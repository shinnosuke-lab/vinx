//! Sub-agent tasks: the synthetic `task` tool.
//!
//! A `task` call delegates a self-contained piece of work to a child
//! [`AgentLoop`](crate::agent_loop::AgentLoop) with a FRESH context (the child
//! sees only the prompt it is given — none of the parent's conversation), an
//! optional skill persona, and the same tool registry. Several `task` calls in
//! one assistant message fan out concurrently (bounded by
//! [`TaskRunner::max_parallel`]). The child's final answer returns to the
//! parent as the tool result; the full child transcript is persisted as a
//! hidden session (`origin = "task"`) for auditing.
//!
//! Lifecycle rules (structured concurrency — no orphans):
//! - a child never outlives its parent turn: parent cancellation propagates,
//!   and every child is bounded by a wall-clock timeout;
//! - child events stream to the parent's event channel wrapped in
//!   [`AgentEvent::Subagent`] envelopes, so UIs can show progress without
//!   confusing child output for parent output;
//! - child *confirmations* are the exception: they forward **unwrapped**
//!   (serialized one at a time across children), so existing confirm UIs work
//!   untouched; replies route back to the right child via [`ConfirmRouter`].
//!
//! Depth is capped at 1 by construction: a child runner is never given a
//! `TaskRunner`, so the `task` tool is neither advertised nor executable
//! inside a child.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::agent_loop::{run_agent_turn, TurnParams};
use crate::client::LlmClient;
use crate::event::{AgentEvent, ConfirmResponse};
use crate::skill::{load_skill, ActiveSkill, SkillRegistry};
use crate::tool::ToolRegistry;
use crate::types::*;

/// Routes confirmation replies to the child agent that asked.
///
/// The kernel-level half of "child confirms forward unwrapped": when a child
/// emits `ConfirmTool { id }`, the task driver registers `id → child confirm
/// sender` here before forwarding the event. Delivery layers (web session
/// manager, TUI, headless CLI) consult the router FIRST and fall back to the
/// parent turn's confirm channel — one mechanism shared by every frontend.
///
/// Also owns the cross-child serialization gate: at most one child
/// confirmation is presented at a time (single-slot confirm UIs would
/// otherwise drop overlapping requests from parallel children).
pub struct ConfirmRouter {
    routes: Mutex<HashMap<String, mpsc::UnboundedSender<ConfirmResponse>>>,
    /// Live children's cancel flags keyed by the parent `task` tool_call id,
    /// so a frontend can cancel ONE running sub-agent without touching the
    /// rest of the turn (the driver folds the flag into its normal wind-down).
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Serializes child `ConfirmTool` presentation (capacity 1).
    confirm_gate: Arc<tokio::sync::Semaphore>,
}

impl ConfirmRouter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            routes: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            confirm_gate: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<ConfirmResponse>>> {
        self.routes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_cancels(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.cancels.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn register_cancel(&self, call_id: &str, flag: Arc<AtomicBool>) {
        self.lock_cancels().insert(call_id.to_string(), flag);
    }

    fn unregister_cancel(&self, call_id: &str) {
        self.lock_cancels().remove(call_id);
    }

    /// Cancel one running sub-agent by its `task` tool_call id. Returns
    /// `false` when no such task is live (already finished or unknown).
    pub fn cancel_task(&self, call_id: &str) -> bool {
        match self.lock_cancels().get(call_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    fn register(&self, call_id: &str, tx: mpsc::UnboundedSender<ConfirmResponse>) {
        self.lock().insert(call_id.to_string(), tx);
    }

    fn unregister(&self, call_id: &str) {
        self.lock().remove(call_id);
    }

    /// Whether `call_id` is a pending child confirmation.
    pub fn routes(&self, call_id: &str) -> bool {
        self.lock().contains_key(call_id)
    }

    /// Deliver a reply to the child parked on `call_id`. Returns `false` when
    /// the id is not routed here (caller falls back to the parent channel).
    pub fn deliver(&self, call_id: &str, response: ConfirmResponse) -> bool {
        match self.lock().get(call_id) {
            Some(tx) => tx.send(response).is_ok(),
            None => false,
        }
    }

    /// Wake every child parked on a confirmation with a denial (parent turn
    /// cancelled / wound down): the cancel flag alone cannot interrupt a
    /// blocked `recv()`.
    pub fn deny_all(&self) {
        for tx in self.lock().values() {
            let _ = tx.send(ConfirmResponse::Deny);
        }
    }
}

/// Everything needed to run `task` calls for one parent turn. Construct at
/// the turn spawn site and hand to the loop via
/// [`TurnParams::task_runner`](crate::agent_loop::TurnParams).
pub struct TaskRunner {
    pub llm: LlmClient,
    pub registry: Arc<ToolRegistry>,
    pub skills: Option<Arc<SkillRegistry>>,
    pub blocklist: Vec<String>,
    pub configured_context_tokens: usize,
    pub trust_all: bool,
    /// Parent session's full-auto flag (shared): a child inherits the parent's
    /// live approval mode.
    pub auto_confirm: Arc<AtomicBool>,
    /// Child transcript persistence (hidden sessions, `origin = "task"`).
    /// `None` = no persistence (e.g. one-shot CLI).
    pub store: Option<Arc<crate::web::store::SqliteStore>>,
    /// The parent's system prompt; the child gets it plus a sub-agent contract
    /// section (see [`subagent_system_prompt`]).
    pub system_prompt: String,
    /// Default model for children (empty = the parent turn's model).
    pub subagent_model: String,
    /// Default reasoning-effort level for children (empty = inherit the
    /// parent client's). Delegated work is often mechanical, where a lighter
    /// level is much faster.
    pub subagent_reasoning_effort: String,
    /// Per-task wall-clock budget in seconds (0 = no limit — discouraged).
    pub timeout_secs: u64,
    /// Fan-out width: how many children run concurrently; the rest queue.
    pub max_parallel: usize,
    /// Confirm reply routing, shared with the frontend delivery layer.
    pub confirm_router: Arc<ConfirmRouter>,
}

/// Structured outcome of one child task, serialized into the `task` tool
/// result the parent model consumes.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskReport {
    /// `true` when the child ran to a normal `AssistantDone`.
    pub ok: bool,
    /// The child's final answer (or partial progress on timeout/cancel).
    pub result: String,
    /// Error message when `ok == false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Hidden session holding the full child transcript (when persisted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_session_id: Option<String>,
    pub elapsed_ms: u64,
    pub timed_out: bool,
    pub cancelled: bool,
}

impl TaskReport {
    fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"ok\":false}".into())
    }
}

/// The synthetic `task` tool schema advertised to the LLM (only when a
/// [`TaskRunner`] is configured — never inside a child).
pub fn task_definition() -> ToolDefinition {
    ToolDefinition::new(
        "task",
        "Delegate a self-contained piece of work to a sub-agent that runs in its own \
         fresh context and reports back one final result. Use it to (a) fan out \
         INDEPENDENT chunks of work in parallel — issue every task call in the SAME \
         message, they run concurrently — or (b) keep a large exploration (many tool \
         calls, long outputs) out of this conversation's context. \
         The sub-agent sees ONLY your `prompt`: it has no access to this conversation, \
         so the prompt must be complete and self-contained (background, exact goal, \
         constraints, and what the final report must contain). Do NOT delegate \
         trivial work (a single tool call is cheaper done directly), do NOT create \
         tasks that depend on each other's output in the same batch (run dependent \
         steps sequentially yourself), and TRUST the report — do not redo the \
         sub-agent's work. Not available inside a sub-agent (no nesting).",
        ToolParameters::object(
            HashMap::from([
                (
                    "description".into(),
                    ToolParameter::string(
                        "3-8 word summary of the task, shown to the user as progress",
                    ),
                ),
                (
                    "prompt".into(),
                    ToolParameter::string(
                        "complete, self-contained instructions for the sub-agent: \
                         background, exact goal, constraints, and what to report back",
                    ),
                ),
                (
                    "skill".into(),
                    ToolParameter::string(
                        "optional: skill name (from the skills manifest) the sub-agent \
                         starts with — pick the one matching the task domain",
                    ),
                ),
                (
                    "model".into(),
                    ToolParameter::string(
                        "optional: model override for this task (default: the \
                         configured sub-agent model)",
                    ),
                ),
                (
                    "timeout_secs".into(),
                    ToolParameter::integer(
                        "optional: wall-clock budget in seconds for this task \
                         (default: the configured sub-agent timeout; clamped to \
                         30-3600). Raise it for tasks known to be large — e.g. \
                         a whole-package deep review needs ~1800.",
                    ),
                ),
                (
                    "reasoning_effort".into(),
                    ToolParameter::string(
                        "optional: reasoning-effort level for this task \
                         (provider-specific, e.g. low/high/max; default: the \
                         configured sub-agent level). Use a lighter level for \
                         mechanical work like translation or bulk edits.",
                    ),
                ),
            ]),
            vec!["description".into(), "prompt".into()],
        ),
    )
}

/// The child's system prompt: the parent persona plus the sub-agent contract.
fn subagent_system_prompt(parent_prompt: &str) -> String {
    format!(
        "{parent_prompt}\n\n\
         ## Sub-agent contract\n\
         You are a sub-agent executing ONE delegated task. Work autonomously: \
         do not ask the user questions — make reasonable assumptions and note \
         them in your report. When done, end with a final message that is a \
         complete, self-contained report for the delegating agent: what you \
         did, what you found (with concrete evidence: paths, values, outputs), \
         and anything that failed or was skipped. That final message is the \
         ONLY thing the delegating agent receives. If told your time budget \
         is nearly exhausted, stop exploring IMMEDIATELY and write that final \
         report from what you already have — a partial report beats none."
    )
}

/// Poll cadence for propagating the parent's cancel flag into children (the
/// flag is a plain `AtomicBool` — there is nothing to `await` on).
const PARENT_CANCEL_POLL_MS: u64 = 200;
/// Clamp bounds for the per-task `timeout_secs` argument.
const MIN_TASK_TIMEOUT_SECS: u64 = 30;
const MAX_TASK_TIMEOUT_SECS: u64 = 3600;
/// After cancel/timeout is signalled, how long a child gets to wind down
/// before its driver stops pumping events and aborts it.
const CANCEL_GRACE_SECS: u64 = 30;
/// Cap on the soft-deadline margin (SIGTERM before SIGKILL): this long before
/// the hard budget the child is steered to stop exploring and write its final
/// report, so hitting the budget salvages a report instead of discarding the
/// work. Actual margin is `min(60s, budget / 5)`; see [`wrap_up_margin_secs`].
const WRAP_UP_MAX_MARGIN_SECS: u64 = 60;

/// The wrap-up nudge, injected as a plain user message at the child's next
/// round boundary (a child wedged inside one long tool call or LLM stream
/// never sees it — the hard deadline still applies).
const WRAP_UP_STEER: &str =
    "Your time budget is nearly exhausted. Stop exploring and stop calling tools NOW; \
     write your complete final report from what you already have.";

/// Soft-deadline margin before the hard budget. `0` (budgets under 5s, or no
/// budget at all) disables the wrap-up nudge.
fn wrap_up_margin_secs(timeout_secs: u64) -> u64 {
    (timeout_secs / 5).min(WRAP_UP_MAX_MARGIN_SECS)
}

/// One `task` tool call, extracted by the loop.
pub struct TaskCall {
    /// The parent `task` tool_call id — also the `Subagent` envelope tag.
    pub call_id: String,
    pub args: serde_json::Value,
}

impl TaskRunner {
    /// Run a batch of `task` calls concurrently (bounded by `max_parallel`,
    /// allSettled semantics: one child failing never aborts the others) and
    /// return `(call_id, result_json, success)` per call, in input order.
    pub async fn run_batch(
        self: &Arc<Self>,
        calls: Vec<TaskCall>,
        parent_event_tx: &mpsc::UnboundedSender<AgentEvent>,
        parent_cancel: Arc<AtomicBool>,
    ) -> Vec<(String, String, bool)> {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(self.max_parallel.max(1)));
        // A FuturesUnordered where upstream uses a JoinSet: `tokio::spawn` wants
        // a tokio runtime, and the executor here is the browser's microtask
        // queue. Driving the drivers as one future is the same concurrency --
        // wasm is single-threaded, so upstream's tasks were never parallel on
        // this target either -- and the same allSettled semantics. What it gives
        // up is isolation: a panicking driver takes the parent turn with it,
        // where a JoinSet would have reported it as a join error.
        let mut drivers = futures::stream::FuturesUnordered::new();
        let mut order: Vec<String> = Vec::with_capacity(calls.len());

        for call in calls {
            order.push(call.call_id.clone());
            let runner = Arc::clone(self);
            let event_tx = parent_event_tx.clone();
            let cancel = parent_cancel.clone();
            let semaphore = semaphore.clone();
            drivers.push(async move {
                // Buffered fan-out: acquire a slot; queued tasks simply wait.
                let _permit = semaphore.acquire_owned().await;
                let call_id = call.call_id.clone();
                let report = runner.run_one(call, &event_tx, cancel).await;
                (call_id, report)
            });
        }

        let mut by_id: HashMap<String, TaskReport> = HashMap::new();
        while let Some((call_id, report)) = futures::StreamExt::next(&mut drivers).await {
            by_id.insert(call_id, report);
        }

        // The "driver crashed" fallback below is kept even though a driver can
        // no longer fail to report: the batch still owes an answer per call.
        order
            .into_iter()
            .map(|call_id| {
                let report = by_id.remove(&call_id).unwrap_or(TaskReport {
                    ok: false,
                    result: String::new(),
                    error: Some("task driver crashed before reporting".into()),
                    transcript_session_id: None,
                    elapsed_ms: 0,
                    timed_out: false,
                    cancelled: false,
                });
                let ok = report.ok;
                (call_id, report.to_json(), ok)
            })
            .collect()
    }

    /// Run one child task to completion (or timeout/cancel) and report.
    async fn run_one(
        &self,
        call: TaskCall,
        parent_event_tx: &mpsc::UnboundedSender<AgentEvent>,
        parent_cancel: Arc<AtomicBool>,
    ) -> TaskReport {
        let started = wasmtimer::std::Instant::now();
        let fail = |msg: &str| TaskReport {
            ok: false,
            result: String::new(),
            error: Some(msg.to_string()),
            transcript_session_id: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            timed_out: false,
            cancelled: false,
        };

        let prompt = call
            .args
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if prompt.is_empty() {
            return fail(
                "[NO_RETRY] task.prompt is required and must be a complete, \
                 self-contained instruction — nothing was executed.",
            );
        }

        // ── Optional skill persona: staged exactly like an explicit user
        // activation (skill body as input context + allow-list seed). ──
        let skill_arg = call
            .args
            .get("skill")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut active_skill: Option<ActiveSkill> = None;
        let mut skill_message: Option<ChatMessage> = None;
        if let Some(name) = skill_arg {
            let Some(reg) = self.skills.as_ref() else {
                return fail(&format!(
                    "[NO_RETRY] task.skill '{name}' requested but no skill registry \
                     is available — re-issue without `skill`."
                ));
            };
            // Model-driven activation mirrors read_skill: non-user-invocable
            // skills are fair game for a sub-agent.
            match load_skill(reg, name, false) {
                Ok(loaded) => {
                    skill_message = Some(ChatMessage::skill_context(
                        &loaded.active.name,
                        &loaded.content,
                    ));
                    active_skill = Some(loaded.active);
                }
                Err(e) => {
                    return fail(&format!(
                        "[NO_RETRY] task.skill: {e}. Use a name from the skills \
                         manifest, or omit `skill`."
                    ));
                }
            }
        }

        // Per-task wall-clock budget: explicit arg (clamped to a sane range)
        // > the configured sub-agent timeout.
        let timeout_secs = effective_timeout_secs(&call.args, self.timeout_secs);

        // Per-task model: explicit arg > configured sub-agent model > parent's.
        let model_arg = call
            .args
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                let m = self.subagent_model.trim();
                (!m.is_empty()).then(|| m.to_string())
            });
        let llm = match model_arg {
            Some(m) => self.llm.clone().with_model(&m),
            None => self.llm.clone(),
        };
        // Per-task reasoning effort: explicit arg > configured sub-agent
        // level > inherit the parent client's (the clone already carries it).
        let effort_arg = call
            .args
            .get("reasoning_effort")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                let e = self.subagent_reasoning_effort.trim();
                (!e.is_empty()).then(|| e.to_string())
            });
        let llm = match effort_arg {
            Some(e) => llm.with_reasoning_effort(Some(e)),
            None => llm,
        };

        // Fresh, self-contained child context.
        let mut initial: Vec<ChatMessage> =
            vec![ChatMessage::system(&subagent_system_prompt(&self.system_prompt))];
        if let Some(msg) = skill_message {
            initial.push(msg);
        }
        initial.push(ChatMessage::user(&prompt));

        let child_session_id = format!("task-{}", uuid::Uuid::new_v4());
        let (child_event_tx, child_event_rx) = mpsc::unbounded_channel::<AgentEvent>();
        let (child_confirm_tx, child_confirm_rx) = mpsc::unbounded_channel::<ConfirmResponse>();
        // Steer channel into the child, used for the wrap-up nudge when the
        // soft deadline fires (and nothing else — the user cannot steer a
        // sub-agent directly).
        let (child_steer_tx, child_steer_rx) = mpsc::unbounded_channel::<String>();
        let child_cancel = Arc::new(AtomicBool::new(false));

        let mut params = TurnParams::new(
            llm,
            self.registry.clone(),
            initial,
            child_event_tx,
            child_confirm_rx,
        );
        // ask_user_rx stays None: a sub-agent never interrogates the user —
        // the loop's headless branch auto-picks defaults if a skill's flow
        // somehow reaches ask_user (the tool is not advertised to children).
        params.cancel_flag = child_cancel.clone();
        params.configured_context_tokens = self.configured_context_tokens;
        params.blocklist = self.blocklist.clone();
        params.trust_all = self.trust_all;
        params.auto_confirm = Some(self.auto_confirm.clone());
        params.skills = self.skills.clone();
        params.active_skill = active_skill.clone();
        params.session_id = Some(child_session_id.clone());
        params.steer_rx = Some(child_steer_rx);
        // Children archive before compaction too (into their own hidden
        // transcript session).
        params.store = self.store.clone();
        // No task_runner: children cannot spawn grandchildren (depth cap).

        let child = spawn_child_turn(params);

        // Expose this child's cancel flag for per-task cancellation (e.g. the
        // web UI's per-subagent cancel button) while it is live.
        self.confirm_router
            .register_cancel(&call.call_id, child_cancel.clone());

        // ── Drive the child: pump + wrap events, route confirms, persist the
        // transcript, enforce timeout and parent-cancel propagation. ──
        let outcome = self
            .drive_child(
                &call.call_id,
                &child_session_id,
                active_skill.as_ref(),
                timeout_secs,
                child_event_rx,
                child_confirm_tx,
                child_steer_tx,
                child_cancel.clone(),
                parent_cancel,
                parent_event_tx,
            )
            .await;
        self.confirm_router.unregister_cancel(&call.call_id);
        // Normally the event channel closing means the child task is done;
        // abort is a no-op then, and the hard stop for an overstayed grace.
        child.abort();

        TaskReport {
            ok: outcome.ok,
            result: outcome.result,
            error: outcome.error,
            // Only advertise the transcript id if at least one SessionSync
            // actually reached the store — a child that died before its first
            // sync has no transcript, and a dangling id sends the parent (or a
            // human) hunting for a session that does not exist.
            transcript_session_id: outcome.synced.then_some(child_session_id),
            elapsed_ms: started.elapsed().as_millis() as u64,
            timed_out: outcome.timed_out,
            cancelled: outcome.cancelled,
        }
    }

    /// Pump one child's events until it finishes (or grace after
    /// cancel/timeout runs out). Returns the child's outcome.
    #[allow(clippy::too_many_arguments)]
    async fn drive_child(
        &self,
        task_id: &str,
        child_session_id: &str,
        active_skill: Option<&ActiveSkill>,
        timeout_secs: u64,
        mut child_event_rx: mpsc::UnboundedReceiver<AgentEvent>,
        child_confirm_tx: mpsc::UnboundedSender<ConfirmResponse>,
        child_steer_tx: mpsc::UnboundedSender<String>,
        child_cancel: Arc<AtomicBool>,
        parent_cancel: Arc<AtomicBool>,
        parent_event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> ChildOutcome {
        let router = &self.confirm_router;
        let mut outcome = ChildOutcome::default();
        // The skill steering the child right now (it may read_skill mid-task);
        // persisted with the transcript.
        let mut current_skill: Option<ActiveSkill> = active_skill.cloned();
        let mut last_context: Vec<ChatMessage> = Vec::new();
        // Ids of child confirms currently presented to the user, and the
        // serialization permit held while one is on screen.
        let mut presented_confirms: std::collections::HashSet<String> = Default::default();
        let mut confirm_permit: Option<tokio::sync::OwnedSemaphorePermit> = None;

        let timeout = wasmtimer::tokio::sleep(std::time::Duration::from_secs(
            // A day, where upstream says u64::MAX / 2. A browser timer takes an
            // i32 of milliseconds, and wasmtimer turns anything longer into
            // setTimeout(0) -- which fires at once, finds the deadline still in
            // the future and reschedules, i.e. spins a core. Nothing here lives
            // for a day: the worker holding this dies with its document.
            if timeout_secs == 0 { 86_400 } else { timeout_secs },
        ));
        tokio::pin!(timeout);
        // Soft deadline (SIGTERM before SIGKILL): `margin` before the hard
        // budget, nudge the child — via its steer channel — to stop working
        // and write the final report, so the budget salvages a report instead
        // of discarding the work. The hard deadline below is untouched: the
        // task still never exceeds `timeout_secs`. Disabled arms park on the
        // same one-day sleep as `timeout` above (browser i32-millis timers).
        let wrap_up_margin = wrap_up_margin_secs(timeout_secs);
        let wrap_up_enabled = timeout_secs > 0 && wrap_up_margin > 0;
        let wrap_up = wasmtimer::tokio::sleep(std::time::Duration::from_secs(
            if wrap_up_enabled { timeout_secs - wrap_up_margin } else { 86_400 },
        ));
        tokio::pin!(wrap_up);
        let mut wrap_up_sent = false;
        let mut cancel_poll =
            wasmtimer::tokio::interval(std::time::Duration::from_millis(PARENT_CANCEL_POLL_MS));
        // Armed once cancel/timeout was signalled: the child gets a grace
        // window to wind down (synthesize tool results, sync) before the
        // driver stops pumping.
        let grace = wasmtimer::tokio::sleep(std::time::Duration::from_secs(CANCEL_GRACE_SECS));
        tokio::pin!(grace);
        let mut winding_down = false;

        let signal_cancel = |child_cancel: &Arc<AtomicBool>,
                             child_confirm_tx: &mpsc::UnboundedSender<ConfirmResponse>| {
            child_cancel.store(true, Ordering::Relaxed);
            // Wake a child parked on a confirmation — the flag alone cannot
            // interrupt a blocked recv().
            let _ = child_confirm_tx.send(ConfirmResponse::Deny);
        };

        loop {
            tokio::select! {
                evt = child_event_rx.recv() => {
                    let Some(evt) = evt else { break }; // child done: channel closed
                    match &evt {
                        AgentEvent::ConfirmTool { id, .. } => {
                            // Serialize confirm presentation across children,
                            // register the reply route, then forward UNWRAPPED
                            // so existing confirm UIs work untouched.
                            let permit = router
                                .confirm_gate
                                .clone()
                                .acquire_owned()
                                .await
                                .ok();
                            confirm_permit = permit;
                            router.register(id, child_confirm_tx.clone());
                            presented_confirms.insert(id.clone());
                            let _ = parent_event_tx.send(evt.clone());
                            continue;
                        }
                        AgentEvent::ToolCallResult { id, .. } if presented_confirms.remove(id) => {
                            // The confirmed (or denied) call resolved: release
                            // the route + the presentation slot, and forward
                            // the result unwrapped too, so the confirm UI that
                            // showed the unwrapped request also sees its
                            // resolution signal.
                            router.unregister(id);
                            confirm_permit = None;
                            let _ = parent_event_tx.send(evt.clone());
                            continue;
                        }
                        AgentEvent::SkillActivated { name, allowed_tools } => {
                            current_skill = Some(ActiveSkill {
                                name: name.clone(),
                                allowed_tools: allowed_tools.clone(),
                            });
                        }
                        AgentEvent::SkillDeactivated => {
                            current_skill = None;
                        }
                        AgentEvent::SessionSync { full_context, .. } => {
                            last_context = full_context.clone();
                            if let Some(store) = &self.store {
                                store.save_async(
                                    child_session_id,
                                    full_context,
                                    "task",
                                    current_skill.as_ref(),
                                );
                                outcome.synced = true;
                            }
                        }
                        AgentEvent::AssistantDone { .. } => {
                            outcome.ok = true;
                            outcome.result = final_answer(&last_context);
                        }
                        AgentEvent::Error(e) => {
                            outcome.ok = false;
                            outcome.error = Some(e.clone());
                            outcome.result = final_answer(&last_context);
                        }
                        _ => {}
                    }
                    let _ = parent_event_tx.send(AgentEvent::Subagent {
                        task_id: task_id.to_string(),
                        event: Box::new(evt),
                    });
                }
                _ = &mut wrap_up, if wrap_up_enabled && !wrap_up_sent && !winding_down => {
                    wrap_up_sent = true;
                    log::info!(
                        "task {task_id}: {wrap_up_margin}s of the {timeout_secs}s budget left \
                         — steering child to wrap up"
                    );
                    let _ = child_steer_tx.send(WRAP_UP_STEER.to_string());
                }
                _ = &mut timeout, if !winding_down => {
                    log::warn!(
                        "task {task_id}: wall-clock timeout ({}s) — cancelling child",
                        timeout_secs
                    );
                    outcome.timed_out = true;
                    winding_down = true;
                    grace.as_mut().reset(
                        wasmtimer::std::Instant::now()
                            + std::time::Duration::from_secs(CANCEL_GRACE_SECS),
                    );
                    signal_cancel(&child_cancel, &child_confirm_tx);
                }
                _ = cancel_poll.tick(), if !winding_down => {
                    // `child_cancel` can also be set externally (per-task
                    // cancel via `ConfirmRouter::cancel_task`); both sources
                    // fold into the same wind-down + partial-progress report.
                    let parent = parent_cancel.load(Ordering::Relaxed);
                    if parent || child_cancel.load(Ordering::Relaxed) {
                        if parent {
                            log::info!("task {task_id}: parent cancelled — cancelling child");
                        } else {
                            log::info!("task {task_id}: cancelled individually — winding down child");
                        }
                        outcome.cancelled = true;
                        winding_down = true;
                        grace.as_mut().reset(
                            wasmtimer::std::Instant::now()
                                + std::time::Duration::from_secs(CANCEL_GRACE_SECS),
                        );
                        signal_cancel(&child_cancel, &child_confirm_tx);
                    }
                }
                _ = &mut grace, if winding_down => {
                    log::warn!("task {task_id}: child ignored cancel for {CANCEL_GRACE_SECS}s — abandoning");
                    break;
                }
            }
        }

        // Release any confirm route/slot still held (child died mid-confirm).
        for id in presented_confirms.drain() {
            router.unregister(&id);
        }
        drop(confirm_permit);

        if outcome.timed_out {
            outcome.ok = false;
            let partial = final_answer(&last_context);
            outcome.result = if partial.is_empty() {
                String::new()
            } else {
                format!("[partial progress before timeout]\n{partial}")
            };
            outcome.error = Some(format!(
                "task exceeded its {}s wall-clock budget and was cancelled",
                timeout_secs
            ));
        } else if outcome.cancelled {
            outcome.ok = false;
            let partial = final_answer(&last_context);
            outcome.result = if partial.is_empty() {
                String::new()
            } else {
                format!("[partial progress before cancel]\n{partial}")
            };
            outcome.error = Some("cancelled by the user".into());
        } else if !outcome.ok && outcome.error.is_none() {
            // Channel closed without AssistantDone/Error: the child task died.
            outcome.error = Some("sub-agent ended without a result".into());
            outcome.result = final_answer(&last_context);
        }
        outcome
    }
}

/// Spawn a child turn. Deliberately a plain (non-async) fn: the child runs
/// the same `run_agent_turn` as its parent, and spawning it INSIDE the
/// parent's async call graph would make the parent future's auto-trait
/// (`Send`) inference recursive (parent ⊃ run_batch ⊃ run_one ⊃ child turn ⊃
/// parent). Hoisting the spawn into a named fn moves the `Send` obligation
/// out of every opaque future, breaking the cycle.
///
/// Here the future is boxed as a `dyn Future` too, which ends that chain
/// outright rather than only moving it: a generic `spawn_local` would still have
/// to monomorphize the same ring. The handle is an `AbortHandle` because
/// `spawn_local` returns nothing to cancel with, and `abort()` is all the call
/// site asks of it.
fn spawn_child_turn(params: TurnParams) -> futures::future::AbortHandle {
    let child: std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> =
        Box::pin(run_agent_turn(params));
    let (child, handle) = futures::future::abortable(child);
    wasm_bindgen_futures::spawn_local(async move {
        let _ = child.await;
    });
    handle
}

#[derive(Default)]
struct ChildOutcome {
    ok: bool,
    result: String,
    error: Option<String>,
    timed_out: bool,
    cancelled: bool,
    /// True once at least one `SessionSync` was handed to the store — the
    /// gate for advertising `transcript_session_id` in the report.
    synced: bool,
}

/// Per-task wall-clock budget: the `timeout_secs` argument (clamped to
/// [`MIN_TASK_TIMEOUT_SECS`]..=[`MAX_TASK_TIMEOUT_SECS`]) or the configured
/// sub-agent default.
fn effective_timeout_secs(args: &serde_json::Value, default_secs: u64) -> u64 {
    args.get("timeout_secs")
        .and_then(|v| v.as_u64())
        .map(|s| s.clamp(MIN_TASK_TIMEOUT_SECS, MAX_TASK_TIMEOUT_SECS))
        .unwrap_or(default_secs)
}

/// The child's final report: the last assistant message with actual content.
fn final_answer(context: &[ChatMessage]) -> String {
    context
        .iter()
        .rev()
        .find(|m| {
            matches!(m.role, Role::Assistant)
                && m.content.as_deref().is_some_and(|c| !c.trim().is_empty())
        })
        .and_then(|m| m.content.clone())
        .unwrap_or_default()
}
