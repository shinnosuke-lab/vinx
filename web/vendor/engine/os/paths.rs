//! `SafePathAllowList` — a directory allow-list for `write_file` / `edit_file`.
//!
//! This gates writes/edits by **directory
//! prefix**: once a folder is allow-listed (via the confirm-bar "allow this
//! folder" button), any write/edit whose target lives inside it downgrades to
//! `Safe` (no confirmation). Empty list = every write/edit needs confirmation.
//!
//! Entries are stored canonicalized so prefix matching is reliable; the list is
//! capped FIFO at [`MAX_SAFE_PATHS`], de-duplicated, and persisted to a sidecar
//! JSON file so all sessions share one list and it survives restarts.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Upper bound on the directory allow-list (mirrors the command list's cap).
pub const MAX_SAFE_PATHS: usize = 200;

/// Allow-listed write/edit directories.
pub struct SafePathAllowList {
    /// Canonicalized directory prefixes.
    allowed: RwLock<Vec<PathBuf>>,
    /// Sidecar path for the list (`<data_dir>/safe_paths.json`). `None` keeps
    /// the list in-memory only.
    sidecar: Option<PathBuf>,
}

/// Canonicalize a path that should denote a directory. Returns the canonical
/// directory when it exists (a file path collapses to its parent dir).
fn canonical_dir(path: &str) -> Option<PathBuf> {
    let p = Path::new(path.trim());
    if p.as_os_str().is_empty() {
        return None;
    }
    let canon = crate::vfs::canonicalize(p).ok()?;
    if crate::vfs::is_dir(&canon) {
        Some(canon)
    } else {
        canon.parent().map(|x| x.to_path_buf())
    }
}

/// Canonical parent directory of a (possibly non-existent) write/edit target.
/// Deliberately STRICTER than [`OsPolicy::check_write`](crate::os::OsPolicy::check_write)
/// (which accepts a not-yet-existing directory chain): a target whose parent
/// does not exist yet never matches the allow-list, so brand-new directories
/// always go through confirmation even inside a trusted folder.
fn canonical_parent_of(target: &str) -> Option<PathBuf> {
    let p = Path::new(target.trim());
    if p.as_os_str().is_empty() {
        return None;
    }
    if let Ok(canon) = crate::vfs::canonicalize(p) {
        // Existing target: a dir is its own prefix, a file uses its parent.
        return if crate::vfs::is_dir(&canon) {
            Some(canon)
        } else {
            canon.parent().map(|x| x.to_path_buf())
        };
    }
    // New file: resolve the (existing) parent directory.
    let parent = p
        .parent()
        .filter(|pp| !pp.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    crate::vfs::canonicalize(parent).ok()
}

impl SafePathAllowList {
    /// Load any previously-learned directories from `sidecar` (ignored when
    /// missing/unreadable; entries that no longer resolve are dropped).
    pub fn new(sidecar: Option<PathBuf>) -> Self {
        let allowed = sidecar
            .as_ref()
            .and_then(|p| crate::vfs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|s| canonical_dir(&s))
            .collect::<Vec<_>>();
        Self {
            allowed: RwLock::new(dedup(allowed)),
            sidecar,
        }
    }

    /// True when a write/edit `target` lives inside an allow-listed directory.
    pub fn is_allowed_for(&self, target: &str) -> bool {
        let Some(parent) = canonical_parent_of(target) else {
            return false;
        };
        self.allowed
            .read()
            .map(|l| l.iter().any(|root| parent.starts_with(root)))
            .unwrap_or(false)
    }

    /// Learn a directory (canonicalized). Returns `true` when newly added.
    /// No-op for unresolvable paths or duplicates; evicts the oldest past
    /// [`MAX_SAFE_PATHS`] and persists to the sidecar.
    pub fn learn(&self, dir: &str) -> bool {
        let Some(canon) = canonical_dir(dir) else {
            return false;
        };
        let mut allowed = match self.allowed.write() {
            Ok(l) => l,
            Err(_) => return false,
        };
        if allowed.iter().any(|d| d == &canon) {
            return false;
        }
        allowed.push(canon);
        while allowed.len() > MAX_SAFE_PATHS {
            allowed.remove(0);
        }
        self.persist(&allowed);
        true
    }

    /// Drop all allow-listed directories. Persists.
    pub fn clear(&self) {
        if let Ok(mut allowed) = self.allowed.write() {
            allowed.clear();
            self.persist(&allowed);
        }
    }

    /// Remove one allow-listed directory (matched canonically, falling back to a
    /// literal compare against the stored display string). Returns `true` when
    /// removed.
    pub fn remove(&self, dir: &str) -> bool {
        let canon = canonical_dir(dir);
        let raw = dir.trim();
        let Ok(mut allowed) = self.allowed.write() else {
            return false;
        };
        let before = allowed.len();
        allowed.retain(|d| {
            if let Some(c) = &canon {
                d != c
            } else {
                d.to_string_lossy() != raw
            }
        });
        let changed = allowed.len() != before;
        if changed {
            self.persist(&allowed);
        }
        changed
    }

    /// Snapshot of the allow-listed directories (display strings) for the
    /// management endpoint.
    pub fn snapshot(&self) -> Vec<String> {
        self.allowed
            .read()
            .map(|l| l.iter().map(|p| p.to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    }

    fn persist(&self, allowed: &[PathBuf]) {
        if let Some(p) = &self.sidecar {
            if let Some(parent) = p.parent() {
                let _ = crate::vfs::create_dir_all(parent);
            }
            let as_strings: Vec<String> = allowed
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if let Ok(json) = serde_json::to_string_pretty(&as_strings) {
                let _ = crate::vfs::write(p, json);
            }
        }
    }
}

fn dedup(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for p in paths {
        if !out.iter().any(|e| e == &p) {
            out.push(p);
        }
    }
    out
}
