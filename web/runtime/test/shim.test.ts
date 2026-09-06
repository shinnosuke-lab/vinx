/**
 * The fetch shim, checked against what the chat UI actually requires.
 *
 * The assertions here are deliberately the client's own preconditions — the
 * content type it rejects on, the 409 it treats as "attach instead", the
 * incremental body it reads. A shim that returns the right JSON but buffers the
 * stream would pass a looser test and fail in the browser.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentClient } from '../src/client';
import { ConfigStore } from '../src/config';
import { createHandler, installFetchShim, type ShimOptions } from '../src/shim';

/** A client whose worker the test plays. */
function fakeClient() {
	const attached: Array<{
		session: string;
		push: (frame: string) => void;
		follow: boolean;
		detached: boolean;
	}> = [];
	const calls: Array<[string, unknown[]]> = [];
	const record =
		(name: string, result: unknown = undefined) =>
		(...args: unknown[]) => {
			calls.push([name, args]);
			return Promise.resolve(result);
		};

	const client = {
		calls,
		attached,
		sendResult: { accepted: true } as {
			accepted: boolean;
			reason?: string;
			running?: boolean;
			queued?: boolean;
			position?: number;
		},
		modelList: [] as string[],
		dirs: [] as string[],
		stored: new Map<string, { bytes: Uint8Array; mime: string }>(),
		uploadResult: null as unknown,
		upload: (...args: unknown[]) => {
			calls.push(['upload', args]);
			const [name, mime, bytes] = args as [string, string, Uint8Array];
			if (client.uploadResult) return Promise.resolve(client.uploadResult);
			const id = `${'a'.repeat(32)}.${mime.startsWith('image/') ? 'png' : 'bin'}`;
			client.stored.set(id, { bytes, mime });
			return Promise.resolve({
				ok: true,
				id,
				name,
				mime,
				kind: mime.startsWith('image/') ? 'image' : 'file',
				size: bytes.length,
				lines: null,
			});
		},
		readUpload: (...args: unknown[]) => {
			calls.push(['readUpload', args]);
			return Promise.resolve(client.stored.get(args[0] as string) ?? null);
		},
		send: (...args: unknown[]) => {
			calls.push(['send', args]);
			return Promise.resolve(client.sendResult);
		},
		steerResult: true,
		steer: (...args: unknown[]) => {
			calls.push(['steer', args]);
			return Promise.resolve(client.steerResult);
		},
		rewindResult: { ok: true, message_count: 2, active_skill: null } as unknown,
		rewind: (...args: unknown[]) => {
			calls.push(['rewind', args]);
			return Promise.resolve(client.rewindResult);
		},
		installed: [] as { name: string; version?: string }[],
		skillOutcome: { ok: true, name: 'demo', diagnostics: [] } as unknown,
		skills: (...args: unknown[]) => {
			calls.push(['skills', args]);
			return Promise.resolve({ skills: client.installed, diagnostics: [] });
		},
		skillText: (...args: unknown[]) => {
			calls.push(['skillText', args]);
			const [, which] = args as [string, string];
			return Promise.resolve(which === 'readme' ? '# demo\n' : null);
		},
		skillIcon: (...args: unknown[]) => {
			calls.push(['skillIcon', args]);
			return Promise.resolve({ bytes: new TextEncoder().encode('PNG'), mime: 'image/png' });
		},
		setSkillFlag: record('setSkillFlag'),
		importSkill: (...args: unknown[]) => {
			calls.push(['importSkill', args]);
			return Promise.resolve(client.skillOutcome);
		},
		previewSkill: (...args: unknown[]) => {
			calls.push(['previewSkill', args]);
			return Promise.resolve({ ok: true, readme: '# demo\n', changelog: null });
		},
		deleteSkill: record('deleteSkill', { ok: true }),
		looks: [] as { name: string; css: string; js: string }[],
		active: null as string | null,
		themes: (...args: unknown[]) => {
			calls.push(['themes', args]);
			const found = client.looks.find((l) => l.name === client.active);
			return Promise.resolve({ themes: found ? [found] : [] });
		},
		savedThemes: (...args: unknown[]) => {
			calls.push(['savedThemes', args]);
			return Promise.resolve({
				releases: client.looks.map((l) => ({ kind: 'theme', name: l.name })),
			});
		},
		saveTheme: (...args: unknown[]) => {
			calls.push(['saveTheme', args]);
			const [name, css, js] = args as [string, string, string];
			client.looks = [...client.looks.filter((l) => l.name !== name), { name, css, js }];
			return Promise.resolve({ ok: true });
		},
		activateTheme: (...args: unknown[]) => {
			calls.push(['activateTheme', args]);
			const [name] = args as [string | undefined];
			if (name && !client.looks.some((l) => l.name === name)) {
				return Promise.resolve({ ok: false, error: `no theme named '${name}'`, status: 404 });
			}
			client.active = name ?? null;
			return Promise.resolve({ ok: true });
		},
		deleteTheme: record('deleteTheme', { ok: true }),
		models: (...args: unknown[]) => {
			calls.push(['models', args]);
			// The worker answers the whole /api/models body: list + caps.
			return Promise.resolve({ ok: true, models: client.modelList, caps: {} });
		},
		allowDir: (...args: unknown[]) => {
			calls.push(['allowDir', args]);
			client.dirs.push(args[0] as string);
			return Promise.resolve(true);
		},
		allowedDirs: (...args: unknown[]) => {
			calls.push(['allowedDirs', args]);
			return Promise.resolve(client.dirs);
		},
		forgetDirs: (...args: unknown[]) => {
			calls.push(['forgetDirs', args]);
			const dir = args[0] as string | undefined;
			client.dirs = dir ? client.dirs.filter((d) => d !== dir) : [];
			return Promise.resolve();
		},
		runtimeStat: (...args: unknown[]) => {
			calls.push(['runtimeStat', args]);
			return Promise.resolve({ root: '/runtime', categories: {} });
		},
		runtimeClear: (...args: unknown[]) => {
			calls.push(['runtimeClear', args]);
			return Promise.resolve({ ok: true, reclaimed_bytes: 128, cleared: ['drafts'] });
		},
		attach(session: string, onFrame: (frame: string) => void, follow = false) {
			const entry = { session, push: onFrame, follow, detached: false };
			attached.push(entry);
			return () => {
				entry.detached = true;
			};
		},
		configure: record('configure'),
		setReasoningEffort: record('setReasoningEffort'),
		cancelTask: record('cancelTask', false),
		sessionArchive: record('sessionArchive', { generations: [] }),
		sessionArchiveGet: record('sessionArchiveGet', null),
		cancel: record('cancel'),
		confirm: record('confirm'),
		setAuto: record('setAuto'),
		answer: record('answer'),
		sessions: record('sessions', [{ id: 'a' }]),
		session: record('session', { id: 'a', messages: [] }),
		search: record('search', [{ id: 'a', snippets: [] }]),
		updateSession: record('updateSession'),
		deleteSession: record('deleteSession'),
		queuePromote: record('queuePromote', true),
	};
	return client;
}

/** A `ConfigStore` over a plain map, so tests never touch real storage. */
function memoryConfig() {
	const map = new Map<string, string>();
	return new ConfigStore({
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
	});
}

function handler(
	client: ReturnType<typeof fakeClient>,
	meta: Record<string, unknown> = {},
	config = memoryConfig(),
	extra: Partial<ShimOptions> = {},
) {
	const handle = createHandler(client as unknown as AgentClient, { meta, config, ...extra });
	return (path: string, init?: RequestInit) =>
		handle(new Request(`http://gw${path}`, init), new URL(`http://gw${path}`).pathname);
}

const post = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(body),
});

describe('routing', () => {
	it('leaves requests outside the prefix to the real fetch', async () => {
		const client = fakeClient();
		const passthrough = vi.fn(async () => new Response('upstream'));
		const uninstall = installFetchShim(client as unknown as AgentClient, { passthrough });

		const res = await fetch('https://example.com/models.json');
		expect(await res.text()).toBe('upstream');
		expect(passthrough).toHaveBeenCalled();
		uninstall();
	});

	it('restores the original fetch on uninstall', () => {
		const before = globalThis.fetch;
		const uninstall = installFetchShim(fakeClient() as unknown as AgentClient, {
			passthrough: before,
		});
		expect(globalThis.fetch).not.toBe(before);
		uninstall();
		expect(globalThis.fetch).toBe(before);
	});

	it('404s an unknown route instead of hanging', async () => {
		const res = await handler(fakeClient())('/api/nope');
		expect(res.status).toBe(404);
	});

	// The console page posts run_python to the device itself, and the shim
	// owns the page's fetch once the AI panel has booted the engine — this is
	// what keeps the prompt working from that moment on.
	it('hands the device its own tool calls, query string and all', async () => {
		const seen: string[] = [];
		const passthrough = (async (input: RequestInfo | URL) => {
			seen.push(input instanceof Request ? input.url : String(input));
			return new Response('{"ok":true}');
		}) as typeof fetch;
		const res = await handler(fakeClient(), {}, memoryConfig(), { passthrough })(
			'/api/tools/call?console=1',
			post({ name: 'run_python', arguments: { code: '1' } }),
		);
		expect(await res.json()).toEqual({ ok: true });
		expect(seen).toEqual(['http://gw/api/tools/call?console=1']);
	});

	it('turns a worker failure into a 500 rather than a rejected promise', async () => {
		const client = fakeClient();
		client.sessions = () => Promise.reject(new Error('worker died'));
		const res = await handler(client)('/api/sessions');
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe('worker died');
	});
});

describe('POST /api/chat', () => {
	it('mints a session id when the client has none, and says a turn is running', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat', post({ message: 'hi', session_id: null }));

		expect(res.headers.get('content-type')).toContain('application/json');
		const ack = await res.json();
		expect(ack.ok).toBe(true);
		expect(ack.running).toBe(true);
		expect(ack.session_id).toBeTruthy();
		// The same id has to reach the worker, or the stream that follows would
		// attach to a different session.
		expect(client.calls.find(([n]) => n === 'send')?.[1][0]).toBe(ack.session_id);
	});

	it('keeps the session id the client supplied', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat', post({ message: 'hi', session_id: 'mine' }));
		expect((await res.json()).session_id).toBe('mine');
	});

	it('answers 409 turn_in_flight, which the client reads as "attach instead"', async () => {
		const client = fakeClient();
		client.sendResult = { accepted: false, reason: 'turn_in_flight' };
		const res = await handler(client)('/api/chat', post({ message: 'hi', session_id: 's' }));

		expect(res.status).toBe(409);
		const ack = await res.json();
		expect(ack.error).toBe('turn_in_flight');
		expect(ack.session_id).toBe('s');
	});

	it('tells the client not to attach when the turn was refused outright', async () => {
		const client = fakeClient();
		client.sendResult = { accepted: false, reason: 'not_configured' };
		const res = await handler(client)('/api/chat', post({ message: 'hi', session_id: 's' }));

		expect(res.status).toBe(400);
		expect((await res.json()).running).toBe(false);
	});

	// "Send when it finishes": the composer's answer to typing during a turn.
	// 200 rather than the 409 the same request gets without `queue`, because the
	// message was accepted — just not started yet.
	it('reports a queued message as queued, with its place in line', async () => {
		const client = fakeClient();
		client.sendResult = { accepted: true, running: true, queued: true, position: 2 };
		const res = await handler(client)(
			'/api/chat',
			post({ message: 'and then this', session_id: 's', queue: true }),
		);

		expect(res.status).toBe(200);
		const ack = await res.json();
		expect(ack).toMatchObject({ ok: true, running: true, queued: true, position: 2 });
		expect(client.calls.find(([n]) => n === 'send')?.[1][2]).toMatchObject({ queue: true });
	});

	// The page's leave guard runs off this: the engine is in the tab, so
	// closing it stops the turn. Only a turn that actually started counts --
	// prompting on the way out of a page where nothing is running is how a
	// guard gets dismissed unread.
	it('reports a started turn to the page, and only a started one', async () => {
		const client = fakeClient();
		const onTurnStarted = vi.fn();
		const send = (body: unknown) => handler(client, {}, memoryConfig(), { onTurnStarted })('/api/chat', post(body));

		await send({ message: 'hi', session_id: 's' });
		expect(onTurnStarted).toHaveBeenCalledTimes(1);

		client.sendResult = { accepted: true, running: true, queued: true, position: 1 };
		await send({ message: 'later', session_id: 's', queue: true });
		client.sendResult = { accepted: false, reason: 'turn_in_flight' };
		await send({ message: 'now', session_id: 's' });
		client.sendResult = { accepted: true, running: false };
		await send({ message: '/reset', session_id: 's' });
		expect(onTurnStarted).toHaveBeenCalledTimes(1);
	});
});

describe('POST /api/chat/steer', () => {
	it('injects the message into the running turn', async () => {
		const client = fakeClient();
		const res = await handler(client)(
			'/api/chat/steer',
			post({ session_id: 's', message: 'actually, this too' }),
		);
		expect(res.status).toBe(200);
		expect(client.calls.find(([n]) => n === 'steer')?.[1]).toEqual(['s', 'actually, this too']);
	});

	// The UI reads any failure as "there was no turn" and sends the message as a
	// normal one, so this must not answer 200 when nothing was steered.
	it('refuses when there is no turn to steer', async () => {
		const client = fakeClient();
		client.steerResult = false;
		const res = await handler(client)('/api/chat/steer', post({ session_id: 's', message: 'hi' }));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe('no_turn_in_flight');
	});
});

describe('POST /api/chat/rewind', () => {
	it('truncates at the message the user chose to edit', async () => {
		const client = fakeClient();
		const res = await handler(client)(
			'/api/chat/rewind',
			post({ session_id: 's', user_index: 1 }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, active_skill: null });
		expect(client.calls.find(([n]) => n === 'rewind')?.[1]).toEqual(['s', 1]);
	});

	it('answers 409 while a turn is running, so the UI says to cancel first', async () => {
		const client = fakeClient();
		client.rewindResult = { ok: false, error: 'turn_in_flight', message: 'cancel it first' };
		const res = await handler(client)('/api/chat/rewind', post({ session_id: 's', user_index: 0 }));
		expect(res.status).toBe(409);
	});

	it('answers 400 for an index that names no message', async () => {
		const client = fakeClient();
		client.rewindResult = { ok: false, error: 'user_index out of range' };
		const res = await handler(client)('/api/chat/rewind', post({ session_id: 's', user_index: 9 }));
		expect(res.status).toBe(400);
	});
});

describe('GET /api/chat/stream/{id}', () => {
	it('is an event stream, which the client checks before reading', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat/stream/abc');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		expect(client.attached[0].session).toBe('abc');
	});

	it('decodes the session id out of the path', async () => {
		const client = fakeClient();
		await handler(client)('/api/chat/stream/a%2Fb');
		expect(client.attached[0].session).toBe('a/b');
	});

	it('delivers frames as they arrive, not once the turn ends', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat/stream/abc');
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		client.attached[0].push('event: content\ndata: {"text":"one"}\n\n');
		const first = await reader.read();
		expect(decoder.decode(first.value)).toContain('"one"');

		// Nothing has been sent since, and the turn has not ended: the stream
		// must still be open and simply have nothing to hand over yet.
		client.attached[0].push('event: content\ndata: {"text":"two"}\n\n');
		const second = await reader.read();
		expect(decoder.decode(second.value)).toContain('"two"');
		expect(second.done).toBe(false);
	});

	it('closes on the terminal frame and releases the subscription', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat/stream/abc');
		const reader = res.body!.getReader();

		client.attached[0].push('event: done\ndata: {"elapsed_ms":12}\n\n');
		await reader.read(); // the done frame itself
		expect((await reader.read()).done).toBe(true);
		expect(client.attached[0].detached).toBe(true);
	});

	it('closes on an error frame too', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat/stream/abc');
		const reader = res.body!.getReader();

		client.attached[0].push('event: error\ndata: {"message":"nope"}\n\n');
		await reader.read();
		expect((await reader.read()).done).toBe(true);
		expect(client.attached[0].detached).toBe(true);
	});

	it('stops the stream when the request is aborted', async () => {
		const client = fakeClient();
		const ac = new AbortController();
		const res = await handler(client)('/api/chat/stream/abc', { signal: ac.signal });
		const reader = res.body!.getReader();

		ac.abort();
		expect((await reader.read()).done).toBe(true);
		expect(client.attached[0].detached).toBe(true);
	});

	it('detaches when the consumer cancels the body', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat/stream/abc');
		await res.body!.cancel();
		expect(client.attached[0].detached).toBe(true);
	});

	it('handles a request that was already aborted before it started', async () => {
		const client = fakeClient();
		const ac = new AbortController();
		ac.abort();
		const res = await handler(client)('/api/chat/stream/abc', { signal: ac.signal });
		expect((await res.body!.getReader().read()).done).toBe(true);
	});

	// The chat UI keeps one of these per open conversation instead of attaching
	// per turn, which is what makes a queued message starting by itself — or a
	// turn sent from another tab — appear on screen at all.
	it('keeps a followed stream open past the end of a turn', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/chat/stream/abc?follow=1');
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		expect(client.attached[0].follow).toBe(true);

		client.attached[0].push('event: done\ndata: {"elapsed_ms":12}\n\n');
		await reader.read();
		expect(
			client.attached[0].detached,
			'a followed stream must survive the turn it attached to',
		).toBe(false);

		// And the next turn's snapshot arrives down the same connection.
		client.attached[0].push('event: session\ndata: {"running":true}\n\n');
		expect(decoder.decode((await reader.read()).value)).toContain('"running":true');
	});

	it('is turn-scoped unless follow was asked for', async () => {
		const client = fakeClient();
		await handler(client)('/api/chat/stream/abc?follow=0');
		expect(client.attached[0].follow).toBe(false);
	});
});

describe('sessions', () => {
	it('lists sessions, and searches when there is a query', async () => {
		const client = fakeClient();
		await handler(client)('/api/sessions');
		expect(client.calls.map(([n]) => n)).toContain('sessions');

		await handler(client)('/api/sessions?q=bridge');
		const search = client.calls.find(([n]) => n === 'search');
		expect(search?.[1][0]).toBe('bridge');
	});

	it('treats a blank query as a plain list', async () => {
		const client = fakeClient();
		await handler(client)('/api/sessions?q=%20%20');
		expect(client.calls.map(([n]) => n)).toEqual(['sessions']);
	});

	it('reads, patches and deletes one session', async () => {
		const client = fakeClient();
		expect((await handler(client)('/api/sessions/abc')).status).toBe(200);

		await handler(client)('/api/sessions/abc', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'renamed', pinned: true }),
		});
		expect(client.calls.find(([n]) => n === 'updateSession')?.[1]).toEqual([
			'abc',
			{ title: 'renamed', pinned: true, archived: undefined, category: undefined },
		]);

		await handler(client)('/api/sessions/abc', { method: 'DELETE' });
		expect(client.calls.find(([n]) => n === 'deleteSession')?.[1]).toEqual(['abc']);
	});

	it('patches archive and category flags, clearing the category with null', async () => {
		const client = fakeClient();
		await handler(client)('/api/sessions/abc', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ archived: true, category: 'work' }),
		});
		expect(client.calls.find(([n]) => n === 'updateSession')?.[1]).toEqual([
			'abc',
			{ title: undefined, pinned: undefined, archived: true, category: 'work' },
		]);
		client.calls.length = 0;
		await handler(client)('/api/sessions/abc', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ category: null }),
		});
		expect(client.calls.find(([n]) => n === 'updateSession')?.[1]).toEqual([
			'abc',
			{ title: undefined, pinned: undefined, archived: undefined, category: null },
		]);
		// Over-long labels are refused up front rather than silently dropped.
		const res = await handler(client)('/api/sessions/abc', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ category: 'x'.repeat(65) }),
		});
		expect(res.status).toBe(400);
	});

	it('lists sessions by scope and rejects an unknown one', async () => {
		const client = fakeClient();
		await handler(client)('/api/sessions');
		expect(client.calls.find(([n]) => n === 'sessions')?.[1]).toEqual([undefined]);
		client.calls.length = 0;
		await handler(client)('/api/sessions?scope=archived');
		expect(client.calls.find(([n]) => n === 'sessions')?.[1]).toEqual(['archived']);
		const bad = await handler(client)('/api/sessions?scope=bogus');
		expect(bad.status).toBe(400);
		expect((await bad.json()).error).toBe('invalid_scope');
	});

	it('404s a session that is gone', async () => {
		const client = fakeClient();
		client.session = () => Promise.resolve(null);
		expect((await handler(client)('/api/sessions/gone')).status).toBe(404);
	});
});

describe('control endpoints', () => {
	it('passes confirm through with the auto flag', async () => {
		const client = fakeClient();
		await handler(client)(
			'/api/chat/confirm',
			post({ session_id: 's', confirmed: true, auto: true }),
		);
		expect(client.calls.find(([n]) => n === 'confirm')?.[1]).toEqual([
			's',
			true,
			true,
			undefined,
			undefined,
		]);
	});

	// A sub-agent's confirm bar is the parent's bar: the request reaches the UI
	// unwrapped so the existing bar needs no changes, which leaves the tool-call
	// id as the only thing saying whose approval this is.
	it('carries the tool-call id the confirm bar was answering', async () => {
		const client = fakeClient();
		await handler(client)(
			'/api/chat/confirm',
			post({ session_id: 's', id: 'call_7', confirmed: true }),
		);
		expect(client.calls.find(([n]) => n === 'confirm')?.[1][4]).toBe('call_7');
	});

	it('carries the arguments the user edited in the confirm bar', async () => {
		const client = fakeClient();
		await handler(client)(
			'/api/chat/confirm',
			post({ session_id: 's', confirmed: true, amended_args: { path: '/runtime/drafts/a.md' } }),
		);
		// Serialised, because that is what crosses to the worker; dropping it
		// would run the call the model asked for rather than the one approved.
		expect(client.calls.find(([n]) => n === 'confirm')?.[1]).toEqual([
			's',
			true,
			false,
			'{"path":"/runtime/drafts/a.md"}',
			undefined,
		]);
	});

	it('turns full-auto on for a session rather than pretending to', async () => {
		const client = fakeClient();
		const res = await handler(client)(
			'/api/chat/auto',
			post({ session_id: 's', enabled: true }),
		);
		expect(await res.json()).toEqual({ ok: true, enabled: true });
		expect(client.calls.find(([n]) => n === 'setAuto')?.[1]).toEqual(['s', true]);
	});

	it('applies the composer full-auto toggle only to a session it creates', async () => {
		const client = fakeClient();
		await handler(client)('/api/chat', post({ message: 'hi', session_id: null, full_auto: true }));
		const auto = client.calls.find(([n]) => n === 'setAuto');
		expect(auto?.[1][1]).toBe(true);
		// Same session the turn went to, and before the send.
		expect(auto?.[1][0]).toBe(client.calls.find(([n]) => n === 'send')?.[1][0]);
		expect(client.calls.findIndex(([n]) => n === 'setAuto')).toBeLessThan(
			client.calls.findIndex(([n]) => n === 'send'),
		);
		client.calls.length = 0;
		await handler(client)('/api/chat', post({ message: 'hi', session_id: 'old', full_auto: true }));
		expect(client.calls.find(([n]) => n === 'setAuto')).toBeUndefined();
	});

	it('promotes a queued message and 404s one that is no longer parked', async () => {
		const client = fakeClient();
		const res = await handler(client)(
			'/api/chat/queue/promote',
			post({ session_id: 's', id: 7 }),
		);
		expect(await res.json()).toEqual({ ok: true });
		expect(client.calls.find(([n]) => n === 'queuePromote')?.[1]).toEqual(['s', 7]);
		client.queuePromote = () => Promise.resolve(false);
		const gone = await handler(client)('/api/chat/queue/promote', post({ session_id: 's', id: 8 }));
		expect(gone.status).toBe(404);
	});

	it('sends a cancelled ask_user as no answers', async () => {
		const client = fakeClient();
		await handler(client)(
			'/api/chat/answer',
			post({ session_id: 's', answers: [{ question_id: 'q' }], cancelled: true }),
		);
		expect(client.calls.find(([n]) => n === 'answer')?.[1]).toEqual(['s', []]);
	});

	it('cancels a turn', async () => {
		const client = fakeClient();
		await handler(client)('/api/chat/cancel', post({ session_id: 's' }));
		expect(client.calls.find(([n]) => n === 'cancel')?.[1]).toEqual(['s']);
	});

	it('reports the protocol version in meta, which the UI probes at boot', async () => {
		const res = await handler(fakeClient(), { version: '0.1.0' })('/api/chat/meta');
		expect(res.headers.get('content-type')).toContain('application/json');
		const meta = await res.json();
		expect(meta.protocol).toBe(2);
		expect(meta.version).toBe('0.1.0');
	});

	it('answers boot probes with empty lists so the UI hides those features', async () => {
		const h = handler(fakeClient());
		for (const path of ['/api/models', '/api/tools']) {
			const res = await h(path);
			expect(res.status, path).toBe(200);
			expect((await res.json()).ok, path).toBe(true);
		}
	});
});

describe('attachments', () => {
	const upload = (body: BodyInit, type: string, name?: string): RequestInit => ({
		method: 'POST',
		headers: { 'Content-Type': type, ...(name ? { 'X-File-Name': encodeURIComponent(name) } : {}) },
		body,
	});

	it('stores the body and answers with the reference the next message carries', async () => {
		const client = fakeClient();
		const h = handler(client);

		const res = await h('/api/chat/upload', upload('# notes\n', 'text/markdown', 'notes.md'));
		const result = await res.json();
		expect(res.status).toBe(200);
		expect(result.id).toBeTruthy();
		expect(result.kind).toBe('file');

		const [name, mime, bytes] = client.calls.find(([n]) => n === 'upload')![1] as [
			string,
			string,
			Uint8Array,
		];
		expect(name, 'the name is percent-encoded in the header and decoded here').toBe('notes.md');
		expect(mime).toBe('text/markdown');
		expect(new TextDecoder().decode(bytes)).toBe('# notes\n');
	});

	it('decodes a non-ASCII name, which is the only reason the header is encoded', async () => {
		const client = fakeClient();
		await handler(client)('/api/chat/upload', upload('x', 'text/plain', '报告.txt'));
		expect((client.calls.find(([n]) => n === 'upload')![1] as string[])[0]).toBe('报告.txt');
	});

	// The UI shows this message to the user verbatim, so the status and the
	// reason both have to survive the trip.
	it('passes a refusal through with the status the engine chose', async () => {
		const client = fakeClient();
		client.uploadResult = { ok: false, status: 413, error: 'image exceeds 10MB' };

		const res = await handler(client)('/api/chat/upload', upload('x', 'image/png'));
		expect(res.status).toBe(413);
		expect((await res.json()).error).toBe('image exceeds 10MB');
	});

	it('serves an image back as itself, so the transcript can render it', async () => {
		const client = fakeClient();
		const h = handler(client);
		const { id } = await (await h('/api/chat/upload', upload('PNG', 'image/png', 'shot.png'))).json();

		const res = await h(`/api/chat/upload/${id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(
			res.headers.get('Content-Disposition'),
			'an image that downloads instead of rendering is a broken thumbnail',
		).toBeNull();
		expect(await res.text()).toBe('PNG');
	});

	it('serves anything else as a download under its original name', async () => {
		const client = fakeClient();
		const h = handler(client);
		const { id } = await (await h('/api/chat/upload', upload('data', 'application/pdf'))).json();

		const res = await h(`/api/chat/upload/${id}?name=${encodeURIComponent('报告.pdf')}`);
		const disposition = res.headers.get('Content-Disposition') ?? '';
		expect(disposition).toContain('attachment');
		// Headers are ASCII: the readable name rides `filename*`, and the
		// fallback must not carry raw non-ASCII bytes.
		expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('报告.pdf')}`);
		expect(/filename="[\x20-\x7e]*"/.test(disposition), disposition).toBe(true);
	});

	it('404s an upload that is no longer there rather than serving nothing', async () => {
		const res = await handler(fakeClient())(`/api/chat/upload/${'b'.repeat(32)}.png`);
		expect(res.status).toBe(404);
	});

	// A list built by the UI and dropped here would leave the attach button
	// looking like it worked while the model saw nothing.
	it('carries the message its attachments', async () => {
		const client = fakeClient();
		await handler(client)(
			'/api/chat',
			post({ session_id: 's', message: 'what is this', attachments: [{ id: 'x.png', name: 'x' }] }),
		);
		const [, , options] = client.calls.find(([n]) => n === 'send')![1] as [string, string, any];
		expect(options.attachments).toEqual([{ id: 'x.png', name: 'x' }]);
	});
});

describe('skills', () => {
	const zip = (): RequestInit => ({
		method: 'POST',
		headers: { 'Content-Type': 'application/zip' },
		body: new Uint8Array([0x50, 0x4b, 3, 4]),
	});

	it('lists what is installed, with the diagnostics the palette shows', async () => {
		const client = fakeClient();
		client.installed = [{ name: 'demo', version: '1.0.0' }];
		const body = await (await handler(client)('/api/skills')).json();
		expect(body.skills).toHaveLength(1);
		expect(body.diagnostics).toEqual([]);
	});

	it('serves the readme as markdown, not as JSON', async () => {
		const res = await handler(fakeClient())('/api/skills/demo/readme');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/markdown');
		expect(await res.text()).toBe('# demo\n');
	});

	// The detail panel reads a 404 as "this skill ships no changelog" and hides
	// the tab; an empty 200 would leave an empty tab instead.
	it('404s a changelog the skill does not have', async () => {
		const res = await handler(fakeClient())('/api/skills/demo/changelog');
		expect(res.status).toBe(404);
	});

	it('serves the icon as an image', async () => {
		const res = await handler(fakeClient())('/api/skills/demo/icon');
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(await res.text()).toBe('PNG');
	});

	it('carries each switch through under its own name', async () => {
		const client = fakeClient();
		const h = handler(client);
		for (const flag of ['enabled', 'pinned', 'shared']) {
			await h(`/api/skills/demo/${flag}`, post({ [flag]: false }));
		}
		expect(client.calls.filter(([n]) => n === 'setSkillFlag').map(([, a]) => a)).toEqual([
			['demo', 'enabled', false],
			['demo', 'pinned', false],
			['demo', 'shared', false],
		]);
	});

	it('decodes a name out of the path before asking about it', async () => {
		const client = fakeClient();
		await handler(client)(`/api/skills/${encodeURIComponent('中文技能')}`, { method: 'DELETE' });
		expect(client.calls.find(([n]) => n === 'deleteSkill')?.[1]).toEqual(['中文技能']);
	});

	it('hands an imported package to the engine as bytes', async () => {
		const client = fakeClient();
		const res = await handler(client)('/api/skills/import', zip());
		expect(res.status).toBe(200);
		expect((await res.json()).name).toBe('demo');
		const [bytes] = client.calls.find(([n]) => n === 'importSkill')![1] as [Uint8Array];
		expect(Array.from(bytes)).toEqual([0x50, 0x4b, 3, 4]);
	});

	// The UI puts this message in front of the user, so the engine's reason has
	// to reach it rather than becoming a generic failure.
	it('passes a refused package through with its status', async () => {
		const client = fakeClient();
		client.skillOutcome = { ok: false, status: 400, error: 'invalid SKILL.md' };
		const res = await handler(client)('/api/skills/import', zip());
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid SKILL.md');
	});
});

describe('the skills market', () => {
	const index = {
		generated_at: '2026-01-01T00:00:00Z',
		skills: [
			{ name: 'demo', version: '2.0.0', url: 'demo-2.0.0.zip' },
			{ name: 'other', version: '1.0.0', url: 'other-1.0.0.zip' },
			// What the real hub carries: skills that drive a gateway's Linux
			// CLIs, and skills written for either runtime. The two above
			// declare nothing, which is how a generic skill says "anywhere".
			{ name: 'shell-only', version: '1.0.0', url: 'shell-only-1.0.0.zip', env: ['gateway'] },
			{ name: 'both', version: '1.0.0', url: 'both-1.0.0.zip', env: ['gateway', 'MPY'] },
		],
	};

	/** A repository over `fetch`, and a record of what was asked of it. */
	function repo() {
		const asked: string[] = [];
		const passthrough = (async (input: RequestInfo | URL) => {
			const url = String(input);
			asked.push(url);
			if (url.endsWith('index.json')) return new Response(JSON.stringify(index));
			if (url.endsWith('.zip')) return new Response(new Uint8Array([0x50, 0x4b, 3, 4]));
			return new Response('nope', { status: 404 });
		}) as typeof fetch;
		return { asked, passthrough };
	}

	// The UI reads 404 as "this agent has no repository" and hides the tab.
	// An empty list would leave an empty tab that looks broken instead.
	it('404s when no repository is configured', async () => {
		const res = await handler(fakeClient())('/api/skills/market');
		expect(res.status).toBe(404);
	});

	// version.sh is read as text by the build, so a line written as
	// `SKILLS_REPO=${SKILLS_REPO:-http://…}` once reached the bundle
	// unexpanded. Resolved against the page's origin, that had the market
	// asking the gateway for `/$%7BSKILLS_REPO:-…%7D/index.json`. The build now
	// refuses such a value; this is the second door, for anything that gets a
	// repository from somewhere else.
	it('ignores a repository that is not an absolute address', async () => {
		const { asked, passthrough } = repo();
		for (const bad of ['${SKILLS_REPO:-http://skills.example.com}', '/skills', 'skills.example.com']) {
			const h = handler(fakeClient(), {}, memoryConfig(), { skillsRepo: bad, passthrough });
			expect((await h('/api/skills/market')).status, bad).toBe(404);
		}
		expect(asked, 'nothing should have been requested at all').toHaveLength(0);
	});

	it('merges what is installed into the index, so the button says the truth', async () => {
		const client = fakeClient();
		client.installed = [{ name: 'demo', version: '1.0.0' }];
		const { passthrough } = repo();
		const h = handler(client, {}, memoryConfig(), { skillsRepo: 'http://repo/skills/', passthrough });

		const body = await (await h('/api/skills/market')).json();
		expect(body.repo, 'the UI resolves icon URLs against this').toBe('http://repo/skills');
		expect(body.skills[0]).toMatchObject({ installed_version: '1.0.0', update_available: true });
		expect(body.skills[1]).toMatchObject({ installed_version: null, update_available: false });
	});

	it('downloads the package and installs it through the engine', async () => {
		const client = fakeClient();
		const { asked, passthrough } = repo();
		const h = handler(client, {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });

		const res = await h('/api/skills/market/install', post({ name: 'demo' }));
		expect(res.status).toBe(200);
		expect(asked, 'the package URL is relative to the index').toContain('http://repo/demo-2.0.0.zip');
		expect(client.calls.some(([n]) => n === 'importSkill')).toBe(true);
	});

	// The environment check upstream runs in its server: without it every
	// entry looked installable here, so the hub's gateway skills were offered
	// by a page whose only runtime is the firmware's MicroPython sandbox.
	it('marks the entries whose env excludes this agent', async () => {
		const { passthrough } = repo();
		const h = handler(fakeClient(), {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });

		const body = await (await h('/api/skills/market')).json();
		const mismatch = new Map(body.skills.map((s: any) => [s.name, s.env_mismatch]));
		expect(mismatch.get('shell-only'), 'gateway CLIs cannot run in the sandbox').toBe(true);
		expect(mismatch.get('both'), 'declaring mpy as well is an overlap, case aside').toBe(false);
		expect(mismatch.get('demo'), 'an entry declaring no env runs anywhere').toBe(false);
	});

	it('refuses to install a skill built for another environment', async () => {
		const client = fakeClient();
		const { asked, passthrough } = repo();
		const h = handler(client, {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });

		const res = await h('/api/skills/market/install', post({ name: 'shell-only' }));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/\[gateway\].*\[mpy\]/);
		expect(asked.some((u) => u.endsWith('.zip')), 'refused before downloading').toBe(false);
		expect(client.calls.some(([n]) => n === 'importSkill')).toBe(false);
	});

	// Reading is not installing: what a skill is for is worth showing even
	// where it cannot run, if only to explain why it is not on offer.
	it('still previews a skill it would refuse to install', async () => {
		const client = fakeClient();
		const { passthrough } = repo();
		const h = handler(client, {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });

		const res = await h('/api/skills/market/shell-only/preview');
		expect(res.status).toBe(200);
		expect((await res.json()).readme).toBe('# demo\n');
	});

	it('previews a package without installing it', async () => {
		const client = fakeClient();
		const { passthrough } = repo();
		const h = handler(client, {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });

		const body = await (await h('/api/skills/market/demo/preview')).json();
		expect(body.readme).toBe('# demo\n');
		expect(client.calls.some(([n]) => n === 'importSkill'), 'a preview must not install').toBe(false);
	});

	it('404s a name the repository does not carry', async () => {
		const { passthrough } = repo();
		const h = handler(fakeClient(), {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });
		expect((await h('/api/skills/market/ghost/preview')).status).toBe(404);
	});

	it('reads the index once and reuses it', async () => {
		const { asked, passthrough } = repo();
		const h = handler(fakeClient(), {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });

		await h('/api/skills/market');
		await h('/api/skills/market');
		expect(asked.filter((u) => u.endsWith('index.json'))).toHaveLength(1);
	});

	// A repository that is down must not look like a repository that is empty:
	// the UI would tell the user there is nothing to install.
	it('reports an unreachable repository rather than an empty one', async () => {
		const passthrough = (async () => new Response('', { status: 500 })) as typeof fetch;
		const h = handler(fakeClient(), {}, memoryConfig(), { skillsRepo: 'http://repo', passthrough });
		expect((await h('/api/skills/market')).status).toBe(502);
	});
});

describe('installing from an address the user pasted', () => {
	// Works without a repository configured: this is the other half of the
	// skills page toolbar, and it names its own host.
	it('downloads it and installs it through the engine', async () => {
		const client = fakeClient();
		const asked: string[] = [];
		const passthrough = (async (input: RequestInfo | URL) => {
			asked.push(String(input));
			return new Response(new Uint8Array([0x50, 0x4b, 3, 4]));
		}) as typeof fetch;
		const h = handler(client, {}, memoryConfig(), { passthrough });

		const res = await h('/api/skills/install-url', post({ url: 'http://elsewhere/demo.zip' }));
		expect(res.status).toBe(200);
		expect(asked).toEqual(['http://elsewhere/demo.zip']);
		expect(client.calls.some(([n]) => n === 'importSkill')).toBe(true);
	});

	// A pasted link is a download, not a way to reach for something local.
	it('refuses a scheme that is not http', async () => {
		const client = fakeClient();
		const h = handler(client, {}, memoryConfig(), {
			passthrough: (async () => new Response('')) as typeof fetch,
		});

		for (const url of ['file:///etc/passwd', 'data:application/zip;base64,UEsDBA==', '']) {
			expect((await h('/api/skills/install-url', post({ url }))).status).toBe(400);
		}
		expect(client.calls.some(([n]) => n === 'importSkill')).toBe(false);
	});

	// The page fetches this itself, so a host without CORS is indistinguishable
	// from a host that is down -- and both have to be reported rather than
	// leaving a spinner or a silent no-op.
	it('reports a download it could not make', async () => {
		const h = handler(fakeClient(), {}, memoryConfig(), {
			passthrough: (async () => {
				throw new TypeError('Failed to fetch');
			}) as typeof fetch,
		});

		const res = await h('/api/skills/install-url', post({ url: 'http://blocked/demo.zip' }));
		expect(res.status).toBe(502);
		expect((await res.json()).error, 'the CORS case has to be named; it is the likely one').toMatch(
			/Access-Control-Allow-Origin/,
		);
	});

	it('reports a package the host answered with an error', async () => {
		const h = handler(fakeClient(), {}, memoryConfig(), {
			passthrough: (async () => new Response('', { status: 404 })) as typeof fetch,
		});
		expect((await h('/api/skills/install-url', post({ url: 'http://host/gone.zip' }))).status).toBe(502);
	});
});

describe('the write/edit allow-list', () => {
	// Without this the confirm bar's "allow this folder" button is decoration:
	// the UI sends the directory and nothing on this side reads it.
	it('learns the folder the confirm bar sent, and only on approval', async () => {
		const client = fakeClient();
		const h = handler(client);

		await h('/api/chat/confirm', post({ session_id: 's', confirmed: true, allow_dir: '/skills' }));
		expect(client.calls.find(([n]) => n === 'allowDir')?.[1]).toEqual(['/skills']);

		client.calls.length = 0;
		await h('/api/chat/confirm', post({ session_id: 's', confirmed: false, allow_dir: '/etc' }));
		expect(
			client.calls.some(([n]) => n === 'allowDir'),
			'a declined call must not still trust the folder',
		).toBe(false);
	});

	it('ignores the field when the UI sends it empty or as null', async () => {
		const client = fakeClient();
		const h = handler(client);
		await h('/api/chat/confirm', post({ session_id: 's', confirmed: true, allow_dir: null }));
		await h('/api/chat/confirm', post({ session_id: 's', confirmed: true, allow_dir: '  ' }));
		expect(client.calls.some(([n]) => n === 'allowDir')).toBe(false);
	});

	it('lists what has been allowed, and takes one back or all of them', async () => {
		const client = fakeClient();
		const h = handler(client);
		client.dirs = ['/skills', '/notes'];

		const listed = await (await h('/api/safe-paths')).json();
		expect(listed.learned).toEqual(['/skills', '/notes']);
		expect(listed.max, 'the panel shows this as a capacity').toBeGreaterThan(0);

		expect((await (await h('/api/safe-paths?dir=/notes', { method: 'DELETE' })).json()).learned)
			.toEqual(['/skills']);
		expect((await (await h('/api/safe-paths', { method: 'DELETE' })).json()).learned).toEqual([]);
	});

	it('answers the command allow-list empty rather than 404, since run_shell is not here', async () => {
		const res = await handler(fakeClient())('/api/safe-commands');
		expect(res.status).toBe(200);
		expect((await res.json()).learned).toEqual([]);
	});
});

describe('the runtime cache card', () => {
	it('passes a single category through, so a row can refresh itself alone', async () => {
		const client = fakeClient();
		const h = handler(client);

		expect((await (await h('/api/runtime/stat')).json()).root).toBe('/runtime');
		expect(client.calls.at(-1)).toEqual(['runtimeStat', [undefined]]);

		await h('/api/runtime/stat?category=drafts');
		expect(client.calls.at(-1)).toEqual(['runtimeStat', ['drafts']]);
	});

	it('clears what was named, and reads a bodiless request as "all of it"', async () => {
		const client = fakeClient();
		const h = handler(client);

		const res = await h('/api/runtime/clear', post({ categories: ['drafts'] }));
		expect((await res.json()).reclaimed_bytes).toBe(128);
		expect(client.calls.at(-1)).toEqual(['runtimeClear', [['drafts']]]);

		// The card always sends a body, but a request without one must not
		// throw its way out of the shim as a 500 -- an empty list is what the
		// route means by "everything".
		await h('/api/runtime/clear', { method: 'POST' });
		expect(client.calls.at(-1)).toEqual(['runtimeClear', [[]]]);
	});
});

describe('the model picker', () => {
	// The composer's badge hangs entirely on `meta.model` being truthy, and it
	// only becomes a picker when `/api/models` is non-empty as well. Both halves
	// are checked here because either one alone renders nothing.
	it('puts the configured model in meta, which is what draws the badge', async () => {
		const config = memoryConfig();
		config.save({ base_url: 'https://one/v1', model: 'deepseek-chat' });
		expect((await (await handler(fakeClient(), {}, config)('/api/chat/meta')).json()).model).toBe(
			'deepseek-chat',
		);
	});

	it('leaves the field out entirely when nothing is configured', async () => {
		const meta = await (await handler(fakeClient())('/api/chat/meta')).json();
		expect('model' in meta, 'an empty string would draw an empty chip').toBe(false);
	});

	it('tells the UI whether new chats start in full-auto, and follows the settings panel', async () => {
		const config = memoryConfig();
		const h = handler(fakeClient(), {}, config);
		// Unset reads as an explicit false: the UI compares `=== true`.
		expect((await (await h('/api/chat/meta')).json()).config).toEqual({ default_full_auto: false });

		await h('/api/config', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ base_url: 'https://one/v1', model: 'm', api_key: '', default_full_auto: true }),
		});
		expect((await (await h('/api/chat/meta')).json()).config).toEqual({ default_full_auto: true });
	});

	it('follows the settings panel without a reload', async () => {
		const config = memoryConfig();
		const h = handler(fakeClient(), {}, config);
		await h(
			'/api/config',
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ base_url: 'https://one/v1', model: 'first', api_key: 'k' }),
			},
		);
		expect((await (await h('/api/chat/meta')).json()).model).toBe('first');

		await h('/api/config', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ base_url: 'https://one/v1', model: 'second', api_key: '' }),
		});
		expect((await (await h('/api/chat/meta')).json()).model).toBe('second');
	});

	it('reports what the endpoint advertises', async () => {
		const client = fakeClient();
		client.modelList = ['a', 'b'];
		const body = await (await handler(client)('/api/models')).json();
		expect(body.models).toEqual(['a', 'b']);
	});

	it('carries the chosen model into the turn', async () => {
		const client = fakeClient();
		await handler(client)('/api/chat', post({ message: 'hi', session_id: 's', model: 'other' }));
		expect(client.calls.find(([n]) => n === 'send')?.[1][2]).toMatchObject({ model: 'other' });
	});

	it('sends no model when the picker was never touched', async () => {
		const client = fakeClient();
		await handler(client)('/api/chat', post({ message: 'hi', session_id: 's' }));
		expect((client.calls.find(([n]) => n === 'send')?.[1][2] as { model?: string }).model)
			.toBeUndefined();
	});

	// The console's assistant panel tags its messages `origin: "terminal"`;
	// the engine writes it on the session's first save and the sessions page
	// draws its glyph from it. The main chat sends nothing and stays `web`.
	it('carries the origin into the turn, and only when one was named', async () => {
		const client = fakeClient();
		const h = handler(client);
		await h('/api/chat', post({ message: 'hi', session_id: 't', origin: 'terminal' }));
		expect(client.calls.find(([n]) => n === 'send')?.[1][2]).toMatchObject({ origin: 'terminal' });

		client.calls.length = 0;
		await h('/api/chat', post({ message: 'hi', session_id: 's' }));
		expect((client.calls.find(([n]) => n === 'send')?.[1][2] as { origin?: string }).origin)
			.toBeUndefined();
	});
});

describe('/api/config', () => {
	const put = (body: unknown): RequestInit => ({
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	it('never hands the stored key back to the form', async () => {
		const client = fakeClient();
		const config = memoryConfig();
		const h = handler(client, {}, config);

		await h('/api/config', put({ base_url: 'https://api.example.com/v1', model: 'm', api_key: 'sk-secret' }));

		const shown = await (await h('/api/config')).json();
		expect(shown.api_key).toBe('');
		// ...but does say one is there, so the form can tell "stored" from
		// "never set" without seeing it.
		expect(shown.api_key_set).toBe(true);
		expect(shown.base_url).toBe('https://api.example.com/v1');
		// But the engine did get the real one.
		expect(client.calls.find(([n]) => n === 'configure')?.[1]).toEqual([
			'https://api.example.com/v1',
			'sk-secret',
			'm',
		]);
	});

	it('keeps the stored key when the form submits a blank one', async () => {
		const client = fakeClient();
		const config = memoryConfig();
		const h = handler(client, {}, config);

		await h('/api/config', put({ base_url: 'https://one/v1', model: 'm', api_key: 'sk-secret' }));
		// The user edits the model; the key field is blank because it was never
		// shown to them. It must survive.
		await h('/api/config', put({ base_url: 'https://one/v1', model: 'other', api_key: '' }));

		expect(config.load().api_key).toBe('sk-secret');
		expect(config.load().model).toBe('other');
	});

	it('applies a saved config to the engine at once, with no restart to wait for', async () => {
		const client = fakeClient();
		const res = await handler(client)(
			'/api/config',
			put({ base_url: 'https://api.example.com/v1', model: 'm', api_key: 'k' }),
		);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.restarting).toBe(false);
		expect(client.calls.some(([n]) => n === 'configure')).toBe(true);
	});

	it('serves an empty config before anything is set, so the form is editable', async () => {
		const cfg = await (await handler(fakeClient())('/api/config')).json();
		expect(cfg.enabled).toBe(true);
		expect(cfg.base_url).toBe('');
		expect(cfg.api_key_set).toBe(false);
	});

	it('does not persist the api_key_set annotation a form round-trips', async () => {
		const config = memoryConfig();
		const h = handler(fakeClient(), {}, config);
		await h('/api/config', put({ base_url: 'https://one/v1', model: 'm', api_key: '', api_key_set: true }));
		expect('api_key_set' in config.load()).toBe(false);
		expect(config.sanitized().api_key_set).toBe(false);
	});

	it('survives corrupt storage rather than bricking the page', async () => {
		const map = new Map<string, string>([['vinx.web.config', 'not json']]);
		const config = new ConfigStore({
			getItem: (k) => map.get(k) ?? null,
			setItem: (k, v) => void map.set(k, v),
		});
		expect(config.load().base_url).toBe('');
		expect(config.usable()).toBe(false);
	});

	it('is only usable once an endpoint and a model are set', () => {
		const config = memoryConfig();
		expect(config.usable()).toBe(false);
		config.save({ base_url: 'https://one/v1' });
		expect(config.usable(), 'a base url alone is not enough').toBe(false);
		config.save({ model: 'm' });
		expect(config.usable()).toBe(true);
		config.save({ enabled: false });
		expect(config.usable(), 'a disabled agent must not be treated as ready').toBe(false);
	});
});

describe('themes', () => {
	const put = (body: unknown): RequestInit => ({
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	it('serves only the active look, because the UI injects one stylesheet', async () => {
		const client = fakeClient();
		const h = handler(client);

		await h('/api/themes/dusk', put({ css: 'body{color:red}', js: '', session_id: 's' }));
		await h('/api/themes/dawn', put({ css: 'body{color:blue}', js: '' }));
		expect((await (await h('/api/themes')).json()).themes).toHaveLength(0);

		await h('/api/themes/active', put({ name: 'dusk' }));
		const shown = (await (await h('/api/themes')).json()).themes;
		expect(shown).toHaveLength(1);
		expect(shown[0].name).toBe('dusk');
	});

	it('carries the owning session to the engine, as the tool path does', async () => {
		const client = fakeClient();
		await handler(client)('/api/themes/dusk', put({ css: 'a{}', js: 'b', session_id: 's1' }));
		expect(client.calls.find(([n]) => n === 'saveTheme')?.[1]).toEqual(['dusk', 'a{}', 'b', 's1']);
	});

	it('restores the built-in look without deleting anything', async () => {
		const client = fakeClient();
		const h = handler(client);
		await h('/api/themes/dusk', put({ css: 'a{}' }));
		await h('/api/themes/active', put({ name: 'dusk' }));

		await h('/api/themes/active', { method: 'DELETE' });
		expect((await (await h('/api/themes')).json()).themes).toHaveLength(0);
		expect((await (await h('/api/releases?kind=theme')).json()).releases).toHaveLength(1);
	});

	it('reports the engine status when a look is gone', async () => {
		const res = await handler(fakeClient())('/api/themes/active', put({ name: 'nope' }));
		expect(res.status).toBe(404);
	});

	it('decodes a name the URL escaped, or the card cannot be saved', async () => {
		const client = fakeClient();
		const name = encodeURIComponent('午夜');
		await handler(client)(`/api/themes/${name}`, put({ css: 'a{}' }));
		expect((client.calls.find(([n]) => n === 'saveTheme')?.[1] as string[])[0]).toBe('午夜');
	});

	it('lists saved looks under releases, where the themes page reads them', async () => {
		const client = fakeClient();
		const h = handler(client);
		await h('/api/themes/dusk', put({ css: 'a{}' }));

		const themed = await (await h('/api/releases?kind=theme')).json();
		expect(themed.releases.map((r: { name: string }) => r.name)).toEqual(['dusk']);
		// Nothing else can be published from a page, so every other kind is
		// empty rather than missing.
		expect((await (await h('/api/releases?kind=app')).json()).releases).toEqual([]);
	});

	it('deletes a saved look', async () => {
		const client = fakeClient();
		await handler(client)(`/api/releases/theme/${encodeURIComponent('午夜')}`, {
			method: 'DELETE',
		});
		expect(client.calls.find(([n]) => n === 'deleteTheme')?.[1]).toEqual(['午夜']);
	});
});

describe('boot probes', () => {
	it('answers with empty lists so the UI hides features that do not exist yet', async () => {
		const h = handler(fakeClient());
		// Every one of these is requested at boot; a 404 makes the UI report a
		// broken backend instead of quietly hiding the feature.
		for (const path of ['/api/models', '/api/tools']) {
			const res = await h(path);
			expect(res.status, path).toBe(200);
			expect((await res.json()).ok, path).toBe(true);
		}
	});

	it('keeps the apps repository a 404, which is how the UI hides that tab', async () => {
		const res = await handler(fakeClient())('/api/apps/market');
		expect(res.status).toBe(404);
	});

	// A pasted package URL names the app after its file — minus the hub's
	// dotted version, and minus a query string or fragment, which are not
	// part of the name (a signed CDN link would otherwise fall back to the
	// timestamp name).
	it('names an installed .vapp after the URL file name, query and fragment stripped', async () => {
		const put: string[] = [];
		const ran: string[] = [];
		const vmApps = {
			list: async () => [],
			cli: async (args: string) => {
				ran.push(args);
				return 'installed /data/apps/demoweb.vapp\n';
			},
			putFile: async (path: string) => void put.push(path),
		};
		const h = handler(fakeClient(), {}, memoryConfig(), {
			vmApps,
			passthrough: (async () => new Response(new Uint8Array([0x1f, 0x8b, 8, 0]))) as typeof fetch,
		});
		const res = await h(
			'/api/apps/install-url',
			post({ url: 'http://hub/packages/DemoWeb.1.2.0.vapp?sig=abc&t=1#frag' }),
		);
		expect(res.status).toBe(200);
		expect(put).toEqual(['.vinx/tmp/demoweb.vapp']);
		expect(ran).toEqual(['install /data/.vinx/tmp/demoweb.vapp']);
		expect((await res.json()).name).toBe('demoweb');
	});

	// A machine the person left powered off refuses every route into it
	// with a MachineOffError (app/vm.ts whenUp); the shim turns that into
	// 503 + a stable code, so the Apps page can say it in their language
	// instead of showing the bridge's English. Any other failure keeps the
	// guest's own words at 500.
	it('answers MACHINE_OFF for a machine the person left off, and the guest’s words otherwise', async () => {
		const off = Object.assign(new Error('the machine is powered off — the power key boots it'), {
			name: 'MachineOffError',
		});
		const vmApps = {
			list: async () => [],
			cli: async (args: string) => {
				if (args.startsWith('start ')) throw off;
				throw new Error('app: demo is a pure web app (no backend)');
			},
			putFile: async () => {
				throw off;
			},
		};
		const h = handler(fakeClient(), {}, memoryConfig(), { vmApps });
		const start = await h('/api/releases/app/demo/start', { method: 'POST' });
		expect(start.status).toBe(503);
		expect(await start.json()).toEqual({ error: off.message, code: 'MACHINE_OFF' });
		const install = await h('/api/apps/install', {
			method: 'POST',
			headers: { 'x-file-name': 'demo.vapp' },
			body: new Uint8Array([1, 2, 3]),
		});
		expect(install.status).toBe(503);
		expect((await install.json()).code).toBe('MACHINE_OFF');
		const stop = await h('/api/releases/app/demo/stop', { method: 'POST' });
		expect(stop.status).toBe(500);
		expect(await stop.json()).toEqual({ error: 'app: demo is a pure web app (no backend)' });
	});

	// `run` is the Apps page's verb for a window app. A bridge that can open
	// one by itself (a pure web app from the machine's mirror, machine off
	// or not) is asked first; without that, the guest CLI STARTS it — rund
	// spawns a backend window app (on a PTY for a tty app) and the desktop
	// grows the window on its stream. Not `app run`: that is the console's
	// verb and refuses a tty app from a channel with no terminal (exit 2),
	// which a backgrounded, output-discarding call used to swallow — the
	// "open window does nothing" of the bundled lasertyper.
	it('runs a window app through the page’s opener when there is one, else the CLI', async () => {
		const ran: string[] = [];
		const opened: string[] = [];
		const base = {
			list: async () => [],
			cli: async (args: string) => {
				ran.push(args);
				return '';
			},
			putFile: async () => {},
		};
		const withOpener = handler(fakeClient(), {}, memoryConfig(), {
			vmApps: { ...base, run: async (id: string) => void opened.push(id) },
		});
		expect((await withOpener('/api/releases/app/cute2048/run', { method: 'POST' })).status).toBe(200);
		expect(opened).toEqual(['cute2048']);
		expect(ran).toEqual([]);

		const cliOnly = handler(fakeClient(), {}, memoryConfig(), { vmApps: base });
		expect((await cliOnly('/api/releases/app/cute2048/run', { method: 'POST' })).status).toBe(200);
		expect(ran).toEqual(['start cute2048']);
		expect((await cliOnly('/api/releases/app/Not%20An%20Id/run', { method: 'POST' })).status).toBe(400);
	});

	// The list carries the manifest kind for the card's verb, and a window
	// app whose window is open on this desktop reads as active — rund never
	// sees a window, so the desktop's word is the only one there is.
	it('lists the kind, and an open window as active', async () => {
		const vmApps = {
			list: async () => [
				{ id: 'cute2048', state: 'off', enabled: false, size: 10, kind: 'window', windowOpen: true },
				{ id: 'notes', state: 'off', enabled: false, size: 10, kind: 'window', windowOpen: false },
				{ id: 'svc', state: 'running', enabled: true, size: 10, kind: 'service' },
			],
			cli: async () => '',
			putFile: async () => {},
		};
		const res = await handler(fakeClient(), {}, memoryConfig(), { vmApps })('/api/releases?kind=app');
		const { releases } = await res.json();
		expect(releases.map((r: any) => [r.name, r.status, r.app_kind])).toEqual([
			['cute2048', 'active', 'window'],
			['notes', 'inactive', 'window'],
			['svc', 'active', 'service'],
		]);
	});

	it('lists the device tools once they are registered', async () => {
		const handle = createHandler(fakeClient() as unknown as AgentClient, {
			tools: [{ name: 'run_python', description: 'runs python' }],
		});
		const res = await handle(new Request('http://gw/api/tools'), '/api/tools');
		const body = await res.json();
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0].name).toBe('run_python');
	});

	it('names an unimplemented route, since the browser will not', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await handler(fakeClient())('/api/logs/export');
		expect(warn.mock.calls[0][0]).toContain('GET /api/logs/export');
		warn.mockRestore();
	});
});
