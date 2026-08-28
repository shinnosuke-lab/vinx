//! Tool abstraction: the `Tool` trait, an execution `ToolContext`, and a
//! runtime-mutable `ToolRegistry`.
//!
//! This is the seam that decouples the agent loop from any specific set of
//! tools. Native Rust tools, OS capabilities, and (later) MCP-sourced tools all
//! implement [`Tool`] and register into a single [`ToolRegistry`]; the loop only
//! ever talks to the registry.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::event::AgentEvent;
use crate::types::{RiskLevel, ToolDefinition, ToolResult};

/// Per-call execution context handed to [`Tool::execute`].
///
/// Carries the event channel (so tools can stream progress / render output) and
/// a cooperative cancel flag. App state is injected by each tool implementation
/// holding its own `Arc<...>` (closure-style), keeping the core state-agnostic.
#[derive(Clone)]
pub struct ToolContext {
    pub event_tx: mpsc::UnboundedSender<AgentEvent>,
    pub cancel: Arc<AtomicBool>,
    /// The session this call runs in. Tools are process-wide singletons shared
    /// across sessions, so session-aware behavior (e.g. the session-retrieval
    /// tools excluding the conversation they run in) must come from here.
    /// `None` for headless/test invocations.
    session_id: Option<String>,
}

impl ToolContext {
    pub fn new(event_tx: mpsc::UnboundedSender<AgentEvent>, cancel: Arc<AtomicBool>) -> Self {
        Self {
            event_tx,
            cancel,
            session_id: None,
        }
    }

    /// Attach the id of the session this tool call belongs to.
    pub fn with_session(mut self, session_id: Option<String>) -> Self {
        self.session_id = session_id;
        self
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Best-effort emit an event (ignores a closed receiver).
    pub fn emit(&self, event: AgentEvent) {
        let _ = self.event_tx.send(event);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// A callable tool the agent can invoke.
#[async_trait]
pub trait Tool: Send + Sync {
    /// The function-calling schema advertised to the LLM.
    fn definition(&self) -> ToolDefinition;

    /// Tool name (defaults to the definition's function name).
    fn name(&self) -> String {
        self.definition().function.name
    }

    /// Risk of executing this call. May inspect `args` (e.g. a shell tool can
    /// upgrade based on the command). Defaults to `Safe`.
    fn risk(&self, _args: &serde_json::Value) -> RiskLevel {
        RiskLevel::Safe
    }

    /// Whether this tool needs to take over the terminal (interactive). The
    /// loop suspends/resumes the terminal around interactive tools.
    fn interactive(&self) -> bool {
        false
    }

    /// Execute the tool with parsed JSON `args`.
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolResult;
}

/// Return true if `name` is blocked by `blocklist` (exact match, case-sensitive).
pub fn is_tool_blocked(name: &str, blocklist: &[String]) -> bool {
    blocklist.iter().any(|b| b == name)
}

#[derive(Default)]
struct RegistryInner {
    tools: HashMap<String, Arc<dyn Tool>>,
    /// Insertion order, so `definitions()` is stable for prompt-cache friendliness.
    order: Vec<String>,
    blocklist: Vec<String>,
}

/// Runtime-mutable registry of tools, shareable via `Arc` and safe to mutate
/// concurrently (skill hot-loading, dynamic injection).
#[derive(Default)]
pub struct ToolRegistry {
    inner: RwLock<RegistryInner>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_blocklist(blocklist: Vec<String>) -> Self {
        Self {
            inner: RwLock::new(RegistryInner {
                blocklist,
                ..Default::default()
            }),
        }
    }

    // Lock accessors that recover from poisoning: the registry is plain data
    // (no invariants spanning the critical section), so a panic elsewhere while
    // holding the lock must not turn every later request into a panic.
    fn read(&self) -> std::sync::RwLockReadGuard<'_, RegistryInner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, RegistryInner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_blocklist(&self, blocklist: Vec<String>) {
        self.write().blocklist = blocklist;
    }

    /// Register a tool. Returns `false` (and does nothing) if the tool's name is
    /// in the blocklist. Re-registering an existing name replaces it.
    pub fn register(&self, tool: Arc<dyn Tool>) -> bool {
        let name = tool.name();
        let mut inner = self.write();
        if is_tool_blocked(&name, &inner.blocklist) {
            log::info!("tool '{}' blocked by blocklist; not registered", name);
            return false;
        }
        if !inner.tools.contains_key(&name) {
            inner.order.push(name.clone());
        }
        inner.tools.insert(name, tool);
        true
    }

    /// Remove a tool by name. Returns true if it existed.
    pub fn unregister(&self, name: &str) -> bool {
        let mut inner = self.write();
        inner.order.retain(|n| n != name);
        inner.tools.remove(name).is_some()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.read().tools.contains_key(name)
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.read().tools.get(name).cloned()
    }

    /// All tool definitions in insertion order (for sending to the LLM).
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let inner = self.read();
        inner
            .order
            .iter()
            .filter_map(|n| inner.tools.get(n).map(|t| t.definition()))
            .collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.read().order.clone()
    }

    pub fn len(&self) -> usize {
        self.read().tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
