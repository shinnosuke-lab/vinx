//! Real turns against a real socket.
//!
//! `host.rs` covers the bookkeeping around a turn while stubbing the model out.
//! This covers the part that stub hides: reqwest running on the browser's fetch,
//! a chunked response, SSE records reassembled across chunk boundaries, and
//! tool-call arguments accumulated from fragments. That code is shared with the
//! native build but it is the most likely to behave differently under wasm, so
//! it is worth exercising rather than assuming.
//!
//! Needs the mock endpoint from `runtime/test/mock-llm.mjs`; `deploy/test.sh`
//! starts it and passes the URL in. Without it these are skipped rather than
//! failed, so `cargo test` on its own stays useful.

#![cfg(feature = "sqlite")]

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use agent_web_core::host::AgentHost;
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

/// Where `deploy/test.sh` put the mock endpoint, if it is running.
const MOCK: Option<&str> = option_env!("MOCK_LLM_URL");

struct Harness {
    host: AgentHost,
    frames: Rc<RefCell<Vec<(String, String)>>>,
    _sink: Closure<dyn FnMut(String, String)>,
}

impl Harness {
    /// A host pointed at a mock scenario, not yet watching anything.
    fn against(scenario: &str) -> Harness {
        let frames = Rc::new(RefCell::new(Vec::new()));
        let recorder = frames.clone();
        let sink = Closure::wrap(Box::new(move |stream: String, frame: String| {
            recorder.borrow_mut().push((stream, frame));
        }) as Box<dyn FnMut(String, String)>);

        let host = AgentHost::new(sink.as_ref().unchecked_ref::<js_sys::Function>().clone())
            .expect("host over an in-memory store");
        host.configure(MOCK.unwrap(), "test-key", scenario);

        Harness {
            host,
            frames,
            _sink: sink,
        }
    }

    /// Start a turn and watch it, in the order the real client does it: post
    /// first, then attach. Attaching first would add the idle session's own
    /// `done` to the log and make "did the turn finish" ambiguous.
    fn run(&self, text: &str) -> serde_json::Value {
        self.run_with(text, "{}")
    }

    /// The same, with the per-turn options `POST /api/chat` carries.
    fn run_with(&self, text: &str, options: &str) -> serde_json::Value {
        let ack = serde_json::from_str(&self.host.send("chat", text, options)).expect("a JSON ack");
        self.host.attach("s1", "chat", true);
        ack
    }

    fn events(&self) -> Vec<String> {
        self.frames
            .borrow()
            .iter()
            .filter(|(s, _)| s == "s1")
            .filter_map(|(_, f)| {
                f.lines()
                    .find_map(|l| l.strip_prefix("event: ").map(str::to_string))
            })
            .collect()
    }

    /// Every payload sent under this event name, in order.
    fn payloads(&self, event: &str) -> Vec<serde_json::Value> {
        let want = format!("event: {event}\n");
        self.frames
            .borrow()
            .iter()
            .filter(|(s, f)| s == "s1" && f.starts_with(&want))
            .filter_map(|(_, f)| {
                f.lines()
                    .find_map(|l| l.strip_prefix("data: "))
                    .and_then(|d| serde_json::from_str(d).ok())
            })
            .collect()
    }

    /// Concatenated `content` text, as the UI would render it.
    fn text(&self) -> String {
        self.payloads("content")
            .iter()
            .filter_map(|p| p["text"].as_str().map(str::to_string))
            .collect()
    }

    /// Wait for an event to show up. Returns false if it never does.
    async fn wait_for(&self, event: &str, tries: u32) -> bool {
        for _ in 0..tries {
            if self.events().iter().any(|e| e == event) {
                return true;
            }
            wasmtimer::tokio::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    /// Wait for the turn to end. Returns false if it never does.
    ///
    /// `done` closes every turn, successful or not; `error` is checked too so a
    /// turn that fails before reaching `done` fails fast instead of at timeout.
    async fn settled(&self) -> bool {
        for _ in 0..200 {
            let events = self.events();
            if events.iter().any(|e| e == "done" || e == "error") {
                return true;
            }
            wasmtimer::tokio::sleep(Duration::from_millis(25)).await;
        }
        false
    }
}

/// Skip rather than fail when the mock is not running.
macro_rules! require_mock {
    () => {
        if MOCK.is_none() {
            return;
        }
    };
}

#[wasm_bindgen_test]
async fn a_turn_streams_prose_from_a_real_endpoint() {
    require_mock!();
    let h = Harness::against("mock-text");

    h.run("hi");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    assert_eq!(
        h.text(),
        "Hello, world",
        "deltas must arrive in order and be stitched without loss"
    );
    // More than one frame, or nothing was actually streamed.
    assert!(
        h.payloads("content").len() > 1,
        "the response was delivered in one lump, so nothing streamed"
    );
    assert!(!h.events().contains(&"error".to_string()));
}

/// Providers append a usage record after the last choice when asked for one;
/// the engine reports it as its own frame, after the answer and before `done`,
/// so the UI can show a turn's cost and the estimator can calibrate itself
/// on the real `prompt_tokens`.
#[wasm_bindgen_test]
async fn token_usage_is_reported_after_the_answer() {
    require_mock!();
    let h = Harness::against("mock-text");

    h.run("hi");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    let usage = h.payloads("usage");
    assert_eq!(usage.len(), 1, "exactly one usage frame per model round: {usage:?}");
    assert_eq!(usage[0]["prompt_tokens"], 1234);
    assert_eq!(usage[0]["completion_tokens"], 5);
    // Nothing cached on this stream — reported as zero, not omitted.
    assert_eq!(usage[0]["cached_tokens"], 0);
    assert_eq!(usage[0]["model"], "mock-text");
    let events = h.events();
    let usage_at = events.iter().position(|e| e == "usage").unwrap();
    let done_at = events.iter().rposition(|e| e == "done").unwrap();
    assert!(usage_at < done_at, "usage must land before done: {events:?}");
}

/// The composer's picker sends its choice with the message rather than saving
/// it, so the endpoint and key stay the configured ones and only the model
/// changes. The mock keys its scenarios off the model name, which makes a turn
/// that plays a scenario the host was never configured with the proof that the
/// override reached the wire.
#[wasm_bindgen_test]
async fn a_turn_can_name_a_model_the_host_was_not_configured_with() {
    require_mock!();
    let h = Harness::against("mock-text");

    h.run_with("hi", r#"{"model":"mock-reasoning"}"#);
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );
    assert_eq!(
        h.text(),
        "answer",
        "the turn ran on the configured model, so the override was dropped"
    );
}

#[wasm_bindgen_test]
async fn a_blank_override_leaves_the_configured_model_alone() {
    require_mock!();
    let h = Harness::against("mock-text");

    // What the UI sends when the picker is showing the default: the field is
    // present but says nothing. Taking it literally would ask for a model
    // named "   ".
    h.run_with("hi", r#"{"model":"   "}"#);
    assert!(h.settled().await);
    assert_eq!(h.text(), "Hello, world");
}

/// Half of what the picker needs; the other half is `meta.model`, which the
/// fetch shim fills in. With an empty list the UI shows a read-only badge.
#[wasm_bindgen_test]
async fn the_endpoint_is_asked_which_models_it_has() {
    require_mock!();
    let h = Harness::against("mock-text");

    let models: Vec<String> =
        serde_json::from_str(&h.host.models().await).expect("a JSON array of ids");
    assert!(
        models.contains(&"mock-text".to_string()),
        "the endpoint's own list did not come back: {models:?}"
    );
}

#[wasm_bindgen_test]
async fn a_streamed_answer_is_persisted_and_replays_on_reattach() {
    require_mock!();
    let h = Harness::against("mock-text");

    h.run("hi");
    assert!(h.settled().await);

    let detail: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    let messages = detail["messages"].as_array().expect("a saved transcript");
    let roles: Vec<&str> = messages.iter().filter_map(|m| m["role"].as_str()).collect();
    assert_eq!(
        roles,
        vec!["user", "assistant"],
        "both halves of the exchange must survive the turn: {messages:?}"
    );
    assert_eq!(messages[1]["content"], "Hello, world");
}

/// An unnamed session names itself after its first question, and says so on the
/// stream — otherwise the sidebar is a column of identical "Untitled" rows and
/// the only way to tell two conversations apart is to open them.
#[wasm_bindgen_test]
async fn a_finished_turn_names_the_session_it_ran_in() {
    require_mock!();
    let h = Harness::against("mock-text");

    h.run("  which devices are\nnearby  ");
    assert!(h.settled().await);

    // Single-lined and trimmed, as upstream derives it.
    assert_eq!(
        h.payloads("title").first().map(|p| p["title"].clone()),
        Some(serde_json::json!("which devices are nearby")),
        "no title frame: {:?}",
        h.events()
    );
    // Before `done`, because a client that has seen the turn end may already
    // have stopped reading the stream.
    let events = h.events();
    let title = events.iter().position(|e| e == "title");
    let done = events.iter().position(|e| e == "done");
    assert!(title < done, "title must precede done: {events:?}");

    let detail: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    assert_eq!(detail["meta"]["title"], "which devices are nearby");

    // A second turn leaves it alone: the name came from the question that
    // opened the conversation, and renaming it on every answer would make the
    // sidebar move under the reader.
    h.host.detach("s1");
    h.frames.borrow_mut().clear();
    h.run("and now");
    assert!(h.settled().await);
    assert!(
        h.payloads("title").is_empty(),
        "a named session was renamed: {:?}",
        h.payloads("title")
    );

    // Nor does a name the user typed get overwritten by the next turn. This is
    // the same check as above from the other side: what protects the rename is
    // that the title is no longer empty, not that a title was derived once.
    h.host
        .update_session("chat", Some("device audit".into()), None, None, None)
        .unwrap();
    h.host.detach("s1");
    h.frames.borrow_mut().clear();
    h.run("once more");
    assert!(h.settled().await);
    assert!(h.payloads("title").is_empty());

    let detail: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    assert_eq!(detail["meta"]["title"], "device audit");
}

#[wasm_bindgen_test]
async fn reasoning_is_reported_separately_from_the_answer() {
    require_mock!();
    let h = Harness::against("mock-reasoning");

    h.run("hi");
    assert!(h.settled().await);

    let reasoning: String = h
        .payloads("reasoning")
        .iter()
        .filter_map(|p| p["text"].as_str().map(str::to_string))
        .collect();
    assert_eq!(reasoning, "thinking harder");
    assert_eq!(
        h.text(),
        "answer",
        "reasoning must not leak into the visible answer"
    );
}

#[wasm_bindgen_test]
async fn an_sse_record_split_across_chunks_is_still_read() {
    require_mock!();
    let h = Harness::against("mock-split");

    h.run("hi");
    assert!(h.settled().await);
    assert_eq!(h.text(), "split across chunks");
}

#[wasm_bindgen_test]
async fn comments_and_malformed_records_are_skipped() {
    require_mock!();
    let h = Harness::against("mock-noise");

    h.run("hi");
    assert!(h.settled().await);
    assert_eq!(
        h.text(),
        "survived",
        "one unparseable record must not sink the stream"
    );
}

/// Frames must reach the client while the turn is still open.
///
/// The weaker "did every delta arrive" check passes even when the whole turn is
/// buffered and flushed at the end, which is not streaming at all.
#[wasm_bindgen_test]
async fn frames_arrive_while_the_turn_is_still_running() {
    require_mock!();
    let h = Harness::against("mock-slow");

    h.run("hi");
    assert!(h.wait_for("content", 200).await, "no content ever arrived");
    assert!(
        !h.events().contains(&"done".to_string()),
        "the first delta only appeared once the turn had ended, so nothing streamed"
    );
    assert_eq!(h.text(), "first", "and it is the first delta, not both");

    assert!(h.settled().await);
    assert_eq!(h.text(), "firstsecond");
}

/// The full tool leg: the call is announced, the user is asked, and the answer
/// lets the loop finish. This deadlocks if frames are not pumped concurrently —
/// the decision can only be made after the `confirm` frame has been delivered.
#[wasm_bindgen_test]
async fn a_tool_call_is_announced_gated_and_resumed() {
    require_mock!();
    let h = Harness::against("mock-tool");

    h.run("read a file");

    assert!(
        h.wait_for("tool_start", 200).await,
        "the tool call never reached the stream: {:?}",
        h.events()
    );
    let starts = h.payloads("tool_start");
    assert_eq!(starts[0]["name"], "no_such_tool");

    // The arguments were streamed as `{"pa` + `th":"/tmp/x"}`; anything parsing
    // per-chunk would have dropped or mangled them.
    let args: String = h
        .payloads("tool_args")
        .iter()
        .filter_map(|p| p["delta"].as_str().map(str::to_string))
        .collect();
    assert_eq!(args, r#"{"path":"/tmp/x"}"#);

    // No tool is registered here, so it gates as Dangerous and asks first.
    assert!(
        h.wait_for("confirm", 200).await,
        "an unregistered tool must be gated, not run: {:?}",
        h.events()
    );
    assert_eq!(h.payloads("confirm")[0]["name"], "no_such_tool");

    h.host.confirm("chat", None, true, false, None);

    assert!(
        h.settled().await,
        "the turn never resumed after the decision: {:?}",
        h.events()
    );
    assert!(
        !h.payloads("tool_result").is_empty(),
        "the tool's outcome must reach the client"
    );
    assert_eq!(
        h.text(),
        "done with the tool",
        "the transcript with the tool result must go back to the model"
    );
}

#[wasm_bindgen_test]
async fn declining_a_tool_still_lets_the_turn_finish() {
    require_mock!();
    let h = Harness::against("mock-tool");

    h.run("read a file");
    assert!(h.wait_for("confirm", 200).await);

    h.host.confirm("chat", None, false, false, None);

    assert!(
        h.settled().await,
        "a declined tool must close the turn, not strand it: {:?}",
        h.events()
    );
}

/// `recall_result` is loop-intercepted, like `ask_user`: were it looked up in
/// the registry it would gate as an unknown (Dangerous) tool and stall on a
/// `confirm` frame — so a turn that finishes with no confirm, carrying a
/// structured miss the model then echoes, is the proof of interception.
#[wasm_bindgen_test]
async fn recall_result_is_intercepted_and_a_miss_is_structured() {
    require_mock!();
    let h = Harness::against("mock-recall-miss");

    h.run("recall something");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    assert!(
        !h.events().contains(&"confirm".to_string()),
        "recall_result must be intercepted before the dangerous-tool gate"
    );
    let results = h.payloads("tool_result");
    assert!(!results.is_empty(), "the recall call was never answered");
    let body = results[0]["result"].as_str().unwrap_or_default();
    assert!(
        body.contains("No tool result with call_id=\"call_ghost\""),
        "a structured miss, not an unknown-tool reply: {body}"
    );
    assert!(
        h.text().contains("tool said:"),
        "the miss must ride back to the model like any tool result"
    );
}

/// `update_task_state` is the other loop-intercepted synthetic: it must be
/// acknowledged without a gate, and the ack must ride back to the model.
#[wasm_bindgen_test]
async fn update_task_state_is_intercepted_and_acknowledged() {
    require_mock!();
    let h = Harness::against("mock-task-state");

    h.run("work on something long");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    assert!(
        !h.events().contains(&"confirm".to_string()),
        "update_task_state must be intercepted before the dangerous-tool gate"
    );
    let results = h.payloads("tool_result");
    assert!(!results.is_empty(), "the call was never answered");
    let body = results[0]["result"].as_str().unwrap_or_default();
    assert!(
        body.contains("Task state recorded"),
        "a validation ack, not an unknown-tool reply: {body}"
    );
}

/// A block over the 2000-character target but under the 4000 cap is kept —
/// refusing it would only make the model retry a slightly shorter one at the
/// full price — and the ack says so, so the next write shrinks.
#[wasm_bindgen_test]
async fn an_over_target_task_state_is_accepted_with_a_nudge() {
    require_mock!();
    let h = Harness::against("mock-task-state-long");

    h.run("work on something long");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    let results = h.payloads("tool_result");
    assert!(!results.is_empty(), "the call was never answered");
    let body = results[0]["result"].as_str().unwrap_or_default();
    assert!(
        body.contains("Task state recorded") && body.contains("over the 2000"),
        "accepted, but told to trim next time: {body}"
    );
}

/// The intercepted synthetics must not bypass the consecutive-failure
/// breaker: a model re-recalling the same missing call_id gets three
/// structured misses, and the fourth identical call is [BLOCKED].
#[wasm_bindgen_test]
async fn a_repeatedly_missed_recall_trips_the_breaker() {
    require_mock!();
    let h = Harness::against("mock-recall-breaker");

    h.run("recall the same ghost forever");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    let results = h.payloads("tool_result");
    assert_eq!(
        results.len(),
        4,
        "three misses then the block, nothing more: {results:?}"
    );
    for miss in &results[..3] {
        let body = miss["result"].as_str().unwrap_or_default();
        assert!(
            body.contains("No tool result with call_id=\"call_ghost\""),
            "the first three are honest misses: {body}"
        );
    }
    let fourth = results[3]["result"].as_str().unwrap_or_default();
    assert!(
        fourth.contains("[BLOCKED]"),
        "the fourth identical call must be cut off: {fourth}"
    );
    assert!(
        h.text().contains("blocked after 4 attempts"),
        "the mock stops the moment it sees the block: {}",
        h.text()
    );
}

#[wasm_bindgen_test]
async fn an_upstream_error_status_is_reported_on_the_stream() {
    require_mock!();
    let h = Harness::against("mock-500");

    h.run("hi");
    assert!(h.settled().await, "a failed turn must still settle");

    assert!(
        h.events().contains(&"error".to_string()),
        "an upstream 500 must surface, not hang: {:?}",
        h.events()
    );
}

/// vinx: the provider's overflow verdict (HTTP 400 `context_length_exceeded`)
/// is not an error the user sees — the loop compacts what is OLDER than the
/// live message (forced) and replays once. The turn ends in prose; the failed
/// round left nothing behind; the compaction shows as a status, not as an
/// error; the message that provoked the verdict is still in the history
/// verbatim.
#[wasm_bindgen_test]
async fn a_context_overflow_verdict_compacts_and_replays_once() {
    require_mock!();
    let h = Harness::against("mock-overflow-once");

    // History to shed: a first exchange the mock simply acknowledges.
    let report = format!("Here is the report: {}", "lorem ipsum ".repeat(300));
    h.run(&report);
    assert!(h.settled().await, "the opening turn must settle");
    assert_eq!(h.text(), "Noted.");
    h.host.detach("s1");
    h.frames.borrow_mut().clear();

    h.run("does it overflow?");
    assert!(h.settled().await, "the replayed turn must settle");

    let events = h.events();
    assert!(
        !events.contains(&"error".to_string()),
        "an overflow verdict must be absorbed by compaction, not surfaced: {events:?}"
    );
    assert_eq!(h.text(), "Fits now", "the replay's prose is the turn's answer");
    let statuses: Vec<String> = h
        .payloads("status")
        .iter()
        .filter_map(|p| p["text"].as_str().map(str::to_string))
        .collect();
    assert!(
        statuses.iter().any(|t| t.starts_with("Compacting context")),
        "the forced compaction must announce itself: {statuses:?}"
    );
    // The history now opens with the summary the mock's summarizer wrote —
    // proof the replay went out over a compacted transcript, not a retry of
    // the same bytes.
    let session: serde_json::Value =
        serde_json::from_str(&h.host.session("chat").expect("a session")).expect("a session document");
    let history = session["messages"].as_array().expect("messages");
    assert!(
        history.iter().any(|m| m["role"] == "user"
            && m["content"]
                .as_str()
                .is_some_and(|c| c.starts_with("[Conversation Summary]"))),
        "no summary in the persisted history: {history:?}"
    );
    assert!(
        history.iter().any(|m| m["role"] == "user" && m["content"] == "does it overflow?"),
        "the live message must survive the compaction verbatim: {history:?}"
    );
    assert!(
        !history.iter().any(|m| m["content"].as_str().is_some_and(|c| c.starts_with("Here is the report"))),
        "the older exchange is what should have been summarized: {history:?}"
    );
}

/// vinx: when the message that overflowed IS the live one and nothing older is
/// left to shed, compaction cannot help — summarizing the message to a 500-char
/// head would have the model answer a question it never saw. The verdict is
/// surfaced instead (the user can shorten the message), the history is left
/// intact, and the compaction reports itself as skipped rather than pretending.
#[wasm_bindgen_test]
async fn an_overflowing_message_is_refused_rather_than_summarized_away() {
    require_mock!();
    let h = Harness::against("mock-overflow-once");

    let paste = format!("overflow test: {}", "lorem ipsum ".repeat(300));
    h.run(&paste);
    assert!(h.settled().await, "the refused turn must settle");

    let events = h.events();
    assert!(
        events.contains(&"error".to_string()),
        "with nothing older to shed the provider's verdict must surface: {events:?}"
    );
    let statuses: Vec<String> = h
        .payloads("status")
        .iter()
        .filter_map(|p| p["text"].as_str().map(str::to_string))
        .collect();
    assert!(
        statuses.iter().any(|t| t.contains("exceeds the model's context window")),
        "the skipped compaction must say why: {statuses:?}"
    );
    let session: serde_json::Value =
        serde_json::from_str(&h.host.session("chat").expect("a session")).expect("a session document");
    let history = session["messages"].as_array().expect("messages");
    assert!(
        !history.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|c| c.starts_with("[Conversation Summary]"))),
        "the live message must not have been summarized away: {history:?}"
    );
    assert!(
        history.iter().any(|m| m["role"] == "user" && m["content"] == paste),
        "the user's message must be in the history verbatim: {history:?}"
    );
}

/// The classifier behind that replay: status-gated, phrase-matched. A 200
/// whose content merely talks about context length, or a 429 quoting a token
/// limit, is not an overflow.
#[wasm_bindgen_test]
fn only_a_4xx_naming_the_context_limit_reads_as_overflow() {
    use agent_web_core::client::error_is_context_overflow as overflow;
    assert!(overflow(
        "LLM API error: 400 Bad Request {\"error\":{\"code\":\"context_length_exceeded\"}}"
    ));
    assert!(overflow(
        "LLM API error: 400 Bad Request {\"error\":{\"message\":\"Input exceeded model token limit\"}}"
    ));
    assert!(overflow(
        "LLM API error: 413 Payload Too Large {\"error\":{\"message\":\"prompt is too long\"}}"
    ));
    assert!(overflow(
        "LLM API error: 400 Bad Request {\"message\":\"The input token count (300000) exceeds the maximum\"}"
    ));
    assert!(!overflow("LLM API error: 429 Too Many Requests token limit reached, retry later"));
    // Groq's tokens-per-minute overrun: same status family, same "too large"
    // wording, but a rate limit — a wait, not a compaction.
    assert!(!overflow(
        "LLM API error: 413 Payload Too Large {\"error\":{\"message\":\"Request too large for model \
         `llama-3.3-70b` in organization `org` on tokens per minute (TPM): Limit 6000, Requested 7001\",\
         \"type\":\"tokens\",\"code\":\"rate_limit_exceeded\"}}"
    ));
    assert!(!overflow("LLM API error: 400 Bad Request {\"error\":{\"message\":\"invalid temperature\"}}"));
    assert!(!overflow("LLM API error: 401 Unauthorized bad key"));
    assert!(!overflow("LLM stream ended before a terminal marker; maximum context length"));
}

#[wasm_bindgen_test]
async fn a_rejected_key_is_reported_rather_than_retried_forever() {
    require_mock!();
    let h = Harness::against("mock-401");

    h.run("hi");
    assert!(h.settled().await, "a 401 must settle rather than spin");
    assert!(h.events().contains(&"error".to_string()));
}

#[wasm_bindgen_test]
async fn a_truncated_stream_ends_the_turn_instead_of_hanging() {
    require_mock!();
    let h = Harness::against("mock-truncated");

    h.run("hi");
    assert!(
        h.settled().await,
        "a stream that stops without [DONE] must still close the turn"
    );
}

/// The composer's "send when it finishes": a second message parks behind the
/// running turn and starts on its own once that turn ends, without the user
/// having to come back and press send again.
#[wasm_bindgen_test]
async fn a_message_sent_during_a_turn_waits_and_then_runs() {
    require_mock!();
    let h = Harness::against("mock-slow");

    h.run("hi");
    assert!(
        h.wait_for("content", 200).await,
        "the first turn never started"
    );

    let ack: serde_json::Value =
        serde_json::from_str(&h.host.send("chat", "and then this", r#"{"queue":true}"#)).unwrap();
    assert_eq!(ack["queued"], true, "the second message was refused: {ack}");
    assert_eq!(ack["position"], 1);

    // Everyone watching is told what is waiting, not just whoever queued it.
    let queued = h.payloads("queue");
    assert_eq!(
        queued.last().map(|p| p["items"][0]["message"].clone()),
        Some(serde_json::json!("and then this")),
        "no queue frame: {:?}",
        h.events()
    );

    // Two turns, so two `done` frames, and the queue empties on the way.
    for _ in 0..400 {
        if h.events().iter().filter(|e| *e == "done").count() >= 2 {
            break;
        }
        wasmtimer::tokio::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        h.events().iter().filter(|e| *e == "done").count(),
        2,
        "the queued message never ran: {:?}",
        h.events()
    );

    let detail: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    let asked: Vec<&str> = detail["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert_eq!(asked, vec!["hi", "and then this"]);
}

/// Stop must work while the upstream is still silent — before a single byte
/// of the response, where nothing is streaming and no delta loop is polling
/// the flag. The mock withholds its headers for 3s; a cancel at ~300ms has
/// to close the turn well inside that, with no prose and no error.
#[wasm_bindgen_test]
async fn a_stop_during_the_wait_for_headers_ends_the_turn_at_once() {
    require_mock!();
    let h = Harness::against("mock-slow-headers");

    h.run("hi");
    wasmtimer::tokio::sleep(Duration::from_millis(300)).await;
    let started = wasmtimer::std::Instant::now();
    h.host.cancel("chat");

    assert!(h.settled().await, "the cancelled turn never settled");
    let took = started.elapsed();
    assert!(
        took < Duration::from_millis(2000),
        "stop waited for the upstream instead of aborting the request: {took:?}"
    );
    let events = h.events();
    assert!(
        events.contains(&"done".to_string()) && !events.contains(&"error".to_string()),
        "a stop is a clean end, not a failure: {events:?}"
    );
    assert_eq!(h.text(), "", "nothing from the aborted request may leak through");
}

/// "Send now": the message joins the turn already running rather than waiting
/// for it, and the model answers it in the same turn.
#[wasm_bindgen_test]
async fn a_message_can_be_injected_into_the_running_turn() {
    require_mock!();
    let h = Harness::against("mock-slow");

    h.run("hi");
    assert!(h.wait_for("content", 200).await);
    assert!(h.host.steer("chat", "actually, this too"));

    assert!(
        h.wait_for("user_injected", 200).await,
        "the injected message never reached the stream: {:?}",
        h.events()
    );
    assert_eq!(
        h.payloads("user_injected")[0]["text"],
        "actually, this too",
        "the bubble the UI places has to carry the text"
    );
    assert!(h.settled().await);

    // Idle now, so there is nothing to steer and the client is told to send it
    // as a normal message instead.
    assert!(!h.host.steer("chat", "too late"));
}

/// A `task` call runs a child agent with a context of its own and reports one
/// answer back. Its transcript is kept for auditing but stays out of the
/// sidebar, which is what `origin = 'task'` is for.
#[wasm_bindgen_test]
async fn a_delegated_task_reports_back_from_a_hidden_transcript() {
    require_mock!();
    let h = Harness::against("mock-task");

    h.run("delegate something");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    // The parent answers from the child's report and nothing else: the child's
    // context never joins the parent's, which is the point of delegating.
    assert!(
        h.text().starts_with("sub-agent said: ") && h.text().contains("the child reporting in"),
        "the parent did not report what the child said: {}",
        h.text()
    );

    // The child's own frames arrive wrapped, so a UI can show its progress
    // without mistaking it for the parent's output.
    let subagent = h.payloads("subagent");
    assert!(
        !subagent.is_empty(),
        "no sub-agent frames were forwarded: {:?}",
        h.events()
    );
    assert_eq!(subagent[0]["task_id"], "call_task_1");
    // Every envelope names the task (its `description`) and the child's
    // transcript session, so a viewer that missed the parent's tool_start can
    // still title the progress row and deep-link to the live sub-session.
    for frame in &subagent {
        assert_eq!(frame["label"], "count to one", "unlabelled frame: {frame}");
        assert!(
            frame["session_id"]
                .as_str()
                .is_some_and(|s| s.starts_with("task-")),
            "frame without the child's session: {frame}"
        );
    }

    // What the parent model was handed, and where the transcript went. The
    // parent stream resolves the task call exactly once: `run_batch` emits it
    // as the child ends, and the loop must not repeat it.
    let parent_results: Vec<_> = h
        .payloads("tool_result")
        .into_iter()
        .filter(|r| r["id"] == "call_task_1")
        .collect();
    assert_eq!(
        parent_results.len(),
        1,
        "the task call resolved {} times on the parent stream: {:?}",
        parent_results.len(),
        h.events()
    );
    let report: serde_json::Value =
        serde_json::from_str(parent_results[0]["result"].as_str().unwrap()).unwrap();
    assert_eq!(report["ok"], true);
    assert_eq!(report["result"], "the child reporting in");
    let transcript = report["transcript_session_id"]
        .as_str()
        .expect("a transcript id");
    assert_eq!(
        subagent[0]["session_id"], transcript,
        "the envelopes and the report disagree on the child's session"
    );

    let sessions: serde_json::Value = serde_json::from_str(&h.host.sessions(None).unwrap()).unwrap();
    let listed: Vec<&str> = sessions
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["id"].as_str())
        .collect();
    assert!(
        !listed.contains(&transcript),
        "the sub-agent's transcript is in the sidebar: {listed:?}"
    );
    // Hidden, not discarded: it is still readable by id.
    let child: serde_json::Value =
        serde_json::from_str(&h.host.session(transcript).unwrap()).unwrap();
    assert!(
        child["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["content"].as_str() == Some("the child reporting in")),
        "the child's transcript was not persisted: {child}"
    );
    // ...and titled with the task's label, not left as an untitled "New chat"
    // (auto-titling only runs for user chats).
    assert_eq!(
        child["meta"]["title"], "count to one",
        "the child's transcript was not titled: {child}"
    );
}

/// The label a task rides under: its `description`, else the prompt's first
/// line, capped at 80 chars.
#[wasm_bindgen_test]
fn a_task_is_labelled_by_description_then_prompt() {
    use agent_web_core::agent_task::task_label;
    let label = task_label(&serde_json::json!({
        "description": "  count to one  ",
        "prompt": "Count to one and report back.",
    }));
    assert_eq!(label, "count to one");

    let label = task_label(&serde_json::json!({
        "description": "",
        "prompt": "\n  Summarise the log.\nThen stop.",
    }));
    assert_eq!(label, "Summarise the log.");

    let long = "x".repeat(200);
    let label = task_label(&serde_json::json!({ "prompt": long }));
    assert_eq!(label.chars().count(), 80);

    assert_eq!(task_label(&serde_json::json!({})), "");
}

#[wasm_bindgen_test]
async fn the_session_is_no_longer_running_once_the_turn_ends() {
    require_mock!();
    let h = Harness::against("mock-text");

    h.run("hi");
    assert!(h.settled().await);

    let sessions: serde_json::Value = serde_json::from_str(&h.host.sessions(None).unwrap()).unwrap();
    assert_eq!(
        sessions[0]["running"], false,
        "a finished turn must release the session, or the next send is refused"
    );
    // And the proof that it is released: another turn is accepted.
    let ack: serde_json::Value = serde_json::from_str(&h.host.send("chat", "again", "{}")).unwrap();
    assert_eq!(ack["accepted"], true);
}
