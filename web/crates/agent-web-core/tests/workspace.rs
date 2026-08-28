//! The workspace filesystem, and whether it survives a reload.
//!
//! The tab is where skills, uploads and the agent's own files live, and a
//! workspace that quietly forgets them is worse than one that never existed:
//! everything keeps working for as long as the page is open, so nothing notices
//! until someone comes back the next day.
//!
//! What is being exercised here is the write-through path, not IndexedDB. These
//! run under Node, where the default SQLite VFS keeps its files in memory but
//! keeps them by *name* — so closing a handle and opening the same name again
//! is the same thing a reload is, as far as this layer can tell.

#![cfg(feature = "sqlite")]

use agent_web_core::vfs;
use agent_web_core::workspace::Workspace;
use wasm_bindgen_test::*;

/// Attach a workspace over a named database, as the worker does at boot.
///
/// The tree is global, so each case starts by dropping whatever the last one
/// left behind.
fn open(name: &str) {
    vfs::detach();
    vfs::attach(Box::new(Workspace::open(name).expect("a workspace database")));
}

#[wasm_bindgen_test]
fn files_survive_being_reopened() {
    open("reopen.db");
    vfs::write("/skills/demo/SKILL.md", "# demo").unwrap();
    // Bytes, not text: an upload can be a PNG, and this tree holds those now.
    vfs::write("/runtime/uploads/logo.png", [0x89, b'P', b'N', b'G', 0x0d]).unwrap();

    open("reopen.db");

    assert_eq!(vfs::read_to_string("/skills/demo/SKILL.md").unwrap(), "# demo");
    assert_eq!(
        vfs::read("/runtime/uploads/logo.png").unwrap(),
        vec![0x89, b'P', b'N', b'G', 0x0d]
    );
    assert!(
        vfs::is_dir("/skills/demo"),
        "the directories a write created must come back too, or read_dir finds nothing"
    );
    let listed: Vec<_> = vfs::read_dir("/skills")
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    assert_eq!(listed, vec![std::path::PathBuf::from("/skills/demo")]);
}

/// The registry decides a skill changed by comparing `(size, modified)`. If the
/// counter behind `modified` restarted at zero on reload, a file written before
/// it would look newer than one written after, and an edit would go unnoticed.
#[wasm_bindgen_test]
fn a_reload_does_not_rewind_the_write_counter() {
    open("counter.db");
    vfs::write("/a.txt", "one").unwrap();
    let before = vfs::metadata("/a.txt").unwrap().modified().unwrap();

    open("counter.db");
    assert_eq!(
        vfs::metadata("/a.txt").unwrap().modified().unwrap(),
        before,
        "the stored file came back with a different age than it was written with"
    );

    vfs::write("/b.txt", "two").unwrap();
    assert!(
        vfs::metadata("/b.txt").unwrap().modified().unwrap() > before,
        "a file written after the reload looks older than one written before it"
    );
}

#[wasm_bindgen_test]
fn deleting_a_skill_deletes_it_from_storage_too() {
    open("delete.db");
    vfs::write("/skills/gone/SKILL.md", "# gone").unwrap();
    vfs::write("/skills/gone/scripts/run.py", "print(1)").unwrap();
    vfs::write("/skills/kept/SKILL.md", "# kept").unwrap();

    vfs::remove_dir_all("/skills/gone").unwrap();
    assert!(!vfs::exists("/skills/gone/scripts/run.py"));

    open("delete.db");
    assert!(
        !vfs::exists("/skills/gone"),
        "an uninstalled skill came back after a reload"
    );
    assert!(vfs::exists("/skills/kept/SKILL.md"), "the wrong subtree went");
}

#[wasm_bindgen_test]
fn one_file_removed_leaves_its_neighbours() {
    open("one-file.db");
    vfs::write("/notes/a.md", "a").unwrap();
    vfs::write("/notes/b.md", "b").unwrap();

    vfs::remove_file("/notes/a.md").unwrap();
    assert!(vfs::remove_file("/notes").is_err(), "a directory is not a file");
    assert!(vfs::remove_file("/notes/a.md").is_err(), "and it is already gone");

    open("one-file.db");
    assert!(!vfs::exists("/notes/a.md"));
    assert_eq!(vfs::read_to_string("/notes/b.md").unwrap(), "b");
}

#[wasm_bindgen_test]
fn a_file_that_is_not_text_says_so_rather_than_mangling_itself() {
    open("binary.db");
    vfs::write("/image.png", [0xff, 0xd8, 0xff]).unwrap();

    // The file tools ask for text. Replacement characters would look like a
    // successful read of a corrupt file, which is the worse answer.
    let e = vfs::read_to_string("/image.png").expect_err("binary is not text");
    assert_eq!(e.kind(), std::io::ErrorKind::InvalidData);
}

#[wasm_bindgen_test]
fn a_workspace_is_per_namespace_like_the_session_store() {
    // One origin now serves the page for every gateway; without this, one
    // gateway's skills would show up on another's.
    assert_eq!(
        agent_web_core::storage::workspace_db_name(None),
        "workspace.db"
    );
    assert_eq!(
        agent_web_core::storage::workspace_db_name(Some("192.168.1.104:60000")),
        "workspace-192-168-1-104-60000.db"
    );
    assert_ne!(
        agent_web_core::storage::workspace_db_name(Some("a")),
        agent_web_core::storage::db_name(Some("a")),
        "the workspace and the sessions must not land in one file"
    );
}
