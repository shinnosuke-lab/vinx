//! Saved looks: the theme half of agent-core's `releases`, over the VFS.
//!
//! Upstream's module is about everything an agent puts out into the world —
//! published files, installed apps, saved themes. Only the last of those means
//! anything in a page, so only that is here, under upstream's own names and
//! layout (`themes/<name>/plugin.css`, `plugin.js`, `meta.json`, and an
//! `active` pointer beside them). Keeping the names is what lets the vendored
//! `set_chat_style` compile against this without a patch, and what would let a
//! workspace exported from here drop into an agent-core install.
//!
//! Theme **assets** are the one thing answered rather than emulated. Upstream
//! copies a look's images into the theme and serves them at `/theme/assets/…`;
//! that path is not under `/api/`, so the fetch shim never sees it, and a
//! stylesheet's `url()` does not go through `fetch` in the first place. Rather
//! than serve a URL that would 404, the tool is built without a read policy —
//! which is upstream's own way of saying a deployment has nowhere to put them,
//! and makes it stop advertising the parameter. The functions below therefore
//! exist to satisfy the call sites, and say so.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The active-theme pointer, a file beside the theme directories. `active` is
/// thus a reserved theme name.
pub const ACTIVE_POINTER: &str = "active";

/// Written into the pointer by "restore the built-in look". Distinct from an
/// absent pointer, which still falls back to a `default` slot.
pub const NO_THEME_SENTINEL: &str = ".none";

/// The name is the directory name and the card label both.
pub const MAX_THEME_NAME_CHARS: usize = 64;

/// Where a page-only look's assets would be staged upstream. Named for the
/// vendored tool, which clears it; nothing here ever writes it.
pub const PREVIEW_SLOT: &str = ".preview";

/// Per-theme metadata, `<themes>/<name>/meta.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThemeMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub css_bytes: u64,
    #[serde(default)]
    pub js_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Representative colours for the card's swatch, as the model reported
    /// them — the CSS itself goes through `hsl(var(--egg-h) …)` indirection, so
    /// they cannot be read back out of it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub palette: Vec<String>,
    /// Keys this build does not know, kept verbatim across a re-save.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One saved look's injectable payload — a row of `GET /api/themes`.
#[derive(Debug, Clone, Serialize)]
pub struct ThemeContent {
    pub name: String,
    pub css: String,
    pub js: String,
}

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

/// One plain path component: no directories, no traversal, not hidden.
///
/// Upstream's rule for anything whose name becomes a served path. It is public
/// because the vendored style tool validates asset names with it.
pub fn is_safe_public_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && name != ".."
}

/// ADMISSION: may a *new* theme be created under this name?
pub fn is_safe_theme_name(name: &str) -> bool {
    is_safe_public_name(name)
        && name != ACTIVE_POINTER
        && name.chars().count() <= MAX_THEME_NAME_CHARS
        && !name.chars().any(char::is_control)
}

/// ADDRESSING: may this name refer to a theme that already exists?
///
/// Looser than admission on purpose, and upstream's reasoning carries over: a
/// slot created under an older rule must stay switchable and deletable, or the
/// user is left with a card they can see and not touch.
fn is_addressable_theme_name(name: &str) -> bool {
    is_safe_public_name(name) && name != ACTIVE_POINTER
}

/// Persist (or replace) one look. The directory is the registration; removing
/// it is the uninstall.
pub fn write_theme(
    root: &Path,
    name: &str,
    css: &str,
    js: &str,
    session_id: Option<&str>,
    description: Option<&str>,
    palette: &[String],
) -> std::io::Result<()> {
    let name = name.trim();
    if name == ACTIVE_POINTER {
        return Err(invalid(
            "theme name 'active' is reserved (the active-theme pointer)",
        ));
    }
    if !is_safe_theme_name(name) {
        return Err(invalid("invalid theme name"));
    }
    let dir = root.join(name);
    // Read-modify-write: a re-save replaces the payload but must not reset the
    // slot's identity. `created_at` is when the look was first kept.
    let prior: Option<ThemeMeta> = crate::vfs::read_to_string(dir.join("meta.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    crate::vfs::create_dir_all(&dir)?;
    crate::vfs::write(dir.join("plugin.css"), css.as_bytes().to_vec())?;
    if js.trim().is_empty() {
        let _ = crate::vfs::remove_file(dir.join("plugin.js"));
    } else {
        crate::vfs::write(dir.join("plugin.js"), js.as_bytes().to_vec())?;
    }

    let meta = ThemeMeta {
        session_id: session_id.map(str::to_string),
        created_at: prior
            .as_ref()
            .map(|p| p.created_at.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        css_bytes: css.len() as u64,
        js_bytes: js.len() as u64,
        description: description
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| prior.as_ref().and_then(|p| p.description.clone())),
        palette: palette.to_vec(),
        extra: prior.map(|p| p.extra).unwrap_or_default(),
    };
    crate::vfs::write(
        dir.join("meta.json"),
        serde_json::to_vec_pretty(&meta).unwrap_or_default(),
    )
}

/// Delete a saved look. Answers whether there was one.
pub fn remove_theme(root: &Path, name: &str) -> std::io::Result<bool> {
    if !is_addressable_theme_name(name) {
        return Err(invalid("invalid theme name"));
    }
    let dir = root.join(name);
    let existed = crate::vfs::is_file(dir.join("plugin.css"));
    if crate::vfs::is_dir(&dir) {
        crate::vfs::remove_dir_all(&dir)?;
    }
    Ok(existed)
}

/// Every saved look's payload, by name.
pub fn read_themes(root: &Path) -> Vec<ThemeContent> {
    let mut out: Vec<ThemeContent> = directories(root)
        .into_iter()
        .filter_map(|dir| content_at(root, &dir))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The saved looks as the management page's cards, newest first.
pub fn scan_themes(root: &Path) -> Vec<serde_json::Value> {
    let mut records: Vec<(String, serde_json::Value)> = directories(root)
        .into_iter()
        .filter(|name| crate::vfs::is_file(root.join(name).join("plugin.css")))
        .map(|name| {
            let meta: ThemeMeta = crate::vfs::read_to_string(root.join(&name).join("meta.json"))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let created_at = meta.created_at.clone();
            (
                created_at.clone(),
                serde_json::json!({
                    "kind": "theme",
                    "name": name,
                    "session_id": meta.session_id,
                    "created_at": (!created_at.is_empty()).then_some(created_at),
                    "size": meta.css_bytes + meta.js_bytes,
                    "description": meta.description,
                    "palette": meta.palette,
                }),
            )
        })
        .collect();
    records.sort_by(|a, b| b.0.cmp(&a.0));
    records.into_iter().map(|(_, record)| record).collect()
}

/// The one look boot injects: the pointer when it resolves, else the historical
/// `default` slot, else none. A pointer left dangling by a hand-deleted theme
/// self-heals to that fallback.
pub fn active_theme(root: &Path) -> Option<ThemeContent> {
    content_at(root, &active_theme_name(root)?)
}

/// Point the active-theme pointer at a saved look.
pub fn set_active_theme(root: &Path, name: &str) -> std::io::Result<()> {
    let name = name.trim();
    if !is_addressable_theme_name(name) {
        return Err(invalid("invalid theme name"));
    }
    if !theme_exists(root, name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such theme",
        ));
    }
    crate::vfs::create_dir_all(root)?;
    crate::vfs::write(root.join(ACTIVE_POINTER), name.as_bytes().to_vec())
}

/// Restore the built-in look without deleting anything. Writes the sentinel
/// rather than removing the pointer, so a `default` slot does not creep back in
/// on the next reload.
pub fn deactivate_theme(root: &Path) -> std::io::Result<()> {
    crate::vfs::create_dir_all(root)?;
    crate::vfs::write(
        root.join(ACTIVE_POINTER),
        NO_THEME_SENTINEL.as_bytes().to_vec(),
    )
}

/// Drop the pointer, re-enabling the `default` fallback.
pub fn clear_active_theme(root: &Path) {
    let _ = crate::vfs::remove_file(root.join(ACTIVE_POINTER));
}

/// Drop the pointer only if it names `name`, so deleting an inactive look
/// leaves the active one selected.
pub fn clear_active_theme_if(root: &Path, name: &str) {
    if read_pointer(root).as_deref() == Some(name) {
        clear_active_theme(root);
    }
}

// ── theme assets ──
//
// Reachable but inert; see the module header for why. Each returns what its
// caller reads as "nothing was installed", which is the truth.

/// No-op: there is no overlay to clear, because nothing stages assets here.
pub fn clear_preview(_root: &Path) {}

/// No-op. Only ever called with an empty list: without a read policy the tool
/// refuses a non-empty one before reaching this.
pub fn set_preview_assets(_root: &Path, _files: &[(PathBuf, String)]) -> std::io::Result<usize> {
    Ok(0)
}

/// No-op, as [`set_preview_assets`].
pub fn set_theme_assets(
    _root: &Path,
    _name: &str,
    _files: &[(PathBuf, String)],
) -> std::io::Result<usize> {
    Ok(0)
}

/// No-op: a saved look adopts the assets of the look on screen, and there are
/// none to adopt.
pub fn adopt_assets_into(_root: &Path, _name: &str) -> std::io::Result<usize> {
    Ok(0)
}

// ── shared helpers ──

/// Directory names under the themes root, hidden ones excluded.
fn directories(root: &Path) -> Vec<String> {
    let Ok(entries) = crate::vfs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| crate::vfs::is_dir(e.path()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect()
}

fn content_at(root: &Path, name: &str) -> Option<ThemeContent> {
    let dir = root.join(name);
    Some(ThemeContent {
        name: name.to_string(),
        css: crate::vfs::read_to_string(dir.join("plugin.css")).ok()?,
        js: crate::vfs::read_to_string(dir.join("plugin.js")).unwrap_or_default(),
    })
}

fn read_pointer(root: &Path) -> Option<String> {
    let raw = crate::vfs::read_to_string(root.join(ACTIVE_POINTER)).ok()?;
    let name = raw.trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn theme_exists(root: &Path, name: &str) -> bool {
    crate::vfs::is_file(root.join(name).join("plugin.css"))
}

fn active_theme_name(root: &Path) -> Option<String> {
    let pointer = read_pointer(root);
    if pointer.as_deref() == Some(NO_THEME_SENTINEL) {
        return None;
    }
    pointer
        .filter(|name| theme_exists(root, name))
        .or_else(|| theme_exists(root, "default").then(|| "default".to_string()))
}
