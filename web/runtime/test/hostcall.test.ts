/**
 * The page's executors and control-plane methods, off the wire: runJs's REPL
 * semantics and console capture, hostFetch against a real local server, and
 * the §6.8 resource-ref decisions in pageMethods (inline under the budget,
 * /data/.vinx/tmp past it, honest errors when the ref or the mount is bad).
 *
 * The old CALL/DONE codec (parseCallLine/buildDoneLine) retired with the
 * hostcall wire itself — the VX1/JSON-RPC link that replaced it is tested in
 * rpc.test.ts. What lives on here is what still executes.
 *
 * The app module is imported directly (the share-diff precedent): everything
 * in it runs under node — AsyncFunction, fetch, TextDecoder are all here —
 * except scripts that touch `document`, which these tests do not.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	hostFetch,
	pageMethods,
	runJs,
	type BleBroker,
	type BridgeControl,
	type DesktopSurface,
	type RefIo,
	type WindowService,
} from '../../app/hostcall';
import { INLINE_MAX, ServeError, type ServeContext } from '../../app/rpc';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const decoder = new TextDecoder();

describe('runJs', () => {
	it('answers a bare expression, REPL-style', async () => {
		expect(await runJs('6*7')).toEqual({ ok: true, output: '42' });
	});
	it('falls back to function-body semantics for statements', async () => {
		expect(await runJs('const a = 40; return a + 2;')).toEqual({ ok: true, output: '42' });
	});
	it('captures console output alongside the value', async () => {
		const ran = await runJs('console.log("step", 1); console.warn("careful"); return "done"');
		expect(ran.ok).toBe(true);
		expect(ran.output).toBe('step 1\n[warn] careful\ndone');
	});
	it('reports a thrown error as an outcome, not an exception', async () => {
		const ran = await runJs('null.x');
		expect(ran.ok).toBe(false);
		expect(ran.output).toContain('TypeError');
	});
	it('reports a syntax error without constructing anything', async () => {
		const ran = await runJs('for (;;');
		expect(ran.ok).toBe(false);
		expect(ran.output).toContain('SyntaxError');
	});
	it('awaits, and times an over-long await out', async () => {
		const quick = await runJs('await new Promise(r => setTimeout(() => r(7), 10))');
		expect(quick).toEqual({ ok: true, output: '7' });
		const slow = await runJs('await new Promise(() => {})', 50);
		expect(slow.ok).toBe(false);
		expect(slow.output).toContain('timed out');
	});
	it('says something when the script says nothing', async () => {
		const ran = await runJs('let x = 1;');
		expect(ran.ok).toBe(true);
		expect(ran.output).toContain('no output');
	});
	it('restores the console it hijacked', async () => {
		const before = console.log;
		await runJs('console.log("captured")');
		expect(console.log).toBe(before);
	});
	it('keeps two overlapping runs straight and restores after the last one', async () => {
		const before = console.log;
		const slow = runJs('await new Promise(r => setTimeout(r, 40)); console.log("late"); return "slow"');
		const quick = await runJs('console.log("early"); return "quick"');
		// The quick run is done but the slow one still holds the console.
		expect(console.log).not.toBe(before);
		const done = await slow;
		expect(console.log).toBe(before);
		// "early" fell while both sinks were live, so both carry it (fan-out
		// over attribution); "late" came after the quick run left.
		expect(quick.output).toBe('early\nquick');
		expect(done.output).toBe('early\nlate\nslow');
	});
});

// ── a local server both hostFetch and http.fetch run against ──

let server: Server;
let base: string;
beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === '/text') {
			res.writeHead(200, { 'content-type': 'text/plain', 'x-flavor': 'plain' });
			res.end('hello from node');
		} else if (req.url === '/echo') {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						method: req.method,
						body: Buffer.concat(chunks).toString(),
						header: req.headers['x-probe'] ?? null,
					}),
				);
			});
		} else if (req.url === '/binary') {
			res.writeHead(200, { 'content-type': 'application/octet-stream' });
			res.end(Buffer.from([0xff, 0x00, 0xfe, 0x01]));
		} else if (req.url === '/big') {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('y'.repeat(INLINE_MAX * 4));
		} else {
			res.writeHead(404);
			res.end('gone');
		}
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const addr = server.address();
	base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => {
	server.close();
});

describe('hostFetch', () => {
	it('fetches text with status and headers', async () => {
		const got = await hostFetch({ url: `${base}/text` });
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(got.status).toBe(200);
		expect(got.headers['x-flavor']).toBe('plain');
		expect(new TextDecoder().decode(got.bytes)).toBe('hello from node');
	});
	it('carries method, headers and a base64 body', async () => {
		const got = await hostFetch({
			url: `${base}/echo`,
			method: 'POST',
			headers: { 'x-probe': 'yes' },
			bodyB64: b64('exact bytes'),
		});
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(JSON.parse(new TextDecoder().decode(got.bytes))).toEqual({
			method: 'POST',
			body: 'exact bytes',
			header: 'yes',
		});
	});
	it('carries raw bodyBytes without a base64 leg', async () => {
		const got = await hostFetch({
			url: `${base}/echo`,
			method: 'POST',
			bodyBytes: new TextEncoder().encode('raw payload 中文'),
		});
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(JSON.parse(new TextDecoder().decode(got.bytes)).body).toBe('raw payload 中文');
	});
	it('reports an unreachable host as an error naming the usual suspect', async () => {
		const got = await hostFetch({ url: 'http://127.0.0.1:9/', timeoutMs: 2_000 });
		expect(got.ok).toBe(false);
		if (got.ok) return;
		expect(got.error).toContain('fetch:');
	});
	it('refuses an unusable URL outright', async () => {
		// No `location` under node, so a relative URL has no base to resolve
		// against — in the page it resolves against the page instead.
		expect((await hostFetch({ url: '::not a url::' })).ok).toBe(false);
	});
	it('stops the transfer when the outer signal aborts', async () => {
		const ctl = new AbortController();
		const p = hostFetch({ url: `${base}/text` }, ctl.signal);
		ctl.abort();
		const got = await p;
		// A race either way is honest: cancelled, or finished just before.
		if (!got.ok) expect(got.error).toContain('cancelled');
	});
});

// ── the control-plane methods over a fake /data ──

function fakeIo(): { io: RefIo; files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		io: {
			read: async (path) => {
				const got = files.get(path);
				if (!got) throw new Error('missing');
				return got;
			},
			write: async (path, bytes) => {
				files.set(path, bytes);
			},
		},
	};
}

function ctx(id = 'g.1.1'): ServeContext {
	return { id, signal: new AbortController().signal, deadlineMs: 30_000 };
}

describe('pageMethods: debug.js', () => {
	it('answers inline under the budget', async () => {
		const { io } = fakeIo();
		const reply = (await pageMethods(io)['debug.js']({ code: '"x"' }, ctx())) as Record<string, unknown>;
		expect(reply).toEqual({ ok: true, output: 'x' });
	});
	it('spills a big output to /data/.vinx/tmp and answers an outputRef', async () => {
		const { io, files } = fakeIo();
		const reply = (await pageMethods(io)['debug.js'](
			{ code: `"z".repeat(${INLINE_MAX + 10})` },
			ctx('g.7.2'),
		)) as { ok: boolean; outputRef: { path: string; size: number; owner: string } };
		expect(reply.ok).toBe(true);
		expect(reply.outputRef.path).toBe('/data/.vinx/tmp/js-g.7.2.out');
		expect(reply.outputRef.owner).toBe('caller');
		expect(decoder.decode(files.get(reply.outputRef.path))).toBe('z'.repeat(INLINE_MAX + 10));
		expect(reply.outputRef.size).toBe(INLINE_MAX + 10);
	});
	it('reads staged code through codeRef, size checked', async () => {
		const { io, files } = fakeIo();
		const code = new TextEncoder().encode('40 + 2');
		files.set('/data/.vinx/tmp/js-77.code', code);
		const reply = (await pageMethods(io)['debug.js'](
			{ codeRef: { path: '/data/.vinx/tmp/js-77.code', size: code.byteLength } },
			ctx(),
		)) as Record<string, unknown>;
		expect(reply).toEqual({ ok: true, output: '42' });
	});
	it('refuses a ref outside the tmp namespace, a size mismatch, and empty code', async () => {
		const { io, files } = fakeIo();
		const methods = pageMethods(io);
		await expect(
			methods['debug.js']({ codeRef: { path: '/data/secrets.txt' } }, ctx()),
		).rejects.toSatisfy((e: unknown) => e instanceof ServeError && e.rpc.name === 'RESOURCE_INVALID');
		await expect(
			methods['debug.js']({ codeRef: { path: '/data/.vinx/tmp/../../etc/passwd' } }, ctx()),
		).rejects.toSatisfy((e: unknown) => e instanceof ServeError && e.rpc.name === 'RESOURCE_INVALID');
		files.set('/data/.vinx/tmp/short.code', new Uint8Array(3));
		await expect(
			methods['debug.js']({ codeRef: { path: '/data/.vinx/tmp/short.code', size: 99 } }, ctx()),
		).rejects.toSatisfy((e: unknown) => e instanceof ServeError && e.rpc.name === 'RESOURCE_INVALID');
		await expect(methods['debug.js']({}, ctx())).rejects.toSatisfy(
			(e: unknown) => e instanceof ServeError && e.rpc.name === 'INVALID_PARAMS',
		);
	});
	it('turns a failed /data write into DATA_PLANE_UNAVAILABLE', async () => {
		const io: RefIo = {
			read: async () => {
				throw new Error('no');
			},
			write: async () => {
				throw new Error('no 9p mount');
			},
		};
		await expect(
			pageMethods(io)['debug.js']({ code: `"z".repeat(${INLINE_MAX * 2})` }, ctx()),
		).rejects.toSatisfy(
			(e: unknown) => e instanceof ServeError && e.rpc.name === 'DATA_PLANE_UNAVAILABLE',
		);
	});
});

describe('pageMethods: http.fetch', () => {
	it('answers a small text body inline', async () => {
		const { io } = fakeIo();
		const reply = (await pageMethods(io)['http.fetch']({ url: `${base}/text` }, ctx())) as Record<
			string,
			unknown
		>;
		expect(reply.ok).toBe(true);
		expect(reply.status).toBe(200);
		expect(reply.body).toBe('hello from node');
		expect(reply.bodyRef).toBeUndefined();
	});
	it('answers a small binary body as base64', async () => {
		const { io } = fakeIo();
		const reply = (await pageMethods(io)['http.fetch']({ url: `${base}/binary` }, ctx())) as Record<
			string,
			unknown
		>;
		expect(reply.bodyB64).toBe(Buffer.from([0xff, 0x00, 0xfe, 0x01]).toString('base64'));
		expect(reply.body).toBeUndefined();
	});
	it('spills a big body to /data/.vinx/tmp and answers a bodyRef', async () => {
		const { io, files } = fakeIo();
		const reply = (await pageMethods(io)['http.fetch']({ url: `${base}/big` }, ctx('g.9.1'))) as {
			ok: boolean;
			bodyRef: { path: string; size: number; binary: boolean; expiresWithSession: boolean };
		};
		expect(reply.ok).toBe(true);
		expect(reply.bodyRef.path).toBe('/data/.vinx/tmp/fetch-g.9.1.bin');
		expect(reply.bodyRef.size).toBe(INLINE_MAX * 4);
		expect(reply.bodyRef.binary).toBe(false);
		expect(reply.bodyRef.expiresWithSession).toBe(true);
		expect(files.get(reply.bodyRef.path)?.byteLength).toBe(INLINE_MAX * 4);
	});
	it('sends a staged request body through bodyRef', async () => {
		const { io, files } = fakeIo();
		const staged = new TextEncoder().encode('big body from /data');
		files.set('/data/.vinx/tmp/body-1.bin', staged);
		const reply = (await pageMethods(io)['http.fetch'](
			{
				url: `${base}/echo`,
				method: 'POST',
				bodyRef: { path: '/data/.vinx/tmp/body-1.bin', size: staged.byteLength },
			},
			ctx(),
		)) as { body: string };
		expect(JSON.parse(reply.body).body).toBe('big body from /data');
	});
	it('keeps HTTP errors as answered requests, not failures', async () => {
		const { io } = fakeIo();
		const reply = (await pageMethods(io)['http.fetch']({ url: `${base}/nope` }, ctx())) as Record<
			string,
			unknown
		>;
		expect(reply.ok).toBe(true);
		expect(reply.status).toBe(404);
	});
	it('answers transport failure as {ok:false}, an application outcome', async () => {
		const { io } = fakeIo();
		const reply = (await pageMethods(io)['http.fetch'](
			{ url: 'http://127.0.0.1:9/', timeoutMs: 2_000 },
			ctx(),
		)) as Record<string, unknown>;
		expect(reply.ok).toBe(false);
		expect(String(reply.error)).toContain('fetch:');
	});
});

// ── the Phase 3 capability methods: the OSC 7770 successors ──

const errName = (name: string) => (e: unknown) => e instanceof ServeError && e.rpc.name === name;

describe('pageMethods: desktop capabilities', () => {
	it('notify.show says what carried it, and is honest with nothing to carry', async () => {
		const { io } = fakeIo();
		const shown: string[] = [];
		const withToast = pageMethods(io, {
			notify: (text) => {
				shown.push(text);
				return 'note';
			},
		});
		expect(await withToast['notify.show']({ text: 'the kettle boiled' }, ctx())).toEqual({
			via: 'note',
		});
		expect(shown).toEqual(['the kettle boiled']);
		await expect(withToast['notify.show']({}, ctx())).rejects.toSatisfy(errName('INVALID_PARAMS'));
		// No permission, no toast: an error the guest hears, never a no-op.
		const nowhere = pageMethods(io, { notify: () => null });
		await expect(nowhere['notify.show']({ text: 'x' }, ctx())).rejects.toSatisfy(errName('UNAVAILABLE'));
		await expect(pageMethods(io)['notify.show']({ text: 'x' }, ctx())).rejects.toSatisfy(
			errName('UNAVAILABLE'),
		);
	});

	it('speech.speak speaks or says it cannot', async () => {
		const { io } = fakeIo();
		const spoken: string[] = [];
		const methods = pageMethods(io, {
			speak: (text) => {
				spoken.push(text);
				return true;
			},
		});
		expect(await methods['speech.speak']({ text: 'vinx can speak now' }, ctx())).toEqual({});
		expect(spoken).toEqual(['vinx can speak now']);
		await expect(pageMethods(io)['speech.speak']({ text: 'x' }, ctx())).rejects.toSatisfy(
			errName('UNAVAILABLE'),
		);
	});

	it('media.camera.capture answers an explicit /data image ref', async () => {
		const { io } = fakeIo();
		const methods = pageMethods(io, { captureCamera: async () => 12345 });
		expect(await methods['media.camera.capture']({ name: 'shot.png' }, ctx())).toEqual({
			image: { path: '/data/shot.png', size: 12345, owner: 'caller', expiresWithSession: false },
		});
		// The filename shape is re-checked here: a forged call cannot name a path.
		await expect(
			methods['media.camera.capture']({ name: '../etc/passwd' }, ctx()),
		).rejects.toSatisfy(errName('INVALID_PARAMS'));
		// A denied permission is the capability being unavailable.
		const denied = pageMethods(io, {
			captureCamera: async () => {
				throw new Error('Permission denied');
			},
		});
		await expect(denied['media.camera.capture']({ name: 'a.png' }, ctx())).rejects.toSatisfy(
			errName('UNAVAILABLE'),
		);
	});

	it('window.openUrl reports the disposition and guards the scheme', async () => {
		const { io } = fakeIo();
		const opened: string[] = [];
		const methods = pageMethods(io, {
			openUrl: (url) => {
				opened.push(url);
				return url.includes('blocked') ? 'parked' : 'opened';
			},
		});
		expect(await methods['window.openUrl']({ url: 'https://a.example/' }, ctx())).toEqual({
			disposition: 'opened',
		});
		expect(await methods['window.openUrl']({ url: 'https://blocked.example/' }, ctx())).toEqual({
			disposition: 'parked',
		});
		// The page is the security boundary; a non-web scheme dies loudly.
		await expect(
			methods['window.openUrl']({ url: 'javascript:alert(1)' }, ctx()),
		).rejects.toSatisfy(errName('INVALID_PARAMS'));
		expect(opened).toEqual(['https://a.example/', 'https://blocked.example/']);
	});

	it('resource.open and resource.download consume a §6.8 ref', async () => {
		const { io, files } = fakeIo();
		const staged = new TextEncoder().encode('vm-page-render');
		files.set('/data/.vinx/tmp/open-1.bin', staged);
		const got: { name: string; bytes: Uint8Array }[] = [];
		const methods = pageMethods(io, {
			openFile: (name, bytes) => {
				got.push({ name, bytes });
				return 'opened';
			},
			download: (name, bytes) => {
				got.push({ name, bytes });
				return true;
			},
		});
		const ref = { path: '/data/.vinx/tmp/open-1.bin', size: staged.byteLength };
		expect(await methods['resource.open']({ name: 'page.html', ref }, ctx())).toEqual({
			disposition: 'opened',
		});
		expect(await methods['resource.download']({ name: 'out.bin', ref }, ctx())).toEqual({});
		expect(got.map((g) => g.name)).toEqual(['page.html', 'out.bin']);
		expect(decoder.decode(got[0].bytes)).toBe('vm-page-render');
		// The ref rules are the shared ones: outside the namespace, refused.
		await expect(
			methods['resource.open']({ name: 'x', ref: { path: '/etc/passwd', size: 1 } }, ctx()),
		).rejects.toSatisfy(errName('RESOURCE_INVALID'));
	});

	it('ble.* rides the broker: results, hex validation, honest absences', async () => {
		const { io } = fakeIo();
		const writes: string[] = [];
		const broker: BleBroker = {
			connect: async () => ({ device: 'e2e-ble', id: 'dev-1' }),
			status: () => ({ state: 'connected', device: 'e2e-ble', id: 'dev-1' }),
			scan: async () => ({ pending: true, note: 'click the chip' }),
			services: async () => 'svc 180d\n  chr 2a37  notify',
			read: async () => 'ab10',
			write: async (_s, _c, hex) => {
				writes.push(hex);
			},
			subscribe: async () => '',
			disconnect: async () => {},
			feedPath: () => '/data/.vinx/tmp/ble-feed',
		};
		const methods = pageMethods(io, { ble: broker });
		expect(await methods['ble.connect']({}, ctx())).toEqual({ device: 'e2e-ble', id: 'dev-1' });
		expect(await methods['ble.status']({}, ctx())).toEqual({
			state: 'connected',
			device: 'e2e-ble',
			id: 'dev-1',
		});
		expect(await methods['ble.scan']({ on: true }, ctx())).toEqual({
			pending: true,
			note: 'click the chip',
			feed: { path: '/data/.vinx/tmp/ble-feed' },
		});
		expect(await methods['ble.services']({}, ctx())).toEqual({
			services: 'svc 180d\n  chr 2a37  notify',
		});
		expect(await methods['ble.read']({ svc: '180d', chr: '2a38' }, ctx())).toEqual({ value: 'ab10' });
		expect(await methods['ble.write']({ svc: '180d', chr: '2a38', hex: 'c0ffee' }, ctx())).toEqual({});
		expect(writes).toEqual(['c0ffee']);
		await expect(
			methods['ble.write']({ svc: '180d', chr: '2a38', hex: 'abc' }, ctx()),
		).rejects.toSatisfy(errName('INVALID_PARAMS'));
		// Without a broker (no Web Bluetooth, or no page) every op says so.
		await expect(pageMethods(io)['ble.connect']({}, ctx())).rejects.toSatisfy(errName('UNAVAILABLE'));
	});

	it('origin arbitration maps to its own codes: busy names the holder, hidden means foreground', async () => {
		const { io } = fakeIo();
		// RESOURCE_BUSY (1007): a broker verdict thrown by the surface (the
		// page wraps captureCamera in withOriginLock; a sibling machine
		// holding the lock raises exactly this).
		const { OriginBusyError, withOriginLock } = await import('../../app/origin-broker');
		const busy = pageMethods(io, {
			captureCamera: async () => {
				throw new OriginBusyError('camera', 'terminal machine 1');
			},
		});
		await expect(busy['media.camera.capture']({ name: 'x.png' }, ctx())).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof ServeError &&
				e.rpc.name === 'RESOURCE_BUSY' &&
				e.rpc.code === 1007 &&
				e.rpc.message.includes('terminal machine 1'),
		);
		// REQUIRES_FOREGROUND (1008): the real broker refuses a hidden
		// document before it even looks at the lock. (The E2E suite pins
		// the cross-machine busy path; a hidden tab throttles the VM that
		// would type the command, so this half is pinned here.)
		(globalThis as { document?: unknown }).document = { visibilityState: 'hidden' };
		try {
			const hidden = pageMethods(io, {
				captureCamera: (name) => withOriginLock('camera', async () => name.length),
			});
			await expect(hidden['media.camera.capture']({ name: 'x.png' }, ctx())).rejects.toSatisfy(
				(e: unknown) =>
					e instanceof ServeError && e.rpc.name === 'REQUIRES_FOREGROUND' && e.rpc.code === 1008,
			);
		} finally {
			delete (globalThis as { document?: unknown }).document;
		}
	});

	it('window.* rides the table: list, create from a bundleRef, close, move, resize', async () => {
		const { io, files } = fakeIo();
		const calls: string[] = [];
		const created: { id: string; title: string; appId?: string; bundle: { html: string } }[] = [];
		const table: WindowService = {
			list: () => [{ id: 'screen', title: 'screen', surface: 'screen', open: true }],
			create: (spec) => {
				created.push(spec);
			},
			close: (id) => {
				calls.push(`close:${id}`);
				return id !== 'ghost';
			},
			focus: (id) => id !== 'ghost',
			move: (id, x, y) => {
				calls.push(`move:${id}:${x},${y}`);
				return true;
			},
			resize: (id, w, h) => {
				calls.push(`resize:${id}:${w}x${h}`);
				return true;
			},
		};
		const methods = pageMethods(io, { windows: table });

		expect(await methods['window.list']({}, ctx())).toEqual({
			windows: [{ id: 'screen', title: 'screen', surface: 'screen', open: true }],
		});

		const bundle = new TextEncoder().encode(
			JSON.stringify({ html: '<h1>hi</h1>', css: 'h1{color:red}', js: 'console.log(1)' }),
		);
		files.set('/data/.vinx/tmp/app-clock.bundle', bundle);
		const ref = { path: '/data/.vinx/tmp/app-clock.bundle', size: bundle.byteLength };
		expect(
			await methods['window.create']({ surface: 'web', app: 'clock', bundleRef: ref }, ctx()),
		).toEqual({ id: 'clock', created: true });
		expect(created[0].appId).toBe('clock');
		expect(created[0].bundle.html).toBe('<h1>hi</h1>');

		// A window without an app gets a generated id.
		const anon = (await methods['window.create'](
			{ surface: 'web', title: 'Scratch', bundleRef: ref },
			ctx(),
		)) as { id: string };
		expect(anon.id).toMatch(/^web-\d+$/);

		// The §10.3 shape is enforced: not-JSON and empty bundles refuse.
		files.set('/data/.vinx/tmp/bad.bundle', new TextEncoder().encode('<html>'));
		await expect(
			methods['window.create'](
				{ surface: 'web', bundleRef: { path: '/data/.vinx/tmp/bad.bundle', size: 6 } },
				ctx(),
			),
		).rejects.toSatisfy(errName('RESOURCE_INVALID'));
		await expect(
			methods['window.create']({ surface: 'fb', bundleRef: ref }, ctx()),
		).rejects.toSatisfy(errName('INVALID_PARAMS'));

		expect(await methods['window.close']({ id: 'clock' }, ctx())).toEqual({ closed: true });
		await expect(methods['window.close']({ id: 'ghost' }, ctx())).rejects.toSatisfy(
			errName('UNAVAILABLE'),
		);
		expect(await methods['window.move']({ id: 'clock', x: 10, y: 20 }, ctx())).toEqual({ moved: true });
		expect(await methods['window.resize']({ id: 'clock', w: 300, h: 200 }, ctx())).toEqual({
			resized: true,
		});
		await expect(methods['window.resize']({ id: 'clock', w: 0, h: 5 }, ctx())).rejects.toSatisfy(
			errName('INVALID_PARAMS'),
		);
		expect(calls).toEqual(['close:clock', 'close:ghost', 'move:clock:10,20', 'resize:clock:300x200']);

		// Without a table (a bare page) every window.* op says so.
		await expect(pageMethods(io)['window.list']({}, ctx())).rejects.toSatisfy(errName('UNAVAILABLE'));
	});

	it('network.bridge.* rides the control: status, say, honest absences', async () => {
		const { io } = fakeIo();
		const said: string[] = [];
		const control: BridgeControl = {
			start: async () => ({ state: 'on', role: 'host', room: 'abcdef', members: [] }),
			join: async () => ({ state: 'on', role: 'member', room: 'abcdef', members: [] }),
			stop: () => {},
			say: (text) => {
				said.push(text);
				return true;
			},
			status: () => ({
				state: 'on',
				role: 'host',
				room: 'abcdef',
				members: [{ name: 'vinx1', ip: '10.0.2.1', host: true }],
			}),
		};
		const methods = pageMethods(io, { bridge: control });
		expect(await methods['network.bridge.start']({ name: 'vinx1', ip: '10.0.2.1' }, ctx())).toEqual({
			state: 'on',
			role: 'host',
			room: 'abcdef',
			members: [],
		});
		const status = (await methods['network.bridge.status']({}, ctx())) as {
			members: unknown[];
		};
		expect(status.members).toHaveLength(1);
		expect(await methods['network.bridge.say']({ text: 'hello' }, ctx())).toEqual({});
		expect(said).toEqual(['hello']);
		// A dead room answers UNAVAILABLE, not silence.
		const dead: DesktopSurface = { bridge: { ...control, say: () => false } };
		await expect(
			pageMethods(io, dead)['network.bridge.say']({ text: 'x' }, ctx()),
		).rejects.toSatisfy(errName('UNAVAILABLE'));
		await expect(pageMethods(io)['network.bridge.status']({}, ctx())).rejects.toSatisfy(
			errName('UNAVAILABLE'),
		);
	});
});
