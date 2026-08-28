//! One real turn against a real provider.
//!
//! The mock endpoint in `turn.rs` covers the protocol thoroughly, but it is a
//! server written to agree with our reading of it. This checks that reading
//! against something we do not control: real TLS, a real provider's chunking,
//! its own idea of what an SSE record looks like, and its keep-alives.
//!
//! Opt-in. Set the endpoint and it runs; leave it unset and it skips, so the
//! default suite stays offline and free:
//!
//!     LIVE_BASE_URL=https://api.deepseek.com/v1 \
//!     LIVE_API_KEY=sk-... \
//!     LIVE_MODEL=deepseek-v4-pro \
//!     wasm-pack test --node --features sqlite --test live
//!
//! Read from the environment at runtime rather than with `option_env!` so the
//! key is never baked into a build artifact sitting in `target/`.

#![cfg(feature = "sqlite")]

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use agent_web_core::host::AgentHost;
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

/// `process.env[name]`, which is how the node test harness sees its environment.
fn env(name: &str) -> Option<String> {
    let process = js_sys::Reflect::get(&js_sys::global(), &"process".into()).ok()?;
    let env = js_sys::Reflect::get(&process, &"env".into()).ok()?;
    js_sys::Reflect::get(&env, &name.into()).ok()?.as_string()
}

struct Live {
    host: AgentHost,
    frames: Rc<RefCell<Vec<(String, String)>>>,
    _sink: Closure<dyn FnMut(String, String)>,
}

impl Live {
    /// `None` when the endpoint is not configured, which means skip.
    fn open() -> Option<Live> {
        let base_url = env("LIVE_BASE_URL")?;
        let api_key = env("LIVE_API_KEY").unwrap_or_default();
        let model = env("LIVE_MODEL")?;

        let frames = Rc::new(RefCell::new(Vec::new()));
        let recorder = frames.clone();
        let sink = Closure::wrap(Box::new(move |stream: String, frame: String| {
            recorder.borrow_mut().push((stream, frame));
        }) as Box<dyn FnMut(String, String)>);

        let host = AgentHost::new(sink.as_ref().unchecked_ref::<js_sys::Function>().clone())
            .expect("host over an in-memory store");
        host.configure(&base_url, &api_key, &model);

        Some(Live {
            host,
            frames,
            _sink: sink,
        })
    }

    fn run(&self, text: &str) {
        let ack: serde_json::Value =
            serde_json::from_str(&self.host.send("chat", text, "{}")).expect("a JSON ack");
        assert_eq!(ack["accepted"], true, "the turn was refused: {ack}");
        self.host.attach("s1", "chat", true);
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

    fn text(&self) -> String {
        self.payloads("content")
            .iter()
            .filter_map(|p| p["text"].as_str().map(str::to_string))
            .collect()
    }

    /// The reason a turn failed, if it did.
    fn error(&self) -> Option<String> {
        self.payloads("error")
            .first()
            .and_then(|p| p["message"].as_str().map(str::to_string))
    }

    /// Wait up to 60s — a real provider under load is slower than a mock.
    async fn settled(&self) -> bool {
        for _ in 0..600 {
            if self.events().iter().any(|e| e == "done" || e == "error") {
                return true;
            }
            wasmtimer::tokio::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    /// How many content frames had arrived by the time the first one did.
    async fn wait_for_first_content(&self) -> bool {
        for _ in 0..600 {
            if !self.payloads("content").is_empty() {
                return true;
            }
            if self.events().iter().any(|e| e == "error" || e == "done") {
                return false;
            }
            wasmtimer::tokio::sleep(Duration::from_millis(50)).await;
        }
        false
    }
}

#[wasm_bindgen_test]
async fn a_real_provider_streams_a_real_answer() {
    let Some(live) = Live::open() else {
        return; // not configured
    };

    live.run("Reply with exactly one word: pong");

    assert!(
        live.wait_for_first_content().await,
        "no content arrived; the turn reported: {:?}",
        live.error()
    );
    // Streaming, not a single buffered lump at the end.
    assert!(
        !live.events().contains(&"done".to_string()),
        "the answer only appeared once the turn had ended, so nothing streamed"
    );

    assert!(live.settled().await, "the turn never finished");
    assert_eq!(live.error(), None, "the turn failed");

    let answer = live.text();
    assert!(!answer.trim().is_empty(), "the answer was empty");
    assert!(
        answer.to_lowercase().contains("pong"),
        "unexpected answer from the model: {answer:?}"
    );

    // And it survived into the store, which is what a reload would read.
    let detail: serde_json::Value =
        serde_json::from_str(&live.host.session("chat").unwrap()).unwrap();
    let messages = detail["messages"].as_array().expect("a saved transcript");
    assert_eq!(
        messages.len(),
        2,
        "both halves of the exchange must be persisted: {messages:?}"
    );
    assert_eq!(messages[1]["content"], answer);
}

#[wasm_bindgen_test]
async fn a_second_turn_carries_the_first_one_as_context() {
    let Some(live) = Live::open() else {
        return;
    };

    live.run("My favourite colour is heliotrope. Reply with just: ok");
    assert!(live.settled().await, "the first turn never finished");
    assert_eq!(live.error(), None);

    live.host.detach("s1");
    live.frames.borrow_mut().clear();

    live.run("What is my favourite colour? Reply with just the colour.");
    assert!(live.settled().await, "the second turn never finished");
    assert_eq!(live.error(), None);

    let answer = live.text().to_lowercase();
    assert!(
        answer.contains("heliotrope"),
        "the stored transcript was not sent back to the model; got {answer:?}"
    );
}
