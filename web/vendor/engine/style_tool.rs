//! `set_chat_style` — easter-egg tool that lets the model restyle the chat web
//! UI by emitting LLM-authored CSS and (optionally) JavaScript.
//!
//! The tool validates the payload and forwards it as an
//! [`AgentEvent::ApplyChatStyle`]; the web frontend injects the CSS into a
//! singleton `<style>` tag and runs the JS in page context (see
//! `ui/src/lib/llm-style.ts`). By default nothing is persisted: the look lives
//! for the current page only and a refresh restores the default, which is also
//! the hard escape hatch. Non-web channels (TUI) ignore the event.
//!
//! With `persist: true` the payload ALSO lands in the `theme` UI plugin
//! (`<data_dir>/themes/default/`, see [`crate::releases`]): the frontend
//! re-applies it on every boot until it is removed (empty persist, the Apps
//! page card, or `rm -rf` over SSH). `?notheme=1` skips injection entirely —
//! the escape hatch when a bad persisted style locks the page; the persist
//! receipt tells the model to mention it.
//!
//! A look may also ship binary assets (`assets`: background photos, textures,
//! fonts). They are copied INTO the theme package — `<themes>/<name>/assets/`,
//! or the `.preview` overlay for a page-only look — and served at the fixed
//! `/theme/assets/<name>` mount point, so the css/js reference real, stable
//! URLs and nothing needs rewriting before injection (see
//! [`crate::releases::resolve_theme_asset`]).
//!
//! The model gets no visual feedback, so the tool description carries the whole
//! "style API": the palette-first design method, the full semantic-variable
//! set, stable `data-acc` selectors, the `egg` JS runtime contract and the
//! full-replacement semantics. Quality of the easter egg is tuned by editing
//! that description, not code.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use crate::event::AgentEvent;
use crate::os::{self, OsPolicy};
use crate::tool::{Tool, ToolContext};
use crate::types::{RiskLevel, ToolDefinition, ToolParameter, ToolParameters, ToolResult};

/// Hard cap on the combined payload (css + js). Generous for a hand-written
/// theme with effects, small enough to stop a runaway generation from flooding
/// the SSE channel.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// Everything the model needs to produce a coherent look for this UI, in one
/// place. Sent with every request, so no prose padding: method, full variable
/// list, selectors, JS contract, one compact example.
const DESCRIPTION: &str = "\
Easter egg: restyle the chat web UI live with custom CSS and optional JavaScript (current page \
only; a refresh restores the default look). Use it when the user asks to change the UI's style, \
theme, colors, layout or mood, or wants visual effects ('cyberpunk style', 'make everything \
dance', 'let's celebrate'). Go bold — deliver one complete, coherent look per call; you get no \
visual feedback, so don't probe with tiny tweaks.

SEMANTICS: each call REPLACES the previous css AND js entirely (the previous script's cleanups \
run first, its layer nodes are removed). For incremental changes resend the full payload \
including everything that should survive. Empty css+js resets to the default look (use it when \
the user asks to restore).

DESIGN METHOD — follow strictly, this is what makes the result look designed instead of patched:
1. Palette first: pick one base hue, one accent hue and a lightness ramp; declare them as tokens \
on .acc-root (e.g. --egg-h:265; --egg-a:190;).
2. Derive ALL semantic variables from those tokens via hsl() — never scatter ad-hoc colors. \
Override the FULL set, each WITH !important (brand colors are inline styles and win otherwise; \
any variable you skip keeps its default and looks broken): --color-background/-foreground, \
--color-primary/-primary-foreground, --color-secondary/-secondary-foreground, \
--color-muted/-muted-foreground, --color-accent/-accent-foreground, --color-card/-card-foreground, \
--color-popover/-popover-foreground, --color-border, --color-input, --color-ring, \
--color-sidebar, --color-sidebar-foreground, --color-sidebar-border, --color-sidebar-accent, \
--color-sidebar-muted. Optional: --color-destructive/-success/-warning (+ -foreground pairs), \
--radius-sm/-md/-lg/-xl, --font-sans/-mono.
3. Contrast: every bg/fg pair must stay readable; --color-muted-foreground must be legible on \
both background and muted. One .acc-root{} block with !important covers light and dark mode.

SELECTORS: `.acc-root` = app root. `data-acc` anchors (combine freely with descendant / \
:nth-child): nav-rail (left sidebar), brand-logo (logo at sidebar top), new-chat-btn, nav-btn \
(sidebar nav buttons), about-btn (round avatar/logo button at sidebar bottom-left), main-view \
(main content; its background is the gutter beside the centered column), msg-user (user bubbles), \
msg-assistant (assistant message row — NO default background), msg-assistant-body (the assistant's \
markdown content; style THIS to give assistant replies a card), reasoning-block (collapsible \
'thinking' row), chat-input (the input FRAME — border/background live here; the textarea inside \
is transparent), send-btn, tool-block (tool-call cards), fx-layer (invisible full-screen overlay, \
pointer-events:none — target its ::before/::after, or append JS-created canvases/nodes to it).

SURFACES (know the defaults so you neither leave gaps nor fight them): assistant replies have NO \
card by default — put background/border/padding on [data-acc=msg-assistant-body] to make them \
cards. reasoning-block is a compact collapsible row (a left border + muted label); tool-block is \
a collapsible card (rounded border, muted header row with chevron + status icon, white body); \
give them a matching accent so they don't read as second-class beside the reply cards. \
Whenever you give a block a visible background or border, use SYMMETRIC horizontal padding — the \
transcript's default insets are left-only, so a one-sided pad makes content hug the right edge. \
Style the chat-input FRAME (border/background go there); never border the textarea inside it, or \
you get a box-in-box. Code blocks, inline code and table headers derive from var(--color-muted) / \
var(--color-foreground), so overriding those variables reskins them automatically. The strip \
beside the centered chat column is main-view's background (= --color-background unless you style \
[data-acc=main-view]). Shell/terminal tool cards keep a fixed dark palette on purpose; recolor \
them via [data-acc=tool-block] descendants only if the theme needs it.

CSS RULES: animate only transform/opacity (never box-shadow, size or filter). Celebration \
effects: finite iteration count + animation-fill-mode:forwards; only persistent themes may loop. \
Add a `transition` on colors for a smooth switch. @import is stripped, and so is every url(...) \
except an inline data: URI.

JS (optional, for what CSS can't do: canvas particles, physics, choreography). Runs in the page \
with full DOM access as `(egg) => { <your code> }`. API: egg.root = the .acc-root element; \
egg.layer = the fx-layer div (append your canvases/nodes HERE — it is cleared on replace/reset); \
egg.onCleanup(fn) = REQUIRED registration for everything you start (rAF loops, intervals, \
listeners, nodes added outside egg.layer) so the next call or a reset can undo it. Rules: drive \
animation with requestAnimationFrame; celebration effects must self-stop after ~8-15s; don't \
intercept the app's keyboard/mouse input; don't fetch or touch storage.

EXAMPLE (a COMPLETE required set — never abbreviate yours):
css: \".acc-root{--egg-h:265;--egg-a:190;\
--color-background:hsl(var(--egg-h) 45% 8%) !important;--color-foreground:hsl(var(--egg-h) 25% \
92%) !important;--color-primary:hsl(var(--egg-a) 95% 55%) !important;--color-primary-foreground:\
hsl(var(--egg-h) 45% 8%) !important;--color-secondary:hsl(var(--egg-h) 35% 16%) !important;\
--color-secondary-foreground:hsl(var(--egg-h) 25% 92%) !important;--color-muted:hsl(var(--egg-h) \
35% 16%) !important;--color-muted-foreground:hsl(var(--egg-h) 15% 70%) !important;--color-accent:\
hsl(var(--egg-a) 60% 30%) !important;--color-accent-foreground:hsl(var(--egg-h) 25% 92%) \
!important;--color-card:hsl(var(--egg-h) 40% 12%) !important;--color-card-foreground:hsl(\
var(--egg-h) 25% 92%) !important;--color-popover:hsl(var(--egg-h) 40% 12%) !important;\
--color-popover-foreground:hsl(var(--egg-h) 25% 92%) !important;--color-border:hsl(var(--egg-h) \
30% 24%) !important;--color-input:hsl(var(--egg-h) 30% 24%) !important;--color-ring:hsl(\
var(--egg-a) 95% 55%) !important;--color-sidebar:hsl(var(--egg-h) 50% 6%) !important;\
--color-sidebar-foreground:hsl(var(--egg-h) 25% 92%) !important;--color-sidebar-border:hsl(\
var(--egg-h) 30% 24%) !important;--color-sidebar-accent:hsl(var(--egg-a) 95% 55%) !important;\
--color-sidebar-muted:hsl(var(--egg-h) 15% 70%) !important;transition:background-color .5s,color \
.5s}.acc-root [data-acc=msg-assistant-body]{background:var(--color-card);border:1px solid \
var(--color-border);border-radius:var(--radius-lg);padding:.75rem 1rem}\"
js: \"const c=Object.assign(document.createElement('canvas'),{width:innerWidth,height:\
innerHeight});egg.layer.appendChild(c);const x=c.getContext('2d');const P=Array.from({length:80},\
()=>({x:Math.random()*c.width,y:Math.random()*-c.height,v:1+2*Math.random()}));let raf;const t0=\
performance.now();(function step(t){x.clearRect(0,0,c.width,c.height);for(const p of P){p.y=(p.y+\
p.v)%c.height;x.fillStyle=`hsl(${(t/20+p.x)%360} 90% 60%)`;x.fillRect(p.x,p.y,3,3)}if(t-t0<12000)\
raf=requestAnimationFrame(step);else x.clearRect(0,0,c.width,c.height)})(t0);\
egg.onCleanup(()=>cancelAnimationFrame(raf))\"

After applying, briefly tell the user they can say 'restore the default style' (or refresh the \
page) to undo.

NAMING: always pass a short human `name` for the look you create (e.g. 'Cyberpunk Neon') — it \
pre-fills the user's 'save this theme' button and names a persisted theme; without it the save \
button falls back to an ugly timestamp.

PERSISTENCE: by default the look is page-only (refresh restores the default). Set persist:true \
ONLY when the user asks to keep the theme ('save this theme', 'use this from now on'): the \
payload is stored under the `name` slot (default 'default') and becomes the ACTIVE theme, \
re-applied on every page load. Saving under a NEW name keeps previously saved themes intact so \
the user can switch between them (Apps/Releases page). persist:true with empty css+js deletes \
that named slot (use when the user wants it gone). Saved themes appear in list_releases as \
kind 'theme'. When the user asks to KEEP a look you \
ALREADY applied this turn, resend the exact css and js from that call byte-for-byte — do not \
regenerate or tweak them: an identical payload re-applies as a silent no-op, while any change \
re-renders the page and interrupts running effects. (The web UI also shows a 'save this theme' \
button on the applied-style card, so the user can persist the current look without asking you.)";

/// Appended to [`DESCRIPTION`] only where assets can actually be installed (a
/// deployment without a data dir has nowhere to put them, and must not be told
/// about a parameter it does not advertise — including the `/theme/assets/`
/// exception to the url() rule, which is why [`DESCRIPTION`] does not mention
/// it).
const ASSETS_DOC: &str = "\
ASSETS — images and fonts that ship WITH the look. Pass the files in `assets` and reference them \
in css/js at /theme/assets/<name> — the one url() form besides data: that survives sanitizing — \
e.g. assets:[{\"path\":\"/root/runtime/uploads/8f3c….jpg\",\
\"name\":\"hero.jpg\"}] with css `background-image:url(/theme/assets/hero.jpg)` (same string works \
in js). That URL always serves the look currently applied, so it survives saving, renaming and \
switching themes — never build a URL from the theme name, and never `publish` a theme image. Use \
it for a picture the user uploaded (their message lists the file's disk path) or a file you wrote \
with write_file; for tiny decorations prefer an inline data: URI. Like css and js, `assets` \
REPLACES the previous set, so resend every file the look still needs — or omit the parameter \
entirely to keep the assets already in effect (that is what makes persisting a look you just \
applied safe). When you swap in a DIFFERENT image, give it a new name: a browser that already \
painted /theme/assets/hero.jpg will not repaint it just because the bytes changed.";

/// The `set_chat_style` tool. Stateless for the page-only easter egg; with
/// `persist: true` it writes the default saved theme under `themes_dir`.
pub struct SetChatStyleTool {
    /// `<data_dir>/themes`; `None` disables persistence (persist:true
    /// then fails in-band) AND assets (nowhere to put them).
    themes_dir: Option<PathBuf>,
    /// Read policy for `assets` sources — the same one the OS tools enforce, so
    /// a theme can only be built from files the agent may already read.
    /// `None` = no assets parameter is advertised.
    policy: Option<Arc<OsPolicy>>,
    /// Bare-filename asset sources resolve here (see [`os::resolve_in_drafts`]).
    drafts_dir: Option<PathBuf>,
}

impl SetChatStyleTool {
    pub fn new(themes_dir: Option<PathBuf>) -> Self {
        Self {
            themes_dir,
            policy: None,
            drafts_dir: None,
        }
    }

    /// Enable the `assets` parameter: copying a file into a theme is a read of
    /// that file, so it takes the OS read policy (and the drafts bucket for the
    /// bare-filename convention). Both travel together — assets are all-or-
    /// nothing, never half-configured.
    pub fn with_assets(mut self, policy: Arc<OsPolicy>, drafts_dir: Option<PathBuf>) -> Self {
        self.policy = Some(policy);
        self.drafts_dir = drafts_dir;
        self
    }

    /// Assets are only offered when a themes dir AND a read policy exist.
    fn assets_enabled(&self) -> bool {
        self.themes_dir.is_some() && self.policy.is_some()
    }

    /// Turn the `assets` argument into `(source file, served name)` pairs,
    /// validating everything BEFORE anything is written: a bad path must leave
    /// the current look untouched. An element is either a path string or
    /// `{path, name}` — uploads are named after a uuid, so renaming to
    /// `hero.jpg` is what makes the css readable.
    ///
    /// `None` = the argument was omitted, which means "keep the current look's
    /// assets" (distinct from `[]` = drop them). Omission is the common shape of
    /// a re-send — the model resending css/js byte-for-byte to persist a look it
    /// just applied — and wiping the images there would break the very look it
    /// is trying to keep.
    fn resolve_assets(
        &self,
        args: &serde_json::Value,
    ) -> Result<Option<Vec<(PathBuf, String)>>, String> {
        let value = match args.get("assets") {
            None | Some(serde_json::Value::Null) => return Ok(None),
            Some(v) => v,
        };
        let Some(list) = value.as_array() else {
            return Err("Error: assets must be an array of {path, name} entries.".into());
        };
        if list.is_empty() {
            return Ok(Some(Vec::new()));
        }
        let Some(policy) = self.policy.as_ref().filter(|_| self.themes_dir.is_some()) else {
            return Err("Error: theme assets are unavailable on this deployment. Use inline \
                        data: URIs or a CSS-only look."
                .into());
        };
        let mut out = Vec::with_capacity(list.len());
        for item in list {
            let (path, rename) = match item {
                serde_json::Value::String(s) => (s.trim(), None),
                serde_json::Value::Object(_) => (
                    item.get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim(),
                    item.get("name")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty()),
                ),
                _ => return Err("Error: each assets entry must be a path or {path, name}.".into()),
            };
            if path.is_empty() {
                return Err("Error: an assets entry has an empty path.".into());
            }
            let source = os::resolve_in_drafts(self.drafts_dir.as_deref(), path);
            let resolved = policy.check_read(&source)?;
            if !resolved.is_file() {
                return Err(format!("Error: asset is not a file: {path}"));
            }
            let name = match rename {
                Some(n) => n.to_string(),
                None => resolved
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            };
            if !crate::releases::is_safe_public_name(&name) {
                return Err(format!(
                    "Error: `{name}` cannot be served as a theme asset (needs one plain file \
                     name, no directories or leading dot). Pass {{path, name}} to rename it."
                ));
            }
            out.push((resolved, name));
        }
        Ok(Some(out))
    }
}

#[async_trait]
impl Tool for SetChatStyleTool {
    fn definition(&self) -> ToolDefinition {
        let mut properties = HashMap::from([
            (
                        "css".into(),
                        ToolParameter::string(
                            "Complete CSS stylesheet to inject (replaces the previous one). \
                             Empty string resets the styling.",
                        ),
                    ),
                    (
                        "js".into(),
                        ToolParameter::string(
                            "Optional JavaScript effect script, executed as (egg) => { ... } \
                             after the previous script is cleaned up. Omit or empty for \
                             CSS-only looks.",
                        ),
                    ),
                    (
                        "persist".into(),
                        ToolParameter::boolean(
                            "Save as the persistent theme (re-applied on every page load) — \
                             only when the user asks to keep it. persist with empty css+js \
                             deletes the saved theme. Default false: current page only.",
                        )
                        .with_default(serde_json::json!(false)),
                    ),
                    (
                        "name".into(),
                        ToolParameter::string(
                            "ALWAYS provide: a short, human-friendly name for this look (2-4 \
                             words, e.g. 'Cyberpunk Neon' or 'Ocean Calm'). It pre-fills the \
                             user's 'save this theme' button, and on persist:true it is the \
                             saved theme's slot/label (saving activates it; a new name keeps \
                             other saved themes for switching; omitting it on persist uses the \
                             'default' slot). 'active' is reserved.",
                        ),
                    ),
                    (
                        "description".into(),
                        ToolParameter::string(
                            "Persist-only: a short one-line label for the saved theme (e.g. \
                             'Midnight violet, cyan accents'). Ignored unless persist:true.",
                        ),
                    ),
                    (
                        "palette".into(),
                        ToolParameter::array_of(
                            "Persist-only: 3-5 representative colors of this theme as hex \
                             strings (e.g. ['#1a1230','#b48cff','#22d3ee']) for a swatch \
                             preview — report the final rendered colors, since the CSS uses \
                             indirected hsl(var(--egg-h) …) tokens. Ignored unless persist:true.",
                            ToolParameter::string("hex color, e.g. #b48cff"),
                        ),
                    ),
                ]);
        if self.assets_enabled() {
            properties.insert(
                "assets".into(),
                ToolParameter::array_of(
                    "Optional image/font files to ship WITH this look (background photos, \
                     textures, logos — e.g. a picture the user just uploaded). Reference each \
                     one in css/js as /theme/assets/<name>, a fixed URL that keeps working \
                     after the theme is saved, renamed or switched. Like css and js this \
                     REPLACES the previous assets, so resend every file the look still needs. \
                     Max 10MB per file, 30MB per theme; for tiny decorations prefer an inline \
                     data: URI.",
                    ToolParameter::object(
                        "One file to install into the theme",
                        HashMap::from([
                            (
                                "path".into(),
                                ToolParameter::string(
                                    "Readable file to copy: an uploaded attachment's disk path, \
                                     any absolute path, or a bare filename (= a write_file \
                                     draft).",
                                ),
                            ),
                            (
                                "name".into(),
                                ToolParameter::string(
                                    "File name to serve it under, e.g. 'hero.jpg' — ALWAYS set \
                                     it for uploads (their names are uuids). Defaults to the \
                                     source file's own name.",
                                ),
                            ),
                        ]),
                        vec!["path".into()],
                    ),
                ),
            );
        }
        let description = if self.assets_enabled() {
            format!("{DESCRIPTION}\n\n{ASSETS_DOC}")
        } else {
            DESCRIPTION.to_string()
        };
        ToolDefinition::new(
            "set_chat_style",
            &description,
            ToolParameters::object(properties, vec!["css".into()]),
        )
    }

    fn risk(&self, args: &serde_json::Value) -> RiskLevel {
        // The page-only easter egg stays frictionless (a refresh undoes it),
        // but persisting = the look re-applies on every load for every future
        // visit — a durable exposure, so it takes the confirmation gate like
        // publish/run_app. trust_all / session auto-confirm skip it as usual
        // (the loop decides; this is only the classification).
        //
        // `assets` deliberately does NOT raise the level, even though copying a
        // file to the mount point exposes it over unauthenticated HTTP the way
        // `publish` does: a look is built from what the conversation already
        // handed the agent, page-only assets die with the overlay on the next
        // reload, and gating every skin-with-a-picture behind a dialog would
        // cost more than it protects here. A decision, not an oversight.
        if args
            .get("persist")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            RiskLevel::Dangerous
        } else {
            RiskLevel::Safe
        }
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolResult {
        let css = args.get("css").and_then(|v| v.as_str()).unwrap_or("");
        let js = args.get("js").and_then(|v| v.as_str()).unwrap_or("");
        let persist = args
            .get("persist")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let description = args.get("description").and_then(|v| v.as_str());
        // Theme name (persist-only): the slot to save/replace/delete. Empty or
        // absent means the `default` slot (the "save this look" convention).
        let theme_name = args
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("default");
        // Palette: accept an array of hex strings; keep the first 5, trimmed.
        let palette: Vec<String> = args
            .get("palette")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .take(5)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        // Resolved (and fully validated) before anything is written: a bad
        // asset path must fail the call with the current look untouched.
        let assets = match self.resolve_assets(&args) {
            Ok(a) => a,
            Err(e) => return ToolResult::text(e).with_success(false),
        };

        if css.len() + js.len() > MAX_PAYLOAD_BYTES {
            return ToolResult::text(format!(
                "Error: payload too large ({} bytes css + {} bytes js; max {} combined). Send a \
                 tighter theme.",
                css.len(),
                js.len(),
                MAX_PAYLOAD_BYTES
            ))
            .with_success(false);
        }

        let is_reset = css.trim().is_empty() && js.trim().is_empty();

        // Persistence first: a failed write must not leave the user believing
        // the theme was saved (the live apply below still happens either way).
        let mut persist_note = String::new();
        if persist {
            let Some(root) = &self.themes_dir else {
                return ToolResult::text(
                    "Error: theme persistence is unavailable on this deployment \
                     (no data dir). The style can still be applied for the \
                     current page by calling again without persist.",
                )
                .with_success(false);
            };
            if is_reset {
                match crate::releases::remove_theme(root, theme_name) {
                    Ok(true) => {
                        crate::releases::clear_active_theme_if(root, theme_name);
                        persist_note = " The saved theme was deleted.".into()
                    }
                    Ok(false) => persist_note = " No saved theme existed.".into(),
                    Err(e) => {
                        return ToolResult::text(format!(
                            "Error: could not delete the saved theme: {e}"
                        ))
                        .with_success(false)
                    }
                }
                crate::releases::clear_preview(root);
            } else {
                // Assets go in before the payload: `write_theme` counts what is
                // on disk for the releases card. Omitted assets adopt the look
                // currently in effect (the same thing the "save this theme"
                // button does), so persisting a look you just applied keeps its
                // images without re-sending them.
                let installed = match &assets {
                    Some(list) => crate::releases::set_theme_assets(root, theme_name, list),
                    None => crate::releases::adopt_assets_into(root, theme_name),
                };
                if let Err(e) = installed {
                    return ToolResult::text(format!("Error: could not install the assets: {e}"))
                        .with_success(false);
                }
                if let Err(e) = crate::releases::write_theme(
                    root,
                    theme_name,
                    css,
                    js,
                    ctx.session_id(),
                    description,
                    &palette,
                ) {
                    return ToolResult::text(format!("Error: could not save the theme: {e}"))
                        .with_success(false);
                }
                // Persist == activate: the kept look is the one that re-applies
                // on the next load.
                let _ = crate::releases::set_active_theme(root, theme_name);
                // The saved theme is now the look in effect; a leftover overlay
                // would shadow its assets at the mount point.
                crate::releases::clear_preview(root);
                persist_note = " Saved as the persistent theme: it re-applies on every page \
                                load. Tell the user it can be removed from the Apps page, by \
                                asking to restore the default permanently, or bypassed by \
                                opening the app with ?notheme=1 if the page ever misbehaves."
                    .into();
            }
        } else if let Some(root) = &self.themes_dir {
            // Page-only look: its assets live in the preview overlay, which the
            // mount point prefers over the active theme and which is dropped on
            // the next reload. A reset means "no look", so no assets either.
            let staged = if is_reset {
                crate::releases::clear_preview(root);
                Ok(0)
            } else {
                match &assets {
                    Some(list) => crate::releases::set_preview_assets(root, list),
                    // Omitted: keep whatever the look in effect already serves.
                    None => Ok(0),
                }
            };
            if let Err(e) = staged {
                return ToolResult::text(format!("Error: could not install the assets: {e}"))
                    .with_success(false);
            }
        }

        ctx.emit(AgentEvent::ApplyChatStyle {
            css: css.into(),
            js: js.into(),
            // The files behind /theme/assets/ only just landed on disk, so the
            // streaming preview painted this css against 404s. Flagging the
            // explicit-`assets` case (a new set, or `[]` to drop it) is what
            // gets them fetched; an omitted argument keeps serving the same
            // bytes, so identical css stays a no-op and the page never blinks.
            assets_changed: assets.is_some(),
        });

        // The model can't see the page: echo enough back for it to confidently
        // report success (or announce the reset) to the user.
        if is_reset {
            return ToolResult::text(format!("Chat style reset to default.{persist_note}"))
                .with_success(true);
        }
        let rules = css.matches('{').count();
        let mut msg = format!(
            "Applied {} bytes of CSS (~{} rules)",
            css.len(),
            rules
        );
        if !js.trim().is_empty() {
            msg.push_str(&format!(" and {} bytes of JS", js.len()));
        }
        // Echo the served names: the model cannot see the page, and these are
        // the exact URLs its css/js must have used.
        match assets.as_deref() {
            Some([]) => msg.push_str(" (no assets)"),
            Some(list) => msg.push_str(&format!(
                " and {} asset(s) now served at {}",
                list.len(),
                list.iter()
                    .map(|(_, name)| format!("/theme/assets/{name}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            None => {}
        }
        if persist {
            msg.push_str(" to the chat UI.");
            msg.push_str(&persist_note);
        } else {
            msg.push_str(" to the chat UI. Current page only; a refresh restores the default.");
        }
        ToolResult::text(msg).with_success(true)
    }
}
