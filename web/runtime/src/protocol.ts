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
	| 'cancelTask'
	| 'sessionArchive'
	| 'sessionArchiveGet'
	| 'setReasoningEffort'
	| 'upload'
	| 'readUpload'
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

export type ToWorker = Init | Request | VmResult;

export function isInit(m: ToWorker): m is Init {
	return 'init' in m;
}

export function isVmResult(m: ToWorker): m is VmResult {
	return 'vmResult' in m;
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

export type FromWorker = Reply | Frame | Ready | VmCall;

export function isFrame(m: FromWorker): m is Frame {
	return 'frame' in m;
}

export function isReady(m: FromWorker): m is Ready {
	return 'ready' in m;
}

export function isVmCall(m: FromWorker): m is VmCall {
	return 'vmCall' in m;
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
