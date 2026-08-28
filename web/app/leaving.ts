/**
 * Ask before a reload or a close throws away a running turn.
 *
 * Upstream's agent is a process on a machine somewhere: the browser is a
 * viewer, and closing it leaves the turn running to be read back later. Here
 * the engine is the tab — wasm in a worker the document owns — so a reload, a
 * navigation or a closed tab ends the turn where it stands, and the
 * conversation comes back holding only what was committed before the last
 * write. That is a property of putting the agent in a page, not a bug to fix,
 * but it should not be discovered by losing five minutes of work.
 *
 * So: a native confirmation, and only while something is actually running.
 * `beforeunload` cannot await anything, which is why the count is kept here
 * rather than asked for at the last moment.
 *
 * What it does not cover, because nothing in a page can: a tab discarded by
 * Chrome's Memory Saver is closed without ever running this, and a background
 * tab has its timers throttled to about one a minute, so the count can be that
 * stale. Both fail towards a prompt that should not have appeared rather than a
 * turn quietly lost.
 */

import type { AgentClient } from '../runtime/src/index';

/** How often to re-ask the engine while a turn is believed to be running. */
const POLL_MS = 1500;

export interface LeaveGuard {
	/** A turn just started; watch until the engine says none are left. */
	started(): void;
	/** Remove the handler and stop polling. */
	stop(): void;
}

export function guardRunningTurns(client: AgentClient): LeaveGuard {
	let running = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	const stopPolling = () => {
		if (timer === null) return;
		clearInterval(timer);
		timer = null;
	};

	const ask = async () => {
		try {
			running = await client.turns();
		} catch {
			// A worker that is gone cannot be running a turn, and a guard that
			// prompts because it failed to ask is a guard people learn to
			// dismiss without reading.
			running = 0;
		}
		if (running === 0) stopPolling();
	};

	const watch = () => {
		if (timer !== null) return;
		timer = setInterval(() => void ask(), POLL_MS);
	};

	const onLeave = (e: BeforeUnloadEvent) => {
		if (running === 0) return;
		// Both spellings: the modern one and the assignment older browsers
		// still want. The text is the browser's own — no page has been able to
		// choose it for years.
		e.preventDefault();
		e.returnValue = '';
	};

	const onVisible = () => {
		// Coming back to a tab whose timers were throttled: re-ask before the
		// user has a chance to close it on a count from a minute ago.
		if (document.visibilityState === 'visible' && timer !== null) void ask();
	};

	window.addEventListener('beforeunload', onLeave);
	document.addEventListener('visibilitychange', onVisible);

	return {
		started() {
			// Believed immediately rather than after the first poll: a turn
			// started and abandoned within the same second is exactly the one
			// worth asking about.
			running = Math.max(running, 1);
			watch();
		},
		stop() {
			stopPolling();
			window.removeEventListener('beforeunload', onLeave);
			document.removeEventListener('visibilitychange', onVisible);
		},
	};
}
