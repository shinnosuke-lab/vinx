/**
 * The RPC plumbing, against a worker we control.
 *
 * The engine is not involved: what is being checked is that requests get ids,
 * replies find their caller, frames reach the right stream, and the failure
 * paths reject rather than hang. A promise that never settles is the worst
 * outcome here, so several of these exist specifically to rule it out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentClient } from '../src/client';
import { PROTOCOL_VERSION } from '../src/protocol';

/** Stands in for the Dedicated Worker; the test plays the worker's part. */
class FakeWorker {
	static last: FakeWorker;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: ErrorEvent) => void) | null = null;
	sent: any[] = [];
	/** The boot message, kept apart from requests as the real worker does. */
	init: any = null;
	terminated = false;

	constructor(
		public url: string | URL,
		public options?: WorkerOptions,
	) {
		FakeWorker.last = this;
	}

	postMessage(message: any) {
		if (message && 'init' in message) this.init = message;
		else this.sent.push(message);
	}

	terminate() {
		this.terminated = true;
	}

	/** Deliver a message as if the worker had sent it. */
	emit(message: unknown) {
		this.onmessage?.({ data: message } as MessageEvent);
	}

	fail(message: string) {
		this.onerror?.({ message } as ErrorEvent);
	}

	/** Announce a successful load. */
	ready(extra: Record<string, unknown> = {}) {
		this.emit({ ready: true, protocol: PROTOCOL_VERSION, ...extra });
	}

	/** Answer the nth request the client made. */
	reply(index: number, result: unknown) {
		this.emit({ id: this.sent[index].id, result });
	}
}

function connect(options: { namespace?: string; workerUrl?: string } = {}) {
	const client = new AgentClient({ workerUrl: 'worker.js', ...options });
	return { client, worker: FakeWorker.last };
}

beforeEach(() => {
	vi.stubGlobal('Worker', FakeWorker);
});

describe('startup', () => {
	it('loads the worker as a module', () => {
		const { worker } = connect();
		expect(worker.options?.type).toBe('module');
	});

	// The deployment this ships in: the document is served by the gateway and
	// the code by the asset host. A worker script URL may not be cross-origin
	// whatever CORS headers arrive, so it is reached through a same-origin
	// bootstrap instead. See `spawn` in client.ts.
	describe('when the script is on another origin', () => {
		const bootstrap = 'blob:http://192.168.1.104:60000/1';
		let blobs: Blob[];

		beforeEach(() => {
			blobs = [];
			vi.stubGlobal('location', {
				origin: 'http://192.168.1.104:60000',
				href: 'http://192.168.1.104:60000/',
			});
			vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
				blobs.push(blob as Blob);
				return bootstrap;
			});
			vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});

		it('runs a bootstrap that imports the real script', async () => {
			const { worker } = connect({
				workerUrl: 'https://assets.example.com/vinx/0.1.0/assets/worker.js',
			});
			expect(worker.url).toBe(bootstrap);
			await expect(blobs[0].text()).resolves.toBe(
				'importScripts("https://assets.example.com/vinx/0.1.0/assets/worker.js")',
			);
		});

		it('makes it a classic worker, because module workers have no importScripts', () => {
			const { worker } = connect({ workerUrl: 'http://assets.example.com/x/worker.js' });
			expect(worker.options?.type).toBeUndefined();
		});

		it('leaves a same-origin script alone', () => {
			const { worker } = connect({ workerUrl: 'http://192.168.1.104:60000/worker.js' });
			expect(worker.url).toBe('http://192.168.1.104:60000/worker.js');
			expect(worker.options?.type).toBe('module');
			expect(blobs).toHaveLength(0);
		});

		it('releases the bootstrap when closed, but not before', () => {
			const { client } = connect({ workerUrl: 'http://assets.example.com/x/worker.js' });
			// Revoking at construction races the fetch of the script it names.
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
			client.close();
			expect(URL.revokeObjectURL).toHaveBeenCalledWith(bootstrap);
		});
	});

	it('names the store before the worker can open one', () => {
		const { worker } = connect({ namespace: '192.168.1.104:60000' });
		// Not "eventually": the worker opens its database on this message, so a
		// namespace that arrived after any request would arrive too late.
		expect(worker.init).toEqual({ init: true, namespace: '192.168.1.104:60000' });
		expect(worker.sent).toHaveLength(0);
	});

	it('still boots the worker when no store is named', () => {
		const { worker } = connect();
		expect(worker.init).toEqual({ init: true, namespace: undefined });
	});

	it('waits for the worker before sending anything', async () => {
		const { client, worker } = connect();
		const call = client.sessions();
		// Not yet ready: the request must be held, not dropped or sent early.
		expect(worker.sent).toHaveLength(0);

		worker.ready();
		await client.whenReady();
		await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
		worker.reply(0, []);
		await expect(call).resolves.toEqual([]);
	});

	it('reports when storage is ephemeral, since history will not survive', async () => {
		const { client, worker } = connect();
		worker.ready({ ephemeral: true });
		await expect(client.whenReady()).resolves.toEqual({
			protocol: PROTOCOL_VERSION,
			ephemeral: true,
		});
	});

	it('refuses a worker speaking a different protocol', async () => {
		const { client, worker } = connect();
		worker.emit({ ready: true, protocol: PROTOCOL_VERSION + 1 });
		await expect(client.whenReady()).rejects.toThrow(/protocol/);
	});

	it('surfaces a load failure instead of hanging', async () => {
		const { client, worker } = connect();
		worker.emit({ ready: true, protocol: PROTOCOL_VERSION, error: 'could not load wasm' });
		await expect(client.whenReady()).rejects.toThrow(/could not load wasm/);
	});
});

describe('calls', () => {
	async function connected() {
		const { client, worker } = connect();
		worker.ready();
		await client.whenReady();
		return { client, worker };
	}

	it('routes replies to the right caller', async () => {
		const { client, worker } = await connected();
		const first = client.sessions();
		const second = client.session('abc');
		await vi.waitFor(() => expect(worker.sent).toHaveLength(2));

		// Answered out of order on purpose: ids, not arrival order, decide.
		worker.reply(1, { id: 'abc' });
		worker.reply(0, [{ id: 'x' }]);

		await expect(second).resolves.toEqual({ id: 'abc' });
		await expect(first).resolves.toEqual([{ id: 'x' }]);
	});

	it('rejects when the worker reports an error', async () => {
		const { client, worker } = await connected();
		const call = client.session('gone');
		await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
		worker.emit({ id: worker.sent[0].id, error: 'no such session' });
		await expect(call).rejects.toThrow('no such session');
	});

	it('rejects everything in flight when the worker dies', async () => {
		const { client, worker } = await connected();
		const call = client.sessions();
		await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
		worker.fail('out of memory');
		await expect(call).rejects.toThrow(/out of memory/);
	});

	it('rejects everything in flight when closed', async () => {
		const { client, worker } = await connected();
		const call = client.sessions();
		await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
		client.close();
		expect(worker.terminated).toBe(true);
		await expect(call).rejects.toThrow(/closed/);
	});

	it('carries per-turn options alongside the message', async () => {
		const { client, worker } = await connected();
		void client.send('s', 'hi', { model: 'other' });
		await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
		expect(worker.sent[0]).toMatchObject({
			method: 'send',
			params: { session: 's', text: 'hi', options: { model: 'other' } },
		});
	});

	it('passes confirm decisions through with the approve-all flag', async () => {
		const { client, worker } = await connected();
		void client.confirm('s', true, true);
		await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
		expect(worker.sent[0]).toMatchObject({
			method: 'confirm',
			params: { session: 's', approved: true, approveAll: true },
		});
	});
});

describe('streams', () => {
	async function connected() {
		const { client, worker } = connect();
		worker.ready();
		await client.whenReady();
		return { client, worker };
	}

	it('delivers frames to the stream that asked for them', async () => {
		const { client, worker } = await connected();
		const a: string[] = [];
		const b: string[] = [];
		client.attach('chat', (f) => a.push(f));
		client.attach('other', (f) => b.push(f));
		await vi.waitFor(() => expect(worker.sent).toHaveLength(2));

		const [first, second] = worker.sent.map((m) => m.params.stream);
		worker.emit({ stream: first, frame: 'event: content\ndata: {"text":"hi"}\n\n' });
		worker.emit({ stream: second, frame: 'event: done\ndata: {"elapsed_ms":1}\n\n' });

		expect(a).toEqual(['event: content\ndata: {"text":"hi"}\n\n']);
		expect(b).toEqual(['event: done\ndata: {"elapsed_ms":1}\n\n']);
	});

	it('stops delivering after detach and tells the worker', async () => {
		const { client, worker } = await connected();
		const seen: string[] = [];
		const detach = client.attach('chat', (f) => seen.push(f));
		await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
		const stream = worker.sent[0].params.stream;

		detach();
		worker.emit({ stream, frame: 'event: content\ndata: {"text":"late"}\n\n' });
		expect(seen).toEqual([]);

		await vi.waitFor(() =>
			expect(worker.sent.some((m) => m.method === 'detach' && m.params.stream === stream)).toBe(
				true,
			),
		);
	});

	it('ignores a frame for a stream nobody is watching', async () => {
		const { worker } = await connected();
		// A turn can be mid-publish when a view unmounts; that must not throw.
		expect(() => worker.emit({ stream: 'ghost', frame: 'event: content\ndata: {}\n\n' })).not.toThrow();
	});
});
