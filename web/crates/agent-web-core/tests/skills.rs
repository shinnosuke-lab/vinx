//! Installing a skill into the page's own workspace.
//!
//! The registry lives in the forked engine and has its own tests upstream,
//! which the fork does not carry. What is ours is the install path — a zip
//! arriving from a file picker or a repository — so that is what these cover,
//! and in particular the two things that make it safe to point at a tree that
//! also holds the user's files: a package cannot write outside where it is
//! staged, and it cannot ask for unbounded space.

#![cfg(feature = "sqlite")]

use std::io::Write;
use std::sync::Arc;

use agent_web_core::skill::SkillRegistry;
use agent_web_core::tool::ToolRegistry;
use agent_web_core::{skills, vfs};
use wasm_bindgen_test::*;

fn workspace() -> Arc<SkillRegistry> {
    vfs::detach();
    agent_web_core::files::prepare();
    skills::install(&ToolRegistry::new())
}

/// A package, built the way a skill author's `zip` would build one.
fn package(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options: zip::write::FileOptions<()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in entries {
        writer.start_file(*name, options).unwrap();
        writer.write_all(body).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// The smallest thing the parser accepts as a skill.
fn skill_md(name: &str, version: &str) -> Vec<u8> {
    format!(
        "---\nname: {name}\ndescription: a test skill\nversion: {version}\n---\n\n# {name}\n\nDo the thing.\n"
    )
    .into_bytes()
}

#[wasm_bindgen_test]
async fn an_installed_package_becomes_a_skill_the_registry_can_see() {
    let registry = workspace();
    let installed = skills::import(
        &registry,
        &package(&[
            ("demo/SKILL.md", &skill_md("demo", "1.0.0")),
            ("demo/CHANGELOG.md", b"# 1.0.0\n"),
            ("demo/reference.md", b"details\n"),
        ]),
    )
    .unwrap();

    assert_eq!(installed.name, "demo");

    let skill = registry.get("demo").expect("the registry rescanned");
    assert_eq!(skill.version.as_deref(), Some("1.0.0"));
    assert_eq!(skill.description, "a test skill");

    // The whole package comes along, not just the manifest: `read_skill` serves
    // the rest of the files on demand.
    assert!(vfs::is_file("/skills/demo/reference.md"));

    let listed = skills::listing(&registry);
    assert_eq!(listed["skills"][0]["name"], "demo");
    assert_eq!(listed["skills"][0]["enabled"], true);
    assert_eq!(
        listed["skills"][0]["deletable"], true,
        "everything here arrived through an install, so all of it can go"
    );
}

/// A package that names `../` would otherwise write wherever it liked — into
/// another skill, or over the session's own files.
#[wasm_bindgen_test]
async fn a_package_cannot_write_outside_where_it_is_staged() {
    let registry = workspace();
    vfs::write("/notes.md", b"mine".to_vec()).unwrap();

    let refused = skills::import(
        &registry,
        &package(&[
            ("demo/SKILL.md", &skill_md("demo", "1.0.0")),
            ("../../notes.md", b"theirs"),
        ]),
    )
    .unwrap_err();

    assert_eq!(refused.status, 400);
    assert!(refused.message.contains("unsafe path"), "{}", refused.message);
    assert_eq!(vfs::read_to_string("/notes.md").unwrap(), "mine");
    assert!(registry.get("demo").is_none(), "a refused package installs nothing");
}

/// A zip declares how big each entry becomes, so a small download can ask for
/// an unbounded write. The cap is on the sum, checked as it goes.
#[wasm_bindgen_test]
async fn a_package_cannot_ask_for_unbounded_space() {
    let registry = workspace();
    let refused = skills::import(
        &registry,
        &package(&[
            ("demo/SKILL.md", &skill_md("demo", "1.0.0")),
            // Compresses to almost nothing; expands to more than the cap.
            ("demo/filler.bin", &vec![0u8; 60 * 1024 * 1024]),
        ]),
    )
    .unwrap_err();

    assert_eq!(refused.status, 413);
    assert!(registry.get("demo").is_none());
}

#[wasm_bindgen_test]
async fn what_is_not_a_skill_says_so_rather_than_installing_half_of_itself() {
    let registry = workspace();

    let empty = skills::import(&registry, b"").unwrap_err();
    assert_eq!(empty.status, 400);

    let garbage = skills::import(&registry, b"this is not a zip").unwrap_err();
    assert_eq!(garbage.status, 400);

    let no_manifest = skills::import(&registry, &package(&[("demo/README.md", b"hi")])).unwrap_err();
    assert!(no_manifest.message.contains("SKILL.md"), "{}", no_manifest.message);

    // `reset` and `none` turn a skill off in the palette, so a skill by that
    // name could never be selected.
    let reserved = skills::import(&registry, &package(&[("s/SKILL.md", &skill_md("reset", "1.0.0"))]))
        .unwrap_err();
    assert_eq!(reserved.status, 409);

    assert!(skills::listing(&registry)["skills"].as_array().unwrap().is_empty());
}

/// Reinstalling is how a skill is updated, and the old copy has to go: files
/// dropped in the new version would otherwise linger and still be read.
#[wasm_bindgen_test]
async fn installing_over_a_skill_replaces_it_rather_than_merging() {
    let registry = workspace();
    skills::import(
        &registry,
        &package(&[
            ("demo/SKILL.md", &skill_md("demo", "1.0.0")),
            ("demo/gone.md", b"old\n"),
        ]),
    )
    .unwrap();

    skills::import(&registry, &package(&[("demo/SKILL.md", &skill_md("demo", "2.0.0"))])).unwrap();

    assert_eq!(registry.get("demo").unwrap().version.as_deref(), Some("2.0.0"));
    assert!(!vfs::exists("/skills/demo/gone.md"));
    assert_eq!(skills::listing(&registry)["skills"].as_array().unwrap().len(), 1);
}

/// The archive stays where it was downloaded to only for as long as it takes to
/// validate it; a workspace that accumulated every install would fill up.
#[wasm_bindgen_test]
async fn nothing_is_left_behind_in_the_staging_area() {
    let registry = workspace();
    skills::import(&registry, &package(&[("demo/SKILL.md", &skill_md("demo", "1.0.0"))])).unwrap();
    let _ = skills::import(&registry, b"not a zip");
    let _ = skills::preview(&package(&[("demo/SKILL.md", &skill_md("demo", "1.0.0"))]));

    let staged = vfs::read_dir(agent_web_core::files::TMP).unwrap().flatten().count();
    assert_eq!(staged, 0, "an import leaves the staging area as it found it");
}

#[wasm_bindgen_test]
async fn a_preview_reads_a_package_without_installing_it() {
    let registry = workspace();
    let bytes = package(&[
        ("demo/SKILL.md", &skill_md("demo", "1.0.0")),
        ("demo/CHANGELOG.md", b"# 1.0.0\n\nFirst.\n"),
    ]);

    let preview = skills::preview(&bytes).unwrap();
    assert!(preview.readme.contains("Do the thing."));
    assert_eq!(preview.changelog.as_deref(), Some("# 1.0.0\n\nFirst.\n"));

    registry.scan();
    assert!(registry.get("demo").is_none(), "a preview must not install");

    // A package with no changelog reads as none, which is what makes the UI
    // hide the tab rather than show an empty one.
    let bare = skills::preview(&package(&[("demo/SKILL.md", &skill_md("demo", "1.0.0"))])).unwrap();
    assert!(bare.changelog.is_none());
}

/// The flags outlive a scan — they are the user's decisions, not the package's
/// — but they must not outlive the skill itself.
#[wasm_bindgen_test]
async fn deleting_a_skill_takes_its_switches_with_it() {
    let registry = workspace();
    let bytes = package(&[("demo/SKILL.md", &skill_md("demo", "1.0.0"))]);
    skills::import(&registry, &bytes).unwrap();

    registry.set_enabled("demo", false);
    registry.set_pinned("demo", true);
    let listed = skills::listing(&registry);
    assert_eq!(listed["skills"][0]["enabled"], false);
    assert_eq!(listed["skills"][0]["pinned"], true);
    assert!(
        vfs::exists("/skills-state.json"),
        "the flags have to survive a reload"
    );

    skills::delete(&registry, "demo").unwrap();
    assert!(!vfs::exists("/skills/demo"));
    assert!(skills::listing(&registry)["skills"].as_array().unwrap().is_empty());

    skills::import(&registry, &bytes).unwrap();
    let reinstalled = skills::listing(&registry);
    assert_eq!(
        reinstalled["skills"][0]["enabled"], true,
        "a reinstall must not inherit a decision about the copy that was deleted"
    );
    assert_eq!(reinstalled["skills"][0]["pinned"], false);

    assert_eq!(skills::delete(&registry, "demo").is_ok(), true);
    assert_eq!(skills::delete(&registry, "demo").unwrap_err().status, 404);
}

#[wasm_bindgen_test]
async fn an_icon_is_served_as_what_it_is() {
    let registry = workspace();
    skills::import(
        &registry,
        &package(&[
            ("demo/SKILL.md", &skill_md("demo", "1.0.0")),
            ("demo/icon.png", &[0x89, b'P', b'N', b'G']),
        ]),
    )
    .unwrap();

    assert_eq!(skills::listing(&registry)["skills"][0]["has_icon"], true);
    let (bytes, mime) = skills::icon(&registry, "demo").expect("the package shipped one");
    assert_eq!(bytes, vec![0x89, b'P', b'N', b'G']);
    assert_eq!(mime, "image/png");

    skills::import(&registry, &package(&[("bare/SKILL.md", &skill_md("bare", "1.0.0"))])).unwrap();
    assert!(skills::icon(&registry, "bare").is_none());
    assert!(skills::icon(&registry, "absent").is_none());
}
