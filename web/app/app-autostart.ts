/**
 * The desktop's half of autostart (§10.7). /data/apps/enabled is one list
 * with two clocks: rund starts an enabled service after the machine boots;
 * an enabled pure web app — a window and no process — is opened by the
 * page when the page loads, machine on or off, from the package in the
 * machine's mirror (vm-apps.ts's openFromMirror, the same window `app run`
 * would make; same id, so a boot-time `app run` or a click only raises it).
 *
 * Once per document: a page load is the desktop's boot, and this runs at
 * it — not on route changes, not when the machine comes up later (its
 * /data is the mirror replayed; the list is the same one read here).
 * The ephemeral tab (another owns the machine) reads the same mirror and
 * opens the same windows: every tab is a desktop, and the list is what the
 * person chose for the desktop.
 */

import { parseEnabled } from './enabled-list';
import { mirroredDir } from './share-store';
import { isPureWebInMirror, openFromMirror } from './vm-apps';

const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

let started: Promise<string[]> | null = null;

/** Open every enabled pure web app's window. Resolves to the ids opened;
 * a second call returns the first's result. Never throws — a broken
 * package is skipped, a missing mirror is an empty list. */
export function autostartWebApps(): Promise<string[]> {
	started ??= (async () => {
		const opened: string[] = [];
		try {
			const files = await mirroredDir('apps');
			for (const id of parseEnabled(files.get('enabled'))) {
				if (!APP_ID.test(id) || !files.has(`${id}.vapp`)) continue;
				// Services and backed windows are rund's at boot; only a pure
				// web app (the marker, or the package itself) is ours here.
				if (!(await isPureWebInMirror(id, files))) continue;
				if (await openFromMirror(id, files)) opened.push(id);
			}
		} catch (e) {
			console.warn('[vinx] autostart of web apps skipped:', e);
		}
		return opened;
	})();
	return started;
}
