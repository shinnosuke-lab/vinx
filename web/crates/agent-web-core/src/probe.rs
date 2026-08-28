//! Size probe: the reachable-code graph, not a feature.
//!
//! A `cdylib` with no exports links to almost nothing once LTO runs, so
//! measuring one tells you nothing about what the real module will cost. This
//! module exists to pull in exactly what a real turn pulls in -- the streaming
//! LLM client, the agent loop, the tool registry, the skill registry and the
//! event encoder -- so `deploy/measure.sh` reports a number that means
//! something.
//!
//! It is compiled only under `--features size-probe` and is expected to be
//! deleted once the worker entry point in the real build covers the same graph.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

use crate::agent_loop::AgentLoop;
use crate::bridge::BridgedTool;
use crate::client::LlmClient;
use crate::skill::SkillRegistry;
use crate::tool::ToolRegistry;
use crate::types::{ChatMessage, RiskLevel, ToolParameters};

/// Run one turn against a real endpoint, returning the encoded event stream.
///
/// Every dependency the production path has, this has: reqwest's fetch backend
/// and the SSE parser via `LlmClient`, the multi-turn machinery via
/// `AgentLoop`, YAML frontmatter and the regex matcher via `SkillRegistry`,
/// and the wire encoder via `sse`.
#[wasm_bindgen]
pub async fn probe_turn(base_url: String, api_key: String, model: String, prompt: String) -> String {
    console_error_panic_hook::set_once();

    let llm = LlmClient::new(&base_url, &api_key, &model, None);

    let registry = Arc::new(ToolRegistry::new());
    let (tool_tx, mut tool_rx) = mpsc::unbounded_channel();
    registry.register(Arc::new(BridgedTool::from_schema(
        "run_python",
        "Execute Python on the gateway.",
        ToolParameters::object(Default::default(), Vec::new()),
        RiskLevel::Dangerous,
        tool_tx,
    )));

    // Answer every call with a stub. The point is to link the path, and a turn
    // that hangs on the first tool call would never reach the rest of it.
    wasm_bindgen_futures::spawn_local(async move {
        while let Some(call) = tool_rx.recv().await {
            let _ = call
                .reply
                .send(crate::types::ToolResult::text(format!("stub: {}", call.tool)));
        }
    });

    // Filesystem-backed upstream, so it finds nothing here. Reachability is
    // what is being measured; the IndexedDB-backed replacement lands with the
    // SkillSource seam.
    let skills = SkillRegistry::new(Vec::new());
    skills.scan();

    let mut agent = AgentLoop::new(llm, registry).with_skill_registry(skills);

    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let (_confirm_tx, mut confirm_rx) = mpsc::unbounded_channel();
    let cancel = Arc::new(AtomicBool::new(false));

    let mut messages = vec![ChatMessage::user(&prompt)];
    let turn = agent.process_message(&mut messages, &event_tx, &mut confirm_rx, None, cancel);

    // Drain through the real encoder: that is what the fetch shim will serve,
    // and it keeps `sse` out of the dead-code set.
    let collect = async move {
        let mut out = String::new();
        while let Some(event) = event_rx.recv().await {
            // `encode` returns None for events the wire protocol drops.
            if let Some(frame) = crate::sse::encode(&event) {
                out.push_str(&frame);
            }
        }
        out
    };

    let (result, encoded) = futures::join!(turn, collect);
    match result {
        Ok(()) => encoded,
        Err(e) => format!("{encoded}\nerror: {e}"),
    }
}

/// Exercise the real session store, so the SQLite round of
/// `deploy/measure.sh` prices what actually ships rather than a stub.
///
/// Every method is touched: `save` and `load` link the whole binding layer, and
/// `search` is what pulls in the snippet builder and the `LIKE` machinery.
#[cfg(feature = "sqlite")]
#[wasm_bindgen]
pub async fn probe_sqlite() -> String {
    console_error_panic_hook::set_once();

    let store = match crate::storage::open(None).await {
        Ok(s) => s,
        Err(e) => return e,
    };

    let id = uuid::Uuid::new_v4().to_string();
    let messages = vec![
        ChatMessage::system("you are a gateway agent"),
        ChatMessage::user("scan for devices"),
    ];
    if let Err(e) = store.save(&id, &messages, "web", None) {
        return format!("save failed: {e}");
    }
    let loaded = store.load(&id).map(|m| m.len()).unwrap_or(0);
    let listed = store.list().map(|r| r.len()).unwrap_or(0);
    let found = store.search("devices", 10, None).map(|h| h.len()).unwrap_or(0);
    let detailed = store.detail(&id).map(|d| d.is_some()).unwrap_or(false);
    let _ = store.set_title(&id, "probe");
    let _ = store.update(&id, None, Some(true));
    let _ = store.title_of(&id);
    let _ = store.load_state(&id);
    let _ = store.delete(&id);

    format!("loaded={loaded} listed={listed} found={found} detailed={detailed}")
}
