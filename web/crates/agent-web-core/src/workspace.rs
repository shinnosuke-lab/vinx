//! Where the workspace's files actually live.
//!
//! [`crate::vfs`] is the filesystem the engine sees; this is the disk under it.
//! One table of paths, opened on the same IndexedDB-backed SQLite the session
//! store runs on — which is what makes a write durable without an await, and
//! that is the whole reason this is SQLite rather than IndexedDB directly.
//! Every caller above is synchronous and cannot be made otherwise without
//! rewriting the vendored registry.
//!
//! It is a *separate database file* from `sessions.db`, not another table in it.
//! The session schema is a verbatim copy of agent-core's and a database written
//! here has to stay one a native install can open; adding to it would end that.

use std::cell::RefCell;
use std::path::PathBuf;

use crate::sql::{Connection, Value};
use crate::vfs::{Backing, Entry};

pub struct Workspace {
    conn: RefCell<Connection>,
}

// One thread, as everywhere else here; see `sql::Connection`.
unsafe impl Send for Workspace {}
unsafe impl Sync for Workspace {}

impl Workspace {
    /// Open (or create) the workspace database.
    ///
    /// The VFS must already be installed; see [`crate::storage`].
    pub fn open(path: &str) -> crate::sql::Result<Workspace> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
                 path TEXT PRIMARY KEY,
                 dir  INTEGER NOT NULL,
                 body BLOB NOT NULL,
                 rev  INTEGER NOT NULL
             );",
        )?;
        Ok(Workspace {
            conn: RefCell::new(conn),
        })
    }
}

/// A path as SQLite stores it.
///
/// Lossy on paths that are not UTF-8, which cannot occur: every path in this
/// tree is built from string literals and from names the engine parsed out of
/// UTF-8 archives and JSON.
fn key(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

impl Backing for Workspace {
    fn load(&self) -> Vec<Entry> {
        let conn = self.conn.borrow();
        let loaded = conn
            .prepare("SELECT path, dir, body, rev FROM files")
            .and_then(|mut stmt| {
                stmt.rows(|r| Entry {
                    path: PathBuf::from(r.text_or_empty(0)),
                    dir: r.int(1) != 0,
                    body: r.blob(2),
                    rev: r.int(3).max(0) as u64,
                })
            });
        match loaded {
            Ok(entries) => entries,
            Err(e) => {
                // An empty workspace rather than a page that will not start.
                // Skills can be reinstalled; a browser that cannot open the
                // chat cannot be told so.
                log::error!("could not read the workspace back: {e}");
                Vec::new()
            }
        }
    }

    fn put(&self, entry: Entry) -> std::io::Result<()> {
        self.conn
            .borrow()
            .execute(
                "INSERT INTO files (path, dir, body, rev) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(path) DO UPDATE SET dir=?2, body=?3, rev=?4",
                &[
                    key(&entry.path).into(),
                    Value::Int(entry.dir as i64),
                    entry.body.into(),
                    Value::Int(entry.rev as i64),
                ],
            )
            .map_err(failed)
    }

    fn remove(&self, paths: &[PathBuf]) -> std::io::Result<()> {
        let conn = self.conn.borrow();
        for path in paths {
            conn.execute("DELETE FROM files WHERE path=?1", &[key(path).into()])
                .map_err(failed)?;
        }
        Ok(())
    }
}

/// SQLite's complaint, in the shape the filesystem API above returns.
fn failed(e: crate::sql::Error) -> std::io::Error {
    std::io::Error::other(format!("the workspace could not be written: {e}"))
}
