//! Getting a browser tool past the engine's `Send` bound.
//!
//! `Tool` is declared `Send + Sync` and `#[async_trait]` adds a `Send` bound to
//! the future returned by `execute`. Nothing in the browser satisfies that:
//! `JsFuture`, `Promise` and every `web_sys` handle are `!Send`, so a tool that
//! simply awaits `fetch` will not compile against the vendored trait.
//!
//! Rather than patch the bound out of the engine -- a change that would touch
//! every call site and fight upstream forever -- the JS work is moved off the
//! tool's own future. `execute` only sends a request down a channel and awaits a
//! oneshot reply, and both halves of that are `Send`. The JS lives in a task
//! started with `spawn_local`, which never needs to be `Send` because it stays
//! on the one thread a wasm module has.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};

use crate::tool::{Tool, ToolContext};
use crate::types::{RiskLevel, ToolDefinition, ToolParameters, ToolResult};

/// A failed call, flagged so the loop's consecutive-failure counter sees it as
/// a real failure rather than guessing from the output text.
fn failed(msg: &str) -> ToolResult {
    let mut r = ToolResult::text(msg);
    r.success = Some(false);
    r
}

/// One tool invocation handed to the host task, with the channel to answer on.
pub struct ToolCall {
    pub tool: String,
    pub args: serde_json::Value,
    pub reply: oneshot::Sender<ToolResult>,
}

/// The tool side of the bridge: `Send`, holds no JS, forwards everything.
pub struct BridgedTool {
    definition: ToolDefinition,
    risk: RiskLevel,
    tx: mpsc::UnboundedSender<ToolCall>,
}

impl BridgedTool {
    pub fn new(
        definition: ToolDefinition,
        risk: RiskLevel,
        tx: mpsc::UnboundedSender<ToolCall>,
    ) -> Self {
        BridgedTool {
            definition,
            risk,
            tx,
        }
    }

    /// Build from the gateway's `/api/tools` description, which is where the
    /// device's tools (notably `run_python`) enter the registry.
    pub fn from_schema(
        name: &str,
        description: &str,
        parameters: ToolParameters,
        risk: RiskLevel,
        tx: mpsc::UnboundedSender<ToolCall>,
    ) -> Self {
        BridgedTool::new(
            ToolDefinition::new(name, description, parameters),
            risk,
            tx,
        )
    }
}

#[async_trait]
impl Tool for BridgedTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn risk(&self, _args: &serde_json::Value) -> RiskLevel {
        self.risk
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolResult {
        let (reply, answer) = oneshot::channel();
        let call = ToolCall {
            tool: self.definition.function.name.clone(),
            args,
            reply,
        };
        if self.tx.send(call).is_err() {
            return failed("tool host is gone (the page was closed or reloaded)");
        }
        match answer.await {
            Ok(result) => result,
            // The host drops the sender without replying when the user cancels,
            // so distinguish that from a genuine crash for the transcript.
            Err(_) if ctx.is_cancelled() => failed("cancelled"),
            Err(_) => failed("tool host dropped the call without replying"),
        }
    }
}

/// Shared cancel flag, so the page can stop a turn between tool calls.
pub fn cancel_flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

/// Set the flag the engine polls between loop iterations.
pub fn cancel(flag: &Arc<AtomicBool>) {
    flag.store(true, Ordering::Relaxed);
}
