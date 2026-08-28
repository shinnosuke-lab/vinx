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
 *   - guest→host, every third round (~15 s): the guest lists /data/host with
 *     the same fingerprint trick share-store uses, and changed files are read
 *     back and written to the real disk through createWritable.
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
import { shq } from '../runtime/src/device-vm';
import type { VinxVm } from './vm';
import { machineId } from './pane-id';

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
			const dirs = new Set<string>(['/data/host']);
			for (const { path } of push) {
				const i = path.lastIndexOf('/');
				if (i > 0) dirs.add(`/data/host/${path.slice(0, i)}`);
			}
			await vm.runShell(`mkdir -p ${[...dirs].map(shq).join(' ')}`, 15);
			for (const { path, bytes } of push) {
				await vm.putFile(`host/${path}`, bytes);
			}
		}

		// Gone from the disk: gone from the guest (RAM, so this is safe).
		const rm: string[] = [];
		for (const path of hostFp.keys()) {
			if (files.has(path)) continue;
			hostFp.delete(path);
			synced.delete(path);
			guestFp.delete(path);
			rm.push(`/data/host/${shq(path)}`);
		}
		if (rm.length) await vm.runShell(`rm -f ${rm.join(' ')}`, 15);
	}

	async function guestSweep(): Promise<void> {
		// Same listing protocol as share-store: size|mtime|name, name last.
		const ls = await vm.runShell(
			'[ -d /data/host ] || exit 9; cd /data/host && ' +
				`find . -maxdepth ${MAX_MOUNT_DEPTH} -type f | while IFS= read -r f; do ` +
				`printf '%s|%s|%s\\n' "$(wc -c < "$f")" "$(date -r "$f" +%s)" "\${f#./}"; done; true`,
			20,
		);
		if (ls.exit_code !== 0) return;

		const seen = new Set<string>();
		for (const line of ls.output.split('\n')) {
			const first = line.indexOf('|');
			const second = first === -1 ? -1 : line.indexOf('|', first + 1);
			if (second === -1) continue;
			const size = Number(line.slice(0, first));
			const mtime = Number(line.slice(first + 1, second));
			const path = line.slice(second + 1).trim();
			if (!Number.isFinite(size) || !Number.isFinite(mtime) || !mountablePath(path)) continue;
			seen.add(path);
			const fp = `${size}|${mtime}`;
			if (guestFp.get(path) === fp) continue;
			guestFp.set(path, fp);
			if (size > MAX_MOUNT_FILE_BYTES) {
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
		for (const path of guestFp.keys()) {
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
