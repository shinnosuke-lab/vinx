//! Agent → frontend events + user-response types.
//!
//! TUI-flavored `Render*` variants are kept as generic events that channels
//! may ignore.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::types::{ChatMessage, RiskLevel, TokenUsage};

/// One selectable option inside an `AskQuestion`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// One question in an `ask_user` request. Multiple `AskQuestion`s can ride a
/// single `AgentEvent::AskUser` so the LLM can collect several decisions at once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskQuestion {
    pub id: String,
    pub question: String,
    pub options: Vec<AskOption>,
    #[serde(default)]
    pub allow_custom: bool,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

/// User's answer to a single `AskQuestion`, tied back via `question_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskAnswer {
    pub question_id: String,
    #[serde(default)]
    pub selected_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
}

// `non_exhaustive`: downstream crates must keep a wildcard arm when matching,
// so the kernel can add event variants without breaking embedders (the Rust
// half of "we don't break userspace"; the SSE half lives in docs/PROTOCOL.md).
#[non_exhaustive]
#[derive(Debug, Clone)]
pub enum AgentEvent {
    // Streaming output
    StreamContent(String),
    StreamReasoning(String),

    // Tool calls
    ToolCallStart {
        id: String,
        name: String,
        arguments: String,
    },
    ToolCallArgumentsDelta {
        id: String,
        delta: String,
    },
    ToolCallResult {
        id: String,
        result: String,
        /// The loop's single verdict on this call (structured `ToolResult::success`
        /// first, string heuristics as fallback). Sinks must consume this bit
        /// instead of re-sniffing `result` — the kernel decides once.
        success: bool,
    },

    // Confirmation requests (with risk level)
    ConfirmTool {
        id: String,
        name: String,
        arguments: String,
        risk: RiskLevel,
    },

    /// Structured user-input request from the `ask_user` tool. Carries 1..N
    /// independent questions so a single tool_call can resolve several
    /// uncertain parameters at once.
    AskUser {
        id: String,
        questions: Vec<AskQuestion>,
        /// Set in unattended sessions (FULL-AUTO / trust-all): after this many
        /// seconds without an answer the loop auto-picks each question's
        /// recommended default and moves on. UIs should show a countdown.
        /// `None` = the loop waits indefinitely (attended session).
        timeout_secs: Option<u64>,
    },

    /// An event from a sub-agent (`task` tool call), wrapped so channels can
    /// tell child output from parent output. `task_id` is the parent `task`
    /// tool_call id; `session_id` is the child's hidden transcript session
    /// (`task-<uuid>`), so delivery layers can mirror child events onto a
    /// live view of that session; `label` is the task's human-readable name
    /// (its `description` argument), riding every envelope so a viewer that
    /// never saw the parent round's tool_start (e.g. a re-attach whose replay
    /// was trimmed) can still title the progress row. Child `ConfirmTool`
    /// events are the exception — they are forwarded unwrapped (see
    /// `agent_task`) so confirm UIs work untouched.
    Subagent {
        task_id: String,
        session_id: String,
        label: String,
        event: Box<AgentEvent>,
    },

    /// A user message was steered into the RUNNING turn (the "send now"
    /// path): the loop appended it to the context at a round boundary and the
    /// model sees it on its next request. UIs append a user bubble in place.
    UserInjected {
        text: String,
    },

    /// A steered message the turn accepted but never reached a round boundary
    /// for, because the turn then failed. Internal: the driver (web pump /
    /// TUI) puts the text back at the FRONT of its queue so the next turn
    /// starts with it. Clients learn about it from the resulting queue state,
    /// not from this event.
    SteerRequeued {
        text: String,
    },

    /// A skill was activated (the model called `read_skill`). Carries the
    /// enforced tool allow-list so the web layer can persist it on the session
    /// (cross-turn) and surface the active skill in the UI.
    SkillActivated {
        name: String,
        allowed_tools: Vec<String>,
    },

    /// The active skill was cleared (the model called `read_skill` with the
    /// reserved `reset`/`none` name). The web layer should drop the persisted
    /// active skill so the next turn starts with the full toolset.
    SkillDeactivated,

    // Lifecycle
    AssistantDone {
        elapsed_ms: u64,
    },
    /// Token accounting for ONE LLM round (a turn with tool calls emits
    /// several), straight from the provider's `usage` report. Emitted only
    /// when the provider reported one. `model` is the model the round was
    /// sent to. Sinks use it for per-session counters; ignoring it is fine.
    Usage {
        model: String,
        usage: TokenUsage,
    },
    Error(String),
    SessionSync {
        new_messages: Vec<ChatMessage>,
        full_context: Vec<ChatMessage>,
        /// Whether a pending skill (de)activation should commit with this sync.
        /// `true` on normal turn completion; `false` on the error-path sync so a
        /// turn that errored before real progress persists its messages without
        /// silently activating a skill whose turn never ran.
        commit_skill: bool,
    },

    // Mode/profile changes
    ModeSwitch(String),
    ProfileSwitch(String),

    // Status
    /// A one-line note to the user about what the loop itself is doing, apart
    /// from the model's output ("Compacting context..."). `pending` marks
    /// work in flight that the NEXT `StatusUpdate` resolves: a sink shows it
    /// as the current activity and lets that next note replace it, so the
    /// transcript keeps the outcome rather than the wait. A note with
    /// `pending: false` is such an outcome (or a standalone remark) and
    /// stays.
    StatusUpdate { text: String, pending: bool },

    // Optional rich rendering (channels can ignore)
    RenderBarChart {
        title: String,
        labels: Vec<String>,
        values: Vec<u64>,
    },
    RenderSparkline {
        title: String,
        values: Vec<u64>,
    },
    RenderLineChart {
        title: String,
        x_label: String,
        y_label: String,
        series_names: Vec<String>,
        datasets: Vec<Vec<f64>>,
    },
    RenderGauge {
        title: String,
        items: Vec<(String, f64, f64)>,
    },
    /// Easter egg: LLM-authored CSS/JS to restyle the chat web UI (from the
    /// `set_chat_style` tool). Empty `css` + `js` means "reset to default".
    /// Non-web channels (TUI) ignore it.
    ///
    /// `assets_changed` = this call also replaced the files served at
    /// `/theme/assets/`. The frontend previews css while the arguments are still
    /// streaming — before those files exist — so any `url()` pointing at the
    /// mount point 404s during the preview. The flag tells it that re-injecting
    /// identical css is NOT a no-op this time: it is what makes the browser
    /// request the images again, now that they are on disk.
    ApplyChatStyle {
        css: String,
        js: String,
        assets_changed: bool,
    },
    SuspendTerminal,
    ResumeTerminal,
}

/// User's response to a `ConfirmTool` event.
///
/// `Approve` carries optional amended arguments so a confirm UI can edit the
/// tool args before approving. Most callers send `None`.
///
/// `ApproveAll` approves the pending call AND flips the session-scoped
/// auto-confirm flag, so every later confirmation in this session is skipped
/// (ask_user is unaffected — it is not a confirmation).
#[derive(Debug, Clone)]
pub enum ConfirmResponse {
    Approve {
        amended_args: Option<serde_json::Value>,
    },
    ApproveAll,
    Deny,
}

impl ConfirmResponse {
    pub fn approve() -> Self {
        ConfirmResponse::Approve { amended_args: None }
    }
}

impl From<bool> for ConfirmResponse {
    fn from(v: bool) -> Self {
        if v {
            ConfirmResponse::approve()
        } else {
            ConfirmResponse::Deny
        }
    }
}

/// User's response to an `AskUser` event.
#[derive(Debug, Clone)]
pub enum AskUserResponse {
    Answered {
        answers: Vec<AskAnswer>,
    },
    Cancelled,
    /// Not an answer: the user is interacting with the pending question
    /// (selecting options, typing a custom reply). Resets the unattended
    /// auto-pick deadline back to the full `ask_user_timeout_secs`; ignored
    /// when no timeout is armed (attended sessions).
    Activity,
}

/// Serialize the user's answers (matched against `questions` by `question_id`)
/// into the structured JSON tool_result the LLM consumes:
/// `{ cancelled, auto_picked, note?, answers: [{ question_id, question,
/// selected_ids, selected_labels, custom_text? }] }`.
///
/// `note` appears only with `auto_picked: true`, and says in words what the
/// flag means: a model reading `selected_labels: ["Images"]` next to a bare
/// boolean it was never told about has answered "understood — it's the
/// images" and built a feature nobody asked for. The sentence travels with
/// the data so it cannot be missed.
pub(crate) fn build_ask_user_payload(
    questions: &[AskQuestion],
    answers: &[AskAnswer],
    cancelled: bool,
    auto_picked: bool,
) -> String {
    let by_qid: HashMap<&str, &AskAnswer> = answers
        .iter()
        .map(|a| (a.question_id.as_str(), a))
        .collect();
    let items: Vec<serde_json::Value> = questions
        .iter()
        .map(|q| {
            let a = by_qid.get(q.id.as_str()).copied();
            let selected_ids: Vec<String> = a.map(|a| a.selected_ids.clone()).unwrap_or_default();
            let selected_labels: Vec<String> = selected_ids
                .iter()
                .filter_map(|sid| {
                    q.options
                        .iter()
                        .find(|o| &o.id == sid)
                        .map(|o| o.label.clone())
                })
                .collect();
            let custom = a.and_then(|a| a.custom_text.clone());
            let mut obj = serde_json::Map::new();
            obj.insert(
                "question_id".into(),
                serde_json::Value::String(q.id.clone()),
            );
            obj.insert(
                "question".into(),
                serde_json::Value::String(q.question.clone()),
            );
            obj.insert(
                "selected_ids".into(),
                serde_json::to_value(&selected_ids).unwrap_or(serde_json::Value::Null),
            );
            obj.insert(
                "selected_labels".into(),
                serde_json::to_value(&selected_labels).unwrap_or(serde_json::Value::Null),
            );
            if let Some(c) = custom {
                obj.insert("custom_text".into(), serde_json::Value::String(c));
            }
            serde_json::Value::Object(obj)
        })
        .collect();
    let mut root = serde_json::Map::new();
    root.insert("cancelled".into(), serde_json::Value::Bool(cancelled));
    root.insert("auto_picked".into(), serde_json::Value::Bool(auto_picked));
    if auto_picked {
        root.insert(
            "note".into(),
            serde_json::Value::String(
                "The user did not answer: the session is unattended and these are the \
                 default options, filled in after a timeout — not their choice. Treat them \
                 as your own guess: say what you assumed, keep the work that rests on it \
                 small and reversible, and for a question about what they actually want, \
                 prefer to stop and ask in prose over committing to a large piece of work."
                    .into(),
            ),
        );
    }
    root.insert("answers".into(), serde_json::Value::Array(items));
    serde_json::Value::Object(root).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_question() -> Vec<AskQuestion> {
        vec![AskQuestion {
            id: "q".into(),
            question: "Which?".into(),
            options: vec![
                AskOption {
                    id: "a".into(),
                    label: "A".into(),
                    hint: None,
                },
                AskOption {
                    id: "b".into(),
                    label: "B".into(),
                    hint: None,
                },
            ],
            allow_custom: false,
            multi_select: false,
            default_id: None,
        }]
    }

    /// The flag alone was read as an answer once; the sentence rides along.
    #[test]
    fn an_auto_pick_says_so_in_words() {
        let answers = vec![AskAnswer {
            question_id: "q".into(),
            selected_ids: vec!["a".into()],
            custom_text: None,
        }];
        let picked: serde_json::Value = serde_json::from_str(&build_ask_user_payload(
            &one_question(),
            &answers,
            false,
            true,
        ))
        .unwrap();
        assert_eq!(picked["auto_picked"], true);
        let note = picked["note"]
            .as_str()
            .expect("a note travels with an auto-pick");
        assert!(note.contains("did not answer"), "{note}");
        assert!(note.contains("not their choice"), "{note}");
        assert_eq!(picked["answers"][0]["selected_labels"][0], "A");

        let answered: serde_json::Value = serde_json::from_str(&build_ask_user_payload(
            &one_question(),
            &answers,
            false,
            false,
        ))
        .unwrap();
        assert_eq!(answered["auto_picked"], false);
        assert!(
            answered.get("note").is_none(),
            "a real answer carries no note: {answered}"
        );
    }
}
