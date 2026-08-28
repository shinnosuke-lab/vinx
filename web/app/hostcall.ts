/**
 * The page as a callable host: run JavaScript here, fetch from here.
 *
 * Two executors and one wire format, shared by two callers:
 *
 *   - The LLM's `run_js` tool (device-vm.ts) calls `runJs` directly, injected
 *     through `VmExtras` the way `terminal` and `download` are.
 *   - The guest's js(1) and fetch(1) CLIs speak a line protocol over ttyS3
 *     (vm.ts owns the UART; `parseCallLine`/`buildDoneLine`/`answerHostcall`
 *     here are its codec and its brain).
 *
 * Why ttyS3 and not the existing OSC escapes: OSC only reaches the browser
 * when the emitting command's stdout is the console (ttyS0). A CLI the model
 * invokes through run_shell has its stdout captured by agentd — the escapes
 * would land in the tool output, not the parser. A dedicated UART works the
 * same for every caller.
 *
 * Wire format, one line each way, payloads base64(JSON) — agentd's shape,
 * with the same length-prefix truncation guard:
 *
 *   ->  CALL <id> <kind> <len> <base64(json)>
 *   <-  DONE <id> <0|1> <len> <base64(json)>
 *
 * Large payloads do not belong on an emulated UART (it moves bytes one at a
 * time): replies past `REPLY_INLINE_MAX` land in /data as `.hostcall-<id>`
 * and the DONE carries `{file}`; requests past the same bound arrive as
 * `{req: <file>}` naming a /data file that holds the real payload. 9p is
 * exact and memory-speed both ways.
 *
 * Everything here runs on the main thread on purpose (the point of run_js is
 * the page: its DOM, its origin, its fetch). The consequence is stated where
 * it matters: a timeout only interrupts code that awaits — synchronous code
 * cannot be preempted, and a `while(true)` freezes the tab.
 */

/** Where an inline reply stops and the /data spill begins. */
export const REPLY_INLINE_MAX = 32 * 1024;
/** What runJs hands back at most — context is not a pastebin. */
const MAX_JS_OUTPUT = 48_000;
/** A fetched body larger than this is cut (and says so). */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

function clampMs(v: unknown, fallback = 30_000): number {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(120_000, Math.max(1_000, Math.floor(n)));
}

function fmtValue(v: unknown): string {
	if (typeof v === 'string') return v;
	try {
		const s = JSON.stringify(v);
		if (s !== undefined) return s;
	} catch {
		/* circular or hostile toJSON; String below still answers */
	}
	return String(v);
}

export interface JsRun {
	/** false when the script threw or timed out. */
	ok: boolean;
	/** Console output plus the completion value (or the error), printable. */
	output: string;
}

// ── console capture, shared because runs overlap ──
//
// Two callers can have scripts in flight at once: the LLM's run_js and the
// guest's js(1) (flock serialises guests, not the LLM). A per-run
// save-hijack-restore tangles under that overlap — the later run saves the
// earlier run's wrapper as "the original", and whichever finishes last
// installs a dead run's wrapper as the console, forever. So the wrapper goes
// on once, fans each line out to every live run's sink, and the real console
// comes back only when the last run leaves. A line logged while two runs are
// live lands in both sinks: on a shared main thread attribution is a guess,
// and a lost line would be worse than a duplicated one.

const sinks = new Set<string[]>();
let hijacked: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error } | null =
	null;

function openSink(): string[] {
	if (!hijacked) {
		hijacked = { log: console.log, warn: console.warn, error: console.error };
		const capture =
			(tag: string, through: (...a: unknown[]) => void) =>
			(...args: unknown[]) => {
				const line = tag + args.map(fmtValue).join(' ');
				for (const sink of sinks) sink.push(line);
				through.apply(console, args);
			};
		console.log = capture('', hijacked.log);
		console.warn = capture('[warn] ', hijacked.warn);
		console.error = capture('[error] ', hijacked.error);
	}
	const sink: string[] = [];
	sinks.add(sink);
	return sink;
}

function closeSink(sink: string[]) {
	sinks.delete(sink);
	if (sinks.size === 0 && hijacked) {
		console.log = hijacked.log;
		console.warn = hijacked.warn;
		console.error = hijacked.error;
		hijacked = null;
	}
}

/**
 * Run a script on this page: `await` works, `document`/`window`/`fetch` are
 * the page's own. Console output is captured; the completion value rides
 * along. Never throws — an error is an outcome, not an exception.
 *
 * Expression-first, like a REPL: `6*7` answers 42. If wrapping the code as
 * `return (...)` is not valid syntax (multiple statements, declarations), it
 * runs as a function body instead, where an explicit `return` sets the value.
 *
 * The timeout is a promise race: it fires only when the script yields (an
 * await). Synchronous code cannot be interrupted on the main thread — a
 * `while(true)` freezes the page, timeout or not.
 */
export async function runJs(code: string, timeoutMs = 10_000): Promise<JsRun> {
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
		...args: string[]
	) => () => Promise<unknown>;

	let fn: () => Promise<unknown>;
	try {
		try {
			// The newline stops a trailing line comment from eating the `)`.
			fn = new AsyncFunction(`return (${code}\n)`);
		} catch {
			fn = new AsyncFunction(code);
		}
	} catch (e) {
		return { ok: false, output: `SyntaxError: ${e instanceof Error ? e.message : String(e)}` };
	}

	const logs = openSink();

	const timedOut = Symbol('timeout');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ok = true;
	let tail = '';
	try {
		const value = await Promise.race([
			fn(),
			new Promise<typeof timedOut>((resolve) => {
				timer = setTimeout(() => resolve(timedOut), timeoutMs);
			}),
		]);
		if (value === timedOut) {
			ok = false;
			tail = `[timed out after ${Math.round(timeoutMs / 1000)}s — the timeout only interrupts code that awaits]`;
		} else if (value !== undefined) {
			tail = fmtValue(value);
		}
	} catch (e) {
		ok = false;
		tail = e instanceof Error ? `${e.name}: ${e.message}` : `threw: ${fmtValue(e)}`;
	} finally {
		clearTimeout(timer);
		closeSink(logs);
	}

	let output = [...logs, tail].filter((s) => s !== '').join('\n');
	if (output.length > MAX_JS_OUTPUT) {
		output = output.slice(0, MAX_JS_OUTPUT) + `\n[truncated at ${MAX_JS_OUTPUT} chars]`;
	}
	return { ok, output: output || '(no output — the script logged nothing and returned undefined)' };
}

export interface HostFetchRequest {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	/** A text body, or — for exact bytes — `bodyB64`. */
	body?: string;
	bodyB64?: string;
	timeoutMs?: number;
}

export type HostFetchResult =
	| {
			ok: true;
			status: number;
			statusText: string;
			/** The final URL, after redirects. */
			url: string;
			headers: Record<string, string>;
			bytes: Uint8Array;
			truncated: boolean;
	  }
	| { ok: false; error: string };

/**
 * A fetch from this page, on the guest's behalf. The page's origin and the
 * browser's rules apply: cross-origin responses are readable only when the
 * server sends permissive CORS headers — a failure here is usually that, and
 * the error says so. Relative URLs resolve against the page.
 */
export async function hostFetch(req: HostFetchRequest): Promise<HostFetchResult> {
	let url: string;
	try {
		url = new URL(
			String(req?.url ?? ''),
			typeof location === 'undefined' ? undefined : location.href,
		).href;
	} catch {
		return { ok: false, error: `fetch: not a usable URL: ${String(req?.url)}` };
	}

	let body: BodyInit | undefined;
	if (typeof req.bodyB64 === 'string') {
		try {
			body = b64ToBytes(req.bodyB64);
		} catch {
			return { ok: false, error: 'fetch: the request body is not valid base64' };
		}
	} else if (typeof req.body === 'string') {
		body = req.body;
	}

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), clampMs(req.timeoutMs));
	try {
		const res = await fetch(url, {
			method: req.method || 'GET',
			headers: req.headers && typeof req.headers === 'object' ? req.headers : undefined,
			body,
			signal: abort.signal,
		});

		const chunks: Uint8Array[] = [];
		let total = 0;
		let truncated = false;
		const reader = res.body?.getReader();
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value?.length) continue;
				if (total + value.length > MAX_FETCH_BYTES) {
					chunks.push(value.subarray(0, MAX_FETCH_BYTES - total));
					total = MAX_FETCH_BYTES;
					truncated = true;
					await reader.cancel().catch(() => {});
					break;
				}
				chunks.push(value);
				total += value.length;
			}
		}
		const bytes = new Uint8Array(total);
		let at = 0;
		for (const c of chunks) {
			bytes.set(c, at);
			at += c.length;
		}

		return {
			ok: true,
			status: res.status,
			statusText: res.statusText,
			url: res.url,
			headers: Object.fromEntries(res.headers.entries()),
			bytes,
			truncated,
		};
	} catch (e) {
		if (abort.signal.aborted) {
			return { ok: false, error: `fetch: timed out after ${clampMs(req.timeoutMs) / 1000}s` };
		}
		// The browser deliberately says nothing about *why* a cross-origin
		// request failed; name the usual suspect so the guest can act on it.
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			error:
				`fetch: ${msg} — from a page this usually means CORS (the server did not allow ` +
				`cross-origin reads) or no network route; for arbitrary hosts use curl over a relay`,
		};
	} finally {
		clearTimeout(timer);
	}
}

// ── the ttyS3 wire ──

export interface ParsedCall {
	id: string;
	kind: string;
	payload?: unknown;
	/** Set when the line was addressable but unusable; a DONE(error) is owed. */
	error?: string;
}

/**
 * One guest line. `null` is boot noise (not CALL-shaped, nothing owed); a
 * parse with `error` set still carries the id, so the failure can be
 * *answered* rather than leaving the CLI to its read timeout.
 */
export function parseCallLine(line: string): ParsedCall | null {
	if (!line.startsWith('CALL ')) return null;
	const parts = line.split(' ');
	const id = parts[1] ?? '';
	if (!/^[\w.-]+$/.test(id)) return null; // no usable id: nowhere to answer
	if (parts.length !== 5) return { id, kind: '', error: 'malformed CALL line' };
	const [, , kind, len, b64] = parts;
	if (!/^\d+$/.test(len) || Number(len) !== b64.length) {
		return { id, kind, error: `payload arrived truncated (${b64.length} of ${len} chars)` };
	}
	try {
		return { id, kind, payload: JSON.parse(fromB64(b64)) };
	} catch {
		return { id, kind, error: 'payload is not base64-encoded JSON' };
	}
}

/** The reply line, `\n` included. */
export function buildDoneLine(id: string, reply: Record<string, unknown>): string {
	const b64 = toB64(JSON.stringify(reply));
	const ok = reply.ok === true ? 1 : 0;
	return `DONE ${id} ${ok} ${b64.length} ${b64}\n`;
}

/**
 * Answer one call. Every reply is `{ok, ...}`; a thrown executor is caught by
 * the caller (vm.ts), which owes a DONE on every path. `spill` writes a
 * too-big body into /data under the given name.
 */
export async function answerHostcall(
	kind: string,
	payload: unknown,
	id: string,
	spill: (name: string, bytes: Uint8Array) => Promise<void>,
): Promise<Record<string, unknown>> {
	const args = (payload ?? {}) as Record<string, unknown>;

	if (kind === 'js') {
		const code = typeof args.code === 'string' ? args.code : '';
		if (!code.trim()) return { ok: false, error: 'js: the payload carries no code' };
		const ran = await runJs(code, clampMs(args.timeoutMs, 10_000));
		if (ran.output.length > REPLY_INLINE_MAX) {
			const name = `.hostcall-${id}`;
			await spill(name, encoder.encode(ran.output));
			return { ok: ran.ok, file: name, bytes: ran.output.length };
		}
		return { ok: ran.ok, output: ran.output };
	}

	if (kind === 'fetch') {
		const got = await hostFetch(args as HostFetchRequest);
		if (!got.ok) return got;
		const meta = {
			ok: true,
			status: got.status,
			statusText: got.statusText,
			url: got.url,
			headers: got.headers,
			...(got.truncated ? { truncated: true } : {}),
		};
		if (got.bytes.byteLength > REPLY_INLINE_MAX) {
			const name = `.hostcall-${id}`;
			await spill(name, got.bytes);
			return { ...meta, file: name, bytes: got.bytes.byteLength, binary: tryUtf8(got.bytes) === null };
		}
		const text = tryUtf8(got.bytes);
		return text !== null ? { ...meta, body: text } : { ...meta, bodyB64: toB64Bytes(got.bytes) };
	}

	return { ok: false, error: `unknown hostcall kind: ${kind} (this page knows js, fetch)` };
}

// ── base64, chunked so a 2 MB body does not blow the argument list ──

function toB64(text: string): string {
	return toB64Bytes(encoder.encode(text));
}

function toB64Bytes(bytes: Uint8Array): string {
	let bin = '';
	const STEP = 0x8000;
	for (let i = 0; i < bytes.length; i += STEP) {
		bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
	}
	return btoa(bin);
}

function fromB64(b64: string): string {
	return new TextDecoder().decode(b64ToBytes(b64));
}

/** The narrow return type (a Uint8Array over a real ArrayBuffer, which
 * `new Uint8Array(n)` guarantees) is what lets callers pass it as a fetch
 * BodyInit under TS 5.9's generic typed arrays. */
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function tryUtf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}
