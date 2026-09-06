//! The multi-turn tool-calling engine.
//!
//! Tool dispatch goes through a [`ToolRegistry`]; risk / interactivity come
//! from each [`Tool`] impl.
//! Everything else — `ask_user`, dangerous-op confirmation, per-call
//! consecutive-failure circuit breaking (keyed by tool name + arguments, so a
//! catch-all tool like `run_shell` is not blocked wholesale when unrelated
//! commands fail), context compaction, inline seeding, dynamic tool
//! injection — is preserved.

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use crate::client::LlmClient;
use crate::context::{
    compact_context, compaction_tail_budget, compaction_tail_start, compaction_threshold,
    compress_tool_result, context_chars, fresh_context_state, latest_task_state, prune_target,
    pruning_threshold, recall_index, recall_tool_result, should_compact, task_state_block,
    task_state_verdict, RecallOutcome, SharedContextState, SummaryScope, TaskStateVerdict,
    SUMMARY_MARKER, TASK_STATE_AIM_CHARS, TASK_STATE_MAX_CHARS, TASK_STATE_TARGET_CHARS,
};
use crate::event::{
    build_ask_user_payload, AgentEvent, AskAnswer, AskQuestion, AskUserResponse, ConfirmResponse,
};
pub use crate::skill::ActiveSkill;
use crate::skill::{resolve_active_skill, SkillRegistry};
use crate::tool::{is_tool_blocked, ToolContext, ToolRegistry};
use crate::types::*;

/// Upper bound on LLM rounds (assistant turns) within a single
/// `process_message`. `-1` = unlimited: the turn then ends only when the model
/// returns a reply without tool_calls, or the user cancels. Any value >= 0 is a
/// hard cap; hitting it emits `AgentEvent::Error` and closes the turn.
pub const MAX_AGENT_LOOPS: isize = -1;
/// Upper bound on tool_calls accepted from a single assistant turn. A model may
/// legitimately fan out many parallel edits, so this is generous; going over it
/// does not abort the turn — every call gets a synthetic "skipped" result and
/// the loop continues so the model can re-issue in smaller batches (see the
/// over-limit branch in `process_message`).
pub const MAX_TOOL_CALLS_PER_TURN: usize = 32;

/// The agent engine. One `AgentLoop` drives one conversation turn (and its
/// nested tool calls) per `process_message`.
pub struct AgentLoop {
    pub llm: LlmClient,
    /// Tool source. Shared (`Arc`) so skill hot-loading / native registration
    /// performed elsewhere is reflected here on the next turn.
    pub registry: Arc<ToolRegistry>,
    /// Runtime-injected tool definitions (e.g. from a search tool). They must
    /// also resolve in `registry` to actually execute.
    extra_tools: Vec<ToolDefinition>,
    /// Optional blocklist applied to dynamic injection.
    blocklist: Vec<String>,
    /// Configured context size in tokens (0 = auto-detect from model name).
    pub configured_context_tokens: usize,
    pub max_loops: isize,
    pub max_tools_per_turn: usize,
    /// When true, the `ask_user` UX primitive is advertised + intercepted.
    pub include_ask_user: bool,
    /// Trust-all ("auto gear"): when true, every `Dangerous` op runs without
    /// confirmation. Set from `AGENT_TRUST_ALL` at process start only.
    pub trust_all: bool,
    /// Session-scoped full-auto flag, shared with the session that owns this
    /// turn (`Arc`): a `ConfirmResponse::ApproveAll` flips it on, the UI can
    /// flip it off mid-turn, and `needs_confirm` reads it live so both take
    /// effect on the very next tool call. Unlike `trust_all` it never outlives
    /// the session. `ask_user` is unaffected either way.
    auto_confirm: Arc<AtomicBool>,
    /// Skill registry, so a `read_skill` call can resolve the skill's enforced
    /// `allowed-tools` list. `None` disables skill-based tool isolation.
    skills: Option<Arc<SkillRegistry>>,
    /// The skill steering the current conversation (last `read_skill`). Seeded
    /// from the session (cross-turn) and updated in-turn when the model switches.
    active_skill: Option<ActiveSkill>,
    /// Id of the session this loop drives, surfaced to tools via
    /// [`ToolContext`] (session-aware tools need to know their own session).
    session_id: Option<String>,
    /// Seconds an `ask_user` waits for a human in an unattended session
    /// (trust-all or session FULL-AUTO) before auto-picking each question's
    /// default. `0` = wait forever. Attended sessions always wait.
    ask_user_timeout_secs: u64,
    /// Sub-agent execution (`task` tool). `Some` = the tool is advertised and
    /// `task` calls fan out to child loops; `None` = no sub-agents (a child
    /// loop is always `None` — the depth cap).
    task_runner: Option<Arc<crate::agent_task::TaskRunner>>,
    /// Mid-turn user steering ("send now"): messages arriving here are
    /// appended to the context at the next round boundary — the model sees
    /// them on its next request instead of after the turn. `None` = steering
    /// not offered (one-shot CLI, children).
    steer_rx: Option<mpsc::UnboundedReceiver<String>>,
    /// Session store, used ONLY to archive the raw context before a Level-2
    /// compaction rewrites it (the summary replaces the live history; the
    /// archive keeps the original reachable). `None` = no archiving.
    store: Option<Arc<crate::web::store::SqliteStore>>,
    /// Level-1 cut point + the provider's last prompt-token count, shared
    /// with the session so they survive turn boundaries (see
    /// [`SessionContextState`](crate::context::SessionContextState)). A
    /// fresh, unshared one when no session provided its own.
    context_state: SharedContextState,
}

impl AgentLoop {
    pub fn new(llm: LlmClient, registry: Arc<ToolRegistry>) -> Self {
        Self {
            llm,
            registry,
            extra_tools: Vec::new(),
            blocklist: Vec::new(),
            configured_context_tokens: 0,
            max_loops: MAX_AGENT_LOOPS,
            max_tools_per_turn: MAX_TOOL_CALLS_PER_TURN,
            include_ask_user: true,
            trust_all: false,
            auto_confirm: Arc::new(AtomicBool::new(false)),
            skills: None,
            active_skill: None,
            session_id: None,
            ask_user_timeout_secs: crate::config::default_ask_user_timeout_secs(),
            task_runner: None,
            steer_rx: None,
            store: None,
            context_state: fresh_context_state(),
        }
    }

    /// Share the session's context memory (Level-1 cut point, last measured
    /// prompt size) with this turn's loop.
    pub fn with_context_state(mut self, state: SharedContextState) -> Self {
        self.context_state = state;
        self
    }

    pub fn with_context_tokens(mut self, tokens: usize) -> Self {
        self.configured_context_tokens = tokens;
        self
    }

    pub fn with_blocklist(mut self, blocklist: Vec<String>) -> Self {
        self.blocklist = blocklist;
        self
    }

    pub fn with_ask_user(mut self, enabled: bool) -> Self {
        self.include_ask_user = enabled;
        self
    }

    /// Enable trust-all: skip all dangerous-op confirmation.
    pub fn with_trust_all(mut self, trust_all: bool) -> Self {
        self.trust_all = trust_all;
        self
    }

    /// Share the session's auto-confirm flag with this loop. Passing the
    /// session's own `Arc` (not a copy of its value) is what makes the mode
    /// span turns AND react immediately to a mid-turn on/off toggle.
    pub fn with_auto_confirm(mut self, flag: Arc<AtomicBool>) -> Self {
        self.auto_confirm = flag;
        self
    }

    /// Inject the skill registry so `read_skill` can resolve each skill's
    /// enforced `allowed-tools` list (enables skill-based tool isolation).
    pub fn with_skill_registry(mut self, skills: Arc<SkillRegistry>) -> Self {
        self.skills = Some(skills);
        self
    }

    /// Seed the active skill (e.g. restored from the session) so tool isolation
    /// carries across turns until the model reads another skill.
    pub fn with_active_skill(mut self, active: Option<ActiveSkill>) -> Self {
        self.active_skill = active;
        self
    }

    /// Bind the loop to its session so tools can see which conversation they
    /// run in (via [`ToolContext::session_id`]).
    pub fn with_session_id(mut self, session_id: Option<String>) -> Self {
        self.session_id = session_id;
        self
    }

    /// Configure the unattended `ask_user` timeout (see
    /// [`crate::config::AgentConfig::ask_user_timeout_secs`]). `0` disables it.
    pub fn with_ask_user_timeout(mut self, secs: u64) -> Self {
        self.ask_user_timeout_secs = secs;
        self
    }

    /// Enable the `task` sub-agent tool, executing calls through `runner`.
    pub fn with_task_runner(mut self, runner: Option<Arc<crate::agent_task::TaskRunner>>) -> Self {
        self.task_runner = runner;
        self
    }

    /// Attach the mid-turn steering channel (the "send now" path).
    pub fn with_steer(mut self, rx: Option<mpsc::UnboundedReceiver<String>>) -> Self {
        self.steer_rx = rx;
        self
    }

    /// Attach the session store for pre-compaction archiving.
    pub fn with_store(mut self, store: Option<Arc<crate::web::store::SqliteStore>>) -> Self {
        self.store = store;
        self
    }

    /// Drain pending steered messages into the context (round boundary).
    /// Each becomes a regular user message; `UserInjected` tells UIs to
    /// append the bubble in place. Returns how many were injected.
    fn drain_steers(
        &mut self,
        messages: &mut Vec<ChatMessage>,
        new_messages: &mut Vec<ChatMessage>,
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> usize {
        let Some(rx) = self.steer_rx.as_mut() else {
            return 0;
        };
        let mut injected = 0;
        while let Ok(text) = rx.try_recv() {
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            let msg = ChatMessage::user(&text);
            messages.push(msg.clone());
            new_messages.push(msg);
            let _ = event_tx.send(AgentEvent::UserInjected { text });
            injected += 1;
        }
        injected
    }

    /// Hand back steered messages the turn never got to inject, so they are
    /// not silently swallowed: each is reported as [`AgentEvent::SteerRequeued`]
    /// and the driver (web pump / TUI) puts it at the FRONT of the queue,
    /// where it runs first in the next turn — the order the user typed it in.
    ///
    /// Used on the failure exit only. A cancelled turn deliberately drops
    /// them: cancel means "stop everything", queue included.
    fn requeue_pending_steers(&mut self, event_tx: &mpsc::UnboundedSender<AgentEvent>) {
        let Some(rx) = self.steer_rx.as_mut() else {
            return;
        };
        while let Ok(text) = rx.try_recv() {
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            let _ = event_tx.send(AgentEvent::SteerRequeued { text });
        }
    }

    /// The `ask_user` auto-pick deadline for the CURRENT approval state, read
    /// live per call: `Some(secs)` only when the session is unattended
    /// (trust-all or FULL-AUTO) and a timeout is configured — flipping
    /// FULL-AUTO mid-turn changes what the very next `ask_user` does.
    fn ask_user_timeout(&self) -> Option<u64> {
        let unattended = self.trust_all || self.auto_confirm.load(Ordering::Relaxed);
        (unattended && self.ask_user_timeout_secs > 0).then_some(self.ask_user_timeout_secs)
    }

    /// Whether `name` is in the active skill's `allowed-tools` (its pre-approved
    /// set). `read_skill` (to switch/leave a skill) and `ask_user` always count
    /// as in-list. No active skill, or an empty allow-list, means everything is
    /// in-list.
    ///
    /// Being out-of-list is NOT a hard block: it escalates the call instead
    /// (see [`AgentLoop::needs_confirm`]) — safe tools still run, riskier ones
    /// require user confirmation.
    fn tool_in_skill_allowlist(&self, name: &str) -> bool {
        match &self.active_skill {
            Some(sk) if !sk.allowed_tools.is_empty() => {
                name == "read_skill"
                    || name == "ask_user"
                    || sk.allowed_tools.iter().any(|a| a == name)
            }
            _ => true,
        }
    }

    /// Confirmation policy for one tool call.
    ///
    /// - `Dangerous` always confirms (allow-list membership declares intent,
    ///   not safety).
    /// - A call outside the active skill's `allowed-tools` additionally
    ///   confirms anything above `Safe` — the allow-list acts as an escalation
    ///   gate, not an exclusive whitelist: undeclared read-only/safe tools run
    ///   freely, undeclared risky ones need the user's nod.
    /// - `trust_all` (explicit operator opt-in, e.g. headless/scheduled runs)
    ///   skips all confirmation, consistent with the pre-existing gate.
    /// - `auto_confirm` (session-scoped full-auto, user opt-in from the
    ///   confirm UI) is read live so toggling it mid-turn applies to the very
    ///   next tool call.
    fn needs_confirm(&self, name: &str, risk: RiskLevel) -> bool {
        if self.trust_all || self.auto_confirm.load(Ordering::Relaxed) {
            return false;
        }
        risk == RiskLevel::Dangerous
            || (!self.tool_in_skill_allowlist(name) && risk > RiskLevel::Safe)
    }

    /// Dynamically inject extra tool definitions (honoring the blocklist).
    pub fn inject_tools(&mut self, new_tools: Vec<ToolDefinition>) {
        for td in new_tools {
            if is_tool_blocked(&td.function.name, &self.blocklist) {
                continue;
            }
            if !self
                .extra_tools
                .iter()
                .any(|t| t.function.name == td.function.name)
            {
                self.extra_tools.push(td);
            }
        }
    }

    /// Compute the tool list advertised to the LLM this turn: registry tools +
    /// injected tools (+ ask_user if enabled).
    ///
    /// This set is intentionally **constant** across turns regardless of the
    /// active skill: tools render at the very top of the prompt-cache prefix
    /// (`tools → system → messages`), so filtering them per skill would bust the
    /// entire cache on every skill switch. Skill-based tool isolation is instead
    /// applied at dispatch time as an escalation gate (see
    /// [`AgentLoop::needs_confirm`]), with the active skill's `allowed-tools`
    /// surfaced to the model via the `read_skill` result (which lives in the
    /// messages stream, not the cached prefix).
    fn active_tools(&self) -> Vec<ToolDefinition> {
        let mut tools = self.registry.definitions();
        for t in &self.extra_tools {
            if !tools.iter().any(|d| d.function.name == t.function.name) {
                tools.push(t.clone());
            }
        }
        if self.include_ask_user && !tools.iter().any(|d| d.function.name == "ask_user") {
            tools.push(ask_user_definition());
        }
        // Always advertised (same cache-stability rule as everything above):
        // the placeholders it resolves may appear in ANY session once the
        // context outgrows the pruning threshold.
        if !tools.iter().any(|d| d.function.name == "recall_result") {
            tools.push(recall_result_definition());
        }
        if !tools.iter().any(|d| d.function.name == "update_task_state") {
            tools.push(update_task_state_definition());
        }
        if self.task_runner.is_some() && !tools.iter().any(|d| d.function.name == "task") {
            tools.push(crate::agent_task::task_definition());
        }
        tools
    }

    /// Process a user message through the loop, yielding events via `event_tx`.
    ///
    /// - `confirm_rx` receives approval/denial for dangerous tool calls.
    /// - `ask_user_rx` receives answers for `ask_user`; `None` => headless,
    ///   auto-pick each question's `default_id` (or first option).
    /// - `cancel_flag` allows external cancellation.
    pub async fn process_message(
        &mut self,
        messages: &mut Vec<ChatMessage>,
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
        confirm_rx: &mut mpsc::UnboundedReceiver<ConfirmResponse>,
        ask_user_rx: Option<&mut mpsc::UnboundedReceiver<AskUserResponse>>,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let mut ask_user_rx = ask_user_rx;
        let start = wasmtimer::std::Instant::now();
        let mut tool_fail_count: HashMap<String, u8> = HashMap::new();
        let mut pending_task_ids: Vec<String> = Vec::new();
        let mut new_messages: Vec<ChatMessage> = Vec::new();
        let mut pending_inline_seeds: Vec<String> = Vec::new();

        for loop_idx in 0usize.. {
            if self.max_loops >= 0 && loop_idx >= self.max_loops as usize {
                break;
            }
            if cancel_flag.load(Ordering::Relaxed) {
                log::info!("agent loop #{}: cancelled", loop_idx);
                self.emit_done(event_tx, &new_messages, messages, start);
                return Ok(());
            }

            // Steered ("send now") user messages land at round boundaries, so
            // the model sees them on this very request instead of next turn.
            self.drain_steers(messages, &mut new_messages, event_tx);

            // `Some` = pruned request view (old tool results replaced by
            // placeholders on the wire only); the canonical `messages` keep
            // full content for persistence, display, and archiving.
            let mut request_view = self.maybe_compact_context(messages, event_tx).await;

            let active = self.active_tools();
            let tool_defs = if active.is_empty() {
                None
            } else {
                Some(active.as_slice())
            };

            let content_seed = if pending_inline_seeds.is_empty() {
                None
            } else {
                let joined = pending_inline_seeds.join("\n\n");
                pending_inline_seeds.clear();
                Some(joined)
            };

            // What this request weighs on the estimator's scale; paired with
            // the provider's `prompt_tokens` below to calibrate the estimator.
            let mut sent_chars = crate::context::request_chars(
                request_view.as_deref().unwrap_or(messages),
                tool_defs,
            );

            let mut assistant_result = self
                .llm
                .chat_stream_outcome(
                    request_view.as_deref().unwrap_or(messages),
                    tool_defs,
                    event_tx,
                    Some(cancel_flag.clone()),
                    content_seed.clone(),
                )
                .await;

            // One-shot automatic retry for a reasoning-only response (the
            // model thought but produced neither content nor tool calls —
            // discarded by the stream layer, so the history is unchanged and
            // the request can simply be replayed). Observed to succeed on
            // retry in the wild. When the failure was a token-cap truncation
            // (finish_reason=length: reasoning ate the whole budget), the
            // retry runs one effort level lower — for THIS request only, the
            // configured effort is untouched.
            if let Err(error) = &assistant_result {
                let error_text = error.to_string();
                if !cancel_flag.load(Ordering::Relaxed)
                    && crate::client::error_is_reasoning_only(&error_text)
                {
                    let reduced = if crate::client::error_is_length_truncated(&error_text) {
                        self.llm.with_reduced_effort()
                    } else {
                        None
                    };
                    log::warn!(
                        "agent loop #{}: reasoning-only response; retrying once{}: {}",
                        loop_idx,
                        if reduced.is_some() {
                            " with reduced reasoning effort"
                        } else {
                            ""
                        },
                        error_text
                    );
                    assistant_result = reduced
                        .as_ref()
                        .unwrap_or(&self.llm)
                        .chat_stream_outcome(
                            request_view.as_deref().unwrap_or(messages),
                            tool_defs,
                            event_tx,
                            Some(cancel_flag.clone()),
                            content_seed.clone(),
                        )
                        .await;
                }
            }

            // The provider said the prompt does not fit its context window.
            // Its tokenizer is the ground truth, whatever the estimate said:
            // compact the history (forced) and replay once. The history is
            // unchanged by the failed round and nothing reached the UI, so
            // the replay is invisible except for the "Compacting…" status.
            if let Err(error) = &assistant_result {
                let overflow = !cancel_flag.load(Ordering::Relaxed)
                    && crate::client::error_is_context_overflow(&error.to_string());
                if overflow {
                    log::warn!(
                        "agent loop #{}: provider reports context overflow; compacting and \
                         replaying once: {}",
                        loop_idx,
                        error
                    );
                    // Replay only over a request that differs from the one
                    // refused: a rewritten history always does; a view only
                    // when it elides something (a forced cut over a history
                    // with nothing to elide is the same bytes again — sending
                    // them would just buy a second 400).
                    let replay = match self
                        .maybe_compact_context_inner(messages, event_tx, true)
                        .await
                    {
                        ContextPrep::Compacted => Some(None),
                        ContextPrep::View(view) => {
                            (crate::context::request_chars(&view, tool_defs) < sent_chars)
                                .then_some(Some(view))
                        }
                        ContextPrep::Canonical => None,
                    };
                    if let Some(forced_view) = replay {
                        // vinx: the replay IS this round's request now — the
                        // recall lookup and the estimator calibration below
                        // must see what actually went out, not the first try.
                        request_view = forced_view;
                        sent_chars = crate::context::request_chars(
                            request_view.as_deref().unwrap_or(messages),
                            tool_defs,
                        );
                        assistant_result = self
                            .llm
                            .chat_stream_outcome(
                                request_view.as_deref().unwrap_or(messages),
                                tool_defs,
                                event_tx,
                                Some(cancel_flag.clone()),
                                content_seed.clone(),
                            )
                            .await;
                    }
                }
            }

            let outcome = match assistant_result {
                Ok(outcome) => outcome,
                Err(_) if cancel_flag.load(Ordering::Relaxed) => {
                    log::info!("agent loop #{}: cancelled during LLM stream", loop_idx);
                    self.emit_done(event_tx, &new_messages, messages, start);
                    return Ok(());
                }
                Err(error) => {
                    // Persist the user message + any completed rounds before the
                    // error bubbles up, so a mid-turn failure (429, disconnect)
                    // isn't lost on refresh.
                    self.emit_sync(event_tx, &new_messages, messages);
                    return Err(error);
                }
            };
            // `length` here means the response was cut by the completion-token
            // cap — any tool call in it is suspect (see the malformed-args
            // branch below).
            let turn_finish_reason = outcome.finish_reason;
            let assistant_msg = outcome.message;
            if let Some(usage) = outcome.usage {
                // The provider's own count of this request's prompt: the
                // authoritative context size for the next round's pruning /
                // compaction decision (see `maybe_compact_context`).
                self.context_state
                    .lock()
                    .unwrap()
                    .observe(sent_chars, usage.prompt_tokens);
                // One record per LLM round; sinks aggregate per turn/session.
                let _ = event_tx.send(AgentEvent::Usage {
                    model: self.llm.model().to_string(),
                    usage,
                });
            }

            if cancel_flag.load(Ordering::Relaxed) {
                log::info!("agent loop #{}: cancelled after LLM stream", loop_idx);
                self.emit_done(event_tx, &new_messages, messages, start);
                return Ok(());
            }
            if !assistant_msg.has_assistant_payload() {
                self.emit_sync(event_tx, &new_messages, messages);
                return Err(
                    "LLM returned an invalid assistant message without content or tool calls"
                        .into(),
                );
            }

            let has_tool_calls = assistant_msg
                .tool_calls
                .as_ref()
                .is_some_and(|tool_calls| !tool_calls.is_empty());
            messages.push(assistant_msg.clone());
            new_messages.push(assistant_msg.clone());
            // Where this assistant message sits in both vectors — the
            // malformed-args branch below patches its broken call arguments
            // in place (tool results pushed meanwhile shift the tail, not
            // these indices).
            let assistant_idx = messages.len() - 1;
            let assistant_new_idx = new_messages.len() - 1;

            if !has_tool_calls {
                // A steer that raced the final answer must not be dropped on
                // the floor: inject it and keep looping — the model answers
                // it right here in the same turn.
                if self.drain_steers(messages, &mut new_messages, event_tx) > 0 {
                    self.emit_sync(event_tx, &new_messages, messages);
                    continue;
                }
                log::info!(
                    "agent loop #{}: done (no tool_calls), elapsed={}ms",
                    loop_idx,
                    start.elapsed().as_millis()
                );
                self.emit_done(event_tx, &new_messages, messages, start);
                return Ok(());
            }

            let tool_calls = assistant_msg.tool_calls.unwrap();
            log::info!(
                "agent loop #{}: tool_calls={} names=[{}]",
                loop_idx,
                tool_calls.len(),
                tool_calls
                    .iter()
                    .map(|tc| tc.function.name.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            );
            // Over-limit is handled softly instead of aborting the turn: the
            // assistant message (already pushed above) carries every tool_call,
            // so we MUST answer each one or the next request would send an
            // assistant with unmatched tool_call_ids (OpenAI 400). We write a
            // synthetic "skipped" result per call and `continue` the loop so the
            // model can re-issue in smaller batches — the conversation keeps
            // going rather than dead-ending on an error.
            if tool_calls.len() > self.max_tools_per_turn {
                log::warn!(
                    "agent loop #{}: too many tool calls ({}/{}) — skipping batch, \
                     answering each with a synthetic result",
                    loop_idx,
                    tool_calls.len(),
                    self.max_tools_per_turn
                );
                let skip_msg = format!(
                    "[NO_RETRY] Skipped: {} tool calls were requested in one turn, over the \
                     limit of {}. None were executed. Re-issue them in smaller batches of at \
                     most {} tool calls per turn.",
                    tool_calls.len(),
                    self.max_tools_per_turn,
                    self.max_tools_per_turn
                );
                for tc in &tool_calls {
                    let tool_msg = ChatMessage::tool_result(&tc.id, &skip_msg);
                    messages.push(tool_msg.clone());
                    new_messages.push(tool_msg);
                    let _ = event_tx.send(AgentEvent::ToolCallResult {
                        id: tc.id.clone(),
                        result: skip_msg.clone(),
                        success: false,
                    });
                }
                continue;
            }

            // ── `task` sub-agents: every task call in this assistant message
            // fans out CONCURRENTLY (bounded by the runner), before the
            // sequential pass below handles the rest. Each call gets a result
            // whatever happens (allSettled), so tool_call ids stay paired.
            // Without a runner (headless embedders, child loops) `task` is not
            // advertised and any stray call falls through to the unknown-tool
            // reply in the sequential pass. ──
            let answered_tasks: std::collections::HashSet<String> =
                if let Some(runner) = self.task_runner.clone() {
                    let task_calls: Vec<crate::agent_task::TaskCall> = tool_calls
                        .iter()
                        .filter(|tc| tc.function.name == "task")
                        .map(|tc| crate::agent_task::TaskCall {
                            call_id: tc.id.clone(),
                            args: serde_json::from_str(tc.function.arguments.trim())
                                .unwrap_or(serde_json::Value::Null),
                        })
                        .collect();
                    if task_calls.is_empty() {
                        Default::default()
                    } else {
                        log::info!(
                            "agent loop #{}: fanning out {} task call(s)",
                            loop_idx,
                            task_calls.len()
                        );
                        let results = runner
                            .run_batch(task_calls, event_tx, cancel_flag.clone())
                            .await;
                        let mut answered = std::collections::HashSet::new();
                        for (call_id, result_json, _success) in results {
                            // The `ToolCallResult` event already went out from
                            // `run_batch` the moment each child ended; here the
                            // paired tool message enters history, in call order.
                            // vinx: `tool_result` — no `is_error` status on the
                            // wire here (upstream's `tool_result_with_status`
                            // feeds its Sand sink).
                            let tool_msg = ChatMessage::tool_result(&call_id, &result_json);
                            messages.push(tool_msg.clone());
                            new_messages.push(tool_msg);
                            answered.insert(call_id);
                        }
                        answered
                    }
                } else {
                    Default::default()
                };

            for (tc_idx, tc) in tool_calls.iter().enumerate() {
                // Already answered by the task fan-out above.
                if answered_tasks.contains(&tc.id) {
                    continue;
                }
                if cancel_flag.load(Ordering::Relaxed) {
                    // Answer every not-yet-processed call (this one and the rest)
                    // with a synthetic result before ending the turn, so the
                    // persisted assistant message never has an unmatched
                    // tool_call_id — the next turn's request stays valid.
                    for rem in tool_calls[tc_idx..]
                        .iter()
                        .filter(|rem| !answered_tasks.contains(&rem.id))
                    {
                        let tool_msg = ChatMessage::tool_result(&rem.id, "Cancelled by user");
                        messages.push(tool_msg.clone());
                        new_messages.push(tool_msg);
                        let _ = event_tx.send(AgentEvent::ToolCallResult {
                            id: rem.id.clone(),
                            result: "Cancelled by user".to_string(),
                            success: false,
                        });
                    }
                    self.emit_done(event_tx, &new_messages, messages, start);
                    return Ok(());
                }

                // Defence in depth behind the stream guard in `client.rs`: a
                // nameless call can only come from a damaged provider stream.
                // Answer it rather than looking up the empty name — every call
                // must carry a result or the next request goes out unpaired.
                if tc.function.name.trim().is_empty() {
                    let msg = "[NO_RETRY] Received a tool call with no name — nothing was \
                               executed. Re-issue the call naming one of the available tools."
                        .to_string();
                    log::warn!(
                        "agent loop: answered nameless tool call: id={:?} args_len={}",
                        tc.id,
                        tc.function.arguments.len()
                    );
                    let tool_msg = ChatMessage::tool_result(&tc.id, &msg);
                    messages.push(tool_msg.clone());
                    new_messages.push(tool_msg);
                    let _ = event_tx.send(AgentEvent::ToolCallResult {
                        id: tc.id.clone(),
                        result: msg,
                        success: false,
                    });
                    continue;
                }

                // Throttle status polls while background tasks are pending.
                if !pending_task_ids.is_empty() && tc.function.name.ends_with("_status") {
                    let throttle_msg = format!(
                        "[system] background task(s) running (task_ids: {}); results will be \
                         pushed automatically. Ask the user to wait; do not poll status.",
                        pending_task_ids.join(", ")
                    );
                    let tool_msg = ChatMessage::tool_result(&tc.id, &throttle_msg);
                    messages.push(tool_msg.clone());
                    new_messages.push(tool_msg);
                    let _ = event_tx.send(AgentEvent::ToolCallResult {
                        id: tc.id.clone(),
                        result: throttle_msg,
                        // Informational redirect, not a failure.
                        success: true,
                    });
                    continue;
                }

                // ── ask_user: intercepted before risk-check / execute. ──
                if self.include_ask_user && tc.function.name == "ask_user" {
                    let result_json = handle_ask_user(
                        &tc.id,
                        &tc.function.arguments,
                        event_tx,
                        ask_user_rx.as_deref_mut(),
                        self.ask_user_timeout(),
                    )
                    .await;
                    let tool_msg = ChatMessage::tool_result(&tc.id, &result_json);
                    messages.push(tool_msg.clone());
                    new_messages.push(tool_msg);
                    let _ = event_tx.send(AgentEvent::ToolCallResult {
                        id: tc.id.clone(),
                        result: result_json,
                        // The ask mechanism itself worked (a cancel is an answer).
                        success: true,
                    });
                    continue;
                }

                // Incomplete JSON means the response was cut mid-arguments (an
                // output-token ceiling on a large payload is the usual cause).
                // Degrading that to `Null` used to run the tool with no
                // arguments at all — e.g. a truncated theme edit landing as a
                // theme reset. Refuse instead, and say why, so the model can
                // re-issue. Absent arguments stay valid for tools that take none.
                let raw_args = tc.function.arguments.trim();
                let args_val: serde_json::Value = if raw_args.is_empty() {
                    serde_json::Value::Null
                } else {
                    match serde_json::from_str(raw_args) {
                        Ok(parsed) => parsed,
                        Err(err) => {
                            // `finish_reason=length` upgrades the guess to a
                            // certainty: the stream was cut by the output
                            // token cap mid-arguments.
                            let cap_truncated = turn_finish_reason.as_deref() == Some("length");
                            let split_hint = if tc.function.name == "write_file" {
                                "write the file in parts instead: one write_file call with \
                                 mode='overwrite' for the first chunk, then mode='append' \
                                 calls for the rest (keep each call well under 20KB)"
                            } else {
                                "re-issue the call with complete arguments, splitting \
                                 oversized ones"
                            };
                            let msg = if cap_truncated {
                                format!(
                                    "[NO_RETRY] Arguments for '{}' are not valid JSON ({err}) — \
                                     nothing was executed. The response hit its output token \
                                     cap (finish_reason=length), so the payload IS truncated; \
                                     {split_hint}.",
                                    tc.function.name
                                )
                            } else {
                                format!(
                                    "[NO_RETRY] Arguments for '{}' are not valid JSON ({err}) — \
                                     nothing was executed. The payload looks truncated; \
                                     {split_hint}.",
                                    tc.function.name
                                )
                            };
                            log::warn!(
                                "agent loop: rejected tool call with malformed arguments: \
                                 name={} args_len={} finish_reason={} err={}",
                                tc.function.name,
                                tc.function.arguments.len(),
                                turn_finish_reason.as_deref().unwrap_or("-"),
                                err
                            );
                            // Swap the broken arguments for a short stub in the
                            // persisted history (id/name stay, so the call/result
                            // pairing holds). Kimi K3 replays complete assistant
                            // messages on every request — tens of KB of dead
                            // broken JSON would otherwise ride the rest of the
                            // session.
                            let stub = malformed_args_stub(tc.function.arguments.len());
                            stub_malformed_call_args(&mut messages[assistant_idx], &tc.id, &stub);
                            stub_malformed_call_args(
                                &mut new_messages[assistant_new_idx],
                                &tc.id,
                                &stub,
                            );
                            let tool_msg = ChatMessage::tool_result(&tc.id, &msg);
                            messages.push(tool_msg.clone());
                            new_messages.push(tool_msg);
                            let _ = event_tx.send(AgentEvent::ToolCallResult {
                                id: tc.id.clone(),
                                result: msg,
                                success: false,
                            });
                            continue;
                        }
                    }
                };

                // ── update_task_state: the task registers. The call itself
                // (riding the assistant message) is the storage — persisted
                // with the history, replayed by `latest_task_state` — so the
                // interception only validates and acknowledges. Intercepted
                // calls still go through the consecutive-failure breaker: a
                // model stuck re-sending the same rejected state is the same
                // loop the breaker exists for. ──
                if tc.function.name == "update_task_state" {
                    let fail_key = tool_fail_key(&tc.function.name, &args_val);
                    let call_desc = call_preview(&args_val);
                    let prev_fails = *tool_fail_count.get(&fail_key).unwrap_or(&0);
                    if prev_fails >= 3 {
                        let blocked_msg = format!(
                            "[BLOCKED] This exact '{}' call has failed {} consecutive \
                             times: {}. Do NOT repeat it — try a different \
                             command/arguments, or ask the user for help.",
                            tc.function.name, prev_fails, call_desc
                        );
                        let tool_msg = ChatMessage::tool_result(&tc.id, &blocked_msg);
                        messages.push(tool_msg.clone());
                        new_messages.push(tool_msg);
                        let _ = event_tx.send(AgentEvent::ToolCallResult {
                            id: tc.id.clone(),
                            result: blocked_msg,
                            success: false,
                        });
                        continue;
                    }
                    let state = args_val
                        .get("state")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .unwrap_or("");
                    // One verdict, shared with the replay and the view stub —
                    // whatever is accepted here is exactly what
                    // `latest_task_state` will return.
                    let (result, success) = match task_state_verdict(state) {
                        TaskStateVerdict::Empty => (
                            "[NO_RETRY] update_task_state requires a non-empty `state` \
                             string. Nothing was recorded; the register is unchanged."
                                .to_string(),
                            false,
                        ),
                        TaskStateVerdict::OverCap(n) => (
                            format!(
                                "[NO_RETRY] Task state is {n} chars — the hard cap is {}. \
                                 Nothing was recorded; the register is unchanged. Re-send a \
                                 trimmed state (about {} chars: goal, current deltas, key \
                                 call_ids — no narration).",
                                TASK_STATE_MAX_CHARS, TASK_STATE_AIM_CHARS
                            ),
                            false,
                        ),
                        // Recorded — refusing would drop the freshest state at
                        // the moment the model is busiest and compaction
                        // nearest. The nudge is for NEXT time: saying so
                        // explicitly is what saves the round trip a model
                        // would otherwise spend re-sending a trimmed copy.
                        TaskStateVerdict::OverTarget(n) => (
                            format!(
                                "Task state recorded ({n} chars) — over the {}-char target. \
                                 No action needed now; trim it on your next update (drop \
                                 narration, keep goal / current deltas / key call_ids).",
                                TASK_STATE_TARGET_CHARS
                            ),
                            true,
                        ),
                        TaskStateVerdict::Ok(_) => (
                            "Task state recorded. It survives context compaction \
                             verbatim; update it as the task moves."
                                .to_string(),
                            true,
                        ),
                    };
                    if success {
                        tool_fail_count.remove(&fail_key);
                    } else {
                        *tool_fail_count.entry(fail_key).or_insert(0) += 1;
                    }
                    let tool_msg = ChatMessage::tool_result(&tc.id, &result);
                    messages.push(tool_msg.clone());
                    new_messages.push(tool_msg);
                    let _ = event_tx.send(AgentEvent::ToolCallResult {
                        id: tc.id.clone(),
                        result,
                        success,
                    });
                    continue;
                }

                // ── recall_result: the fault handler for elided tool results.
                // Intercepted like ask_user, before any gating: the loop owns
                // the canonical history the lookup reads (no registry tool
                // could answer it), and it is read-only by construction. The
                // breaker still applies: re-asking for the same missing
                // call_id will never start succeeding. ──
                if tc.function.name == "recall_result" {
                    let fail_key = tool_fail_key(&tc.function.name, &args_val);
                    let call_desc = call_preview(&args_val);
                    let prev_fails = *tool_fail_count.get(&fail_key).unwrap_or(&0);
                    if prev_fails >= 3 {
                        let blocked_msg = format!(
                            "[BLOCKED] This exact '{}' call has failed {} consecutive \
                             times: {}. Do NOT repeat it — try a different \
                             command/arguments, or ask the user for help.",
                            tc.function.name, prev_fails, call_desc
                        );
                        let tool_msg = ChatMessage::tool_result(&tc.id, &blocked_msg);
                        messages.push(tool_msg.clone());
                        new_messages.push(tool_msg);
                        let _ = event_tx.send(AgentEvent::ToolCallResult {
                            id: tc.id.clone(),
                            result: blocked_msg,
                            success: false,
                        });
                        continue;
                    }
                    let (result, success) =
                        self.handle_recall(&args_val, messages, request_view.as_deref());
                    if success {
                        tool_fail_count.remove(&fail_key);
                    } else {
                        *tool_fail_count.entry(fail_key).or_insert(0) += 1;
                    }
                    let tool_msg = ChatMessage::tool_result(&tc.id, &result);
                    messages.push(tool_msg.clone());
                    new_messages.push(tool_msg);
                    let _ = event_tx.send(AgentEvent::ToolCallResult {
                        id: tc.id.clone(),
                        result,
                        success,
                    });
                    continue;
                }

                let tool = self.registry.get(&tc.function.name);

                // Risk gating. Unknown tools fail safe to Dangerous.
                let risk = tool
                    .as_ref()
                    .map(|t| t.risk(&args_val))
                    .unwrap_or(RiskLevel::Dangerous);

                let mut amended_args_str: Option<String> = None;

                // ── Skill tool isolation as an escalation gate. ──
                // The advertised toolset stays FULL and constant (active_tools()
                // never hides tools, for prompt-cache stability). A call outside
                // the active skill's `allowed-tools` is not refused: safe tools
                // run as usual, riskier ones go through the standard user
                // confirmation below (see needs_confirm).
                if !self.tool_in_skill_allowlist(&tc.function.name) {
                    if let Some(sk) = &self.active_skill {
                        let disposition = if risk == RiskLevel::Safe {
                            "permitted (safe)"
                        } else if self.trust_all {
                            "auto-approved (trust_all)"
                        } else {
                            "requires user confirmation"
                        };
                        log::info!(
                            "skill '{}': tool '{}' outside allowed-tools (risk={:?}) — {}",
                            sk.name,
                            tc.function.name,
                            risk,
                            disposition,
                        );
                    }
                }

                if self.needs_confirm(&tc.function.name, risk) {
                    let _ = event_tx.send(AgentEvent::ConfirmTool {
                        id: tc.id.clone(),
                        name: tc.function.name.clone(),
                        arguments: tc.function.arguments.clone(),
                        risk,
                    });

                    let response = confirm_rx.recv().await.unwrap_or(ConfirmResponse::Deny);
                    match &response {
                        ConfirmResponse::Approve { amended_args } => {
                            if let Some(v) = amended_args {
                                amended_args_str = Some(v.to_string());
                            }
                        }
                        ConfirmResponse::ApproveAll => {
                            // Approve this call and enable session full-auto:
                            // the shared flag silences every later
                            // needs_confirm in this session (until toggled
                            // off). ask_user keeps prompting regardless.
                            self.auto_confirm.store(true, Ordering::Relaxed);
                            log::info!("session full-auto enabled via ApproveAll");
                        }
                        ConfirmResponse::Deny => {
                            let tool_msg =
                                ChatMessage::tool_result(&tc.id, "User rejected this operation");
                            messages.push(tool_msg.clone());
                            new_messages.push(tool_msg);
                            let _ = event_tx.send(AgentEvent::ToolCallResult {
                                id: tc.id.clone(),
                                result: "User rejected".to_string(),
                                success: false,
                            });
                            continue;
                        }
                    }
                }

                // Unknown tool: report cleanly so the model can recover.
                let tool = match tool {
                    Some(t) => t,
                    None => {
                        let msg = format!(
                            "[NO_RETRY] Unknown tool '{}'. It is not registered. \
                             Use one of the available tools.",
                            tc.function.name
                        );
                        let tool_msg = ChatMessage::tool_result(&tc.id, &msg);
                        messages.push(tool_msg.clone());
                        new_messages.push(tool_msg);
                        let _ = event_tx.send(AgentEvent::ToolCallResult {
                            id: tc.id.clone(),
                            result: msg,
                            success: false,
                        });
                        continue;
                    }
                };

                let effective_args_val: serde_json::Value = match &amended_args_str {
                    Some(s) => serde_json::from_str(s).unwrap_or(args_val.clone()),
                    None => args_val.clone(),
                };

                let fail_key = tool_fail_key(&tc.function.name, &effective_args_val);
                // Computed before `effective_args_val` is moved into `execute`.
                let call_desc = call_preview(&effective_args_val);
                let prev_fails = *tool_fail_count.get(&fail_key).unwrap_or(&0);
                if prev_fails >= 3 {
                    let blocked_msg = format!(
                        "[BLOCKED] This exact '{}' call has failed {} consecutive times: {}. \
                         Do NOT repeat it — try a different command/arguments, or ask the user \
                         for help.",
                        tc.function.name, prev_fails, call_desc
                    );
                    let tool_msg = ChatMessage::tool_result(&tc.id, &blocked_msg);
                    messages.push(tool_msg.clone());
                    new_messages.push(tool_msg);
                    let _ = event_tx.send(AgentEvent::ToolCallResult {
                        id: tc.id.clone(),
                        result: blocked_msg,
                        success: false,
                    });
                    continue;
                }

                let interactive = tool.interactive();
                if interactive {
                    let _ = event_tx.send(AgentEvent::SuspendTerminal);
                    let _ = confirm_rx.recv().await;
                }

                let ctx = ToolContext::new(event_tx.clone(), cancel_flag.clone())
                    .with_session(self.session_id.clone());
                let tool_started = wasmtimer::std::Instant::now();
                let tool_result = tool.execute(effective_args_val, &ctx).await;
                let tool_elapsed_ms = tool_started.elapsed().as_millis() as u64;

                log::info!(
                    "tool result: name={} output_len={} preview={}",
                    tc.function.name,
                    tool_result.output.len(),
                    crate::client::log_truncate(&tool_result.output, 150)
                );

                if interactive {
                    let _ = event_tx.send(AgentEvent::ResumeTerminal);
                }

                // Merge dynamically injected tools.
                if !tool_result.inject_tools.is_empty() {
                    self.inject_tools(tool_result.inject_tools.clone());
                }

                let mut result = tool_result.output;
                let skip_compress = tool_result.skip_compress;
                let inline_content = tool_result.inline_content;
                let tool_success = tool_result.success;

                // ── Round-level structured observability: (skill, tool, result,
                // latency). Always logged; optionally appended to a JSONL sink
                // (AGENT_SKILL_STATS_FILE) for offline skill analytics. ──
                record_tool_stat(
                    self.active_skill.as_ref().map(|s| s.name.as_str()),
                    &tc.function.name,
                    tool_success,
                    tool_elapsed_ms,
                );

                // ── Skill (de)activation on a successful read_skill call. ──
                // `reset`/`none` is the escape hatch: it clears the active skill
                // and restores the full toolset. Any other name activates that
                // skill, whose enforced allow-list steers subsequent tool calls
                // (in-turn and — via the emitted events — across turns). ──
                if tc.function.name == "read_skill" && tool_success != Some(false) {
                    if let Some(name) = args_val.get("name").and_then(|v| v.as_str()) {
                        if crate::skill::is_reset_skill_name(name) {
                            if self.active_skill.is_some() {
                                log::info!("skill deactivated (reset); full toolset restored");
                                self.active_skill = None;
                                let _ = event_tx.send(AgentEvent::SkillDeactivated);
                            }
                        } else if let Some(reg) = self.skills.as_ref() {
                            if let Ok(active) = resolve_active_skill(reg, name, false) {
                                log::info!(
                                    "skill activated: {} (allowed_tools=[{}])",
                                    active.name,
                                    active.allowed_tools.join(", ")
                                );
                                let _ = event_tx.send(AgentEvent::SkillActivated {
                                    name: active.name.clone(),
                                    allowed_tools: active.allowed_tools.clone(),
                                });
                                self.active_skill = Some(active);
                            }
                        }
                    }
                }

                if tc.function.name.ends_with("_start") {
                    if let Some(tid) = extract_task_id(&result) {
                        pending_task_ids.push(tid);
                    }
                }

                let is_unrecoverable = tool_result_is_failure(tool_success, &result);
                if is_unrecoverable {
                    let count = tool_fail_count.entry(fail_key.clone()).or_insert(0);
                    *count += 1;
                    if *count >= 2 {
                        result.push_str(&format!(
                            "\n[REPEATED_FAILURE] This exact '{}' call has failed {} times: {}. \
                             Stop repeating it — try a different command/arguments or inform the \
                             user about the issue.",
                            tc.function.name, count, call_desc
                        ));
                    }
                } else {
                    tool_fail_count.remove(&fail_key);
                }

                let compressed = if skip_compress {
                    result.clone()
                } else {
                    compress_tool_result(&result)
                };

                let tool_msg = ChatMessage::tool_result(&tc.id, &compressed);
                messages.push(tool_msg.clone());
                new_messages.push(tool_msg);
                let _ = event_tx.send(AgentEvent::ToolCallResult {
                    id: tc.id.clone(),
                    result: result.clone(),
                    success: !is_unrecoverable,
                });

                if let Some(inline) = inline_content {
                    let _ = event_tx.send(AgentEvent::StreamContent(inline.clone()));
                    pending_inline_seeds.push(inline);
                }
            }

            // ── Round-boundary durability: commit the completed tool round
            // now — the context is valid here (every tool_call has its
            // result), so a crash/panic/timeout later in the turn still
            // leaves an auditable transcript up to this point. Consumers are
            // idempotent whole-snapshot writers (session memory replace +
            // store snapshot merge), so the extra syncs only re-save the same
            // session; `commit_skill: false` keeps a staged skill activation
            // pending until the turn-level sync. ──
            self.emit_sync(event_tx, &new_messages, messages);
        }

        let _ = event_tx.send(AgentEvent::SessionSync {
            new_messages: new_messages.clone(),
            full_context: messages.clone(),
            commit_skill: true,
        });
        // Same rule as the failure exit in `run_agent_turn`: this turn ends
        // without answering, so an unconsumed steer goes back to the queue.
        self.requeue_pending_steers(event_tx);
        let _ = event_tx.send(AgentEvent::Error(
            "Reached maximum agent loop iterations".to_string(),
        ));
        Ok(())
    }

    fn emit_done(
        &self,
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
        new_messages: &[ChatMessage],
        messages: &[ChatMessage],
        start: wasmtimer::std::Instant,
    ) {
        let elapsed = start.elapsed().as_millis() as u64;
        let _ = event_tx.send(AgentEvent::SessionSync {
            new_messages: new_messages.to_vec(),
            full_context: messages.to_vec(),
            commit_skill: true,
        });
        let _ = event_tx.send(AgentEvent::AssistantDone {
            elapsed_ms: elapsed,
        });
    }

    /// Commit progress WITHOUT signaling the turn finished. Used on the error
    /// paths that `return Err` (LLM request failed, e.g. 429 retries exhausted,
    /// mid-stream disconnect, or an invalid assistant message): emit a
    /// `SessionSync` so the user message plus any already-completed tool rounds
    /// are persisted before the error bubbles up — otherwise the turn is lost on
    /// refresh (even a first-call 429 would drop the user's just-typed message,
    /// unlike a cancel, which keeps it).
    ///
    /// `commit_skill: false`: a staged skill activation whose turn errored is
    /// NOT committed — the skill only takes effect if the turn actually
    /// progressed to a successful sync. Deliberately no `AssistantDone`; the
    /// `Error` event that follows tells the client the turn failed.
    ///
    /// Safe to persist: the failed/invalid LLM response is never pushed into
    /// `messages`, so its tail is a valid tool result / user message (no
    /// dangling tool_calls). Continuation stays valid on any model because
    /// `client::prepare_messages_for_api` re-projects (heals) the history per
    /// target model on every request.
    fn emit_sync(
        &self,
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
        new_messages: &[ChatMessage],
        messages: &[ChatMessage],
    ) {
        if messages.is_empty() {
            return;
        }
        let _ = event_tx.send(AgentEvent::SessionSync {
            new_messages: new_messages.to_vec(),
            full_context: messages.to_vec(),
            commit_skill: false,
        });
    }

    /// Resolve one `recall_result` call (see [`resolve_recall`]).
    fn handle_recall(
        &self,
        args: &serde_json::Value,
        messages: &[ChatMessage],
        request_view: Option<&[ChatMessage]>,
    ) -> (String, bool) {
        resolve_recall(
            args,
            messages,
            request_view,
            self.store.as_deref(),
            self.session_id.as_deref(),
        )
    }

    /// Prune (Level 1) and/or LLM-compact (Level 2) the working context before
    /// each LLM request when it exceeds the model's thresholds.
    ///
    /// Level 1 is a request-time VIEW: the returned pruned copy (`Some`) is
    /// what goes on the wire, while the canonical `messages` keep every tool
    /// result's full content — in memory and in the session DB — so the user's
    /// transcript is never silently degraded. `None` means the canonical
    /// history goes out as it stands: either it is under the pruning
    /// threshold, or Level 2 just rewrote it (summary + verbatim tail) and
    /// the rewritten history IS the request.
    ///
    /// Level 2 is the only destructive step, and it only runs after the span
    /// it replaces has been archived successfully. An archive failure (full
    /// disk, DB error) skips compaction for this round — better an oversized
    /// context than destroying data with no backup — and the pruned view
    /// keeps the request itself within budget until the next attempt.
    ///
    /// The canonical history is additionally hard-capped at
    /// `CANONICAL_CAP_FACTOR`× the compaction threshold: the pruned view can
    /// stay small forever (old tool results are placeholders in the view), and
    /// without the cap the canonical context — rewritten wholesale to SQLite
    /// on every sync — would grow unboundedly.
    async fn maybe_compact_context(
        &mut self,
        messages: &mut Vec<ChatMessage>,
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> Option<Vec<ChatMessage>> {
        match self
            .maybe_compact_context_inner(messages, event_tx, false)
            .await
        {
            ContextPrep::View(view) => Some(view),
            ContextPrep::Canonical | ContextPrep::Compacted => None,
        }
    }

    /// [`Self::maybe_compact_context`] with `force`: compact even when the
    /// estimate says the context fits. Used when the PROVIDER said it did not
    /// (a context-overflow verdict) — its tokenizer, not the estimate, is the
    /// ground truth.
    async fn maybe_compact_context_inner(
        &mut self,
        messages: &mut Vec<ChatMessage>,
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
        force: bool,
    ) -> ContextPrep {
        let model = self.llm.model().to_string();
        let configured = self.configured_context_tokens;
        // Snapshot the shared state for this decision; the cut is written
        // back below (the calibration is only written by `observe`).
        let mut ctx = *self.context_state.lock().unwrap();
        // The thresholds are defined on the default character scale; bring
        // them onto THIS session's scale once, then compare raw sizes. A
        // session whose content tokenizes denser than the default gets
        // proportionally lower thresholds (see `SessionContextState`).
        let prune_thresh = ctx.threshold_for(pruning_threshold(&model, configured));
        let compact_thresh = ctx.threshold_for(compaction_threshold(&model, configured));
        let target = ctx.threshold_for(prune_target(&model, configured));

        let canonical_size = context_chars(messages);

        // Level 1: the stepped prune (the cut is an absolute position and
        // only moves forward, so the request prefix is byte-identical between
        // re-plans). A forced round cuts even when the estimate says it fits —
        // the provider has just said otherwise.
        let mut view = ctx.prune.view(messages, prune_thresh, target, compact_thresh);
        if view.is_none() && force {
            view = Some(ctx.prune.force_cut(messages, target));
        }
        let view_size = view.as_deref().map(context_chars).unwrap_or(canonical_size);
        log::info!(
            "Level 1 view pruning: canonical={} view={} elided={:?} planned={} chars_per_token={:?} \
             prune_thresh={} target={} compact_thresh={}",
            canonical_size,
            view_size,
            ctx.prune.elided,
            ctx.prune.planned_size,
            ctx.chars_per_token.map(|r| (r * 100.0).round() / 100.0),
            prune_thresh,
            target,
            compact_thresh
        );
        // The cut (possibly re-planned) is the session's now.
        self.context_state.lock().unwrap().prune = ctx.prune;

        // Level 2 decision.
        let fallback = match view {
            Some(view) => ContextPrep::View(view),
            None => ContextPrep::Canonical,
        };
        if !force && !should_compact(canonical_size, view_size, compact_thresh) {
            return fallback;
        }
        // From here on a compaction is attempted; `fallback` is what goes out
        // if it fails.

        // A pending note: whatever comes out of the attempt below — the
        // compaction figures or a skip notice — resolves it. Every exit
        // path from here MUST send one, or the wait stays on screen.
        let _ = event_tx.send(AgentEvent::StatusUpdate {
            text: "Compacting context...".to_string(),
            pending: true,
        });
        let skipped = |reason: String| AgentEvent::StatusUpdate {
            text: format!("Context compaction skipped ({reason}); continuing without it"),
            pending: false,
        };
        // The most recent exchanges stay behind the summary VERBATIM — the
        // user's live request, the tool results the model was acting on — so
        // the turn resumes exactly where it stopped. Only the span before them
        // is summarized, archived and destroyed.
        let mut tail_start = compaction_tail_start(messages, compaction_tail_budget(compact_thresh));
        // vinx: a forced round answers the provider's verdict on the request
        // just made. When that request IS the user's fresh message, the fix is
        // to shed what is older — never the message itself: the budgeted tail
        // drops it whenever it is larger than the budget (a pasted document),
        // and summarizing it to a 500-char head would have the model answer a
        // question it never saw. So the tail starts at that message at the
        // latest, and when nothing older is left to shed the verdict stands —
        // the user sees the provider's error and can shorten the message. An
        // overflow mid-turn (newest message a tool result) keeps upstream's
        // behaviour: the span is summarized and the turn goes on from it.
        if force && messages.last().is_some_and(|m| m.role == Role::User) {
            let live = messages.len() - 1;
            tail_start = tail_start.min(live);
            let first = usize::from(messages.first().is_some_and(|m| m.role == Role::System));
            if tail_start <= first {
                log::warn!(
                    "forced compaction skipped: nothing older than the live request to shed"
                );
                let _ = event_tx.send(skipped(
                    "the message alone exceeds the model's context window".to_string(),
                ));
                return fallback;
            }
        }
        let tail_kept = messages.len() - tail_start;
        // The task-state register is carried across the compaction verbatim —
        // read it from the canonical history BEFORE that history is destroyed,
        // and show it to the summarizer so the summary covers what it lacks
        // instead of repeating it.
        let task_state = latest_task_state(messages);
        // Summarize the canonical history (full tool results, not the view's
        // placeholders): compact_context caps each entry at 500 chars, so the
        // prompt stays bounded while the summary sees real content.
        let scope = SummaryScope {
            tail_kept,
            task_state: task_state.as_deref(),
        };
        let started = wasmtimer::std::Instant::now();
        let summary = match compact_context(&self.llm, &messages[..tail_start], scope).await {
            Ok(summary) => summary,
            Err(e) => {
                log::warn!("compaction summary failed, keeping the context: {e}");
                let _ = event_tx.send(skipped(format!("summarizer failed: {e}")));
                return fallback;
            }
        };
        let summarizer_secs = started.elapsed().as_secs_f64();
        // Written by code, not by the summarizer: the ids of the span's largest
        // results, so recall_result stays reachable without the LLM reciting
        // them (≈ 12 output tokens each — the most expensive thing it wrote).
        let index = recall_index(&messages[..tail_start]);
        // The summary is about to replace the raw history — snapshot the span
        // it replaces to the archive first, and only destroy what was durably
        // archived. Exactly that span, not the tail: the tail stays live, and
        // archiving what the next compaction archives again would show every
        // kept message twice in the stitched transcript. On failure keep the
        // context intact and retry on a later round.
        let mut archived_generation: Option<i64> = None;
        if let (Some(store), Some(sid)) = (&self.store, &self.session_id) {
            // Inline, not on a blocking thread: the wasm store lives on this
            // thread, and an archive runs once per compaction, which is rare
            // and already on the slow path.
            match store.archive_messages(sid, &messages[..tail_start]) {
                Ok(generation) => {
                    log::info!(
                        "pre-compaction archive: session={} generation={} messages={} \
                         kept_verbatim={}",
                        self.session_id.as_deref().unwrap_or(""),
                        generation,
                        tail_start,
                        tail_kept
                    );
                    archived_generation = Some(generation);
                }
                Err(e) => {
                    log::warn!("pre-compaction archive failed, skipping compaction: {e}");
                    let _ = event_tx.send(skipped(format!("archive failed: {e}")));
                    return fallback;
                }
            }
        }
        // Rebuild: [system] + summary + the verbatim tail.
        let head_len = usize::from(messages.first().is_some_and(|m| m.role == Role::System));
        let tail = messages.split_off(tail_start);
        messages.truncate(head_len);
        // The first line is EXACTLY `[Conversation Summary]` — a frozen token:
        // the chat UI matches it byte-for-byte to collapse the message
        // (AgentChat.tsx `summaryMarker`), and read_session's transcript
        // stitching keys on it too. Anything else goes on the lines below.
        let mut body = SUMMARY_MARKER.to_string();
        // When the raw history was archived, say so IN the summary message:
        // the call_ids the summary preserves stay actionable — recall_result
        // falls through to the archive for anything named here.
        if let Some(generation) = archived_generation {
            body.push_str(&format!(
                "\nEarlier history archived (generation {generation}); tool results \
                 named below remain retrievable via recall_result(call_id=...)."
            ));
        }
        if tail_kept > 0 {
            body.push_str(&format!(
                "\nThe {tail_kept} most recent messages follow this summary verbatim."
            ));
        }
        if let Some(state) = task_state {
            body.push_str("\n\n");
            // Delimited so the NEXT compaction's latest_task_state finds it
            // again — the block carries forward until the model rewrites it.
            body.push_str(&task_state_block(&state));
        }
        body.push_str("\n\n");
        // The narrative is LLM text and may quote a pasted transcript —
        // neutralize any task-state delimiters in it so the block above stays
        // the only one latest_task_state can find in this trusted message.
        body.push_str(&crate::context::neutralize_task_state_markers(&summary));
        if let Some(index) = index {
            body.push_str("\n\n");
            body.push_str(&index);
        }
        messages.push(ChatMessage::user(&body));
        messages.extend(tail);
        // The history is new: the old cut point no longer describes it (the
        // tokenizer calibration does — same content, same language).
        self.context_state.lock().unwrap().reset_cut();
        log::info!(
            "context compacted: {} chars -> {} chars (summary {} chars + {} verbatim messages); \
             summarizer took {:.1}s",
            canonical_size,
            context_chars(messages),
            body.chars().count(),
            tail_kept,
            summarizer_secs
        );
        // Tell the user what the wait was — the same figures the log carries,
        // plus the summarizer model when it is not the turn's own. This is
        // the outcome that resolves the pending "Compacting context..." note.
        let summarizer_note = self
            .llm
            .compaction_model()
            .map(|m| format!(" on {m}"))
            .unwrap_or_default();
        let _ = event_tx.send(AgentEvent::StatusUpdate {
            text: format!(
                "Context compacted in {summarizer_secs:.0}s{summarizer_note}: summary {} chars, \
                 {tail_kept} recent messages kept verbatim",
                body.chars().count()
            ),
            pending: false,
        });
        ContextPrep::Compacted
    }
}

/// What [`AgentLoop::maybe_compact_context_inner`] decided the round sends.
enum ContextPrep {
    /// The canonical history as it stands.
    Canonical,
    /// Level 1: a pruned request VIEW; the canonical history is untouched.
    View(Vec<ChatMessage>),
    /// Level 2: the canonical history itself was rewritten (summary + verbatim
    /// tail) and is the request.
    Compacted,
}

/// Everything one turn needs, gathered into a struct so the parameter surface
/// can grow without breaking signatures (construct with [`TurnParams::new`],
/// then set optional fields directly — new fields keep old callers compiling).
pub struct TurnParams {
    pub llm: LlmClient,
    pub registry: Arc<ToolRegistry>,
    pub initial_messages: Vec<ChatMessage>,
    pub event_tx: mpsc::UnboundedSender<AgentEvent>,
    pub confirm_rx: mpsc::UnboundedReceiver<ConfirmResponse>,
    /// `None` => headless: `ask_user` auto-picks each question's default.
    pub ask_user_rx: Option<mpsc::UnboundedReceiver<AskUserResponse>>,
    pub cancel_flag: Arc<AtomicBool>,
    /// Configured context size in tokens (0 = auto-detect from model name).
    pub configured_context_tokens: usize,
    pub blocklist: Vec<String>,
    pub trust_all: bool,
    /// Session-scoped full-auto flag (shared `Arc`, read live by the loop).
    pub auto_confirm: Option<Arc<AtomicBool>>,
    pub skills: Option<Arc<SkillRegistry>>,
    pub active_skill: Option<ActiveSkill>,
    pub session_id: Option<String>,
    /// Unattended `ask_user` auto-pick timeout in seconds (0 = wait forever).
    pub ask_user_timeout_secs: u64,
    /// Sub-agent execution for the `task` tool (`None` = tool unavailable;
    /// child turns always run with `None` — the depth cap).
    pub task_runner: Option<Arc<crate::agent_task::TaskRunner>>,
    /// Mid-turn user steering ("send now"); `None` = not offered.
    pub steer_rx: Option<mpsc::UnboundedReceiver<String>>,
    /// Session store for pre-compaction archiving; `None` = no archiving.
    pub store: Option<Arc<crate::web::store::SqliteStore>>,
    /// The session's context memory (Level-1 cut point, last measured prompt
    /// size), shared across turns; `None` = fresh per turn.
    pub context_state: Option<SharedContextState>,
}

impl TurnParams {
    /// Minimal constructor; optional knobs default off (no skills, attended
    /// defaults, fresh cancel flag) and are set as plain fields afterwards.
    pub fn new(
        llm: LlmClient,
        registry: Arc<ToolRegistry>,
        initial_messages: Vec<ChatMessage>,
        event_tx: mpsc::UnboundedSender<AgentEvent>,
        confirm_rx: mpsc::UnboundedReceiver<ConfirmResponse>,
    ) -> Self {
        Self {
            llm,
            registry,
            initial_messages,
            event_tx,
            confirm_rx,
            ask_user_rx: None,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            configured_context_tokens: 0,
            blocklist: Vec::new(),
            trust_all: false,
            auto_confirm: None,
            skills: None,
            active_skill: None,
            session_id: None,
            ask_user_timeout_secs: crate::config::default_ask_user_timeout_secs(),
            task_runner: None,
            steer_rx: None,
            store: None,
            context_state: None,
        }
    }
}

/// Run one turn to completion (e.g. inside a spawned task): builds the
/// [`AgentLoop`] from `params`, drives `process_message`, and reports a
/// failure as [`AgentEvent::Error`].
pub async fn run_agent_turn(params: TurnParams) {
    let TurnParams {
        llm,
        registry,
        initial_messages,
        event_tx,
        confirm_rx,
        ask_user_rx,
        cancel_flag,
        configured_context_tokens,
        blocklist,
        trust_all,
        auto_confirm,
        skills,
        active_skill,
        session_id,
        ask_user_timeout_secs,
        task_runner,
        steer_rx,
        store,
        context_state,
    } = params;

    let mut agent = AgentLoop::new(llm, registry)
        .with_context_tokens(configured_context_tokens)
        .with_blocklist(blocklist)
        .with_trust_all(trust_all)
        .with_active_skill(active_skill)
        .with_session_id(session_id)
        .with_ask_user_timeout(ask_user_timeout_secs)
        .with_task_runner(task_runner)
        .with_steer(steer_rx)
        .with_store(store);
    if let Some(state) = context_state {
        agent = agent.with_context_state(state);
    }
    if let Some(flag) = auto_confirm {
        agent = agent.with_auto_confirm(flag);
    }
    if let Some(reg) = skills {
        agent = agent.with_skill_registry(reg);
    }
    let mut messages = initial_messages;
    let mut confirm_rx = confirm_rx;
    let mut ask_user_rx = ask_user_rx;

    let result = agent
        .process_message(
            &mut messages,
            &event_tx,
            &mut confirm_rx,
            ask_user_rx.as_mut(),
            cancel_flag,
        )
        .await;

    if let Err(e) = result {
        // Before the terminal frame: a steer that was accepted but never
        // reached a round boundary (the request failed first) goes back to
        // the queue instead of vanishing. The driver reads this while still
        // in the event loop, i.e. before it drains the queue on `Error`.
        agent.requeue_pending_steers(&event_tx);
        let _ = event_tx.send(AgentEvent::Error(e.to_string()));
    }
}

/// Compatibility wrapper for the pre-[`TurnParams`] signature; prefer
/// [`run_agent_turn`]. Behaves identically, with the default unattended
/// `ask_user` timeout.
#[allow(clippy::too_many_arguments)]
pub async fn run_agent_loop_standalone(
    llm: LlmClient,
    registry: Arc<ToolRegistry>,
    configured_context_tokens: usize,
    blocklist: Vec<String>,
    initial_messages: Vec<ChatMessage>,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    confirm_rx: mpsc::UnboundedReceiver<ConfirmResponse>,
    ask_user_rx: Option<mpsc::UnboundedReceiver<AskUserResponse>>,
    cancel_flag: Arc<AtomicBool>,
    trust_all: bool,
    auto_confirm: Option<Arc<AtomicBool>>,
    skills: Option<Arc<SkillRegistry>>,
    active_skill: Option<ActiveSkill>,
    session_id: Option<String>,
) {
    let mut params = TurnParams::new(llm, registry, initial_messages, event_tx, confirm_rx);
    params.ask_user_rx = ask_user_rx;
    params.cancel_flag = cancel_flag;
    params.configured_context_tokens = configured_context_tokens;
    params.blocklist = blocklist;
    params.trust_all = trust_all;
    params.auto_confirm = auto_confirm;
    params.skills = skills;
    params.active_skill = active_skill;
    params.session_id = session_id;
    run_agent_turn(params).await;
}

/// The synthetic `recall_result` tool: the fault handler for tool results
/// elided from the request view (see [`crate::context::clear_old_tool_results`]).
pub fn recall_result_definition() -> ToolDefinition {
    ToolDefinition::new(
        "recall_result",
        "Retrieve the full content of an earlier tool result that was elided from \
         the visible context to save space. Elided results appear as placeholders: \
         `[compacted: <tool> result, <n> chars — recall_result(call_id=\"...\") \
         restores it]`. Pass that call_id to get the original content back. \
         Read-only and free of side effects — always prefer this over re-running \
         the command that produced the result.",
        ToolParameters::object(
            HashMap::from([(
                "call_id".into(),
                ToolParameter::string("the call_id from a `[compacted: ...]` placeholder"),
            )]),
            vec!["call_id".into()],
        ),
    )
}

/// Resolve one `recall_result` call: look the id up in the canonical history
/// (which Level-1 pruning never touches), then fall through to the session
/// archive for content a Level-2 compaction has rewritten away. Returns
/// `(tool result text, success)`.
///
/// A free function rather than a method so store-backed tests can drive both
/// lookup levels directly, without standing up a loop and an endpoint.
pub fn resolve_recall(
    args: &serde_json::Value,
    messages: &[ChatMessage],
    request_view: Option<&[ChatMessage]>,
    store: Option<&crate::web::store::SqliteStore>,
    session_id: Option<&str>,
) -> (String, bool) {
    let call_id = args.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
    if call_id.is_empty() {
        return (
            "[NO_RETRY] recall_result requires a call_id — copy it from the \
             `[compacted: ...]` placeholder of the result you need."
                .to_string(),
            false,
        );
    }
    match recall_tool_result(messages, request_view, call_id) {
        RecallOutcome::Recalled { tool, content } => {
            log::info!(
                "recall_result: restored call_id={} tool={} len={}",
                call_id,
                tool,
                content.len()
            );
            (
                format!(
                    "[recalled {} result call_id=\"{}\"]\n{}",
                    tool, call_id, content
                ),
                true,
            )
        }
        RecallOutcome::Visible => (
            format!(
                "Result call_id=\"{}\" is already present in full in the current \
                 context — read it from there.",
                call_id
            ),
            true,
        ),
        RecallOutcome::Miss => {
            // The id is not in the working context at all: a Level-2
            // compaction may have replaced it with the summary. The archive
            // written just before that compaction still has it.
            if let (Some(store), Some(sid)) = (store, session_id) {
                match store.lookup_archived_tool_result(sid, call_id) {
                    Ok(Some((tool, content))) => {
                        log::info!(
                            "recall_result: restored call_id={} tool={} len={} (archive)",
                            call_id,
                            tool,
                            content.len()
                        );
                        return (
                            format!(
                                "[recalled archived {} result call_id=\"{}\"]\n{}",
                                tool, call_id, content
                            ),
                            true,
                        );
                    }
                    Ok(None) => {}
                    Err(e) => log::warn!("recall_result: archive lookup failed: {e}"),
                }
            }
            (
                format!(
                    "[NO_RETRY] No tool result with call_id=\"{}\" exists in this \
                     session. Check the id against a `[compacted: ...]` placeholder.",
                    call_id
                ),
                false,
            )
        }
    }
}

/// The synthetic `update_task_state` tool: the task registers. Its calls stay
/// in the history (that IS the storage — see [`crate::context::latest_task_state`]);
/// at compaction time the newest block is copied into the summary message
/// verbatim, so what the model wrote here survives where the rest of the
/// history is reduced to a lossy summary.
pub fn update_task_state_definition() -> ToolDefinition {
    let description = format!(
        "Maintain a compact task-state block during long multi-step tasks: the goal, \
         what is done, what is in progress, key facts (include call_ids of \
         load-bearing tool results), and next steps — one terse line each, no \
         narration. Each call REPLACES the previous block, so always write the \
         complete state. Aim for about {} characters and stay under {}. \
         When the conversation is later compacted to fit the context window, this \
         block survives verbatim while everything else is summarized — put what you \
         cannot afford to lose here. Update it at natural milestones, not every turn.",
        TASK_STATE_AIM_CHARS, TASK_STATE_TARGET_CHARS
    );
    ToolDefinition::new(
        "update_task_state",
        &description,
        ToolParameters::object(
            HashMap::from([(
                "state".into(),
                ToolParameter::string("the complete task-state block (replaces the previous one)"),
            )]),
            vec!["state".into()],
        ),
    )
}

/// The synthetic `ask_user` tool schema advertised to the LLM.
pub fn ask_user_definition() -> ToolDefinition {
    let option_obj = ToolParameter::object(
        "an option",
        HashMap::from([
            (
                "id".into(),
                ToolParameter::string("option id (machine-readable)"),
            ),
            (
                "label".into(),
                ToolParameter::string("label shown to the user"),
            ),
            (
                "hint".into(),
                ToolParameter::string("optional secondary hint"),
            ),
        ]),
        vec!["id".into(), "label".into()],
    );
    let question_obj = ToolParameter::object(
        "one question",
        HashMap::from([
            (
                "id".into(),
                ToolParameter::string("question id, used to match the answer"),
            ),
            (
                "question".into(),
                ToolParameter::string("question text shown to the user"),
            ),
            (
                "options".into(),
                ToolParameter::array_of("2-5 candidate options", option_obj),
            ),
            (
                "allow_custom".into(),
                ToolParameter::boolean(
                    "deprecated — the UI always offers a free-text answer; field ignored",
                )
                .with_default(serde_json::json!(false)),
            ),
            (
                "multi_select".into(),
                ToolParameter::boolean("allow multiple selection (default false)")
                    .with_default(serde_json::json!(false)),
            ),
            (
                "default_id".into(),
                ToolParameter::string(
                    "recommended default option id — also what is picked for the user \
                     when they do not answer in time (unattended sessions); without it \
                     the first option is",
                ),
            ),
        ]),
        vec!["id".into(), "question".into(), "options".into()],
    );

    ToolDefinition::new(
        "ask_user",
        "Ask the user one or more structured multiple-choice questions to resolve \
         ambiguous parameters or key decisions. Prefer batching independent questions \
         into a single call. Each question should offer 2-5 options and a recommended \
         default_id when possible. The user can ALWAYS type a free-text answer instead \
         of picking an option — any answer may carry `custom_text`; when present, it is \
         the user's actual answer and takes precedence over selected option ids. \
         If the result has `auto_picked: true`, the user did NOT answer: the session \
         is unattended and the defaults were filled in after a timeout. Treat them as \
         your own guess, not their decision — say what you assumed, keep the work that \
         rests on it small and reversible, and for a question about what they actually \
         want, prefer to stop and ask in prose over committing to a large piece of work. \
         Do not use for chitchat or to confirm obvious intent.",
        ToolParameters::object(
            HashMap::from([(
                "questions".into(),
                ToolParameter::array_of("1-5 independent questions", question_obj),
            )]),
            vec!["questions".into()],
        ),
    )
}

/// Resolve one `ask_user` call.
///
/// - Attended (`timeout_secs: None`): park on the channel until the user
///   answers or cancels — the pre-existing behavior.
/// - Unattended (`timeout_secs: Some(n)`, i.e. trust-all / FULL-AUTO with a
///   configured timeout): still ask for real, but auto-pick each question's
///   recommended default after `n` seconds so an unattended turn never parks
///   forever. The result carries `auto_picked: true` so the model knows the
///   user did not actually answer.
/// - Headless (`ask_user_rx: None`, e.g. `agent run`): auto-pick immediately.
async fn handle_ask_user(
    tool_call_id: &str,
    arguments: &str,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ask_user_rx: Option<&mut mpsc::UnboundedReceiver<AskUserResponse>>,
    timeout_secs: Option<u64>,
) -> String {
    let parsed: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
    let questions: Vec<AskQuestion> = parsed
        .get("questions")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    if questions.is_empty() {
        return serde_json::json!({
            "error": "ask_user.questions is required (non-empty array). \
                      Re-emit ask_user with at least one question, or pick a sensible default."
        })
        .to_string();
    }

    if let Some(rx) = ask_user_rx {
        // Discard answers queued for a PREVIOUS ask (e.g. one submitted just
        // after its timeout auto-picked): the channel outlives individual
        // asks, and a stale response must never resolve this fresh question.
        while rx.try_recv().is_ok() {}

        let _ = event_tx.send(AgentEvent::AskUser {
            id: tool_call_id.to_string(),
            questions: questions.clone(),
            timeout_secs,
        });
        // Both arms loop: `Activity` is not an answer — with a timeout armed
        // it pushes the auto-pick deadline back to the full window; without
        // one (attended) it is simply discarded.
        let response = match timeout_secs {
            Some(secs) => {
                let window = std::time::Duration::from_secs(secs);
                let mut deadline = wasmtimer::std::Instant::now() + window;
                loop {
                    match wasmtimer::tokio::timeout_at(deadline, rx.recv()).await {
                        Ok(Some(AskUserResponse::Activity)) => {
                            deadline = wasmtimer::std::Instant::now() + window;
                        }
                        Ok(response) => break response,
                        Err(_) => {
                            log::info!(
                                "ask_user {} timed out after {}s (unattended); auto-picking defaults",
                                tool_call_id,
                                secs
                            );
                            let answers = auto_pick_ask_defaults(&questions);
                            return build_ask_user_payload(&questions, &answers, false, true);
                        }
                    }
                }
            }
            None => loop {
                match rx.recv().await {
                    // No deadline to reset in attended sessions; discard.
                    Some(AskUserResponse::Activity) => continue,
                    response => break response,
                }
            },
        };
        match response {
            Some(AskUserResponse::Answered { answers }) => {
                build_ask_user_payload(&questions, &answers, false, false)
            }
            // `Activity` never reaches here (consumed above); listed for
            // exhaustiveness and treated as a cancel if it somehow did.
            Some(AskUserResponse::Cancelled) | Some(AskUserResponse::Activity) | None => {
                build_ask_user_payload(&questions, &[], true, false)
            }
        }
    } else {
        let answers = auto_pick_ask_defaults(&questions);
        build_ask_user_payload(&questions, &answers, false, true)
    }
}

fn auto_pick_ask_defaults(questions: &[AskQuestion]) -> Vec<AskAnswer> {
    questions
        .iter()
        .map(|q| {
            let pick = q
                .default_id
                .clone()
                .or_else(|| q.options.first().map(|o| o.id.clone()));
            AskAnswer {
                question_id: q.id.clone(),
                selected_ids: pick.into_iter().collect(),
                custom_text: None,
            }
        })
        .collect()
}

/// Emit a structured per-tool observability record: `(skill, tool, result,
/// elapsed_ms)`. Always logged at info; when `AGENT_SKILL_STATS_FILE` is set,
/// also appended as one JSON object per line (JSONL) for offline analysis.
/// Best-effort — a failing sink never disrupts the turn.
fn record_tool_stat(skill: Option<&str>, tool: &str, success: Option<bool>, elapsed_ms: u64) {
    let outcome = match success {
        Some(true) => "ok",
        Some(false) => "error",
        None => "unknown",
    };
    log::info!(
        "skill_stat skill={} tool={} result={} elapsed_ms={}",
        skill.unwrap_or("-"),
        tool,
        outcome,
        elapsed_ms
    );
    if let Ok(path) = std::env::var("AGENT_SKILL_STATS_FILE") {
        if path.is_empty() {
            return;
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = serde_json::json!({
            "ts_ms": ts,
            "skill": skill,
            "tool": tool,
            "result": outcome,
            "elapsed_ms": elapsed_ms,
        });
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            use std::io::Write;
            let _ = writeln!(f, "{}", line);
        }
    }
}

fn extract_task_id(output: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("task_id:") {
            let tid = rest.trim();
            if !tid.is_empty() {
                return Some(tid.to_string());
            }
        }
    }
    None
}

/// Circuit-breaker counting key: tool name + the call's argument signature.
/// Distinct invocations of the same tool (e.g. `curl` probing different URLs,
/// `systemctl` querying different units) each count independently; only an
/// *identical* call that keeps failing accumulates — exactly the "endlessly
/// retrying the same failing call" the breaker is meant to catch. serde_json
/// (no `preserve_order`) serializes object keys sorted, so the signature is
/// stable and insensitive to field ordering. Kept as a readable string (not a
/// hash): the per-turn map is tiny and this stays greppable in logs.
fn tool_fail_key(name: &str, args: &serde_json::Value) -> String {
    format!(
        "{}::{}",
        name,
        serde_json::to_string(args).unwrap_or_default()
    )
}

/// Short, human-readable description of a tool call for breaker messages, so
/// the model is nudged to *vary* the call rather than assume the whole tool is
/// dead. Prefers `run_shell`'s `command`; otherwise a truncated args JSON.
fn call_preview(args: &serde_json::Value) -> String {
    match args.get("command").and_then(|v| v.as_str()) {
        Some(cmd) => crate::client::log_truncate(cmd, 120),
        None => crate::client::log_truncate(&serde_json::to_string(args).unwrap_or_default(), 120),
    }
}

/// Whether a tool result counts as an (unrecoverable) failure for the
/// consecutive-failure breaker. Prefers the structured `success` flag.
fn tool_result_is_failure(success: Option<bool>, output: &str) -> bool {
    match success {
        Some(true) => false,
        Some(false) => true,
        None => {
            output.contains("[NO_RETRY]")
                || output.starts_with("Error")
                || output.starts_with("Compile FAILED")
        }
    }
}

/// Replacement body for tool-call arguments that failed to parse (stream cut
/// mid-JSON). Valid JSON on purpose: the stub is replayed to the provider on
/// every later request of the session.
fn malformed_args_stub(discarded_len: usize) -> String {
    format!(
        "{{\"error\":\"arguments were truncated in transit ({discarded_len} chars discarded); \
         the call was not executed\"}}"
    )
}

/// Swap the arguments of tool call `call_id` inside a persisted assistant
/// message for `stub`, keeping id/name so the call/result pairing stays
/// wire-valid. Broken multi-KB argument blobs must not ride every subsequent
/// request (K3 replays complete assistant messages verbatim).
fn stub_malformed_call_args(message: &mut ChatMessage, call_id: &str, stub: &str) {
    if let Some(calls) = message.tool_calls.as_mut() {
        if let Some(call) = calls.iter_mut().find(|call| call.id == call_id) {
            call.function.arguments = stub.to_string();
        }
    }
}
