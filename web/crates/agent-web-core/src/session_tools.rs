//! LLM retrieval tools over the session store: `search_sessions` +
//! `read_session`.
//!
//! Ported from agent-core's `src/web/session_tools.rs` against this port's
//! [`crate::store::SessionStore`]. Two deliberate differences from upstream:
//! the store error type is [`crate::sql::Error`] instead of rusqlite's, and
//! there are no `store.flush().await` read barriers — this port's writes are
//! synchronous (see `save_async` in store.rs), so there is no persist queue
//! for a read to wait on.
//!
//! Both tools are Safe (auto-run, read-only). Retrieved content is a
//! HISTORICAL record of past conversations — the schemas and outputs say so
//! explicitly, because the biggest failure mode of session retrieval is the
//! model quoting stale state as if it were current.
//!
//! The current conversation is excluded from results (its content is already
//! in the working context); the session id comes from [`ToolContext`], wired
//! through the agent loop.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use crate::context::SUMMARY_MARKER;
use crate::store::SessionStore;
use crate::tool::{Tool, ToolContext, ToolRegistry};
use crate::types::{ChatMessage, Role, ToolDefinition, ToolParameter, ToolParameters, ToolResult};

/// Per-message excerpt cap in a transcript (chars).
const MSG_CHAR_LIMIT: usize = 500;
/// Whole-transcript cap (chars). Sessions carry tool logs and long answers;
/// without a hard budget one `read_session` could flood the context.
const TOTAL_CHAR_BUDGET: usize = 8_000;
/// Transcript entries always kept from the start when over budget (the rest
/// fills from the tail, where conclusions live).
const HEAD_KEEP: usize = 2;
/// Default / max number of sessions returned by `search_sessions`.
const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 10;

/// Shared reminder appended to tool outputs.
const HISTORICAL_NOTE: &str =
    "Note: this is a HISTORICAL record of a past conversation. Device/gateway state may have \
     changed since — verify current state with live commands before relying on it.";

/// Register both tools. Called from the host once the store exists.
pub fn install(registry: &ToolRegistry, store: Arc<SessionStore>) {
    registry.register(Arc::new(SearchSessionsTool::new(store.clone())));
    registry.register(Arc::new(ReadSessionTool::new(store)));
}

/// `search_sessions` — keyword search across stored conversations.
pub struct SearchSessionsTool {
    store: Arc<SessionStore>,
}

impl SearchSessionsTool {
    pub fn new(store: Arc<SessionStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for SearchSessionsTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "search_sessions",
            "Search past conversation sessions stored on this device (keyword match over \
             user/assistant messages, including history that a context compaction archived; \
             tool logs and system prompts are not searched). Returns session ids, titles, \
             timestamps and matching excerpts, newest first ([archived] marks excerpts from \
             compacted-away history). The current session is always excluded. Use when the \
             user refers to a previous conversation (\"last time\", \"before\", \"that earlier \
             issue\"). Results are HISTORICAL records and may be outdated — verify current \
             state with live commands. Follow up with read_session to view one session.",
            ToolParameters::object(
                HashMap::from([
                    (
                        "query".into(),
                        ToolParameter::string(
                            "1-3 short keywords separated by spaces (terms are ANDed; split \
                             phrases and Chinese sentences into distinct words, e.g. \
                             \"mosquitto 断连\" not \"mosquitto为什么断连了\"). Omit to list \
                             the most recent sessions.",
                        ),
                    ),
                    (
                        "limit".into(),
                        ToolParameter::integer("max sessions to return (1-10, default 5)")
                            .with_default(serde_json::json!(DEFAULT_LIMIT)),
                    ),
                ]),
                vec![],
            ),
        )
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolResult {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).clamp(1, MAX_LIMIT))
            .unwrap_or(DEFAULT_LIMIT);

        let hits = match self.store.search(&query, limit, ctx.session_id()) {
            Ok(hits) => hits,
            Err(e) => {
                return ToolResult::text(format!("Error: session store query failed: {e}"))
                    .with_success(false)
            }
        };

        if hits.is_empty() {
            let msg = if query.is_empty() {
                "No past sessions found (this is the only conversation stored).".to_string()
            } else {
                format!(
                    "No past sessions matched \"{query}\". Try fewer or shorter keywords, or \
                     omit query to list recent sessions."
                )
            };
            return ToolResult::text(msg).with_success(true);
        }

        let mut out = if query.is_empty() {
            format!("Most recent sessions ({}, current excluded):\n", hits.len())
        } else {
            format!(
                "Sessions matching \"{}\" ({}, newest first, current excluded):\n",
                query,
                hits.len()
            )
        };
        for h in &hits {
            let title = if h.title.trim().is_empty() {
                "(untitled)"
            } else {
                h.title.as_str()
            };
            out.push_str(&format!(
                "- id: {} | updated: {} | {}",
                h.id, h.updated_at, title
            ));
            if !query.is_empty() {
                out.push_str(&format!(" | {} matching message(s)", h.match_count));
            }
            out.push('\n');
            for sn in &h.snippets {
                out.push_str(&format!("    > {sn}\n"));
            }
        }
        out.push_str(&format!(
            "\nUse read_session with an id for details. {HISTORICAL_NOTE}"
        ));
        ToolResult::text(out).with_success(true)
    }
}

/// `read_session` — transcript view of one stored conversation.
pub struct ReadSessionTool {
    store: Arc<SessionStore>,
}

impl ReadSessionTool {
    pub fn new(store: Arc<SessionStore>) -> Self {
        Self { store }
    }

    /// Resolve a full id or unique id prefix against ALL stored sessions —
    /// hidden `task` transcripts included (their ids arrive via task reports
    /// and must stay readable; `store.list()`'s visible-only filter is a UI
    /// concern that must not leak into id resolution).
    fn resolve_id(&self, wanted: &str) -> Result<Resolved, crate::sql::Error> {
        let matches = self.store.resolve_id_prefix(wanted)?;
        Ok(match matches.len() {
            0 => Resolved::NotFound,
            1 => Resolved::One(matches.into_iter().next().unwrap()),
            _ => Resolved::Ambiguous(matches),
        })
    }

    /// "Recent sessions" footer used by not-found/ambiguous error paths so the
    /// model can self-correct without another search round-trip.
    fn recent_footer(&self, exclude: Option<&str>) -> String {
        match self.store.search("", DEFAULT_LIMIT, exclude) {
            Ok(recent) if !recent.is_empty() => {
                let mut out = String::from("Recent sessions:\n");
                for h in recent {
                    let title = if h.title.trim().is_empty() {
                        "(untitled)".to_string()
                    } else {
                        h.title
                    };
                    out.push_str(&format!("- id: {} | {} | {}\n", h.id, h.updated_at, title));
                }
                out
            }
            _ => String::new(),
        }
    }
}

enum Resolved {
    One(String),
    NotFound,
    Ambiguous(Vec<String>),
}

#[async_trait]
impl Tool for ReadSessionTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "read_session",
            "Read the transcript of one past conversation session by id (get ids from \
             search_sessions; a unique id prefix of 8+ chars is accepted). Includes history \
             a context compaction archived, so compacted-away messages stay readable. Tool \
             outputs are omitted and long messages truncated — to retrieve one tool \
             result's full content from THIS conversation, use recall_result(call_id=...) \
             instead. Reading the CURRENT session's id returns its pre-compaction archive — \
             use it when earlier parts of this very conversation were compacted into a \
             summary. The content is HISTORICAL — it describes past state, not the present.",
            ToolParameters::object(
                HashMap::from([(
                    "id".into(),
                    ToolParameter::string("session id (or unique prefix) to read"),
                )]),
                vec!["id".into()],
            ),
        )
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolResult {
        let wanted = args
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if wanted.is_empty() {
            return ToolResult::text(
                "Error: `id` is required. Call search_sessions first to find one.",
            )
            .with_success(false);
        }

        let id = match self.resolve_id(&wanted) {
            Ok(Resolved::One(id)) => id,
            Ok(Resolved::NotFound) => {
                return ToolResult::text(format!(
                    "No stored session has id (or id prefix) \"{}\".\n{}",
                    wanted,
                    self.recent_footer(ctx.session_id())
                ))
                .with_success(false);
            }
            Ok(Resolved::Ambiguous(ids)) => {
                return ToolResult::text(format!(
                    "Id prefix \"{}\" is ambiguous ({} sessions match): {}. Pass a longer \
                     prefix or the full id.",
                    wanted,
                    ids.len(),
                    ids.join(", ")
                ))
                .with_success(false);
            }
            Err(e) => {
                return ToolResult::text(format!("Error: session store query failed: {e}"))
                    .with_success(false)
            }
        };

        // Pre-compaction archive of the session, rendered oldest-first. The
        // `[Conversation Summary]` message opening generation N+1 is the
        // compaction boundary that closed generation N — rendered as a marker
        // line, so consecutive generations read as one continuous transcript.
        let generations = match self.store.list_archive_generations(&id) {
            Ok(g) => g,
            Err(e) => {
                return ToolResult::text(format!("Error: session store query failed: {e}"))
                    .with_success(false)
            }
        };
        let mut archived_entries: Vec<String> = Vec::new();
        for g in &generations {
            if let Ok(Some(msgs)) = self.store.load_archive(&id, g.generation) {
                for m in &msgs {
                    push_transcript_entry(&mut archived_entries, m);
                }
            }
        }

        if ctx.session_id() == Some(id.as_str()) {
            // The live part is already in the model's context; what it CANNOT
            // see is the history a compaction replaced with a summary.
            if archived_entries.is_empty() {
                return ToolResult::text(
                    "That is the current session — its content is already in your context. \
                     Use search_sessions to find PAST sessions.",
                )
                .with_success(true);
            }
            let mut out = format!(
                "Pre-compaction history of the CURRENT session ({} archived message(s) across \
                 {} compaction(s)). Your live context continues from the summary; this is the \
                 original it replaced:\n\n",
                archived_entries.len(),
                generations.len()
            );
            out.push_str(&assemble_transcript(archived_entries));
            return ToolResult::text(out).with_success(true);
        }

        let detail = match self.store.detail(&id) {
            Ok(Some(d)) => d,
            Ok(None) => {
                return ToolResult::text(format!("Session {id} no longer exists."))
                    .with_success(false)
            }
            Err(e) => {
                return ToolResult::text(format!("Error: session store query failed: {e}"))
                    .with_success(false)
            }
        };
        let (title, created_at, updated_at, _active_skill, messages) = detail;

        let title = if title.trim().is_empty() {
            "(untitled)".to_string()
        } else {
            title
        };
        let archived_note = if archived_entries.is_empty() {
            String::new()
        } else {
            format!(
                " (+{} archived across {} compaction(s))",
                archived_entries.len(),
                generations.len()
            )
        };
        let mut out = format!(
            "Session {id} — \"{title}\"\ncreated: {created_at} | last updated: {updated_at} | \
             {} message(s){archived_note}\n{HISTORICAL_NOTE}\n\n",
            messages.len()
        );
        let mut entries = archived_entries;
        for m in &messages {
            push_transcript_entry(&mut entries, m);
        }
        out.push_str(&assemble_transcript(entries));
        ToolResult::text(out).with_success(true)
    }
}

/// [`render_message`] with two transcript-level rules on top: system prompts
/// are dropped (archive snapshots include them), and the `[Conversation
/// Summary]` message that opens a post-compaction context becomes a boundary
/// marker — in a stitched transcript the original messages it summarized sit
/// right above it. That replacement is only safe when something IS above:
/// legacy sessions may hold a summary with no archived generation (archiving
/// used to be fire-and-forget), and hiding the summary there would lose the
/// only surviving record — a summary opening the transcript stays verbatim.
fn push_transcript_entry(entries: &mut Vec<String>, m: &ChatMessage) {
    if m.role == Role::System {
        return;
    }
    let is_summary = m.role == Role::User
        && m.content
            .as_deref()
            .is_some_and(|c| c.starts_with(SUMMARY_MARKER));
    if is_summary && !entries.is_empty() {
        entries.push(
            "[--- context compacted here: the messages above were replaced by a summary ---]"
                .to_string(),
        );
    } else {
        entries.push(render_message(m));
    }
}

/// One transcript line per message; tool/skill bodies are elided (log dumps and
/// prompt boilerplate), user/assistant text is excerpted.
fn render_message(m: &ChatMessage) -> String {
    let content = m.content.as_deref().unwrap_or("");
    match m.role {
        Role::Tool => format!("[tool output omitted, {} chars]", content.chars().count()),
        Role::Skill => format!(
            "[skill \"{}\" context omitted, {} chars]",
            m.skill_name().unwrap_or("?"),
            content.chars().count()
        ),
        Role::Assistant if content.trim().is_empty() => {
            let names = m
                .tool_calls
                .as_ref()
                .map(|tcs| {
                    tcs.iter()
                        .map(|tc| tc.function.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            format!("[assistant] (issued tool calls: {names})")
        }
        _ => {
            let label = match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                _ => "message",
            };
            let (excerpt, cut) = truncate_chars(content, MSG_CHAR_LIMIT);
            let flat = excerpt.replace('\n', "\n  ");
            if cut {
                format!(
                    "[{label}] {flat} … [truncated, {} chars total]",
                    content.chars().count()
                )
            } else {
                format!("[{label}] {flat}")
            }
        }
    }
}

/// Join entries under [`TOTAL_CHAR_BUDGET`]. When over, keep [`HEAD_KEEP`]
/// entries from the start and fill the rest from the tail — conclusions
/// cluster at the end of a conversation (same shape as read_file's large-file
/// head+tail preview).
fn assemble_transcript(entries: Vec<String>) -> String {
    let total: usize = entries.iter().map(|e| e.chars().count()).sum();
    if total <= TOTAL_CHAR_BUDGET || entries.len() <= HEAD_KEEP {
        return entries.join("\n");
    }

    let head: Vec<String> = entries.iter().take(HEAD_KEEP).cloned().collect();
    let mut budget = TOTAL_CHAR_BUDGET.saturating_sub(head.iter().map(|e| e.chars().count()).sum());
    let mut tail: Vec<String> = Vec::new();
    for e in entries.iter().skip(HEAD_KEEP).rev() {
        let len = e.chars().count();
        if len > budget {
            break;
        }
        budget -= len;
        tail.push(e.clone());
    }
    tail.reverse();

    let omitted = entries.len() - HEAD_KEEP - tail.len();
    let mut out = head;
    if omitted > 0 {
        out.push(format!("[... {omitted} message(s) omitted ...]"));
    }
    out.extend(tail);
    out.join("\n")
}

/// Char-boundary-safe prefix (content is largely CJK; byte slicing panics).
/// Returns the excerpt and whether anything was cut.
fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max {
            return (out, true);
        }
        out.push(c);
    }
    (out, false)
}
