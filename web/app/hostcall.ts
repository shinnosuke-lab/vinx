/**
 * The page as a callable host: run JavaScript here, fetch from here.
 *
 * Two executors and the two control-plane methods built on them, shared by
 * two callers:
 *
 *   - The LLM's `run_js` tool (device-vm.ts) calls `runJs` directly, injected
 *     through `VmExtras` the way `terminal` and `download` are.
 *   - The guest's js(1) and fetch(1) CLIs arrive as JSON-RPC over the ttyS3
 *     control link (app/rpc.ts owns the wire; vm.ts wires it to the UART):
 *     `debug.js` and `http.fetch`, the methods `pageMethods` builds here.
 *
 * Method results follow system-v2 §6.8: what fits the negotiated inline
 * budget rides in the frame; anything bigger lands in /data/.vinx/tmp and
 * the result names it explicitly ({outputRef}/{bodyRef} with path, size,
 * owner, expiresWithSession) — the caller consumes and deletes it. Requests
 * mirror the same idea with {codeRef}/{bodyRef} for arguments too big for a
 * 4 KiB frame.
 *
 * `debug.js` is named for what it is (§14): the page as a debugging surface.
 * Public capability grows as proper methods, not as more page eval.
 *
 * Everything here runs on the main thread on purpose (the point of run_js is
 * the page: its DOM, its origin, its fetch). The consequence is stated where
 * it matters: a timeout only interrupts code that awaits — synchronous code
 * cannot be preempted, and a `while(true)` freezes the tab.
 */

import { OriginBusyError, OriginForegroundError } from './origin-broker';
import { ERR, INLINE_MAX, rpcError, ServeError, type ServeHandler } from './rpc';

/** What runJs hands back at most — context is not a pastebin. */
const MAX_JS_OUTPUT = 48_000;
/** A fetched body larger than this is cut (and says so). */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
/** Where session resources live (§6.8); the guest sweeps it at boot. */
const TMP_PREFIX = '/data/.vinx/tmp/';
/** A whole result frame must fit maxFrame with envelope room to spare. */
const RESULT_BUDGET = 3200;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
// guest's js(1) (the control link serves requests concurrently). A per-run
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
	/** A text body, or — for exact bytes — `bodyB64` / `bodyBytes`. */
	body?: string;
	bodyB64?: string;
	bodyBytes?: Uint8Array;
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
 * the error says so. Relative URLs resolve against the page. An aborted
 * `signal` (rpc.cancel) stops the transfer.
 */
export async function hostFetch(req: HostFetchRequest, signal?: AbortSignal): Promise<HostFetchResult> {
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
	if (req.bodyBytes instanceof Uint8Array) {
		// Copy into a plain ArrayBuffer-backed view: BodyInit's typing (and
		// some fetch implementations) dislike SharedArrayBuffer backings.
		const copy = new Uint8Array(req.bodyBytes.byteLength);
		copy.set(req.bodyBytes);
		body = copy;
	} else if (typeof req.bodyB64 === 'string') {
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
	const onOuterAbort = () => abort.abort();
	signal?.addEventListener('abort', onOuterAbort, { once: true });
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
		if (signal?.aborted) {
			return { ok: false, error: 'fetch: cancelled' };
		}
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
		signal?.removeEventListener('abort', onOuterAbort);
	}
}

// ── the control-plane methods ──

/** How the methods reach /data: absolute guest paths, bytes both ways.
 * vm.ts backs this with the 9p API; tests back it with a Map. */
export interface RefIo {
	read(path: string): Promise<Uint8Array>;
	write(path: string, bytes: Uint8Array): Promise<void>;
}

function refPath(ref: unknown): { path: string; size: number | null } {
	const r = (ref ?? {}) as { path?: unknown; size?: unknown };
	const path = typeof r.path === 'string' ? r.path : '';
	const base = path.startsWith(TMP_PREFIX) ? path.slice(TMP_PREFIX.length) : '';
	if (!/^[\w.-]+$/.test(base)) {
		throw new ServeError(
			rpcError(
				ERR.RESOURCE_INVALID,
				`not a session resource path: ${path || '(missing)'}`,
				`refs name files directly under ${TMP_PREFIX} (§6.8)`,
			),
		);
	}
	return { path, size: typeof r.size === 'number' ? r.size : null };
}

async function readRef(io: RefIo, ref: unknown): Promise<Uint8Array> {
	const { path, size } = refPath(ref);
	let bytes: Uint8Array;
	try {
		bytes = await io.read(path);
	} catch {
		throw new ServeError(
			rpcError(ERR.RESOURCE_INVALID, `the ref cannot be read: ${path}`, 'deleted already, or /data never mounted?'),
		);
	}
	if (size !== null && bytes.byteLength !== size) {
		throw new ServeError(
			rpcError(
				ERR.RESOURCE_INVALID,
				`the ref declares ${size} bytes but carries ${bytes.byteLength}`,
				'the writer and the caller disagree; re-stage it',
			),
		);
	}
	return bytes;
}

async function writeRef(io: RefIo, name: string, bytes: Uint8Array): Promise<string> {
	const path = TMP_PREFIX + name;
	try {
		await io.write(path, bytes);
	} catch {
		throw new ServeError(
			rpcError(
				ERR.DATA_PLANE_UNAVAILABLE,
				'the result outgrew the inline budget and writing it to /data failed',
				'is /data mounted? small results still work',
			),
		);
	}
	return path;
}

/** A guest id (g.12.3) as a filename fragment. */
function safeId(id: string): string {
	return id.replace(/[^\w.-]/g, '_');
}

/** Response headers, bounded: a server can send kilobytes of them and the
 * whole result must still fit one frame. */
function trimHeaders(h: Record<string, string>): { headers: Record<string, string>; cut: boolean } {
	const headers: Record<string, string> = {};
	let used = 0;
	let cut = false;
	for (const [k, v] of Object.entries(h)) {
		used += k.length + v.length + 6;
		if (used > 2048) {
			cut = true;
			continue;
		}
		headers[k] = v;
	}
	return { headers, cut };
}

const fits = (result: Record<string, unknown>) =>
	encoder.encode(JSON.stringify(result)).length <= RESULT_BUDGET;

/** A required non-empty string param, or INVALID_PARAMS naming it. */
function wantStr(params: Record<string, unknown>, key: string, method: string): string {
	const v = params[key];
	if (typeof v !== 'string' || v === '') {
		throw new ServeError(rpcError(ERR.INVALID_PARAMS, `${method} wants a ${key} string`));
	}
	return v;
}

/** A desktop capability, or UNAVAILABLE saying which page would carry it. */
function wantSurface<T>(member: T | undefined, what: string): T {
	if (!member) {
		throw new ServeError(
			rpcError(ERR.UNAVAILABLE, `no ${what} on this desktop`, 'is a page showing this machine?'),
		);
	}
	return member;
}

/** A broker/executor failure as the guest should hear it. The origin
 * broker's verdicts keep their own codes (§3.0: contention and foreground
 * rules are named errors, not generic unavailability). */
function unavailable(e: unknown): ServeError {
	if (e instanceof ServeError) return e;
	if (e instanceof OriginBusyError) return new ServeError(rpcError(ERR.RESOURCE_BUSY, e.message));
	if (e instanceof OriginForegroundError) {
		return new ServeError(rpcError(ERR.REQUIRES_FOREGROUND, e.message));
	}
	return new ServeError(rpcError(ERR.UNAVAILABLE, e instanceof Error ? e.message : String(e)));
}

/** camera(1)'s filename shape, re-checked here so a forged call cannot
 * name a path; the CLI validates the same way for its own error text. */
const CAMERA_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

/**
 * What the desktop lends the control plane beyond executors — every browser
 * API the methods below need, injected so this module stays node-testable
 * (§8.2's stance: the page's own capabilities, reached through one seam).
 * The screen panel registers itself as 'screen' (vm.ts's onWindowFocus);
 * §10.7's fuller window.* set arrives with Phase 5. Everything is optional:
 * an absent member answers UNAVAILABLE with a hint, never a silent no-op
 * (§15 Phase 3's closing rule).
 */
export interface DesktopSurface {
	/** Raise/show the named desktop window; false when no such window. */
	focusWindow?: (id: string) => boolean;
	/** The desktop document's window table (§10.7): list/create/close/
	 * focus/move/resize, backed by window-manager.ts. */
	windows?: WindowService;
	/** A system notification if permitted, else a page toast; null when
	 * neither surface exists. Answers what carried it. */
	notify?: (text: string) => 'notification' | 'note' | null;
	/** Speak through the page's speech synthesis; false when unsupported. */
	speak?: (text: string) => boolean;
	/** One webcam frame, PNG, into /data/<name>; resolves with its size. */
	captureCamera?: (name: string) => Promise<number>;
	/** Open a URL in a new tab. 'parked' when the popup blocker won and a
	 * chip now waits for the person's click; null when nothing could even
	 * park it (no page is showing this machine). */
	openUrl?: (url: string) => 'opened' | 'parked' | null;
	/** Render-or-download a named file (the fileOpener split): renderable
	 * types open a tab (or park), opaque ones download under their name. */
	openFile?: (name: string, bytes: Uint8Array) => 'opened' | 'parked' | 'downloaded' | null;
	/** Hand bytes to the person as a browser download. */
	download?: (name: string, bytes: Uint8Array) => boolean;
	/** The Web Bluetooth broker (ble.ts); absent off-Chromium and in tests. */
	ble?: BleBroker;
	/** The WebRTC LAN bridge control (bridge-ctl.ts). */
	bridge?: BridgeControl;
}

/**
 * The page's one BLE device, GATT-deep (ble.ts holds the state: device,
 * subscriptions, the parked picker). Methods throw plain Errors with
 * guest-worthy messages; the handlers wrap them as UNAVAILABLE.
 */
export interface BleBroker {
	/** Blocks until the picker resolves — a human click on the ble chip —
	 * or a remembered device reconnects silently. */
	connect(service?: string): Promise<{ device: string; id: string }>;
	status(): { state: 'off' | 'pending' | 'connected'; device?: string; id?: string };
	/** Two-phase by browser rule: `on` parks the scan on the chip and
	 * answers accepted; the click starts it. */
	scan(on: boolean): Promise<{ pending?: boolean; note?: string }>;
	services(): Promise<string>;
	read(svc: string, chr: string): Promise<string>;
	write(svc: string, chr: string, hex: string): Promise<void>;
	/** Subscribe (or, with `off`, unsubscribe); answers a note for the
	 * already-subscribed case. Values land in the feed ring. */
	subscribe(svc: string, chr: string, off: boolean): Promise<string>;
	disconnect(): Promise<void>;
	/** Where notification/scan lines land: a data-plane ring under the
	 * session tmp namespace, named here so results can say so (§6.8). */
	feedPath(): string;
}

/**
 * The desktop's window table, as the window.* methods see it (§10.7;
 * window-manager.ts implements it, one table per desktop document — that
 * is window.*'s scope, §3.0). Methods answer plainly; `create` throws a
 * plain Error the handler maps (a missing app shell among them, §18).
 */
export interface WindowService {
	list(): { id: string; title: string; surface: string; open: boolean }[];
	create(spec: {
		id: string;
		title: string;
		appId?: string;
		bundle: { html: string; css: string; js: string };
	}): void;
	close(id: string): boolean;
	focus(id: string): boolean;
	move(id: string, x: number, y: number): boolean;
	resize(id: string, w: number, h: number): boolean;
}

/** A window.create bundle may carry this much, decoded (§10.3 speaks of
 * single-file self-contained bundles; half a megabyte is a lot of one). */
const BUNDLE_MAX = 512 * 1024;

/** The §10.3 bundle: three structured parts, never a whole document. */
function parseBundle(bytes: Uint8Array): { html: string; css: string; js: string } {
	if (bytes.byteLength > BUNDLE_MAX) {
		throw new ServeError(
			rpcError(ERR.INVALID_PARAMS, `the bundle is ${bytes.byteLength} bytes; the cap is ${BUNDLE_MAX}`),
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(bytes));
	} catch {
		throw new ServeError(
			rpcError(ERR.RESOURCE_INVALID, 'the bundle is not JSON', 'app-run stages {html, css, js}'),
		);
	}
	const b = (parsed ?? {}) as Record<string, unknown>;
	const part = (k: string) => {
		const v = b[k];
		if (v === undefined) return '';
		if (typeof v !== 'string') {
			throw new ServeError(
				rpcError(ERR.RESOURCE_INVALID, `bundle.${k} is not a string`, 'structured parts, not documents (§10.3)'),
			);
		}
		return v;
	};
	const html = part('html');
	const css = part('css');
	const js = part('js');
	if (!html && !js) {
		throw new ServeError(
			rpcError(ERR.RESOURCE_INVALID, 'the bundle carries neither html nor js', 'an empty window is a mistake somewhere'),
		);
	}
	return { html, css, js };
}

/** The bridge's roster, live from the room (never a file). */
export interface BridgeStatus {
	state: 'off' | 'joining' | 'on' | 'failed';
	role?: 'host' | 'member';
	room?: string;
	members?: { name: string; ip: string; host: boolean }[];
	error?: string;
}

/** The WebRTC LAN bridge, driven from the guest (bridge-ctl.ts). */
export interface BridgeControl {
	/** Resolves when the room is on; rejects with the failure. */
	start(name: string, ip: string, signal?: AbortSignal): Promise<BridgeStatus>;
	join(code: string, name: string, ip: string, signal?: AbortSignal): Promise<BridgeStatus>;
	stop(): void;
	/** false when no live room — the caller hears that, not silence. */
	say(text: string, to?: string): boolean;
	status(): BridgeStatus;
}

/**
 * The methods this page serves over the control link. `io` is the /data
 * back end; the returned table goes straight into RpcLink's options (and
 * its keys into the hello, so the guest can discover them).
 */
export function pageMethods(io: RefIo, desktop: DesktopSurface = {}): Record<string, ServeHandler> {
	/** Names for windows created without an app id. */
	let anonWindows = 0;
	/** The id param the window.* methods (focus excepted) want. */
	const wantWindowId = (params: Record<string, unknown>, method: string): string => {
		const id = typeof params.id === 'string' ? params.id : '';
		if (!id) {
			throw new ServeError(rpcError(ERR.INVALID_PARAMS, `${method} wants {id}`, 'window.list names them'));
		}
		return id;
	};
	const noSuchWindow = (id: string): ServeError =>
		new ServeError(
			rpcError(ERR.UNAVAILABLE, `no window named ${id} on this desktop`, 'window.list shows what there is'),
		);

	return {
		// The first real window.* method (§7.1: desktop-owned, §10.7 names
		// focus). lvdemo(1) calls it before painting /dev/fb0 — a draw
		// changes no video mode, so only the guest can say "show the
		// screen". Resolution order: the window table first, then the
		// legacy focus broadcast the screen panels registered before the
		// table existed.
		'window.focus': async (params) => {
			const id = typeof params.id === 'string' ? params.id : '';
			if (!id) {
				throw new ServeError(
					rpcError(ERR.INVALID_PARAMS, 'window.focus wants {id}', "the VGA panel is id 'screen'"),
				);
			}
			if (!desktop.windows?.focus(id) && !desktop.focusWindow?.(id)) {
				throw new ServeError(
					rpcError(
						ERR.UNAVAILABLE,
						`no window named ${id} on this desktop`,
						"the screen panel registers as 'screen' while a page is showing this machine",
					),
				);
			}
			return { focused: true };
		},

		// ── the rest of §10.7's minimal window set (Phase 5). Scope is
		// this desktop document (§3.0): one machine's windows, never a
		// sibling pane's. The closed/focused *events* wait for the rpcd
		// event stream (§6.7's named gap); what a close means for a hybrid
		// app's process is wired page-side instead — the manager's close
		// calls app.stop for windows that front an app. ──

		'window.list': async () => {
			const table = wantSurface(desktop.windows, 'window table');
			return { windows: table.list() };
		},

		// The §10.3 launch: app-run stages the {html,css,js} bundle under
		// /data/.vinx/tmp and names it here as bundleRef — a request
		// parameter, never a return value (§6.8). The bundle is read (and
		// done with) before this replies, so the caller may delete it.
		'window.create': async (params) => {
			const table = wantSurface(desktop.windows, 'window table');
			const surface = typeof params.surface === 'string' ? params.surface : '';
			if (surface !== 'web') {
				throw new ServeError(
					rpcError(
						ERR.INVALID_PARAMS,
						surface ? `surface ${surface} is not creatable here` : 'window.create wants {surface:"web", bundleRef}',
						'a tty window opens through app.start {pty:true} (§6.9); fb is the screen window',
					),
				);
			}
			const bundle = parseBundle(await readRef(io, params.bundleRef));
			const app = typeof params.app === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(params.app)
				? params.app
				: undefined;
			const id = app ?? `web-${++anonWindows}`;
			const title =
				typeof params.title === 'string' && params.title.trim()
					? params.title.trim().slice(0, 48)
					: id;
			try {
				table.create({ id, title, appId: app, bundle });
			} catch (e) {
				throw unavailable(e);
			}
			return { id, created: true };
		},

		'window.close': async (params) => {
			const table = wantSurface(desktop.windows, 'window table');
			const id = wantWindowId(params, 'window.close');
			if (!table.close(id)) throw noSuchWindow(id);
			return { closed: true };
		},

		'window.move': async (params) => {
			const table = wantSurface(desktop.windows, 'window table');
			const id = wantWindowId(params, 'window.move');
			const x = Number(params.x);
			const y = Number(params.y);
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				throw new ServeError(rpcError(ERR.INVALID_PARAMS, 'window.move wants {id, x, y} in pane pixels'));
			}
			if (!table.move(id, Math.round(x), Math.round(y))) throw noSuchWindow(id);
			return { moved: true };
		},

		'window.resize': async (params) => {
			const table = wantSurface(desktop.windows, 'window table');
			const id = wantWindowId(params, 'window.resize');
			const w = Number(params.w);
			const h = Number(params.h);
			if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
				throw new ServeError(rpcError(ERR.INVALID_PARAMS, 'window.resize wants {id, w, h} in pane pixels'));
			}
			if (!table.resize(id, Math.round(w), Math.round(h))) throw noSuchWindow(id);
			return { resized: true };
		},

		// ── the OSC 7770 successors (§15 Phase 3): notify(1), say(1),
		// camera(1), open(1), download(1), ble(1), bridge(1) used to reach
		// the page as terminal escape sequences — parsed on exactly one
		// page's xterm, silent everywhere else, answered through /data
		// files the guest polled. Each is a method now: both pages serve
		// them, run_shell can call them, and a failure is an error the
		// caller hears. ──

		'notify.show': async (params) => {
			const text = wantStr(params, 'text', 'notify.show');
			const via = desktop.notify?.(text) ?? null;
			if (!via) {
				throw new ServeError(
					rpcError(
						ERR.UNAVAILABLE,
						'nowhere to show a notification',
						'the browser has not granted notifications and no page toast is showing this machine',
					),
				);
			}
			return { via };
		},

		'speech.speak': async (params) => {
			const text = wantStr(params, 'text', 'speech.speak');
			if (!desktop.speak?.(text)) {
				throw new ServeError(
					rpcError(ERR.UNAVAILABLE, 'this desktop cannot speak', 'speechSynthesis is missing, or no page shows this machine'),
				);
			}
			return {};
		},

		'media.camera.capture': async (params) => {
			const name = wantStr(params, 'name', 'media.camera.capture');
			if (!CAMERA_NAME.test(name)) {
				throw new ServeError(
					rpcError(ERR.INVALID_PARAMS, `not a usable image name: ${name}`, 'a bare NAME.png — no slashes, no leading dot'),
				);
			}
			const capture = wantSurface(desktop.captureCamera, 'camera');
			let size: number;
			try {
				size = await capture(name);
			} catch (e) {
				// A denied permission or a missing device is the capability
				// being unavailable, not an internal fault.
				throw unavailable(e);
			}
			// A person-facing photo, not a session temp: it lands in /data
			// proper and persists like anything else there.
			return { image: { path: `/data/${name}`, size, owner: 'caller', expiresWithSession: false } };
		},

		'window.openUrl': async (params) => {
			const url = wantStr(params, 'url', 'window.openUrl');
			// The page is the security boundary: nothing but web URLs opens
			// from the guest (javascript:, file: die here, loudly).
			if (!/^https?:\/\//i.test(url)) {
				throw new ServeError(
					rpcError(ERR.INVALID_PARAMS, `only http(s) URLs open from the guest: ${url.slice(0, 80)}`),
				);
			}
			const open = wantSurface(desktop.openUrl, 'URL opener');
			const disposition = open(url);
			if (!disposition) {
				throw new ServeError(
					rpcError(
						ERR.UNAVAILABLE,
						'the popup blocker stopped it and nothing could park a retry',
						'is a page showing this machine?',
					),
				);
			}
			return { disposition };
		},

		'resource.open': async (params) => {
			const name = wantStr(params, 'name', 'resource.open');
			const bytes = await readRef(io, params.ref);
			const open = wantSurface(desktop.openFile, 'file opener');
			const disposition = open(name, bytes);
			if (!disposition) {
				throw new ServeError(
					rpcError(
						ERR.UNAVAILABLE,
						'the popup blocker stopped it and nothing could park a retry',
						'is a page showing this machine?',
					),
				);
			}
			return { disposition };
		},

		'resource.download': async (params) => {
			const name = wantStr(params, 'name', 'resource.download');
			const bytes = await readRef(io, params.ref);
			if (!wantSurface(desktop.download, 'download surface')(name, bytes)) {
				throw new ServeError(rpcError(ERR.UNAVAILABLE, 'this desktop cannot start a download'));
			}
			return {};
		},

		// ── ble.* (§7.1: desktop broker, origin scope). The broker keeps
		// the state (one device, subscriptions, the parked picker); the
		// browser's gesture rule survives as-is: connect blocks until the
		// person clicks the ble chip, scan answers accepted and waits for
		// the same click. ──

		'ble.connect': async (params) => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			const service = typeof params.service === 'string' && params.service ? params.service : undefined;
			try {
				return await broker.connect(service);
			} catch (e) {
				throw unavailable(e);
			}
		},

		'ble.status': async () => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			return broker.status();
		},

		'ble.scan': async (params) => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			try {
				const got = await broker.scan(params.on !== false);
				return { ...got, feed: { path: broker.feedPath() } };
			} catch (e) {
				throw unavailable(e);
			}
		},

		'ble.services': async (_params, ctx) => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			let listing: string;
			try {
				listing = await broker.services();
			} catch (e) {
				throw unavailable(e);
			}
			const bytes = encoder.encode(listing);
			if (bytes.byteLength <= INLINE_MAX) return { services: listing };
			const path = await writeRef(io, `ble-${safeId(ctx.id)}.out`, bytes);
			return { servicesRef: { path, size: bytes.byteLength, owner: 'caller', expiresWithSession: true } };
		},

		'ble.read': async (params) => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			try {
				return { value: await broker.read(wantStr(params, 'svc', 'ble.read'), wantStr(params, 'chr', 'ble.read')) };
			} catch (e) {
				throw unavailable(e);
			}
		},

		'ble.write': async (params) => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			const hex = wantStr(params, 'hex', 'ble.write');
			if (!/^([0-9a-fA-F]{2})+$/.test(hex) || hex.length > 1024) {
				throw new ServeError(
					rpcError(ERR.INVALID_PARAMS, 'HEX must be whole bytes, at most 512 of them'),
				);
			}
			try {
				await broker.write(wantStr(params, 'svc', 'ble.write'), wantStr(params, 'chr', 'ble.write'), hex);
			} catch (e) {
				throw unavailable(e);
			}
			return {};
		},

		'ble.notify': async (params) => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			try {
				const note = await broker.subscribe(
					wantStr(params, 'svc', 'ble.notify'),
					wantStr(params, 'chr', 'ble.notify'),
					params.off === true,
				);
				return { ...(note ? { note } : {}), feed: { path: broker.feedPath() } };
			} catch (e) {
				throw unavailable(e);
			}
		},

		'ble.disconnect': async () => {
			const broker = wantSurface(desktop.ble, 'Web Bluetooth broker');
			await broker.disconnect();
			return {};
		},

		// ── network.bridge.* (§7.1: network.* is the desktop's). Control
		// only — the WebRTC machinery is net-bridge.ts's, and status reads
		// the live room, so a room the person started with clicks answers
		// here too (what /data/.bridge-status used to carry). ──

		'network.bridge.start': async (params, ctx) => {
			const bridge = wantSurface(desktop.bridge, 'bridge control');
			const name = (typeof params.name === 'string' && params.name ? params.name : 'someone').slice(0, 32);
			const ip = (typeof params.ip === 'string' ? params.ip : '').slice(0, 15);
			try {
				return { ...(await bridge.start(name, ip, ctx.signal)) };
			} catch (e) {
				throw unavailable(e);
			}
		},

		'network.bridge.join': async (params, ctx) => {
			const bridge = wantSurface(desktop.bridge, 'bridge control');
			const code = wantStr(params, 'code', 'network.bridge.join');
			const name = (typeof params.name === 'string' && params.name ? params.name : 'someone').slice(0, 32);
			const ip = (typeof params.ip === 'string' ? params.ip : '').slice(0, 15);
			try {
				return { ...(await bridge.join(code, name, ip, ctx.signal)) };
			} catch (e) {
				throw unavailable(e);
			}
		},

		'network.bridge.stop': async () => {
			wantSurface(desktop.bridge, 'bridge control').stop();
			return {};
		},

		'network.bridge.say': async (params) => {
			const bridge = wantSurface(desktop.bridge, 'bridge control');
			const text = wantStr(params, 'text', 'network.bridge.say');
			const to = typeof params.to === 'string' && params.to ? params.to : undefined;
			if (!bridge.say(text, to)) {
				throw new ServeError(
					rpcError(ERR.UNAVAILABLE, 'no live bridge', 'bridge start or bridge join first'),
				);
			}
			return {};
		},

		'network.bridge.status': async () => {
			const bridge = wantSurface(desktop.bridge, 'bridge control');
			return { ...bridge.status() };
		},

		'debug.js': async (params, ctx) => {
			let code = typeof params.code === 'string' ? params.code : '';
			if (!code && params.codeRef !== undefined) {
				code = decoder.decode(await readRef(io, params.codeRef));
			}
			if (!code.trim()) {
				throw new ServeError(rpcError(ERR.INVALID_PARAMS, 'debug.js: the params carry no code'));
			}
			const ran = await runJs(code, clampMs(params.timeoutMs, 10_000));
			const bytes = encoder.encode(ran.output);
			if (bytes.byteLength <= INLINE_MAX) return { ok: ran.ok, output: ran.output };
			const path = await writeRef(io, `js-${safeId(ctx.id)}.out`, bytes);
			return {
				ok: ran.ok,
				outputRef: { path, size: bytes.byteLength, owner: 'caller', expiresWithSession: true },
			};
		},

		'http.fetch': async (params, ctx) => {
			const req: HostFetchRequest = {
				url: typeof params.url === 'string' ? params.url : undefined,
				method: typeof params.method === 'string' ? params.method : undefined,
				headers:
					params.headers && typeof params.headers === 'object'
						? (params.headers as Record<string, string>)
						: undefined,
				body: typeof params.body === 'string' ? params.body : undefined,
				bodyB64: typeof params.bodyB64 === 'string' ? params.bodyB64 : undefined,
				timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
			};
			if (params.bodyRef !== undefined) req.bodyBytes = await readRef(io, params.bodyRef);

			const got = await hostFetch(req, ctx.signal);
			if (!got.ok) return got;

			const { headers, cut } = trimHeaders(got.headers);
			const meta = {
				ok: true,
				status: got.status,
				statusText: got.statusText,
				url: got.url,
				headers,
				...(cut ? { headersTruncated: true } : {}),
				...(got.truncated ? { truncated: true } : {}),
			};
			const text = tryUtf8(got.bytes);
			if (got.bytes.byteLength <= INLINE_MAX) {
				const inline =
					text !== null ? { ...meta, body: text } : { ...meta, bodyB64: toB64Bytes(got.bytes) };
				if (fits(inline)) return inline;
			}
			const path = await writeRef(io, `fetch-${safeId(ctx.id)}.bin`, got.bytes);
			return {
				...meta,
				bodyRef: {
					path,
					size: got.bytes.byteLength,
					binary: text === null,
					owner: 'caller',
					expiresWithSession: true,
				},
			};
		},
	};
}

// ── base64, chunked so a 2 MB body does not blow the argument list ──

function toB64Bytes(bytes: Uint8Array): string {
	let bin = '';
	const STEP = 0x8000;
	for (let i = 0; i < bytes.length; i += STEP) {
		bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
	}
	return btoa(bin);
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
