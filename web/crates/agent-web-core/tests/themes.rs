//! Looks the page wears: what `set_chat_style` saves and what the routes read.
//!
//! Upstream's own tests for this live against a temp directory and are not
//! carried by the fork, so the cases here stand in for them — with the emphasis
//! on the two ends we are responsible for: that a saved look lands in the
//! workspace under upstream's layout, and that exactly one look is ever served
//! back, since the UI injects the answer into a single `<style>` tag.

#![cfg(feature = "sqlite")]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use agent_web_core::event::AgentEvent;
use agent_web_core::tool::{ToolContext, ToolRegistry};
use agent_web_core::{files, themes, vfs};
use tokio::sync::mpsc;
use wasm_bindgen_test::*;

/// An empty workspace with the style tool registered.
fn workspace() -> Arc<ToolRegistry> {
    vfs::detach();
    files::prepare();
    let registry = Arc::new(ToolRegistry::new());
    themes::install(&registry);
    registry
}

fn context(session: Option<&str>) -> ToolContext {
    let (tx, rx) = mpsc::unbounded_channel::<AgentEvent>();
    // Leaked: dropping the receiver closes the channel, and the tool reports
    // the applied style through it.
    std::mem::forget(rx);
    ToolContext::new(tx, Arc::new(AtomicBool::new(false)))
        .with_session(session.map(str::to_string))
}

async fn style(registry: &ToolRegistry, args: serde_json::Value, session: Option<&str>) -> String {
    let tool = registry
        .get("set_chat_style")
        .expect("set_chat_style is registered");
    tool.execute(args, &context(session)).await.output
}

#[wasm_bindgen_test]
async fn a_look_the_model_keeps_survives_as_files_the_routes_can_read() {
    let registry = workspace();

    style(
        &registry,
        serde_json::json!({
            "css": "body{background:#101014}",
            "js": "egg.root.dataset.night = '1'",
            "persist": true,
            "name": "midnight",
            "description": "Dark, violet accents",
            "palette": ["#101014", "#8b5cf6"],
        }),
        Some("session-1"),
    )
    .await;

    // Upstream's layout, so an exported workspace drops into an agent-core
    // install unchanged.
    assert_eq!(
        vfs::read_to_string("/themes/midnight/plugin.css").unwrap(),
        "body{background:#101014}"
    );
    assert!(vfs::is_file("/themes/midnight/plugin.js"));
    assert_eq!(vfs::read_to_string("/themes/active").unwrap(), "midnight");

    // Keeping a look activates it: that is what "it re-applies on every load"
    // means, and the boot route is where the page finds out.
    let active = themes::active();
    assert_eq!(active["themes"].as_array().unwrap().len(), 1);
    assert_eq!(active["themes"][0]["name"], "midnight");
    assert_eq!(active["themes"][0]["css"], "body{background:#101014}");

    let card = &themes::saved()["releases"][0];
    assert_eq!(card["name"], "midnight");
    assert_eq!(card["description"], "Dark, violet accents");
    assert_eq!(card["session_id"], "session-1");
    assert_eq!(
        card["palette"][1], "#8b5cf6",
        "the swatch cannot be read back out of css written through hsl() tokens"
    );
}

#[wasm_bindgen_test]
async fn only_the_active_look_is_served_however_many_are_saved() {
    workspace();

    themes::save("dawn", "body{color:#111}", "", None).unwrap();
    themes::save("dusk", "body{color:#eee}", "", None).unwrap();
    assert_eq!(themes::saved()["releases"].as_array().unwrap().len(), 2);
    assert!(
        themes::active()["themes"].as_array().unwrap().is_empty(),
        "saving is not wearing"
    );

    themes::activate("dusk").unwrap();
    let shown = themes::active();
    assert_eq!(shown["themes"].as_array().unwrap().len(), 1);
    assert_eq!(shown["themes"][0]["name"], "dusk");

    // Back to the built-in look, keeping both saved ones.
    themes::deactivate().unwrap();
    assert!(themes::active()["themes"].as_array().unwrap().is_empty());
    assert_eq!(themes::saved()["releases"].as_array().unwrap().len(), 2);
}

/// The sentinel exists so that "restore the built-in look" is not undone by a
/// reload finding an old `default` slot and wearing it again.
#[wasm_bindgen_test]
async fn restoring_the_built_in_look_outlives_a_reload() {
    workspace();
    themes::save("default", "body{color:red}", "", None).unwrap();
    assert_eq!(themes::active()["themes"][0]["name"], "default");

    themes::deactivate().unwrap();
    assert!(themes::active()["themes"].as_array().unwrap().is_empty());
}

#[wasm_bindgen_test]
async fn deleting_the_look_being_worn_takes_it_off() {
    workspace();
    themes::save("dusk", "body{}", "", None).unwrap();
    themes::save("dawn", "body{}", "", None).unwrap();
    themes::activate("dusk").unwrap();

    // An inactive one goes without disturbing what is on screen.
    themes::delete("dawn").unwrap();
    assert_eq!(themes::active()["themes"][0]["name"], "dusk");

    themes::delete("dusk").unwrap();
    assert!(
        themes::active()["themes"].as_array().unwrap().is_empty(),
        "a pointer left naming a deleted look would inject nothing and hide the reason"
    );
    assert!(themes::delete("dusk").is_err(), "it is already gone");
}

/// The name becomes a directory beside every other look and the pointer file:
/// the two ways out of that slot are the two that must be refused.
#[wasm_bindgen_test]
async fn a_name_cannot_escape_the_themes_directory_or_shadow_the_pointer() {
    workspace();

    for name in ["../escape", "nested/look", ".hidden", "active"] {
        assert!(
            themes::save(name, "body{}", "", None).is_err(),
            "{name} was accepted"
        );
    }
    assert!(!vfs::is_file("/escape/plugin.css"));
}

/// A re-save replaces the payload; it does not create a second slot, and it
/// does not reset when the look was first kept.
#[wasm_bindgen_test]
async fn saving_over_a_look_keeps_the_slot_it_already_had() {
    workspace();
    themes::save("dusk", "body{color:#eee}", "", Some("session-1")).unwrap();
    let first = themes::saved()["releases"][0]["created_at"].clone();

    themes::save("dusk", "body{color:#ddd}", "", Some("session-2")).unwrap();
    let cards = themes::saved();
    assert_eq!(cards["releases"].as_array().unwrap().len(), 1);
    assert_eq!(cards["releases"][0]["created_at"], first);
    assert_eq!(
        vfs::read_to_string("/themes/dusk/plugin.css").unwrap(),
        "body{color:#ddd}"
    );
}

/// The model's own way of undoing a look it saved: the same call with nothing
/// in it.
#[wasm_bindgen_test]
async fn an_empty_persisting_call_removes_the_saved_look() {
    let registry = workspace();
    themes::save("midnight", "body{}", "", None).unwrap();
    themes::activate("midnight").unwrap();

    let said = style(
        &registry,
        serde_json::json!({ "css": "", "js": "", "persist": true, "name": "midnight" }),
        None,
    )
    .await;

    assert!(said.contains("deleted"), "{said}");
    assert!(!vfs::is_dir("/themes/midnight"));
    assert!(themes::active()["themes"].as_array().unwrap().is_empty());
}

/// Assets would be served from `/theme/assets/…`, a path the fetch shim never
/// sees. The tool must therefore not offer them — a model that read about the
/// parameter would write `url()`s that resolve to nothing.
#[wasm_bindgen_test]
async fn the_page_never_offers_assets_it_could_not_serve() {
    let registry = workspace();
    let definition = registry
        .get("set_chat_style")
        .expect("set_chat_style is registered")
        .definition();

    let text = serde_json::to_string(&definition).unwrap();
    assert!(!text.contains("assets"), "{text}");
    assert!(text.contains("persist"), "persistence is still on offer");
}
