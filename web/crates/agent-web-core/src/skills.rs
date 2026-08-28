//! Skills, installed into the workspace.
//!
//! The registry itself is vendored and already runs here: `skill.rs`'s twenty
//! `std::fs` calls were redirected to [`crate::vfs`] when it was brought over,
//! so it scans, parses and hot-reloads over the page's own tree. What was
//! missing was everything around it — somewhere to put a skill, the routes the
//! management page calls, and the registry reaching the turn at all.
//!
//! Installing is upstream's validation chain, which is worth following exactly:
//! a zip is bounded (entries, decompressed size), refused if any path escapes,
//! parsed as a skill before anything is moved, and only then put in place.
//! Upstream stages into a temp dir on the same filesystem for atomicity, and so
//! does this — [`crate::files::TMP`] — because a package that fails validation
//! half way must not leave a partial skill behind.
//!
//! Upstream's two writable-directory concepts collapse into one here. There is
//! no bundle of built-in skills to shadow and no read-only workspace directory:
//! everything under `skills/` arrived through this module, so everything is
//! deletable and nothing is `builtin`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::answer::Refused;
use crate::skill::{is_reset_skill_name, is_valid_skill_name, SkillRegistry};
use crate::tool::ToolRegistry;

/// Upstream's caps, and for the same reason: a zip declares its decompressed
/// size, so a small download can ask for an unbounded write.
const MAX_PACKAGE: usize = 25 * 1024 * 1024;
const MAX_UNPACKED: u64 = 50 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;

/// Build the registry over the workspace and register `read_skill`.
///
/// The scan happens in `SkillRegistry::new`, so the workspace has to be
/// hydrated before this is called — which it is: `open_workspace` runs before
/// the host is built.
pub fn install(registry: &ToolRegistry) -> Arc<SkillRegistry> {
    let skills = SkillRegistry::new(vec![PathBuf::from(crate::files::SKILLS)]);
    skills.attach_state(PathBuf::from(crate::files::SKILL_STATE));
    registry.register(Arc::new(crate::skill::ReadSkillTool::new(skills.clone())));
    skills
}

/// What `GET /api/skills` answers.
///
/// Upstream's fields, minus the two that describe a distinction this does not
/// have: every skill here lives in the one writable directory, so `builtin` is
/// always false and `deletable` always true. They are still sent, because the
/// management page reads them to decide which buttons to draw.
pub fn listing(skills: &SkillRegistry) -> serde_json::Value {
    let installed: Vec<serde_json::Value> = skills
        .list()
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "name": s.name,
                "description": s.description,
                "when_to_use": s.when_to_use,
                "allowed_tools": s.allowed_tools,
                "argument_hint": s.argument_hint,
                "version": s.version,
                "author": s.author,
                "env": s.env,
                "disable_model_invocation": s.disable_model_invocation,
                "user_invocable": s.user_invocable,
                "dir": s.dir.to_string_lossy(),
                "enabled": !skills.is_disabled(&s.name),
                "pinned": skills.is_pinned(&s.name),
                "shared": skills.is_shared(&s.name),
                "builtin": false,
                "deletable": true,
                "has_icon": s.icon.is_some(),
            })
        })
        .collect();

    let diagnostics: Vec<serde_json::Value> = skills
        .diagnostics()
        .into_iter()
        .map(|d| {
            serde_json::json!({
                "kind": d.kind,
                "path": d.path.to_string_lossy(),
                "message": d.message,
            })
        })
        .collect();

    serde_json::json!({ "skills": installed, "diagnostics": diagnostics })
}

/// A skill's icon: the bytes and what to serve them as.
pub fn icon(skills: &SkillRegistry, name: &str) -> Option<(Vec<u8>, &'static str)> {
    let path = skills.get(name)?.icon?;
    let bytes = crate::vfs::read(&path).ok()?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Some((bytes, mime))
}

/// What an install reports back: the name it went in under, and whatever the
/// authoring lint had to say about it.
#[derive(Debug, Serialize)]
pub struct Installed {
    pub name: String,
    pub diagnostics: Vec<String>,
}

/// What a package says about itself, without installing it.
///
/// The market's detail dialog asks for this. Upstream reads it off its own copy
/// of the repository; here the browser has already downloaded the zip to hand
/// it over, so the answer comes out of the bytes it is holding.
#[derive(Debug, Serialize)]
pub struct Preview {
    pub readme: String,
    pub changelog: Option<String>,
}

/// Install a skill package. Replaces an installed skill of the same name.
pub fn import(skills: &SkillRegistry, bytes: &[u8]) -> Result<Installed, Refused> {
    let staged = stage(bytes)?;
    let outcome = finish(skills, &staged);
    let _ = crate::vfs::remove_dir_all(&staged);
    outcome
}

/// Read a package's documentation without installing it.
pub fn preview(bytes: &[u8]) -> Result<Preview, Refused> {
    let staged = stage(bytes)?;
    let dir = skill_dir(&staged).ok_or_else(|| Refused::bad("archive has no SKILL.md"))?;
    let readme = crate::vfs::read_to_string(dir.join("SKILL.md"))
        .map_err(|e| Refused::bad(format!("cannot read SKILL.md: {e}")))?;
    let changelog = crate::vfs::read_to_string(dir.join("CHANGELOG.md")).ok();
    let _ = crate::vfs::remove_dir_all(&staged);
    Ok(Preview { readme, changelog })
}

/// Remove an installed skill.
///
/// The enable/pin/share flags go with it, so a later reinstall starts from the
/// defaults rather than inheriting decisions about a skill the user deleted.
pub fn delete(skills: &SkillRegistry, name: &str) -> Result<(), Refused> {
    let skill = skills
        .get(name)
        .ok_or_else(|| Refused::missing(format!("no skill named '{name}'")))?;
    crate::vfs::remove_dir_all(&skill.dir)
        .map_err(|e| Refused::broken(format!("could not delete: {e}")))?;
    skills.set_enabled(name, true);
    skills.set_pinned(name, false);
    skills.set_shared(name, true);
    skills.scan();
    Ok(())
}

/// Unpack a package into its own staging directory, bounded.
fn stage(bytes: &[u8]) -> Result<PathBuf, Refused> {
    if bytes.is_empty() {
        return Err(Refused::bad("empty body"));
    }
    if bytes.len() > MAX_PACKAGE {
        return Err(Refused::too_large(format!(
            "package exceeds {}MB",
            MAX_PACKAGE / (1024 * 1024)
        )));
    }
    let into = PathBuf::from(crate::files::TMP).join(format!("import-{}", uuid::Uuid::new_v4()));
    match unpack(bytes, &into) {
        Ok(()) => Ok(into),
        Err(e) => {
            let _ = crate::vfs::remove_dir_all(&into);
            Err(e)
        }
    }
}

/// Validate what was staged and put it in place.
fn finish(skills: &SkillRegistry, staged: &Path) -> Result<Installed, Refused> {
    let dir = skill_dir(staged).ok_or_else(|| Refused::bad("archive has no SKILL.md"))?;
    let skill = crate::skill::parse_skill_dir(&dir)
        .map_err(|e| Refused::bad(format!("invalid SKILL.md: {e}")))?;
    let name = skill.name;

    if !is_valid_skill_name(&name) {
        return Err(Refused::bad(format!(
            "invalid skill name '{name}' (want ^[a-z0-9-]{{1,64}}$)"
        )));
    }
    if is_reset_skill_name(&name) {
        return Err(Refused::conflict(format!(
            "'{name}' is a reserved name (reset/none)"
        )));
    }

    let diagnostics = crate::skill::lint_skill(&dir);

    let home = PathBuf::from(crate::files::SKILLS).join(&name);
    if crate::vfs::exists(&home) {
        crate::vfs::remove_dir_all(&home)
            .map_err(|e| Refused::broken(format!("could not replace '{name}': {e}")))?;
    }
    copy_tree(&dir, &home).map_err(|e| Refused::broken(format!("could not install: {e}")))?;

    // The registry hot-reloads on a fingerprint of the tree, and a package
    // written and read in the same tick can land inside its debounce window.
    // Rescanning is cheap and makes the response describe what is actually
    // installed.
    skills.scan();
    Ok(Installed { name, diagnostics })
}

/// Where the skill lives inside an unpacked package: the root when it holds a
/// `SKILL.md`, otherwise the first subdirectory that does.
fn skill_dir(root: &Path) -> Option<PathBuf> {
    if crate::vfs::is_file(root.join("SKILL.md")) {
        return Some(root.to_path_buf());
    }
    let mut dirs: Vec<PathBuf> = crate::vfs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| crate::vfs::is_dir(p))
        .collect();
    dirs.sort();
    dirs.into_iter()
        .find(|d| crate::vfs::is_file(d.join("SKILL.md")))
}

/// Extract a zip into the workspace.
///
/// Two things make this safe to point at a tree that also holds the session's
/// files: `enclosed_name` returns nothing for an absolute or `..`-climbing
/// entry, and the caps bound what a small download can ask to be written.
fn unpack(bytes: &[u8], dest: &Path) -> Result<(), Refused> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| Refused::bad(format!("not a valid zip: {e}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(Refused::bad(format!(
            "archive has too many entries ({} > {MAX_ENTRIES})",
            archive.len()
        )));
    }

    crate::vfs::create_dir_all(dest).map_err(|e| Refused::broken(e.to_string()))?;

    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| Refused::bad(format!("cannot read entry {i}: {e}")))?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(Refused::bad(format!(
                "unsafe path in archive: {}",
                entry.name()
            )));
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            crate::vfs::create_dir_all(&out).map_err(|e| Refused::broken(e.to_string()))?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNPACKED {
            return Err(Refused::too_large("archive too large when decompressed"));
        }
        let mut body = Vec::with_capacity(entry.size() as usize);
        std::io::copy(&mut entry, &mut body)
            .map_err(|e| Refused::bad(format!("cannot decompress {}: {e}", entry.name())))?;
        crate::vfs::write(&out, body).map_err(|e| Refused::broken(e.to_string()))?;
    }
    Ok(())
}

/// Copy a directory tree. Stands in for the rename upstream does: the workspace
/// has no rename, and at these sizes the difference is not worth an API.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    crate::vfs::create_dir_all(dst)?;
    for entry in crate::vfs::read_dir(src)?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if crate::vfs::is_dir(&from) {
            copy_tree(&from, &to)?;
        } else {
            crate::vfs::write(&to, crate::vfs::read(&from)?)?;
        }
    }
    Ok(())
}
