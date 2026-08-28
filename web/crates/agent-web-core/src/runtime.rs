//! What the Runtime Cache card reports, and what its Clear button empties.
//!
//! Upstream this measures directories on the machine the agent runs on. The
//! shape survives the move intact, because [`crate::files`] keeps upstream's
//! layout: `runtime/drafts`, `runtime/uploads` and `runtime/tmp` are real
//! directories here too, just in [`crate::vfs`] rather than on a disk. So the
//! card is one of the few settings features that means the same thing in a tab
//! as it does on a host — it reports the workspace, which is the only storage
//! this build has, and clearing it reclaims real IndexedDB space.
//!
//! Export is the half that did not survive: the button is a `window.open` of
//! `/api/runtime/export`, and a navigation does not go through the fetch shim,
//! so it would leave the page and ask the gateway for a route it does not have.
//! `app/capabilities.css` hides those buttons.

use std::path::Path;

use serde::Serialize;

use crate::answer::Refused;

/// The categories the card lists, in its order.
///
/// `downloads` has no directory here — nothing in a tab downloads to one — but
/// it is reported at zero rather than left out: the card renders its row from
/// its own list either way, and an absent entry draws an em dash where a
/// truthful "0 B" belongs.
///
/// Upstream's fifth, `public`, is missing on purpose. Publishing needs a server
/// to serve what was published, so there is no such directory here and no
/// releases page to manage it from.
const CATEGORIES: [(&str, &str); 4] = [
    ("drafts", crate::files::DRAFTS),
    ("downloads", "/runtime/downloads"),
    ("uploads", crate::files::UPLOADS),
    ("tmp", crate::files::TMP),
];

/// Where the card says all this lives. A workspace path, and a real one:
/// `list_files("/runtime")` answers from the same tree.
const ROOT: &str = "/runtime";

/// `GET /api/runtime/stat[?category=]`: size and file count per category.
pub fn stat(category: Option<&str>) -> serde_json::Value {
    let mut categories = serde_json::Map::new();
    for (name, path) in CATEGORIES {
        if category.is_some_and(|only| only != name) {
            continue;
        }
        let (size_bytes, file_count) = measure(Path::new(path));
        categories.insert(
            name.to_string(),
            serde_json::json!({
                "path": path,
                "size_bytes": size_bytes,
                "file_count": file_count,
                // Always null. The workspace stamps a file with a write
                // counter rather than a clock (see `vfs::Metadata::modified`),
                // and a counter rendered as a date reads as 1970.
                "last_modified": serde_json::Value::Null,
            }),
        );
    }
    serde_json::json!({ "root": ROOT, "categories": categories })
}

#[derive(Serialize)]
pub struct Cleared {
    pub reclaimed_bytes: u64,
    pub cleared: Vec<&'static str>,
}

/// `POST /api/runtime/clear`: empty these categories, or all of them when the
/// list is empty. Answers the bytes reclaimed.
///
/// An unknown name is ignored rather than refused, as upstream does: the card
/// sends one of its own ids, so a name from anywhere else is not a request to
/// argue with.
pub fn clear(requested: &[String]) -> Result<Cleared, Refused> {
    let mut reclaimed = 0;
    let mut cleared = Vec::new();
    for (name, path) in CATEGORIES {
        if !requested.is_empty() && !requested.iter().any(|r| r == name) {
            continue;
        }
        // Nothing to reclaim, and creating the directory just to leave it empty
        // would put a folder in the workspace that nothing ever writes to.
        if !crate::vfs::exists(path) {
            continue;
        }
        let (size, _) = measure(Path::new(path));
        reclaimed += size;
        crate::vfs::remove_dir_all(path).map_err(|e| Refused::broken(e.to_string()))?;
        // Recreated, because `list_files` on a directory that was never created
        // reports "path not found" — which reads as a broken tool rather than
        // as an empty folder. Same reason `files::prepare` exists.
        crate::vfs::create_dir_all(path).map_err(|e| Refused::broken(e.to_string()))?;
        cleared.push(name);
    }
    Ok(Cleared {
        reclaimed_bytes: reclaimed,
        cleared,
    })
}

/// Total bytes and file count under `dir`, recursively.
///
/// A directory that is not there measures zero rather than failing: the card
/// treats absence as nothing to clean up, which is also what it looks like to
/// the user.
fn measure(dir: &Path) -> (u64, u64) {
    let Ok(entries) = crate::vfs::read_dir(dir) else {
        return (0, 0);
    };
    let mut size = 0;
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if crate::vfs::is_dir(&path) {
            let (s, c) = measure(&path);
            size += s;
            count += c;
        } else if let Ok(meta) = crate::vfs::metadata(&path) {
            size += meta.len();
            count += 1;
        }
    }
    (size, count)
}
