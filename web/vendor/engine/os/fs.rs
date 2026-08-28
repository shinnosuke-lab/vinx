//! Structured filesystem tools: `read_file`, `write_file`, `edit_file`,
//! `list_files`. Reads are `Safe`; writes/edits are `Dangerous`. All paths are
//! validated against the shared [`OsPolicy`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use crate::os::{OsPolicy, SafePathAllowList};
use crate::tool::{Tool, ToolContext};
use crate::types::{RiskLevel, ToolDefinition, ToolParameter, ToolParameters, ToolResult};

// ── read_file ──

pub struct ReadFileTool {
    policy: Arc<OsPolicy>,
}

impl ReadFileTool {
    pub fn new(policy: Arc<OsPolicy>) -> Self {
        Self { policy }
    }
}

#[async_trait]
impl Tool for ReadFileTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "read_file",
            "Read text file contents with line numbers. Large files (>500 lines) \
             without a range return metadata + head/tail preview; use \
             start_line/end_line for a precise range. Line numbers start at 1.",
            ToolParameters::object(
                HashMap::from([
                    (
                        "path".into(),
                        ToolParameter::string("File path (absolute or relative)"),
                    ),
                    (
                        "start_line".into(),
                        ToolParameter::integer("Start line, 1-based, optional"),
                    ),
                    (
                        "end_line".into(),
                        ToolParameter::integer("End line, inclusive, optional"),
                    ),
                ]),
                vec!["path".into()],
            ),
        )
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return ToolResult::text("Error: path is required").with_success(false);
        }
        let resolved = match self.policy.check_read(path) {
            Ok(p) => p,
            Err(e) => return ToolResult::text(e).with_success(false),
        };
        let start = args
            .get("start_line")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);
        let end = args
            .get("end_line")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);
        execute_read_file(&resolved, path, start, end).await
    }
}

async fn execute_read_file(
    resolved: &Path,
    display: &str,
    start: Option<usize>,
    end: Option<usize>,
) -> ToolResult {
    const LARGE_FILE_LINES: usize = 500;
    const HEAD_LINES: usize = 50;
    const TAIL_LINES: usize = 20;
    const MAX_OUTPUT_CHARS: usize = 60_000;

    let bytes = match crate::vfs::read(resolved) {
        Ok(b) => b,
        Err(e) => {
            let msg = match e.kind() {
                std::io::ErrorKind::NotFound => format!("Error: file not found: {}", display),
                std::io::ErrorKind::PermissionDenied => {
                    format!("Error: permission denied: {}", display)
                }
                _ => format!("Error reading file: {}", e),
            };
            return ToolResult::text(msg).with_success(false);
        }
    };

    if bytes.iter().take(8192).any(|&b| b == 0) {
        return ToolResult::text(format!(
            "[Binary file: {} | {} bytes]\nCannot read binary files as text.",
            display,
            bytes.len()
        ))
        .with_success(true);
    }

    let content = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let size_kb = bytes.len() as f64 / 1024.0;

    let mut result = format!(
        "[File: {} | {} lines | {:.1} KB]\n",
        display, total, size_kb
    );
    let width = format!("{}", total).len();
    let emit = |result: &mut String, idx: usize, line: &str| {
        result.push_str(&format!("{:>width$}|{}\n", idx, line, width = width));
    };

    if let Some(s) = start {
        let s = s.max(1);
        let e = end.unwrap_or(total).min(total);
        if s > total {
            result.push_str(&format!(
                "Error: start_line {} exceeds total {} lines",
                s, total
            ));
            return ToolResult::text(result).with_success(false);
        }
        for (i, line) in lines[s - 1..e].iter().enumerate() {
            emit(&mut result, s + i, line);
        }
    } else if let Some(e) = end {
        let e = e.min(total);
        for (i, line) in lines[..e].iter().enumerate() {
            emit(&mut result, i + 1, line);
        }
    } else if total > LARGE_FILE_LINES {
        for (i, line) in lines[..HEAD_LINES].iter().enumerate() {
            emit(&mut result, i + 1, line);
        }
        let omit_start = HEAD_LINES + 1;
        let omit_end = total - TAIL_LINES;
        result.push_str(&format!(
            "\n... ({} lines omitted: {}-{}, use start_line/end_line to read a range) ...\n\n",
            omit_end - omit_start + 1,
            omit_start,
            omit_end
        ));
        for (i, line) in lines[total - TAIL_LINES..].iter().enumerate() {
            emit(&mut result, total - TAIL_LINES + i + 1, line);
        }
    } else {
        for (i, line) in lines.iter().enumerate() {
            emit(&mut result, i + 1, line);
        }
    }

    if result.len() > MAX_OUTPUT_CHARS {
        result.truncate(MAX_OUTPUT_CHARS);
        result.push_str("\n... [output truncated]");
    }

    ToolResult::text(result).with_success(true)
}

// ── write_file ──

pub struct WriteFileTool {
    policy: Arc<OsPolicy>,
    /// When set, a bare-filename `path` (no separators, not absolute) is
    /// redirected into this runtime drafts dir, so ad-hoc artifacts land in the
    /// managed Runtime Cache instead of the process CWD. Redirected writes are
    /// `Safe` (the bucket is sandboxed and disposable); delivery to the user is
    /// a separate explicit step — the `publish` tool.
    drafts_dir: Option<PathBuf>,
    /// Shared directory allow-list: a write whose (resolved) target lives inside
    /// an allow-listed folder downgrades to `Safe`. `None` = always confirm.
    safe_paths: Option<Arc<SafePathAllowList>>,
}

impl WriteFileTool {
    pub fn new(policy: Arc<OsPolicy>) -> Self {
        Self {
            policy,
            drafts_dir: None,
            safe_paths: None,
        }
    }

    /// Redirect bare-filename writes into `drafts_dir` (the runtime drafts bucket).
    pub fn with_drafts_dir(mut self, drafts_dir: Option<PathBuf>) -> Self {
        self.drafts_dir = drafts_dir;
        self
    }

    /// Share the directory allow-list so writes into trusted folders skip confirmation.
    pub fn with_safe_paths(mut self, safe_paths: Option<Arc<SafePathAllowList>>) -> Self {
        self.safe_paths = safe_paths;
        self
    }

    /// Resolve the requested `path` into the actual write target. A bare filename
    /// (no `/` or `\`, not absolute) is redirected into the drafts bucket;
    /// anything carrying a path is left untouched.
    fn resolve_target(&self, path: &str) -> String {
        crate::os::resolve_in_drafts(self.drafts_dir.as_deref(), path)
    }
}

#[async_trait]
impl Tool for WriteFileTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "write_file",
            "Write content to a text file (creates parent directories). Use \
             mode='append' to add, 'overwrite' to replace. For large content \
             (over ~20KB), split the write into multiple calls — the first with \
             mode='overwrite', the rest with mode='append' — a single oversized \
             call risks being cut off by the response token cap. Prefer \
             edit_file for small in-place edits. A bare filename (no directory) \
             lands in the managed drafts bucket without confirmation — use that \
             for generated artifacts; other paths require confirmation.",
            ToolParameters::object(
                HashMap::from([
                    (
                        "path".into(),
                        ToolParameter::string("File path (absolute preferred)"),
                    ),
                    ("content".into(), ToolParameter::string("Content to write")),
                    (
                        "mode".into(),
                        ToolParameter::string_enum("Write mode", &["overwrite", "append"])
                            .with_default(serde_json::json!("overwrite")),
                    ),
                ]),
                vec!["path".into(), "content".into()],
            ),
        )
    }

    fn risk(&self, args: &serde_json::Value) -> RiskLevel {
        // Resolve the redirect (bare filename → drafts) BEFORE consulting the
        // allow-list, so matching lines up with where the file actually lands.
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let target = self.resolve_target(path);
        // Drafts writes are Safe: the bucket is sandboxed and disposable, and
        // exposure to the user is a separate confirmed step (`publish`).
        if let Some(drafts) = &self.drafts_dir {
            if Path::new(&target).starts_with(drafts) {
                return RiskLevel::Safe;
            }
        }
        match &self.safe_paths {
            Some(list) if list.is_allowed_for(&target) => RiskLevel::Safe,
            _ => RiskLevel::Dangerous,
        }
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let mode = args
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("overwrite");
        if path.is_empty() {
            return ToolResult::text("Error: path is required").with_success(false);
        }
        let target = self.resolve_target(path);
        // A redirected draft lands in a runtime dir that may not exist yet;
        // create it so check_write can validate the (now-existing) parent.
        if target != path {
            if let Some(parent) = Path::new(&target).parent() {
                let _ = crate::vfs::create_dir_all(parent);
            }
        }
        let resolved = match self.policy.check_write(&target) {
            Ok(p) => p,
            Err(e) => return ToolResult::text(e).with_success(false),
        };
        execute_write_file(&resolved, content, mode).await
    }
}

async fn execute_write_file(resolved: &Path, content: &str, mode: &str) -> ToolResult {
    if let Some(parent) = resolved.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = crate::vfs::create_dir_all(parent) {
                return ToolResult::text(format!(
                    "Error: failed to create parent directory: {}",
                    e
                ))
                .with_success(false);
            }
        }
    }

    let display = resolved.display().to_string();
    match mode {
        // Read-modify-write, because the workspace stores whole files rather
        // than offering a handle to seek in. Same result, and nothing here is
        // large enough for the difference to matter.
        "append" => {
            let mut body = crate::vfs::read(resolved).unwrap_or_default();
            body.extend_from_slice(content.as_bytes());
            match crate::vfs::write(resolved, body) {
                Ok(_) => {
                    ToolResult::text(format!("Appended {} bytes to {}", content.len(), display))
                        .with_success(true)
                }
                Err(e) => {
                    ToolResult::text(format!("Error: failed to write: {}", e)).with_success(false)
                }
            }
        }
        _ => match crate::vfs::write(resolved, content) {
            Ok(_) => ToolResult::text(format!("Written {} bytes to {}", content.len(), display))
                .with_success(true),
            Err(e) => {
                ToolResult::text(format!("Error: failed to write: {}", e)).with_success(false)
            }
        },
    }
}

// ── edit_file ──

pub struct EditFileTool {
    policy: Arc<OsPolicy>,
    /// Shared directory allow-list: an edit whose target lives inside an
    /// allow-listed folder downgrades to `Safe`. `None` = always confirm.
    safe_paths: Option<Arc<SafePathAllowList>>,
}

impl EditFileTool {
    pub fn new(policy: Arc<OsPolicy>) -> Self {
        Self {
            policy,
            safe_paths: None,
        }
    }

    /// Share the directory allow-list so edits into trusted folders skip confirmation.
    pub fn with_safe_paths(mut self, safe_paths: Option<Arc<SafePathAllowList>>) -> Self {
        self.safe_paths = safe_paths;
        self
    }
}

#[async_trait]
impl Tool for EditFileTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "edit_file",
            "Replace `old_str` with `new_str` in a text file. PRECONDITIONS: \
             (1) read_file FIRST so old_str matches the live bytes; (2) old_str must \
             match EXACTLY ONCE unless replace_all=true; (3) include enough context to \
             be unique. Whitespace is significant. new_str may be empty (deletion). \
             Requires confirmation.",
            ToolParameters::object(
                HashMap::from([
                    ("path".into(), ToolParameter::string("File path")),
                    (
                        "old_str".into(),
                        ToolParameter::string("Exact bytes to find"),
                    ),
                    (
                        "new_str".into(),
                        ToolParameter::string("Replacement bytes (empty deletes)"),
                    ),
                    (
                        "replace_all".into(),
                        ToolParameter::boolean("Replace every occurrence (default false)")
                            .with_default(serde_json::json!(false)),
                    ),
                ]),
                vec!["path".into(), "old_str".into(), "new_str".into()],
            ),
        )
    }

    fn risk(&self, args: &serde_json::Value) -> RiskLevel {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        match &self.safe_paths {
            Some(list) if list.is_allowed_for(path) => RiskLevel::Safe,
            _ => RiskLevel::Dangerous,
        }
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let old_str = args.get("old_str").and_then(|v| v.as_str()).unwrap_or("");
        let new_str = args.get("new_str").and_then(|v| v.as_str()).unwrap_or("");
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if path.is_empty() {
            return ToolResult::text("Error: path is required").with_success(false);
        }
        if old_str.is_empty() {
            return ToolResult::text(
                "Error: old_str must be non-empty. Use write_file for new files / full rewrites.",
            )
            .with_success(false);
        }
        let resolved = match self.policy.check_write(path) {
            Ok(p) => p,
            Err(e) => return ToolResult::text(e).with_success(false),
        };
        execute_edit_file(&resolved, path, old_str, new_str, replace_all).await
    }
}

fn line_of(body: &str, byte_pos: usize) -> usize {
    body[..byte_pos].bytes().filter(|&b| b == b'\n').count() + 1
}

fn locate_all(body: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = body[from..].find(needle) {
        let abs = from + rel;
        out.push(abs);
        from = abs + needle.len().max(1);
    }
    out
}

async fn execute_edit_file(
    resolved: &Path,
    display: &str,
    old_str: &str,
    new_str: &str,
    replace_all: bool,
) -> ToolResult {
    let bytes = match crate::vfs::read(resolved) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ToolResult::text(format!(
                "Error: file not found: {}. Use write_file with mode='overwrite' to create it.",
                display
            ))
            .with_success(false);
        }
        Err(e) => {
            return ToolResult::text(format!("Error: failed to read file: {}", e))
                .with_success(false)
        }
    };
    let body = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => {
            return ToolResult::text(format!(
                "Error: file {} is binary; edit_file only handles UTF-8 text.",
                display
            ))
            .with_success(false)
        }
    };

    if old_str == new_str {
        return ToolResult::text("Error: old_str and new_str are identical; nothing to do.")
            .with_success(false);
    }

    let matches = locate_all(&body, old_str);
    if matches.is_empty() {
        return ToolResult::text(format!(
            "Error: old_str not found in {}. Re-read with read_file and provide the EXACT bytes \
             (indentation, trailing whitespace, newlines all matter).",
            display
        ))
        .with_success(false);
    }
    if matches.len() > 1 && !replace_all {
        let lines = matches
            .iter()
            .map(|&pos| line_of(&body, pos).to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return ToolResult::text(format!(
            "Error: old_str matched {} times in {} (lines {}). Add surrounding context to make it \
             unique, or pass replace_all=true.",
            matches.len(),
            display,
            lines
        ))
        .with_success(false);
    }

    let (new_body, count) = if replace_all {
        (body.replace(old_str, new_str), matches.len())
    } else {
        (body.replacen(old_str, new_str, 1), 1)
    };

    match crate::vfs::write(resolved, new_body) {
        Ok(_) => ToolResult::text(format!(
            "Edited {} ({} replacement{})",
            display,
            count,
            if count == 1 { "" } else { "s" }
        ))
        .with_success(true),
        Err(e) => ToolResult::text(format!("Error: failed to write: {}", e)).with_success(false),
    }
}

// ── list_files ──

pub struct ListFilesTool {
    policy: Arc<OsPolicy>,
}

impl ListFilesTool {
    pub fn new(policy: Arc<OsPolicy>) -> Self {
        Self { policy }
    }
}

#[async_trait]
impl Tool for ListFilesTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "list_files",
            "List files and directories. Returns type (DIR/FILE), name, and size for \
             each entry; optionally recursive with a max depth and a glob filter.",
            ToolParameters::object(
                HashMap::from([
                    ("path".into(), ToolParameter::string("Directory path")),
                    (
                        "recursive".into(),
                        ToolParameter::boolean("Recurse into subdirectories (default false)")
                            .with_default(serde_json::json!(false)),
                    ),
                    (
                        "pattern".into(),
                        ToolParameter::string("Glob filter, e.g. '*.log'. Optional"),
                    ),
                    (
                        "max_depth".into(),
                        ToolParameter::integer("Max recursion depth (default 3)")
                            .with_default(serde_json::json!(3)),
                    ),
                ]),
                vec!["path".into()],
            ),
        )
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let recursive = args
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let pattern = args.get("pattern").and_then(|v| v.as_str());
        let max_depth = args.get("max_depth").and_then(|v| v.as_u64()).unwrap_or(3) as usize;

        let resolved = match self.policy.check_read(path) {
            Ok(p) => p,
            Err(e) => return ToolResult::text(e).with_success(false),
        };
        execute_list_files(&resolved, path, recursive, pattern, max_depth)
    }
}

fn glob_match(pattern: &str, name: &str) -> bool {
    // Minimal glob: only '*' wildcards (sufficient for "*.log" style filters).
    fn helper(p: &[u8], n: &[u8]) -> bool {
        if p.is_empty() {
            return n.is_empty();
        }
        if p[0] == b'*' {
            helper(&p[1..], n) || (!n.is_empty() && helper(p, &n[1..]))
        } else if !n.is_empty() && (p[0] == n[0]) {
            helper(&p[1..], &n[1..])
        } else {
            false
        }
    }
    helper(pattern.as_bytes(), name.as_bytes())
}

fn execute_list_files(
    resolved: &Path,
    display: &str,
    recursive: bool,
    pattern: Option<&str>,
    max_depth: usize,
) -> ToolResult {
    if !crate::vfs::exists(resolved) {
        return ToolResult::text(format!("Error: path not found: {}", display)).with_success(false);
    }
    if !crate::vfs::is_dir(resolved) {
        return ToolResult::text(format!("Error: not a directory: {}", display))
            .with_success(false);
    }

    let mut out = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(resolved.to_path_buf(), 0)];
    let mut count = 0usize;
    const MAX_ENTRIES: usize = 2000;

    while let Some((dir, depth)) = stack.pop() {
        let entries = match crate::vfs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for entry in items {
            if count >= MAX_ENTRIES {
                out.push("... [truncated: too many entries]".to_string());
                return ToolResult::text(out.join("\n")).with_success(true);
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = entry
                .path()
                .strip_prefix(resolved)
                .unwrap_or(&entry.path())
                .to_string_lossy()
                .to_string();
            if meta.is_dir() {
                if pattern.is_none() {
                    out.push(format!("DIR   {}/", rel));
                    count += 1;
                }
                if recursive && depth + 1 < max_depth {
                    stack.push((entry.path(), depth + 1));
                }
            } else {
                let matches = pattern.map(|p| glob_match(p, &name)).unwrap_or(true);
                if matches {
                    out.push(format!("FILE  {:>10}  {}", meta.len(), rel));
                    count += 1;
                }
            }
        }
    }

    if out.is_empty() {
        out.push("(empty)".to_string());
    }
    ToolResult::text(format!("[Listing: {}]\n{}", display, out.join("\n"))).with_success(true)
}
