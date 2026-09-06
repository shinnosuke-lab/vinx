/**
 * The origin broker (§3.0, §20): arbitration between this origin's desktop
 * documents over the physical browser resources they share — the camera,
 * the Bluetooth session. Every machine (chat page, each terminal pane) is
 * its own document; without this, three of them would each pretend to own
 * the one webcam.
 *
 * The mechanism is Web Locks, one lock per resource, never waited on:
 * `ifAvailable` turns contention into an immediate, honest RESOURCE_BUSY
 * naming the holder (announced through localStorage — the Locks API knows
 * who holds a lock but not which machine that is). Foreground rules ride
 * on top: the camera and the BLE picker want a visible document
 * (gesture/permission UX), and a hidden machine's request is refused as
 * REQUIRES_FOREGROUND rather than forwarded — §3.0 allows exactly that
 * where safe forwarding does not exist yet.
 *
 * Two grips:
 *
 *   - withOriginLock(resource, work): hold for the duration of one call
 *     (a camera capture);
 *   - acquireOriginHold(resource): hold until released (a BLE connection
 *     or scan), reference-counted per document — Web Locks are not
 *     reentrant, and a connect-then-scan from one machine must not
 *     deadlock against itself.
 *
 * No Web Locks (an insecure context) means no arbitration — the single
 * plain-HTTP dev machine is its own arbiter.
 */

import { machineId } from './pane-id';

export class OriginBusyError extends Error {
	constructor(resource: string, holder: string | null) {
		super(`the ${resource} is in use by ${holder || 'another machine on this origin'}`);
		this.name = 'OriginBusyError';
	}
}

export class OriginForegroundError extends Error {
	constructor(resource: string) {
		super(`the ${resource} wants a foreground page and this machine's is hidden — switch to its tab and retry`);
		this.name = 'OriginForegroundError';
	}
}

const lockName = (resource: string) => `vinx.origin.${resource}`;
const holderKey = (resource: string) => `vinx.origin.holder.${resource}`;

/** How the holder reads in a stranger's error message. */
function selfLabel(): string {
	const id = machineId();
	return id === 'c' ? "the chat page's machine" : `terminal machine ${id}`;
}

function announceHolder(resource: string): void {
	try {
		localStorage.setItem(holderKey(resource), selfLabel());
	} catch {
		/* private mode: the busy error just loses the name */
	}
}

function clearHolder(resource: string): void {
	try {
		localStorage.removeItem(holderKey(resource));
	} catch {
		/* ditto */
	}
}

/** Who announced the resource last; null when nobody (or no storage). */
export function currentHolder(resource: string): string | null {
	try {
		return localStorage.getItem(holderKey(resource));
	} catch {
		return null;
	}
}

function requireForeground(resource: string): void {
	if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
		throw new OriginForegroundError(resource);
	}
}

/** Run one call while exclusively holding the resource; contention is an
 * immediate OriginBusyError, a hidden document an OriginForegroundError. */
export async function withOriginLock<T>(resource: string, work: () => Promise<T>): Promise<T> {
	requireForeground(resource);
	if (typeof navigator === 'undefined' || !navigator.locks) return work();
	return navigator.locks.request(lockName(resource), { ifAvailable: true }, async (lock) => {
		if (!lock) throw new OriginBusyError(resource, currentHolder(resource));
		announceHolder(resource);
		try {
			return await work();
		} finally {
			clearHolder(resource);
		}
	});
}

/** This document's long holds, reference-counted over one real lock. */
const holds = new Map<string, { refs: number; release: () => void }>();

/**
 * Take (or share) this document's long hold on a resource; the returned
 * release drops one reference, and the last one releases the real lock.
 * Throws OriginBusyError when another document holds it.
 */
export async function acquireOriginHold(resource: string): Promise<() => void> {
	requireForeground(resource);
	const shared = holds.get(resource);
	if (shared) {
		shared.refs++;
		return makeRelease(resource);
	}
	if (typeof navigator === 'undefined' || !navigator.locks) {
		holds.set(resource, { refs: 1, release: () => {} });
		return makeRelease(resource);
	}
	await new Promise<void>((resolve, reject) => {
		void navigator.locks.request(lockName(resource), { ifAvailable: true }, (lock) => {
			if (!lock) {
				reject(new OriginBusyError(resource, currentHolder(resource)));
				return;
			}
			announceHolder(resource);
			// The lock lives exactly as long as this promise: the release
			// stored below settles it.
			return new Promise<void>((releaseLock) => {
				holds.set(resource, {
					refs: 1,
					release: () => {
						clearHolder(resource);
						releaseLock();
					},
				});
				resolve();
			});
		});
	});
	return makeRelease(resource);
}

function makeRelease(resource: string): () => void {
	let done = false;
	return () => {
		if (done) return; // a double release must not steal a sibling's ref
		done = true;
		const hold = holds.get(resource);
		if (!hold) return;
		hold.refs--;
		if (hold.refs <= 0) {
			holds.delete(resource);
			hold.release();
		}
	};
}