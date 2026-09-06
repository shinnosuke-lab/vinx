//! The gateway's tools, called from the tab.
//!
//! Covers the whole path a device tool takes: the device's `/api/tools` payload
//! into the registry, the model asking for it, the confirmation gate deciding
//! whether the user is asked, the call going out over HTTP, and the result
//! coming back far enough for the model to see it.
//!
//! Needs the mock from `runtime/test/mock-llm.mjs`, which plays both the model
//! and the gateway. Skipped when it is not running.

#![cfg(feature = "sqlite")]

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use agent_web_core::host::AgentHost;
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

const MOCK: Option<&str> = option_env!("MOCK_LLM_URL");

/// The device's `/api/tools`, as the page's device layer serves it.
///
/// `gateway_info` deliberately omits `required`, which is what the device
/// actually sends for a tool that takes no arguments — and what a strict
/// deserializer silently drops.
const PAYLOAD: &str = r#"{
  "system_prompt": "You are running on a Vinx Linux device.",
  "tools": [
    {
      "name": "gateway_info",
      "safe": true,
      "description": "Report the gateway model, MAC and firmware.",
      "parameters": {"type": "object", "properties": {}}
    },
    {
      "name": "run_python",
      "safe": false,
      "description": "Execute MicroPython on the gateway.",
      "parameters": {
        "type": "object",
        "properties": {"code": {"type": "string", "description": "source"}},
        "required": ["code"]
      }
    },
    {
      "name": "failing_tool",
      "safe": true,
      "description": "Always fails.",
      "parameters": {"type": "object", "properties": {}}
    },
    {
      "name": "nonsense_reply",
      "safe": true,
      "description": "Answers with something that is not JSON.",
      "parameters": {"type": "object", "properties": {}}
    }
  ]
}"#;

struct Harness {
    host: AgentHost,
    frames: Rc<RefCell<Vec<(String, String)>>>,
    _sink: Closure<dyn FnMut(String, String)>,
}

impl Harness {
    fn against(scenario: &str) -> Harness {
        let base = MOCK.unwrap();
        let frames = Rc::new(RefCell::new(Vec::new()));
        let recorder = frames.clone();
        let sink = Closure::wrap(Box::new(move |stream: String, frame: String| {
            recorder.borrow_mut().push((stream, frame));
        }) as Box<dyn FnMut(String, String)>);

        let host = AgentHost::new(sink.as_ref().unchecked_ref::<js_sys::Function>().clone())
            .expect("host over an in-memory store");
        host.configure(base, "test-key", scenario);

        // The mock serves the gateway on the same origin as the model, one path
        // up from the `/v1` base.
        let endpoint = format!("{}/api/tools/call", base.trim_end_matches("/v1"));
        let names = host
            .install_tools(PAYLOAD, &endpoint)
            .expect("the device payload is readable");
        assert_eq!(
            names,
            vec![
                "gateway_info",
                "run_python",
                "failing_tool",
                "nonsense_reply"
            ],
            "every tool the device offered must reach the registry"
        );

        Harness {
            host,
            frames,
            _sink: sink,
        }
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

    async fn wait_for(&self, event: &str) -> bool {
        for _ in 0..200 {
            if self.events().iter().any(|e| e == event) {
                return true;
            }
            wasmtimer::tokio::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    async fn settled(&self) -> bool {
        for _ in 0..400 {
            if self.events().iter().any(|e| e == "done" || e == "error") {
                return true;
            }
            wasmtimer::tokio::sleep(Duration::from_millis(25)).await;
        }
        false
    }
}

macro_rules! require_mock {
    () => {
        if MOCK.is_none() {
            return;
        }
    };
}

#[wasm_bindgen_test]
async fn a_safe_tool_runs_without_asking_and_its_output_reaches_the_model() {
    require_mock!();
    let h = Harness::against("mock-gateway-info");

    h.run("what gateway is this?");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    assert!(
        !h.events().contains(&"confirm".to_string()),
        "a tool the device declared safe must not stop to ask"
    );
    assert!(
        h.text().contains("v86"),
        "the gateway's output never reached the model: {:?}",
        h.text()
    );
}

#[wasm_bindgen_test]
async fn an_unsafe_tool_is_gated_and_runs_once_allowed() {
    require_mock!();
    let h = Harness::against("mock-run-python");

    h.run("run some python");

    assert!(
        h.wait_for("confirm").await,
        "run_python must be gated; the device declared it unsafe: {:?}",
        h.events()
    );
    assert_eq!(h.payloads("confirm")[0]["name"], "run_python");

    h.host.confirm("chat", None, true, false, None);
    assert!(
        h.settled().await,
        "the turn never resumed: {:?}",
        h.events()
    );

    assert!(
        h.text().contains("ran: print(1)"),
        "the gateway did not run the code the model asked for: {:?}",
        h.text()
    );
}

#[wasm_bindgen_test]
async fn declining_an_unsafe_tool_keeps_it_off_the_gateway() {
    require_mock!();
    let h = Harness::against("mock-run-python");

    h.run("run some python");
    assert!(h.wait_for("confirm").await);

    h.host.confirm("chat", None, false, false, None);
    assert!(h.settled().await, "a declined tool must close the turn");

    assert!(
        !h.text().contains("ran: print(1)"),
        "the code ran despite being declined: {:?}",
        h.text()
    );
}

#[wasm_bindgen_test]
async fn a_failing_tool_reports_its_error_and_whatever_it_managed_to_print() {
    require_mock!();
    let h = Harness::against("mock-failing-tool");

    h.run("do the thing");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    let answer = h.text();
    assert!(
        answer.contains("NameError"),
        "the failure did not reach the model: {answer:?}"
    );
    assert!(
        answer.contains("partial output"),
        "output printed before the failure is usually the explanation, and was dropped: {answer:?}"
    );
}

#[wasm_bindgen_test]
async fn a_gateway_that_answers_with_junk_is_reported_not_parsed() {
    require_mock!();
    let h = Harness::against("mock-nonsense");

    h.run("do the thing");
    assert!(
        h.settled().await,
        "a malformed gateway reply must not strand the turn: {:?}",
        h.events()
    );

    let result = h.payloads("tool_result");
    assert!(
        !result.is_empty(),
        "the failure never reached the transcript"
    );
    assert_eq!(
        result[0]["success"], false,
        "a junk reply must count as a failure, or the loop keeps retrying"
    );
}

/// Without this the model is driving a gateway it has never been told about.
#[wasm_bindgen_test]
async fn the_devices_prompt_is_sent_to_the_model() {
    require_mock!();
    let h = Harness::against("mock-echo-system");

    h.run("hello");
    assert!(
        h.settled().await,
        "the turn never finished: {:?}",
        h.events()
    );

    assert!(
        h.text().contains("You are running on a Vinx Linux device."),
        "the device's system prompt never reached the model: {:?}",
        h.text()
    );

    // And it stays out of the transcript the UI renders.
    let detail: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    let shown: Vec<&str> = detail["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["role"].as_str())
        .collect();
    assert!(
        !shown.contains(&"system"),
        "the system prompt must not be shown as a chat message: {shown:?}"
    );
}

/// A host with no mock behind it — `install_tools` is local, so what lands in
/// (and leaves) the registry needs no server to observe.
fn bare_host() -> (AgentHost, Closure<dyn FnMut(String, String)>) {
    let sink = Closure::wrap(Box::new(|_: String, _: String| {}) as Box<dyn FnMut(String, String)>);
    let host = AgentHost::new(sink.as_ref().unchecked_ref::<js_sys::Function>().clone())
        .expect("host over an in-memory store");
    (host, sink)
}

/// The in-page VM ships its own read_file/write_file; registration replaces
/// the workspace's. The vfs-only leftovers (list_files, search_files, and the
/// workspace's download_file / open_file / install_app when the device brought
/// none) would keep a second, invisible filesystem in the model's toolbox, so
/// the install retires them.
#[wasm_bindgen_test]
fn a_device_with_file_tools_retires_the_workspace_leftovers() {
    let (host, _sink) = bare_host();
    let payload = r#"{
      "system_prompt": "a Linux VM in this tab",
      "tools": [
        {"name":"run_shell","safe":false,"description":"x","parameters":{"type":"object","properties":{}}},
        {"name":"read_file","safe":true,"description":"x","parameters":{"type":"object","properties":{}}},
        {"name":"write_file","safe":false,"description":"x","parameters":{"type":"object","properties":{}}}
      ]
    }"#;
    host.install_tools(payload, "http://vm.internal/tools/call")
        .expect("the vm payload is readable");

    let names = host.tool_names();
    assert!(
        names.iter().any(|n| n == "read_file") && names.iter().any(|n| n == "run_shell"),
        "the device's tools must be in: {names:?}"
    );
    for retired in [
        "list_files",
        "search_files",
        "download_file",
        "open_file",
        "install_app",
    ] {
        assert!(
            !names.iter().any(|n| n == retired),
            "{retired} must retire when the device owns the files: {names:?}"
        );
    }
}

/// A device that brings its own download_file keeps the name: the workspace's
/// is replaced, not retired, and the model still has one way to hand a file
/// over — the machine's.
#[wasm_bindgen_test]
fn a_device_with_its_own_download_file_keeps_the_name() {
    let (host, _sink) = bare_host();
    let payload = r#"{
      "system_prompt": "a Linux VM in this tab",
      "tools": [
        {"name":"read_file","safe":true,"description":"x","parameters":{"type":"object","properties":{}}},
        {"name":"write_file","safe":false,"description":"x","parameters":{"type":"object","properties":{}}},
        {"name":"download_file","safe":true,"description":"from the vm","parameters":{"type":"object","properties":{}}}
      ]
    }"#;
    host.install_tools(payload, "http://vm.internal/tools/call")
        .expect("the vm payload is readable");

    let names = host.tool_names();
    assert_eq!(
        names.iter().filter(|n| *n == "download_file").count(),
        1,
        "exactly one download_file, the device's: {names:?}"
    );

    // And when the machine goes away, the workspace's comes back with the
    // rest of the workspace tools.
    host.uninstall_tools(vec![
        "read_file".into(),
        "write_file".into(),
        "download_file".into(),
    ]);
    let names = host.tool_names();
    for back in [
        "read_file",
        "write_file",
        "list_files",
        "search_files",
        "download_file",
        "open_file",
        "install_app",
    ] {
        assert!(
            names.iter().any(|n| n == back),
            "{back} must return: {names:?}"
        );
    }
}

/// A gateway that brings no file tools leaves the workspace's alone — the
/// tab filesystem is still the model's only one.
#[wasm_bindgen_test]
fn a_device_without_file_tools_keeps_the_workspace_ones() {
    let (host, _sink) = bare_host();
    host.install_tools(PAYLOAD, "http://gw.invalid/api/tools/call")
        .expect("the gateway payload is readable");

    let names = host.tool_names();
    assert!(
        names.iter().any(|n| n == "list_files") && names.iter().any(|n| n == "search_files"),
        "without device file tools the workspace's must survive: {names:?}"
    );
}

/// The in-page machine comes and goes with its power key. Taking its tools
/// back is the exact inverse of installing them: the device's names leave,
/// the workspace file tools it had replaced come back whole (all four, the
/// two it retired included), and a payload with no tools but a briefing —
/// how the page tells the model why the shell is gone — can follow at once.
#[wasm_bindgen_test]
fn uninstalling_the_device_restores_the_workspace() {
    let (host, _sink) = bare_host();
    let before = host.tool_names();
    let payload = r#"{
      "system_prompt": "a Linux VM in this tab",
      "tools": [
        {"name":"run_shell","safe":false,"description":"x","parameters":{"type":"object","properties":{}}},
        {"name":"read_file","safe":true,"description":"x","parameters":{"type":"object","properties":{}}},
        {"name":"write_file","safe":false,"description":"x","parameters":{"type":"object","properties":{}}}
      ]
    }"#;
    host.install_tools(payload, "http://vm.internal/tools/call")
        .expect("the vm payload is readable");

    let removed = host.uninstall_tools(vec![
        "run_shell".into(),
        "read_file".into(),
        "write_file".into(),
        "never_installed".into(),
    ]);
    assert_eq!(
        removed,
        vec!["run_shell", "read_file", "write_file"],
        "only what was there leaves"
    );

    let after = host.tool_names();
    assert!(
        !after.iter().any(|n| n == "run_shell"),
        "the device's tool must be gone: {after:?}"
    );
    for n in ["read_file", "write_file", "list_files", "search_files"] {
        assert!(
            after.iter().any(|x| x == n),
            "the workspace's {n} must be back: {after:?}"
        );
    }
    let mut before_sorted = before.clone();
    let mut after_sorted = after.clone();
    before_sorted.sort();
    after_sorted.sort();
    assert_eq!(
        after_sorted, before_sorted,
        "the toolbox must be exactly what it was before the device"
    );

    // The no-machine briefing: tools none, prompt one paragraph — accepted,
    // and it leaves the toolbox alone.
    let briefed = host
        .install_tools(
            r#"{"tools":[],"system_prompt":"the machine is off"}"#,
            "http://vm.internal/tools/call",
        )
        .expect("a tool-less payload is a valid one");
    assert!(briefed.is_empty());
    assert_eq!(host.tool_names().len(), after.len());
}

/// A second turn must not stack another system message on the first.
#[wasm_bindgen_test]
async fn the_prompt_is_not_repeated_on_later_turns() {
    require_mock!();
    let h = Harness::against("mock-echo-system");

    h.run("first");
    assert!(h.settled().await);
    h.host.detach("s1");
    h.frames.borrow_mut().clear();

    h.run("second");
    assert!(h.settled().await, "the second turn never finished");

    let stored: serde_json::Value = serde_json::from_str(&h.host.session("chat").unwrap()).unwrap();
    let count = stored["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "system")
        .count();
    assert_eq!(count, 0, "the transcript should never carry a system row");
    assert!(
        h.text().contains("Vinx Linux"),
        "the prompt was lost on the second turn: {:?}",
        h.text()
    );
}
