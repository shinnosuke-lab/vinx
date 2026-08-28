//! Just enough of rusqlite's shape to port the session store unchanged.
//!
//! `sqlite-wasm-rs` exposes the SQLite C API and nothing above it, while the
//! upstream store is written against rusqlite. Rewriting the store's queries to
//! a different idiom would be the surest way to let its behaviour drift from the
//! native one, so instead this wraps the C API in the small subset of rusqlite's
//! surface those queries actually use — `prepare`, `bind`, `step`, typed column
//! reads — and the store's SQL is then copied across verbatim.
//!
//! Deliberately not general: no floats, no user-defined functions, no statement
//! cache. Text and integers are all the session store needs; blobs were added
//! for the workspace, whose files are bytes and include images.

use std::ffi::{CStr, CString};
use std::os::raw::c_int;
use std::ptr;

use sqlite_wasm_rs as ffi;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct Error {
    pub code: c_int,
    pub message: String,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sqlite error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

impl Error {
    fn new(code: c_int, message: impl Into<String>) -> Self {
        Error {
            code,
            message: message.into(),
        }
    }
}

/// A value bound to a statement parameter.
///
/// `Null` is a distinct variant rather than an `Option` wrapper because the
/// store's search binds a parameter that is sometimes a string and sometimes
/// SQL NULL, and `?1 IS NULL` has to see a real NULL for the "no exclusion"
/// case to work.
#[derive(Debug, Clone)]
pub enum Value {
    Null,
    Int(i64),
    Text(String),
    Blob(Vec<u8>),
}

impl From<i64> for Value {
    fn from(v: i64) -> Self {
        Value::Int(v)
    }
}

impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Value::Int(v as i64)
    }
}

impl From<usize> for Value {
    fn from(v: usize) -> Self {
        Value::Int(v as i64)
    }
}

impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Value::Text(v.to_string())
    }
}

impl From<String> for Value {
    fn from(v: String) -> Self {
        Value::Text(v)
    }
}

impl From<Vec<u8>> for Value {
    fn from(v: Vec<u8>) -> Self {
        Value::Blob(v)
    }
}

impl From<&[u8]> for Value {
    fn from(v: &[u8]) -> Self {
        Value::Blob(v.to_vec())
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Self {
        match v {
            Some(v) => v.into(),
            None => Value::Null,
        }
    }
}

pub struct Connection {
    handle: *mut ffi::sqlite3,
}

// A wasm module has one thread. The store is shared through an `Arc` and the
// engine's types demand `Send + Sync` to cross its channels, but no second
// thread exists to race with.
unsafe impl Send for Connection {}
unsafe impl Sync for Connection {}

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe { ffi::sqlite3_close(self.handle) };
    }
}

impl Connection {
    /// Open (or create) a database on whichever VFS is currently the default.
    ///
    /// The caller installs the VFS first; this stays agnostic so the same code
    /// runs against the in-memory VFS in tests and IndexedDB in the browser.
    pub fn open(path: &str) -> Result<Self> {
        let cpath = CString::new(path).map_err(|e| Error::new(ffi::SQLITE_MISUSE, e.to_string()))?;
        let mut handle = ptr::null_mut();
        let rc = unsafe {
            ffi::sqlite3_open_v2(
                cpath.as_ptr(),
                &mut handle,
                ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE,
                ptr::null(),
            )
        };
        if rc != ffi::SQLITE_OK {
            // The handle is returned even on failure, and closing it is how the
            // error message is reclaimed rather than leaked.
            let msg = unsafe { errmsg(handle) };
            unsafe { ffi::sqlite3_close(handle) };
            return Err(Error::new(rc, msg));
        }
        Ok(Connection { handle })
    }

    /// Run one or more statements, discarding any rows. Mirrors
    /// `rusqlite::Connection::execute_batch`.
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        let csql = CString::new(sql).map_err(|e| Error::new(ffi::SQLITE_MISUSE, e.to_string()))?;
        let rc = unsafe {
            ffi::sqlite3_exec(
                self.handle,
                csql.as_ptr(),
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if rc == ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(Error::new(rc, unsafe { errmsg(self.handle) }))
        }
    }

    pub fn prepare(&self, sql: &str) -> Result<Statement<'_>> {
        let csql = CString::new(sql).map_err(|e| Error::new(ffi::SQLITE_MISUSE, e.to_string()))?;
        let mut stmt = ptr::null_mut();
        let rc = unsafe {
            ffi::sqlite3_prepare_v2(
                self.handle,
                csql.as_ptr(),
                -1,
                &mut stmt,
                ptr::null_mut(),
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(Error::new(rc, unsafe { errmsg(self.handle) }));
        }
        Ok(Statement {
            handle: stmt,
            conn: self,
        })
    }

    /// Prepare, bind, and run to completion. For INSERT/UPDATE/DELETE.
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<()> {
        let mut stmt = self.prepare(sql)?;
        stmt.bind(params)?;
        while stmt.step()? {}
        Ok(())
    }

    /// Run `f` inside a transaction, rolling back if it fails.
    ///
    /// The store's `save` is a delete-then-reinsert, which would leave a session
    /// with no messages at all if it failed halfway.
    pub fn transaction<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.execute_batch("BEGIN")?;
        match f() {
            Ok(v) => {
                self.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}

unsafe fn errmsg(handle: *mut ffi::sqlite3) -> String {
    let p = ffi::sqlite3_errmsg(handle);
    if p.is_null() {
        return "unknown error".to_string();
    }
    CStr::from_ptr(p).to_string_lossy().into_owned()
}

pub struct Statement<'a> {
    handle: *mut ffi::sqlite3_stmt,
    conn: &'a Connection,
}

impl Drop for Statement<'_> {
    fn drop(&mut self) {
        unsafe { ffi::sqlite3_finalize(self.handle) };
    }
}

impl Statement<'_> {
    /// Bind positional parameters, 1-based as SQLite numbers them.
    pub fn bind(&mut self, params: &[Value]) -> Result<()> {
        for (i, v) in params.iter().enumerate() {
            let idx = (i + 1) as c_int;
            let rc = match v {
                Value::Null => unsafe { ffi::sqlite3_bind_null(self.handle, idx) },
                Value::Int(n) => unsafe { ffi::sqlite3_bind_int64(self.handle, idx, *n) },
                Value::Text(s) => unsafe {
                    // SQLITE_TRANSIENT tells SQLite to copy the string now. The
                    // alternative, STATIC, would have it borrow a pointer into a
                    // Rust String that is dropped at the end of this loop
                    // iteration.
                    ffi::sqlite3_bind_text(
                        self.handle,
                        idx,
                        s.as_ptr() as *const _,
                        s.len() as c_int,
                        ffi::SQLITE_TRANSIENT(),
                    )
                },
                Value::Blob(b) => unsafe {
                    // An empty Vec's pointer is dangling but never null, which
                    // is what separates a zero-length blob from SQL NULL here.
                    ffi::sqlite3_bind_blob(
                        self.handle,
                        idx,
                        b.as_ptr() as *const _,
                        b.len() as c_int,
                        ffi::SQLITE_TRANSIENT(),
                    )
                },
            };
            if rc != ffi::SQLITE_OK {
                return Err(Error::new(rc, unsafe { errmsg(self.conn.handle) }));
            }
        }
        Ok(())
    }

    /// Rewind a finished statement so it can be bound and run again.
    ///
    /// Bindings are cleared too. Without that, re-binding a shorter parameter
    /// list would silently reuse the previous row's values for the trailing
    /// parameters — which in `save`'s insert loop would mean a message
    /// inheriting the last one's tool calls.
    pub fn reset(&mut self) -> Result<()> {
        // sqlite3_reset returns the error from the *previous* step, which the
        // caller has already seen and handled; only clear_bindings can report
        // something new here.
        unsafe { ffi::sqlite3_reset(self.handle) };
        let rc = unsafe { ffi::sqlite3_clear_bindings(self.handle) };
        if rc == ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(Error::new(rc, unsafe { errmsg(self.conn.handle) }))
        }
    }

    /// Advance to the next row. `true` means a row is available to read.
    pub fn step(&mut self) -> Result<bool> {
        match unsafe { ffi::sqlite3_step(self.handle) } {
            ffi::SQLITE_ROW => Ok(true),
            ffi::SQLITE_DONE => Ok(false),
            rc => Err(Error::new(rc, unsafe { errmsg(self.conn.handle) })),
        }
    }

    /// Text of column `i`, or `None` when the column is SQL NULL.
    pub fn text(&self, i: usize) -> Option<String> {
        let i = i as c_int;
        if unsafe { ffi::sqlite3_column_type(self.handle, i) } == ffi::SQLITE_NULL {
            return None;
        }
        let p = unsafe { ffi::sqlite3_column_text(self.handle, i) };
        if p.is_null() {
            return None;
        }
        Some(unsafe { CStr::from_ptr(p as *const _) }
            .to_string_lossy()
            .into_owned())
    }

    /// Text of column `i`, empty string for NULL.
    ///
    /// The store's schema declares `title`, `created_at` and friends NOT NULL,
    /// so this is for columns that cannot be null but are read as owned strings.
    pub fn text_or_empty(&self, i: usize) -> String {
        self.text(i).unwrap_or_default()
    }

    pub fn int(&self, i: usize) -> i64 {
        unsafe { ffi::sqlite3_column_int64(self.handle, i as c_int) }
    }

    /// Bytes of column `i`; empty for SQL NULL and for a zero-length blob,
    /// which SQLite does not distinguish through this accessor.
    pub fn blob(&self, i: usize) -> Vec<u8> {
        let i = i as c_int;
        // Order matters: sqlite3_column_bytes must be called after the pointer
        // accessor for the length to describe what that pointer points at.
        let p = unsafe { ffi::sqlite3_column_blob(self.handle, i) };
        let n = unsafe { ffi::sqlite3_column_bytes(self.handle, i) } as usize;
        if p.is_null() || n == 0 {
            return Vec::new();
        }
        unsafe { std::slice::from_raw_parts(p as *const u8, n) }.to_vec()
    }

    /// Collect every remaining row through `f`.
    pub fn rows<T>(&mut self, mut f: impl FnMut(&Statement<'_>) -> T) -> Result<Vec<T>> {
        let mut out = Vec::new();
        while self.step()? {
            out.push(f(self));
        }
        Ok(out)
    }

    /// The first row through `f`, or `None` when the query matched nothing.
    /// Mirrors rusqlite's `query_row(..).optional()`.
    pub fn row<T>(&mut self, f: impl FnOnce(&Statement<'_>) -> T) -> Result<Option<T>> {
        if self.step()? {
            Ok(Some(f(self)))
        } else {
            Ok(None)
        }
    }
}
