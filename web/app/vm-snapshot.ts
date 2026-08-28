/**
 * The boot snapshot cache: one gzipped v86 state image per machine, in its
 * own IndexedDB database (share-store owns `vinx.vm`; a second store there
 * would mean a version bump and a migration for no gain).
 *
 * A record is only as good as the world it was saved in, so it carries a
 * `stamp` — app version, network mode, memory size — and a load under any
 * other stamp returns nothing. One record per machine id, not one per page:
 * two panes restoring the same image would wake up with the same MAC and
 * the same 10.0.2.x address on one LAN hub, which is why each machine saves
 * its own boot instead of sharing one.
 */

const DB_NAME = 'vinx.vm-state';
const STORE = 'snapshots';

interface SnapshotRecord {
	stamp: string;
	blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
	});
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
	});
}

/** The stored state for `key`, decompressed — or null when there is none,
 * the stamp disagrees, or anything at all goes wrong. Restoring is an
 * optimization; every failure just means a cold boot. */
export async function loadSnapshot(key: string, stamp: string): Promise<ArrayBuffer | null> {
	if (typeof indexedDB === 'undefined') return null;
	try {
		const db = await openDb();
		const record = await request<SnapshotRecord | undefined>(
			db.transaction(STORE).objectStore(STORE).get(key),
		).finally(() => db.close());
		if (!record || record.stamp !== stamp) return null;
		return await new Response(
			record.blob.stream().pipeThrough(new DecompressionStream('gzip')),
		).arrayBuffer();
	} catch {
		return null;
	}
}

export async function saveSnapshot(key: string, stamp: string, state: ArrayBuffer): Promise<void> {
	const blob = await new Response(
		new Blob([state]).stream().pipeThrough(new CompressionStream('gzip')),
	).blob();
	const db = await openDb();
	const tx = db.transaction(STORE, 'readwrite');
	tx.objectStore(STORE).put({ stamp, blob } satisfies SnapshotRecord, key);
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
	}).finally(() => db.close());
}

/** Forget a snapshot that failed to restore (or aged out): the next boot
 * should not trip over it again. */
export async function dropSnapshot(key: string): Promise<void> {
	try {
		const db = await openDb();
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).delete(key);
		await new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		}).finally(() => db.close());
	} catch {
		/* nothing to forget */
	}
}
