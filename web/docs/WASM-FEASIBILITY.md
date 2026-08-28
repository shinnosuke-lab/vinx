# Can agent-core's engine run in a browser?

> **A historical note.** This is the feasibility study the project was
> started on, kept as the record of that decision; the numbers are from the
> bare engine at that point in time. The shipped module has grown since —
> the browser host, reqwest, the store and everything else in
> `crates/agent-web-core` ride along (about 1.2 MB gzipped today) — but the
> methodology (quote gzipped transfer, not raw `.wasm`) and the conclusions
> stand.

Yes. It compiles for `wasm32-unknown-unknown` with two small patches, and the
result is far smaller than the estimate this project was planned against.

Everything below is measured, not projected. Reproduce with `./deploy/measure.sh`.

## What it costs

Over the wire, gzipped, which is the only figure worth quoting:

| build | wasm | JS glue | total |
|---|---:|---:|---:|
| engine only | 316,879 | 7,021 | **323,900** |
| engine + SQLite + store + host | 731,418 | 11,593 | **743,011** |

The planning estimate was 3–5 MB. The engine alone is **324 KB**, an order of
magnitude smaller. For comparison, a lightweight Preact page shipped for a
small embedded device runs 91 KB gzipped.

Intermediate stages, to show why only the last one should be quoted:

| stage | engine only | + SQLite |
|---|---:|---:|
| `cargo build --release` | 1,411,380 | 2,468,626 |
| after wasm-bindgen + `wasm-opt -Oz` | 726,609 | 1,592,043 |
| after gzip | 316,879 | 731,418 |

Raw `.wasm` is about 4.5x the transfer size. Quoting it is how size budgets get
set wrong.

### An earlier measurement said 252 KB; it was wrong

Before the skill filesystem existed, the same probe measured 245 KB for the
engine. That number was optimistic for a structural reason worth remembering:
`std::fs` on wasm32 compiles to stubs that fail every call, so LLVM could see
that `read_dir` never returns entries and prune everything downstream of it —
the whole frontmatter parser, the reference resolver, the linter. Giving the
registry a filesystem that actually returns files made that code reachable and
added 72 KB.

The lesson generalises: on this target, anything gated behind a failing host call
is invisible to a size probe until the host call works.

### SQLite is more than half the download

**SQLite, the session store and the worker host cost 414,539 bytes gzipped —
more than the entire engine.** They turn a 324 KB download into a 743 KB one.

That was not obvious in advance, and it was weighed rather than assumed: session
storage stays on SQLite so the schema and `LIKE` search semantics remain
identical to the native `SqliteStore`, which is what lets a session move between
the desktop agent-core and this one. On an internal network that parity is worth
the bytes.

The alternative, if it ever stops being worth it, is implementing the store
directly against IndexedDB for a few KB, giving up parity and hand-rolling the
search index.

## What had to change

Three adaptations. They were originally carried as patch files over a synced
vendored copy; since the fork they are simply part of the sources under
`vendor/engine/`. The historical patch names are kept below because they
delimit the changes well.

**`0001-browser-clock.patch`** — `std::time::Instant` and `tokio::time::sleep`
compile on wasm32 but panic at runtime, because std maps time to `unsupported`
and tokio's timer has no driver. Both are swapped for [`wasmtimer`], which
reimplements them over `performance.now()` and `setTimeout` with identical
signatures, so each site is a one-line change. Eight call sites plus two type
annotations (`SkillRegistry`'s `checked_at` field and `emit_done`'s parameter).

**`0002-no-host-filesystem.patch`** — one `tokio::fs::read`, in the path that
turns an uploaded image into a data URL. `tokio`'s `fs` feature cannot be enabled
for wasm at all, so this is a hard compile error rather than a runtime one. It is
also dead code in a browser: the read is guarded by `upload_path`, which returns
`None` unless an uploads directory was configured, and nothing configures one.

**`0003-skill-vfs.patch`** — `SkillRegistry` is built on paths: it scans
directories, reads `SKILL.md`, resolves references against a skill's directory,
and writes its own state file.

The obvious move, rewriting it to take a `SkillSource` trait, would touch all 68
path-handling sites in `skill.rs` and turn every upstream edit into a merge
conflict. Only 20 of those sites actually perform I/O; the rest are `Path` and
`PathBuf`, which are pure string algebra and work on wasm untouched. So the
patch redirects just the I/O to `crate::vfs`, an in-memory tree that mirrors the
corner of `std::fs` the registry uses, and reads as a change of prefix rather
than a change of logic.

Two details there are not prefix swaps. `Path::is_file` and friends are inherent
methods that answer `false` on wasm rather than failing, so they become calls.
And `std::fs::canonicalize` backs `is_within`, the check that stops a skill's
references escaping its own directory; on wasm it fails, which makes the check
fail *closed* and rejects every reference. The VFS resolves `.` and `..`
lexically instead — equivalent to canonicalising here precisely because the tree
has no symlinks, so no path can normalise inside the base while resolving
outside it.

The registry's calls are synchronous, so the VFS is too: a snapshot is hydrated
from storage before the registry runs and flushed after a mutation. Skills are
small text files, so holding them in memory is fine, but a write is not durable
until something flushes.

Notably **not** changed: the `AGENT_SKILL_STATS_FILE` sink in `agent_loop.rs`
uses `SystemTime::now` and `std::fs`, both of which would panic, but it sits
behind a `std::env::var` that always returns `Err` on wasm. Leaving it alone
keeps the divergence from upstream smaller.

Upstream's own `#[cfg(test)]` modules — ~2,000 lines — are not carried by the
fork. They need dev-dependencies this crate has no reason to carry, and
`skill.rs`'s tests build fixtures through `std::fs` while the code under test
now reads through the VFS, so they would assert against a filesystem nothing
looks at. `crates/agent-web-core/tests/` covers this side instead.

## The `Send` bound is the real design constraint

Not a size problem, and the thing most likely to be mis-planned.

`Tool` is declared `Send + Sync`, and `#[async_trait]` adds a `Send` bound to the
future returned by `execute`. Nothing in the browser satisfies it: `JsFuture`,
`Promise` and every `web_sys` handle are `!Send`. A tool that simply awaits
`fetch` does not compile.

Patching the bound out would touch every call site in the engine and mean fighting
upstream forever. Instead the JS work moves off the tool's own future
(`crates/agent-web-core/src/bridge.rs`): `execute` sends the call down a channel
and awaits a `oneshot` reply — both `Send` — while the actual `fetch` runs in a
task started with `spawn_local`, which never needs to be `Send` because a wasm
module has one thread. This is verified to compile against the unmodified trait.

## Session storage

`SqliteStore` is not vendored — it is rusqlite-shaped, and rusqlite cannot link
here. It is ported instead, into `store.rs`, with the SQL copied across verbatim:
same two tables, same migrations, same queries. Anywhere the SQL diverges, the
cross-install promise that justifies bundling SQLite is broken, so it is copied
rather than rewritten in a nicer idiom.

rusqlite's role is taken by `sql.rs`, a wrapper over the C API that
`sqlite-wasm-rs` exposes, covering only the shape the store's queries use —
`prepare`, `bind`, `step`, typed column reads. No blobs, no floats, no statement
cache.

Verified by 18 tests (`./deploy/test.sh`) running against real SQLite compiled to
wasm, covering the parts that can drift silently: term ANDing across different
messages, exclusion of system/skill/tool rows from search, `LIKE` metacharacters
staying literal, char-indexed snippets over CJK, and `save` being a whole-table
rewrite. They use the in-memory VFS, so IndexedDB persistence itself still needs
a browser run.

Two deliberate divergences, both forced by the platform:

**No `PRAGMA journal_mode=WAL`.** WAL needs shared memory the IndexedDB VFS
cannot provide. Asking for it anyway is not an error — SQLite simply leaves the
database in whatever mode it was already in, which reads like a guarantee and
is not one.

**Timestamps are nudged to stay monotonic.** This one is worth knowing about
before it bites someone else. The store orders sessions by `updated_at`, and
upstream can trust the wall clock for that because a native `Utc::now()` has
nanosecond resolution. In a browser it is `Date.now()` — milliseconds, coarsened
further by some engines as a timing-attack defence — so two saves in the same
burst produce *identical* strings and "newest first" stops being defined. Two
tests failed on exactly this before it was understood.

The fix issues each timestamp as at least one microsecond past the last one
handed out. The alternative, adding a tiebreak column to the `ORDER BY`, would
have meant the queries no longer matching upstream's — and a tiebreak on `id`
would only be deterministic, not correct, since a UUID says nothing about
insertion order.

## Running the engine from a page

The engine lives in a Dedicated Worker, so a long turn or a large session query
never blocks rendering. `host.rs` is what the worker drives, and it emits
agent-core's SSE frames verbatim — `session`, `history`, live frames, then `done`
or `error`. Emitting the identical wire format is what will let the stock chat UI
run against this with only a `fetch` shim in between, rather than a port of the
UI.

**A worker dies with its document, and that changes one guarantee.** Upstream
lets a client attach to a turn that started before it connected, because the
server outlives the browser. Nothing here does: a reload ends the turn rather
than resuming it. The replay machinery is still needed and still used, but only
within a single page lifetime — the SPA navigating away from a running chat and
back, which the session sidebar makes easy. Worth stating plainly, because
"attach to a running turn" reads like it means the same thing in both places and
it does not.

Two smaller consequences of the same fact:

- Session storage falls back to in-memory when IndexedDB is refused (private
  windows, quota denials) rather than failing to start. The worker reports which
  mode it got, so the page can tell the user history will not survive.
- Persistence happens at the end of a turn, in one whole-table write, as
  upstream does. A tab closed mid-turn loses that turn.

## Forked surface

This study was done against nine engine files (~7,000 lines) copied from
agent-core at `5fe6ea0` (0.3.0); the fork has since grown to sixteen (the `os/`
tool layer and the task tool joined). The set is nearly closed: the files
reference only each other plus three host modules answered by browser-native
versions. See `vendor/VENDOR.json` for the file list and for why each excluded
module was excluded.

They are mounted at the crate root with `#[path]` rather than under an `engine::`
module, because they address each other as `crate::types`, `crate::tool` and so
on. Mounting them elsewhere would mean rewriting every internal path for no
gain.

## Toolchain notes

Three things that cost time and will cost it again on a fresh machine:

- **`getrandom` needs a backend.** wasm32-unknown-unknown has no OS entropy, so
  getrandom 0.3 refuses to pick one and `uuid`'s v4 generator fails to link. Fixed
  by `--cfg getrandom_backend="wasm_js"` in `.cargo/config.toml` plus the
  `wasm_js` feature.
- **wasm-pack's bundled `wasm-opt` rejects the module.** rustc emits
  `i32.trunc_sat_f64_u` by default; binaryen defaults to the MVP feature set and
  fails validation with "all used features should be allowed". Fixed by listing
  the post-MVP proposals in `[package.metadata.wasm-pack.profile.release]`. The
  same block switches `-O` to `-Oz`.
- **`sqlite-wasm-rs` must not use its default `bundled` feature.** That shells out
  to a clang able to emit wasm32 objects, which Xcode's cannot. `precompiled`
  ships the same library prebuilt.

Of the three SQLite VFS options, `relaxed-idb` is the one that fits — but not for
the reason usually assumed. None of them need COOP/COEP. The OPFS-backed
`sahpool` only runs inside a Dedicated Worker, which would pin the module to a
worker and rule out dropping it into a plain page, the stated goal here. The trade
is durability: `relaxed-idb` can lose the last commits if a tab dies mid-write,
which is why the store should flush on turn boundaries rather than trust the VFS.

[`wasmtimer`]: https://crates.io/crates/wasmtimer
