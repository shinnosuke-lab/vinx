/**
 * The Dedicated Worker that hosts the engine.
 *
 * Everything expensive happens here — the wasm module, the agent loop, SQLite —
 * so a long turn or a big session query never janks the page. The worker itself
 * is deliberately thin: it loads the module, forwards calls, and forwards
 * frames back. All the judgement lives in Rust.
 *
 * Note this dies with the document. A reload does not resume a turn, it ends
 * one; see the note in `host.rs`.
 */

import init, { AgentHost, openHost } from '../pkg/agent_web_core.js';
import type {
	Download,
	Frame,
	InstallApp,
	Ready,
	Reply,
	Request,
	ToWorker,
	VmCall,
	WebAppSource,
} from './protocol';
import { isInit, isInstallAppResult, isVmResult, PROTOCOL_VERSION } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let host: AgentHost | null = null;
/**
 * Set by the first `init`. Nothing happens until then — the page picks the
 * database, and `AgentClient` sends it before any request.
 */
let booted: Promise<void> | null = null;

function post(message: Reply | Frame | Ready | VmCall | Download | InstallApp) {
	// A download carries its bytes: hand the buffer over instead of copying it.
	// So do an app's parts — the engine copied them out of wasm memory already.
	if ('download' in message) self.postMessage(message, [message.bytes.buffer]);
	else if ('installApp' in message) {
		const { html, css, js } = message.app;
		const buffers = [html, css, js].filter((p): p is Uint8Array => !!p).map((p) => p.buffer);
		self.postMessage(message, buffers);
	} else self.postMessage(message);
}

/**
 * Where the in-page VM's tools are "hosted".
 *
 * The engine's tool layer speaks HTTP: `installTools` takes an endpoint and
 * every call is a POST to it, through this worker's `fetch`. The VM those
 * calls are for is not on any network — it is v86, on the main thread — so
 * this name is a routing tag, not an address. Requests to it are bounced over
 * `postMessage` and the reply is dressed back up as a `Response`. Everything
 * else `fetch`es normally; the LLM traffic never comes through here changed.
 *
 * Kept in lockstep with `VM_ENDPOINT` in device-vm.ts — the worker bundle is
 * its own entry, so the constant cannot be imported across.
 */
const VM_HOST = 'http://vm.internal/';

const vmPending = new Map<number, (r: { status: number; body: string }) => void>();
let vmNextId = 1;

const realFetch = self.fetch.bind(self);
self.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	// DOM Request, not the RPC `Request` this module imports from ./protocol —
	// that name is shadowed here, so reach the global constructor by name.
	const isRequest = input instanceof globalThis.Request;
	const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
	if (!url.startsWith(VM_HOST)) return realFetch(input as RequestInfo, init);

	// reqwest's wasm backend builds a DOM Request with the body on it; a
	// hand-written fetch puts the body in init. Cover both.
	let body = '';
	const raw = init?.body;
	if (typeof raw === 'string') body = raw;
	else if (raw instanceof Uint8Array) body = new TextDecoder().decode(raw);
	else if (raw instanceof ArrayBuffer) body = new TextDecoder().decode(new Uint8Array(raw));
	else if (isRequest) body = await (input as { clone(): { text(): Promise<string> } }).clone().text();

	const vmId = vmNextId++;
	const answer = new Promise<{ status: number; body: string }>((resolve) => {
		vmPending.set(vmId, resolve);
	});
	post({ vmCall: true, vmId, body });
	const { status, body: reply } = await answer;
	const response = new Response(reply, {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
	// A hand-built Response has an empty `.url`, and reqwest's wasm client
	// parses that field into a `Url` and panics ("url parse") on the empty
	// string. Shadow the read-only getter with the endpoint it was fetching,
	// which is what a real fetch would have set.
	Object.defineProperty(response, 'url', { value: url, configurable: true });
	return response;
}) as typeof fetch;

/** Every frame the engine produces, tagged with the stream that asked for it. */
function sink(stream: string, frame: string) {
	post({ stream, frame });
}

/**
 * The page's half of the workspace `download_file`: the engine has the bytes,
 * only the main thread can click an `<a download>`. Installed on every host
 * shape — persistent or in-memory, a draft is a draft.
 */
function downloader(filename: string, bytes: Uint8Array) {
	post({ download: true, filename, bytes });
}

/**
 * The page's half of the workspace `install_app`: the engine has the parts,
 * the main thread has the machine's mirror and the Apps page. Unlike a
 * download this one waits for the answer — the model must hear whether the
 * app is on the page, and in the machine's own words when it is not. Same
 * request/reply shape as the VM bounce above.
 */
const installPending = new Map<number, (r: { ok: boolean; text: string }) => void>();
let installNextId = 1;

function installer(app: WebAppSource): Promise<string> {
	const installId = installNextId++;
	const answer = new Promise<{ ok: boolean; text: string }>((resolve) => {
		installPending.set(installId, resolve);
	});
	post({ installApp: true, installId, app });
	return answer.then(({ ok, text }) => {
		if (ok) return text;
		throw new Error(text);
	});
}

async function boot(namespace?: string) {
	try {
		await init();
	} catch (e) {
		post({ ready: true, protocol: PROTOCOL_VERSION, error: `could not load wasm: ${e}` });
		return;
	}

	// Persistent storage first; fall back to in-memory rather than refusing to
	// start. A private window or a denied storage quota should cost history, not
	// the whole application.
	try {
		host = await openHost(sink, namespace);
		host.setDownloader(downloader);
		host.setAppInstaller(installer);
		post({ ready: true, protocol: PROTOCOL_VERSION });
	} catch (e) {
		try {
			host = new AgentHost(sink);
			host.setDownloader(downloader);
			host.setAppInstaller(installer);
			post({ ready: true, protocol: PROTOCOL_VERSION, ephemeral: true });
		} catch (fatal) {
			post({
				ready: true,
				protocol: PROTOCOL_VERSION,
				error: `no session storage available: ${e}; in-memory also failed: ${fatal}`,
			});
		}
	}
}

/**
 * Params are positional per method rather than a named object, because the
 * generated wasm bindings are positional and a translation layer between the
 * two would be one more place for them to disagree.
 *
 * A case may return a promise; see the caller. Most do not, and it matters that
 * they do not — `send` reserves its turn before returning.
 */
function dispatch(h: AgentHost, method: Request['method'], p: any): unknown {
	switch (method) {
		case 'configure':
			return h.configure(p.baseUrl, p.apiKey, p.model);
		case 'installTools':
			return h.installTools(p.payload, p.endpoint);
		case 'uninstallTools':
			return h.uninstallTools(p.names);
		case 'attach':
			return h.attach(p.stream, p.session, p.follow === true);
		case 'detach':
			return h.detach(p.stream);
		case 'send':
			// Synchronous by design: the ack says only whether the turn was
			// accepted, and the turn itself is registered before this returns so
			// the attach that follows cannot miss it. Output arrives as frames.
			return JSON.parse(h.send(p.session, p.text, JSON.stringify(p.options ?? {})));
		case 'steer':
			return h.steer(p.session, p.message ?? '');
		case 'rewind':
			return JSON.parse(h.rewind(p.session, p.userIndex ?? 0));
		case 'models':
			// The whole /api/models body: the list plus per-model capability
			// records (effort levels, thinking mode) for the effort switcher.
			return h.modelsPayload().then((raw) => JSON.parse(raw));
		case 'cancel':
			return h.cancel(p.session);
		case 'confirm':
			return h.confirm(p.session, p.callId, p.approved, p.approveAll ?? false, p.amendedArgs);
		case 'setAuto':
			return h.setAuto(p.session, p.enabled === true);
		case 'answer':
			return h.answer(p.session, JSON.stringify(p.answers ?? []));
		case 'askActivity':
			return h.askActivity(p.session);
		case 'queueRemove':
			return h.queueRemove(p.session, Number(p.id) || 0);
		case 'queueEdit':
			return h.queueEdit(p.session, Number(p.id) || 0, p.message ?? '');
		case 'queuePromote':
			return h.queuePromote(p.session, Number(p.id) || 0);
		case 'cancelTask':
			return h.cancelTask(p.session, p.taskId ?? '');
		case 'sessionArchive':
			return JSON.parse(h.listSessionArchive(p.session));
		case 'sessionArchiveGet':
			return JSON.parse(h.getSessionArchive(p.session, BigInt(p.generation ?? 0)));
		case 'setReasoningEffort':
			return h.setReasoningEffort(p.effort ?? '', p.subagentEffort ?? '');
		case 'upload':
			return JSON.parse(h.upload(p.name ?? '', p.mime ?? '', p.bytes));
		case 'readUpload': {
			// Two calls, one round trip: the id's extension decides the type,
			// and that table belongs next to the one that produced the id.
			const bytes = h.readUpload(p.id);
			return bytes ? { bytes, mime: h.uploadMime(p.id) } : null;
		}
		case 'readWorkspaceFile':
			return h.readWorkspaceFile(p.path) ?? null;
		case 'skills':
			return JSON.parse(h.skills());
		case 'skillText':
			return h.skillText(p.name, p.which) ?? null;
		case 'skillIcon': {
			const bytes = h.skillIcon(p.name);
			return bytes ? { bytes, mime: h.skillIconMime(p.name) } : null;
		}
		case 'setSkillFlag':
			return h.setSkillFlag(p.name, p.flag, p.value === true);
		case 'importSkill':
			return JSON.parse(h.importSkill(p.bytes));
		case 'previewSkill':
			return JSON.parse(h.previewSkill(p.bytes));
		case 'deleteSkill':
			return JSON.parse(h.deleteSkill(p.name));
		case 'themes':
			return JSON.parse(h.themes());
		case 'savedThemes':
			return JSON.parse(h.savedThemes());
		case 'saveTheme':
			return JSON.parse(h.saveTheme(p.name, p.css ?? '', p.js ?? '', p.session ?? undefined));
		case 'activateTheme':
			return JSON.parse(h.activateTheme(p.name ?? undefined));
		case 'deleteTheme':
			return JSON.parse(h.deleteTheme(p.name));
		case 'allowDir':
			return h.allowDir(p.dir ?? '');
		case 'allowedDirs':
			return JSON.parse(h.allowedDirs());
		case 'forgetDirs':
			return h.forgetDirs(p.dir);
		case 'runtimeStat':
			return JSON.parse(h.runtimeStat(p.category ?? undefined));
		case 'runtimeClear':
			return JSON.parse(h.runtimeClear(JSON.stringify(p.categories ?? [])));
		case 'turns':
			return h.turns();
		case 'sessions':
			return JSON.parse(h.sessions(p.scope));
		case 'session':
			return JSON.parse(h.session(p.session));
		case 'search':
			return JSON.parse(h.search(p.query ?? '', p.limit ?? 20, p.exclude));
		case 'updateSession':
			// `category: null` (clear) travels as '' — wasm-bindgen's Option<String>
			// has no third state.
			return h.updateSession(
				p.session,
				p.title,
				p.pinned,
				p.archived,
				p.category === null ? '' : p.category,
			);
		case 'deleteSession':
			return h.deleteSession(p.session);
		default: {
			// Exhaustiveness: adding a Method without a case is a compile error.
			const never: never = method;
			throw new Error(`unknown method: ${never}`);
		}
	}
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
	if (isInit(e.data)) {
		// Booting on the first message rather than on load is what lets the page
		// choose the database. A second init is ignored: the store is open and
		// reopening it under another name would strand every session already in
		// flight.
		if (!booted) booted = boot(e.data.namespace);
		return;
	}
	if (isVmResult(e.data)) {
		const settle = vmPending.get(e.data.vmId);
		if (settle) {
			vmPending.delete(e.data.vmId);
			settle({ status: e.data.status, body: e.data.body });
		}
		return;
	}
	if (isInstallAppResult(e.data)) {
		const settle = installPending.get(e.data.installId);
		if (settle) {
			installPending.delete(e.data.installId);
			settle({ ok: e.data.ok, text: e.data.text });
		}
		return;
	}

	const { id, method, params } = e.data;
	if (!host) {
		post({ id, error: 'the worker is still starting' });
		return;
	}
	// A panic in the engine arrives here as a thrown JsValue, or as a rejection
	// for the methods that are async. Reporting it on the reply keeps the page
	// usable; the worker itself is still fine, because a wasm panic aborts the
	// call rather than the module.
	const failed = (err: unknown) =>
		post({ id, error: err instanceof Error ? err.message : String(err) });

	try {
		const result = dispatch(host, method, params ?? {});
		if (result instanceof Promise) result.then((value) => post({ id, result: value }), failed);
		else post({ id, result });
	} catch (err) {
		failed(err);
	}
};
