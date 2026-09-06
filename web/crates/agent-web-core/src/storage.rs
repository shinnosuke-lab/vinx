//! Bringing up SQLite in a browser tab.
//!
//! SQLite needs somewhere to put bytes. In a page there is no filesystem, so a
//! VFS is registered that keeps the database in IndexedDB, and only then can a
//! connection be opened.
//!
//! This has to happen once, before anything touches the store, and it is async
//! while every method on [`SessionStore`] is not — which is why it lives in its
//! own step rather than inside `SessionStore::open`.

use crate::sql::Result as SqlResult;
use crate::store::SessionStore;

/// Filename inside the VFS. Matches the native install's `sessions.db` so an
/// exported database drops straight in.
pub const DB_NAME: &str = "sessions.db";

/// The workspace's own file; see [`crate::workspace`] for why it is not a table
/// in `sessions.db`.
pub const WORKSPACE_DB_NAME: &str = "workspace.db";

/// The database file for a given namespace.
///
/// IndexedDB is keyed by origin, and the page is now served from the asset host
/// rather than from the gateway — so every gateway an operator visits shares one
/// origin, and without this they would share one history too. The gateway's
/// address is folded into the filename to keep them apart.
///
/// No namespace gives [`DB_NAME`] unchanged, which is what a same-origin
/// deployment gets and what any database written before this existed is called.
pub fn db_name(namespace: Option<&str>) -> String {
    named(DB_NAME, "sessions", namespace)
}

/// The same, for the workspace. One gateway's files stay out of another's for
/// the same reason its sessions do.
pub fn workspace_db_name(namespace: Option<&str>) -> String {
    named(WORKSPACE_DB_NAME, "workspace", namespace)
}

fn named(plain: &str, stem: &str, namespace: Option<&str>) -> String {
    let ns = namespace.unwrap_or("").trim();
    if ns.is_empty() {
        return plain.to_string();
    }
    // This becomes a filename in the VFS and an IndexedDB key, so keep it to
    // characters that cannot be read as a path or need escaping anywhere.
    let safe: String = ns
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("{}-{}.db", stem, safe.trim_matches('-'))
}

/// Install the IndexedDB VFS and open the session store.
///
/// Call once per page or worker. Calling it twice re-registers the VFS under the
/// same name, which SQLite rejects; hold on to the store instead.
pub async fn open(namespace: Option<&str>) -> std::result::Result<SessionStore, String> {
    let cfg = sqlite_wasm_rs::relaxed_idb_vfs::RelaxedIdbCfgBuilder::new().build();
    // `true` makes it the default VFS, so `Connection::open` picks it up without
    // naming it and the store stays agnostic about where its bytes go.
    sqlite_wasm_rs::relaxed_idb_vfs::install(&cfg, true)
        .await
        .map_err(|e| format!("could not install the IndexedDB VFS: {e:?}"))?;

    let name = db_name(namespace);
    SessionStore::open(&name).map_err(|e| format!("could not open {name}: {e}"))
}

/// Give the workspace filesystem somewhere to keep its files.
///
/// Call after [`open`], which is what installs the VFS both databases sit on.
/// A failure here is worth reporting but not fatal: the tab still runs, with a
/// workspace that lasts as long as the page does.
pub fn open_workspace(namespace: Option<&str>) -> std::result::Result<(), String> {
    let name = workspace_db_name(namespace);
    let workspace = crate::workspace::Workspace::open(&name)
        .map_err(|e| format!("could not open {name}: {e}"))?;
    crate::vfs::attach(Box::new(workspace));
    Ok(())
}

/// Open the store against an in-memory database.
///
/// For tests and for the case where IndexedDB is unavailable — a private window
/// in some browsers, or a storage quota refusal. The session survives the tab
/// and nothing more, which is worth saying out loud to the user rather than
/// letting them discover it on reload.
pub fn open_ephemeral() -> SqlResult<SessionStore> {
    SessionStore::open(":memory:")
}
