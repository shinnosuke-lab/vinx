/**
 * Make the worker look like agent-core's HTTP server.
 *
 * The chat UI is written against `fetch('/api/...')`. Rather than fork it to
 * call the worker directly — which would mean maintaining a second copy of a
 * moving target — this answers those requests in the page. The UI is used
 * unmodified, and every feature it gains upstream keeps working here.
 *
 * The illusion has to be complete in the ways the UI actually checks:
 *
 *  - `/api/chat/stream/{id}` returns `text/event-stream` with a streaming body.
 *    The client rejects the response outright if the content type is wrong, and
 *    it reads the body incrementally, so a string buffered until the turn ends
 *    would defeat the whole point.
 *  - `POST /api/chat` returns a JSON ack and, when a turn is already running,
 *    HTTP 409 with `turn_in_flight` — which the client turns into "attach and
 *    watch" rather than an error.
 *  - Aborting a request has to stop the stream, or a closed chat view leaves the
 *    worker publishing to nobody.
 *
 * Requests outside the prefix are passed to the original `fetch` untouched, so
 * a page using this can still talk to the network.
 */

import type { AgentClient, Outcome } from './client';
import { ConfigStore } from './config';

export interface ShimOptions {
	/** Only paths starting with this are answered here. */
	prefix?: string;
	/**
	 * Backs `/api/config`, so the UI's own settings panel is where the model
	 * endpoint is set. Defaults to a `localStorage`-backed store.
	 */
	config?: ConfigStore;
	/**
	 * Device tools already registered with the engine, reported at
	 * `/api/tools` so the UI lists what the agent can actually do.
	 */
	tools?: unknown[];
	/**
	 * Reported by `/api/chat/meta`. The UI shows it and uses it to decide which
	 * optional features to offer.
	 */
	meta?: Record<string, unknown>;
	/**
	 * A skills repository — an `index.json` and the packages it names, over
	 * plain HTTP (see agent-core's docs/SKILLS_REPO.md).
	 *
	 * Unset, `/api/skills/market` answers 404 and the UI hides the tab, which
	 * is its documented way of saying an agent has no repository. That is the
	 * default deliberately: a market pointing at nothing is worse than none.
	 */
	skillsRepo?: string;
	/** Defaults to `globalThis.fetch`. */
	passthrough?: typeof fetch;
	/**
	 * Called when `POST /api/chat` starts a turn, rather than queuing one or
	 * being refused.
	 *
	 * Here to drive the page's leave guard: upstream's turns run in a server
	 * process, so nothing there cares that a browser tab closed, but this
	 * engine *is* the tab. Only the edge is reported — when the turn ends is
	 * the engine's to say, and the guard asks it (`AgentClient.turns`) rather
	 * than inferring an ending from frames nobody may be attached to read.
	 */
	onTurnStarted?: () => void;
	/**
	 * Called after `POST /api/chat/upload` stored a file, with the same name
	 * and bytes. The page uses it to land chat attachments in the VM's
	 * /data/share/local as well, so the model's file tools (which live on the VM,
	 * not in the engine's workspace) can reach what the person attached.
	 * Fire-and-forget: the upload has already succeeded.
	 */
	onUpload?: (name: string, mime: string, bytes: Uint8Array) => void;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Mirrors `os::MAX_SAFE_PATHS`; the settings panel shows it as a capacity. */
const MAX_SAFE_PATHS = 200;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Turn an engine outcome into a response.
 *
 * The success payload is the body as it stands — the engine builds what the UI
 * reads — and a refusal carries the status the engine chose, because what makes
 * a request wrong is decided by the same code that would have carried it out.
 */
function answer<T>(outcome: Outcome<T>): Response {
	return outcome.ok ? json(outcome) : json({ error: outcome.error }, outcome.status);
}

/** A session id for a chat that does not have one yet. */
function newSessionId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	// Older WebViews have `crypto` without `randomUUID`. The id only has to be
	// unique within one browser profile, so this is sufficient.
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Install the shim over `globalThis.fetch`.
 *
 * Returns a function that puts the original back — worth calling in tests and
 * in hot-reload, where a stacked shim would answer twice.
 */
export function installFetchShim(client: AgentClient, options: ShimOptions = {}): () => void {
	const prefix = options.prefix ?? '/api/';
	const original = options.passthrough ?? globalThis.fetch.bind(globalThis);
	const handler = createHandler(client, options);

	// Only the page's own origin: a gateway named in `?gw=` — how `vite dev`
	// reaches one — is a different origin serving `/api/` too, and matching on
	// the path alone would answer requests meant for the device with the
	// worker's idea of them.
	//
	// In the deployment the gateway serves the page, so the two origins are the
	// same and this cannot tell them apart. It does not need to. The page only
	// talks to the device at boot, before this is installed (see `deviceTools`),
	// and the engine's tool calls are made from inside the worker, which has a
	// `fetch` of its own that nothing here touches.
	const here = globalThis.location?.origin;

	const shim: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		const url = new URL(request.url, here ?? 'http://shim.invalid');
		const mine = !here || url.origin === here;
		if (!mine || !url.pathname.startsWith(prefix)) return original(input as RequestInfo, init);
		return handler(request, url.pathname);
	};

	globalThis.fetch = shim;
	return () => {
		globalThis.fetch = original;
	};
}

/**
 * The routing table, separated from the global patching so it can be tested
 * without touching `globalThis`.
 */
export function createHandler(
	client: AgentClient,
	options: ShimOptions = {},
): (request: Request, path: string) => Promise<Response> {
	const { prefix = '/api/', meta = {}, config = new ConfigStore(), tools = [] } = options;
	const route = (p: string) => p.slice(prefix.length);

	// Captured now, not when a route needs it: this runs before
	// `installFetchShim` replaces `globalThis.fetch`, so it is the browser's
	// own. Reading it later would hand a route the shim itself, which for a
	// download from another origin means a needless round trip back through
	// here to be passed out again.
	const passthrough = options.passthrough ?? globalThis.fetch.bind(globalThis);
	const market = new SkillsMarket(options.skillsRepo, passthrough);

	return async function handle(request: Request, path: string): Promise<Response> {
		const tail = route(path);
		const url = new URL(request.url, 'http://shim.invalid');

		try {
			// ── the device's own endpoint ──
			// The console page posts run_python here itself, straight from the
			// prompt, and the moment its assistant boots this engine the shim
			// owns the page's fetch — so without this line opening the AI panel
			// would take the prompt down with a 404. The shim implements no
			// device tool (the engine's own calls leave from inside the worker,
			// whose fetch is untouched); the request is handed to the browser's
			// real fetch unchanged, query string and all.
			if (tail === 'tools/call') return passthrough(request);

			// ── chat ──
			if (tail.startsWith('chat/stream/')) {
				const session = decodeURIComponent(tail.slice('chat/stream/'.length));
				const follow = ['1', 'true'].includes(url.searchParams.get('follow') ?? '');
				return streamResponse(client, session, request.signal, follow);
			}
			if (tail === 'chat' && request.method === 'POST') {
				return chat(client, await request.json(), options.onTurnStarted);
			}
			if (tail === 'chat/steer' && request.method === 'POST') {
				const body = await request.json();
				const steered = await client.steer(body.session_id, String(body.message ?? ''));
				// 409 rather than an ok-with-a-flag: the UI reads any non-2xx as
				// "there was nothing to steer" and sends the message normally.
				return steered
					? json({ ok: true, session_id: body.session_id })
					: json(
							{
								ok: false,
								error: 'no_turn_in_flight',
								message: 'no running turn to steer; send it as a regular message',
							},
							409,
						);
			}
			if (tail === 'chat/rewind' && request.method === 'POST') {
				const body = await request.json();
				const outcome = await client.rewind(body.session_id, Number(body.user_index) || 0);
				// A rewind is refused for one of two reasons, and the UI shows
				// both as a toast: a running turn (409, cancel it first) or an
				// index that names no message (400).
				if (outcome.ok) return json(outcome);
				return json(outcome, outcome.error === 'turn_in_flight' ? 409 : 400);
			}
			if (tail === 'chat/meta') {
				// Read the config now rather than closing over it: the model is
				// what the composer's badge shows, and changing it in the
				// settings panel has to be visible without a reload. An empty
				// one is left out entirely — the badge hangs on the field being
				// truthy, and `model: ""` would render an empty chip.
				const model = config.load().model?.trim();
				return json({ ...meta, ...(model ? { model } : {}), protocol: 2 });
			}
			if (tail === 'chat/upload' && request.method === 'POST') {
				return upload(client, request, options.onUpload);
			}
			if (tail.startsWith('chat/upload/') && request.method === 'GET') {
				const id = decodeURIComponent(tail.slice('chat/upload/'.length));
				return download(client, id, url.searchParams.get('name'));
			}
			if (tail === 'chat/confirm' && request.method === 'POST') {
				const body = await request.json();
				// "Allow this folder" rides on the approval. Learned first, so
				// the tool the user just approved is already covered if the
				// same turn writes there twice.
				if (body.confirmed === true && typeof body.allow_dir === 'string' && body.allow_dir.trim()) {
					await client.allowDir(body.allow_dir);
				}
				// The bar lets the arguments be edited before approving, and the
				// edited call is the one the user is approving. Serialised
				// because that is how the engine wants it; it re-parses.
				const amended =
					body.amended_args === undefined || body.amended_args === null
						? undefined
						: JSON.stringify(body.amended_args);
				// The tool-call id rides along because a sub-agent's confirm bar
				// looks exactly like the parent's: it is the only thing that says
				// which agent the answer is for.
				await client.confirm(
					body.session_id,
					body.confirmed === true,
					body.auto === true,
					amended,
					typeof body.id === 'string' ? body.id : undefined,
				);
				return json({ ok: true });
			}
			if (tail === 'chat/answer' && request.method === 'POST') {
				const body = await request.json();
				// An activity ping is NOT an answer: the user is typing in the
				// ask bar, and the engine only pushes its auto-pick deadline
				// back. Routed apart before the answer path, which would read
				// the missing `answers` as backing out and cancel the question.
				if (body.activity === true) {
					await client.askActivity(body.session_id);
					return json({ ok: true });
				}
				// `cancelled` is carried as an empty answer list, which is how the
				// host already reads "the user backed out".
				await client.answer(body.session_id, body.cancelled ? [] : (body.answers ?? []));
				return json({ ok: true });
			}
			if (tail === 'chat/cancel' && request.method === 'POST') {
				const body = await request.json();
				await client.cancel(body.session_id);
				return json({ ok: true });
			}
			// The queue strip's actions, addressing items by the id their
			// `queue` frame carried. A miss is a 404 the UI reads as "already
			// gone" and resolves from the next snapshot.
			if (tail === 'chat/queue/remove' && request.method === 'POST') {
				const body = await request.json();
				const ok = await client.queueRemove(body.session_id, Number(body.id) || 0);
				return ok ? json({ ok: true }) : json({ error: 'no such queued message' }, 404);
			}
			if (tail === 'chat/queue/edit' && request.method === 'POST') {
				const body = await request.json();
				const ok = await client.queueEdit(
					body.session_id,
					Number(body.id) || 0,
					String(body.message ?? ''),
				);
				return ok ? json({ ok: true }) : json({ error: 'no such queued message' }, 404);
			}
			// Cancel ONE running sub-agent; the rest of the turn keeps going.
			// 404 when the task already finished — the UI clears its row from
			// the next `subagent` frame either way.
			if (tail === 'chat/task/cancel' && request.method === 'POST') {
				const body = await request.json();
				const ok = await client.cancelTask(body.session_id, String(body.task_id ?? ''));
				return ok ? json({ ok: true }) : json({ ok: false, error: 'not_found' }, 404);
			}
			if (tail === 'chat/auto' && request.method === 'POST') {
				const body = await request.json().catch(() => ({}));
				const enabled = body.enabled === true;
				await client.setAuto(body.session_id, enabled);
				return json({ ok: true, enabled });
			}

			// ── configuration ──
			if (tail === 'config' && request.method === 'GET') {
				return json(config.sanitized());
			}
			if (tail === 'config' && request.method === 'PUT') {
				const saved = config.save(await request.json());
				// Apply immediately. agent-core restarts the process to pick up a
				// new config; there is no process here, so the next turn simply
				// uses the new endpoint — and the UI is told not to wait for a
				// restart that will never happen.
				await client.configure(saved.base_url, saved.api_key, saved.model);
				await client.setReasoningEffort(
					saved.reasoning_effort ?? '',
					saved.subagent_reasoning_effort ?? '',
				);
				return json({ ok: true, restarting: false });
			}

			// ── sessions ──
			if (tail === 'sessions' && request.method === 'GET') {
				const q = url.searchParams.get('q');
				return json(q?.trim() ? await client.search(q.trim()) : await client.sessions());
			}
			if (tail.startsWith('sessions/')) {
				const rest = tail.slice('sessions/'.length);
				// The pre-compaction archive, under the session it belongs to:
				// `{id}/archive` lists generations, `{id}/archive/{n}` loads one.
				const archiveAt = rest.indexOf('/archive');
				if (archiveAt !== -1 && request.method === 'GET') {
					const id = decodeURIComponent(rest.slice(0, archiveAt));
					const gen = rest.slice(archiveAt + '/archive'.length);
					if (gen === '' || gen === '/') {
						return json(await client.sessionArchive(id));
					}
					const generation = Number(gen.replace(/^\//, ''));
					if (!Number.isInteger(generation)) return json({ error: 'not_found' }, 404);
					const body = await client.sessionArchiveGet(id, generation);
					return body ? json(body) : json({ error: 'not_found' }, 404);
				}
				const id = decodeURIComponent(rest);
				if (request.method === 'GET') {
					const detail = await client.session(id);
					return detail ? json(detail) : json({ error: 'not found' }, 404);
				}
				if (request.method === 'PATCH') {
					const patch = await request.json();
					await client.updateSession(id, patch.title, patch.pinned);
					return json({ ok: true });
				}
				if (request.method === 'DELETE') {
					await client.deleteSession(id);
					return json({ ok: true });
				}
			}

			// What the endpoint advertises, for the composer's model picker,
			// plus per-model capability records for the effort switcher.
			// Empty is a normal answer: not every provider lists its models,
			// and the UI falls back to a read-only badge.
			if (tail === 'models') return json(await client.models());

			// ── the write/edit allow-list ──
			//
			// The counterpart to `allow_dir` above: the settings panel lists
			// what has been allowed and lets it be taken back.
			if (tail === 'safe-paths' && request.method === 'GET') {
				return json({ learned: await client.allowedDirs(), max: MAX_SAFE_PATHS });
			}
			if (tail === 'safe-paths' && request.method === 'DELETE') {
				await client.forgetDirs(url.searchParams.get('dir') ?? undefined);
				return json({ learned: await client.allowedDirs() });
			}
			// The command allow-list has nothing to gate: `run_shell` is not
			// one of the tools here. Answered rather than 404'd so the panel
			// draws an empty card instead of an error.
			if (tail === 'safe-commands') return json({ learned: [], max: 0 });

			// ── how much of the workspace is in use ──
			//
			// One of the few settings cards that means the same thing here as
			// on a host: the categories it reports are real directories in the
			// workspace, and clearing them reclaims real IndexedDB space.
			//
			// Its export button is not here, because it cannot be: it is a
			// `window.open` of /api/runtime/export, and a navigation never
			// passes through this shim. capabilities.css hides it.
			if (tail === 'runtime/stat' && request.method === 'GET') {
				return json(await client.runtimeStat(url.searchParams.get('category') ?? undefined));
			}
			if (tail === 'runtime/clear' && request.method === 'POST') {
				const body = await request.json().catch(() => ({}));
				return answer(await client.runtimeClear(body.categories ?? []));
			}

			// ── endpoints the UI probes at boot ──
			//
			// Answered with empty rather than 404 on purpose: a 404 makes the UI
			// show a broken-backend state, while an empty list makes it hide the
			// feature, which is the truth until those parts are built.
			if (tail === 'tools') return json({ ok: true, tools });

			// ── themes ──
			//
			// `active` before `{name}`, as upstream: the pointer is its own
			// resource, and `active` is a reserved theme name because of it.
			if (tail === 'themes' && request.method === 'GET') return json(await client.themes());
			if (tail === 'themes/active' && request.method === 'PUT') {
				return answer(await client.activateTheme((await request.json()).name));
			}
			if (tail === 'themes/active' && request.method === 'DELETE') {
				return answer(await client.activateTheme());
			}
			if (tail.startsWith('themes/') && request.method === 'PUT') {
				const body = await request.json();
				const name = decodeURIComponent(tail.slice('themes/'.length));
				return answer(
					await client.saveTheme(name, body.css ?? '', body.js ?? '', body.session_id),
				);
			}

			// ── what this agent has published ──
			//
			// Themes are the only kind: a page has no systemd services to run
			// and no public directory to publish into. Answered rather than
			// 404'd for every other kind, so those pages draw an empty state
			// instead of a broken backend.
			if (tail === 'releases' && request.method === 'GET') {
				const kind = url.searchParams.get('kind');
				return json(kind === 'theme' ? await client.savedThemes() : { releases: [] });
			}
			// The apps repository, answered the way the UI reads as "there is
			// none": a page has nowhere to install a service. Said explicitly
			// rather than left to fall through, so it is not logged as a route
			// somebody forgot.
			if (tail.startsWith('apps/market')) return json({ error: 'no apps repository' }, 404);

			if (tail.startsWith('releases/theme/') && request.method === 'DELETE') {
				return answer(await client.deleteTheme(decodeURIComponent(tail.slice('releases/theme/'.length))));
			}

			// ── skills ──
			//
			// The market is checked first: `skills/market` would otherwise be
			// read as a skill called "market" by the per-skill routes below.
			if (tail.startsWith('skills/market')) return market.handle(client, tail, request);
			if (tail === 'skills' && request.method === 'GET') return json(await client.skills());
			if (tail === 'skills/import' && request.method === 'POST') {
				return answer(await client.importSkill(new Uint8Array(await request.arrayBuffer())));
			}
			if (tail === 'skills/install-url' && request.method === 'POST') {
				const body = await request.json().catch(() => ({}));
				return installFromUrl(client, body.url, passthrough);
			}
			if (tail.startsWith('skills/')) return skill(client, tail.slice('skills/'.length), request);

			// The UI asked for something this does not serve yet. It degrades
			// gracefully, but the browser only reports a bare "404 (Not Found)"
			// with no path, so say which one — otherwise a missing feature looks
			// like a broken page and there is nothing to search for.
			console.warn(`[agent-web] unimplemented route: ${request.method} ${path}`);
			return json({ error: `no route for ${request.method} ${path}` }, 404);
		} catch (e) {
			// A worker that died mid-request would otherwise surface as an
			// unhandled rejection somewhere far from the cause.
			return json({ error: e instanceof Error ? e.message : String(e) }, 500);
		}
	};
}

/**
 * `POST /api/chat/upload`: the body is the file, the name rides a header.
 *
 * The header is percent-encoded, because HTTP headers are ASCII and file names
 * are not. Upstream decodes it server-side and echoes the real name back, and
 * the UI uses that answer verbatim — decoding twice would corrupt a name that
 * legitimately contains a `%`.
 */
async function upload(
	client: AgentClient,
	request: Request,
	onUpload?: ShimOptions['onUpload'],
): Promise<Response> {
	const raw = request.headers.get('x-file-name') ?? '';
	let name = raw;
	try {
		name = decodeURIComponent(raw);
	} catch {
		// Not encoded, or badly. A plain name is still a name.
	}
	const mime = request.headers.get('content-type') ?? '';
	const bytes = new Uint8Array(await request.arrayBuffer());
	const outcome = await client.upload(name, mime, bytes);
	if (outcome.ok && onUpload) {
		try {
			onUpload(name, mime, bytes);
		} catch (e) {
			console.warn(`[agent-web] onUpload failed for ${name}:`, e);
		}
	}
	return answer(outcome);
}

/**
 * `GET /api/chat/upload/{id}`: the bytes back, for the transcript.
 *
 * Images are served as themselves so they can render inline; everything else
 * downloads under its original name. The `filename*` form is what carries a
 * non-ASCII name intact, and the plain `filename` is the fallback for clients
 * that do not read it.
 */
async function download(client: AgentClient, id: string, name: string | null): Promise<Response> {
	const found = await client.readUpload(id);
	if (!found) return json({ error: 'no such upload' }, 404);

	const headers: Record<string, string> = {
		'Content-Type': found.mime,
		// The id is a fresh uuid per upload, so the bytes behind one never
		// change.
		'Cache-Control': 'private, max-age=31536000, immutable',
	};
	if (!found.mime.startsWith('image/')) {
		const filename = (name?.trim() ? name : id).slice(0, 120);
		const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
		headers['Content-Disposition'] =
			`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
	}
	// `.buffer` rather than the view: a `Uint8Array` is not a `BodyInit`, and
	// the array came back from the worker whole rather than as a window onto
	// something larger.
	return new Response(found.bytes.buffer as ArrayBuffer, { status: 200, headers });
}

/**
 * `/api/skills/{name}/...`: one installed skill.
 *
 * `readme` and `changelog` are markdown rather than JSON, and the UI tells them
 * apart by status: a skill with no changelog must 404, or the detail panel
 * renders an empty tab instead of hiding it.
 */
async function skill(client: AgentClient, rest: string, request: Request): Promise<Response> {
	const [raw, action] = rest.split('/');
	const name = decodeURIComponent(raw);

	if (!action && request.method === 'DELETE') return answer(await client.deleteSkill(name));

	if (request.method === 'POST' && ['enabled', 'pinned', 'shared'].includes(action)) {
		const body = await request.json();
		await client.setSkillFlag(name, action as 'enabled' | 'pinned' | 'shared', body[action] === true);
		return json({ ok: true });
	}

	if (request.method === 'GET' && (action === 'readme' || action === 'changelog')) {
		const text = await client.skillText(name, action);
		if (text === null) return json({ error: `no ${action} for '${name}'` }, 404);
		return new Response(text, {
			status: 200,
			headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
		});
	}

	if (request.method === 'GET' && action === 'icon') {
		const found = await client.skillIcon(name);
		if (!found) return json({ error: 'no icon' }, 404);
		return new Response(found.bytes.buffer as ArrayBuffer, {
			status: 200,
			headers: { 'Content-Type': found.mime, 'Cache-Control': 'no-cache' },
		});
	}

	return json({ error: `no route for ${request.method} skills/${rest}` }, 404);
}

/**
 * `POST /api/skills/install-url {url}`: install a package from an address the
 * user pasted.
 *
 * Upstream downloads it agent-side because its browser cannot reach an
 * arbitrary host. This one has no agent-side, so the page fetches it itself —
 * which works for a host that sends `Access-Control-Allow-Origin` and cannot
 * work for one that does not. That distinction is invisible to `fetch`, which
 * reports a blocked response and a dead host identically, so the failure says
 * both things rather than guessing.
 *
 * `get` is the unshimmed `fetch`, and is passed in rather than defaulted: a
 * default is evaluated on the call, by which time the shim owns
 * `globalThis.fetch` and this would be asking itself to fetch someone else's
 * host. See where `createHandler` captures it.
 */
async function installFromUrl(
	client: AgentClient,
	url: unknown,
	get: typeof fetch,
): Promise<Response> {
	const address = typeof url === 'string' ? url.trim() : '';
	if (!address) return json({ error: 'empty_url' }, 400);
	// http(s) only, as upstream: `file:` and `data:` would let a pasted link
	// reach for something that is not a download.
	if (!/^https?:\/\//i.test(address)) return json({ error: 'only http(s) URLs can be installed' }, 400);

	let res: Response;
	try {
		res = await get(address);
	} catch (e) {
		return json(
			{
				error:
					`could not download ${address}: ${e instanceof Error ? e.message : String(e)}. ` +
					`The page downloads it itself, so the host has to allow this origin ` +
					`(Access-Control-Allow-Origin) — a host that does not looks exactly like one that is down.`,
			},
			502,
		);
	}
	if (!res.ok) return json({ error: `could not download ${address} (HTTP ${res.status})` }, 502);
	return answer(await client.importSkill(new Uint8Array(await res.arrayBuffer())));
}

/**
 * The environment this agent runs in, as a skill's `env:` names it.
 *
 * Deliberately not `gateway`, even though the device is one: that name belongs
 * to the agent that runs *on* a gateway with a shell, and the skills declaring
 * it (gdb, strace, mbpoll, ua) drive Linux CLIs this page has no way to reach.
 * All that executes here is MicroPython inside the firmware's sandbox, so this
 * says so, and those skills fall out as mismatched rather than being offered
 * and failing at the first command.
 *
 * A constant rather than a setting: unlike upstream, where an operator can run
 * the same binary in a container or on a PC, there is only one place this page
 * can run its code.
 */
const AGENT_ENV = 'mpy';

/** An entry's declared target environments, trimmed; empty = generic. */
function envTargets(env: unknown): string[] {
	const raw = Array.isArray(env) ? env : String(env ?? '').split(',');
	return raw.map((e) => String(e).trim()).filter(Boolean);
}

/**
 * Whether an entry's `env` excludes this agent, by upstream's rule
 * (`skill_market::env_mismatch`): a case-insensitive set intersection, where
 * no overlap is the mismatch. An entry that declares nothing is generic and
 * runs anywhere, so it is never blocked.
 */
function envMismatch(env: unknown): boolean {
	const targets = envTargets(env);
	return targets.length > 0 && !targets.some((e) => e.toLowerCase() === AGENT_ENV);
}

/**
 * A skills repository, read straight from the browser.
 *
 * Upstream proxies this through the agent because its UI cannot reach an
 * arbitrary host — a page and a repository are rarely the same origin. Here the
 * repository is on the asset host, which already sends the CORS header the page
 * needs for its own code, so the download is simply made from here and handed
 * to the engine to unpack. That removes the proxy and its `install-url`
 * companion entirely.
 *
 * The index's `sha256` is not verified, and cannot be: `crypto.subtle` exists
 * only in a secure context and the gateway serves this page over plain HTTP.
 * What the package can do is bounded by the engine instead — the same entry,
 * size and path checks upstream applies after its own hash check.
 */
class SkillsMarket {
	private cached: { at: number; index: any } | null = null;

	constructor(
		private repo: string | undefined,
		/**
		 * The unshimmed `fetch`; the repository is not this page's origin. Passed
		 * in rather than defaulted, for the reason `installFromUrl` gives.
		 */
		private get: typeof fetch,
	) {
		const address = repo?.trim().replace(/\/+$/, '') ?? '';
		// Absolute http(s) only. A relative or malformed value would be
		// resolved against the page's own origin, which is the gateway — so
		// the market would ask the device for an index it has never heard of,
		// and the operator would see a 404 naming the gateway rather than
		// anything about a repository. Treated as "no repository", which the
		// UI already knows how to present.
		const usable = /^https?:\/\/[^/]+/i.test(address);
		if (address && !usable) {
			console.warn(`[agent-web] ignoring skills repository, not an absolute http(s) URL: ${address}`);
		}
		this.repo = usable ? address : undefined;
	}

	handle(client: AgentClient, tail: string, request: Request): Promise<Response> {
		// 404 rather than an empty list: the UI reads it as "this agent has no
		// repository" and hides the tab, which is exactly the situation.
		if (!this.repo) return Promise.resolve(json({ error: 'no skills repository' }, 404));

		const rest = tail.slice('skills/market'.length).replace(/^\//, '');
		if (!rest && request.method === 'GET') return this.listing(client);
		if (rest === 'install' && request.method === 'POST') return this.install(client, request);

		const preview = /^(.+)\/preview$/.exec(rest);
		if (preview && request.method === 'GET') {
			return this.preview(client, decodeURIComponent(preview[1]));
		}
		return Promise.resolve(json({ error: `no route for ${request.method} ${tail}` }, 404));
	}

	/**
	 * The index, with what is installed here merged into it — the version
	 * beside each entry is what turns "install" into "installed" or "update".
	 * Every skill here came from a package, so all of them are replaceable.
	 */
	private async listing(client: AgentClient): Promise<Response> {
		const index = await this.index();
		if (index instanceof Response) return index;

		const local = new Map<string, string>();
		for (const s of (await client.skills()).skills as any[]) {
			local.set(s.name, String(s.version ?? ''));
		}
		const skills = (index.skills ?? []).map((entry: any) => {
			const installed = local.get(entry?.name);
			return {
				...entry,
				installed_version: installed ?? null,
				update_available: installed !== undefined && !!entry.version && installed !== entry.version,
				repo_managed: true,
				// `install` refuses these, so the UI disables the action with
				// the reason and hides the entry unless it is asked for.
				env_mismatch: envMismatch(entry?.env),
			};
		});
		return json({ ...index, repo: this.repo, skills });
	}

	private async install(client: AgentClient, request: Request): Promise<Response> {
		const { name } = await request.json();
		const entry = await this.entry(name);
		if (entry instanceof Response) return entry;

		// Checked here and not only in the UI: the button is disabled from the
		// same flag, but a skill built for another runtime is refused however
		// the request was made, as upstream's install endpoint does.
		if (envMismatch(entry.env)) {
			const targets = envTargets(entry.env).join(', ');
			return json(
				{
					error:
						`'${name}' only targets environment(s) [${targets}] and this agent runs in ` +
						`[${AGENT_ENV}] — the skill would not work here, so installation is refused`,
				},
				409,
			);
		}

		const bytes = await this.download(entry);
		if (bytes instanceof Response) return bytes;
		return answer(await client.importSkill(bytes));
	}

	/**
	 * Reading a package is not installing it: the docs of a skill meant for
	 * another environment are worth showing, if only to explain why it is not
	 * on offer. Upstream draws the line in the same place.
	 */
	private async preview(client: AgentClient, name: string): Promise<Response> {
		const entry = await this.entry(name);
		if (entry instanceof Response) return entry;
		const bytes = await this.download(entry);
		if (bytes instanceof Response) return bytes;
		return answer(await client.previewSkill(bytes));
	}

	/** The index itself, cached as long as upstream caches its own. */
	private async index(): Promise<any | Response> {
		const now = Date.now();
		if (this.cached && now - this.cached.at < 60_000) return this.cached.index;

		const res = await this.get(`${this.repo}/index.json`);
		if (!res.ok) return json({ error: `repository unreachable (HTTP ${res.status})` }, 502);

		const index = await res.json();
		this.cached = { at: now, index };
		return index;
	}

	/**
	 * A named index entry, or the response explaining why there is none. Split
	 * from `download` so a request can be judged on the entry's metadata
	 * before anything is fetched.
	 */
	private async entry(name: string): Promise<any | Response> {
		const index = await this.index();
		if (index instanceof Response) return index;

		const entry = (index.skills ?? []).find((s: any) => s?.name === name);
		if (!entry?.url) return json({ error: `'${name}' is not in the repository` }, 404);
		return entry;
	}

	/** An entry's package bytes, or the response explaining why not. */
	private async download(entry: any): Promise<Uint8Array | Response> {
		// Relative to the index, as the protocol specifies, unless the entry
		// gave an absolute URL — which is how a repository points at a mirror.
		const res = await this.get(new URL(entry.url, `${this.repo}/`).href);
		if (!res.ok) {
			return json({ error: `could not download '${entry.name}' (HTTP ${res.status})` }, 502);
		}
		return new Uint8Array(await res.arrayBuffer());
	}
}

/** `POST /api/chat`: start a turn and answer with the ack the client expects. */
async function chat(client: AgentClient, body: any, started?: () => void): Promise<Response> {
	const session = body.session_id || newSessionId();
	// The model rides on the message because the picker is a per-turn choice,
	// not a setting: dropping it here would leave a picker that visibly does
	// nothing, which is worse than not offering one.
	const ack = await client.send(session, String(body.message ?? ''), {
		model: typeof body.model === 'string' ? body.model : undefined,
		reasoningEffort:
			typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()
				? body.reasoning_effort
				: undefined,
		attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
		skillAction: body.skill_action ?? undefined,
		queue: body.queue === true,
		interrupt: body.interrupt === true,
		// Which surface sent it — the console's assistant panel tags itself
		// `terminal`, and the sessions page draws its glyph from this.
		origin: typeof body.origin === 'string' && body.origin ? body.origin : undefined,
	});

	if (!ack.accepted && ack.reason === 'turn_in_flight') {
		// The client reads this as "attach and watch", not as a failure.
		return json({ ok: false, error: 'turn_in_flight', session_id: session }, 409);
	}
	if (!ack.accepted) {
		// `running: false` tells the client not to attach; the reason is already
		// on the stream as an `error` frame if anyone is watching.
		return json({ ok: false, error: ack.reason ?? 'rejected', session_id: session, running: false }, 400);
	}
	// A bare `/reset` turns the active skill off and asks nothing of the model,
	// so there is no turn to attach to. The client synthesises the frames it
	// would otherwise have read from the stream.
	if (ack.running === false) {
		return json({
			ok: true,
			session_id: session,
			running: false,
			active_skill: null,
			auto_confirm: ack.auto_confirm === true,
		});
	}
	// Parked behind the running turn rather than started. `running: true` is
	// still the truth — a turn is running, just not this message's — and the
	// composer reads `queued` to show it in the strip above itself. An
	// interrupt says so (`interrupted: true`): the turn it wound down is
	// ending, and this message is at the front.
	if (ack.queued) {
		return json({
			ok: true,
			session_id: session,
			running: true,
			queued: true,
			...(ack.interrupted ? { interrupted: true } : {}),
			position: ack.position ?? 1,
			auto_confirm: ack.auto_confirm === true,
		});
	}
	started?.();
	return json({ ok: true, session_id: session, running: true, auto_confirm: ack.auto_confirm === true });
}

/**
 * `GET /api/chat/stream/{id}`: frames as they are produced.
 *
 * The body is a `ReadableStream` rather than a joined string because the client
 * reads it incrementally — buffering until the turn ended would remove the only
 * thing streaming is for.
 *
 * `follow` is the session-scoped form the chat UI asks for: `done` no longer
 * ends the response, it merely separates one turn's frames from the next turn's
 * snapshot, and the stream lives until the reader hangs up. Without it the
 * response is turn-scoped, which is what a one-off viewer wants.
 */
function streamResponse(
	client: AgentClient,
	session: string,
	signal: AbortSignal,
	follow = false,
): Response {
	const encoder = new TextEncoder();
	let detach: (() => void) | null = null;

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const finish = () => {
				if (closed) return;
				closed = true;
				detach?.();
				detach = null;
				try {
					controller.close();
				} catch {
					// Already closed by an abort that raced us; nothing to do.
				}
			};

			detach = client.attach(
				session,
				(frame) => {
					if (closed) return;
					controller.enqueue(encoder.encode(frame));
					// `done` and `error` are terminal in the protocol, and a
					// turn-scoped client stops reading at them. Closing here
					// rather than waiting for it to hang up releases the
					// subscription immediately.
					if (
						!follow &&
						(frame.startsWith('event: done') || frame.startsWith('event: error'))
					) {
						finish();
					}
				},
				follow,
			);

			if (signal.aborted) finish();
			else signal.addEventListener('abort', finish, { once: true });
		},

		cancel() {
			// The consumer walked away — an unmounted chat view, usually.
			detach?.();
			detach = null;
		},
	});

	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
		},
	});
}
