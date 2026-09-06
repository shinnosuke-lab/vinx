//! agent-core's file tools, pointed at the workspace instead of a disk.
//!
//! The tools themselves live in the forked engine, whose upstream tested them
//! with fixtures built through `std::fs` and `tempfile` — neither exists in a
//! page, so the fork does not carry those tests. What follows is the minimum
//! that replaces them — the behaviours where "it now reads the workspace"
//! could plausibly have changed the answer.

#![cfg(feature = "sqlite")]

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use agent_web_core::event::AgentEvent;
use agent_web_core::files;
use agent_web_core::os::SafePathAllowList;
use agent_web_core::tool::{ToolContext, ToolRegistry};
use agent_web_core::types::RiskLevel;
use agent_web_core::vfs;
use tokio::sync::mpsc;
use wasm_bindgen::prelude::Closure;
use wasm_bindgen::JsCast;
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

    let read = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "/notes.md" }),
    )
    .await;
    assert!(read.contains("1|hello"), "{read:?}");
    assert!(read.contains("2|world"), "{read:?}");

    call(
        &registry,
        "edit_file",
        serde_json::json!({ "path": "/notes.md", "old_str": "world", "new_str": "workspace" }),
    )
    .await;
    assert_eq!(
        vfs::read_to_string("/notes.md").unwrap(),
        "hello\nworkspace\n"
    );
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

/// `new_str == old_str` is almost always an INSERT whose new_str was cut
/// short after copying the anchor. The refusal is diagnosed AFTER locating, so
/// it says where the anchor sits and how to fix the call — and, when the
/// anchor is not there at all, that error wins (there is nothing to insert
/// at).
#[wasm_bindgen_test]
async fn an_identical_edit_is_refused_with_the_anchor_line_and_the_fix() {
    let registry = workspace();
    vfs::write("/same.txt", "a\nanchor\nb\n").unwrap();

    let refused = call(
        &registry,
        "edit_file",
        serde_json::json!({ "path": "/same.txt", "old_str": "anchor", "new_str": "anchor" }),
    )
    .await;
    assert!(refused.starts_with("Error: new_str is identical to old_str"), "{refused:?}");
    assert!(refused.contains("(line 2)"), "{refused:?}");
    assert!(refused.contains("To INSERT text, new_str must be old_str plus the new text"), "{refused:?}");
    assert_eq!(vfs::read_to_string("/same.txt").unwrap(), "a\nanchor\nb\n");

    // A missing anchor is the more useful complaint than "identical".
    let missing = call(
        &registry,
        "edit_file",
        serde_json::json!({ "path": "/same.txt", "old_str": "nope", "new_str": "nope" }),
    )
    .await;
    assert!(missing.contains("old_str not found"), "{missing:?}");

    // Upstream's tool description carries the rule, so the model reads it
    // before making the mistake.
    let def = registry.get("edit_file").unwrap().definition();
    assert!(
        def.function.description.contains("to INSERT, new_str must repeat old_str"),
        "{}",
        def.function.description
    );
}

/// Reading a large file whole would blow the context window, so the tool
/// summarises unless asked for a range.
#[wasm_bindgen_test]
async fn a_large_file_comes_back_as_a_preview_until_a_range_is_asked_for() {
    let registry = workspace();
    let body: String = (1..=600).map(|n| format!("line {n}\n")).collect();
    vfs::write("/big.txt", &body).unwrap();

    let preview = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "/big.txt" }),
    )
    .await;
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
/// by naming a path on the gateway that the model assumes is there. And the
/// miss reads as a miss: "no such file", not a resolver complaint a model
/// takes for a permission wall.
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
    assert!(escaped.contains("no such file or directory"), "{escaped:?}");
    assert!(!escaped.contains("cannot resolve"), "{escaped:?}");

    let gateway = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "/etc/hosts" }),
    )
    .await;
    assert!(
        gateway.contains("no such file or directory: /etc/hosts"),
        "{gateway:?}"
    );

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
    vfs::write(
        "/skills/ble/SKILL.md",
        "---\nname: ble\n---\nscan for beacons\n",
    )
    .unwrap();
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

/// Searching one file names it once: `notes.html:3:`, not `notes.html/:3:`
/// (the remainder under a search root that IS the file is empty).
#[wasm_bindgen_test]
async fn searching_a_single_file_prints_its_path_without_a_stray_slash() {
    let registry = workspace();
    vfs::write("/skills/ble/notes.txt", "one\ntwo\nthree beacons\n").unwrap();

    let hits = call(
        &registry,
        "search_files",
        serde_json::json!({ "pattern": "beacons", "path": "/skills/ble/notes.txt" }),
    )
    .await;
    assert!(hits.contains("/skills/ble/notes.txt:3:"), "{hits:?}");
    assert!(!hits.contains("notes.txt/:"), "{hits:?}");
}

/// The bare-name rule has no exceptions: the model that just wrote
/// `notes.html` can grep and list it by that name too, instead of learning
/// per tool which ones understood it.
#[wasm_bindgen_test]
async fn a_bare_filename_searches_and_lists_the_draft_too() {
    let registry = workspace();
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "notes.html", "content": "<h1>x</h1>\n<script>go()</script>\n" }),
    )
    .await;

    let hits = call(
        &registry,
        "search_files",
        serde_json::json!({ "pattern": "<script>", "path": "notes.html" }),
    )
    .await;
    assert!(hits.contains("notes.html:2:"), "{hits:?}");
    assert!(!hits.contains("no such file"), "{hits:?}");

    let listed = call(
        &registry,
        "list_files",
        serde_json::json!({ "path": "notes.html" }),
    )
    .await;
    assert!(
        listed.contains("not a directory: /runtime/drafts/notes.html"),
        "the draft was found (and is a file): {listed:?}"
    );

    // `.` is not a filename: the tools' default path keeps meaning the root,
    // not the drafts bucket that happens to contain a `.` too.
    let root = call(&registry, "list_files", serde_json::json!({ "path": "." })).await;
    assert!(root.contains("skills/"), "{root:?}");
    assert!(!root.contains("drafts/."), "{root:?}");

    // No draft of that name: the path means what it says, and the miss is
    // reported against it.
    let missing = call(
        &registry,
        "search_files",
        serde_json::json!({ "pattern": "x", "path": "nothing.html" }),
    )
    .await;
    assert!(
        missing.contains("no such file or directory: nothing.html"),
        "{missing:?}"
    );
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

    assert!(
        allowed.learn("/skills"),
        "the folder exists and can be allowed"
    );
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
    vfs::write(
        "/runtime/uploads/logo.png",
        [0x89, b'P', b'N', b'G', 0x00, 0x01],
    )
    .unwrap();

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

// ── the bare-filename convention, read back ──

/// What a bare-filename `write_file` produced is found again by the same bare
/// name — without that, the model writes `x.html`, is told it went to
/// `/runtime/drafts/x.html`, and then hears "file not found: x.html" from
/// `edit_file`.
#[wasm_bindgen_test]
async fn a_bare_filename_reads_and_edits_the_draft_it_wrote() {
    let registry = workspace();
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "page.html", "content": "<h1>hi</h1>\n" }),
    )
    .await;

    let read = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "page.html" }),
    )
    .await;
    assert!(read.contains("1|<h1>hi</h1>"), "{read:?}");

    let edit = registry.get("edit_file").unwrap();
    assert_eq!(
        edit.risk(&serde_json::json!({ "path": "page.html", "old_str": "hi", "new_str": "hello" })),
        RiskLevel::Safe,
        "editing inside the drafts bucket is as harmless as writing there"
    );
    let edited = call(
        &registry,
        "edit_file",
        serde_json::json!({ "path": "page.html", "old_str": "hi", "new_str": "hello" }),
    )
    .await;
    assert!(edited.contains("Edited"), "{edited:?}");
    assert_eq!(
        vfs::read_to_string("/runtime/drafts/page.html").unwrap(),
        "<h1>hello</h1>\n"
    );

    // A root-level file of the same name does not shadow the draft: the write
    // went to drafts, so the read means drafts.
    vfs::write("/page.html", "root copy").unwrap();
    let read = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "page.html" }),
    )
    .await;
    assert!(read.contains("<h1>hello</h1>"), "{read:?}");
}

/// A bare name that is no draft falls through to the path as written, and a
/// miss is reported against that name — not against a drafts guess.
#[wasm_bindgen_test]
async fn a_bare_filename_that_is_no_draft_means_the_path_as_written() {
    let registry = workspace();
    vfs::write("/notes.md", "at the root").unwrap();

    let read = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "notes.md" }),
    )
    .await;
    assert!(read.contains("at the root"), "{read:?}");

    let missing = call(
        &registry,
        "read_file",
        serde_json::json!({ "path": "nothing.md" }),
    )
    .await;
    assert!(missing.contains("nothing.md"), "{missing:?}");
    assert!(!missing.contains("/runtime/drafts/"), "{missing:?}");
}

// ── download_file: the way a draft reaches the person ──

/// What the fake page saw: the filename and bytes of the last download.
type Seen = Rc<RefCell<Option<(String, Vec<u8>)>>>;

/// Wires a recording downloader; returns where the recording lands.
fn recording_downloader() -> Seen {
    let seen: Seen = Rc::new(RefCell::new(None));
    let sink = seen.clone();
    let f = Closure::<dyn Fn(String, js_sys::Uint8Array)>::new(
        move |name: String, bytes: js_sys::Uint8Array| {
            *sink.borrow_mut() = Some((name, bytes.to_vec()));
        },
    );
    files::set_downloader(Some(f.as_ref().unchecked_ref::<js_sys::Function>().clone()));
    f.forget();
    seen
}

#[wasm_bindgen_test]
async fn download_file_hands_a_draft_to_the_person_by_its_bare_name() {
    let registry = workspace();
    let seen = recording_downloader();
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "2048.html", "content": "<!doctype html>" }),
    )
    .await;

    let tool = registry.get("download_file").unwrap();
    assert_eq!(
        tool.risk(&serde_json::json!({ "path": "2048.html" })),
        RiskLevel::Safe,
        "the person's own file into their own downloads folder needs no confirmation"
    );
    let out = tool
        .execute(serde_json::json!({ "path": "2048.html" }), &context())
        .await;
    assert_ne!(out.success, Some(false), "{}", out.output);
    assert!(out.output.contains("2048.html"), "{}", out.output);
    assert!(out.output.contains("15 bytes"), "{}", out.output);

    let (name, bytes) = seen.borrow().clone().expect("the page was handed the file");
    assert_eq!(name, "2048.html");
    assert_eq!(bytes, b"<!doctype html>");
    files::set_downloader(None);
}

#[wasm_bindgen_test]
async fn download_file_reports_what_it_cannot_send() {
    let registry = workspace();
    let seen = recording_downloader();
    vfs::create_dir_all("/skills/demo").unwrap();

    let missing = call(
        &registry,
        "download_file",
        serde_json::json!({ "path": "nothing.html" }),
    )
    .await;
    assert!(
        missing.contains("no such file or directory: nothing.html"),
        "{missing:?}"
    );

    let dir = call(
        &registry,
        "download_file",
        serde_json::json!({ "path": "/skills/demo" }),
    )
    .await;
    assert!(dir.contains("is a directory"), "{dir:?}");

    let outside = call(
        &registry,
        "download_file",
        serde_json::json!({ "path": "/etc/hosts" }),
    )
    .await;
    assert!(
        outside.contains("no such file or directory: /etc/hosts"),
        "{outside:?}"
    );

    assert!(
        seen.borrow().is_none(),
        "nothing should have reached the page"
    );

    // A page that never installed a downloader (a headless embedding) is told
    // apart from a broken one: the tool says so instead of claiming success.
    files::set_downloader(None);
    vfs::write("/runtime/drafts/a.txt", "a").unwrap();
    let nowhere = call(
        &registry,
        "download_file",
        serde_json::json!({ "path": "a.txt" }),
    )
    .await;
    assert!(nowhere.contains("cannot hand files"), "{nowhere:?}");
}

// ── open_file: the other door — a tab to look at, opened by the person ──

/// The tool only vets the path; the card's Open button does the opening, by
/// reading the file back through the host at click time. So the tool's
/// success must mean "that read will work", and its result must not claim
/// the file is already on screen.
#[wasm_bindgen_test]
async fn open_file_offers_a_draft_and_the_page_can_read_it_back() {
    let registry = workspace();
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "app.html", "content": "<h1>app</h1>" }),
    )
    .await;

    let tool = registry.get("open_file").expect("open_file registered");
    assert_eq!(
        tool.risk(&serde_json::json!({ "path": "app.html" })),
        RiskLevel::Safe,
        "a button the person may press needs no confirmation"
    );
    let out = tool
        .execute(serde_json::json!({ "path": "app.html" }), &context())
        .await;
    assert_ne!(out.success, Some(false), "{}", out.output);
    assert!(out.output.contains("Offered app.html"), "{}", out.output);
    assert!(out.output.contains("12 bytes"), "{}", out.output);
    assert!(
        out.output.contains("when the person clicks"),
        "{}",
        out.output
    );

    // What the button will fetch — by the bare name the model used, and by
    // the full path alike.
    assert_eq!(
        files::read_for_person("app.html").as_deref(),
        Some(b"<h1>app</h1>".as_slice())
    );
    assert_eq!(
        files::read_for_person("/runtime/drafts/app.html").as_deref(),
        Some(b"<h1>app</h1>".as_slice())
    );
    // Gone (or never there, or a directory): nothing, and the card says so.
    assert_eq!(files::read_for_person("nothing.html"), None);
    assert_eq!(files::read_for_person("/runtime/drafts"), None);
    assert_eq!(files::read_for_person(""), None);
}

#[wasm_bindgen_test]
async fn open_file_reports_what_it_cannot_offer() {
    let registry = workspace();
    vfs::create_dir_all("/skills/demo").unwrap();

    let missing = call(
        &registry,
        "open_file",
        serde_json::json!({ "path": "nothing.html" }),
    )
    .await;
    assert!(
        missing.contains("no such file or directory: nothing.html"),
        "{missing:?}"
    );

    let dir = call(
        &registry,
        "open_file",
        serde_json::json!({ "path": "/skills/demo" }),
    )
    .await;
    assert!(
        dir.contains("is a directory; open_file takes one file"),
        "{dir:?}"
    );

    let empty = call(&registry, "open_file", serde_json::json!({})).await;
    assert!(empty.contains("path is required"), "{empty:?}");
}

// ── install_app: the third door — a web app onto the Apps page ──

/// What the fake page saw: the object handed to the installer, read back
/// field by field.
#[derive(Debug, Clone, PartialEq)]
struct HandedApp {
    id: String,
    title: Option<String>,
    description: Option<String>,
    html: Vec<u8>,
    css: Option<Vec<u8>>,
    js: Option<Vec<u8>>,
    /// The `autostart` key as the page sees it: absent (None) unless the
    /// model passed a literal true.
    autostart: Option<bool>,
}

type SeenApp = Rc<RefCell<Option<HandedApp>>>;

fn field(obj: &js_sys::Object, key: &str) -> wasm_bindgen::JsValue {
    js_sys::Reflect::get(obj, &wasm_bindgen::JsValue::from_str(key)).unwrap()
}

fn bytes_field(obj: &js_sys::Object, key: &str) -> Option<Vec<u8>> {
    let v = field(obj, key);
    if v.is_undefined() {
        None
    } else {
        Some(js_sys::Uint8Array::from(v).to_vec())
    }
}

/// Wires an installer that records what it was given and answers `answer`:
/// `Ok` resolves the promise with that line, `Err` rejects it.
fn recording_installer(answer: Result<&'static str, &'static str>) -> SeenApp {
    let seen: SeenApp = Rc::new(RefCell::new(None));
    let sink = seen.clone();
    let f =
        Closure::<dyn Fn(js_sys::Object) -> js_sys::Promise>::new(move |app: js_sys::Object| {
            *sink.borrow_mut() = Some(HandedApp {
                id: field(&app, "id").as_string().unwrap(),
                title: field(&app, "title").as_string(),
                description: field(&app, "description").as_string(),
                html: bytes_field(&app, "html").expect("html is always handed"),
                css: bytes_field(&app, "css"),
                js: bytes_field(&app, "js"),
                autostart: field(&app, "autostart").as_bool(),
            });
            match answer {
                Ok(line) => js_sys::Promise::resolve(&wasm_bindgen::JsValue::from_str(line)),
                Err(why) => js_sys::Promise::reject(&js_sys::Error::new(why)),
            }
        });
    files::set_app_installer(Some(f.as_ref().unchecked_ref::<js_sys::Function>().clone()));
    f.forget();
    seen
}

#[wasm_bindgen_test]
async fn install_app_hands_the_parts_to_the_page_and_relays_its_answer() {
    let registry = workspace();
    let seen = recording_installer(Ok("Installed \"Focus\" (focus) on the Apps page."));
    for (name, content) in [
        ("focus.html", "<h1>Focus</h1>"),
        ("focus.css", "h1{color:red}"),
        ("focus.js", "vinx.say('hi')"),
    ] {
        call(
            &registry,
            "write_file",
            serde_json::json!({ "path": name, "content": content }),
        )
        .await;
    }

    let tool = registry.get("install_app").expect("install_app registered");
    let args = serde_json::json!({
        "id": "focus",
        "title": "Focus",
        "description": "A timer",
        "html": "focus.html",
        "css": "focus.css",
        "js": "/runtime/drafts/focus.js"
    });
    assert_eq!(
        tool.risk(&args),
        RiskLevel::Safe,
        "an inert package onto a page the person can clear needs no confirmation"
    );
    let out = tool.execute(args, &context()).await;
    assert_ne!(out.success, Some(false), "{}", out.output);
    // The page's own line is what the model reads.
    assert_eq!(out.output, "Installed \"Focus\" (focus) on the Apps page.");

    let handed = seen.borrow().clone().expect("the page was handed the app");
    assert_eq!(
        handed,
        HandedApp {
            id: "focus".into(),
            title: Some("Focus".into()),
            description: Some("A timer".into()),
            html: b"<h1>Focus</h1>".to_vec(),
            css: Some(b"h1{color:red}".to_vec()),
            js: Some(b"vinx.say('hi')".to_vec()),
            autostart: None,
        }
    );
    files::set_app_installer(None);
}

/// `autostart` crosses only as a literal true — the person's policy, which
/// the page reads as "add to the list"; anything else leaves the key off so
/// an update keeps the current setting.
#[wasm_bindgen_test]
async fn install_app_hands_autostart_only_when_asked() {
    let registry = workspace();
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "a.html", "content": "<p>a</p>" }),
    )
    .await;
    let tool = registry.get("install_app").unwrap();
    for (given, expected) in [
        (serde_json::json!(true), Some(true)),
        (serde_json::json!(false), None),
        (serde_json::json!("true"), None),
        (serde_json::json!(1), None),
    ] {
        let seen = recording_installer(Ok("ok"));
        let out = tool
            .execute(
                serde_json::json!({ "id": "a", "html": "a.html", "autostart": given }),
                &context(),
            )
            .await;
        assert_ne!(out.success, Some(false), "{}", out.output);
        let handed = seen.borrow().clone().unwrap();
        assert_eq!(handed.autostart, expected, "autostart given as {given}");
    }
    files::set_app_installer(None);
}

#[wasm_bindgen_test]
async fn install_app_relays_the_pages_refusal_as_a_failure() {
    let registry = workspace();
    let seen = recording_installer(Err(
        "E ID_INVALID id: Focus — lowercase letters, digits and dashes",
    ));
    call(
        &registry,
        "write_file",
        serde_json::json!({ "path": "f.html", "content": "<p>x</p>" }),
    )
    .await;

    let tool = registry.get("install_app").unwrap();
    let out = tool
        .execute(
            serde_json::json!({ "id": "Focus", "html": "f.html" }),
            &context(),
        )
        .await;
    assert_eq!(out.success, Some(false), "{}", out.output);
    assert!(
        out.output.starts_with("Error: E ID_INVALID"),
        "{}",
        out.output
    );
    // Optional parts stay absent rather than arriving empty.
    let handed = seen.borrow().clone().unwrap();
    assert_eq!(handed.title, None);
    assert_eq!(handed.css, None);
    assert_eq!(handed.js, None);
    files::set_app_installer(None);
}

#[wasm_bindgen_test]
async fn install_app_reports_what_it_cannot_hand_over() {
    let registry = workspace();
    let seen = recording_installer(Ok("never"));
    vfs::create_dir_all("/skills/demo").unwrap();
    vfs::write("/runtime/drafts/ok.html", "<p>ok</p>").unwrap();

    let no_id = call(
        &registry,
        "install_app",
        serde_json::json!({ "html": "ok.html" }),
    )
    .await;
    assert!(no_id.contains("id is required"), "{no_id:?}");

    let no_html = call(&registry, "install_app", serde_json::json!({ "id": "x" })).await;
    assert!(no_html.contains("html is required"), "{no_html:?}");

    let missing = call(
        &registry,
        "install_app",
        serde_json::json!({ "id": "x", "html": "nothing.html" }),
    )
    .await;
    assert!(
        missing.contains("no such file or directory: nothing.html"),
        "{missing:?}"
    );

    let dir = call(
        &registry,
        "install_app",
        serde_json::json!({ "id": "x", "html": "ok.html", "css": "/skills/demo" }),
    )
    .await;
    assert!(
        dir.contains("is a directory; install_app takes one file"),
        "{dir:?}"
    );

    // A part over what a window stages is refused here, before it crosses.
    vfs::write(
        "/runtime/drafts/big.js",
        &"x".repeat(files::MAX_APP_PART_BYTES + 1),
    )
    .unwrap();
    let big = call(
        &registry,
        "install_app",
        serde_json::json!({ "id": "x", "html": "ok.html", "js": "big.js" }),
    )
    .await;
    assert!(
        big.contains("js (/runtime/drafts/big.js) is 163841 bytes"),
        "{big:?}"
    );
    assert!(big.contains("at most 163840 bytes"), "{big:?}");

    assert!(
        seen.borrow().is_none(),
        "nothing should have reached the page"
    );

    // A page that never installed an installer is told apart from a broken one.
    files::set_app_installer(None);
    let nowhere = call(
        &registry,
        "install_app",
        serde_json::json!({ "id": "x", "html": "ok.html" }),
    )
    .await;
    assert!(nowhere.contains("cannot install apps"), "{nowhere:?}");
}
