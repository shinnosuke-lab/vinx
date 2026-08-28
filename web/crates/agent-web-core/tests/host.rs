//! The worker-facing host: does it emit the frames the protocol promises?
//!
//! These drive `AgentHost` the way the worker does — a JS sink function in, SSE
//! records out — and assert on the wire format rather than on internal state,
//! because the wire format is the thing the chat UI depends on.
//!
//! No model endpoint is reachable from a test, so nothing here runs a real turn.
//! What is covered is the surrounding contract: attach ordering, history
//! replay, session bookkeeping, and how a misconfigured host reports itself.

#![cfg(feature = "sqlite")]

use std::cell::RefCell;
use std::rc::Rc;

use agent_web_core::host::AgentHost;
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

/// A host wired to a frame recorder, standing in for the worker's `postMessage`.
struct Harness {
    host: AgentHost,
    frames: Rc<RefCell<Vec<(String, String)>>>,
    // Kept alive for as long as the host might call it.
    _sink: Closure<dyn FnMut(String, String)>,
}

impl Harness {
    fn new() -> Harness {
        let frames = Rc::new(RefCell::new(Vec::new()));
        let recorder = frames.clone();
        let sink = Closure::wrap(Box::new(move |stream: String, frame: String| {
            recorder.borrow_mut().push((stream, frame));
        }) as Box<dyn FnMut(String, String)>);
        let host = AgentHost::new(sink.as_ref().unchecked_ref::<js_sys::Function>().clone())
            .expect("host over an in-memory store");
        Harness {
            host,
            frames,
            _sink: sink,
        }
    }

    /// Watch one turn and stop at its end, the way a client that re-attaches
    /// per turn does.
    fn watch(&self, stream: &str, session: &str) {
        self.host.attach(stream, session, false);
    }

    /// Watch the session for as long as it is open, the way the chat UI does:
    /// one stream that outlives every turn in it.
    fn follow(&self, stream: &str, session: &str) {
        self.host.attach(stream, session, true);
    }

    /// Event names seen on a stream, in order.
    fn events(&self, stream: &str) -> Vec<String> {
        self.frames
            .borrow()
            .iter()
            .filter(|(s, _)| s == stream)
            .filter_map(|(_, f)| {
                f.lines()
                    .find_map(|l| l.strip_prefix("event: ").map(str::to_string))
            })
            .collect()
    }

    /// Payload of the first frame with this event name.
    fn payload(&self, stream: &str, event: &str) -> serde_json::Value {
        let want = format!("event: {event}\n");
        self.frames
            .borrow()
            .iter()
            .filter(|(s, _)| s == stream)
            .find(|(_, f)| f.starts_with(&want))
            .and_then(|(_, f)| {
                f.lines()
                    .find_map(|l| l.strip_prefix("data: "))
                    .and_then(|d| serde_json::from_str(d).ok())
            })
            .unwrap_or_else(|| panic!("no `{event}` frame on {stream}: {:?}", self.events(stream)))
    }

    fn clear(&self) {
        self.frames.borrow_mut().clear();
    }
}

#[wasm_bindgen_test]
fn attaching_to_an_idle_session_closes_the_stream() {
    let h = Harness::new();
    h.watch("s1", "never-seen");

    assert_eq!(
        h.events("s1"),
        vec!["session", "history", "done"],
        "an idle session must not leave the client waiting"
    );

    let session = h.payload("s1", "session");
    assert_eq!(session["session_id"], "never-seen");
    assert_eq!(session["running"], false);
    assert_eq!(session["active_skill"], serde_json::Value::Null);

    assert_eq!(
        h.payload("s1", "history")["messages"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(h.payload("s1", "done")["elapsed_ms"], 0);
}

/// The `history` frame is what the UI paints on first render, so it has to carry
/// the stored conversation — and not the system prompt, which is not the user's
/// to see.
#[wasm_bindgen_test]
fn history_replays_the_stored_conversation_without_the_system_prompt() {
    let h = Harness::new();
    let transcript = serde_json::json!([
        { "role": "system", "content": "you are a gateway agent" },
        { "role": "user", "content": "scan for devices" },
        { "role": "assistant", "content": "found three" },
    ]);
    h.host
        .import_session("imported", &transcript.to_string())
        .unwrap();

    h.watch("s1", "imported");
    let messages = h.payload("s1", "history")["messages"].clone();
    let messages = messages.as_array().unwrap();

    assert_eq!(messages.len(), 2, "the system prompt is not replayed");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "scan for devices");
    assert_eq!(messages[1]["content"], "found three");
}

/// A transcript survives the round trip through the store in the shape the UI
/// sent it, which is the whole point of keeping agent-core's schema.
#[wasm_bindgen_test]
fn an_imported_transcript_comes_back_intact() {
    let h = Harness::new();
    let transcript = serde_json::json!([
        { "role": "user", "content": "check the bridge" },
        {
            "role": "assistant",
            "content": null,
            "reasoning_content": "needs a tool",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": { "name": "ble_scan", "arguments": "{}" }
            }]
        },
        { "role": "tool", "content": "3 devices", "tool_call_id": "call_1" },
    ]);
    h.host
        .import_session("s", &transcript.to_string())
        .unwrap();

    let detail: serde_json::Value = serde_json::from_str(&h.host.session("s").unwrap()).unwrap();
    let messages = detail["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["reasoning_content"], "needs a tool");
    assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "ble_scan");
    assert_eq!(messages[2]["tool_call_id"], "call_1");
    assert_eq!(detail["meta"]["running"], false);

    // And it shows up in the list with the system message excluded from counts.
    let sessions: serde_json::Value =
        serde_json::from_str(&h.host.sessions().unwrap()).unwrap();
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    assert_eq!(sessions[0]["id"], "s");
    assert_eq!(sessions[0]["message_count"], 3);
    assert_eq!(sessions[0]["running"], false);
}

fn ack(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).expect("the ack is JSON")
}

#[wasm_bindgen_test]
fn a_turn_without_an_endpoint_is_refused_and_says_so_on_the_stream() {
    let h = Harness::new();
    h.watch("s1", "chat");
    h.clear();

    let reply = ack(&h.host.send("chat", "hello", "{}"));
    assert_eq!(reply["accepted"], false);
    assert_eq!(reply["reason"], "not_configured");

    // And it lands in the transcript, because that is where the user is looking.
    assert_eq!(
        h.payload("s1", "error")["message"],
        "no model endpoint configured"
    );
}

/// A session remembers which surface started it: the console's assistant panel
/// sends `origin: "terminal"`, the main chat sends nothing and gets `web` — and
/// the sessions page draws its glyph from this.
#[wasm_bindgen_test]
fn a_sessions_origin_is_the_surface_that_started_it() {
    let h = Harness::new();
    h.host.configure("https://api.example.com/v1", "key", "model");

    assert_eq!(
        ack(&h.host.send("term", "hi", r#"{"origin":"terminal"}"#))["accepted"],
        true
    );
    assert_eq!(ack(&h.host.send("chat", "hi", "{}"))["accepted"], true);

    let sessions: serde_json::Value = serde_json::from_str(&h.host.sessions().unwrap()).unwrap();
    let origin = |id: &str| {
        sessions
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap_or_else(|| panic!("session {id} is not listed"))["origin"]
            .clone()
    };
    assert_eq!(origin("term"), "terminal");
    assert_eq!(origin("chat"), "web", "unnamed surfaces stay the main chat");
}

/// The race this exists to prevent: the client posts, then attaches. If the turn
/// were only registered on a later microtask, that attach would find an idle
/// session, be sent `done`, and render a turn that ended before it started.
#[wasm_bindgen_test]
fn a_turn_is_visible_to_an_attach_that_follows_immediately() {
    let h = Harness::new();
    h.host.configure("https://api.example.com/v1", "key", "model");

    assert_eq!(ack(&h.host.send("chat", "hello", "{}"))["accepted"], true);
    h.watch("s1", "chat");

    let session = h.payload("s1", "session");
    assert_eq!(
        session["running"], true,
        "the turn must be registered before send returns"
    );
    assert!(
        !h.events("s1").contains(&"done".to_string()),
        "an attach during a live turn must not be closed out"
    );

    // And the same turn is reported as running by the session list.
    let sessions: serde_json::Value = serde_json::from_str(&h.host.sessions().unwrap()).unwrap();
    assert_eq!(sessions[0]["running"], true);
}

/// The bug this exists to prevent: the UI adds the user's message to its own
/// transcript on send and then attaches, and it *replaces* that transcript with
/// whatever `history` carries. Nothing is committed to the store until the turn
/// ends, so a `history` frame assembled from the store alone would arrive a
/// moment later and delete the message the user just watched itself send.
#[wasm_bindgen_test]
fn history_carries_the_message_the_turn_was_started_with() {
    let h = Harness::new();
    h.host.configure("https://api.example.com/v1", "key", "model");

    h.host.send("chat", "scan for devices", "{}");
    h.watch("s1", "chat");

    let messages = h.payload("s1", "history")["messages"].clone();
    let messages = messages.as_array().unwrap();
    assert_eq!(
        messages.len(),
        1,
        "the staged message is missing from history: {messages:?}"
    );
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "scan for devices");

    // The system prompt is staged alongside it and is not the user's to see —
    // the same rule the stored half of history follows.
    assert!(
        !messages.iter().any(|m| m["role"] == "system"),
        "the system prompt leaked into the transcript: {messages:?}"
    );
}

/// Full-auto is per session and outlives the turn it was granted in, which is
/// what "always allow" means to the person who clicked it. It is memory-only,
/// so a reload asks again — deliberate, and upstream's behaviour too.
#[wasm_bindgen_test]
fn full_auto_is_remembered_for_the_session_that_granted_it() {
    let h = Harness::new();
    h.host.configure("https://api.example.com/v1", "key", "model");
    // A stored session to read back: `session()` answers `null` for an id that
    // has never been written, and every assertion below would pass against it.
    h.host.import_session("chat", "[]").unwrap();

    // Off by default, and reported so on every surface the badge reads.
    h.watch("s1", "chat");
    assert_eq!(h.payload("s1", "session")["auto_confirm"], false);
    h.clear();

    // Granted the way the confirm bar grants it: an approval that says "and
    // stop asking". The flag is set here rather than only inside the loop, so a
    // client reading session state straight after sees what it just turned on.
    h.host.confirm("chat", None, true, true, None);

    h.watch("s2", "chat");
    assert_eq!(
        h.payload("s2", "session")["auto_confirm"], true,
        "a reattach must not report the badge as off"
    );

    let detail: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    assert_eq!(detail["meta"]["auto_confirm"], true);

    // And the next turn in that session starts with it still on, which is the
    // part that was broken: the flag used to live for one turn only.
    assert_eq!(ack(&h.host.send("chat", "again", "{}"))["auto_confirm"], true);

    // Another session is unaffected: this is not a global switch.
    h.watch("s3", "other");
    assert_eq!(h.payload("s3", "session")["auto_confirm"], false);
}

#[wasm_bindgen_test]
fn full_auto_can_be_turned_off_again() {
    let h = Harness::new();
    h.host.set_auto("chat", true);
    h.watch("s1", "chat");
    assert_eq!(h.payload("s1", "session")["auto_confirm"], true);
    h.clear();

    h.host.set_auto("chat", false);
    h.watch("s2", "chat");
    assert_eq!(h.payload("s2", "session")["auto_confirm"], false);

    // Deleting the conversation takes the grant with it: an id that came back
    // round must start by asking again.
    h.host.set_auto("chat", true);
    h.host.delete_session("chat").unwrap();
    h.clear();
    h.watch("s3", "chat");
    assert_eq!(h.payload("s3", "session")["auto_confirm"], false);
}

/// The follow stream's reason for existing: a turn nobody on this connection
/// asked for still shows up on it. That covers a queued message starting by
/// itself and a second tab sending one — the UI keeps one stream per open
/// conversation and never decides when to re-attach.
#[wasm_bindgen_test]
fn a_following_stream_is_told_when_the_next_turn_starts() {
    let h = Harness::new();
    h.host.configure("https://api.example.com/v1", "key", "model");

    h.follow("f", "chat");
    h.watch("w", "chat");
    assert_eq!(h.events("f"), vec!["session", "history", "done"]);
    h.clear();

    h.host.send("chat", "scan for devices", "{}");

    // A full snapshot, not just live frames: `session` re-asserts that a turn
    // is running — which is what turns the composer back into its streaming
    // state — and `history` carries the message being answered, so the
    // transcript is right even in a tab that never saw it sent.
    assert_eq!(h.events("f"), vec!["session", "history"]);
    assert_eq!(h.payload("f", "session")["running"], true);
    assert_eq!(
        h.payload("f", "history")["messages"][0]["content"],
        "scan for devices"
    );

    // The turn-scoped stream gets nothing: its `done` ended it, and re-opening
    // it is its client's business.
    assert!(
        h.events("w").is_empty(),
        "a turn-scoped stream was re-snapshotted: {:?}",
        h.events("w")
    );
}

/// "Edit & resend": the conversation is truncated at the chosen message, in the
/// store as well as in what the next turn will send.
#[wasm_bindgen_test]
fn rewinding_discards_a_message_and_everything_after_it() {
    let h = Harness::new();
    let transcript = serde_json::json!([
        { "role": "system", "content": "you are a gateway agent" },
        { "role": "user", "content": "scan for devices" },
        { "role": "assistant", "content": "found three" },
        { "role": "user", "content": "connect to the first" },
        { "role": "assistant", "content": "connected" },
    ]);
    h.host
        .import_session("chat", &transcript.to_string())
        .unwrap();
    h.follow("f", "chat");
    h.clear();

    let reply = ack(&h.host.rewind("chat", 1));
    assert_eq!(reply["ok"], true, "{reply}");
    // Counted as the UI counts: the system prompt is not part of the
    // conversation.
    assert_eq!(reply["message_count"], 2);

    let detail: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    let kept: Vec<&str> = detail["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert_eq!(
        kept,
        vec!["scan for devices", "found three"],
        "the rewound half must be gone from the store too"
    );

    // Other tabs converge rather than keeping a transcript that no longer
    // exists.
    assert_eq!(h.events("f"), vec!["session", "history", "done"]);
    assert_eq!(
        h.payload("f", "history")["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // An index past the end changes nothing.
    let refused = ack(&h.host.rewind("chat", 9));
    assert_eq!(refused["ok"], false);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&h.host.session("chat").unwrap()).unwrap()
            ["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

/// A rewind rewrites the rows a running turn is about to write. Refused rather
/// than raced, and the client is told to cancel first.
#[wasm_bindgen_test]
fn rewinding_is_refused_while_a_turn_is_running() {
    let h = Harness::new();
    h.host.configure("https://api.example.com/v1", "key", "model");
    h.host.import_session("chat", "[]").unwrap();

    h.host.send("chat", "hello", "{}");
    let refused = ack(&h.host.rewind("chat", 0));
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["error"], "turn_in_flight");
}

#[wasm_bindgen_test]
fn a_second_turn_is_refused_while_one_is_in_flight() {
    let h = Harness::new();
    h.host.configure("https://api.example.com/v1", "key", "model");

    assert_eq!(ack(&h.host.send("chat", "one", "{}"))["accepted"], true);
    let second = ack(&h.host.send("chat", "two", "{}"));
    assert_eq!(second["accepted"], false);
    assert_eq!(
        second["reason"], "turn_in_flight",
        "the client maps this to HTTP 409 and attaches instead"
    );

    // A different session is unaffected.
    assert_eq!(ack(&h.host.send("other", "hello", "{}"))["accepted"], true);
}

#[wasm_bindgen_test]
fn detach_stops_delivery_and_is_idempotent() {
    let h = Harness::new();
    h.watch("s1", "chat");
    assert!(!h.events("s1").is_empty());

    h.host.detach("s1");
    h.host.detach("s1"); // second call must not panic
    h.clear();

    h.host.send("chat", "hello", "{}");
    assert!(
        h.events("s1").is_empty(),
        "a detached stream must stop receiving frames"
    );
}

/// A session with a turn in flight must not be overwritten from underneath it.
#[wasm_bindgen_test]
fn import_refuses_to_race_a_running_turn() {
    let h = Harness::new();
    // No turn: accepted.
    h.host.import_session("s", "[]").unwrap();

    // Malformed input is rejected rather than silently storing nothing.
    assert!(h.host.import_session("s", "not json").is_err());
}

#[wasm_bindgen_test]
fn two_streams_on_one_session_both_get_the_opening_frames() {
    let h = Harness::new();
    h.watch("a", "chat");
    h.watch("b", "chat");

    for stream in ["a", "b"] {
        assert_eq!(
            h.events(stream),
            vec!["session", "history", "done"],
            "stream {stream}"
        );
    }
}

#[wasm_bindgen_test]
fn session_queries_return_json_the_client_can_use() {
    let h = Harness::new();

    assert_eq!(h.host.sessions().unwrap(), "[]");
    assert_eq!(h.host.session("nope").unwrap(), "null");

    let hits: serde_json::Value = serde_json::from_str(&h.host.search("", 10, None).unwrap())
        .expect("search returns valid JSON");
    assert_eq!(hits.as_array().unwrap().len(), 0);

    // Updating a session that does not exist is a no-op rather than an error,
    // matching the store.
    h.host.update_session("nope", Some("t".into()), Some(true)).unwrap();
    h.host.delete_session("nope").unwrap();
}

#[wasm_bindgen_test]
async fn an_unconfigured_host_lists_no_models_rather_than_failing() {
    let h = Harness::new();
    // The UI asks for this at boot, before anyone has entered an endpoint. An
    // error here would surface as a failed load; an empty list is simply a
    // model badge with nothing to pick from.
    assert_eq!(h.host.models().await, "[]");
}

// A configured host running a real turn is deliberately not tested here: it
// would need a reachable model endpoint, and the client's retry/backoff would
// make the test slow and flaky. That path is covered end to end against a live
// endpoint when the fetch shim lands.
