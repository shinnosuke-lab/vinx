//! The Runtime Cache card, over the workspace it actually measures.
//!
//! Upstream reports directories on a host and has its own tests for that; what
//! is worth pinning here is the part that moved. The categories are real
//! directories in [`agent_web_core::vfs`], and both halves of the card are
//! things a user does to their own storage — so the cases below are about the
//! numbers being the workspace's own, and about a clear taking the files
//! without taking the directory they lived in.

#![cfg(feature = "sqlite")]

use agent_web_core::{files, runtime, vfs};
use wasm_bindgen_test::*;

/// An empty workspace with the layout the categories name.
fn workspace() {
    vfs::detach();
    files::prepare();
}

/// One category's row, as the card reads it.
fn row(stat: &serde_json::Value, name: &str) -> (u64, u64) {
    let cat = stat["categories"][name]
        .as_object()
        .unwrap_or_else(|| panic!("no {name} row in {stat}"));
    (
        cat["size_bytes"].as_u64().unwrap(),
        cat["file_count"].as_u64().unwrap(),
    )
}

#[wasm_bindgen_test]
fn the_card_measures_the_workspace_and_counts_nested_files() {
    workspace();
    vfs::write("/runtime/drafts/notes.md", "0123456789").unwrap();
    vfs::write("/runtime/drafts/deep/nested.txt", "abc").unwrap();
    vfs::write("/runtime/uploads/u_1.png", [0u8; 40]).unwrap();

    let stat = runtime::stat(None);

    // The path shown is one the file tools accept, not a host's data
    // directory: whoever copies it out of the card can paste it into
    // list_files.
    assert_eq!(stat["root"], "/runtime");
    assert!(vfs::is_dir(stat["root"].as_str().unwrap()));

    // A subdirectory's files count towards the category, or a drafts folder
    // full of them would report as empty and its Clear button stay disabled.
    assert_eq!(row(&stat, "drafts"), (13, 2));
    assert_eq!(row(&stat, "uploads"), (40, 1));

    // Nothing downloads to a directory in a tab. The row is reported at zero
    // anyway, because the card draws it from its own list and an absent entry
    // shows an em dash where a truthful "0 B" belongs.
    assert_eq!(row(&stat, "downloads"), (0, 0));

    // Never a date: the workspace stamps writes with a counter, not a clock.
    assert!(stat["categories"]["drafts"]["last_modified"].is_null());
}

#[wasm_bindgen_test]
fn one_category_can_be_asked_for_on_its_own() {
    workspace();
    vfs::write("/runtime/tmp/half-unpacked.zip", [7u8; 5]).unwrap();

    // The refresh button on a row re-stats that row alone, and merges the
    // answer into what it already had -- so anything else in the reply would
    // overwrite rows the user has not touched.
    let stat = runtime::stat(Some("tmp"));
    assert_eq!(row(&stat, "tmp"), (5, 1));
    assert_eq!(
        stat["categories"].as_object().unwrap().len(),
        1,
        "asking for one category answered with {stat}"
    );
}

#[wasm_bindgen_test]
fn clearing_takes_the_files_and_leaves_the_directory() {
    workspace();
    vfs::write("/runtime/drafts/notes.md", "0123456789").unwrap();
    vfs::write("/runtime/uploads/u_1.png", [0u8; 40]).unwrap();

    let cleared = runtime::clear(&["drafts".to_string()]).expect("drafts is clearable");
    assert_eq!(cleared.reclaimed_bytes, 10);
    assert_eq!(cleared.cleared, ["drafts"]);

    // The directory has to come back. `list_files` on one that is not there
    // answers "path not found", which reads as a broken tool rather than as an
    // empty folder.
    assert!(vfs::is_dir(files::DRAFTS));
    assert!(!vfs::exists("/runtime/drafts/notes.md"));

    // And only the one named: a card with four Clear buttons that each wiped
    // everything would be worse than no card.
    assert_eq!(row(&runtime::stat(None), "uploads"), (40, 1));
}

#[wasm_bindgen_test]
fn clearing_nothing_in_particular_clears_all_of_it() {
    workspace();
    vfs::write("/runtime/drafts/notes.md", "0123456789").unwrap();
    vfs::write("/runtime/uploads/u_1.png", [0u8; 40]).unwrap();
    vfs::write("/skills/demo/SKILL.md", "# demo").unwrap();

    let cleared = runtime::clear(&[]).expect("an empty list clears everything");
    assert_eq!(cleared.reclaimed_bytes, 50);

    // downloads has no directory, so it is not among them: creating one just
    // to leave it empty would put a folder in the workspace that nothing ever
    // writes to.
    assert_eq!(cleared.cleared, ["drafts", "uploads", "tmp"]);

    // Skills are not cache. They are installed software with a page of their
    // own, and "clear caches" must never be how they are uninstalled.
    assert!(vfs::is_file("/skills/demo/SKILL.md"));
}
