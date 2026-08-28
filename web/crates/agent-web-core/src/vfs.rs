//! A filesystem for skills, in a place that has none.
//!
//! `SkillRegistry` is built on paths: it scans directories, reads `SKILL.md`,
//! resolves references relative to a skill's directory, and writes its own state
//! file. Roughly twenty call sites, all synchronous, none of which can work on
//! wasm because `std::fs` there fails every call.
//!
//! Two ways to bridge that. Rewriting the registry to take a `SkillSource` trait
//! would touch all sixty-eight path-handling sites in `skill.rs` and turn every
//! upstream edit into a merge conflict. Instead only the I/O is redirected here,
//! which is twenty sites, because `Path` and `PathBuf` are pure string algebra
//! and already work on wasm untouched.
//!
//! The API deliberately mirrors the corner of `std::fs` that the registry uses,
//! so the patch reads as a change of prefix rather than a change of logic.
//!
//! ## Why it is synchronous, and what that buys
//!
//! The registry's calls are synchronous and making them async would be that wide
//! rewrite again. So the tree is held in memory and every mutation is written
//! through to a [`Backing`] — [`crate::workspace`] in the browser — which is
//! synchronous because it is SQLite, the same SQLite the session store already
//! runs on. Reads never touch it; a write is one small statement.
//!
//! Attaching a backing is optional. Without one this is an ordinary in-memory
//! filesystem, which is what tests and a browser that refused IndexedDB get.

use std::collections::BTreeMap;
use std::io::{Error, ErrorKind, Result};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Debug, Clone)]
enum Node {
    Dir,
    File {
        body: Vec<u8>,
        /// Stands in for a modification time.
        ///
        /// The registry hashes `(path, size, mtime)` to notice when a skill
        /// directory has changed. There are no timestamps here, but a counter
        /// bumped on every write answers that question more exactly than a clock
        /// does: it cannot collide the way two writes inside one timer tick can.
        rev: u64,
    },
}

/// Source of `rev`. Monotonic for the life of the page; the snapshot carries the
/// values so a reload does not restart them and make old files look new.
static REV: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_rev() -> u64 {
    REV.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// The tree is global because the registry calls free functions and carries no
/// context it could hold a handle in. A wasm module is single-threaded, so the
/// lock is never contended; it is here to satisfy the borrow checker, not to
/// coordinate anything.
static TREE: RwLock<BTreeMap<PathBuf, Node>> = RwLock::new(BTreeMap::new());

fn not_found(path: &Path) -> Error {
    Error::new(
        ErrorKind::NotFound,
        format!("{} not found in the workspace", path.display()),
    )
}

fn is_a_directory(path: &Path) -> Error {
    Error::new(
        ErrorKind::IsADirectory,
        format!("{} is a directory", path.display()),
    )
}

// ── std::fs shape ──

pub fn read(path: impl AsRef<Path>) -> Result<Vec<u8>> {
    let path = path.as_ref();
    match TREE.read().unwrap().get(path) {
        Some(Node::File { body, .. }) => Ok(body.clone()),
        Some(Node::Dir) => Err(is_a_directory(path)),
        None => Err(not_found(path)),
    }
}

pub fn read_to_string(path: impl AsRef<Path>) -> Result<String> {
    // Same failure `std::fs::read_to_string` gives for a file that is not text,
    // which matters now that uploads share this tree with skills: the file
    // tools ask for text and an image has to say no rather than come back as
    // replacement characters.
    String::from_utf8(read(path)?).map_err(|e| Error::new(ErrorKind::InvalidData, e))
}

pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }
    let node = Node::File {
        body: contents.as_ref().to_vec(),
        rev: next_rev(),
    };
    persist(path, &node)?;
    TREE.write().unwrap().insert(path.to_path_buf(), node);
    Ok(())
}

pub fn create_dir_all(path: impl AsRef<Path>) -> Result<()> {
    let mut fresh = Vec::new();
    {
        let mut tree = TREE.write().unwrap();
        // Every ancestor is recorded, so `read_dir` can list a directory without
        // walking the whole map to infer which prefixes exist.
        for ancestor in path.as_ref().ancestors() {
            if ancestor.as_os_str().is_empty() {
                continue;
            }
            if tree.insert(ancestor.to_path_buf(), Node::Dir).is_none() {
                fresh.push(ancestor.to_path_buf());
            }
        }
    }
    // Outside the lock: the backing is free to read the tree back.
    for dir in fresh {
        persist(&dir, &Node::Dir)?;
    }
    Ok(())
}

/// Delete one file. A directory is refused, as `std::fs::remove_file` does.
pub fn remove_file(path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    match TREE.read().unwrap().get(path) {
        Some(Node::File { .. }) => {}
        Some(Node::Dir) => return Err(is_a_directory(path)),
        None => return Err(not_found(path)),
    }
    TREE.write().unwrap().remove(path);
    forget(&[path.to_path_buf()])
}

/// Delete a directory and everything under it.
///
/// Uninstalling a skill is the reason this exists: a skill is a directory of
/// files, and leaving any of them behind would leave the registry able to scan
/// something the user removed.
pub fn remove_dir_all(path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    let gone: Vec<PathBuf> = {
        let mut tree = TREE.write().unwrap();
        if !tree.contains_key(path) {
            return Err(not_found(path));
        }
        let gone = tree
            .keys()
            .filter(|k| k.as_path() == path || k.starts_with(path))
            .cloned()
            .collect::<Vec<_>>();
        for key in &gone {
            tree.remove(key);
        }
        gone
    };
    forget(&gone)
}

pub fn metadata(path: impl AsRef<Path>) -> Result<Metadata> {
    let path = path.as_ref();
    match TREE.read().unwrap().get(path) {
        Some(Node::File { body, rev }) => Ok(Metadata {
            is_file: true,
            len: body.len() as u64,
            rev: *rev,
        }),
        Some(Node::Dir) => Ok(Metadata {
            is_file: false,
            len: 0,
            rev: 0,
        }),
        None => Err(not_found(path)),
    }
}

pub struct Metadata {
    is_file: bool,
    len: u64,
    rev: u64,
}

impl Metadata {
    pub fn is_file(&self) -> bool {
        self.is_file
    }

    pub fn is_dir(&self) -> bool {
        !self.is_file
    }

    /// File size in bytes, matching `std::fs::Metadata::len`. There is no
    /// `is_empty` for the same reason std has none: this is a size, not a
    /// collection.
    #[allow(clippy::len_without_is_empty)]
    pub fn len(&self) -> u64 {
        self.len
    }

    /// The write counter, dressed as a `SystemTime` so the registry's
    /// `duration_since(UNIX_EPOCH)` fingerprint keeps working unchanged.
    ///
    /// This is not a wall-clock time and must never be shown to anyone as one.
    /// It only has to be different after a write, which is exactly what the
    /// fingerprint asks of it.
    pub fn modified(&self) -> Result<std::time::SystemTime> {
        Ok(std::time::UNIX_EPOCH + std::time::Duration::from_nanos(self.rev))
    }
}

/// Immediate children of `path`, in the shape `std::fs::read_dir` returns so the
/// registry's `.filter_map(|e| e.ok()).map(|e| e.path())` chains still read the
/// same.
pub fn read_dir(path: impl AsRef<Path>) -> Result<ReadDir> {
    let path = path.as_ref();
    let tree = TREE.read().unwrap();
    if !matches!(tree.get(path), Some(Node::Dir)) {
        return Err(not_found(path));
    }
    let entries = tree
        .keys()
        .filter(|k| k.parent() == Some(path))
        .map(|k| DirEntry { path: k.clone() })
        .collect::<Vec<_>>();
    Ok(ReadDir(entries.into_iter()))
}

pub struct ReadDir(std::vec::IntoIter<DirEntry>);

impl Iterator for ReadDir {
    type Item = Result<DirEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(Ok)
    }
}

pub struct DirEntry {
    path: PathBuf,
}

impl DirEntry {
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }

    pub fn file_name(&self) -> std::ffi::OsString {
        self.path
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default()
    }

    pub fn metadata(&self) -> Result<Metadata> {
        metadata(&self.path)
    }
}

/// Resolve `.` and `..` and confirm the result exists.
///
/// The registry uses this for `is_within`, which stops a skill's references from
/// escaping its own directory. Resolving lexically is safe here in a way it
/// would not be on a real filesystem: this tree has no symlinks and no hardlinks,
/// so there is no path that normalises inside the base while resolving outside
/// it. That is the entire reason a lexical answer is allowed to stand in for a
/// canonical one.
///
/// Existence still has to be checked, because `is_within` relies on a missing
/// path failing rather than silently passing the prefix test.
///
/// A relative path resolves against the root, because a page has no working
/// directory to resolve it against and the file tools default their `path` to
/// `"."`. That makes `list_files(".")` mean the workspace, which is the only
/// thing it could usefully mean here.
pub fn canonicalize(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    let mut out = PathBuf::from("/");
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                // Refusing to climb past the root keeps `/../etc` from
                // normalising to something outside the tree.
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    if TREE.read().unwrap().contains_key(&out) {
        Ok(out)
    } else {
        Err(not_found(&out))
    }
}

/// `Path::is_file` and friends are inherent methods that always answer false on
/// wasm, so the patched call sites use these instead.
pub fn is_file(path: impl AsRef<Path>) -> bool {
    matches!(
        TREE.read().unwrap().get(path.as_ref()),
        Some(Node::File { .. })
    )
}

pub fn is_dir(path: impl AsRef<Path>) -> bool {
    matches!(TREE.read().unwrap().get(path.as_ref()), Some(Node::Dir))
}

pub fn exists(path: impl AsRef<Path>) -> bool {
    TREE.read().unwrap().contains_key(path.as_ref())
}

// ── persistence ──

/// One stored path, as a backing store sees it.
pub struct Entry {
    pub path: PathBuf,
    pub dir: bool,
    /// Empty for a directory.
    pub body: Vec<u8>,
    /// The write counter; see [`Node::File`]. Zero for a directory.
    pub rev: u64,
}

/// Somewhere the tree survives the tab.
///
/// Deliberately narrow, and deliberately synchronous: the whole reason this
/// module exists is that the code above it cannot await. The one implementation
/// is [`crate::workspace`].
pub trait Backing: Send + Sync {
    /// Everything stored, in any order. Called once, by [`attach`].
    fn load(&self) -> Vec<Entry>;
    /// Store one path, replacing what was there.
    fn put(&self, entry: Entry) -> Result<()>;
    /// Forget these paths. Absent ones are not an error.
    fn remove(&self, paths: &[PathBuf]) -> Result<()>;
}

static BACKING: RwLock<Option<Box<dyn Backing>>> = RwLock::new(None);

/// Adopt a backing store: load what it holds, and write through to it from now
/// on.
///
/// Call once, before anything reads the tree. Whatever is already in memory is
/// discarded — this is the boot path, and a half-populated tree merged with a
/// stored one would be neither.
pub fn attach(backing: Box<dyn Backing>) {
    let stored = backing.load();

    let mut tree = BTreeMap::new();
    let mut high = 0;
    for entry in stored {
        high = high.max(entry.rev);
        let node = if entry.dir {
            Node::Dir
        } else {
            Node::File {
                body: entry.body,
                rev: entry.rev,
            }
        };
        tree.insert(entry.path, node);
    }

    // Carry the counter across the reload rather than restarting it, or a file
    // written before the reload would look newer than one written after, and
    // the registry would miss the change.
    REV.fetch_max(high + 1, std::sync::atomic::Ordering::Relaxed);
    *TREE.write().unwrap() = tree;
    *BACKING.write().unwrap() = Some(backing);
}

/// Give up the backing store and empty the tree. For tests, which would
/// otherwise leak one case's files into the next.
pub fn detach() {
    *BACKING.write().unwrap() = None;
    TREE.write().unwrap().clear();
}

/// Write one path through to storage, before it is committed to memory.
///
/// That order is deliberate. A refused write — a storage quota is the realistic
/// one — should fail the call rather than leave the tab holding a file that is
/// not there any more after a reload.
fn persist(path: &Path, node: &Node) -> Result<()> {
    let guard = BACKING.read().unwrap();
    let Some(backing) = guard.as_ref() else {
        return Ok(());
    };
    backing.put(match node {
        Node::Dir => Entry {
            path: path.to_path_buf(),
            dir: true,
            body: Vec::new(),
            rev: 0,
        },
        Node::File { body, rev } => Entry {
            path: path.to_path_buf(),
            dir: false,
            body: body.clone(),
            rev: *rev,
        },
    })
}

fn forget(paths: &[PathBuf]) -> Result<()> {
    let guard = BACKING.read().unwrap();
    match guard.as_ref() {
        Some(backing) => backing.remove(paths),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_creates_parents_and_read_dir_lists_only_children() {
        let _ = create_dir_all("/skills");
        write("/skills/demo/SKILL.md", "# demo").unwrap();
        write("/skills/demo/scripts/run.sh", "#!/bin/sh\n").unwrap();

        assert!(is_dir("/skills/demo"));
        assert!(is_file("/skills/demo/SKILL.md"));
        assert_eq!(read_to_string("/skills/demo/SKILL.md").unwrap(), "# demo");

        // `scripts` is a child; `scripts/run.sh` is not.
        let mut kids: Vec<_> = read_dir("/skills/demo")
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        kids.sort();
        assert_eq!(
            kids,
            vec![
                PathBuf::from("/skills/demo/SKILL.md"),
                PathBuf::from("/skills/demo/scripts"),
            ]
        );

        assert!(read_to_string("/skills/missing").is_err());
        assert!(!is_file("/skills/demo"));
    }
}
