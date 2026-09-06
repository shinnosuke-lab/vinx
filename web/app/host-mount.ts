/**
 * A real folder from the person's disk, mounted into the guest at /data/host.
 *
 * File System Access gives the page a directory handle; this module keeps
 * that directory and the guest's /data/host converged with two sweeps on one
 * loop:
 *
 *   - host→guest, every round (~5 s): walk the handle, and every file whose
 *     size+mtime fingerprint moved is read, hashed and — unless the guest
 *     already has those exact bytes — pushed with putFile. Files that left
 *     the disk are rm'd from the guest.
 *   - guest→host, every third round (~15 s): the page walks its own 9p
 *     inodes under host/ with the same fingerprint trick share-store uses,
 *     and changed files are read back and written to the real disk through
 *     createWritable.
 *
 * The content hash is what stops the ring: a push flips the receiving side's
 * fingerprint, but the re-read bytes hash to what was just synced, so the
 * echo dies after one cheap read. Guest-side deletions deliberately do NOT
 * propagate — this code never removes anything from a real disk. (The guest
 * copy is not resurrected either: the host fingerprint did not move, so
 * nothing re-pushes. Touch the file on the host to bring it back.)
 *
 * Directories starting with a dot are skipped whole (.git alone would blow
 * every budget), and the budgets keep the pipeline polite: depth 5, 8 MB a
 * file, 64 MB and 400 files a directory. Past a budget the offender is
 * skipped (or the sweep pauses) and the chip's note callback says so.
 *
 * The handle itself is structured-cloneable, so it survives reloads in a
 * small IndexedDB of its own; only the permission does not — Chromium wants
 * one gesture-bound requestPermission per session, which is the mount chip's
 * "reconnect" click.
 */

import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { VinxVm } from './vm';
import { machineId } from './pane-id';
import { isRegularMode } from './share-diff';

export const MAX_MOUNT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_MOUNT_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_MOUNT_FILES = 400;
export const MAX_MOUNT_DEPTH = 5;

const HOST_SWEEP_MS = 5_000;
/** guest→host runs every Nth host sweep. */
const GUEST_EVERY = 3;

const DB_NAME = 'vinx.mount';
const STORE = 'handles';

// ── the remembered handle ──

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB refused to open'));
	});
}

/** Each machine (chat page, pane 1, pane 2) remembers its own mount. */
const dbKey = () => machineId();

export async function storedHandle(): Promise<FileSystemDirectoryHandle | null> {
	const d = await openDb();
	return new Promise((resolve) => {
		const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(dbKey());
		req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
		req.onerror = () => resolve(null);
	});
}

export async function storeHandle(handle: FileSystemDirectoryHandle): Promise<void> {
	const d = await openDb();
	return new Promise((resolve, reject) => {
		const t = d.transaction(STORE, 'readwrite');
		t.objectStore(STORE).put(handle, dbKey());
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
	});
}

export async function clearHandle(): Promise<void> {
	const d = await openDb();
	return new Promise((resolve) => {
		const t = d.transaction(STORE, 'readwrite');
		t.objectStore(STORE).delete(dbKey());
		t.oncomplete = () => resolve();
		t.onerror = () => resolve();
	});
}

// ── path hygiene ──

/**
 * A relative path the mount will carry: sane segments, no dot-names (hidden
 * files and directories stay home — think .git), nothing a line protocol or
 * a shell quote could trip on.
 */
export function mountablePath(path: string): boolean {
	if (!path || path.length > 512) return false;
	if (/[|\n\r\\\0]/.test(path)) return false;
	const parts = path.split('/');
	if (parts.length > MAX_MOUNT_DEPTH) return false;
	return parts.every((s) => s.length > 0 && s.length <= 128 && !s.startsWith('.'));
}

/** @noble, not crypto.subtle: the latter is missing on plain-HTTP LAN origins. */
function sha256(bytes: Uint8Array): string {
	return bytesToHex(sha256Bytes(bytes));
}

// ── the session ──

export interface MountSession {
	stop(): void;
}

export function startMount(
	vm: VinxVm,
	root: FileSystemDirectoryHandle,
	note: (msg: string) => void,
): MountSession {
	/** size:lastModified per host path — "did the disk move since last look". */
	const hostFp = new Map<string, string>();
	/** size|mtime per guest path — "did the guest move since last look". */
	const guestFp = new Map<string, string>();
	/** Content hash of the last bytes either side synced; the echo breaker. */
	const synced = new Map<string, string>();
	/** Budget overruns are worth one note each, not one per sweep. */
	const noted = new Set<string>();
	let stopped = false;
	let round = 0;

	const noteOnce = (key: string, msg: string) => {
		if (noted.has(key)) return;
		noted.add(key);
		note(msg);
	};

	async function scanHost(
		dir: FileSystemDirectoryHandle,
		prefix: string,
		depth: number,
		out: Map<string, File>,
	): Promise<void> {
		if (depth > MAX_MOUNT_DEPTH) return;
		for await (const [name, entry] of dir.entries()) {
			if (out.size > MAX_MOUNT_FILES) return;
			if (entry.kind === 'file') {
				const path = prefix + name;
				if (!mountablePath(path)) continue;
				out.set(path, await entry.getFile());
			} else if (!name.startsWith('.')) {
				await scanHost(entry as FileSystemDirectoryHandle, `${prefix}${name}/`, depth + 1, out);
			}
		}
	}

	async function hostSweep(): Promise<void> {
		const files = new Map<string, File>();
		await scanHost(root, '', 1, files);
		if (files.size > MAX_MOUNT_FILES) {
			noteOnce('files', `mount: over ${MAX_MOUNT_FILES} files; host→guest sync paused`);
			return;
		}
		let total = 0;
		for (const f of files.values()) total += f.size;
		if (total > MAX_MOUNT_TOTAL_BYTES) {
			noteOnce(
				'total',
				`mount: over ${MAX_MOUNT_TOTAL_BYTES / (1024 * 1024)} MB; host→guest sync paused`,
			);
			return;
		}
		noted.delete('files');
		noted.delete('total');

		// What changed on disk since the last look, by fingerprint.
		const push: { path: string; bytes: Uint8Array }[] = [];
		for (const [path, file] of files) {
			const fp = `${file.size}:${file.lastModified}`;
			if (hostFp.get(path) === fp) continue;
			if (file.size > MAX_MOUNT_FILE_BYTES) {
				hostFp.set(path, fp); // do not re-report every sweep
				noteOnce(`big:${path}`, `mount: ${path} is over 8 MB, skipped`);
				continue;
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			hostFp.set(path, fp);
			const hash = sha256(bytes);
			if (synced.get(path) === hash) continue; // the guest's own write, echoed
			synced.set(path, hash);
			push.push({ path, bytes });
		}

		if (push.length) {
			// Parents made on the page's own 9p tree (§8.2) — putFile walks
			// but never mkdirs, and no guest round trip is owed for it.
			const dirs = new Set<string>(['host']);
			for (const { path } of push) {
				const i = path.lastIndexOf('/');
				if (i > 0) dirs.add(`host/${path.slice(0, i)}`);
			}
			for (const dir of dirs) await vm.ensureDir(dir);
			for (const { path, bytes } of push) {
				await vm.putFile(`host/${path}`, bytes);
			}
		}

		// Gone from the disk: gone from the guest (RAM, so this is safe) —
		// unlinked page-side, same tree the push wrote into.
		for (const path of [...hostFp.keys()]) {
			if (files.has(path)) continue;
			hostFp.delete(path);
			synced.delete(path);
			guestFp.delete(path);
			vm.deleteData(`host/${path}`);
		}
	}

	/** The guest side of /data/host, walked on the page's own 9p inodes
	 * (share-store's listing moved the same way — §15 Phase 2): regular
	 * files only, dot-names skipped whole, depth capped like scanHost. */
	async function scanGuest(
		rel: string,
		prefix: string,
		depth: number,
		out: Map<string, { size: number; mtime: number }>,
	): Promise<void> {
		if (depth > MAX_MOUNT_DEPTH) return;
		for (const e of await vm.listData(rel)) {
			if (e.name.startsWith('.')) continue;
			if (e.dir) {
				await scanGuest(`${rel}/${e.name}`, `${prefix}${e.name}/`, depth + 1, out);
			} else if (isRegularMode(e.mode)) {
				out.set(prefix + e.name, { size: e.size, mtime: e.mtime });
			}
		}
	}

	async function guestSweep(): Promise<void> {
		const files = new Map<string, { size: number; mtime: number }>();
		try {
			await scanGuest('host', '', 1, files);
		} catch {
			return; // no /data/host yet: nothing has been pushed or made
		}

		const seen = new Set<string>();
		for (const [path, stat] of files) {
			if (!mountablePath(path)) continue;
			seen.add(path);
			const fp = `${stat.size}|${stat.mtime}`;
			if (guestFp.get(path) === fp) continue;
			guestFp.set(path, fp);
			if (stat.size > MAX_MOUNT_FILE_BYTES) {
				noteOnce(`big:${path}`, `mount: ${path} is over 8 MB, not written back`);
				continue;
			}
			try {
				const bytes = await vm.readFile(`host/${path}`);
				const hash = sha256(bytes);
				if (synced.get(path) === hash) continue; // our own push, echoed
				synced.set(path, hash);
				await writeHost(path, bytes);
				// The disk write moved the host fingerprint; forgetting ours
				// makes the next host sweep re-read, hash, match, and settle.
				hostFp.delete(path);
			} catch (e) {
				console.warn(`[mount] could not write ${path} back:`, e);
			}
		}
		for (const path of [...guestFp.keys()]) {
			if (!seen.has(path)) guestFp.delete(path); // deleted in the guest; the disk keeps its copy
		}
	}

	async function writeHost(path: string, bytes: Uint8Array): Promise<void> {
		const parts = path.split('/');
		let dir = root;
		for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
		const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
		const w = await fh.createWritable();
		await w.write(bytes as unknown as ArrayBuffer);
		await w.close();
	}

	// One self-rescheduling loop: sweeps never overlap, a slow round simply
	// delays the next, and a stop() between rounds is honored.
	void (async () => {
		while (!stopped) {
			try {
				await hostSweep();
				if (round % GUEST_EVERY === GUEST_EVERY - 1) await guestSweep();
			} catch (e) {
				console.warn('[mount] sweep failed:', e);
			}
			round++;
			await new Promise((r) => setTimeout(r, HOST_SWEEP_MS));
		}
	})();

	return {
		stop() {
			stopped = true;
		},
	};
}
