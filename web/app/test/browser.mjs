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

/** The one origin serving the document, the code, and the VM images. */
const APP_URL = process.env.APP_URL;
const MOCK_LLM_URL = process.env.MOCK_LLM_URL;
/** Set by browser.sh when app/public/vm/ carries the built images. */
const VM_IMAGES = process.env.VM_IMAGES === '1';
assert.ok(APP_URL, 'APP_URL must point at the static server');
assert.ok(MOCK_LLM_URL, 'MOCK_LLM_URL must point at the mock endpoint');

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
function muteNetPrompt(ctx) {
	return ctx.addInitScript(() => localStorage.setItem('vinx.net.prompted', '1'));
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

/** Concatenated text of the `content` frames. */
function text(sse) {
	return [...sse.matchAll(/^event: content\ndata: (.+)$/gm)]
		.map((m) => JSON.parse(m[1]).text)
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
 * rootless, and a predicate that throws kills the wait instead of retrying. */
function vmReady(frame, timeout = 120_000) {
	return frame.waitForFunction(() => document.documentElement?.dataset.vmState === 'ready', null, {
		timeout,
	});
}

function frameScreen(frame) {
	return frame.evaluate(() =>
		[...document.querySelectorAll('.xterm-rows > div')]
			.map((row) => row.textContent.replace(/\u00a0/g, ' ').replace(/\s+$/, ''))
			.join('\n')
			.replace(/\n+$/, ''),
	);
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

/** Type into a pane's console: the click focuses the frame's xterm, the
 * page-level keyboard then lands there. */
async function frameType(page, frame, line) {
	await frame.click('.xterm-screen');
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
	assert.match(system, /Available Skills/, `no manifest in the system message: ${system.slice(0, 400)}`);
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

test('the apps page leads to the console rather than to a 404', async (page) => {
	const href = await eventually(
		page,
		() =>
			[...document.querySelectorAll('a[href]')]
				.map((a) => a.getAttribute('href'))
				.find((h) => h && h.includes('terminal')) ?? null,
		'no link to the console',
		5_000,
	).catch(() => null);
	// The console is a second document at `/terminal/` — the URL the vendored
	// apps page and open_terminal button both use — served as a directory
	// index by this build.
	const url = new URL('terminal/', APP_URL).href;
	const res = await page.evaluate((u) => fetch(u).then((r) => r.status), url);
	assert.equal(res, 200, 'the console document is not served');
	if (href) assert.match(href, /terminal/);
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
	// vm.runShell -> agentd on ttyS1 -> back. mock-run-shell calls `echo hi`
	// and its second leg echoes the tool result, so "hi" in the final content
	// proves the output made the round trip. The unsafe tool parks at the
	// approval gate; the reader approves it and keeps going.
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
	// `pwd`; /data in the echo proves agentd cd'd there at startup, so the
	// model's relative paths land where they survive a reload.
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
		await frame.waitForSelector('.xterm-rows', { timeout: 30_000 });

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

	// A body past the inline bound rides /data, exact bytes: the kernel image
	// is ~9 MB, the cap cuts it at exactly 2 MiB, and wc must agree.
	await frameType(
		page,
		frame,
		`fetch -o /tmp/big.bin /vm/bzImage 2>&1; wc -c < /tmp/big.bin; echo BIG-D''ONE`,
	);
	const big = await frameUntil(frame, (t) => /BIG-DONE/.test(t), 'the spilled body', 90_000);
	assert.match(big, /2097152/, `the /data overflow lane lost bytes:\n${big}`);
	// The overflow relay must not linger for the /data mirror to pick up.
	await frameType(page, frame, `ls /data/.hostcall-* 2>&1; echo CLEAN-D''ONE`);
	const clean = await frameUntil(frame, (t) => /CLEAN-DONE/.test(t), 'the relay cleanup', 15_000);
	assert.match(clean, /No such file/, `overflow relays were left behind:\n${clean}`);

	// A request past the inline bound rides /data the other way: a ~40 KB
	// script goes out as CALL {req}, runs whole, and the relay file is the
	// CLI's to delete. The asserted value (42000) never appears in the typed
	// command, so the echo cannot satisfy the match.
	await frameType(
		page,
		frame,
		`{ i=0; while [ $i -lt 2200 ]; do echo 'console.log("y")'; i=$((i+1)); done; ` +
			`echo 'return 6*7*1000'; } > /tmp/bigreq.js; wc -c /tmp/bigreq.js; ` +
			`js /tmp/bigreq.js | tail -n1; ls /data/.hostcall-req-* 2>&1; echo BIGREQ-D''ONE`,
	);
	const bigReq = await frameUntil(frame, (t) => /BIGREQ-DONE/.test(t), 'the big request', 60_000);
	assert.match(bigReq, /42000/, `a >32 KiB script did not survive the /data relay:\n${bigReq}`);
	assert.match(bigReq, /No such file/, `request relays were left behind:\n${bigReq}`);
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

test('a saved machine restores on reload, and a corrupt snapshot falls back cold', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// This VM has been up far longer than the save delay, so a snapshot
	// exists. Leave a marker in /data, give the mirror a beat to catch it,
	// then reload: the boot must come back 'restored' (near-instant), the
	// console must answer, and /data must hold the marker again.
	const frame = await paneFrame(page);
	await vmReady(frame);
	await frameUntil(frame, (t) => /#\s*$/.test(t), 'a prompt');
	await frameType(page, frame, "echo kept > /data/snap-probe.txt && echo SNAP-''SET");
	await frameUntil(frame, (t) => /SNAP-SET/.test(t), 'the marker write');
	// Wait for the mirror row itself (the 15 s loop runs on its own phase;
	// a fixed sleep would race it). The state snapshot was saved minutes ago.
	{
		const deadline = Date.now() + 45_000;
		for (;;) {
			const mirrored = await frame.evaluate(async () => {
				const db = await new Promise((resolve, reject) => {
					const req = indexedDB.open('vinx.vm');
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				const key = await new Promise((resolve) => {
					const get = db
						.transaction('share', 'readonly')
						.objectStore('share')
						.getKey('p1/snap-probe.txt');
					get.onsuccess = () => resolve(get.result ?? null);
					get.onerror = () => resolve(null);
				});
				db.close();
				return key != null;
			});
			if (mirrored) break;
			if (Date.now() > deadline) throw new Error('the marker never reached the mirror');
			await new Promise((r) => setTimeout(r, 1_000));
		}
	}

	await page.reload({ waitUntil: 'networkidle' });
	const warm = await paneFrame(page);
	await vmReady(warm);
	assert.equal(
		await warm.evaluate(() => document.documentElement.dataset.vmBoot),
		'restored',
		'the reload did not restore from the snapshot',
	);
	await frameUntil(warm, (t) => /#\s*$/.test(t), 'a prompt after restore');
	// The wake-up wiped /data and the mirror restore repopulates it just
	// after 'ready' — poll rather than race it.
	await frameType(
		page,
		warm,
		"i=0; while [ $i -lt 30 ] && [ ! -f /data/snap-probe.txt ]; do i=$((i+1)); sleep 1; done; cat /data/snap-probe.txt; echo SNAP-''READ",
	);
	const read = await frameUntil(warm, (t) => /SNAP-READ/.test(t), 'the marker read', 60_000);
	assert.match(read, /kept/, `the /data marker did not survive the restored boot:\n${read}`);

	// Corrupt the stored state; the loader must shrug and boot cold.
	const corrupted = await page.evaluate(async () => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open('vinx.vm-state');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const tx = db.transaction('snapshots', 'readwrite');
		const store = tx.objectStore('snapshots');
		const record = await new Promise((resolve) => {
			const get = store.get('1');
			get.onsuccess = () => resolve(get.result ?? null);
			get.onerror = () => resolve(null);
		});
		if (record) {
			record.blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
			store.put(record, '1');
		}
		await new Promise((resolve) => {
			tx.oncomplete = resolve;
			tx.onerror = resolve;
		});
		db.close();
		return record !== null;
	});
	assert.ok(corrupted, 'no snapshot record found to corrupt');

	await page.reload({ waitUntil: 'networkidle' });
	const cold = await paneFrame(page);
	await vmReady(cold);
	assert.equal(
		await cold.evaluate(() => document.documentElement.dataset.vmBoot),
		'cold',
		'a corrupt snapshot should have fallen back to a cold boot',
	);
});

test('a second tab playing the same pane cold-boots: one name, one snapshot', async (page, context) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Two tabs both play pane 1 and share one snapshot record; restoring it
	// twice would put two NICs with the same MAC (and the same derived
	// address) on the shared in-browser hub. The Web Lock arbitrates: the
	// tab holding the machine name restores, any other cold-boots into a
	// fresh random MAC.
	//
	// First wait for a restorable snapshot to exist again — the previous
	// test left this page freshly cold-booted, and its 10-second save timer
	// replaces the 4-byte corrupted stand-in with a real multi-megabyte
	// record. Only then does the second tab's cold boot prove the lock (and
	// not a missing snapshot) made the call.
	{
		const deadline = Date.now() + 60_000;
		for (;;) {
			const size = await page.evaluate(async () => {
				const db = await new Promise((resolve, reject) => {
					const req = indexedDB.open('vinx.vm-state');
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				const record = await new Promise((resolve) => {
					const get = db.transaction('snapshots').objectStore('snapshots').get('1');
					get.onsuccess = () => resolve(get.result ?? null);
					get.onerror = () => resolve(null);
				});
				db.close();
				return record?.blob?.size ?? 0;
			});
			if (size > 1_000_000) break;
			if (Date.now() > deadline) {
				throw new Error(`no fresh snapshot appeared to contend for (blob ${size} B)`);
			}
			await new Promise((r) => setTimeout(r, 1_000));
		}
	}

	const second = await context.newPage();
	try {
		await second.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
		const pane = await paneFrame(second);
		await vmReady(pane);
		assert.equal(
			await pane.evaluate(() => document.documentElement.dataset.vmBoot),
			'cold',
			'the second tab restored the shared snapshot — two identical MACs on one hub',
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
	// one, but the utterance text proves the OSC arrived intact.
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

	// camera(1): the launch flags below give getUserMedia a fake device, so
	// no permission prompt blocks the frame. The guest script polls /data for
	// the PNG and reports; the magic bytes prove a real encode happened.
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
	await frame.click('.xterm-screen', { position: { x: 5, y: 5 } });
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

	// Close the panel first: lvdemo asks the page to reopen it (js -e
	// window.vinxScreenShow), and only an absent panel can prove that.
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
			.click('.xterm-screen', { position: { x: 5, y: 5 }, force: true })
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
	await frame.click('.xterm-screen', { position: { x: 5, y: 5 } });
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

		// A hosts. The code comes back through /data/.bridge-status and the
		// script prints the join line, plus the pointer at `bridge say`.
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
	await frame.click('.xterm-screen');
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
function attachApproving(page, sessionId, budget = 120_000) {
	return page.evaluate(
		async ([id, BUDGET]) => {
			const res = await fetch(`/api/chat/stream/${encodeURIComponent(id)}`);
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			const start = Date.now();
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
				if (!approved && /event: confirm\b/.test(out)) {
					approved = true;
					const m = out.match(/event: confirm\ndata: (.+)/);
					const callId = m ? (JSON.parse(m[1]).id ?? null) : null;
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

test('run_shell can call js(1): the agentd path an OSC channel could never serve', async (page) => {
	if (!VM_IMAGES) {
		console.log('        (skipped: no VM images; set VM_IMAGES=1 after ../linux/build.sh)');
		return;
	}
	// Still on the chat page with a ready VM. The long way round on purpose:
	// engine -> run_shell -> agentd (ttyS1, stdout captured) -> js(1) ->
	// hostcall (ttyS3) -> the page -> all the way back. This is exactly the
	// leg where escape-sequence commands (imgcat, open) do nothing.
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
	// 32 KiB of payload in the command: its base64 RUN line used to be able
	// to truncate silently on the serial path (a cut on a 4-char boundary
	// still decodes). agentd now checks the length; wc -c saying 32768 means
	// every byte made it and the command really ran.
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

test('the open_terminal button opens terminal/ under the site root, not the domain root', async (page) => {
	// Served under /nested/site/ (the assets server aliases the same tree
	// there): the old hard-coded "/terminal" would pop the domain root and
	// 404 on a GitHub-Pages-style deployment. No VM needed — the tool is
	// engine-side and does nothing.
	await page.goto(new URL('nested/site/', APP_URL).href, {
		waitUntil: 'networkidle',
	});
	await ready(page);
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

	const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
	popupPromise.catch(() => {});
	await button.click();
	const popup = await popupPromise;
	try {
		assert.equal(
			new URL(popup.url()).pathname,
			'/nested/site/terminal/',
			'the terminal did not open under the site root',
		);
	} finally {
		if (!popup.isClosed()) await popup.close();
	}
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

page.on('pageerror', (e) => note(`page error: ${e.message}`));
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
