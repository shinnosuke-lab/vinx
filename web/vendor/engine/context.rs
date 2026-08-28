//! Context management: tool-result compression + working-context pruning /
//! LLM compaction.
//!
//! User-facing strings are plain bilingual text (no i18n macro).

use std::error::Error;

use tokio::sync::mpsc;

use crate::client::LlmClient;
use crate::types::*;

// ── Tool-result compression ──

const MAX_RESULT_CHARS: usize = 50_000;

const NO_RETRY_HINT: &str =
    "请基于已有信息回答，不要尝试重新获取/Answer with available data, do not retry";

/// Compress a raw tool result for context efficiency: strip ANSI, render JSON
/// arrays-of-objects as compact tables, and truncate oversized blobs.
pub fn compress_tool_result(result: &str) -> String {
    let result = strip_ansi_escapes(result);

    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&result) {
        return compress_json_value(&val);
    }

    if result.chars().count() > MAX_RESULT_CHARS {
        let truncated: String = result.chars().take(MAX_RESULT_CHARS).collect();
        format!(
            "{}...\n[truncated/已截断, {} chars。{}]",
            truncated,
            result.chars().count(),
            NO_RETRY_HINT,
        )
    } else {
        result
    }
}

fn compress_json_value(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Array(arr) => {
            if arr.is_empty() {
                return "[]".to_string();
            }
            if arr.iter().all(|v| v.is_object()) {
                return json_array_to_table(arr);
            }
            let compact = serde_json::to_string(val).unwrap_or_default();
            if compact.len() > MAX_RESULT_CHARS {
                truncate_simple_array(arr)
            } else {
                compact
            }
        }
        serde_json::Value::Object(obj) => {
            let compact = serde_json::to_string(val).unwrap_or_default();
            if compact.len() > MAX_RESULT_CHARS {
                let keys: Vec<&String> = obj.keys().collect();
                let preview: serde_json::Map<String, serde_json::Value> = obj
                    .iter()
                    .take(5)
                    .map(|(k, v)| {
                        let vs = serde_json::to_string(v).unwrap_or_default();
                        if vs.len() > 500 {
                            (
                                k.clone(),
                                serde_json::Value::String(format!(
                                    "[{} chars truncated]",
                                    vs.len()
                                )),
                            )
                        } else {
                            (k.clone(), v.clone())
                        }
                    })
                    .collect();
                format!(
                    "[JSON object, {} fields: {}]\nPreview: {}\n[{}]",
                    keys.len(),
                    keys.iter()
                        .map(|k| k.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    serde_json::to_string(&serde_json::Value::Object(preview)).unwrap_or_default(),
                    NO_RETRY_HINT,
                )
            } else {
                compact
            }
        }
        _ => serde_json::to_string(val).unwrap_or_default(),
    }
}

fn json_array_to_table(arr: &[serde_json::Value]) -> String {
    let mut keys: Vec<String> = Vec::new();
    for item in arr {
        if let Some(obj) = item.as_object() {
            for key in obj.keys() {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
        }
    }

    let total = arr.len();
    let mut lines: Vec<String> = Vec::with_capacity(total + 1);
    lines.push(format!("{} items | {}", total, keys.join(" | ")));

    for item in arr {
        if let Some(obj) = item.as_object() {
            let cells: Vec<String> = keys
                .iter()
                .map(|k| match obj.get(k) {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Null) | None => String::new(),
                    Some(v) => serde_json::to_string(v).unwrap_or_default(),
                })
                .collect();
            lines.push(cells.join(" | "));
        }
    }

    lines.join("\n")
}

fn truncate_simple_array(arr: &[serde_json::Value]) -> String {
    let total = arr.len();
    let mut buf = String::from("[");
    let mut count = 0;
    for item in arr {
        let s = serde_json::to_string(item).unwrap_or_default();
        if count > 0 && buf.len() + s.len() + 2 > MAX_RESULT_CHARS {
            break;
        }
        if count > 0 {
            buf.push(',');
        }
        buf.push_str(&s);
        count += 1;
    }
    buf.push(']');
    format!("{}\n[showing {}/{}. {}]", buf, count, total, NO_RETRY_HINT)
}

fn strip_ansi_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&nc) = chars.peek() {
                    chars.next();
                    if nc.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ── Working-context pruning + compaction ──

pub const KEEP_RECENT_TOOL_RESULTS: usize = 8;

/// Level-1 pruning is a request-time view, so the canonical history keeps
/// growing between Level-2 compactions. Past this multiple of the compaction
/// threshold a compaction is forced even when the pruned view is still small,
/// bounding memory and the whole-snapshot DB rewrites (nothing is lost — the
/// full history is archived first).
pub const CANONICAL_CAP_FACTOR: usize = 4;

const CHARS_PER_TOKEN: usize = 3;
const COMPACTION_RATIO: f64 = 0.45;
const PRUNING_RATIO: f64 = 0.70;

pub(crate) fn model_context_tokens(model: &str) -> usize {
    let m = model.to_lowercase();
    if crate::client::is_kimi_k3(&m) {
        1_000_000
    } else if m.contains("kimi") {
        256_000
    } else if m.contains("glm-5.2") || m.contains("glm-5.3") {
        1_000_000
    } else if m.contains("glm-5") {
        200_000
    } else if m.contains("deepseek") {
        1_000_000
    } else {
        256_000
    }
}

/// Compaction byte threshold. `configured_tokens > 0` overrides auto-detection.
pub fn compaction_threshold(model: &str, configured_tokens: usize) -> usize {
    let tokens = if configured_tokens > 0 {
        configured_tokens
    } else {
        model_context_tokens(model)
    };
    ((tokens as f64) * COMPACTION_RATIO * (CHARS_PER_TOKEN as f64)) as usize
}

/// Pruning (Level 1) byte threshold — 70% of the compaction threshold.
pub fn pruning_threshold(model: &str, configured_tokens: usize) -> usize {
    let full = compaction_threshold(model, configured_tokens);
    ((full as f64) * PRUNING_RATIO) as usize
}

/// Marker prefix of an elided tool result in the request view. Stable on
/// purpose: the `recall_result` tool description tells the model to look for
/// it, and [`recall_tool_result`] uses it to tell "elided" from "visible".
pub const COMPACTED_PREFIX: &str = "[compacted:";

/// Tool name behind `call_id`, resolved from the assistant message that
/// issued the call (the tool-result message itself only carries the id).
/// Searched newest-first, matching [`recall_tool_result`]'s content lookup:
/// if a provider ever reuses an id, name and content come from the same call.
pub fn tool_name_for_call(messages: &[ChatMessage], call_id: &str) -> Option<String> {
    messages.iter().rev().find_map(|m| {
        m.tool_calls
            .as_ref()?
            .iter()
            .rev()
            .find_map(|tc| (tc.id == call_id).then(|| tc.function.name.clone()))
    })
}

/// Level 1: replace the body of all but the most recent `keep_recent` tool
/// results with an addressable placeholder.
///
/// The placeholder carries the call's id ON PURPOSE: it is a swap entry, not
/// a tombstone. `recall_result` (intercepted in `agent_loop`) restores the
/// original from the canonical history, so eliding is safe even when the
/// model turns out to need the content later.
pub fn clear_old_tool_results(messages: &mut [ChatMessage], keep_recent: usize) {
    let tool_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == Role::Tool)
        .map(|(i, _)| i)
        .collect();

    if tool_indices.len() <= keep_recent {
        return;
    }

    // Two passes because the name lookup reads `messages` while the rewrite
    // mutates it: collect the replacements first, then apply.
    let to_clear = tool_indices.len() - keep_recent;
    let replacements: Vec<(usize, String)> = tool_indices[..to_clear]
        .iter()
        .filter_map(|&idx| {
            let msg = &messages[idx];
            let content = msg.content.as_deref()?;
            // Short results stay: the placeholder itself runs ~120 bytes, so
            // anything under 200 saves nothing worth the indirection.
            // Already-elided entries stay: rewrapping would lose the id.
            if content.len() <= 200 || content.starts_with(COMPACTED_PREFIX) {
                return None;
            }
            let call_id = msg.tool_call_id.as_deref().unwrap_or("");
            let tool =
                tool_name_for_call(messages, call_id).unwrap_or_else(|| "tool".to_string());
            Some((
                idx,
                format!(
                    "{} {} result, {} chars — recall_result(call_id=\"{}\") restores it]",
                    COMPACTED_PREFIX,
                    tool,
                    content.chars().count(),
                    call_id
                ),
            ))
        })
        .collect();
    for (idx, placeholder) in replacements {
        messages[idx].content = Some(placeholder);
    }
}

/// Level 1, register file edition: only the LATEST `update_task_state` call
/// keeps its arguments in the request view — earlier snapshots are dead state
/// the newest one replaced, yet they ride in assistant messages that
/// `clear_old_tool_results` never touches. Same move as the malformed-args
/// stub in `agent_loop`: swap arguments only, keep id/name so the
/// call/result pairing stays wire-valid. The canonical history is not touched
/// (`latest_task_state` replays it and must see every write).
pub fn stub_superseded_task_states(messages: &mut [ChatMessage]) {
    let mut sites: Vec<(usize, usize)> = Vec::new();
    for (mi, msg) in messages.iter().enumerate() {
        if let Some(calls) = &msg.tool_calls {
            for (ci, call) in calls.iter().enumerate() {
                if call.function.name == "update_task_state" {
                    sites.push((mi, ci));
                }
            }
        }
    }
    if sites.len() < 2 {
        return;
    }
    sites.pop(); // the newest write is the live register — leave it alone
    for (mi, ci) in sites {
        if let Some(calls) = messages[mi].tool_calls.as_mut() {
            calls[ci].function.arguments = "{\"state\":\"[superseded]\"}".to_string();
        }
    }
}

/// Outcome of a recall lookup against the canonical history.
#[derive(Debug)]
pub enum RecallOutcome {
    /// The result exists and was elided from the request view: its full
    /// (write-time-compressed) content, plus the tool that produced it.
    Recalled { tool: String, content: String },
    /// The result exists and is already visible in the current view —
    /// returning it again would only duplicate context.
    Visible,
    /// No such call_id in the canonical history (never existed, or the
    /// history was compacted away — the archive fall-through lives with the
    /// caller, which owns the store).
    Miss,
}

/// Look up the tool result `call_id` for a `recall_result` call.
///
/// `view` is the pruned request view the model saw this round; `None` means
/// the canonical history went out as-is, so everything found is [`RecallOutcome::Visible`].
pub fn recall_tool_result(
    messages: &[ChatMessage],
    view: Option<&[ChatMessage]>,
    call_id: &str,
) -> RecallOutcome {
    let found = messages
        .iter()
        .rev()
        .find(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some(call_id));
    let Some(msg) = found else {
        return RecallOutcome::Miss;
    };

    let elided = view.is_some_and(|v| {
        v.iter().any(|m| {
            m.role == Role::Tool
                && m.tool_call_id.as_deref() == Some(call_id)
                && m.content
                    .as_deref()
                    .is_some_and(|c| c.starts_with(COMPACTED_PREFIX))
        })
    });
    if !elided {
        return RecallOutcome::Visible;
    }
    RecallOutcome::Recalled {
        tool: tool_name_for_call(messages, call_id).unwrap_or_else(|| "tool".to_string()),
        content: msg.content.clone().unwrap_or_default(),
    }
}

/// Working-context size in content characters (the system prompt is excluded:
/// it is fixed overhead the pruning/compaction thresholds already account for).
pub fn context_chars(messages: &[ChatMessage]) -> usize {
    messages
        .iter()
        .skip(1)
        .filter_map(|m| m.content.as_ref())
        .map(|c| c.len())
        .sum()
}

/// Build the request-time view of the working context: `None` while under the
/// pruning threshold (send the canonical history as-is, no clone), otherwise a
/// pruned copy for the wire. The canonical history is NEVER mutated here — old
/// tool results keep their full content in memory and in the session DB until
/// a Level-2 compaction archives them, so nothing the user said or saw is lost
/// to Level-1 pruning.
pub fn build_request_view(
    messages: &[ChatMessage],
    prune_threshold: usize,
) -> Option<Vec<ChatMessage>> {
    if context_chars(messages) <= prune_threshold {
        return None;
    }
    let mut view = messages.to_vec();
    clear_old_tool_results(&mut view, KEEP_RECENT_TOOL_RESULTS);
    stub_superseded_task_states(&mut view);
    Some(view)
}

/// Level-2 trigger decision: compact when the pruned view still exceeds the
/// compaction threshold, OR the canonical history (which pruning no longer
/// shrinks) exceeds the `CANONICAL_CAP_FACTOR` hard cap.
pub fn should_compact(
    canonical_chars: usize,
    view_chars: usize,
    compact_threshold: usize,
) -> bool {
    view_chars > compact_threshold
        || canonical_chars > compact_threshold.saturating_mul(CANONICAL_CAP_FACTOR)
}

/// First line of every compaction summary message, byte-for-byte. FROZEN:
/// the chat UI collapses summary messages by matching this exact prefix
/// (AgentChat.tsx `summaryMarker`), so extra information belongs on the
/// following lines, never inside the brackets.
pub const SUMMARY_MARKER: &str = "[Conversation Summary]";

// ── Task-state registers ──

/// Size cap for one `update_task_state` block. Registers are supposed to be
/// small — past this the tool refuses and asks the model to trim.
pub const TASK_STATE_MAX_CHARS: usize = 2000;

const TASK_STATE_OPEN: &str = "[Task State]\n";
const TASK_STATE_CLOSE: &str = "\n[/Task State]";

/// The task-state block in force at the END of `messages`.
///
/// The state has no store of its own — the history IS the store: the newest
/// valid `update_task_state` call wins, and when none exists (e.g. right
/// after a compaction replaced those calls with a summary), the block an
/// earlier compaction embedded in its summary message carries forward.
/// Validation mirrors the tool's own (non-empty, within the cap), so a call
/// the tool rejected can never become the snapshot.
pub fn latest_task_state(messages: &[ChatMessage]) -> Option<String> {
    for msg in messages.iter().rev() {
        if let Some(tcs) = &msg.tool_calls {
            for tc in tcs.iter().rev() {
                if tc.function.name != "update_task_state" {
                    continue;
                }
                let state = serde_json::from_str::<serde_json::Value>(&tc.function.arguments)
                    .ok()
                    .and_then(|v| v.get("state").and_then(|s| s.as_str()).map(str::to_string));
                if let Some(state) = state {
                    let state = state.trim().to_string();
                    if !state.is_empty() && state.chars().count() <= TASK_STATE_MAX_CHARS {
                        return Some(state);
                    }
                }
            }
        }
        // Only trust blocks inside our own summary messages — a user pasting
        // a transcript must not be able to overwrite the snapshot.
        if msg.role == Role::User {
            if let Some(content) = msg.content.as_deref() {
                if content.starts_with(SUMMARY_MARKER) {
                    if let Some(block) = extract_task_state_block(content) {
                        return Some(block);
                    }
                }
            }
        }
    }
    None
}

/// Wrap a state block in its stable delimiters for embedding in a compaction
/// summary message (the form [`latest_task_state`] can find again).
pub fn task_state_block(state: &str) -> String {
    format!("{}{}{}", TASK_STATE_OPEN, state, TASK_STATE_CLOSE)
}

fn extract_task_state_block(content: &str) -> Option<String> {
    let start = content.find(TASK_STATE_OPEN)? + TASK_STATE_OPEN.len();
    let end = content[start..].find(TASK_STATE_CLOSE)? + start;
    Some(content[start..end].to_string())
}

/// Level 2: ask the LLM to summarize the conversation history into a compact
/// structured summary.
pub async fn compact_context(
    client: &LlmClient,
    messages: &[ChatMessage],
) -> Result<String, Box<dyn Error + Send + Sync>> {
    let mut history = String::new();
    for msg in messages {
        if msg.role == Role::System {
            continue;
        }
        let role = match msg.role {
            Role::User => "用户",
            Role::Assistant => "助手",
            Role::Tool => "工具",
            Role::Skill => "技能",
            _ => continue,
        };
        if let Some(ref content) = msg.content {
            let brief = if content.len() > 500 {
                format!("{}...", &content.chars().take(500).collect::<String>())
            } else {
                content.clone()
            };
            // Tool results carry their call_id so the summary can preserve
            // it — the id is the address recall_result retrieves the full
            // content by, after this summary has replaced the raw history.
            match (&msg.role, msg.tool_call_id.as_deref()) {
                (Role::Tool, Some(id)) => {
                    history.push_str(&format!("[工具 {}] {}\n", id, brief))
                }
                _ => history.push_str(&format!("[{}] {}\n", role, brief)),
            }
        }
        if let Some(ref tcs) = msg.tool_calls {
            for tc in tcs {
                let args = &tc.function.arguments;
                let brief_args = if args.chars().count() > 200 {
                    format!("{}...", args.chars().take(200).collect::<String>())
                } else {
                    args.clone()
                };
                history.push_str(&format!(
                    "[助手→工具 {}] {}({})\n",
                    tc.id, tc.function.name, brief_args
                ));
            }
        }
    }

    let compact_messages = vec![
        ChatMessage::system(
            "你是摘要助手。请用简洁的结构化格式总结对话历史。\
            保留：1) 已完成操作及结果 2) 当前进行中的任务 3) 关键数据 \
            4) 下一步计划 5) 关键工具结果的 call_id（形如 call_xxx——\
            原文之后可凭 call_id 通过 recall_result 取回，务必为重要结果保留）。\
            不要添加任何额外解释。",
        ),
        ChatMessage::user(&format!("总结以下对话：\n\n{}", history)),
    ];

    let (tx, _rx) = mpsc::unbounded_channel();
    let result = client.chat_stream(&compact_messages, None, &tx).await?;
    Ok(result
        .content
        .unwrap_or_else(|| "[Summary generation failed]".to_string()))
}
