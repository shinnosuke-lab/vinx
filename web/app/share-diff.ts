/**
 * The pure half of /data snapshotting, kept free of DOM and IndexedDB so the
 * runtime test suite can cover it directly.
 *
 * A snapshot no longer rewrites the whole mirror: the guest lists /data with
 * a size|mtime fingerprint per file, and only files whose fingerprint moved
 * are read and re-written. That keeps the 15-second cycle near-free while the
 * directory is quiet, however big it is.
 */

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

/** The one nested directory the mirror carries: /data/share/local, the files
 * every VM on this origin sees. Doubles as the IndexedDB key prefix for them.
 * (`share/` is the sharing namespace; a future relay-backed tier would be
 * `share/net/` beside it.) */
export const LOCAL_PREFIX = 'share/local/';

/**
 * One line of the guest listing, `size|mtime|exec|name` — the name last
 * because it is the only field that may itself contain `|`; exec is `1` for
 * a file the guest can execute, `0` otherwise.
 * Returns null for anything that does not parse or that the mirror refuses
 * (directories are excluded by the guest command, names with separators or
 * newlines cannot round-trip through a line protocol). The single sanctioned
 * prefix is `share/local/`: the guest listing tags /data/share/local entries
 * with it, and the name keeps it — it is the namespace the whole pipeline
 * keys on.
 */
export function parseStatLine(line: string): { name: string; stat: FileStat } | null {
	const first = line.indexOf('|');
	const second = first === -1 ? -1 : line.indexOf('|', first + 1);
	const third = second === -1 ? -1 : line.indexOf('|', second + 1);
	if (third === -1) return null;
	const size = Number(line.slice(0, first));
	const mtime = Number(line.slice(first + 1, second));
	const exec = line.slice(second + 1, third);
	const name = line.slice(third + 1);
	if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtime)) return null;
	if (exec !== '0' && exec !== '1') return null;
	const bare = name.startsWith(LOCAL_PREFIX) ? name.slice(LOCAL_PREFIX.length) : name;
	if (!mirrorable(bare)) return null;
	return { name, stat: { size, mtime, exec: exec === '1' } };
}

/** A name the mirror is willing to carry: flat files with sane names. */
export function mirrorable(name: string): boolean {
	if (!name || name.endsWith('/')) return false;
	if (name === '.' || name === '..' || name.includes('/')) return false;
	return name.length <= 128;
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
