//! Turn transaction primitives, shared by every frontend (web, TUI).
//!
//! A turn is staged, run, then committed — never written first and rolled
//! back. [`stage_turn`] builds the loop snapshot without touching committed
//! state; [`TurnLedger`] watches the loop's event stream and yields a
//! [`TurnCommit`] at each sync point. A turn that errors before any sync
//! therefore leaves nothing behind, on any frontend.

use crate::event::AgentEvent;
use crate::skill::{ActiveSkill, PreparedSkillActivation};
use crate::types::ChatMessage;

/// A staged (not yet committed) turn: the snapshot to feed the agent loop
/// plus the optimistic state the caller may announce/display immediately.
#[derive(Debug, Clone)]
pub struct StagedTurn {
    /// Committed messages + system seed? + user message? + skill context?.
    pub snapshot: Vec<ChatMessage>,
    /// The skill steering this turn (optimistic until committed).
    pub skill_seed: Option<ActiveSkill>,
    /// Skill events to announce before the loop starts (optimistic UI state).
    pub announce: Vec<AgentEvent>,
    /// The staged user message text, when one was staged (drives user bubbles).
    pub user_text: Option<String>,
    /// True for an explicit reset: deactivation is deterministic control-plane
    /// work that cannot fail, so the caller must commit it immediately,
    /// independent of the turn result.
    pub commit_reset: bool,
}

/// Stage a turn from committed state. Pure — no session or store is touched;
/// applying `commit_reset` and registering control channels stay with the
/// caller.
///
/// `attachments`: image references riding the staged user message. An
/// attachment IS a message — a turn with attachments and empty text still
/// stages a user message.
pub fn stage_turn(
    committed: &[ChatMessage],
    committed_skill: Option<ActiveSkill>,
    system_prompt: &str,
    message: &str,
    attachments: Vec<crate::types::Attachment>,
    activation: Option<&PreparedSkillActivation>,
    is_reset: bool,
) -> StagedTurn {
    let has_message = !message.trim().is_empty() || !attachments.is_empty();
    let reset_only = is_reset && !has_message;

    let mut snapshot = committed.to_vec();
    if !reset_only && snapshot.is_empty() {
        snapshot.push(ChatMessage::system(system_prompt));
    }

    let mut skill_seed = committed_skill;
    let mut announce = Vec::new();
    let mut user_text = None;
    let mut commit_reset = false;

    if let Some(prepared) = activation {
        let shown = if !message.trim().is_empty() {
            message.to_string()
        } else {
            format!("/{}", prepared.active.name)
        };
        snapshot.push(ChatMessage::user_with_attachments(&shown, attachments));
        snapshot.push(prepared.message.clone());
        skill_seed = Some(prepared.active.clone());
        announce.push(AgentEvent::SkillActivated {
            name: prepared.active.name.clone(),
            allowed_tools: prepared.active.allowed_tools.clone(),
        });
        user_text = Some(shown);
    } else if is_reset {
        skill_seed = None;
        commit_reset = true;
        announce.push(AgentEvent::SkillDeactivated);
        if has_message {
            snapshot.push(ChatMessage::user_with_attachments(message, attachments));
            user_text = Some(message.to_string());
        }
    } else {
        snapshot.push(ChatMessage::user_with_attachments(message, attachments));
        user_text = Some(message.to_string());
    }

    StagedTurn {
        snapshot,
        skill_seed,
        announce,
        user_text,
        commit_reset,
    }
}

/// The skill steering the conversation as of the END of `messages`, replayed
/// from the activation traces the history itself carries: a [`Role::Skill`]
/// context message (explicit user activation) or a `read_skill` tool call
/// (model-originated; a `reset`/`none` name clears). History rewind uses this
/// to recompute the active skill of the truncated context — the persisted
/// `active_skill` column describes the PRE-rewind state and cannot be reused.
///
/// One documented approximation: an explicit user reset (`/reset`) leaves no
/// trace in the message history, so rewinding past one can resurrect the
/// skill it had cleared. The state is visible in the UI and another reset
/// undoes it.
pub fn replay_skill_marker(messages: &[ChatMessage]) -> Option<String> {
    let mut current: Option<String> = None;
    for m in messages {
        if let Some(name) = m.skill_name() {
            current = Some(name.to_string());
            continue;
        }
        let Some(tool_calls) = &m.tool_calls else {
            continue;
        };
        for tc in tool_calls {
            if tc.function.name != "read_skill" {
                continue;
            }
            let name = serde_json::from_str::<serde_json::Value>(&tc.function.arguments)
                .ok()
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string));
            if let Some(name) = name {
                current = if crate::skill::is_reset_skill_name(&name) {
                    None
                } else {
                    Some(name)
                };
            }
        }
    }
    current
}

/// A commit produced at a sync point of the loop's event stream.
#[derive(Debug, Clone)]
pub struct TurnCommit {
    /// The full canonical context to replace committed messages with.
    pub messages: Vec<ChatMessage>,
    /// Skill state riding this commit: `None` = unchanged since the last
    /// commit, `Some(state)` = replace the committed skill with `state`.
    pub skill: Option<Option<ActiveSkill>>,
}

/// Tracks in-turn skill changes and turns loop events into commits.
///
/// Skill activation/deactivation events are held as *pending* and land
/// together with the next context sync, so skill state and the messages that
/// evidence it commit atomically.
#[derive(Debug, Default)]
pub struct TurnLedger {
    pending_skill: Option<Option<ActiveSkill>>,
}

impl TurnLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one loop event; returns a commit to apply, if this event is a
    /// sync point.
    pub fn observe(&mut self, event: &AgentEvent) -> Option<TurnCommit> {
        match event {
            AgentEvent::SkillActivated {
                name,
                allowed_tools,
            } => {
                self.pending_skill = Some(Some(ActiveSkill {
                    name: name.clone(),
                    allowed_tools: allowed_tools.clone(),
                }));
                None
            }
            AgentEvent::SkillDeactivated => {
                self.pending_skill = Some(None);
                None
            }
            AgentEvent::SessionSync {
                full_context,
                commit_skill,
                ..
            } => Some(TurnCommit {
                messages: full_context.clone(),
                // Error-path syncs (`commit_skill: false`) persist messages but
                // leave a staged skill activation uncommitted: the skill only
                // sticks if the turn ran to a successful sync.
                skill: if *commit_skill {
                    self.pending_skill.take()
                } else {
                    None
                },
            }),
            _ => None,
        }
    }
}
