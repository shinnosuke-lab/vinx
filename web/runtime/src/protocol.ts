/**
 * The contract between the page and the worker.
 *
 * Two layers ride the same `postMessage` channel and it helps to keep them
 * apart:
 *
 *  - **RPC**, defined here, is transport. Requests carry an id, replies quote
 *    it. Purely an artefact of talking to a worker.
 *  - **Frames** are agent-core's SSE vocabulary, passed through untouched. The
 *    worker does not parse them and neither does the client; they exist so the
 *    stock chat UI can consume this the same way it consumes the HTTP server.
 *
 * Keeping frames opaque here is deliberate: every event agent-core adds works
 * without a change on this side.
 */

/** Bumped only by a breaking change; mirrors `sse::PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 2;

/** Methods the worker answers. Named after the HTTP routes they stand in for. */
export type Method =
	| 'configure'
	| 'installTools'
	| 'uninstallTools'
	| 'attach'
	| 'detach'
	| 'send'
	| 'steer'
	| 'rewind'
	| 'models'
	| 'cancel'
	| 'confirm'
	| 'setAuto'
	| 'answer'
	| 'askActivity'
	| 'queueRemove'
	| 'queueEdit'
	| 'queuePromote'
	| 'cancelTask'
	| 'sessionArchive'
	| 'sessionArchiveGet'
	| 'setReasoningEffort'
	| 'upload'
	| 'readUpload'
	| 'readWorkspaceFile'
	| 'skills'
	| 'skillText'
	| 'skillIcon'
	| 'setSkillFlag'
	| 'importSkill'
	| 'previewSkill'
	| 'deleteSkill'
	| 'themes'
	| 'savedThemes'
	| 'saveTheme'
	| 'activateTheme'
	| 'deleteTheme'
	| 'allowDir'
	| 'allowedDirs'
	| 'forgetDirs'
	| 'runtimeStat'
	| 'runtimeClear'
	| 'turns'
	| 'sessions'
	| 'session'
	| 'search'
	| 'updateSession'
	| 'deleteSession';

export interface Request {
	id: number;
	method: Method;
	params?: unknown;
}

/**
 * The first message the page sends, before any request.
 *
 * Separate from the RPC methods because it decides how the worker comes up
 * rather than asking it to do something: the store has to be opened against the
 * right database before there is a host to call methods on. `postMessage`
 * delivers in order, so this is always seen first.
 */
export interface Init {
	init: true;
	/** Keeps one gateway's sessions out of another's; see `storage::db_name`. */
	namespace?: string;
}

/**
 * The main thread answering a `VmCall`.
 *
 * `status`/`body` mirror an HTTP response because the engine's tool layer
 * thinks it is speaking HTTP; see `VM_ENDPOINT` in worker.ts.
 */
export interface VmResult {
	vmResult: true;
	vmId: number;
	status: number;
	body: string;
}

/**
 * The main thread answering an `InstallApp`.
 *
 * `ok` with the line the model reads, or a refusal in the machine's own
 * finding codes — the tool result on the engine's side is whichever came back.
 */
export interface InstallAppResult {
	installAppResult: true;
	installId: number;
	ok: boolean;
	text: string;
}

export type ToWorker = Init | Request | VmResult | InstallAppResult;

export function isInit(m: ToWorker): m is Init {
	return 'init' in m;
}

export function isVmResult(m: ToWorker): m is VmResult {
	return 'vmResult' in m;
}

export function isInstallAppResult(m: ToWorker): m is InstallAppResult {
	return 'installAppResult' in m;
}

/** A method returned normally. `result` is already-decoded JSON. */
export interface Reply {
	id: number;
	result?: unknown;
	error?: string;
}

/**
 * One SSE frame for an attached stream.
 *
 * Unsolicited: it carries the stream id from `attach`, not a request id, since
 * frames arrive long after the call that started them.
 */
export interface Frame {
	stream: string;
	frame: string;
}

/** The worker finished loading and is ready for requests. */
export interface Ready {
	ready: true;
	protocol: number;
	/** Set when sessions will not survive a reload; see `AgentHost::new`. */
	ephemeral?: boolean;
	error?: string;
}

/**
 * A device tool call leaving the engine, bounced to the main thread.
 *
 * The engine's tool layer POSTs its calls over the worker's `fetch`; the VM
 * they are for lives on the main thread (v86 drives DOM-adjacent APIs and the
 * serial bridge is wired there), so the worker forwards the body and waits
 * for the matching `VmResult`.
 */
export interface VmCall {
	vmCall: true;
	vmId: number;
	/** The request body: `{"name": ..., "arguments": ...}` as JSON text. */
	body: string;
}

/**
 * Bytes the engine hands to the person as a browser download.
 *
 * The workspace `download_file` tool's second half: the worker holds the
 * file, the main thread holds the DOM that can click an `<a download>`. One
 * way, like a `Frame` — the tool call it belongs to was already answered on
 * the engine's side once the bytes left.
 */
export interface Download {
	download: true;
	/** The name the browser saves the file under (the draft's own). */
	filename: string;
	bytes: Uint8Array;
}

/**
 * The parts of a pure web app the model wrote, on their way to the Apps page.
 *
 * The workspace `install_app` tool's second half. The worker holds the drafts;
 * the machine's mirror, its live `/data` and the Apps page are all on the main
 * thread, which packs and installs them and answers with an `InstallAppResult`
 * — the tool waits for it, because the model must hear whether the app is on
 * the page or why not.
 */
export interface InstallApp {
	installApp: true;
	installId: number;
	app: WebAppSource;
}

/** What `install_app` hands over: manifest fields and the window's parts. */
export interface WebAppSource {
	/** `^[a-z0-9][a-z0-9-]{0,31}$`, checked by the installer, not here. */
	id: string;
	title?: string;
	description?: string;
	/** The body fragment app-run(8) stages as index.html. */
	html: Uint8Array;
	/** style.css, when the model wrote one. */
	css?: Uint8Array;
	/** app.js, when the model wrote one. */
	js?: Uint8Array;
	/** Put it on the autostart list (`/data/apps/enabled`): the page opens
	 * its window whenever it loads. The person's policy — set only when they
	 * asked; absent leaves the list as it is (an update keeps the choice). */
	autostart?: boolean;
}

export type FromWorker = Reply | Frame | Ready | VmCall | Download | InstallApp;

export function isFrame(m: FromWorker): m is Frame {
	return 'frame' in m;
}

export function isReady(m: FromWorker): m is Ready {
	return 'ready' in m;
}

export function isVmCall(m: FromWorker): m is VmCall {
	return 'vmCall' in m;
}

export function isDownload(m: FromWorker): m is Download {
	return 'download' in m;
}

export function isInstallApp(m: FromWorker): m is InstallApp {
	return 'installApp' in m;
}

/**
 * Split a raw SSE record into its event name and payload.
 *
 * Only for callers that want to act on frames rather than forward them — the
 * fetch shim does not need this, because it hands the bytes to `EventSource`
 * semantics unchanged.
 */
export function parseFrame(raw: string): { event: string; data: unknown } | null {
	const nameMatch = /^event: (.+)$/m.exec(raw);
	const dataMatch = /^data: (.+)$/m.exec(raw);
	if (!nameMatch || !dataMatch) return null;
	try {
		return { event: nameMatch[1], data: JSON.parse(dataMatch[1]) };
	} catch {
		return null;
	}
}
