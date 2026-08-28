/**
 * The hostcall channel's brain, off the wire: the CALL/DONE codec, the runJs
 * executor's REPL semantics and console capture, hostFetch against a real
 * local server, and the /data overflow decisions in answerHostcall.
 *
 * The app module is imported directly (the share-diff precedent): everything
 * in it runs under node — AsyncFunction, fetch, TextDecoder are all here —
 * except scripts that touch `document`, which these tests do not.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
	answerHostcall,
	buildDoneLine,
	hostFetch,
	parseCallLine,
	REPLY_INLINE_MAX,
	runJs,
} from '../../app/hostcall';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('parseCallLine', () => {
	it('parses a well-formed CALL', () => {
		const payload = b64(JSON.stringify({ code: '1+1' }));
		const call = parseCallLine(`CALL 42-7 js ${payload.length} ${payload}`);
		expect(call).toEqual({ id: '42-7', kind: 'js', payload: { code: '1+1' } });
	});
	it('ignores boot noise and lines without a usable id', () => {
		expect(parseCallLine('agetty: unknown terminal')).toBeNull();
		expect(parseCallLine('DONE 1 1 0 e30=')).toBeNull();
		expect(parseCallLine('CALL ')).toBeNull();
	});
	it('answers (not ignores) a truncated payload', () => {
		const payload = b64('{"a":1}');
		const call = parseCallLine(`CALL 9 js ${payload.length + 8} ${payload}`);
		expect(call?.id).toBe('9');
		expect(call?.error).toContain('truncated');
	});
	it('answers a payload that is not base64 JSON', () => {
		const call = parseCallLine('CALL 9 js 3 !!!');
		expect(call?.id).toBe('9');
		expect(call?.error).toContain('not base64');
	});
	it('answers a CALL with the wrong number of fields', () => {
		const call = parseCallLine('CALL 9 js');
		expect(call?.id).toBe('9');
		expect(call?.error).toContain('malformed');
	});
});

describe('buildDoneLine', () => {
	it('round-trips through parse-shaped fields with the ok flag on the line', () => {
		const line = buildDoneLine('a-1', { ok: true, output: 'hi' });
		const [verb, id, ok, len, payload] = line.trim().split(' ');
		expect(verb).toBe('DONE');
		expect(id).toBe('a-1');
		expect(ok).toBe('1');
		expect(Number(len)).toBe(payload.length);
		expect(JSON.parse(Buffer.from(payload, 'base64').toString())).toEqual({
			ok: true,
			output: 'hi',
		});
		expect(line.endsWith('\n')).toBe(true);
	});
	it('flags a failure as 0 for the shell to test cheaply', () => {
		expect(buildDoneLine('x', { ok: false, error: 'no' }).split(' ')[2]).toBe('0');
	});
});

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

describe('hostFetch and the fetch kind', () => {
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
				res.end('y'.repeat(REPLY_INLINE_MAX + 100));
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

	it('answers inline for a small text body', async () => {
		const spill = vi.fn();
		const reply = await answerHostcall('fetch', { url: `${base}/text` }, 'id1', spill);
		expect(reply.ok).toBe(true);
		expect(reply.status).toBe(200);
		expect(reply.body).toBe('hello from node');
		expect(spill).not.toHaveBeenCalled();
	});
	it('answers base64 for a small binary body', async () => {
		const reply = await answerHostcall('fetch', { url: `${base}/binary` }, 'id2', vi.fn());
		expect(reply.bodyB64).toBe(Buffer.from([0xff, 0x00, 0xfe, 0x01]).toString('base64'));
		expect(reply.body).toBeUndefined();
	});
	it('spills a big body to /data and answers {file}', async () => {
		const spill = vi.fn(async (_name: string, _bytes: Uint8Array) => {});
		const reply = await answerHostcall('fetch', { url: `${base}/big` }, 'id3', spill);
		expect(reply.file).toBe('.hostcall-id3');
		expect(reply.bytes).toBe(REPLY_INLINE_MAX + 100);
		expect(reply.binary).toBe(false);
		expect(spill).toHaveBeenCalledTimes(1);
		expect(spill.mock.calls[0][0]).toBe('.hostcall-id3');
	});
	it('keeps HTTP errors as answered requests, not failures', async () => {
		const reply = await answerHostcall('fetch', { url: `${base}/nope` }, 'id4', vi.fn());
		expect(reply.ok).toBe(true);
		expect(reply.status).toBe(404);
	});
});

describe('answerHostcall, the rest', () => {
	it('answers js inline and spills a huge output', async () => {
		const small = await answerHostcall('js', { code: '"x"' }, 'a', vi.fn());
		expect(small).toEqual({ ok: true, output: 'x' });

		const spill = vi.fn(async () => {});
		const big = await answerHostcall(
			'js',
			{ code: `"z".repeat(${REPLY_INLINE_MAX + 10})` },
			'b',
			spill,
		);
		expect(big.file).toBe('.hostcall-b');
		expect(spill).toHaveBeenCalledTimes(1);
	});
	it('refuses an empty js payload and an unknown kind, both as DONE(error)', async () => {
		expect((await answerHostcall('js', {}, 'c', vi.fn())).ok).toBe(false);
		const unknown = await answerHostcall('teleport', {}, 'd', vi.fn());
		expect(unknown.ok).toBe(false);
		expect(unknown.error).toContain('teleport');
	});
});
