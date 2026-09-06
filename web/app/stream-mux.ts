/**
 * The ttyS1 stream lane: interactive byte streams (PTY windows), multiplexed
 * (docs/system-v2.zh-CN.md §6.9). The guest half is rpcd's mux.c; the two
 * parsers must agree. Pure logic — no v86, no DOM — vm.ts owns the UART and
 * feeds bytes in, a `sendBytes` callback carries bytes out.
 *
 * Frame shape, an ASCII header then raw payload (no terminator — any bytes):
 *
 *   SB1 <channel> <byteLen>\n<byteLen raw bytes>
 *
 * PROTOTYPE FORMAT: §6.9 keeps this unfrozen until the PTY surface has been
 * lived with. Both ends ship together; change both.
 *
 * Control rides ttyS3, not here: stream.opened/closed/credit arrive as
 * RpcLink notifications and the owner (vm.ts) calls open()/close()/credit()
 * on this class. This lane carries nothing but payload bytes.
 *
 * Flow control (page→guest): every channel starts with the window the guest
 * granted in stream.opened; sending spends it, stream.credit refills it
 * (the guest grants credit back as bytes land in the PTY). What does not
 * fit the window queues here, bounded; past the bound the oldest queued
 * bytes drop and are counted — a terminal's paste can lose its tail, a
 * control call can never be wedged. guest→page needs none of this: UART
 * bytes land synchronously and xterm consumes faster than a serial line
 * delivers; a handler that is somehow gone drops bytes with a counter.
 */

const encoder = new TextEncoder();

/** Largest payload per frame; mirrors mux.h MUX_FRAME_MAX. */
export const MUX_FRAME_MAX = 2048;
/** Page→guest bytes in flight across all channels (link-level cap, well
 * under the §6.3 serial cliff). */
export const MUX_LINK_WINDOW = 32 * 1024;
/** Most bytes queued per channel waiting for credit; then the oldest drop. */
export const CHANNEL_QUEUE_MAX = 64 * 1024;

const BYTE_LF = 0x0a;
const BYTE_SP = 0x20;

export interface StreamHandler {
	data(bytes: Uint8Array): void;
}

export interface MuxStats {
	framesIn: number;
	framesOut: number;
	noiseBytes: number;
	badFrames: number;
	/** Payload bytes for channels nobody has open. */
	orphanBytes: number;
	/** Page→guest bytes dropped because a channel queue burst its bound. */
	droppedBytes: number;
}

interface Channel {
	handler: StreamHandler;
	/** Bytes the guest will accept right now (its grant minus in-flight). */
	window: number;
	/** Sent and not yet credited back (this channel's share of the link). */
	inFlight: number;
	/** Waiting for credit, in write order. */
	queue: Uint8Array[];
	queuedBytes: number;
}

export class StreamMux {
	private readonly sendBytes: (bytes: Uint8Array) => void;
	private channels = new Map<number, Channel>();
	/** Link-level in-flight (sent, not yet credited back), all channels. */
	private linkInFlight = 0;

	readonly stats: MuxStats = {
		framesIn: 0,
		framesOut: 0,
		noiseBytes: 0,
		badFrames: 0,
		orphanBytes: 0,
		droppedBytes: 0,
	};

	// parser state
	private buf = new Uint8Array(MUX_FRAME_MAX * 4 + 512);
	private len = 0;

	constructor(opts: { sendBytes: (bytes: Uint8Array) => void }) {
		this.sendBytes = opts.sendBytes;
	}

	/** A stream.opened notification: register the consumer. */
	open(id: number, window: number, handler: StreamHandler) {
		this.channels.set(id, {
			handler,
			window: Number.isFinite(window) && window >= 0 ? window : 8 * 1024,
			inFlight: 0,
			queue: [],
			queuedBytes: 0,
		});
	}

	/** A stream.closed notification (or the owner giving up on the id). */
	close(id: number) {
		const ch = this.channels.get(id);
		if (!ch) return;
		// In-flight bytes of a closed channel will never be credited;
		// give their link budget back.
		this.linkInFlight = Math.max(0, this.linkInFlight - ch.inFlight);
		this.channels.delete(id);
	}

	has(id: number): boolean {
		return this.channels.has(id);
	}

	/** New control session: every old channel died with the old session. */
	closeAll() {
		this.channels.clear();
		this.linkInFlight = 0;
		this.reset();
	}

	/** A stream.credit notification: the guest consumed, the window refills. */
	credit(id: number, bytes: number) {
		const ch = this.channels.get(id);
		if (!ch || !(bytes > 0)) return;
		const settled = Math.min(bytes, ch.inFlight);
		ch.window += bytes;
		ch.inFlight -= settled;
		this.linkInFlight = Math.max(0, this.linkInFlight - settled);
		this.pump(id, ch);
	}

	/** Page→guest bytes (keystrokes, pastes). Queues past the window. */
	send(id: number, bytes: Uint8Array) {
		const ch = this.channels.get(id);
		if (!ch || bytes.length === 0) return;
		ch.queue.push(bytes);
		ch.queuedBytes += bytes.length;
		while (ch.queuedBytes > CHANNEL_QUEUE_MAX && ch.queue.length > 0) {
			const oldest = ch.queue.shift()!;
			ch.queuedBytes -= oldest.length;
			this.stats.droppedBytes += oldest.length;
		}
		this.pump(id, ch);
	}

	private pump(id: number, ch: Channel) {
		while (ch.queue.length > 0) {
			const budget = Math.min(ch.window, MUX_LINK_WINDOW - this.linkInFlight, MUX_FRAME_MAX);
			if (budget <= 0) return;
			let chunk = ch.queue[0];
			if (chunk.length > budget) {
				ch.queue[0] = chunk.subarray(budget);
				chunk = chunk.subarray(0, budget);
			} else {
				ch.queue.shift();
			}
			ch.queuedBytes -= chunk.length;
			ch.window -= chunk.length;
			ch.inFlight += chunk.length;
			this.linkInFlight += chunk.length;
			this.transmit(id, chunk);
		}
	}

	private transmit(id: number, payload: Uint8Array) {
		const head = encoder.encode(`SB1 ${id} ${payload.length}\n`);
		const frame = new Uint8Array(head.length + payload.length);
		frame.set(head, 0);
		frame.set(payload, head.length);
		this.stats.framesOut++;
		try {
			this.sendBytes(frame);
		} catch {
			// The UART is the page's own emulator call; a throw means the VM
			// is tearing down and these bytes have nowhere to go.
		}
	}

	// ── receive path (mirrors mux.c) ──

	onByte(byte: number) {
		this.feed1(byte);
		this.drain();
	}

	onBytes(bytes: Uint8Array) {
		for (const b of bytes) this.feed1(b);
		this.drain();
	}

	/** Drop any partial frame (a new VM attach; the old wire's leftovers). */
	reset() {
		this.stats.noiseBytes += this.len;
		this.len = 0;
	}

	private feed1(b: number) {
		if (this.len >= this.buf.length) {
			// Full and unparseable: the front is noise by definition.
			this.buf.copyWithin(0, 1024);
			this.len -= 1024;
			this.stats.noiseBytes += 1024;
		}
		this.buf[this.len++] = b;
	}

	private drain() {
		for (;;) {
			if (this.len < 4) return;
			const at = this.findHeader();
			if (at < 0) {
				const keep = Math.min(this.len, 3);
				this.stats.noiseBytes += this.len - keep;
				this.drop(this.len - keep);
				return;
			}
			if (at > 0) {
				this.stats.noiseBytes += at;
				this.drop(at);
			}
			const chan = this.readInt(4, 5, BYTE_SP);
			if (chan === 'wait') return;
			if (chan === 'bad') {
				this.bad();
				continue;
			}
			const blen = this.readInt(chan.end + 1, 5, BYTE_LF);
			if (blen === 'wait') return;
			if (blen === 'bad' || blen.value > MUX_FRAME_MAX) {
				this.bad();
				continue;
			}
			const payloadAt = blen.end + 1;
			if (this.len < payloadAt + blen.value) return;
			const payload = this.buf.slice(payloadAt, payloadAt + blen.value);
			this.drop(payloadAt + blen.value);
			this.stats.framesIn++;
			const ch = this.channels.get(chan.value);
			if (ch) ch.handler.data(payload);
			else this.stats.orphanBytes += payload.length;
		}
	}

	private findHeader(): number {
		for (let i = 0; i + 4 <= this.len; i++) {
			if (
				this.buf[i] === 0x53 /* S */ &&
				this.buf[i + 1] === 0x42 /* B */ &&
				this.buf[i + 2] === 0x31 /* 1 */ &&
				this.buf[i + 3] === BYTE_SP
			)
				return i;
		}
		return -1;
	}

	private readInt(from: number, maxDigits: number, stop: number): { value: number; end: number } | 'wait' | 'bad' {
		let value = 0;
		let i = from;
		for (; ; i++) {
			if (i >= this.len) return i - from > maxDigits ? 'bad' : 'wait';
			const c = this.buf[i];
			if (c === stop) break;
			if (c < 0x30 || c > 0x39 || i - from >= maxDigits) return 'bad';
			value = value * 10 + (c - 0x30);
		}
		if (i === from) return 'bad';
		return { value, end: i };
	}

	private bad() {
		this.stats.badFrames++;
		this.stats.noiseBytes += 4;
		this.drop(4);
	}

	private drop(n: number) {
		if (n <= 0) return;
		if (n >= this.len) {
			this.len = 0;
			return;
		}
		this.buf.copyWithin(0, n, this.len);
		this.len -= n;
	}
}
