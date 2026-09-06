/**
 * The built page, in a real browser.
 *
 * Everything else in the suite runs the engine under Node, where the wasm is
 * loaded from a file, `fetch` is Node's, and there is no IndexedDB — so the
 * things that only exist in a browser have never been exercised: the worker
 * actually starting, the wasm arriving over HTTP, streaming through the page's
 * `fetch`, and persistence, which is stubbed with an in-memory database
 * everywhere else.
 *
 * The page is a single-origin static site here (no server, no gateway): the
 * document, the code, and the VM images all come from one static host. The
 * assertions go through `window.fetch` rather than clicking the UI, because the
 * shim's whole job is to make `fetch('/api/...')` behave like agent-core's
 * server — testing the contract itself rather than one UI's reading of it.
 *
 * The console/VM leg is real end to end: it boots the emulated Linux and reads
 * its serial console. That needs the images under app/public/vm/, so it is
 * skipped (not failed) when they are absent — set VM_IMAGES=1 to require it.
 *
 * Run with `./deploy/browser.sh`.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { crc32 } from 'node:zlib';

import { chromium } from 'playwright';

import { CORPUS, expectedCodes, sampleCommands } from './manifest-corpus.mjs';

/** The one origin serving the document, the code, and the VM images. */
const APP_URL = process.env.APP_URL;
const MOCK_LLM_URL = process.env.MOCK_LLM_URL;
/** The app shell (system-v2 §10.3): shipped beside the page, so browser.sh
 * names it as `app-frame.html` on the desktop's own origin. */
const APP_FRAME_URL = process.env.APP_FRAME_URL;
/** Set by browser.sh when app/public/vm/ carries the built images. */
const VM_IMAGES = process.env.VM_IMAGES === '1';
assert.ok(APP_URL, 'APP_URL must point at the static server');
assert.ok(MOCK_LLM_URL, 'MOCK_LLM_URL must point at the mock endpoint');
assert.ok(APP_FRAME_URL, 'APP_FRAME_URL must point at the app shell');

/**
 * Attach to a session and collect its SSE, the way the chat client does.
 *
 * Stops at `done` or `error` — the turn is over — and also at `confirm`, where
 * the turn parks at the approval gate and sends nothing more until answered.
 * Without that last one, a gated tool call leaves the read hanging forever.
 */
function attach(page, sessionId) {
	return page.evaluate(async (id) => {
		const res = await fetch(`/api/chat/stream/${encodeURIComponent(id)}`);
		const type = res.headers.get('content-type') ?? '';
		if (!type.includes('text/event-stream')) throw new Error(`not an event stream: ${type}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let out = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value, { stream: true });
			if (/event: (done|error|confirm)\b/.test(out)) break;
		}
		return out;
	}, sessionId);
}

/** Every context answers the terminal's one-time "go online?" banner before
 * it can appear: it floats over the panes and would steal clicks meant for
 * elements underneath. Its own behavior is asserted in a dedicated test. */
/** Every context in this suite opens on a machine that boots with the
 * page, and without the two first-run questions the chat page would ask:
 * the network nudge, and whether to boot at all (machine-power.ts — a
 * machine last left 'on' boots with the page, the pre-question
 * behaviour). The one test about the question itself builds its own
 * context without this. */
function muteNetPrompt(ctx) {
	return ctx.addInitScript(() => {
		localStorage.setItem('vinx.net.prompted', '1');
		localStorage.setItem('vinx.machine.power', 'on');
	});
}

/** The Bridge LAN surfaces hide by default (WebRTC across home networks is
 * too flaky to sell as a mode); this flag brings them back so the bridge
 * machinery keeps its coverage. A dedicated test asserts the default. */
function enableBridgeUi(ctx) {
	return ctx.addInitScript(() => localStorage.setItem('vinx.bridge.ui', '1'));
}

/** Wait for the worker to be answering; nothing works before that. */
async function ready(page, timeout = 60_000) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const ok = await page
			.evaluate(() =>
				fetch('/api/chat/meta')
					.then((r) => r.ok)
					.catch(() => false),
			)
			.catch(() => false);
		if (ok) return;
		if (Date.now() > deadline) {
			throw new Error(
				`the worker never answered /api/chat/meta within ${timeout}ms.\n` +
					`document: ${page.url()}\n` +
					(seen.size ? `what the browser said:\n  ${problems().join('\n  ')}\n` : ''),
			);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Poll `read` in the page until it returns something, or give up. */
async function eventually(page, read, what, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const got = await page.evaluate(read).catch(() => null);
		if (got) return got;
		if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeout}ms`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Point the page at the mock endpoint and choose a scenario. */
function configure(page, model) {
	return page.evaluate(
		([url, model]) =>
			fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					base_url: url,
					model,
					api_key: 'k',
					enabled: true,
				}),
			}).then((r) => r.json()),
		[MOCK_LLM_URL, model],
	);
}

/** Event names in an SSE blob, in order. */
function events(sse) {
	return [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
}

/** Concatenated text of the `content` frames — or, when the turn outran the
 * attach (events run session,history,done with no deltas), the assistant text
 * from the last replayed `history` frame. That is the rule the real client
 * follows (AgentChat's `history` case: one snapshot serving first send,
 * re-attach and the fast-turn race alike); tests that specifically pin live
 * streaming assert `events(sse)` separately. */
function text(sse) {
	const live = [...sse.matchAll(/^event: content\ndata: (.+)$/gm)]
		.map((m) => JSON.parse(m[1]).text)
		.join('');
	if (live) return live;
	const replay = [...sse.matchAll(/^event: history\ndata: (.+)$/gm)].at(-1);
	if (!replay) return '';
	return (JSON.parse(replay[1]).messages ?? [])
		.filter((m) => m.role === 'assistant' && typeof m.content === 'string')
		.map((m) => m.content)
		.join('');
}

/**
 * The terminal page is a shell over iframes — the console lives inside
 * `pane-1` (a second machine, when split in, inside `pane-2`). Everything
 * that used to address the terminal's DOM addresses the pane's frame now.
 */
async function paneFrame(page, id = '1', timeout = 30_000) {
	await page.waitForSelector(`iframe[name="pane-${id}"]`, { timeout });
	const deadline = Date.now() + timeout;
	for (;;) {
		const frame = page.frame({ name: `pane-${id}` });
		if (frame) return frame;
		if (Date.now() > deadline) throw new Error(`the pane-${id} frame never appeared`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Booting a real kernel in a headless emulator takes a while. The optional
 * chain matters: during an iframe's navigation swap the document is briefly
 * rootless, and a predicate that throws kills the wait instead of retrying.
 * A timeout names where the boot stalled — 'booting' plus a control-link
 * state distinguishes a load-starved kernel from a wedged control plane. */
async function vmReady(frame, timeout = 120_000) {
	try {
		await frame.waitForFunction(() => document.documentElement?.dataset.vmState === 'ready', null, {
			timeout,
		});
	} catch (e) {
		const at = await frame
			.evaluate(() => ({
				vm: document.documentElement?.dataset.vmState,
				rpc: window.vinxRpc?.state?.(),
			}))
			.catch(() => null);
		throw new Error(
			`the VM never reached ready (stalled at ${JSON.stringify(at)}): ${String(e.message).split('\n')[0]}`,
		);
	}
}

/** The ttyS3 control link, page side: hello answered, session up. VM
 * "ready" only means the hello went out (vm.ts attaches and moves on), and
 * the console prompt is a different daemon entirely — a test that talks to
 * the control plane right after either would race rpcd's own startup. */
function rpcUp(frame, timeout = 30_000) {
	return frame.waitForFunction(() => window.vinxRpc?.state() === 'up', null, { timeout });
}

/** The whole control plane: the link is up AND rund is serving. rpcd
 * answers hello before rund's rpc.serve lands (separate respawned daemons,
 * §6.10), so "up" alone leaves a window where proc.run honestly answers
 * UNAVAILABLE "rund is not connected" — a slow boot under a loaded host
 * stretches it to seconds. Tests about proc.run's behaviour start here;
 * the boot window itself stays visible in the errors it was designed to
 * give (§18: readiness is the caller's to gate on). */
async function procReady(frame, timeout = 30_000) {
	await rpcUp(frame, timeout);
	const deadline = Date.now() + timeout;
	for (;;) {
		const r = await frame.evaluate(() =>
			window.vinxRpc.call('proc.run', { command: 'true' }, 10_000),
		);
		if (r.ok) return;
		if (r.error?.name !== 'UNAVAILABLE' || Date.now() > deadline)
			throw new Error(`proc.run never became ready: ${JSON.stringify(r)}`);
		await new Promise((pause) => setTimeout(pause, 250));
	}
}

/** The console's viewport text. Read through the buffer API (the pages
 * export their console as __vinxConsole): under the WebGL renderer the
 * DOM carries no text rows. Only the viewport rows, exactly what the old
 * .xterm-rows read gave — a tty window (§6.9) is a different terminal and
 * never mixes in. The DOM read stays as the fallback for a console that
 * has not exported itself yet. */
function frameScreen(frame) {
	return frame.evaluate(() => {
		const t = window.__vinxConsole;
		if (t) {
			const buf = t.buffer.active;
			const rows = [];
			for (let i = 0; i < t.rows; i++) {
				rows.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
			}
			return rows.join('\n').replace(/\n+$/, '');
		}
		return [...document.querySelectorAll('.screen .xterm-rows > div, .vmc-term .xterm-rows > div')]
			.map((row) => row.textContent.replace(/\u00a0/g, ' ').replace(/\s+$/, ''))
			.join('\n')
			.replace(/\n+$/, '');
	});
}

async function frameUntil(frame, matches, what, timeout = 120_000) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const text = await frameScreen(frame);
		if (matches(text)) return text;
		if (Date.now() > deadline) throw new Error(`the console never showed ${what}:\n${text}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** Type into a console: the click focuses the xterm, the page-level
 * keyboard then lands there. Scoped to the console proper (the terminal
 * page's `.screen`, or the chat page's `.vmc-term` panel) — a tty
 * window's xterm would swallow the keystrokes otherwise. */
async function frameType(page, frame, line) {
	await frame.click('.screen .xterm-screen, .vmc-term .xterm-screen');
	await page.keyboard.type(line);
	await page.keyboard.press('Enter');
}

/** A skill package: a zip of one `SKILL.md`, built here rather than committed. */
function skillPackage(name, body) {
	const file = Buffer.from(`${name}/SKILL.md`);
	const data = Buffer.from(body);
	const crc = crc32(data);

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(file.length, 26);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(file.length, 28);

	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + file.length, 12);
	end.writeUInt32LE(local.length + file.length + data.length, 16);

	return [...Buffer.concat([local, file, data, central, file, end])];
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the page boots: worker, wasm and UI all come up', async (page) => {
	const meta = await page.evaluate(() => fetch('/api/chat/meta').then((r) => r.json()));
	assert.equal(meta.protocol, 2, 'the worker answered, so wasm loaded over HTTP');

	const rendered = await page.evaluate(() => {
		const root = document.getElementById('root');
		return {
			children: root?.children.length ?? 0,
			text: root?.textContent ?? '',
		};
	});
	assert.ok(rendered.children > 0, 'nothing rendered into #root');
	assert.ok(
		!rendered.text.includes('The agent could not start'),
		`the page rendered its failure screen: ${rendered.text.slice(0, 300)}`,
	);
});

test('a turn streams from the model through the page fetch', async (page) => {
	await configure(page, 'mock-text');
	const ack = await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'hi', session_id: 'stream' }),
		}).then((r) => r.json()),
	);
	assert.equal(ack.ok, true);
	const sse = await attach(page, 'stream');
	assert.ok(events(sse).includes('content'), `no content frames: ${events(sse)}`);
	assert.equal(text(sse), 'Hello, world');
});

test('the device tool is run_shell, marked unsafe so the model is gated', async (page) => {
	// The tool comes from the in-page VM's local payload, not an HTTP device,
	// so it is proven by the confirmation gate below — only a registered unsafe
	// tool raises one — rather than by a tools listing endpoint.
	await configure(page, 'mock-run-shell');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'run it', session_id: 'gated' }),
		}).then((r) => r.json()),
	);
	const sse = await attach(page, 'gated');
	assert.ok(
		events(sse).includes('confirm'),
		`run_shell did not raise the confirmation gate: ${events(sse)}`,
	);
	assert.ok(sse.includes('run_shell'), 'the gated call was not run_shell');
});

test('run_js runs on this very page and its value reaches the model', async (page) => {
	// No VM needed: the tool dispatches on the main thread and executes right
	// here (app/hostcall.ts). Unsafe, so the reader approves the one gate.
	await configure(page, 'mock-run-js');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'run it', session_id: 'runjs-e2e' }),
		}).then((r) => r.json()),
	);
	const sse = await attachApproving(page, 'runjs-e2e', 60_000);
	assert.ok(!events(sse).includes('error'), `the run_js turn errored: ${sse.slice(0, 500)}`);
	assert.ok(
		text(sse).includes('42'),
		`the expression value did not reach the model: ${text(sse) || sse.slice(0, 500)}`,
	);
});

test('storage survives a reload, which is the whole point of IndexedDB', async (page) => {
	await configure(page, 'mock-text');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'remember me', session_id: 'kept' }),
		}).then((r) => r.json()),
	);
	await attach(page, 'kept');

	await page.reload({ waitUntil: 'networkidle' });
	await ready(page);
	const sessions = await page.evaluate(() => fetch('/api/sessions').then((r) => r.json()));
	assert.ok(
		(sessions.sessions ?? sessions).some?.((s) => s.id === 'kept') ??
			JSON.stringify(sessions).includes('kept'),
		'the session did not survive the reload',
	);
});

test('full-auto, archive and category are kept in the store across a reload', async (page) => {
	await configure(page, 'mock-text');
	const api = (path, init) =>
		page.evaluate(
			([p, i]) =>
				fetch(p, i).then(async (r) => {
					if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
					return r.json();
				}),
			[path, init ?? {}],
		);
	const send = (body) =>
		api('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	const ids = (list) => list.map((s) => s.id);

	// The fresh composer's toggle: no session id yet, so the flag rides on the
	// send that creates the session and has to land in the row it creates.
	const ack = await send({ message: 'first', full_auto: true });
	const id = ack.session_id;
	assert.ok(id, 'the ack should name the session the send created');
	await attach(page, id);
	const patch = (body) =>
		api(`/api/sessions/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	await patch({ archived: true });
	await patch({ category: 'work' });

	assert.ok(!ids(await api('/api/sessions')).includes(id), 'archived, yet listed');
	const row = (await api('/api/sessions?scope=archived')).find((s) => s.id === id);
	assert.ok(row?.archived_at, 'not in the archived scope');
	assert.equal(row.category, 'work');
	assert.ok(ids(await api('/api/sessions?scope=all')).includes(id));
	const bad = await page.evaluate(() => fetch('/api/sessions?scope=bogus').then((r) => r.status));
	assert.equal(bad, 400, 'an unknown scope should be refused');

	// A new host over the same database, as the user sees it after F5: the
	// flag the running host kept in memory has to come back from the store.
	await page.reload({ waitUntil: 'networkidle' });
	await ready(page);
	await configure(page, 'mock-text');
	const detail = () => api(`/api/sessions/${encodeURIComponent(id)}`);
	const meta = (await detail()).meta;
	assert.equal(meta.auto_confirm, true, 'full-auto did not survive the reload');
	assert.equal(meta.category, 'work');
	assert.ok(meta.archived_at, 'the archive stamp did not survive the reload');

	// Sending to an archived session revives it the moment the turn starts;
	// the label and the full-auto flag stay.
	await send({ message: 'again', session_id: id });
	await attach(page, id);
	const revived = (await api('/api/sessions')).find((s) => s.id === id);
	assert.ok(revived, 'a new turn should bring the session back to the live list');
	assert.equal(revived.archived_at, undefined);
	assert.equal(revived.category, 'work');
	assert.equal((await detail()).meta.auto_confirm, true);
});

test('the settings page can make full-auto the default, and a fresh chat starts in it', async (page) => {
	await configure(page, 'mock-text');
	const get = (path) => page.evaluate((p) => fetch(p).then((r) => r.json()), path);

	// The form never sees the key, but is told one is there.
	const shown = await get('/api/config');
	assert.equal(shown.api_key, '');
	assert.equal(shown.api_key_set, true, 'the form cannot tell "stored" from "never set" otherwise');
	assert.equal((await get('/api/chat/meta')).config.default_full_auto, false);

	// Save with the toggle on — the whole form round-trips, annotation included,
	// exactly as the settings page submits it.
	await page.evaluate(
		(cfg) =>
			fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...cfg, api_key: '', default_full_auto: true }),
			}).then((r) => r.json()),
		shown,
	);
	assert.equal((await get('/api/chat/meta')).config.default_full_auto, true);

	// After F5 the default comes back from storage and seeds the fresh
	// composer's badge: the red pill is pressed before any session exists.
	await page.reload({ waitUntil: 'networkidle' });
	await ready(page);
	assert.equal((await get('/api/chat/meta')).config.default_full_auto, true, 'the default did not survive the reload');
	const pressed = await eventually(
		page,
		() => {
			const b = [...document.querySelectorAll('button[aria-pressed]')].find((el) =>
				/FULL-AUTO|全自动/.test(el.textContent ?? ''),
			);
			return b ? b.getAttribute('aria-pressed') : null;
		},
		'the full-auto badge',
	);
	assert.equal(pressed, 'true', 'a fresh chat should start with the badge on');
	// The key survived a save that left the field blank.
	assert.equal((await get('/api/config')).api_key_set, true);
});

test('the page installs its own Linux VM reference on first load', async (page) => {
	const skill = await eventually(
		page,
		() =>
			fetch('/api/skills')
				.then((r) => r.json())
				.then((l) => l.skills.find((s) => s.name === 'linux-vm') ?? null),
		'the bundled skill was never installed',
	);
	assert.ok(skill.version, 'installed without a version, so it can never be updated');

	const readme = await page.evaluate(() =>
		fetch('/api/skills/linux-vm/readme').then((r) => r.text()),
	);
	assert.match(readme, /busybox/, 'the reference stopped describing the userland');
});

test('the system prompt carries the skills manifest, so skills are discoverable', async (page) => {
	// Tier 1 of the skill system: without the manifest in the system message
	// the model can never learn that read_skill has anything to read — the
	// recorded symptom was an agent unaware the VM has a VGA screen at all.
	await eventually(
		page,
		() =>
			fetch('/api/skills')
				.then((r) => r.json())
				.then((l) => l.skills.find((s) => s.name === 'linux-vm') ?? null),
		'the bundled skill was never installed',
	);
	await configure(page, 'mock-echo-system');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'what do you know?', session_id: 'sysmsg-e2e' }),
		}).then((r) => r.json()),
	);
	const sse = await attach(page, 'sysmsg-e2e');
	const system = text(sse);
	assert.match(
		system,
		/Available Skills/,
		`no manifest in the system message (events: ${events(sse).join(',')}): ${system.slice(0, 400)}`,
	);
	assert.match(system, /linux-vm/, 'the manifest does not name the linux-vm skill');
	assert.match(
		system,
		/fbdemo/,
		'the linux-vm entry stopped naming the VGA screen (fbdemo) — the blind spot this exists to fix',
	);
});

test('an installed skill outlives the tab and steers a turn', async (page) => {
	const bytes = skillPackage(
		'weather',
		'---\nname: weather\ndescription: talks about weather\n---\n\nAlways mention the barometer.\n',
	);
	const installed = await page.evaluate(
		(body) =>
			fetch('/api/skills/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/zip' },
				body: new Uint8Array(body),
			}).then((r) => r.json()),
		bytes,
	);
	assert.equal(installed.ok ?? true, true, `import failed: ${JSON.stringify(installed)}`);

	await page.reload({ waitUntil: 'networkidle' });
	await ready(page);
	const after = await page.evaluate(() => fetch('/api/skills').then((r) => r.json()));
	assert.ok(
		after.skills.some((s) => s.name === 'weather'),
		'the imported skill did not survive the reload',
	);
});

test('the terminal page is still served, as its own computer', async (page) => {
	// Nothing on the chat page links to `/terminal/` anymore — every document
	// is one machine (pane-id.ts), so the apps page's old "Web Terminal" card
	// and the vendored open_terminal button were doors to a *different*
	// computer dressed as this one's. The document itself remains, reached by
	// URL, as the way to sit down at another machine.
	const url = new URL('terminal/', APP_URL).href;
	const res = await page.evaluate((u) => fetch(u).then((r) => r.status), url);
	assert.equal(res, 200, 'the terminal document is not served');
});

test('an unreachable endpoint is reported, not swallowed', async (page) => {
	await page.evaluate(
		(url) =>
			fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					base_url: url,
					model: 'mock-text',
					api_key: 'k',
					enabled: true,
				}),
			}).then((r) => r.json()),
		'http://127.0.0.1:9/v1',
	);
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'hi', session_id: 'dead' }),
		}).then((r) => r.json()),
	);
	const sse = await attach(page, 'dead');
	assert.ok(
		events(sse).includes('error') || events(sse).includes('done'),
		`a dead endpoint left the stream open: ${events(sse)}`,
	);
});

test('run_shell runs on the VM and its output reaches the model', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The whole loop: engine -> the worker's fetch bounce -> the main thread ->
	// vm.runShell -> proc.run on ttyS3 (rpcd, then rund) -> back.
	// mock-run-shell calls `echo hi` and its second leg echoes the tool
	// result, so "hi" in the final content proves the output made the round
	// trip. The unsafe tool parks at the approval gate; the reader approves
	// it and keeps going.
	//
	// Reload and let the page's pre-boot bring the VM up uncontended first: a
	// VM that boots *during* the turn competes with the engine worker for the
	// main thread and crawls (see app/main.tsx). Waiting for the VM to reach
	// `ready` (reflected onto <html data-vm-state>) makes this deterministic
	// instead of racing whatever prior tests left behind.
	await page.reload({ waitUntil: 'networkidle' });
	await ready(page);
	await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 60_000,
	});
	await configure(page, 'mock-run-shell');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'run it', session_id: 'run-e2e' }),
		}).then((r) => r.json()),
	);
	// Each read races a remaining-time timeout, so a stalled stream fails the
	// test rather than hanging the suite. Booting v86 and running the command
	// takes tens of seconds, hence the generous budget.
	const sse = await page.evaluate(async (id) => {
		const res = await fetch(`/api/chat/stream/${encodeURIComponent(id)}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		const start = Date.now();
		const BUDGET = 120_000;
		let out = '';
		let approved = false;
		for (;;) {
			const left = BUDGET - (Date.now() - start);
			if (left <= 0) break;
			const step = await Promise.race([
				reader.read(),
				new Promise((r) => setTimeout(() => r({ timeout: true }), left)),
			]);
			if (step.timeout || step.done) break;
			out += decoder.decode(step.value, { stream: true });
			// Approve the run_shell call once, so the unsafe tool actually runs.
			if (!approved && /event: confirm\b/.test(out)) {
				approved = true;
				const m = out.match(/event: confirm\ndata: (.+)/);
				const callId = m ? (JSON.parse(m[1]).id ?? null) : null;
				await fetch('/api/chat/confirm', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ session_id: id, id: callId, confirmed: true }),
				});
			}
			if (/event: (done|error)\b/.test(out)) break;
		}
		return out;
	}, 'run-e2e');
	assert.ok(!events(sse).includes('error'), `the run_shell turn errored: ${sse.slice(0, 500)}`);
	assert.ok(
		text(sse).includes('hi'),
		`the command output did not reach the model: ${text(sse) || sse.slice(0, 500)}`,
	);
});

test('run_shell starts in /data, the directory that persists', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The VM is warm from the previous test. mock-pwd-shell runs a bare
	// `pwd`; /data in the echo proves rund starts jobs there (agentd did
	// the same — rund was built agentd-shaped for exactly this swap), so
	// the model's relative paths land where they survive a reload.
	await configure(page, 'mock-pwd-shell');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'where are you?', session_id: 'pwd-e2e' }),
		}).then((r) => r.json()),
	);
	const sse = await attachApproving(page, 'pwd-e2e');
	assert.ok(!events(sse).includes('error'), `the pwd turn errored: ${sse.slice(0, 500)}`);
	assert.match(
		text(sse),
		/\/data/,
		`run_shell does not start in /data: ${text(sse) || sse.slice(0, 500)}`,
	);
});

test('the console boots the VM and echoes over its serial line', async (page, context) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const term = await context.newPage();
	try {
		await term.goto(new URL('terminal/', APP_URL).href, {
			waitUntil: 'networkidle',
		});
		const frame = await paneFrame(term);
		// The container, not .xterm-rows: the WebGL renderer draws on a
		// canvas and keeps no DOM text rows.
		await frame.waitForSelector('.screen .xterm-screen', { timeout: 30_000 });

		// Wait for a shell prompt on ttyS0.
		await frameUntil(frame, (t) => /#\s*$/.test(t) || t.includes('vinx'), 'a shell prompt');
		await frameType(term, frame, 'echo br0wser-live');
		await frameUntil(frame, (t) => t.includes('br0wser-live'), 'the echoed line');
	} finally {
		if (!term.isClosed()) await term.close();
	}
});

test('js(1) and fetch(1) reach the page over ttyS3', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);
	await rpcUp(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// An expression answers REPL-style; the split marker keeps the expected
	// output out of the echoed command, and $(...) proves the answer arrives
	// on stdout (capturable), not painted by escape sequences.
	await frameType(page, frame, `v=$(js -e '6*7') && echo "GOT-$v-JS"`);
	const js = await frameUntil(
		frame,
		(t) => /GOT-\d+-JS|js:|hostcall:/.test(t),
		'the js answer',
		30_000,
	);
	assert.match(js, /GOT-42-JS/, `js(1) did not answer 42:\n${js}`);

	// The page's own DOM is what makes js(1) different from qjs(1).
	await frameType(page, frame, `js -e 'document.characterSet'; echo DOM-D''ONE`);
	const dom = await frameUntil(frame, (t) => /DOM-DONE/.test(t), 'the DOM read', 30_000);
	assert.match(dom, /UTF-8/, `js(1) could not read the page's DOM:\n${dom}`);

	// A script error is an exit code and a named error, not a hang.
	await frameType(page, frame, `js -e 'null.x' 2>&1; echo RC=$?`);
	const thrown = await frameUntil(frame, (t) => /RC=\d/.test(t), 'the thrown script', 30_000);
	assert.match(thrown, /TypeError/, `the error text did not come back:\n${thrown}`);
	assert.match(thrown, /RC=1/, `a thrown script must exit 1:\n${thrown}`);

	// fetch: a same-origin page, body on stdout.
	await frameType(page, frame, `fetch /index.html | head -c 120; echo; echo FETCH-D''ONE`);
	const fetched = await frameUntil(frame, (t) => /FETCH-DONE/.test(t), 'the fetch body', 30_000);
	assert.match(fetched, /doctype|<html/i, `fetch(1) did not print the body:\n${fetched}`);

	// An HTTP error is status-on-stderr and exit 22, curl -f style. The
	// marker must not be RC= again: the thrown-script step's RC=1 is still
	// on screen, and frameUntil would take it for the answer.
	await frameType(page, frame, `fetch /definitely-not-here 2>&1; echo MISS-RC=$?`);
	const missed = await frameUntil(frame, (t) => /MISS-RC=\d+/.test(t), 'the 404', 30_000);
	assert.match(missed, /HTTP 404/, `the status line did not surface:\n${missed}`);
	assert.match(missed, /MISS-RC=22/, `a 404 must exit 22:\n${missed}`);

	// A body past the inline budget rides /data as a bodyRef (§6.8), exact
	// bytes: the kernel image is ~9 MB, the cap cuts it at exactly 2 MiB,
	// and wc must agree.
	await frameType(
		page,
		frame,
		`fetch -o /tmp/big.bin /vm/bzImage 2>&1; wc -c < /tmp/big.bin; echo BIG-D''ONE`,
	);
	const big = await frameUntil(frame, (t) => /BIG-DONE/.test(t), 'the spilled body', 90_000);
	assert.match(big, /2097152/, `the /data resource-ref lane lost bytes:\n${big}`);
	// The ref is the caller's to consume and delete; nothing may linger for
	// the /data mirror to pick up.
	await frameType(page, frame, `ls /data/.vinx/tmp/ | wc -l; echo CLEAN-D''ONE`);
	const clean = await frameUntil(frame, (t) => /CLEAN-DONE/.test(t), 'the ref cleanup', 15_000);
	assert.match(clean, /\b0\b/, `resource refs were left behind:\n${clean}`);

	// A request past what a 4 KiB frame carries rides /data the other way: a
	// ~40 KB script goes out as {codeRef}, runs whole, and the staged file is
	// the CLI's to delete. The asserted value (42000) never appears in the
	// typed command, so the echo cannot satisfy the match.
	await frameType(
		page,
		frame,
		`{ i=0; while [ $i -lt 2200 ]; do echo 'console.log("y")'; i=$((i+1)); done; ` +
			`echo 'return 6*7*1000'; } > /tmp/bigreq.js; wc -c /tmp/bigreq.js; ` +
			`js /tmp/bigreq.js | tail -n1; ls /data/.vinx/tmp/ | wc -l; echo BIGREQ-D''ONE`,
	);
	const bigReq = await frameUntil(frame, (t) => /BIGREQ-DONE/.test(t), 'the big request', 60_000);
	assert.match(bigReq, /42000/, `a >4 KiB script did not survive the codeRef lane:\n${bigReq}`);
	assert.match(bigReq, /\n0\b/, `staged refs were left behind:\n${bigReq}`);
});

// ── Control-plane failure cases (system-v2 §6.7 calls these day-one tests):
// the Phase 0 baseline versions of these pinned the old CALL/DONE protocol
// (docs/protocol-baseline.zh-CN.md); these are their Phase 1 successors on
// the VX1/JSON-RPC link, plus the day-one obligations that had no
// pre-rpcd equivalent. window.vinxRpc and window.vinxSerialProbe (vm.ts,
// terminal.tsx) are the instruments. ──

test('a parked run_shell blocks nothing: other calls and the console stay live', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await rpcUp(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// Park a run_shell on a command only a flag file releases — a slow tool
	// call in miniature, without a guessed sleep to clean up after. Before
	// Phase 2 this proved two wires were independent; the wires are one now,
	// and the same guarantee is rpcd/rund multiplexing (§6.7): a long job
	// holds a rund slot, never the link.
	const parked = frame.evaluate(() =>
		window.vinxRpc.run('until [ -f /tmp/ch-go ]; do sleep 1; done; echo released', 90),
	);
	// js(1) rides the same control plane; it owes an answer *while* the
	// long job runs. The $(...) proves it arrived on stdout.
	await frameType(page, frame, `v=$(js -e '6*7') && echo "CH-$v-INDEP"`);
	const seen = await frameUntil(
		frame,
		(t) => /CH-\d+-INDEP|js:|rpc:/.test(t),
		'the js answer during a parked run_shell',
		30_000,
	);
	assert.match(seen, /CH-42-INDEP/, `js(1) did not answer while a run_shell was parked:\n${seen}`);

	// Release from the console (ttyS0, its own line as ever).
	await frameType(page, frame, 'touch /tmp/ch-go');
	const done = await parked;
	assert.equal(done.exit_code, 0, `the parked run_shell broke: ${JSON.stringify(done)}`);
	assert.match(done.output, /released/, 'the parked run_shell lost its output');
});

test('two guest processes call at once: rpcd multiplexes, frames stay whole', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await rpcUp(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// Watch the frames leave the guest while two js(1) run concurrently.
	// The old protocol needed flock to serialise callers; rpcd multiplexes
	// many clients over one write queue instead — both answered, no lock.
	await frame.evaluate(() => window.vinxSerialProbe.record(3));
	await frameType(
		page,
		frame,
		`rm -f /tmp/ha /tmp/hb; js -e '"A"+"1"' >/tmp/ha 2>&1 & js -e '"B"+"2"' >/tmp/hb 2>&1 & wait; ` +
			`echo "GOT-$(cat /tmp/ha)-$(cat /tmp/hb)"; echo MUX-D''ONE`,
	);
	const both = await frameUntil(frame, (t) => t.includes('MUX-DONE'), 'both calls', 60_000);
	if (!/GOT-A1-B2/.test(both)) {
		// A lost answer here has once meant "UNAVAILABLE: no page session" —
		// rpcd and the page disagreeing about whether a session exists. Both
		// ends keep a view: capture them while the machine is still running,
		// so the failure explains which side dropped it (or never had it).
		const link = await frame.evaluate(() => ({
			state: window.vinxRpc?.state?.(),
			stats: window.vinxRpc?.stats?.(),
		}));
		await frameType(page, frame, `cat /run/vinx/rpcd.pid; tail -n 24 /run/vinx/rpcd.log; echo LOG-D''ONE`);
		const log = await frameUntil(frame, (t) => t.includes('LOG-DONE'), 'the rpcd log', 30_000).catch(
			(e) => `unreadable: ${e.message}`,
		);
		assert.fail(
			`concurrent calls lost an answer:\n${both}\n` +
				`--- the page link ---\n${JSON.stringify(link)}\n` +
				`--- rpcd's log ---\n${log}`,
		);
	}

	// One writer on the wire: every guest frame the page recorded is whole —
	// a VX1/VXA header at the start of each line, no interleaved fragments.
	const tally = await frame.evaluate(() => window.vinxSerialProbe.stopRecord(3));
	const lines = tally.tail.split('\n').filter((l) => l.trim() !== '');
	const frames = lines.filter((l) => /^VX[1A] [0-9a-f]{16} \d+/.test(l));
	assert.ok(frames.length >= 2, `expected whole VX1 frames on ttyS3, saw:\n${tally.tail}`);
	// The tail window may clip the oldest line; every *complete* line in it
	// must be frame-shaped (debug.js requests and their ACKs).
	for (const line of lines.slice(1)) {
		assert.match(line, /^VX[1A] [0-9a-f]{16} \d+/, `a frame arrived interleaved or torn:\n${line}`);
	}
	// And nothing the page's parser saw during the burst was noise.
	const stats = await frame.evaluate(() => window.vinxRpc.stats());
	assert.equal(stats.badFrames, 0, `the page counted torn frames: ${JSON.stringify(stats)}`);
});

test('run_shell output past 64 KiB carries a marker and a readable ref — no more silent cut', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// This test's Phase 0 ancestor pinned the baseline flaw: agentd cut at
	// exactly 65536 with exit 0 and no marker (that behaviour is preserved
	// in docs/protocol-baseline.zh-CN.md §3 and measured against proc.run
	// in §6). The runShell adapter (vm.ts) inverted it: same 64 KiB inline
	// ceiling, but the cut is *said*, and the §6.8 output ref carrying the
	// full bytes is named — read_file's to fetch until the machine reboots.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await rpcUp(frame);

	const run = await frame.evaluate(() => window.vinxRpc.run('yes x | head -c 100000', 60));
	assert.equal(run.exit_code, 0, `the long command itself failed: ${JSON.stringify(run)}`);
	assert.match(
		run.output,
		/\[output truncated after 65536 bytes: 100000 bytes total/,
		`no truncation marker:\n…${run.output.slice(65500, 65900)}`,
	);
	const ref = run.output.match(/the full output is at (\/data\/\S+) —/)?.[1];
	assert.ok(ref, `the marker names no ref:\n…${run.output.slice(65500)}`);

	// The named ref holds every byte (9p exact), and it is the caller's to
	// spend — wc proves the size, rm cleans the namespace.
	const wc = await frame.evaluate(
		([p]) => window.vinxRpc.run(`wc -c < ${p} && rm -f ${p}`, 15),
		[ref],
	);
	assert.match(wc.output, /100000/, `the ref lost bytes: ${JSON.stringify(wc)}`);

	// Under the ceiling nothing is marked and nothing lingers: the adapter
	// reads the ref back whole and unlinks it.
	const mid = await frame.evaluate(() => window.vinxRpc.run('yes x | head -c 10000', 60));
	assert.equal(mid.exit_code, 0);
	assert.equal(mid.output.length, 10000, `a mid-size output must arrive whole, got ${mid.output.length}`);
	assert.ok(!/trunc/i.test(mid.output), 'a mid-size output must not be marked');
	const leftovers = await frame.evaluate(() =>
		window.vinxRpc.run('ls /data/.vinx/tmp/ 2>/dev/null | grep -c "^proc-" || true', 15),
	);
	assert.match(leftovers.output, /^0/, `spent output refs linger: ${JSON.stringify(leftovers)}`);
});

test('wire noise on ttyS3: both parsers count it, resync, and the session heals', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// (The ttyS1 half of this test — agentd answering DONE 125 to bad
	// frames — retired with agentd in Phase 3; rpc.test.ts fuzzes the
	// surviving codec.)
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// Garbage on ttyS3 (page→guest): raw high bytes, a header wearing a bad
	// epoch, a frame whose declared length lies, a bare ACK. rpcd's parser
	// must count them as noise, resync on the next real header, and keep the
	// session — one bad frame must not poison the stream (§6.7).
	await frame.evaluate(() => {
		const probe = window.vinxSerialProbe;
		probe.send(3, [0xff, 0xff, 0x00, 0x9b, 0x0a]);
		probe.send(3, 'VX1 ZZZZZZZZZZZZZZZZ 9 4 hey!\n'); // epoch is not hex
		probe.send(3, 'VX1 0123456789abcdef 9 4000 short\n'); // length lies
		probe.send(3, 'VXA 0123456789abcdef 7\n'); // stale ack, wrong epoch
	});

	// Garbage on ttyS3 (guest→page): a root process scribbling on the port
	// behind rpcd's back (TIOCEXCL does not bind root). Typed at the console
	// (ttyS0): the control plane is exactly the thing being wrecked here,
	// so the order must not ride it.
	const noiseBefore = await frame.evaluate(() => window.vinxRpc.stats());
	await frameType(
		page,
		frame,
		String.raw`printf 'not a frame \376\377 at all\n' > /dev/ttyS3 && echo SCRIBBLE-''SENT`,
	);
	await frameUntil(frame, (t) => /SCRIBBLE-SENT/.test(t), 'the scribble order', 15_000);

	// The lying length parked rpcd's parser on a partial frame; its stall
	// watchdog declares the wire out of sync after ~2 s and drops the
	// session; the page's own retransmit budget concludes UNAVAILABLE and
	// re-hellos. Poll explicitly (not waitForFunction: its polling re-enters
	// an async predicate every interval, and overlapping calls would smear
	// the very handshake being tested) until a call lands in the fresh
	// session.
	{
		let healed = false;
		for (let i = 0; i < 40 && !healed; i++) {
			const r = await frame.evaluate(() =>
				window.vinxRpc.call('proc.run', { command: 'echo healed' }, 5_000),
			);
			healed = r.ok === true;
			if (!healed) await new Promise((res) => setTimeout(res, 1_000));
		}
		assert.ok(healed, 'the control plane never healed after the garbage');
	}

	// The machine answers normally afterwards, from both entrances.
	const alive = await frame.evaluate(() => window.vinxRpc.run('echo alive', 15));
	assert.equal(alive.exit_code, 0, `run_shell did not survive the noise: ${JSON.stringify(alive)}`);
	assert.match(alive.output, /alive/, 'run_shell answered garbage after the noise');
	await frameType(page, frame, `v=$(js -e '3*3') && echo "NOISE-$v-OK"`);
	const after = await frameUntil(frame, (t) => /NOISE-\d+-OK/.test(t), 'the control plane after noise', 30_000);
	assert.match(after, /NOISE-9-OK/, `the control plane did not survive the ttyS3 garbage:\n${after}`);
	const noiseAfter = await frame.evaluate(() => window.vinxRpc.stats());
	assert.ok(
		noiseAfter.noiseBytes > noiseBefore.noiseBytes,
		`the page parser never counted the scribble: ${JSON.stringify(noiseAfter)}`,
	);
	assert.equal(await frame.evaluate(() => window.vinxRpc.state()), 'up', 'the link fell over noise');
});

test('the control session opens with hello, and discover pages every method', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await rpcUp(frame);

	// The hello negotiated what both ends will honour (§6.6). protocol:1
	// is the frozen shape (§16); rpcd echoes the page's number.
	const peer = await frame.evaluate(() => window.vinxRpc.peer());
	assert.equal(peer.protocol, 1, `not protocol 1: ${JSON.stringify(peer)}`);
	assert.ok(peer.methods.includes('proc.run'), `rund's method is missing: ${JSON.stringify(peer)}`);
	assert.equal(peer.maxFrame, 4096, 'the frame budget moved');

	// discover aggregates rpcd's own methods, rund's, and what the page
	// declared in its hello — paged, each page under the inline budget.
	// The page bound (not a while) is the guard against a nextCursor loop;
	// Phase 3 grew the page's table past twenty methods, hence 32 pages.
	const listed = [];
	let cursor = 0;
	for (let i = 0; i < 32 && cursor !== null; i++) {
		const got = await frame.evaluate(
			([c]) => window.vinxRpc.call('rpc.discover', { cursor: c, limit: 3 }),
			[cursor],
		);
		assert.ok(got.ok, `discover failed: ${JSON.stringify(got)}`);
		listed.push(...got.result.methods.map((m) => m.name));
		cursor = got.result.nextCursor ?? null;
	}
	for (const name of [
		'rpc.hello',
		'rpc.cancel',
		'proc.run',
		'http.fetch',
		'debug.js',
		'notify.show',
		'ble.connect',
		'network.bridge.status',
	]) {
		assert.ok(listed.includes(name), `discover never listed ${name}: ${listed.join(', ')}`);
	}

	// The same list from inside the machine, through rpc(1) — itself run
	// through proc.run, so this is also a nested control-plane call.
	const cli = await frame.evaluate(() => window.vinxRpc.run('rpc discover', 30));
	assert.equal(cli.exit_code, 0, `rpc discover failed: ${JSON.stringify(cli)}`);
	assert.match(cli.output, /proc\.run/, `rpc discover lost rund's method:\n${cli.output}`);
	assert.match(cli.output, /http\.fetch/, `rpc discover lost the page's methods:\n${cli.output}`);
});

test('proc.run: starts in /data, honours scriptRef, spills big output as a ref', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	const rpc = (method, params, deadline) =>
		frame.evaluate(([m, p, d]) => window.vinxRpc.call(m, p, d), [method, params, deadline]);

	// Like everything the model runs: relative paths land where they persist.
	const pwd = await rpc('proc.run', { command: 'pwd' });
	assert.ok(pwd.ok, `pwd failed: ${JSON.stringify(pwd)}`);
	assert.equal(pwd.result.stdout, '/data\n', 'proc.run does not start in /data');
	assert.equal(pwd.result.exitCode, 0);

	// A staged script runs whole through scriptRef (§6.8) — the lane long
	// commands take instead of squeezing through a 4 KiB frame.
	const stage = await frame.evaluate(() =>
		window.vinxRpc.run(
			`printf 'echo from-script; pwd' > /data/.vinx/tmp/s1.sh && wc -c < /data/.vinx/tmp/s1.sh`,
			15,
		),
	);
	assert.equal(stage.exit_code, 0, `staging failed: ${JSON.stringify(stage)}`);
	const size = Number(stage.output.trim());
	const script = await rpc('proc.run', {
		scriptRef: { path: '/data/.vinx/tmp/s1.sh', size },
	});
	assert.ok(script.ok, `scriptRef failed: ${JSON.stringify(script)}`);
	assert.equal(script.result.stdout, 'from-script\n/data\n');

	// A ref that lies about its size is refused, named for what it is.
	const lied = await rpc('proc.run', {
		scriptRef: { path: '/data/.vinx/tmp/s1.sh', size: size + 5 },
	});
	assert.equal(lied.error?.name, 'RESOURCE_INVALID', `a lying ref got through: ${JSON.stringify(lied)}`);
	// So is a path outside the tmp namespace.
	const escape = await rpc('proc.run', { scriptRef: { path: '/etc/passwd', size: 1 } });
	assert.equal(escape.error?.name, 'RESOURCE_INVALID', `a stray path got through: ${JSON.stringify(escape)}`);

	// Big output: inline head + truncated flag + the full bytes as a /data
	// ref the caller consumes — where agentd silently cut at 64 KiB.
	const big = await rpc('proc.run', { command: 'yes 0123456789abcde | head -c 100000' });
	assert.ok(big.ok, `the big run failed: ${JSON.stringify(big)}`);
	assert.equal(big.result.exitCode, 0);
	assert.equal(big.result.truncated, true, 'the truncation must be marked');
	assert.ok(big.result.stdout.length <= 1024, 'the inline head must respect inlineMax');
	assert.equal(big.result.output.size, 100000, `the ref lost bytes: ${JSON.stringify(big.result.output)}`);
	const readBack = await frame.evaluate(
		([p]) => window.vinxRpc.run(`wc -c < ${p} && rm ${p}`, 15),
		[big.result.output.path],
	);
	assert.match(readBack.output, /100000/, `the guest cannot read the ref: ${JSON.stringify(readBack)}`);

	// Params that cannot fit a frame are refused locally, pointing at refs.
	const oversized = await rpc('proc.run', { command: 'x'.repeat(8000) });
	assert.equal(oversized.error?.name, 'INVALID_PARAMS', `an oversized frame went out: ${JSON.stringify(oversized)}`);
});

test('the control plane is concurrent, and sheds load past the cap as OVERLOADED', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);

	// A slow call must not block a fast one (§6.7: replies out of order).
	const order = await frame.evaluate(async () => {
		const done = [];
		const slow = window.vinxRpc
			.call('proc.run', { command: 'sleep 4; echo slow', timeoutMs: 30_000 }, 30_000)
			.then((r) => done.push(['slow', r.ok, r.error?.name]));
		const fast = window.vinxRpc
			.call('proc.run', { command: 'echo fast' }, 30_000)
			.then((r) => done.push(['fast', r.ok, r.error?.name]));
		await fast;
		const afterFast = done.map(([n]) => n).join(',');
		await slow;
		return { afterFast, all: done };
	});
	assert.equal(order.afterFast, 'fast', `the fast call waited for the slow one: ${JSON.stringify(order)}`);
	assert.deepEqual(
		order.all.map(([, ok]) => ok),
		[true, true],
		`a call failed: ${JSON.stringify(order)}`,
	);

	// rund runs 8 jobs at once; the 9th and 10th answer OVERLOADED instead
	// of queueing into the dark.
	const shed = await frame.evaluate(async () => {
		const calls = [];
		for (let i = 0; i < 10; i++) {
			calls.push(window.vinxRpc.call('proc.run', { command: `sleep 3; echo n${i}`, timeoutMs: 30_000 }, 30_000));
		}
		const results = await Promise.all(calls);
		return {
			ok: results.filter((r) => r.ok).length,
			overloaded: results.filter((r) => r.error?.name === 'OVERLOADED').length,
			other: results.filter((r) => !r.ok && r.error?.name !== 'OVERLOADED').map((r) => r.error),
		};
	});
	assert.equal(shed.ok, 8, `expected 8 to run: ${JSON.stringify(shed)}`);
	assert.equal(shed.overloaded, 2, `expected 2 shed: ${JSON.stringify(shed)}`);
});

test('cancellation reaches the process: deadlines answer 1003 and kill the group', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	const sh = (cmd, t = 20) => frame.evaluate(([c, s]) => window.vinxRpc.run(c, s), [cmd, t]);

	// A call whose transport deadline passes: the page settles it locally as
	// DEADLINE_EXCEEDED and sends rpc.cancel; rund kills the process group,
	// so the side effect behind the sleep never happens.
	const timed = await frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'sleep 30 && touch /data/leak-a', timeoutMs: 60_000 }, 1_000),
	);
	assert.equal(timed.error?.name, 'DEADLINE_EXCEEDED', `expected 1003: ${JSON.stringify(timed)}`);
	await new Promise((r) => setTimeout(r, 1_500)); // the cancel's wire trip
	const killed = await sh('ps w | grep "sleep 3[0]" | wc -l; ls /data/leak-a 2>&1');
	assert.match(killed.output, /^0\n/, `the sleep outlived its cancel:\n${killed.output}`);
	assert.match(killed.output, /No such file/, `the cancelled command still ran:\n${killed.output}`);

	// A guest client that dies mid-call: rpcd notices the socket close and
	// cancels the work it originated (§6.7 disconnection cleanup). The
	// grep -v: this very script is itself a rund job now, so its own
	// `sh -c` argv carries the words "sleep 44" — agentd fed commands
	// through stdin where ps could not see them, rund does not.
	const crashed = await sh(
		`rpc call proc.run '{"command":"sleep 44 && touch /data/leak-b","timeoutMs":60000}' -t 60 & ` +
			`CLI=$!; sleep 1; kill -9 $CLI; sleep 1; ` +
			`ps w | grep "sleep 4[4]" | grep -cv "proc\\.run"; ls /data/leak-b 2>&1`,
		30,
	);
	assert.match(crashed.output, /0\n/, `the orphaned job survived its caller:\n${crashed.output}`);
	assert.match(crashed.output, /No such file/, `the orphaned command still ran:\n${crashed.output}`);
});

test('rpcd dies, init respawns it, and the page re-hellos into a fresh session', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	const sh = (cmd, t = 20) => frame.evaluate(([c, s]) => window.vinxRpc.run(c, s), [cmd, t]);

	const pid0 = (await sh('cat /run/vinx/rpcd.pid')).output.trim();
	const sessions0 = (await frame.evaluate(() => window.vinxRpc.stats())).sessions;

	// Park a call, then shoot rpcd from the console (ttyS0): the kill takes
	// down the very daemon that would carry a proc.run's answer, so the
	// order must not ride the control plane it is breaking.
	const parked = frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'sleep 60', timeoutMs: 60_000 }, 60_000),
	);
	await frameType(page, frame, `kill -9 $(cat /run/vinx/rpcd.pid) && echo KILLED-''RPCD`);
	await frameUntil(frame, (t) => /KILLED-RPCD/.test(t), 'the rpcd kill', 15_000);
	// The next frame gets no ACK (the respawned rpcd has no session for this
	// epoch), the link concludes UNAVAILABLE, fails everything pending —
	// the parked call included — and re-hellos on its own.
	const probeCall = await frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'echo probe' }, 15_000),
	);
	assert.equal(probeCall.error?.name, 'UNAVAILABLE', `expected the probe to fail: ${JSON.stringify(probeCall)}`);
	assert.equal((await parked).error?.name, 'UNAVAILABLE', 'the parked call must fail with the link');

	// The respawned rpcd also cost rund its socket; procReady spans both
	// recoveries (re-hello, then rund's 1 s reconnect loop).
	await procReady(frame);
	const stats = await frame.evaluate(() => window.vinxRpc.stats());
	assert.ok(stats.sessions > sessions0, `no new session: ${JSON.stringify(stats)}`);

	const pid1 = (await sh('cat /run/vinx/rpcd.pid')).output.trim();
	assert.ok(pid1 && pid1 !== pid0, `rpcd was not respawned (pid ${pid0} -> ${pid1})`);
	const after = await frame.evaluate(() => window.vinxRpc.call('proc.run', { command: 'echo back' }, 15_000));
	assert.ok(after.ok && after.result.stdout === 'back\n', `the fresh session is lame: ${JSON.stringify(after)}`);
});

test('a page-initiated session reset cancels everything pending, then serves again', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	const sh = (cmd, t = 20) => frame.evaluate(([c, s]) => window.vinxRpc.run(c, s), [cmd, t]);

	const parked = frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'sleep 55', timeoutMs: 60_000 }, 60_000),
	);
	await new Promise((r) => setTimeout(r, 1_000)); // let it reach rund
	await frame.evaluate(() => window.vinxRpc.reattach());
	assert.equal((await parked).error?.name, 'UNAVAILABLE', 'a reset must fail pending calls at once');

	await rpcUp(frame);
	// The reset cancelled the old session's work on the guest too: rpcd sent
	// rpc.cancel for everything routed to rund (§6.6).
	await new Promise((r) => setTimeout(r, 1_000));
	const leftovers = await sh('ps w | grep "sleep 5[5]" | wc -l');
	assert.match(leftovers.output, /^0/, `the old session's job survived the reset:\n${leftovers.output}`);
	const again = await frame.evaluate(() => window.vinxRpc.call('proc.run', { command: 'echo again' }, 15_000));
	assert.ok(again.ok && again.result.stdout === 'again\n', `the new session is lame: ${JSON.stringify(again)}`);
});

test('without /data, small calls still work and big output answers DATA_PLANE_UNAVAILABLE', async (page, context) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// A page of its own: this VM loses its /data on purpose, and the second
	// tab of the same machine runs ephemeral anyway (no mirror writes).
	const term = await context.newPage();
	try {
		await term.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
		const frame = await paneFrame(term);
		await vmReady(frame);
		await procReady(frame);

		const unmount = await frame.evaluate(() => window.vinxRpc.run('umount -l /data && echo GONE', 15));
		assert.match(unmount.output, /GONE/, `the unmount failed: ${JSON.stringify(unmount)}`);

		// Small control calls do not depend on the data plane (§6.8)...
		const small = await frame.evaluate(() =>
			window.vinxRpc.call('proc.run', { command: 'echo still-here' }, 15_000),
		);
		assert.ok(small.ok && small.result.stdout === 'still-here\n', `a small call broke: ${JSON.stringify(small)}`);

		// ...and a call that needs it says so, instead of truncating silently.
		const big = await frame.evaluate(() =>
			window.vinxRpc.call('proc.run', { command: 'yes x | head -c 50000' }, 15_000),
		);
		assert.equal(
			big.error?.name,
			'DATA_PLANE_UNAVAILABLE',
			`expected 1004 for big output without /data: ${JSON.stringify(big)}`,
		);
	} finally {
		if (!term.isClosed()) await term.close();
	}
});

test('dropped and guest-created /data files survive a reload', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}

	// Turn the main page itself into the terminal: one VM, one /data mirror.
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	let frame = await paneFrame(page);
	await vmReady(frame);

	// Exercise the actual drop event, not vm.putFile directly. Two files:
	// the spaced ASCII name (flattened to hello_drop.txt) and a Chinese one,
	// which must land under its own name — the whole pipeline is UTF-8 and
	// only the drop-side sanitizer ever flattened it. Files are processed in
	// order and the note shows the last one, so waiting on the Chinese note
	// means both are in.
	await frame.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['drop-body\n'], 'hello drop.txt', { type: 'text/plain' }));
		transfer.items.add(new File(['cjk-body\n'], '中文名.txt', { type: 'text/plain' }));
		document.querySelector('.pane').dispatchEvent(
			new DragEvent('drop', {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer,
			}),
		);
	});
	await frame.waitForFunction(
		() => document.querySelector('.drop-note')?.textContent?.includes('/data/中文名.txt'),
		null,
		{ timeout: 20_000 },
	);
	await frameType(page, frame, 'cat /data/hello_drop.txt; echo DROP-READ-DONE');
	const dropped = await frameUntil(frame, (t) => t.includes('DROP-READ-DONE'), 'the drop read');
	assert.match(dropped, /drop-body/, 'the dropped bytes did not reach the guest');
	await frameType(page, frame, 'ls /data && cat /data/中文名.txt; echo CJK-DROP-DONE');
	const cjk = await frameUntil(frame, (t) => t.includes('CJK-DROP-DONE'), 'the CJK drop read');
	assert.match(cjk, /中文名\.txt/, 'ls did not show the Chinese name as dropped');
	assert.match(cjk, /cjk-body/, 'the Chinese-named file did not read back');

	// The same drop path with a Chinese name: shareName keeps letters of any
	// script, so the file must land under its own name, not as ___.txt. A
	// separate drop keeps the drop-note assertion above unambiguous.
	await frame.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['cjk-body\n'], '中文名.txt', { type: 'text/plain' }));
		document.querySelector('.pane').dispatchEvent(
			new DragEvent('drop', {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer,
			}),
		);
	});
	await frame.waitForFunction(
		() => document.querySelector('.drop-note')?.textContent?.includes('/data/中文名.txt'),
		null,
		{ timeout: 20_000 },
	);
	await frameType(page, frame, 'ls /data; echo CJK-DROP-LS-DONE');
	const cjkListed = await frameUntil(frame, (t) => t.includes('CJK-DROP-LS-DONE'), 'the CJK ls');
	assert.match(cjkListed, /中文名\.txt/, 'the Chinese filename was flattened on the way in');

	// This one originates inside Linux — a plain file and an executable
	// script, because the mirror must carry the exec bit too (9p restore
	// creates 0644 files; the meta store's chmod list puts the bit back).
	// The snapshot loop runs every 15s on its own phase, so waiting a fixed
	// time races it — wait for the mirror rows themselves to appear instead.
	await frameType(page, frame, 'echo guest-body > /data/guest.txt; echo GUEST-WROTE');
	await frameUntil(frame, (t) => t.includes('GUEST-WROTE'), 'the guest write');
	await frameType(
		page,
		frame,
		'printf "#!/bin/sh\\necho EXEC-STILL-RUNS\\n" > /data/run.sh && chmod +x /data/run.sh; echo SCRIPT-WROTE',
	);
	await frameUntil(frame, (t) => t.includes('SCRIPT-WROTE'), 'the script write');
	// evaluate (not waitForFunction): the check is async because IndexedDB is,
	// and waitForFunction treats a returned Promise as already-truthy.
	{
		const deadline = Date.now() + 45_000;
		for (;;) {
			const mirrored = await frame.evaluate(async () => {
				const db = await new Promise((resolve, reject) => {
					const req = indexedDB.open('vinx.vm');
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				const haveKey = (store, check) =>
					new Promise((resolve) => {
						const get = check(db.transaction(store, 'readonly').objectStore(store));
						get.onsuccess = () => resolve(get.result);
						get.onerror = () => resolve(null);
					});
				const file = await haveKey('share', (s) => s.getKey('p1/guest.txt'));
				// The exec list is written after the file rows in the same
				// round; requiring both means the reload below cannot race it.
				const exec = await haveKey('meta', (s) => s.get('p1/'));
				db.close();
				return file != null && Array.isArray(exec) && exec.includes('run.sh');
			});
			if (mirrored) break;
			if (Date.now() > deadline) {
				throw new Error('the guest-side files never reached the IndexedDB mirror');
			}
			await new Promise((r) => setTimeout(r, 1_000));
		}
	}

	await page.reload({ waitUntil: 'networkidle' });
	frame = await paneFrame(page);
	await vmReady(frame);
	// Restoration starts as READY is published and only has two tiny files.
	await new Promise((r) => setTimeout(r, 1_000));
	await frameType(
		page,
		frame,
		'printf "<%s><%s><%s>\\n" "$(cat /data/hello_drop.txt)" "$(cat /data/guest.txt)" "$(cat /data/中文名.txt)"; echo SHARE-RESTORE-DONE',
	);
	const restored = await frameUntil(
		frame,
		(t) => t.includes('SHARE-RESTORE-DONE'),
		'the restore read',
	);
	assert.match(
		restored,
		/<drop-body><guest-body><cjk-body>/,
		'the /data mirror did not survive reload',
	);

	// Running the script (not just reading it) proves the exec bit came back.
	await frameType(page, frame, '/data/run.sh; echo EXEC-CHECK-DONE');
	const rerun = await frameUntil(frame, (t) => t.includes('EXEC-CHECK-DONE'), 'the script run');
	assert.match(rerun, /EXEC-STILL-RUNS/, 'the exec bit did not survive reload');

	// Use hex escapes so the expected output does not already occur in the
	// command xterm echoes; seeing it proves tcc really executed in v86.
	await frameType(
		page,
		frame,
		`echo '#include <stdio.h>' >/tmp/b.c; echo 'int main(void){puts("\\x54\\x43\\x43\\x2d\\x42\\x52\\x4f\\x57\\x53\\x45\\x52\\x2d\\x4f\\x4b");}' >>/tmp/b.c; tcc -run /tmp/b.c`,
	);
	await frameUntil(frame, (t) => t.includes('TCC-BROWSER-OK'), 'the tcc output');
});

test('a second machine splits in: isolated files, one LAN', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Still on the terminal shell from the previous test; machine 1 is up.
	const one = await paneFrame(page);
	await vmReady(one);
	await page.click('.actions button[title*="Split right"]');
	const two = await paneFrame(page, '2');
	await vmReady(two);

	// Separate machines: a file in one does not exist in the other.
	await frameType(page, one, 'touch /tmp/only-in-1; echo T1-DONE');
	await frameUntil(one, (t) => t.includes('T1-DONE'), 'the touch');
	await frameType(page, two, 'ls /tmp/only-in-1 2>&1; echo LS-DONE');
	const isolation = await frameUntil(two, (t) => t.includes('LS-DONE'), 'the ls');
	assert.match(isolation, /No such file/, 'pane 2 saw pane 1 filesystem');

	// One LAN: machine 1 pings machine 2's derived address for real.
	await frameType(page, two, 'cat /run/inbrowser-host; echo IP-DONE');
	const ipScreen = await frameUntil(two, (t) => t.includes('IP-DONE'), 'the host number');
	const host = ipScreen.match(/\n(\d{1,3})\s*\nIP-DONE/)?.[1];
	assert.ok(host, `no inbrowser host number on screen:\n${ipScreen}`);
	await frameType(page, one, `ping -c 1 -W 3 10.0.2.${host}; echo PING-DONE`);
	const pinged = await frameUntil(one, (t) => t.includes('PING-DONE'), 'the ping');
	assert.match(pinged, /1 packets received/, 'the two machines did not reach each other');

	// Close machine 2 so later reloads of this page boot one VM, not two.
	await page
		.locator('.shell-frame', { has: page.locator('iframe[name="pane-2"]') })
		.locator('.frame-close')
		.click();
	await page.waitForSelector('iframe[name="pane-2"]', {
		state: 'detached',
		timeout: 5_000,
	});
});

test('share local(1) puts a file on every machine: mirror, fresh boot, live sync', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Still on the terminal page; machine 1 is up.
	const one = await paneFrame(page);
	await vmReady(one);

	// The scope is a required argument: bare `share FILE` must refuse.
	await frameType(page, one, "share /tmp/nope 2>&1 | head -1; echo USAGE-D''ONE");
	const usage = await frameUntil(one, (t) => /USAGE-DONE/.test(t), 'the usage message');
	assert.match(usage, /usage: share local/, 'share without a scope did not explain itself');

	// Guest side: share local copies into /data/share/local.
	await frameType(
		page,
		one,
		"echo first-public > /tmp/pub1.txt && share local /tmp/pub1.txt && echo PUB1-D''ONE",
	);
	await frameUntil(one, (t) => /PUB1-DONE/.test(t), 'the share');

	// Page side: the snapshot mirrors it under the shared (pane-less) prefix.
	const mirrored = (frame, key) =>
		frame.evaluate(async (k) => {
			const db = await new Promise((resolve, reject) => {
				const req = indexedDB.open('vinx.vm');
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			const found = await new Promise((resolve) => {
				const t = db.transaction('share', 'readonly');
				const get = t.objectStore('share').getKey(k);
				get.onsuccess = () => resolve(get.result != null);
				get.onerror = () => resolve(false);
			});
			db.close();
			return found;
		}, key);
	{
		const deadline = Date.now() + 45_000;
		while (!(await mirrored(one, 'share/local/pub1.txt'))) {
			if (Date.now() > deadline) throw new Error('share local never reached the shared mirror');
			await new Promise((r) => setTimeout(r, 1_000));
		}
	}

	// A machine that boots after the fact restores the shared directory.
	await page.click('.actions button[title*="Split right"]');
	const two = await paneFrame(page, '2');
	await vmReady(two);
	await frameType(
		page,
		two,
		"i=0; while [ $i -lt 30 ] && [ ! -f /data/share/local/pub1.txt ]; do i=$((i+1)); sleep 1; done; cat /data/share/local/pub1.txt; echo PUB-READ-D''ONE",
	);
	const read2 = await frameUntil(two, (t) => /PUB-READ-DONE/.test(t), 'the pane-2 read', 60_000);
	assert.match(read2, /first-public/, 'the shared file did not reach the second machine');

	// Live direction: machine 2 shares while machine 1 is running; the
	// snapshot mirrors it, the BroadcastChannel announces it, and machine 1's
	// page writes it into its own guest without a reboot.
	await frameType(
		page,
		two,
		"echo second-public > /tmp/pub2.txt && share local /tmp/pub2.txt && echo PUB2-D''ONE",
	);
	await frameUntil(two, (t) => /PUB2-DONE/.test(t), 'the second share');
	await frameType(
		page,
		one,
		"i=0; while [ $i -lt 45 ] && [ ! -f /data/share/local/pub2.txt ]; do i=$((i+1)); sleep 1; done; cat /data/share/local/pub2.txt; echo SYNC-READ-D''ONE",
	);
	const read1 = await frameUntil(
		one,
		(t) => /SYNC-READ-DONE/.test(t),
		'the live-sync read',
		90_000,
	);
	assert.match(read1, /second-public/, 'the running machine never received the published file');

	// Close machine 2, as the split test does.
	await page
		.locator('.shell-frame', { has: page.locator('iframe[name="pane-2"]') })
		.locator('.frame-close')
		.click();
	await page.waitForSelector('iframe[name="pane-2"]', {
		state: 'detached',
		timeout: 5_000,
	});
});

test('micropython matches its reference: core modules in, CPython-only ones out', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The linux-vm skill's micropython section names names; this keeps it
	// honest against the interpreter actually in the image.
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	await frameType(
		page,
		frame,
		"micropython -c \"import sys,os,time,json,re,struct,socket,select,math,hashlib,binascii,errno,collections,io,array,heapq,random; print('MPY-CORE' + '-OK')\"",
	);
	const core = await frameUntil(frame, (t) => /MPY-CORE-OK|Error/.test(t), 'the core imports');
	assert.match(core, /MPY-CORE-OK/, `a documented module is missing:\n${core}`);

	// The micropython-lib add-ons under /usr/lib/micropython: the modules
	// the reference now promises (datetime above all — the recorded pain
	// point) must import, and datetime must actually compute.
	await frameType(
		page,
		frame,
		"micropython -c \"import datetime,pathlib,argparse,logging,shutil,fnmatch,functools,unittest; from os import path; print('MPY-LIB' + '-OK', datetime.date(2024,1,31).isoformat())\"",
	);
	const lib = await frameUntil(frame, (t) => /MPY-LIB-OK|Error/.test(t), 'the add-on imports');
	assert.match(lib, /MPY-LIB-OK 2024-01-31/, `a promised add-on is missing:\n${lib}`);

	await frameType(
		page,
		frame,
		"micropython -c 'import subprocess' 2>&1; micropython -c 'import multiprocessing' 2>&1; echo MPY-NEG-D''ONE",
	);
	const neg = await frameUntil(frame, (t) => /MPY-NEG-DONE/.test(t), 'the negative imports');
	const misses = neg.match(/no module named/g) ?? [];
	assert.ok(
		misses.length >= 2,
		`subprocess/multiprocessing should be absent (the reference says so):\n${neg}`,
	);
});

test('sqlite3, jq and make earn their bytes: CLI, tcc linkage, a Makefile', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// The sqlite3 CLI computes; jq filters; the split markers keep the
	// expected output out of the echoed command.
	await frameType(page, frame, `echo 'select 41+1;' | sqlite3 && echo SQL-CLI-D''ONE`);
	const sql = await frameUntil(frame, (t) => /SQL-CLI-DONE/.test(t), 'the sqlite3 CLI');
	assert.match(sql, /\n42/, `sqlite3 did not answer 42:\n${sql}`);

	await frameType(page, frame, `echo '{"answer":42}' | jq .answer && echo JQ-D''ONE`);
	const jq = await frameUntil(frame, (t) => /JQ-DONE/.test(t), 'the jq filter');
	assert.match(jq, /\n42/, `jq did not extract the field:\n${jq}`);

	// The point of shipping libsqlite3.so + sqlite3.h: tcc links it.
	await frameType(
		page,
		frame,
		`printf '#include <sqlite3.h>\\nint main(){return sqlite3_libversion()?0:1;}\\n' > /tmp/s.c && tcc /tmp/s.c -lsqlite3 -o /tmp/s && /tmp/s && echo SQL-TCC-D''ONE`,
	);
	await frameUntil(frame, (t) => /SQL-TCC-DONE/.test(t), 'the tcc -lsqlite3 build');

	// GNU make drives tcc: the busybox userland has no make of its own.
	await frameType(
		page,
		frame,
		`mkdir -p /tmp/mk && printf 'all:\\n\\t@echo MAKE-RUNS-''OK\\n' > /tmp/mk/Makefile && make -C /tmp/mk`,
	);
	await frameUntil(frame, (t) => /MAKE-RUNS-OK/.test(t), 'the make run');
});

test('the console starts in /data, like everything the model runs', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The typed line echoes `$(pwd)` unexpanded, so CWD=/data on screen can
	// only be the shell answering.
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	await frameType(page, frame, 'echo "CWD=$(pwd)"');
	const cwd = await frameUntil(frame, (t) => /CWD=\S+/.test(t), 'the pwd answer');
	assert.match(cwd, /CWD=\/data/, `the login shell does not start in /data:\n${cwd}`);
});

test('btmon decodes a btsnoop capture, no bluetoothd anywhere', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// A minimal btsnoop built from octal escapes, all fields big-endian: the
	// 16-byte header (magic, version 1, datalink 1002 = HCI UART) and one
	// 24-byte record header (orig/incl len 4, flags 2 = sent command, zero
	// drops, zero timestamp) holding the H4 bytes 01 03 0c 00 — an HCI
	// Reset command. btmon -r must name it.
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	// Redirected, not straight to the tty: on a terminal btmon opens a pager
	// whose screen would vanish again before the assertion reads it. The
	// split grep pattern types as itself, so the joined match can only be
	// btmon's decode.
	await frameType(
		page,
		frame,
		"printf 'btsnoop\\0\\0\\0\\0\\1\\0\\0\\3\\352\\0\\0\\0\\4\\0\\0\\0\\4\\0\\0\\0\\2\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\1\\3\\14\\0' > /tmp/t.btsnoop && btmon -r /tmp/t.btsnoop >/tmp/bt.out 2>&1; echo BTMON-RC=$?; grep 'HCI Comm''and' /tmp/bt.out",
	);
	const decoded = await frameUntil(frame, (t) => /BTMON-RC=\d/.test(t), 'the btmon run');
	assert.match(decoded, /BTMON-RC=0/, `btmon exited non-zero:\n${decoded}`);
	assert.match(decoded, /HCI Command: Reset/, `btmon did not decode the Reset command:\n${decoded}`);
});

test('assembly is first-class: nasm assembles, tcc links, strace watches', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// Intel syntax through nasm, linked by tcc against libc — the exact
	// workflow the reference documents. The message is split in the source
	// (db "ASM-SAY","S-42") so it can only appear joined at runtime.
	await frameType(
		page,
		frame,
		`printf 'global main\\nextern printf\\nsection .text\\nmain:\\npush msg\\ncall printf\\nadd esp,4\\nxor eax,eax\\nret\\nsection .data\\nmsg: db "ASM-SAY","S-42",10,0\\n' > /tmp/a.asm && nasm -f elf32 /tmp/a.asm -o /tmp/a.o && tcc /tmp/a.o -o /tmp/a && /tmp/a; echo ASM-RC=$?`,
	);
	const ran = await frameUntil(frame, (t) => /ASM-RC=\d/.test(t), 'the assembled run');
	assert.match(ran, /ASM-SAYS-42/, `the nasm+tcc pipeline did not run:\n${ran}`);

	// ndisasm reads machine code back: 31 C0 C3 is xor eax,eax / ret.
	await frameType(
		page,
		frame,
		"printf '\\x31\\xc0\\xc3' > /tmp/f.bin && ndisasm -b 32 /tmp/f.bin; echo NDIS-RC=$?",
	);
	const dis = await frameUntil(frame, (t) => /NDIS-RC=\d/.test(t), 'the disassembly');
	assert.match(dis, /xor eax,eax/, `ndisasm did not read the bytes back:\n${dis}`);

	// strace sees the syscall behind that printf — the debugger that works
	// over a non-interactive channel. musl's stdio flushes through writev,
	// not write, so trace and grep accept either; on failure the trace head
	// lands on screen for the assertion message.
	await frameType(
		page,
		frame,
		"strace -e trace=write,writev /tmp/a 2>/tmp/st.txt >/dev/null; grep -Eq 'write(v)?\\(1' /tmp/st.txt && echo STRACE-SEES-''WRITE || sed -n '1,4p' /tmp/st.txt; echo STRACE-D''ONE",
	);
	const traced = await frameUntil(frame, (t) => /STRACE-DONE/.test(t), 'the strace run');
	assert.match(traced, /STRACE-SEES-WRITE/, `strace did not record the write:\n${traced}`);
});

/** Whether the origin's /data mirror (IndexedDB vinx.vm, store `share`)
 * currently holds a key. Any same-origin frame can look. */
async function mirrorHasKey(frame, key) {
	return frame.evaluate(async (k) => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open('vinx.vm');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const hit = await new Promise((resolve) => {
			// A page that never wrote its mirror has not created the store.
			if (!db.objectStoreNames.contains('share')) return resolve(null);
			const get = db.transaction('share', 'readonly').objectStore('share').getKey(k);
			get.onsuccess = () => resolve(get.result ?? null);
			get.onerror = () => resolve(null);
		});
		db.close();
		return hit != null;
	}, key);
}

/** Wait out the 15 s sweep phase until a mirror key appears. */
async function waitMirrorKey(frame, key, what, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await mirrorHasKey(frame, key))) {
		if (Date.now() > deadline) throw new Error(`${what} never reached the mirror (${key})`);
		await new Promise((r) => setTimeout(r, 1_000));
	}
}

/** The text of a mirror key's bytes (values are raw ArrayBuffers), or null
 * when the key is absent. */
async function mirrorText(frame, key) {
	return frame.evaluate(async (k) => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open('vinx.vm');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const bytes = await new Promise((resolve) => {
			if (!db.objectStoreNames.contains('share')) return resolve(null);
			const get = db.transaction('share', 'readonly').objectStore('share').get(k);
			get.onsuccess = () => resolve(get.result ?? null);
			get.onerror = () => resolve(null);
		});
		db.close();
		return bytes == null ? null : new TextDecoder().decode(new Uint8Array(bytes));
	}, key);
}

/** Poll a mirror key's text until `ok(text)` holds (text is null while the
 * key is absent). */
async function mirrorTextBecomes(frame, key, ok, what, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const text = await mirrorText(frame, key);
		if (ok(text)) return text;
		if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms (${key} = ${JSON.stringify(text)})`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** Put text under a mirror key — a row the way an older page left it, for
 * the current one to find — or, text null, take the row away. Waits for the
 * page to have created the store (its first read of the mirror does),
 * rather than racing it. */
async function mirrorPut(frame, key, text, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const done = await frame.evaluate(
			async ([k, t]) => {
				const db = await new Promise((resolve, reject) => {
					const req = indexedDB.open('vinx.vm');
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				const ok = await new Promise((resolve) => {
					if (!db.objectStoreNames.contains('share')) return resolve(false);
					const tx = db.transaction('share', 'readwrite');
					if (t === null) tx.objectStore('share').delete(k);
					else tx.objectStore('share').put(new TextEncoder().encode(t).buffer, k);
					tx.oncomplete = () => resolve(true);
					tx.onerror = () => resolve(false);
				});
				db.close();
				return ok;
			},
			[key, text],
		);
		if (done) return;
		if (Date.now() > deadline) throw new Error(`the mirror store never appeared to take ${key}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

test('a /data file survives a reload through the IndexedDB mirror', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// There is no whole-machine snapshot: every load is a cold boot, and the
	// mirror is the machine's only archive. Leave a marker in /data, wait
	// for the 15 s sweep to mirror it (a fixed sleep would race the loop's
	// phase), reload, and the boot-time restore must bring it back.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	await frameType(page, frame, "echo kept > /data/mirror-probe.txt && echo MARK-''SET");
	await frameUntil(frame, (t) => /MARK-SET/.test(t), 'the marker write');
	await waitMirrorKey(frame, 'p1/mirror-probe.txt', 'the marker');

	await page.reload({ waitUntil: 'networkidle' });
	const warm = await paneFrame(page);
	await vmReady(warm);
	await frameUntil(warm, (t) => /#\s*$/.test(t), 'a prompt after reload');
	// The mirror restore runs just after 'ready' — poll rather than race it.
	await frameType(
		page,
		warm,
		"i=0; while [ $i -lt 30 ] && [ ! -f /data/mirror-probe.txt ]; do i=$((i+1)); sleep 1; done; cat /data/mirror-probe.txt; echo MARK-''READ",
	);
	const read = await frameUntil(warm, (t) => /MARK-READ/.test(t), 'the marker read', 60_000);
	assert.match(read, /kept/, `the /data marker did not survive the reload:\n${read}`);
});

test('a /data tree survives a reload: nested dirs, exec bits, excluded subtrees', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §15 Phase 4: the private mirror is recursive. Build a small tree with
	// a nested file and an executable script, plus files in the two subtrees
	// the mirror excludes by rule — host/ (synced with a real disk when
	// mounted) and .vinx/ (transport scratch). After a reload the tree and
	// the exec bit come back; the excluded files never even reach IndexedDB.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	await frameType(
		page,
		frame,
		'mkdir -p /data/proj/sub /data/host/hd && echo deep > /data/proj/sub/deep.txt && ' +
			"printf '#!/bin/sh\\necho ran-from-tree\\n' > /data/proj/tool.sh && chmod +x /data/proj/tool.sh && " +
			"echo no > /data/host/hd/skip.txt && echo no > /data/.vinx/keep-out.txt && echo TREE-''SET",
	);
	await frameUntil(frame, (t) => /TREE-SET/.test(t), 'the tree write');
	await waitMirrorKey(frame, 'p1/proj/sub/deep.txt', 'the nested file');
	await waitMirrorKey(frame, 'p1/proj/tool.sh', 'the nested script');

	// The sweep that mirrored the tree has run; the excluded files must not
	// be in it — by rule (§12.1), not because a glob missed them.
	assert.equal(
		await mirrorHasKey(frame, 'p1/host/hd/skip.txt'),
		false,
		'host/ leaked into the mirror',
	);
	assert.equal(
		await mirrorHasKey(frame, 'p1/.vinx/keep-out.txt'),
		false,
		'.vinx/ leaked into the mirror',
	);

	await page.reload({ waitUntil: 'networkidle' });
	const warm = await paneFrame(page);
	await vmReady(warm);
	await frameUntil(warm, (t) => /#\s*$/.test(t), 'a prompt after reload');
	await frameType(
		page,
		warm,
		'i=0; while [ $i -lt 30 ] && [ ! -f /data/proj/sub/deep.txt ]; do i=$((i+1)); sleep 1; done; ' +
			"cat /data/proj/sub/deep.txt; /data/proj/tool.sh; echo TREE-''READ",
	);
	const read = await frameUntil(warm, (t) => /TREE-READ/.test(t), 'the tree read-back', 60_000);
	assert.match(read, /deep/, `the nested file did not survive the reload:\n${read}`);
	assert.match(read, /ran-from-tree/, `the exec bit did not survive the reload:\n${read}`);
});

test('the 9p write doorbell mirrors fresh files well before the 15 s sweep', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §12.1: 9p-write-end optimises guest→page discovery. Each write should
	// reach the mirror in doorbell time (~2 s debounce + a snapshot), not
	// sweep time (up to 15 s). Three rounds in sequence: one fast round
	// could ride a lucky sweep phase, three in a row could not.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	for (let round = 1; round <= 3; round++) {
		await frameType(page, frame, `echo ding-${round} > /data/bell-${round}.txt && echo BELL-${round}-''SET`);
		await frameUntil(frame, (t) => new RegExp(`BELL-${round}-SET`).test(t), `the round ${round} write`);
		const started = Date.now();
		await waitMirrorKey(frame, `p1/bell-${round}.txt`, `the round ${round} bell`, 10_000);
		const tookMs = Date.now() - started;
		assert.ok(tookMs < 8_000, `round ${round} took ${tookMs}ms — doorbell time, not sweep time`);
	}
});

test('an app becomes a service: scaffold, check, pack, install, supervise, survive, autostart', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §15 Phase 4's acceptance loop, end to end at the console: app(1)
	// scaffolds a service, check --json speaks the stable error shape,
	// pack/install land a validated .vapp in /data/apps, rund supervises
	// it (log, pid, stop kills the group), the service survives an rpcd
	// death (a page reload must not take a pure-Linux service down), and
	// an enabled service autostarts after a reboot because the recursive
	// mirror carried /data/apps across it.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// Scaffold, then a deliberate break: check --json must name the missing
	// entry with the stable {code,path} shape a model can act on (§13.2).
	await frameType(page, frame, "app new e2e-svc --service && echo NEW-''OK");
	await frameUntil(frame, (t) => /NEW-OK/.test(t), 'the scaffold', 30_000);
	await frameType(
		page,
		frame,
		'mv /data/work/e2e-svc/run /tmp/run.bak; ' +
			"app check /data/work/e2e-svc --json | jq -r '.errors[0].code'; " +
			"mv /tmp/run.bak /data/work/e2e-svc/run; echo CHECK-NEG-''DONE",
	);
	const neg = await frameUntil(frame, (t) => /CHECK-NEG-DONE/.test(t), 'the negative check');
	assert.match(neg, /ENTRY_NOT_FOUND/, `check --json did not name the missing entry:\n${neg}`);
	await frameType(
		page,
		frame,
		"app check /data/work/e2e-svc --json | jq -r '.ok'; echo CHECK-''DONE",
	);
	const ok = await frameUntil(frame, (t) => /CHECK-DONE/.test(t), 'the passing check');
	assert.match(ok, /true/, `the scaffold does not pass its own check:\n${ok}`);

	// Pack, install, start; the log proves it runs, the pid file is the
	// observation surface (§9.3).
	await frameType(page, frame, "app pack /data/work/e2e-svc && echo PACK-''OK");
	await frameUntil(frame, (t) => /PACK-OK/.test(t), 'the pack', 30_000);
	await frameType(page, frame, "app install /data/work/e2e-svc.vapp && echo INSTALL-''OK");
	await frameUntil(frame, (t) => /INSTALL-OK/.test(t), 'the install', 30_000);
	await frameType(page, frame, "app start e2e-svc && echo START-''OK");
	const started = await frameUntil(frame, (t) => /START-OK/.test(t), 'the start', 30_000);
	assert.match(started, /e2e-svc running \(pid \d+/, `start did not report a pid:\n${started}`);
	await frameType(
		page,
		frame,
		"sleep 6; app log e2e-svc | head -2; cat /run/vinx/apps/e2e-svc/pid; echo LOG-''SEEN",
	);
	const logged = await frameUntil(frame, (t) => /LOG-SEEN/.test(t), 'the log read', 30_000);
	assert.match(logged, /alive at/, `the service log is empty:\n${logged}`);
	const pid0 = (logged.match(/\n(\d+)\s*\n?LOG-SEEN/) ?? [])[1];
	assert.ok(pid0, `no pid on the observation surface:\n${logged}`);

	// Shoot rpcd from the console: the control plane dies and re-hellos,
	// the service must not notice (§9.3 — the deliberate exception to
	// "losing the socket kills the jobs").
	await frameType(page, frame, `kill -9 $(cat /run/vinx/rpcd.pid) && echo KILLED-''RPCD`);
	await frameUntil(frame, (t) => /KILLED-RPCD/.test(t), 'the rpcd kill', 15_000);
	await procReady(frame);
	await frameType(
		page,
		frame,
		`cat /run/vinx/apps/e2e-svc/pid; app status e2e-svc; echo SURVIVE-''CHECKED`,
	);
	const survived = await frameUntil(frame, (t) => /SURVIVE-CHECKED/.test(t), 'the survival check', 30_000);
	assert.ok(
		new RegExp(`\\b${pid0}\\b`).test(survived),
		`the service died with rpcd (pid ${pid0} gone):\n${survived}`,
	);
	assert.match(survived, /e2e-svc is running/, `status disagrees after the rpcd respawn:\n${survived}`);

	// Stop kills the whole group; the state file says so.
	await frameType(
		page,
		frame,
		`app stop e2e-svc; sleep 1; kill -0 ${pid0} 2>/dev/null && echo STILL-ALIVE || echo GROUP-DEAD; ` +
			"cat /run/vinx/apps/e2e-svc/state; echo STOP-''CHECKED",
	);
	const stopped = await frameUntil(frame, (t) => /STOP-CHECKED/.test(t), 'the stop check', 30_000);
	assert.match(stopped, /GROUP-DEAD/, `the group outlived app stop:\n${stopped}`);
	assert.match(stopped, /\bstopped\b/, `the state file disagrees:\n${stopped}`);

	// Enable, let the recursive mirror carry /data/apps, reboot the machine
	// (a page reload), and the sweep must bring the service back on its own.
	await frameType(page, frame, "app enable e2e-svc && echo ENABLE-''OK");
	await frameUntil(frame, (t) => /ENABLE-OK/.test(t), 'the enable', 15_000);
	await waitMirrorKey(frame, 'p1/apps/e2e-svc.vapp', 'the installed package');
	await waitMirrorKey(frame, 'p1/apps/enabled', 'the enable list');

	await page.reload({ waitUntil: 'networkidle' });
	const warm = await paneFrame(page);
	await vmReady(warm);
	await procReady(warm);
	await frameUntil(warm, (t) => /#\s*$/.test(t), 'a prompt after reboot');
	await frameType(
		page,
		warm,
		'i=0; while [ $i -lt 45 ] && [ "$(cat /run/vinx/apps/e2e-svc/state 2>/dev/null)" != running ]; do i=$((i+1)); sleep 1; done; ' +
			"app status e2e-svc; echo AUTO-''CHECKED",
	);
	const auto = await frameUntil(warm, (t) => /AUTO-CHECKED/.test(t), 'the autostart check', 90_000);
	assert.match(auto, /e2e-svc is running/, `the enabled service did not autostart:\n${auto}`);

	// Leave the machine clean: the next boot of this suite profile must not
	// resurrect the service.
	await frameType(
		page,
		warm,
		"app remove e2e-svc; rm -rf /data/work/e2e-svc /data/work/e2e-svc.vapp; echo CLEAN-''DONE",
	);
	await frameUntil(warm, (t) => /CLEAN-DONE/.test(t), 'the cleanup', 30_000);
});

test('an app’s second install runs, a command app finishes, a removed app frees its slot', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Three truths the service test above never asked, each found by
	// driving the lifecycle the way an agent does. Through the run_shell
	// adapter (vinxRpc.run): the words are the guest's own, no screen
	// scraping.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	const sh = async (command, timeoutS = 60) => {
		const r = await frame.evaluate(([c, t]) => window.vinxRpc.run(c, t), [command, timeoutS]);
		return r.output ?? '';
	};
	const clean = () =>
		sh(
			'for a in e2e-re e2e-cmd e2e-q1 e2e-q2 e2e-q3 e2e-q4 e2e-q5 e2e-q6 e2e-q7 e2e-q8 e2e-q9; do app remove $a >/dev/null 2>&1; done; ' +
				'rm -rf /data/work/e2e-re* /data/work/e2e-cmd* /data/work/e2e-q*; echo CLEAN',
			90,
		);
	await clean();
	try {
		// 1. Edit, pack, install, run — the §13 loop, twice in one boot. The
		//    unpacked tree used to be "once per boot": the second install
		//    landed in /data/apps and the machine kept running the first.
		const v1 = await sh(
			"app new e2e-re --command >/dev/null && printf '#!/bin/sh\\necho VERSION-ONE\\n' > /data/work/e2e-re/run && " +
				'app pack /data/work/e2e-re >/dev/null && app install /data/work/e2e-re.vapp >/dev/null && app run e2e-re',
		);
		assert.match(v1, /VERSION-ONE/, `the first version did not run:\n${v1}`);
		const v2 = await sh(
			"printf '#!/bin/sh\\necho VERSION-TWO\\n' > /data/work/e2e-re/run && " +
				'app pack /data/work/e2e-re >/dev/null && app install /data/work/e2e-re.vapp >/dev/null && app run e2e-re',
		);
		assert.match(v2, /VERSION-TWO/, `a re-installed app still ran the old version:\n${v2}`);
		assert.doesNotMatch(v2, /VERSION-ONE/, `the stale tree answered:\n${v2}`);
		// The supervised path picks the same version up: start/stop, and the
		// log (rund's, stdout of the run) says which one ran.
		const viaStart = await sh(
			'app start e2e-re >/dev/null; sleep 1; app log e2e-re | grep -c VERSION-TWO; app log e2e-re | grep -c VERSION-ONE',
		);
		assert.match(viaStart, /^1\s*\n0/m, `app start ran a version other than the installed one:\n${viaStart}`);

		// 2. A command app finishes; it is not a crashed service. Started
		//    through rund (what the Apps page's play button does) its exit
		//    is completion: state `stopped`, exit 0 on record, nothing
		//    restarted — enabled, it runs once per boot, not once per tick.
		const cmd = await sh(
			'app new e2e-cmd --command >/dev/null && app pack /data/work/e2e-cmd >/dev/null && app install /data/work/e2e-cmd.vapp >/dev/null && ' +
				'cat /data/apps/e2e-cmd.kind; app start e2e-cmd >/dev/null; sleep 2; ' +
				'echo "state=$(cat /run/vinx/apps/e2e-cmd/state) exit=$(cat /run/vinx/apps/e2e-cmd/exit)"; app status e2e-cmd; app list --json',
		);
		assert.match(cmd, /^command$/m, `install did not record the kind sidecar:\n${cmd}`);
		assert.match(cmd, /state=stopped exit=0/, `a finished command app is not "stopped":\n${cmd}`);
		assert.doesNotMatch(cmd, /restart\(s\)|crashed|failed/, `a finished command app counted as a crash:\n${cmd}`);
		assert.match(cmd, /"id":"e2e-cmd","state":"stopped","enabled":false,"size":\d+,"kind":"command"/, `app.list does not carry the kind from the sidecar:\n${cmd}`);
		const enabled = await sh(
			'app enable e2e-cmd; sleep 12; echo "runs=$(grep -c hello /run/vinx/apps/e2e-cmd/log)"; app status e2e-cmd; app disable e2e-cmd >/dev/null',
			60,
		);
		assert.match(enabled, /runs once on every boot/, `enable did not speak the command kind's truth:\n${enabled}`);
		assert.match(enabled, /runs=1\b/, `an enabled command app was re-run by the sweep:\n${enabled}`);

		// 3. rund manages eight services at a time; a removed app must give
		//    its slot back, or eight discarded demos refuse the ninth until
		//    a reboot. Nine ids, each installed, started, removed in turn —
		//    then the ninth must start.
		const slots = await sh(
			'ok=0; for i in 1 2 3 4 5 6 7 8 9; do ' +
				'app new e2e-q$i --service >/dev/null && app pack /data/work/e2e-q$i >/dev/null && app install /data/work/e2e-q$i.vapp >/dev/null && ' +
				'app start e2e-q$i >/dev/null 2>&1 && ok=$((ok+1)); app remove e2e-q$i >/dev/null 2>&1; sleep 6; done; echo "started=$ok"',
			180,
		);
		assert.match(slots, /started=9/, `slots of removed apps were not recycled:\n${slots}`);
	} finally {
		await clean();
	}
});

test('a pure web app opens a sandboxed window: bundle, bridge, CSP, close', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §10.3 end to end: the shell ships beside the page and carries its CSP
	// in a <meta> (the default deploy — one static directory), the bundle
	// renders inside a sandboxed frame that is an opaque origin even on the
	// desktop's own host, the app's only system surface is the allowlisted
	// MessagePort bridge, and the title-bar close unmounts it all.
	const shellRes = await page.request.get(APP_FRAME_URL);
	assert.equal(shellRes.status(), 200, `the shell is not served at ${APP_FRAME_URL}`);
	assert.match(
		await shellRes.text(),
		/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"/,
		'the shell lost its meta CSP',
	);
	assert.equal(
		new URL(APP_FRAME_URL).origin,
		new URL(APP_URL).origin,
		`the default shell should ride the desktop's origin: ${APP_FRAME_URL} vs ${APP_URL}`,
	);

	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frameType(page, frame, "app new webby --web && app check /data/work/webby --json | jq -r '.ok'; echo NEW-''DONE");
	const scaffolded = await frameUntil(frame, (t) => /NEW-DONE/.test(t), 'the web scaffold', 30_000);
	assert.match(scaffolded, /true/, `the web template fails its own check:\n${scaffolded}`);
	await frameType(
		page,
		frame,
		"app pack /data/work/webby && app install /data/work/webby.vapp && app run webby && echo RUN-''DONE",
	);
	const ran = await frameUntil(frame, (t) => /RUN-DONE/.test(t), 'the web app run', 45_000);
	assert.match(ran, /window webby is up/, `app-run never reported the window:\n${ran}`);

	// The window is on the pane, titled by app id, its tenant a sandboxed
	// frame on the shell.
	await frame.waitForSelector('iframe.app-frame', { timeout: 15_000 });
	const titles = await frame.$$eval('.vga-title-text', (els) => els.map((e) => e.textContent));
	assert.ok(titles.includes('webby'), `no window titled webby: ${JSON.stringify(titles)}`);
	const appFrame = page.frames().find((f) => f.url().startsWith(APP_FRAME_URL));
	assert.ok(appFrame, 'the app frame never attached');

	// The bundle's three parts all landed: html (the button), js (rewrote
	// the title), css (rides the same style tag — presence is enough).
	await appFrame.waitForSelector('#ping', { timeout: 15_000 });
	const h1 = await appFrame.textContent('#title');
	assert.match(h1 ?? '', /hello from/, `app.js never ran in the frame: "${h1}"`);

	// CSP: the frame cannot fetch even the desktop's own origin — which is
	// also the shell's.
	const fetched = await appFrame.evaluate(
		(url) => fetch(url).then(() => 'fetched', (e) => `blocked: ${e.name}`),
		APP_URL,
	);
	assert.match(fetched, /^blocked/, `the shell CSP let a fetch through: ${fetched}`);
	// ...nor load an image or a child frame from it; the policy reports
	// each refusal to the document.
	const violated = await appFrame.evaluate(
		(url) =>
			new Promise((resolve) => {
				const seen = [];
				document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
				const img = document.createElement('img');
				img.src = `${url}vm/seabios.bin`;
				document.body.appendChild(img);
				const child = document.createElement('iframe');
				child.src = url;
				document.body.appendChild(child);
				setTimeout(() => resolve(seen.sort().join(',')), 1500);
			}),
		APP_URL,
	);
	assert.match(violated, /img-src/, `the shell CSP let an image through: "${violated}"`);
	assert.match(violated, /frame-src/, `the shell CSP let a child frame through: "${violated}"`);
	// Sandbox: no popups, and — served from the desktop's own host — still
	// an opaque origin: no reach into the desktop's DOM, and its
	// localStorage is the shell's in-memory stand-in, not the desktop's.
	const escaped = await appFrame.evaluate(() => {
		const out = { open: String(window.open('about:blank')), parent: 'reached' };
		try {
			void parent.document.title;
		} catch (e) {
			out.parent = `blocked: ${e.name}`;
		}
		localStorage.setItem('vinx-e2e-leak', 'from the app');
		return out;
	});
	assert.equal(escaped.open, 'null', 'the sandbox let window.open through');
	assert.match(escaped.parent, /^blocked: SecurityError/, `the frame reached the desktop's DOM: ${escaped.parent}`);
	assert.equal(
		await page.evaluate(() => localStorage.getItem('vinx-e2e-leak')),
		null,
		"the app's localStorage write landed in the desktop's storage",
	);

	// The bridge: the app's notify.show lands as the desktop's toast,
	// attributed to the app.
	await appFrame.click('#ping');
	await frame.waitForFunction(
		() => document.querySelector('.drop-note')?.textContent?.includes('[webby]'),
		null,
		{ timeout: 15_000 },
	);

	// window.list sees it from the guest (rpc(1) — the direction the
	// method exists for; the desktop asking itself never crosses rpcd).
	await frameType(page, frame, `rpc call window.list '{}' | jq -r '.windows[].id'; echo LIST-''DONE`);
	const listed = await frameUntil(frame, (t) => /LIST-DONE/.test(t), 'the window list', 20_000);
	assert.match(listed, /\bwebby\b/, `window.list lost the app window:\n${listed}`);
	await frame
		.locator('.vga-window', { has: frame.locator('.vga-title-text', { hasText: 'webby' }) })
		.locator('.vga-btn[title*="Close"]')
		.click();
	await frame.waitForSelector('iframe.app-frame', { state: 'detached', timeout: 10_000 });

	await frameType(page, frame, "app remove webby; rm -rf /data/work/webby /data/work/webby.vapp; echo CLEAN-''DONE");
	await frameUntil(frame, (t) => /CLEAN-DONE/.test(t), 'the cleanup', 30_000);
});

test('a hybrid app fronts a service: closing the window stops the backend', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §15 Phase 5's close semantics: the window and the process are one
	// app. app start supervises the backend (rund) and app-run raises the
	// window on the way in; the title-bar close tears the port off and
	// stops the backend through app.stop — manual-stop, so the sweep does
	// not resurrect what the person dismissed.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frameType(
		page,
		frame,
		'app new hybby --service && cd /data/work/hybby && ' +
			`printf '{"schema":0,"kind":"window","exec":"./run","ui":{"type":"web"}}' > app.json && ` +
			"printf '<p id=\"ui\">hybrid ui</p>' > index.html && cd /data && " +
			"app check /data/work/hybby --json | jq -r '.ok'; echo HY-NEW-''DONE",
	);
	const made = await frameUntil(frame, (t) => /HY-NEW-DONE/.test(t), 'the hybrid scaffold', 30_000);
	assert.match(made, /true/, `the hybrid manifest fails its check:\n${made}`);
	await frameType(
		page,
		frame,
		"app pack /data/work/hybby && app install /data/work/hybby.vapp && app start hybby && echo HY-START-''DONE",
	);
	const started = await frameUntil(frame, (t) => /HY-START-DONE/.test(t), 'the hybrid start', 45_000);
	assert.match(started, /hybby running \(pid \d+/, `the backend never started:\n${started}`);

	// Both halves are up: the window on the pane, the service in rund.
	await frame.waitForSelector('iframe.app-frame', { timeout: 15_000 });
	await frameType(page, frame, "cat /run/vinx/apps/hybby/pid; echo HY-PID-''SEEN");
	const pidText = await frameUntil(frame, (t) => /HY-PID-SEEN/.test(t), 'the backend pid', 15_000);
	const pid = (pidText.match(/\n(\d+)\s*\n?HY-PID-SEEN/) ?? [])[1];
	assert.ok(pid, `no pid on the observation surface:\n${pidText}`);

	// Close the window; the backend must die with it.
	await frame
		.locator('.vga-window', { has: frame.locator('.vga-title-text', { hasText: 'hybby' }) })
		.locator('.vga-btn[title*="Close"]')
		.click();
	await frame.waitForSelector('iframe.app-frame', { state: 'detached', timeout: 10_000 });
	await frameType(
		page,
		frame,
		'i=0; while [ $i -lt 20 ] && [ "$(cat /run/vinx/apps/hybby/state 2>/dev/null)" != stopped ]; do i=$((i+1)); sleep 1; done; ' +
			`cat /run/vinx/apps/hybby/state; kill -0 ${pid} 2>/dev/null && echo STILL-ALIVE || echo BACKEND-DEAD; echo HY-STOP-''CHECKED`,
	);
	const stopped = await frameUntil(frame, (t) => /HY-STOP-CHECKED/.test(t), 'the close-stop check', 45_000);
	assert.match(stopped, /\bstopped\b/, `the state file disagrees after the close:\n${stopped}`);
	assert.match(stopped, /BACKEND-DEAD/, `the backend outlived its window:\n${stopped}`);

	await frameType(page, frame, "app remove hybby; rm -rf /data/work/hybby /data/work/hybby.vapp; echo HY-CLEAN-''DONE");
	await frameUntil(frame, (t) => /HY-CLEAN-DONE/.test(t), 'the cleanup', 30_000);
});

/** Read a tty window's xterm buffer (canvas renderer: the DOM says
 * nothing) through the page's test registry, by app id. */
function ttyWindowText(frame, app) {
	return frame.evaluate((id) => {
		const t = window.__vinxTtyTerms?.get(id);
		if (!t) return null;
		const buf = t.buffer.active;
		const rows = [];
		for (let i = 0; i < buf.length; i++) rows.push(buf.getLine(i)?.translateToString(true) ?? '');
		return rows.join('\n').replace(/\n+$/, '');
	}, app);
}

async function ttyWindowUntil(frame, app, matches, what, timeout = 60_000) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const text = await ttyWindowText(frame, app);
		if (text !== null && matches(text)) return text;
		if (Date.now() > deadline)
			throw new Error(`the ${app} tty window never showed ${what}:\n${text ?? '(no window)'}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

test('a tty app runs in a terminal window: PTY end to end, close stops the app', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §6.9's whole story in one pass: app new --tty scaffolds a termbox2
	// program that compiles in the machine (tcc), app.start {pty} spawns
	// it on a PTY (openpty/login_tty), rpcd pumps the master over the
	// ttyS1 mux, the desktop opens an xterm window over the channel —
	// then a page keystroke rides page→guest and the app's redraw rides
	// guest→page, which only the whole loop working can explain. The
	// title-bar close stops the app (app.stop), and the dying PTY closes
	// the stream.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frameType(
		page,
		frame,
		"app new ptt --tty && app check /data/work/ptt --json | jq -r '.ok'; echo PTT-NEW-''DONE",
	);
	const made = await frameUntil(frame, (t) => /PTT-NEW-DONE/.test(t), 'the tty scaffold', 30_000);
	assert.match(made, /true/, `the --tty template fails its own check:\n${made}`);

	await frameType(
		page,
		frame,
		"app pack /data/work/ptt && app install /data/work/ptt.vapp && app start ptt && echo PTT-START-''DONE",
	);
	const started = await frameUntil(frame, (t) => /PTT-START-DONE/.test(t), 'the tty start', 45_000);
	assert.match(started, /ptt running \(pid \d+/, `the app never started:\n${started}`);

	// The terminal window: DesktopWindow chrome titled ptt, xterm inside.
	await frame.waitForSelector('.tty-term', { timeout: 20_000 });
	// tcc compiles main.c inside ./run before the UI paints; wait for the
	// template's frame to arrive through the mux (guest→page proven).
	await ttyWindowUntil(frame, 'ptt', (t) => /tty app/.test(t) && /q quits/.test(t), 'the termbox UI', 60_000);

	// One keystroke down the channel (page→guest); the app redraws with
	// its count (guest→page, again). U+0078 is the x we typed.
	await frame.click('.tty-term');
	await page.keyboard.type('x');
	await ttyWindowUntil(frame, 'ptt', (t) => /1 so far/.test(t) && /U\+0078/.test(t), 'the keystroke count', 20_000);

	// Close the window: the backend stops (manual-stop), the stream dies,
	// the window is already gone.
	await frame
		.locator('.vga-window', { has: frame.locator('.vga-title-text', { hasText: 'ptt' }) })
		.locator('.vga-btn[title*="Close"]')
		.click();
	await frame.waitForSelector('.tty-term', { state: 'detached', timeout: 10_000 });
	await frameType(
		page,
		frame,
		'i=0; while [ $i -lt 20 ] && [ "$(cat /run/vinx/apps/ptt/state 2>/dev/null)" != stopped ]; do i=$((i+1)); sleep 1; done; ' +
			"cat /run/vinx/apps/ptt/state; echo PTT-STOP-''CHECKED",
	);
	const stopped = await frameUntil(frame, (t) => /PTT-STOP-CHECKED/.test(t), 'the close-stop check', 45_000);
	assert.match(stopped, /\bstopped\b/, `closing the window did not stop the app:\n${stopped}`);

	await frameType(page, frame, "app remove ptt; rm -rf /data/work/ptt /data/work/ptt.vapp; echo PTT-CLEAN-''DONE");
	await frameUntil(frame, (t) => /PTT-CLEAN-DONE/.test(t), 'the cleanup', 30_000);
});

test('a PTY firehose does not clog the control plane', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §6.9's isolation goal, measured: a tty app spraying output saturates
	// the ttyS1 mux (bounded by rpcd's backpressure, not by memory), and a
	// control call on ttyS3 still answers promptly — two lanes, two fates.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frameType(
		page,
		frame,
		'mkdir -p /data/work/flood && cd /data/work/flood && ' +
			`printf '{"schema":0,"kind":"window","ui":{"type":"tty"},"exec":"./run"}' > app.json && ` +
			"printf '#!/bin/sh\\nexec yes FLOOD-0123456789abcdefghijklmnopqrstuvwxyz' > run && chmod +x run && cd /data && " +
			"app pack /data/work/flood && app install /data/work/flood.vapp && app start flood && echo FLOOD-''UP",
	);
	const up = await frameUntil(frame, (t) => /FLOOD-UP/.test(t), 'the flood app', 45_000);
	assert.match(up, /flood running/, `the flood app never started:\n${up}`);
	await frame.waitForSelector('.tty-term', { timeout: 20_000 });

	// The lane is genuinely moving: two mux snapshots a second apart.
	const before = await frame.evaluate(() => window.vinxRpc.mux());
	await page.waitForTimeout(1_000);
	const after = await frame.evaluate(() => window.vinxRpc.mux());
	assert.ok(
		(after.framesIn ?? 0) > (before.framesIn ?? 0),
		`the firehose is not flowing over the mux: ${JSON.stringify({ before, after })}`,
	);

	// Now the control plane, mid-firehose: an answer in seconds, not a
	// deadline. (The 15 s ceiling is the assertion; a clogged lane would
	// ride the 30 s default deadline into failure.)
	const t0 = Date.now();
	const alive = await frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'echo control-plane-alive' }, 15_000),
	);
	const elapsed = Date.now() - t0;
	assert.ok(alive.ok, `the control call failed under mux load: ${JSON.stringify(alive)}`);
	assert.match(String(alive.result?.stdout ?? ''), /control-plane-alive/, 'the answer is not the answer');
	assert.ok(elapsed < 15_000, `the control call took ${elapsed} ms under mux load`);

	await frameType(page, frame, "app stop flood && app remove flood; rm -rf /data/work/flood /data/work/flood.vapp; echo FLOOD-''CLEAN");
	await frameUntil(frame, (t) => /FLOOD-CLEAN/.test(t), 'the flood cleanup', 45_000);
	await frame.waitForSelector('.tty-term', { state: 'detached', timeout: 10_000 });
});

test('one framebuffer program at a time: the lock, the crash release, the stty restore', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// fb-run's three promises (§10.5): a second FB program is refused by
	// name while the first holds the lock; kill -9 releases the lock with
	// the fd (nothing to clean up); and the terminal's termios come back
	// whatever the program did to them.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// The termios baseline, before anything touches the console.
	await frameType(page, frame, "stty -g > /tmp/tty0.base; echo BASE-''SAVED");
	await frameUntil(frame, (t) => /BASE-SAVED/.test(t), 'the stty baseline', 15_000);

	// lvdemo holds the framebuffer (tcc compile happens outside the lock).
	await frameType(page, frame, 'lvdemo &');
	try {
		await frameUntil(frame, (t) => /lvdemo: ready/.test(t), 'lvdemo up', 120_000);

		// A second FB program: an explicit refusal, not a fight over fb0.
		await frameType(page, frame, "fbdemo; echo FB-RC=''$?");
		const busy = await frameUntil(frame, (t) => /FB-RC=\d+/.test(t), 'the busy refusal', 30_000);
		assert.match(busy, /fb-run: the framebuffer is busy/, `no busy message:\n${busy}`);
		assert.match(busy, /FB-RC=75/, `the refusal must exit 75 (EX_TEMPFAIL):\n${busy}`);

		// kill -9 the holder: the lock dies with the fd, no cleanup owed.
		await frameType(page, frame, "kill -9 %1 2>/dev/null; sleep 1; fbdemo; echo FB2-RC=''$?");
		const freed = await frameUntil(frame, (t) => /FB2-RC=\d+/.test(t), 'the post-kill run', 60_000);
		assert.match(freed, /fbdemo: painted \d+x\d+/, `the lock did not release after kill -9:\n${freed}`);
		assert.match(freed, /FB2-RC=0/, `fbdemo failed after the release:\n${freed}`);
	} finally {
		await frame.click('.screen .xterm-screen', { position: { x: 5, y: 5 }, force: true }).catch(() => {});
		await frameType(page, frame, 'kill -9 %1 2>/dev/null; true').catch(() => {});
		// lvdemo's window.focus popped the screen panel; put it away.
		await frame
			.evaluate(() => {
				const panel = document.querySelector('.vga-panel');
				if (panel) document.querySelector('.screen-chip')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			})
			.catch(() => {});
	}

	// The restore promise, pinned directly: a program that wrecks its
	// termios and exits cleanly must leave the console as it found it.
	await frameType(page, frame, "fb-run sh -c 'stty raw -echo; true'; stty -g > /tmp/tty0.after; cmp -s /tmp/tty0.base /tmp/tty0.after && echo STTY-''SAME || echo STTY-''DIFF");
	const restored = await frameUntil(frame, (t) => /STTY-(SAME|DIFF)/.test(t), 'the stty comparison', 30_000);
	assert.match(restored, /STTY-SAME/, `fb-run did not restore the terminal:\n${restored}`);
});

test('drag and long-press over the panel arrive as held PS/2 buttons', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The DesktopWindow gestures (drag chrome, raise on pointerdown) and
	// the PS/2 forwarding share the same pointer — this pins that a hold
	// over the *panel* stays a hold on the wire: bit0 of every packet
	// while the button is down, a clean 0 after release. Independent of
	// LVGL: /dev/input/mice bytes are the whole assertion.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frame.click('.screen-chip');
	const canvas = await frame.waitForSelector('.vga-panel canvas', { timeout: 10_000 });

	// The checker first (no time pressure), then the capture. The PS/2
	// stream is 3-byte packets; bit3 of byte 0 is always set, which picks
	// the packet alignment, and bit0 is the left button. The verdict wants
	// a run of 5+ held packets (the drag) followed by a release packet.
	await frameType(
		page,
		frame,
		"printf 'b=open(\"/tmp/mice.bin\",\"rb\").read()\\n" +
			'best=(-1,[])\\n' +
			'for off in range(3):\\n' +
			' pk=[b[i:i+3] for i in range(off,len(b)-2,3)]\\n' +
			' score=sum(1 for p in pk if p[0]&8)\\n' +
			' if score>best[0]: best=(score,pk)\\n' +
			'bits=[p[0]&1 for p in best[1]]\\n' +
			'ok=False\\n' +
			'run=0\\n' +
			'for x in bits:\\n' +
			' if x: run+=1\\n' +
			' else:\\n' +
			'  if run>=5: ok=True\\n' +
			'  run=0\\n' +
			'print(\"MICE-HELD-OK\" if ok else \"MICE-HELD-BAD \"+\"\".join(str(x) for x in bits))\\n' +
			"' > /tmp/chk.py; echo CHK-''READY",
	);
	await frameUntil(frame, (t) => /CHK-READY/.test(t), 'the checker script', 15_000);

	await frameType(page, frame, "(timeout 8 cat /dev/input/mice > /tmp/mice.bin; echo CAP-''DONE) &");
	await page.waitForTimeout(500);

	// Park off-panel, then: press, drag in steps, hold still, release,
	// and a tail move after release (bit0 must be 0 there).
	const box = await canvas.boundingBox();
	await page.mouse.move(box.x + 30, box.y + 30);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
	await page.waitForTimeout(800); // the long press: held, not moving
	await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
	await page.mouse.up();
	await page.mouse.move(box.x + 40, box.y + 40, { steps: 4 });

	await frameUntil(frame, (t) => /CAP-DONE/.test(t), 'the capture end', 20_000);
	await frameType(page, frame, 'micropython /tmp/chk.py');
	const verdict = await frameUntil(frame, (t) => /MICE-HELD-(OK|BAD)/.test(t), 'the packet verdict', 20_000);
	assert.match(verdict, /MICE-HELD-OK/, `no held-button run in the PS/2 stream:\n${verdict}`);

	await frame.click('.screen-chip').catch(() => {});
	await frame.waitForSelector('.vga-panel', { state: 'detached', timeout: 10_000 }).catch(() => {});
});

test('a killed backend tells everyone: the event, the annotated window, the honest status', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The §6.7 event stream with real callers on both ends: rund emits
	// app.exited when the backend dies (kill -9, exit 137), the page —
	// a subscriber since hello — annotates the window title; and when the
	// person closes that window, the page emits window.closed, which a
	// console `rpc watch` (the other subscriber) prints. Status stays
	// honest throughout: rund's files say crashed, app status agrees the
	// app is not running.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frameType(
		page,
		frame,
		'app new evy --service && cd /data/work/evy && ' +
			`printf '{"schema":0,"kind":"window","exec":"./run","ui":{"type":"web"}}' > app.json && ` +
			"printf '<p>event ui</p>' > index.html && cd /data && " +
			"app pack /data/work/evy && app install /data/work/evy.vapp && echo EV-''INSTALLED",
	);
	await frameUntil(frame, (t) => /EV-INSTALLED/.test(t), 'the app install', 45_000);

	// The console-side subscriber, before anything happens (a plain
	// background job: the cleanup kills %1).
	await frameType(page, frame, "rpc watch window app > /tmp/wev.log 2>&1 & sleep 1; echo WATCH-''UP");
	await frameUntil(frame, (t) => /WATCH-UP/.test(t), 'the watcher', 15_000);

	await frameType(page, frame, "app start evy && cat /run/vinx/apps/evy/pid; echo EV-''STARTED");
	const started = await frameUntil(frame, (t) => /EV-STARTED/.test(t), 'the start', 45_000);
	const pid = (started.match(/\n(\d+)\s*\n?EV-STARTED/) ?? [])[1];
	assert.ok(pid, `no pid after start:\n${started}`);
	await frame.waitForSelector('iframe.app-frame', { timeout: 15_000 });

	// Kill the backend behind rund's back; 137 is the truth to spread.
	await frameType(page, frame, `kill -9 ${pid}; echo EV-''KILLED`);
	await frameUntil(frame, (t) => /EV-KILLED/.test(t), 'the kill', 15_000);

	// The page heard app.exited: the window title says so, the window stays.
	await frame.waitForSelector('.vga-title-text:has-text("evy (exited 137)")', { timeout: 20_000 });

	// Status is honest: the state file says crashed (backoff ledger), and
	// app status agrees the app is not running. (The screen still shows
	// the *historical* "evy running" from the start — anchor on the
	// current answer's own shape, not on the scrollback.)
	await frameType(page, frame, "cat /run/vinx/apps/evy/state; app status evy; echo EV-STATUS-''SEEN");
	const status = await frameUntil(frame, (t) => /EV-STATUS-SEEN/.test(t), 'the status', 15_000);
	assert.match(status, /\bcrashed\b/, `the state file does not say crashed:\n${status}`);
	assert.match(status, /app: evy is (stopped|crashed)/, `app status claims a dead app runs:\n${status}`);

	// Now the other direction: closing the annotated window emits
	// window.closed, and the console watcher prints it.
	await frame
		.locator('.vga-window', { has: frame.locator('.vga-title-text', { hasText: 'evy' }) })
		.locator('.vga-btn[title*="Close"]')
		.click();
	await frame.waitForSelector('iframe.app-frame', { state: 'detached', timeout: 10_000 });
	await frameType(
		page,
		frame,
		'i=0; while [ $i -lt 15 ] && ! grep -q window.closed /tmp/wev.log 2>/dev/null; do i=$((i+1)); sleep 1; done; ' +
			"cat /tmp/wev.log; echo WEV-''SEEN",
	);
	const wev = await frameUntil(frame, (t) => /WEV-SEEN/.test(t), 'the watch log', 30_000);
	assert.match(wev, /app\.exited \{"id":"evy","code":137\}/, `the watcher missed app.exited:\n${wev}`);
	assert.match(wev, /window\.closed \{"id":"evy"/, `the watcher missed window.closed:\n${wev}`);

	await frameType(
		page,
		frame,
		"kill %1 2>/dev/null; app remove evy; rm -rf /data/work/evy /data/work/evy.vapp /tmp/wev.log; echo EV-CLEAN-''DONE",
	);
	await frameUntil(frame, (t) => /EV-CLEAN-DONE/.test(t), 'the cleanup', 30_000);
});

test('the terminal button opens shell windows: independent PTYs, closing one kills its shell', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// proc.pty end to end, macOS-Terminal shaped: each footer click opens
	// an in-page terminal window (an unmanaged stream, no app behind it)
	// whose tenant is a login shell on its own PTY — same machine,
	// separate windows, separate processes. Closing a window closes its
	// stream (HUP, reaped by rund); the main console never notices.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// The tty registry, keyed tty-<stream> (unmanaged windows front no
	// app, so the key is the stream id's).
	const ttyKeys = () => frame.evaluate(() => [...(window.__vinxTtyTerms?.keys() ?? [])]);
	const typeInto = (key, line) =>
		frame.evaluate(([k, s]) => window.__vinxTtyTerms.get(k).input(`${s}\r`), [key, line]);
	// A window is named by the stream class its tenant wears (two windows
	// both titled "shell"; the class tells them apart).
	const winOf = (key) =>
		frame.locator('.vga-window', { has: frame.locator(`.tty-s${key.slice(4)}`) });

	await frame.click('button[title*="proc.pty"]');
	await frame.waitForSelector('.tty-term .xterm', { timeout: 30_000 });
	const [key1] = await ttyKeys();
	assert.ok(key1, 'the first shell never registered');
	// A login shell greets with the banner and the full prompt: rund sets
	// HOME, so /root/.profile (PS1='\u@\h:\w# ') is sourced, same as the
	// serial console — not busybox's bare fallback.
	await ttyWindowUntil(
		frame,
		key1,
		(t) => /root@vinx:.*#\s*$/.test(t),
		'the first shell prompt (root@vinx)',
		30_000,
	);

	await frame.click('button[title*="proc.pty"]');
	await frame.waitForFunction((k) => (window.__vinxTtyTerms?.size ?? 0) > 1, key1, {
		timeout: 30_000,
	});
	const key2 = (await ttyKeys()).find((k) => k !== key1);
	assert.ok(key2, 'the second shell never registered');
	await ttyWindowUntil(frame, key2, (t) => /#\s*$/.test(t), 'the second shell prompt', 30_000);

	// Two windows, two shells: each says its own pid. The second window
	// (fresh, on top) proves the real keyboard path — click focuses, keys
	// land; the first types through term.input, the same onData → mux lane.
	await winOf(key2).locator('.tty-term').click();
	await page.keyboard.type('echo P-ID=$$');
	await page.keyboard.press('Enter');
	const t2 = await ttyWindowUntil(frame, key2, (t) => /P-ID=\d+/.test(t), 'the second pid', 20_000);
	const pid2 = t2.match(/P-ID=(\d+)/)[1];

	await typeInto(key1, 'echo P-ID=$$');
	const t1 = await ttyWindowUntil(frame, key1, (t) => /P-ID=\d+/.test(t), 'the first pid', 20_000);
	const pid1 = t1.match(/P-ID=(\d+)/)[1];
	assert.notEqual(pid1, pid2, 'the two windows share one shell');

	// Close the first window (dispatchEvent: the two overlap, and a real
	// click would land on whichever is on top): its stream closes, the
	// shell gets HUP and rund reaps it; the second stays interactive.
	await winOf(key1).locator('.vga-btn[title*="Close"]').dispatchEvent('click');
	await frame.waitForSelector(`.tty-s${key1.slice(4)}`, { state: 'detached', timeout: 10_000 });
	await frameType(
		page,
		frame,
		`i=0; while [ $i -lt 15 ] && kill -0 ${pid1} 2>/dev/null; do i=$((i+1)); sleep 1; done; ` +
			`kill -0 ${pid1} 2>/dev/null && echo SH1-ALIVE || echo SH1-DEAD; echo SH-CHECK-''DONE`,
	);
	const dead = await frameUntil(frame, (t) => /SH-CHECK-DONE/.test(t), 'the first shell reaped', 30_000);
	assert.match(dead, /SH1-DEAD/, `closing the window did not kill its shell:\n${dead}`);

	await typeInto(key2, 'echo STILL-HERE');
	await ttyWindowUntil(frame, key2, (t) => /STILL-HERE/.test(t), 'the survivor echo', 20_000);

	// The grid follows the window: drag the corner handle out and the
	// terminal refits (ResizeObserver → fit → stream.resize). First walk
	// the window away from the bottom-right corner, where the page's own
	// AI fab sits over the resize handle and would eat the pointer.
	const colsOf = (key) => frame.evaluate((k) => window.__vinxTtyTerms.get(k)?.cols ?? 0, key);
	const colsBefore = await colsOf(key2);
	{
		const title = await winOf(key2).locator('.vga-title').boundingBox();
		assert.ok(title, 'the survivor window has no title bar');
		await page.mouse.move(title.x + 40, title.y + title.height / 2);
		await page.mouse.down();
		await page.mouse.move(100, 120, { steps: 8 });
		await page.mouse.up();
	}
	{
		const grip = await winOf(key2).locator('.vga-resize-se').boundingBox();
		assert.ok(grip, 'the survivor window has no resize handle');
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		await page.mouse.move(grip.x + 260, grip.y + 40, { steps: 8 });
		await page.mouse.up();
	}
	{
		const deadline = Date.now() + 10_000;
		for (;;) {
			if ((await colsOf(key2)) > colsBefore) break;
			if (Date.now() > deadline)
				throw new Error(`the shell never refit after the window resize (stuck at ${colsBefore} cols)`);
			await page.waitForTimeout(200);
		}
	}

	// Close the survivor; nothing lingers.
	await winOf(key2).locator('.vga-btn[title*="Close"]').dispatchEvent('click');
	await frameType(
		page,
		frame,
		`i=0; while [ $i -lt 15 ] && kill -0 ${pid2} 2>/dev/null; do i=$((i+1)); sleep 1; done; ` +
			`kill -0 ${pid2} 2>/dev/null && echo SH2-ALIVE || echo SH2-DEAD; echo SH2-CHECK-''DONE`,
	);
	const dead2 = await frameUntil(frame, (t) => /SH2-CHECK-DONE/.test(t), 'the second shell reaped', 30_000);
	assert.match(dead2, /SH2-DEAD/, `the survivor outlived its window:\n${dead2}`);
});

test('the screen window resizes with its frame, picture in proportion', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The fixed-mode picture against a free-shape window: drag the corner
	// and the canvas follows (VgaPanel's ResizeObserver → fit), scaled in
	// proportion — never stretched. The letterbox that pads the difference
	// wears the family ground (#1a1b26), not black.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-panel canvas', { timeout: 10_000 });

	const shape = () =>
		frame.evaluate(() => {
			const c = document.querySelector('.vga-panel canvas');
			if (!c) return null;
			const r = c.getBoundingClientRect();
			return { w: r.width, h: r.height };
		});
	const before = await shape();
	assert.ok(before && before.w > 0, 'the screen canvas never painted');

	assert.equal(
		await frame.evaluate(
			() => getComputedStyle(document.querySelector('.vga-panel')).backgroundColor,
		),
		'rgb(26, 27, 38)',
		'the letterbox lost the family ground colour',
	);

	// Walk the window away from the bottom-right corner first: the page's
	// AI fab sits there, over the resize handle. Then drag the corner
	// INWARD — shrinking dodges the whole-multiple snap that a small
	// outward drag would bounce back from (below 1x the aspect-true size
	// stays), and a shrunk picture proves the same follow-the-frame path.
	const win = frame.locator('.vga-window', { has: frame.locator('.vga-panel') });
	{
		const title = await win.locator('.vga-title').boundingBox();
		assert.ok(title, 'the screen window has no title bar');
		await page.mouse.move(title.x + 40, title.y + title.height / 2);
		await page.mouse.down();
		await page.mouse.move(100, 120, { steps: 8 });
		await page.mouse.up();
	}
	{
		const grip = await win.locator('.vga-resize-se').boundingBox();
		assert.ok(grip, 'the screen window has no resize handle');
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		await page.mouse.move(grip.x - 200, grip.y - 150, { steps: 8 });
		await page.mouse.up();
	}
	let after = null;
	{
		const deadline = Date.now() + 10_000;
		for (;;) {
			after = await shape();
			if (after && after.w < before.w) break;
			if (Date.now() > deadline)
				throw new Error(`the screen never followed the window resize (stuck at ${before.w}px)`);
			await page.waitForTimeout(200);
		}
	}
	// Proportion held: the mode's aspect survives the free-shape drag.
	assert.ok(
		Math.abs(after.w / after.h - before.w / before.h) < 0.03,
		`the picture stretched: ${before.w}x${before.h} → ${after.w}x${after.h}`,
	);

	// The chip toggles it away; the machine keeps rendering unseen.
	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-panel', { state: 'detached', timeout: 10_000 });
});

test('an app registers ext.*: served while it runs, gone when it stops', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §7.3 end to end, and §16's condition 3 made real: a service hosts
	// ext.exsvc.upper through `rpc serve` (its registration is its rpcd
	// connection), a guest shell calls it, the page calls it over ttyS3
	// (page→guest through a dynamically routed method), discover lists it
	// under the app's name — and stopping the app unregisters it, because
	// the table is the connection, not a config file.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frameType(
		page,
		frame,
		'app new exsvc --service && cd /data/work/exsvc && ' +
			"printf '#!/bin/sh\\nexec rpc serve ext.exsvc.upper -- ./upper.sh\\n' > run && " +
			`printf '#!/bin/sh\\n# {"text":X} in, {"text":upper(X)} out\\nexec jq -c "{text: (.text // \\\\"\\\\" | ascii_upcase)}"\\n' > upper.sh && ` +
			'chmod +x run upper.sh && cd /data && ' +
			"app pack /data/work/exsvc && app install /data/work/exsvc.vapp && app start exsvc && echo EXT-''UP",
	);
	const up = await frameUntil(frame, (t) => /EXT-UP/.test(t), 'the ext service', 45_000);
	assert.match(up, /exsvc running/, `the ext host never started:\n${up}`);

	// The registration is a beat behind the start (the service connects,
	// then rpc.serve lands); retry until the call answers.
	await frameType(
		page,
		frame,
		'i=0; while [ $i -lt 20 ]; do ' +
			`out=$(jq -cn '{text:"hi vinx"}' | rpc call ext.exsvc.upper - 2>/dev/null) && break; ` +
			'i=$((i+1)); sleep 1; done; ' +
			"echo \"$out\"; echo EXT-CALL-''DONE",
	);
	const called = await frameUntil(frame, (t) => /EXT-CALL-DONE/.test(t), 'the guest-side call', 45_000);
	assert.match(called, /\{"text":"HI VINX"\}/, `the handler's answer never came back:\n${called}`);

	// discover lists it, owner = the app id.
	await frameType(page, frame, "rpc discover | grep ext.exsvc; echo EXT-DISC-''DONE");
	const disc = await frameUntil(frame, (t) => /EXT-DISC-DONE/.test(t), 'the discover row', 20_000);
	assert.match(disc, /ext\.exsvc\.upper\s+exsvc/, `discover does not list the ext method:\n${disc}`);

	// The page is a caller too: the same method over ttyS3.
	const fromPage = await frame.evaluate(() =>
		window.vinxRpc.call('ext.exsvc.upper', { text: 'from the page' }, 15_000),
	);
	assert.ok(fromPage.ok, `the page-side call failed: ${JSON.stringify(fromPage)}`);
	assert.equal(fromPage.result?.text, 'FROM THE PAGE', `wrong answer: ${JSON.stringify(fromPage)}`);

	// Stop the app: the connection dies, and with it the registration.
	await frameType(
		page,
		frame,
		"app stop exsvc >/dev/null; rpc call ext.exsvc.upper '{}' 2>&1; echo RC=''$?; echo EXT-GONE-''DONE",
	);
	const gone = await frameUntil(frame, (t) => /EXT-GONE-DONE/.test(t), 'the post-stop call', 30_000);
	assert.match(gone, /METHOD_NOT_FOUND/, `the registration outlived its app:\n${gone}`);
	assert.match(gone, /RC=1/, `a dead method must fail the call:\n${gone}`);

	await frameType(page, frame, "app remove exsvc; rm -rf /data/work/exsvc /data/work/exsvc.vapp; echo EXT-CLEAN-''DONE");
	await frameUntil(frame, (t) => /EXT-CLEAN-DONE/.test(t), 'the cleanup', 30_000);
});

test('noise on the stream lane: the mux resyncs, terminals and control both live', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The mux flavour of the wire-noise test (§6.7's "one bad frame must
	// not poison the stream", applied to §6.9's byte lane): garbage rides
	// ttyS1 in both directions — the serial probe sprays the guest-bound
	// side, `head -c /dev/urandom > /dev/ttyS1` fouls the page-bound side
	// from inside — and afterwards a PTY window still echoes and the
	// control plane still answers. The page's parser counts what it ate.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// A PTY window whose app is a plain echo (cat): what goes down comes
	// back up through the same two parsers the noise is about to hit.
	await frameType(
		page,
		frame,
		'mkdir -p /data/work/noisy && cd /data/work/noisy && ' +
			`printf '{"schema":0,"kind":"window","ui":{"type":"tty"},"exec":"./run"}' > app.json && ` +
			"printf '#!/bin/sh\\nexec cat\\n' > run && chmod +x run && cd /data && " +
			"app pack /data/work/noisy && app install /data/work/noisy.vapp && app start noisy && echo NOISY-''UP",
	);
	await frameUntil(frame, (t) => /NOISY-UP/.test(t) && /noisy running/.test(t), 'the echo app', 45_000);
	await frame.waitForSelector('.tty-term', { timeout: 20_000 });

	// Before: the loop works.
	await frame.click('.tty-term');
	await page.keyboard.type('before-noise');
	await ttyWindowUntil(frame, 'noisy', (t) => /before-noise/.test(t), 'the pre-noise echo', 20_000);

	// Guest-bound garbage (the page sprays the UART), then page-bound
	// garbage (the guest fouls its own tty around rpcd's frames).
	await frame.evaluate(() => {
		const junk = new Uint8Array(1500);
		for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
		window.vinxSerialProbe.send(1, [...junk]);
		// A lying header too: declares a big payload it never delivers.
		window.vinxSerialProbe.send(1, [...new TextEncoder().encode('SB1 1 2000\n')].slice(0, 11));
	});
	await frameType(page, frame, "head -c 1500 /dev/urandom > /dev/ttyS1; echo FOUL-''DONE");
	await frameUntil(frame, (t) => /FOUL-DONE/.test(t), 'the guest-side spray', 20_000);

	// The rpcd-side parser gets its stall-kick two seconds after a lying
	// header; give it that beat, then prove both lanes still work.
	await page.waitForTimeout(3_000);
	await frame.click('.tty-term');
	await page.keyboard.type('after-noise');
	await ttyWindowUntil(frame, 'noisy', (t) => /after-noise/.test(t), 'the post-noise echo', 30_000);

	const alive = await frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'echo control-still-alive' }, 15_000),
	);
	assert.ok(alive.ok, `the control plane broke under mux noise: ${JSON.stringify(alive)}`);
	assert.match(String(alive.result?.stdout ?? ''), /control-still-alive/);

	// The page's ledger saw the garbage (either lane's counters move,
	// depending on how the bytes interleaved with real frames).
	const stats = await frame.evaluate(() => window.vinxRpc.mux());
	assert.ok(
		(stats.noiseBytes ?? 0) > 0 || (stats.badFrames ?? 0) > 0 || (stats.orphanBytes ?? 0) > 0,
		`the page parser counted nothing: ${JSON.stringify(stats)}`,
	);

	await frameType(page, frame, "app stop noisy >/dev/null; app remove noisy; rm -rf /data/work/noisy /data/work/noisy.vapp; echo NOISY-CLEAN-''DONE");
	await frameUntil(frame, (t) => /NOISY-CLEAN-DONE/.test(t), 'the cleanup', 45_000);
	await frame.waitForSelector('.tty-term', { state: 'detached', timeout: 10_000 }).catch(() => {});
});

test('twenty broken manifests: app check names every one with its stable code', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §16-7's corpus, pinned as a regression: each sample in
	// manifest-corpus.mjs breaks one rule (or two), and `app check --json`
	// must answer with exactly the expected {code} set — the stable error
	// surface a model repairs against (§13.2). The comparison runs in the
	// guest (each sample carries its .expect file), so the console only
	// needs to show the verdict, not twenty rows.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	await procReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// Materialise the corpus two samples per line: busybox's interactive
	// line editor caps a typed line at 1024 bytes, and five base64'd
	// samples burst it (the tail of the command simply vanished).
	for (let at = 0; at < CORPUS.length; at += 2) {
		const batch = CORPUS.slice(at, at + 2);
		const cmds = batch.flatMap((s) => {
			const mk = sampleCommands(s, '/tmp/corpus');
			const want = Buffer.from(expectedCodes(s), 'utf8').toString('base64');
			mk.push(`echo ${want} | base64 -d > /tmp/corpus/${s.id}/.expect`);
			return mk;
		});
		await frameType(page, frame, `${cmds.join(' && ')} && echo BATCH-${at}-''OK`);
		await frameUntil(frame, (t) => new RegExp(`BATCH-${at}-OK`).test(t), `corpus batch ${at}`, 30_000);
	}

	await frameType(
		page,
		frame,
		'fail=0; for d in /tmp/corpus/*/; do id=$(basename "$d"); want=$(cat "$d/.expect"); ' +
			"got=$(app check \"$d\" --json | jq -r '[.errors[].code]|sort|join(\",\")'); " +
			'[ "$got" = "$want" ] || { echo "CO-BAD $id got=$got want=$want"; fail=1; }; done; ' +
			"[ \"$fail\" = 0 ] && echo CO-ALL-''OK || echo CO-SOME-''BAD; echo CORPUS-''DONE",
	);
	const verdict = await frameUntil(frame, (t) => /CORPUS-DONE/.test(t), 'the corpus verdict', 60_000);
	assert.match(verdict, /CO-ALL-OK/, `a sample's codes drifted:\n${verdict}`);
	assert.equal(CORPUS.length, 20, 'the corpus is twenty samples, per §16-7');

	await frameType(page, frame, "rm -rf /tmp/corpus; echo CO-CLEAN-''DONE");
	await frameUntil(frame, (t) => /CO-CLEAN-DONE/.test(t), 'the cleanup', 15_000);
});

test('a second tab of the same pane runs ephemeral: reads the mirror, never writes it', async (page, context) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Two tabs both play pane 1 — one machine name, one /data archive, and
	// the Web Lock names the first tab its only writer. The second tab runs
	// as an ephemeral machine: it restores /data like any boot, but neither
	// its new files nor its deletions may reach the mirror (a missing row in
	// its listing must not erase the owner's file). The origin-shared
	// share/local tier is the deliberate exception — an explicit share still
	// lands, which doubles as proof that the ephemeral sweep ran at all.
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const frame = await paneFrame(page);
	await vmReady(frame);
	assert.equal(
		await frame.evaluate(() => document.documentElement.dataset.vmIdentity),
		'owner',
		'the first tab does not hold the machine name',
	);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	await frameType(page, frame, "echo alive > /data/owner-keep.txt && echo KEEP-''SET");
	await frameUntil(frame, (t) => /KEEP-SET/.test(t), 'the owner marker write');
	await waitMirrorKey(frame, 'p1/owner-keep.txt', "the owner's marker");

	const second = await context.newPage();
	try {
		await second.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
		const pane = await paneFrame(second);
		await vmReady(pane);
		assert.equal(
			await pane.evaluate(() => document.documentElement.dataset.vmIdentity),
			'ephemeral',
			'the second tab claims to own a machine name already taken',
		);
		await frameUntil(pane, (t) => /#\s*$/.test(t), 'an ephemeral prompt');
		// The ephemeral machine restores the archive it will never write.
		await frameType(
			second,
			pane,
			"i=0; while [ $i -lt 30 ] && [ ! -f /data/owner-keep.txt ]; do i=$((i+1)); sleep 1; done; cat /data/owner-keep.txt; echo EPH-''RESTORED",
		);
		const restored = await frameUntil(
			pane,
			(t) => /EPH-RESTORED/.test(t),
			'the ephemeral restore read',
			60_000,
		);
		assert.match(restored, /alive/, `the ephemeral machine did not restore /data:\n${restored}`);
		// Now the two hazards at once: a new private file, and deleting the
		// owner's file from this guest — plus the sweep sentinel in
		// share/local, the one tier an ephemeral machine may write.
		await frameType(
			second,
			pane,
			"rm -f /data/owner-keep.txt; echo mine > /data/eph-file.txt; echo shared > /data/share/local/eph-shared.txt; echo EPH-''SET",
		);
		await frameUntil(pane, (t) => /EPH-SET/.test(t), 'the ephemeral writes');
		await waitMirrorKey(pane, 'share/local/eph-shared.txt', "the ephemeral machine's share");
		// The sweep that mirrored the sentinel is the sweep that would have
		// carried the private rows; both verdicts are in.
		assert.equal(
			await mirrorHasKey(pane, 'p1/eph-file.txt'),
			false,
			'an ephemeral machine wrote its private file into the mirror',
		);
		assert.equal(
			await mirrorHasKey(pane, 'p1/owner-keep.txt'),
			true,
			"the ephemeral machine's deletion erased the owner's mirror row",
		);
	} finally {
		if (!second.isClosed()) await second.close();
	}
});

test('a Web Serial device becomes /dev/ttyS2, bytes both ways', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// A fake port behind the real picker: the chip's whole flow — requestPort,
	// open, both pump directions — runs as shipped, only the wire is virtual.
	// (navigator.serial exists in desktop Chrome, headless included; the chip
	// would not have rendered otherwise and the click below would fail.)
	await frame.evaluate(() => {
		let got = '';
		const port = {
			open: async () => {},
			close: async () => {},
			readable: new ReadableStream({
				start(controller) {
					window.__serialFeed = (s) => controller.enqueue(new TextEncoder().encode(s));
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					got += new TextDecoder().decode(chunk);
					window.__serialGot = got;
				},
			}),
			getInfo: () => ({}),
		};
		navigator.serial.requestPort = async () => port;
	});
	await frame.click('.serial-chip');
	await frame.click('.np-save');
	await frame.waitForSelector('.serial-chip.on', { timeout: 10_000 });

	// Guest → device. The guest's termios echo also mirrors device-fed bytes
	// back out, so the assertion is a substring, not an equality.
	await frameType(page, frame, `echo SERIAL-TO-DEVICE-42 > /dev/ttyS2; echo WROTE-SER''IAL`);
	await frameUntil(frame, (t) => /WROTE-SERIAL/.test(t), 'the serial write');
	{
		const deadline = Date.now() + 15_000;
		for (;;) {
			const got = await frame.evaluate(() => window.__serialGot ?? '');
			if (got.includes('SERIAL-TO-DEVICE-42')) break;
			if (Date.now() > deadline) {
				throw new Error(`the fake device never saw the guest's bytes; got: ${got}`);
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	// Device → guest: a background head(1) catches the line the fake feeds.
	await frameType(page, frame, `(head -n1 /dev/ttyS2 > /tmp/ser-in) & echo READER-''UP`);
	await frameUntil(frame, (t) => /READER-UP/.test(t), 'the reader start');
	await frame.evaluate(() => window.__serialFeed('DEVICE-TO-GUEST-7\n'));
	await frameType(page, frame, `sleep 1; cat /tmp/ser-in; echo READ-SERIAL-''DONE`);
	const read = await frameUntil(frame, (t) => /READ-SERIAL-DONE/.test(t), 'the serial read');
	assert.match(read, /DEVICE-TO-GUEST-7/, `the guest never read the device's line:\n${read}`);

	// Click again: disconnect, back to the quiet chip.
	await frame.click('.serial-chip');
	await frame.waitForSelector('.serial-chip:not(.on)', { timeout: 10_000 });
});

test('the footer volume knob: page-side gain, mute toggle, persistence', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);

	// The knob wires itself in as soon as the speaker adapter exists; the
	// applied gain lands on data-volume (vm.setVolume's observability).
	await frame.waitForFunction(() => !!document.documentElement.dataset.volume, null, {
		timeout: 15_000,
	});

	// Drag to 30 (the native-setter dance is for React's controlled input):
	// the page gain follows and the value persists for the next visit.
	const drag = (value) =>
		frame.evaluate((v) => {
			const slider = document.querySelector('.vol-chip input');
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, v);
			slider.dispatchEvent(new Event('input', { bubbles: true }));
		}, value);
	await drag('30');
	await frame.waitForFunction(() => document.documentElement.dataset.volume === '0.3', null, {
		timeout: 5_000,
	});
	assert.equal(
		await frame.evaluate(() => localStorage.getItem('vinx.volume')),
		'30',
		'the volume did not persist',
	);

	// Mute is a click, unmute another; the slider value survives underneath.
	await frame.click('.vol-mute');
	await frame.waitForFunction(() => document.documentElement.dataset.volume === '0', null, {
		timeout: 5_000,
	});
	await frame.click('.vol-mute');
	await frame.waitForFunction(() => document.documentElement.dataset.volume === '0.3', null, {
		timeout: 5_000,
	});
});

test('ble(1) drives a Web Bluetooth device: connect, GATT, notify feed', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}

	// A fake GATT world behind a fake navigator.bluetooth, installed in every
	// frame before the app loads: one heart-rate service, one notifying
	// characteristic (2a37), one readable/writable one (2a38). ble.ts runs as
	// shipped — parking on the chip, seq-matched replies, the notify feed —
	// only the radio is imaginary. requestLEScan is deliberately absent, so
	// `ble scan` exercises the honest flag hint.
	await page.addInitScript(() => {
		const fake = () => {
			const hex = (dv) => {
				let s = '';
				for (let i = 0; i < dv.byteLength; i++) {
					s += dv.getUint8(i).toString(16).padStart(2, '0');
				}
				return s;
			};
			// ble.ts turns 16-bit shorts into numbers and passes names through.
			const match = (u, short) =>
				u === parseInt(short, 16) || (typeof u === 'string' && u.startsWith(`0000${short}`));
			const c37 = Object.assign(new EventTarget(), {
				uuid: '00002a37-0000-1000-8000-00805f9b34fb',
				properties: {
					read: false,
					write: false,
					writeWithoutResponse: false,
					notify: true,
					indicate: false,
				},
				value: null,
				startNotifications: async () => c37,
				stopNotifications: async () => c37,
			});
			window.__bleNotify = (h) => {
				const b = new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
				c37.value = new DataView(b.buffer);
				c37.dispatchEvent(new Event('characteristicvaluechanged'));
			};
			const c38 = Object.assign(new EventTarget(), {
				uuid: '00002a38-0000-1000-8000-00805f9b34fb',
				properties: {
					read: true,
					write: true,
					writeWithoutResponse: false,
					notify: false,
					indicate: false,
				},
				value: null,
				readValue: async () => new DataView(new Uint8Array([0xab, 0x10]).buffer),
				writeValue: async (bytes) => {
					window.__bleWrote = hex(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
				},
			});
			const svc = {
				uuid: '0000180d-0000-1000-8000-00805f9b34fb',
				isPrimary: true,
				getCharacteristics: async () => [c37, c38],
				getCharacteristic: async (u) => {
					if (match(u, '2a37')) return c37;
					if (match(u, '2a38')) return c38;
					throw new Error('no such characteristic');
				},
			};
			const device = Object.assign(new EventTarget(), {
				id: 'e2e-ble-id',
				name: 'e2e-ble',
			});
			const server = {
				connected: false,
				connect: async () => {
					server.connected = true;
					return server;
				},
				disconnect: () => {
					if (!server.connected) return;
					server.connected = false;
					device.dispatchEvent(new Event('gattserverdisconnected'));
				},
				getPrimaryServices: async () => [svc],
				getPrimaryService: async (u) => {
					if (match(u, '180d') || u === 'heart_rate') return svc;
					throw new Error('no such service');
				},
			};
			device.gatt = server;
			return Object.assign(new EventTarget(), {
				getDevices: async () => [],
				requestDevice: async (opts) => {
					window.__bleOpts = opts;
					return device;
				},
			});
		};
		Object.defineProperty(Navigator.prototype, 'bluetooth', {
			configurable: true,
			get() {
				window.__bleFake ??= fake();
				return window.__bleFake;
			},
		});
	});

	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// Nothing yet: no status file, no device.
	await frameType(page, frame, 'ble show');
	await frameUntil(frame, (t) => /ble: no device/.test(t), 'the empty ble show');

	// connect parks on the chip; the click is the gesture requestDevice needs.
	await frameType(page, frame, 'ble connect');
	await frame.waitForSelector('.ble-chip.pending', { timeout: 15_000 });
	await frame.click('.ble-chip');
	await frame.waitForSelector('.ble-chip.on', { timeout: 10_000 });
	await frameUntil(frame, (t) => /ble: connected to e2e-ble/.test(t), 'the connect');

	// The blanket grant: acceptAllDevices plus every 16-bit service id —
	// the SIG standard block (256) and the member block (1024).
	const opts = await frame.evaluate(() => window.__bleOpts);
	assert.equal(opts.acceptAllDevices, true, 'requestDevice should accept all devices');
	assert.equal(opts.optionalServices.length, 1280, 'all 16-bit service ids should be granted');

	await frameType(page, frame, 'ble services');
	const svcs = await frameUntil(frame, (t) => /svc 180d/.test(t), 'the service list');
	assert.match(svcs, /chr 2a37\s+notify/, `2a37 should list as notify:\n${svcs}`);
	assert.match(svcs, /chr 2a38\s+read write/, `2a38 should list as read write:\n${svcs}`);

	await frameType(page, frame, 'ble read 180d 2a38');
	await frameUntil(frame, (t) => /\bab10\b/.test(t), 'the read value');

	await frameType(page, frame, 'ble write 180d 2a38 c0ffee');
	await frameUntil(frame, (t) => /ble: written/.test(t), 'the write ack');
	assert.equal(await frame.evaluate(() => window.__bleWrote), 'c0ffee');

	// Subscribe, follow the feed from the background, feed a value from the
	// "device", and find it in the watcher's log.
	await frameType(page, frame, 'ble notify 180d 2a37');
	await frameUntil(frame, (t) => /ble: subscribed/.test(t), 'the subscribe ack');
	// timeout(1), not a kill: the watcher is `sh /usr/bin/ble`, so killall
	// would have to aim at sh — and the shell typing this is one too.
	await frameType(page, frame, `(timeout 6 ble watch >/tmp/blf 2>&1 &); echo WATCH-''UP`);
	await frameUntil(frame, (t) => /WATCH-UP/.test(t), 'the watcher start');
	await frame.evaluate(() => window.__bleNotify('0a64'));
	await frameType(page, frame, `sleep 7; cat /tmp/blf; echo WATCH-''DONE`);
	const watched = await frameUntil(frame, (t) => /WATCH-DONE/.test(t), 'the watch log');
	assert.match(watched, /2a37\s+0a64/, `the notification never reached the feed:\n${watched}`);

	await frameType(page, frame, 'ble notify 180d 2a37 off');
	await frameUntil(frame, (t) => /ble: unsubscribed/.test(t), 'the unsubscribe ack');

	// Subscribe again after the off: the old listener must be gone, so one
	// event floats one line — a leak would stack listeners and print it
	// twice. (The screen already shows one `ble: subscribed`, hence the
	// chained marker instead of waiting on that text.)
	await frameType(page, frame, `ble notify 180d 2a37 && echo RESUB-''OK`);
	await frameUntil(frame, (t) => /RESUB-OK/.test(t), 'the re-subscribe ack');
	await frameType(page, frame, `(timeout 6 ble watch >/tmp/blf2 2>&1 &); echo WATCH2-''UP`);
	await frameUntil(frame, (t) => /WATCH2-UP/.test(t), 'the second watcher start');
	await frame.evaluate(() => window.__bleNotify('0b7f'));
	await frameType(page, frame, `sleep 7; cat /tmp/blf2; echo WATCH2-''DONE`);
	const watched2 = await frameUntil(frame, (t) => /WATCH2-DONE/.test(t), 'the second watch log');
	const hits = watched2.match(/2a37\s+0b7f/g) ?? [];
	assert.equal(hits.length, 1, `one event should float exactly once:\n${watched2}`);

	// No requestLEScan in the fake: scan answers with the flag's address --
	// which the terminal also renders as a copyable link.
	await frameType(page, frame, 'ble scan 1');
	await frameUntil(frame, (t) => /chrome:\/\/flags/.test(t), 'the scan flag hint');

	await frameType(page, frame, 'ble disconnect');
	await frameUntil(frame, (t) => /ble: disconnected/.test(t), 'the disconnect');
	await frame.waitForSelector('.ble-chip:not(.on)', { timeout: 10_000 });
});

test('origin resources have one arbiter: a busy BLE radio names its holder', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// §3.0 (and the Phase 0 debt this repays): machines on one origin do
	// not each pretend to own the physical radio. Machine 1 holds the BLE
	// session; machine 2's connect answers RESOURCE_BUSY *naming machine
	// 1*, immediately — no picker, no timeout. Runs right after the
	// ble(1) test on purpose: its addInitScript fake bluetooth persists
	// on this page and covers both panes here. (The REQUIRES_FOREGROUND
	// half of the arbitration is pinned in hostcall.test.ts — a hidden
	// tab throttles the very VM that would type the command, so the
	// browser leg would test the throttle, not the broker.)
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	const one = await paneFrame(page);
	await vmReady(one);
	await procReady(one);
	await frameUntil(one, (t) => /#\s*$/.test(t), 'a prompt on machine 1');

	// Machine 1 takes the radio (the fake picker resolves on the chip).
	await frameType(page, one, 'ble connect');
	await one.waitForSelector('.ble-chip.pending', { timeout: 15_000 });
	await one.click('.ble-chip');
	await frameUntil(one, (t) => /ble: connected to e2e-ble/.test(t), 'machine 1 connected', 30_000);

	// Machine 2 splits in and asks for the same radio.
	await page.click('.actions button[title*="Split right"]');
	const two = await paneFrame(page, '2');
	await vmReady(two);
	await procReady(two);
	await frameUntil(two, (t) => /#\s*$/.test(t), 'a prompt on machine 2');
	await frameType(page, two, 'ble connect');
	const busy = await frameUntil(
		two,
		(t) => /RESOURCE_BUSY/.test(t),
		'the busy verdict on machine 2',
		30_000,
	);
	assert.match(busy, /terminal machine 1/, `the busy error does not name the holder:\n${busy}`);

	// Machine 1 lets go; the radio is the origin's again — machine 2's
	// retry now parks on the picker like any first connect.
	await frameType(page, one, 'ble disconnect');
	await frameUntil(one, (t) => /ble: disconnected/.test(t), 'the release', 15_000);
	await frameType(page, two, 'ble connect');
	await two.waitForSelector('.ble-chip.pending', { timeout: 15_000 });
	await two.click('.ble-chip');
	await frameUntil(two, (t) => /ble: connected to e2e-ble/.test(t), 'machine 2 connected', 30_000);
	await frameType(page, two, 'ble disconnect');
	await frameUntil(two, (t) => /ble: disconnected/.test(t), 'machine 2 released', 15_000);

	// Close machine 2 so later reloads of this page boot one VM, not two.
	await page
		.locator('.shell-frame', { has: page.locator('iframe[name="pane-2"]') })
		.locator('.frame-close')
		.click();
	await page.waitForSelector('iframe[name="pane-2"]', { state: 'detached', timeout: 10_000 });
});

test('the guest reaches the browser: sound card, say, notify, camera', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// The kernel probed v86's SB16 and OSS emulation put /dev/dsp on it —
	// that one device node is the whole zero-userspace sound story.
	await frameType(page, frame, `[ -c /dev/dsp ] && echo SND-DEV-''OK || echo SND-DEV-''MISSING`);
	const snd = await frameUntil(frame, (t) => /SND-DEV-(OK|MISSING)/.test(t), 'the sound check');
	assert.match(snd, /SND-DEV-OK/, `no /dev/dsp — the kernel did not find the SB16:\n${snd}`);

	// say(1): a spy where the voice would be — headless Chrome speaks to no
	// one, but the utterance text proves the speech.speak call arrived.
	await frame.evaluate(() => {
		window.__said = '';
		speechSynthesis.speak = (u) => {
			window.__said = u.text;
		};
	});
	await frameType(page, frame, 'say vinx can speak now');
	{
		const deadline = Date.now() + 15_000;
		for (;;) {
			const said = await frame.evaluate(() => window.__said);
			if (said === 'vinx can speak now') break;
			if (Date.now() > deadline) throw new Error(`say(1) never reached speechSynthesis: "${said}"`);
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	// notify(1): permission is 'default' here, so the promised fallback — the
	// corner toast — is what must appear.
	await frameType(page, frame, 'notify the kettle boiled');
	await frame.waitForFunction(
		() => document.querySelector('.drop-note')?.textContent?.includes('notify: the kettle boiled'),
		null,
		{ timeout: 15_000 },
	);

	// The same call from run_shell — the leg the OSC protocol could never
	// serve (its output was captured, never parsed; §4.1's named flaw, dead
	// since these became control-plane methods).
	const shellNotify = await frame.evaluate(() => window.vinxRpc.run('notify shell-said-so', 20));
	assert.equal(shellNotify.exit_code, 0, `notify failed under run_shell: ${JSON.stringify(shellNotify)}`);
	await frame.waitForFunction(
		() => document.querySelector('.drop-note')?.textContent?.includes('notify: shell-said-so'),
		null,
		{ timeout: 15_000 },
	);

	// camera(1): the launch flags below give getUserMedia a fake device, so
	// no permission prompt blocks the frame. media.camera.capture answers
	// with the file's path and size; the magic bytes prove a real encode.
	await frameType(page, frame, 'camera snap e2e-shot.png');
	await frameUntil(
		frame,
		(t) => /camera: \/data\/e2e-shot\.png/.test(t),
		'the camera frame',
		45_000,
	);
	await frameType(page, frame, `head -c 4 /data/e2e-shot.png | od -An -tx1; echo CAM-MAGIC-''DONE`);
	const magic = await frameUntil(frame, (t) => /CAM-MAGIC-DONE/.test(t), 'the PNG magic read');
	assert.match(magic, /89 50 4e 47/, `/data/e2e-shot.png is not a PNG:\n${magic}`);
});

test('the VGA screen panel shows what the guest draws on /dev/fb0', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// The chip opens the panel; fbcon's boot-time modeset means the canvas
	// is already in graphics mode, sized by the Bochs DRM driver.
	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-panel canvas', { timeout: 10_000 });

	await frameType(page, frame, 'fbdemo');
	await frameUntil(frame, (t) => /fbdemo: painted \d+x\d+/.test(t), 'the fbdemo report', 60_000);

	// One pixel from the middle of the canvas: the gradient's midpoint is
	// far from both black (fbcon idle) and white, so any real paint shows.
	// The context options must match v86's own getContext call — different
	// options on the same canvas return null.
	const deadline = Date.now() + 15_000;
	for (;;) {
		const px = await frame.evaluate(() => {
			const canvas = document.querySelector('.vga-panel canvas');
			if (!canvas || !canvas.width) return null;
			const ctx = canvas.getContext('2d', { alpha: false });
			if (!ctx) return null;
			const d = ctx.getImageData((canvas.width / 2) | 0, (canvas.height / 2) | 0, 1, 1).data;
			return [d[0], d[1], d[2]];
		});
		if (px && px[0] + px[1] + px[2] > 120) break;
		if (Date.now() > deadline) {
			throw new Error(`the canvas stayed dark after fbdemo: ${JSON.stringify(px)}`);
		}
		await new Promise((r) => setTimeout(r, 300));
	}

	// The chip closes the panel again; the canvas leaves the page.
	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-panel', {
		state: 'detached',
		timeout: 10_000,
	});
});

test('boot progress is one monotonic number that ends at 100%', async (page, context) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// A fresh page, so the boot is watched from as early as possible. The
	// old bar swept 0→100% once per file (five times over) and then looped
	// an animation; the contract now is one number that only ever grows —
	// vm.ts mirrors it onto the document for exactly this assertion.
	const term = await context.newPage();
	try {
		await term.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'domcontentloaded' });
		const frame = await paneFrame(term);
		const samples = [];
		const deadline = Date.now() + 150_000;
		for (;;) {
			const s = await frame
				.evaluate(() => ({
					p: document.documentElement?.dataset.vmBootProgress,
					state: document.documentElement?.dataset.vmState,
				}))
				.catch(() => null);
			if (s?.p !== undefined && samples[samples.length - 1] !== s.p) samples.push(s.p);
			if (s?.state === 'ready') break;
			if (s?.state === 'failed') throw new Error('the VM failed to boot');
			if (Date.now() > deadline)
				throw new Error(`the VM never became ready; progress saw: ${samples.join(' ')}`);
			await new Promise((r) => setTimeout(r, 50));
		}
		const nums = samples.map(Number);
		assert.ok(nums.length >= 2, `too few progress samples to judge: ${samples.join(' ')}`);
		for (let i = 1; i < nums.length; i++) {
			assert.ok(
				nums[i] >= nums[i - 1],
				`progress went backwards (${nums[i - 1]} -> ${nums[i]}): ${samples.join(' ')}`,
			);
		}
		assert.equal(samples[samples.length - 1], '1.000', 'the bar did not end at 100%');
	} finally {
		if (!term.isClosed()) await term.close();
	}
});

test('the screen window keeps a hand-set size across close and reopen', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// A do-nothing NROM cartridge, built right in the guest: 16-byte iNES
	// header, 16 KiB PRG that jumps in place (reset/NMI/IRQ vectors all
	// $8000), 8 KiB CHR of zeros. Loading it makes nes mode-set to its
	// native 256x224 — the departure from fbcon's baseline that auto-opens
	// the screen window with a fit, which no shell command alone can do.
	await frameType(
		page,
		frame,
		String.raw`{ printf 'NES\x1a\x01\x01'; head -c 10 /dev/zero; printf '\x4c\x00\x80'; head -c 16375 /dev/zero; printf '\x00\x80\x00\x80\x00\x80'; head -c 8192 /dev/zero; } > /tmp/e2e.nes && wc -c < /tmp/e2e.nes`,
	);
	await frameUntil(frame, (t) => /24592/.test(t), 'the ROM byte count');
	await frameType(page, frame, 'nes /tmp/e2e.nes --no-sound');
	await frame.waitForSelector('.vga-window', { timeout: 60_000 });

	const rect = () =>
		frame.evaluate(() => {
			const el = document.querySelector('.vga-window');
			return el ? { w: el.offsetWidth, h: el.offsetHeight } : null;
		});
	const whole = (r) => r && (r.w - 2) % 256 === 0 && (r.h - 28) % 224 === 0;
	// The auto-fit sizes the window to a whole multiple of the mode.
	{
		const deadline = Date.now() + 30_000;
		for (;;) {
			const r = await rect();
			if (whole(r)) break;
			if (Date.now() > deadline)
				throw new Error(`the window never fit the mode: ${JSON.stringify(await rect())}`);
			await new Promise((r2) => setTimeout(r2, 200));
		}
	}
	const before = await rect();

	// Drag the SE corner toward one multiple below (or above, at 1x): the
	// drag is aspect-locked and the release snaps to the nearest whole
	// multiple — the panel then has the content's exact shape, so no black
	// frame on all four sides. The pointer aims at target±0.3 so the snap
	// rounds to the target and the size demonstrably changes.
	const n = (before.w - 2) / 256;
	const target = n >= 2 ? n - 1 : n + 1;
	const aim = target + (n >= 2 ? 0.3 : -0.3);
	const handle = await frame.waitForSelector('.vga-resize-se');
	const box = await handle.boundingBox();
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(
		cx + Math.round(256 * aim + 2 - before.w),
		cy + Math.round(224 * aim + 28 - before.h),
		{ steps: 6 },
	);
	await page.mouse.up();
	const resized = await rect();
	assert.deepEqual(
		resized,
		{ w: 256 * target + 2, h: 224 * target + 28 },
		`the release did not snap to the ${target}x multiple (from ${JSON.stringify(before)})`,
	);

	// Close and reopen: the hand-set size must survive — this exact reopen
	// used to stomp it back to the auto-fit.
	await frame.click('.vga-btn[title*="Close"]');
	await frame.waitForSelector('.vga-window', { state: 'detached', timeout: 10_000 });
	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-window', { timeout: 10_000 });
	assert.deepEqual(await rect(), resized, 'reopening the screen reset the hand-set size');

	// q on the console quits nes (the serial tty carries the same keys);
	// the mode returns to the baseline. Click the terminal's top-left
	// corner — the floating window sits bottom-right — to focus it first.
	await frame.click('.screen .xterm-screen', { position: { x: 5, y: 5 } });
	await page.keyboard.press('q');
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'the prompt after quitting nes', 30_000);
	await frame.click('.vga-btn[title*="Close"]');
	await frame.waitForSelector('.vga-window', { state: 'detached', timeout: 10_000 });
});

test('lvdemo compiles in the machine, draws a GUI, and the page mouse clicks it', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The whole GUI story in one pass: the image carries the Chinese font,
	// tcc links the shipped example against liblvgl.so inside the guest,
	// the screen panel shows what it draws, and pointer events over the
	// panel come back as PS/2 → evdev — which the printed "click" can only
	// mean survived end to end.
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-panel canvas', { timeout: 10_000 });

	// Raw PS/2 first: three bytes on /dev/input/mice is one movement
	// packet, and needs nothing from LVGL — the narrowest wire check.
	await frameType(
		page,
		frame,
		'(timeout 10 head -c 3 /dev/input/mice > /tmp/mice.bin; echo MICE-$(wc -c < /tmp/mice.bin)) &',
	);
	const canvas = await frame.waitForSelector('.vga-panel canvas');
	const cbox = await canvas.boundingBox();
	await page.mouse.move(cbox.x + 10, cbox.y + 10);
	await page.mouse.move(cbox.x + cbox.width - 10, cbox.y + cbox.height / 2, { steps: 12 });
	await frameUntil(frame, (t) => /MICE-3/.test(t), 'a PS/2 packet in the guest', 20_000);

	// The GB2312 font ships in the image; the demo loads it from there.
	await frameType(page, frame, 'echo FONT-$(wc -c < /usr/share/fonts/cjk16.bin)');
	await frameUntil(
		frame,
		(t) => /FONT-\d{6,}\b/.test(t),
		'the bundled font and its six-figure byte count',
		30_000,
	);

	// Close the panel first: lvdemo asks the page to reopen it (rpc call
	// window.focus '{"id":"screen"}'), and only an absent panel proves that.
	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-panel', { state: 'detached', timeout: 10_000 });

	// tcc compiles the shipped example against the system liblvgl.so; its
	// stdout stays on this tty, so the readiness (and the mouse's evdev
	// node) print right here.
	await frameType(page, frame, 'lvdemo &');
	try {
		await frame.waitForSelector('.vga-panel canvas', { timeout: 30_000 });
		const up = await frameUntil(frame, (t) => /lvdemo: ready/.test(t), 'lvdemo up', 120_000);
		assert.match(up, /lvdemo: pointer on \/dev\/input\/event\d/, 'lvdemo found no mouse evdev');

		// The screen center is the demo's button; both it and the backdrop
		// are blue-leaning, where fbcon's leftovers are black or white.
		{
			const deadline = Date.now() + 15_000;
			for (;;) {
				const px = await frame.evaluate(() => {
					const c = document.querySelector('.vga-panel canvas');
					if (!c || !c.width) return null;
					const ctx = c.getContext('2d', { alpha: false });
					if (!ctx) return null;
					const d = ctx.getImageData((c.width / 2) | 0, (c.height / 2) | 0, 1, 1).data;
					return [d[0], d[1], d[2]];
				});
				if (px && px[2] > 40 && px[2] > px[0]) break;
				if (Date.now() > deadline)
					throw new Error(`the canvas never showed LVGL's paint: ${JSON.stringify(px)}`);
				await new Promise((r) => setTimeout(r, 300));
			}
		}

		// Move onto the centered button: crossing the panel edge fires the
		// enter-anchor (a clamped sweep to 0,0 plus a walk to the pointer),
		// so the guest cursor lands under the page pointer no matter what
		// motion history preceded it. An unpatched (unclamped) evdev driver
		// would bank the sweep's overshoot and miss the button — this click
		// is the clamp's regression test too. Approach from an off-panel
		// park in small steps: each step must stay within one PS/2 packet
		// (~250 guest px per axis).
		// (Measure the canvas afresh: the text-mode box from above is
		// stale — starting lvdemo switched the mode and resized the panel.)
		const box = await (await frame.waitForSelector('.vga-panel canvas')).boundingBox();
		await page.mouse.move(box.x - 40, box.y - 40);
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
		// A few evdev polls (33 ms each) between move, press and release:
		// the driver folds a whole queue into one sampled state, so a
		// same-instant press+release reads as "never pressed".
		await page.waitForTimeout(250);
		await page.mouse.down();
		await page.waitForTimeout(150);
		await page.mouse.up();
		await frameUntil(frame, (t) => /lvdemo: click 1/.test(t), "the button's click report", 20_000);
	} finally {
		// Leave nothing running or covering the terminal — a failure here
		// must not cascade into every test that follows.
		await frame
			.click('.screen .xterm-screen', { position: { x: 5, y: 5 }, force: true })
			.catch(() => {});
		await frameType(page, frame, 'kill %1 2>/dev/null').catch(() => {});
		await frame.click('.screen-chip').catch(() => {});
		await frame
			.waitForSelector('.vga-panel', { state: 'detached', timeout: 10_000 })
			.catch(() => {});
	}
});

test('termbox2 and ncurses are one tcc line from a TUI', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Compile-and-link is the promise the image makes (the drawing itself
	// is xterm.js's job and long proven): termbox2 is a single header that
	// carries its own implementation behind TB_IMPL, ncurses links as a
	// shared library, and the terminfo entry for this terminal must exist
	// or neither draws at runtime.
	const frame = await paneFrame(page);
	await vmReady(frame);
	// A bare Enter first: a previous test's background job may have printed
	// after the prompt (e.g. "lvdemo: ready"), leaving the screen not
	// ending in "#" — one newline redraws a clean prompt to match.
	await frame.click('.screen .xterm-screen', { position: { x: 5, y: 5 } });
	await page.keyboard.press('Enter');
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	await frameType(
		page,
		frame,
		String.raw`printf '#define TB_IMPL\n#include <termbox2.h>\nint main(void){return 0;}\n' > /tmp/tb.c && tcc /tmp/tb.c -o /tmp/tb && echo TB-OK`,
	);
	await frameUntil(frame, (t) => /TB-OK/.test(t), 'termbox2 compiled and linked', 60_000);

	await frameType(
		page,
		frame,
		String.raw`printf '#include <ncurses.h>\nint main(void){return initscr==0;}\n' > /tmp/nc.c && { tcc /tmp/nc.c -lncurses -o /tmp/nc 2>/dev/null || tcc /tmp/nc.c -lncursesw -o /tmp/nc; } && echo NC-OK; ls /usr/share/terminfo/x/ | head -1`,
	);
	await frameUntil(
		frame,
		(t) => /NC-OK/.test(t) && /xterm/.test(t),
		'ncurses linked and terminfo present',
		60_000,
	);
});

test('a mounted folder syncs both ways with /data/host', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	await page.goto(new URL('terminal/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');

	// An OPFS directory is a real FileSystemDirectoryHandle, so the whole
	// pipeline — scan, push, write-back — runs as shipped; only the picker
	// (which needs a human gesture) is bypassed, via the mount control's
	// window-event hook. Seed proj/hello.txt before mounting.
	await frame.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const stale = [];
		for await (const [name] of root.entries()) stale.push(name);
		for (const name of stale) await root.removeEntry(name, { recursive: true }).catch(() => {});
		const dir = await root.getDirectoryHandle('proj', { create: true });
		const fh = await dir.getFileHandle('hello.txt', { create: true });
		const w = await fh.createWritable();
		await w.write('from the host\n');
		await w.close();
		window.dispatchEvent(new CustomEvent('vinx:mount', { detail: root }));
	});
	await frame.waitForSelector('.mount-chip.on', { timeout: 10_000 });

	// host→guest: the first sweep lands it under /data/host, subdirectory
	// intact. The guest polls so a slow first round does not flake.
	await frameType(
		page,
		frame,
		'i=0; while [ ! -f /data/host/proj/hello.txt ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done; cat /data/host/proj/hello.txt',
	);
	await frameUntil(frame, (t) => t.includes('from the host'), 'the host file in the guest', 60_000);

	// guest→host: a file written in the guest reaches the real (OPFS) disk on
	// the ~15 s write-back sweep.
	await frameType(page, frame, 'echo "from the guest" > /data/host/reply.txt');
	const deadline = Date.now() + 60_000;
	for (;;) {
		const text = await frame.evaluate(async () => {
			try {
				const root = await navigator.storage.getDirectory();
				const fh = await root.getFileHandle('reply.txt');
				return await (await fh.getFile()).text();
			} catch {
				return null;
			}
		});
		if (text?.includes('from the guest')) break;
		if (Date.now() > deadline) {
			throw new Error(`reply.txt never reached the host disk (${JSON.stringify(text)})`);
		}
		await new Promise((r) => setTimeout(r, 1000));
	}

	// The chip unmounts; the sync stops.
	await frame.click('.mount-chip');
	await frame.waitForSelector('.mount-chip:not(.on)', { timeout: 10_000 });
});

test('the terminal offers going online once, and remembers the answer', async () => {
	// Fresh contexts stand in for first visits: no muteNetPrompt, no stored
	// network choice. The banner lives in the shell document, before (and
	// regardless of whether) any VM boots.
	const stayCtx = await browser.newContext();
	const goCtx = await browser.newContext();
	try {
		// "Stay LAN-only" retires the banner for good.
		const p = await stayCtx.newPage();
		await p.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'domcontentloaded' });
		await p.waitForSelector('.np-prompt', { timeout: 10_000 });
		await p.click('.np-prompt-stay');
		assert.equal(await p.$('.np-prompt'), null, 'the banner outlived its dismissal');
		await p.reload({ waitUntil: 'domcontentloaded' });
		await p.waitForTimeout(500);
		assert.equal(await p.$('.np-prompt'), null, 'the dismissed banner came back on reload');
		const mode = await p.evaluate(() => localStorage.getItem('vinx.vm.relay'));
		assert.equal(mode, null, `staying LAN-only changed the network anyway: ${mode}`);

		// "Go online" persists the public wsproxy relay and restarts the page.
		const q = await goCtx.newPage();
		await q.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'domcontentloaded' });
		await q.waitForSelector('.np-prompt', { timeout: 10_000 });
		await q.click('.np-prompt-go');
		const relay = await q.evaluate(() => localStorage.getItem('vinx.vm.relay'));
		assert.equal(relay, 'wss://relay.widgetry.org/', `one click stored: ${relay}`);
	} finally {
		await stayCtx.close();
		await goCtx.close();
	}
});

test('the pane iframe delegates every permission the pane uses', async () => {
	// Chrome's Local Network Access taught the lesson: a permissions-policy
	// feature missing from the frame's allow attribute fails *silently* (an
	// intranet relay WebSocket just hangs). Keep the full grant list pinned.
	const ctx = await browser.newContext();
	await muteNetPrompt(ctx);
	const p = await ctx.newPage();
	try {
		await p.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'domcontentloaded' });
		await p.waitForSelector('iframe[name="pane-1"]', { timeout: 10_000 });
		const allow = await p.getAttribute('iframe[name="pane-1"]', 'allow');
		for (const feature of [
			'local-network-access',
			'clipboard-read',
			'clipboard-write',
			'serial',
			'bluetooth',
			'camera',
			'autoplay',
		]) {
			assert.ok(allow.includes(feature), `the pane iframe no longer delegates ${feature}: ${allow}`);
		}
	} finally {
		await ctx.close();
	}
});

test('the network panel reports an unreachable relay before saving', async () => {
	const ctx = await browser.newContext();
	await muteNetPrompt(ctx);
	const p = await ctx.newPage();
	try {
		await p.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
		const frame = await paneFrame(p);
		await frame.click('.np-chip');
		await frame.click('.np-opt-wsproxy input[type="radio"]');
		await frame.fill('.np-opt-wsproxy .np-url', 'ws://127.0.0.1:9/');
		await frame.click('.np-opt-wsproxy .np-probe');
		await frame.waitForSelector('.np-opt-wsproxy .np-probe-status.bad', { timeout: 10_000 });
		const message = await frame.textContent('.np-opt-wsproxy .np-probe-status');
		assert.ok(message.trim().startsWith('✗'), `relay failure was not explained: ${message}`);
	} finally {
		await ctx.close();
	}
});

test('the network chip marks a running VM whose relay is disconnected', async () => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const ctx = await browser.newContext();
	await muteNetPrompt(ctx);
	const p = await ctx.newPage();
	try {
		const url = new URL('terminal/', APP_URL);
		url.searchParams.set('relay', 'ws://127.0.0.1:9/');
		await p.goto(url.href, { waitUntil: 'networkidle' });
		const frame = await paneFrame(p);
		await vmReady(frame);
		await frame.waitForSelector('.np-chip.np-relay-down', { timeout: 15_000 });
		assert.match(
			await frame.getAttribute('.np-chip', 'title'),
			/(disconnected|断开)/i,
			'the down chip did not explain the relay failure',
		);
	} finally {
		await ctx.close();
	}
});

test('the Bridge LAN card hides until vinx.bridge.ui opts back in', async () => {
	// A context without the flag: the network settings offer three modes and
	// no bridge card — the machinery stays, only the doorway is gone.
	const ctx = await browser.newContext();
	await muteNetPrompt(ctx);
	const p = await ctx.newPage();
	try {
		await p.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
		const frame = await paneFrame(p);
		await frame.click('.np-chip');
		await frame.waitForSelector('.np-opt-host', { timeout: 10_000 });
		assert.equal(await frame.$('.np-opt-bridge'), null, 'the bridge card rendered without the flag');
		assert.equal(await frame.$('.np-manage-bridge'), null, 'the manage button rendered without the flag');
	} finally {
		await ctx.close();
	}
});

test('a hand-carried bridge joins two LANs: ping, roster and say, no relay', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Two browser contexts are two people: separate storage, separate
	// BroadcastChannels — their VMs cannot see each other until bridged.
	// The codes travel through this script, standing in for the chat or
	// email that carries them between real people.
	const ctxB = await browser.newContext();
	await muteNetPrompt(ctxB);
	await enableBridgeUi(ctxB);
	const pageA = await context.newPage();
	const pageB = await ctxB.newPage();
	try {
		await pageA.goto(new URL('terminal/', APP_URL).href, {
			waitUntil: 'networkidle',
		});
		await pageB.goto(new URL('terminal/', APP_URL).href, {
			waitUntil: 'networkidle',
		});
		const frameA = await paneFrame(pageA);
		const frameB = await paneFrame(pageB);
		await Promise.all([vmReady(frameA), vmReady(frameB)]);
		await frameUntil(frameA, (t) => /#\s*$/.test(t), 'a prompt on A');
		await frameUntil(frameB, (t) => /#\s*$/.test(t), 'a prompt on B');

		// B's address, printed where the screen scrape can pick it up.
		await frameType(
			pageB,
			frameB,
			"ifconfig eth0 | sed -n 's/.*inet addr:\\([0-9.]*\\).*/MY-IP=\\1/p'",
		);
		const ipText = await frameUntil(frameB, (t) => /MY-IP=10\./.test(t), "B's IP");
		const ipB = ipText.match(/MY-IP=(10\.[0-9.]+)/)[1];

		// A mints the invite in the bridge panel: reached through the network
		// settings' "Bridge LAN" card (its "Manage bridge…" button swaps the
		// dialogs), and the hand-carried pair is the "manual" card next to
		// the default room-code card...
		await frameA.click('.np-chip');
		await frameA.click('.np-opt-bridge input');
		await frameA.click('.np-manage-bridge');
		await frameA.click('.np-sig-manual input');
		await frameA.click('.np-bridge-create');
		await frameA.waitForFunction(
			() => document.querySelector('.np-bridge-code')?.value.length > 0,
			null,
			{ timeout: 15_000 },
		);
		const invite = await frameA.inputValue('.np-bridge-code');

		// ...B answers it...
		await frameB.click('.np-chip');
		await frameB.click('.np-opt-bridge input');
		await frameB.click('.np-manage-bridge');
		await frameB.click('.np-sig-manual input');
		await frameB.click('.np-bridge-join');
		await frameB.fill('.np-bridge-paste', invite);
		await frameB.click('.np-bridge-answer');
		await frameB.waitForFunction(
			() => document.querySelector('.np-bridge-code')?.value.length > 0,
			null,
			{ timeout: 15_000 },
		);
		const answer = await frameB.inputValue('.np-bridge-code');

		// ...and A completes. Both panels report the bridge up.
		await frameA.fill('.np-bridge-paste', answer);
		await frameA.click('.np-bridge-connect');
		await frameA.waitForSelector('.np-bridge-status.on', { timeout: 30_000 });
		await frameB.waitForSelector('.np-bridge-status.on', { timeout: 30_000 });
		await frameA.click('.np-backdrop', { position: { x: 5, y: 5 } });
		await frameB.click('.np-backdrop', { position: { x: 5, y: 5 } });

		// One segment now: A pings B across the bridge.
		await frameType(pageA, frameA, `ping -c 2 ${ipB}`);
		await frameUntil(
			frameA,
			(t) => /2 packets received/.test(t),
			'the ping replies from the far LAN',
			60_000,
		);

		// The hand-carried pair is the same room underneath: the guest's
		// bridge(1) sees a roster, and `bridge say` floats danmaku — exactly
		// as if the SDP had travelled through a relay.
		await frameType(pageA, frameA, 'bridge show');
		await frameUntil(
			frameA,
			(t) => /room manual .* 2 machine/.test(t),
			"A's bridge show names the manual room and both machines",
			30_000,
		);
		await frameType(pageA, frameA, 'bridge say carried-by-hand-still-floats');
		await frameUntil(frameA, (t) => /bridge: sent/.test(t), "A's send receipt", 20_000);
		await pageB.waitForFunction(
			(needle) => (document.querySelector('.danmaku')?.textContent ?? '').includes(needle),
			'carried-by-hand-still-floats',
			{ timeout: 30_000 },
		);
	} finally {
		if (!pageA.isClosed()) await pageA.close();
		await ctxB.close();
	}
});

/**
 * A NIP-01 relay in miniature: REQ subscribes (kinds and #d filters), EVENT
 * fans out to every matching subscription — including the sender's own, as
 * real relays do; the client filters by pubkey. Nothing is stored: the
 * bridge only uses ephemeral events, so neither does the real network.
 */
async function startMockRelay() {
	const { WebSocketServer } = await import('ws');
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	const subs = new Map(); // socket -> Map(subId -> filter)
	wss.on('connection', (ws) => {
		const mine = new Map();
		subs.set(ws, mine);
		ws.on('message', (data) => {
			let msg;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg[0] === 'EVENT') {
				const ev = msg[1];
				ws.send(JSON.stringify(['OK', ev.id, true, '']));
				for (const [sock, m] of subs) {
					for (const [sid, f] of m) {
						if (f.kinds && !f.kinds.includes(ev.kind)) continue;
						const d = f['#d'];
						if (d && !ev.tags.some((t) => t[0] === 'd' && d.includes(t[1]))) continue;
						sock.send(JSON.stringify(['EVENT', sid, ev]));
					}
				}
			} else if (msg[0] === 'REQ') {
				mine.set(msg[1], msg[2] ?? {});
				ws.send(JSON.stringify(['EOSE', msg[1]]));
			} else if (msg[0] === 'CLOSE') {
				mine.delete(msg[1]);
			}
		});
		ws.on('close', () => subs.delete(ws));
	});
	await new Promise((r) => wss.on('listening', r));
	return {
		url: `ws://127.0.0.1:${wss.address().port}`,
		close: () => wss.close(),
	};
}

test('a room code bridges three browsers, and bridge say floats across them', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The default flow, driven entirely from the guests' consoles: A types
	// `bridge start`, reads the room code "aloud" (this script carries it),
	// B and C type `bridge join`. Signalling goes through a local stand-in
	// for the public Nostr relays, injected via the same localStorage key
	// the panel's advanced fold writes. Three parties on purpose: B↔C
	// traffic exercises the host's learning switch, not just the A↔B leg.
	const relay = await startMockRelay();
	const ctxB = await browser.newContext();
	const ctxC = await browser.newContext();
	await muteNetPrompt(ctxB);
	await muteNetPrompt(ctxC);
	// B2's refused-second-bridge check walks in through the panel UI.
	await enableBridgeUi(ctxB);
	await context.addInitScript((url) => localStorage.setItem('vinx.bridge.relays', url), relay.url);
	await ctxB.addInitScript((url) => localStorage.setItem('vinx.bridge.relays', url), relay.url);
	await ctxC.addInitScript((url) => localStorage.setItem('vinx.bridge.relays', url), relay.url);
	const pageA = await context.newPage();
	const pageB = await ctxB.newPage();
	const pageC = await ctxC.newPage();
	try {
		await pageA.goto(new URL('terminal/', APP_URL).href, {
			waitUntil: 'networkidle',
		});
		await pageB.goto(new URL('terminal/', APP_URL).href, {
			waitUntil: 'networkidle',
		});
		await pageC.goto(new URL('terminal/', APP_URL).href, {
			waitUntil: 'networkidle',
		});
		const frameA = await paneFrame(pageA);
		const frameB = await paneFrame(pageB);
		const frameC = await paneFrame(pageC);
		await Promise.all([vmReady(frameA), vmReady(frameB), vmReady(frameC)]);
		await frameUntil(frameA, (t) => /#\s*$/.test(t), 'a prompt on A');
		await frameUntil(frameB, (t) => /#\s*$/.test(t), 'a prompt on B');
		await frameUntil(frameC, (t) => /#\s*$/.test(t), 'a prompt on C');

		// A hosts. network.bridge.start blocks until the room is on and
		// answers the code; the script prints the join line, plus the
		// pointer at `bridge say`.
		await frameType(pageA, frameA, 'bridge start');
		const started = await frameUntil(
			frameA,
			(t) => /bridge join [a-z2-9]{6}/.test(t) && /bridge say/.test(t),
			'the room code and the say hint',
			60_000,
		);
		const code = started.match(/bridge join ([a-z2-9]{6})/)[1];

		// B joins by code alone — no pasting — and its `show` names the host.
		// The machine count can land a beat before the roster rows do, so the
		// wait insists on the host line too — the matches below must not null.
		await frameType(pageB, frameB, `bridge join ${code}`);
		const joined = await frameUntil(
			frameB,
			(t) => /\b2 machine/.test(t) && /\S+\s+10\.0\.2\.\d+\s+host/.test(t),
			'B joined and saw a 2-machine roster with the host row',
			90_000,
		);
		const ipA = joined.match(/(10\.0\.2\.\d+)\s+host/)[1];

		// C joins the same code: three machines, one segment, star topology.
		await frameType(pageC, frameC, `bridge join ${code}`);
		const joinedC = await frameUntil(
			frameC,
			(t) => /\b3 machine/.test(t) && /\*\s+\S+\s+10\.0\.2\.\d+/.test(t),
			'C joined and saw a 3-machine roster with its own row',
			90_000,
		);
		const ipC = joinedC.match(/\*\s+\S+\s+(10\.0\.2\.\d+)/)[1];

		// The host's roster agrees (the control plane reached every side).
		await frameType(pageA, frameA, 'bridge show');
		await frameUntil(frameA, (t) => /\b3 machine/.test(t), "A's roster shows 3 machines", 30_000);

		// Member-to-member traffic transits the host's learning switch: the
		// first ping floods, the replies teach it, and it keeps working.
		await frameType(pageB, frameB, `ping -c 2 ${ipC}`);
		await frameUntil(
			frameB,
			(t) => /2 packets received/.test(t),
			'B pinged C through the host switch',
			60_000,
		);

		// Chat is the bridge's own: `bridge say` floats the words across
		// every member's window as danmaku, drawn by the page — no client,
		// no console tty in the path at all. The receiving keyboards are
		// never touched between the send and the assertion: delivery must
		// render on its own. (The overlay lives in the top shell document —
		// the bridge runs in the pane iframe and posts across a
		// BroadcastChannel — so the assertions look at the page, not the
		// frame.)
		const sawIt = (p, what) =>
			p.waitForFunction(
				(needle) => (document.querySelector('.danmaku')?.textContent ?? '').includes(needle),
				what,
				{ timeout: 30_000 },
			);
		await frameType(pageA, frameA, 'bridge say hello-everyone-on-the-bridge');
		await frameUntil(frameA, (t) => /bridge: sent/.test(t), "A's send receipt", 20_000);
		// The sender's echo first — it appears instantly, and a floated line
		// only lives ~10s, so the checks run in arrival order.
		await sawIt(pageA, 'hello-everyone-on-the-bridge');
		await sawIt(pageB, 'hello-everyone-on-the-bridge');
		await sawIt(pageC, 'hello-everyone-on-the-bridge');

		// A whisper (`say @name`) reaches its addressee alone. B read the
		// host's name off its own roster; C, delivered in the same fanout
		// loop as A, gets a beat past A's arrival to prove silence.
		const nameA = joined.match(/(\S+)\s+10\.0\.2\.\d+\s+host/)[1];
		await frameType(pageB, frameB, `bridge say @${nameA} just-for-the-host`);
		await sawIt(pageA, 'just-for-the-host');
		await pageC.waitForTimeout(3000);
		const leaked = await pageC.evaluate(
			() => document.querySelector('.danmaku')?.textContent ?? '',
		);
		assert.ok(!leaked.includes('just-for-the-host'), `the whisper leaked to C: ${leaked}`);

		// The footer chip wears the bridge.
		const chip = await frameA.textContent('.np-chip');
		assert.ok(chip.includes('⇄'), `the chip shows no bridge marker: ${chip}`);

		// A second bridge on an origin that already runs one is refused: a
		// host bridge here and a member bridge there would loop one frame
		// through the shared hub forever. The Web Lock says no politely.
		const pageB2 = await ctxB.newPage();
		try {
			await pageB2.goto(new URL('terminal/', APP_URL).href, {
				waitUntil: 'networkidle',
			});
			const frameB2 = await paneFrame(pageB2);
			await frameB2.click('.np-chip');
			await frameB2.click('.np-opt-bridge input');
			await frameB2.click('.np-manage-bridge');
			await frameB2.click('.np-room-join');
			await frameB2.fill('.np-room-code-input', code);
			await frameB2.click('.np-room-go');
			await frameB2.waitForSelector('.np-err', { timeout: 15_000 });
			const err = await frameB2.textContent('.np-err');
			assert.ok(
				err.includes('another tab'),
				`the second bridge was not refused with the lock message: ${err}`,
			);
		} finally {
			await pageB2.close();
		}

		const shot = resolve(import.meta.dirname, '../../build/bridge-room-e2e.png');
		await mkdir(dirname(shot), { recursive: true });
		await pageA.screenshot({ path: shot, fullPage: false });

		// Disconnect from the console too, and the status file follows.
		await frameType(pageA, frameA, 'bridge stop');
		await frameUntil(frameA, (t) => /bridge: disconnected/.test(t), 'A stopped its bridge', 20_000);
	} finally {
		relay.close();
		if (!pageA.isClosed()) await pageA.close();
		await ctxB.close();
		await ctxC.close();
	}
});

test('read_terminal lets the panel read the screen', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameType(page, frame, 'echo SCREEN-MARK-1337');
	await frameUntil(frame, (t) => t.includes('SCREEN-MARK-1337'), 'the marker');

	// Wake the pane's own engine (the panel is lazy) and wait for its shim.
	await frame.click('.ai-fab');
	const deadline = Date.now() + 60_000;
	for (;;) {
		const ok = await frame
			.evaluate(() =>
				fetch('/api/chat/meta')
					.then((r) => r.ok)
					.catch(() => false),
			)
			.catch(() => false);
		if (ok) break;
		if (Date.now() > deadline) throw new Error('the pane engine never came up');
		await new Promise((r) => setTimeout(r, 200));
	}

	await frame.evaluate(
		([url, model]) =>
			fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					base_url: url,
					model,
					api_key: 'k',
					enabled: true,
				}),
			}).then((r) => r.json()),
		[MOCK_LLM_URL, 'mock-read-terminal'],
	);
	await frame.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: 'what is on my screen?',
				session_id: 'rt-e2e',
			}),
		}).then((r) => r.json()),
	);
	const sse = await frame.evaluate(async (id) => {
		const res = await fetch(`/api/chat/stream/${encodeURIComponent(id)}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let out = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value, { stream: true });
			if (/event: (done|error|confirm)\b/.test(out)) break;
		}
		return out;
	}, 'rt-e2e');
	assert.ok(
		!events(sse).includes('confirm'),
		`read_terminal is safe and must not raise the gate: ${events(sse)}`,
	);
	assert.ok(
		text(sse).includes('SCREEN-MARK-1337'),
		`the screen content did not reach the model: ${text(sse).slice(0, 300)}`,
	);
});

test('the /data quota refuses a drop that would blow past it', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);

	// 60 MB of standing mirror, planted directly in IndexedDB (writing it
	// through the VM would be slow and prove nothing extra here).
	await frame.evaluate(async () => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open('vinx.vm');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await new Promise((resolve, reject) => {
			const t = db.transaction('share', 'readwrite');
			const s = t.objectStore('share');
			for (let i = 0; i < 4; i++) s.put(new Uint8Array(15 << 20).buffer, `p1/quota-filler-${i}`);
			t.oncomplete = resolve;
			t.onerror = () => reject(t.error);
		});
	});

	await frame.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File([new Uint8Array(6 << 20)], 'straw.bin'));
		document.querySelector('.pane').dispatchEvent(
			new DragEvent('drop', {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer,
			}),
		);
	});
	await frame.waitForFunction(
		() => document.querySelector('.drop-note')?.textContent?.includes('exceed'),
		null,
		{ timeout: 20_000 },
	);

	// Clean up, or every later reload replays 60 MB into the guest.
	await frame.evaluate(async () => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open('vinx.vm');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await new Promise((resolve, reject) => {
			const t = db.transaction('share', 'readwrite');
			const s = t.objectStore('share');
			for (let i = 0; i < 4; i++) s.delete(`p1/quota-filler-${i}`);
			t.oncomplete = resolve;
			t.onerror = () => reject(t.error);
		});
	});
});

test('the console speaks UTF-8: banner, Chinese typed in, Chinese filenames', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Still on the terminal shell. `exec sh -l` re-runs the login profile in
	// place — same process, same tty, no init/getty respawn to race — and the
	// `clear` first makes the fresh banner the only one on the screen.
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	await frameType(page, frame, 'clear && exec sh -l');
	await frameUntil(
		frame,
		(t) => t.includes('vinx linux') && /#\s*$/.test(t),
		'the login banner and a fresh prompt',
	);

	// Typed CJK crosses xterm -> UTF-8 -> UART -> ash and echoes back whole.
	// The `$n` indirection means the *only* place 你好.txt can appear on
	// screen is ls output, and the split marker (CJK-D''ONE types as itself
	// but *prints* joined) means the wait matches output, not the echo of
	// the command being typed.
	await frameType(page, frame, 'n=你好; touch "/tmp/$n.txt" && ls /tmp && echo CJK-D\'\'ONE');
	const listed = await frameUntil(frame, (t) => /CJK-DONE/.test(t), 'the CJK round trip');
	assert.match(listed, /你好\.txt/, 'the Chinese filename did not survive to ls output');
	assert.ok(!/\?\?\?/.test(listed), `ls printed ? for the CJK name:\n${listed}`);
});

test('imgcat(1) puts a decoded image on the screen', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	// A 1x1 PNG, decoded in the guest, sent back as OSC 1337 inline=1. The
	// image addon's storageUsage moves off zero only when a payload really
	// decoded into pixels.
	const png =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
	await frameType(page, frame, `echo ${png} | base64 -d > /tmp/dot.png && imgcat /tmp/dot.png`);
	await frame.waitForFunction(() => (window.vinxImages?.storageUsage ?? 0) > 0, null, {
		timeout: 30_000,
	});
	// -w pins a width in cells; the addon stores the resized bitmap, so a
	// 4-cell-wide copy of the same 1x1 PNG must grow the storage — proof the
	// width field survived the trip and was honoured.
	const first = await frame.evaluate(() => window.vinxImages.storageUsage);
	await frameType(page, frame, 'imgcat -w 4 /tmp/dot.png');
	await frame.waitForFunction((before) => (window.vinxImages?.storageUsage ?? 0) > before, first, {
		timeout: 30_000,
	});
});

test('download(1) at the prompt lands as a browser download', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
	// Handled early: if a step before the await throws first, this pending
	// wait times out later as an unhandled rejection and kills the whole
	// run — the one test's failure is enough. (Every waitForEvent below
	// carries the same line.)
	downloadPromise.catch(() => {});
	await frameType(page, frame, 'printf from-the-vm > /tmp/out.bin && download /tmp/out.bin');
	const download = await downloadPromise;
	assert.match(download.suggestedFilename(), /^out\.bin$/);
	const body = await readFile(await download.path(), 'utf8');
	assert.equal(body, 'from-the-vm', 'the downloaded bytes are not the guest file');
});

test('open(1) hands a file to the browser, which renders it', async (page, context) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	// Playwright disables the popup blocker, so the window.open goes through
	// (a blocked one would park on the .open-chip instead).
	const popupPromise = page.waitForEvent('popup', { timeout: 60_000 });
	popupPromise.catch(() => {});
	await frameType(
		page,
		frame,
		`printf '<h1>vm-page-render</h1>' > /tmp/t.html && open /tmp/t.html`,
	);
	const popup = await popupPromise;
	try {
		await popup.waitForLoadState('domcontentloaded');
		assert.match(popup.url(), /^blob:/, 'open(1) did not open a typed blob URL');
		const heading = await popup.textContent('h1');
		assert.equal(heading, 'vm-page-render', 'the browser did not render the HTML');
	} finally {
		if (!popup.isClosed()) await popup.close();
	}
});

test('open(1) on an opaque type downloads under its own name', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	// The browser cannot render octet-stream, so open(1) routes it through
	// the <a download> path — a navigated blob URL would land as a UUID; this
	// way the file keeps its name.
	const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
	downloadPromise.catch(() => {});
	await frameType(
		page,
		frame,
		'printf raw-bytes > /tmp/keep-my-name.bin && open /tmp/keep-my-name.bin',
	);
	const download = await downloadPromise;
	assert.equal(
		download.suggestedFilename(),
		'keep-my-name.bin',
		'open(1) lost the filename on the download path',
	);
	const body = await readFile(await download.path(), 'utf8');
	assert.equal(body, 'raw-bytes', 'the downloaded bytes are not the guest file');
});

test('vim(1) round-trips Chinese text', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	// vi is the real vim now (busybox's applet, which drew CJK by bytes and
	// sheared the screen, is compiled out). Insert a Chinese line, check the
	// *screen* shows it whole, save, and read the file back at the prompt.
	await frame.click('.screen .xterm-screen');
	await page.keyboard.type('vi /tmp/cjk-note.txt');
	await page.keyboard.press('Enter');
	// "[New]" is the status line of a displayed buffer. E1187 is the failure
	// mode this guards: no user vimrc makes vim chase the runtime's
	// defaults.vim, which the image does not carry — /root/.vimrc (overlay)
	// exists precisely to stop that.
	const opened = await frameUntil(frame, (t) => /\[New\]|E1187/.test(t), 'vim with the file open');
	assert.ok(!opened.includes('E1187'), 'vim stumbled over the missing defaults.vim');
	await page.keyboard.press('i');
	await page.keyboard.type('中文编辑无错位');
	await frameUntil(
		frame,
		(t) => t.includes('中文编辑无错位'),
		'the inserted CJK shown contiguously',
	);
	await page.keyboard.press('Escape');
	await page.keyboard.type(':wq');
	await page.keyboard.press('Enter');
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'the prompt back from vim');
	await frameType(page, frame, "cat /tmp/cjk-note.txt && echo VIM-D''ONE");
	const shown = await frameUntil(frame, (t) => /VIM-DONE/.test(t), 'the vim round trip');
	assert.match(shown, /中文编辑无错位/, 'the CJK line did not survive vim :wq');
});

test('lua runs 64-bit, and tcc embeds it', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	// Standard Lua semantics were chosen on purpose (LUA_32BITS off): a
	// 64-bit maxinteger is the tell. The echoed command has "64bit" inside
	// quotes after `and`, so the bare `lua<tab>64bit` only comes from print.
	await frameType(
		page,
		frame,
		`lua -e 'print("lua", math.maxinteger > 2^32 and "64bit" or "32bit")' && echo LUA-D''ONE`,
	);
	const luaOut = await frameUntil(frame, (t) => /LUA-DONE/.test(t), 'the lua one-liner');
	assert.match(luaOut, /lua\s+64bit/, 'lua is missing, or built with 32-bit numbers');

	// The embedding leg — the whole point of shipping liblua.so and the lua
	// headers: tcc compiles a host that boots a lua_State and runs a chunk.
	// Lua long brackets keep single quotes out of the C string, and the
	// [[embedded-]]..[[lua-ok]] split keeps the marker out of the echo.
	await frameType(
		page,
		frame,
		`printf '#include <lauxlib.h>\\n#include <lualib.h>\\nint main(){lua_State*L=luaL_newstate();luaL_openlibs(L);luaL_dostring(L,"print([[embedded-]]..[[lua-ok]])");lua_close(L);return 0;}\\n' > /tmp/host.c && tcc /tmp/host.c -llua -o /tmp/host && /tmp/host && echo EMB-D''ONE`,
	);
	const embOut = await frameUntil(
		frame,
		(t) => /EMB-DONE/.test(t),
		'the tcc-embeds-lua round trip',
	);
	assert.match(embOut, /embedded-lua-ok/, 'the tcc-compiled host did not run the lua chunk');
});

test('read_file skips the gate; write_file stops at it', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Back to the chat page; its pre-boot brings the VM up.
	await page.goto(APP_URL, { waitUntil: 'networkidle' });
	await ready(page);
	await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 120_000,
	});

	await configure(page, 'mock-read-file');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'read it', session_id: 'safe-read' }),
		}).then((r) => r.json()),
	);
	const safe = await attach(page, 'safe-read');
	assert.ok(
		!events(safe).includes('confirm'),
		`read_file is safe and must not raise the gate: ${events(safe)}`,
	);
	assert.ok(
		text(safe).includes('vinx'),
		`the file content did not reach the model: ${text(safe).slice(0, 300)}`,
	);

	await configure(page, 'mock-write-file');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'write it', session_id: 'gated-write' }),
		}).then((r) => r.json()),
	);
	const gated = await attach(page, 'gated-write');
	assert.ok(
		events(gated).includes('confirm'),
		`write_file did not raise the confirmation gate: ${events(gated)}`,
	);
	assert.ok(gated.includes('write_file'), 'the gated call was not write_file');
});

test('download_file hands the bytes to the browser', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Still on the chat page with a ready VM from the previous test.
	await configure(page, 'mock-download');
	const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
	downloadPromise.catch(() => {});
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: 'give me the file',
				session_id: 'dl-e2e',
			}),
		}).then((r) => r.json()),
	);
	const download = await downloadPromise;
	// Chromium may still append a sniffed extension on some platforms.
	assert.match(download.suggestedFilename(), /^hostname(\.\w+)?$/);
	const file = await download.path();
	const body = await readFile(file, 'utf8');
	assert.match(body, /vinx/, 'the downloaded bytes are not the guest file');
	await attach(page, 'dl-e2e'); // drain the stream so the next test starts clean
});

/** Attach, approving the one confirm on the way, until done/error or budget. */
/** Attach and approve every confirmation the turn raises — each by its own
 * call id, so a multi-step turn (the app builder: several run_shell calls)
 * runs to its end the way a person clicking "allow" each time would. */
function attachApproving(page, sessionId, budget = 120_000) {
	return page.evaluate(
		async ([id, BUDGET]) => {
			const res = await fetch(`/api/chat/stream/${encodeURIComponent(id)}`);
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			const start = Date.now();
			let out = '';
			const approved = new Set();
			for (;;) {
				const left = BUDGET - (Date.now() - start);
				if (left <= 0) break;
				const step = await Promise.race([
					reader.read(),
					new Promise((r) => setTimeout(() => r({ timeout: true }), left)),
				]);
				if (step.timeout || step.done) break;
				out += decoder.decode(step.value, { stream: true });
				for (const m of out.matchAll(/event: confirm\ndata: (.+)/g)) {
					const callId = JSON.parse(m[1]).id ?? null;
					if (approved.has(callId)) continue;
					approved.add(callId);
					await fetch('/api/chat/confirm', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							session_id: id,
							id: callId,
							confirmed: true,
						}),
					});
				}
				if (/event: (done|error)\b/.test(out)) break;
			}
			return out;
		},
		[sessionId, budget],
	);
}

test('an approved write_file lands in a directory that did not exist', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Still on the chat page with a ready VM. The mock asks for
	// /tmp/wf dir/wf.txt — a fresh directory with a space in it — so the
	// "wrote N bytes" result proves the tool created the parents in the real
	// guest instead of failing the way it used to.
	await configure(page, 'mock-write-nested');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'write it', session_id: 'wf-nested' }),
		}).then((r) => r.json()),
	);
	const sse = await attachApproving(page, 'wf-nested');
	assert.ok(!events(sse).includes('error'), `the write turn errored: ${sse.slice(0, 500)}`);
	assert.ok(
		/wrote 16 bytes/.test(text(sse)),
		`write_file did not report success: ${text(sse).slice(0, 300)}`,
	);
});

test('the chat builds an app of each kind: the scripted agent’s loop lands, and write_file keeps a script executable', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The §13 loop as the model runs it — `app new`, write_file over the
	// scaffold's file, `app check --json`, pack+install, run/start, `app
	// list` — for a web app, a service and a command (mock-app-builder
	// follows that plan, one tool call per turn). The service and the
	// command rewrite `run` with write_file; that used to replace the inode
	// and drop the exec bit `app new` had set, so `app check` failed on
	// ENTRY_NOT_EXEC over a file the model had just edited in front of it.
	// putFile now carries an existing file's mode across the rewrite.
	// The chat page, whatever the previous test left showing (the terminal
	// page keeps its machine in a pane frame, not on the document).
	if (!page.url().startsWith(APP_URL) || page.url().includes('/terminal')) {
		await page.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(page);
	}
	await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 180_000,
	});
	await configure(page, 'mock-app-builder');
	try {
		for (const [ask, id, kind, state] of [
			['web app', 'bld-web', 'window', 'stopped'],
			['service', 'bld-svc', 'service', 'running'],
			['command', 'bld-cmd', 'command', 'stopped'],
		]) {
			await page.evaluate(
				([m, s]) =>
					fetch('/api/chat', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ message: m, session_id: s }),
					}).then((r) => r.json()),
				[`make me a ${ask} named ${id}`, `build-${id}`],
			);
			const sse = await attachApproving(page, `build-${id}`, 240_000);
			assert.ok(!events(sse).includes('error'), `the ${id} build errored: ${text(sse).slice(0, 400)}`);
			if (id === 'bld-web') {
				// `app check --json` ran mid-loop; its findings travelled back
				// to the model as a tool result, which the stream carries.
				const results = [...sse.matchAll(/^event: tool_result\ndata: (.+)$/gm)].map((m) => String(JSON.parse(m[1]).result ?? ''));
				const check = results.find((r) => r.includes('"warnings"')) ?? '';
				assert.match(check, /HTML_EXTERNAL_REF/, `app check did not flag the page-shaped index.html:\n${check.slice(0, 500)}`);
				assert.match(check, /JS_SANDBOX_API/, `app check did not flag localStorage in app.js:\n${check.slice(0, 500)}`);
				assert.match(check, /"ok":\s*true/, `warnings must not fail the check:\n${check.slice(0, 300)}`);
			}
			const said = text(sse);
			assert.match(said, /app list said/, `the ${id} build did not reach its last step:\n${said.slice(0, 400)}`);
			assert.ok(
				said.includes(`"id":"${id}","kind":"${kind}","size":`) && said.includes(`"id":"${id}"`),
				`${id} is not installed as a ${kind} after the model's loop:\n${said.slice(0, 600)}`,
			);
			assert.match(
				said,
				new RegExp(`"id":"${id}","kind":"${kind}","size":\\d+,"state":"${state}"`),
				`${id} did not end in state ${state}:\n${said.slice(0, 600)}`,
			);
		}
		// The web app's window came up from `app run`, showing the file the
		// model wrote (not the scaffold's) — written as a whole page with a
		// <link> and a <script src>, and an app.js on localStorage: the
		// contract broken the way a model breaks it. The shell unwraps the
		// page and drops the references (the css/js are injected anyway),
		// and stands in a per-window storage, so the window works; `app
		// check` named both habits as warnings on the way.
		await page.waitForSelector('iframe.app-frame', { timeout: 15_000 });
		const appFrame = page.frames().find((f) => f.url().startsWith(APP_FRAME_URL));
		assert.ok(appFrame, 'the web app window never attached');
		await appFrame.waitForSelector('#marker', { timeout: 15_000 });
		assert.equal(await appFrame.textContent('#marker'), 'built-by-the-model');
		assert.match(
			(await appFrame.textContent('#title')) ?? '',
			/hello from bld-web #1/,
			'app.js did not run (its localStorage line would have thrown in a bare sandbox)',
		);
		assert.equal(await appFrame.locator('link[rel=stylesheet], script[src]').count(), 0, 'external refs survived into the frame');
		// And the Apps page sees all three with their kinds.
		const listed = await page.evaluate(() => fetch('/api/releases?kind=app').then((r) => r.json()));
		const kinds = Object.fromEntries(listed.releases.map((r) => [r.name, r.app_kind]));
		assert.deepEqual(
			{ 'bld-web': kinds['bld-web'], 'bld-svc': kinds['bld-svc'], 'bld-cmd': kinds['bld-cmd'] },
			{ 'bld-web': 'window', 'bld-svc': 'service', 'bld-cmd': 'command' },
			`the Apps page's kinds: ${JSON.stringify(kinds)}`,
		);
	} finally {
		// Leave the shared machine as found; the window too — an app frame
		// left floating over the page intercepts the clicks of every test
		// after this one.
		await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await page.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(
			page,
			page,
			"for a in bld-web bld-svc bld-cmd; do app stop $a >/dev/null 2>&1; app remove $a >/dev/null 2>&1; done; rm -rf /data/work/bld-*; echo BLD-CLEAN-D''ONE",
		);
		await frameUntil(page, (t) => /BLD-CLEAN-DONE/.test(t), 'the build cleanup', 60_000);
		await page.locator('[data-testid="vm-console"] .vga-btn').last().click();
		await page.waitForSelector('iframe.app-frame', { state: 'detached', timeout: 15_000 }).catch(() => {});
		assert.equal(await page.locator('iframe.app-frame').count(), 0, 'the build left an app window on the shared page');
	}
});

test('run_shell can call js(1): the captured-stdout path an OSC channel could never serve', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Still on the chat page with a ready VM. The long way round on purpose:
	// engine -> run_shell -> proc.run (rund, stdout captured) -> js(1) ->
	// debug.js back up the same ttyS3 wire -> the page -> all the way back.
	// Since Phase 2 both legs share one link, so this is a live re-entrancy
	// proof: rpcd routes the nested call while the outer one is pending.
	// It is also exactly the leg where escape-sequence commands (imgcat,
	// open) do nothing — stdout capture is what makes js(1) usable here.
	await configure(page, 'mock-js-shell');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'run js via shell', session_id: 'js-shell-e2e' }),
		}).then((r) => r.json()),
	);
	const sse = await attachApproving(page, 'js-shell-e2e');
	assert.ok(!events(sse).includes('error'), `the turn errored: ${sse.slice(0, 500)}`);
	assert.ok(
		text(sse).includes('42'),
		`the js answer did not make the round trip: ${text(sse) || sse.slice(0, 500)}`,
	);
});

test('a chat attachment lands in /data/share/local and the file tools reach it', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// A machine still booting would take the upload (putFile waits for it)
	// and then replay the mirror over it at ready — the same file twice,
	// racing the read below. Not this test's subject: wait for ready.
	await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 180_000,
	});
	// Upload the way the composer does: POST with the name on a header.
	const up = await page.evaluate(() =>
		fetch('/api/chat/upload', {
			method: 'POST',
			headers: {
				'x-file-name': encodeURIComponent('notes from me.txt'),
				'content-type': 'text/plain',
			},
			body: 'attach-body\n',
		}).then((r) => r.json()),
	);
	assert.equal(up.ok ?? true, true, `the upload failed: ${JSON.stringify(up)}`);

	// The shared mirror row appears at once (the guest copy follows).
	{
		const deadline = Date.now() + 20_000;
		for (;;) {
			const found = await page.evaluate(async () => {
				const db = await new Promise((resolve, reject) => {
					const req = indexedDB.open('vinx.vm');
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				const got = await new Promise((resolve) => {
					const t = db.transaction('share', 'readonly');
					const get = t.objectStore('share').getKey('share/local/notes from me.txt');
					get.onsuccess = () => resolve(get.result != null);
					get.onerror = () => resolve(false);
				});
				db.close();
				return got;
			});
			if (found) break;
			if (Date.now() > deadline) throw new Error('the attachment never reached the shared mirror');
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	// And the model's own read_file — which lives on the VM — can open it.
	await configure(page, 'mock-read-shared');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: 'read the attachment',
				session_id: 'att-e2e',
			}),
		}).then((r) => r.json()),
	);
	const sse = await attach(page, 'att-e2e');
	assert.ok(
		!events(sse).includes('confirm'),
		`read_file is safe and must not raise the gate: ${events(sse)}`,
	);
	assert.ok(
		text(sse).includes('attach-body'),
		`the attachment did not reach the VM's filesystem: ${text(sse).slice(0, 300)}`,
	);
});

test('a run_shell command tens of KB long arrives whole', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// 32 KiB of payload in the command: far past the control frame's 4 KiB
	// budget, so the runShell adapter must stage it as a §6.8 scriptRef and
	// rund must run the staged file whole. wc -c saying 32768 means every
	// byte made it and the command really ran — this is the acceptance test
	// for the adapter's auto-staging.
	await configure(page, 'mock-long-shell');
	await page.evaluate(() =>
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: 'count it', session_id: 'long-e2e' }),
		}).then((r) => r.json()),
	);
	const sse = await attachApproving(page, 'long-e2e');
	assert.ok(!events(sse).includes('error'), `the long command errored: ${sse.slice(0, 500)}`);
	assert.ok(
		text(sse).includes('32768'),
		`the command payload did not arrive whole: ${text(sse).slice(0, 300)}`,
	);
});

test('share_local reaches a running terminal at once; plain /data stays private', async (page, context) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Two machines at once: the chat page's VM (still ready from the earlier
	// tests) and a terminal pane in a second tab. The bug this guards: the
	// chat page used to fall back to pane 1's mirror bucket, so the two live
	// VMs fought over one mirror and cross-machine files showed up only
	// after a reload.
	const term = await context.newPage();
	try {
		await term.goto(new URL('terminal/', APP_URL).href, {
			waitUntil: 'networkidle',
		});
		const pane = await paneFrame(term);
		await vmReady(pane);
		await frameUntil(pane, (t) => /#\s*$/.test(t), 'a pane prompt');

		// The model shares /etc/hostname from the chat VM. share_local is
		// safe (the file goes to the person's own tabs), so no gate.
		await configure(page, 'mock-share-local');
		await page.evaluate(() =>
			fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'hand it over', session_id: 'sl-e2e' }),
			}).then((r) => r.json()),
		);
		const sse = await attach(page, 'sl-e2e');
		assert.ok(
			!events(sse).includes('confirm'),
			`share_local is safe and must not raise the gate: ${events(sse)}`,
		);
		assert.ok(
			text(sse).includes('/data/share/local/hostname'),
			`share_local did not report the shared path: ${text(sse).slice(0, 300)}`,
		);

		// No reload anywhere: the tool kicked an immediate snapshot, the
		// BroadcastChannel announced it, and the pane's page wrote it into
		// its own live guest. The wait is generous but the normal case is a
		// second or two — not the 15s interval.
		await frameType(
			term,
			pane,
			"i=0; while [ $i -lt 30 ] && [ ! -f /data/share/local/hostname ]; do i=$((i+1)); sleep 1; done; cat /data/share/local/hostname; echo SL-READ-D''ONE",
		);
		const got = await frameUntil(pane, (t) => /SL-READ-DONE/.test(t), 'the shared read', 60_000);
		assert.match(got, /vinx/, 'the shared file never appeared in the running terminal');

		// The private tier: a write into the chat VM's own /data mirrors
		// under the chat bucket (`c/`), not pane 1's — and never reaches the
		// terminal machine at all.
		await configure(page, 'mock-write-data');
		await page.evaluate(() =>
			fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'keep a note', session_id: 'wd-e2e' }),
			}).then((r) => r.json()),
		);
		const wrote = await attachApproving(page, 'wd-e2e');
		assert.ok(!events(wrote).includes('error'), `the /data write errored: ${wrote.slice(0, 500)}`);

		const bucketKey = (k) =>
			page.evaluate(async (key) => {
				const db = await new Promise((resolve, reject) => {
					const req = indexedDB.open('vinx.vm');
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				const found = await new Promise((resolve) => {
					const t = db.transaction('share', 'readonly');
					const get = t.objectStore('share').getKey(key);
					get.onsuccess = () => resolve(get.result != null);
					get.onerror = () => resolve(false);
				});
				db.close();
				return found;
			}, k);
		{
			const deadline = Date.now() + 45_000;
			while (!(await bucketKey('c/from-chat.txt'))) {
				if (Date.now() > deadline) throw new Error('the chat write never reached the c/ bucket');
				await new Promise((r) => setTimeout(r, 1_000));
			}
		}
		assert.equal(
			await bucketKey('p1/from-chat.txt'),
			false,
			"the chat page's private file leaked into pane 1's bucket",
		);
		await frameType(term, pane, "ls /data/from-chat.txt 2>&1; echo ISO-D''ONE");
		const iso = await frameUntil(pane, (t) => /ISO-DONE/.test(t), 'the isolation ls');
		assert.match(iso, /No such file/, "the chat VM's private /data file appeared in the terminal");
	} finally {
		if (!term.isClosed()) await term.close();
	}
});

test('the machine console opens on this machine: a live shell on the chat VM', async (page) => {
	// Every document is one computer (pane-id.ts). The chat page's machine
	// used to be headless — the agent could use it, the person could not see
	// it. The console opens on the OPEN_VM_CONSOLE_EVENT (what the boot
	// flow and the open_terminal card fire — the capsule's power key took
	// the old mascot button's place, and its running-state click is a
	// power-off, exercised by its own test).
	const panel = page.locator('[data-testid="vm-console"]');
	assert.equal(await panel.isVisible(), false, 'the console panel should start hidden');
	await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
	await panel.waitFor({ state: 'visible', timeout: 10_000 });

	// The identity verdict is public: this document either owns machine `c`
	// or runs an ephemeral one, and either way it says so.
	const identity = await page.evaluate(() => document.documentElement.dataset.vmIdentity);
	assert.ok(
		identity === 'owner' || identity === 'ephemeral',
		`the machine identity is not surfaced on the chat page: ${identity}`,
	);

	// The machine capsule holds every control — power, terminal, screen,
	// network — one pill, four segments; the console title bar carries only
	// the machine's state. The power segment wears the running state; the
	// network segment opens the network panel (backdrop click closes it,
	// leaving the page as it was).
	assert.equal(
		await page.locator('.np-fab .np-fab-seg').count(),
		4,
		'the capsule should hold power, terminal, screen and network segments',
	);
	await page.click('.np-fab-net');
	await page.waitForSelector('.np-panel', { timeout: 10_000 });
	await page.click('.np-backdrop', { position: { x: 8, y: 8 } });
	await page.waitForSelector('.np-panel', { state: 'detached', timeout: 10_000 });

	// The console is the same machine the agent drives: type at the shell and
	// read the answer back. The VM pre-boots at page load, and by this point
	// in the suite it has long been ready. The quote split keeps the match
	// from triggering on the echoed command line itself.
	await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 120_000,
	});
	assert.equal(
		await page.locator('.np-fab-power').getAttribute('data-state'),
		'ready',
		'the power segment should wear the running machine state',
	);
	await frameType(page, page, "echo chat-console-al''ive");
	await frameUntil(page, (t) => /chat-console-alive/.test(t), 'the echo in the machine console');

	// Closing hides the panel; the machine (and the xterm behind the panel)
	// keeps running for the next test. The console is a DesktopWindow now:
	// its close button is the chrome's last .vga-btn.
	await page.locator('[data-testid="vm-console"] .vga-btn').last().click();
	assert.equal(await panel.isVisible(), false, 'the close button did not hide the panel');
});

test('a popup-blocked open(1) parks on the chat page too, and the click opens it', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The terminal page always had a parking chip for an open(1) the popup
	// blocker refused; the chat page had no consumer, so the guest's open
	// vanished and the model looked broken. Playwright runs with the
	// blocker off, so the refusal is staged: window.open answers null (what
	// a blocked call returns) until the chip is clicked.
	await page.evaluate(() => {
		window.__realOpen = window.open;
		window.open = () => null;
	});
	try {
		await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await page.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
			timeout: 120_000,
		});
		await frameType(
			page,
			page,
			`printf '<h1>chat-park-render</h1>' > /tmp/park.html && open /tmp/park.html`,
		);
		const chip = page.locator('.vmc-open-chip');
		await chip.waitFor({ timeout: 30_000 });
		assert.match(await chip.textContent(), /park\.html/, 'the chip should name the parked file');

		// The click is the gesture the blocker respects; here it simply
		// reaches the real window.open again.
		await page.evaluate(() => {
			window.open = window.__realOpen;
		});
		const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
		popupPromise.catch(() => {});
		await chip.click();
		const popup = await popupPromise;
		try {
			await popup.waitForLoadState('domcontentloaded');
			assert.match(popup.url(), /^blob:/, 'the retried open did not open the typed blob URL');
			assert.equal(await popup.textContent('h1'), 'chat-park-render');
		} finally {
			if (!popup.isClosed()) await popup.close();
		}
		await chip.waitFor({ state: 'detached', timeout: 5_000 });
	} finally {
		await page.evaluate(() => {
			if (window.__realOpen) window.open = window.__realOpen;
			delete window.__realOpen;
		});
		if (await page.locator('[data-testid="vm-console"]').isVisible()) {
			await page.locator('[data-testid="vm-console"] .vga-btn').last().click();
		}
	}
});

test('the Apps page manages this machine’s .vapps: list, start, stop, uninstall', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The vendored Apps page (#/apps) used to be an empty state; the shim
	// now bridges its releases/apps endpoints to rund. Build and install a
	// tiny service through the console (the CLI owns packaging), then drive
	// its whole lifecycle from the page.
	await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
	await page.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
	await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 120_000,
	});
	await frameType(
		page,
		page,
		'app new demoapp --service && app pack /data/work/demoapp && ' +
			"app install /data/work/demoapp.vapp && echo APPS-SETUP-D''ONE",
	);
	await frameUntil(page, (t) => /APPS-SETUP-DONE/.test(t), 'the demo app installed', 60_000);
	await page.locator('[data-testid="vm-console"] .vga-btn').last().click();

	try {
		// The page lists it (refresh runs on mount).
		await page.evaluate(() => {
			location.hash = '#/apps';
		});
		const card = page.locator('h3[title="demoapp"]');
		await card.waitFor({ timeout: 15_000 });
		// This card's buttons: the page ships an app of its own (lasertyper,
		// bundled-apps.ts), whose card wears the same glyphs.
		const cardBox = page.locator('.grid > div', { has: card });

		// Start: the card's play button flips to a stop (square) button once
		// rund reports the service running (the page refreshes after the
		// call). Buttons are found by their lucide glyphs, not their
		// localized titles — the suite runs in whatever language the host
		// browser wears.
		await cardBox.locator('button:has(svg.lucide-play)').click();
		await cardBox.locator('button:has(svg.lucide-square)').waitFor({ timeout: 30_000 });

		// Stop: back to startable.
		await cardBox.locator('button:has(svg.lucide-square)').click();
		await cardBox.locator('button:has(svg.lucide-play)').waitFor({ timeout: 30_000 });

		// The bundled tty app (lasertyper, bundled-apps.ts) opens from its
		// card too: the window kind's verb is `app start` under the hood
		// (vm-apps.ts run) — rund spawns it on a PTY and the desktop grows
		// the terminal window on the stream. It used to be `app run`
		// backgrounded with its output discarded, which the guest refuses
		// from a channel with no terminal (exit 2): the click did nothing.
		// The game's start screen is drawn by the compiled program (tcc
		// runs first), so seeing its prompt proves the whole path, not just
		// the window.
		const laser = page.locator('.grid > div', { has: page.locator('h3[title="lasertyper"]') });
		await laser.locator('button:has(svg.lucide-play)').click();
		await page.waitForSelector('.tty-term', { timeout: 30_000 });
		await ttyWindowUntil(page, 'lasertyper', (t) => /开始游戏/.test(t), 'the game’s start screen', 60_000);
		await laser.locator('button:has(svg.lucide-square)').waitFor({ timeout: 30_000 });
		// Stop from the card: the backend dies, the PTY closes, the window goes.
		await laser.locator('button:has(svg.lucide-square)').click();
		await page.waitForSelector('.tty-term', { state: 'detached', timeout: 20_000 });
		await laser.locator('button:has(svg.lucide-play)').waitFor({ timeout: 30_000 });

		// Autostart, from the detail panel's actions tab (the second
		// aria-selected pill). The switch row is found by its zap glyph —
		// the LAST one, since the DetailCard header wears a zap too — and
		// flipping it swaps the glyph to zap-off. The guest's own
		// /data/apps/enabled list is the authoritative assertion.
		await card.click();
		await page.locator('button[aria-selected]').nth(1).click();
		await page.locator('button:has(svg.lucide-zap)').last().click();
		await page.locator('button:has(svg.lucide-zap-off)').waitFor({ timeout: 15_000 });
		await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await page.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(page, page, "cat /data/apps/enabled; echo AUTOSTART-CHECK-D''ONE");
		const en = await frameUntil(
			page,
			(t) => /AUTOSTART-CHECK-DONE/.test(t),
			'the enabled list',
			30_000,
		);
		assert.match(en, /demoapp/, `enabling autostart did not reach /data/apps/enabled:\n${en}`);
		await page.locator('[data-testid="vm-console"] .vga-btn').last().click();
		// Off again — boot policy only, nothing else moved.
		await page.locator('button:has(svg.lucide-zap-off)').click();
		await page.locator('button:has(svg.lucide-zap)').last().waitFor({ timeout: 15_000 });

		// Uninstall, through the card's overflow menu (a portal; the ellipsis
		// needs a real hover-and-click — the menu closes on outside
		// pointerdown) and its confirm dialog. Menu items are matched by
		// text in both languages: the suite runs in whatever language the
		// host browser wears. The card then leaves the grid — which also
		// guards the rund fix where a removed app's stopped service slot
		// used to linger in app.list as a ghost entry.
		await cardBox.hover();
		await cardBox.locator('button:has(svg.lucide-ellipsis)').click();
		await page.click('button:has-text("Uninstall"), button:has-text("卸载")');
		await page.click('button:has-text("Confirm"), button:has-text("确认")');
		await card.waitFor({ state: 'detached', timeout: 15_000 });
	} finally {
		// Home again for the tests after this one, whatever happened above.
		await page.evaluate(() => {
			location.hash = '#/chat';
		});
		await page.waitForSelector('textarea', { timeout: 15_000 });
	}

	// The guest agrees the package is gone.
	await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
	await page.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
	await frameType(
		page,
		page,
		"ls /data/apps/demoapp.vapp 2>&1; rm -rf /data/work/demoapp /data/work/demoapp.vapp; echo APPS-GONE-D''ONE",
	);
	const gone = await frameUntil(page, (t) => /APPS-GONE-DONE/.test(t), 'the uninstall check', 30_000);
	assert.match(gone, /No such file/, `uninstalling from the page left the package behind:\n${gone}`);
	await page.locator('[data-testid="vm-console"] .vga-btn').last().click();
});

test('the power key shuts the machine down, and boots it back with the console', async () => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// A page of its own: powering a machine off must not touch the suite's
	// shared chat VM, which later tests still type at.
	const ctx = await browser.newContext();
	await muteNetPrompt(ctx);
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		// The page pre-boots its machine; wait until it runs.
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
			timeout: 180_000,
		});
		// Something in /data to carry across: a machine powered off and on
		// comes up with a fresh, empty 9p tree — the mirror has to be
		// replayed into it as on a first boot (the page used to restore
		// once per PAGE and lost every /data file on a power cycle). Written
		// moments before the power key, so the snapshot the power-off takes
		// is the only thing that saves it.
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(p, p, "echo across-the-power-cycle > /data/survivor.txt; echo WROTE-D''ONE");
		await frameUntil(p, (t) => /WROTE-DONE/.test(t), 'the survivor file', 30_000);
		await p.locator('[data-testid="vm-console"] .vga-btn').last().click();

		// Power off: a confirm panel (the network panel's dress, not the
		// browser's native dialog) guards the RAM; the confirm button is
		// the consent, and the machine stops with its windows. The confirm
		// carries no setting: the machine comes back the way it is left
		// (machine-power.ts), and this power-off IS the setting — the next
		// load finds it off, quietly.
		await p.click('.np-fab-power');
		await p.waitForSelector('.np-poweroff', { timeout: 10_000 });
		assert.equal(await p.locator('.np-poweroff input').count(), 0, 'the power-off confirm grew a setting');
		assert.equal(await p.evaluate(() => localStorage.getItem('vinx.machine.power')), 'on');
		await p.click('.np-poweroff-go');
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'off', null, {
			timeout: 15_000,
		});
		assert.equal(
			await p.evaluate(() => localStorage.getItem('vinx.machine.power')),
			'off',
			'the power-off did not remember the machine as off',
		);
		assert.equal(
			await p.locator('[data-testid="vm-console"]').isVisible(),
			false,
			'power-off left the console window open',
		);

		// Looking at the Apps page must not boot the machine: its list is
		// rund's app.list, and rpcCall used to wait out a boot — which on a
		// powered-off VM meant starting one (and pulsing skeletons for the
		// duration). Off, the bridge answers from the mirror at once, and
		// the page says NOTHING about power: no banner, no power key of its
		// own — the capsule at the bottom right is the machine's one owner
		// and floats over this route too. (The one thing on a fresh machine
		// is the app the page ships, bundled-apps.ts — its card comes from
		// the mirror, no machine asked.)
		await p.evaluate(() => {
			location.hash = '#/apps';
		});
		await p.locator('h3[title="lasertyper"]').waitFor({ timeout: 15_000 });
		assert.equal(await p.locator('[data-testid="apps-vm-notice"]').count(), 0, 'the Apps page nagged about power');
		assert.equal(await p.locator('.animate-pulse').count(), 0, 'skeletons pulsed for an off machine');
		assert.equal(await p.locator('.np-fab-power').count(), 1, 'the capsule should float over the Apps page');
		await p.waitForTimeout(2_000);
		assert.equal(
			await p.evaluate(() => document.documentElement.dataset.vmState),
			'off',
			'opening #/apps booted the powered-off machine',
		);

		// Power on from the capsule, on the Apps page: the console opens on
		// the boot log, the machine is remembered as on again, and the list
		// refreshes on its own at ready (rund's list now, with the same one
		// card the mirror showed).
		await p.click('.np-fab-power');
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		assert.equal(
			await p.evaluate(() => localStorage.getItem('vinx.machine.power')),
			'on',
			'the power key did not remember the machine as on',
		);
		assert.ok(
			(await p.locator('[data-testid="vm-boot-note"]').count()) === 1,
			'the capsule should show the boot note while booting',
		);
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
			timeout: 180_000,
		});
		await p.locator('h3[title="lasertyper"]').waitFor({ timeout: 30_000 });
		assert.equal(await p.locator('[data-testid="vm-boot-note"]').count(), 0, 'the boot note outlived the boot');
		await p.evaluate(() => {
			location.hash = '#/chat';
		});
		await p.waitForSelector('textarea', { timeout: 15_000 });

		// The reborn machine's shell is alive (the console is already open:
		// the power key opened it on the boot) — and its /data is whole: the
		// file from before the power-off is back, restored from the mirror
		// the power-off flushed.
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(
			p,
			p,
			'i=0; while [ $i -lt 30 ] && [ ! -f /data/survivor.txt ]; do i=$((i+1)); sleep 1; done; ' +
				"cat /data/survivor.txt; rm -f /data/survivor.txt; echo back-al''ive",
		);
		const reborn = await frameUntil(p, (t) => /back-alive/.test(t), 'the reborn machine echo', 60_000);
		assert.match(reborn, /across-the-power-cycle/, `/data did not survive the power cycle:\n${reborn}`);
	} finally {
		await ctx.close();
	}
});

test('booting is the person’s decision: the page asks once, the machine stays as left, and the model follows', async () => {
	// The machine costs RAM, CPU and a 22 MB download the first time; a
	// person who only wants the chat or a web app should pay none of it.
	// So a first visit asks (machine-power.ts) and the machine stays off
	// until answered — and the model, meanwhile, holds none of the
	// machine's tools and is briefed to say so (runtime/src/index.ts
	// followPower; the engine re-reads its toolbox every turn). A fresh
	// context stands in for the first visit: no power remembered.
	const ctx = await browser.newContext();
	await ctx.addInitScript(() => localStorage.setItem('vinx.net.prompted', '1'));
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		const ask = p.locator('[data-testid="vm-ask"]');
		await ask.waitFor({ timeout: 15_000 });
		await p.waitForTimeout(1_500);
		assert.equal(
			await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'),
			'off',
			'the page booted the machine before the person answered',
		);

		// Unanswered, the model is offered no shell: the wire says so (the
		// mock echoes the tool names it was given) and so does /api/tools.
		const listed = await p.evaluate(() => fetch('/api/tools').then((r) => r.json()));
		assert.equal(listed.tools.length, 0, `tools offered while the machine is off: ${JSON.stringify(listed)}`);
		await configure(p, 'mock-echo-tools');
		await p.evaluate(() =>
			fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'what can you call?', session_id: 'policy-off' }),
			}).then((r) => r.json()),
		);
		const offTools = text(await attach(p, 'policy-off'));
		assert.doesNotMatch(offTools, /run_shell|read_terminal|run_js/, `the model was armed with a machine that is off:\n${offTools}`);
		assert.match(offTools, /read_file/, `the workspace file tools must stand in:\n${offTools}`);
		// And it is told why, in the briefing.
		await configure(p, 'mock-echo-system');
		await p.evaluate(() =>
			fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'hello', session_id: 'policy-off-sys' }),
			}).then((r) => r.json()),
		);
		const offSystem = text(await attach(p, 'policy-off-sys'));
		assert.match(offSystem, /not powered on/, `the no-machine briefing did not reach the model:\n${offSystem}`);

		// Cancel (or the backdrop) is "not now, and ask me again": nothing
		// is remembered, this load stays off, the next load asks anew.
		await ask.locator('.np-cancel').click();
		assert.equal(await ask.count(), 0, 'cancel did not close the question');
		assert.equal(await p.evaluate(() => localStorage.getItem('vinx.machine.power')), null, 'cancel remembered something');
		await p.waitForTimeout(1_000);
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off');
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await ask.waitFor({ timeout: 15_000 });

		// "Not now": the question retires, the machine stays off, the
		// where-is-the-key hint shows once, and the answer is the remembered
		// power — a reload asks nothing and boots nothing. (The power key is
		// where to change one's mind; there is no separate setting.)
		await ask.locator('.np-ask-skip input').check();
		await ask.locator('.np-ask-go').click();
		await p.locator('[data-testid="vm-ask-later"]').waitFor({ timeout: 5_000 });
		assert.equal(await ask.count(), 0, 'the question outlived its answer');
		assert.equal(await p.evaluate(() => localStorage.getItem('vinx.machine.power')), 'off');
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForTimeout(1_500);
		assert.equal(await p.locator('[data-testid="vm-ask"]').count(), 0, 'a remembered choice was asked again');
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off');
		// The network dialog carries no machine setting any more.
		await p.click('.np-fab-net');
		await p.locator('.np-panel').waitFor({ timeout: 10_000 });
		assert.equal(await p.locator('[data-testid="vm-policy"]').count(), 0, 'the network dialog grew a boot setting');
		// The decision holds against every route INTO the machine, not just
		// the page load (vm.ts whenUp). Left off, a file attached to the
		// chat lands in the mirror — where the next boot's restore finds
		// it — and boots nothing; an app dropped on the Apps page is refused
		// in the person's language, and boots nothing.
		await p.click('.np-cancel');
		await p.evaluate(() =>
			fetch('/api/chat/upload', {
				method: 'POST',
				headers: { 'x-file-name': encodeURIComponent('while-off.txt'), 'content-type': 'text/plain' },
				body: 'attached while the machine was off\n',
			}).then((r) => r.json()),
		);
		await waitMirrorKey(p, 'share/local/while-off.txt', 'the attachment mirrored while off', 20_000);
		await p.waitForTimeout(1_500);
		assert.equal(
			await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'),
			'off',
			'attaching a file booted a machine the person left off',
		);
		const install = await p.evaluate(() =>
			fetch('/api/apps/install', {
				method: 'POST',
				headers: { 'content-type': 'application/gzip', 'x-file-name': 'dropped.vapp' },
				body: new Uint8Array([0x1f, 0x8b, 8, 0]),
			}).then((r) => r.json().then((j) => ({ status: r.status, ...j }))),
		);
		assert.equal(install.status, 503, `an install on an off machine did not refuse: ${JSON.stringify(install)}`);
		assert.equal(install.code, 'MACHINE_OFF');
		await p.waitForTimeout(1_000);
		assert.equal(
			await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'),
			'off',
			'installing an app booted a machine the person left off',
		);

		// A visitor who never decided, so the rest of this test can answer
		// the other way (the only way back to the question is a memory the
		// machine never had).
		await p.evaluate(() => localStorage.removeItem('vinx.machine.power'));

		if (!VM_IMAGES) {
			console.log('        (the boot half skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
			return;
		}
		// "Power on": the machine is remembered as on the moment it is asked
		// for. Stopping the boot from the note is a change of mind — the
		// machine goes back to off, not to failed, and is remembered as off
		// (a stopped boot must not come back on the next load) — and the
		// tools go with it; the power key boots it for real, remembers it
		// on, and the tools come back on the next message.
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		const ask2 = p.locator('[data-testid="vm-ask"]');
		await ask2.waitFor({ timeout: 15_000 });
		await ask2.locator('.np-ask-boot input').check();
		await ask2.locator('.np-ask-go').click();
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'booting', null, { timeout: 15_000 });
		assert.equal(await p.evaluate(() => localStorage.getItem('vinx.machine.power')), 'on', 'the boot answer was not remembered');
		await p.locator('[data-testid="vm-boot-note"] .np-boot-stop').click();
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'off', null, { timeout: 15_000 });
		await p.waitForTimeout(500);
		assert.equal(await p.locator('[data-testid="vm-boot-failed"]').count(), 0, 'a stopped boot was painted as a failure');
		assert.equal(await p.locator('.np-fab-power').getAttribute('data-state'), 'off');
		assert.equal(await p.evaluate(() => localStorage.getItem('vinx.machine.power')), 'off', 'a stopped boot stayed remembered as on');

		await p.click('.np-fab-power');
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, { timeout: 180_000 });
		assert.equal(await p.evaluate(() => localStorage.getItem('vinx.machine.power')), 'on', 'the power key did not remember the machine as on');
		await eventually(
			p,
			() => fetch('/api/tools').then((r) => r.json()).then((l) => (l.tools.some((t) => t.name === 'run_shell') ? true : null)),
			'the machine came up but its tools did not follow',
		);
		await configure(p, 'mock-echo-tools');
		await p.evaluate(() =>
			fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'and now?', session_id: 'policy-on' }),
			}).then((r) => r.json()),
		);
		const onTools = text(await attach(p, 'policy-on'));
		assert.match(onTools, /run_shell/, `the model did not get the machine's tools after the boot:\n${onTools}`);
	} finally {
		await ctx.close();
	}
});

test('with the machine off, a draft written by bare name can be edited by that name and handed to the person', async () => {
	// The gap a real session fell into (2026-09-04): asked for a small web
	// page with the machine off, the model wrote it into the workspace,
	// then had no way to give it to the person — download_file lived only
	// on the machine, publish does not exist here, and edit_file by the
	// bare name it had just written to came back "file not found". Now the
	// workspace carries its own download_file, and read/edit resolve a bare
	// name against the drafts the same way write_file does. Machine off,
	// on purpose: none of this needs one.
	const ctx = await browser.newContext({ acceptDownloads: true });
	await ctx.addInitScript(() => {
		localStorage.setItem('vinx.net.prompted', '1');
		localStorage.setItem('vinx.machine.power', 'off');
	});
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForTimeout(1_000);
		assert.equal(
			await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'),
			'off',
			'the machine booted although it was left off',
		);
		const listed = await p.evaluate(() => fetch('/api/tools').then((r) => r.json()));
		assert.equal(listed.tools.length, 0, `device tools offered while the machine is off: ${JSON.stringify(listed)}`);

		await configure(p, 'mock-draft-download');
		const downloadPromise = p.waitForEvent('download', { timeout: 60_000 });
		downloadPromise.catch(() => {});
		await p.evaluate(() =>
			fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'make me a page', session_id: 'draft-dl' }),
			}).then((r) => r.json()),
		);
		// Three Safe tools: nothing to approve, the turn runs to its end.
		const sse = await attach(p, 'draft-dl');
		assert.ok(!events(sse).includes('confirm'), `a workspace tool raised the gate:\n${sse}`);
		const said = text(sse);
		assert.match(said, /Written \d+ bytes to/, `write_file's result did not reach the model:\n${said}`);
		assert.match(said, /Edited .*hello\.html \(1 replacement\)/, `edit_file by the bare name did not land:\n${said}`);
		assert.doesNotMatch(said, /file not found/, `a bare name the model just wrote to was not found:\n${said}`);
		assert.match(said, /Sent hello\.html \(\d+ bytes\) to the person/, `download_file did not report the hand-over:\n${said}`);

		const download = await downloadPromise;
		assert.match(download.suggestedFilename(), /^hello\.html$/);
		const body = await readFile(await download.path(), 'utf8');
		assert.equal(body, '<h1>hello, world</h1>\n', 'the person got something other than the edited draft');
	} finally {
		await ctx.close();
	}
});

test('with the machine off, open_file puts an Open button on its card, and the click shows the draft in a new tab', async () => {
	// The follow-up the same person asked next (2026-09-04): "can't the page
	// just load it?" — a download was the only way out of the workspace. Now
	// open_file offers the file: the card carries an Open button, and the
	// click (the gesture pop-up blockers want) hands the bytes to the browser
	// as a new tab. The bytes are read back through the runtime at that
	// point, not shipped in the tool result, so the tab shows the file as it
	// is now and a card in an old session still opens. Machine off: this is
	// a workspace tool and must not need one.
	const ctx = await browser.newContext();
	await ctx.addInitScript(() => {
		localStorage.setItem('vinx.net.prompted', '1');
		localStorage.setItem('vinx.machine.power', 'off');
	});
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		await configure(p, 'mock-open-file');

		// Through the composer, not fetch: the point is the card the UI renders
		// for the tool result. Both tools are Safe — no gate, the turn runs to
		// its end and the model's closing line echoes what it was told.
		await p.fill('textarea', 'show me a page');
		await p.keyboard.press('Enter');
		const button = p.locator('[data-testid="open-file"]');
		await button.waitFor({ state: 'visible', timeout: 60_000 });
		assert.match(await button.innerText(), /hello\.html/, 'the button names the file it opens');
		const said = p.getByText(/tool said:/);
		await said.waitFor({ timeout: 30_000 });
		const echoed = await said.innerText();
		assert.match(echoed, /Offered hello\.html \(\d+ bytes\)/, `open_file did not report the offer:\n${echoed}`);
		assert.match(echoed, /when the person clicks/, `the result must not claim the file is already on screen:\n${echoed}`);
		// (The echo arriving at all means neither Safe tool raised the gate.)

		// The click is the gesture: a new tab, at a blob: URL of this origin,
		// showing the draft.
		const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 15_000 }), button.click()]);
		await tab.waitForLoadState('load');
		assert.match(tab.url(), /^blob:/, `the file opened as ${tab.url()} rather than a blob: URL`);
		assert.equal(await tab.locator('h1').innerText(), 'hello, tab');
		assert.equal(await tab.title(), 'hi');
		await tab.close();

		// A card whose file has since gone says so instead of opening nothing:
		// the runtime read is what the button stands on.
		const cleared = await p.evaluate(() =>
			fetch('/api/runtime/clear', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ categories: ['drafts'] }),
			}).then((r) => r.json()),
		);
		assert.ok(cleared.ok !== false, `clearing the drafts failed: ${JSON.stringify(cleared)}`);
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		const gone = p.locator('[data-testid="open-file-gone"]');
		await gone.waitFor({ state: 'visible', timeout: 15_000 });
		assert.match(await gone.innerText(), /hello\.html/);
		assert.equal(await p.locator('[data-testid="open-file"]').count(), 0, 'a button for a file that is gone');
	} finally {
		await ctx.close();
	}
});

test('with the machine off, install_app lands a web app on the Apps page, the card’s Open button brings up its window, and autostart opens it at page load', async () => {
	// The third door out of the workspace: an app, not a file. Asked for "a
	// web app", a model used to hand over a standalone HTML — a preview,
	// not an entry on the Apps page — because the only road to the page was
	// `app install` on a machine the person may have left off. Now the
	// model writes the three parts as drafts and install_app packs them the
	// way `app pack` would, validates them the way `app install` would, and
	// lands them in the machine's mirror of /data/apps — no machine. The
	// Apps page lists the app at once, its window opens from the mirror
	// like any pure web app's, and the card carries an Open button of its
	// own. Asked for "every time I open this page", the model passes
	// autostart: the same /data/apps/enabled list rund reads for services,
	// with the page as the clock for a window with no process (§10.7) — it
	// opens at the next load, the Apps page's switch turns it off and on,
	// and rund's boot sweep leaves it alone. Machine off throughout, and
	// still off at the end.
	const ctx = await browser.newContext();
	await ctx.addInitScript(() => {
		localStorage.setItem('vinx.net.prompted', '1');
		localStorage.setItem('vinx.machine.power', 'off');
	});
	const p = await ctx.newPage();
	const appFrame = async () => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const f = p.frames().find((fr) => fr.url().startsWith(APP_FRAME_URL));
			if (f) return f;
			if (Date.now() > deadline) throw new Error('the app frame never attached');
			await new Promise((r) => setTimeout(r, 100));
		}
	};
	// The Apps page's autostart switch lives on the Actions tab of the app's
	// detail panel; for a pure web app it speaks of the page loading, not of
	// a boot, and the overview names the policy the same way.
	const toggleOpenOnLoad = async (expectTitle) => {
		await p.evaluate(() => {
			location.hash = '#/apps';
		});
		const card = p.locator('.grid > div', { has: p.locator('h3[title="tick"]') });
		await card.waitFor({ timeout: 15_000 });
		await card.locator('h3').click();
		await p.getByText(/^Open on load$|^装载时打开$/).first().waitFor({ timeout: 10_000 });
		await p.getByRole('tab', { name: /Actions|操作/ }).click();
		const row = p.getByRole('button', { name: expectTitle });
		await row.waitFor({ timeout: 10_000 }).catch(async (e) => {
			const seen = await p.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean));
			throw new Error(`${e.message}\n        buttons on the page: ${JSON.stringify(seen)}`);
		});
		assert.equal(await p.getByRole('button', { name: /start on boot|开机自启/i }).count(), 0, 'a pure web app was offered a boot-time switch');
		await row.click();
		await p.evaluate(() => {
			location.hash = '#/chat';
		});
		await p.waitForSelector('textarea', { timeout: 15_000 });
	};
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		await configure(p, 'mock-install-app');

		await p.fill('textarea', 'make me a tick app that opens every time I open this page');
		await p.keyboard.press('Enter');
		const button = p.locator('[data-testid="install-app-open"]');
		await button.waitFor({ state: 'visible', timeout: 60_000 });
		assert.match(await button.innerText(), /Tick Tock/, 'the button names the app by its title');
		const said = p.getByText(/tool said:/);
		await said.waitFor({ timeout: 30_000 });
		const echoed = await said.innerText();
		// Four Safe tools: no gate (the echo arriving says so), and the
		// model was told what landed, where, and what it takes to open it.
		assert.match(echoed, /Installed tick \("Tick Tock"\): index\.html, style\.css, app\.js -> \/data\/apps\/tick\.vapp \(\d+ bytes\)/, `install_app did not report the install:\n${echoed}`);
		assert.match(echoed, /Apps page/, `the result does not tell the model where the person finds the app:\n${echoed}`);
		assert.match(echoed, /powered off/, `the result does not say the machine took no part:\n${echoed}`);
		assert.match(echoed, /autostart list.*whenever the page loads/, `the result does not say the autostart was taken:\n${echoed}`);
		assert.doesNotMatch(echoed, /app check: (error|warning)/, `a clean scaffold drew a finding:\n${echoed}`);
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'installing booted the machine');

		// What `app install` + `app enable` would have left in /data/apps, in
		// the mirror: the package, the three sidecars a listing reads, the
		// pure-web marker rund's sweep reads, and the enabled list itself —
		// the guest's exact bytes, one id per line.
		for (const key of ['c/apps/tick.vapp', 'c/apps/tick.kind', 'c/apps/tick.title', 'c/apps/tick.description', 'c/apps/tick.web']) {
			assert.ok(await mirrorHasKey(p, key), `${key} is not in the mirror`);
		}
		assert.equal(await mirrorText(p, 'c/apps/enabled'), 'tick\n', 'the enabled list is not what `app enable` writes');
		// Installing does not open the window: autostart is the next load's.
		assert.equal(await p.locator('iframe.app-frame').count(), 0, 'installing opened the window');

		// The Apps page lists it from the mirror — the card wears the title,
		// the id is its tooltip — with the window verb, and the releases API
		// reads its kind from the sidecar, its autostart from the list, and
		// its pure-web nature from the marker.
		await p.evaluate(() => {
			location.hash = '#/apps';
		});
		const card = p.locator('.grid > div', { has: p.locator('h3[title="tick"]') });
		await card.waitFor({ timeout: 15_000 });
		assert.match(await card.locator('h3').textContent(), /^Tick Tock$/, 'the card does not show the title');
		await card.locator('button[title="Open window"], button[title="打开窗口"]').waitFor({ timeout: 10_000 });
		const listed = await p.evaluate(() => fetch('/api/releases?kind=app').then((r) => r.json()));
		const tick = listed.releases.find((r) => r.name === 'tick');
		assert.equal(tick?.app_kind, 'window', `the app's kind did not come from the sidecar: ${JSON.stringify(tick)}`);
		assert.equal(tick?.enabled, 'enabled', `the app's autostart did not come from the list: ${JSON.stringify(tick)}`);
		assert.equal(tick?.web, true, `the app is not listed as a pure web app: ${JSON.stringify(tick)}`);
		assert.equal(await p.locator('[data-testid="apps-vm-notice"]').count(), 0, 'the Apps page nagged about power');
		await p.evaluate(() => {
			location.hash = '#/chat';
		});
		await p.waitForSelector('textarea', { timeout: 15_000 });

		// The card's Open button: the window comes up on this page, from
		// the mirror, with all three parts in it — and the machine stays off.
		await button.click();
		await p.waitForSelector('iframe.app-frame', { timeout: 15_000 });
		const frame = await appFrame();
		await frame.waitForFunction(() => document.getElementById('marker')?.textContent === 'hello from app.js', null, { timeout: 15_000 });
		assert.equal(await frame.textContent('.note'), 'from install_app', 'the window shows a different fragment');
		assert.equal(
			await frame.evaluate(() => getComputedStyle(document.querySelector('.note')).color),
			'rgb(0, 128, 128)',
			'style.css did not reach the window',
		);
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'opening the app booted the machine');
		// Open again: the same window, raised — not a second one.
		await button.click();
		await p.waitForTimeout(800);
		assert.equal(await p.locator('iframe.app-frame').count(), 1, 'a second open made a second window');

		// Autostart: the page loads, the window is there — nobody clicked.
		// The package is in the mirror, not in the tool result, so the card
		// survives the reload as a working button too (it only raises).
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForSelector('iframe.app-frame', { timeout: 15_000 });
		const auto = await appFrame();
		await auto.waitForFunction(() => document.getElementById('marker')?.textContent === 'hello from app.js', null, { timeout: 15_000 });
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'autostart booted the machine');
		const again = p.locator('[data-testid="install-app-open"]');
		await again.waitFor({ state: 'visible', timeout: 15_000 });
		await again.click();
		await p.waitForTimeout(800);
		assert.equal(await p.locator('iframe.app-frame').count(), 1, 'the card opened a second window beside the autostarted one');

		// The switch on the Apps page, machine still off: off edits the list
		// in the mirror (the open window stays — load policy only), the next
		// load opens nothing, and on puts it back for the load after.
		await toggleOpenOnLoad(/Don.t open when the page loads|^取消装载时打开/);
		await mirrorTextBecomes(p, 'c/apps/enabled', (t) => t !== null && !/^tick$/m.test(t), 'the switch taking tick off the list');
		assert.equal(await p.locator('iframe.app-frame').count(), 1, 'turning autostart off closed the open window');
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForTimeout(2_500);
		assert.equal(await p.locator('iframe.app-frame').count(), 0, 'the window opened at load with autostart off');
		await toggleOpenOnLoad(/^Open when the page loads|^页面装载时打开/);
		await mirrorTextBecomes(p, 'c/apps/enabled', (t) => t === 'tick\n', 'the switch putting tick back on the list');
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'the switch booted the machine');
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForSelector('iframe.app-frame', { timeout: 15_000 });

		if (!VM_IMAGES) {
			console.log('        (the boot half skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
			return;
		}
		// Power on: the boot replays the mirror into /data, and the guest
		// finds what `app install` + `app enable` would have left — the
		// package `app list` names with the install's title, enabled and
		// marked web, which rund's sweep left alone (no process: "stopped",
		// not a crash); `app enable` takes it again in the page's words, and
		// `app run` opens (the same window, raised). With the machine up the
		// workspace's install_app retires in favour of the `app` CLI, as its
		// two door-mates do.
		await p.click('.np-fab-power');
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, { timeout: 180_000 });
		await eventually(
			p,
			() => fetch('/api/tools').then((r) => r.json()).then((l) => (l.tools.some((t) => t.name === 'run_shell') ? true : null)),
			'the machine came up but its tools did not follow',
		);
		const tools = await p.evaluate(() => fetch('/api/tools').then((r) => r.json()));
		assert.ok(!tools.tools.some((t) => t.name === 'install_app'), 'install_app stayed on the list beside the `app` CLI');
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		// A few sweep ticks after the replay before looking: a sweep that
		// wrongly spawned a pure web app would have shown by then.
		await p.waitForTimeout(4_000);
		await frameType(
			p,
			p,
			"app list --json | jq -c '.apps[] | select(.id==\"tick\") | {id,kind,enabled,web,state}'; cat /data/apps/tick.title /data/apps/tick.web; cat /data/apps/enabled; " +
				"tar tzf /data/apps/tick.vapp | sed 's#^\\./##' | sort | tr '\\n' ' '; echo; app disable tick && app enable tick; echo \"ENABLE-RC=$?\"; app run tick; echo \"RUN-RC=$?\"; echo BOOT-CHECK-D''ONE",
		);
		const seen = await frameUntil(p, (t) => /BOOT-CHECK-DONE/.test(t), 'the guest’s view of the install', 90_000);
		assert.match(seen, /\{"id":"tick","kind":"window","enabled":true,"web":true,"state":"stopped"\}/, `app list does not see the page-installed, page-enabled web app as rund should:\n${seen}`);
		assert.match(seen, /^Tick Tock$/m, `the title sidecar did not reach the guest:\n${seen}`);
		assert.match(seen, /^web$/m, `the pure-web marker did not reach the guest:\n${seen}`);
		assert.match(seen, /^tick$/m, `the enabled list did not reach the guest:\n${seen}`);
		assert.match(seen, /app\.js app\.json index\.html style\.css/, `the guest reads a different package:\n${seen}`);
		assert.match(seen, /enabled -- its window opens whenever the page loads/, `app enable does not speak of the page for a pure web app:\n${seen}`);
		assert.match(seen, /ENABLE-RC=0/, `app enable refused the pure web app:\n${seen}`);
		assert.match(seen, /RUN-RC=0/, `app run refused the page-installed app:\n${seen}`);
		assert.equal(await p.locator('iframe.app-frame').count(), 1, 'app run made a second window instead of raising the open one');

		// Uninstall with the machine up, through the card's overflow menu:
		// the guest's `app remove` (stop, disable, rm), the window closing
		// with it, and the mirror following the guest's rm at once — an
		// unlink rings no 9p doorbell, so the bridge asks for the snapshot
		// itself; a package removed a moment ago must not linger in the
		// mirror to be listed, or autostarted, from there.
		await p.locator('[data-testid="vm-console"] .vga-btn').last().click();
		await p.evaluate(() => {
			location.hash = '#/apps';
		});
		const tickCard = p.locator('h3[title="tick"]');
		await tickCard.waitFor({ timeout: 15_000 });
		const tickBox = p.locator('.grid > div', { has: tickCard });
		await tickBox.hover();
		await tickBox.locator('button:has(svg.lucide-ellipsis)').click();
		await p.click('button:has-text("Uninstall"), button:has-text("卸载")');
		await p.click('button:has-text("Confirm"), button:has-text("确认")');
		await tickCard.waitFor({ state: 'detached', timeout: 15_000 });
		assert.equal(await p.locator('iframe.app-frame').count(), 0, 'uninstalling left the app’s window open');
		const mirrorDeadline = Date.now() + 10_000;
		while (await mirrorHasKey(p, 'c/apps/tick.vapp')) {
			if (Date.now() > mirrorDeadline) throw new Error('the mirror kept the removed package past the bridge’s snapshot');
			await new Promise((r) => setTimeout(r, 300));
		}
		assert.ok(!(await mirrorHasKey(p, 'c/apps/tick.web')), 'the mirror kept the removed app’s pure-web marker');
		assert.doesNotMatch((await mirrorText(p, 'c/apps/enabled')) ?? '', /^tick$/m, 'the mirror’s autostart list still names the removed app');
		await p.evaluate(() => {
			location.hash = '#/chat';
		});
		await p.waitForSelector('textarea', { timeout: 15_000 });
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(p, p, "echo REMOVE-CHECK-BEG''IN; ls /data/apps/tick.vapp /data/apps/tick.web 2>&1; cat /data/apps/enabled; app list --json | jq -c '[(.apps // [])[].id] | sort'; echo REMOVE-CHECK-D''ONE");
		// Only the lines between the markers: the boot check above printed
		// the enabled list too, and that `tick` may still be on screen.
		const removed = (await frameUntil(p, (t) => /REMOVE-CHECK-DONE/.test(t), 'the guest’s view of the uninstall', 60_000)).replace(/^[\s\S]*REMOVE-CHECK-BEGIN\n/, '');
		assert.match(removed, /tick\.vapp.*No such file/, `the guest still has the removed package:\n${removed}`);
		assert.match(removed, /tick\.web.*No such file/, `the guest still has the removed app’s marker:\n${removed}`);
		assert.doesNotMatch(removed, /^tick$/m, `the guest’s autostart list still names the removed app:\n${removed}`);
		// What is left is what the page ships (bundled-apps.ts), nothing else; the
		// guest lists in directory order, so the ids are sorted first.
		assert.match(removed, /^\["lasertyper","nes"\]$/m, `app list still names the removed app:\n${removed}`);
	} finally {
		await ctx.close();
	}
});

test('install_app refuses what `app install` would refuse, in its words, and installs nothing', async () => {
	// The refusal side of the same door: the page runs the guest's checks
	// (app-check.ts) over what the engine handed over. A bad id is the
	// guest's ID_INVALID line, same shape; the result is an error the model
	// reads, the card shows it without an Open button, and nothing lands in
	// the mirror.
	const ctx = await browser.newContext();
	await ctx.addInitScript(() => {
		localStorage.setItem('vinx.net.prompted', '1');
		localStorage.setItem('vinx.machine.power', 'off');
	});
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		await configure(p, 'mock-install-app-bad');
		await p.fill('textarea', 'install it anyway');
		await p.keyboard.press('Enter');
		const said = p.getByText(/tool said:/);
		await said.waitFor({ timeout: 60_000 });
		const echoed = await said.innerText();
		assert.match(
			echoed,
			/Error: app check: error ID_INVALID \(Bad App\): 'Bad App' is not an app id -- lowercase letters, digits and dashes/,
			`the refusal did not reach the model in the guest's words:\n${echoed}`,
		);
		assert.match(echoed, /nothing installed/, `the refusal does not say nothing landed:\n${echoed}`);
		assert.equal(await p.locator('[data-testid="install-app-open"]').count(), 0, 'a refused install drew an Open button');
		await p.locator('[data-testid="install-app-refused"]').waitFor({ timeout: 10_000 });
		assert.ok(!(await mirrorHasKey(p, 'c/apps/Bad App.vapp')), 'a refused install reached the mirror');
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'a refusal booted the machine');
	} finally {
		await ctx.close();
	}
});

test('a fresh install is not an enable: install_app drops a leftover autostart line for its id, and only that one', async () => {
	// A mirror used to keep a removed app's autostart line (`app remove`
	// emptied the list, and an emptied file was the one edit the snapshot
	// missed), and a person's machine may still carry such a line. A
	// package installed later under that name must not autostart unasked:
	// the list is policy set after an install, so installing is not
	// enabling — on either side (app-install.ts here, the guest's `app
	// install` in the Apps-page suite). Another id's line is not this
	// install's business and stays. Machine off throughout.
	const ctx = await browser.newContext();
	await ctx.addInitScript(() => {
		localStorage.setItem('vinx.net.prompted', '1');
		localStorage.setItem('vinx.machine.power', 'off');
	});
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		await mirrorPut(p, 'c/apps/enabled', 'tock\nother\n');
		await configure(p, 'mock-install-app-plain');
		await p.fill('textarea', 'install tock');
		await p.keyboard.press('Enter');
		const said = p.getByText(/tool said:/);
		await said.waitFor({ timeout: 60_000 });
		const echoed = await said.innerText();
		assert.match(echoed, /Installed tock \("Tock"\): index\.html -> \/data\/apps\/tock\.vapp/, `install_app did not report the install:\n${echoed}`);
		assert.doesNotMatch(echoed, /autostart list/, `an install nobody asked to autostart speaks of the list:\n${echoed}`);
		assert.equal(await mirrorText(p, 'c/apps/enabled'), 'other\n', 'the leftover line for the installed id stayed, or another id’s line went with it');
		const listed = await p.evaluate(() => fetch('/api/releases?kind=app').then((r) => r.json()));
		const tock = listed.releases.find((r) => r.name === 'tock');
		assert.equal(tock?.enabled, 'disabled', `a fresh install came up enabled: ${JSON.stringify(tock)}`);
		// The next load opens nothing — the leftover line would have.
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForTimeout(2_500);
		assert.equal(await p.locator('iframe.app-frame').count(), 0, 'the leftover line autostarted the fresh install');
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'installing booted the machine');
	} finally {
		await ctx.close();
	}
});

test('the page ships an app: lasertyper is seeded once per machine, an uninstall is final, a package of their own is left alone', async () => {
	// bundled-apps.ts: apps/lasertyper at the repository root, packed by
	// build-apps.mjs, landed on the first load the way `app install` leaves
	// a package — sidecars and all, machine off — and recorded on
	// apps/bundled. A gift, not documentation: the record, not the package,
	// is what the next load checks, so an uninstalled bundled app stays
	// uninstalled; and an id the person already has a package under is
	// theirs, left as it is (and recorded, so no later build touches it).
	const ctx = await browser.newContext();
	await ctx.addInitScript(() => {
		localStorage.setItem('vinx.net.prompted', '1');
		localStorage.setItem('vinx.machine.power', 'off');
	});
	const p = await ctx.newPage();
	const releases = () => p.evaluate(() => fetch('/api/releases?kind=app').then((r) => r.json()));
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		await p.evaluate(() => {
			location.hash = '#/apps';
		});
		await p.locator('h3[title="lasertyper"]').waitFor({ timeout: 20_000 });
		assert.equal(await mirrorText(p, 'c/apps/lasertyper.kind'), 'window\n', 'the kind sidecar is not the guest’s');
		assert.equal(await mirrorText(p, 'c/apps/lasertyper.title'), 'Laser Typer\n', 'the title sidecar is not the manifest’s');
		assert.ok(!(await mirrorHasKey(p, 'c/apps/lasertyper.web')), 'a tty window app got the pure-web marker');
		assert.equal(await mirrorText(p, 'c/apps/bundled'), 'lasertyper\nnes\n', 'the seed was not recorded');
		const laser = (await releases()).releases.find((r) => r.name === 'lasertyper');
		assert.equal(laser?.app_kind, 'window', `not listed as a window app: ${JSON.stringify(laser)}`);
		assert.equal(laser?.web, false, `a tty app listed as pure web: ${JSON.stringify(laser)}`);
		assert.equal(laser?.enabled, 'disabled', `a gift that autostarts: ${JSON.stringify(laser)}`);
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'seeding booted the machine');
		// The package is the build's, byte for byte.
		const built = JSON.parse(await readFile(new URL('../gen/bundled-apps.json', import.meta.url), 'utf8'));
		const size = await p.evaluate(async () => {
			const db = await new Promise((resolve, reject) => {
				const req = indexedDB.open('vinx.vm');
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			const bytes = await new Promise((resolve) => {
				const tx = db.transaction('share', 'readonly');
				const req = tx.objectStore('share').get('c/apps/lasertyper.vapp');
				req.onsuccess = () => resolve(req.result ? req.result.byteLength : -1);
				req.onerror = () => resolve(-1);
			});
			db.close();
			return bytes;
		});
		assert.equal(size, built.find((a) => a.id === 'lasertyper')?.bytes, 'the mirrored package is not the built one');

		// Uninstall from the card — the person's path, machine off — then
		// reload: gone it stays, the record still names it.
		const h3 = p.locator('h3[title="lasertyper"]');
		const box = p.locator('.grid > div', { has: h3 });
		await box.hover();
		await box.locator('button:has(svg.lucide-ellipsis)').click();
		await p.click('button:has-text("Uninstall"), button:has-text("卸载")');
		await p.click('button:has-text("Confirm"), button:has-text("确认")');
		await h3.waitFor({ state: 'detached', timeout: 15_000 });
		assert.ok(!(await mirrorHasKey(p, 'c/apps/lasertyper.vapp')), 'the mirror kept the package');
		assert.equal(await mirrorText(p, 'c/apps/bundled'), 'lasertyper\nnes\n', 'uninstalling forgot the record');
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForTimeout(2_500);
		assert.ok(!(await mirrorHasKey(p, 'c/apps/lasertyper.vapp')), 'the uninstalled bundled app came back on the next load');
		assert.equal((await releases()).releases.some((r) => r.name === 'lasertyper'), false, 'the list names the uninstalled bundled app');

		// Their own package under the id, no record (a machine from before the
		// gift, say): the seed records the id and leaves the bytes alone.
		await mirrorPut(p, 'c/apps/bundled', null);
		await mirrorPut(p, 'c/apps/lasertyper.vapp', 'theirs');
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await mirrorTextBecomes(p, 'c/apps/bundled', (t) => t === 'lasertyper\nnes\n', 'the seed recording an id the person already had', 15_000);
		assert.equal(await mirrorText(p, 'c/apps/lasertyper.vapp'), 'theirs', 'the seed overwrote a package of theirs');
		assert.ok(!(await mirrorHasKey(p, 'c/apps/lasertyper.kind')), 'the seed wrote sidecars beside a package of theirs');
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState ?? 'off'), 'off', 'the seed booted the machine');

		if (!VM_IMAGES) {
			console.log('        (the guest leg skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
			return;
		}
		// The guest leg: a fresh machine (their fake package and the record
		// taken away first) gets the real thing, boots, and the game runs —
		// `run` compiles main.c with the machine's tcc on the PTY rund opened,
		// and the title screen is in the window.
		await mirrorPut(p, 'c/apps/bundled', null);
		await mirrorPut(p, 'c/apps/lasertyper.vapp', null);
		await p.reload({ waitUntil: 'networkidle' });
		await ready(p);
		await mirrorTextBecomes(p, 'c/apps/bundled', (t) => t === 'lasertyper\nnes\n', 'the seed on a fresh machine', 15_000);
		await mirrorTextBecomes(p, 'c/apps/lasertyper.kind', (t) => t === 'window\n', 'the seed’s sidecars on a fresh machine', 15_000);
		await p.evaluate(() => {
			location.hash = '#/chat';
		});
		await p.waitForSelector('textarea', { timeout: 15_000 });
		await p.click('.np-fab-power');
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, { timeout: 180_000 });
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await p.waitForTimeout(3_000);
		// The replay lands /data/apps moments after the boot; wait for it.
		await frameType(
			p,
			p,
			"until [ -f /data/apps/lasertyper.vapp ]; do sleep 1; done; app list --json | jq -c '.apps[] | select(.id==\"lasertyper\") | {id,kind,enabled}'; echo LIST-D''ONE",
		);
		const listed = await frameUntil(p, (t) => /LIST-DONE/.test(t), 'app list on the seeded machine', 60_000);
		assert.match(listed, /\{"id":"lasertyper","kind":"window","enabled":false\}/, `the guest does not list the bundled app as installed:\n${listed}`);
		await frameType(p, p, 'app start lasertyper; echo START-D\'\'ONE');
		await frameUntil(p, (t) => /START-DONE/.test(t), 'app start of the bundled game', 60_000);
		await ttyWindowUntil(p, 'lasertyper', (t) => /\[ENTER\] 开始游戏/.test(t), 'the game’s title screen in its window', 120_000);
		// Close the window the way a person does; the game exits with it and
		// rund sees the backend stop. (The window sits over the console, so
		// nothing is typed there until it is gone.)
		await p
			.locator('.vga-window', { has: p.locator('.vga-title-text', { hasText: /lasertyper|Laser Typer/ }) })
			.locator('.vga-btn[title*="Close"]')
			.click();
		await p.waitForSelector('.tty-term', { state: 'detached', timeout: 15_000 });
		await frameType(
			p,
			p,
			'i=0; while [ $i -lt 20 ] && [ "$(cat /run/vinx/apps/lasertyper/state 2>/dev/null)" != stopped ]; do i=$((i+1)); sleep 1; done; ' +
				"cat /run/vinx/apps/lasertyper/state; echo GAME-STOP-''CHECKED",
		);
		const stopped = await frameUntil(p, (t) => /GAME-STOP-CHECKED/.test(t), 'the game stopping with its window', 45_000);
		assert.match(stopped, /\bstopped\b/, `closing the window did not stop the game:\n${stopped}`);
	} finally {
		await ctx.close();
	}
});

test('the page ships the console’s window: nes lists the ROMs in /data, a pick mode-sets the screen, q comes back to the list', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// apps/nes (bundled-apps.ts): a tty window whose `run` is a ROM picker —
	// the machine is the image's /usr/bin/nes, the package the doorway from
	// a card's play button. A do-nothing NROM cartridge built in the guest
	// (the 24592 bytes the screen-window test uses: vectors at $8000, a jump
	// in place) is enough for the whole path: the picker lists it by name,
	// the pick runs `nes /data/e2e-pick.nes` on the window's PTY (the game's
	// own lines land in the window), the mode-set to 256x224 opens the
	// screen window by itself, q quits the game and the list is back, q
	// again ends the picker and the window with it.
	//
	// Home first: the console lives on the chat page. A predecessor may
	// have left the terminal document (its own page, not a route): that
	// takes a navigation and the chat page's pre-boot brings the machine
	// up again; a route only takes the hash. Home again at the end.
	if (/\/terminal\//.test(page.url())) {
		await page.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(page);
	}
	await page.evaluate(() => {
		location.hash = '#/chat';
	});
	await page.waitForSelector('textarea', { timeout: 15_000 });
	await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
	await page.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
	await page.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 120_000,
	});
	await frameType(
		page,
		page,
		String.raw`{ printf 'NES\x1a\x01\x01'; head -c 10 /dev/zero; printf '\x4c\x00\x80'; head -c 16375 /dev/zero; printf '\x00\x80\x00\x80\x00\x80'; head -c 8192 /dev/zero; } > /data/e2e-pick.nes && wc -c < /data/e2e-pick.nes; echo ROM-D''ONE`,
	);
	const made = await frameUntil(page, (t) => /ROM-DONE/.test(t), 'the synthetic ROM in /data', 60_000);
	assert.match(made, /24592/, `the ROM did not land:\n${made}`);
	await page.locator('[data-testid="vm-console"] .vga-btn').last().click();

	// Keys for the picker go to its xterm, focused through the test registry
	// rather than a click: the screen window that opens mid-test may sit
	// over the terminal, and a click there would make the PANEL the keyboard.
	const focusTty = () => page.evaluate(() => window.__vinxTtyTerms?.get('nes')?.focus());
	const screen = page.locator('.vga-window', { has: page.locator('.vga-panel') });
	try {
		await page.evaluate(() => {
			location.hash = '#/apps';
		});
		const card = page.locator('.grid > div', { has: page.locator('h3[title="nes"]') });
		await card.locator('button:has(svg.lucide-play)').click();
		await page.waitForSelector('.tty-term', { timeout: 30_000 });
		// The list: the file by its path under /data, numbered.
		const list = await ttyWindowUntil(
			page,
			'nes',
			(t) => /e2e-pick\.nes/.test(t) && /number plays/.test(t),
			'the ROM list',
			60_000,
		);
		const num = /^\s*(\d+)\) e2e-pick\.nes/m.exec(list)?.[1];
		assert.ok(num, `the list gives the ROM no number:\n${list}`);
		await card.locator('button:has(svg.lucide-square)').waitFor({ timeout: 30_000 });

		// The pick: the game starts on the screen (the mode-set opens the
		// screen window — the .vga-window with a .vga-panel; the tty window
		// is a .vga-window without one) and talks in the tty window.
		await focusTty();
		await page.keyboard.type(num);
		await page.keyboard.press('Enter');
		await screen.waitFor({ timeout: 60_000 });
		await ttyWindowUntil(page, 'nes', (t) => /keys: arrows/.test(t), 'the game’s own key line in the window', 60_000);

		// q quits the game — typed in the tty window it rides the PTY
		// (input.c's serial path). The picker clears and lists again.
		await focusTty();
		await page.keyboard.type('q');
		await ttyWindowUntil(
			page,
			'nes',
			(t) => /number plays/.test(t) && /e2e-pick\.nes/.test(t) && !/keys: arrows/.test(t),
			'the list back after the game',
			60_000,
		);

		// q again ends the picker: the PTY closes, the window goes, the card
		// is startable again.
		await focusTty();
		await page.keyboard.type('q');
		await page.keyboard.press('Enter');
		await page.waitForSelector('.tty-term', { state: 'detached', timeout: 20_000 });
		await card.locator('button:has(svg.lucide-play)').waitFor({ timeout: 30_000 });
	} finally {
		// The screen window stays open after the game (the person closes
		// it); the console is where the ROM goes away.
		if (await screen.count()) await screen.locator('.vga-btn[title*="Close"]').click();
		await page.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await page.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(page, page, "app stop nes 2>/dev/null; rm -f /data/e2e-pick.nes; echo NES-CLEAN-''DONE");
		await frameUntil(page, (t) => /NES-CLEAN-DONE/.test(t), 'the cleanup', 30_000);
		await page.locator('[data-testid="vm-console"] .vga-btn').last().click();
		await page.evaluate(() => {
			location.hash = '#/chat';
		});
		await page.waitForSelector('textarea', { timeout: 15_000 });
	}
});

test('the Apps page speaks each kind’s verbs; a powered-off machine still lists its apps, and a pure web app opens without it', async () => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The other half of "not now — web only" (vm-apps.ts): a pure web app's
	// window is a sandboxed frame fed a bundle, nothing of Linux in it, so
	// the page can open one from the package in the machine's mirror while
	// the machine is off. The installed list, too, is the mirror's while
	// off — the same packages `app list` would name, minus rund's states.
	// Build the app on a running machine first (its install lands in the
	// mirror), then power off and use nothing but the page.
	const ctx = await browser.newContext();
	await muteNetPrompt(ctx);
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'networkidle' });
		await ready(p);
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, { timeout: 180_000 });
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(
			p,
			p,
			"app new offweb --web >/dev/null && echo '<p id=\"marker\">off-web-marker</p>' >> /data/work/offweb/index.html && " +
				"app pack /data/work/offweb >/dev/null && app install /data/work/offweb.vapp >/dev/null && app new offsvc --service >/dev/null && " +
				"app pack /data/work/offsvc >/dev/null && app install /data/work/offsvc.vapp >/dev/null && echo OFF-SETUP-D''ONE",
		);
		await frameUntil(p, (t) => /OFF-SETUP-DONE/.test(t), 'the two installs', 90_000);
		await waitMirrorKey(p, 'c/apps/offweb.vapp', 'the web app package');
		await waitMirrorKey(p, 'c/apps/offweb.kind', 'the web app kind sidecar');
		await waitMirrorKey(p, 'c/apps/offsvc.vapp', 'the service package');
		await p.locator('[data-testid="vm-console"] .vga-btn').last().click();

		// While the machine runs: the cards speak each kind's verbs (the
		// same words the CLI knows), and wear the manifest's title. The web
		// scaffold titles itself after its id; a command app is "run once";
		// a window app opens and closes from its card, and its "stop" is
		// the window closing — nothing for rund. Its autostart is the
		// page's (§10.7): `app enable` takes it, says so in the page's
		// words, and leaves the marker rund's sweep reads to skip it.
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(
			p,
			p,
			"app new offcmd --command >/dev/null && app pack /data/work/offcmd >/dev/null && app install /data/work/offcmd.vapp >/dev/null && " +
				"cat /data/apps/offweb.title; app enable offweb; echo \"ENABLE-RC=$?\"; cat /data/apps/offweb.web; echo KINDS-SETUP-D''ONE",
		);
		const kinds = await frameUntil(p, (t) => /KINDS-SETUP-DONE/.test(t), 'the command app install', 60_000);
		assert.match(kinds, /^offweb$/m, `install did not record the scaffold's title:\n${kinds}`);
		assert.match(kinds, /offweb enabled -- its window opens whenever the page loads/, `enable on a pure web app did not speak of the page:\n${kinds}`);
		assert.match(kinds, /ENABLE-RC=0/, `enable on a pure web app was refused:\n${kinds}`);
		assert.match(kinds, /^web$/m, `install did not leave the pure-web marker:\n${kinds}`);
		await waitMirrorKey(p, 'c/apps/enabled', 'the enabled list');
		await waitMirrorKey(p, 'c/apps/offweb.web', 'the pure-web marker');
		await p.locator('[data-testid="vm-console"] .vga-btn').last().click();
		await p.evaluate(() => {
			location.hash = '#/apps';
		});
		const liveWeb = p.locator('.grid > div', { has: p.locator('h3[title="offweb"]') });
		await liveWeb.waitFor({ timeout: 15_000 });
		assert.match(await liveWeb.locator('h3').textContent(), /^offweb$/, 'the card does not show the title');
		await liveWeb.locator('button[title="Open window"], button[title="打开窗口"]').click();
		await p.waitForSelector('iframe.app-frame', { timeout: 15_000 });
		await liveWeb.locator('button[title="Close window"], button[title="关闭窗口"]').waitFor({ timeout: 15_000 });
		await liveWeb.locator('button[title="Close window"], button[title="关闭窗口"]').click();
		await p.waitForSelector('iframe.app-frame', { state: 'detached', timeout: 15_000 });
		await liveWeb.locator('button[title="Open window"], button[title="打开窗口"]').waitFor({ timeout: 15_000 });
		const liveCmd = p.locator('.grid > div', { has: p.locator('h3[title="offcmd"]') });
		await liveCmd.locator('button[title="Run once"], button[title="运行一次"]').click();
		await p.waitForTimeout(3_000);
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await frameType(p, p, "echo \"state=$(cat /run/vinx/apps/offcmd/state) exit=$(cat /run/vinx/apps/offcmd/exit)\"; app remove offcmd >/dev/null; echo CMD-D''ONE");
		const cmd = await frameUntil(p, (t) => /CMD-DONE/.test(t), 'the command app state', 30_000);
		assert.match(cmd, /state=stopped exit=0/, `run once from the card did not run the command to completion:\n${cmd}`);
		await p.locator('[data-testid="vm-console"] .vga-btn').last().click();
		await p.evaluate(() => {
			location.hash = '#/chat';
		});
		await p.waitForSelector('textarea', { timeout: 15_000 });

		// Off. From here on the machine takes no part. The power-off itself
		// remembers the machine as off (machine-power.ts): no need is
		// allowed to boot it behind the person's back.
		await p.click('.np-fab-power');
		await p.waitForSelector('.np-poweroff', { timeout: 10_000 });
		await p.click('.np-poweroff-go');
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'off', null, { timeout: 15_000 });
		assert.equal(await p.evaluate(() => localStorage.getItem('vinx.machine.power')), 'off', 'the power-off did not remember off');

		// The list: both packages, from the mirror, with their kinds; and
		// not a word about power from the page itself. No skeletons, no
		// boot.
		await p.evaluate(() => {
			location.hash = '#/apps';
		});
		await p.locator('h3[title="offweb"]').waitFor({ timeout: 15_000 });
		await p.locator('h3[title="offsvc"]').waitFor({ timeout: 15_000 });
		assert.equal(await p.locator('[data-testid="apps-vm-notice"]').count(), 0, 'the Apps page nagged about power');
		assert.equal(await p.getByText(/powered off|已关机/).count(), 0, 'the Apps page mentioned the power before anything asked for the machine');
		assert.equal(await p.locator('.animate-pulse').count(), 0, 'skeletons on a mirror-backed list');
		const listed = await p.evaluate(() => fetch('/api/releases?kind=app').then((r) => r.json()));
		const web = listed.releases.find((r) => r.name === 'offweb');
		const svc = listed.releases.find((r) => r.name === 'offsvc');
		assert.equal(web?.app_kind, 'window', `the web app's kind did not come from the sidecar: ${JSON.stringify(web)}`);
		assert.equal(web?.enabled, 'enabled', `the web app's autostart did not come from the mirrored list: ${JSON.stringify(web)}`);
		assert.equal(web?.web, true, `the web app is not listed as a pure web app: ${JSON.stringify(web)}`);
		assert.equal(svc?.app_kind, 'service', `the service's kind did not come from the sidecar: ${JSON.stringify(svc)}`);
		assert.equal(svc?.enabled, 'disabled', `the service reads as enabled: ${JSON.stringify(svc)}`);
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState), 'off', 'listing booted the machine');

		// Open the web app from its card: the play key reads "open window"
		// for a window app, and the window comes up — from the mirror, on
		// the page, the machine still off — with the app's own content.
		const webCard = p.locator('.grid > div', { has: p.locator('h3[title="offweb"]') });
		const open = webCard.locator('button[title="Open window"], button[title="打开窗口"]');
		await open.waitFor({ timeout: 10_000 });
		await open.click();
		await p.waitForSelector('iframe.app-frame', { timeout: 15_000 });
		const frame = await (async () => {
			const deadline = Date.now() + 15_000;
			for (;;) {
				const f = p.frames().find((fr) => fr.url().startsWith(APP_FRAME_URL));
				if (f) return f;
				if (Date.now() > deadline) throw new Error('the app frame never attached');
				await new Promise((r) => setTimeout(r, 100));
			}
		})();
		await frame.waitForSelector('#marker', { timeout: 15_000 });
		assert.equal(await frame.textContent('#marker'), 'off-web-marker', 'the window shows a different app');
		// app.js ran too — the bundle carried all three parts.
		assert.match((await frame.textContent('#title')) ?? '', /hello from/, 'app.js did not run in the frame');
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState), 'off', 'opening a web app booted the machine');
		// Open again: the same window, raised — not a second one.
		await open.click().catch(() => {});
		await p.waitForTimeout(800);
		assert.equal(await p.locator('iframe.app-frame').count(), 1, 'a second open made a second window');
		// And the list now says the window is up.
		const again = await p.evaluate(() => fetch('/api/releases?kind=app').then((r) => r.json()));
		assert.equal(again.releases.find((r) => r.name === 'offweb')?.status, 'active', 'an open window does not read as active');

		// The service, by contrast, needs the machine — and the machine is
		// the person's to start: a refusal in their words that points at
		// the power key, no boot.
		const svcCard = p.locator('.grid > div', { has: p.locator('h3[title="offsvc"]') });
		await svcCard.locator('button[title="Start"], button[title="启动"]').click();
		await p.getByText(/power it on with the key|请用右下角的电源键/).last().waitFor({ timeout: 10_000 });
		await p.waitForTimeout(1_000);
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState), 'off', 'starting a service booted a machine left off');

		// Uninstall, machine still off — the person's own click path, the
		// card's overflow menu and its confirm. The web app first: its
		// window closes, its card leaves, and the guest's remove happens in
		// the mirror (the package, the sidecars, the autostart line), with
		// no boot and no word about power. The service next: a package is
		// the mirror's just as much while the machine is off — nothing runs
		// that would need stopping — so it goes the same way.
		const uninstall = async (id) => {
			const h3 = p.locator(`h3[title="${id}"]`);
			const box = p.locator('.grid > div', { has: h3 });
			await box.hover();
			await box.locator('button:has(svg.lucide-ellipsis)').click();
			await p.click('button:has-text("Uninstall"), button:has-text("卸载")');
			await p.click('button:has-text("Confirm"), button:has-text("确认")');
			await h3.waitFor({ state: 'detached', timeout: 15_000 });
		};
		await uninstall('offweb');
		assert.equal(await p.locator('iframe.app-frame').count(), 0, 'uninstalling the web app left its window open');
		for (const k of ['c/apps/offweb.vapp', 'c/apps/offweb.web', 'c/apps/offweb.kind']) {
			assert.ok(!(await mirrorHasKey(p, k)), `the mirror kept ${k} after the uninstall`);
		}
		assert.doesNotMatch((await mirrorText(p, 'c/apps/enabled')) ?? '', /^offweb$/m, 'the mirror’s autostart list still names the removed web app');
		await uninstall('offsvc');
		assert.ok(!(await mirrorHasKey(p, 'c/apps/offsvc.vapp')), 'the mirror kept the removed service’s package');
		const afterRemove = await p.evaluate(() => fetch('/api/releases?kind=app').then((r) => r.json()));
		assert.deepEqual(
			afterRemove.releases.filter((r) => r.name === 'offweb' || r.name === 'offsvc'),
			[],
			`the list still names an uninstalled app: ${JSON.stringify(afterRemove.releases)}`,
		);
		assert.equal(await p.evaluate(() => document.documentElement.dataset.vmState), 'off', 'uninstalling booted the machine');

		// Power on: the replay carries the mirror in as it is now — without
		// the two packages. Neither comes back, and rund's list is empty.
		await p.evaluate(() => {
			location.hash = '#/chat';
		});
		await p.waitForSelector('textarea', { timeout: 15_000 });
		await p.click('.np-fab-power');
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, { timeout: 180_000 });
		await p.evaluate(() => window.dispatchEvent(new Event('vinx:open-console')));
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await p.waitForTimeout(3_000);
		await frameType(p, p, "ls /data/apps/ 2>&1; app list --json | jq -c '[(.apps // [])[].id] | sort'; echo REPLAY-CHECK-D''ONE");
		const replayed = await frameUntil(p, (t) => /REPLAY-CHECK-DONE/.test(t), 'the guest’s /data/apps after the off-machine uninstall', 60_000);
		assert.doesNotMatch(replayed, /offweb|offsvc/, `an app uninstalled with the machine off came back with the boot:
${replayed}`);
		// What is left is what the page ships (bundled-apps.ts), nothing else; the
		// guest lists in directory order, so the ids are sorted first.
		assert.match(replayed, /^\["lasertyper","nes"\]$/m, `app list names something after both uninstalls:
${replayed}`);

		// The guest's side of "installing is not enabling" (the page's is in
		// the install_app suite): a line on the list with no package behind
		// it — the leftover a mirror that missed a disable used to leave —
		// goes with a fresh install under that name, so the new package does
		// not autostart unasked; an update keeps the person's choice.
		await frameType(
			p,
			p,
			"app new stale --command >/dev/null && app pack /data/work/stale >/dev/null && echo stale >> /data/apps/enabled && " +
				"app install /data/work/stale.vapp >/dev/null; echo \"FRESH=$(app list --json | jq -c '.apps[] | select(.id==\"stale\") | .enabled') LINES=$(grep -cx stale /data/apps/enabled)\"; " +
				"app enable stale >/dev/null; app install /data/work/stale.vapp >/dev/null; echo \"UPDATE=$(app list --json | jq -c '.apps[] | select(.id==\"stale\") | .enabled')\"; " +
				"app remove stale >/dev/null; echo STALE-CHECK-D''ONE",
		);
		const stale = await frameUntil(p, (t) => /STALE-CHECK-DONE/.test(t), 'the guest’s install over a leftover autostart line', 60_000);
		assert.match(stale, /FRESH=false LINES=0/, `a fresh install kept the leftover autostart line:\n${stale}`);
		assert.match(stale, /UPDATE=true/, `an update dropped the person’s autostart choice:\n${stale}`);
	} finally {
		await ctx.close();
	}
});

test('mashing the terminal button during boot opens one window, not one per click', async () => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// The regression: rpcCall waits out the boot, so every click during it
	// queued a proc.pty and ready burst that many shells. openShellWindow
	// single-flights the wish; the segment breathes (data-state=booting)
	// so the wait reads as accepted, not stuck.
	const ctx = await browser.newContext();
	await muteNetPrompt(ctx);
	const p = await ctx.newPage();
	try {
		await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
		await p.waitForSelector('.np-fab-term', { timeout: 30_000 });
		// Catch the machine mid-boot (the page pre-boots on load).
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'booting', null, {
			timeout: 30_000,
		});
		assert.equal(
			await p.locator('.np-fab-term').getAttribute('data-state'),
			'booting',
			'the terminal segment should wear the booting state',
		);
		// The capsule says so in words too: the boot note with its progress
		// line sits beside the pill for exactly as long as the boot runs.
		assert.equal(
			await p.locator('[data-testid="vm-boot-note"]').count(),
			1,
			'the capsule should show the boot note while booting',
		);
		assert.equal(
			await p.locator('[data-testid="vm-console"]').isVisible(),
			false,
			'the console should start hidden',
		);
		await p.click('.np-fab-term');
		// A cold click opens the console first (the boot log on ttyS0), so
		// a slow machine shows something at once instead of a dead button;
		// the shell window still follows when the machine is up.
		await p.locator('[data-testid="vm-console"]').waitFor({ state: 'visible', timeout: 10_000 });
		await p.click('.np-fab-term');
		await p.click('.np-fab-term');
		await p.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
			timeout: 180_000,
		});
		// The one accepted click opens its window; give any stowaways a
		// moment to surface before counting.
		await p.waitForSelector('.tty-term', { timeout: 30_000 });
		await p.waitForTimeout(2_000);
		assert.equal(
			await p.locator('.tty-term').count(),
			1,
			'clicks queued during boot burst extra shell windows',
		);
		assert.equal(
			await p.locator('[data-testid="vm-boot-note"]').count(),
			0,
			'the boot note outlived the boot',
		);
	} finally {
		await ctx.close();
	}
});

test('the open_terminal button opens this machine’s console, not another computer', async (page) => {
	// The vendored renderer popped `/terminal/` in a new tab — a *different*
	// VM wearing the name "terminal". The chat page overrides the renderer
	// (app/open-terminal-tool.tsx): same testid, but the button now opens the
	// in-page machine console. No VM needed for the tool itself — it is
	// engine-side and does nothing.
	await configure(page, 'mock-open-terminal');

	// Through the composer, not fetch: the whole point is the button the UI
	// renders for the tool result. By testid, not text: the card header also
	// says "Open Terminal" (and would toggle the card closed if clicked), and
	// the button label is localized. `.last()` because the conversation is
	// shared across this suite (one origin, one IndexedDB): an earlier test's
	// turn may have left the same button higher up the transcript.
	await page.fill('textarea', 'give me a terminal');
	await page.keyboard.press('Enter');
	const button = page.locator('[data-testid="open-terminal"]').last();
	await button.waitFor({ timeout: 60_000 });

	// A popup here would mean the old renderer is back: another computer in
	// a new tab, dressed as this machine's terminal.
	let popped = false;
	page.once('popup', () => {
		popped = true;
	});
	await button.click();
	const panel = page.locator('[data-testid="vm-console"]');
	await panel.waitFor({ state: 'visible', timeout: 10_000 });
	assert.equal(popped, false, 'open_terminal popped a new tab instead of this machine’s console');
	await page.locator('[data-testid="vm-console"] .vga-btn').last().click();
});

// The fake-media flags feed getUserMedia a generated test pattern, which is
// what lets the camera(1) test run headless with no permission prompt; they
// change nothing for pages that never ask for media.
const browser = await chromium.launch({
	channel: 'chrome',
	headless: true,
	args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext();
await muteNetPrompt(context);
// The suite keeps exercising the hidden-by-default bridge machinery; the
// one test that asserts the default builds its own unflagged context.
await enableBridgeUi(context);
const page = await context.newPage();

const seen = new Map();
const note = (m) => seen.set(m, (seen.get(m) ?? 0) + 1);
const problems = () => [...seen].map(([m, n]) => (n > 1 ? `${m} (x${n})` : m));

page.on('pageerror', (e) => {
	// The first stack frames name the culprit chunk; the message alone
	// ("offset is out of bounds") names nothing.
	const stack =
		e.stack && e.stack !== e.message
			? `\n      ${String(e.stack).split('\n').slice(0, 5).join('\n      ')}`
			: '';
	note(`page error: ${e.message}${stack}`);
});
page.on('console', (m) => {
	if (m.type() === 'error') note(`console error: ${m.text()}`);
	if (m.text().includes('unimplemented route')) note(m.text());
});
page.on('response', (r) => {
	if (r.status() >= 400) note(`HTTP ${r.status()} ${r.url()}`);
});

await page.goto(APP_URL, { waitUntil: 'networkidle' });
await ready(page);

// TEST_FILTER=<regex> runs a subset while debugging. Mind the couplings:
// a few tests reuse the page state their predecessor left behind.
const chosen = process.env.TEST_FILTER
	? tests.filter((t) => new RegExp(process.env.TEST_FILTER).test(t.name))
	: tests;

let failed = 0;
for (const { name, fn } of chosen) {
	try {
		await fn(page, context);
		console.log(`  ok    ${name}`);
	} catch (e) {
		failed++;
		console.log(`  FAIL  ${name}`);
		console.log(`        ${String(e.message).split('\n').join('\n        ')}`);
	}
}

const shot = resolve(import.meta.dirname, '../../build/browser-test.png');
await mkdir(dirname(shot), { recursive: true });
await page.screenshot({ path: shot, fullPage: false });
console.log(`\nscreenshot: ${shot}`);

await browser.close();

if (seen.size) {
	console.log('\nbrowser reported:');
	for (const p of problems()) console.log(`  ${p}`);
}

console.log(`\n${chosen.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
