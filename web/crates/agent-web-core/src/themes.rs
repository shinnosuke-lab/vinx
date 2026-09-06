//! What the theme routes do, over [`crate::releases`].
//!
//! A theme is a stylesheet (and optionally a script) the page injects at boot,
//! written either by the model through `set_chat_style` or by the "save this
//! look" button, which posts back the CSS already on screen. Of everything
//! agent-core can publish, this is the one kind that is entirely a browser
//! concern — so it is the one kind implemented here rather than answered empty.
//!
//! Only the *active* look is served, as upstream: two stylesheets fighting over
//! the same page is not a feature, and the UI injects whatever this returns
//! into a single `<style>` tag anyway.

use std::path::PathBuf;
use std::sync::Arc;

use crate::answer::Refused;
use crate::tool::ToolRegistry;

fn root() -> PathBuf {
    PathBuf::from(crate::files::THEMES)
}

/// Let the model restyle the page it is being read in.
///
/// Persisting is left enabled — that is what makes a look survive the reload —
/// but no read policy is attached, so the `assets` parameter is not advertised;
/// see [`crate::releases`] for why a page cannot serve them.
pub fn install(registry: &ToolRegistry) {
    registry.register(Arc::new(crate::style_tool::SetChatStyleTool::new(Some(
        root(),
    ))));
}

/// `GET /api/themes`: the look to inject, as a list of nought or one.
pub fn active() -> serde_json::Value {
    let themes: Vec<_> = crate::releases::active_theme(&root()).into_iter().collect();
    serde_json::json!({ "themes": themes })
}

/// `GET /api/releases?kind=theme`: the cards on the themes page.
pub fn saved() -> serde_json::Value {
    serde_json::json!({ "releases": crate::releases::scan_themes(&root()) })
}

/// `PUT /api/themes/{name}`: keep the look currently on screen.
///
/// The button sends the CSS the page is already wearing, so this never goes
/// near the model — what is saved is exactly what the user is looking at.
pub fn save(name: &str, css: &str, js: &str, session_id: Option<&str>) -> Result<(), Refused> {
    crate::releases::write_theme(&root(), name, css, js, session_id, None, &[])
        .map_err(|e| Refused::bad(e.to_string()))
}

/// `PUT /api/themes/active`: switch which saved look is injected.
pub fn activate(name: &str) -> Result<(), Refused> {
    crate::releases::set_active_theme(&root(), name).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Refused::missing(format!("no theme named '{name}'")),
        _ => Refused::bad(e.to_string()),
    })
}

/// `DELETE /api/themes/active`: back to the built-in look, keeping the saved
/// ones.
pub fn deactivate() -> Result<(), Refused> {
    crate::releases::deactivate_theme(&root()).map_err(|e| Refused::broken(e.to_string()))
}

/// `DELETE /api/releases/theme/{name}`: remove a saved look for good.
pub fn delete(name: &str) -> Result<(), Refused> {
    let root = root();
    match crate::releases::remove_theme(&root, name) {
        Ok(true) => {
            // Or the pointer would name a look that is gone, and boot would
            // silently fall through to `default`.
            crate::releases::clear_active_theme_if(&root, name);
            Ok(())
        }
        Ok(false) => Err(Refused::missing(format!("no theme named '{name}'"))),
        Err(e) => Err(Refused::bad(e.to_string())),
    }
}
