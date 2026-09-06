//! Tools that live on the device, called from the tab.
//!
//! The device publishes what it can do at `GET /api/tools` and runs it
//! at `POST /api/tools/call`. Both are on the page's own origin, so the worker
//! reaches them directly — the engine's registry gets real gateway capability
//! without anything server-side holding the session.
//!
//! Every tool arrives through [`BridgedTool`], because a `Tool` must be `Send`
//! and nothing that touches the network from a browser is. See `bridge.rs`.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tokio::sync::mpsc;

use crate::bridge::{BridgedTool, ToolCall};
use crate::tool::ToolRegistry;
use crate::types::{RiskLevel, ToolParameter, ToolParameters, ToolResult};

/// What `GET /api/tools` answers.
#[derive(Debug, Default, Deserialize)]
pub struct ToolsPayload {
    #[serde(default)]
    pub tools: Vec<DeviceTool>,
    /// The device's own description of itself, which becomes the system message
    /// of every session. Without it the model has no idea what it is attached
    /// to.
    #[serde(default)]
    pub system_prompt: String,
}

#[derive(Debug, Deserialize)]
pub struct DeviceTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: LenientParameters,
    /// Whether it can run without asking. Absent means unsafe: a tool that
    /// forgot to declare itself should be gated, not waved through.
    #[serde(default)]
    pub safe: bool,
}

/// The engine's `ToolParameters` with every field optional.
///
/// A JSON Schema for a tool that takes no arguments is legitimately
/// `{"type":"object","properties":{}}` — no `required` — and the engine's type
/// demands all three fields, so deserializing the device's payload straight
/// into it drops those tools without a word. Being tolerant of what a peer
/// sends is this boundary's job, not upstream's.
#[derive(Debug, Deserialize)]
pub struct LenientParameters {
    #[serde(rename = "type", default = "object")]
    schema_type: String,
    #[serde(default)]
    properties: HashMap<String, ToolParameter>,
    #[serde(default)]
    required: Vec<String>,
}

fn object() -> String {
    "object".to_string()
}

impl Default for LenientParameters {
    fn default() -> Self {
        LenientParameters {
            schema_type: object(),
            properties: HashMap::new(),
            required: Vec::new(),
        }
    }
}

impl From<LenientParameters> for ToolParameters {
    fn from(p: LenientParameters) -> ToolParameters {
        ToolParameters {
            schema_type: p.schema_type,
            properties: p.properties,
            required: p.required,
        }
    }
}

/// What `POST /api/tools/call` answers.
#[derive(Debug, Deserialize)]
struct CallOutcome {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

impl CallOutcome {
    /// Fold the device's answer into what the loop and the transcript need.
    ///
    /// `success` is set explicitly rather than left to the loop's substring
    /// heuristic: a successful `run_python` that prints the word "error" is not
    /// a failed tool call, and three of those in a row would otherwise abort
    /// the turn.
    fn into_result(self) -> ToolResult {
        let mut result = if self.ok {
            ToolResult::text(self.output.unwrap_or_default())
        } else {
            // Partial output before a failure is often the whole explanation,
            // so keep it next to the error rather than choosing one.
            let error = self.error.unwrap_or_else(|| "the tool failed".into());
            match self.output.filter(|o| !o.is_empty()) {
                Some(output) => {
                    ToolResult::text(format!("{error}\n\noutput before the failure:\n{output}"))
                }
                None => ToolResult::text(error),
            }
        };
        result.success = Some(self.ok);
        result
    }
}

/// Register everything the device offers, and start serving its calls.
///
/// Returns the names registered, in the order they were accepted. The pump runs
/// until the page goes away; there is nothing to stop it, because a tab that
/// has torn down its worker has torn down the registry with it.
/// Make a same-origin path absolute.
///
/// `reqwest` parses the URL itself rather than handing it to `fetch`, so a
/// relative path fails with a bare "builder error" that names neither the URL
/// nor the reason. Callers naturally write `/api/tools/call`, which is what the
/// device actually serves, so resolve it here instead of demanding they know.
fn absolute(endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        return endpoint.to_string();
    }
    // Works in both a worker and a window; neither type is in scope for the
    // other, so go through the global object.
    let origin = js_sys::Reflect::get(&js_sys::global(), &"location".into())
        .ok()
        .and_then(|loc| js_sys::Reflect::get(&loc, &"origin".into()).ok())
        .and_then(|o| o.as_string())
        .unwrap_or_default();

    format!("{}{}", origin.trim_end_matches('/'), endpoint)
}

pub fn install(
    registry: &Arc<ToolRegistry>,
    payload: ToolsPayload,
    endpoint: String,
) -> Vec<String> {
    let (tx, rx) = mpsc::unbounded_channel::<ToolCall>();
    let mut registered = Vec::new();

    for tool in payload.tools {
        // Unsafe tools gate on the same confirmation the desktop agent uses;
        // `run_python` on a gateway is exactly what that gate is for.
        let risk = if tool.safe {
            RiskLevel::Safe
        } else {
            RiskLevel::Dangerous
        };
        let bridged = BridgedTool::from_schema(
            &tool.name,
            &tool.description,
            tool.parameters.into(),
            risk,
            tx.clone(),
        );
        if registry.register(Arc::new(bridged)) {
            registered.push(tool.name);
        } else {
            log::warn!("device tool '{}' was rejected by the registry", tool.name);
        }
    }

    wasm_bindgen_futures::spawn_local(pump(rx, absolute(&endpoint)));
    registered
}

/// Forward each call to the device and answer with what it says.
async fn pump(mut rx: mpsc::UnboundedReceiver<ToolCall>, endpoint: String) {
    let http = reqwest::Client::new();

    while let Some(call) = rx.recv().await {
        let outcome = invoke(&http, &endpoint, &call.tool, &call.args).await;
        // The receiver is gone when the turn was cancelled while the tool ran.
        // Not an error, and not worth logging every time.
        let _ = call.reply.send(outcome);
    }
}

async fn invoke(
    http: &reqwest::Client,
    endpoint: &str,
    name: &str,
    args: &serde_json::Value,
) -> ToolResult {
    let body = serde_json::json!({ "name": name, "arguments": args });

    let response = match http.post(endpoint).json(&body).send().await {
        Ok(r) => r,
        // Name the URL: reqwest's own message for a malformed one is "builder
        // error", which says nothing about what was wrong or where it pointed.
        Err(e) => return failure(format!("could not reach the gateway at {endpoint}: {e}")),
    };

    // A gateway that is up but unhappy answers with a status, and its body is
    // usually the reason — worth putting in the transcript rather than "500".
    let status = response.status();
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => return failure(format!("the gateway's reply could not be read: {e}")),
    };

    match serde_json::from_str::<CallOutcome>(&text) {
        Ok(outcome) => outcome.into_result(),
        Err(_) if !status.is_success() => failure(format!(
            "the gateway answered HTTP {status}: {}",
            trim(&text)
        )),
        Err(e) => failure(format!(
            "the gateway's reply was not valid JSON ({e}): {}",
            trim(&text)
        )),
    }
}

fn failure(message: String) -> ToolResult {
    let mut result = ToolResult::text(message);
    result.success = Some(false);
    result
}

/// Keep an unexpected body short enough to be readable in a transcript.
fn trim(text: &str) -> String {
    const LIMIT: usize = 500;
    match text.char_indices().nth(LIMIT) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}
