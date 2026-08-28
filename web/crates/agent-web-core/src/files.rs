//! The workspace: where the file tools point, and what lives in it.
//!
//! Upstream's file tools operate on the machine the agent runs on. There is no
//! such machine here, so they operate on [`crate::vfs`] instead — a tree in the
//! page, persisted to IndexedDB. The layout below is upstream's, relative to a
//! data directory that here is simply the root: `skills/`, `skills-state.json`,
//! `runtime/uploads/`, `themes/`. Keeping the names means the engine's
//! path-shaped code needs no adjustment, and a workspace exported from here
//! would drop into an agent-core install unchanged.
//!
//! What this is *not* is the device's disk. When a device publishes its own
//! file tools (the in-page VM does), those *replace* the workspace's on
//! registration — see `ToolRegistry::register` — and `tools::install` then
//! retires the vfs-only leftovers, so the model sees exactly one filesystem.
//! The system message matches whichever world the model actually holds,
//! because a model that has to discover the truth by failing wastes turns
//! on it.

use std::path::PathBuf;
use std::sync::Arc;

use crate::os::{OsPolicy, SafePathAllowList};
use crate::tool::ToolRegistry;

/// Everything the tools can see. The allow-list is the whole tree because the
/// tree is already a sandbox: it holds only what the page put there.
pub const ROOT: &str = "/";

/// Installed skills, one directory each. Scanned by `SkillRegistry`.
pub const SKILLS: &str = "/skills";

/// Which skills the user turned off or pinned. Upstream's format, an opt-out
/// set, so the file means the same thing in both places.
pub const SKILL_STATE: &str = "/skills-state.json";

/// Files the user attached to a message.
pub const UPLOADS: &str = "/runtime/uploads";

/// Where a bare-filename `write_file` lands. Writes here need no confirmation:
/// the bucket is disposable and nothing outside the page can read it.
pub const DRAFTS: &str = "/runtime/drafts";

/// Saved chat themes, plus the `active` pointer.
pub const THEMES: &str = "/themes";

/// Where a skill package is unpacked before it is known to be one. A peer of
/// `skills/` rather than a directory inside it, so a half-validated package is
/// never somewhere the registry would scan.
pub const TMP: &str = "/runtime/tmp";

/// Directories the user has said not to ask about again.
pub const SAFE_PATHS: &str = "/safe_paths.json";

/// The directories the layout above assumes exist.
///
/// Cheap and idempotent, and worth doing up front: `list_files` on a directory
/// that was never created reports "path not found", which reads as a bug in the
/// tool rather than as an empty folder.
pub fn prepare() {
    for dir in [SKILLS, UPLOADS, DRAFTS, THEMES, TMP] {
        if let Err(e) = crate::vfs::create_dir_all(dir) {
            log::error!("could not create {dir} in the workspace: {e}");
        }
    }
}

/// What the model is told when no device is attached: the workspace is the
/// only filesystem it has.
pub const BRIEFING: &str = "\
You have a private workspace: a filesystem that lives in this browser tab and \
nowhere else. read_file, write_file, edit_file, list_files and search_files \
operate on it, and on nothing else. It starts with skills/, themes/ and \
runtime/ and is empty otherwise.\n\
It is NOT any machine's filesystem. Reading /etc, /root or any other system \
path will find nothing here.\n\
A write_file with a bare filename (no directory) lands in runtime/drafts/ and \
runs without asking; any other path asks the user first.";

/// What the model is told when a device owns the file tools (the in-page VM
/// does): one filesystem, the machine's. The tab workspace still exists for
/// the UI (skills, themes, thumbnails) but is no longer model surface, so it
/// goes unmentioned — a second, invisible filesystem is exactly the confusion
/// this text used to cause.
pub const VM_BRIEFING: &str = "\
Your file tools (read_file, write_file, edit_file, list_dir) all operate on \
the Linux machine described above — there is no separate workspace. Two \
places persist across a page reload: /data is this machine's OWN persistent \
directory (the person's other machines do not see it), and /data/share/local \
is shared between every machine the person has open (the chat page's, each \
split pane's, other tabs'). Files the person attaches to the chat appear in \
/data/share/local/. To hand a file to the other machines, use the share_local \
tool (in the shell: `share local FILE`) — browser-local mirroring, nothing \
goes over the network.";

/// Compose the system message: what the device said about itself, then the
/// filesystem story that matches the tools the model actually holds.
/// `device_owns_files` comes from the tool install (see
/// `AgentHost::install_tools`): true when the device's read_file/write_file
/// replaced the workspace's.
pub fn briefing(device: &str, device_owns_files: bool) -> String {
    match (device.trim(), device_owns_files) {
        ("", _) => BRIEFING.to_string(),
        (device, true) => format!("{device}\n\n{VM_BRIEFING}"),
        // A device that describes itself but brings no file tools: the
        // workspace tools are still the model's, so the original story holds.
        (device, false) => format!("{device}\n\n{BRIEFING}"),
    }
}

#[cfg(test)]
mod tests {
    /// The filesystem story must match who owns the file tools, not merely
    /// whether a device said hello — a gateway without file tools still gets
    /// the workspace briefing.
    #[test]
    fn the_briefing_follows_the_file_tools_owner() {
        let vm = super::briefing("a Linux VM", true);
        assert!(vm.contains("/data/share/local"), "{vm}");
        assert!(!vm.contains("private workspace"), "{vm}");

        let gateway = super::briefing("a gateway", false);
        assert!(gateway.contains("private workspace"), "{gateway}");

        let alone = super::briefing("", true);
        assert!(alone.contains("private workspace"), "{alone}");
    }
}

/// Register the file tools against the workspace.
///
/// `safe_paths` is shared with the host so the confirm bar's "allow this
/// folder" button can grow it; see [`crate::host::AgentHost::allow_dir`].
pub fn install(registry: &ToolRegistry, safe_paths: Arc<SafePathAllowList>) {
    prepare();
    crate::os::register_audited(
        registry,
        OsPolicy::new(vec![PathBuf::from(ROOT)], false),
        // No auditor: upstream's writes an audit trail to a log file, and a
        // page has nowhere to put one that would outlive the tab.
        None,
        Some(PathBuf::from(DRAFTS)),
        Some(safe_paths),
    );
    // Pure UI: the chat card is a button that opens /terminal. Nothing runs
    // here; the console page itself talks to the device's run_shell.
    registry.register(Arc::new(crate::os::OpenTerminalTool::new()));
}
