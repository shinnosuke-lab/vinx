//! Skill system — aligned with Claude Code / Cursor / Codex.
//!
//! A skill is a **directory** containing a `SKILL.md` (YAML frontmatter +
//! markdown body) and optional `references/`, `scripts/`, `assets/`. Loading is
//! three-tier (progressive disclosure):
//!
//! 1. **Tier 1 (metadata)** — at startup only each skill's `name` + `description`
//!    (+ `when_to_use`) are injected into the system prompt ([`SkillRegistry::manifest`]).
//! 2. **Tier 2 (body)** — on a match the model calls `read_skill` to load the
//!    `SKILL.md` body ([`ReadSkillTool`]).
//! 3. **Tier 3 (resources)** — `references/scripts/assets` are read/executed on
//!    demand via the OS tools (`read_file` / `run_shell`).
//!
//! Discovery scans multiple directories (bundled + user/app-level). Hot reload
//! is **pull-based** ([`SkillRegistry::ensure_fresh`]): every read point
//! revalidates a TTL-debounced stat fingerprint and re-parses only when disk
//! actually changed — no background poller, zero idle work.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::tool::{Tool, ToolContext};
use crate::types::{ChatMessage, ToolDefinition, ToolParameter, ToolParameters, ToolResult};

/// The skill currently steering a conversation.
///
/// `allowed_tools` is an escalation gate, not an exclusive whitelist: callers
/// outside it may still run according to the engine's risk policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveSkill {
    pub name: String,
    pub allowed_tools: Vec<String>,
}

/// A user-originated skill control operation.
///
/// This is shared by HTTP and TUI frontends so explicit activation/reset has
/// deterministic engine semantics instead of relying on a natural-language
/// prompt asking the model to call `read_skill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SkillAction {
    Activate { name: String },
    Reset,
}

/// A fully resolved skill ready to enter the model context.
#[derive(Debug, Clone)]
pub struct LoadedSkill {
    pub active: ActiveSkill,
    pub content: String,
}

/// A deterministic explicit user activation: the skill's resolved metadata
/// plus the canonical [`crate::types::Role::Skill`] context message to stage
/// into the turn. No assistant/tool messages are fabricated — the skill body
/// is injected as input context, which every OpenAI-compatible provider
/// accepts by construction.
#[derive(Debug, Clone)]
pub struct PreparedSkillActivation {
    pub active: ActiveSkill,
    pub message: ChatMessage,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SkillLoadError {
    InvalidName,
    Unknown(String),
    Disabled(String),
    NotUserInvocable(String),
}

impl std::fmt::Display for SkillLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName => write!(f, "invalid skill name"),
            Self::Unknown(name) => write!(f, "unknown skill '{}'", name),
            Self::Disabled(name) => write!(f, "skill '{}' is disabled", name),
            Self::NotUserInvocable(name) => {
                write!(f, "skill '{}' cannot be invoked manually", name)
            }
        }
    }
}

impl std::error::Error for SkillLoadError {}

/// A discovered skill (Tier-1 metadata + paths).
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub when_to_use: Option<String>,
    /// Tools this skill declares it uses. When non-empty the agent loop treats
    /// it as an **escalation gate** while the skill is active: declared tools
    /// (plus `read_skill`/`ask_user`) run under the normal risk policy,
    /// undeclared safe tools still run, and undeclared riskier tools require
    /// user confirmation. Empty = no restriction.
    pub allowed_tools: Vec<String>,
    /// When true, only triggered by name (not auto-selected by the model).
    pub disable_model_invocation: bool,
    /// When false, the skill cannot be invoked manually by the user (model-only).
    /// Defaults to true.
    pub user_invocable: bool,
    /// Optional `/`-menu argument hint, e.g. `[channel] [--verbose]`.
    pub argument_hint: Option<String>,
    /// Optional semantic version for tracking iterations.
    pub version: Option<String>,
    /// Optional author / maintainer, free-form. Convention: `Name <email-or-url>`
    /// (the UI links a trailing `<...>` as mailto/href). Purely informational —
    /// attribution + who to contact, especially for repository-distributed skills.
    pub author: Option<String>,
    /// Execution environments this skill targets (frontmatter `env:`, open
    /// vocabulary — recommended values: `ac`, `gateway`, `container`, `pc`).
    /// Empty = runs anywhere. Market installs hard-refuse a skill whose `env`
    /// does not include the agent's configured environment (`agent.env`).
    pub env: Vec<String>,
    /// Absolute path to the skill's icon image, if any: the frontmatter `icon:`
    /// (a path relative to the skill dir) when valid, else an auto-detected
    /// `assets/icon.*` / `icon.*`. Always resolves *inside* the skill dir
    /// (traversal/symlink-escape rejected). Served at `GET /api/skills/{name}/icon`.
    pub icon: Option<PathBuf>,
    pub dir: PathBuf,
    pub skill_md: PathBuf,
}

/// A skill-discovery diagnostic surfaced to hosts (settings page / `/api/skills`)
/// instead of being silently swallowed by a `log::warn`.
#[derive(Debug, Clone)]
pub struct SkillDiagnostic {
    /// Machine-readable kind: `"parse_error"` or `"shadowed"`.
    pub kind: String,
    /// Path to the offending `SKILL.md` (or its directory).
    pub path: PathBuf,
    /// Human-readable explanation.
    pub message: String,
}

/// Hot-reloadable registry of skills discovered across multiple directories.
#[derive(Default)]
pub struct SkillRegistry {
    dirs: Vec<PathBuf>,
    skills: RwLock<HashMap<String, Skill>>,
    /// Non-fatal discovery diagnostics from the last scan (parse errors +
    /// name-collision shadowing + authoring lint), so authors can see *why* a
    /// skill is missing or malformed.
    diagnostics: RwLock<Vec<SkillDiagnostic>>,
    /// Registered tool names, injected by the host once all tools are wired
    /// (see [`SkillRegistry::set_known_tools`]). When non-empty, `scan` validates
    /// each skill's `allowed-tools` against it and reports unknown tools as lint.
    known_tools: RwLock<Vec<String>>,
    /// Names of skills the user has disabled from the management page. Disabled
    /// skills stay discoverable (`list()`/`/api/skills`) but are excluded from
    /// the model manifest and refused by `read_skill`. Persisted via
    /// [`SkillRegistry::attach_state`].
    disabled: RwLock<HashSet<String>>,
    /// Names of skills the user has pinned in the management page (sorted to the
    /// top, shown in a dedicated "pinned" section). Purely a UI ordering hint;
    /// it does not affect discovery or the model manifest. Persisted alongside
    /// `disabled` via [`SkillRegistry::attach_state`].
    pinned: RwLock<HashSet<String>>,
    /// Names of skills the user has taken OFF this agent's hub index
    /// (`GET /repo/index.json`). Orthogonal to `disabled`: `disabled` governs
    /// local use (manifest / `read_skill`), `unshared` governs distribution.
    /// Stored as an opt-out set so sharing stays the default. Persisted
    /// alongside `disabled` via [`SkillRegistry::attach_state`].
    unshared: RwLock<HashSet<String>>,
    /// Path to the JSON file the `disabled` / `pinned` / `unshared` sets are
    /// persisted to (`<data_dir>/skills-state.json`). `None` = in-memory only
    /// (tests).
    state_path: RwLock<Option<PathBuf>>,
    /// On-demand hot-reload state (see [`SkillRegistry::ensure_fresh`]).
    freshness: RwLock<Freshness>,
}

/// Hot-reload bookkeeping: when the disk state was last compared and what it
/// looked like. The fingerprint is a hash over every discovered `SKILL.md`'s
/// `(path, mtime, size)` — cheap stats, no parsing.
#[derive(Default)]
struct Freshness {
    checked_at: Option<wasmtimer::std::Instant>,
    fingerprint: u64,
}

impl SkillRegistry {
    /// Create a registry over `dirs` and perform an initial scan.
    pub fn new(dirs: Vec<PathBuf>) -> Arc<Self> {
        let reg = Arc::new(Self {
            dirs,
            skills: RwLock::new(HashMap::new()),
            diagnostics: RwLock::new(Vec::new()),
            known_tools: RwLock::new(Vec::new()),
            disabled: RwLock::new(HashSet::new()),
            pinned: RwLock::new(HashSet::new()),
            unshared: RwLock::new(HashSet::new()),
            state_path: RwLock::new(None),
            freshness: RwLock::new(Freshness::default()),
        });
        reg.scan();
        reg
    }

    /// Bind a JSON state file (`{ "disabled": [...], "pinned": [...],
    /// "unshared": [...] }`) and load it, so per-skill enable/disable, pin and
    /// share toggles survive restarts. Call once after [`SkillRegistry::new`];
    /// safe when the file is absent (starts empty) and when any key is missing
    /// (older state files).
    pub fn attach_state(&self, path: PathBuf) {
        let parsed = crate::vfs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        let read_set = |key: &str| -> HashSet<String> {
            parsed
                .as_ref()
                .and_then(|v| v.get(key))
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<HashSet<String>>()
                })
                .unwrap_or_default()
        };
        if let Ok(mut d) = self.disabled.write() {
            *d = read_set("disabled");
        }
        if let Ok(mut p) = self.pinned.write() {
            *p = read_set("pinned");
        }
        if let Ok(mut u) = self.unshared.write() {
            *u = read_set("unshared");
        }
        if let Ok(mut p) = self.state_path.write() {
            *p = Some(path);
        }
    }

    /// True when `name` has been disabled by the user.
    pub fn is_disabled(&self, name: &str) -> bool {
        self.disabled
            .read()
            .map(|d| d.contains(name))
            .unwrap_or(false)
    }

    /// True when `name` has been pinned by the user in the management page.
    pub fn is_pinned(&self, name: &str) -> bool {
        self.pinned
            .read()
            .map(|p| p.contains(name))
            .unwrap_or(false)
    }

    /// True when `name` is listed on this agent's hub index (`/repo`). Sharing
    /// is the default; the user opts a skill out from the management page.
    /// Orthogonal to [`SkillRegistry::is_disabled`]: a locally disabled skill
    /// can stay shared (e.g. an AC distributing a gateway-only skill it never
    /// runs itself), and vice versa.
    pub fn is_shared(&self, name: &str) -> bool {
        !self
            .unshared
            .read()
            .map(|u| u.contains(name))
            .unwrap_or(false)
    }

    /// Enable or disable a skill by name, persisting to the bound state file.
    /// Disabled skills are hidden from the model (manifest + `read_skill`) but
    /// stay listed for the management page.
    pub fn set_enabled(&self, name: &str, enabled: bool) {
        if let Ok(mut d) = self.disabled.write() {
            if enabled {
                d.remove(name);
            } else {
                d.insert(name.to_string());
            }
        }
        self.persist_state();
    }

    /// Pin or unpin a skill by name, persisting to the bound state file. Pinning
    /// only affects the management page's ordering (pinned skills float to the
    /// top); it does not change discovery or the model manifest.
    pub fn set_pinned(&self, name: &str, pinned: bool) {
        if let Ok(mut p) = self.pinned.write() {
            if pinned {
                p.insert(name.to_string());
            } else {
                p.remove(name);
            }
        }
        self.persist_state();
    }

    /// Share or unshare a skill on this agent's hub index (persisted).
    /// Unsharing delists it from `/repo/index.json` and 404s its package;
    /// local use (manifest / `read_skill`) is untouched.
    pub fn set_shared(&self, name: &str, shared: bool) {
        if let Ok(mut u) = self.unshared.write() {
            if shared {
                u.remove(name);
            } else {
                u.insert(name.to_string());
            }
        }
        self.persist_state();
    }

    /// Write the current `disabled` + `pinned` + `unshared` sets to the bound
    /// state file (best-effort).
    fn persist_state(&self) {
        let path = match self.state_path.read().ok().and_then(|p| p.clone()) {
            Some(p) => p,
            None => return,
        };
        let sorted = |lock: &RwLock<HashSet<String>>| -> Vec<String> {
            let mut names: Vec<String> = lock
                .read()
                .map(|s| s.iter().cloned().collect())
                .unwrap_or_default();
            names.sort();
            names
        };
        let body = serde_json::json!({
            "disabled": sorted(&self.disabled),
            "pinned": sorted(&self.pinned),
            "unshared": sorted(&self.unshared),
        });
        if let Some(parent) = path.parent() {
            let _ = crate::vfs::create_dir_all(parent);
        }
        if let Ok(s) = serde_json::to_string_pretty(&body) {
            let _ = crate::vfs::write(&path, s);
        }
    }

    /// Register the set of tool names the host has wired, then re-scan so
    /// `allowed-tools` typo checks (unknown-tool lint) take effect. Call this
    /// once after **all** tools are registered — doing it earlier would flag
    /// not-yet-registered tools (e.g. `read_skill`, declarative file-tools).
    pub fn set_known_tools(&self, tools: Vec<String>) {
        if let Ok(mut k) = self.known_tools.write() {
            *k = tools;
        }
        self.scan();
    }

    /// (Re)scan all configured directories, replacing the in-memory set.
    ///
    /// Discovery walks each root **recursively**: any directory containing a
    /// `SKILL.md` is a skill, so category folders work for grouping
    /// (`skills/diagnose/<name>/SKILL.md`) — aligned with Cursor. A skill's
    /// identity comes from the directory that holds its `SKILL.md` (or the
    /// frontmatter `name`), not the category above it. Once a `SKILL.md` is
    /// found in a directory, its subtree is not descended further.
    pub fn scan(&self) {
        let mut found: HashMap<String, Skill> = HashMap::new();
        let mut diags: Vec<SkillDiagnostic> = Vec::new();
        for dir in &self.dirs {
            if !crate::vfs::is_dir(&dir) {
                continue;
            }
            scan_dir_recursive(dir, &mut found, &mut diags);
        }
        // allowed-tools reference check: flag entries that aren't registered
        // tools (catches typos that would silently shrink a skill's toolset).
        // `read_skill`/`ask_user` are always available, so never flagged.
        let known = self
            .known_tools
            .read()
            .map(|k| k.clone())
            .unwrap_or_default();
        if !known.is_empty() {
            for s in found.values() {
                for tool in &s.allowed_tools {
                    if tool == "read_skill" || tool == "ask_user" {
                        continue;
                    }
                    if !known.iter().any(|k| k == tool) {
                        diags.push(SkillDiagnostic {
                            kind: "lint".into(),
                            path: s.skill_md.clone(),
                            message: format!(
                                "allowed-tools lists unknown tool '{}' (not registered)",
                                tool
                            ),
                        });
                    }
                }
            }
        }

        let count = found.len();
        if !diags.is_empty() {
            log::warn!(
                "skill scan: {} diagnostic(s) — see /api/skills",
                diags.len()
            );
        }
        // printk discipline: INFO only when the skill set actually changed
        // (names added/removed/updated); an identical rescan stays silent.
        let changed = self
            .skills
            .read()
            .map(|old| old.len() != found.len() || !found.keys().all(|k| old.contains_key(k)))
            .unwrap_or(true);
        if let Ok(mut s) = self.skills.write() {
            *s = found;
        }
        if let Ok(mut d) = self.diagnostics.write() {
            *d = diags;
        }
        if changed {
            log::info!("skill scan: {} skill(s) discovered", count);
        } else {
            log::debug!("skill scan: {} skill(s), unchanged", count);
        }
        // Record what disk looked like for this scan so ensure_fresh() can
        // cheaply detect the next change.
        if let Ok(mut f) = self.freshness.write() {
            f.fingerprint = self.fingerprint();
            f.checked_at = Some(wasmtimer::std::Instant::now());
        }
    }

    /// Cheap disk fingerprint: hash of every discovered `SKILL.md`'s
    /// `(path, mtime, size)`. Same traversal rules as [`SkillRegistry::scan`]
    /// (a dir owning a `SKILL.md` is a leaf), but stat-only — no parsing.
    fn fingerprint(&self) -> u64 {
        use std::hash::Hasher;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for dir in &self.dirs {
            if crate::vfs::is_dir(&dir) {
                fingerprint_dir_recursive(dir, &mut hasher);
            }
        }
        hasher.finish()
    }

    /// Hot reload, pull-model: bring the registry up to date with disk **at the
    /// moment it is read**.
    ///
    /// Skills are only consumed at a handful of read points (`manifest()` for
    /// the system prompt, `get()`/`read_body()` for `read_skill`, `list()` /
    /// `diagnostics()` for the management API) — between reads, nobody looks at
    /// the data, so a background poller (or inotify) refreshes state no one is
    /// consuming. Instead each read point calls this: a TTL-debounced stat
    /// fingerprint (~a few stats every ≥2s), with a full re-parse only when
    /// disk actually changed. Idle process ⇒ zero work, zero log noise.
    pub fn ensure_fresh(&self) {
        const TTL: std::time::Duration = std::time::Duration::from_secs(2);
        {
            // One checker at a time; concurrent readers just use the snapshot.
            let Ok(mut fresh) = self.freshness.try_write() else {
                return;
            };
            if fresh.checked_at.is_some_and(|t| t.elapsed() < TTL) {
                return;
            }
            let fp = self.fingerprint();
            let unchanged = fp == fresh.fingerprint;
            fresh.checked_at = Some(wasmtimer::std::Instant::now());
            fresh.fingerprint = fp;
            if unchanged {
                return;
            }
        } // release the lock: scan() re-enters freshness at its tail
        self.scan();
    }

    /// Non-fatal diagnostics from the last scan (parse errors + shadowing).
    pub fn diagnostics(&self) -> Vec<SkillDiagnostic> {
        self.ensure_fresh();
        self.diagnostics
            .read()
            .map(|d| d.clone())
            .unwrap_or_default()
    }

    pub fn get(&self, name: &str) -> Option<Skill> {
        self.ensure_fresh();
        self.skills.read().ok()?.get(name).cloned()
    }

    pub fn list(&self) -> Vec<Skill> {
        self.ensure_fresh();
        let mut v: Vec<Skill> = self
            .skills
            .read()
            .map(|s| s.values().cloned().collect())
            .unwrap_or_default();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    pub fn is_empty(&self) -> bool {
        self.skills.read().map(|s| s.is_empty()).unwrap_or(true)
    }

    /// Tier-1 manifest text for injection into the system prompt.
    ///
    /// Skills flagged `disable-model-invocation` (manual) are **excluded** so the
    /// model never learns their names and cannot auto-load them. They stay
    /// reachable only by explicit user request: the `/` palette expands to a
    /// directive naming the skill, and `read_skill` resolves by registry (not
    /// this manifest). This makes `disable-model-invocation` an enforced boundary
    /// rather than an advisory label.
    ///
    /// User-disabled skills (management-page toggle, see [`SkillRegistry::set_enabled`])
    /// are likewise excluded and additionally refused by `read_skill`.
    pub fn manifest(&self) -> String {
        let skills: Vec<Skill> = self
            .list()
            .into_iter()
            .filter(|s| !s.disable_model_invocation && !self.is_disabled(&s.name))
            .collect();
        if skills.is_empty() {
            return String::new();
        }
        let mut out = String::from(
            "# Available Skills\n\
             You have access to the following skills. When a user request matches a \
             skill's purpose, call `read_skill` with its `name` to load the full \
             instructions, then follow them.\n\n",
        );
        for s in &skills {
            out.push_str(&format!("- **{}**: {}", s.name, s.description));
            if let Some(w) = &s.when_to_use {
                out.push_str(&format!(" — when: {}", w));
            }
            if let Some(v) = &s.version {
                out.push_str(&format!(" [v{}]", v));
            }
            out.push('\n');
        }
        out
    }

    /// Tier-2 body: the `SKILL.md` content for `name` (frontmatter stripped).
    pub fn read_body(&self, name: &str) -> Option<String> {
        let skill = self.get(name)?;
        let raw = crate::vfs::read_to_string(&skill.skill_md).ok()?;
        Some(strip_frontmatter(&raw))
    }

    /// The skill's `CHANGELOG.md` (raw markdown), when it ships one in its
    /// directory. `None` = unknown skill or no changelog file.
    pub fn read_changelog(&self, name: &str) -> Option<String> {
        let skill = self.get(name)?;
        crate::vfs::read_to_string(skill.dir.join("CHANGELOG.md")).ok()
    }
}

/// Recursively walk `dir`: a directory holding a `SKILL.md` is parsed as a skill
/// (and its subtree is not descended further); otherwise descend into
/// subdirectories. First occurrence wins on name collision (directory order,
/// then a stable sort within each level for deterministic precedence).
fn scan_dir_recursive(
    dir: &Path,
    found: &mut HashMap<String, Skill>,
    diags: &mut Vec<SkillDiagnostic>,
) {
    let skill_md = dir.join("SKILL.md");
    if crate::vfs::is_file(&skill_md) {
        match parse_skill(dir, &skill_md) {
            Ok(skill) => {
                use std::collections::hash_map::Entry;
                match found.entry(skill.name.clone()) {
                    Entry::Vacant(v) => {
                        // Surface authoring lint (name/description/size) as
                        // non-fatal diagnostics so authors can tidy up.
                        for w in lint_skill(dir) {
                            diags.push(SkillDiagnostic {
                                kind: "lint".into(),
                                path: skill_md.clone(),
                                message: w,
                            });
                        }
                        v.insert(skill);
                    }
                    Entry::Occupied(existing) => {
                        // A later directory lost the name race; record it so the
                        // author sees the shadowing rather than a silent drop.
                        diags.push(SkillDiagnostic {
                            kind: "shadowed".into(),
                            path: skill.dir.clone(),
                            message: format!(
                                "skill '{}' is shadowed by an earlier definition at {}",
                                skill.name,
                                existing.get().dir.display()
                            ),
                        });
                    }
                }
            }
            Err(e) => {
                log::warn!("skill parse failed for {}: {}", skill_md.display(), e);
                diags.push(SkillDiagnostic {
                    kind: "parse_error".into(),
                    path: skill_md.clone(),
                    message: e,
                });
            }
        }
        return; // a skill directory is a leaf; don't nest skills inside skills
    }
    let entries = match crate::vfs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("skill scan: cannot read {}: {}", dir.display(), e);
            return;
        }
    };
    let mut subdirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| crate::vfs::is_dir(&p))
        .collect();
    subdirs.sort(); // deterministic precedence within a level
    for sub in subdirs {
        scan_dir_recursive(&sub, found, diags);
    }
}

/// Stat-only mirror of [`scan_dir_recursive`]'s traversal, feeding a hasher:
/// a directory owning a `SKILL.md` contributes `(path, size, mtime)` and is a
/// leaf; anything else descends. Never opens or parses file contents.
fn fingerprint_dir_recursive(dir: &Path, hasher: &mut std::collections::hash_map::DefaultHasher) {
    use std::hash::Hash;
    let skill_md = dir.join("SKILL.md");
    if let Ok(meta) = crate::vfs::metadata(&skill_md) {
        if meta.is_file() {
            skill_md.hash(hasher);
            meta.len().hash(hasher);
            if let Ok(d) = meta
                .modified()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default())
            {
                d.as_nanos().hash(hasher);
            }
            return;
        }
    }
    let Ok(entries) = crate::vfs::read_dir(dir) else {
        return;
    };
    let mut subdirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| crate::vfs::is_dir(&p))
        .collect();
    subdirs.sort();
    for sub in subdirs {
        fingerprint_dir_recursive(&sub, hasher);
    }
}

/// Split a `SKILL.md` into (frontmatter_yaml, body).
fn split_frontmatter(raw: &str) -> (Option<&str>, &str) {
    let trimmed = raw.trim_start_matches('\u{feff}');
    if let Some(rest) = trimmed.strip_prefix("---") {
        // rest starts right after the opening '---'
        let rest = rest
            .strip_prefix('\n')
            .or_else(|| rest.strip_prefix("\r\n"))
            .unwrap_or(rest);
        if let Some(end) = find_closing_delim(rest) {
            let fm = &rest[..end.0];
            let body = &rest[end.1..];
            return (Some(fm), body);
        }
    }
    (None, raw)
}

/// Find the closing `---` delimiter line; returns (fm_end, body_start).
fn find_closing_delim(s: &str) -> Option<(usize, usize)> {
    let mut idx = 0;
    for line in s.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" {
            return Some((idx, idx + line.len()));
        }
        idx += line.len();
    }
    None
}

pub(crate) fn strip_frontmatter(raw: &str) -> String {
    split_frontmatter(raw).1.trim_start().to_string()
}

fn parse_skill(dir: &Path, skill_md: &Path) -> Result<Skill, String> {
    let raw = crate::vfs::read_to_string(skill_md).map_err(|e| e.to_string())?;
    let (fm, _body) = split_frontmatter(&raw);
    let fm = fm.ok_or_else(|| "missing YAML frontmatter".to_string())?;

    let value: serde_yaml::Value =
        serde_yaml::from_str(fm).map_err(|e| format!("invalid YAML frontmatter: {}", e))?;
    let map = value
        .as_mapping()
        .ok_or_else(|| "frontmatter is not a mapping".to_string())?;

    let get_str = |key: &str| -> Option<String> {
        map.get(serde_yaml::Value::String(key.to_string()))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    let dir_name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = get_str("name").unwrap_or(dir_name);
    let description = get_str("description")
        .ok_or_else(|| "frontmatter missing required `description`".to_string())?;
    let when_to_use = get_str("when_to_use").or_else(|| get_str("when-to-use"));

    let allowed_tools = map
        .get(serde_yaml::Value::String("allowed-tools".to_string()))
        .or_else(|| map.get(serde_yaml::Value::String("allowed_tools".to_string())))
        .map(parse_string_list)
        .unwrap_or_default();

    let disable_model_invocation = map
        .get(serde_yaml::Value::String(
            "disable-model-invocation".to_string(),
        ))
        .or_else(|| {
            map.get(serde_yaml::Value::String(
                "disable_model_invocation".to_string(),
            ))
        })
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // `user-invocable: false` makes a skill model-only (no manual `/` trigger).
    let user_invocable = map
        .get(serde_yaml::Value::String("user-invocable".to_string()))
        .or_else(|| map.get(serde_yaml::Value::String("user_invocable".to_string())))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let argument_hint = get_str("argument-hint").or_else(|| get_str("argument_hint"));
    let version = get_str("version");
    let author = get_str("author");
    let icon = resolve_icon(dir, get_str("icon").as_deref());

    // `env: gateway, container` or `env: [gateway, container]` — target
    // execution environments (open vocabulary). Missing/empty = anywhere.
    let env = map
        .get(serde_yaml::Value::String("env".to_string()))
        .map(parse_string_list)
        .unwrap_or_default();

    Ok(Skill {
        name,
        description,
        when_to_use,
        allowed_tools,
        disable_model_invocation,
        user_invocable,
        argument_hint,
        version,
        author,
        env,
        icon,
        dir: dir.to_path_buf(),
        skill_md: skill_md.to_path_buf(),
    })
}

/// Parse the `SKILL.md` in `dir` (public wrapper over the internal parser) so
/// hosts can validate an imported skill package before installing it.
pub fn parse_skill_dir(dir: &Path) -> Result<Skill, String> {
    parse_skill(dir, &dir.join("SKILL.md"))
}

/// Resolve a skill's icon to an absolute path **inside** the skill dir, or `None`.
///
/// A frontmatter `icon:` (relative path) wins when it exists and stays within the
/// dir; otherwise we auto-detect a conventional `assets/icon.*` / `icon.*`. The
/// containment check canonicalizes both sides, rejecting `..` traversal and
/// symlink escapes so the icon endpoint can only ever serve in-skill files.
fn resolve_icon(dir: &Path, declared: Option<&str>) -> Option<PathBuf> {
    if let Some(rel) = declared {
        let rel = rel.trim();
        if !rel.is_empty() {
            let cand = dir.join(rel);
            return (crate::vfs::is_file(&cand) && is_within(dir, &cand)).then_some(cand);
        }
    }
    const CANDIDATES: [&str; 10] = [
        "assets/icon.svg",
        "assets/icon.png",
        "assets/icon.webp",
        "assets/icon.jpg",
        "assets/icon.jpeg",
        "icon.svg",
        "icon.png",
        "icon.webp",
        "icon.jpg",
        "icon.jpeg",
    ];
    CANDIDATES
        .iter()
        .map(|n| dir.join(n))
        .find(|cand| crate::vfs::is_file(&cand))
}

/// True when `path` canonically resolves to a location inside `base`. Both must
/// exist (callers check `is_file()` first). Rejects `..` traversal + symlink
/// escapes.
fn is_within(base: &Path, path: &Path) -> bool {
    match (
        crate::vfs::canonicalize(base),
        crate::vfs::canonicalize(path),
    ) {
        (Ok(b), Ok(p)) => p.starts_with(b),
        _ => false,
    }
}

/// Validate a skill directory against the community `SKILL.md` conventions
/// (name format, description length, file size, and `references/`/`scripts/`
/// reference existence). Returns a list of human-readable warnings — empty means
/// the skill is well-formed. Used by the `skill lint` helper and unit tests;
/// hosts may surface these in tooling.
///
/// Note: `allowed-tools` reference checking lives in [`SkillRegistry::scan`]
/// (via [`SkillRegistry::set_known_tools`]) because it needs the registered
/// tool set, which this filesystem-only function has no access to.
pub fn lint_skill(dir: &Path) -> Vec<String> {
    let mut warnings = Vec::new();
    let skill_md = dir.join("SKILL.md");
    if !crate::vfs::is_file(&skill_md) {
        warnings.push(format!("missing SKILL.md in {}", dir.display()));
        return warnings;
    }
    let raw = match crate::vfs::read_to_string(&skill_md) {
        Ok(r) => r,
        Err(e) => {
            warnings.push(format!("cannot read SKILL.md: {}", e));
            return warnings;
        }
    };

    match parse_skill(dir, &skill_md) {
        Ok(skill) => {
            if !is_valid_skill_name(&skill.name) {
                warnings.push(format!(
                    "name '{}' should match ^[a-z0-9-]{{1,64}}$ and not start/end with '-'",
                    skill.name
                ));
            }
            if is_reset_skill_name(&skill.name) {
                warnings.push(format!(
                    "name '{}' is reserved (reset/none) and will be shadowed by the read_skill \
                     escape hatch; rename it",
                    skill.name
                ));
            }
            let desc_len = skill.description.chars().count();
            if skill.description.trim().is_empty() {
                warnings.push("description must not be empty".into());
            } else if desc_len > 1024 {
                warnings.push(format!("description is {} chars (>1024 max)", desc_len));
            }
        }
        Err(e) => warnings.push(format!("frontmatter invalid: {}", e)),
    }

    let line_count = raw.lines().count();
    if line_count > 500 {
        warnings.push(format!(
            "SKILL.md is {} lines (>500); keep it a router and move detail into references/",
            line_count
        ));
    } else if line_count > 300 {
        warnings.push(format!(
            "SKILL.md is {} lines (>300); consider splitting into references/ modules",
            line_count
        ));
    }

    // Reference check: `references/...` and `scripts/...` paths mentioned in the
    // body should resolve relative to the skill dir (these prefixes are the
    // Tier-3 convention, so relative resolution is unambiguous and low-noise).
    let body = strip_frontmatter(&raw);
    for rel in referenced_paths(&body) {
        if !crate::vfs::exists(&dir.join(&rel)) {
            warnings.push(format!("referenced file not found: {}", rel));
        }
    }
    warnings
}

/// Extract `references/<path>` and `scripts/<path>` references from a skill body,
/// deduplicated. Requires a non-path char before the prefix (word boundary) to
/// avoid matching inside longer words. Conservative on purpose: only these two
/// in-skill prefixes are checked, so we don't guess at `docs/`-style paths whose
/// root we can't resolve.
fn referenced_paths(body: &str) -> Vec<String> {
    const PREFIXES: [&str; 2] = ["references/", "scripts/"];
    let bytes = body.as_bytes();
    let is_path_char = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'/' | b'-');
    let mut out: Vec<String> = Vec::new();
    for prefix in PREFIXES {
        let mut from = 0;
        while let Some(rel) = body[from..].find(prefix) {
            let start = from + rel;
            let boundary_ok = start == 0 || !is_path_char(bytes[start - 1]);
            let mut end = start + prefix.len();
            while end < bytes.len() && is_path_char(bytes[end]) {
                end += 1;
            }
            from = end.max(start + 1);
            if !boundary_ok {
                continue;
            }
            let path = body[start..end].trim_end_matches(['/', '.']);
            if path.len() > prefix.len() && !out.iter().any(|p| p == path) {
                out.push(path.to_string());
            }
        }
    }
    out
}

/// Reserved `read_skill` argument that clears the active skill and restores the
/// full toolset instead of loading a skill. Matches `reset` / `none`
/// (case- and whitespace-insensitive). These names are therefore not usable as
/// real skill names.
pub fn is_reset_skill_name(name: &str) -> bool {
    matches!(name.trim().to_ascii_lowercase().as_str(), "reset" | "none")
}

/// True when `name` matches the community convention: 1-64 chars of lowercase
/// letters / digits / hyphens, not starting or ending with a hyphen.
pub fn is_valid_skill_name(name: &str) -> bool {
    let len = name.chars().count();
    if len == 0 || len > 64 {
        return false;
    }
    if name.starts_with('-') || name.ends_with('-') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Accept either a YAML sequence (`[a, b]`) or a comma-separated string.
fn parse_string_list(v: &serde_yaml::Value) -> Vec<String> {
    if let Some(seq) = v.as_sequence() {
        seq.iter()
            .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect()
    } else if let Some(s) = v.as_str() {
        s.split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect()
    } else {
        Vec::new()
    }
}

/// Resolve and render a skill exactly as `read_skill` exposes it to the model.
///
/// `require_user_invocable` is true for explicit frontend actions and false
/// for model-originated `read_skill` calls.
fn resolve_skill(
    registry: &SkillRegistry,
    name: &str,
    require_user_invocable: bool,
) -> Result<Skill, SkillLoadError> {
    if !is_valid_skill_name(name) {
        return Err(if name.is_empty() {
            SkillLoadError::InvalidName
        } else {
            SkillLoadError::Unknown(name.to_string())
        });
    }
    if registry.is_disabled(name) {
        return Err(SkillLoadError::Disabled(name.to_string()));
    }
    let skill = registry
        .get(name)
        .ok_or_else(|| SkillLoadError::Unknown(name.to_string()))?;
    if require_user_invocable && !skill.user_invocable {
        return Err(SkillLoadError::NotUserInvocable(name.to_string()));
    }
    Ok(skill)
}

/// Resolve the active-state metadata without reading the SKILL.md body.
pub fn resolve_active_skill(
    registry: &SkillRegistry,
    name: &str,
    require_user_invocable: bool,
) -> Result<ActiveSkill, SkillLoadError> {
    let skill = resolve_skill(registry, name, require_user_invocable)?;
    Ok(ActiveSkill {
        name: skill.name,
        allowed_tools: skill.allowed_tools,
    })
}

pub fn load_skill(
    registry: &SkillRegistry,
    name: &str,
    require_user_invocable: bool,
) -> Result<LoadedSkill, SkillLoadError> {
    let skill = resolve_skill(registry, name, require_user_invocable)?;
    let body = registry
        .read_body(name)
        .ok_or_else(|| SkillLoadError::Unknown(name.to_string()))?;

    let mut content = format!("# Skill: {}\n[dir: {}]\n", skill.name, skill.dir.display());
    if let Some(v) = &skill.version {
        content.push_str(&format!("[version: {}]\n", v));
    }
    if !skill.allowed_tools.is_empty() {
        content.push_str(&format!(
            "[allowed-tools: {} — prefer these while this skill is active; \
             other safe tools still work, riskier ones need user approval]\n",
            skill.allowed_tools.join(", ")
        ));
    }
    content.push('\n');
    content.push_str(&body);

    Ok(LoadedSkill {
        active: ActiveSkill {
            name: skill.name,
            allowed_tools: skill.allowed_tools,
        },
        content,
    })
}

/// Prepare a deterministic explicit activation. The skill body becomes a
/// canonical [`crate::types::Role::Skill`] message the caller stages after the
/// user message, before starting the LLM turn. Explicit activation is user
/// intent, so it is injected as input context — never as fabricated model
/// output (some providers, e.g. DeepSeek thinking models, reject assistant
/// tool-call messages the model did not actually produce).
pub fn prepare_user_skill_activation(
    registry: &SkillRegistry,
    name: &str,
) -> Result<PreparedSkillActivation, SkillLoadError> {
    let loaded = load_skill(registry, name, true)?;
    let message = ChatMessage::skill_context(&loaded.active.name, &loaded.content);

    Ok(PreparedSkillActivation {
        active: loaded.active,
        message,
    })
}

/// `read_skill` — Tier-2 loader. Reads a skill's `SKILL.md` body by name.
pub struct ReadSkillTool {
    registry: Arc<SkillRegistry>,
}

impl ReadSkillTool {
    pub fn new(registry: Arc<SkillRegistry>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl Tool for ReadSkillTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "read_skill",
            "Load the full instructions for a skill by name (from the skills manifest \
             in the system prompt). Returns the SKILL.md body; follow it, reading any \
             referenced files/scripts on demand with read_file / run_shell. Pass \
             name=\"reset\" to exit the current skill and restore the full toolset.",
            ToolParameters::object(
                HashMap::from([(
                    "name".into(),
                    ToolParameter::string("Skill name (as shown in the manifest)"),
                )]),
                vec!["name".into()],
            ),
        )
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            return ToolResult::text("Error: name is required").with_success(false);
        }
        // Reserved escape hatch: leaving the active skill restores the full
        // toolset. The agent loop watches for this result to clear its
        // `active_skill` state (see `process_message`).
        if is_reset_skill_name(name) {
            return ToolResult::text_raw("Exited the active skill; all tools are available again.")
                .with_success(true);
        }
        match load_skill(&self.registry, name, false) {
            Ok(loaded) => ToolResult::text_raw(loaded.content).with_success(true),
            Err(SkillLoadError::Disabled(_)) => ToolResult::text(format!(
                "[NO_RETRY] Skill '{}' is currently disabled and cannot be loaded.",
                name
            ))
            .with_success(false),
            Err(_) => ToolResult::text(format!(
                "[NO_RETRY] Unknown skill '{}'. Check the skills manifest for valid names.",
                name
            ))
            .with_success(false),
        }
    }
}
