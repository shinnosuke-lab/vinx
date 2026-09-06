//! Attaching a file to a message.
//!
//! The point of these is the join between the two halves: an upload is stored
//! as a file in the workspace, so the path the model is told about in the wire
//! note is a path its own `read_file` can open. If that stops being true the
//! feature degrades silently — the model is handed a path and finds nothing.

#![cfg(feature = "sqlite")]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use agent_web_core::event::AgentEvent;
use agent_web_core::files;
use agent_web_core::os::SafePathAllowList;
use agent_web_core::tool::{ToolContext, ToolRegistry};
use agent_web_core::types::Attachment;
use agent_web_core::uploads;
use agent_web_core::vfs;
use tokio::sync::mpsc;
use wasm_bindgen_test::*;

fn workspace() -> Arc<ToolRegistry> {
    vfs::detach();
    let registry = Arc::new(ToolRegistry::new());
    files::install(&registry, Arc::new(SafePathAllowList::new(None)));
    registry
}

async fn read_file(registry: &ToolRegistry, path: &str) -> String {
    let (tx, rx) = mpsc::unbounded_channel::<AgentEvent>();
    std::mem::forget(rx);
    registry
        .get("read_file")
        .expect("read_file is not registered")
        .execute(
            serde_json::json!({ "path": path }),
            &ToolContext::new(tx, Arc::new(AtomicBool::new(false))),
        )
        .await
        .output
}

fn reference(id: &str) -> Attachment {
    Attachment {
        id: id.to_string(),
        name: "notes.md".into(),
        mime: String::new(),
        // Zero, as the UI sends it: the client echoes back what it was told and
        // `resolve` is what makes the number authoritative.
        size: 0,
        lines: None,
    }
}

/// The whole point of storing an upload in the workspace rather than beside it.
#[wasm_bindgen_test]
async fn an_attached_text_file_is_one_the_model_can_read() {
    let registry = workspace();
    let stored = uploads::store("notes.md", "text/markdown", b"alpha\nbeta\n").unwrap();

    assert_eq!(stored.kind, "file");
    assert_eq!(stored.size, 11);
    assert_eq!(stored.lines, Some(2), "the wire note quotes this");
    assert!(stored.id.ends_with(".md"), "{}", stored.id);

    let path = format!("/runtime/uploads/{}", stored.id);
    let read = read_file(&registry, &path).await;
    assert!(read.contains("1|alpha"), "{read:?}");
    assert!(read.contains("2|beta"), "{read:?}");
}

/// The extension is what marks an upload as visual input, everywhere
/// downstream — including inside the vendored engine.
#[wasm_bindgen_test]
async fn an_image_is_stored_under_a_canonical_extension() {
    workspace();
    let png = uploads::store(
        "shot.PNG",
        "image/png; charset=binary",
        &[0x89, b'P', b'N', b'G'],
    )
    .unwrap();

    assert_eq!(png.kind, "image");
    assert!(png.id.ends_with(".png"), "{}", png.id);
    assert!(uploads::is_image(&png.id));
    assert_eq!(uploads::mime_of(&png.id), "image/png");
    assert_eq!(png.lines, None, "a line count would be meaningless");

    // A JPEG uploaded as .jpeg is still one file type, so the id says jpg.
    let jpeg = uploads::store("photo.jpeg", "image/jpeg", b"\xff\xd8\xff").unwrap();
    assert!(jpeg.id.ends_with(".jpg"), "{}", jpeg.id);
}

/// A file whose type is not in the image set must not end up with an image
/// extension, or it would be sent to the model as a picture of itself.
#[wasm_bindgen_test]
async fn a_non_image_never_takes_an_image_extension() {
    workspace();
    let svg = uploads::store("diagram.svg", "image/svg+xml", b"<svg/>").unwrap();
    assert_eq!(svg.kind, "file");

    let disguised = uploads::store("evil.png", "application/octet-stream", b"MZ").unwrap();
    assert_eq!(disguised.kind, "file");
    assert!(disguised.id.ends_with(".bin"), "{}", disguised.id);
    assert!(!uploads::is_image(&disguised.id));

    let nameless = uploads::store("", "application/octet-stream", b"x").unwrap();
    assert!(nameless.id.ends_with(".bin"), "{}", nameless.id);
}

#[wasm_bindgen_test]
async fn what_cannot_be_stored_says_why_and_with_which_status() {
    workspace();

    let empty = uploads::store("x.txt", "text/plain", b"").unwrap_err();
    assert_eq!(empty.status, 400);

    // The caps differ by kind, and the message is shown to the user as-is.
    let big = uploads::store("x.txt", "text/plain", &vec![b'x'; 21 * 1024 * 1024]).unwrap_err();
    assert_eq!(big.status, 413);
    assert!(big.message.contains("20MB"), "{}", big.message);

    let image = uploads::store("x.png", "image/png", &vec![0u8; 11 * 1024 * 1024]).unwrap_err();
    assert_eq!(image.status, 413);
    assert!(image.message.contains("10MB"), "{}", image.message);

    // 11MB is over the image cap but under the file one.
    assert!(uploads::store(
        "x.bin",
        "application/octet-stream",
        &vec![0u8; 11 * 1024 * 1024]
    )
    .is_ok());
}

#[wasm_bindgen_test]
async fn only_ids_this_produced_are_ever_treated_as_paths() {
    workspace();
    let stored = uploads::store("notes.md", "text/plain", b"hi").unwrap();
    assert!(uploads::valid_id(&stored.id));

    for hostile in [
        "../../etc/passwd",
        "/etc/passwd",
        "notes.md",
        "",
        "0123456789abcdef0123456789abcde.md",
    ] {
        assert!(!uploads::valid_id(hostile), "{hostile:?} must not be an id");
        assert!(uploads::load(hostile).is_none(), "{hostile:?}");
    }
}

/// A page can be reloaded, and a workspace cleared, between the upload and the
/// message it was attached to.
#[wasm_bindgen_test]
async fn references_are_checked_against_the_workspace_before_the_turn() {
    workspace();
    let stored = uploads::store("notes.md", "text/plain", b"alpha\n").unwrap();
    let gone = format!("{}.md", "0".repeat(32));

    let resolved = uploads::resolve(vec![
        reference(&stored.id),
        reference(&gone),
        reference("../secrets"),
    ]);

    assert_eq!(resolved.len(), 1, "only the one still there survives");
    assert_eq!(resolved[0].id, stored.id);
    assert_eq!(
        resolved[0].size, 6,
        "the size has to come from the file, not from the client"
    );
    assert_eq!(resolved[0].name, "notes.md", "the display name is kept");
}

#[wasm_bindgen_test]
async fn an_upload_reads_back_byte_for_byte() {
    workspace();
    let bytes: Vec<u8> = (0u8..=255).collect();
    let stored = uploads::store("blob.dat", "application/octet-stream", &bytes).unwrap();

    assert_eq!(uploads::load(&stored.id).as_deref(), Some(&bytes[..]));
    assert_eq!(uploads::mime_of(&stored.id), "application/octet-stream");
}
