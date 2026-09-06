//! Attaching a file to a message.
//!
//! The rules are upstream's, from `web/actix.rs`'s two upload handlers: an id
//! is `<32 hex>.<ext>`, the extension decides whether an attachment is an image
//! (and therefore whether it enters model context), images cap at 10MB and
//! everything else at 20MB, and `size`/`lines` are measured once here so the
//! note put on the wire never re-reads the file. They are reproduced rather
//! than vendored because upstream's copy is welded to actix types — the parts
//! worth keeping are the constants and the id grammar, and both are small.
//!
//! What changes is only where the bytes go: [`crate::files::UPLOADS`] in the
//! workspace instead of a directory on a host. That is also what makes an
//! attached text file useful — it is a real path the model can `read_file`.

use std::path::PathBuf;

use crate::answer::Refused;
use crate::types::Attachment;

/// Images are the only uploads that reach the model directly, so they are
/// capped tighter than files it merely has a path to.
const IMAGE_MAX: usize = 10 * 1024 * 1024;
const FILE_MAX: usize = 20 * 1024 * 1024;

/// Accepted image MIME types → canonical extension. Deliberately closed: an
/// extension in this set is what marks an upload as visual input everywhere
/// downstream, including in the vendored engine.
fn image_ext(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// Whether an id names an image. Keyed off the extension rather than the
/// stored MIME because the id is all the transcript keeps.
pub fn is_image(id: &str) -> bool {
    matches!(
        id.rsplit('.').next().unwrap_or(""),
        "png" | "jpg" | "jpeg" | "webp" | "gif"
    )
}

/// The MIME type to serve an id back as. Only images get a real one — nothing
/// else is rendered inline, and guessing would invite the browser to.
pub fn mime_of(id: &str) -> &'static str {
    match id.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// Ids are generated here and then travel through the UI and the session
/// store, so anything coming back is checked against the grammar before it
/// becomes a path.
pub fn valid_id(id: &str) -> bool {
    let Some((stem, ext)) = id.split_once('.') else {
        return false;
    };
    stem.len() == 32
        && stem.chars().all(|c| c.is_ascii_hexdigit())
        && (1..=8).contains(&ext.len())
        && ext
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// A non-image's extension, taken from its original name: lowercase
/// `[a-z0-9]{1,8}`, `bin` when absent. An image extension is remapped to `bin`
/// too, because "extension is in the image set" is precisely what downstream
/// reads as "arrived through the image path".
fn file_ext(name: &str) -> String {
    let ext: String = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .take(8)
        .collect();
    if ext.is_empty() || is_image(&format!("x.{ext}")) {
        "bin".to_string()
    } else {
        ext
    }
}

/// Line count for text-like bodies; `None` for binaries (a NUL in the first
/// 8KB), so the wire note does not advertise a meaningless number.
fn count_lines(body: &[u8]) -> Option<u64> {
    if body.is_empty() || body[..body.len().min(8192)].contains(&0) {
        return None;
    }
    let newlines = body.iter().filter(|b| **b == b'\n').count() as u64;
    Some(newlines + u64::from(*body.last().unwrap() != b'\n'))
}

pub fn path_of(id: &str) -> PathBuf {
    PathBuf::from(crate::files::UPLOADS).join(id)
}

/// What the UI is told about a stored upload. `kind` is what decides whether it
/// renders as a thumbnail or as a file chip.
#[derive(Debug, serde::Serialize)]
pub struct Stored {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub kind: &'static str,
    pub size: u64,
    pub lines: Option<u64>,
}

/// Store one upload in the workspace.
///
/// `mime` is the request's content type and `name` the original file name;
/// between them they decide the extension, and the extension decides
/// everything else.
pub fn store(name: &str, mime: &str, body: &[u8]) -> Result<Stored, Refused> {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if body.is_empty() {
        return Err(Refused::bad("empty body"));
    }
    let (ext, kind, max) = match image_ext(&mime) {
        Some(ext) => (ext.to_string(), "image", IMAGE_MAX),
        None => (file_ext(name), "file", FILE_MAX),
    };
    if body.len() > max {
        return Err(Refused::too_large(format!(
            "{kind} exceeds {}MB",
            max / (1024 * 1024)
        )));
    }

    let id = format!("{}.{ext}", uuid::Uuid::new_v4().simple());
    crate::vfs::write(path_of(&id), body)
        .map_err(|e| Refused::broken(format!("cannot store upload: {e}")))?;

    Ok(Stored {
        // Only files are read as text, and only there does a line count mean
        // anything.
        lines: (kind == "file").then(|| count_lines(body)).flatten(),
        size: body.len() as u64,
        id,
        name: name.chars().take(120).collect(),
        mime,
        kind,
    })
}

/// Read an upload back, for `GET /api/chat/upload/{id}`.
pub fn load(id: &str) -> Option<Vec<u8>> {
    valid_id(id)
        .then(|| crate::vfs::read(path_of(id)).ok())
        .flatten()
}

/// Turn the references riding a message into attachments the engine can use.
///
/// The client echoes back what it was given, but a page can be reloaded and a
/// workspace cleared between the upload and the send, so existence is checked
/// here and the size is taken from the file rather than trusted. Anything gone
/// is dropped with a warning instead of failing the turn: losing a thumbnail
/// is better than losing the message it was attached to.
pub fn resolve(refs: Vec<Attachment>) -> Vec<Attachment> {
    refs.into_iter()
        .filter_map(|r| {
            if !valid_id(&r.id) {
                log::warn!("attachment rejected (bad id): {:?}", r.id);
                return None;
            }
            match crate::vfs::metadata(path_of(&r.id)) {
                Ok(m) if m.is_file() => Some(Attachment { size: m.len(), ..r }),
                _ => {
                    log::warn!("attachment dropped (no longer in the workspace): {}", r.id);
                    None
                }
            }
        })
        .collect()
}
