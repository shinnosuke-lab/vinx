//! Model capability table — the single source of truth for "what can this
//! model do", keyed on the model name.
//!
//! Consolidates the per-model knowledge that used to live in scattered
//! heuristics: vision input ([`crate::client::model_supports_vision`]),
//! context window ([`crate::context::model_context_tokens`]), thinking-mode
//! support, and the selectable `reasoning_effort` levels. Consumed by:
//!
//! - [`crate::client`]'s wire profiles (effort clamping, whether to send the
//!   `thinking` field),
//! - `GET /api/models` (the web chat's effort switcher reads `caps` per model),
//! - the TUI `/effort` picker.
//!
//! Data verified against the official provider docs (2026-08):
//! docs.bigmodel.cn (GLM), platform.kimi.com (Kimi), api-docs.deepseek.com
//! (DeepSeek). `vision`/`context_tokens` are name-based heuristics only — the
//! config-level `vision` override is NOT applied here; runtime gating stays on
//! `LlmClient::supports_vision()`.

use serde::Serialize;

/// Thinking-mode (chain-of-thought) support of a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Thinking {
    /// Always reasons; thinking cannot be disabled (glm-5.3, kimi-k3, glm-4.7).
    Forced,
    /// Reasons on demand / can be toggled via the `thinking` field or is on by
    /// default server-side (glm-5.2/5.x/4.5+, deepseek v4, kimi-k2.6).
    Dynamic,
    /// Nothing known about the model's thinking behavior.
    Unknown,
}

/// Capability record for one model name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCaps {
    /// Accepts image input (name heuristic; config override not applied).
    pub vision: bool,
    /// Context window in tokens (name heuristic).
    pub context_tokens: usize,
    pub thinking: Thinking,
    /// `reasoning_effort` values the provider accepts on this model. Empty =
    /// the parameter is unsupported / unknown (effort selectors stay hidden;
    /// the wire layer clamps configured values away for KNOWN families).
    pub effort_levels: &'static [&'static str],
    /// The provider's server-side default effort (informational).
    pub default_effort: Option<&'static str>,
    /// `max_completion_tokens` to send explicitly, `None` = don't send (the
    /// server default stays in charge). Pinned only where the server default
    /// is known to be harmfully low: the Kimi coding endpoint caps responses
    /// at 32K unless raised, and K3's max-effort reasoning alone can exhaust
    /// that (reasoning tokens count against the cap). Values a provider
    /// rejects are handled at the wire layer (drop + retry once).
    pub max_completion_tokens: Option<u32>,
}

const LOW_HIGH_MAX: &[&str] = &["low", "high", "max"];

/// K3: official platform default (docs allow up to 1,048,576). Sent explicitly
/// because the coding subscription endpoint (`api.kimi.com/coding/v1`)
/// otherwise defaults to a 32K cap that long reasoning exhausts mid-response.
const K3_MAX_COMPLETION_TOKENS: u32 = 131_072;

/// Whether the model belongs to a family whose `reasoning_effort` rules we
/// know (GLM / Kimi / DeepSeek). For these, a configured effort outside the
/// model's accepted list is clamped instead of passed through.
pub(crate) fn known_family(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    crate::client::is_glm(&m)
        || m.contains("kimi")
        || crate::client::is_kimi_k3(&m)
        || m.contains("deepseek")
}

/// Whether a GLM model accepts the `thinking={type:...}` request field:
/// only 4.5 and above do (official docs); older GLM rejects the field.
/// GLM-specific on purpose — DeepSeek's thinking field is decided by the
/// WIRE PROFILE in `client.rs` (base_url counts there, not just the model
/// name), and Kimi K3 never takes the field (top-level effort only).
pub(crate) fn glm_accepts_thinking_field(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    crate::client::is_glm(&m) && glm_version(&m).is_some_and(|v| v >= (4, 5))
}

/// Parse the `(major, minor)` version out of a GLM model name: `glm-5.3` →
/// (5,3), `glm-5-turbo` → (5,0), `glm-4.6v` → (4,6). `None` when no version
/// digit follows a `glm` token (e.g. bare `glm`).
fn glm_version(lower: &str) -> Option<(u32, u32)> {
    let idx = lower.find("glm")?;
    let rest = &lower[idx + 3..];
    let rest = rest.trim_start_matches(['-', '_', ' ']);
    let major: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if major.is_empty() {
        return None;
    }
    let after = &rest[major.len()..];
    let minor: String = after
        .strip_prefix('.')
        .map(|a| a.chars().take_while(|c| c.is_ascii_digit()).collect())
        .unwrap_or_default();
    Some((major.parse().ok()?, minor.parse().unwrap_or(0)))
}

/// Capability lookup for a model name. Unknown names get a conservative
/// record (no thinking knowledge, no effort levels) — the wire layer then
/// passes configured values through verbatim, trusting the operator.
pub fn model_caps(model: &str) -> ModelCaps {
    let m = model.to_ascii_lowercase();
    let vision = crate::client::model_supports_vision(model);
    let context_tokens = crate::context::model_context_tokens(model);

    let (thinking, effort_levels, default_effort): (
        Thinking,
        &'static [&'static str],
        Option<&'static str>,
    ) = if crate::client::is_glm(&m) {
        match glm_version(&m) {
            // glm-5.3+: forced thinking, low/high/max (other values error).
            Some(v) if v >= (5, 3) => (Thinking::Forced, LOW_HIGH_MAX, Some("max")),
            // glm-5.2: dynamic thinking; accepts low/high/max (server maps
            // low→high, xhigh→max; none/minimal disable thinking).
            Some((5, 2)) => (Thinking::Dynamic, LOW_HIGH_MAX, Some("max")),
            // glm-5.1 / glm-5 / glm-5-turbo: reasoning_effort unsupported
            // (only GLM-5.2 and above take the parameter).
            Some(v) if v >= (5, 0) => (Thinking::Dynamic, &[], None),
            // glm-4.7 / glm-4.5V force thinking; 4.5/4.6 are dynamic.
            Some((4, 7)) => (Thinking::Forced, &[], None),
            Some(v) if v >= (4, 5) => {
                if vision && v == (4, 5) {
                    // glm-4.5V forces thinking (unlike text glm-4.5).
                    (Thinking::Forced, &[], None)
                } else {
                    (Thinking::Dynamic, &[], None)
                }
            }
            // Older GLM (< 4.5): no thinking field support at all.
            _ => (Thinking::Unknown, &[], None),
        }
    } else if crate::client::is_kimi_k3(&m) {
        // K3 always reasons; top-level reasoning_effort low/high/max.
        (Thinking::Forced, LOW_HIGH_MAX, Some("max"))
    } else if m.contains("kimi") {
        // K2.x: thinking toggle exists but reasoning_effort is unsupported.
        (Thinking::Dynamic, &[], None)
    } else if m.contains("deepseek") {
        // v4: thinking on by default; effort low/high/max, default high
        // (medium/xhigh are server-mapped to high).
        (Thinking::Dynamic, LOW_HIGH_MAX, Some("high"))
    } else {
        (Thinking::Unknown, &[], None)
    };

    let max_completion_tokens = crate::client::is_kimi_k3(&m).then_some(K3_MAX_COMPLETION_TOKENS);

    ModelCaps {
        vision,
        context_tokens,
        thinking,
        effort_levels,
        default_effort,
        max_completion_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glm_family_caps_match_official_docs() {
        let g53 = model_caps("glm-5.3");
        assert_eq!(g53.thinking, Thinking::Forced);
        assert_eq!(g53.effort_levels, LOW_HIGH_MAX);
        assert_eq!(g53.default_effort, Some("max"));
        assert_eq!(g53.context_tokens, 1_000_000);
        assert!(!g53.vision);

        let g52 = model_caps("glm-5.2");
        assert_eq!(g52.thinking, Thinking::Dynamic);
        assert_eq!(g52.effort_levels, LOW_HIGH_MAX);

        // reasoning_effort is 5.2+ only.
        for m in ["glm-5.1", "glm-5", "glm-5-turbo"] {
            let caps = model_caps(m);
            assert!(caps.effort_levels.is_empty(), "{m}");
            assert_eq!(caps.thinking, Thinking::Dynamic, "{m}");
        }

        assert_eq!(model_caps("glm-4.7").thinking, Thinking::Forced);
        assert_eq!(model_caps("glm-4.6").thinking, Thinking::Dynamic);
        assert_eq!(model_caps("glm-4.5").thinking, Thinking::Dynamic);
        // Pre-4.5 GLM knows nothing about thinking.
        assert_eq!(model_caps("glm-4-flash").thinking, Thinking::Unknown);
    }

    #[test]
    fn glm_thinking_field_is_45_plus_only() {
        assert!(glm_accepts_thinking_field("glm-5.3"));
        assert!(glm_accepts_thinking_field("glm-4.5"));
        assert!(glm_accepts_thinking_field("glm-4.6v"));
        assert!(!glm_accepts_thinking_field("glm-4-flash"));
        assert!(!glm_accepts_thinking_field("glm-3-turbo"));
        // Non-GLM families are out of scope here: DeepSeek's thinking field
        // is a wire-profile decision (client.rs), Kimi never takes it.
        assert!(!glm_accepts_thinking_field("deepseek-v4-pro"));
        assert!(!glm_accepts_thinking_field("kimi-k3"));
        assert!(!glm_accepts_thinking_field("gpt-5.2"));
    }

    #[test]
    fn kimi_and_deepseek_caps_match_official_docs() {
        let k3 = model_caps("kimi-k3");
        assert_eq!(k3.thinking, Thinking::Forced);
        assert_eq!(k3.effort_levels, LOW_HIGH_MAX);
        assert_eq!(k3.default_effort, Some("max"));
        assert_eq!(k3.context_tokens, 1_000_000);

        // K2.x has no reasoning_effort parameter.
        assert!(model_caps("kimi-k2.6").effort_levels.is_empty());
        assert!(model_caps("kimi-k2.7-code").effort_levels.is_empty());

        let ds = model_caps("deepseek-v4-pro");
        assert_eq!(ds.effort_levels, LOW_HIGH_MAX);
        assert_eq!(ds.default_effort, Some("high"));
    }

    #[test]
    fn max_completion_tokens_pinned_for_k3_only() {
        // K3 (any alias): sent explicitly to override the coding endpoint's
        // 32K server default.
        for m in ["kimi-k3", "k3", "kimi-k3-turbo"] {
            assert_eq!(model_caps(m).max_completion_tokens, Some(131_072), "{m}");
        }
        // Everyone else keeps the server default (nothing sent).
        for m in ["kimi-k2.6", "glm-5.3", "deepseek-v4-pro", "gpt-5.2"] {
            assert_eq!(model_caps(m).max_completion_tokens, None, "{m}");
        }
    }

    #[test]
    fn unknown_models_get_conservative_caps() {
        let caps = model_caps("gpt-5.2");
        assert_eq!(caps.thinking, Thinking::Unknown);
        assert!(caps.effort_levels.is_empty());
        assert_eq!(caps.default_effort, None);
    }

    #[test]
    fn glm_version_parses_variants() {
        assert_eq!(glm_version("glm-5.3"), Some((5, 3)));
        assert_eq!(glm_version("glm-5-turbo"), Some((5, 0)));
        assert_eq!(glm_version("glm-4.6v"), Some((4, 6)));
        assert_eq!(glm_version("z-ai/glm-5.3"), Some((5, 3)));
        assert_eq!(glm_version("glm"), None);
    }
}
