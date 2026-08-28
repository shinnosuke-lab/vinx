/**
 * Put the Linux VM reference in the workspace, if it is not already.
 *
 * The model writes run_shell against a userland it cannot see — busybox, not
 * GNU coreutils — and the traps live in this skill. Shipping it as a package
 * rather than as prompt text is what lets it be complete: it costs a
 * description until the model calls read_skill.
 *
 * Version-compared, so a new build replaces it and an unchanged one is a single
 * `/api/skills` read. Deleting it from the skills page is therefore undone by
 * the next reload — it is documentation this page carries, not something the
 * user installed. Failure is logged and nothing else: the agent works without
 * it, it just guesses more.
 *
 * Shared by both engines' hosts — the chat page and the terminal's assistant
 * panel — which is why it lives here rather than in main.tsx. It talks to
 * `/api/skills`, so it must run after `mount()` has installed the fetch shim.
 */

// Both written by `npm run build:skill` from ../../skills/; see build-skill.mjs.
import bundledSkill from './gen/bundled-skill.json';
import bundledSkillUrl from './gen/linux-vm.zip?url';

export async function installBundledSkill() {
	const listed = await fetch('/api/skills').then((r) => r.json());
	const have = (listed.skills ?? []).find((s: { name: string }) => s.name === bundledSkill.name);
	if (have?.version === bundledSkill.version) return;

	const zip = await fetch(bundledSkillUrl).then((r) => r.arrayBuffer());
	const res = await fetch('/api/skills/import', {
		method: 'POST',
		headers: { 'Content-Type': 'application/zip' },
		body: zip,
	});
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	console.info(`installed the bundled ${bundledSkill.name} skill ${bundledSkill.version}`);
}
