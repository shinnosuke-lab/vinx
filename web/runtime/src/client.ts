/**
 * The page's handle on the worker.
 *
 * Turns `postMessage` into promises for calls and callbacks for streams, and
 * nothing more. It does not interpret frames — the fetch shim layered on top of
 * this hands them to the chat UI exactly as the HTTP server would have.
 */

import type {
	FromWorker,
	Init,
	InstallAppResult,
	Method,
	Ready,
	Reply,
	Request,
	VmResult,
	WebAppSource,
} from './protocol';
import { isDownload, isFrame, isInstallApp, isReady, isVmCall, PROTOCOL_VERSION } from './protocol';

export interface ClientOptions {
	/**
	 * Where the worker script lives. Defaults to a sibling of this module, which
	 * is what the published bundle looks like.
	 *
	 * May be cross-origin — see `spawn`, which is where that is dealt with.
	 */
	workerUrl?: string | URL;
	/**
	 * Which stored history to open. One origin now serves the page for every
	 * gateway, so without this they would share one history; see
	 * `storage::db_name`.
	 */
	namespace?: string;
	/**
	 * Answers the engine's device tool calls when the device is the in-page VM.
	 *
	 * The engine POSTs tool calls over the worker's `fetch`; calls aimed at
	 * `VM_ENDPOINT` are bounced here instead of the network (see worker.ts).
	 * `body` is the request body — `{"name": ..., "arguments": ...}` — and the
	 * return value is dressed back up as the HTTP response the engine expects.
	 * Unset, such calls answer 502, which the engine reports as a failed tool.
	 */
	onVmCall?: (body: string) => Promise<{ status: number; body: string }>;
	/**
	 * Hands a workspace file to the person as a browser download — the second
	 * half of the engine's `download_file` while the workspace (not a machine)
	 * is the model's filesystem. The worker has the bytes; only page code can
	 * click an `<a download>`. Unset, the download is dropped on the floor and
	 * the tool's success is a lie — pages with a DOM should always set it.
	 */
	onDownload?: (filename: string, bytes: Uint8Array) => void;
	/**
	 * Puts a pure web app the model wrote on this page's Apps page — the second
	 * half of the engine's `install_app`, the workspace's third door beside
	 * download_file and open_file. Resolves with the line the model reads
	 * ("Installed … on the Apps page"); rejects with the refusal, which the
	 * engine hands the model verbatim, so make it the machine's own finding
	 * codes. Unset, the tool reports that this page cannot install apps.
	 */
	onInstallApp?: (app: WebAppSource) => Promise<string>;
}

/** Per-turn overrides, mirroring the fields `POST /api/chat` carries. */
export interface SendOptions {
	/**
	 * Run this turn on a different model. The endpoint and key are the
	 * configured ones; only the model changes, and only for this turn.
	 */
	model?: string;
	/** Files uploaded before this message, by the id `upload` gave back. */
	attachments?: { id: string; name?: string; lines?: number | null }[];
	/**
	 * Turn a skill on or off by name, from the `/` palette. Deterministic,
	 * where asking the model to read a skill is a request it may decline.
	 */
	skillAction?: { op: 'activate'; name: string } | { op: 'reset' };
	/**
	 * Park the message behind a turn already running instead of being refused;
	 * it starts on its own when that turn ends. The composer's "send when it
	 * finishes", next to "send now", which is `steer`.
	 */
	queue?: boolean;
	/**
	 * With a turn in flight: wind it down (the queue survives, unlike
	 * `cancel`) and park this message at the queue FRONT, so it starts the
	 * moment the turn ends — the main chat's "send now". Idle sessions treat
	 * it as a plain send. Wins over `queue`.
	 */
	interrupt?: boolean;
	/**
	 * Which surface this message came from — unset means the main chat
	 * (`web`); the console's assistant panel says `terminal`. Recorded on the
	 * session's first save, so the sessions page can say where it started.
	 */
	origin?: string;
	/**
	 * Per-turn reasoning-effort override, from the composer's effort switcher.
	 * Unset keeps the configured default (which itself defaults to the
	 * provider profile's).
	 */
	reasoningEffort?: string;
}

/** A stored upload, as `POST /api/chat/upload` reports it. */
export interface Upload {
	id: string;
	name: string;
	mime: string;
	/** `image` enters model context on vision models; `file` is read on
	 *  demand, through the file tools. */
	kind: 'image' | 'file';
	size: number;
	lines: number | null;
}

/**
 * Either what was done or the reason it was refused, with the status the
 * refusal should be reported as.
 *
 * The rules that reject a file — or a skill package — are the same ones that
 * classify it, so both answers come from the engine rather than being split
 * across the two languages. On success the payload is the response body: the
 * shim passes it to the UI as it stands.
 */
export type Outcome<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

/** What the worker reported once it finished loading. */
export interface HostStatus {
	protocol: number;
	/** Sessions will not survive a reload. Worth telling the user. */
	ephemeral: boolean;
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
};

/**
 * Start the worker, from wherever its script happens to live.
 *
 * A worker script URL must be same-origin with the document whatever CORS
 * headers the other host sends: workers are clients, and a cross-origin client
 * would mean picking a cross-origin service worker for it, so the platform
 * refuses (whatwg/html#3109). Here the document is served by the gateway and the
 * code by the asset host, so cross-origin is the normal case rather than an
 * exotic one.
 *
 * The way through is a same-origin script that pulls the real one in.
 * `importScripts` fetches in no-cors mode, which is also why this half needs
 * nothing from the asset host — unlike the module scripts and the wasm, which
 * are CORS requests. It has to be a classic worker, since `importScripts` does
 * not exist in a module one; the built bundle is an IIFE with no imports, so
 * there is nothing to lose. A same-origin URL is left alone, which is what keeps
 * `vite dev` on its module worker.
 */
function spawn(url: string | URL): { worker: Worker; objectUrl?: string } {
	const here = globalThis.location?.origin;
	const absolute = here ? new URL(url, globalThis.location.href) : null;
	if (!absolute || absolute.origin === here) {
		return { worker: new Worker(url, { type: 'module' }) };
	}

	const boot = `importScripts(${JSON.stringify(absolute.href)})`;
	const objectUrl = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
	return { worker: new Worker(objectUrl), objectUrl };
}

export class AgentClient {
	private worker: Worker;
	/** The bootstrap's URL, when there is one. Revoked on close, not sooner:
	 * the script is fetched in parallel with construction. */
	private objectUrl?: string;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private streams = new Map<string, (frame: string) => void>();
	private ready: Promise<HostStatus>;
	private onVmCall?: ClientOptions['onVmCall'];
	private onDownload?: ClientOptions['onDownload'];
	private onInstallApp?: ClientOptions['onInstallApp'];

	constructor(options: ClientOptions = {}) {
		const url = options.workerUrl ?? new URL('./worker.js', import.meta.url);
		this.onVmCall = options.onVmCall;
		this.onDownload = options.onDownload;
		this.onInstallApp = options.onInstallApp;
		const started = spawn(url);
		this.worker = started.worker;
		this.objectUrl = started.objectUrl;

		let settle!: (status: HostStatus) => void;
		let fail!: (e: Error) => void;
		this.ready = new Promise((res, rej) => {
			settle = res;
			fail = rej;
		});

		this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
			const message = e.data;

			if (isReady(message)) {
				this.onReady(message, settle, fail);
				return;
			}
			if (isFrame(message)) {
				// A frame for a stream that has already detached is normal: the
				// engine may have been mid-publish when the view unmounted.
				this.streams.get(message.stream)?.(message.frame);
				return;
			}
			if (isVmCall(message)) {
				this.answerVmCall(message.vmId, message.body);
				return;
			}
			if (isDownload(message)) {
				// One way: the engine already told the model the file went out.
				this.onDownload?.(message.filename, message.bytes);
				return;
			}
			if (isInstallApp(message)) {
				this.answerInstallApp(message.installId, message.app);
				return;
			}
			this.settleCall(message);
		};

		this.worker.onerror = (e) => {
			const error = new Error(`worker failed: ${e.message}`);
			fail(error);
			// Nothing will ever answer these now.
			for (const p of this.pending.values()) p.reject(error);
			this.pending.clear();
		};

		// The worker does nothing until it has this, and `postMessage` delivers
		// in order, so every later request is answered by a host opened against
		// the right database.
		this.worker.postMessage({ init: true, namespace: options.namespace } satisfies Init);
	}

	private onReady(message: Ready, settle: (s: HostStatus) => void, fail: (e: Error) => void) {
		if (message.error) {
			fail(new Error(message.error));
			return;
		}
		if (message.protocol !== PROTOCOL_VERSION) {
			// Frames would be misread rather than obviously broken, so refuse
			// instead of limping along.
			fail(
				new Error(
					`worker speaks protocol v${message.protocol}, this client speaks v${PROTOCOL_VERSION}`,
				),
			);
			return;
		}
		settle({ protocol: message.protocol, ephemeral: message.ephemeral ?? false });
	}

	private settleCall(message: Reply) {
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) pending.reject(new Error(message.error));
		else pending.resolve(message.result);
	}

	/** A device tool call for the in-page VM; see `ClientOptions.onVmCall`. */
	private async answerVmCall(vmId: number, body: string) {
		let status = 502;
		let reply = JSON.stringify({ ok: false, error: 'no VM is attached to this page' });
		const handler = this.onVmCall;
		if (handler) {
			try {
				({ status, body: reply } = await handler(body));
			} catch (e) {
				status = 500;
				reply = JSON.stringify({
					ok: false,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		this.worker.postMessage({ vmResult: true, vmId, status, body: reply } satisfies VmResult);
	}

	/** The model's `install_app` reaching the page; see `ClientOptions.onInstallApp`. */
	private async answerInstallApp(installId: number, app: WebAppSource) {
		let ok = false;
		let text = 'this page cannot install apps';
		const handler = this.onInstallApp;
		if (handler) {
			try {
				text = await handler(app);
				ok = true;
			} catch (e) {
				text = e instanceof Error ? e.message : String(e);
			}
		}
		this.worker.postMessage({
			installAppResult: true,
			installId,
			ok,
			text,
		} satisfies InstallAppResult);
	}

	/** Resolves once the engine has loaded, or rejects if it cannot. */
	whenReady(): Promise<HostStatus> {
		return this.ready;
	}

	private async call<T>(method: Method, params?: unknown): Promise<T> {
		await this.ready;
		const id = this.nextId++;
		const request: Request = { id, method, params };
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.worker.postMessage(request);
		});
	}

	/**
	 * Configured default reasoning-effort levels (settings page): `effort`
	 * for the main turn, `subagentEffort` for `task` children. Empty strings
	 * mean "provider default"/"inherit". Applied to turns started afterwards.
	 */
	setReasoningEffort(effort: string, subagentEffort: string): Promise<void> {
		return this.call('setReasoningEffort', { effort, subagentEffort });
	}

	configure(baseUrl: string, apiKey: string, model: string): Promise<void> {
		return this.call('configure', { baseUrl, apiKey, model });
	}

	/**
	 * Give the engine the device's tools.
	 *
	 * `payload` is the device's `/api/tools` body; `endpoint` is where calls go.
	 * Resolves with the names registered — worth comparing against what the
	 * device offered, since a rejected tool is otherwise just a tool the model
	 * never calls.
	 */
	installTools(payload: unknown, endpoint: string): Promise<string[]> {
		return this.call('installTools', { payload: JSON.stringify(payload), endpoint });
	}

	/**
	 * Take device tools back by name — the inverse of `installTools`, for a
	 * device that comes and goes (the in-page machine a person may leave
	 * powered off). The turn in flight keeps what it already holds; the next
	 * one is briefed without the device. Resolves with the names removed.
	 */
	uninstallTools(names: string[]): Promise<string[]> {
		return this.call('uninstallTools', { names });
	}

	/**
	 * Watch a session. `onFrame` receives raw SSE records, starting with
	 * `session` and `history`.
	 *
	 * `follow` makes it session-scoped rather than turn-scoped: the stream does
	 * not end with the turn it attached to, and every later turn opens with a
	 * fresh `session` + `history` snapshot. That is how a queued message
	 * starting by itself becomes visible, and it is what the chat UI uses.
	 *
	 * Returns a function that stops the stream. Call it when the view goes away,
	 * or the worker keeps publishing to a listener nobody reads.
	 */
	attach(session: string, onFrame: (frame: string) => void, follow = false): () => void {
		const stream = `s${this.nextId++}`;
		this.streams.set(stream, onFrame);
		void this.call('attach', { stream, session, follow });
		return () => {
			this.streams.delete(stream);
			void this.call('detach', { stream });
		};
	}

	/**
	 * Start a turn. Resolves when it is accepted, not when it finishes.
	 *
	 * A refusal is not an exception: `turn_in_flight` means the caller should
	 * attach and watch the turn already running, and `not_configured` has
	 * already been reported on the stream.
	 */
	send(
		session: string,
		text: string,
		options: SendOptions = {},
	): Promise<{
		accepted: boolean;
		reason?: string;
		running?: boolean;
		auto_confirm?: boolean;
		/** The message was parked; it starts when the running turn ends. */
		queued?: boolean;
		/** Its 1-based place in the queue, when it was parked. */
		position?: number;
		/** An `interrupt` send that found a turn to wind down: the message is
		 *  parked at the queue front and starts the moment that turn ends. */
		interrupted?: boolean;
	}> {
		// snake_case on the wire: the engine deserialises these with the same
		// field names `POST /api/chat` uses.
		const { skillAction, reasoningEffort, ...rest } = options;
		return this.call('send', {
			session,
			text,
			options: { ...rest, skill_action: skillAction, reasoning_effort: reasoningEffort },
		});
	}

	/**
	 * Inject a message into the turn already running — the composer's "send
	 * now". The loop appends it at its next round boundary, so the model sees it
	 * on its next request instead of after the turn.
	 *
	 * Resolves false when there was no turn to steer, which the caller answers
	 * by sending the message normally.
	 */
	steer(session: string, message: string): Promise<boolean> {
		return this.call('steer', { session, message });
	}

	/**
	 * Discard the conversation from its `userIndex`-th user message onwards —
	 * "edit & resend". Resolves the recomputed active skill, or refuses with
	 * `turn_in_flight` while a turn is running.
	 */
	rewind(
		session: string,
		userIndex: number,
	): Promise<
		| { ok: true; message_count: number; active_skill: string | null }
		| { ok: false; error: string; message?: string }
	> {
		return this.call('rewind', { session, userIndex });
	}

	/**
	 * The whole `/api/models` body: the models the configured endpoint
	 * advertises plus per-model capability records (`caps` — effort levels,
	 * thinking mode; always includes the configured default model).
	 *
	 * `models` is empty when the endpoint does not implement the listing,
	 * which is common enough that it is not worth reporting — the UI shows a
	 * read-only model badge instead of a picker.
	 */
	models(): Promise<{ ok: true; models: string[]; caps: Record<string, unknown> }> {
		return this.call('models');
	}

	cancel(session: string): Promise<void> {
		return this.call('cancel', { session });
	}

	/**
	 * Cancel ONE running sub-agent by the `task_id` the `subagent` frames
	 * carry. Resolves `false` when no such task is live (already finished, or
	 * the id is unknown) — the HTTP shim turns that into a 404.
	 */
	cancelTask(session: string, taskId: string): Promise<boolean> {
		return this.call('cancelTask', { session, taskId });
	}

	/**
	 * How many turns are running, across every session.
	 *
	 * For the page's leave guard: this engine lives in the tab, so a turn dies
	 * with it, and something has to know that before the tab goes. Cheap enough
	 * to poll — see `AgentHost::turns`.
	 */
	turns(): Promise<number> {
		return this.call('turns');
	}

	/**
	 * Answer a `confirm` frame.
	 *
	 * `callId` is the tool call the frame was about, and it decides who the
	 * answer belongs to: a sub-agent's confirmation reaches the UI unwrapped, so
	 * the reply is otherwise indistinguishable from one meant for the parent.
	 *
	 * `amendedArgs` is the call as edited in the confirm bar, serialised —
	 * omitted, the tool runs with what the model asked for.
	 */
	confirm(
		session: string,
		approved: boolean,
		approveAll = false,
		amendedArgs?: string,
		callId?: string,
	): Promise<void> {
		return this.call('confirm', { session, callId, approved, approveAll, amendedArgs });
	}

	/**
	 * Turn full-auto on or off for a session: no tool confirmations until it is
	 * turned back off. Shared with a running turn, so it lands on the next tool
	 * call rather than the next turn.
	 */
	setAuto(session: string, enabled: boolean): Promise<void> {
		return this.call('setAuto', { session, enabled });
	}

	/** Answer an `ask_user` frame. An empty array reads as backing out. */
	answer(session: string, answers: unknown[]): Promise<void> {
		return this.call('answer', { session, answers });
	}

	/**
	 * The user is interacting with the pending `ask_user` without answering
	 * yet. With a timeout armed, the engine pushes the auto-pick deadline back
	 * to the full window. Fire-and-forget; harmless when nothing is pending.
	 */
	askActivity(session: string): Promise<void> {
		return this.call('askActivity', { session });
	}

	/**
	 * Drop one parked message, by the id the `queue` frame carries. Resolves
	 * false when it is already gone (started, or removed by another tab).
	 */
	queueRemove(session: string, id: number): Promise<boolean> {
		return this.call('queueRemove', { session, id });
	}

	/**
	 * Replace one parked message's text; attachments and the model override
	 * ride along unchanged. Resolves false when the id names nothing.
	 */
	queueEdit(session: string, id: number, message: string): Promise<boolean> {
		return this.call('queueEdit', { session, id, message });
	}

	/**
	 * "Send now" for a parked message: move it to the queue front and wind
	 * the running turn down (queue kept) so it starts next. Resolves `false`
	 * when the id names nothing — already started, or removed by another tab.
	 */
	queuePromote(session: string, id: number): Promise<boolean> {
		return this.call('queuePromote', { session, id });
	}

	/**
	 * Put a file the user attached into the workspace.
	 *
	 * `mime` is what the browser said the blob was; it decides whether this is
	 * an image, and images are the only uploads a model can look at directly.
	 */
	upload(name: string, mime: string, bytes: Uint8Array): Promise<Outcome<Upload>> {
		return this.call('upload', { name, mime, bytes });
	}

	/**
	 * Read an upload back, for the transcript's thumbnails and download links.
	 * Resolves null when the id is unknown — an old session can outlive a
	 * cleared workspace.
	 */
	readUpload(id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
		return this.call('readUpload', { id });
	}

	/**
	 * The bytes behind a workspace path the model offered with `open_file` —
	 * the page half of that tool: its chat card reads the file back through
	 * here when the person clicks Open, so the tab shows the file as it is
	 * now, and a card in an old session still works. A bare filename names a
	 * draft, exactly as it did for the model. Resolves null when nothing is
	 * there any more (or it is a directory, or over the hand-over cap).
	 */
	readWorkspaceFile(path: string): Promise<Uint8Array | null> {
		return this.call('readWorkspaceFile', { path });
	}

	/** What is installed, and what the last scan could not make sense of. */
	skills(): Promise<{ skills: unknown[]; diagnostics: unknown[] }> {
		return this.call('skills');
	}

	/** A skill's `SKILL.md` body, or its changelog. Null when it has none. */
	skillText(name: string, which: 'readme' | 'changelog'): Promise<string | null> {
		return this.call('skillText', { name, which });
	}

	skillIcon(name: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
		return this.call('skillIcon', { name });
	}

	/**
	 * Toggle one of a skill's switches. `enabled` governs whether the model is
	 * told about it, `shared` whether it is offered to other agents, `pinned`
	 * only where it sits in the list.
	 */
	setSkillFlag(name: string, flag: 'enabled' | 'pinned' | 'shared', value: boolean): Promise<void> {
		return this.call('setSkillFlag', { name, flag, value });
	}

	/** Install a skill package, replacing an installed skill of the same name. */
	importSkill(bytes: Uint8Array): Promise<Outcome<{ name: string; diagnostics: string[] }>> {
		return this.call('importSkill', { bytes });
	}

	/** What a package documents, without installing it. */
	previewSkill(
		bytes: Uint8Array,
	): Promise<Outcome<{ readme: string; changelog: string | null }>> {
		return this.call('previewSkill', { bytes });
	}

	deleteSkill(name: string): Promise<Outcome<Record<string, never>>> {
		return this.call('deleteSkill', { name });
	}

	/**
	 * The look to wear, as a list of nought or one. Only the active theme is
	 * served: the UI injects whatever comes back into a single `<style>` tag,
	 * so a second entry would simply erase the first.
	 */
	themes(): Promise<{ themes: { name: string; css: string; js: string }[] }> {
		return this.call('themes');
	}

	/** The saved looks, as the themes page's cards. */
	savedThemes(): Promise<{ releases: unknown[] }> {
		return this.call('savedThemes');
	}

	/** Keep the look already on screen; no model round-trip. */
	saveTheme(
		name: string,
		css: string,
		js: string,
		session?: string | null,
	): Promise<Outcome<Record<string, never>>> {
		return this.call('saveTheme', { name, css, js, session });
	}

	/** Switch the injected look; no name restores the built-in one. */
	activateTheme(name?: string): Promise<Outcome<Record<string, never>>> {
		return this.call('activateTheme', { name });
	}

	deleteTheme(name: string): Promise<Outcome<Record<string, never>>> {
		return this.call('deleteTheme', { name });
	}

	/**
	 * Stop asking about writes inside a directory — the confirm bar's "allow
	 * this folder". Resolves false when the directory is not in the workspace.
	 */
	allowDir(dir: string): Promise<boolean> {
		return this.call('allowDir', { dir });
	}

	/** The directories writes no longer need confirming in. */
	allowedDirs(): Promise<string[]> {
		return this.call('allowedDirs');
	}

	/** Ask about a directory again, or about all of them when given none. */
	forgetDirs(dir?: string): Promise<void> {
		return this.call('forgetDirs', { dir });
	}

	/** How much of the workspace each runtime category is using. */
	runtimeStat<T = unknown>(category?: string): Promise<T> {
		return this.call('runtimeStat', { category });
	}

	/** Empty those categories, or all of them when given none. */
	runtimeClear(categories: string[] = []): Promise<Outcome<{ reclaimed_bytes: number; cleared: string[] }>> {
		return this.call('runtimeClear', { categories });
	}

	/**
	 * The session list; `scope` is `active` (default) | `archived` | `all`.
	 * Rejects (invalid_scope) for anything else.
	 */
	sessions<T = unknown[]>(scope?: string): Promise<T> {
		return this.call('sessions', { scope });
	}

	session<T = unknown>(session: string): Promise<T> {
		return this.call('session', { session });
	}

	/** A session's archived pre-compaction generations: `{ generations }`. */
	sessionArchive<T = unknown>(session: string): Promise<T> {
		return this.call('sessionArchive', { session });
	}

	/** One archived generation's messages, or `null` when it does not exist. */
	sessionArchiveGet<T = unknown>(session: string, generation: number): Promise<T | null> {
		return this.call('sessionArchiveGet', { session, generation });
	}

	search<T = unknown[]>(query: string, limit = 20, exclude?: string): Promise<T> {
		return this.call('search', { query, limit, exclude });
	}

	/**
	 * `PATCH /api/sessions/{id}`: every field optional, absent = unchanged.
	 * `category` is tri-state — `undefined` unchanged, `null` clear, else the
	 * label (at most 64 characters; the host rejects longer as a no-op).
	 */
	updateSession(
		session: string,
		patch: { title?: string; pinned?: boolean; archived?: boolean; category?: string | null } = {},
	): Promise<void> {
		return this.call('updateSession', { session, ...patch });
	}

	deleteSession(session: string): Promise<void> {
		return this.call('deleteSession', { session });
	}

	/** Tear down the worker. The client is unusable afterwards. */
	close() {
		this.worker.terminate();
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		for (const p of this.pending.values()) {
			p.reject(new Error('the client was closed'));
		}
		this.pending.clear();
		this.streams.clear();
	}
}
