//! Agent → frontend events + user-response types.
//!
//! TUI-flavored `Render*` variants are kept as generic events that channels
//! may ignore.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::types::{ChatMessage, RiskLevel};

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
    /// tool_call id. Child `ConfirmTool` events are the exception — they are
    /// forwarded unwrapped (see `agent_task`) so confirm UIs work untouched.
    Subagent {
        task_id: String,
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
    StatusUpdate(String),

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
    Answered { answers: Vec<AskAnswer> },
    Cancelled,
    /// Not an answer: the user is interacting with the pending question
    /// (selecting options, typing a custom reply). Resets the unattended
    /// auto-pick deadline back to the full `ask_user_timeout_secs`; ignored
    /// when no timeout is armed (attended sessions).
    Activity,
}

/// Serialize the user's answers (matched against `questions` by `question_id`)
/// into the structured JSON tool_result the LLM consumes:
/// `{ cancelled, auto_picked, answers: [{ question_id, question, selected_ids,
/// selected_labels, custom_text? }] }`.
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
    root.insert("answers".into(), serde_json::Value::Array(items));
    serde_json::Value::Object(root).to_string()
}
