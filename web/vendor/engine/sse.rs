//! `AgentEvent` → Server-Sent Events encoding (framework-agnostic).
//!
//! Each event becomes an `event: <name>\ndata: <json>\n\n` frame. Internal
//! bookkeeping events (`SessionSync`) are not forwarded to the client (return
//! `None`); the web layer consumes those to persist state.

use crate::event::AgentEvent;

/// SSE wire-protocol version, surfaced as `"protocol"` in `GET /api/chat/meta`.
///
/// The frame vocabulary and field semantics are specified in
/// `docs/PROTOCOL.md` ("we don't break userspace"): additions are
/// backward-compatible (new fields / new event names clients may ignore) and
/// keep this number; any breaking change must bump it.
///
/// v2: `POST /api/chat` returns a JSON ack; ALL streaming moved to
/// `GET /api/chat/stream/{session_id}` (self-contained: `session` → `history`
/// → live frames → `done`/`error`). Bumped with no external consumers of the
/// v1 POST stream (verified across product repos/docs at the time).
pub const PROTOCOL_VERSION: u32 = 2;

/// Encode an [`AgentEvent`] as an SSE frame string, or `None` if the event is
/// internal and should not be sent to the client.
pub fn encode(event: &AgentEvent) -> Option<String> {
    let (name, data) = event_payload(event)?;
    Some(format!("event: {}\ndata: {}\n\n", name, data))
}

/// The `(event name, JSON payload)` for an event, or `None` for internal
/// events. Split from [`encode`] so `subagent` envelopes can nest the inner
/// event's name + payload as data fields.
fn event_payload(event: &AgentEvent) -> Option<(&'static str, serde_json::Value)> {
    let (name, data) = match event {
        AgentEvent::StreamContent(s) => ("content", serde_json::json!({ "text": s })),
        AgentEvent::StreamReasoning(s) => ("reasoning", serde_json::json!({ "text": s })),
        AgentEvent::ToolCallStart {
            id,
            name,
            arguments,
        } => (
            "tool_start",
            serde_json::json!({ "id": id, "name": name, "arguments": arguments }),
        ),
        AgentEvent::ToolCallArgumentsDelta { id, delta } => {
            ("tool_args", serde_json::json!({ "id": id, "delta": delta }))
        }
        AgentEvent::ToolCallResult {
            id,
            result,
            success,
        } => (
            "tool_result",
            serde_json::json!({ "id": id, "result": result, "success": success }),
        ),
        AgentEvent::ConfirmTool {
            id,
            name,
            arguments,
            risk,
        } => (
            "confirm",
            serde_json::json!({ "id": id, "name": name, "arguments": arguments, "risk": risk }),
        ),
        AgentEvent::AskUser {
            id,
            questions,
            timeout_secs,
        } => (
            "ask_user",
            serde_json::json!({ "id": id, "questions": questions, "timeout_secs": timeout_secs }),
        ),
        AgentEvent::SkillActivated {
            name,
            allowed_tools,
        } => (
            "skill",
            serde_json::json!({ "name": name, "allowed_tools": allowed_tools }),
        ),
        AgentEvent::SkillDeactivated => (
            "skill",
            serde_json::json!({ "name": serde_json::Value::Null, "allowed_tools": [] }),
        ),
        AgentEvent::AssistantDone { elapsed_ms } => {
            ("done", serde_json::json!({ "elapsed_ms": elapsed_ms }))
        }
        AgentEvent::Error(e) => ("error", serde_json::json!({ "message": e })),
        AgentEvent::Usage { model, usage } => (
            "usage",
            serde_json::json!({
                "model": model,
                "prompt_tokens": usage.prompt_tokens,
                "completion_tokens": usage.completion_tokens,
                "cached_tokens": usage.cached_tokens,
                "cache_write_tokens": usage.cache_write_tokens,
            }),
        ),
        // `pending: true` = work in flight; the next `status` frame resolves
        // it, and clients replace the row instead of stacking a second one.
        AgentEvent::StatusUpdate { text, pending } => (
            "status",
            serde_json::json!({ "text": text, "pending": pending }),
        ),
        AgentEvent::ModeSwitch(m) => ("mode", serde_json::json!({ "mode": m })),
        AgentEvent::ProfileSwitch(p) => ("profile", serde_json::json!({ "profile": p })),
        AgentEvent::RenderBarChart {
            title,
            labels,
            values,
        } => (
            "render",
            serde_json::json!({ "kind": "bar", "title": title, "labels": labels, "values": values }),
        ),
        AgentEvent::RenderSparkline { title, values } => (
            "render",
            serde_json::json!({ "kind": "sparkline", "title": title, "values": values }),
        ),
        AgentEvent::RenderLineChart {
            title,
            x_label,
            y_label,
            series_names,
            datasets,
        } => (
            "render",
            serde_json::json!({
                "kind": "line", "title": title, "x_label": x_label, "y_label": y_label,
                "series_names": series_names, "datasets": datasets
            }),
        ),
        AgentEvent::RenderGauge { title, items } => (
            "render",
            serde_json::json!({ "kind": "gauge", "title": title, "items": items }),
        ),
        AgentEvent::ApplyChatStyle {
            css,
            js,
            assets_changed,
        } => (
            "style",
            serde_json::json!({ "css": css, "js": js, "assets_changed": assets_changed }),
        ),
        // Sub-agent envelope: the inner event's frame name + payload become
        // data fields, so one stable outer name (`subagent`) covers every
        // inner kind and old clients can ignore the whole family.
        // `session_id` names the child's transcript session so clients can
        // deep-link to the live sub-session view; `label` names the task
        // itself, so even a viewer that never saw the parent tool_start (a
        // re-attach after a trimmed replay) can title the progress row.
        AgentEvent::Subagent {
            task_id,
            session_id,
            label,
            event,
        } => {
            let (inner_name, inner_data) = event_payload(event)?;
            (
                "subagent",
                serde_json::json!({
                    "task_id": task_id,
                    "session_id": session_id,
                    "label": label,
                    "event": inner_name,
                    "data": inner_data,
                }),
            )
        }
        AgentEvent::UserInjected { text } => ("user_injected", serde_json::json!({ "text": text })),
        // Internal / not forwarded. `SteerRequeued` instructs the driver to
        // re-queue the text; what clients see is the `queue` frame that
        // follows, so the queue stays the single client-visible mechanism.
        AgentEvent::SessionSync { .. }
        | AgentEvent::SteerRequeued { .. }
        | AgentEvent::SuspendTerminal
        | AgentEvent::ResumeTerminal => return None,
    };

    Some((name, data))
}

/// Build a one-off SSE frame with a custom event name + JSON payload.
pub fn frame(name: &str, data: serde_json::Value) -> String {
    format!("event: {}\ndata: {}\n\n", name, data)
}
