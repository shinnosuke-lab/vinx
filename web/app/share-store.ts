/**
 * The persistence behind /data — two tiers of it.
 *
 * The machine is RAM by design — a reload erases it — but /data is a 9p
 * filesystem whose actual bytes live on the page side, so the page can copy
 * them in and out. This module keeps an IndexedDB mirror of it:
 *
 *   - on boot (state `ready`), every stored file is replayed into the 9p
 *     share, so the guest wakes up with yesterday's /data;
 *   - periodically, and when the tab goes hidden, the live /data is
 *     snapshotted back — incrementally: the page lists its own 9p inodes
 *     with a size|mtime fingerprint (see share-diff.ts), and only files
 *     whose fingerprint moved are read (via the emulator's read_file) and
 *     re-written, one IndexedDB put per file. Deleted files lose their keys.
 *
 * The two tiers are two key namespaces over one object store:
 *
 *   - `/data` itself is private to its VM. The chat page and each terminal
 *     pane are separate VMs sharing one origin, so these keys wear a
 *     machine prefix (`c/`, `p1/`, `p2/` — see pane-id.ts) and all
 *     operations stay inside their own prefix — without that two live
 *     mirrors would overwrite each other.
 *   - `/data/share/local` is one directory for *all* the VMs on this origin:
 *     the chat page's, each split pane's, other tabs'. Its keys wear the
 *     literal `share/local/` prefix (no machine), so every mirror reads and
 *     writes the same rows. Live VMs hear about each other's changes over a
 *     BroadcastChannel: a snapshot that stored new shared bytes announces the
 *     names, and every other page replays them into its own guest. The
 *     guest-side `share local` command is just `cp` into /data/share/local —
 *     the snapshot does the rest. Nothing here touches the network: the tier
 *     is IndexedDB + BroadcastChannel, same-origin, offline-friendly.
 *
 * The announce/apply loop does not ring forever: an applied file comes back
 * through the receiver's next snapshot with a moved mtime, but its bytes
 * match the mirror, and identical bytes are neither stored nor re-announced.
 * (A deletion racing a concurrent snapshot on another page can resurrect a
 * file — best-effort is the contract here, and the mirrors do converge.)
 *
 * Quotas keep /data from eating the browser: 9p bytes live in page memory
 * (the guest's 128 MB does not cap them) and an unbounded mirror would make
 * both the page and the snapshot cycle heavier forever. Past
 * MAX_SHARE_TOTAL_BYTES — or past MAX_MIRROR_FILES, its recursive twin —
 * the snapshot pauses (keeping the last good mirror) and a
 * `vinx:share-quota` event lets the page say so.
 *
 * Best-effort by nature: work done in the last seconds before a reload can
 * miss the snapshot; the motd and docs say as much. The private tier is a
 * real tree (§15 Phase 4): keys are relative paths, directories come back
 * on restore before their files do. `share/local/` stays flat — its
 * announce protocol names bare files across machines. What never enters
 * the mirror: dot segments anywhere (`.vinx/`), and the `host/` subtree
 * (host-mount syncs it with a real disk; see share-diff.ts).
 *
 * The 15-second cycle is the floor, not the only trigger: the guest's own
 * 9p writes ring vm.ts's `9p-write-end` doorbell (§12.1 — a dirty flag,
 * not a locator: the event names only a basename, and mkdir/unlink don't
 * ring at all), which schedules a snapshot a couple of seconds out. The
 * page's own writes bypass the 9p protocol layer and stay silent, so a
 * restore never rings the bell it is answering.
 */

import type { VinxVm } from './vm';
import { machineId } from './pane-id';
import {
	diffSnapshot,
	listingFromEntries,
	MAX_MIRROR_FILES,
	MAX_SHARE_TOTAL_BYTES,
	mirrorable,
	LOCAL_PREFIX,
	totalBytes,
	walkListing,
	type FileStat,
} from './share-diff';

export { MAX_SHARE_TOTAL_BYTES, LOCAL_PREFIX };

const DB_NAME = 'vinx.vm';
const STORE = 'share';
/** Sidecar rows the file rows cannot express: per-tier exec-bit lists
 * (9p restore creates plain 0644 files; the page-side chmod puts the bit
 * back). Entries are tier-relative paths — a root-level file is still its
 * bare name, so version-2 rows read back unchanged. Added in DB version 2;
 * version 1 databases upgrade by growing the empty store. */
const META = 'meta';
const SNAPSHOT_EVERY_MS = 15_000;
/** How long after the 9p doorbell before the snapshot runs: long enough to
 * coalesce a burst of writes, short enough to beat the 15 s floor hollow. */
const DOORBELL_DEBOUNCE_MS = 2_000;
/** Everything lives in guest RAM (128 MB) and in IndexedDB; keep files sane. */
export const MAX_SHARE_FILE_BYTES = 16 * 1024 * 1024;

/** Fired (once per crossing) when /data exceeds the quota and snapshots pause. */
export const SHARE_QUOTA_EVENT = 'vinx:share-quota';

/** Fired once per boot when the mirror has been replayed into /data — the
 * point at which the machine's files are all there. Listed by the Apps
 * page (vendored, hears it off the window) to ask rund again: at `ready`
 * the tree is still empty, and app.list would say "nothing installed". */
export const DATA_RESTORED_EVENT = 'vinx:data-restored';

/** Same-origin pages tell each other /data/share/local moved on this channel. */
const LOCAL_CHANNEL = 'vinx.share.local';

const prefix = () => `${machineId() === 'c' ? 'c' : `p${machineId()}`}/`;

/**
 * Names travel in "listing space" throughout this module: a private file is
 * its bare name, a shared file keeps its `share/local/` prefix — which is
 * also, verbatim, both its IndexedDB key and its path under the 9p root.
 * Only private keys need the machine prefix added.
 */
const keyFor = (name: string) => (name.startsWith(LOCAL_PREFIX) ? name : prefix() + name);

let db: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!db) {
		db = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 2);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
				if (!req.result.objectStoreNames.contains(META)) req.result.createObjectStore(META);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error ?? new Error('IndexedDB refused to open'));
		});
	}
	return db;
}

function tx(d: IDBDatabase, mode: IDBTransactionMode) {
	return d.transaction(STORE, mode).objectStore(STORE);
}

/** The key range covering this machine's private mirror and nothing else. */
function machineRange(): IDBKeyRange {
	return IDBKeyRange.bound(prefix(), `${prefix()}\uffff`);
}

/** The key range covering the shared tier. `share/local/` cannot collide
 * with a machine prefix: those are `c/` and `p<digit>/`, never `sh`. */
function localRange(): IDBKeyRange {
	return IDBKeyRange.bound(LOCAL_PREFIX, `${LOCAL_PREFIX}\uffff`);
}

function readRange(range: IDBKeyRange, strip: number): Promise<Map<string, Uint8Array>> {
	return openDb().then(
		(d) =>
			new Promise((resolve, reject) => {
				const out = new Map<string, Uint8Array>();
				const req = tx(d, 'readonly').openCursor(range);
				req.onsuccess = () => {
					const cur = req.result;
					if (!cur) return resolve(out);
					out.set(String(cur.key).slice(strip), new Uint8Array(cur.value as ArrayBuffer));
					cur.continue();
				};
				req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
			}),
	);
}

/** Both tiers this VM mirrors, names in listing space. */
async function storedFiles(): Promise<Map<string, Uint8Array>> {
	const [priv, shared] = await Promise.all([
		readRange(machineRange(), prefix().length),
		readRange(localRange(), 0),
	]);
	return new Map([...priv, ...shared]);
}

async function storedNames(): Promise<Set<string>> {
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const out = new Set<string>();
		let waiting = 2;
		const one = (range: IDBKeyRange, strip: number) => {
			const req = tx(d, 'readonly').getAllKeys(range);
			req.onsuccess = () => {
				for (const k of req.result) out.add(String(k).slice(strip));
				if (--waiting === 0) resolve(out);
			};
			req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
		};
		one(machineRange(), prefix().length);
		one(localRange(), 0);
	});
}

/** One mirrored file's bytes, or null. `name` in listing space. */
async function storedFile(name: string): Promise<Uint8Array | null> {
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const req = tx(d, 'readonly').get(keyFor(name));
		req.onsuccess = () =>
			resolve(req.result ? new Uint8Array(req.result as ArrayBuffer) : null);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
	});
}

/**
 * This machine's private mirror under one directory, names relative to it
 * — what a powered-off machine's /data holds, read without booting it.
 * The Apps page lists /data/apps from here while the machine is off (the
 * installed packages are facts about the machine whether or not it runs),
 * and opens a pure web app's package from here too. `dir` without a
 * trailing slash; an empty map for a directory the mirror does not have.
 */
export async function mirroredDir(dir: string): Promise<Map<string, Uint8Array>> {
	const at = `${prefix()}${dir.replace(/^\/+|\/+$/g, '')}/`;
	return readRange(IDBKeyRange.bound(at, `${at}\uffff`), at.length);
}

/** Bytes this VM's mirror currently holds — the drag-and-drop preflight. */
export async function storedShareBytes(): Promise<number> {
	const files = await storedFiles();
	let sum = 0;
	for (const bytes of files.values()) sum += bytes.byteLength;
	return sum;
}

/** The exec-bit list for a tier: tier-relative paths, keyed by the tier's
 * own prefix (`c/`, `p1/`, `p2/` for private mirrors, `share/local/` for
 * the shared one — the same disjoint namespaces the file rows use). */
async function readExecList(key: string): Promise<string[]> {
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const req = d.transaction(META, 'readonly').objectStore(META).get(key);
		req.onsuccess = () =>
			resolve(Array.isArray(req.result) ? req.result.filter((n): n is string => typeof n === 'string') : []);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
	});
}

/** Give a batch of restored files their exec bit back, straight on the
 * page-side inodes (the 9p writes made them 0644); a miss costs the bit. */
function reapplyExec(vm: VinxVm, prefixPath: string, names: string[]): void {
	for (const n of names) {
		try {
			vm.setExecData(prefixPath + n, true);
		} catch (e) {
			console.warn(`[share] could not re-apply exec bit on ${prefixPath}${n}:`, e);
		}
	}
}

/** Persist one file immediately (drag-and-drop calls this beside putFile). */
export async function storeShareFile(name: string, bytes: Uint8Array): Promise<void> {
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const t = d.transaction(STORE, 'readwrite');
		// Copy into a standalone ArrayBuffer: the Uint8Array may be a view.
		t.objectStore(STORE).put(bytes.slice().buffer, keyFor(name));
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
	});
}

/** Drop files from this machine's mirror, in one transaction — the page's
 * `rm` while the machine is off (an `app remove` made here, vm-apps.ts):
 * with the machine off the mirror is /data as the person knows it, and the
 * replay at the next boot simply never puts these back. Names absent from
 * the mirror are no error, like `rm -f`. */
export async function removeShareFiles(names: string[]): Promise<void> {
	if (!names.length) return;
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const t = d.transaction(STORE, 'readwrite');
		const s = t.objectStore(STORE);
		for (const name of names) s.delete(keyFor(name));
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error ?? new Error('IndexedDB delete failed'));
	});
}

/** One snapshot round's writes, atomically: file rows and the exec sidecar
 * rows commit in a single transaction across both stores, so a crash cannot
 * leave the exec lists describing files the mirror does not hold (§12.1's
 * atomicity asked exactly this of the persistence side). */
async function putMany(
	files: Map<string, Uint8Array>,
	remove: string[],
	execRows: Map<string, string[]>,
): Promise<void> {
	if (!files.size && !remove.length && !execRows.size) return;
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const t = d.transaction([STORE, META], 'readwrite');
		const s = t.objectStore(STORE);
		for (const [name, bytes] of files) s.put(bytes.slice().buffer, keyFor(name));
		for (const name of remove) s.delete(keyFor(name));
		const m = t.objectStore(META);
		for (const [key, names] of execRows) m.put(names, key);
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
	});
}

/** The shared directory must exist before anything lands in it: putFile
 * walks the 9p tree and cannot create directories itself. Made page-side —
 * the tree is the page's own (§8.2), no guest round trip owed. */
async function ensureLocalDir(vm: VinxVm): Promise<void> {
	await vm.ensureDir(LOCAL_PREFIX);
}

async function restore(vm: VinxVm): Promise<void> {
	const files = await storedFiles();
	try {
		await ensureLocalDir(vm);
	} catch (e) {
		console.warn('[share] could not create /data/share/local:', e);
	}
	// Parents first, on the page's own 9p tree (putFile walks but never
	// mkdirs): the directory set falls out of the file paths, and ensureDir
	// creates each chain segment by segment — restored trees come back as
	// trees, not as a pile of failed writes.
	const dirs = new Set<string>();
	for (const name of files.keys()) {
		const i = name.lastIndexOf('/');
		if (i > 0) dirs.add(name.slice(0, i));
	}
	for (const dir of dirs) {
		try {
			await vm.ensureDir(dir);
		} catch (e) {
			console.warn(`[share] could not create /data/${dir}:`, e);
		}
	}
	const landed = new Set<string>();
	for (const [name, bytes] of files) {
		try {
			await vm.putFile(name, bytes);
			landed.add(name);
		} catch (e) {
			console.warn(`[share] could not restore ${name}:`, e);
		}
	}
	// The 9p writes above made every file 0644; give the scripts their bit
	// back. Only files that actually landed — a stale meta name must not
	// cost the whole batch.
	try {
		const [priv, local] = await Promise.all([readExecList(prefix()), readExecList(LOCAL_PREFIX)]);
		reapplyExec(vm, '', priv.filter((n) => landed.has(n)));
		reapplyExec(
			vm,
			LOCAL_PREFIX,
			local.filter((n) => landed.has(LOCAL_PREFIX + n)),
		);
	} catch (e) {
		console.warn('[share] could not restore exec bits:', e);
	}
}

// ── the BroadcastChannel between this page and its siblings ──

let channel: BroadcastChannel | null | undefined;

function localChannel(): BroadcastChannel | null {
	if (channel === undefined) {
		channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(LOCAL_CHANNEL);
	}
	return channel;
}

/** Names bare (no `share/local/`); `exec` is the subset of `changed` whose
 * executable bit is set. A page never hears its own announcements. */
function announce(changed: string[], removed: string[], exec: string[]): void {
	if (changed.length || removed.length) localChannel()?.postMessage({ changed, removed, exec });
}

/** A sibling page changed /data/share/local: replay its mirror rows into this
 * guest. Skipped while the VM is not up — the boot restore replays anyway. */
async function applyRemote(vm: VinxVm, data: unknown): Promise<void> {
	if (vm.getState() !== 'ready') return;
	const { changed, removed, exec } = (data ?? {}) as {
		changed?: unknown;
		removed?: unknown;
		exec?: unknown;
	};
	const names = (Array.isArray(changed) ? changed : []).filter(
		(n): n is string => typeof n === 'string' && mirrorable(n),
	);
	if (names.length) {
		// An announcement can land in the moment between `ready` and the boot
		// restore's own mkdir; putFile cannot create directories itself.
		await ensureLocalDir(vm).catch(() => {});
	}
	const applied = new Set<string>();
	for (const name of names) {
		try {
			const bytes = await storedFile(LOCAL_PREFIX + name);
			if (bytes) {
				await vm.putFile(LOCAL_PREFIX + name, bytes);
				applied.add(name);
			}
		} catch (e) {
			console.warn(`[share] could not apply share/local/${name}:`, e);
		}
	}
	reapplyExec(
		vm,
		LOCAL_PREFIX,
		(Array.isArray(exec) ? exec : []).filter(
			(n): n is string => typeof n === 'string' && applied.has(n),
		),
	);
	for (const name of Array.isArray(removed) ? removed : []) {
		if (typeof name !== 'string' || !mirrorable(name)) continue;
		vm.deleteData(LOCAL_PREFIX + name);
	}
}

/**
 * Put a file into /data/share/local from the page itself — the chat
 * attachment path. Mirrors first (IndexedDB is the durable copy), then into
 * the live guest, then tells the other pages. The name is flattened to
 * something the mirror can carry; the caller shows the returned name to the
 * person.
 */
export async function shareLocalFile(
	vm: VinxVm,
	name: string,
	bytes: Uint8Array,
): Promise<string> {
	let safe = name.replace(/[/\\|\n\r\0]/g, '_').slice(-128);
	if (!mirrorable(safe)) safe = `file-${Date.now()}`;
	if (bytes.byteLength > MAX_SHARE_FILE_BYTES) {
		throw new Error(`${name} is ${bytes.byteLength} bytes; /data carries at most ${MAX_SHARE_FILE_BYTES}`);
	}
	await storeShareFile(LOCAL_PREFIX + safe, bytes);
	try {
		await ensureLocalDir(vm);
		await vm.putFile(LOCAL_PREFIX + safe, bytes);
	} catch (e) {
		// The mirror holds it; this VM picks it up on its next boot restore.
		console.warn(`[share] share/local/${safe} mirrored but not live:`, e);
	}
	announce([safe], [], []);
	return safe;
}

/** Last round's fingerprints; files whose stat moved get re-read. */
let fingerprints = new Map<string, FileStat>();
let snapshotting = false;
/** Up while the boot restore replays the mirror: a snapshot that ran mid-
 * replay would fingerprint half a tree as the whole truth (§12.1's "restore
 * atomically" is this gate plus the parents-first replay above). */
let restoring = false;
let overQuota = false;
/** Has this boot's replay landed — is the guest's /data whole? False from
 * the moment the machine goes down until the next restore completes. */
let whole = false;
/** Per-file-cap offenders already named once; a Set, not a log flood. */
const warnedOversize = new Set<string>();

/**
 * Whether the guest's /data is whole — this boot's mirror replay has
 * landed. At `ready` the tree is still empty: an edit the guest CLI makes
 * to /data/apps in that gap (`app remove`, `app enable`) is undone a
 * second later when the replay puts the mirror's copy back. What must
 * edit the guest's /data waits for DATA_RESTORED_EVENT while this is
 * false (vm-apps.ts). Without persistence attached there is no replay to
 * wait for, and the tree is as whole as it gets.
 */
export function dataWhole(): boolean {
	return !attached || whole;
}

async function snapshot(vm: VinxVm): Promise<void> {
	if (snapshotting || restoring || vm.getState() !== 'ready') return;
	snapshotting = true;
	try {
		// An ephemeral machine (another tab holds this machineId, see
		// vm.ts claimIdentity) reads the mirror at boot but never writes
		// it back: its private files live and die with the tab, and its
		// listing must not delete the owner's rows. The origin-shared
		// share/local tier stays writable — an explicit share addresses
		// every machine by design, not this machine's archive.
		const owner = await vm.isOwner();
		// The listing comes from the page's own 9p inodes (§15 Phase 2) —
		// the very object store the mirror replays into, so it is the truth
		// whether or not the guest managed to mount /data: an unmounted
		// guest cannot have written here, and the old "require the real
		// mount or an empty fallback directory erases the mirror" hazard is
		// structurally gone. The private tier is walked recursively
		// (walkListing keys on relative paths and excludes dot segments,
		// `host/` and `share/` by rule — §12.1); the share/local pass stays
		// flat and tags its names with the prefix the pipeline keys on.
		const listing = new Map<string, FileStat>();
		let overflow = false;
		if (owner) {
			const walked = await walkListing(vm);
			overflow = walked.overflow;
			for (const [name, stat] of walked.listing) listing.set(name, stat);
		}
		try {
			for (const [name, stat] of listingFromEntries(
				await vm.listData(LOCAL_PREFIX),
				LOCAL_PREFIX,
			)) {
				listing.set(name, stat);
			}
		} catch {
			// share/local does not exist yet on this boot; nothing shared.
		}

		// Over quota — too many bytes, or too many files for one machine's
		// tree: keep the last good mirror, say so once, and try again when
		// the guest has cleaned up.
		if (overflow || totalBytes(listing) > MAX_SHARE_TOTAL_BYTES) {
			if (!overQuota) {
				overQuota = true;
				window.dispatchEvent(
					new CustomEvent(SHARE_QUOTA_EVENT, {
						detail: { bytes: totalBytes(listing), ...(overflow ? { files: MAX_MIRROR_FILES } : {}) },
					}),
				);
				console.warn(
					overflow
						? `[share] over ${MAX_MIRROR_FILES} files; persistence paused until /data shrinks`
						: `[share] over ${MAX_SHARE_TOTAL_BYTES / (1024 * 1024)} MB; persistence paused until /data shrinks`,
				);
			}
			return;
		}
		overQuota = false;

		// The mirror-key set feeds the remove list; a non-owner must not see
		// private rows there, or its (filtered) listing would delete them all.
		const mirrored = await storedNames();
		if (!owner) for (const name of mirrored) if (!name.startsWith(LOCAL_PREFIX)) mirrored.delete(name);

		// A file past the per-file cap is settled at stat time — no read, no
		// per-round re-read, one warning. Dropping it from this round's
		// mirror view too keeps its last good version (if any) out of the
		// remove list, the same keep-what-we-had stance the quota takes.
		for (const [name, stat] of listing) {
			if (stat.size <= MAX_SHARE_FILE_BYTES) continue;
			listing.delete(name);
			mirrored.delete(name);
			if (!warnedOversize.has(name)) {
				warnedOversize.add(name);
				console.warn(`[share] ${name} exceeds ${MAX_SHARE_FILE_BYTES} bytes, not persisted`);
			}
		}

		const { read, remove } = diffSnapshot(fingerprints, listing, mirrored);
		const changed = new Map<string, Uint8Array>();
		const next = new Map(listing);
		for (const name of read) {
			try {
				const bytes = await vm.readFile(name);
				// A shared file another page announced and this one applied
				// has a fresh mtime but the mirror's exact bytes: storing it
				// again would re-announce it and ring the pages forever.
				// Identical bytes are settled — update the fingerprint and
				// move on.
				if (name.startsWith(LOCAL_PREFIX)) {
					const mirror = await storedFile(name);
					if (mirror && sameBytes(mirror, bytes)) continue;
				}
				changed.set(name, bytes);
			} catch {
				// Deleted between stat and read, or unreadable: retry next round.
				next.delete(name);
			}
		}

		// The exec lists mirror the whole current listing (not a delta): the
		// boot restore reads them cold, with no fingerprints to diff against.
		// They ride the same transaction as the file rows — a crash cannot
		// leave them describing a mirror that never landed.
		const privExec: string[] = [];
		const localExec: string[] = [];
		for (const [name, stat] of next) {
			if (!stat.exec) continue;
			if (name.startsWith(LOCAL_PREFIX)) localExec.push(name.slice(LOCAL_PREFIX.length));
			else privExec.push(name);
		}
		const execRows = new Map<string, string[]>();
		// A non-owner's private exec list would be empty (see the listing
		// filter) — writing it would clobber the owner's row.
		if (owner) execRows.set(prefix(), privExec);
		execRows.set(LOCAL_PREFIX, localExec);
		await putMany(changed, remove, execRows);
		fingerprints = next;

		const bare = (n: string) => n.slice(LOCAL_PREFIX.length);
		const changedLocal = [...changed.keys()].filter((n) => n.startsWith(LOCAL_PREFIX)).map(bare);
		announce(
			changedLocal,
			remove.filter((n) => n.startsWith(LOCAL_PREFIX)).map(bare),
			changedLocal.filter((n) => localExec.includes(n)),
		);
	} catch (e) {
		console.warn('[share] snapshot failed:', e);
	} finally {
		snapshotting = false;
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

let attached = false;
let attachedVm: VinxVm | null = null;

/**
 * Snapshot now instead of waiting out the 15-second interval. The share_local
 * device tool calls this after the guest `share local` lands, so the other
 * pages hear the announcement within a second rather than half a snapshot
 * round. Harmless when nothing changed (the diff comes back empty) and when
 * persistence is not attached.
 */
export function requestSnapshot(): void {
	if (attachedVm) void snapshot(attachedVm);
}

let inFlight: Promise<void> | null = null;

/**
 * A snapshot the caller can wait for — the one to take before the machine
 * goes away. The tick, the doorbell and requestSnapshot are all best-effort
 * and skip when a round is running; a power-off must not: whatever the
 * guest wrote since the last round (an `app remove`, a file saved seconds
 * ago) exists nowhere but in the machine's RAM until it lands in the
 * mirror. Waits out a round in progress, then runs one. Resolves at once
 * when persistence is not attached or the machine is not up (nothing to
 * save, or nothing to save from).
 */
export async function flushMirror(): Promise<void> {
	const vm = attachedVm;
	if (!vm || vm.getState() !== 'ready') return;
	while (snapshotting) await new Promise((r) => setTimeout(r, 50));
	inFlight ??= snapshot(vm).finally(() => {
		inFlight = null;
	});
	await inFlight;
}

/**
 * Wire persistence onto the page's VM: restore on ready, then snapshot on a
 * self-rescheduling loop (a recursive walk of a big tree must not overlap
 * itself — a slow round just delays the next), on the guest's 9p write
 * doorbell (debounced), and whenever the tab goes hidden (the closest thing
 * to "before the user leaves" that still allows async work); keep
 * /data/share/local in step with the other pages' announcements. Called
 * once by sharedVm().
 */
export function attachSharePersistence(vm: VinxVm): void {
	if (attached || typeof indexedDB === 'undefined') return;
	attached = true;
	attachedVm = vm;
	// Every boot restores: a machine powered off and on again comes up with
	// an empty /data (the 9p tree is built with the emulator) and needs its
	// mirror replayed the same as a first boot. Once per boot, not once per
	// page — the latch resets when the machine goes down.
	let restoredThisBoot = false;
	vm.onState((s) => {
		if (s === 'off' || s === 'failed') {
			restoredThisBoot = false;
			whole = false;
			return;
		}
		if (s !== 'ready' || restoredThisBoot) return;
		restoredThisBoot = true;
		restoring = true;
		void restore(vm)
			.catch((e) => console.warn('[share] restore failed:', e))
			.finally(() => {
				restoring = false;
				whole = true;
				// The moment /data is whole again: what lists it (the Apps
				// page) asked at `ready` and saw an empty tree; ask again.
				if (typeof window !== 'undefined') window.dispatchEvent(new Event(DATA_RESTORED_EVENT));
			});
	});
	const loop = () => {
		void snapshot(vm).finally(() => setTimeout(loop, SNAPSHOT_EVERY_MS));
	};
	setTimeout(loop, SNAPSHOT_EVERY_MS);
	// The guest's own 9p writes ring here (vm.ts's 9p-write-end listener);
	// one trailing debounce turns a burst into one early snapshot. Restores
	// and other page-side writes bypass the 9p protocol layer and stay
	// silent, so the bell never answers itself.
	let bell: ReturnType<typeof setTimeout> | null = null;
	vm.onDataWritten(() => {
		bell ??= setTimeout(() => {
			bell = null;
			void snapshot(vm);
		}, DOORBELL_DEBOUNCE_MS);
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') void snapshot(vm);
	});
	localChannel()?.addEventListener('message', (e) => {
		void applyRemote(vm, e.data).catch(() => {});
	});
}
