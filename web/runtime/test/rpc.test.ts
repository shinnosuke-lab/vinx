/**
 * The ttyS3 RPC link off the wire: VX1/VXA framing under fire, the
 * stop-and-wait sender against a fake clock, and the JSON-RPC dispatcher's
 * day-one obligations — cancel answers CANCELLED, every accepted request is
 * answered exactly once, a lost link fails fast and re-hellos.
 *
 * The app module is imported directly (the hostcall.test.ts precedent):
 * rpc.ts is pure logic, so the whole state machine runs under node. The
 * "guest" here is the test: it parses what the link transmits and answers
 * by feeding bytes back, which is exactly what rpcd does with a real UART.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import {
	ACK_TIMEOUT_MS,
	buildAckFrame,
	buildDataFrame,
	ERR,
	type Frame,
	FrameParser,
	HARD_FRAME_LIMIT,
	HELLO_RESPONSE_MS,
	HELLO_RETRY_MS,
	MAX_FRAME,
	MAX_PENDING_CALLS,
	MAX_RETRANSMITS,
	MAX_SERVE_PENDING,
	RPC_PROTOCOL,
	RpcCallError,
	RpcLink,
	rpcError,
	ServeError,
	type LinkState,
	type RpcLinkOptions,
	type ServeHandler,
} from '../../app/rpc';

const encoder = new TextEncoder();

/** Deterministic xorshift32 — a failure prints its seed, so it replays. */
function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x1_0000_0000;
	};
}

const CJK = '中文串口协议帧序号确认重传会话😀🚀';
function randomText(r: () => number, max: number): string {
	const n = Math.floor(r() * max);
	let out = '';
	for (let i = 0; i < n; i++) {
		out +=
			r() < 0.5
				? String.fromCharCode(0x20 + Math.floor(r() * 95))
				: CJK[Math.floor(r() * CJK.length)];
	}
	return out;
}

const EPOCH = 'a1b2c3d4e5f60718';

function collect(): { frames: Frame[]; parser: FrameParser } {
	const frames: Frame[] = [];
	const parser = new FrameParser((f) => frames.push(f));
	return { frames, parser };
}

// ── L1: the frame parser under fire ──

describe('FrameParser', () => {
	it('round-trips data and ack frames, CJK payloads byte-counted', () => {
		const { frames, parser } = collect();
		const json = JSON.stringify({ method: 'x', params: { text: '中文😀' } });
		parser.pushAll(buildDataFrame(EPOCH, 7, json));
		parser.pushAll(buildAckFrame(EPOCH, 7));
		expect(frames).toEqual([
			{ kind: 'data', epoch: EPOCH, seq: 7, json },
			{ kind: 'ack', epoch: EPOCH, seq: 7 },
		]);
		// The length field counts UTF-8 bytes, not UTF-16 units.
		const head = new TextDecoder().decode(buildDataFrame(EPOCH, 7, json)).split(' ', 4);
		expect(Number(head[3])).toBe(encoder.encode(json).length);
	});

	it('delivers the same frames whether bytes arrive one at a time or in blobs', () => {
		const r = rng(0xf00d);
		const sent: string[] = [];
		let wire = new Uint8Array(0);
		for (let i = 0; i < 40; i++) {
			const json = JSON.stringify({ id: `p.${i}`, note: randomText(r, 80) });
			sent.push(json);
			const f = buildDataFrame(EPOCH, i + 1, json);
			const grown = new Uint8Array(wire.length + f.length);
			grown.set(wire);
			grown.set(f, wire.length);
			wire = grown;
		}
		const whole = collect();
		whole.parser.pushAll(wire);
		const dribble = collect();
		for (const b of wire) dribble.parser.push(b);
		for (const got of [whole.frames, dribble.frames]) {
			expect(got.length).toBe(40);
			expect(got.map((f) => (f.kind === 'data' ? f.json : ''))).toEqual(sent);
		}
	});

	it('a payload smuggling "VX1 " cannot desynchronise a length-framed reader', () => {
		const { frames, parser } = collect();
		const trap = JSON.stringify({ text: 'VX1 deadbeefdeadbeef 9 5 xxxxx\nVXA innocent' });
		parser.pushAll(buildDataFrame(EPOCH, 1, trap));
		parser.pushAll(buildAckFrame(EPOCH, 2));
		expect(frames.length).toBe(2);
		expect(frames[0]).toMatchObject({ kind: 'data', seq: 1, json: trap });
		expect(frames[1]).toMatchObject({ kind: 'ack', seq: 2 });
		expect(parser.stats.noiseBytes).toBe(0);
	});

	it('counts boot noise and finds the first frame behind it', () => {
		const { frames, parser } = collect();
		parser.pushAll(new Uint8Array([0xff, 0x00, 0x1b, 0x5b, 0x32, 0x4a])); // \xff\0 ESC[2J
		parser.pushAll(encoder.encode('agetty: unknown terminal\n'));
		parser.pushAll(buildAckFrame(EPOCH, 0));
		expect(frames).toEqual([{ kind: 'ack', epoch: EPOCH, seq: 0 }]);
		expect(parser.stats.noiseBytes).toBeGreaterThan(20);
	});

	it('resyncs after a frame whose declared length lies, and after a lost LF', () => {
		const { frames, parser } = collect();
		// Length says 10, payload is 4, so the LF check lands mid-noise.
		parser.pushAll(encoder.encode(`VX1 ${EPOCH} 3 10 hey!\n`));
		parser.pushAll(buildDataFrame(EPOCH, 4, '{"a":1}'));
		// A frame that lost its LF entirely, glued to the next frame.
		const cut = buildDataFrame(EPOCH, 5, '{"b":2}');
		parser.pushAll(cut.subarray(0, cut.length - 1));
		parser.pushAll(buildDataFrame(EPOCH, 6, '{"c":3}'));
		const seqs = frames.filter((f) => f.kind === 'data').map((f) => f.seq);
		expect(seqs).toContain(4);
		expect(seqs).toContain(6);
		expect(seqs).not.toContain(3);
		expect(seqs).not.toContain(5);
		expect(parser.stats.badFrames).toBeGreaterThanOrEqual(2);
	});

	it('treats a length past the hard limit as a bad frame, not a buffering order', () => {
		const { frames, parser } = collect();
		parser.pushAll(encoder.encode(`VX1 ${EPOCH} 1 ${HARD_FRAME_LIMIT + 1} `));
		parser.pushAll(buildAckFrame(EPOCH, 9));
		expect(frames).toEqual([{ kind: 'ack', epoch: EPOCH, seq: 9 }]);
		expect(parser.stats.badFrames).toBe(1);
	});

	it('rejects a declared length that cuts a UTF-8 sequence', () => {
		const { frames, parser } = collect();
		const payload = encoder.encode('{"t":"中"}'); // 中 is bytes 6..9
		const cut = 8; // ends one byte into the three-byte sequence
		const head = encoder.encode(`VX1 ${EPOCH} 2 ${cut} `);
		const bytes = new Uint8Array([...head, ...payload.subarray(0, cut), 0x0a]);
		parser.pushAll(bytes);
		parser.pushAll(buildAckFrame(EPOCH, 3));
		expect(frames).toEqual([{ kind: 'ack', epoch: EPOCH, seq: 3 }]);
	});

	it('never throws and never invents frames from random mangling (fuzz)', () => {
		const r = rng(0xabad1dea);
		for (let round = 0; round < 200; round++) {
			const { frames, parser } = collect();
			const json = JSON.stringify({ note: randomText(r, 120) });
			const good = buildDataFrame(EPOCH, 1, json);
			const mangled = [...good];
			const hits = 1 + Math.floor(r() * 3);
			for (let i = 0; i < hits; i++) {
				const at = Math.floor(r() * mangled.length);
				mangled[at] = Math.floor(r() * 256);
			}
			parser.pushAll(new Uint8Array(mangled)); // must not throw
			for (const f of frames) {
				// Whatever came out parsed by the rules; a mangled frame may
				// still surface only if the mangling hit the payload without
				// breaking UTF-8 — in which case header fields are intact.
				expect(f.epoch).toMatch(/^[0-9a-f]{16}$/);
			}
			// And the stream recovers: a clean frame behind the wreck parses.
			parser.pushAll(buildDataFrame(EPOCH, 2, '{"ok":1}'));
			expect(frames.some((f) => f.kind === 'data' && f.seq === 2)).toBe(true);
		}
	});

	it('reset() abandons a partial frame so a new session is not swallowed by it', () => {
		const { frames, parser } = collect();
		// A header that declares 4000 bytes and stops: every later frame
		// would drown in its payload...
		parser.pushAll(encoder.encode(`VX1 ${EPOCH} 3 4000 short`));
		parser.pushAll(buildDataFrame(EPOCH, 4, '{"a":1}'));
		expect(frames.length).toBe(0);
		// ...until the owner declares the old wire dead.
		parser.reset();
		parser.pushAll(buildDataFrame(EPOCH, 5, '{"b":2}'));
		expect(frames).toEqual([{ kind: 'data', epoch: EPOCH, seq: 5, json: '{"b":2}' }]);
	});

	it('recovers every good frame between bursts of garbage (fuzz)', () => {
		const r = rng(0x600dbad);
		const { frames, parser } = collect();
		let want = 0;
		for (let i = 0; i < 120; i++) {
			if (r() < 0.4) {
				const junk = new Uint8Array(Math.floor(r() * 40));
				for (let j = 0; j < junk.length; j++) junk[j] = Math.floor(r() * 256);
				parser.pushAll(junk);
				// Garbage may have left a half-eaten header; a LF settles it
				// the way a real line boundary would.
				parser.push(0x0a);
			}
			want++;
			parser.pushAll(buildDataFrame(EPOCH, want, JSON.stringify({ i: want, t: randomText(r, 60) })));
		}
		const seqs = frames.filter((f) => f.kind === 'data').map((f) => f.seq);
		for (let s = 1; s <= want; s++) expect(seqs, `frame ${s} lost`).toContain(s);
	});
});

// ── L2: the link against a scripted guest ──

interface Guest {
	link: RpcLink;
	/** Everything the page transmitted, parsed. */
	out: Frame[];
	states: LinkState[];
	epoch: () => string;
	/** Data frames' JSON bodies, parsed, in order. */
	bodies: () => Record<string, unknown>[];
	body: (matching: (b: Record<string, unknown>) => boolean) => Record<string, unknown> | undefined;
	ack: (seq: number) => void;
	/** Feed a guest→page data frame; seq auto-increments. */
	send: (body: Record<string, unknown>) => number;
	sendRaw: (json: string) => void;
	/** Ack whatever page frame is unacked, oldest first. */
	ackAll: () => void;
	helloUp: () => void;
	nowMs: () => number;
	freeze: (ms: number) => void;
}

function makeGuest(methods: Record<string, ServeHandler> = {}, extra: Partial<RpcLinkOptions> = {}): Guest {
	let tokenN = 0;
	let clockSkew = 0;
	const out: Frame[] = [];
	const states: LinkState[] = [];
	const parser = new FrameParser((f) => out.push(f));
	let guestSeq = 0;
	const link = new RpcLink({
		sendBytes: (b) => parser.pushAll(b),
		methods,
		now: () => Date.now() + clockSkew,
		randomToken: () => (++tokenN).toString(16).padStart(16, '0') + 'f'.repeat(16),
		onState: (s) => states.push(s),
		...extra,
	});
	const epoch = () => link.sessionToken!.slice(0, 16);
	const acked = new Set<string>();
	const g: Guest = {
		link,
		out,
		states,
		epoch,
		bodies: () =>
			out
				.filter((f) => f.kind === 'data')
				.map((f) => JSON.parse((f as { json: string }).json) as Record<string, unknown>),
		body: (matching) => g.bodies().find(matching),
		ack: (seq) => link.onBytes(buildAckFrame(epoch(), seq)),
		send: (body) => {
			guestSeq++;
			link.onBytes(buildDataFrame(epoch(), guestSeq, JSON.stringify(body)));
			return guestSeq;
		},
		sendRaw: (json) => {
			guestSeq++;
			link.onBytes(buildDataFrame(epoch(), guestSeq, json));
		},
		ackAll: () => {
			for (const f of out) {
				const key = `${f.epoch}:${f.seq}`;
				if (f.kind === 'data' && !acked.has(key)) {
					acked.add(key);
					g.ack(f.seq);
				}
			}
		},
		helloUp: () => {
			link.attach();
			g.ackAll();
			guestSeq = 0;
			g.send({
				jsonrpc: '2.0',
				id: 'p.0',
				result: { protocol: 0, implementation: 'fake-rpcd/0', methods: ['proc.run'] },
			});
			expect(link.state).toBe('up');
		},
		nowMs: () => Date.now() + clockSkew,
		freeze: (ms) => {
			clockSkew += ms;
		},
	};
	return g;
}

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

describe('RpcLink', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('opens with a hello at seq 0 carrying the token and the served methods', () => {
		vi.useFakeTimers();
		const g = makeGuest({ 'http.fetch': async () => ({}) });
		g.link.attach();
		expect(g.out.length).toBe(1);
		const f = g.out[0];
		expect(f).toMatchObject({ kind: 'data', seq: 0, epoch: g.epoch() });
		const body = g.bodies()[0];
		expect(body.method).toBe('rpc.hello');
		const params = body.params as Record<string, unknown>;
		expect(params.protocol).toBe(RPC_PROTOCOL);
		expect(params.sessionToken).toBe(g.link.sessionToken);
		expect(params.methods).toEqual(['http.fetch']);
		expect((params.flow as Record<string, unknown>).pageToGuest).toBe('stop-wait');
		g.ack(0);
		// An rpcd inside the compatibility window may still answer the old
		// protocol number; the link accepts either shape (they are one).
		g.send({ jsonrpc: '2.0', id: 'p.0', result: { protocol: 0, maxFrame: 8192, inlineMax: 512 } });
		expect(g.link.state).toBe('up');
		// Negotiation takes the min of each side's preference.
		expect(g.link.maxFrame).toBe(MAX_FRAME);
		expect(g.link.inlineMax).toBe(512);
	});

	it('routes guest notifications through onNotify — but rpc.cancel stays the link business', () => {
		vi.useFakeTimers();
		const seen: [string, Record<string, unknown>][] = [];
		const g = makeGuest({}, { onNotify: (m, p) => seen.push([m, p]) });
		g.helloUp();
		g.send({ jsonrpc: '2.0', method: 'stream.opened', params: { id: 3, app: 'top', cols: 80, rows: 24, window: 8192 } });
		g.send({ jsonrpc: '2.0', method: 'rpc.event', params: { topic: 'app.exited', data: { id: 'x', code: 137 } } });
		g.send({ jsonrpc: '2.0', method: 'never.heard.of.it' }); // no params → {}
		g.send({ jsonrpc: '2.0', method: 'rpc.cancel', params: { id: 'p.9' } });
		expect(seen).toEqual([
			['stream.opened', { id: 3, app: 'top', cols: 80, rows: 24, window: 8192 }],
			['rpc.event', { topic: 'app.exited', data: { id: 'x', code: 137 } }],
			['never.heard.of.it', {}],
		]);
	});

	it('calls a guest method and resolves on its response', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const p = g.link.call('proc.run', { command: 'uname' }, { deadlineMs: 5_000 });
		const req = g.body((b) => b.method === 'proc.run')!;
		expect(req.id).toBe('p.1');
		expect((req.meta as Record<string, unknown>).deadlineMs).toBe(5_000);
		g.ackAll();
		g.send({ jsonrpc: '2.0', id: 'p.1', result: { exitCode: 0, stdout: 'Linux' } });
		await expect(p).resolves.toEqual({ exitCode: 0, stdout: 'Linux' });
	});

	it('rejects with the guest error, name and code intact', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const p = g.link.call('proc.run', {});
		g.ackAll();
		g.send({
			jsonrpc: '2.0',
			id: 'p.1',
			error: { code: 1004, name: 'DATA_PLANE_UNAVAILABLE', message: 'no /data', hint: 'mount it' },
		});
		const err = await p.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RpcCallError);
		expect((err as RpcCallError).code).toBe(1004);
		expect((err as RpcCallError).name).toBe('DATA_PLANE_UNAVAILABLE');
		expect((err as RpcCallError).hint).toBe('mount it');
	});

	it('keeps one data frame in flight: the second call waits for the first ACK', () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		void g.link.call('proc.run', { command: 'a' }).catch(() => {});
		void g.link.call('proc.run', { command: 'b' }).catch(() => {});
		const before = g.out.filter((f) => f.kind === 'data').length;
		expect(before).toBe(2); // hello + first call only
		g.ackAll();
		expect(g.out.filter((f) => f.kind === 'data').length).toBe(3);
	});

	it('retransmits an unacked frame, then declares the link lost and re-hellos', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const firstEpoch = g.epoch();
		const p = g.link.call('proc.run', { command: 'x' });
		const sends = () => g.out.filter((f) => f.kind === 'data' && f.epoch === firstEpoch && f.seq === 1).length;
		expect(sends()).toBe(1);
		await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
		expect(sends()).toBe(2);
		await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
		expect(sends()).toBe(3); // MAX_RETRANSMITS = 2 exhausted
		const rejected = p.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
		const err = await rejected;
		expect((err as RpcCallError).name).toBe('UNAVAILABLE');
		expect(g.link.state).toBe('unavailable');
		expect(g.link.stats().retransmits).toBe(MAX_RETRANSMITS);
		// Recovery: a fresh hello with a fresh token, unprompted.
		await vi.advanceTimersByTimeAsync(HELLO_RETRY_MS + 1);
		expect(g.link.state).toBe('hello');
		expect(g.epoch()).not.toBe(firstEpoch);
		expect(g.link.stats().sessions).toBe(2);
	});

	it('forgives its own freeze: a grossly late ACK timer is a probe, not a strike', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		void g.link.call('proc.run', { command: 'x' }).catch(() => {});
		// The page stalls for 30 s (M5: whole machine frozen); the timer then
		// fires hopelessly late. That must not burn retransmit budget.
		for (let i = 0; i < 5; i++) {
			g.freeze(ACK_TIMEOUT_MS * 5);
			await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
			expect(g.link.state).toBe('up');
		}
		// A real (unfrozen) silence still counts and still concludes.
		for (let i = 0; i <= MAX_RETRANSMITS; i++) {
			await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
		}
		expect(g.link.state).not.toBe('up');
	});

	it('serves a guest request and answers exactly once, without acking guest frames', async () => {
		vi.useFakeTimers();
		const seen: Record<string, unknown>[] = [];
		const g = makeGuest({
			'debug.js': async (params) => {
				seen.push(params);
				return { ok: true, output: '42' };
			},
		});
		g.helloUp();
		g.send({ jsonrpc: '2.0', id: 'g.1', method: 'debug.js', params: { code: '6*7' } });
		await flush();
		g.ackAll();
		const reply = g.body((b) => b.id === 'g.1')!;
		expect(reply.result).toEqual({ ok: true, output: '42' });
		expect(seen).toEqual([{ code: '6*7' }]);
		// guest→page is unacked by design: the page never emits VXA.
		expect(g.out.filter((f) => f.kind === 'ack').length).toBe(0);
	});

	it('answers rpc.cancel with CANCELLED, exactly once, and aborts the handler', async () => {
		vi.useFakeTimers();
		let aborted = false;
		const g = makeGuest({
			'http.fetch': (_p, ctx) =>
				new Promise((_resolve, reject) => {
					ctx.signal.addEventListener('abort', () => {
						aborted = true;
						reject(new Error('aborted'));
					});
				}),
		});
		g.helloUp();
		g.send({ jsonrpc: '2.0', id: 'g.1', method: 'http.fetch', params: { url: 'x' } });
		await flush();
		g.send({ jsonrpc: '2.0', method: 'rpc.cancel', params: { id: 'g.1' } });
		await flush();
		g.ackAll();
		const replies = g.bodies().filter((b) => b.id === 'g.1' && (b.result !== undefined || b.error !== undefined));
		expect(replies.length).toBe(1);
		expect((replies[0].error as Record<string, unknown>).name).toBe('CANCELLED');
		expect(aborted).toBe(true);
	});

	it('enforces the serve deadline from meta and answers DEADLINE_EXCEEDED', async () => {
		vi.useFakeTimers();
		const g = makeGuest({ 'http.fetch': () => new Promise(() => {}) });
		g.helloUp();
		g.send({
			jsonrpc: '2.0',
			id: 'g.1',
			method: 'http.fetch',
			params: {},
			meta: { deadlineMs: 1_000 },
		});
		await vi.advanceTimersByTimeAsync(1_001);
		g.ackAll();
		const reply = g.body((b) => b.id === 'g.1')!;
		expect((reply.error as Record<string, unknown>).name).toBe('DEADLINE_EXCEEDED');
	});

	it('gives up on an unanswered call at its deadline and sends rpc.cancel', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const p = g.link.call('proc.run', { command: 'sleep 99' }, { deadlineMs: 1_000 });
		g.ackAll();
		const rejected = p.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(3_100); // deadline + grace
		g.ackAll();
		expect(((await rejected) as RpcCallError).name).toBe('DEADLINE_EXCEEDED');
		const cancel = g.body((b) => b.method === 'rpc.cancel');
		expect((cancel?.params as Record<string, unknown>)?.id).toBe('p.1');
	});

	it('cancels a call through the caller AbortSignal', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const ctl = new AbortController();
		const p = g.link.call('proc.run', {}, { signal: ctl.signal });
		g.ackAll();
		const rejected = p.catch((e: unknown) => e);
		ctl.abort();
		expect(((await rejected) as RpcCallError).name).toBe('CANCELLED');
		g.ackAll();
		expect(g.body((b) => b.method === 'rpc.cancel')).toBeTruthy();
	});

	it('dedups guest frames by sequence: a replayed request runs once', async () => {
		vi.useFakeTimers();
		let runs = 0;
		const g = makeGuest({
			'debug.js': async () => {
				runs++;
				return {};
			},
		});
		g.helloUp();
		const seq = g.send({ jsonrpc: '2.0', id: 'g.1', method: 'debug.js', params: {} });
		g.link.onBytes(buildDataFrame(g.epoch(), seq, JSON.stringify({ jsonrpc: '2.0', id: 'g.1', method: 'debug.js', params: {} })));
		await flush();
		expect(runs).toBe(1);
		expect(g.link.stats().dupFrames).toBe(1);
	});

	it('drops frames from a previous epoch as stale', async () => {
		vi.useFakeTimers();
		let runs = 0;
		const g = makeGuest({
			'debug.js': async () => {
				runs++;
				return {};
			},
		});
		g.helloUp();
		g.link.onBytes(
			buildDataFrame('0000000000000000', 1, JSON.stringify({ jsonrpc: '2.0', id: 'g.9', method: 'debug.js' })),
		);
		await flush();
		expect(runs).toBe(0);
		expect(g.link.stats().staleFrames).toBe(1);
	});

	it('answers an unknown method with METHOD_NOT_FOUND and a hint of what it serves', async () => {
		vi.useFakeTimers();
		const g = makeGuest({ 'http.fetch': async () => ({}) });
		g.helloUp();
		g.send({ jsonrpc: '2.0', id: 'g.1', method: 'window.create', params: {} });
		await flush();
		g.ackAll();
		const reply = g.body((b) => b.id === 'g.1')!;
		const err = reply.error as Record<string, unknown>;
		expect(err.code).toBe(ERR.METHOD_NOT_FOUND.code);
		expect(err.hint).toContain('http.fetch');
	});

	it('rejects non-object params with INVALID_PARAMS and swallows malformed JSON, counting it', async () => {
		vi.useFakeTimers();
		const g = makeGuest({ 'debug.js': async () => ({}) });
		g.helloUp();
		g.send({ jsonrpc: '2.0', id: 'g.1', method: 'debug.js', params: [1, 2] as unknown as Record<string, unknown> });
		await flush();
		g.ackAll();
		expect(((g.body((b) => b.id === 'g.1'))!.error as Record<string, unknown>).name).toBe('INVALID_PARAMS');
		g.sendRaw('{"jsonrpc":"2.0", broken');
		g.sendRaw('[1,2,3]');
		await flush();
		expect(g.link.stats().protocolErrors).toBe(2);
	});

	it('sheds serve load past the cap with OVERLOADED', async () => {
		vi.useFakeTimers();
		const g = makeGuest({ 'http.fetch': () => new Promise(() => {}) });
		g.helloUp();
		for (let i = 1; i <= MAX_SERVE_PENDING + 1; i++) {
			g.send({ jsonrpc: '2.0', id: `g.${i}`, method: 'http.fetch', params: {} });
		}
		await flush();
		g.ackAll();
		const last = g.body((b) => b.id === `g.${MAX_SERVE_PENDING + 1}`)!;
		expect((last.error as Record<string, unknown>).name).toBe('OVERLOADED');
	});

	it('sheds caller load past the pending cap, locally and immediately', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const settled: Promise<unknown>[] = [];
		for (let i = 0; i < MAX_PENDING_CALLS; i++) {
			settled.push(g.link.call('proc.run', { i }).catch(() => {}));
		}
		const err = await g.link.call('proc.run', {}).catch((e: unknown) => e);
		expect((err as RpcCallError).name).toBe('OVERLOADED');
		g.link.detach();
		await Promise.all(settled);
	});

	it('refuses params that cannot fit a frame, pointing at resource refs', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const err = await g.link
			.call('proc.run', { command: 'x'.repeat(MAX_FRAME) })
			.catch((e: unknown) => e);
		expect((err as RpcCallError).name).toBe('INVALID_PARAMS');
		expect((err as RpcCallError).hint).toContain('resource ref');
	});

	it('turns an oversized handler result into INTERNAL_ERROR instead of a broken frame', async () => {
		vi.useFakeTimers();
		const g = makeGuest({ 'debug.js': async () => ({ output: 'y'.repeat(MAX_FRAME) }) });
		g.helloUp();
		g.send({ jsonrpc: '2.0', id: 'g.1', method: 'debug.js', params: {} });
		await flush();
		g.ackAll();
		const reply = g.body((b) => b.id === 'g.1')!;
		const err = reply.error as Record<string, unknown>;
		expect(err.name).toBe('INTERNAL_ERROR');
		expect(err.message).toContain('resource ref');
	});

	it('lets a handler speak wire errors through ServeError', async () => {
		vi.useFakeTimers();
		const g = makeGuest({
			'http.fetch': async () => {
				throw new ServeError(rpcError(ERR.DATA_PLANE_UNAVAILABLE, 'no /data mounted'));
			},
		});
		g.helloUp();
		g.send({ jsonrpc: '2.0', id: 'g.1', method: 'http.fetch', params: {} });
		await flush();
		g.ackAll();
		const err = (g.body((b) => b.id === 'g.1'))!.error as Record<string, unknown>;
		expect(err.code).toBe(1004);
		expect(err.message).toBe('no /data mounted');
	});

	it('re-attach starts a new session: pendings fail UNAVAILABLE, serves abort, seqs reset', async () => {
		vi.useFakeTimers();
		let aborted = false;
		const g = makeGuest({
			'http.fetch': (_p, ctx) =>
				new Promise(() => {
					ctx.signal.addEventListener('abort', () => {
						aborted = true;
					});
				}),
		});
		g.helloUp();
		const firstEpoch = g.epoch();
		const p = g.link.call('proc.run', {});
		g.ackAll();
		g.send({ jsonrpc: '2.0', id: 'g.1', method: 'http.fetch', params: {} });
		await flush();
		const rejected = p.catch((e: unknown) => e);
		g.link.attach();
		expect(((await rejected) as RpcCallError).name).toBe('UNAVAILABLE');
		expect(aborted).toBe(true);
		expect(g.epoch()).not.toBe(firstEpoch);
		// No stale response for the aborted serve ever leaves on the new wire.
		g.ackAll();
		expect(g.bodies().filter((b) => b.id === 'g.1' && b.error !== undefined).length).toBe(0);
	});

	it('re-attach clears a half-received frame from the old wire', () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		// rpcd dies mid-write: a frame declaring 4000 bytes arrives short.
		g.link.onBytes(encoder.encode(`VX1 ${g.epoch()} 9 4000 0123456789`));
		g.link.attach();
		g.ackAll();
		g.send({ jsonrpc: '2.0', id: 'p.0', result: { protocol: 0 } });
		expect(g.link.state).toBe('up');
	});

	it('resends an ACKed but unanswered hello after its watchdog, same token', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.link.attach();
		const token = g.link.sessionToken;
		g.ackAll(); // ACK the hello; never answer it
		await vi.advanceTimersByTimeAsync(HELLO_RESPONSE_MS + 1);
		expect(g.link.sessionToken).toBe(token);
		const hellos = g.bodies().filter((b) => b.method === 'rpc.hello');
		expect(hellos.length).toBe(2);
		expect((hellos[1].params as Record<string, unknown>).sessionToken).toBe(token);
		expect(g.link.stats().helloSends).toBe(2);
	});

	it('fails calls fast while unavailable and counts a response to a settled call as stale', async () => {
		vi.useFakeTimers();
		const g = makeGuest();
		g.helloUp();
		const p = g.link.call('proc.run', {}, { deadlineMs: 1_000 });
		g.ackAll();
		const rejected = p.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(3_100);
		await rejected;
		g.send({ jsonrpc: '2.0', id: 'p.1', result: {} }); // too late
		expect(g.link.stats().staleResponses).toBe(1);
		g.link.detach();
		const err = await g.link.call('proc.run', {}).catch((e: unknown) => e);
		expect((err as RpcCallError).name).toBe('UNAVAILABLE');
	});
});
