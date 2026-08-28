//! OpenAI-compatible streaming LLM client.
//!
//! SSE is parsed at the byte level so a multi-byte UTF-8 char split across
//! network chunks is never mangled.

use std::collections::{BTreeMap, HashSet};
use std::error::Error;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use tokio::sync::mpsc;

use crate::types::*;

#[derive(Clone)]
pub struct LlmClient {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    temperature: Option<f32>,
    /// Configured reasoning-effort override (`None`/empty = the provider
    /// profile's default). Values are provider-specific (e.g. GLM-5.3:
    /// `low`/`high`/`max`) and sent as the OpenAI-compatible top-level
    /// `reasoning_effort` field where the profile supports it.
    reasoning_effort: Option<String>,
    /// Vision capability override from config (`None` = auto-detect from the
    /// model name via [`model_supports_vision`]).
    vision_override: Option<bool>,
    /// Where uploaded images live (`runtime/uploads`). Attachment references
    /// are resolved (read + base64-encoded) against it at request time.
    uploads_dir: Option<std::path::PathBuf>,
    /// Latched when the endpoint 400-rejects `max_completion_tokens`: the
    /// field is dropped from every later request (this process) instead of
    /// failing each one. Shared across clones (per-turn model swaps, reduced-
    /// effort retries) so one rejection teaches them all.
    max_tokens_unsupported: Arc<AtomicBool>,
}

/// A streamed chat completion, fully assembled: the assistant message plus the
/// provider's terminal `finish_reason` (`stop`, `length`, `tool_calls`, …;
/// `None` when the stream closed via `[DONE]` without one). `length` means the
/// response hit the completion-token cap — callers use it to tell "the payload
/// IS truncated" apart from "the model chose to stop here".
pub struct StreamOutcome {
    pub message: ChatMessage,
    pub finish_reason: Option<String>,
}

/// Stable marker carried by the "reasoning-only response" stream error (the
/// model produced thinking but neither content nor tool calls). The agent loop
/// keys its one-shot automatic retry on it.
pub(crate) const REASONING_ONLY_MARKER: &str = "reasoning-only response discarded";

/// Marker present when a stream error was caused by the completion-token cap
/// (`finish_reason=length`): the retry should spend less on reasoning.
pub(crate) const LENGTH_TRUNCATED_MARKER: &str = "finish_reason=length";

/// Whether a chat-stream error is the reasoning-only class (worth one retry).
pub(crate) fn error_is_reasoning_only(error: &str) -> bool {
    error.contains(REASONING_ONLY_MARKER)
}

/// Whether a chat-stream error reports a completion-token-cap truncation.
pub(crate) fn error_is_length_truncated(error: &str) -> bool {
    error.contains(LENGTH_TRUNCATED_MARKER)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WireProfile {
    OpenAiCompatible,
    DeepSeek,
    /// Kimi K3: OpenAI-compatible top-level `reasoning_effort`
    /// (`low`/`high`/`max`, default `max`), no `thinking` field, and — like
    /// DeepSeek — the reasoning generated on a tool-call turn must be
    /// replayed back on the next request.
    KimiK3,
    /// Zhipu GLM (bigmodel.cn / z.ai): `thinking={type:enabled}` plus an
    /// optional `reasoning_effort` (GLM-5.3: `low`/`high`/`max`, server
    /// default `max`; GLM-5.2 accepts more levels). No reasoning replay —
    /// the API neither requires nor documents it.
    Glm,
}

impl WireProfile {
    fn replays_tool_reasoning(self) -> bool {
        matches!(self, Self::DeepSeek | Self::KimiK3)
    }

    /// Kimi K3 requires the COMPLETE assistant message replayed as-is on
    /// every request — including `reasoning_content` on plain (non-tool)
    /// replies ("多轮对话和工具调用必须原样回传完整 assistant message").
    /// DeepSeek explicitly ignores non-tool-turn reasoning, and Qwen-style
    /// providers reject it, so this stays K3-only.
    fn replays_all_reasoning(self) -> bool {
        matches!(self, Self::KimiK3)
    }

    /// Kimi K3 fixes sampling parameters server-side (`temperature=1.0`,
    /// `top_p=0.95`, …) and advises against sending them explicitly.
    fn omits_sampling_params(self) -> bool {
        matches!(self, Self::KimiK3)
    }
}

/// Display label for an attachment in placeholders (name, falling back to id).
fn display_name(attachment: &Attachment) -> &str {
    if attachment.name.trim().is_empty() {
        &attachment.id
    } else {
        &attachment.name
    }
}

/// Human-readable byte size for file notes: `2.4 MB` / `3 KB` / `512 B`.
fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

/// MIME type from an upload id's extension (ids are `<uuid>.<ext>`).
fn mime_from_upload_id(id: &str) -> String {
    match id.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Whether a (lowercased) model name denotes Kimi K3. Matches a `k3` token so
/// bare `k3`, `kimi-k3`, `kimi-k3-turbo`, `moonshot/kimi-k3` all qualify, while
/// unrelated names like `k30` / `2k3` do not.
pub(crate) fn is_kimi_k3(model: &str) -> bool {
    model
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| token == "k3")
}

/// Whether a (lowercased) model name denotes a Zhipu GLM model. Matches a
/// `glm` token so `glm-5.3`, `glm-4.7`, `z-ai/glm-5.3` all qualify, while
/// unrelated names containing the letters (e.g. `paglm`) do not.
pub(crate) fn is_glm(model: &str) -> bool {
    model
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| token == "glm")
}

/// Conservative vision (image input) heuristic over the model name. Image
/// parts use the OpenAI-standard format everywhere, so the only per-model
/// question is "can it accept them at all" — sending images to a text-only
/// model is a provider 400. Unknown/private names can be forced via the
/// `vision` config override.
pub(crate) fn model_supports_vision(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    let tokens: Vec<&str> = m
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    // `4v` / `5v` / `46v` … (GLM vision families), plain `vl` (Qwen-VL),
    // `omni`, `vision`, `llava`, and Kimi K3.
    let digit_v = |t: &&str| {
        t.len() >= 2 && t.ends_with('v') && t[..t.len() - 1].chars().all(|c| c.is_ascii_digit())
    };
    tokens.contains(&"k3")
        || tokens.contains(&"vl")
        || tokens.contains(&"omni")
        || tokens.contains(&"vision")
        || tokens.contains(&"llava")
        || tokens.iter().any(digit_v)
        || m.contains("gpt-4o")
        || m.contains("gpt-4.1")
        || m.contains("gpt-5")
        || m.contains("gemini")
}

impl LlmClient {
    pub fn new(base_url: &str, api_key: &str, model: &str, temperature: Option<f32>) -> Self {
        LlmClient {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
            temperature,
            reasoning_effort: None,
            vision_override: None,
            uploads_dir: None,
            max_tokens_unsupported: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Configured reasoning-effort override (empty/`None` = the provider
    /// profile's default). Chainable at construction and per-clone, mirroring
    /// [`Self::with_model`] so a sub-agent can run on a lighter effort level.
    pub fn with_reasoning_effort(mut self, effort: Option<String>) -> Self {
        self.reasoning_effort = effort
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty());
        self
    }

    /// Vision capability override from config (`None` = auto-detect).
    pub fn with_vision(mut self, vision: Option<bool>) -> Self {
        self.vision_override = vision;
        self
    }

    /// Where uploaded images live (attachment resolution at request time).
    pub fn with_uploads_dir(mut self, dir: Option<std::path::PathBuf>) -> Self {
        self.uploads_dir = dir;
        self
    }

    /// Override the model for this client instance. Used to apply a per-turn
    /// model selection: the web layer clones the shared client and swaps the
    /// model before spawning a chat turn, leaving the default untouched.
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = model.to_string();
        self
    }

    /// List the models the upstream OpenAI-compatible endpoint advertises via
    /// `GET {base_url}/models` (`data[].id`). Not all providers implement it;
    /// callers treat any error as "no list available" and fall back to a
    /// read-only model badge. A short timeout keeps a slow/absent endpoint from
    /// stalling the UI.
    pub async fn list_models(&self) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
        let url = format!("{}/models", self.base_url);
        let mut req_builder = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .header("Accept", "application/json");
        if !self.api_key.is_empty() {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", self.api_key));
        }

        let response = req_builder.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!("models list error: {} {}", status, log_truncate(&body, 200)).into());
        }

        let payload: serde_json::Value = response.json().await?;
        let models = payload
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|id| id.as_str()))
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(models)
    }

    /// Whether the configured model accepts image input (config override
    /// first, then the model-name heuristic). Single source of truth — the
    /// web meta endpoint and the TUI both consume this.
    pub fn supports_vision(&self) -> bool {
        self.vision_override
            .unwrap_or_else(|| model_supports_vision(&self.model))
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Whether an API key is configured (the TUI surfaces a setup hint when not).
    pub fn has_api_key(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    fn wire_profile(&self) -> WireProfile {
        let model = self.model.to_ascii_lowercase();
        let base_url = self.base_url.to_ascii_lowercase();
        if model.contains("deepseek") || base_url.contains("api.deepseek.com") {
            WireProfile::DeepSeek
        } else if is_kimi_k3(&model) {
            // Match on the model name only (not the moonshot base_url) so the
            // K2.x models on the same endpoint keep the default behavior.
            WireProfile::KimiK3
        } else if is_glm(&model) {
            // Model name only, for the same reason: non-GLM models served
            // through a bigmodel-compatible proxy keep the default behavior.
            WireProfile::Glm
        } else {
            WireProfile::OpenAiCompatible
        }
    }

    /// Reasoning-mode request parameters, driven by the wire profile plus the
    /// model capability table ([`crate::model_caps`]):
    /// - `thinking={type:enabled}`: always for the DeepSeek profile (a wire
    ///   decision — base_url counts, so aliased model names on the official
    ///   endpoint keep it), and for GLM 4.5+ (older GLM rejects the field).
    ///   Kimi K3 uses top-level effort only.
    /// - The configured [`Self::with_reasoning_effort`] value is CLAMPED for
    ///   known families: sent when the model's `effort_levels` list contains
    ///   it, otherwise it falls back to the provider default (which may mean
    ///   sending nothing). Unknown models pass the value through verbatim —
    ///   the operator knows their private deployment better than we do.
    /// - With nothing configured, DeepSeek and Kimi K3 keep their historical
    ///   `"max"` baseline; GLM and plain OpenAI-compatible send nothing (the
    ///   server default stays in charge).
    fn reasoning_params(&self) -> (Option<String>, Option<ThinkingConfig>) {
        let caps = crate::model_caps::model_caps(&self.model);
        let enabled = || {
            Some(ThinkingConfig {
                thinking_type: "enabled".to_string(),
            })
        };
        let thinking = match self.wire_profile() {
            WireProfile::DeepSeek => enabled(),
            WireProfile::Glm if crate::model_caps::glm_accepts_thinking_field(&self.model) => {
                enabled()
            }
            _ => None,
        };

        let baseline = match self.wire_profile() {
            WireProfile::DeepSeek | WireProfile::KimiK3 => Some("max".to_string()),
            WireProfile::Glm | WireProfile::OpenAiCompatible => None,
        };
        let effort = match self.reasoning_effort.clone() {
            None => baseline,
            Some(e) if caps.effort_levels.contains(&e.as_str()) => Some(e),
            Some(e) if !crate::model_caps::known_family(&self.model) => Some(e),
            // Known family, unsupported value (or the family has no effort
            // parameter at all): clamp to the provider default.
            Some(_) => caps.default_effort.map(str::to_string),
        };
        (effort, thinking)
    }

    /// The temperature actually sent on the wire: providers that fix their
    /// sampling parameters (Kimi K3) never receive one, even when configured.
    fn effective_temperature(&self) -> Option<f32> {
        if self.wire_profile().omits_sampling_params() {
            None
        } else {
            self.temperature
        }
    }

    /// Resolve canonical messages into the request-body form. Image
    /// attachments become OpenAI-standard image parts for vision-capable
    /// models, or text placeholders otherwise (so a session with images keeps
    /// working after switching to a text-only model). Non-image attachments
    /// become a single path-note block for EVERY model — the file never
    /// enters context; the model inspects it on demand with
    /// read_file/search_files. Images get a path note of their own so they can
    /// be handed to a tool as files (theme assets, conversion, publish).
    /// Attachment fields never reach the wire.
    ///
    /// Assembly order is fixed: with image parts, `[images…, text(body + image
    /// note + file note)]`; text-only, `body \n placeholders \n image note \n
    /// file note`.
    async fn resolve_wire_messages(&self, messages: Vec<ChatMessage>) -> Vec<WireChatMessage> {
        let vision = self.supports_vision();
        let mut out = Vec::with_capacity(messages.len());
        for mut message in messages {
            let attachments = message.attachments.take().filter(|a| !a.is_empty());
            let (Some(attachments), Role::User) = (attachments, &message.role) else {
                out.push(WireChatMessage::from(message));
                continue;
            };
            let (images, files): (Vec<Attachment>, Vec<Attachment>) =
                attachments.into_iter().partition(Attachment::is_image);
            let text = message.content.clone().unwrap_or_default();
            let file_note = self.file_note_block(&files);
            let image_note = self.image_note_block(&images);
            let mut wire = WireChatMessage::from(message);
            if vision && !images.is_empty() {
                let mut parts: Vec<ContentPart> = Vec::new();
                for attachment in &images {
                    match self.attachment_data_url(attachment).await {
                        Some(url) => parts.push(ContentPart::ImageUrl {
                            image_url: ImageUrl { url },
                        }),
                        None => parts.push(ContentPart::Text {
                            text: format!("[image unavailable: {}]", display_name(attachment)),
                        }),
                    }
                }
                let mut tail = if text.trim().is_empty() { String::new() } else { text };
                for note in [&image_note, &file_note].into_iter().flatten() {
                    if !tail.is_empty() {
                        tail.push_str("\n\n");
                    }
                    tail.push_str(note);
                }
                if !tail.is_empty() {
                    parts.push(ContentPart::Text { text: tail });
                }
                wire.content = Some(WireContent::Parts(parts));
            } else {
                let mut sections: Vec<String> = Vec::new();
                if !text.trim().is_empty() {
                    sections.push(text);
                }
                if !images.is_empty() {
                    // Text-only model: be explicit that it CANNOT see the
                    // image — a bare "[image: x]" invites hallucinating its
                    // contents.
                    sections.push(
                        images
                            .iter()
                            .map(|a| {
                                format!(
                                    "[image attached: {} — not visible to this model]",
                                    display_name(a)
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
                for note in [image_note, file_note].into_iter().flatten() {
                    sections.push(note);
                }
                wire.content = Some(WireContent::Text(sections.join("\n")));
            }
            out.push(wire);
        }
        out
    }

    /// One note block covering every non-image attachment on a message:
    ///
    /// ```text
    /// [attached files — inspect with read_file (paginated) / search_files:
    ///   bridge.log (2.4 MB, 18231 lines) at /abs/uploads/xxx.log
    ///   wifi.conf (3 KB, 42 lines) at /abs/uploads/yyy.conf]
    /// ```
    ///
    /// Pure formatting over `Attachment` metadata captured at upload time —
    /// no file reads at request time; one shared instruction line no matter
    /// how many files (token-lean, prefix-cache friendly). Missing files
    /// (cleared runtime cache) degrade to `<name> (unavailable)`.
    fn file_note_block(&self, files: &[Attachment]) -> Option<String> {
        self.note_block(
            files,
            "[attached files — inspect with read_file (paginated) / search_files:",
        )
    }

    /// The same note for IMAGE attachments, whose pixels already travel inline
    /// as a `data:` URL. What the model lacks is the disk PATH — needed to reuse
    /// the upload as a file: install it as a theme asset with `set_chat_style`,
    /// convert it, publish it. Without this it has to guess at `runtime/uploads`
    /// and list a directory of uuids to find the image the user just sent.
    ///
    /// Vanished uploads are omitted rather than listed as `(unavailable)`: the
    /// image part already says so for the model that can see images, and a
    /// text-only model gets its own explicit placeholder.
    fn image_note_block(&self, images: &[Attachment]) -> Option<String> {
        self.note_block(
            images.iter().filter(|a| self.upload_path(a).is_some()),
            "[attached images — on disk too, pass the path when a tool needs the file:",
        )
    }

    /// Where an upload lives, when it is still there. `None` when the uploads
    /// dir is unconfigured, the id looks path-like, or the runtime cache was
    /// cleared.
    fn upload_path(&self, attachment: &Attachment) -> Option<PathBuf> {
        let dir = self.uploads_dir.as_ref()?;
        let id = &attachment.id;
        // Ids are generated as `<uuid>.<ext>`; reject anything path-like.
        if id.contains('/') || id.contains('\\') || id.contains("..") {
            return None;
        }
        let path = dir.join(id);
        // `Path::is_file` answers false for everything on wasm, and an upload
        // lives in the workspace rather than on a disk. See crate::vfs.
        crate::vfs::is_file(&path).then_some(path)
    }

    fn note_block<'a>(
        &self,
        files: impl IntoIterator<Item = &'a Attachment>,
        header: &str,
    ) -> Option<String> {
        let entries = files
            .into_iter()
            .map(|f| {
                let name = display_name(f);
                let Some(path) = self.upload_path(f) else {
                    return format!("  {name} (unavailable)");
                };
                let meta = match (f.size, f.lines) {
                    (0, _) => String::new(),
                    (s, Some(1)) => format!(" ({}, 1 line)", human_size(s)),
                    (s, Some(l)) => format!(" ({}, {l} lines)", human_size(s)),
                    (s, None) => format!(" ({})", human_size(s)),
                };
                format!("  {name}{meta} at {}", path.display())
            })
            .collect::<Vec<_>>();
        if entries.is_empty() {
            return None;
        }
        Some(format!("{header}\n{}]", entries.join("\n")))
    }

    /// Read an uploaded image and encode it as a `data:` URL. `None` when the
    /// uploads dir is not configured, the id looks unsafe, or the file is
    /// gone (cleared runtime cache) — callers degrade to a placeholder.
    async fn attachment_data_url(&self, attachment: &Attachment) -> Option<String> {
        let path = self.upload_path(attachment)?;
        // Synchronous, because the workspace is: `tokio::fs` does not exist on
        // wasm32 (the `fs` feature is refused for the target), and reading an
        // upload out of the in-memory tree has nothing to wait for anyway.
        let bytes = crate::vfs::read(&path).ok()?;
        let mime = if attachment.mime.trim().is_empty() {
            mime_from_upload_id(&attachment.id)
        } else {
            attachment.mime.clone()
        };
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
    }

    /// Project canonical persisted messages onto the current provider's wire
    /// format. This is deliberately non-destructive: malformed legacy rows stay
    /// available for UI/history export but cannot poison future LLM requests.
    fn prepare_messages_for_api(&self, messages: &[ChatMessage]) -> Vec<ChatMessage> {
        let profile = self.wire_profile();

        // Pairing guard (heals orphaned histories from older or interrupted
        // turns). OpenAI rejects a request when an assistant `tool_calls` entry
        // has no following `tool` result, or a `tool` message references a call
        // no assistant declared. Pre-scan both directions so the unmatched side
        // can be dropped here without mutating the persisted rows (UI/export
        // keep the originals). This is the single wire chokepoint, so a session
        // whose SQLite history is already broken can resume without migration.
        //
        // Blank ids are excluded from both sets on purpose. A malformed stream
        // can leave an assistant call and its result both carrying `""`, which
        // pairs with itself and would otherwise sail through — until a provider
        // that maps the history onto Anthropic's `tool_result` block rejects the
        // empty `tool_use_id`. Keeping `""` out of the sets makes both sides
        // unmatched, so the guard below drops them as orphans and an already
        // poisoned session heals itself on its next request.
        let answered_tool_calls: HashSet<&str> = messages
            .iter()
            .filter(|m| matches!(m.role, Role::Tool))
            .filter_map(|m| m.tool_call_id.as_deref())
            .filter(|id| !id.trim().is_empty())
            .collect();
        let declared_tool_calls: HashSet<&str> = messages
            .iter()
            .filter_map(|m| m.tool_calls.as_ref())
            .flatten()
            .map(|tc| tc.id.as_str())
            .filter(|id| !id.trim().is_empty())
            .collect();

        messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| {
                let mut wire = message.clone();

                if matches!(wire.role, Role::Skill) {
                    // Canonical skill-context messages (explicit user
                    // activation) are input context: encode as a plain
                    // user-role message. `tool_call_id` carries the skill name
                    // for renderers only and must not reach the wire.
                    wire.role = Role::User;
                    wire.reasoning_content = None;
                    wire.tool_calls = None;
                    wire.tool_call_id = None;
                    return Some(wire);
                }

                if matches!(wire.role, Role::Tool) {
                    // Drop a tool result whose call no assistant declared
                    // (orphan) — the provider would reject the dangling message.
                    let matched = wire
                        .tool_call_id
                        .as_deref()
                        .is_some_and(|id| declared_tool_calls.contains(id));
                    if !matched {
                        log::warn!(
                            "LLM request dropped orphan tool result: index={} tool_call_id={:?}",
                            index,
                            wire.tool_call_id
                        );
                        return None;
                    }
                    wire.reasoning_content = None;
                    return Some(wire);
                }

                if !matches!(wire.role, Role::Assistant) {
                    // `reasoning_content` is not part of the OpenAI wire format
                    // for system/user messages.
                    wire.reasoning_content = None;
                    return Some(wire);
                }

                // Assistant: drop any tool_call lacking a matching tool result
                // (orphan) so the request never carries an unanswered call.
                if let Some(tool_calls) = wire.tool_calls.take() {
                    let before = tool_calls.len();
                    let kept: Vec<ToolCall> = tool_calls
                        .into_iter()
                        .filter(|tc| answered_tool_calls.contains(tc.id.as_str()))
                        .collect();
                    if kept.len() != before {
                        log::warn!(
                            "LLM request dropped {} unanswered tool_call(s) from assistant: index={}",
                            before - kept.len(),
                            index
                        );
                    }
                    if !kept.is_empty() {
                        wire.tool_calls = Some(kept);
                    }
                }

                let has_content = wire
                    .content
                    .as_deref()
                    .is_some_and(|content| !content.trim().is_empty());
                let has_tool_calls = wire
                    .tool_calls
                    .as_ref()
                    .is_some_and(|tool_calls| !tool_calls.is_empty());

                if !has_content && !has_tool_calls {
                    log::warn!(
                        "LLM request dropped invalid assistant history: index={} reasoning_len={}",
                        index,
                        wire.reasoning_content.as_deref().map(str::len).unwrap_or(0)
                    );
                    return None;
                }

                // Normalize blank option values instead of sending provider-
                // sensitive empty strings/arrays.
                if !has_content {
                    wire.content = None;
                }
                if !has_tool_calls {
                    wire.tool_calls = None;
                }

                // Reasoning replay is provider-specific:
                // - Kimi K3: the complete assistant message must be replayed
                //   as-is on EVERY turn (missing tool-turn reasoning is a 400;
                //   missing plain-turn reasoning degrades coherence/caching).
                // - DeepSeek: tool-call turns must replay reasoning in all
                //   subsequent requests (400 otherwise); non-tool turns are
                //   explicitly ignored.
                // - Other OpenAI-compatible providers either do not define
                //   this field or reject it (e.g. Qwen) — strip it.
                let replay = profile.replays_all_reasoning()
                    || (profile.replays_tool_reasoning() && has_tool_calls);
                wire.reasoning_content = if replay {
                    message
                        .reasoning_content
                        .as_ref()
                        .filter(|reasoning| !reasoning.trim().is_empty())
                        .cloned()
                } else {
                    None
                };

                Some(wire)
            })
            .collect()
    }

    /// Streaming chat completion. Parsed SSE events go to `event_tx`; the
    /// complete assistant message (content + tool_calls) is returned when done.
    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
        event_tx: &mpsc::UnboundedSender<UiEvent>,
    ) -> Result<ChatMessage, Box<dyn Error + Send + Sync>> {
        self.chat_stream_inner(messages, tools, event_tx, None, None)
            .await
            .map(|outcome| outcome.message)
    }

    /// Same as [`chat_stream`] but seeds the assistant content with a
    /// pre-existing string (e.g. inline content already streamed from a tool).
    /// The seed is NOT re-emitted; it is only merged into the returned message.
    pub async fn chat_stream_with_seed(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
        event_tx: &mpsc::UnboundedSender<UiEvent>,
        content_seed: Option<String>,
    ) -> Result<ChatMessage, Box<dyn Error + Send + Sync>> {
        self.chat_stream_inner(messages, tools, event_tx, None, content_seed)
            .await
            .map(|outcome| outcome.message)
    }

    /// Same as [`chat_stream`] but polls `cancel`; cancellation returns an error
    /// instead of promoting a partial stream to a completed assistant message.
    pub async fn chat_stream_cancellable(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
        event_tx: &mpsc::UnboundedSender<UiEvent>,
        cancel: Arc<AtomicBool>,
    ) -> Result<ChatMessage, Box<dyn Error + Send + Sync>> {
        self.chat_stream_inner(messages, tools, event_tx, Some(cancel), None)
            .await
            .map(|outcome| outcome.message)
    }

    /// Cancellable variant of [`Self::chat_stream_with_seed`].
    pub async fn chat_stream_with_seed_cancellable(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
        event_tx: &mpsc::UnboundedSender<UiEvent>,
        cancel: Arc<AtomicBool>,
        content_seed: Option<String>,
    ) -> Result<ChatMessage, Box<dyn Error + Send + Sync>> {
        self.chat_stream_inner(messages, tools, event_tx, Some(cancel), content_seed)
            .await
            .map(|outcome| outcome.message)
    }

    /// Full-fidelity streaming entry: like the wrappers above but returns the
    /// [`StreamOutcome`] (message + terminal `finish_reason`), which the agent
    /// loop uses to tell a token-cap truncation apart from a normal stop.
    pub async fn chat_stream_outcome(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
        event_tx: &mpsc::UnboundedSender<UiEvent>,
        cancel: Option<Arc<AtomicBool>>,
        content_seed: Option<String>,
    ) -> Result<StreamOutcome, Box<dyn Error + Send + Sync>> {
        self.chat_stream_inner(messages, tools, event_tx, cancel, content_seed)
            .await
    }

    async fn chat_stream_inner(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolDefinition]>,
        event_tx: &mpsc::UnboundedSender<UiEvent>,
        cancel: Option<Arc<AtomicBool>>,
        content_seed: Option<String>,
    ) -> Result<StreamOutcome, Box<dyn Error + Send + Sync>> {
        let url = format!("{}/chat/completions", self.base_url);
        let canonical = self.prepare_messages_for_api(messages);

        log::info!(
            "LLM request: model={} messages={} source_messages={} tools={} last_user_msg={}",
            self.model,
            canonical.len(),
            messages.len(),
            tools.map(|t| t.len()).unwrap_or(0),
            last_user_msg_preview(&canonical, 100)
        );

        let wire_messages = self.resolve_wire_messages(canonical).await;

        let (reasoning_effort, thinking) = self.reasoning_params();
        let mut request = ChatCompletionRequest {
            model: self.model.clone(),
            messages: wire_messages,
            stream: true,
            tools: tools.map(|t| t.to_vec()),
            temperature: self.effective_temperature(),
            stream_options: Some(StreamOptions {
                include_usage: true,
            }),
            reasoning_effort,
            thinking,
            max_completion_tokens: self.effective_max_completion_tokens(),
        };

        let response = match self.send_chat_request(&url, &request, true).await {
            Ok(response) => response,
            // Any 400 while the optional `max_completion_tokens` field is on
            // the wire gets one retry without it. Rejections don't reliably
            // name the field (localized or empty bodies), and an endpoint
            // that rejects it must not brick every request. An unrelated 400
            // just fails again identically on the retry — one extra request,
            // never a new failure mode.
            Err(error)
                if request.max_completion_tokens.is_some()
                    && is_bad_request_error(&error.to_string()) =>
            {
                log::warn!(
                    "LLM request with max_completion_tokens={} got a 400; retrying \
                     without the field: {}",
                    request.max_completion_tokens.unwrap_or_default(),
                    log_truncate(&error.to_string(), 300)
                );
                request.max_completion_tokens = None;
                let response = self.send_chat_request(&url, &request, true).await?;
                // Succeeding without the field proves the field was the
                // problem: stop sending it (this client and its clones) for
                // the rest of the process.
                log::warn!(
                    "LLM endpoint accepted the request without max_completion_tokens; \
                     disabling the field for this client"
                );
                self.max_tokens_unsupported.store(true, Ordering::Relaxed);
                response
            }
            Err(error) => return Err(error),
        };

        self.process_stream(response, event_tx, cancel, content_seed)
            .await
    }

    /// The `max_completion_tokens` to put on the wire: the capability table's
    /// pinned value (see [`crate::model_caps`]), unless this endpoint already
    /// 400-rejected the field once.
    fn effective_max_completion_tokens(&self) -> Option<u32> {
        if self.max_tokens_unsupported.load(Ordering::Relaxed) {
            return None;
        }
        crate::model_caps::model_caps(&self.model).max_completion_tokens
    }

    async fn process_stream(
        &self,
        response: reqwest::Response,
        event_tx: &mpsc::UnboundedSender<UiEvent>,
        cancel: Option<Arc<AtomicBool>>,
        content_seed: Option<String>,
    ) -> Result<StreamOutcome, Box<dyn Error + Send + Sync>> {
        use futures::StreamExt;

        let mut content_buf = content_seed.unwrap_or_default();
        let mut reasoning_buf = String::new();
        // Keyed by the provider's `index` rather than positionally: a stream
        // whose indices start at 1, skip a value, or arrive out of order must
        // not fabricate empty slots (see the drop guard below), and a wild
        // index must not size an allocation.
        let mut tool_calls: BTreeMap<usize, ToolCallAccumulator> = BTreeMap::new();
        let mut byte_buf: Vec<u8> = Vec::new();

        let mut stream = response.bytes_stream();
        let mut usage: Option<SseUsage> = None;
        let stream_t0 = wasmtimer::std::Instant::now();
        let mut saw_terminal = false;
        let mut finish_reason: Option<String> = None;

        'stream: loop {
            if let Some(c) = cancel.as_ref() {
                if c.load(Ordering::Relaxed) {
                    log::info!(
                        "LLM stream cancelled at elapsed_ms={}; discarding partial message",
                        stream_t0.elapsed().as_millis()
                    );
                    return Err("LLM stream cancelled".into());
                }
            }

            let next_chunk = if cancel.is_some() {
                tokio::select! {
                    chunk = stream.next() => chunk,
                    _ = wasmtimer::tokio::sleep(Duration::from_millis(50)) => continue,
                }
            } else {
                stream.next().await
            };
            let Some(chunk) = next_chunk else {
                break;
            };
            let chunk = chunk?;

            for line in drain_sse_lines(&mut byte_buf, &chunk) {
                if line == "data: [DONE]" {
                    saw_terminal = true;
                    break 'stream;
                }
                if line.is_empty() {
                    continue;
                }

                if let Some(json_str) = line.strip_prefix("data: ") {
                    let sse_data = match serde_json::from_str::<SseData>(json_str) {
                        Ok(data) => data,
                        Err(err) => {
                            // A data line we cannot decode may carry content
                            // deltas — dropping it silently would surface later
                            // as a mysteriously empty/truncated message. Keep
                            // going (the terminal marker check still guards the
                            // result), but leave a trace.
                            log::warn!(
                                "LLM stream: undecodable SSE data line dropped: err={} line={}",
                                err,
                                log_truncate(json_str, 200)
                            );
                            continue;
                        }
                    };
                    if let Some(u) = sse_data.usage {
                        usage = Some(u);
                    }
                    for choice in &sse_data.choices {
                        if let Some(reason) = &choice.finish_reason {
                            saw_terminal = true;
                            if !reason.trim().is_empty() {
                                finish_reason = Some(reason.clone());
                            }
                        }
                        let delta = &choice.delta;

                        if let Some(ref c) = delta.content {
                            content_buf.push_str(c);
                            let _ = event_tx.send(UiEvent::StreamContent(c.clone()));
                        }

                        if let Some(ref r) = delta.reasoning_content {
                            reasoning_buf.push_str(r);
                            let _ = event_tx.send(UiEvent::StreamReasoning(r.clone()));
                        }

                        if let Some(ref tc_deltas) = delta.tool_calls {
                            for tc_delta in tc_deltas {
                                let acc = tool_calls.entry(tc_delta.index).or_default();

                                if let Some(ref id) = tc_delta.id {
                                    acc.id = id.clone();
                                }
                                if let Some(ref f) = tc_delta.function {
                                    if let Some(ref name) = f.name {
                                        acc.name = name.clone();
                                        let _ = event_tx.send(UiEvent::ToolCallStart {
                                            id: acc.id.clone(),
                                            name: name.clone(),
                                            arguments: String::new(),
                                        });
                                    }
                                    if let Some(ref args) = f.arguments {
                                        acc.arguments.push_str(args);
                                        let _ = event_tx.send(UiEvent::ToolCallArgumentsDelta {
                                            id: acc.id.clone(),
                                            delta: args.clone(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if cancel
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            log::info!(
                "LLM stream cancelled at elapsed_ms={}; discarding partial message",
                stream_t0.elapsed().as_millis()
            );
            return Err("LLM stream cancelled".into());
        }
        if !saw_terminal {
            return Err(
                "LLM stream ended before a terminal marker; partial response discarded".into(),
            );
        }

        log::info!(
            "LLM stream done: elapsed_ms={} finish_reason={}",
            stream_t0.elapsed().as_millis(),
            finish_reason.as_deref().unwrap_or("-")
        );

        if let Some(u) = &usage {
            let cached = u.cached_tokens();
            let hit_rate = if u.prompt_tokens > 0 {
                (cached as f64 / u.prompt_tokens as f64) * 100.0
            } else {
                0.0
            };
            log::info!(
                "LLM usage: prompt_tokens={} cached_tokens={} completion_tokens={} total_tokens={} cache_hit_rate={:.0}%",
                u.prompt_tokens,
                cached,
                u.completion_tokens,
                u.total_tokens,
                hit_rate
            );
        }

        // A tool call needs both an id (to pair its result with) and a name (to
        // dispatch on). Anything missing either is not a call the provider
        // meant to make — it is stream damage. Persisting it would poison the
        // session for good: the empty id pairs with its own empty-id result, so
        // the history stays self-consistent while every later request carries a
        // blank `tool_use_id` that strict providers reject.
        let final_tool_calls: Option<Vec<ToolCall>> = {
            let kept: Vec<ToolCall> = tool_calls
                .into_iter()
                .filter(|(index, acc)| {
                    let usable = !acc.id.trim().is_empty() && !acc.name.trim().is_empty();
                    if !usable {
                        log::warn!(
                            "LLM stream dropped malformed tool_call: index={} id={:?} name={:?} args_len={}",
                            index,
                            acc.id,
                            acc.name,
                            acc.arguments.len()
                        );
                    }
                    usable
                })
                .map(|(_, acc)| ToolCall {
                    id: acc.id,
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: acc.name,
                        arguments: acc.arguments,
                    },
                })
                .collect();
            (!kept.is_empty()).then_some(kept)
        };

        let content = if content_buf.is_empty() {
            None
        } else {
            Some(content_buf)
        };
        let reasoning = if reasoning_buf.is_empty() {
            None
        } else {
            Some(reasoning_buf)
        };

        let message = ChatMessage::assistant(content, reasoning, final_tool_calls);
        if !message.has_assistant_payload() {
            // `finish_reason` tells the two failure modes apart: `length`
            // means the completion-token cap was exhausted while reasoning
            // (the answer never started), anything else is the model stopping
            // on its own after thinking. The marker strings drive the agent
            // loop's one-shot retry — keep them in sync with
            // `REASONING_ONLY_MARKER` / `LENGTH_TRUNCATED_MARKER`.
            let detail = match finish_reason.as_deref() {
                Some("length") => "finish_reason=length: the response hit the completion \
                                   token cap while still reasoning"
                    .to_string(),
                Some(reason) => format!("finish_reason={reason}"),
                None => "no finish_reason".to_string(),
            };
            return Err(format!(
                "LLM stream ended without assistant content or tool calls ({detail}); \
                 {REASONING_ONLY_MARKER}"
            )
            .into());
        }

        Ok(StreamOutcome {
            message,
            finish_reason,
        })
    }

    /// Non-streaming chat completion; returns just the content string.
    /// Used for auxiliary work (session titles, compaction summaries), so on
    /// GLM — where thinking is always on and defaults to `max` — the effort is
    /// pinned to `low`: deep reasoning on a title is pure latency.
    pub async fn chat_simple(
        &self,
        messages: &[ChatMessage],
    ) -> Result<String, Box<dyn Error + Send + Sync>> {
        let url = format!("{}/chat/completions", self.base_url);

        let (reasoning_effort, thinking) = match self.wire_profile() {
            WireProfile::Glm => {
                let caps = crate::model_caps::model_caps(&self.model);
                (
                    // Only models that actually take the parameter (5.2+).
                    caps.effort_levels
                        .contains(&"low")
                        .then(|| "low".to_string()),
                    crate::model_caps::glm_accepts_thinking_field(&self.model).then(|| {
                        ThinkingConfig {
                            thinking_type: "enabled".to_string(),
                        }
                    }),
                )
            }
            _ => (None, None),
        };
        let request = ChatCompletionRequest {
            model: self.model.clone(),
            messages: self
                .resolve_wire_messages(self.prepare_messages_for_api(messages))
                .await,
            stream: false,
            tools: None,
            temperature: None,
            stream_options: None,
            reasoning_effort,
            thinking,
            // Titles/summaries are short; the server default cap is plenty.
            max_completion_tokens: None,
        };

        let response = self.send_chat_request(&url, &request, false).await?;

        let body: serde_json::Value = response.json().await?;
        let content = body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();
        Ok(content)
    }

    // ── 连接 / 首响应阶段的有限指数退避重试 ──
    //
    // 网络错误(TCP 重置、DNS 抖动、TLS 超时)和可重试状态码(429 限流、
    // 5xx 网关抖动)按指数退避重试;鉴权 / 参数类 4xx 重试无意义,直接
    // 失败。一旦状态码 2xx 就把就绪的 Response 交给上层进入流式 —— 流式
    // 阶段本身绝不回头重试(否则会重复输出已收到的 delta)。

    /// 连接 / 首响应阶段的最大请求次数(含首次)。
    const MAX_REQUEST_ATTEMPTS: u32 = 3;

    /// 一个可重试的 HTTP 状态码:429(限流)或 5xx(服务端 / 网关)。其余
    /// 4xx(鉴权、参数错误、not found)重试无意义。
    fn is_retryable_status(status: reqwest::StatusCode) -> bool {
        status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
    }

    /// A clone of this client with the reasoning effort dropped one level per
    /// the model's capability table, for retrying a request whose response was
    /// `length`-truncated mid-reasoning. `None` when the model has no effort
    /// parameter or is already at the lowest level (retry with the same
    /// parameters instead).
    pub fn with_reduced_effort(&self) -> Option<LlmClient> {
        let caps = crate::model_caps::model_caps(&self.model);
        if caps.effort_levels.is_empty() {
            return None;
        }
        // The level actually in effect: the wire value (configured, clamped)
        // or, when nothing is sent, the provider's server-side default.
        let current = self
            .reasoning_params()
            .0
            .or_else(|| caps.default_effort.map(str::to_string))?;
        let index = caps.effort_levels.iter().position(|l| *l == current)?;
        if index == 0 {
            return None;
        }
        let reduced = caps.effort_levels[index - 1];
        Some(
            self.clone()
                .with_reasoning_effort(Some(reduced.to_string())),
        )
    }

    /// 解析 `Retry-After` 响应头(只认秒数形式,clamp 到 30s 上限),缺失
    /// 或非法时回退 `fallback` 退避值。
    fn retry_after_or(&self, response: &reqwest::Response, fallback: Duration) -> Duration {
        if let Some(val) = response.headers().get("retry-after") {
            if let Ok(s) = val.to_str() {
                if let Ok(secs) = s.trim().parse::<u64>() {
                    return Duration::from_secs(secs).min(Duration::from_secs(30));
                }
            }
        }
        fallback
    }

    /// 发送一次 chat-completion 请求,对网络错误与 429/5xx 做有限指数退避
    /// 重试。返回的 Response 已通过状态码检查,可直接进入流式 / JSON 解析。
    /// `stream` 为 true 时设 `Accept: text/event-stream`(与历史行为一致)。
    async fn send_chat_request(
        &self,
        url: &str,
        request: &ChatCompletionRequest,
        stream: bool,
    ) -> Result<reqwest::Response, Box<dyn Error + Send + Sync>> {
        let mut backoff = Duration::from_secs(1);
        for attempt in 1..=Self::MAX_REQUEST_ATTEMPTS {
            let mut req_builder = self
                .client
                .post(url)
                .header("Content-Type", "application/json");
            if stream {
                req_builder = req_builder.header("Accept", "text/event-stream");
            }
            if !self.api_key.is_empty() {
                req_builder =
                    req_builder.header("Authorization", format!("Bearer {}", self.api_key));
            }

            match req_builder.json(request).send().await {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return Ok(response);
                    }
                    // 可重试且仍有余量 → 退避后重试。
                    if Self::is_retryable_status(status) && attempt < Self::MAX_REQUEST_ATTEMPTS {
                        let delay = self.retry_after_or(&response, backoff);
                        log::warn!(
                            "LLM API retryable error: status={} attempt={}/{}; retry in {:?}",
                            status,
                            attempt,
                            Self::MAX_REQUEST_ATTEMPTS,
                            delay
                        );
                        drop(response);
                        wasmtimer::tokio::sleep(delay).await;
                        backoff = (backoff * 2).min(Duration::from_secs(8));
                        continue;
                    }
                    // 不可重试(4xx)或重试用尽 → 读 body 报错。
                    let body = response.text().await.unwrap_or_default();
                    log::error!(
                        "LLM API error: status={} body={}",
                        status,
                        log_truncate(&body, 500)
                    );
                    return Err(format!("LLM API error: {} {}", status, body).into());
                }
                Err(e) => {
                    if attempt < Self::MAX_REQUEST_ATTEMPTS {
                        log::warn!(
                            "LLM request network error (attempt {}/{}): {}; retry in {:?}",
                            attempt,
                            Self::MAX_REQUEST_ATTEMPTS,
                            e,
                            backoff
                        );
                        wasmtimer::tokio::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(8));
                        continue;
                    }
                    log::error!(
                        "LLM request failed after {} attempts: {}",
                        Self::MAX_REQUEST_ATTEMPTS,
                        e
                    );
                    return Err(e.into());
                }
            }
        }
        // 每次迭代必然 return;此处为防御性兜底。
        Err("LLM request: retry loop exited unexpectedly".into())
    }
}

#[derive(Default)]
struct ToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

/// Largest char boundary `<= max` (stable replacement for the unstable
/// `str::floor_char_boundary`).
fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut idx = max;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

pub(crate) fn log_truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let end = floor_char_boundary(s, max);
        format!("{}...", &s[..end])
    }
}

fn last_user_msg_preview(messages: &[ChatMessage], max: usize) -> String {
    messages
        .iter()
        .rev()
        .find(|m| matches!(m.role, Role::User))
        .and_then(|m| m.content.as_ref())
        .map(|c| log_truncate(c, max))
        .unwrap_or_else(|| "(none)".to_string())
}

/// Whether a chat-request error is an HTTP 400 (invalid request). Matches the
/// error string `send_chat_request` builds (`"LLM API error: <status> <body>"`).
///
/// Deliberately does NOT look for the field name in the body: providers reject
/// with localized or empty messages, so any 400 while `max_completion_tokens`
/// is on the wire earns the one-shot retry without it — an unrelated 400 fails
/// again identically on the retry, and only a retry that SUCCEEDS latches the
/// field off. Other statuses (401/404/429/5xx) are never about this field.
fn is_bad_request_error(error: &str) -> bool {
    error.starts_with("LLM API error: 400")
}

/// Append `chunk` to `buf` and drain every complete `\n`-terminated line,
/// decoding each as UTF-8 (with surrounding whitespace trimmed). Byte-level
/// buffering ensures a multi-byte UTF-8 char split across chunks is intact.
pub(crate) fn drain_sse_lines(buf: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buf.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        lines.push(
            String::from_utf8_lossy(&line[..line.len() - 1])
                .trim()
                .to_string(),
        );
    }
    lines
}
