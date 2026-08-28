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
 *     snapshotted back — incrementally: the guest lists names with a
 *     size|mtime fingerprint (see share-diff.ts), and only files whose
 *     fingerprint moved are read (via the emulator's read_file) and
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
 * A quota keeps /data from eating the browser: 9p bytes live in page memory
 * (the guest's 128 MB does not cap them) and an unbounded mirror would make
 * both the page and the snapshot cycle heavier forever. Past
 * MAX_SHARE_TOTAL_BYTES the snapshot pauses (keeping the last good mirror)
 * and a `vinx:share-quota` event lets the page say so.
 *
 * Best-effort by nature: work done in the last seconds before a reload can
 * miss the snapshot; the motd and docs say as much. Directories are not
 * mirrored — each tier is flat files, and `share/local/` is the one nested
 * path there is.
 */

import { shq } from '../runtime/src/device-vm';
import type { VinxVm } from './vm';
import { machineId } from './pane-id';
import {
	diffSnapshot,
	MAX_SHARE_TOTAL_BYTES,
	mirrorable,
	parseStatLine,
	LOCAL_PREFIX,
	totalBytes,
	type FileStat,
} from './share-diff';

export { MAX_SHARE_TOTAL_BYTES, LOCAL_PREFIX };

const DB_NAME = 'vinx.vm';
const STORE = 'share';
/** Sidecar rows the file rows cannot express: per-tier exec-bit name lists
 * (9p restore creates plain 0644 files; chmod puts the bit back). Added in
 * DB version 2; version 1 databases upgrade by growing the empty store. */
const META = 'meta';
const SNAPSHOT_EVERY_MS = 15_000;
/** Everything lives in guest RAM (128 MB) and in IndexedDB; keep files sane. */
export const MAX_SHARE_FILE_BYTES = 16 * 1024 * 1024;

/** Fired (once per crossing) when /data exceeds the quota and snapshots pause. */
export const SHARE_QUOTA_EVENT = 'vinx:share-quota';

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

/** Bytes this VM's mirror currently holds — the drag-and-drop preflight. */
export async function storedShareBytes(): Promise<number> {
	const files = await storedFiles();
	let sum = 0;
	for (const bytes of files.values()) sum += bytes.byteLength;
	return sum;
}

/** The exec-bit name list for a tier: bare names, keyed by the tier's own
 * prefix (`c/`, `p1/`, `p2/` for private mirrors, `share/local/` for the
 * shared one — the same disjoint namespaces the file rows use). */
async function readExecList(key: string): Promise<string[]> {
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const req = d.transaction(META, 'readonly').objectStore(META).get(key);
		req.onsuccess = () =>
			resolve(Array.isArray(req.result) ? req.result.filter((n): n is string => typeof n === 'string') : []);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
	});
}

async function writeExecList(key: string, names: string[]): Promise<void> {
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const t = d.transaction(META, 'readwrite');
		t.objectStore(META).put(names, key);
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
	});
}

/** `chmod +x` a batch of restored files; a failure only costs the bit. */
async function reapplyExec(vm: VinxVm, dir: string, names: string[]): Promise<void> {
	if (!names.length) return;
	const args = names.map((n) => `${dir}/${shq(n)}`).join(' ');
	await vm.runShell(`chmod +x ${args}`, 10).catch((e) => {
		console.warn(`[share] could not re-apply exec bits under ${dir}:`, e);
	});
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

async function putMany(files: Map<string, Uint8Array>, remove: string[]): Promise<void> {
	if (!files.size && !remove.length) return;
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const t = d.transaction(STORE, 'readwrite');
		const s = t.objectStore(STORE);
		for (const [name, bytes] of files) s.put(bytes.slice().buffer, keyFor(name));
		for (const name of remove) s.delete(keyFor(name));
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
	});
}

/** The shared directory must exist before anything lands in it: the page-side
 * putFile walks the 9p tree and cannot create directories itself. */
async function ensureLocalDir(vm: VinxVm): Promise<void> {
	await vm.runShell('mkdir -p /data/share/local', 10);
}

async function restore(vm: VinxVm): Promise<void> {
	const files = await storedFiles();
	try {
		await ensureLocalDir(vm);
	} catch (e) {
		console.warn('[share] could not create /data/share/local:', e);
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
	// make chmod fail the whole batch.
	try {
		const [priv, local] = await Promise.all([readExecList(prefix()), readExecList(LOCAL_PREFIX)]);
		await reapplyExec(vm, '/data', priv.filter((n) => landed.has(n)));
		await reapplyExec(
			vm,
			'/data/share/local',
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
	await reapplyExec(
		vm,
		'/data/share/local',
		(Array.isArray(exec) ? exec : []).filter(
			(n): n is string => typeof n === 'string' && applied.has(n),
		),
	);
	for (const name of Array.isArray(removed) ? removed : []) {
		if (typeof name !== 'string' || !mirrorable(name)) continue;
		await vm.runShell(`rm -f /data/share/local/${shq(name)}`, 10).catch(() => {});
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
let overQuota = false;

async function snapshot(vm: VinxVm): Promise<void> {
	if (snapshotting || vm.getState() !== 'ready') return;
	snapshotting = true;
	try {
		// The directory itself exists even when an old cached image failed to
		// mount 9p. Require the real mount before treating an empty listing as
		// authoritative, or that fallback directory would erase the mirror.
		// The listing prints size|mtime|exec|name (name last: it is the only
		// field that may contain the separator), the /data/share/local pass
		// tagging its names with the `share/local/` prefix the rest of the
		// pipeline keys on. Built from wc and date because this busybox
		// carries no stat applet; `[ -f ]` keeps directories and an empty
		// share's literal `*` out, and the closing `true` keeps the loop's
		// last test from deciding the exit code.
		const stat = `printf '%s|%s|%s|%s\\n' "$(wc -c < "$f")" "$(date -r "$f" +%s)" "$([ -x "$f" ] && echo 1 || echo 0)"`;
		const ls = await vm.runShell(
			"grep -q ' /data 9p ' /proc/mounts || exit 9; " +
				`cd /data && for f in *; do [ -f "$f" ] && ${stat} "$f"; done; ` +
				`if [ -d /data/share/local ]; then cd /data/share/local; for f in *; do [ -f "$f" ] && ${stat} "share/local/$f"; done; fi; true`,
			15,
		);
		if (ls.exit_code !== 0) return;

		const listing = new Map<string, FileStat>();
		for (const line of ls.output.split('\n')) {
			const parsed = parseStatLine(line.trim());
			if (parsed) listing.set(parsed.name, parsed.stat);
		}

		// Over quota: keep the last good mirror, say so once, and try again
		// when the guest has cleaned up.
		if (totalBytes(listing) > MAX_SHARE_TOTAL_BYTES) {
			if (!overQuota) {
				overQuota = true;
				window.dispatchEvent(
					new CustomEvent(SHARE_QUOTA_EVENT, { detail: { bytes: totalBytes(listing) } }),
				);
				console.warn(
					`[share] over ${MAX_SHARE_TOTAL_BYTES / (1024 * 1024)} MB; persistence paused until /data shrinks`,
				);
			}
			return;
		}
		overQuota = false;

		const { read, remove } = diffSnapshot(fingerprints, listing, await storedNames());
		const changed = new Map<string, Uint8Array>();
		const next = new Map(listing);
		for (const name of read) {
			try {
				const bytes = await vm.readFile(name);
				if (bytes.byteLength > MAX_SHARE_FILE_BYTES) {
					console.warn(`[share] ${name} exceeds ${MAX_SHARE_FILE_BYTES} bytes, not persisted`);
					next.delete(name);
					continue;
				}
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
		await putMany(changed, remove);
		fingerprints = next;

		// The exec name lists mirror the whole current listing (not a delta):
		// the boot restore reads them cold, with no fingerprints to diff
		// against. Two tiny array rows per round.
		const privExec: string[] = [];
		const localExec: string[] = [];
		for (const [name, stat] of next) {
			if (!stat.exec) continue;
			if (name.startsWith(LOCAL_PREFIX)) localExec.push(name.slice(LOCAL_PREFIX.length));
			else privExec.push(name);
		}
		await writeExecList(prefix(), privExec);
		await writeExecList(LOCAL_PREFIX, localExec);

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

/**
 * Wire persistence onto the page's VM: restore on ready, then snapshot on an
 * interval and whenever the tab goes hidden (the closest thing to "before the
 * user leaves" that still allows async work), and keep /data/share/local in
 * step with the other pages' announcements. Called once by sharedVm().
 */
export function attachSharePersistence(vm: VinxVm): void {
	if (attached || typeof indexedDB === 'undefined') return;
	attached = true;
	attachedVm = vm;
	let restored = false;
	vm.onState((s) => {
		if (s !== 'ready' || restored) return;
		restored = true;
		void restore(vm).catch((e) => console.warn('[share] restore failed:', e));
	});
	setInterval(() => void snapshot(vm), SNAPSHOT_EVERY_MS);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') void snapshot(vm);
	});
	localChannel()?.addEventListener('message', (e) => {
		void applyRemote(vm, e.data).catch(() => {});
	});
}
