/**
 * The ttyS3 control link: VX1/VXA frames carrying a JSON-RPC 2.0 subset.
 *
 * This is the page half of the protocol in docs/system-v2.zh-CN.md §6
 * (protocol:1, frozen at the §16 gate — the shape is protocol:0's, now
 * kept; rpcd still answers a protocol:0 hello for one version window).
 * The guest half is rpcd, a C daemon that holds
 * /dev/ttyS3 exclusively; everything else in the guest reaches it over a
 * Unix socket. This module is pure logic on purpose — no v86, no DOM — so
 * the whole state machine runs under vitest. vm.ts owns the UART and feeds
 * bytes in; a `sendBytes` callback carries bytes out.
 *
 * Wire shape (L1), one frame per line, headers ASCII, payload UTF-8 JSON:
 *
 *   VX1 <epoch:16hex> <seq> <byteLen> <json>\n     data frame
 *   VXA <epoch:16hex> <seq>\n                      ack
 *
 * The receiver trusts the length, not the newline: it reads exactly
 * `byteLen` bytes after the header and then requires the LF, so a payload
 * containing anything (even a stray "VX1 ") cannot desynchronise it. A bad
 * header or a missing LF is noise: the parser counts it and rescans for the
 *  next header. Nothing here drops non-ASCII bytes — JSON is UTF-8 on the
 * wire.
 *
 * Flow control is asymmetric by measurement (docs/protocol-baseline.zh-CN.md):
 * page → guest is stop-and-wait — one unacked data frame in flight, resend
 * after 2 s, twice, then the link is UNAVAILABLE. That pins the guest-side
 * backlog to one frame (the real cliff is an interrupt storm near 256 KiB,
 * M1b) and turns "nobody holds the port" into an explicit failure instead
 * of a silent FIFO-reset loss (M1a). guest → page needs none of it: UART
 * writes land in the page listener synchronously, so the page never acks
 * and the guest never retransmits; sequence numbers in that direction are
 * for diagnosis only. The retransmit timer runs on a monotonic clock and
 * forgives the page's own freezes (M5: page busy N ms = whole machine
 * frozen N ms): a fire that arrives grossly late is a resend, not a strike.
 *
 * L2 is JSON-RPC 2.0 with string ids — `p.N` minted here, `g.N` by the
 * guest — params/result objects, `meta.deadlineMs` as the transport budget,
 * and `rpc.cancel` notifications. Every request this side accepts is
 * answered exactly once, CANCELLED included. A session is born when the
 * page sends `rpc.hello` (seq 0, always parsed, never deduped) carrying a
 * fresh 128-bit token; the frame epoch is that token's first 16 hex chars,
 * so stale frames from a previous session cannot land in this one.
 */

// ── wire constants (frozen with protocol:1, §6.3/§6.6/§16) ──

export const RPC_PROTOCOL = 1;
/** Advertised frame budget: total bytes, header and LF included. */
export const MAX_FRAME = 4096;
/** Advertised inline payload preference for method params/results. */
export const INLINE_MAX = 1024;
/** Non-negotiable receiver bound: a length past this is a bad frame, not a
 * reason to buffer 4 GB. Generous against future maxFrame growth. */
export const HARD_FRAME_LIMIT = 64 * 1024;
/** Stop-and-wait: resend an unacked data frame after this long... */
export const ACK_TIMEOUT_MS = 2_000;
/** ...this many times (after the first send) before the link is lost. */
export const MAX_RETRANSMITS = 2;
/** A hello whose ACK went missing retries harder than a data frame: the far
 * side may still be booting or respawning (§6.6). */
export const HELLO_RETRANSMITS = 6;
/** No hello response (ACKed or not) after this long: rebuild and resend. */
export const HELLO_RESPONSE_MS = 8_000;
/** While UNAVAILABLE, a fresh hello cycle starts this often. */
export const HELLO_RETRY_MS = 5_000;
/** Callers that give no deadline get this transport budget. */
export const DEFAULT_DEADLINE_MS = 30_000;
/** Local watchdog slack past the far side's deadline, for the wire. */
export const DEADLINE_GRACE_MS = 2_000;
/** Most pending outbound calls (then: OVERLOADED, locally). */
export const MAX_PENDING_CALLS = 32;
/** Most in-flight requests the page will serve (then: OVERLOADED). */
export const MAX_SERVE_PENDING = 32;
/** Most frames waiting behind the stop-and-wait window. */
export const MAX_SEND_QUEUE = 64;

// ── errors (§6.4: code and name are the contract, message/hint are prose) ──

export interface RpcErrorShape {
	code: number;
	name: string;
	message: string;
	hint?: string;
}

export const ERR = {
	PARSE_ERROR: { code: -32700, name: 'PARSE_ERROR' },
	INVALID_REQUEST: { code: -32600, name: 'INVALID_REQUEST' },
	METHOD_NOT_FOUND: { code: -32601, name: 'METHOD_NOT_FOUND' },
	INVALID_PARAMS: { code: -32602, name: 'INVALID_PARAMS' },
	INTERNAL_ERROR: { code: -32603, name: 'INTERNAL_ERROR' },
	UNAVAILABLE: { code: 1001, name: 'UNAVAILABLE' },
	CANCELLED: { code: 1002, name: 'CANCELLED' },
	DEADLINE_EXCEEDED: { code: 1003, name: 'DEADLINE_EXCEEDED' },
	DATA_PLANE_UNAVAILABLE: { code: 1004, name: 'DATA_PLANE_UNAVAILABLE' },
	RESOURCE_INVALID: { code: 1005, name: 'RESOURCE_INVALID' },
	OVERLOADED: { code: 1006, name: 'OVERLOADED' },
	/** An origin resource (camera, BLE, ...) is held by another machine on
	 * this origin (§3.0); the message names the holder. */
	RESOURCE_BUSY: { code: 1007, name: 'RESOURCE_BUSY' },
	/** The resource wants a foreground document (gesture/permission rules)
	 * and this machine's is hidden; §3.0 allows an honest refusal where
	 * forwarding is not safe. */
	REQUIRES_FOREGROUND: { code: 1008, name: 'REQUIRES_FOREGROUND' },
} as const;

export function rpcError(
	base: { code: number; name: string },
	message: string,
	hint?: string,
): RpcErrorShape {
	return { code: base.code, name: base.name, message, ...(hint ? { hint } : {}) };
}

/** What a rejected `call()` carries. `name` is the stable error name. */
export class RpcCallError extends Error {
	readonly code: number;
	readonly hint?: string;
	constructor(err: RpcErrorShape) {
		super(err.message);
		this.name = err.name;
		this.code = err.code;
		this.hint = err.hint;
	}
}

/** Handlers throw this to answer with a specific wire error. */
export class ServeError extends Error {
	readonly rpc: RpcErrorShape;
	constructor(err: RpcErrorShape) {
		super(err.message);
		this.name = err.name;
		this.rpc = err;
	}
}

// ── L1: frames ──

export type Frame =
	| { kind: 'data'; epoch: string; seq: number; json: string }
	| { kind: 'ack'; epoch: string; seq: number };

const encoder = new TextEncoder();
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

const BYTE_V = 0x56; // 'V'
const BYTE_LF = 0x0a;
const BYTE_SP = 0x20;

export function buildDataFrame(epoch: string, seq: number, json: string): Uint8Array {
	const payload = encoder.encode(json);
	const head = encoder.encode(`VX1 ${epoch} ${seq} ${payload.length} `);
	const out = new Uint8Array(head.length + payload.length + 1);
	out.set(head, 0);
	out.set(payload, head.length);
	out[out.length - 1] = BYTE_LF;
	return out;
}

export function buildAckFrame(epoch: string, seq: number): Uint8Array {
	return encoder.encode(`VXA ${epoch} ${seq}\n`);
}

/** Grows-and-compacts byte queue; the parser reads it by offset. */
class ByteFifo {
	private buf = new Uint8Array(4096);
	private head = 0;
	private tail = 0;

	get length(): number {
		return this.tail - this.head;
	}

	push(byte: number) {
		this.ensure(1);
		this.buf[this.tail++] = byte;
	}

	pushAll(bytes: Uint8Array) {
		this.ensure(bytes.length);
		this.buf.set(bytes, this.tail);
		this.tail += bytes.length;
	}

	at(i: number): number {
		return this.buf[this.head + i];
	}

	slice(from: number, to: number): Uint8Array {
		return this.buf.subarray(this.head + from, this.head + to);
	}

	drop(n: number) {
		this.head += n;
		if (this.head >= this.tail) {
			this.head = 0;
			this.tail = 0;
		}
	}

	private ensure(n: number) {
		if (this.tail + n <= this.buf.length) return;
		const len = this.length;
		if (len + n <= this.buf.length) {
			this.buf.copyWithin(0, this.head, this.tail);
		} else {
			const grown = new Uint8Array(Math.max(this.buf.length * 2, len + n + 4096));
			grown.set(this.buf.subarray(this.head, this.tail));
			this.buf = grown;
		}
		this.head = 0;
		this.tail = len;
	}
}

export interface ParserStats {
	frames: number;
	acks: number;
	/** Bytes discarded hunting for a header (boot 0xFF, line noise). */
	noiseBytes: number;
	/** Headers that matched but carried an unusable body. */
	badFrames: number;
}

const HEAD_LEN = 4; // "VX1 " / "VXA "
const EPOCH_LEN = 16;
const MAX_SEQ_DIGITS = 10;
const MAX_LEN_DIGITS = 8;

/**
 * Incremental frame reader. Feed it bytes as they arrive; complete frames
 * come out of `onFrame` in order. It never throws on wire content: whatever
 * fails to parse is counted and skipped, and parsing resumes at the next
 * plausible header — one bad frame must not poison the stream (§6.7).
 */
export class FrameParser {
	private fifo = new ByteFifo();
	/** Cheap gate: no parse attempt until this many bytes exist. */
	private need = HEAD_LEN;
	readonly stats: ParserStats = { frames: 0, acks: 0, noiseBytes: 0, badFrames: 0 };

	constructor(private onFrame: (frame: Frame) => void) {}

	push(byte: number) {
		this.fifo.push(byte);
		if (this.fifo.length >= this.need) this.drain();
	}

	pushAll(bytes: Uint8Array) {
		this.fifo.pushAll(bytes);
		if (this.fifo.length >= this.need) this.drain();
	}

	/** Drop whatever partial frame is buffered. A new session calls this:
	 * a half-received frame from the old session would otherwise swallow
	 * the new session's first frames into its declared length. */
	reset() {
		const len = this.fifo.length;
		if (len > 0) {
			this.stats.noiseBytes += len;
			this.fifo.drop(len);
		}
		this.need = HEAD_LEN;
	}

	private drain() {
		for (;;) {
			if (this.fifo.length < HEAD_LEN) {
				this.need = HEAD_LEN;
				return;
			}
			const at = this.findHeader();
			if (at < 0) {
				// No header anywhere: all but a possible partial header at the
				// tail is noise.
				const keep = Math.min(this.fifo.length, HEAD_LEN - 1);
				const drop = this.fifo.length - keep;
				if (drop > 0) {
					this.stats.noiseBytes += drop;
					this.fifo.drop(drop);
				}
				this.need = HEAD_LEN;
				return;
			}
			if (at > 0) {
				this.stats.noiseBytes += at;
				this.fifo.drop(at);
			}
			const outcome = this.parseAtHead();
			if (outcome === 'wait') return; // this.need already set
			if (outcome === 'bad') {
				// The header text itself is real, so the next real header
				// cannot start inside it: skip it whole and rescan.
				this.stats.badFrames++;
				this.stats.noiseBytes += HEAD_LEN;
				this.fifo.drop(HEAD_LEN);
			}
			this.need = HEAD_LEN;
		}
	}

	/** Index of the first "VX1 "/"VXA " start, or -1. */
	private findHeader(): number {
		const n = this.fifo.length;
		for (let i = 0; i + HEAD_LEN <= n; i++) {
			if (this.fifo.at(i) !== BYTE_V) continue;
			if (this.fifo.at(i + 1) !== 0x58) continue; // 'X'
			const c = this.fifo.at(i + 2);
			if ((c === 0x31 || c === 0x41) && this.fifo.at(i + 3) === BYTE_SP) return i; // '1' | 'A'
		}
		return -1;
	}

	private parseAtHead(): 'frame' | 'wait' | 'bad' {
		const isData = this.fifo.at(2) === 0x31;

		// Epoch: exactly 16 hex chars then a space.
		const epochEnd = HEAD_LEN + EPOCH_LEN;
		if (this.fifo.length < epochEnd + 1) {
			this.need = epochEnd + 1;
			return 'wait';
		}
		for (let i = HEAD_LEN; i < epochEnd; i++) {
			const c = this.fifo.at(i);
			const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
			if (!hex) return 'bad';
		}
		if (this.fifo.at(epochEnd) !== BYTE_SP) return 'bad';
		const epoch = fatalUtf8.decode(this.fifo.slice(HEAD_LEN, epochEnd));

		const seq = this.readInt(epochEnd + 1, MAX_SEQ_DIGITS, isData ? BYTE_SP : BYTE_LF);
		if (seq === 'wait') {
			return 'wait';
		}
		if (seq === 'bad') return 'bad';

		if (!isData) {
			this.fifo.drop(seq.end + 1);
			this.stats.acks++;
			this.onFrame({ kind: 'ack', epoch, seq: seq.value });
			return 'frame';
		}

		const len = this.readInt(seq.end + 1, MAX_LEN_DIGITS, BYTE_SP);
		if (len === 'wait') return 'wait';
		if (len === 'bad') return 'bad';
		if (len.value > HARD_FRAME_LIMIT) return 'bad';

		const payloadAt = len.end + 1;
		const frameEnd = payloadAt + len.value + 1; // + LF
		if (this.fifo.length < frameEnd) {
			this.need = frameEnd;
			return 'wait';
		}
		if (this.fifo.at(frameEnd - 1) !== BYTE_LF) return 'bad';
		let json: string;
		try {
			json = fatalUtf8.decode(this.fifo.slice(payloadAt, payloadAt + len.value));
		} catch {
			return 'bad'; // declared length cuts a UTF-8 sequence, or raw noise
		}
		this.fifo.drop(frameEnd);
		this.stats.frames++;
		this.onFrame({ kind: 'data', epoch, seq: seq.value, json });
		return 'frame';
	}

	/** Decimal digits starting at `from`, ended by `stop`. */
	private readInt(
		from: number,
		maxDigits: number,
		stop: number,
	): { value: number; end: number } | 'wait' | 'bad' {
		let value = 0;
		let i = from;
		for (; ; i++) {
			if (i >= this.fifo.length) {
				if (i - from > maxDigits) return 'bad';
				this.need = this.fifo.length + 1;
				return 'wait';
			}
			const c = this.fifo.at(i);
			if (c === stop) break;
			if (c < 0x30 || c > 0x39 || i - from >= maxDigits) return 'bad';
			value = value * 10 + (c - 0x30);
		}
		if (i === from) return 'bad'; // "VX1 <epoch>  " — empty field
		return { value, end: i };
	}
}

// ── L2: the link ──

export type LinkState = 'idle' | 'hello' | 'up' | 'unavailable';

export interface ServeContext {
	id: string;
	/** Fires on rpc.cancel or session teardown; long handlers should heed it. */
	signal: AbortSignal;
	deadlineMs: number;
}

export type ServeHandler = (
	params: Record<string, unknown>,
	ctx: ServeContext,
) => Promise<unknown>;

export interface HelloResult {
	protocol: number;
	implementation?: string;
	maxFrame?: number;
	inlineMax?: number;
	methods?: string[];
	features?: string[];
	[k: string]: unknown;
}

export interface LinkStats extends ParserStats {
	framesOut: number;
	retransmits: number;
	/** Data frames whose epoch belongs to a previous session. */
	staleFrames: number;
	/** guest→page frames with a sequence we already saw (diagnostic). */
	dupFrames: number;
	/** Responses to calls that had already been settled locally. */
	staleResponses: number;
	/** JSON-RPC bodies that were not addressable requests or responses. */
	protocolErrors: number;
	helloSends: number;
	sessions: number;
}

export interface RpcLinkOptions {
	sendBytes: (bytes: Uint8Array) => void;
	/** Methods this page serves (http.fetch, debug.js). Names go in hello. */
	methods?: Record<string, ServeHandler>;
	implementation?: string;
	/** Monotonic clock in ms; defaults to performance.now. */
	now?: () => number;
	/** 32 lowercase-hex chars; defaults to crypto. Injectable for tests. */
	randomToken?: () => string;
	onState?: (state: LinkState) => void;
	/** New session established: clean up `expiresWithSession` resources. */
	onSessionUp?: (peer: HelloResult, previousToken: string | null) => void;
	/** Guest→page notifications that are not rpc.cancel (stream.*, rpc.gap,
	 * subscribed events...). Unknown methods still land here; the receiver
	 * ignores what it does not know (§6.4). */
	onNotify?: (method: string, params: Record<string, unknown>) => void;
	log?: (line: string) => void;
}

interface PendingCall {
	id: string;
	method: string;
	resolve: (value: unknown) => void;
	reject: (err: RpcCallError) => void;
	deadlineTimer: ReturnType<typeof setTimeout>;
}

interface QueuedFrame {
	json: string;
	/** Assigned on first send; retransmits reuse it. */
	seq?: number;
	hello?: boolean;
}

interface ServeJob {
	ctl: AbortController;
	/** The single-response latch. */
	answered: boolean;
}

function defaultToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let hex = '';
	for (const b of bytes) hex += b.toString(16).padStart(2, '0');
	return hex;
}

/**
 * One control link over one UART. Construct it, wire `onByte` to the UART
 * listener, then `attach()` once the guest is booting; everything else is
 * `call`/`notify` and the served methods.
 */
export class RpcLink {
	private readonly opts: RpcLinkOptions;
	private readonly methods: Record<string, ServeHandler>;
	private readonly now: () => number;
	private readonly parser: FrameParser;

	private stateValue: LinkState = 'idle';
	private token: string | null = null;
	private epoch = '';
	private peer: HelloResult | null = null;

	private nextId = 1;
	private nextSeq = 1;
	private pending = new Map<string, PendingCall>();
	private serves = new Map<string, ServeJob>();

	private queue: QueuedFrame[] = [];
	private inflight: { frame: Uint8Array; seq: number; hello: boolean; sentAt: number; attempts: number } | null =
		null;
	private ackTimer: ReturnType<typeof setTimeout> | null = null;
	private helloTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	/** Highest guest→page data sequence seen this session. */
	private guestSeqSeen = 0;

	private extraStats = {
		framesOut: 0,
		retransmits: 0,
		staleFrames: 0,
		dupFrames: 0,
		staleResponses: 0,
		protocolErrors: 0,
		helloSends: 0,
		sessions: 0,
	};

	constructor(opts: RpcLinkOptions) {
		this.opts = opts;
		this.methods = opts.methods ?? {};
		this.now = opts.now ?? (() => performance.now());
		this.parser = new FrameParser((frame) => this.onFrame(frame));
	}

	get state(): LinkState {
		return this.stateValue;
	}

	/** The active session token (32 hex), or null before first attach. */
	get sessionToken(): string | null {
		return this.token;
	}

	/** What the guest declared in its hello response, if the link is up. */
	get peerHello(): HelloResult | null {
		return this.peer;
	}

	/** Effective frame budget: ours, shrunk by the peer's if it said less. */
	get maxFrame(): number {
		const theirs = this.peer?.maxFrame;
		return typeof theirs === 'number' && theirs > 0 ? Math.min(MAX_FRAME, theirs) : MAX_FRAME;
	}

	get inlineMax(): number {
		const theirs = this.peer?.inlineMax;
		return typeof theirs === 'number' && theirs > 0 ? Math.min(INLINE_MAX, theirs) : INLINE_MAX;
	}

	stats(): LinkStats {
		return { ...this.parser.stats, ...this.extraStats };
	}

	/** UART byte in. */
	onByte(byte: number) {
		this.parser.push(byte);
	}

	onBytes(bytes: Uint8Array) {
		this.parser.pushAll(bytes);
	}

	/**
	 * Start (or restart) a session: new token, new epoch, hello at seq 0.
	 * Everything pending dies with the old session — reload semantics, not
	 * an error path.
	 */
	attach() {
		this.startSession('attach');
	}

	/** Tear the link down for good (tab teardown, tests). */
	detach() {
		this.failSession('the link is detaching');
		this.setState('idle');
		this.token = null;
	}

	/** Call a guest method. Rejects with RpcCallError, never anything else. */
	call(
		method: string,
		params?: Record<string, unknown>,
		opts?: { deadlineMs?: number; signal?: AbortSignal },
	): Promise<unknown> {
		if (this.stateValue === 'idle' || this.stateValue === 'unavailable') {
			return Promise.reject(
				new RpcCallError(
					rpcError(ERR.UNAVAILABLE, `the control link is ${this.stateValue}`, 'the page retries hello in the background; try again'),
				),
			);
		}
		if (this.pending.size >= MAX_PENDING_CALLS) {
			return Promise.reject(
				new RpcCallError(rpcError(ERR.OVERLOADED, `${MAX_PENDING_CALLS} calls already pending on this page`)),
			);
		}
		const deadlineMs = clampDeadline(opts?.deadlineMs);
		const id = `p.${this.nextId++}`;
		const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
		if (params !== undefined) body.params = params;
		body.meta = { deadlineMs };
		const json = JSON.stringify(body);
		if (encoder.encode(json).length + 64 > this.maxFrame) {
			return Promise.reject(
				new RpcCallError(
					rpcError(
						ERR.INVALID_PARAMS,
						`${method} params exceed maxFrame (${this.maxFrame})`,
						'large arguments go through a resource ref (§6.8), not inline',
					),
				),
			);
		}

		return new Promise<unknown>((resolve, reject) => {
			const fail = (err: RpcErrorShape) => {
				const entry = this.pending.get(id);
				if (!entry) return;
				clearTimeout(entry.deadlineTimer);
				this.pending.delete(id);
				reject(new RpcCallError(err));
			};
			if (!this.enqueue({ json })) {
				reject(new RpcCallError(rpcError(ERR.OVERLOADED, 'the send queue is full')));
				return;
			}
			const deadlineTimer = setTimeout(() => {
				// The far side owed a response by deadlineMs; the grace covers
				// the wire. Past that, cancel and settle locally.
				this.notify('rpc.cancel', { id });
				fail(rpcError(ERR.DEADLINE_EXCEEDED, `${method} gave no response within ${deadlineMs} ms`));
			}, deadlineMs + DEADLINE_GRACE_MS);
			this.pending.set(id, { id, method, resolve, reject, deadlineTimer });
			opts?.signal?.addEventListener(
				'abort',
				() => {
					if (!this.pending.has(id)) return; // already settled
					this.notify('rpc.cancel', { id });
					fail(rpcError(ERR.CANCELLED, `${method} was cancelled by the caller`));
				},
				{ once: true },
			);
		});
	}

	/** Fire-and-forget notification to the guest. */
	notify(method: string, params?: Record<string, unknown>) {
		if (this.stateValue === 'idle' || this.stateValue === 'unavailable') return;
		const body: Record<string, unknown> = { jsonrpc: '2.0', method };
		if (params !== undefined) body.params = params;
		this.enqueue({ json: JSON.stringify(body) });
	}

	// ── session ──

	private startSession(why: string) {
		this.failSession(`a new session starts (${why})`);
		// Anything half-received belongs to the old wire; a partial frame
		// kept here would eat the new session's hello reply byte by byte.
		this.parser.reset();
		this.token = (this.opts.randomToken ?? defaultToken)();
		this.epoch = this.token.slice(0, EPOCH_LEN);
		this.nextSeq = 1;
		this.guestSeqSeen = 0;
		this.extraStats.sessions++;
		this.setState('hello');
		this.opts.log?.(`rpc: hello, session ${this.epoch}… (${why})`);
		this.sendHello();
	}

	private sendHello() {
		if (!this.token) return;
		const body = {
			jsonrpc: '2.0',
			id: 'p.0',
			method: 'rpc.hello',
			params: {
				protocol: RPC_PROTOCOL,
				sessionToken: this.token,
				implementation: this.opts.implementation ?? 'vinx-desktop/1.0',
				maxFrame: MAX_FRAME,
				inlineMax: INLINE_MAX,
				flow: { pageToGuest: 'stop-wait', guestToPage: 'unacked' },
				features: ['duplex', 'cancel', 'data-ref', 'streams'],
				methods: Object.keys(this.methods),
			},
		};
		this.extraStats.helloSends++;
		// Hello owns seq 0 and jumps the queue: nothing else may leave first.
		this.inflight = null;
		if (this.ackTimer) clearTimeout(this.ackTimer);
		this.queue = this.queue.filter((q) => !q.hello);
		this.queue.unshift({ json: JSON.stringify(body), seq: 0, hello: true });
		this.pump();
		this.armHelloWatchdog();
	}

	private armHelloWatchdog() {
		if (this.helloTimer) clearTimeout(this.helloTimer);
		this.helloTimer = setTimeout(() => {
			if (this.stateValue !== 'hello') return;
			// ACKed (or not) but never answered: rpcd may have restarted
			// between the ACK and the reply. Same token — replay is idempotent.
			this.opts.log?.('rpc: hello unanswered, resending');
			this.sendHello();
		}, HELLO_RESPONSE_MS);
	}

	private sessionUp(result: HelloResult) {
		if (this.helloTimer) {
			clearTimeout(this.helloTimer);
			this.helloTimer = null;
		}
		this.peer = result;
		this.setState('up');
		this.opts.log?.(
			`rpc: session up (${String(result.implementation ?? 'guest')}, methods: ${(result.methods ?? []).join(', ')})`,
		);
		this.opts.onSessionUp?.(result, this.token);
		this.pump();
	}

	/** Fail all local promises/serves; do not touch state/token. */
	private failSession(why: string) {
		const err = rpcError(ERR.UNAVAILABLE, `the session ended: ${why}`);
		for (const p of [...this.pending.values()]) {
			clearTimeout(p.deadlineTimer);
			p.reject(new RpcCallError(err));
		}
		this.pending.clear();
		for (const s of this.serves.values()) {
			s.answered = true; // the session died; no stale response later
			s.ctl.abort();
		}
		this.serves.clear();
		this.queue = [];
		this.inflight = null;
		this.peer = null;
		if (this.ackTimer) clearTimeout(this.ackTimer);
		if (this.helloTimer) clearTimeout(this.helloTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.ackTimer = null;
		this.helloTimer = null;
		this.retryTimer = null;
	}

	private linkLost(why: string) {
		this.opts.log?.(`rpc: link lost: ${why}`);
		this.failSession(why);
		this.setState('unavailable');
		// Keep knocking: rpcd respawn is init's job, ours is to be there
		// when it opens the port again.
		this.retryTimer = setTimeout(() => this.startSession('recovery'), HELLO_RETRY_MS);
	}

	private setState(next: LinkState) {
		if (this.stateValue === next) return;
		this.stateValue = next;
		this.opts.onState?.(next);
	}

	// ── stop-and-wait sender ──

	private enqueue(frame: QueuedFrame): boolean {
		if (this.queue.length >= MAX_SEND_QUEUE) return false;
		this.queue.push(frame);
		this.pump();
		return true;
	}

	private pump() {
		if (this.inflight) return;
		// During hello, only the hello frame itself may fly: the guest has no
		// session for anything else yet.
		const next = this.stateValue === 'hello' ? (this.queue[0]?.hello ? this.queue[0] : undefined) : this.queue[0];
		if (!next) return;
		this.queue.shift();
		next.seq ??= this.nextSeq++;
		const bytes = buildDataFrame(this.epoch, next.seq, next.json);
		this.inflight = {
			frame: bytes,
			seq: next.seq,
			hello: next.hello === true,
			sentAt: this.now(),
			attempts: 0,
		};
		this.transmit(bytes);
		this.armAckTimer();
	}

	private transmit(bytes: Uint8Array) {
		this.extraStats.framesOut++;
		try {
			this.opts.sendBytes(bytes);
		} catch {
			// The UART is the page's own emulator call; a throw means the VM
			// is tearing down. The ack timer will conclude the link is gone.
		}
	}

	private armAckTimer() {
		if (this.ackTimer) clearTimeout(this.ackTimer);
		this.ackTimer = setTimeout(() => this.onAckTimeout(), ACK_TIMEOUT_MS);
	}

	private onAckTimeout() {
		const flight = this.inflight;
		if (!flight) return;
		const elapsed = this.now() - flight.sentAt;
		// M5: when the page freezes, the whole machine freezes with it, and
		// this timer fires arbitrarily late through no fault of the guest's.
		// A grossly late fire is a probe, not a strike.
		const frozen = elapsed >= ACK_TIMEOUT_MS * 2;
		if (!frozen) flight.attempts++;
		const budget = flight.hello ? HELLO_RETRANSMITS : MAX_RETRANSMITS;
		if (flight.attempts > budget) {
			this.linkLost(
				`no ACK for seq ${flight.seq} after ${budget} retransmits — nothing is holding the far end of the wire`,
			);
			return;
		}
		if (flight.attempts > 0 || frozen) this.extraStats.retransmits++;
		flight.sentAt = this.now();
		this.transmit(flight.frame);
		this.armAckTimer();
	}

	// ── receive path ──

	private onFrame(frame: Frame) {
		if (this.stateValue === 'idle') return;
		if (frame.epoch !== this.epoch) {
			this.extraStats.staleFrames++;
			return;
		}
		if (frame.kind === 'ack') {
			const flight = this.inflight;
			if (!flight || frame.seq !== flight.seq) return; // late duplicate
			if (this.ackTimer) clearTimeout(this.ackTimer);
			this.ackTimer = null;
			this.inflight = null;
			this.pump();
			return;
		}
		// guest→page data: unacked by design; the sequence only witnesses.
		if (frame.seq <= this.guestSeqSeen) {
			this.extraStats.dupFrames++;
			return;
		}
		this.guestSeqSeen = frame.seq;
		this.onBody(frame.json);
	}

	private onBody(json: string) {
		let body: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(json);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
			body = parsed as Record<string, unknown>;
		} catch {
			this.extraStats.protocolErrors++;
			return; // no id was parsed, so nothing can be answered (§6.4)
		}
		const id = typeof body.id === 'string' ? body.id : null;
		const method = typeof body.method === 'string' ? body.method : null;

		if (method !== null) {
			this.onRequest(id, method, body);
			return;
		}
		if (id !== null && ('result' in body || 'error' in body)) {
			this.onResponse(id, body);
			return;
		}
		this.extraStats.protocolErrors++;
	}

	private onResponse(id: string, body: Record<string, unknown>) {
		const entry = this.pending.get(id);
		if (id === 'p.0' && this.stateValue === 'hello') {
			// The hello reply is handled here, not through pending: hello is
			// resent idempotently and must not double-settle.
			if ('error' in body) {
				const e = body.error as Partial<RpcErrorShape> | undefined;
				this.opts.log?.(`rpc: hello refused: ${String(e?.message ?? 'unknown error')}`);
				this.linkLost('the guest refused hello');
				return;
			}
			const result = (body.result ?? {}) as HelloResult;
			this.sessionUp(result);
			return;
		}
		if (!entry) {
			this.extraStats.staleResponses++;
			return;
		}
		clearTimeout(entry.deadlineTimer);
		this.pending.delete(id);
		if ('error' in body) {
			const raw = (body.error ?? {}) as Partial<RpcErrorShape>;
			entry.reject(
				new RpcCallError({
					code: typeof raw.code === 'number' ? raw.code : ERR.INTERNAL_ERROR.code,
					name: typeof raw.name === 'string' ? raw.name : 'INTERNAL_ERROR',
					message: typeof raw.message === 'string' ? raw.message : 'the guest sent a malformed error',
					...(typeof raw.hint === 'string' ? { hint: raw.hint } : {}),
				}),
			);
			return;
		}
		entry.resolve(body.result);
	}

	private onRequest(id: string | null, method: string, body: Record<string, unknown>) {
		// Notifications: no id, no response owed.
		if (id === null) {
			if (method === 'rpc.cancel') {
				const target = (body.params as { id?: unknown } | undefined)?.id;
				if (typeof target === 'string') this.cancelServe(target);
				return;
			}
			// Everything else is the owner's to route (stream.*, events);
			// what it does not know it ignores by design (§6.4).
			const p = body.params;
			this.opts.onNotify?.(
				method,
				typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {},
			);
			return;
		}
		const params = body.params;
		if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
			this.respondError(id, rpcError(ERR.INVALID_PARAMS, 'params must be an object'));
			return;
		}
		const handler = this.methods[method];
		if (!handler) {
			this.respondError(
				id,
				rpcError(ERR.METHOD_NOT_FOUND, `this page does not serve ${method}`, `it serves: ${Object.keys(this.methods).join(', ') || '(nothing)'}`),
			);
			return;
		}
		if (this.serves.has(id)) {
			this.respondError(id, rpcError(ERR.INVALID_REQUEST, `id ${id} is already in flight`));
			return;
		}
		if (this.serves.size >= MAX_SERVE_PENDING) {
			this.respondError(id, rpcError(ERR.OVERLOADED, `${MAX_SERVE_PENDING} requests already in flight on this page`));
			return;
		}
		const meta = (body.meta ?? {}) as { deadlineMs?: unknown };
		const deadlineMs = clampDeadline(typeof meta.deadlineMs === 'number' ? meta.deadlineMs : undefined);
		void this.runServe(id, method, (params ?? {}) as Record<string, unknown>, handler, deadlineMs);
	}

	private async runServe(
		id: string,
		method: string,
		params: Record<string, unknown>,
		handler: ServeHandler,
		deadlineMs: number,
	) {
		const job: ServeJob = { ctl: new AbortController(), answered: false };
		this.serves.set(id, job);
		const answer = (make: () => Record<string, unknown>) => {
			if (job.answered) return;
			job.answered = true;
			this.serves.delete(id);
			this.respond(make());
		};
		const deadline = setTimeout(() => {
			answer(() => ({
				jsonrpc: '2.0',
				id,
				error: rpcError(ERR.DEADLINE_EXCEEDED, `${method} exceeded its ${deadlineMs} ms budget`),
			}));
			job.ctl.abort();
		}, deadlineMs);
		job.ctl.signal.addEventListener(
			'abort',
			() => {
				// rpc.cancel or session teardown. On teardown `answered` is
				// already latched, so this only speaks for real cancels.
				answer(() => ({
					jsonrpc: '2.0',
					id,
					error: rpcError(ERR.CANCELLED, `${method} was cancelled`),
				}));
			},
			{ once: true },
		);
		try {
			const result = await handler(params, { id, signal: job.ctl.signal, deadlineMs });
			answer(() => {
				const frame = { jsonrpc: '2.0', id, result: result ?? {} };
				// A method that outgrows the frame must use a resource ref
				// (§6.8); shipping a broken frame would be worse than erroring.
				if (encoder.encode(JSON.stringify(frame)).length + 64 > this.maxFrame) {
					return {
						jsonrpc: '2.0',
						id,
						error: rpcError(
							ERR.INTERNAL_ERROR,
							`${method} answered past maxFrame; it must spill to a resource ref`,
						),
					};
				}
				return frame;
			});
		} catch (e) {
			answer(() => ({
				jsonrpc: '2.0',
				id,
				error:
					e instanceof ServeError
						? e.rpc
						: rpcError(ERR.INTERNAL_ERROR, e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
			}));
		} finally {
			clearTimeout(deadline);
		}
	}

	private cancelServe(id: string) {
		const job = this.serves.get(id);
		if (job) job.ctl.abort();
	}

	private respondError(id: string, err: RpcErrorShape) {
		this.respond({ jsonrpc: '2.0', id, error: err });
	}

	private respond(body: Record<string, unknown>) {
		if (this.stateValue !== 'up' && this.stateValue !== 'hello') return;
		this.enqueue({ json: JSON.stringify(body) });
	}
}

function clampDeadline(v: number | undefined): number {
	if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_DEADLINE_MS;
	return Math.min(600_000, Math.max(1_000, Math.floor(v)));
}
