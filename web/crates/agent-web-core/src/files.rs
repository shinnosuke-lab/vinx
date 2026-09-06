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
//!
//! The workspace has three doors to the person. Upstream delivers through
//! `publish` (a served URL); a page has no server, so the equivalents are a
//! browser download ([`DownloadFileTool`] — the bytes leave the worker through
//! the function the page installs with `AgentHost::set_downloader`, and the
//! main thread clicks the `<a download>`) and a new tab ([`OpenFileTool`] —
//! the chat card carries an Open button, and the click reads the file back
//! through `AgentHost::read_workspace_file`). Without them a draft is a dead
//! end: the model writes a page, tells the person to "download it from the
//! workspace", and there is nothing on the page that could. The third door is
//! the Apps page ([`InstallAppTool`] — a pure web app's parts leave through
//! the function the page installs with `AgentHost::set_app_installer`, and
//! the page packs and installs them the way `app install` would, machine on or
//! off): to the person "an app" is an entry there, and a draft opened in a tab
//! is not one.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use wasm_bindgen::{JsCast, JsValue};

use crate::os::{OsPolicy, SafePathAllowList};
use crate::tool::{Tool, ToolContext, ToolRegistry};
use crate::types::{RiskLevel, ToolDefinition, ToolParameter, ToolParameters, ToolResult};

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
/// the bucket is disposable and nothing outside the page can read it — a
/// draft reaches the person only through [`DownloadFileTool`],
/// [`OpenFileTool`] or [`InstallAppTool`].
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
/// only filesystem it has — and the person cannot see into it, so the
/// briefing says how a file gets out, and which of the three doors is for
/// what. Left unsaid, the model writes a page and tells the person to fetch it
/// from a place they have no window on — or, asked "can't the page just
/// open it?", guesses instead of answering. The last paragraph names what
/// the person calls an app: asked for "a web app", a model that hands over a
/// standalone HTML has answered a different question — the person looks on
/// the Apps page and finds nothing.
pub const BRIEFING: &str = "\
You have a private workspace: a filesystem that lives in this browser tab and \
nowhere else. read_file, write_file, edit_file, list_files and search_files \
operate on it, and on nothing else. It starts with skills/, themes/ and \
runtime/ and is empty otherwise.\n\
It is NOT any machine's filesystem. Reading /etc, /root or any other system \
path will find nothing here.\n\
A write_file with a bare filename (no directory) lands in runtime/drafts/ and \
runs without asking; any other path asks the user first. Every file tool \
accepts that same bare name for the draft afterwards — read, edit, search, \
open, download, install.\n\
The person does not see this workspace and cannot open or download anything \
from it themselves; the page has no other way to show them a file. You have \
three: open_file puts an Open button in the chat that opens the file in a new \
browser tab when they click it (a web page runs there; images, PDFs and text \
display) — use it when they should see or try what you made. download_file \
gives them a copy saved under the file's own name — use it when they should \
keep it. install_app puts a web app you wrote on the page's Apps page, where \
they open it in a window like any installed app. Finish any request that \
produces a file with one of the three; describing where the file \"is\" does \
not deliver it.\n\
When the person asks for an app (a web app, a widget, a tool \"on the Apps \
page\"), they mean an installed one: write the window's body fragment, \
stylesheet and script as drafts and call install_app — it needs no machine. \
A standalone HTML shown with open_file is a preview, not an app they can find \
there.";

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

// ── handing a file to the person ──

/// The most a single hand-over carries. Matches the VM's transfer cap
/// (`MAX_TRANSFER_BYTES` in device-vm.ts): the bytes cross to the main thread
/// in one message, and a draft is not where a disk image belongs.
pub const MAX_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;

/// A workspace file the model wants the person to have, located and vetted
/// the same way for every door out: `download_file`, `open_file`, and the
/// page's own read for an Open button (`AgentHost::read_workspace_file`).
pub struct Located {
    /// The path as it will be reported back — the drafts-resolved spelling.
    pub path: String,
    /// The canonical path inside the tree.
    pub resolved: PathBuf,
    /// The name the browser sees: the file's own.
    pub filename: String,
    /// Size on disk, already checked against [`MAX_DOWNLOAD_BYTES`].
    pub len: u64,
}

/// Find `path` for a hand-over: a bare name means the draft of that name,
/// the file must exist, be a file, and fit the cap. Errors are the model's
/// words, prefixed `Error:` so they can go straight into a tool result.
pub fn locate(
    policy: &OsPolicy,
    drafts_dir: &Path,
    path: &str,
    verb: &str,
) -> Result<Located, String> {
    if path.is_empty() {
        return Err("Error: path is required".into());
    }
    let path = crate::os::resolve_existing_in_drafts(Some(drafts_dir), path);
    let resolved = policy.check_read(&path)?;
    let meta = crate::vfs::metadata(&resolved)
        .map_err(|_| format!("Error: no such file or directory: {path}"))?;
    if meta.is_dir() {
        return Err(format!(
            "Error: {path} is a directory; {verb} takes one file"
        ));
    }
    if meta.len() > MAX_DOWNLOAD_BYTES as u64 {
        return Err(format!(
            "Error: {path} is {} bytes; {verb} handles at most {MAX_DOWNLOAD_BYTES}",
            meta.len()
        ));
    }
    let filename = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("download")
        .to_string();
    Ok(Located {
        path,
        resolved,
        filename,
        len: meta.len(),
    })
}

/// The one `path` parameter every hand-over tool takes.
fn path_parameter() -> ToolParameters {
    ToolParameters::object(
        HashMap::from([(
            "path".into(),
            ToolParameter::string("Workspace path of the file; a bare filename names a draft"),
        )]),
        vec!["path".into()],
    )
}

thread_local! {
    /// The page's half of `download_file`: a JS `(filename, bytes)` function
    /// that clicks an `<a download>` on the main thread. Wasm is
    /// single-threaded, so a thread-local is the whole registry. `None` on a
    /// host that never installed one (tests, an embedding without a page) —
    /// the tool then says so instead of pretending the file went somewhere.
    static DOWNLOADER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Install (or clear) the page's downloader. See `AgentHost::set_downloader`.
pub fn set_downloader(f: Option<js_sys::Function>) {
    DOWNLOADER.with(|d| *d.borrow_mut() = f);
}

/// Hand `bytes` to the person under `filename`.
fn hand_to_person(filename: &str, bytes: &[u8]) -> Result<(), String> {
    DOWNLOADER.with(|d| {
        let d = d.borrow();
        let Some(f) = d.as_ref() else {
            return Err(
                "this page cannot hand files to the person: no downloader is installed".into(),
            );
        };
        // `Uint8Array::from(&[u8])` copies into a JS-owned buffer, so the
        // main thread may keep (or transfer) it after wasm memory moves on.
        let array = js_sys::Uint8Array::from(bytes);
        f.call2(&JsValue::NULL, &JsValue::from_str(filename), &array)
            .map(|_| ())
            .map_err(|e| {
                let why = e.as_string().unwrap_or_else(|| format!("{e:?}"));
                format!("the page refused the download: {why}")
            })
    })
}

/// `download_file` for the workspace: read a file out of the vfs and hand it
/// to the person as a browser download. The device's tool of the same name
/// replaces this one while the machine is up (its files are the model's
/// filesystem then); `AgentHost::uninstall_tools` brings this one back.
pub struct DownloadFileTool {
    policy: Arc<OsPolicy>,
    drafts_dir: PathBuf,
}

impl DownloadFileTool {
    pub fn new(policy: Arc<OsPolicy>, drafts_dir: PathBuf) -> Self {
        Self { policy, drafts_dir }
    }
}

#[async_trait]
impl Tool for DownloadFileTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "download_file",
            "Give the person a copy of a file from your workspace, as a browser \
             download saved under the file's own name. Use it when they should \
             KEEP the file — a script, a document, an archive. To let them look at \
             a page, image or PDF instead, use open_file. A bare filename means \
             the draft of that name, where a bare-filename write_file put it. Up \
             to 16 MB.",
            path_parameter(),
        )
    }

    /// The person's own file, into their own downloads folder, by their own
    /// browser's rules — nothing to confirm (the VM's tool is Safe too).
    fn risk(&self, _args: &serde_json::Value) -> RiskLevel {
        RiskLevel::Safe
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let file = match locate(&self.policy, &self.drafts_dir, path, "download_file") {
            Ok(f) => f,
            Err(e) => return ToolResult::text(e).with_success(false),
        };
        let bytes = match crate::vfs::read(&file.resolved) {
            Ok(b) => b,
            Err(e) => {
                return ToolResult::text(format!("Error: failed to read {}: {e}", file.path))
                    .with_success(false);
            }
        };
        match hand_to_person(&file.filename, &bytes) {
            Ok(()) => ToolResult::text(format!(
                "Sent {} ({} bytes) to the person as a browser download.",
                file.filename,
                bytes.len()
            )),
            Err(why) => ToolResult::text(format!("Error: {why}")).with_success(false),
        }
    }
}

/// `open_file`: show the person a workspace file in their browser. Like
/// `open_terminal`, the tool itself does nothing but vet the path — the card
/// the page draws for this call carries an Open button, and the click (a real
/// user gesture, so no popup blocker) reads the file back out of the
/// workspace and opens it in a new tab. Pages, images, PDFs and text render;
/// anything else the browser saves. Nothing crosses to the page here, so the
/// button keeps working after a reload and always shows the file as it is now.
///
/// Why a button and not an automatic tab: a page may not open windows outside
/// a gesture, and a tab that appears unbidden when a model decides so is not
/// something a person should have to trust.
pub struct OpenFileTool {
    policy: Arc<OsPolicy>,
    drafts_dir: PathBuf,
}

impl OpenFileTool {
    pub fn new(policy: Arc<OsPolicy>, drafts_dir: PathBuf) -> Self {
        Self { policy, drafts_dir }
    }
}

#[async_trait]
impl Tool for OpenFileTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "open_file",
            "Show the person a file from your workspace: this call puts an Open \
             button in the chat, and when they click it their browser opens the \
             file in a new tab — a web page runs there, images, PDFs and text \
             display; other types download. Use it when they should SEE or TRY \
             something you made; use download_file when they should keep a copy. \
             A bare filename means the draft of that name. Nothing opens until \
             they click, so say \"the Open button above\", not that it is on \
             their screen. Up to 16 MB.",
            path_parameter(),
        )
    }

    /// A button the person may or may not press — nothing to confirm.
    fn risk(&self, _args: &serde_json::Value) -> RiskLevel {
        RiskLevel::Safe
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        match locate(&self.policy, &self.drafts_dir, path, "open_file") {
            Ok(file) => ToolResult::text(format!(
                "Offered {} ({} bytes): the Open button on this card opens it in a new \
                 browser tab when the person clicks it.",
                file.filename, file.len
            )),
            Err(e) => ToolResult::text(e).with_success(false),
        }
    }
}

/// The page's read for an Open button: the file behind `path`, vetted like
/// any hand-over, or `None` when the workspace no longer has it. See
/// `AgentHost::read_workspace_file`.
pub fn read_for_person(path: &str) -> Option<Vec<u8>> {
    let policy = OsPolicy::new(vec![PathBuf::from(ROOT)], false);
    let file = locate(&policy, Path::new(DRAFTS), path, "open_file").ok()?;
    crate::vfs::read(&file.resolved).ok()
}

// ── installing a web app ──

/// The most one part of a web app may weigh: what app-run(8) stages for a
/// window and what the page will open (vapp.ts's PART_MAX). The page checks
/// it again, with the machine's finding codes; here it keeps a runaway draft
/// from crossing to the main thread only to be refused there.
pub const MAX_APP_PART_BYTES: usize = 160 * 1024;

thread_local! {
    /// The page's half of `install_app`: a JS function taking one object
    /// `{id, title?, description?, html, css?, js?}` — the parts as
    /// Uint8Arrays — and returning a promise of the line to show the model,
    /// resolved once the app is on the Apps page, rejected with the refusal
    /// otherwise. `None` on a host that never installed one (tests, an
    /// embedding without a page) — the tool then says so.
    static APP_INSTALLER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Install (or clear) the page's app installer. See
/// `AgentHost::set_app_installer`.
pub fn set_app_installer(f: Option<js_sys::Function>) {
    APP_INSTALLER.with(|d| *d.borrow_mut() = f);
}

/// A JS rejection or exception as the model's words: a string as is, an
/// Error by its message, anything else by its debug print.
fn js_why(e: JsValue) -> String {
    if let Some(s) = e.as_string() {
        return s;
    }
    if let Some(err) = e.dyn_ref::<js_sys::Error>() {
        return String::from(err.message());
    }
    format!("{e:?}")
}

/// `install_app`: put a pure web app the model wrote onto the page's Apps
/// page. The tool's own work is the workspace half — find the parts, read
/// them, cap them — and the page does the rest through the installed
/// function: the manifest, the machine's validation, the package, the
/// machine's mirror of /data/apps (and the live /data when the machine is
/// up), and the Apps page refresh. A pure web app runs in a sandboxed frame
/// and never needs Linux, so installing one is a page operation just as
/// opening one is (vm-apps.ts) — the one kind of app that can be built while
/// the machine is off. Retired together with the other doors while a device
/// owns the file tools: then the model works on the machine, with `app`.
pub struct InstallAppTool {
    policy: Arc<OsPolicy>,
    drafts_dir: PathBuf,
}

impl InstallAppTool {
    pub fn new(policy: Arc<OsPolicy>, drafts_dir: PathBuf) -> Self {
        Self { policy, drafts_dir }
    }

    /// One part of the app, by workspace path: located like any hand-over,
    /// then read and weighed.
    fn part(&self, path: &str, which: &str) -> Result<(String, Vec<u8>), String> {
        let file = locate(&self.policy, &self.drafts_dir, path, "install_app")?;
        if file.len > MAX_APP_PART_BYTES as u64 {
            return Err(format!(
                "Error: {which} ({}) is {} bytes; a web app's parts are at most \
                 {MAX_APP_PART_BYTES} bytes each — the window stages them inline",
                file.path, file.len
            ));
        }
        let bytes = crate::vfs::read(&file.resolved)
            .map_err(|e| format!("Error: failed to read {}: {e}", file.path))?;
        Ok((file.path, bytes))
    }
}

#[async_trait]
impl Tool for InstallAppTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "install_app",
            "Install a web app you wrote onto this page's Apps page, where the \
             person opens it in a window — with or without the machine. This is \
             what \"an app\" or \"a web app\" means to the person; a standalone \
             HTML shown with open_file is a preview, not an app they can find \
             there. Takes workspace paths (a bare filename means the draft of that \
             name): html is the window's BODY FRAGMENT — no <html>/<head>/<body>, \
             no <link> or <script src>; the window supplies the document and \
             injects css and js itself. Each part up to 160 KB, everything inline: \
             the window has no network (no fetch, CDN or import) and no \
             localStorage/cookies; the `vinx` object is its way to the system. \
             Reinstalling the same id updates the app. autostart puts it on the \
             autostart list — the page opens it whenever it loads — and is the \
             person's policy: set it only when they asked for that.",
            ToolParameters::object(
                HashMap::from([
                    (
                        "id".into(),
                        ToolParameter::string(
                            "App id: lowercase letters, digits and dashes, 1-32 characters \
                             (e.g. focus-timer). The same id reinstalls.",
                        ),
                    ),
                    (
                        "title".into(),
                        ToolParameter::string(
                            "Name shown on the Apps page, up to 64 characters (defaults to the id)",
                        ),
                    ),
                    (
                        "description".into(),
                        ToolParameter::string("One line for the Apps page, up to 240 characters"),
                    ),
                    (
                        "html".into(),
                        ToolParameter::string(
                            "Workspace path of the body fragment (the window's index.html)",
                        ),
                    ),
                    (
                        "css".into(),
                        ToolParameter::string(
                            "Workspace path of the stylesheet the window injects (optional)",
                        ),
                    ),
                    (
                        "js".into(),
                        ToolParameter::string(
                            "Workspace path of the script the window runs after the fragment \
                             (optional)",
                        ),
                    ),
                    (
                        "autostart".into(),
                        ToolParameter::boolean(
                            "true: open it whenever the page loads (the person asked for \
                             that). Omit otherwise; an update keeps the current setting.",
                        ),
                    ),
                ]),
                vec!["id".into(), "html".into()],
            ),
        )
    }

    /// The person asked for the app, and what lands is inert: a package the
    /// page opens in a sandboxed frame with no network and no storage,
    /// listed where one click removes it. Like `publish` upstream — a
    /// deliverable, not a change to a machine — so nothing to confirm.
    fn risk(&self, _args: &serde_json::Value) -> RiskLevel {
        RiskLevel::Safe
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let arg = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let refuse = |why: String| ToolResult::text(why).with_success(false);
        let Some(id) = arg("id") else {
            return refuse("Error: id is required (lowercase letters, digits and dashes)".into());
        };
        let Some(html_path) = arg("html") else {
            return refuse(
                "Error: html is required: the workspace path of the window's body fragment".into(),
            );
        };
        let html = match self.part(html_path, "html") {
            Ok(p) => p,
            Err(e) => return refuse(e),
        };
        let css = match arg("css").map(|p| self.part(p, "css")) {
            Some(Ok(p)) => Some(p),
            Some(Err(e)) => return refuse(e),
            None => None,
        };
        let js = match arg("js").map(|p| self.part(p, "js")) {
            Some(Ok(p)) => Some(p),
            Some(Err(e)) => return refuse(e),
            None => None,
        };
        if APP_INSTALLER.with(|d| d.borrow().is_none()) {
            return refuse(
                "Error: this page cannot install apps: no installer is installed".into(),
            );
        }
        // The JS half runs off this future: `execute` must be `Send`, and a
        // promise is not (see bridge.rs). The spawned task owns the parts,
        // talks to the page, and answers on a oneshot — which is `Send`.
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        let handed = HandedApp {
            id: id.to_string(),
            title: arg("title").map(str::to_string),
            description: arg("description").map(str::to_string),
            html: html.1,
            css: css.map(|p| p.1),
            js: js.map(|p| p.1),
            // Only a literal true counts: "false", 1 or a string are "not asked".
            autostart: args.get("autostart").and_then(|v| v.as_bool()) == Some(true),
        };
        wasm_bindgen_futures::spawn_local(async move {
            let _ = tx.send(hand_to_page(handed).await);
        });
        match rx.await {
            Ok(Ok(text)) => ToolResult::text(if text.trim().is_empty() {
                format!("Installed {id} on the Apps page.")
            } else {
                text
            }),
            Ok(Err(why)) => refuse(format!("Error: {why}")),
            Err(_) => refuse("Error: the page dropped the install without answering".into()),
        }
    }
}

/// What crosses to the page for one `install_app`: the manifest fields the
/// model gave and the parts it wrote, as bytes.
struct HandedApp {
    id: String,
    title: Option<String>,
    description: Option<String>,
    html: Vec<u8>,
    css: Option<Vec<u8>>,
    js: Option<Vec<u8>>,
    /// On the autostart list, the person having asked (§10.7).
    autostart: bool,
}

/// The page's turn: build the one plain object the installer takes, call it,
/// and await its promise. Resolves with the line for the model; a rejection,
/// an exception or a missing installer come back as the refusal to show.
async fn hand_to_page(app: HandedApp) -> Result<String, String> {
    let Some(installer) = APP_INSTALLER.with(|d| d.borrow().clone()) else {
        return Err("this page cannot install apps: no installer is installed".into());
    };
    let obj = js_sys::Object::new();
    let set = |key: &str, value: &JsValue| {
        // A fresh plain object never refuses a property.
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(key), value);
    };
    set("id", &JsValue::from_str(&app.id));
    if let Some(title) = &app.title {
        set("title", &JsValue::from_str(title));
    }
    if let Some(description) = &app.description {
        set("description", &JsValue::from_str(description));
    }
    // JS-owned copies (see hand_to_person), so the main thread may keep them.
    set("html", &js_sys::Uint8Array::from(app.html.as_slice()));
    if let Some(bytes) = &app.css {
        set("css", &js_sys::Uint8Array::from(bytes.as_slice()));
    }
    if let Some(bytes) = &app.js {
        set("js", &js_sys::Uint8Array::from(bytes.as_slice()));
    }
    // Absent unless asked: the page reads a missing key as "leave the list".
    if app.autostart {
        set("autostart", &JsValue::TRUE);
    }
    let returned = installer.call1(&JsValue::NULL, &obj).map_err(js_why)?;
    // A promise or a plain value: resolve() takes both.
    let value = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&returned))
        .await
        .map_err(js_why)?;
    Ok(value.as_string().unwrap_or_default())
}

/// Register the file tools against the workspace.
///
/// `safe_paths` is shared with the host so the confirm bar's "allow this
/// folder" button can grow it; see [`crate::host::AgentHost::allow_dir`].
pub fn install(registry: &ToolRegistry, safe_paths: Arc<SafePathAllowList>) {
    prepare();
    let policy = || OsPolicy::new(vec![PathBuf::from(ROOT)], false);
    crate::os::register_audited(
        registry,
        policy(),
        // No auditor: upstream's writes an audit trail to a log file, and a
        // page has nowhere to put one that would outlive the tab.
        None,
        Some(PathBuf::from(DRAFTS)),
        Some(safe_paths),
    );
    // The workspace's doors to the person: a copy to keep, a tab to look at,
    // an app to install. The device's download_file takes that name over
    // while a machine is up; open_file and install_app have no device twin
    // (the guest has open(1) and app(1)) and are retired.
    registry.register(Arc::new(DownloadFileTool::new(
        Arc::new(policy()),
        PathBuf::from(DRAFTS),
    )));
    registry.register(Arc::new(OpenFileTool::new(
        Arc::new(policy()),
        PathBuf::from(DRAFTS),
    )));
    registry.register(Arc::new(InstallAppTool::new(
        Arc::new(policy()),
        PathBuf::from(DRAFTS),
    )));
    // Pure UI: the chat card is a button that opens a console for the person
    // (this machine's panel on the chat page). Nothing runs here.
    registry.register(Arc::new(crate::os::OpenTerminalTool::new()));
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
