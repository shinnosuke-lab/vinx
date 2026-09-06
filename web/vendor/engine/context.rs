//! Context management: tool-result compression + working-context pruning /
//! LLM compaction.
//!
//! User-facing strings are plain bilingual text (no i18n macro).

use std::collections::HashMap;
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

/// Hard floor on how many of the most recent tool results stay verbatim in
/// the request view once Level-1 pruning kicks in, whatever the budget says:
/// roughly two rounds of parallel calls ("read a few files → edit → check").
/// The stepped pruner keeps MORE whenever they fit the prune target (see
/// [`prune_plan`]) — with typical 1–2k-character results that is dozens.
///
/// This is a floor, not a preference: the earlier value of 16 forced sixteen
/// results into the view even when they were 50–90k characters together,
/// which is what pushed the view over the compaction line after as few as 16
/// tool calls (measured: two of four compactions in one afternoon happened
/// with 16 and 28 results in the whole history). Below the floor the model
/// still has `recall_result` for anything it needs back.
pub const KEEP_RECENT_TOOL_RESULTS: usize = 8;

/// Level-1 pruning is a request-time view, so the canonical history keeps
/// growing between Level-2 compactions. Past this multiple of the compaction
/// threshold a compaction is forced even when the pruned view is still small,
/// bounding memory and the whole-snapshot DB rewrites (nothing is lost — the
/// full history is archived first).
pub const CANONICAL_CAP_FACTOR: usize = 4;

/// Characters per token used to turn a token budget into a character budget
/// and back. Measured against provider-reported `prompt_tokens` on real
/// sessions (mixed Chinese/English prose + code + JSON tool arguments):
/// 1.7–2.3 on Claude, 2.4–2.6 on Grok. The old figure, 3, was
/// only right for English prose and under-counted these sessions by 30–70%.
/// Erring LOW (fewer chars per token = more tokens estimated) is the safe
/// direction: the cost of an early compaction is one summary; the cost of a
/// late one is a context-overflow round or, worse, a half-megatoken prompt
/// billed every round.
pub const CHARS_PER_TOKEN: usize = 2;
/// Fractional counterpart for arithmetic that should not round to an integer.
pub const CHARS_PER_TOKEN_F: f64 = 2.4;
/// Where Level-2 compaction triggers, as a fraction of the working budget
/// (view size, system prompt and tool schemas excluded — see
/// [`compaction_threshold`] for the headroom arithmetic).
///
/// Was 0.45: with a 160k budget that compacted at a ~72k-token view, i.e. a
/// ~90k-token prompt against a 200k window, every 15–50 minutes, each time
/// stalling the turn for 85–100 s of summarizing and throwing away the prompt
/// cache. Claude Code and Cursor compact at ~90 % of the window. Now that
/// Level-1 keeps the request prefix byte-identical between re-plans, a large
/// prompt is mostly cache READS (10 % of the write price), so the working
/// set can be bigger; what stays expensive is the compaction itself.
const COMPACTION_RATIO: f64 = 0.75;
/// Tokens kept free below the working budget for what the view size does not
/// count: the system prompt and tool schemas (13–22k tokens measured on this
/// app), the model's reply, and the estimator's residual error after
/// calibration. Binding for small configured budgets, where a pure ratio
/// would leave too little.
const COMPACTION_RESERVE_TOKENS: f64 = 40_000.0;
/// Floor on the compaction line for tiny budgets, so the reserve can never
/// eat the whole budget.
const COMPACTION_MIN_RATIO: f64 = 0.35;
const PRUNING_RATIO: f64 = 0.70;
/// Where stepped pruning brings the view down to, as a fraction of the
/// compaction threshold. Well under the pruning line (0.70) so the view can
/// grow for many rounds before crossing it again — and the request prefix
/// stays byte-identical across those rounds, which is what keeps the
/// provider's prompt cache hot. The gap between the two lines is also the
/// re-plan step when the target is out of reach (see [`PruneState::view`]).
const PRUNE_TARGET_RATIO: f64 = 0.40;
/// Share of the compaction threshold kept VERBATIM behind a Level-2 summary.
/// The most recent exchanges — the user's live request, the tool results the
/// model was acting on — survive as they were instead of as a 500-character
/// paraphrase, so the turn resumes exactly where it stopped; only the history
/// before them is summarized (see [`compaction_tail_start`] for the boundary
/// rule). 10 % of the compaction line is ~12k tokens on the default budget:
/// a few tool exchanges, or one big file read.
pub const COMPACTION_TAIL_RATIO: f64 = 0.10;

/// Hard ceiling on the working budget in tokens regardless of the model's
/// advertised window, unless the user configured a larger size explicitly.
///
/// Window size and working-set size are different things: a 1M-token window
/// means the model CAN read that much, not that every round SHOULD carry it.
/// The price of a round is linear in the prompt (cache reads are the cheap
/// case; a cache MISS re-writes the whole prompt at many times that rate —
/// a 500k-token miss costs several dollars, a 150k one under two), and the
/// model's attention over a 700k-token pile of stale file versions is
/// measurably worse than over a compacted 150k. Letting the budget follow a
/// 1M window is what produced 300–770k-token rounds that never compacted.
/// An explicit `context_size` in the config still wins.
pub const DEFAULT_WORKING_BUDGET_TOKENS: usize = 160_000;

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

/// The working budget in tokens for a model: the configured size when set,
/// otherwise the model window capped at [`DEFAULT_WORKING_BUDGET_TOKENS`].
pub fn working_budget_tokens(model: &str, configured_tokens: usize) -> usize {
    if configured_tokens > 0 {
        configured_tokens
    } else {
        model_context_tokens(model).min(DEFAULT_WORKING_BUDGET_TOKENS)
    }
}

/// Compaction (Level 2) byte threshold on the VIEW (system prompt and tool
/// schemas excluded). `configured_tokens > 0` overrides auto-detection.
///
/// In tokens: `max(budget × 0.35, min(budget × 0.75, budget − 40k))`. For
/// the default 160k budget that is a 120k-token view; with the ~20k of
/// prompt/schema overhead and the reply on top the request stays inside a
/// 200k window. For a configured 128k budget the reserve binds (88k); for a
/// configured 1M it is the ratio (750k).
pub fn compaction_threshold(model: &str, configured_tokens: usize) -> usize {
    let tokens = working_budget_tokens(model, configured_tokens) as f64;
    let line = (tokens * COMPACTION_RATIO)
        .min(tokens - COMPACTION_RESERVE_TOKENS)
        .max(tokens * COMPACTION_MIN_RATIO);
    (line * CHARS_PER_TOKEN_F) as usize
}

/// Pruning (Level 1) byte threshold — 70% of the compaction threshold.
pub fn pruning_threshold(model: &str, configured_tokens: usize) -> usize {
    let full = compaction_threshold(model, configured_tokens);
    ((full as f64) * PRUNING_RATIO) as usize
}

/// Stepped-pruning target in bytes — where a prune brings the view down to.
pub fn prune_target(model: &str, configured_tokens: usize) -> usize {
    let full = compaction_threshold(model, configured_tokens);
    ((full as f64) * PRUNE_TARGET_RATIO) as usize
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

/// Number of tool-result messages in `messages` — the unit the Level-1 cut
/// is counted in.
pub fn tool_result_count(messages: &[ChatMessage]) -> usize {
    messages.iter().filter(|m| m.role == Role::Tool).count()
}

/// Level 1: replace the body of all but the most recent `keep_recent` tool
/// results with an addressable placeholder.
///
/// This is the STATELESS, one-shot form (tests, [`build_request_view`], the
/// recall view): "keep the last N" is a window that slides with every new
/// result, so a caller that rebuilds the view round after round must NOT use
/// it — see [`PruneState`], which pins the cut with the absolute form
/// [`elide_oldest_tool_results`] instead.
pub fn clear_old_tool_results(messages: &mut [ChatMessage], keep_recent: usize) {
    let total = tool_result_count(messages);
    elide_oldest_tool_results(messages, total.saturating_sub(keep_recent));
}

/// Level 1, absolute form: replace the body of the OLDEST `count` tool
/// results (in history order) with an addressable placeholder; every result
/// after them stays verbatim.
///
/// Counted from the FRONT on purpose. The canonical history only ever grows
/// at the tail (a rewrite — compaction, rewind — resets the cut), so the same
/// `count` names the same results round after round: the request prefix up
/// to the newest result is byte-identical between two rounds, and the
/// provider's prompt cache keeps hitting. A keep-from-the-tail count would
/// move the boundary forward by one result each round.
///
/// The placeholder carries the call's id ON PURPOSE: it is a swap entry, not
/// a tombstone. `recall_result` (intercepted in `agent_loop`) restores the
/// original from the canonical history, so eliding is safe even when the
/// model turns out to need the content later.
pub fn elide_oldest_tool_results(messages: &mut [ChatMessage], count: usize) {
    let tool_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == Role::Tool)
        .map(|(i, _)| i)
        .collect();

    let to_clear = count.min(tool_indices.len());
    if to_clear == 0 {
        return;
    }

    // Two passes because the name lookup reads `messages` while the rewrite
    // mutates it: collect the replacements first, then apply.
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
            let tool = tool_name_for_call(messages, call_id).unwrap_or_else(|| "tool".to_string());
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

/// Tool-call arguments above this size are candidates for Level-1 eliding
/// once their call is old enough. The bulk of a long session's prompt turned
/// out to be `write_file` / `edit_file` bodies riding in assistant messages
/// (one session carried 650k characters of arguments against 720k of
/// content), and every one of them is a stale version of a file the model
/// can `read_file` again. Small arguments (paths, commands) stay: they are
/// what tells the model what it did.
pub const ELIDE_ARGS_OVER_CHARS: usize = 2_000;

/// The keys of an elided argument object that are kept in the stub so the
/// call stays recognisable ("wrote ./src/main.rs") without its payload.
const ARG_KEYS_KEPT: &[&str] = &["path", "file", "filename", "name", "command", "url", "pattern"];

/// Level 1, arguments edition: replace the bulky arguments of tool calls whose
/// RESULT is among the oldest `total - keep_recent` results with a short stub
/// that keeps the identifying keys (path/command/…) and notes what was
/// dropped. Same shape as `stub_malformed_call_args` in `agent_loop`: id and
/// name stay, so the call/result pairing stays wire-valid; the canonical
/// history is untouched.
///
/// Stateless keep-count form, paired with [`clear_old_tool_results`]; the
/// stateful pruner uses [`stub_oldest_tool_call_args`].
pub fn stub_old_tool_call_args(messages: &mut [ChatMessage], keep_recent: usize) {
    let total = tool_result_count(messages);
    stub_oldest_tool_call_args(messages, total.saturating_sub(keep_recent));
}

/// [`stub_old_tool_call_args`] in the absolute form: the calls whose result
/// is among the OLDEST `count` results lose their bulky arguments.
///
/// "Old" is decided by the RESULT's position, exactly as
/// [`elide_oldest_tool_results`] decides it, so the two never disagree — and a
/// `write_file` whose result is a short "ok" (never elided as a result) still
/// loses its 40k body once it is behind the cut.
pub fn stub_oldest_tool_call_args(messages: &mut [ChatMessage], count: usize) {
    let old_ids = oldest_tool_call_ids(messages, count);
    if old_ids.is_empty() {
        return;
    }
    for msg in messages.iter_mut() {
        if msg.role != Role::Assistant {
            continue;
        }
        let Some(calls) = msg.tool_calls.as_mut() else {
            continue;
        };
        for call in calls.iter_mut() {
            if !old_ids.contains(call.id.as_str()) {
                continue;
            }
            let args = &call.function.arguments;
            if args.len() <= ELIDE_ARGS_OVER_CHARS || args.contains(ELIDED_ARGS_KEY) {
                continue;
            }
            call.function.arguments = elided_args_stub(&call.function.name, args);
        }
    }
}

/// The `tool_call_id`s of the oldest `count` tool results.
fn oldest_tool_call_ids(messages: &[ChatMessage], count: usize) -> std::collections::HashSet<String> {
    messages
        .iter()
        .filter(|m| m.role == Role::Tool)
        .filter_map(|m| m.tool_call_id.as_deref())
        .take(count)
        .map(|s| s.to_string())
        .collect()
}

/// Marker key inside an elided-arguments stub (valid JSON so providers that
/// re-parse arguments accept it; stable so the pruner does not re-stub it).
const ELIDED_ARGS_KEY: &str = "_elided";

/// Build the replacement arguments: identifying keys kept, the rest replaced
/// by a note with the original size. Non-object arguments collapse to the
/// note alone.
fn elided_args_stub(tool: &str, args: &str) -> String {
    let dropped = args.chars().count();
    let mut stub = serde_json::Map::new();
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(args) {
        for key in ARG_KEYS_KEPT {
            if let Some(v) = map.get(*key) {
                // Keep short identifiers only; a 30k "command" is the payload.
                let short = match v {
                    serde_json::Value::String(s) => s.chars().count() <= 300,
                    _ => true,
                };
                if short {
                    stub.insert((*key).to_string(), v.clone());
                }
            }
        }
    }
    stub.insert(
        ELIDED_ARGS_KEY.to_string(),
        serde_json::Value::String(format!(
            "{tool} arguments elided from the working context ({dropped} chars); the call \
             was executed as recorded in its result — re-read the file to see current content"
        )),
    );
    serde_json::Value::Object(stub).to_string()
}

/// Level 1, register file edition: only the live `update_task_state` call
/// keeps its arguments in the request view — earlier snapshots are dead state
/// the newest one replaced, yet they ride in assistant messages that
/// `clear_old_tool_results` never touches. Same move as the malformed-args
/// stub in `agent_loop`: swap arguments only, keep id/name so the
/// call/result pairing stays wire-valid. The canonical history is not touched
/// (`latest_task_state` replays it and must see every write).
///
/// "Live" is the newest ACCEPTED write — the same one `latest_task_state`
/// returns — not merely the newest one. A refused write (over the cap) is
/// dead on arrival: stubbing the last good register in its favour would show
/// the model a view whose only intact state is the one that was never
/// recorded. With no accepted write at all, the newest one stays visible so
/// the model can still see what it tried to write.
///
/// Stubs every superseded register; the stateful pruner uses
/// [`stub_superseded_task_states_before`] so the stubbing follows the cut.
pub fn stub_superseded_task_states(messages: &mut [ChatMessage]) {
    stub_superseded_task_states_before(messages, usize::MAX);
}

/// [`stub_superseded_task_states`] restricted to registers that sit BEFORE
/// message index `before` — the cold region behind the Level-1 cut.
///
/// A superseded register in the verbatim tail is left alone on purpose: the
/// moment a new `update_task_state` lands, the previous one becomes dead
/// state, but stubbing it right away would rewrite a message the provider
/// already has cached and invalidate every byte after it. Left verbatim, it
/// costs ~1–2k characters until the next re-plan moves the cut past it and
/// stubs it together with everything else that fell behind. The live
/// register is never stubbed, wherever it sits.
pub fn stub_superseded_task_states_before(messages: &mut [ChatMessage], before: usize) {
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
    let is_accepted = |&(mi, ci): &(usize, usize)| {
        messages[mi]
            .tool_calls
            .as_ref()
            .and_then(|calls| task_state_arg(&calls[ci]))
            .is_some_and(|state| task_state_verdict(&state).accepted())
    };
    let live = sites
        .iter()
        .rposition(is_accepted)
        .unwrap_or(sites.len() - 1);
    for (i, (mi, ci)) in sites.into_iter().enumerate() {
        if i == live || mi >= before {
            continue; // the live register, or one still in the verbatim tail
        }
        if let Some(calls) = messages[mi].tool_calls.as_mut() {
            calls[ci].function.arguments = "{\"state\":\"[superseded]\"}".to_string();
        }
    }
}

/// Message index of the Level-1 cut for `elided` oldest results: the index
/// of the assistant message that issued the first result kept verbatim (its
/// call and result are one unit), or `messages.len()` when every result is
/// behind the cut. Everything before it is the cold region. Depends only on
/// the history up to that result, so it is stable between rounds for a fixed
/// `elided`.
pub fn cut_message_index(messages: &[ChatMessage], elided: usize) -> usize {
    let Some(result_index) = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == Role::Tool)
        .nth(elided)
        .map(|(i, _)| i)
    else {
        return messages.len();
    };
    // Step back over the result group to the assistant message that issued it.
    let mut i = result_index;
    while i > 0 && messages[i - 1].role == Role::Tool {
        i -= 1;
    }
    if i > 0 && messages[i - 1].role == Role::Assistant {
        i -= 1;
    }
    i
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

/// Working-context size in characters: message content PLUS tool-call
/// arguments (the system prompt is excluded: it is fixed overhead the
/// thresholds already account for).
///
/// Arguments count because the provider counts them — a `write_file` body is
/// tokenized in full on every request. Leaving them out was the bug that let
/// four sessions grow to 300–770k tokens while the estimate said 250k.
pub fn context_chars(messages: &[ChatMessage]) -> usize {
    messages.iter().skip(1).map(message_chars).sum()
}

/// Character footprint of one message: content + reasoning that will be
/// replayed + every tool call's arguments.
pub fn message_chars(m: &ChatMessage) -> usize {
    let content = m.content.as_ref().map(|c| c.len()).unwrap_or(0);
    let args: usize = m
        .tool_calls
        .as_ref()
        .map(|calls| calls.iter().map(|c| c.function.arguments.len() + c.function.name.len()).sum())
        .unwrap_or(0);
    // vinx: whether reasoning is replayed is per provider (see
    // `client::WireProfile`); every replaying profile sends it on tool-call
    // turns, K3 alone on plain turns too. Count the shared case and accept
    // the small under-estimate on K3 — the calibration ratio absorbs it.
    let reasoning = match (&m.reasoning_content, &m.tool_calls) {
        (Some(r), Some(calls)) if matches!(m.role, Role::Assistant) && !calls.is_empty() => {
            r.len()
        }
        _ => 0,
    };
    content + args + reasoning
}

/// Everything the tokenizer will see for one request, in characters: every
/// message INCLUDING the system prompt, plus the tool schemas. This is the
/// figure to pair with the provider's `prompt_tokens` when calibrating the
/// estimator (see [`SessionContextState::observe`]) — [`context_chars`]
/// deliberately leaves the system prompt out because the thresholds treat it
/// as fixed overhead, but the provider does not.
pub fn request_chars(wire_messages: &[ChatMessage], tools: Option<&[ToolDefinition]>) -> usize {
    let messages: usize = wire_messages.iter().map(message_chars).sum();
    let schemas: usize = tools
        .map(|defs| {
            defs.iter()
                .map(|d| serde_json::to_string(d).map(|s| s.len()).unwrap_or(0))
                .sum()
        })
        .unwrap_or(0);
    messages + schemas
}

/// How many of the most recent tool results a prune keeps verbatim (together
/// with their calls' arguments), chosen so the pruned view lands at or under
/// `target_chars`.
///
/// Walks results newest-first, accumulating each one's footprint (its content
/// if long enough to be elided, plus its call's arguments if bulky enough to
/// be stubbed) on top of everything pruning never touches, and stops when one
/// more would exceed the target. Never below [`KEEP_RECENT_TOOL_RESULTS`]: a
/// minimal working window is worth more than the last few percent of budget —
/// but that floor is deliberately small, so a run of very large results does
/// not force the view over the compaction line all by itself.
pub fn prune_plan(messages: &[ChatMessage], target_chars: usize) -> usize {
    // Bulky arguments by call id (the only ones eliding can remove).
    let mut bulky_args: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for m in messages.iter().skip(1) {
        if let Some(calls) = &m.tool_calls {
            for c in calls {
                if c.function.arguments.len() > ELIDE_ARGS_OVER_CHARS {
                    bulky_args.insert(c.id.as_str(), c.function.arguments.len());
                }
            }
        }
    }
    // Footprint that stays whatever the keep count: everything, with each
    // elidable result counted as its placeholder and each bulky argument as
    // its stub.
    let mut fixed: usize = 0;
    let mut per_result: Vec<usize> = Vec::new(); // newest first
    for m in messages.iter().skip(1).rev() {
        let full = message_chars(m);
        match m.role {
            Role::Tool => {
                let c = m.content.as_ref().map(|c| c.len()).unwrap_or(0);
                let elidable_result = if c > 200 { c - 120 } else { 0 };
                let elidable_args = m
                    .tool_call_id
                    .as_deref()
                    .and_then(|id| bulky_args.get(id))
                    .map(|n| n.saturating_sub(200))
                    .unwrap_or(0);
                fixed += full - elidable_result;
                per_result.push(elidable_result + elidable_args);
            }
            Role::Assistant => {
                let elidable: usize = m
                    .tool_calls
                    .as_ref()
                    .map(|calls| {
                        calls
                            .iter()
                            .filter_map(|c| bulky_args.get(c.id.as_str()))
                            .map(|n| n.saturating_sub(200))
                            .sum()
                    })
                    .unwrap_or(0);
                fixed += full - elidable;
            }
            _ => fixed += full,
        }
    }
    let mut keep = 0usize;
    let mut used = fixed;
    for footprint in &per_result {
        if keep >= KEEP_RECENT_TOOL_RESULTS && used + footprint > target_chars {
            break;
        }
        used += footprint;
        keep += 1;
    }
    keep.max(KEEP_RECENT_TOOL_RESULTS)
}

/// Build the request-time view of the working context: `None` while under the
/// pruning threshold (send the canonical history as-is, no clone), otherwise a
/// pruned copy for the wire. The canonical history is NEVER mutated here — old
/// tool results keep their full content in memory and in the session DB until
/// a Level-2 compaction archives them, so nothing the user said or saw is lost
/// to Level-1 pruning.
///
/// This stateless form cuts a sliding window (the last
/// [`KEEP_RECENT_TOOL_RESULTS`] results) and is for one-shot views only. The
/// loop's per-round view comes from [`PruneState`], which pins the cut at an
/// absolute position so the request prefix stays byte-identical between
/// re-plans (see [`build_request_view_eliding`]).
pub fn build_request_view(
    messages: &[ChatMessage],
    prune_threshold: usize,
) -> Option<Vec<ChatMessage>> {
    build_request_view_keeping(messages, prune_threshold, KEEP_RECENT_TOOL_RESULTS)
}

/// [`build_request_view`] with an explicit keep count (from [`prune_plan`]).
///
/// One-shot: there is no previous round whose prefix this view must match, so
/// every superseded task-state register is stubbed, not just the cold ones.
pub fn build_request_view_keeping(
    messages: &[ChatMessage],
    prune_threshold: usize,
    keep_recent: usize,
) -> Option<Vec<ChatMessage>> {
    if context_chars(messages) <= prune_threshold {
        return None;
    }
    let elided = tool_result_count(messages).saturating_sub(keep_recent);
    let mut view = messages.to_vec();
    elide_oldest_tool_results(&mut view, elided);
    stub_oldest_tool_call_args(&mut view, elided);
    stub_superseded_task_states(&mut view);
    Some(view)
}

/// The request view with the OLDEST `elided` tool results behind the cut:
/// their bodies become placeholders, their calls' bulky arguments stubs, and
/// superseded task-state registers in that cold region are stubbed too.
/// Everything from the first kept result onward is the canonical bytes — a
/// superseded register in the verbatim tail stays as the provider already saw
/// it, and is stubbed once a re-plan moves the cut past it.
///
/// Pure function of `(messages, elided)`: with the same cut, a history that
/// only grew at the tail yields a view whose prefix is byte-identical to the
/// previous round's — the whole point of the stepped pruner.
pub fn build_request_view_eliding(messages: &[ChatMessage], elided: usize) -> Vec<ChatMessage> {
    let mut view = messages.to_vec();
    elide_oldest_tool_results(&mut view, elided);
    stub_oldest_tool_call_args(&mut view, elided);
    let cut = cut_message_index(&view, elided);
    stub_superseded_task_states_before(&mut view, cut);
    view
}

/// [`prune_plan`] expressed as the cut the stateful pruner stores: how many
/// of the OLDEST results to elide so the view lands at or under
/// `target_chars`.
pub fn prune_plan_cut(messages: &[ChatMessage], target_chars: usize) -> usize {
    tool_result_count(messages).saturating_sub(prune_plan(messages, target_chars))
}

/// Per-session pruning state carried across rounds so the cut point stays
/// put between prunes (stable prefix → prompt-cache hits).
///
/// `elided` is the number of OLDEST tool results behind the cut — an absolute
/// position in the history, not a distance from its tail. It only moves when
/// the pruned view exceeds the pruning threshold again, and then only forward;
/// between re-plans the same results stay elided, the same stay verbatim, and
/// the only thing that changes from round to round is the tail (the new call
/// and its result). `None` = never pruned yet.
///
/// Why absolute: the earlier design stored "keep the last N", which is a
/// window that slides by one result per round — every round the oldest
/// previously-verbatim result turned into a placeholder, the request prefix
/// changed at that point, and the provider's prompt cache missed from there
/// on, round after round (measured: cache writes of 50–70k tokens on 46
/// consecutive rounds of one session). Counting from the front fixes the
/// boundary.
#[derive(Debug, Clone, Copy, Default)]
pub struct PruneState {
    pub elided: Option<usize>,
    /// `context_chars` of the view right after the last (re-)plan. When the
    /// target is out of reach (the part pruning cannot touch — user turns,
    /// assistant text and reasoning, small arguments, the floor of recent
    /// results — is itself above the target), the view sits above the pruning
    /// line permanently, and re-planning every round would slide the cut by
    /// one result per round: the very churn the absolute cut exists to
    /// prevent. So a re-plan in that regime waits until the view has grown
    /// by a full step past the last plan (see [`PruneState::view`]).
    pub planned_size: usize,
}

impl PruneState {
    /// Decide this round's view. Returns the view (or `None` = canonical as
    /// is) and moves the retained cut when a re-plan was needed.
    ///
    /// - Under the pruning threshold and never pruned: send as is.
    /// - Previously pruned: rebuild with the SAME cut (the tail grew by one
    ///   call; everything else is byte-identical). Re-plan down to `target`
    ///   only when the view is over the pruning threshold AND either it is
    ///   over the compaction threshold (Level 1 must have done its utmost
    ///   before Level 2 is even considered) or it has grown by a full step
    ///   (`prune_threshold − target`) since the last plan. In the normal
    ///   regime — the last plan landed at or under the target — that step
    ///   rule coincides with "over the pruning threshold". The cut never
    ///   moves backward: un-eliding would rewrite the prefix too.
    /// - First time over: plan down to `target`.
    pub fn view(
        &mut self,
        messages: &[ChatMessage],
        prune_threshold: usize,
        target_chars: usize,
        compact_threshold: usize,
    ) -> Option<Vec<ChatMessage>> {
        let total = tool_result_count(messages);
        match self.elided {
            None if context_chars(messages) <= prune_threshold => None,
            // A cut beyond the history means the history was rewritten under
            // us without a reset (should not happen; be safe): plan afresh.
            Some(elided) if elided <= total => {
                let view = build_request_view_eliding(messages, elided);
                let size = context_chars(&view);
                let step = prune_threshold.saturating_sub(target_chars);
                let due = size > compact_threshold || size > self.planned_size.saturating_add(step);
                if size <= prune_threshold || !due {
                    return Some(view);
                }
                // The verbatim tail outgrew the budget: move the cut forward.
                Some(self.replan(messages, target_chars, elided))
            }
            _ => Some(self.replan(messages, target_chars, 0)),
        }
    }

    /// Cut regardless of the estimate — the provider itself rejected the
    /// request as too long, so a view is built even though our numbers said
    /// the canonical history fits. Moves the cut forward like a re-plan.
    pub fn force_cut(&mut self, messages: &[ChatMessage], target_chars: usize) -> Vec<ChatMessage> {
        let floor = self.elided.unwrap_or(0);
        self.replan(messages, target_chars, floor)
    }

    /// Plan a new cut at or past `floor`, record it and the size it lands at.
    fn replan(&mut self, messages: &[ChatMessage], target_chars: usize, floor: usize) -> Vec<ChatMessage> {
        let elided = prune_plan_cut(messages, target_chars).max(floor);
        let view = build_request_view_eliding(messages, elided);
        self.elided = Some(elided);
        self.planned_size = context_chars(&view);
        view
    }

    /// Forget the cut (after a Level-2 compaction rewrote the history).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Per-SESSION context memory the loop carries from one turn to the next: the
/// Level-1 cut point and a tokenizer calibration. Held on the session (not the
/// per-turn loop) so a new user message does not re-cut the prefix — the same
/// calls stay elided, the same stay verbatim, and the provider's prompt cache
/// survives the turn boundary. Reset when the history is rewritten
/// (compaction, rewind, clear).
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionContextState {
    pub prune: PruneState,
    /// Measured characters-per-token of THIS session's content, from the
    /// provider's own count of the last request (`usage.prompt_tokens`)
    /// against the character size of the view that request carried. `None`
    /// until one round has been measured.
    ///
    /// This is the one honest use of the provider's figure: it counts the
    /// VIEW that was sent, not the canonical history, so it cannot stand in
    /// for either size directly — but the ratio between "what we estimated
    /// for that view" and "what the tokenizer counted" transfers to both.
    /// Mixed Chinese/English/code sessions measure 1.7–2.6 depending on the
    /// model; the static default is the conservative end of that range.
    pub chars_per_token: Option<f64>,
}

impl SessionContextState {
    /// Record one measurement: `sent_chars` is `context_chars` of the
    /// messages that went on the wire, `prompt_tokens` what the provider
    /// counted for them. Clamped to a sane band so a single odd report
    /// (system-prompt-only round, image tokens) cannot swing the estimate.
    pub fn observe(&mut self, sent_chars: usize, prompt_tokens: u32) {
        if prompt_tokens == 0 || sent_chars < 2_000 {
            return; // too small to say anything about the ratio
        }
        let ratio = (sent_chars as f64 / prompt_tokens as f64).clamp(1.0, 6.0);
        // Exponential smoothing: the prompt only changes by one round's worth
        // between measurements, so a heavy weight on the new sample is right,
        // while still damping a single outlier.
        self.chars_per_token = Some(match self.chars_per_token {
            Some(prev) => prev * 0.3 + ratio * 0.7,
            None => ratio,
        });
    }

    /// Convert a character estimate to the calibrated character scale the
    /// thresholds use: `chars × (CHARS_PER_TOKEN_F / measured)`. With no
    /// measurement yet the estimate is returned unchanged. Content that
    /// tokenizes denser than the default (fewer chars per token) is scaled UP
    /// so the thresholds bite earlier; sparser content is scaled down.
    pub fn calibrated(&self, chars: usize) -> usize {
        match self.chars_per_token {
            Some(measured) if measured > 0.0 => {
                (chars as f64 * (CHARS_PER_TOKEN_F / measured)) as usize
            }
            _ => chars,
        }
    }

    /// The inverse: a threshold expressed in default-scale characters,
    /// brought onto this session's raw character scale so raw `context_chars`
    /// can be compared against it directly. (Scaling the three thresholds
    /// once per round is the same decision as scaling every size, with one
    /// place to get it right.)
    pub fn threshold_for(&self, default_scale_chars: usize) -> usize {
        match self.chars_per_token {
            Some(measured) if measured > 0.0 => {
                (default_scale_chars as f64 * (measured / CHARS_PER_TOKEN_F)) as usize
            }
            _ => default_scale_chars,
        }
    }

    /// The history was rewritten: the cut no longer describes it. The
    /// calibration is a property of the session's CONTENT and survives —
    /// a summary is still the same language and the same code.
    pub fn reset_cut(&mut self) {
        self.prune.reset();
    }

    /// Everything, including the calibration (session cleared / rewound to a
    /// different conversation).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Shared handle to a session's [`SessionContextState`].
pub type SharedContextState = std::sync::Arc<std::sync::Mutex<SessionContextState>>;

/// A fresh, unshared [`SharedContextState`] (for one-off turns and tests).
pub fn fresh_context_state() -> SharedContextState {
    std::sync::Arc::new(std::sync::Mutex::new(SessionContextState::default()))
}

/// Level-2 trigger decision: compact when the pruned view still exceeds the
/// compaction threshold, OR the canonical history (which pruning no longer
/// shrinks) exceeds the `CANONICAL_CAP_FACTOR` hard cap.
pub fn should_compact(canonical_chars: usize, view_chars: usize, compact_threshold: usize) -> bool {
    view_chars > compact_threshold
        || canonical_chars > compact_threshold.saturating_mul(CANONICAL_CAP_FACTOR)
}

/// Characters of recent history kept verbatim behind a compaction summary,
/// on the same scale as `compact_threshold` (see [`COMPACTION_TAIL_RATIO`]).
pub fn compaction_tail_budget(compact_threshold: usize) -> usize {
    (compact_threshold as f64 * COMPACTION_TAIL_RATIO) as usize
}

/// Where the verbatim tail begins when `messages` is compacted: the longest
/// suffix within `budget_chars` (by the same measure as [`context_chars`])
/// that starts on a clean boundary — a user, skill or assistant message,
/// never a tool result, whose call would otherwise be summarized away from
/// under it (an assistant message with tool calls brings ALL its results
/// along or is not the boundary). The first non-system message is always
/// summarized, so there is something for the summary to replace even when
/// the whole history would fit; `messages.len()` means no tail fits and the
/// summary stands alone.
pub fn compaction_tail_start(messages: &[ChatMessage], budget_chars: usize) -> usize {
    let first = usize::from(messages.first().is_some_and(|m| m.role == Role::System));
    let mut start = messages.len();
    let mut size = 0usize;
    for i in (first + 1..messages.len()).rev() {
        size += message_chars(&messages[i]);
        if size > budget_chars {
            break;
        }
        if messages[i].role != Role::Tool {
            start = i;
        }
    }
    start
}

/// First line of every compaction summary message, byte-for-byte. FROZEN:
/// the chat UI collapses summary messages by matching this exact prefix
/// (AgentChat.tsx `summaryMarker`), and `read_session`'s transcript stitching
/// keys on it too — extra information belongs on the following lines, never
/// inside the brackets.
pub const SUMMARY_MARKER: &str = "[Conversation Summary]";

// ── Task-state registers ──

/// The size the model is told to stay under for one `update_task_state`
/// block — together with [`TASK_STATE_AIM_CHARS`], the only figure it ever
/// sees. Past it the write is still ACCEPTED (refusing would throw away the
/// freshest state at exactly the moment the model is busiest and compaction
/// nearest), but the acknowledgement asks for a trim on the next update.
pub const TASK_STATE_TARGET_CHARS: usize = 2000;

/// The figure quoted to the model as what to aim for. Models overshoot any
/// size they are given by a fair margin (a quarter over is typical), so the
/// aim sits below the target: a block written "at about" this size lands
/// under [`TASK_STATE_TARGET_CHARS`].
pub const TASK_STATE_AIM_CHARS: usize = TASK_STATE_TARGET_CHARS * 3 / 4;

/// Hard cap. Past this the tool refuses the write and the replay
/// ([`latest_task_state`]) ignores it — a register at twice its target is a
/// log, not a register. Deliberately NOT advertised to the model: a published
/// grace band would simply become the new target.
pub const TASK_STATE_MAX_CHARS: usize = 4000;

/// The one verdict on a candidate register block. Shared by the tool
/// (`agent_loop` accepts or refuses the write and words its acknowledgement
/// from it), the replay ([`latest_task_state`]) and the request-view stub
/// ([`stub_superseded_task_states`]), so what "the live register" means can
/// never drift between them. Sizes are in `chars()`, the unit every other
/// context measure in this module uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStateVerdict {
    /// Nothing to record.
    Empty,
    /// Over [`TASK_STATE_MAX_CHARS`]: refused, never becomes the snapshot.
    OverCap(usize),
    /// Over [`TASK_STATE_TARGET_CHARS`] but within the cap: recorded, with a
    /// nudge to trim next time.
    OverTarget(usize),
    /// Within the target: recorded silently.
    Ok(usize),
}

impl TaskStateVerdict {
    /// Whether the write is recorded, i.e. can be the live register.
    pub fn accepted(self) -> bool {
        matches!(self, Self::Ok(_) | Self::OverTarget(_))
    }
}

/// Judge a candidate block. Takes the state already `trim()`med — the tool
/// and the replay both trim before judging, so the count is of what would
/// actually be stored.
pub fn task_state_verdict(trimmed: &str) -> TaskStateVerdict {
    let n = trimmed.chars().count();
    if n == 0 {
        TaskStateVerdict::Empty
    } else if n > TASK_STATE_MAX_CHARS {
        TaskStateVerdict::OverCap(n)
    } else if n > TASK_STATE_TARGET_CHARS {
        TaskStateVerdict::OverTarget(n)
    } else {
        TaskStateVerdict::Ok(n)
    }
}

/// The trimmed `state` argument of an `update_task_state` call, when its
/// arguments parse. The replay and the view stub both read writes this way.
fn task_state_arg(call: &ToolCall) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&call.function.arguments)
        .ok()
        .and_then(|v| {
            v.get("state")
                .and_then(|s| s.as_str())
                .map(|s| s.trim().to_string())
        })
}

const TASK_STATE_OPEN: &str = "[Task State]\n";
const TASK_STATE_CLOSE: &str = "\n[/Task State]";

/// The task-state block in force at the END of `messages`.
///
/// The state has no store of its own — the history IS the store: the newest
/// accepted `update_task_state` call wins, and when none exists (e.g. right
/// after a compaction replaced those calls with a summary), the block an
/// earlier compaction embedded in its summary message carries forward.
/// "Accepted" is [`task_state_verdict`]'s word, the same one the tool uses,
/// so a call the tool refused can never become the snapshot.
pub fn latest_task_state(messages: &[ChatMessage]) -> Option<String> {
    for msg in messages.iter().rev() {
        if let Some(tcs) = &msg.tool_calls {
            for tc in tcs.iter().rev() {
                if tc.function.name != "update_task_state" {
                    continue;
                }
                if let Some(state) = task_state_arg(tc) {
                    if task_state_verdict(&state).accepted() {
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

/// Defuse task-state delimiters in text WE did not write. Summary messages
/// start with [`SUMMARY_MARKER`], which makes everything in them trusted by
/// [`latest_task_state`] — but the LLM-written narrative may quote a pasted
/// transcript that contains a `[Task State]` block. Run the narrative through
/// this before embedding it, so the only block a summary can carry is the one
/// [`task_state_block`] wrapped. The quoted text stays readable; only the
/// delimiters stop matching.
pub fn neutralize_task_state_markers(s: &str) -> String {
    s.replace(
        TASK_STATE_OPEN.trim_end_matches('\n'),
        "[Task State (quoted)]",
    )
    .replace(
        TASK_STATE_CLOSE.trim_start_matches('\n'),
        "[/Task State (quoted)]",
    )
}

/// Upper bound on the transcript handed to the summarizer, in characters.
/// A 1,100-message session at the per-entry caps below would produce a
/// ~770k-character transcript — more than the summarizing model's own window
/// (the four long sessions measured 300k–1M tokens canonical). The oldest
/// entries are dropped first: the summary exists to carry the RECENT state
/// forward, and an earlier compaction already folded what came before.
const SUMMARY_TRANSCRIPT_MAX_CHARS: usize = 240_000;

/// The size the summarizer is told to stay under, in characters. Unbounded,
/// the summaries measured 6.4–11.3k characters and the summarizer call took
/// 85–100 s — output tokens are wall-clock time the user's turn is stalled
/// for. What used to justify the length now rides along verbatim (the
/// assistant's own task-state block, the most recent messages — see
/// [`compaction_tail_start`]) or is written by code (the recall index, see
/// [`recall_index`]: a 5k-character summary measured 1.9k characters of
/// recited call ids, ≈ 12 output tokens each), so the narrative only has to
/// cover the rest. CJK text spends about twice the tokens per character that
/// Latin text does, which makes this bound worth ~1.5–3k output tokens.
pub const SUMMARY_TARGET_CHARS: usize = 3_500;

/// How much of an EARLIER compaction's summary the summarizer gets to see
/// when it is folded into the next one. Clipping it to the 500-character head
/// every other entry gets — as happened before this cap existed — threw most
/// of the previous generation away at each re-compaction. Generous: the
/// summary is bounded by [`SUMMARY_TARGET_CHARS`] plus the task-state block
/// and the recall index.
const PRIOR_SUMMARY_MAX_CHARS: usize = 12_000;

/// Tool results at or above this size get a line in the compaction's recall
/// index (see [`recall_index`]). Below it the summary's paraphrase is about as
/// good as the original — and the ids stay out of the index so the largest
/// results can have the lines.
pub const RECALL_INDEX_MIN_CHARS: usize = 1_500;
/// Most lines the recall index carries: the largest results of the span win
/// (a 280-message span measured 136 results, 59 of them above the floor).
pub const RECALL_INDEX_MAX_LINES: usize = 24;
/// Heading of the recall index inside a compaction summary.
pub const RECALL_INDEX_HEADING: &str = "[Recallable tool results]";

/// A machine-written index of the largest tool results in `messages` (the
/// span a compaction summary replaces): one line per result — call id, tool,
/// the head of its arguments, size — so the assistant can still reach them
/// through `recall_result(call_id=...)` once the raw history is gone, WITHOUT
/// the summarizer reciting the ids (≈ 12 output tokens apiece, the most
/// expensive thing it wrote). Lines an earlier compaction's index carried
/// (the span opens with the previous summary, whose index is the only trace
/// of results archived before it) are inherited into whatever room the span's
/// own results leave, newest first. Chronological; `None` when nothing
/// qualifies.
pub fn recall_index(messages: &[ChatMessage]) -> Option<String> {
    let mut calls: HashMap<&str, (&str, &str)> = HashMap::new();
    for msg in messages {
        for tc in msg.tool_calls.iter().flatten() {
            calls.insert(
                tc.id.as_str(),
                (tc.function.name.as_str(), tc.function.arguments.as_str()),
            );
        }
    }
    let mut hits: Vec<(usize, &str, usize)> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == Role::Tool)
        .filter_map(|(i, m)| {
            let id = m.tool_call_id.as_deref()?;
            let chars = m.content.as_deref().map_or(0, |c| c.chars().count());
            (chars >= RECALL_INDEX_MIN_CHARS).then_some((i, id, chars))
        })
        .collect();
    hits.sort_by(|a, b| b.2.cmp(&a.2));
    hits.truncate(RECALL_INDEX_MAX_LINES);
    hits.sort_by_key(|h| h.0);
    let room = RECALL_INDEX_MAX_LINES - hits.len();
    let inherited: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == Role::User)
        .filter_map(|m| m.content.as_deref())
        .filter(|c| c.starts_with(SUMMARY_MARKER))
        .flat_map(prior_index_lines)
        .collect();
    let inherited = &inherited[inherited.len().saturating_sub(room)..];
    if hits.is_empty() && inherited.is_empty() {
        return None;
    }
    let mut out = format!(
        "{RECALL_INDEX_HEADING}\nThe largest tool results of the summarized history; \
         recall_result(call_id=...) returns the full content.\n"
    );
    for line in inherited {
        out.push_str(line);
        out.push('\n');
    }
    for (_, id, chars) in hits {
        let (name, args) = calls.get(id).copied().unwrap_or(("?", ""));
        let head: String = args
            .chars()
            .take(80)
            .map(|c| if c == '\n' { ' ' } else { c })
            .collect();
        let ellipsis = if args.chars().count() > 80 { "…" } else { "" };
        let size = if chars >= 1_000 {
            format!("{:.1}k", chars as f64 / 1_000.0)
        } else {
            chars.to_string()
        };
        out.push_str(&format!("- {id}  {name}({head}{ellipsis})  {size} chars\n"));
    }
    Some(out.trim_end().to_string())
}

/// The `- call_id …` lines of the recall index inside an earlier summary
/// message: the run of index lines after [`RECALL_INDEX_HEADING`] and its
/// one-line caption.
fn prior_index_lines(summary: &str) -> impl Iterator<Item = &str> {
    summary
        .lines()
        .skip_while(|l| l.trim() != RECALL_INDEX_HEADING)
        .skip(1)
        .skip_while(|l| !l.starts_with("- "))
        .take_while(|l| l.starts_with("- "))
}

/// What the summarizer is told about the context its summary lands in, so it
/// does not spend its budget on what is already there.
#[derive(Debug, Clone, Copy, Default)]
pub struct SummaryScope<'a> {
    /// Messages after the summarized span that stay in the context verbatim.
    pub tail_kept: usize,
    /// The assistant's task-state block that is appended to the summary
    /// verbatim, if the assistant maintained one.
    pub task_state: Option<&'a str>,
}

/// Level 2: ask the LLM to summarize `messages` — the span of history the
/// summary will REPLACE — into a compact structured summary of at most about
/// [`SUMMARY_TARGET_CHARS`] characters. Runs with the least reasoning the
/// model accepts (see [`LlmClient::with_minimal_reasoning`]), falling back to
/// the turn's own settings if that is refused. An empty reply is an error,
/// never a summary: the caller keeps the history intact and retries on a
/// later round.
pub async fn compact_context(
    client: &LlmClient,
    messages: &[ChatMessage],
    scope: SummaryScope<'_>,
) -> Result<String, Box<dyn Error + Send + Sync>> {
    let mut entries: Vec<String> = Vec::new();
    for msg in messages {
        if msg.role == Role::System {
            continue;
        }
        let role = match msg.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
            Role::Skill => "skill",
            _ => continue,
        };
        if let Some(ref content) = msg.content {
            // An earlier compaction's summary IS the older history, compressed:
            // it goes in whole (bounded by its own writer's limit), where every
            // other entry is clipped to its head.
            let is_prior_summary = msg.role == Role::User && content.starts_with(SUMMARY_MARKER);
            let cap = if is_prior_summary { PRIOR_SUMMARY_MAX_CHARS } else { 500 };
            let brief = if content.chars().count() > cap {
                format!("{}...", &content.chars().take(cap).collect::<String>())
            } else {
                content.clone()
            };
            // Tool results carry their call_id so the summary can preserve
            // it — the id is the address recall_result retrieves the full
            // content by, after this summary has replaced the raw history.
            match (&msg.role, msg.tool_call_id.as_deref()) {
                (Role::Tool, Some(id)) => entries.push(format!("[tool {}] {}\n", id, brief)),
                _ => entries.push(format!("[{}] {}\n", role, brief)),
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
                entries.push(format!(
                    "[assistant→tool {}] {}({})\n",
                    tc.id, tc.function.name, brief_args
                ));
            }
        }
    }
    // Bound the transcript: drop the oldest entries until it fits, and say
    // so, but never drop a leading `[user]` summary from an earlier
    // compaction (it IS the older history, compressed).
    let mut total: usize = entries.iter().map(String::len).sum();
    let mut dropped = 0usize;
    let keep_head = entries
        .first()
        .is_some_and(|e| e.starts_with("[user] ") && e.contains(SUMMARY_MARKER))
        as usize;
    while total > SUMMARY_TRANSCRIPT_MAX_CHARS && entries.len() > keep_head + 1 {
        let removed = entries.remove(keep_head);
        total -= removed.len();
        dropped += 1;
    }
    let mut history = String::with_capacity(total + 128);
    for (i, entry) in entries.iter().enumerate() {
        if i == keep_head && dropped > 0 {
            history.push_str(&format!(
                "[... {dropped} earlier entries omitted from this transcript ...]\n"
            ));
        }
        history.push_str(entry);
    }

    let mut instructions = format!(
        "You are a summarizer. Condense the conversation history into a compact, \
         structured summary from which the assistant can resume the work without \
         the original transcript. Use short headings with terse bullet lines: \
         1) the user's goal and constraints, and the current status; \
         2) what was done and the results — the key facts (paths, names, figures, \
         decisions and why); \
         3) open problems and next steps. \
         Do NOT compile lists of tool-call ids: an index of the large tool results \
         (id, tool, arguments, size) is appended to your summary automatically; \
         mention an id only where a specific fact would be unusable without it. \
         A [Conversation Summary] entry opening the transcript is the summary of \
         even earlier history: fold what still matters from it into yours. \
         Hard limit: {SUMMARY_TARGET_CHARS} characters in total — drop narrative \
         before facts, never exceed it. \
         Write the summary in the language the conversation itself uses. \
         Output the summary only, without preamble or commentary."
    );
    if scope.tail_kept > 0 {
        instructions.push_str(&format!(
            " The {} most recent messages of the conversation are not in the \
             transcript: they stay in the context verbatim after your summary, so \
             cover only what the transcript shows.",
            scope.tail_kept
        ));
    }
    let mut request = String::with_capacity(history.len() + 512);
    if let Some(state) = scope.task_state {
        request.push_str(
            "The assistant's own task-state block below is appended to your summary \
             verbatim — do not repeat what it says; cover what it lacks.\n\n",
        );
        request.push_str(state);
        request.push_str("\n\n");
    }
    request.push_str("Summarize the following conversation:\n\n");
    request.push_str(&history);
    let compact_messages = vec![ChatMessage::system(&instructions), ChatMessage::user(&request)];

    let started = wasmtimer::std::Instant::now();
    let (tx, _rx) = mpsc::unbounded_channel();
    // The summarizer: the configured compaction model (if any) at minimal
    // reasoning — the summary is bounded, mechanical work, and every token
    // the model spends deliberating is wall-clock time the user's turn is
    // stalled for. Should the provider reject that client (an unknown
    // compaction model, a refused parameter tuple) or hiccup, the turn's own
    // client gets one try before giving up.
    let summarizer = client.for_compaction();
    let result = match summarizer.chat_stream(&compact_messages, None, &tx).await {
        Ok(result) => result,
        Err(e) => {
            log::warn!(
                "compaction summary on {} at minimal reasoning failed ({e}); retrying at the turn's settings on {}",
                summarizer.model(),
                client.model()
            );
            client.chat_stream(&compact_messages, None, &tx).await?
        }
    };
    let summary = result
        .content
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .ok_or("the summarizer returned no content")?;
    log::info!(
        "compaction summary ({}): transcript {} bytes in {} entries ({} dropped) -> {} chars in {:.1}s",
        summarizer.model(),
        history.len(),
        entries.len(),
        dropped,
        summary.chars().count(),
        started.elapsed().as_secs_f64()
    );
    Ok(summary)
}

