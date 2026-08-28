//! `search_files` — regex content search across a directory tree.
//!
//! Output protocol mirrors ripgrep: `file:line:text` for matches,
//! `file-line-text` for context lines, `--` between non-adjacent ranges.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use regex::RegexBuilder;

use crate::os::OsPolicy;
use crate::tool::{Tool, ToolContext};
use crate::types::{ToolDefinition, ToolParameter, ToolParameters, ToolResult};

pub struct SearchFilesTool {
    policy: Arc<OsPolicy>,
}

impl SearchFilesTool {
    pub fn new(policy: Arc<OsPolicy>) -> Self {
        Self { policy }
    }
}

#[async_trait]
impl Tool for SearchFilesTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "search_files",
            "Search file contents using a regular expression. Returns matches with \
             file paths and line numbers. Output: `file:line:text` for matches, \
             `file-line-text` for context, `--` separates ranges. Files >10MB are \
             skipped.",
            ToolParameters::object(
                HashMap::from([
                    (
                        "pattern".into(),
                        ToolParameter::string("Regex pattern to search for"),
                    ),
                    (
                        "path".into(),
                        ToolParameter::string("Directory or file to search, default '.'")
                            .with_default(serde_json::json!(".")),
                    ),
                    (
                        "file_ext".into(),
                        ToolParameter::string("Extension filter without dot, e.g. 'log'. Optional"),
                    ),
                    (
                        "max_results".into(),
                        ToolParameter::integer("Max results, default 50")
                            .with_default(serde_json::json!(50)),
                    ),
                    (
                        "ignore_case".into(),
                        ToolParameter::boolean("Case-insensitive, default false")
                            .with_default(serde_json::json!(false)),
                    ),
                    (
                        "context".into(),
                        ToolParameter::integer("Context lines before/after (0-10), 'content' only")
                            .with_default(serde_json::json!(0)),
                    ),
                    (
                        "output_mode".into(),
                        ToolParameter::string_enum(
                            "Output mode",
                            &["content", "files_with_matches", "count"],
                        )
                        .with_default(serde_json::json!("content")),
                    ),
                ]),
                vec!["pattern".into()],
            ),
        )
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
        if pattern.is_empty() {
            return ToolResult::text("Error: pattern is required").with_success(false);
        }
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let file_ext = args.get("file_ext").and_then(|v| v.as_str());
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(50)
            .max(1) as usize;
        let ignore_case = args
            .get("ignore_case")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let context = args
            .get("context")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(10) as usize;
        let output_mode = args
            .get("output_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("content");

        let resolved = match self.policy.check_read(path) {
            Ok(p) => p,
            Err(e) => return ToolResult::text(e).with_success(false),
        };

        let re = match RegexBuilder::new(pattern)
            .case_insensitive(ignore_case)
            .build()
        {
            Ok(r) => r,
            Err(e) => {
                return ToolResult::text(format!("Error: invalid regex: {}", e)).with_success(false)
            }
        };

        let result = run_search(
            &resolved,
            path,
            &re,
            file_ext,
            max_results,
            context,
            output_mode,
        );
        ToolResult::text(result).with_success(true)
    }
}

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

fn collect_files(root: &Path, file_ext: Option<&str>, out: &mut Vec<std::path::PathBuf>) {
    if out.len() > 50_000 {
        return;
    }
    if crate::vfs::is_file(root) {
        if ext_ok(root, file_ext) {
            out.push(root.to_path_buf());
        }
        return;
    }
    let entries = match crate::vfs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Skip common noise dirs.
        if crate::vfs::is_dir(&p) {
            if matches!(name.as_ref(), ".git" | "node_modules" | "target" | ".svn") {
                continue;
            }
            collect_files(&p, file_ext, out);
        } else if ext_ok(&p, file_ext) {
            out.push(p);
        }
    }
}

fn ext_ok(p: &Path, file_ext: Option<&str>) -> bool {
    match file_ext {
        None => true,
        Some(want) => p
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case(want))
            .unwrap_or(false),
    }
}

fn run_search(
    resolved: &Path,
    display: &str,
    re: &regex::Regex,
    file_ext: Option<&str>,
    max_results: usize,
    context: usize,
    output_mode: &str,
) -> String {
    let mut files = Vec::new();
    collect_files(resolved, file_ext, &mut files);
    files.sort();

    let mut out_lines: Vec<String> = Vec::new();
    let mut files_with_matches: Vec<String> = Vec::new();
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut total = 0usize;
    let start = wasmtimer::std::Instant::now();

    'outer: for file in &files {
        if start.elapsed().as_secs() >= 30 {
            out_lines.push("-- [search timed out at 30s; partial results] --".into());
            break;
        }
        let meta = match crate::vfs::metadata(file) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let content = match crate::vfs::read(file) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if content.iter().take(8192).any(|&b| b == 0) {
            continue; // binary
        }
        let text = String::from_utf8_lossy(&content);
        let lines: Vec<&str> = text.lines().collect();
        let rel = file
            .strip_prefix(resolved)
            .map(|p| {
                if display == "." {
                    p.to_string_lossy().to_string()
                } else {
                    format!("{}/{}", display.trim_end_matches('/'), p.to_string_lossy())
                }
            })
            .unwrap_or_else(|_| file.to_string_lossy().to_string());

        // files_with_matches: a single match flags the file; move on.
        if output_mode == "files_with_matches" {
            if lines.iter().any(|l| re.is_match(l)) {
                files_with_matches.push(rel.clone());
                total += 1;
                if total >= max_results {
                    break;
                }
            }
            continue;
        }

        let mut file_match_count = 0usize;
        let mut last_emitted: Option<usize> = None;
        for (i, line) in lines.iter().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            file_match_count += 1;

            if output_mode == "content" {
                let lo = i.saturating_sub(context);
                let hi = (i + context).min(lines.len().saturating_sub(1));
                if let Some(prev) = last_emitted {
                    if lo > prev + 1 {
                        out_lines.push("--".into());
                    }
                }
                for j in lo..=hi {
                    if last_emitted.map(|p| j <= p).unwrap_or(false) {
                        continue;
                    }
                    let sep = if j == i { ':' } else { '-' };
                    out_lines.push(format!("{}{}{}{}{}", rel, sep, j + 1, sep, lines[j]));
                }
                last_emitted = Some(hi);
                total += 1;
                if total >= max_results {
                    out_lines.push(format!("-- [reached max_results={}] --", max_results));
                    break 'outer;
                }
            }
        }

        if output_mode == "count" && file_match_count > 0 {
            counts.push((rel.clone(), file_match_count));
            total += 1;
            if total >= max_results {
                break;
            }
        }
    }

    match output_mode {
        "files_with_matches" => {
            files_with_matches.sort();
            files_with_matches.dedup();
            files_with_matches.truncate(max_results);
            if files_with_matches.is_empty() {
                "No matches".into()
            } else {
                files_with_matches.join("\n")
            }
        }
        "count" => {
            if counts.is_empty() {
                "No matches".into()
            } else {
                counts
                    .iter()
                    .map(|(f, n)| format!("{}:{}", f, n))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        _ => {
            if out_lines.is_empty() {
                "No matches".into()
            } else {
                out_lines.join("\n")
            }
        }
    }
}
