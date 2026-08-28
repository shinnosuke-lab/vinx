//! OS capability tools — the minimal "hands" of the agent.
//!
//! Structured file ops (`read_file` / `write_file` / `edit_file` /
//! `search_files` / `list_files`), over the page's workspace rather than a
//! host filesystem: every `std::fs` call below is redirected to
//! [`crate::vfs`]. Upstream's `run_shell` is not here — a gateway has no
//! shell, and the device's `run_python` tool is its equivalent.
//!
//! Reads are `Safe`; writes/edits are `Dangerous` (confirmation). An
//! [`OsPolicy`] enforces a path allow-list and a global read-only switch so the
//! agent can be scoped to controlled directories in industrial deployments.

mod fs;
mod open_terminal;
mod paths;
mod search;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::tool::{Tool, ToolContext, ToolRegistry};
use crate::types::{RiskLevel, ToolDefinition, ToolResult};

pub use fs::{EditFileTool, ListFilesTool, ReadFileTool, WriteFileTool};
pub use open_terminal::OpenTerminalTool;
pub use paths::{SafePathAllowList, MAX_SAFE_PATHS};
pub use search::SearchFilesTool;

/// The bare-filename convention, shared by every tool that takes a file path
/// from the model: a path with no separators that is not absolute resolves
/// inside the drafts bucket, anything carrying a path is used verbatim. This is
/// what makes `write_file("hero.svg")` compose with `publish` and with
/// `set_chat_style`'s theme assets, without the model tracking absolute paths.
pub fn resolve_in_drafts(drafts_dir: Option<&Path>, path: &str) -> String {
    if let Some(drafts) = drafts_dir {
        let p = path.trim();
        let bare =
            !p.is_empty() && !p.contains('/') && !p.contains('\\') && !Path::new(p).is_absolute();
        if bare {
            return drafts.join(p).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Scoping policy for OS tools.
#[derive(Debug, Clone, Default)]
pub struct OsPolicy {
    /// Allowed filesystem roots (read + write). Empty = unrestricted (dev only).
    pub allow_roots: Vec<PathBuf>,
    /// Extra roots allowed for **reading only** (never writable) — e.g. skill
    /// directories, so a skill's Tier-3 `references/`/`scripts/` stay reachable
    /// via `read_file`/`search_files` even when outside `allow_roots`.
    pub read_roots: Vec<PathBuf>,
    /// When true, write/edit tools refuse to run (reads still allowed).
    pub read_only: bool,
}

/// Canonicalize roots up front; keep the raw path when it doesn't resolve.
fn canonicalize_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    roots
        .into_iter()
        .filter_map(|r| crate::vfs::canonicalize(&r).ok().or(Some(r)))
        .collect()
}

impl OsPolicy {
    pub fn new(allow_roots: Vec<PathBuf>, read_only: bool) -> Self {
        Self {
            allow_roots: canonicalize_roots(allow_roots),
            read_roots: Vec::new(),
            read_only,
        }
    }

    /// Add read-only roots (canonicalized, appended). Chainable on top of
    /// [`OsPolicy::new`].
    pub fn with_read_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.read_roots.append(&mut canonicalize_roots(roots));
        self
    }

    /// Unrestricted policy (allow everything, writes enabled). Dev/testing only.
    pub fn unrestricted() -> Self {
        Self {
            allow_roots: Vec::new(),
            read_roots: Vec::new(),
            read_only: false,
        }
    }

    fn is_within_roots(&self, target: &Path) -> bool {
        if self.allow_roots.is_empty() {
            return true;
        }
        self.allow_roots.iter().any(|r| target.starts_with(r))
    }

    /// Readable when within the (read+write) allow roots or the read-only roots.
    fn is_readable(&self, target: &Path) -> bool {
        self.is_within_roots(target) || self.read_roots.iter().any(|r| target.starts_with(r))
    }

    /// Validate a path for reading. Returns the canonical path or an error.
    pub fn check_read(&self, path: &str) -> Result<PathBuf, String> {
        let p = Path::new(path);
        let canonical = crate::vfs::canonicalize(p)
            .map_err(|_| format!("Error: cannot resolve path: {}", path))?;
        if !self.is_readable(&canonical) {
            return Err(format!(
                "Error: path '{}' is outside the allowed roots; access denied.",
                path
            ));
        }
        Ok(canonical)
    }

    /// Validate a path for writing. Non-existent targets are allowed — the
    /// nearest EXISTING ancestor directory is canonicalized (symlinks
    /// resolved) and checked against the allowed roots, so `write_file` can
    /// create parent directories as its description promises. The
    /// not-yet-existing suffix is re-attached verbatim; any `..` in it is
    /// rejected (it could escape the checked ancestor once dirs are created).
    pub fn check_write(&self, path: &str) -> Result<PathBuf, String> {
        if self.read_only {
            return Err(
                "Error: agent is in read-only mode; write/edit operations are disabled.".into(),
            );
        }
        let p = Path::new(path);
        if let Ok(canonical) = crate::vfs::canonicalize(p) {
            // Existing file.
            if !self.is_within_roots(&canonical) {
                return Err(format!(
                    "Error: path '{}' is outside the allowed roots; write denied.",
                    path
                ));
            }
            return Ok(canonical);
        }
        // Upstream refuses dangling symlinks here (a path whose
        // symlink_metadata succeeds but whose canonicalize failed). The VFS
        // has no symlinks, so that case cannot arise: an existing VFS path
        // always canonicalizes, and a failed canonicalize means a new target.
        //
        // New target: walk up to the nearest existing ancestor. `file_name()`
        // returns `None` for `..`-form components, so a traversal component in
        // the missing suffix fails the walk instead of escaping the check.
        let file_name = p
            .file_name()
            .ok_or_else(|| format!("Error: invalid file path: {}", path))?;
        let parent = p
            .parent()
            .filter(|pp| !pp.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let mut probe = parent;
        let mut missing: Vec<std::ffi::OsString> = Vec::new();
        let ancestor = loop {
            match crate::vfs::canonicalize(probe) {
                Ok(c) => break c,
                Err(_) => match probe.file_name() {
                    Some(name) => {
                        missing.push(name.to_os_string());
                        probe = probe
                            .parent()
                            .filter(|pp| !pp.as_os_str().is_empty())
                            .unwrap_or_else(|| Path::new("."));
                    }
                    None => {
                        return Err(format!(
                            "Error: cannot resolve an existing ancestor directory for: {}",
                            path
                        ))
                    }
                },
            }
        };
        if !self.is_within_roots(&ancestor) {
            return Err(format!(
                "Error: path '{}' is outside the allowed roots; write denied.",
                path
            ));
        }
        if !crate::vfs::is_dir(&ancestor) {
            // e.g. writing under `/allowed/notes.txt/sub/…` — fail here with a
            // clear message instead of an OS-level ENOTDIR at create time.
            return Err(format!(
                "Error: '{}' is not a directory; cannot create '{}' under it.",
                ancestor.display(),
                path
            ));
        }
        let mut resolved = ancestor;
        for name in missing.iter().rev() {
            resolved.push(name);
        }
        resolved.push(file_name);
        Ok(resolved)
    }
}

/// Register the full minimal OS toolset into `registry`, sharing one `policy`.
/// No auditing — for hosts that don't need a tool-call trail.
pub fn register(registry: &ToolRegistry, policy: OsPolicy) {
    let policy = Arc::new(policy);
    registry.register(Arc::new(ReadFileTool::new(policy.clone())));
    registry.register(Arc::new(WriteFileTool::new(policy.clone())));
    registry.register(Arc::new(EditFileTool::new(policy.clone())));
    registry.register(Arc::new(SearchFilesTool::new(policy.clone())));
    registry.register(Arc::new(ListFilesTool::new(policy)));
}

/// A host-supplied sink for tool-call audit events. Implementors typically
/// forward to an event log / audit store. Both hooks are async so an impl can
/// `.await` an async logger; keep them fast and non-blocking.
#[async_trait]
pub trait ToolAuditor: Send + Sync {
    /// Called just before a wrapped tool executes. `args_summary` is a compact,
    /// length-bounded one-liner of the arguments.
    async fn before(&self, tool: &str, args_summary: &str);
    /// Called right after a wrapped tool executes, with the result's success flag.
    async fn after(&self, tool: &str, success: bool);
}

/// Default [`ToolAuditor`]: records wrapped (dangerous) tool calls via the `log`
/// facade under target `agent::audit`. [`WebAgentBuilder`](crate::WebAgentBuilder)
/// installs this when a host doesn't supply its own auditor, so an integration
/// always gets a tool-call trail in the agent log (e.g. `agent.log`).
pub struct LogAuditor;

#[async_trait]
impl ToolAuditor for LogAuditor {
    async fn before(&self, tool: &str, args_summary: &str) {
        log::info!(target: "agent::audit", "tool-call {} args={}", tool, args_summary);
    }
    async fn after(&self, tool: &str, success: bool) {
        log::info!(target: "agent::audit", "tool-done {} success={}", tool, success);
    }
}

/// Compact one-line argument summary (truncated to ~300 bytes on a char boundary).
pub fn summarize_args(args: &Value) -> String {
    let s = serde_json::to_string(args).unwrap_or_else(|_| "<unserializable>".into());
    const MAX: usize = 300;
    if s.len() > MAX {
        let mut cut = MAX;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &s[..cut])
    } else {
        s
    }
}

/// Transparent decorator that reports a tool call to a [`ToolAuditor`] before
/// and after execution. Definition / risk / name / interactivity all delegate to
/// the inner tool, so confirmation-gating is unaffected.
pub struct AuditedTool {
    inner: Arc<dyn Tool>,
    auditor: Arc<dyn ToolAuditor>,
}

impl AuditedTool {
    pub fn new(inner: Arc<dyn Tool>, auditor: Arc<dyn ToolAuditor>) -> Self {
        Self { inner, auditor }
    }
}

#[async_trait]
impl Tool for AuditedTool {
    fn definition(&self) -> ToolDefinition {
        self.inner.definition()
    }
    fn name(&self) -> String {
        self.inner.name()
    }
    fn risk(&self, args: &Value) -> RiskLevel {
        self.inner.risk(args)
    }
    fn interactive(&self) -> bool {
        self.inner.interactive()
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> ToolResult {
        let name = self.inner.name();
        self.auditor.before(&name, &summarize_args(&args)).await;
        let result = self.inner.execute(args, ctx).await;
        self.auditor
            .after(&name, result.success.unwrap_or(true))
            .await;
        result
    }
}

/// Register the OS toolset with optional auditing: read tools (Safe) register
/// directly to keep the trail quiet; write/edit tools (Dangerous) are
/// wrapped in [`AuditedTool`] when an `auditor` is given. With `auditor = None`
/// this is equivalent to [`register`]. `drafts_dir`, when set,
/// redirects bare-filename `write_file` targets into the runtime drafts bucket
/// (such writes are `Safe`).
/// `safe_paths`, when set, is the shared write/edit directory allow-list (writes
/// inside a trusted folder downgrade to `Safe`).
pub fn register_audited(
    registry: &ToolRegistry,
    policy: OsPolicy,
    auditor: Option<Arc<dyn ToolAuditor>>,
    drafts_dir: Option<PathBuf>,
    safe_paths: Option<Arc<SafePathAllowList>>,
) {
    let policy = Arc::new(policy);

    // Reads (Safe): registered directly (no audit noise).
    registry.register(Arc::new(ReadFileTool::new(policy.clone())));
    registry.register(Arc::new(ListFilesTool::new(policy.clone())));
    registry.register(Arc::new(SearchFilesTool::new(policy.clone())));

    // Writes / edits (Dangerous): confirmation + optional audit wrap.
    let wrap = |t: Arc<dyn Tool>| -> Arc<dyn Tool> {
        match &auditor {
            Some(a) => Arc::new(AuditedTool::new(t, Arc::clone(a))),
            None => t,
        }
    };
    registry.register(wrap(Arc::new(
        WriteFileTool::new(policy.clone())
            .with_drafts_dir(drafts_dir.clone())
            .with_safe_paths(safe_paths.clone()),
    )));
    registry.register(wrap(Arc::new(
        EditFileTool::new(policy.clone()).with_safe_paths(safe_paths),
    )));
}
