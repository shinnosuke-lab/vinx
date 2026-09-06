/**
 * The pure half of /data snapshotting, kept free of DOM and IndexedDB so the
 * runtime test suite can cover it directly.
 *
 * A snapshot does not rewrite the whole mirror: the page walks its own 9p
 * inodes (no guest round trip — §15 Phase 2 retired the `for f in *` shell
 * listing, §15 Phase 4 made the walk recursive) with a size|mtime
 * fingerprint per file, and only files whose fingerprint moved are read and
 * re-written. That keeps the 15-second cycle near-free while the tree is
 * quiet, however big it is.
 *
 * The private tier is a real tree now (walkListing); `share/local/` stays
 * the flat origin-shared tier it always was (listingFromEntries), because
 * its announce protocol names bare files across machines. What never enters
 * the mirror, by rule rather than by a glob that happened not to match
 * (§12.1): dot segments anywhere (`.vinx/` and its tmp namespace), the
 * `host/` subtree (synced with a person's real disk by host-mount — a
 * second copy in IndexedDB would double-write and eat the quota), and the
 * `share/` namespace on the private pass (its `local/` tier has its own).
 */

import type { DataEntry } from '../runtime/src/device-vm';

export interface FileStat {
	size: number;
	mtime: number;
	/** The executable bit — the one mode bit the mirror preserves. 9p
	 * restore creates plain 0644 files, so without carrying this a script
	 * would come back un-runnable after a reload. */
	exec: boolean;
}

/** Per-machine ceiling for /data: past this the snapshot pauses rather than
 * letting the mirror (and the page's memory) grow without bound. */
export const MAX_SHARE_TOTAL_BYTES = 64 * 1024 * 1024;

/** Directory depth the private mirror follows; deeper trees are cut with a
 * warning, not silently half-carried (§12.1: bounded paths and depth). */
export const MAX_MIRROR_DEPTH = 8;

/** File-count ceiling for one machine's private tree — the recursive twin
 * of the byte quota: past it the snapshot pauses and says so. */
export const MAX_MIRROR_FILES = 2000;

/** The one nested directory the mirror carries: /data/share/local, the files
 * every VM on this origin sees. Doubles as the IndexedDB key prefix for them.
 * (`share/` is the sharing namespace; a future relay-backed tier would be
 * `share/net/` beside it.) */
export const LOCAL_PREFIX = 'share/local/';

/** POSIX file-type check on a raw inode mode: mirrors and mounts carry
 * regular files only — a guest-made symlink or fifo must not become "bytes". */
export function isRegularMode(mode: number): boolean {
	return (mode & 0o170000) === 0o100000;
}

/**
 * One tier's page-side inode listing folded into the snapshot's name→stat
 * map. Regular files only; dot-names are excluded explicitly — `.vinx/` and
 * relay files stay out of the mirror by rule, not by a glob that happened
 * not to match (§12.1). The single sanctioned prefix is `share/local/`: the
 * caller tags that tier's names with it, and the name keeps it — it is the
 * namespace the whole pipeline keys on.
 */
export function listingFromEntries(
	entries: readonly DataEntry[],
	prefix = '',
): Map<string, FileStat> {
	const out = new Map<string, FileStat>();
	for (const e of entries) {
		if (e.dir || !isRegularMode(e.mode)) continue;
		if (e.name.startsWith('.')) continue;
		if (!mirrorable(e.name)) continue;
		out.set(prefix + e.name, {
			size: e.size,
			mtime: e.mtime,
			exec: (e.mode & 0o111) !== 0,
		});
	}
	return out;
}

/** A name the flat tiers (and the share/local announce protocol) carry:
 * one path segment, sane length. */
export function mirrorable(name: string): boolean {
	if (!name || name.endsWith('/')) return false;
	if (name === '.' || name === '..' || name.includes('/')) return false;
	return name.length <= 128;
}

/**
 * A relative path the recursive private mirror is willing to carry (§12.1's
 * round-trippable names): bounded length and depth, every segment a sane
 * flat name, no dot segments anywhere — which is also what keeps `.vinx/`
 * out at any level. Control characters and the mirror's own `|` separator
 * die here too (the shape host-mount's mountablePath vets for disk paths).
 */
export function mirrorablePath(path: string): boolean {
	if (!path || path.length > 512) return false;
	if (/[|\\\n\r\0]/.test(path)) return false;
	const segs = path.split('/');
	if (segs.length > MAX_MIRROR_DEPTH) return false;
	return segs.every((s) => mirrorable(s) && !s.startsWith('.'));
}

/** What the private walk skips at the root: `share/` (its `local/` tier has
 * its own flat pass and protocol) and `host/` (synced with a person's real
 * disk by host-mount; mirroring it too would double-write and eat the
 * quota). Dot-names are already out by the path rule. */
export const PRIVATE_SKIP_ROOTS: ReadonlySet<string> = new Set(['share', 'host']);

/** How walkListing reaches the tree: vm.ts's listData, one level at a time. */
export interface DataLister {
	listData(rel: string): Promise<readonly DataEntry[]>;
}

/**
 * The private tier's recursive listing: every regular file under /data whose
 * path passes mirrorablePath, keyed by its relative path. Depth past
 * MAX_MIRROR_DEPTH is cut (the subtree is simply not carried); a tree past
 * MAX_MIRROR_FILES comes back marked `overflow` so the caller can pause the
 * snapshot the way the byte quota does — a half-carried tree restored on the
 * next boot would look like data loss.
 */
export async function walkListing(
	vm: DataLister,
): Promise<{ listing: Map<string, FileStat>; overflow: boolean }> {
	const listing = new Map<string, FileStat>();
	let overflow = false;
	const walk = async (rel: string, prefix: string, depth: number): Promise<void> => {
		if (depth >= MAX_MIRROR_DEPTH || overflow) return;
		for (const e of await vm.listData(rel)) {
			if (overflow) return;
			if (e.name.startsWith('.') || !mirrorable(e.name)) continue;
			if (depth === 0 && PRIVATE_SKIP_ROOTS.has(e.name)) continue;
			const path = prefix + e.name;
			if (e.dir) {
				await walk(rel === '' ? e.name : `${rel}/${e.name}`, `${path}/`, depth + 1);
			} else if (isRegularMode(e.mode) && mirrorablePath(path)) {
				if (listing.size >= MAX_MIRROR_FILES) {
					overflow = true;
					return;
				}
				listing.set(path, {
					size: e.size,
					mtime: e.mtime,
					exec: (e.mode & 0o111) !== 0,
				});
			}
		}
	};
	await walk('', '', 0);
	return { listing, overflow };
}

/**
 * What one snapshot round has to do, given the previous round's fingerprints
 * (`prev`), the guest's current listing (`next`), and which names the mirror
 * currently holds (`mirrored`).
 *
 * - `read`: files to pull from the guest and (re)write — new, changed, or
 *   present in the guest but missing from the mirror (a failed earlier write).
 * - `remove`: mirror keys whose file no longer exists in the guest.
 */
export function diffSnapshot(
	prev: ReadonlyMap<string, FileStat>,
	next: ReadonlyMap<string, FileStat>,
	mirrored: ReadonlySet<string>,
): { read: string[]; remove: string[] } {
	const read: string[] = [];
	for (const [name, stat] of next) {
		const before = prev.get(name);
		// An exec flip re-reads unchanged bytes — rare, and cheaper than a
		// separate "metadata only" pipeline.
		const changed =
			!before || before.size !== stat.size || before.mtime !== stat.mtime || before.exec !== stat.exec;
		if (changed || !mirrored.has(name)) read.push(name);
	}
	const remove: string[] = [];
	for (const name of mirrored) {
		if (!next.has(name)) remove.push(name);
	}
	return { read, remove };
}

/** Total bytes a listing claims; the quota check runs on this before any read. */
export function totalBytes(listing: ReadonlyMap<string, FileStat>): number {
	let sum = 0;
	for (const { size } of listing.values()) sum += size;
	return sum;
}
