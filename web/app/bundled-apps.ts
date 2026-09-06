/**
 * The apps this page ships with, seeded once into the machine's /data/apps.
 *
 * `apps/<id>/` at the repository root is the source of each — an app
 * directory as `app pack` takes it; build-apps.mjs packs them into
 * app/gen/apps/<id>.vapp and lists them in app/gen/bundled-apps.json. On
 * the page's first load the tab that owns the machine lands each one the
 * way `app install` would leave it — the package and its sidecars
 * (app-install.ts), in the mirror and, machine up, the live tree — and
 * writes the id to `apps/bundled`: the list of ids this page ever seeded
 * into this machine, one per line, the enabled list's shape and edits.
 *
 * A gift, not documentation (compare bundled-skill.ts, which reinstalls on
 * every version bump): an app the person uninstalls stays uninstalled — the
 * id on `apps/bundled` is what keeps the next load from bringing it back —
 * and an id they already have a package under is theirs, left as it is and
 * recorded, so no later build overwrites it either. A tab that does not own
 * the machine does not seed: the owner did, or will. Failure is logged and
 * nothing else; the next load tries again.
 */

import bundled from './gen/bundled-apps.json';
import { APPS_CHANGED_EVENT, installSidecars, landInApps } from './app-install';
import { parseEnabled, withEnabled } from './enabled-list';
import { mirroredDir } from './share-store';
import { manifestOf, unpackVapp } from './vapp';
import type { VinxVm } from './vm';

/** One line of app/gen/bundled-apps.json — what build-apps.mjs packed. */
interface BundledApp {
	id: string;
	kind: string;
	web: boolean;
	title: string;
	description: string;
	bytes: number;
	sha256: string;
}

/** The record under /data/apps: the ids ever seeded, one per line. */
const RECORD = 'bundled';
export const BUNDLED_RECORD = `apps/${RECORD}`;

const packages = import.meta.glob('./gen/apps/*.vapp', {
	query: '?url',
	import: 'default',
	eager: true,
}) as Record<string, string>;

/**
 * Seed whatever bundled app this machine has not been given yet. Resolves
 * to the ids landed this time (empty when there was nothing to do).
 */
export async function seedBundledApps(vm: VinxVm): Promise<string[]> {
	const apps = bundled as BundledApp[];
	if (apps.length === 0) return [];
	if (!(await vm.isOwner())) return [];

	const installed = await mirroredDir('apps');
	let record = installed.get(RECORD);
	const given = new Set(parseEnabled(record));
	const todo = apps.filter((a) => !given.has(a.id));
	if (todo.length === 0) return [];

	const landed: string[] = [];
	for (const app of todo) {
		const theirs = installed.has(`${app.id}.vapp`);
		const landing: [string, Uint8Array][] = [];
		if (!theirs) {
			const url = packages[`./gen/apps/${app.id}.vapp`];
			if (!url) throw new Error(`bundled-apps.json names ${app.id} but no package was built for it`);
			const res = await fetch(url);
			if (!res.ok) throw new Error(`fetching the bundled ${app.id} package: HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			const files = await unpackVapp(bytes);
			const manifest = files && manifestOf(files);
			if (!manifest) throw new Error(`the bundled ${app.id} package has no readable app.json`);
			landing.push([`apps/${app.id}.vapp`, bytes], ...installSidecars(app.id, manifest));
		}
		// The record goes with the package — one landing, so a machine that
		// is up sees both in its live tree and the next snapshot keeps both.
		record = withEnabled(record, app.id, true);
		landing.push([BUNDLED_RECORD, record]);
		await landInApps(vm, landing);
		if (!theirs) landed.push(app.id);
		console.info(theirs ? `bundled app ${app.id}: a package is already there, left as it is` : `bundled app ${app.id} seeded`);
	}
	if (landed.length) window.dispatchEvent(new CustomEvent(APPS_CHANGED_EVENT, { detail: { ids: landed, seeded: true } }));
	return landed;
}
