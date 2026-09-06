/**
 * The page's half of the workspace `install_app`: a pure web app the model
 * wrote — a body fragment, a stylesheet, a script — onto this machine's
 * /data/apps, machine on or off.
 *
 * A pure web app (kind window, ui web, no exec) runs in a sandboxed frame
 * fed the three parts as a bundle (§10.3); Linux takes no part in it, which
 * is why vm-apps.ts opens one from the mirror while the machine is off. This
 * is the same fact in the other direction: the package `app pack` would have
 * made (vapp.ts's packVapp), the validation `app install` would have run
 * (app-check.ts), the sidecars it would have written, landed where it would
 * have landed — the machine's mirror of /data/apps (share-store), which is
 * /data/apps as far as a powered-off machine is concerned, and the live
 * tree too when there is one. Then the Apps page re-reads (the event), and
 * the person opens the app from there, or from the tool's card.
 *
 * Only the mirror's owner writes it (vm.isOwner, as every private writer):
 * an ephemeral tab's install still lands in its guest when the machine is
 * up, and lives as long as the tab does — the same as its file drops.
 */

import type { WebAppSource } from '../runtime/src/protocol';
import { checkWebApp, formatFindings } from './app-check';
import { isTerminalDocument } from './pane-id';
import { parseEnabled, withEnabled } from './enabled-list';
import { mirroredDir, storeShareFile } from './share-store';
import { isPureWebApp, manifestOf, packVapp, unpackVapp, type VappFiles, type VappManifest } from './vapp';
import { MachineOffError, type VinxVm } from './vm';
import { windowManager } from './window-manager';

/** Fired on window after an install lands: the Apps page re-reads its list
 * (vendor/ui's apps-page listens by name; that tree imports nothing of the
 * app's). `detail` is the app id. */
export const APPS_CHANGED_EVENT = 'vinx:apps-changed';

const encoder = new TextEncoder();

/** The kind an installed package answers to, for the refusal's words. */
function kindOf(files: VappFiles | null): string {
	const m = files ? manifestOf(files) : null;
	if (!m) return 'unreadable';
	if (m.kind === 'window') return m.exec ? 'window (with a backend)' : 'window';
	return m.kind || 'command';
}

/**
 * What `app install` leaves beside a package in /data/apps: the sidecars a
 * listing reads without unpacking — kind, title, description (the last two
 * empty files when the manifest has none; `jq -r` writes "\n") — and, for a
 * pure web app, the `.web` marker that tells rund's boot sweep the
 * autostart is the desktop's (§10.7). Byte for byte the guest's, so `app
 * list` and the Apps page read one truth whichever side installed.
 */
export function installSidecars(id: string, manifest: VappManifest): [string, Uint8Array][] {
	const sidecars: [string, Uint8Array][] = [
		[`apps/${id}.kind`, encoder.encode(`${manifest.kind}\n`)],
		[`apps/${id}.title`, encoder.encode(`${manifest.title ?? ''}\n`)],
		[`apps/${id}.description`, encoder.encode(`${manifest.description ?? ''}\n`)],
	];
	if (isPureWebApp(manifest)) sidecars.push([`apps/${id}.web`, encoder.encode('web\n')]);
	return sidecars;
}

/**
 * Land files under /data: in the mirror when this tab owns the machine, and
 * in the live tree when the machine is up (or booting: whenUp waits). Off
 * stays off — the mirror is the machine's /data until the person boots it,
 * and the boot replays the mirror into the guest. Says where they went; a
 * caller that finds neither has nowhere to put them.
 */
export async function landInApps(vm: VinxVm, landing: [string, Uint8Array][]): Promise<{ owner: boolean; live: boolean }> {
	const owner = await vm.isOwner();
	if (owner) for (const [path, data] of landing) await storeShareFile(path, data);
	let live = true;
	try {
		await vm.ensureDir('apps');
		for (const [path, data] of landing) await vm.putFile(path, data);
	} catch (e) {
		if (!(e instanceof MachineOffError)) throw e;
		live = false;
	}
	return { owner, live };
}

/**
 * Install `app` on this machine. Resolves with the line for the model;
 * rejects with the refusal (the engine prefixes "Error: " and marks the
 * call failed). Both are English like the rest of the shell — the model
 * reads them, not the person.
 */
export async function installWebApp(vm: VinxVm, app: WebAppSource): Promise<string> {
	const findings = checkWebApp(app);
	const errors = findings.filter((f) => f.sev === 'E');
	if (errors.length) throw new Error(`${formatFindings(errors)}\nnothing installed`);
	const warnings = findings.filter((f) => f.sev === 'W');
	const { id } = app;
	const title = app.title?.trim() || undefined;
	const description = app.description?.trim() || undefined;

	// The same id twice is an update — of a web app. An installed command,
	// service or backed window under that name is somebody's program, and
	// `app install` overwriting it is a guest decision this page does not
	// take on its own.
	const installed = await mirroredDir('apps');
	const prior = installed.get(`${id}.vapp`);
	let verb = 'Installed';
	if (prior) {
		const unpacked = await unpackVapp(prior);
		if (!unpacked || !isPureWebApp(manifestOf(unpacked))) {
			throw new Error(
				`${id} is already installed and is a ${kindOf(unpacked)} app, not a web app -- ` +
					`pick another id, or have the person remove it first (the Apps page, or app remove ${id})`,
			);
		}
		verb = 'Updated';
	}

	// The package: what `app pack` makes of the scaffold's directory —
	// app.json beside the three parts (§9.2, §12.4).
	const manifest: Record<string, unknown> = { schema: 1, kind: 'window', ui: { type: 'web' } };
	if (title) manifest.title = title;
	if (description) manifest.description = description;
	const files: VappFiles = new Map([
		['app.json', encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)],
		['index.html', app.html],
	]);
	if (app.css) files.set('style.css', app.css);
	if (app.js) files.set('app.js', app.js);
	const bytes = await packVapp(files);

	// What `app install` leaves in /data/apps: the package and its sidecars
	// (installSidecars). Then the autostart list, when it has to change —
	// the guest's exact edit (enabled-list.ts), so the person finds it on
	// the Apps page the way the CLI would have left it: asked for, `app
	// enable`'s append. Not asked for, on a fresh install, an id already on
	// the list is a leftover — a remove whose disable never reached the
	// mirror — and installing is not enabling: the new package must not
	// autostart unasked, so the line goes, as the guest's `app install`
	// drops it. An update keeps the list as the person set it.
	const landing: [string, Uint8Array][] = [
		[`apps/${id}.vapp`, bytes],
		...installSidecars(id, { kind: 'window', ui: { type: 'web' }, title, description }),
	];
	const enabledList = installed.get('enabled');
	if (app.autostart === true) landing.push(['apps/enabled', withEnabled(enabledList, id, true)]);
	else if (!prior && parseEnabled(enabledList).includes(id)) landing.push(['apps/enabled', withEnabled(enabledList, id, false)]);
	const { owner, live } = await landInApps(vm, landing);
	if (!owner && !live) {
		throw new Error(
			'another tab owns this machine (it booted first) and this one is powered off, so there is ' +
				'nowhere to put the app: install from that tab, or have the person boot this one',
		);
	}
	window.dispatchEvent(new CustomEvent(APPS_CHANGED_EVENT, { detail: id }));

	const parts = [...files.keys()].filter((n) => n !== 'app.json').join(', ');
	const named = title ? `${id} ("${title}")` : id;
	const lines = [
		`${verb} ${named}: ${parts} -> /data/apps/${id}.vapp (${bytes.byteLength} bytes).`,
		isTerminalDocument()
			? `The card of this call has an Open button; on the machine, app list shows it and app run ${id} opens its window.`
			: 'It is on the Apps page now, where the person opens it in a window, machine on or off; the card of this call has an Open button too.',
	];
	if (app.autostart === true) lines.push('It is on the autostart list: this page opens its window whenever the page loads.');
	if (!live) lines.push('The machine is powered off: its /data/apps takes the package at the next boot (nothing to do).');
	else if (!owner) lines.push('This tab is not the machine’s owner: the app is in this machine’s memory only, for as long as the tab lives.');
	if (verb === 'Updated' && windowManager().list().some((w) => w.id === id && w.surface === 'web' && w.open)) {
		lines.push('Its window is open and shows the previous version until it is closed and opened again.');
	}
	if (warnings.length) lines.push(formatFindings(warnings));
	return lines.join('\n');
}
