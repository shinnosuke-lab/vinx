//! Wire types for OpenAI-compatible chat completions + tool calling.
//!
//! `UiEvent` is an alias of this crate's own [`crate::event::AgentEvent`]
//! (no external crate coupling).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Chat Messages ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
    /// User-initiated skill context injection (explicit activation). Canonical
    /// only: never sent as-is — the wire projection encodes it as a user-role
    /// message, and renderers collapse it instead of showing the full body.
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

/// Reference to an uploaded image riding a chat message. Only the reference
/// is persisted — the bytes live in `runtime/uploads/<id>` and are read (and
/// base64-encoded) at request time, only for vision-capable models.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Attachment {
    /// Upload id: the file name inside `runtime/uploads` (`<uuid>.<ext>`).
    pub id: String,
    /// Original file name (display only).
    #[serde(default)]
    pub name: String,
    /// MIME type (e.g. `image/png`).
    #[serde(default)]
    pub mime: String,
    /// File size in bytes, measured once at upload/copy time. Rows persisted
    /// before this field default to 0 (renders as "size unknown" in notes).
    #[serde(default)]
    pub size: u64,
    /// Line count for text-like files, computed once at upload time. `None`
    /// for images, binaries and older rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
}

impl Attachment {
    /// Image attachments become visual input (parts / placeholder); anything
    /// else is a file the model inspects with tools. MIME wins when present,
    /// otherwise the upload id's extension decides (ids are `<uuid>.<ext>`
    /// and the upload endpoint reserves image extensions for image bodies).
    pub fn is_image(&self) -> bool {
        if !self.mime.trim().is_empty() {
            return self.mime.starts_with("image/");
        }
        matches!(
            self.id.rsplit('.').next().unwrap_or(""),
            "png" | "jpg" | "jpeg" | "webp" | "gif"
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Image references on user messages (vision input). Never serialized to
    /// the LLM wire as-is — the wire projection expands or strips it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}

impl ChatMessage {
    pub fn system(content: &str) -> Self {
        ChatMessage {
            role: Role::System,
            content: Some(content.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            attachments: None,
        }
    }

    pub fn user(content: &str) -> Self {
        ChatMessage {
            role: Role::User,
            content: Some(content.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            attachments: None,
        }
    }

    /// User message carrying image attachments (vision input). `content` may
    /// be empty — an image IS a message.
    pub fn user_with_attachments(content: &str, attachments: Vec<Attachment>) -> Self {
        ChatMessage {
            role: Role::User,
            content: Some(content.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            attachments: (!attachments.is_empty()).then_some(attachments),
        }
    }

    pub fn assistant(
        content: Option<String>,
        reasoning_content: Option<String>,
        tool_calls: Option<Vec<ToolCall>>,
    ) -> Self {
        ChatMessage {
            role: Role::Assistant,
            content,
            reasoning_content,
            tool_calls,
            tool_call_id: None,
            attachments: None,
        }
    }

    /// Whether this is a wire-valid assistant turn.
    ///
    /// `reasoning_content` is metadata, not a substitute for the assistant's
    /// answer. OpenAI-compatible APIs require actual content unless the message
    /// carries one or more tool calls.
    pub fn has_assistant_payload(&self) -> bool {
        matches!(self.role, Role::Assistant)
            && (self
                .content
                .as_deref()
                .is_some_and(|content| !content.trim().is_empty())
                || self
                    .tool_calls
                    .as_ref()
                    .is_some_and(|tool_calls| !tool_calls.is_empty()))
    }

    /// Skill context injected by an explicit user activation. `name` rides in
    /// `tool_call_id` (unused for this role) so renderers can label the entry
    /// without parsing the body.
    pub fn skill_context(name: &str, content: &str) -> Self {
        ChatMessage {
            role: Role::Skill,
            content: Some(content.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: Some(name.to_string()),
            attachments: None,
        }
    }

    /// Skill name of a [`Role::Skill`] message.
    pub fn skill_name(&self) -> Option<&str> {
        match self.role {
            Role::Skill => self.tool_call_id.as_deref(),
            _ => None,
        }
    }

    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        ChatMessage {
            role: Role::Tool,
            content: Some(content.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: Some(tool_call_id.to_string()),
            attachments: None,
        }
    }
}

// ── Wire-only message forms (request body) ──

/// One segment of a multimodal message content array (OpenAI vision format).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Clone, Serialize)]
pub struct ImageUrl {
    /// `data:<mime>;base64,<...>` (public URLs are not portable across
    /// providers; K3 explicitly rejects them).
    pub url: String,
}

/// Message content on the wire: plain text, or a parts array (vision input).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum WireContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

/// Wire-only projection of [`ChatMessage`] for the request body: identical
/// shape except `content` may be multimodal. Built exclusively by the wire
/// projection in `client.rs` — canonical messages keep plain-text content
/// plus [`ChatMessage::attachments`] references, which never serialize here.
#[derive(Debug, Clone, Serialize)]
pub struct WireChatMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<WireContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl From<ChatMessage> for WireChatMessage {
    fn from(m: ChatMessage) -> Self {
        WireChatMessage {
            role: m.role,
            content: m.content.map(WireContent::Text),
            reasoning_content: m.reasoning_content,
            tool_calls: m.tool_calls,
            tool_call_id: m.tool_call_id,
        }
    }
}

// ── Tool Definition (for function calling) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolParameter {
    #[serde(rename = "type")]
    pub param_type: String,
    pub description: String,
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ToolParameter>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    /// For `type: "object"` parameters — nested property schemas.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<HashMap<String, ToolParameter>>,
    /// Per-object required fields; only emitted when `properties` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
}

impl ToolParameter {
    pub fn string(desc: &str) -> Self {
        Self {
            param_type: "string".into(),
            description: desc.into(),
            enum_values: None,
            items: None,
            default: None,
            properties: None,
            required: None,
        }
    }
    pub fn integer(desc: &str) -> Self {
        Self {
            param_type: "integer".into(),
            description: desc.into(),
            enum_values: None,
            items: None,
            default: None,
            properties: None,
            required: None,
        }
    }
    pub fn boolean(desc: &str) -> Self {
        Self {
            param_type: "boolean".into(),
            description: desc.into(),
            enum_values: None,
            items: None,
            default: None,
            properties: None,
            required: None,
        }
    }
    pub fn string_enum(desc: &str, values: &[&str]) -> Self {
        Self {
            param_type: "string".into(),
            description: desc.into(),
            enum_values: Some(values.iter().map(|s| s.to_string()).collect()),
            items: None,
            default: None,
            properties: None,
            required: None,
        }
    }
    pub fn array_of(desc: &str, item_type: ToolParameter) -> Self {
        Self {
            param_type: "array".into(),
            description: desc.into(),
            enum_values: None,
            items: Some(Box::new(item_type)),
            default: None,
            properties: None,
            required: None,
        }
    }
    pub fn object(
        desc: &str,
        properties: HashMap<String, ToolParameter>,
        required: Vec<String>,
    ) -> Self {
        Self {
            param_type: "object".into(),
            description: desc.into(),
            enum_values: None,
            items: None,
            default: None,
            properties: Some(properties),
            required: if required.is_empty() {
                None
            } else {
                Some(required)
            },
        }
    }
    pub fn with_default(mut self, val: serde_json::Value) -> Self {
        self.default = Some(val);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolParameters {
    #[serde(rename = "type")]
    pub schema_type: String,
    pub properties: HashMap<String, ToolParameter>,
    pub required: Vec<String>,
}

impl ToolParameters {
    /// Convenience constructor for an `object` schema.
    pub fn object(properties: HashMap<String, ToolParameter>, required: Vec<String>) -> Self {
        Self {
            schema_type: "object".into(),
            properties,
            required,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: ToolParameters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDefinition,
}

impl ToolDefinition {
    pub fn new(name: &str, description: &str, parameters: ToolParameters) -> Self {
        ToolDefinition {
            tool_type: "function".to_string(),
            function: FunctionDefinition {
                name: name.to_string(),
                description: description.to_string(),
                parameters,
            },
        }
    }

    pub fn name(&self) -> &str {
        &self.function.name
    }
}

// ── Tool Execution Result ──

pub struct ToolResult {
    pub output: String,
    pub inject_tools: Vec<ToolDefinition>,
    pub skip_compress: bool,
    /// Content rendered as assistant body directly (streamed via
    /// `AgentEvent::StreamContent` and seeded into the next assistant message).
    pub inline_content: Option<String>,
    /// Structured success signal for the loop's consecutive-failure counter.
    /// `Some(true)` = ran OK (do not count as failure even if output text
    /// contains scary words), `Some(false)` = real failure, `None` = no opinion
    /// (fall back to substring heuristic).
    pub success: Option<bool>,
}

impl ToolResult {
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            output: s.into(),
            inject_tools: Vec::new(),
            skip_compress: false,
            inline_content: None,
            success: None,
        }
    }
    pub fn text_raw(s: impl Into<String>) -> Self {
        Self {
            output: s.into(),
            inject_tools: Vec::new(),
            skip_compress: true,
            inline_content: None,
            success: None,
        }
    }
    pub fn text_with_inline(log: impl Into<String>, inline: impl Into<String>) -> Self {
        Self {
            output: log.into(),
            inject_tools: Vec::new(),
            skip_compress: false,
            inline_content: Some(inline.into()),
            success: None,
        }
    }
    pub fn with_success(mut self, ok: bool) -> Self {
        self.success = Some(ok);
        self
    }
    pub fn with_inject(mut self, tools: Vec<ToolDefinition>) -> Self {
        self.inject_tools = tools;
        self
    }
}

// ── Safety ──

// Ascending severity (Safe < Moderate < Dangerous); the derived `Ord` relies on
// declaration order so callers can `cmp::max` two risks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Safe,
    Moderate,
    Dangerous,
}

// ── SSE Stream Parsing ──

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SseDelta {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<SseToolCallDelta>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SseToolCallDelta {
    pub index: usize,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<SseFunctionDelta>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SseFunctionDelta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SseChoice {
    pub index: usize,
    pub delta: SseDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SseUsage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
    #[serde(default)]
    pub prompt_cache_hit_tokens: Option<u32>,
}

impl SseUsage {
    /// Cached prompt tokens, normalising OpenAI vs DeepSeek shapes.
    pub fn cached_tokens(&self) -> u32 {
        self.prompt_tokens_details
            .as_ref()
            .map(|d| d.cached_tokens)
            .or(self.prompt_cache_hit_tokens)
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: u32,
}

/// Provider-neutral token accounting for one LLM round, as reported by the
/// upstream `usage` object. Zero fields mean "not reported", not "none used".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Prompt / input tokens INCLUDING cache reads (OpenAI convention).
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// Prompt tokens served from the provider's prompt cache.
    pub cached_tokens: u32,
    /// Prompt tokens written into the cache this round (Anthropic-style
    /// providers; `0` where the concept does not exist).
    pub cache_write_tokens: u32,
}

impl TokenUsage {
    pub fn is_empty(&self) -> bool {
        self.prompt_tokens == 0 && self.completion_tokens == 0
    }

    pub fn total_tokens(&self) -> u32 {
        self.prompt_tokens.saturating_add(self.completion_tokens)
    }
}

impl From<&SseUsage> for TokenUsage {
    fn from(u: &SseUsage) -> Self {
        TokenUsage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            cached_tokens: u.cached_tokens(),
            cache_write_tokens: 0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SseData {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub choices: Vec<SseChoice>,
    #[serde(default)]
    pub usage: Option<SseUsage>,
}

// ── UI Events alias ──
// Kept as an alias so ported code referring to `UiEvent` keeps working, while
// the canonical type lives in this crate's `event` module (no external crate).
pub type UiEvent = crate::event::AgentEvent;

// ── API Request ──

#[derive(Debug, Serialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<WireChatMessage>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<StreamOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingConfig>,
    /// Response generation cap (`max_tokens` is deprecated on Kimi; this is
    /// the modern OpenAI-compatible field). Sent only for models whose
    /// capability table pins a value (see [`crate::model_caps`]) — e.g. Kimi
    /// K3, where the coding endpoint's server default is a low 32K that
    /// reasoning alone can exhaust. `None` = the server default stays in
    /// charge (historical behavior).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct StreamOptions {
    pub include_usage: bool,
}

#[derive(Debug, Serialize)]
pub struct ThinkingConfig {
    #[serde(rename = "type")]
    pub thinking_type: String,
}
