//! Session persistence, ported from agent-core's `SqliteStore`.
//!
//! Same two tables, same queries, same search semantics. That is the point: a
//! session written by the desktop agent-core can be opened here and vice versa,
//! which is what the 381 KB of bundled SQLite is being paid for. Anywhere this
//! file diverges from `src/web/store.rs` upstream, that promise is broken, so
//! the SQL below is copied verbatim rather than rewritten in a nicer idiom.
//!
//! What does differ is everything around the SQL:
//!
//! - rusqlite is replaced by [`crate::sql`], a thin wrapper over the C API that
//!   `sqlite-wasm-rs` exposes.
//! - The connection sits behind a plain `RefCell`, not a `Mutex`. A wasm module
//!   has one thread; there is nothing to lock against.
//! - `PRAGMA journal_mode=WAL` is not requested. WAL needs shared memory the
//!   IndexedDB VFS has no way to provide, and asking for it on a VFS that
//!   cannot do it leaves the database in whatever mode it was already in — a
//!   silent no-op that reads like a guarantee.

use std::cell::RefCell;

use serde::Serialize;

use crate::sql::{Connection, Result, Value};
use crate::types::{Attachment, ChatMessage, Role, ToolCall};

/// One row of the session list.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub pinned: bool,
    /// Whether a turn is currently running. In-memory state elsewhere; the
    /// store always reports `false` and the layer above overlays the live value.
    #[serde(default)]
    pub running: bool,
    /// Where the session was created. Upstream writes `"web"` or `"tui"`; this
    /// runtime writes `"web"`, so a session moved between the two stays
    /// labelled with wherever it started.
    pub origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    /// When the session was archived (RFC 3339); `None` = live. Archived
    /// sessions are excluded from [`SessionScope::Active`] listings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    /// User-assigned category (free text, trimmed); `None` = uncategorised.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// Which sessions [`SessionStore::list_scoped`] returns — the `scope` query
/// parameter of `GET /api/sessions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionScope {
    /// Live sessions only (`archived_at IS NULL`) — the default everywhere.
    Active,
    /// Archived sessions only.
    Archived,
    /// Both.
    All,
}

impl SessionScope {
    /// Parse the `scope` query parameter; `None` for anything unknown.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "active" => Some(Self::Active),
            "archived" => Some(Self::Archived),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    fn sql_filter(self) -> &'static str {
        match self {
            Self::Active => "AND s.archived_at IS NULL",
            Self::Archived => "AND s.archived_at IS NOT NULL",
            Self::All => "",
        }
    }
}

/// Longest accepted session category (characters). Categories are labels
/// for grouping the list, not descriptions.
pub const MAX_CATEGORY_CHARS: usize = 64;

/// One result of [`SessionStore::search`]: a session whose user/assistant
/// messages cover every query term.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    /// Number of user/assistant messages containing at least one term.
    pub match_count: usize,
    /// Up to [`SEARCH_SNIPPETS_PER_SESSION`] one-line excerpts around matches.
    pub snippets: Vec<String>,
}

/// One row of `GET /api/sessions/{id}/archive`: a pre-compaction snapshot of
/// the working context ("generation"), oldest first.
#[derive(Debug, Clone, Serialize)]
pub struct ArchiveGeneration {
    pub generation: i64,
    pub archived_at: String,
    pub message_count: i64,
}

/// Max excerpt fragments returned per matching session.
const SEARCH_SNIPPETS_PER_SESSION: usize = 2;
/// Chars of context kept on each side of a snippet's match.
const SEARCH_SNIPPET_RADIUS: usize = 60;

/// Session detail: title, timestamps, active skill, and the non-system history.
pub type SessionDetail = (String, String, String, Option<String>, Vec<ChatMessage>);

/// Organisation flags of one session, off the listing row: pin state,
/// archive stamp and category. What the session detail's `meta` carries so
/// a resumed session shows them without a second trip through the list.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionFlags {
    pub pinned: bool,
    pub archived_at: Option<String>,
    pub category: Option<String>,
}

/// Last timestamp handed out, in microseconds since the epoch.
static LAST_MICROS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// An RFC 3339 timestamp that is always strictly greater than the previous one.
///
/// The store orders sessions by `updated_at`, and upstream can rely on the wall
/// clock for that because a native `Utc::now()` has nanosecond resolution. In a
/// browser it is backed by `Date.now()` — milliseconds, and deliberately
/// coarsened further by some engines as a timing-attack defence — so two saves
/// in the same burst produce *identical* strings and "newest first" stops being
/// defined. `tests/clock.rs` pins that down.
///
/// Nudging the clock forward is preferable to the obvious alternative of adding
/// a tiebreak column to the `ORDER BY`, because that would mean this port's
/// queries no longer match agent-core's, which is the whole thing SQLite is
/// being paid 381 KB for. It also keeps true insertion order, where a tiebreak
/// on `id` would only be deterministic, not correct.
///
/// The skew this introduces is at most one microsecond per save within a single
/// millisecond, and it is corrected the moment the wall clock catches up.
fn now_rfc3339() -> String {
    use std::sync::atomic::Ordering;

    let wall = chrono::Utc::now().timestamp_micros();
    let micros = LAST_MICROS
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |last| {
            Some(wall.max(last + 1))
        })
        // `fetch_update` only fails when the closure returns None, which this
        // one never does.
        .map(|last| wall.max(last + 1))
        .unwrap_or(wall);

    chrono::DateTime::from_timestamp_micros(micros)
        // Kept as `to_rfc3339` with its variable-width fraction, exactly as
        // upstream writes it: these strings are compared as text by SQLite, and
        // a fixed-width fraction would sort incorrectly against the
        // nanosecond-precision values a native install writes.
        .map(|t| t.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

pub struct SessionStore {
    conn: RefCell<Connection>,
}

// One thread, so there is nothing for these to protect against; they exist
// because the engine's `Arc`-shared types are declared `Send + Sync`.
unsafe impl Send for SessionStore {}
unsafe impl Sync for SessionStore {}

impl SessionStore {
    /// Open (or create) the database and bring the schema up to date.
    ///
    /// The VFS must already be installed; see [`crate::storage`].
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS sessions (
                 id TEXT PRIMARY KEY,
                 title TEXT NOT NULL DEFAULT '',
                 pinned INTEGER NOT NULL DEFAULT 0,
                 origin TEXT NOT NULL DEFAULT 'web',
                 active_skill TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 archived_at TEXT,
                 category TEXT,
                 full_auto INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS messages (
                 session_id TEXT NOT NULL,
                 seq INTEGER NOT NULL,
                 role TEXT NOT NULL,
                 content TEXT,
                 reasoning_content TEXT,
                 tool_calls TEXT,
                 tool_call_id TEXT,
                 attachments TEXT,
                 PRIMARY KEY (session_id, seq)
             );
             CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
             CREATE TABLE IF NOT EXISTS messages_archive (
                 session_id TEXT NOT NULL,
                 generation INTEGER NOT NULL,
                 seq INTEGER NOT NULL,
                 role TEXT NOT NULL,
                 content TEXT,
                 reasoning_content TEXT,
                 tool_calls TEXT,
                 tool_call_id TEXT,
                 attachments TEXT,
                 archived_at TEXT NOT NULL,
                 PRIMARY KEY (session_id, generation, seq)
             );",
        )?;
        // Migrations for databases created before these columns existed —
        // relevant here because a database can arrive by import from a native
        // install. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the "duplicate
        // column" error is the signal that the schema is already current and is
        // discarded rather than handled.
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'web'",
            &[],
        );
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN active_skill TEXT", &[]);
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN attachments TEXT", &[]);
        // Archive stamp (NULL = live) and user-assigned category (NULL =
        // uncategorised), both from the xcore sync; see `set_archived`.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN archived_at TEXT", &[]);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN category TEXT", &[]);
        // Full-auto persisted per session so the badge survives a reload; see
        // `set_full_auto`.
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN full_auto INTEGER NOT NULL DEFAULT 0",
            &[],
        );
        Ok(SessionStore {
            conn: RefCell::new(conn),
        })
    }

    /// Whole-table rewrite: upsert the session (bumping `updated_at`) and
    /// rebuild its messages.
    ///
    /// `origin` is written on first insert only, so a session reopened from a
    /// different frontend keeps the label of wherever it was created.
    pub fn save(
        &self,
        id: &str,
        messages: &[ChatMessage],
        origin: &str,
        active_skill: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.borrow();
        let now = now_rfc3339();
        conn.transaction(|| {
            conn.execute(
                "INSERT INTO sessions
                     (id, title, pinned, origin, active_skill, created_at, updated_at)
                 VALUES (?1, '', 0, ?3, ?4, ?2, ?2)
                 ON CONFLICT(id) DO UPDATE
                     SET updated_at=?2, active_skill=?4, archived_at=NULL",
                &[
                    id.into(),
                    now.clone().into(),
                    origin.into(),
                    active_skill.map(|s| s.to_string()).into(),
                ],
            )?;
            conn.execute("DELETE FROM messages WHERE session_id=?1", &[id.into()])?;

            let mut stmt = conn.prepare(
                "INSERT INTO messages
                 (session_id, seq, role, content, reasoning_content, tool_calls, tool_call_id,
                  attachments)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            )?;
            for (seq, m) in messages.iter().enumerate() {
                let tool_calls = m
                    .tool_calls
                    .as_ref()
                    .map(|tc| serde_json::to_string(tc).unwrap_or_default());
                let attachments = m
                    .attachments
                    .as_ref()
                    .map(|a| serde_json::to_string(a).unwrap_or_default());
                stmt.bind(&[
                    id.into(),
                    (seq as i64).into(),
                    role_str(&m.role).into(),
                    m.content.clone().into(),
                    m.reasoning_content.clone().into(),
                    tool_calls.into(),
                    m.tool_call_id.clone().into(),
                    attachments.into(),
                ])?;
                while stmt.step()? {}
                stmt.reset()?;
            }
            Ok(())
        })
    }

    /// [`SessionStore::save`] under the name and signature the engine calls it
    /// by, so the vendored copies compile unpatched.
    ///
    /// Upstream's is asynchronous because its writes go to a background thread;
    /// here the write happens now. What it keeps is the fire-and-forget shape:
    /// the caller is a sub-agent driver reacting to a `SessionSync`, and it has
    /// nowhere to report a failed write to.
    pub fn save_async(
        &self,
        id: &str,
        messages: &[ChatMessage],
        origin: &str,
        active_skill: Option<&crate::skill::ActiveSkill>,
    ) {
        if let Err(e) = self.save(id, messages, origin, active_skill.map(|s| s.name.as_str())) {
            log::warn!("could not save {origin} session {id}: {e}");
        }
    }

    /// Snapshot `messages` under the next generation for this session.
    ///
    /// Called just before a Level-2 compaction replaces the working context
    /// with a summary, so the raw history stays reachable even though the
    /// conversation continues from the summary. Returns the generation written.
    pub fn archive_messages(&self, id: &str, messages: &[ChatMessage]) -> Result<i64> {
        let conn = self.conn.borrow();
        let now = now_rfc3339();
        conn.transaction(|| {
            let mut gen_stmt = conn.prepare(
                "SELECT COALESCE(MAX(generation), 0) + 1 FROM messages_archive
                 WHERE session_id=?1",
            )?;
            gen_stmt.bind(&[id.into()])?;
            let generation = gen_stmt.row(|r| r.int(0))?.unwrap_or(1);

            let mut stmt = conn.prepare(
                "INSERT INTO messages_archive
                 (session_id, generation, seq, role, content, reasoning_content, tool_calls,
                  tool_call_id, attachments, archived_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            )?;
            for (seq, m) in messages.iter().enumerate() {
                let tool_calls = m
                    .tool_calls
                    .as_ref()
                    .map(|tc| serde_json::to_string(tc).unwrap_or_default());
                let attachments = m
                    .attachments
                    .as_ref()
                    .map(|a| serde_json::to_string(a).unwrap_or_default());
                stmt.bind(&[
                    id.into(),
                    generation.into(),
                    (seq as i64).into(),
                    role_str(&m.role).into(),
                    m.content.clone().into(),
                    m.reasoning_content.clone().into(),
                    tool_calls.into(),
                    m.tool_call_id.clone().into(),
                    attachments.into(),
                    now.clone().into(),
                ])?;
                while stmt.step()? {}
                stmt.reset()?;
            }
            Ok(generation)
        })
    }

    /// List this session's archived generations (oldest first). Empty when
    /// the session was never compacted.
    pub fn list_archive_generations(&self, id: &str) -> Result<Vec<ArchiveGeneration>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT generation, MIN(archived_at), COUNT(*)
             FROM messages_archive WHERE session_id=?1
             GROUP BY generation ORDER BY generation ASC",
        )?;
        stmt.bind(&[id.into()])?;
        stmt.rows(|r| ArchiveGeneration {
            generation: r.int(0),
            archived_at: r.text_or_empty(1),
            message_count: r.int(2),
        })
    }

    /// Load one archived generation (full rows, ordered by seq). `None` when
    /// the generation does not exist for this session.
    pub fn load_archive(&self, id: &str, generation: i64) -> Result<Option<Vec<ChatMessage>>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT role, content, reasoning_content, tool_calls, tool_call_id, attachments
             FROM messages_archive WHERE session_id=?1 AND generation=?2 ORDER BY seq ASC",
        )?;
        stmt.bind(&[id.into(), generation.into()])?;
        let messages = stmt.rows(read_message)?;
        Ok((!messages.is_empty()).then_some(messages))
    }

    /// The tool result behind `call_id`, as last archived for this session:
    /// the `recall_result` fall-through for content a Level-2 compaction has
    /// rewritten out of the working context. Newest generation wins (a call id
    /// appears in every generation archived after it happened; the rows are
    /// identical, so any would do — newest keeps the scan short).
    ///
    /// Returns `(tool name, content)`; the name is best-effort ("tool" when
    /// the issuing assistant row cannot be found) — the content is the point.
    pub fn lookup_archived_tool_result(
        &self,
        id: &str,
        call_id: &str,
    ) -> Result<Option<(String, String)>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT content FROM messages_archive
             WHERE session_id=?1 AND tool_call_id=?2 AND role='tool'
                   AND content IS NOT NULL
             ORDER BY generation DESC, seq DESC LIMIT 1",
        )?;
        stmt.bind(&[id.into(), call_id.into()])?;
        let Some(content) = stmt.row(|r| r.text(0))?.flatten() else {
            return Ok(None);
        };

        // The tool name lives in the issuing assistant row's tool_calls JSON.
        // LIKE narrows the candidates; parsing confirms the id actually
        // belongs to a call (and is not, say, a substring of another id —
        // which is also why the LIKE match alone is not trusted for the name).
        let mut name_stmt = conn.prepare(
            "SELECT tool_calls FROM messages_archive
             WHERE session_id=?1 AND tool_calls LIKE '%' || ?2 || '%'
             ORDER BY generation DESC LIMIT 1",
        )?;
        name_stmt.bind(&[id.into(), call_id.into()])?;
        let tool = name_stmt
            .row(|r| r.text(0))?
            .flatten()
            .and_then(|json| serde_json::from_str::<Vec<crate::types::ToolCall>>(&json).ok())
            .and_then(|calls| {
                calls
                    .into_iter()
                    .find(|c| c.id == call_id)
                    .map(|c| c.function.name)
            })
            .unwrap_or_else(|| "tool".to_string());
        Ok(Some((tool, content)))
    }

    /// Create the session row if it is new, and bump `updated_at` either way,
    /// without touching its messages.
    ///
    /// A turn calls this when it starts. Without it the row appears only when
    /// the turn finishes, so the conversation you are currently having is
    /// missing from the session list until it ends — and a session whose first
    /// turn fails never appears at all.
    ///
    /// Deliberately not part of `save`: `save` rewrites the whole message table,
    /// which is exactly what must *not* happen at the start of a turn.
    ///
    /// Sending to an archived session revives it, the same as `save` does, so
    /// it is back in the live list the moment the turn starts. `full_auto` is
    /// the session's current flag; writing it here is what persists a toggle
    /// flipped before the first turn, when there was no row to update yet.
    pub fn touch(&self, id: &str, origin: &str, full_auto: bool) -> Result<()> {
        let now = now_rfc3339();
        self.conn.borrow().execute(
            "INSERT INTO sessions
                 (id, title, pinned, origin, active_skill, created_at, updated_at, full_auto)
             VALUES (?1, '', 0, ?3, NULL, ?2, ?2, ?4)
             ON CONFLICT(id) DO UPDATE
                 SET updated_at=?2, archived_at=NULL, full_auto=?4",
            &[id.into(), now.into(), origin.into(), (full_auto as i64).into()],
        )
    }

    /// Whether the session was left in full-auto; `false` for a session the
    /// store has never seen.
    pub fn full_auto(&self, id: &str) -> Result<bool> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT full_auto FROM sessions WHERE id=?1")?;
        stmt.bind(&[id.into()])?;
        Ok(stmt.row(|r| r.int(0) != 0)?.unwrap_or(false))
    }

    /// Persist the full-auto flag so it survives a reload. A session with no
    /// row yet (flag flipped before the first turn) is not created here;
    /// [`SessionStore::touch`] writes the flag when the first turn creates it.
    pub fn set_full_auto(&self, id: &str, full_auto: bool) -> Result<()> {
        self.conn.borrow().execute(
            "UPDATE sessions SET full_auto=?2 WHERE id=?1",
            &[id.into(), (full_auto as i64).into()],
        )
    }

    /// Full history including the system message, ordered by seq.
    pub fn load(&self, id: &str) -> Result<Vec<ChatMessage>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT role, content, reasoning_content, tool_calls, tool_call_id, attachments
             FROM messages WHERE session_id=?1 ORDER BY seq ASC",
        )?;
        stmt.bind(&[id.into()])?;
        stmt.rows(read_message)
    }

    /// Working context plus the persisted active skill name.
    pub fn load_state(&self, id: &str) -> Result<(Vec<ChatMessage>, Option<String>)> {
        let messages = self.load(id)?;
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT active_skill FROM sessions WHERE id=?1")?;
        stmt.bind(&[id.into()])?;
        let skill = stmt.row(|r| r.text(0))?.flatten();
        Ok((messages, skill))
    }

    /// Keyword search across session content.
    ///
    /// `query` is split on whitespace and terms are ANDed per session: every
    /// term must appear in some user/assistant message, though not necessarily
    /// the same one — a single `LIKE '%whole query%'` would almost never match a
    /// multi-word query. system and skill messages are prompt noise and tool
    /// messages are huge log dumps, so all three are excluded. A blank query
    /// degrades to "most recent sessions" with no snippets. `exclude_id` drops
    /// the caller's own session. Newest first, capped at `limit`.
    ///
    /// Matching covers the live `messages` AND the pre-compaction
    /// `messages_archive`: content a context compaction replaced with a
    /// summary stays findable. Archived snippets carry an `[archived]`
    /// prefix. No dedup is needed — each archive generation holds exactly the
    /// rows that were removed from the live table.
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        exclude_id: Option<&str>,
    ) -> Result<Vec<SearchHit>> {
        let raw_terms: Vec<String> = query.split_whitespace().map(str::to_string).collect();
        let limit = limit.max(1);
        let conn = self.conn.borrow();

        let exclude: Value = exclude_id.map(|s| s.to_string()).into();

        if raw_terms.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT s.id, s.title, s.updated_at FROM sessions s
                 WHERE (?1 IS NULL OR s.id != ?1)
                 ORDER BY s.updated_at DESC LIMIT ?2",
            )?;
            stmt.bind(&[exclude, (limit as i64).into()])?;
            return stmt.rows(|r| SearchHit {
                id: r.text_or_empty(0),
                title: r.text_or_empty(1),
                updated_at: r.text_or_empty(2),
                match_count: 0,
                snippets: Vec::new(),
            });
        }

        // ?1 = exclude_id, ?2.. = one escaped %term% pattern per term.
        let mut sql = String::from(
            "SELECT s.id, s.title, s.updated_at FROM sessions s
             WHERE (?1 IS NULL OR s.id != ?1)",
        );
        for i in 0..raw_terms.len() {
            sql.push_str(&format!(
                " AND (EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id
                   AND m.role IN ('user','assistant')
                   AND m.content LIKE ?{i} ESCAPE '\\')
                 OR EXISTS (SELECT 1 FROM messages_archive a WHERE a.session_id = s.id
                   AND a.role IN ('user','assistant')
                   AND a.content LIKE ?{i} ESCAPE '\\'))",
                i = i + 2
            ));
        }
        sql.push_str(&format!(
            " ORDER BY s.updated_at DESC LIMIT {}",
            limit as i64
        ));

        let mut params: Vec<Value> = Vec::with_capacity(raw_terms.len() + 1);
        params.push(exclude);
        for t in &raw_terms {
            params.push(format!("%{}%", escape_like(t)).into());
        }

        let mut stmt = conn.prepare(&sql)?;
        stmt.bind(&params)?;
        let sessions =
            stmt.rows(|r| (r.text_or_empty(0), r.text_or_empty(1), r.text_or_empty(2)))?;

        // Per matched session: count matching messages (live + archived) and
        // excerpt the most recent ones (conclusions cluster near the end of a
        // conversation). Live rows are the newest; archive generations grow
        // older as the generation number shrinks.
        let or_clause = (0..raw_terms.len())
            .map(|i| format!("content LIKE ?{} ESCAPE '\\'", i + 2))
            .collect::<Vec<_>>()
            .join(" OR ");
        let msg_sql = format!(
            "SELECT content, archived FROM (
                 SELECT session_id, role, content, seq,
                        0 AS archived, 0 AS generation FROM messages
                 UNION ALL
                 SELECT session_id, role, content, seq,
                        1 AS archived, generation FROM messages_archive
             )
             WHERE session_id = ?1 AND role IN ('user','assistant') AND ({})
             ORDER BY archived ASC, generation DESC, seq DESC",
            or_clause
        );

        let mut hits = Vec::with_capacity(sessions.len());
        for (id, title, updated_at) in sessions {
            let mut msg_params: Vec<Value> = Vec::with_capacity(raw_terms.len() + 1);
            msg_params.push(id.clone().into());
            for t in &raw_terms {
                msg_params.push(format!("%{}%", escape_like(t)).into());
            }
            let mut msg_stmt = conn.prepare(&msg_sql)?;
            msg_stmt.bind(&msg_params)?;
            let contents = msg_stmt.rows(|r| (r.text_or_empty(0), r.int(1) != 0))?;
            let mut snippets: Vec<String> = contents
                .iter()
                .take(SEARCH_SNIPPETS_PER_SESSION)
                .map(|(c, archived)| {
                    let snippet = build_snippet(c, &raw_terms);
                    if *archived {
                        format!("[archived] {snippet}")
                    } else {
                        snippet
                    }
                })
                .collect();
            snippets.reverse(); // back to chronological order
            hits.push(SearchHit {
                id,
                title,
                updated_at,
                match_count: contents.len(),
                snippets,
            });
        }
        Ok(hits)
    }

    /// All session ids matching `prefix` exactly or as a prefix, newest first.
    ///
    /// Queries the sessions table directly — hidden `task` transcripts
    /// included — because id resolution is not a UI listing concern: a task
    /// transcript's id arrives via the parent's task report and must stay
    /// resolvable even though [`SessionStore::list`] hides it.
    pub fn resolve_id_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT id FROM sessions WHERE id LIKE ?1 ESCAPE '\\'
             ORDER BY updated_at DESC",
        )?;
        stmt.bind(&[format!("{}%", escape_like(prefix)).into()])?;
        stmt.rows(|r| r.text_or_empty(0))
    }

    /// List sessions; `message_count` excludes the system message.
    ///
    /// Sub-agent transcripts (`origin = 'task'`) are left out, as upstream
    /// leaves them out: they are audit artifacts, reachable by the id in the
    /// parent's task report, not conversations to resume.
    ///
    /// The count comes from one grouped aggregation joined to the sessions
    /// table. Upstream notes that a correlated per-row subquery re-scanned the
    /// messages index once per session and was noticeably slow on gateway
    /// hardware; a browser is not faster at this.
    pub fn list(&self) -> Result<Vec<SessionSummary>> {
        self.list_scoped(SessionScope::Active)
    }

    /// List sessions in `scope` (see [`SessionScope`]); everything else as
    /// [`SessionStore::list`].
    pub fn list_scoped(&self, scope: SessionScope) -> Result<Vec<SessionSummary>> {
        let conn = self.conn.borrow();
        let sql = format!(
            "SELECT s.id, s.title, s.pinned, s.origin, s.created_at, s.updated_at,
                    COALESCE(c.cnt, 0) AS cnt, s.archived_at, s.category
             FROM sessions s
             LEFT JOIN (SELECT session_id, COUNT(*) AS cnt FROM messages
                        WHERE role!='system' GROUP BY session_id) c
                    ON c.session_id = s.id
             WHERE s.origin != 'task' {}
             ORDER BY s.pinned DESC, s.updated_at DESC",
            scope.sql_filter()
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.rows(|r| SessionSummary {
            id: r.text_or_empty(0),
            title: r.text_or_empty(1),
            pinned: r.int(2) != 0,
            running: false,
            origin: r.text_or_empty(3),
            created_at: r.text_or_empty(4),
            updated_at: r.text_or_empty(5),
            message_count: r.int(6),
            archived_at: r.text(7),
            category: r.text(8).filter(|c| !c.is_empty()),
        })
    }

    /// Pin state, archive stamp and category of one session; `None` when the
    /// id names nothing.
    pub fn flags(&self, id: &str) -> Result<Option<SessionFlags>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT pinned, archived_at, category FROM sessions WHERE id=?1",
        )?;
        stmt.bind(&[id.into()])?;
        stmt.row(|r| SessionFlags {
            pinned: r.int(0) != 0,
            archived_at: r.text(1),
            category: r.text(2).filter(|c| !c.is_empty()),
        })
    }

    /// Title, timestamps, active skill, and the non-system messages.
    pub fn detail(&self, id: &str) -> Result<Option<SessionDetail>> {
        let conn = self.conn.borrow();
        let mut meta_stmt = conn.prepare(
            "SELECT title, created_at, updated_at, active_skill
             FROM sessions WHERE id=?1",
        )?;
        meta_stmt.bind(&[id.into()])?;
        let meta = meta_stmt.row(|r| {
            (
                r.text_or_empty(0),
                r.text_or_empty(1),
                r.text_or_empty(2),
                r.text(3),
            )
        })?;
        let Some((title, created, updated, active_skill)) = meta else {
            return Ok(None);
        };

        let mut stmt = conn.prepare(
            "SELECT role, content, reasoning_content, tool_calls, tool_call_id, attachments
             FROM messages WHERE session_id=?1 AND role!='system' ORDER BY seq ASC",
        )?;
        stmt.bind(&[id.into()])?;
        let msgs = stmt.rows(read_message)?;
        Ok(Some((title, created, updated, active_skill, msgs)))
    }

    pub fn update(&self, id: &str, title: Option<&str>, pinned: Option<bool>) -> Result<()> {
        let conn = self.conn.borrow();
        if let Some(t) = title {
            conn.execute(
                "UPDATE sessions SET title=?2 WHERE id=?1",
                &[id.into(), t.into()],
            )?;
        }
        if let Some(p) = pinned {
            conn.execute(
                "UPDATE sessions SET pinned=?2 WHERE id=?1",
                &[id.into(), p.into()],
            )?;
        }
        Ok(())
    }

    /// Archive (`true`) or restore (`false`) a session. Archiving also
    /// un-pins it — a pinned row in the archive would be contradictory — and
    /// stamps `archived_at`; any later save (a new turn) clears the stamp
    /// again, see [`SessionStore::save`].
    pub fn set_archived(&self, id: &str, archived: bool) -> Result<()> {
        let conn = self.conn.borrow();
        if archived {
            conn.execute(
                "UPDATE sessions SET archived_at=?2, pinned=0 WHERE id=?1",
                &[id.into(), now_rfc3339().into()],
            )
        } else {
            conn.execute(
                "UPDATE sessions SET archived_at=NULL WHERE id=?1",
                &[id.into()],
            )
        }
    }

    /// Set (or clear, with `None` / blank) the session's category. The value
    /// is trimmed; callers enforce [`MAX_CATEGORY_CHARS`].
    pub fn set_category(&self, id: &str, category: Option<&str>) -> Result<()> {
        let cat = category.map(str::trim).filter(|c| !c.is_empty());
        self.conn.borrow().execute(
            "UPDATE sessions SET category=?2 WHERE id=?1",
            &[id.into(), cat.map(|c| c.to_string()).into()],
        )
    }

    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        self.conn.borrow().execute(
            "UPDATE sessions SET title=?2 WHERE id=?1",
            &[id.into(), title.into()],
        )
    }

    /// [`SessionStore::set_title`] under the name the engine calls it by: the
    /// sub-agent driver titles a child transcript right after its first
    /// `save_async`. Upstream queues both on one writer thread and relies on
    /// that ordering; here both run inline, so the UPDATE trivially lands
    /// behind the INSERT. Same fire-and-forget shape as `save_async`.
    pub fn set_title_async(&self, id: &str, title: &str) {
        if let Err(e) = self.set_title(id, title) {
            log::warn!("could not title session {id}: {e}");
        }
    }

    /// Current title. An empty string means unnamed, which is what decides
    /// whether a session gets auto-titled after its first turn.
    pub fn title_of(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT title FROM sessions WHERE id=?1")?;
        stmt.bind(&[id.into()])?;
        stmt.row(|r| r.text_or_empty(0))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.borrow();
        conn.execute("DELETE FROM messages WHERE session_id=?1", &[id.into()])?;
        conn.execute(
            "DELETE FROM messages_archive WHERE session_id=?1",
            &[id.into()],
        )?;
        conn.execute("DELETE FROM sessions WHERE id=?1", &[id.into()])
    }
}

fn read_message(r: &crate::sql::Statement<'_>) -> ChatMessage {
    ChatMessage {
        role: role_from(&r.text_or_empty(0)),
        content: r.text(1),
        reasoning_content: r.text(2),
        tool_calls: r
            .text(3)
            .and_then(|s| serde_json::from_str::<Vec<ToolCall>>(&s).ok()),
        tool_call_id: r.text(4),
        attachments: r
            .text(5)
            .and_then(|s| serde_json::from_str::<Vec<Attachment>>(&s).ok()),
    }
}

/// Escape `%`, `_` and `\` in a term destined for `LIKE ... ESCAPE '\'`.
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if c == '%' || c == '_' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Char-level substring search, ASCII-case-insensitive, mirroring SQLite's LIKE
/// semantics: ASCII letters fold, everything else compares exactly.
fn find_term(haystack: &[char], term: &[char]) -> Option<usize> {
    if term.is_empty() || haystack.len() < term.len() {
        return None;
    }
    'outer: for start in 0..=haystack.len() - term.len() {
        for (i, tc) in term.iter().enumerate() {
            if !haystack[start + i].eq_ignore_ascii_case(tc) {
                continue 'outer;
            }
        }
        return Some(start);
    }
    None
}

/// One-line excerpt around the earliest term match.
///
/// Every cut is char-indexed. Content here is largely CJK, and byte slicing
/// would panic mid-codepoint.
fn build_snippet(content: &str, terms: &[String]) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flat.chars().collect();

    let mut best: Option<(usize, usize)> = None; // (start, term len)
    for term in terms {
        let t: Vec<char> = term.chars().collect();
        if let Some(pos) = find_term(&chars, &t) {
            if best.is_none_or(|(s, _)| pos < s) {
                best = Some((pos, t.len()));
            }
        }
    }
    // SQL already filtered to messages containing a term, but stay lenient and
    // fall back to a plain prefix excerpt.
    let (start, len) = best.unwrap_or((0, 0));
    let from = start.saturating_sub(SEARCH_SNIPPET_RADIUS);
    let to = (start + len + SEARCH_SNIPPET_RADIUS).min(chars.len());
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    out.extend(&chars[from..to]);
    if to < chars.len() {
        out.push('…');
    }
    out
}

fn role_str(r: &Role) -> &'static str {
    match r {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::Skill => "skill",
    }
}

fn role_from(s: &str) -> Role {
    match s {
        "system" => Role::System,
        "user" => Role::User,
        "tool" => Role::Tool,
        "skill" => Role::Skill,
        _ => Role::Assistant,
    }
}
