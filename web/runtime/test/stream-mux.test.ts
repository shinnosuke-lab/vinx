/**
 * The ttyS1 stream lane off the wire: SB1 framing under noise (the payload
 * is raw bytes, so anything — including "SB1 " itself — must ride through
 * intact), and the credit ledger that keeps page→guest inside the window
 * the guest granted. Mirrors mux.c; the two parsers must agree, and this
 * suite is the page half's witness.
 */

import { describe, expect, it } from 'vitest';

import { CHANNEL_QUEUE_MAX, MUX_FRAME_MAX, MUX_LINK_WINDOW, StreamMux } from '../../app/stream-mux';

const encoder = new TextEncoder();

function frame(channel: number, payload: Uint8Array): Uint8Array {
	const head = encoder.encode(`SB1 ${channel} ${payload.length}\n`);
	const out = new Uint8Array(head.length + payload.length);
	out.set(head, 0);
	out.set(payload, head.length);
	return out;
}

function collect() {
	const sent: Uint8Array[] = [];
	const mux = new StreamMux({ sendBytes: (b) => sent.push(b.slice()) });
	return { mux, sent };
}

/** Parse every complete SB1 frame out of the concatenated sent bytes. */
function parseSent(sent: Uint8Array[]): { channel: number; payload: Uint8Array }[] {
	let all = new Uint8Array(sent.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for (const b of sent) {
		all.set(b, at);
		at += b.length;
	}
	const out: { channel: number; payload: Uint8Array }[] = [];
	let i = 0;
	while (i < all.length) {
		const lf = all.indexOf(0x0a, i);
		if (lf < 0) break;
		const head = new TextDecoder().decode(all.subarray(i, lf));
		const m = /^SB1 (\d+) (\d+)$/.exec(head);
		if (!m) throw new Error(`bad header: ${JSON.stringify(head)}`);
		const len = Number(m[2]);
		out.push({ channel: Number(m[1]), payload: all.subarray(lf + 1, lf + 1 + len) });
		i = lf + 1 + len;
	}
	return out;
}

describe('the SB1 parser', () => {
	it('delivers frames whole, byte-at-a-time or in slabs, raw payload intact', () => {
		const { mux } = collect();
		const got: { id: number; bytes: Uint8Array }[] = [];
		mux.open(7, 8192, { data: (bytes) => got.push({ id: 7, bytes }) });

		// A payload that contains everything a naive parser trips on: LF,
		// NUL, a nested "SB1 " header, high bytes.
		const nasty = new Uint8Array([0x0a, 0x00, ...encoder.encode('SB1 9 4\n😀'), 0xff, 0xfe]);
		const f = frame(7, nasty);
		for (const b of f) mux.onByte(b); // byte at a time
		mux.onBytes(f); // and as one slab

		expect(got.length).toBe(2);
		expect(Array.from(got[0].bytes)).toEqual(Array.from(nasty));
		expect(Array.from(got[1].bytes)).toEqual(Array.from(nasty));
		expect(mux.stats.badFrames).toBe(0);
	});

	it('skips noise and resynchronises on the next header', () => {
		const { mux } = collect();
		const got: Uint8Array[] = [];
		mux.open(1, 8192, { data: (b) => got.push(b) });

		mux.onBytes(encoder.encode('boot garbage \xff\xfe SB'));
		mux.onBytes(frame(1, encoder.encode('hello')));
		// A lying header (declares more than MUX_FRAME_MAX) is bad, not a wait.
		mux.onBytes(encoder.encode(`SB1 1 ${MUX_FRAME_MAX + 1}\n`));
		mux.onBytes(frame(1, encoder.encode('after')));

		expect(got.map((b) => new TextDecoder().decode(b))).toEqual(['hello', 'after']);
		expect(mux.stats.noiseBytes).toBeGreaterThan(0);
		expect(mux.stats.badFrames).toBeGreaterThan(0);
	});

	it('counts orphan bytes for channels nobody opened', () => {
		const { mux } = collect();
		mux.onBytes(frame(42, encoder.encode('nobody home')));
		expect(mux.stats.orphanBytes).toBe('nobody home'.length);
	});
});

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

describe('the SB1 parser under fire (fuzz)', () => {
	it('random slicing never loses or reorders a frame', () => {
		const r = rng(0x5b1f00d);
		for (let round = 0; round < 50; round++) {
			const { mux } = collect();
			const got: number[][] = [];
			mux.open(1, 0, { data: (b) => got.push([...b]) });
			const sent: number[][] = [];
			let wire = new Uint8Array(0);
			for (let i = 0; i < 20; i++) {
				const payload = new Uint8Array(Math.floor(r() * 100));
				for (let k = 0; k < payload.length; k++) payload[k] = Math.floor(r() * 256);
				sent.push([...payload]);
				const f = frame(1, payload);
				const grown = new Uint8Array(wire.length + f.length);
				grown.set(wire);
				grown.set(f, wire.length);
				wire = grown;
			}
			// Feed in random slices, sometimes byte by byte.
			let at = 0;
			while (at < wire.length) {
				const n = r() < 0.3 ? 1 : 1 + Math.floor(r() * 64);
				mux.onBytes(wire.subarray(at, Math.min(at + n, wire.length)));
				at += n;
			}
			// Zero-length frames deliver zero bytes; everything else whole,
			// in order (seed 0x5b1f00d replays a failure).
			const sentNonEmpty = sent.filter((p) => p.length > 0);
			const gotNonEmpty = got.filter((p) => p.length > 0);
			if (JSON.stringify(gotNonEmpty) !== JSON.stringify(sentNonEmpty))
				throw new Error(`round ${round}: frames lost or scrambled under slicing`);
			if (mux.stats.badFrames !== 0) throw new Error(`round ${round}: clean frames counted bad`);
		}
	});

	it('random corruption never throws, and a clean frame behind the wreck recovers', () => {
		const r = rng(0xdeadf15);
		for (let round = 0; round < 100; round++) {
			const { mux } = collect();
			const got: number[][] = [];
			mux.open(3, 0, { data: (b) => got.push([...b]) });
			const payload = new Uint8Array(1 + Math.floor(r() * 200));
			for (let k = 0; k < payload.length; k++) payload[k] = Math.floor(r() * 256);
			const mangled = [...frame(3, payload)];
			const hits = 1 + Math.floor(r() * 4);
			for (let h = 0; h < hits; h++) mangled[Math.floor(r() * mangled.length)] = Math.floor(r() * 256);
			mux.onBytes(new Uint8Array(mangled)); // must not throw
			// The stream recovers: a good frame lands whole afterwards.
			const probe = new Uint8Array([1, 2, 3, 4, 5]);
			mux.onBytes(frame(3, probe));
			const last = got[got.length - 1];
			if (!last || JSON.stringify(last) !== JSON.stringify([...probe]))
				throw new Error(`round ${round}: the parser did not recover after corruption`);
		}
	});
});

describe('the credit ledger', () => {
	it('spends the window, queues the excess, resumes on credit', () => {
		const { mux, sent } = collect();
		mux.open(3, 10, { data: () => {} });

		mux.send(3, encoder.encode('0123456789ABCDEF')); // 16 bytes into a 10-byte window
		let frames = parseSent(sent);
		expect(frames.length).toBe(1);
		expect(new TextDecoder().decode(frames[0].payload)).toBe('0123456789');

		mux.credit(3, 6);
		frames = parseSent(sent);
		expect(frames.length).toBe(2);
		expect(new TextDecoder().decode(frames[1].payload)).toBe('ABCDEF');
	});

	it('caps a frame at MUX_FRAME_MAX and the link at MUX_LINK_WINDOW', () => {
		const { mux, sent } = collect();
		mux.open(1, MUX_LINK_WINDOW * 2, { data: () => {} });

		mux.send(1, new Uint8Array(MUX_LINK_WINDOW + 5000).fill(0x78));
		const frames = parseSent(sent);
		const total = frames.reduce((n, f) => n + f.payload.length, 0);
		expect(total).toBe(MUX_LINK_WINDOW); // the rest waits for credit
		for (const f of frames) expect(f.payload.length).toBeLessThanOrEqual(MUX_FRAME_MAX);

		// Credit for one channel frees link budget too.
		mux.credit(1, 5000);
		const after = parseSent(sent).reduce((n, f) => n + f.payload.length, 0);
		expect(after).toBe(MUX_LINK_WINDOW + 5000);
	});

	it('drops the oldest queued bytes past the channel bound, counted', () => {
		const { mux, sent } = collect();
		mux.open(2, 0, { data: () => {} }); // no window: everything queues

		mux.send(2, new Uint8Array(CHANNEL_QUEUE_MAX).fill(1));
		mux.send(2, new Uint8Array(100).fill(2)); // bursts the bound
		expect(mux.stats.droppedBytes).toBeGreaterThan(0);
		expect(parseSent(sent).length).toBe(0);
	});

	it('a closed channel returns its in-flight budget to the link', () => {
		const { mux, sent } = collect();
		mux.open(1, MUX_LINK_WINDOW, { data: () => {} });
		mux.send(1, new Uint8Array(MUX_LINK_WINDOW).fill(3)); // link fully in flight
		mux.open(2, 8192, { data: () => {} });
		mux.send(2, encoder.encode('stuck')); // no link budget left
		expect(parseSent(sent).filter((f) => f.channel === 2).length).toBe(0);

		mux.close(1); // its in-flight bytes will never be credited
		mux.send(2, encoder.encode('!'));
		const two = parseSent(sent).filter((f) => f.channel === 2);
		expect(two.length).toBeGreaterThan(0);
	});
});
