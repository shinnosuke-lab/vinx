//! The engine, driven from JavaScript.
//!
//! This is what the Dedicated Worker talks to. It owns the session store, the
//! tool registry and any turn currently in flight, and it speaks the same SSE
//! frame vocabulary as agent-core's HTTP layer — `session`, `history`, then live
//! frames, then `done` or `error`. Emitting the identical wire format is what
//! lets the stock chat UI run against this with only a `fetch` shim in between.
//!
//! ## One difference from the server, worth knowing
//!
//! Upstream supports attaching to a turn that started before the browser
//! connected, because the server outlives the page. Nothing here does: a
//! Dedicated Worker dies with its document, so a reload ends the turn. The
//! replay machinery below is therefore only reachable *within* one page
//! lifetime — the SPA navigating away from a running chat and back, which the
//! session sidebar makes easy to do. That is a real case, just a narrower one.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

use crate::agent_loop::{run_agent_turn, TurnParams};
use crate::agent_task::{ConfirmRouter, TaskRunner};
use crate::client::LlmClient;
use crate::event::{AgentEvent, AskAnswer, AskUserResponse, ConfirmResponse};
use crate::os::SafePathAllowList;
use crate::skill::{
    prepare_user_skill_activation, resolve_active_skill, ActiveSkill, SkillAction, SkillRegistry,
};
use crate::sse;
use crate::store::SessionStore;
use crate::tool::ToolRegistry;
use crate::turn::{stage_turn, TurnLedger};
use crate::types::{Attachment, ChatMessage, Role};

/// How many frames of a running turn are kept for a late viewer.
///
/// A turn that streams more than this drops its oldest frames and the viewer is
/// told the transcript is incomplete rather than being handed a plausible-looking
/// one with a hole in it.
const TAIL_LIMIT: usize = 2048;

/// How long a fetched model list is reused, matching upstream's
/// `MODELS_CACHE_TTL`. The list changes about as often as a provider ships a
/// model, and the UI asks for it on every mount.
const MODELS_CACHE_TTL_MS: f64 = 60_000.0;

/// Where a turn's frames go: the JS side, tagged with the stream that asked.
type Sink = js_sys::Function;

/// What `configure` was told, kept so a turn asking for a different model can
/// rebuild the client without the page having to re-send the key.
struct Endpoint {
    base_url: String,
    api_key: String,
    model: String,
}

/// What rides with one message, from `POST /api/chat`.
///
/// The UI sends the model with the message rather than as a setting, because
/// switching models is a property of the turn: the picker's choice applies to
/// what you are about to ask, not to the endpoint.
#[derive(Default, serde::Deserialize)]
struct SendOptions {
    #[serde(default)]
    model: Option<String>,
    /// Per-turn reasoning-effort override (the composer's effort switcher).
    #[serde(default)]
    reasoning_effort: Option<String>,
    /// Files uploaded before the message was sent. An attachment is a message
    /// in its own right — `text` may be empty when there is one.
    #[serde(default)]
    attachments: Vec<Attachment>,
    /// Turning a skill on or off by name, from the `/` palette. Deterministic,
    /// unlike asking the model to call `read_skill` and hoping it does.
    #[serde(default)]
    skill_action: Option<SkillAction>,
    /// Park the message behind a running turn instead of being refused. The
    /// composer offers this as "send when it finishes", next to "send now",
    /// which is [`AgentHost::steer`] instead.
    #[serde(default)]
    queue: bool,
    /// With a turn in flight: wind it down (same machinery as cancel, but the
    /// queue survives) and park this message at the queue FRONT, so it starts
    /// the moment the turn ends — the main chat's "send now". Idle sessions
    /// behave like a plain send. Wins over `queue`, as upstream's does.
    #[serde(default)]
    interrupt: bool,
    /// Which surface the message came from — `web` (the main chat) unless the
    /// sender says otherwise (`terminal` for the console's assistant panel).
    /// Recorded on the session's first insert and never rewritten, so the
    /// sessions page can say where a conversation was started.
    #[serde(default)]
    origin: Option<String>,
}

/// One turn-start request, with its attachments already resolved.
///
/// Upstream's `TurnStart`, and here for the same reason: `POST /api/chat` and
/// the queue drain at the end of a turn both start turns, and a queued message
/// has to run exactly as it would have if it had been sent by hand.
struct TurnStart {
    text: String,
    model: Option<String>,
    /// Per-turn reasoning-effort override from the composer's effort switcher;
    /// `None` keeps the configured default.
    reasoning_effort: Option<String>,
    attachments: Vec<Attachment>,
    skill_action: Option<SkillAction>,
    queue: bool,
    /// See [`SendOptions::interrupt`].
    interrupt: bool,
    /// See [`SendOptions::origin`]; already defaulted to `web` by `send`.
    origin: String,
}

/// A message parked behind a running turn.
///
/// Upstream's `web::session::QueuedTurn`, not vendored: it belongs to the host
/// layer, which is written here rather than copied.
struct QueuedTurn {
    /// Stable id, upstream's `alloc_queue_id`: what `queue/remove` and
    /// `queue/edit` address, kept for the item's whole parked life.
    id: u64,
    message: String,
    attachments: Vec<Attachment>,
    model: Option<String>,
    /// The effort chosen when the message was written rides with it through
    /// the queue, exactly like the model override does.
    reasoning_effort: Option<String>,
}

/// Nothing to report beyond having worked. An object rather than `()` so the
/// envelope has somewhere to put its flag; see [`crate::answer::envelope`].
#[derive(serde::Serialize)]
struct Empty {}

/// One stream watching one session.
struct Viewer {
    session: String,
    /// Session-scoped rather than turn-scoped: the stream outlives the turn it
    /// attached to, and every later turn opens with a fresh snapshot down the
    /// same connection. That is what lets the UI keep one feed per open
    /// conversation and never decide when to re-attach — a queued follow-up
    /// starting on its own is otherwise invisible to it.
    follow: bool,
}

/// A turn in flight, and everything needed to talk to it.
struct Turn {
    confirm_tx: mpsc::UnboundedSender<ConfirmResponse>,
    ask_tx: mpsc::UnboundedSender<AskUserResponse>,
    /// Where a message typed while this turn runs goes when the user picks
    /// "send now": the loop appends it at its next round boundary, so the model
    /// sees it on its next request instead of after the turn.
    steer_tx: mpsc::UnboundedSender<String>,
    /// Confirm-reply routing for this turn's sub-agents. A child's `confirm`
    /// frame is forwarded to the UI unwrapped — deliberately, so the existing
    /// confirm bar needs no changes — which means the reply comes back looking
    /// exactly like one meant for the parent, and only the tool-call id can
    /// tell them apart.
    router: Arc<ConfirmRouter>,
    cancel: Arc<AtomicBool>,
    /// What this turn staged beyond committed history: the user's message, and
    /// the skill context when one was activated with it.
    ///
    /// The store only advances when the turn ends, so between `send` and that
    /// write these messages exist nowhere else. `attach` appends them to the
    /// history it read, which is what stops the `history` frame — the UI
    /// replaces its transcript wholesale on one — from erasing the message the
    /// user just watched itself send. Upstream's `TurnFeed::staged_tail`, and
    /// the same reason.
    staged_tail: Vec<ChatMessage>,
    /// Frames emitted so far, replayed to anyone who attaches mid-turn.
    tail: VecDeque<String>,
    /// Whether `tail` has dropped anything.
    lossy: bool,
    /// Stream ids currently watching.
    viewers: Vec<String>,
}

struct Inner {
    sink: Sink,
    /// Shared rather than owned outright because a turn's sub-agents write their
    /// own transcripts through it; see [`TaskRunner::store`].
    store: Arc<SessionStore>,
    registry: Arc<ToolRegistry>,
    /// What is installed under `skills/`. Hot-reloads off the workspace, so a
    /// skill imported mid-session is available to the next turn.
    skills: Arc<SkillRegistry>,
    /// Directories the user allowed writes into, shared with the file tools so
    /// growing it here silently downgrades their risk there.
    safe_paths: Arc<SafePathAllowList>,
    /// What the device said about itself. Empty until tools are installed; the
    /// filesystem half of the briefing is added at turn time either way.
    system_prompt: RefCell<String>,
    /// Whether the device's file tools replaced the workspace's (the in-page
    /// VM's do). Decides which filesystem story the briefing tells, and it is
    /// set by the same install that retires the vfs-only leftovers — one fact,
    /// one place.
    device_owns_files: std::cell::Cell<bool>,
    llm: RefCell<Option<LlmClient>>,
    endpoint: RefCell<Option<Endpoint>>,
    /// Configured default reasoning-effort level (settings page); empty = the
    /// provider profile's default. A per-turn override layers on top.
    reasoning_effort: RefCell<String>,
    /// Default effort for `task` sub-agents; empty = inherit the parent
    /// turn's. Delegated work is often mechanical, where lighter is faster.
    subagent_reasoning_effort: RefCell<String>,
    /// The last model list and when it was fetched; see [`MODELS_CACHE_TTL_MS`].
    models: RefCell<Option<(f64, Vec<String>)>>,
    turns: RefCell<HashMap<String, Turn>>,
    /// Messages parked behind a running turn, per session. Drained in order by
    /// the turn that was in the way, as it ends.
    ///
    /// Memory-only: a reload ends the turn they were waiting for, so there is
    /// nothing left for them to be behind.
    queued: RefCell<HashMap<String, VecDeque<QueuedTurn>>>,
    /// Id source for [`QueuedTurn::id`]. Upstream scopes it per session; one
    /// counter gives the same guarantee (an id never renames another parked
    /// item) without another map to clean up.
    next_queue_id: std::cell::Cell<u64>,
    /// Who is watching what. Kept for idle sessions too, which is what lets a
    /// turn started later find the viewers that were already there.
    attached: RefCell<HashMap<String, Viewer>>,
    /// Per-session full-auto, shared with whatever loop is running so a toggle
    /// mid-turn applies to the next tool call.
    ///
    /// Memory-only, as upstream's is: it dies with the page, never leaks to
    /// another session, and is never persisted. That is why "always allow"
    /// survives a second question in the same session but not a reload.
    auto: RefCell<HashMap<String, Arc<AtomicBool>>>,
}

impl Inner {
    /// Hand one frame to JS.
    fn emit(&self, stream_id: &str, frame: &str) {
        let _ = self
            .sink
            .call2(&JsValue::NULL, &stream_id.into(), &frame.into());
    }

    /// The session's full-auto flag, creating it if this is the first mention.
    ///
    /// Creating on demand is what lets the toggle be flipped before the first
    /// turn, which is when someone who already knows what they are doing flips
    /// it.
    fn auto_flag(&self, session_id: &str) -> Arc<AtomicBool> {
        self.auto
            .borrow_mut()
            .entry(session_id.to_string())
            .or_default()
            .clone()
    }

    /// Whether full-auto is on, without creating a flag for a session nobody
    /// has sent to. Reading is not a reason to remember the session.
    fn auto_state(&self, session_id: &str) -> bool {
        self.auto
            .borrow()
            .get(session_id)
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    }

    /// Streams currently watching a session, whether or not a turn is running.
    fn viewers_of(&self, session_id: &str) -> Vec<String> {
        self.attached
            .borrow()
            .iter()
            .filter(|(_, v)| v.session == session_id)
            .map(|(stream, _)| stream.clone())
            .collect()
    }

    /// The subset of those that expect a snapshot at every turn.
    fn followers_of(&self, session_id: &str) -> Vec<String> {
        self.attached
            .borrow()
            .iter()
            .filter(|(_, v)| v.session == session_id && v.follow)
            .map(|(stream, _)| stream.clone())
            .collect()
    }

    /// Publish to every viewer of a session, and remember it for late ones.
    fn publish(&self, session_id: &str, frame: String) {
        let viewers = {
            let mut turns = self.turns.borrow_mut();
            let Some(turn) = turns.get_mut(session_id) else {
                return;
            };
            if turn.tail.len() == TAIL_LIMIT {
                turn.tail.pop_front();
                turn.lossy = true;
            }
            turn.tail.push_back(frame.clone());
            turn.viewers.clone()
        };
        // Emitting outside the borrow: the sink calls into JS, and JS is free to
        // call back in (a `detach` from an unmounting component, say), which
        // would panic on a RefCell still held here.
        for v in viewers {
            self.emit(&v, &frame);
        }
    }

    /// Allocate an id for a message entering the queue.
    fn alloc_queue_id(&self) -> u64 {
        let id = self.next_queue_id.get() + 1;
        self.next_queue_id.set(id);
        id
    }

    /// The `queue` frame's payload: everything parked, in order.
    ///
    /// Always a full snapshot, as upstream's is — an empty `items` is how a
    /// cleared queue is expressed, so a client never has to track deltas. The
    /// message rides whole, not previewed: the strip's in-place editor needs
    /// the real text, and display truncation is CSS's job.
    fn queue_payload(&self, session_id: &str) -> serde_json::Value {
        let queued = self.queued.borrow();
        let items = queued
            .get(session_id)
            .map(|q| {
                q.iter()
                    .map(|i| {
                        serde_json::json!({
                            "id": i.id,
                            "message": i.message,
                            "attachments": i.attachments.len(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        serde_json::json!({ "items": items })
    }

    /// Tell every viewer of a session what is waiting behind its turn.
    ///
    /// Published rather than answered to whoever changed the queue, because two
    /// tabs on one conversation have to agree about what is parked.
    fn publish_queue(&self, session_id: &str) {
        let payload = self.queue_payload(session_id);
        self.publish(session_id, sse::frame("queue", payload));
    }
}

#[wasm_bindgen]
pub struct AgentHost {
    inner: Rc<Inner>,
}

#[wasm_bindgen]
impl AgentHost {
    /// Build a host whose sessions live only as long as the tab.
    ///
    /// This is the fallback, not the normal path — use [`open`] for a host that
    /// persists. It exists for tests, and for browsers that refuse IndexedDB
    /// (private windows, storage quota denials), where losing history on reload
    /// beats refusing to start.
    ///
    /// `sink` is called as `sink(stream_id, frame)` for every frame produced.
    /// Frames are complete SSE records, `event: ...\ndata: ...\n\n`, so the JS
    /// side never has to know the vocabulary.
    #[wasm_bindgen(constructor)]
    pub fn new(sink: Sink) -> Result<AgentHost, JsValue> {
        report_to_console();
        let store = crate::storage::open_ephemeral()
            .map_err(|e| JsValue::from_str(&format!("could not open the session store: {e}")))?;
        Ok(AgentHost::over(sink, store))
    }

    /// Point the host at a model endpoint. Must be called before the first turn.
    pub fn configure(&self, base_url: &str, api_key: &str, model: &str) {
        *self.inner.llm.borrow_mut() = Some(endpoint_client(base_url, api_key, model));
        *self.inner.endpoint.borrow_mut() = Some(Endpoint {
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
        });
        // Another endpoint advertises other models.
        *self.inner.models.borrow_mut() = None;
    }

    /// Configured default reasoning-effort levels, from the settings page:
    /// `effort` for the main turn, `subagent_effort` for `task` children
    /// (empty string = "inherit"/provider default). Applied at turn start, so
    /// there is no client to rebuild here.
    #[wasm_bindgen(js_name = setReasoningEffort)]
    pub fn set_reasoning_effort(&self, effort: &str, subagent_effort: &str) {
        *self.inner.reasoning_effort.borrow_mut() = effort.trim().to_string();
        *self.inner.subagent_reasoning_effort.borrow_mut() = subagent_effort.trim().to_string();
    }

    /// The models this endpoint advertises, as a JSON array.
    ///
    /// A failure is not an error here. Plenty of OpenAI-compatible endpoints do
    /// not implement `GET /models`, and the UI's answer to an empty list is to
    /// show the model as a read-only badge rather than a picker — which is the
    /// right outcome, and better than an error toast on every load.
    pub async fn models(&self) -> String {
        let now = js_sys::Date::now();
        if let Some((fetched_at, cached)) = self.inner.models.borrow().as_ref() {
            if now - fetched_at < MODELS_CACHE_TTL_MS {
                return serde_json::to_string(cached).unwrap_or_else(|_| "[]".to_string());
            }
        }

        // Cloned out of the RefCell before the await: holding a borrow across a
        // suspension point is how a later `configure` panics the host.
        let Some(llm) = self.inner.llm.borrow().clone() else {
            return "[]".to_string();
        };
        let models = llm.list_models().await.unwrap_or_else(|e| {
            log::warn!("could not list models: {e}");
            Vec::new()
        });

        *self.inner.models.borrow_mut() = Some((now, models.clone()));
        serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())
    }

    /// The whole `GET /api/models` body: the models list plus per-model
    /// capability records (`caps`) from the engine's [`crate::model_caps`]
    /// table. `caps` always includes the configured default model, even when
    /// the endpoint advertises nothing — the UI's effort switcher needs the
    /// record of the model it is actually going to send with.
    #[wasm_bindgen(js_name = modelsPayload)]
    pub async fn models_payload(&self) -> String {
        let models_json = self.models().await;
        let models: Vec<String> = serde_json::from_str(&models_json).unwrap_or_default();
        let default_model = self
            .inner
            .endpoint
            .borrow()
            .as_ref()
            .map(|e| e.model.clone())
            .unwrap_or_default();
        let mut caps = serde_json::Map::new();
        for name in models
            .iter()
            .map(String::as_str)
            .chain((!default_model.trim().is_empty()).then_some(default_model.as_str()))
        {
            if !caps.contains_key(name) {
                let value = serde_json::to_value(crate::model_caps::model_caps(name))
                    .unwrap_or(serde_json::Value::Null);
                caps.insert(name.to_string(), value);
            }
        }
        serde_json::json!({ "ok": true, "models": models, "caps": caps }).to_string()
    }

    /// Give the agent the device's capabilities.
    ///
    /// `payload` is what `GET /api/tools` answered; `endpoint` is where calls
    /// go, normally `/api/tools/call` on the page's own origin. Returns the
    /// names that were registered, so the caller can see what was rejected
    /// rather than wondering why the model never calls something.
    ///
    /// Registering the same tool twice is refused by the registry, so this is
    /// not idempotent — call it once, at startup.
    #[wasm_bindgen(js_name = installTools)]
    pub fn install_tools(&self, payload: &str, endpoint: &str) -> Result<Vec<String>, JsValue> {
        let payload: crate::tools::ToolsPayload = serde_json::from_str(payload)
            .map_err(|e| JsValue::from_str(&format!("could not read the tool list: {e}")))?;

        if !payload.system_prompt.is_empty() {
            *self.inner.system_prompt.borrow_mut() = payload.system_prompt.clone();
        }
        let installed = crate::tools::install(&self.inner.registry, payload, endpoint.to_string());
        // A device that ships read_file and write_file has taken the file-tool
        // names over (the registry replaces on collision). The two vfs-only
        // survivors would keep a second, invisible filesystem in the model's
        // toolbox — with the device present the workspace is UI plumbing, not
        // model surface — so they retire, and the briefing switches stories.
        let owns = ["read_file", "write_file"]
            .iter()
            .all(|n| installed.iter().any(|i| i == n));
        if owns {
            self.inner.registry.unregister("list_files");
            self.inner.registry.unregister("search_files");
        }
        self.inner.device_owns_files.set(owns);
        // Now that every tool is registered, a skill declaring `allowed-tools`
        // can be checked against what exists — which is how a typo in a skill
        // shows up as a diagnostic on the management page instead of as a tool
        // the model is told about and never finds.
        self.inner
            .skills
            .set_known_tools(self.inner.registry.names());
        Ok(installed)
    }

    /// Every tool the model currently holds, in registration order — the
    /// truth after collision replacement and retirement, where the device
    /// payload was only the offer. For tests and diagnostics.
    #[wasm_bindgen(js_name = toolNames)]
    pub fn tool_names(&self) -> Vec<String> {
        self.inner.registry.names()
    }

    // ── skills, mirroring /api/skills ──

    /// What is installed, plus whatever the last scan could not make sense of.
    pub fn skills(&self) -> String {
        crate::skills::listing(&self.inner.skills).to_string()
    }

    /// A skill's `SKILL.md` body or its `CHANGELOG.md`, whichever `which`
    /// names. Absent either way when the skill has none.
    #[wasm_bindgen(js_name = skillText)]
    pub fn skill_text(&self, name: &str, which: &str) -> Option<String> {
        match which {
            "changelog" => self.inner.skills.read_changelog(name),
            _ => self.inner.skills.read_body(name),
        }
    }

    /// A skill's icon bytes. The MIME type comes back from [`skill_icon_mime`].
    #[wasm_bindgen(js_name = skillIcon)]
    pub fn skill_icon(&self, name: &str) -> Option<Vec<u8>> {
        crate::skills::icon(&self.inner.skills, name).map(|(bytes, _)| bytes)
    }

    #[wasm_bindgen(js_name = skillIconMime)]
    pub fn skill_icon_mime(&self, name: &str) -> String {
        crate::skills::icon(&self.inner.skills, name)
            .map(|(_, mime)| mime.to_string())
            .unwrap_or_default()
    }

    /// Set one of the three per-skill switches.
    ///
    /// `enabled` governs local use — the model manifest and `read_skill`;
    /// `shared` governs distribution and `pinned` is ordering in the management
    /// page. They are independent, which is upstream's design and worth
    /// keeping: a skill can be published from here without being used here.
    #[wasm_bindgen(js_name = setSkillFlag)]
    pub fn set_skill_flag(&self, name: &str, flag: &str, value: bool) -> Result<(), JsValue> {
        match flag {
            "enabled" => self.inner.skills.set_enabled(name, value),
            "pinned" => self.inner.skills.set_pinned(name, value),
            "shared" => self.inner.skills.set_shared(name, value),
            other => return Err(JsValue::from_str(&format!("no such skill flag: {other}"))),
        }
        Ok(())
    }

    /// Install a skill package (a zip), replacing one of the same name.
    #[wasm_bindgen(js_name = importSkill)]
    pub fn import_skill(&self, bytes: &[u8]) -> String {
        crate::answer::envelope(crate::skills::import(&self.inner.skills, bytes))
    }

    /// What a package would install, without installing it.
    #[wasm_bindgen(js_name = previewSkill)]
    pub fn preview_skill(&self, bytes: &[u8]) -> String {
        crate::answer::envelope(crate::skills::preview(bytes))
    }

    #[wasm_bindgen(js_name = deleteSkill)]
    pub fn delete_skill(&self, name: &str) -> String {
        crate::answer::envelope(crate::skills::delete(&self.inner.skills, name).map(|()| Empty {}))
    }

    // ── themes, mirroring /api/themes ──

    /// The look the page should be wearing, as a list of nought or one.
    pub fn themes(&self) -> String {
        crate::themes::active().to_string()
    }

    /// The saved looks as cards — `GET /api/releases?kind=theme`.
    #[wasm_bindgen(js_name = savedThemes)]
    pub fn saved_themes(&self) -> String {
        crate::themes::saved().to_string()
    }

    /// Keep the look currently on screen under a name.
    #[wasm_bindgen(js_name = saveTheme)]
    pub fn save_theme(&self, name: &str, css: &str, js: &str, session_id: Option<String>) -> String {
        crate::answer::envelope(
            crate::themes::save(name, css, js, session_id.as_deref()).map(|()| Empty {}),
        )
    }

    /// Switch the injected look, or — with no name — go back to the built-in
    /// one without deleting anything.
    #[wasm_bindgen(js_name = activateTheme)]
    pub fn activate_theme(&self, name: Option<String>) -> String {
        let outcome = match name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(name) => crate::themes::activate(name),
            None => crate::themes::deactivate(),
        };
        crate::answer::envelope(outcome.map(|()| Empty {}))
    }

    #[wasm_bindgen(js_name = deleteTheme)]
    pub fn delete_theme(&self, name: &str) -> String {
        crate::answer::envelope(crate::themes::delete(name).map(|()| Empty {}))
    }

    /// Wire protocol version, so a client can refuse a host it does not
    /// understand rather than misreading frames.
    #[wasm_bindgen(js_name = protocolVersion)]
    pub fn protocol_version() -> u32 {
        sse::PROTOCOL_VERSION
    }

    /// Start watching a session.
    ///
    /// Emits `session` and `history` immediately, exactly as
    /// `GET /api/chat/stream/{id}` does. If a turn is running, the frames it has
    /// already produced are replayed and then live ones follow; if not, a `done`
    /// closes the sequence so the client is never left waiting on an idle
    /// session.
    ///
    /// `follow` makes the stream session-scoped instead of turn-scoped: it does
    /// not end at that `done`, and every later turn opens with a snapshot of its
    /// own. See [`Viewer::follow`].
    pub fn attach(&self, stream_id: &str, session_id: &str, follow: bool) {
        let inner = &self.inner;
        inner.attached.borrow_mut().insert(
            stream_id.to_string(),
            Viewer {
                session: session_id.to_string(),
                follow,
            },
        );
        if let Some(turn) = inner.turns.borrow_mut().get_mut(session_id) {
            turn.viewers.push(stream_id.to_string());
        }
        snapshot(inner, stream_id, session_id);
    }

    /// Stop sending frames to a stream. Idempotent.
    pub fn detach(&self, stream_id: &str) {
        let inner = &self.inner;
        let viewer = inner.attached.borrow_mut().remove(stream_id);
        if let Some(viewer) = viewer {
            if let Some(turn) = inner.turns.borrow_mut().get_mut(&viewer.session) {
                turn.viewers.retain(|v| v != stream_id);
            }
        }
    }

    /// Start a turn, answering immediately with a JSON ack:
    /// `{"accepted":true}`, or `{"accepted":false,"reason":...}` where the
    /// reason is `turn_in_flight`, `not_configured`, or why a named skill could
    /// not be activated. A message that was parked instead of started answers
    /// `{"accepted":true,"queued":true,"position":n}`.
    ///
    /// `options_json` carries what `POST /api/chat` sent beyond the message:
    /// the model for this turn, its attachments, any skill the `/` palette
    /// asked for, and whether it may queue. Unparseable options are taken as
    /// none — a turn that runs on the configured model is a better outcome than
    /// a turn refused over a field the UI added.
    ///
    /// Deliberately synchronous. The client's next move after the ack is to
    /// attach to the stream, and if the turn were only registered on some later
    /// microtask that attach would find an idle session, receive `done`, and
    /// show a turn that had ended before it began. Reserving the turn before
    /// returning closes that window.
    pub fn send(&self, session_id: &str, text: &str, options_json: &str) -> String {
        let options: SendOptions = serde_json::from_str(options_json).unwrap_or_default();
        // Resolved here, once, as upstream resolves in its handler: a queued
        // message carries attachments that have already been through this, and
        // running them past it again on the way out of the queue would mean
        // re-reading the workspace for files the sender already vouched for.
        let start = TurnStart {
            text: text.to_string(),
            model: options.model,
            reasoning_effort: options.reasoning_effort,
            attachments: crate::uploads::resolve(options.attachments),
            skill_action: options.skill_action,
            queue: options.queue,
            interrupt: options.interrupt,
            origin: options
                .origin
                .filter(|o| !o.trim().is_empty())
                .unwrap_or_else(|| "web".to_string()),
        };
        start_turn(&self.inner, session_id, start).to_string()
    }

    /// Inject a message into the turn already running, as
    /// `POST /api/chat/steer` does. Answers whether it landed; `false` means
    /// there was no turn to steer and the caller should send it normally.
    ///
    /// The loop appends it at its next round boundary, so the model sees it on
    /// its next request rather than after the turn — which is the whole point,
    /// and the difference between this and the queue.
    pub fn steer(&self, session_id: &str, message: &str) -> bool {
        let message = message.trim();
        if message.is_empty() {
            return false;
        }
        self.inner
            .turns
            .borrow()
            .get(session_id)
            .is_some_and(|turn| turn.steer_tx.send(message.to_string()).is_ok())
    }

    /// Discard the conversation from a message onwards, as
    /// `POST /api/chat/rewind` does: the "edit & resend" button.
    ///
    /// `user_index` counts user messages, 0-based, in the order the `history`
    /// frame lists them — that message and everything after it go, from the
    /// store as well as from the context the next turn will send. The active
    /// skill is recomputed by replaying what is left, so a rewind past the
    /// activation genuinely deactivates it.
    ///
    /// Refused while a turn is running: the turn is writing to the very rows
    /// this rewrites. Destructive and final — and it rewinds the conversation,
    /// not the workspace, so files the discarded turns wrote stay written.
    pub fn rewind(&self, session_id: &str, user_index: usize) -> String {
        let inner = &self.inner;
        if inner.turns.borrow().contains_key(session_id) {
            return serde_json::json!({
                "ok": false,
                "error": "turn_in_flight",
                "message": "cannot rewind while a turn is running; cancel it first",
            })
            .to_string();
        }

        let (mut messages, _) = inner.store.load_state(session_id).unwrap_or_default();
        let cut = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role == Role::User)
            .nth(user_index)
            .map(|(i, _)| i);
        let Some(cut) = cut else {
            return serde_json::json!({ "ok": false, "error": "user_index out of range" })
                .to_string();
        };
        messages.truncate(cut);

        // Anything parked was written against the context that just went away.
        inner.queued.borrow_mut().remove(session_id);
        let skill = crate::turn::replay_skill_marker(&messages)
            .and_then(|name| resolve_active_skill(&inner.skills, &name, false).ok());
        if let Err(e) = inner.store.save(
            session_id,
            &messages,
            "web",
            skill.as_ref().map(|s| s.name.as_str()),
        ) {
            return serde_json::json!({
                "ok": false,
                "error": format!("rewind persist failed: {e}"),
            })
            .to_string();
        }

        // A rewind in one tab must not be invisible in another: they converge on
        // the truncated transcript the same way they would on a new turn.
        for stream in inner.followers_of(session_id) {
            snapshot(inner, &stream, session_id);
        }
        serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "message_count": messages.iter().filter(|m| m.role != Role::System).count(),
            "active_skill": skill.map(|s| s.name),
        })
        .to_string()
    }

    /// Stop the running turn after the current step. The loop checks this
    /// between iterations and around tool calls, so a long tool still finishes.
    pub fn cancel(&self, session_id: &str) {
        let inner = &self.inner;
        // Stop means stop: anything parked behind this turn goes too, or
        // pressing it would start the next message instead of stopping.
        inner.queued.borrow_mut().remove(session_id);
        if let Some(turn) = inner.turns.borrow().get(session_id) {
            turn.cancel.store(true, Ordering::Relaxed);
            // A sub-agent parked on a confirmation cannot see a flag: its
            // `recv()` has to return something. Its own cancellation follows
            // through the task driver's parent-cancel poll.
            turn.router.deny_all();
        }
        inner.publish_queue(session_id);
    }

    /// Answer a `confirm` frame. `approve_all` stops asking for the rest of the
    /// session, matching the terminal's "approve everything from here" option.
    ///
    /// `call_id` is the tool-call id of the frame being answered, and it is what
    /// decides who the reply belongs to: a sub-agent's confirmation reaches the
    /// UI unwrapped, so the answer comes back indistinguishable from one for the
    /// parent apart from this. Absent — an older client — means the parent.
    ///
    /// `amended_args` is the tool call as the user edited it in the confirm bar
    /// — the point of an editable bar being that the amended call is what runs.
    /// Anything unparseable is taken as no amendment: running the tool as the
    /// model asked is closer to what the user approved than refusing the turn
    /// over a malformed field.
    pub fn confirm(
        &self,
        session_id: &str,
        call_id: Option<String>,
        approved: bool,
        approve_all: bool,
        amended_args: Option<String>,
    ) {
        let amended = amended_args
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .and_then(|a| serde_json::from_str::<serde_json::Value>(a).ok());
        let response = match (approved, approve_all) {
            (true, true) => ConfirmResponse::ApproveAll,
            (true, false) => ConfirmResponse::Approve { amended_args: amended },
            (false, _) => ConfirmResponse::Deny,
        };
        // Flipped here as well as inside the loop, which also flips it on
        // receipt: a client that reads session state right after this POST has
        // to already see the badge it just turned on.
        if approved && approve_all {
            self.inner
                .auto_flag(session_id)
                .store(true, Ordering::Relaxed);
        }
        if let Some(turn) = self.inner.turns.borrow().get(session_id) {
            if let Some(id) = call_id.as_deref() {
                if turn.router.routes(id) {
                    turn.router.deliver(id, response);
                    return;
                }
            }
            let _ = turn.confirm_tx.send(response);
        }
    }

    /// Turn full-auto on or off for a session, as `POST /api/chat/auto` does.
    ///
    /// The flag is shared with any loop already running, so this lands on the
    /// next tool call rather than the next turn.
    #[wasm_bindgen(js_name = setAuto)]
    pub fn set_auto(&self, session_id: &str, enabled: bool) {
        self.inner
            .auto_flag(session_id)
            .store(enabled, Ordering::Relaxed);
    }

    // ── the write/edit allow-list, mirroring /api/safe-paths ──

    /// Stop asking about writes inside `dir`, as the confirm bar's "allow this
    /// folder" button does. Answers whether it was newly added; a directory
    /// that does not exist in the workspace cannot be allowed, and says so by
    /// answering false.
    #[wasm_bindgen(js_name = allowDir)]
    pub fn allow_dir(&self, dir: &str) -> bool {
        self.inner.safe_paths.learn(dir)
    }

    /// The allowed directories, as a JSON array of paths.
    #[wasm_bindgen(js_name = allowedDirs)]
    pub fn allowed_dirs(&self) -> String {
        serde_json::to_string(&self.inner.safe_paths.snapshot()).unwrap_or_else(|_| "[]".into())
    }

    /// Ask about `dir` again. With no `dir`, ask about everything again.
    #[wasm_bindgen(js_name = forgetDirs)]
    pub fn forget_dirs(&self, dir: Option<String>) {
        match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            Some(dir) => {
                self.inner.safe_paths.remove(dir);
            }
            None => self.inner.safe_paths.clear(),
        }
    }

    // ── the workspace's size, mirroring /api/runtime ──

    /// What the settings card shows: bytes and files per runtime category.
    #[wasm_bindgen(js_name = runtimeStat)]
    pub fn runtime_stat(&self, category: Option<String>) -> String {
        let category = category.as_deref().map(str::trim).filter(|c| !c.is_empty());
        crate::runtime::stat(category).to_string()
    }

    /// Empty those categories — all of them, given an empty list — and answer
    /// how many bytes that reclaimed.
    ///
    /// The list arrives as JSON rather than as an array because everything else
    /// across this boundary does. Unreadable JSON is refused rather than read
    /// as "no categories named", which would mean wiping all of them over a bug
    /// in our own caller.
    #[wasm_bindgen(js_name = runtimeClear)]
    pub fn runtime_clear(&self, categories_json: &str) -> String {
        let parsed = serde_json::from_str::<Vec<String>>(categories_json)
            .map_err(|e| crate::answer::Refused::bad(format!("unreadable category list: {e}")));
        crate::answer::envelope(parsed.and_then(|names| crate::runtime::clear(&names)))
    }

    // ── attachments, mirroring /api/chat/upload ──

    /// Store a file the user attached, answering the JSON the UI's uploader
    /// expects: `{ok: true, upload}` or `{ok: false, status, error}`.
    ///
    /// The refusal carries its own status because the reason for it — an empty
    /// body, a file over the cap — is decided by the same rules that pick the
    /// extension, and splitting those across the RPC boundary would mean
    /// keeping the MIME table in two languages.
    pub fn upload(&self, name: &str, mime: &str, body: &[u8]) -> String {
        crate::answer::envelope(crate::uploads::store(name, mime, body))
    }

    /// An upload's bytes, or nothing when the id is unknown or malformed.
    #[wasm_bindgen(js_name = readUpload)]
    pub fn read_upload(&self, id: &str) -> Option<Vec<u8>> {
        crate::uploads::load(id)
    }

    /// What to serve those bytes as. Only images get a real type; see
    /// [`crate::uploads::mime_of`].
    #[wasm_bindgen(js_name = uploadMime)]
    pub fn upload_mime(&self, id: &str) -> String {
        crate::uploads::mime_of(id).to_string()
    }

    /// Answer an `ask_user` frame with a JSON array of
    /// `{question_id, selected_ids, custom_text?}`. An empty or unparseable
    /// payload is treated as the user backing out.
    pub fn answer(&self, session_id: &str, answers_json: &str) {
        let response = match serde_json::from_str::<Vec<AskAnswer>>(answers_json) {
            Ok(answers) if !answers.is_empty() => AskUserResponse::Answered { answers },
            _ => AskUserResponse::Cancelled,
        };
        if let Some(turn) = self.inner.turns.borrow().get(session_id) {
            let _ = turn.ask_tx.send(response);
        }
    }

    /// The user is interacting with the pending `ask_user` — typing, choosing —
    /// without having answered yet. Not an answer: with a timeout armed, the
    /// loop pushes its auto-pick deadline back to the full window and keeps
    /// waiting (see `handle_ask_user`). Harmless when nothing is pending.
    #[wasm_bindgen(js_name = askActivity)]
    pub fn ask_activity(&self, session_id: &str) {
        if let Some(turn) = self.inner.turns.borrow().get(session_id) {
            let _ = turn.ask_tx.send(AskUserResponse::Activity);
        }
    }

    /// Drop one parked message, by the id the `queue` frame carries. `false`
    /// when it is already gone — started by the drain, or removed by another
    /// tab — which the UI resolves by waiting for the next `queue` snapshot.
    ///
    /// `id` crosses the boundary as an f64 because that is what a JS number
    /// is; ids are counted from 1 and stay far below 2^53.
    #[wasm_bindgen(js_name = queueRemove)]
    pub fn queue_remove(&self, session_id: &str, id: f64) -> bool {
        let id = id as u64;
        let removed = {
            let mut queued = self.inner.queued.borrow_mut();
            queued.get_mut(session_id).is_some_and(|q| {
                let before = q.len();
                q.retain(|i| i.id != id);
                q.len() != before
            })
        };
        if removed {
            self.inner.publish_queue(session_id);
        }
        removed
    }

    /// Replace one parked message's text; its attachments and model override
    /// ride along unchanged, as upstream's edit does. `false` when the id
    /// names nothing.
    #[wasm_bindgen(js_name = queueEdit)]
    pub fn queue_edit(&self, session_id: &str, id: f64, message: &str) -> bool {
        let id = id as u64;
        let edited = {
            let mut queued = self.inner.queued.borrow_mut();
            queued
                .get_mut(session_id)
                .and_then(|q| q.iter_mut().find(|i| i.id == id))
                .map(|item| item.message = message.to_string())
                .is_some()
        };
        if edited {
            self.inner.publish_queue(session_id);
        }
        edited
    }

    // ── session management, mirroring /api/sessions ──

    /// How many turns are running, across every session.
    ///
    /// Upstream never needs this: its turns run in a server process that
    /// outlives the browser tab. Here the engine is the tab, so closing it
    /// kills whatever it was in the middle of -- and the page's leave guard
    /// has to know that synchronously, which means keeping a recent count
    /// rather than asking at the last moment. Answered from the map the ack
    /// path already consults, so polling it costs nothing; `sessions()` would
    /// read the whole table to say the same thing.
    pub fn turns(&self) -> usize {
        self.inner.turns.borrow().len()
    }

    pub fn sessions(&self) -> Result<String, JsValue> {
        let mut rows = self.inner.store.list().map_err(err)?;
        // The store cannot know which turns are live; the host can.
        let turns = self.inner.turns.borrow();
        for row in &mut rows {
            row.running = turns.contains_key(&row.id);
        }
        serde_json::to_string(&rows).map_err(err)
    }

    pub fn session(&self, id: &str) -> Result<String, JsValue> {
        let detail = self.inner.store.detail(id).map_err(err)?;
        let Some((title, created_at, updated_at, active_skill, messages)) = detail else {
            return Ok("null".to_string());
        };
        // Split into `meta` and `messages` because that is the shape the UI
        // destructures: it reads `detail.meta.title` and friends, and a flat
        // object leaves it loading a transcript under a session whose title,
        // skill and full-auto badge all read as unset.
        serde_json::to_string(&serde_json::json!({
            "meta": {
                "id": id,
                "title": title,
                "created_at": created_at,
                "updated_at": updated_at,
                "active_skill": active_skill,
                "auto_confirm": self.inner.auto_state(id),
                "running": self.inner.turns.borrow().contains_key(id),
            },
            "messages": messages,
        }))
        .map_err(err)
    }

    pub fn search(&self, query: &str, limit: usize, exclude: Option<String>) -> Result<String, JsValue> {
        let hits = self
            .inner
            .store
            .search(query, limit, exclude.as_deref())
            .map_err(err)?;
        serde_json::to_string(&hits).map_err(err)
    }

    /// A session's archived pre-compaction generations (oldest first), as the
    /// body of `GET /api/sessions/{id}/archive`. Empty list when the session
    /// was never compacted.
    #[wasm_bindgen(js_name = listSessionArchive)]
    pub fn list_session_archive(&self, id: &str) -> Result<String, JsValue> {
        let generations = self.inner.store.list_archive_generations(id).map_err(err)?;
        serde_json::to_string(&serde_json::json!({ "generations": generations })).map_err(err)
    }

    /// Full messages of one archived generation, same row shape as the
    /// session detail's `messages` (system prompt filtered out — it is not
    /// transcript). `"null"` when the generation does not exist.
    #[wasm_bindgen(js_name = getSessionArchive)]
    pub fn get_session_archive(&self, id: &str, generation: i64) -> Result<String, JsValue> {
        let Some(messages) = self.inner.store.load_archive(id, generation).map_err(err)? else {
            return Ok("null".to_string());
        };
        let messages: Vec<_> = messages
            .into_iter()
            .filter(|m| m.role != crate::types::Role::System)
            .collect();
        serde_json::to_string(&serde_json::json!({
            "generation": generation,
            "messages": messages,
        }))
        .map_err(err)
    }

    /// Cancel ONE running sub-agent by the `task_id` the `subagent` frames
    /// carry (= the parent `task` tool_call id). The child winds down like a
    /// user cancel: partial progress lands in the parent `task` tool result;
    /// the rest of the turn keeps running. `false` when no such task is live
    /// (already finished, or the id is unknown).
    #[wasm_bindgen(js_name = cancelTask)]
    pub fn cancel_task(&self, session_id: &str, task_id: &str) -> bool {
        self.inner
            .turns
            .borrow()
            .get(session_id)
            .is_some_and(|t| t.router.cancel_task(task_id))
    }

    #[wasm_bindgen(js_name = updateSession)]
    pub fn update_session(
        &self,
        id: &str,
        title: Option<String>,
        pinned: Option<bool>,
    ) -> Result<(), JsValue> {
        self.inner
            .store
            .update(id, title.as_deref(), pinned)
            .map_err(err)
    }

    /// Write a session's transcript directly, without running a turn.
    ///
    /// This is how a conversation exported from the desktop agent-core gets in,
    /// and it is what the shared schema was paid for. `messages_json` is the
    /// same `ChatMessage` array the `history` frame carries, so a transcript can
    /// make the round trip without a translation step.
    ///
    /// Refuses while a turn is running, rather than racing the turn's own
    /// whole-table rewrite and losing one of the two.
    #[wasm_bindgen(js_name = importSession)]
    pub fn import_session(&self, id: &str, messages_json: &str) -> Result<(), JsValue> {
        if self.inner.turns.borrow().contains_key(id) {
            return Err(JsValue::from_str(
                "cannot import into a session with a turn in flight",
            ));
        }
        let messages: Vec<ChatMessage> = serde_json::from_str(messages_json).map_err(err)?;
        self.inner
            .store
            .save(id, &messages, "web", None)
            .map_err(err)
    }

    #[wasm_bindgen(js_name = deleteSession)]
    pub fn delete_session(&self, id: &str) -> Result<(), JsValue> {
        // Deleting a session mid-turn would leave the turn writing to a row that
        // no longer exists, so stop it first. The turn notices between steps.
        self.cancel(id);
        // Whatever was allowed applied to this conversation. A new session that
        // reused the id must start by asking again.
        self.inner.auto.borrow_mut().remove(id);
        self.inner.store.delete(id).map_err(err)
    }
}

impl AgentHost {
    fn over(sink: Sink, store: SessionStore) -> AgentHost {
        let registry = Arc::new(ToolRegistry::new());
        let safe_paths = Arc::new(SafePathAllowList::new(Some(std::path::PathBuf::from(
            crate::files::SAFE_PATHS,
        ))));
        // Registered first, then replaced name-for-name when a device ships
        // its own file tools (the registry replaces on collision, and the
        // device payload arrives later, via install_tools). Standalone — no
        // device, or one without file tools — these stay the model's file
        // tools, operating on the tab workspace.
        crate::files::install(&registry, safe_paths.clone());
        let skills = crate::skills::install(&registry);
        crate::themes::install(&registry);
        // Session retrieval needs the store the sessions live in, so the Arc
        // is built here and shared with Inner.
        let store = Arc::new(store);
        crate::session_tools::install(&registry, store.clone());

        AgentHost {
            inner: Rc::new(Inner {
                sink,
                store,
                registry,
                skills,
                safe_paths,
                system_prompt: RefCell::new(String::new()),
                device_owns_files: std::cell::Cell::new(false),
                llm: RefCell::new(None),
                endpoint: RefCell::new(None),
                reasoning_effort: RefCell::new(String::new()),
                subagent_reasoning_effort: RefCell::new(String::new()),
                models: RefCell::new(None),
                turns: RefCell::new(HashMap::new()),
                queued: RefCell::new(HashMap::new()),
                next_queue_id: std::cell::Cell::new(0),
                attached: RefCell::new(HashMap::new()),
                auto: RefCell::new(HashMap::new()),
            }),
        }
    }
}

/// The client for one turn: the configured one, unless the turn named a
/// different model.
///
/// `None` only when nothing is configured at all — an override cannot stand in
/// for an endpoint, since the address and the key still have to come from
/// somewhere.
fn turn_client(inner: &Inner, model: Option<&str>) -> Option<LlmClient> {
    let configured = inner.llm.borrow().clone()?;
    let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) else {
        return Some(configured);
    };

    let endpoint = inner.endpoint.borrow();
    match endpoint.as_ref() {
        Some(e) if e.model != model => Some(endpoint_client(&e.base_url, &e.api_key, model)),
        // Already the configured model, or configured through a path that did
        // not record the endpoint. Either way there is nothing to swap.
        _ => Some(configured),
    }
}

/// Build a host backed by IndexedDB. This is the normal entry point.
///
/// Separate from the constructor because installing the VFS is asynchronous and
/// a `#[wasm_bindgen(constructor)]` cannot be.
///
/// `namespace` keeps one gateway's history out of another's now that the page is
/// served from a shared origin; see [`crate::storage::db_name`]. Pass nothing
/// for a deployment where the origin is already the gateway.
#[wasm_bindgen(js_name = openHost)]
pub async fn open(sink: Sink, namespace: Option<String>) -> Result<AgentHost, JsValue> {
    report_to_console();
    let store = crate::storage::open(namespace.as_deref()).await.map_err(err)?;

    // Not fatal, and deliberately so: the workspace holds skills and uploads,
    // and a tab that can still hold a conversation is worth more than one that
    // refuses to start because it could not open a second database.
    if let Err(e) = crate::storage::open_workspace(namespace.as_deref()) {
        log::error!("{e}; files will not survive a reload");
    }

    Ok(AgentHost::over(sink, store))
}

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// A client that knows where uploads are.
///
/// Without the uploads directory the engine treats every attachment as gone:
/// an image never becomes visual input, and the note that tells the model
/// where a text file is says "unavailable" instead of a path it could read.
fn endpoint_client(base_url: &str, api_key: &str, model: &str) -> LlmClient {
    LlmClient::new(base_url, api_key, model, None)
        .with_uploads_dir(Some(std::path::PathBuf::from(crate::files::UPLOADS)))
}

/// Send panics and warnings somewhere a person can see them.
///
/// Both are idempotent, which is what lets the two constructors call this
/// without deciding between them. Warn and above only: the engine narrates each
/// step of a turn at `info`, and a console full of that is a console nobody
/// reads the one useful line out of.
fn report_to_console() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Warn);
}

/// One self-contained view of a session, down one stream: `session`, then
/// `history`, then what is queued, then either `done` for an idle session or the
/// running turn's frames so far.
///
/// Upstream's `stream_snapshot_cycle`. It is the whole of a turn-scoped attach
/// and one cycle of a following one, which is what makes a re-snapshot at the
/// next turn deliver exactly what an explicit re-attach would have.
fn snapshot(inner: &Inner, stream_id: &str, session_id: &str) {
    let mut history = inner
        .store
        .detail(session_id)
        .ok()
        .flatten()
        .map(|(_, _, _, _, msgs)| msgs)
        .unwrap_or_default();
    let active_skill = inner
        .store
        .load_state(session_id)
        .ok()
        .and_then(|(_, skill)| skill);

    let (running, replay, lossy) = match inner.turns.borrow().get(session_id) {
        Some(turn) => {
            // After the stored history and before the frames, which is where
            // they belong in the conversation: the message the turn is
            // answering.
            history.extend(
                turn.staged_tail
                    .iter()
                    .filter(|m| m.role != Role::System)
                    .cloned(),
            );
            (
                true,
                turn.tail.iter().cloned().collect::<Vec<_>>(),
                turn.lossy,
            )
        }
        None => (false, Vec::new(), false),
    };

    inner.emit(
        stream_id,
        &sse::frame(
            "session",
            serde_json::json!({
                "session_id": session_id,
                "active_skill": active_skill,
                "auto_confirm": inner.auto_state(session_id),
                "running": running,
            }),
        ),
    );
    inner.emit(
        stream_id,
        &sse::frame("history", serde_json::json!({ "messages": history })),
    );
    // Only when there is something to say: an empty `queue` frame means "the
    // queue was cleared", which is a different statement from silence, and one
    // no idle session should be making.
    let queue = inner.queue_payload(session_id);
    if queue["items"].as_array().is_some_and(|i| !i.is_empty()) {
        inner.emit(stream_id, &sse::frame("queue", queue));
    }

    if !running {
        // Terminal for a turn-scoped viewer, and a separator for a following
        // one: what comes next on that stream is the next turn's snapshot.
        inner.emit(
            stream_id,
            &sse::frame("done", serde_json::json!({ "elapsed_ms": 0 })),
        );
        return;
    }
    if lossy {
        inner.emit(
            stream_id,
            &sse::frame(
                "status",
                serde_json::json!({ "text": "earlier output trimmed / 早期输出已截略" }),
            ),
        );
    }
    for frame in replay {
        inner.emit(stream_id, &frame);
    }
}

/// What the driver needs beyond the loop's own parameters.
struct Driving {
    /// The other end of `TurnParams::event_tx`.
    events: mpsc::UnboundedReceiver<AgentEvent>,
    /// What the staging step decided the client should be told before the model
    /// has said anything.
    announce: Vec<AgentEvent>,
    /// The skill the turn opens with. The ledger replaces it if the model reads
    /// another one mid-turn, and it is what gets stored with the context.
    steering: Option<ActiveSkill>,
}

/// Start a turn, or park the message behind the one already running.
///
/// Upstream's `start_session_turn`, minus the HTTP types. Both entrances to a
/// turn come through here — the client's `POST /api/chat` and the queue drain at
/// the end of the previous turn — which is what makes a queued message behave
/// exactly like a hand-sent one.
fn start_turn(inner: &Rc<Inner>, session_id: &str, start: TurnStart) -> serde_json::Value {
    let TurnStart {
        text,
        model,
        reasoning_effort,
        attachments,
        skill_action,
        queue,
        interrupt,
        origin,
    } = start;

    // Resolved before anything else is touched: a `/skill` naming something
    // that is not installed must not leave a session half-started.
    let activation = match skill_action.as_ref() {
        Some(SkillAction::Activate { name }) => {
            match prepare_user_skill_activation(&inner.skills, name) {
                Ok(prepared) => Some(prepared),
                Err(e) => return serde_json::json!({ "accepted": false, "reason": e.to_string() }),
            }
        }
        _ => None,
    };
    let reset = matches!(skill_action, Some(SkillAction::Reset));
    let has_message = !text.trim().is_empty() || !attachments.is_empty();

    if inner.turns.borrow().contains_key(session_id) {
        // "Send now": wind the running turn down — the same machinery as
        // `cancel`, except the queue survives — and park the message at the
        // FRONT, so the pump starts it the moment the turn ends. Control-plane
        // intent (`/skill`, `/reset`) still cannot ride an interrupt, for the
        // same reason it cannot queue.
        if interrupt && has_message && activation.is_none() && !reset {
            if let Some(turn) = inner.turns.borrow().get(session_id) {
                turn.cancel.store(true, Ordering::Relaxed);
                turn.router.deny_all();
            }
            let id = inner.alloc_queue_id();
            inner
                .queued
                .borrow_mut()
                .entry(session_id.to_string())
                .or_default()
                .push_front(QueuedTurn {
                    id,
                    message: text,
                    attachments,
                    model,
                    reasoning_effort,
                });
            inner.publish_queue(session_id);
            return serde_json::json!({
                "accepted": true,
                "running": true,
                "queued": true,
                "interrupted": true,
                "position": 1,
                "auto_confirm": inner.auto_state(session_id),
            });
        }
        // A plain message can wait. Anything carrying control-plane intent — a
        // `/skill`, a `/reset` — cannot, because what it would do depends on
        // state the running turn is still changing.
        if !queue || !has_message || activation.is_some() || reset {
            return serde_json::json!({ "accepted": false, "reason": "turn_in_flight" });
        }
        let id = inner.alloc_queue_id();
        let position = {
            let mut queued = inner.queued.borrow_mut();
            let q = queued.entry(session_id.to_string()).or_default();
            q.push_back(QueuedTurn {
                id,
                message: text,
                attachments,
                model,
                reasoning_effort,
            });
            q.len()
        };
        inner.publish_queue(session_id);
        return serde_json::json!({
            "accepted": true,
            "running": true,
            "queued": true,
            "position": position,
            "auto_confirm": inner.auto_state(session_id),
        });
    }

    // Staged here rather than in the driver, as upstream stages in its handler.
    // What the turn adds to the conversation has to exist before the ack
    // returns: the client attaches next, and an attach that found nothing staged
    // would answer with a `history` frame from before the message was sent.
    //
    // A stored session keeps only the skill's name. Resolving it against the
    // registry each turn is what makes a skill that was since disabled or
    // uninstalled stop steering, rather than gating tools by a stale list.
    let (committed, steering) = inner.store.load_state(session_id).unwrap_or_default();
    let steering = steering.and_then(|name| resolve_active_skill(&inner.skills, &name, false).ok());
    // A session opens with the system message, which is why the briefing is
    // built even when there is history: the engine assumes the caller put one
    // first — it preserves `messages.first()` verbatim when compressing — and
    // without it the model is told nothing about the device it is driving, nor
    // about the filesystem its file tools point at.
    let device = inner.system_prompt.borrow().clone();
    let mut briefing = crate::files::briefing(&device, inner.device_owns_files.get());
    // Tier 1 of the skill system: each installed skill's name and description
    // ride in the system message, so the model can tell what `read_skill`
    // would load. Without this the skills exist but are undiscoverable — the
    // model would have to be told about them by the user. Rebuilt every turn,
    // so an install or disable takes effect on the next message.
    let manifest = inner.skills.manifest();
    if !manifest.is_empty() {
        briefing.push_str("\n\n");
        briefing.push_str(&manifest);
    }
    let staged = stage_turn(
        &committed,
        steering,
        &briefing,
        &text,
        attachments,
        activation.as_ref(),
        reset,
    );

    // Deactivation is deterministic control-plane work that cannot fail, so it
    // is committed now, independently of how the turn goes.
    if staged.commit_reset {
        let _ = inner.store.save(session_id, &committed, &origin, None);
    }
    // A bare `/reset` is all of the work there was: no turn, and the UI reads
    // `running: false` as "nothing to attach to".
    if reset && staged.user_text.is_none() {
        return serde_json::json!({
            "accepted": true,
            "running": false,
            "auto_confirm": inner.auto_state(session_id),
        });
    }

    let Some(llm) = turn_client(inner, model.as_deref()) else {
        // A configuration mistake is knowable now, so say so now — and also put
        // it on the stream, because that is where the user is looking.
        let frame = sse::frame(
            "error",
            serde_json::json!({ "message": "no model endpoint configured" }),
        );
        for stream in inner.viewers_of(session_id) {
            inner.emit(&stream, &frame);
        }
        return serde_json::json!({ "accepted": false, "reason": "not_configured" });
    };
    // Effort layers: the configured default (settings page), then this turn's
    // override on top. `with_reasoning_effort` is only called when there is
    // something to say — called with `None` it would CLEAR the profile default.
    let configured_effort = inner.reasoning_effort.borrow().clone();
    let llm = if reasoning_effort.as_deref().is_some_and(|e| !e.trim().is_empty()) {
        llm.with_reasoning_effort(reasoning_effort.clone())
    } else if !configured_effort.is_empty() {
        llm.with_reasoning_effort(Some(configured_effort))
    } else {
        llm
    };

    // Make the session real before the turn produces anything, so it shows up in
    // the sidebar as soon as the user hits send rather than when the answer
    // finishes arriving.
    let _ = inner.store.touch(session_id, &origin);

    let (event_tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let (confirm_tx, confirm_rx) = mpsc::unbounded_channel();
    let (ask_tx, ask_rx) = mpsc::unbounded_channel();
    let (steer_tx, steer_rx) = mpsc::unbounded_channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let router = ConfirmRouter::new();
    let auto = inner.auto_flag(session_id);

    inner.turns.borrow_mut().insert(
        session_id.to_string(),
        Turn {
            confirm_tx,
            ask_tx,
            steer_tx,
            router: router.clone(),
            cancel: cancel.clone(),
            staged_tail: staged.snapshot[committed.len()..].to_vec(),
            tail: VecDeque::new(),
            lossy: false,
            viewers: inner.viewers_of(session_id),
        },
    );

    // The turn is registered, so this snapshot says `running: true` and carries
    // the message being answered in its `history`. Every following stream gets
    // one, which is how a turn nobody on this session asked for — the queue
    // draining, another tab sending — appears on screen at all.
    for stream in inner.followers_of(session_id) {
        snapshot(inner, &stream, session_id);
    }

    let mut params = TurnParams::new(llm.clone(), inner.registry.clone(), staged.snapshot, event_tx, confirm_rx);
    params.ask_user_rx = Some(ask_rx);
    params.steer_rx = Some(steer_rx);
    params.cancel_flag = cancel;
    params.auto_confirm = Some(auto.clone());
    params.skills = Some(inner.skills.clone());
    params.active_skill = staged.skill_seed.clone();
    params.session_id = Some(session_id.to_string());
    params.store = Some(inner.store.clone());
    // Sub-agents get the same tools, the same skills and the same approval
    // mode as the turn that delegated to them. What they do not get is a
    // runner of their own, which is the depth cap: `task` is only advertised
    // to a loop that has one.
    params.task_runner = Some(Arc::new(TaskRunner {
        llm,
        registry: inner.registry.clone(),
        skills: Some(inner.skills.clone()),
        blocklist: Vec::new(),
        // Auto-detected from the model name, as it is for the parent: nothing
        // here configures a context size.
        configured_context_tokens: 0,
        trust_all: false,
        auto_confirm: auto.clone(),
        store: Some(inner.store.clone()),
        system_prompt: briefing,
        // Empty: a child runs on whatever model the parent turn is running on,
        // there being no second endpoint to name a cheaper one from.
        subagent_model: String::new(),
        // Children run on the parent turn's client (per-turn effort override
        // included); this configured default then layers on top of it.
        subagent_reasoning_effort: inner.subagent_reasoning_effort.borrow().clone(),
        timeout_secs: crate::config::default_subagent_timeout_secs(),
        max_parallel: crate::config::default_subagent_max_parallel(),
        confirm_router: router,
    }));

    wasm_bindgen_futures::spawn_local(run_turn(
        inner.clone(),
        session_id.to_string(),
        params,
        Driving {
            events: event_rx,
            announce: staged.announce,
            steering: staged.skill_seed,
        },
    ));
    serde_json::json!({
        "accepted": true,
        "running": true,
        "auto_confirm": auto.load(Ordering::Relaxed),
    })
}

/// Upstream's deterministic auto-title: the first user message, single-lined
/// and cut to 40 bytes on a character boundary. No extra model call, which is
/// why it is worth having — a sidebar of "Untitled" is the alternative.
fn derive_title(messages: &[ChatMessage]) -> String {
    let first_user = messages
        .iter()
        .find(|m| m.role == Role::User)
        .and_then(|m| m.content.clone())
        .unwrap_or_default();
    let t = first_user.trim().replace('\n', " ");
    let mut end = t.len().min(40);
    while end > 0 && !t.is_char_boundary(end) {
        end -= 1;
    }
    t[..end].to_string()
}

/// Name a session that has never been named, and tell its viewers.
///
/// Only the empty title is replaced: a title the user typed, or one an earlier
/// turn derived, outranks anything computed here.
fn name_session(inner: &Inner, session_id: &str, candidate: &str) {
    if candidate.is_empty() {
        return;
    }
    let unnamed = match inner.store.title_of(session_id) {
        Ok(Some(title)) => title.is_empty(),
        Ok(None) => true,
        // A store that cannot be read is not one to write a title into.
        Err(_) => false,
    };
    if !unnamed {
        return;
    }
    if inner.store.set_title(session_id, candidate).is_ok() {
        inner.publish(
            session_id,
            sse::frame("title", serde_json::json!({ "title": candidate })),
        );
    }
}

/// Run one turn to completion, publishing frames as they arrive.
///
/// The turn is already registered by the time this starts; see [`start_turn`].
/// `announce` is what the staging step decided the client should be told before
/// the model has said anything, and `steering` is the skill the turn opens with.
async fn run_turn(inner: Rc<Inner>, session_id: String, params: TurnParams, driving: Driving) {
    let Driving {
        mut events,
        announce,
        steering,
    } = driving;

    // Optimistic, and published before the loop starts: the composer shows the
    // active skill as a chip, and waiting for the model's first token to draw
    // it would make an activation look like it had not registered.
    for event in &announce {
        if let Some(frame) = sse::encode(event) {
            inner.publish(&session_id, frame);
        }
    }

    // What this session would be called, if it is still unnamed when the turn
    // lands. Taken before the context is moved into the loop, and from the whole
    // conversation rather than this turn's message: a session whose first turn
    // errored is named after the question that opened it, not the second one.
    let candidate_title = derive_title(&params.initial_messages);

    // The pump and the loop run concurrently: the loop blocks on the confirm
    // channel while waiting for a decision, and that decision can only arrive
    // if the `confirm` frame has already reached the UI.
    let pump = {
        let inner = inner.clone();
        let session_id = session_id.clone();
        let mut steering = steering;
        async move {
            let mut ledger = TurnLedger::new();
            while let Some(event) = events.recv().await {
                // A message the turn accepted for injection but never reached a
                // round boundary for, because the turn then failed. Back to the
                // front of the queue, so the next turn starts with it. Internal:
                // what the client sees is the `queue` frame below.
                if let AgentEvent::SteerRequeued { text } = &event {
                    let id = inner.alloc_queue_id();
                    inner
                        .queued
                        .borrow_mut()
                        .entry(session_id.clone())
                        .or_default()
                        .push_front(QueuedTurn {
                            id,
                            message: text.clone(),
                            attachments: Vec::new(),
                            model: None,
                            reasoning_effort: None,
                        });
                    inner.publish_queue(&session_id);
                }
                // Committed at the loop's own sync points, as upstream commits,
                // rather than once at the end: `run_agent_turn` owns the context
                // and does not hand it back, and a turn that dies between two
                // syncs keeps everything up to the last one.
                if let Some(commit) = ledger.observe(&event) {
                    if let Some(skill) = commit.skill {
                        steering = skill;
                    }
                    let _ = inner.store.save(
                        &session_id,
                        &commit.messages,
                        "web",
                        steering.as_ref().map(|s| s.name.as_str()),
                    );
                }
                // Before the `done` frame this event encodes into, because a
                // client that has seen `done` may already have stopped reading.
                if matches!(event, AgentEvent::AssistantDone { .. }) {
                    name_session(&inner, &session_id, &candidate_title);
                }
                if let Some(frame) = sse::encode(&event) {
                    inner.publish(&session_id, frame);
                }
            }
        }
    };

    // Genuinely concurrent, not sequential. Awaiting the loop first and then
    // draining would hold every frame until the turn ended — no streaming — and
    // would deadlock outright on a confirmation: the loop blocks waiting for a
    // decision that the user can only make after seeing a `confirm` frame that
    // is still sitting in the channel.
    //
    // A failed turn needs no error frame from here: `run_agent_turn` reports it
    // as `AgentEvent::Error`, which the pump encodes like any other.
    futures::join!(run_agent_turn(params), pump);

    // Whatever was parked behind this turn starts now, in order. Cancel empties
    // the queue, so a cancelled turn stops here.
    let next = inner
        .queued
        .borrow_mut()
        .get_mut(&session_id)
        .and_then(|q| q.pop_front());
    // Published while the turn is still registered: `publish` reaches viewers
    // through it, and a frame sent after the removal below would reach nobody.
    if next.is_some() {
        inner.publish_queue(&session_id);
    }
    inner.turns.borrow_mut().remove(&session_id);
    if let Some(item) = next {
        start_turn(
            &inner,
            &session_id,
            TurnStart {
                text: item.message,
                model: item.model,
                reasoning_effort: item.reasoning_effort,
                attachments: item.attachments,
                skill_action: None,
                queue: false,
                interrupt: false,
                // A message only queues behind a turn already running, so the
                // session row exists and its origin is already written; this
                // one is never the first insert.
                origin: "web".to_string(),
            },
        );
    }
}
