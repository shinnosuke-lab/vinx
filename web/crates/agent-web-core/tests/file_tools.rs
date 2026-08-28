//! agent-core's file tools, pointed at the workspace instead of a disk.
//!
//! The tools themselves live in the forked engine, whose upstream tested them
//! with fixtures built through `std::fs` and `tempfile` — neither exists in a
//! page, so the fork does not carry those tests. What follows is the minimum
//! that replaces them — the behaviours where "it now reads the workspace"
//! could plausibly have changed the answer.

#![cfg(feature = "sqlite")]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use agent_web_core::event::AgentEvent;
use agent_web_core::files;
use agent_web_core::os::SafePathAllowList;
use agent_web_core::tool::{ToolContext, ToolRegistry};
use agent_web_core::types::RiskLevel;
use agent_web_core::vfs;
use tokio::sync::mpsc;
use wasm_bindgen_test::*;

/// A registry with the file tools in it, over an empty workspace.
///
/// The tree is global, so each case starts from nothing; `detach` also drops
/// any backing store a workspace test left attached.
fn workspace() -> Arc<ToolRegistry> {
    vfs::detach();
    let registry = Arc::new(ToolRegistry::new());
    files::install(&registry, Arc::new(SafePathAllowList::new(None)));
    registry
}

fn context() -> ToolContext {
    let (tx, rx) = mpsc::unbounded_channel::<AgentEvent>();
    // Leaked deliberately: dropping the receiver closes the channel, and a tool
    // that reports progress would then see a send error in a test that is not
    // about that.
    std::mem::forget(rx);
    ToolContext::new(tx, Arc::new(AtomicBool::new(false)))
}

async fn call(registry: &ToolRegistry, name: &str, args: serde_json::Value) -> String {
    let tool = registry
        .get(name)
        .unwrap_or_else(|| panic!("{name} is not registered"));
    tool.execute(args, &context()).await.output
}

#[wasm_bindgen_test]
async fn the_workspace_starts_with_the_directories_the_layout_assumes() {
    let registry = workspace();
    let listing = call(&registry, "list_files", serde_json::json!({ "path": "." })).await;

    // `.` has to mean something: a page has no working directory, and the
    // tool's own default for `path` is this.
    for dir in ["skills/", "runtime/", "themes/"] {
        assert!(listing.contains(dir), "{dir} missing from {listing:?}");
    }
}

#[wasm_bindgen_test]
async fn a_file_written_by_the_agent_can_be_read_back_and_edited() {
    let registry = workspace();

    let written = call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "/notes.md", "content": "hello\nworld\n" }),
    )
    .await;
    assert!(written.contains("Written"), "{written:?}");

    let read = call(&registry, "read_file", serde_json::json!({ "path": "/notes.md" })).await;
    assert!(read.contains("1|hello"), "{read:?}");
    assert!(read.contains("2|world"), "{read:?}");

    call(
        &registry,
        "edit_file",
        serde_json::json!({ "path": "/notes.md", "old_str": "world", "new_str": "workspace" }),
    )
    .await;
    assert_eq!(vfs::read_to_string("/notes.md").unwrap(), "hello\nworkspace\n");
}

/// The precondition the tool's description leans on hardest: an `old_str` that
/// appears twice is a mistake, not an instruction to pick one.
#[wasm_bindgen_test]
async fn an_ambiguous_edit_is_refused_and_says_where() {
    let registry = workspace();
    vfs::write("/dup.txt", "x\ny\nx\n").unwrap();

    let refused = call(
        &registry,
        "edit_file",
        serde_json::json!({ "path": "/dup.txt", "old_str": "x", "new_str": "z" }),
    )
    .await;
    assert!(refused.contains("matched 2 times"), "{refused:?}");
    assert!(refused.contains("lines 1, 3"), "{refused:?}");
    assert_eq!(
        vfs::read_to_string("/dup.txt").unwrap(),
        "x\ny\nx\n",
        "a refused edit must not have written anything"
    );

    let done = call(
        &registry,
        "edit_file",
        serde_json::json!({
            "path": "/dup.txt", "old_str": "x", "new_str": "z", "replace_all": true
        }),
    )
    .await;
    assert!(done.contains("2 replacements"), "{done:?}");
}

/// Reading a large file whole would blow the context window, so the tool
/// summarises unless asked for a range.
#[wasm_bindgen_test]
async fn a_large_file_comes_back_as_a_preview_until_a_range_is_asked_for() {
    let registry = workspace();
    let body: String = (1..=600).map(|n| format!("line {n}\n")).collect();
    vfs::write("/big.txt", &body).unwrap();

    let preview = call(&registry, "read_file", serde_json::json!({ "path": "/big.txt" })).await;
    assert!(preview.contains("600 lines"), "{preview:?}");
    assert!(preview.contains("lines omitted"), "{preview:?}");
    assert!(
        !preview.contains("line 300\n"),
        "the middle of the file should not be in a preview"
    );

    let range = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "/big.txt", "start_line": 300, "end_line": 302 }),
    )
    .await;
    assert!(range.contains("300|line 300"), "{range:?}");
    assert!(range.contains("302|line 302"), "{range:?}");
    assert!(!range.contains("303|"), "{range:?}");
}

/// Nothing outside the tree is reachable — not by climbing out of it, and not
/// by naming a path on the gateway that the model assumes is there.
#[wasm_bindgen_test]
async fn paths_outside_the_workspace_resolve_to_nothing() {
    let registry = workspace();
    vfs::write("/skills/demo/SKILL.md", "# demo").unwrap();

    let escaped = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "/skills/../../etc/passwd" }),
    )
    .await;
    assert!(escaped.contains("cannot resolve path"), "{escaped:?}");

    let gateway = call(&registry, "read_file", serde_json::json!({ "path": "/etc/hosts" })).await;
    assert!(gateway.contains("cannot resolve path"), "{gateway:?}");

    // And `..` inside the tree still lands where it should, rather than being
    // refused outright.
    let back = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "/skills/demo/../demo/SKILL.md" }),
    )
    .await;
    assert!(back.contains("# demo"), "{back:?}");
}

#[wasm_bindgen_test]
async fn search_finds_a_skill_by_its_contents() {
    let registry = workspace();
    vfs::write("/skills/ble/SKILL.md", "---\nname: ble\n---\nscan for beacons\n").unwrap();
    vfs::write("/skills/ble/notes.txt", "nothing to see").unwrap();

    let hits = call(
        &registry,
        "search_files",
        serde_json::json!({ "pattern": "beacons", "path": "/skills" }),
    )
    .await;
    assert!(hits.contains("ble/SKILL.md"), "{hits:?}");
    assert!(!hits.contains("notes.txt"), "{hits:?}");

    let none = call(
        &registry,
        "search_files",
        serde_json::json!({ "pattern": "beacons", "path": "/skills", "file_ext": "txt" }),
    )
    .await;
    assert_eq!(none, "No matches");
}

/// A bare filename is the one write that does not stop to ask. Everything else
/// does, until the user allows the folder.
#[wasm_bindgen_test]
async fn only_drafts_and_allowed_folders_write_without_asking() {
    vfs::detach();
    let registry = Arc::new(ToolRegistry::new());
    let allowed = Arc::new(SafePathAllowList::new(None));
    files::install(&registry, allowed.clone());

    let write = registry.get("write_file").unwrap();
    assert_eq!(
        write.risk(&serde_json::json!({ "path": "report.md" })),
        RiskLevel::Safe,
        "a bare filename lands in the drafts bucket, which is disposable"
    );
    assert_eq!(
        write.risk(&serde_json::json!({ "path": "/skills/new.md" })),
        RiskLevel::Dangerous
    );

    assert!(allowed.learn("/skills"), "the folder exists and can be allowed");
    assert_eq!(
        write.risk(&serde_json::json!({ "path": "/skills/new.md" })),
        RiskLevel::Safe,
        "the confirm bar's 'allow this folder' has to actually stop the asking"
    );

    // And the same list is what the settings panel reads back.
    assert_eq!(allowed.snapshot(), vec!["/skills".to_string()]);
    assert!(
        !allowed.learn("/nowhere"),
        "a directory that is not in the workspace cannot be allowed"
    );
}

#[wasm_bindgen_test]
async fn a_bare_filename_lands_in_drafts_rather_than_at_the_root() {
    let registry = workspace();
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "report.md", "content": "# report" }),
    )
    .await;

    assert_eq!(
        vfs::read_to_string("/runtime/drafts/report.md").unwrap(),
        "# report"
    );
    assert!(!vfs::exists("/report.md"));
}

#[wasm_bindgen_test]
async fn appending_keeps_what_was_there() {
    let registry = workspace();
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "/log.txt", "content": "one\n" }),
    )
    .await;
    let appended = call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "/log.txt", "content": "two\n", "mode": "append" }),
    )
    .await;

    assert!(appended.contains("Appended"), "{appended:?}");
    assert_eq!(vfs::read_to_string("/log.txt").unwrap(), "one\ntwo\n");
}

/// An upload is bytes, and the text tools have to say so rather than hand the
/// model a screenful of replacement characters.
#[wasm_bindgen_test]
async fn a_binary_file_is_reported_as_one() {
    let registry = workspace();
    vfs::write("/runtime/uploads/logo.png", [0x89, b'P', b'N', b'G', 0x00, 0x01]).unwrap();

    let read = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "/runtime/uploads/logo.png" }),
    )
    .await;
    assert!(read.contains("Binary file"), "{read:?}");
}

/// Pure UI: the chat card is a button. Nothing runs on the host, so success
/// without side effects is the whole contract — and the name is what the stock
/// UI keys its renderer on.
#[wasm_bindgen_test]
async fn open_terminal_is_registered_and_does_nothing() {
    let registry = workspace();
    assert!(
        registry.get("open_terminal").is_some(),
        "open_terminal missing; the chat button would never appear"
    );
    let out = call(&registry, "open_terminal", serde_json::json!({})).await;
    assert!(out.to_ascii_lowercase().contains("terminal"), "{out:?}");
}
