//! `open_terminal` — lazy UI tool: surface a "open terminal" button in chat.
//!
//! The tool itself performs no action on the host. The web frontend renders
//! the call as a button that opens the terminal page (`terminal/` under the
//! site root, wherever the site is deployed) in a new browser tab, so the
//! user (not the model) triggers the actual navigation.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::tool::{Tool, ToolContext};
use crate::types::{RiskLevel, ToolDefinition, ToolParameters, ToolResult};

pub struct OpenTerminalTool;

impl OpenTerminalTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OpenTerminalTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for OpenTerminalTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "open_terminal",
            "Open an interactive shell terminal in a new browser tab for the \
             user. Use when the user wants to run commands themselves or asks \
             for a terminal/shell. No parameters.",
            ToolParameters::object(HashMap::new(), vec![]),
        )
    }

    fn risk(&self, _args: &serde_json::Value) -> RiskLevel {
        // Nothing executes on the host; the frontend only shows a button.
        RiskLevel::Safe
    }

    async fn execute(&self, _args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        ToolResult::text(
            "Terminal is ready. A button has been shown to the user to open it in a new tab.",
        )
        .with_success(true)
    }
}
