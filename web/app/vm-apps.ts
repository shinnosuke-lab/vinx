/**
 * The Apps page's bridge to this machine's app system (shim.ts's
 * VmAppsBridge): rund's app.list behind the list, the guest `app` CLI
 * behind start/stop/enable/disable/remove/install — and, for what needs
 * no machine, the page itself.
 *
 * The machine may be off, as the person left it (machine-power.ts), and
 * the page must still be honest about what is installed and able to open
 * what does not need Linux to run — a pure web app never depends on the
 * machine's power, and nothing here may suggest it does:
 *
 *  - The list. Installed packages live in /data/apps, which the page
 *    mirrors (share-store); anything but a ready machine's mirror is read
 *    here and every package listed as `off` — the same set `app list`
 *    would give, minus the running states rund alone knows.
 *  - Opening a pure web app. Its window is a sandboxed frame fed a bundle
 *    (§10.3); app-run(8) only ever read three files to make that bundle,
 *    and app/vapp.ts reads the same three from the mirrored package. The
 *    window is the same window either way — same id (the app's), same
 *    bundle shape — so the desktop dedupes the two routes by id.
 *  - Autostart (the `enabled` list, user policy). One list, two clocks:
 *    rund starts an enabled service after a boot; an enabled pure web app
 *    is opened by the desktop when the page loads (app-autostart.ts) —
 *    rund skips it, told by the `.web` marker install leaves beside the
 *    package. Flipping the list is a policy edit, not a run: with the
 *    machine off the page makes the guest's exact edit in the mirror
 *    (enabled-list.ts), and the replay at the next boot carries it in.
 *
 * Everything that DOES need the machine goes through it, and through
 * whenUp (vm.ts): a machine left off is a MachineOffError, which the shim
 * turns into MACHINE_OFF and the Apps page words as "power it on from the
 * key at the bottom right" — the capsule floats over every route, so the
 * page itself never shows a power button or a power notice of its own.
 */

import type { VmAppEntry, VmAppsBridge } from '../runtime/src/shim';
import { APPS_CHANGED_EVENT } from './app-install';
import { withEnabled } from './enabled-list';
import {
	DATA_RESTORED_EVENT,
	dataWhole,
	mirroredDir,
	removeShareFiles,
	requestSnapshot,
	storeShareFile,
} from './share-store';
import { isPureWebApp, manifestOf, unpackVapp, webBundleOf } from './vapp';
import { MachineOffError, type VinxVm } from './vm';
import { windowManager } from './window-manager';

const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The files `app install` leaves in /data/apps for one id — the package
 * and its sidecars; the guest's `app remove` deletes exactly these. */
const INSTALL_FILES = ['vapp', 'kind', 'title', 'description', 'web'];

const decoder = new TextDecoder();

/** A sidecar `app install` wrote beside the package (`<id>.kind`, `.title`,
 * `.description`): its first line, trimmed; undefined when absent or empty. */
function sidecar(files: Map<string, Uint8Array>, id: string, which: string): string | undefined {
	const raw = files.get(`${id}.${which}`);
	if (!raw) return undefined;
	const text = decoder.decode(raw).split(/\r?\n/)[0].trim();
	return text || undefined;
}

/** The words a listing shows, from the sidecars in the mirror — the same
 * copy of /data/apps whether the machine is on or off — and the `.web`
 * marker (a pure web app: a window, no process; §10.7). */
function words(files: Map<string, Uint8Array>, id: string): Pick<VmAppEntry, 'title' | 'description' | 'web'> {
	return {
		title: sidecar(files, id, 'title'),
		description: sidecar(files, id, 'description'),
		web: files.has(`${id}.web`) || undefined,
	};
}

function openWindows(): Set<string> {
	return new Set(windowManager().list().filter((w) => w.surface === 'web').map((w) => w.id));
}

/** What the mirror says is installed: `<id>.vapp` (the package), `<id>.kind`
 * (the manifest kind, written by `app install`), and the `enabled` list. */
async function listFromMirror(): Promise<VmAppEntry[]> {
	const files = await mirroredDir('apps');
	const enabled = new Set(
		decoder
			.decode(files.get('enabled') ?? new Uint8Array())
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const open = openWindows();
	const out: VmAppEntry[] = [];
	for (const [name, bytes] of files) {
		if (!name.endsWith('.vapp')) continue;
		const id = name.slice(0, -'.vapp'.length);
		if (!APP_ID.test(id)) continue;
		out.push({
			id,
			state: 'off',
			enabled: enabled.has(id),
			size: bytes.byteLength,
			kind: sidecar(files, id, 'kind'),
			windowOpen: open.has(id),
			...words(files, id),
		});
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Is ID, as installed, a pure web app? The install's `.web` marker says
 * so at once; a package from before the marker is opened and asked. */
export async function isPureWebInMirror(id: string, files?: Map<string, Uint8Array>): Promise<boolean> {
	files ??= await mirroredDir('apps');
	if (files.has(`${id}.web`)) return true;
	if (sidecar(files, id, 'kind') !== 'window') return false;
	const bytes = files.get(`${id}.vapp`);
	if (!bytes) return false;
	const unpacked = await unpackVapp(bytes);
	return !!unpacked && isPureWebApp(manifestOf(unpacked));
}

/** Open a pure web app from its mirrored package, no machine involved.
 * False when the package is not one this page can open by itself. */
export async function openFromMirror(id: string, files?: Map<string, Uint8Array>): Promise<boolean> {
	files ??= await mirroredDir('apps');
	const bytes = files.get(`${id}.vapp`);
	if (!bytes) return false;
	const unpacked = await unpackVapp(bytes);
	if (!unpacked) return false;
	const bundle = webBundleOf(unpacked);
	if (!bundle) return false;
	const title = manifestOf(unpacked)?.title?.trim().slice(0, 48) || id;
	// The same window app-run's window.create would make: the app's id
	// is the window's, so a second open — from either side — raises it.
	windowManager().create({ id, title, appId: id, bundle });
	return true;
}

/**
 * The other way a card changes: its backend exits on its own — the ROM
 * picker's q, a game over, a service that crashed. rund says so (the §10.7
 * app.exited event; vm.ts already reads it for the window's title), and
 * the Apps page re-reads its list on the same event an install fires, so
 * the card is a play button again without anyone pressing refresh. Once
 * per document (main.tsx), beside the bridge; returns the unsubscribe.
 */
export function relayAppExits(vm: VinxVm): () => void {
	return vm.onGuestEvent((topic, data) => {
		if (topic !== 'app.exited') return;
		const id = (data as { id?: unknown } | null)?.id;
		window.dispatchEvent(
			new CustomEvent(APPS_CHANGED_EVENT, { detail: { id: typeof id === 'string' ? id : undefined, exited: true } }),
		);
	});
}

export function vmAppsBridge(vm: VinxVm): VmAppsBridge {
	const up = () => vm.getState() === 'ready' || vm.getState() === 'booting';

	/**
	 * A guest-side edit of /data/apps waits for the guest's /data to be
	 * whole. A booting machine reaches `ready` before the mirror's replay
	 * lands, and `app remove` or `app enable` run in that gap is undone a
	 * second later when the replay puts the mirror's copy back. A boot
	 * that fails meanwhile ends the wait too — the CLI call then says so.
	 */
	const whenDataWhole = async () => {
		while (!dataWhole() && up()) {
			await new Promise<void>((resolve) => {
				const done = () => {
					window.removeEventListener(DATA_RESTORED_EVENT, done);
					off();
					resolve();
				};
				window.addEventListener(DATA_RESTORED_EVENT, done);
				// Fires at once with the current state — up(), checked a
				// moment ago — so `off` is assigned before it can be called.
				const off = vm.onState((s) => {
					if (s !== 'ready' && s !== 'booting') done();
				});
			});
		}
	};

	/**
	 * The guest's `app` CLI, on a machine that is up with its /data whole.
	 * whenUp's verdict comes first, as it does for every implicit need
	 * (vm.ts): a machine remembered on boots for it, one left off refuses
	 * with MachineOffError. After the guest's edit the mirror follows at
	 * once, not at the 15 s tick: an unlink rings no doorbell, and a
	 * package removed a moment ago must not be listed — or autostarted —
	 * from a stale mirror meanwhile.
	 */
	const guestCli = async (args: string, timeoutS: number) => {
		// A no-op command is the cheapest way to ask whenUp (private to
		// vm.ts) for its verdict before waiting on the replay.
		if (!up()) await vm.runShell('true', 10);
		await whenDataWhole();
		const ran = await vm.runShell(`app ${args}`, timeoutS);
		if (ran.exit_code !== 0) throw new Error(ran.output.trim() || `app ${args} exited ${ran.exit_code}`);
		requestSnapshot();
		return ran.output;
	};

	/** The mirror as the machine's /data while it is off: the edits
	 * below are the guest CLI's own, byte for byte, made where the next
	 * boot's replay will find them. Only this machine's owner edits
	 * (an ephemeral machine — another tab holds the id — reads the mirror
	 * but never writes it; share-store). */
	const mirrorEdit = async (id: string, what: string) => {
		const files = await mirroredDir('apps');
		if (!files.has(`${id}.vapp`)) throw new Error(`no such installed app: ${id}`);
		if (!(await vm.isOwner())) throw new Error(`another tab owns this machine — ${what} there`);
		return files;
	};

	return {
		list: async () => {
			// Looking must never boot the machine, nor wait for one: a look is
			// not a need (whenUp), and the page has no business making the
			// person watch a boot to see what is installed. Anything but a
			// ready machine, the mirror answers — the real installed set, as
			// `off` — and the page asks again when the machine comes up.
			if (vm.getState() !== 'ready') return listFromMirror();
			const r = (await vm.rpcCall('app.list', {}, { deadlineMs: 15_000 })) as {
				apps?: VmAppEntry[];
			};
			// rund knows states; the words (title, description) are the
			// install's sidecars, read from the mirror — the page's copy of
			// /data/apps, a snapshot behind by at most the 9p doorbell.
			const [files, open] = [await mirroredDir('apps'), openWindows()];
			return (r.apps ?? []).map((a) => {
				const w = words(files, a.id);
				// rund reports the marker too; either copy suffices.
				return { ...a, windowOpen: open.has(a.id), ...w, web: a.web === true || w.web };
			});
		},
		cli: async (args) => {
			// `stop ID` on a pure web app is its window closing, and the
			// desktop owns windows: done here, machine on or off — the same
			// thing the guest CLI's `app stop` does through window.close.
			// `remove ID` closes the window too before the guest removes the
			// package (the CLI's remove stops first as well; the desktop's
			// word is the one that counts for a window).
			const verb = /^(stop|remove) ([a-z0-9][a-z0-9-]{0,31})$/.exec(args);
			if (verb && (await isPureWebInMirror(verb[2]))) {
				windowManager().close(verb[2]);
				if (verb[1] === 'stop') return `app: ${verb[2]} window closed`;
			}
			// `remove ID` with the machine off is the guest's remove made in
			// the mirror — nothing runs, so there is nothing to stop; what is
			// left is `app disable` and the `rm` of the package and its
			// sidecars, and the next boot's replay never puts them back. A
			// pure web app installed with the machine off (install_app) is
			// uninstalled the same way; and any other app's package is just
			// as much the mirror's while the machine is off.
			if (verb?.[1] === 'remove' && !up()) {
				const id = verb[2];
				const files = await mirrorEdit(id, 'uninstall');
				if (files.has('enabled')) await storeShareFile('apps/enabled', withEnabled(files.get('enabled'), id, false));
				await removeShareFiles(INSTALL_FILES.map((s) => `apps/${id}.${s}`));
				window.dispatchEvent(new CustomEvent(APPS_CHANGED_EVENT, { detail: { id } }));
				return `app: removed ${id}`;
			}
			return guestCli(args, 120);
		},
		putFile: (path, bytes) => vm.putFile(path, bytes),
		setEnabled: async (id, on) => {
			// A running machine's list is the guest's file: the CLI edits
			// it, and the mirror follows (share-store's sweep). Otherwise the
			// mirror IS /data as the person knows it, and the list is policy,
			// not a run — the page makes the guest's exact edit there for any
			// installed app, and the replay at the next boot carries it in;
			// rund then starts the services, this page opens the web apps.
			if (up()) {
				await guestCli(`${on ? 'enable' : 'disable'} ${id}`, 60);
				return;
			}
			const files = await mirrorEdit(id, 'change autostart');
			// The marker, if a package from before it is a pure web app:
			// the guest's `app enable` backfills the same way.
			if (on && !files.has(`${id}.web`) && (await isPureWebInMirror(id, files))) {
				await storeShareFile(`apps/${id}.web`, new TextEncoder().encode('web\n'));
			}
			// `app disable` leaves an absent list absent.
			if (on || files.has('enabled')) {
				await storeShareFile('apps/enabled', withEnabled(files.get('enabled'), id, on));
			}
			window.dispatchEvent(new CustomEvent(APPS_CHANGED_EVENT, { detail: { id } }));
		},
		run: async (id) => {
			// A pure web app opens here whether or not the machine is up:
			// the page has the package, the window needs nothing else.
			// Anything else has a backend, and a machine left off says so.
			if (await openFromMirror(id)) return;
			if (!up()) {
				const files = await mirroredDir('apps');
				if (!files.has(`${id}.vapp`)) throw new Error(`no such installed app: ${id}`);
				throw new MachineOffError();
			}
			// A window app with a backend (§6.9: ui.type tty or fb) opens the
			// way the console's `app start` does — rund spawns it, on a PTY
			// for a tty app (app.start {pty}), and the desktop grows the
			// window on the stream it opens. `app run` is the CONSOLE's verb:
			// it wants the caller's terminal, and this channel has none, so
			// the guest refused a tty app with exit 2 — a verdict the old
			// `>/dev/null 2>&1 &` here swallowed into a silent success.
			// (The page only sends command apps through `start`, apps-page;
			// this path is the window kind's alone.)
			await guestCli(`start ${id}`, 30);
		},
	};
}
