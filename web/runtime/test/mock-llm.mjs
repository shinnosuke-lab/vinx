/**
 * A scriptable OpenAI-compatible endpoint, so the engine's network path can be
 * tested for real.
 *
 * Everything between `send()` and a `content` frame — reqwest over the browser's
 * fetch, chunked transfer, SSE reassembly across arbitrary chunk boundaries,
 * tool-call accumulation — is code that unit tests with a stubbed client never
 * touch, and it is exactly the code most likely to behave differently under
 * wasm. This serves real bytes over a real socket so that path runs.
 *
 * The scenario is chosen by the `model` field of the request, which keeps the
 * test's intent visible at the call site: `configure(url, key, 'mock-tool')`.
 *
 * It plays the gateway too — the tool API, and the page's document at `/`, both
 * of which the device serves. The document matters more than it looks: served
 * from here, the page runs on the gateway's origin, which is what the browser
 * suite needs in order to be testing the deployment rather than a convenient
 * rearrangement of it.
 *
 * Usage: `node mock-llm.mjs [port]`; prints `MOCK_LLM_URL=<url>` once listening.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 0);

/**
 * What the device would have baked into src/http_static.py. Read per request
 * rather than at startup: this server is started before the build, so it can
 * name the port the assets will be published under.
 */
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
const DOCUMENT = resolve(DIST, 'index.html');
const TERMINAL = resolve(DIST, 'terminal/index.html');

/** One SSE record carrying a chat completion chunk. */
function chunk(delta, finish = null) {
	const body = {
		id: 'chatcmpl-mock',
		object: 'chat.completion.chunk',
		created: 1700000000,
		model: 'mock',
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

/**
 * The trailing usage record an OpenAI-compatible stream sends when asked for
 * one (`stream_options.include_usage`): no choices, just the counts. The
 * engine turns it into a `usage` frame and calibrates its token estimate
 * from `prompt_tokens`, so the scenario that streams it also proves the
 * counts survive the trip.
 */
function usageChunk(prompt_tokens, completion_tokens) {
	const body = {
		id: 'chatcmpl-mock',
		object: 'chat.completion.chunk',
		created: 1700000000,
		model: 'mock',
		choices: [],
		usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

/** Did this conversation already come back from a tool? */
function hasToolResult(messages) {
	return messages.some((m) => m.role === 'tool');
}

const scenarios = {
	/**
	 * Plain prose, split so the client has to stitch deltas together, with
	 * the usage record real providers append after the last choice.
	 */
	'mock-text': async (_req, write) => {
		write(chunk({ role: 'assistant', content: '' }));
		write(chunk({ content: 'Hello' }));
		write(chunk({ content: ', world' }));
		write(chunk({}, 'stop'));
		write(usageChunk(1234, 5));
		write('data: [DONE]\n\n');
	},

	/**
	 * The provider's context-overflow verdict, once. The first request is
	 * refused before the stream (see the 400 branch in the handler); the engine
	 * is expected to compact its history — its summarizer's request is answered
	 * here with a summary — and replay, and the replay (whose history now opens
	 * with the summary) gets the prose. Stateless: every decision is read off
	 * the request, so the scenario survives any number of runs against one mock.
	 */
	'mock-overflow-once': async (req, write) => {
		const text = (m) => String(m.content ?? '');
		const summarizing = req.messages.some(
			(m) => m.role === 'system' && text(m).startsWith('You are a summarizer'),
		);
		const compacted = req.messages.some(
			(m) => m.role === 'user' && text(m).startsWith('[Conversation Summary]'),
		);
		const reply = summarizing
			? 'The user shared a report and the assistant acknowledged it.'
			: compacted
				? 'Fits now'
				: 'Noted.';
		write(chunk({ role: 'assistant', content: '' }));
		write(chunk({ content: reply }));
		write(chunk({}, 'stop'));
		write(usageChunk(40, 3));
		write('data: [DONE]\n\n');
	},

	/** Reasoning ahead of the answer, on the vendor-extension field. */
	'mock-reasoning': async (_req, write) => {
		write(chunk({ reasoning_content: 'thinking' }));
		write(chunk({ reasoning_content: ' harder' }));
		write(chunk({ content: 'answer' }));
		write(chunk({}, 'stop'));
		write('data: [DONE]\n\n');
	},

	/**
	 * A tool call, then prose once the result comes back — the two-leg loop that
	 * only works if the engine re-sends the transcript with the tool message.
	 */
	'mock-tool': async (req, write) => {
		if (hasToolResult(req.messages)) {
			write(chunk({ content: 'done with the tool' }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		// A name nothing registers, deliberately: an unknown tool is gated as
		// dangerous, which is the leg this scenario exists to drive. Naming a
		// real one would make the case depend on whether that tool happens to
		// be `Safe` today.
		write(
			chunk({
				tool_calls: [
					{ index: 0, id: 'call_1', type: 'function', function: { name: 'no_such_tool', arguments: '' } },
				],
			}),
		);
		// Arguments arrive split mid-token, which is what real providers do and
		// what a naive per-chunk JSON parse would choke on.
		write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }));
		write(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"/tmp/x"}' } }] }));
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * A record split across TCP writes. The engine buffers bytes rather than
	 * lines, and this is the case that proves it.
	 */
	'mock-split': async (_req, write) => {
		const record = chunk({ content: 'split across chunks' });
		write(record.slice(0, 20));
		await new Promise((r) => setTimeout(r, 10));
		write(record.slice(20));
		write(chunk({}, 'stop'));
		write('data: [DONE]\n\n');
	},

	/**
	 * A deliberate gap between deltas, so a test can catch the first one while
	 * the turn is still open. Anything that buffers until the turn ends passes
	 * a "did every delta arrive" check but fails this one.
	 */
	'mock-slow': async (_req, write) => {
		write(chunk({ content: 'first' }));
		await new Promise((r) => setTimeout(r, 400));
		write(chunk({ content: 'second' }));
		write(chunk({}, 'stop'));
		write('data: [DONE]\n\n');
	},

	/**
	 * Call a device tool, then report what came back.
	 *
	 * The second leg echoes the tool message verbatim, so a test can prove the
	 * result reached the model rather than only that the tool ran.
	 */
	...Object.fromEntries(
		[
			['mock-gateway-info', 'gateway_info', {}],
			['mock-run-shell', 'run_shell', { command: 'echo hi' }],
			// Where a bare command lands: the persistent directory, and the
			// browser suite reads the answer back to hold rund to it.
			['mock-pwd-shell', 'run_shell', { command: 'pwd' }],
			// The VM's structured tools: the safe ones prove the missing
			// confirmation gate, the unsafe one proves its presence, and
			// download/read_terminal drive their page-side lanes.
			['mock-read-file', 'read_file', { path: '/etc/hostname' }],
			['mock-write-file', 'write_file', { path: '/tmp/wf.txt', content: 'from-write-tool\n' }],
			// Into a directory that does not exist yet (with a space, for the
			// quoting): the tool promises to create parents, and the browser
			// suite approves this call and reads the "wrote N bytes" back.
			['mock-write-nested', 'write_file', { path: '/tmp/wf dir/wf.txt', content: 'from-write-tool\n' }],
			// Where chat attachments land; the browser suite uploads first.
			['mock-read-shared', 'read_file', { path: '/data/share/local/notes from me.txt' }],
			// The share_local lane: /etc/hostname exists on any booted guest;
			// the tool copies it into /data/share/local and the page kicks an
			// immediate snapshot-and-announce for the other machines.
			['mock-share-local', 'share_local', { path: '/etc/hostname' }],
			// Into the chat VM's own /data — the private tier: the browser
			// suite asserts it lands in the chat bucket and nowhere else.
			['mock-write-data', 'write_file', { path: '/data/from-chat.txt', content: 'chat-private\n' }],
			// The whole tool is one button on its card; the browser suite
			// clicks it and asserts where the popup went.
			['mock-open-terminal', 'open_terminal', {}],
			// A command tens of KB long: far past the 4 KiB control frame, so
			// the runShell adapter must stage it as a scriptRef (§6.8) and wc
			// proves every byte ran.
			[
				'mock-long-shell',
				'run_shell',
				{ command: `x='${'A'.repeat(32768)}'; printf %s "$x" | wc -c` },
			],
			['mock-download', 'download_file', { path: '/etc/hostname' }],
			['mock-read-terminal', 'read_terminal', { lines: 50 }],
			// The page-side executor, straight through the tool: an expression
			// answers REPL-style, and 42 in the echoed result proves it ran.
			['mock-run-js', 'run_js', { code: '6*7' }],
			// The same executor reached the long way round: run_shell ->
			// proc.run -> js(1) -> debug.js back up the same wire -> the
			// page. A live re-entrancy proof since both legs share ttyS3,
			// and the leg an OSC-based channel could never serve (stdout is
			// captured), so it gets its own scenario.
			['mock-js-shell', 'run_shell', { command: "js -e '6*7'" }],
			// Kept for the wasm device-tool test (crates/.../device_tools.rs),
			// which drives the engine's generic HTTP tool path with its own
			// run_python payload; the tool name here is just its fixture.
			['mock-run-python', 'run_python', { code: 'print(1)' }],
			['mock-failing-tool', 'failing_tool', {}],
			['mock-nonsense', 'nonsense_reply', {}],
			// A recall for an id this fresh session never produced: the loop
			// must intercept it (recall_result is synthetic, not registered)
			// and answer with a structured miss — no confirmation gate.
			['mock-recall-miss', 'recall_result', { call_id: 'call_ghost' }],
			// The task registers: intercepted, validated, acknowledged —
			// the call itself staying in the history is the storage.
			['mock-task-state', 'update_task_state', { state: 'goal: prove the registers' }],
			// Over the 2000-character target, under the 4000 cap: accepted with
			// a nudge in the ack rather than refused.
			['mock-task-state-long', 'update_task_state', { state: 'goal: ' + 'x'.repeat(2500) }],
		].map(([scenario, tool, args]) => [
			scenario,
			async (req, write) => {
				const result = req.messages.find((m) => m.role === 'tool');
				if (result) {
					write(chunk({ content: `tool said: ${result.content}` }));
					write(chunk({}, 'stop'));
					write('data: [DONE]\n\n');
					return;
				}
				write(
					chunk({
						tool_calls: [
							{
								index: 0,
								id: 'call_1',
								type: 'function',
								function: { name: tool, arguments: JSON.stringify(args) },
							},
						],
					}),
				);
				write(chunk({}, 'tool_calls'));
				write('data: [DONE]\n\n');
			},
		]),
	),

	/**
	 * The workspace round trip a real model took on 2026-09-04 and lost: write
	 * a draft by bare filename, edit it by the same bare name, then hand it to
	 * the person — with the machine off, since none of it needs one. The last
	 * leg echoes every tool result so the browser suite can read them back.
	 */
	'mock-draft-download': async (req, write) => {
		const results = req.messages.filter((m) => m.role === 'tool');
		const legs = [
			['write_file', { path: 'hello.html', content: '<h1>hello</h1>\n' }],
			['edit_file', { path: 'hello.html', old_str: 'hello', new_str: 'hello, world' }],
			['download_file', { path: 'hello.html' }],
		];
		const leg = legs[results.length];
		if (!leg) {
			write(chunk({ content: `tool said: ${results.map((r) => r.content).join(' | ')}` }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${results.length + 1}`,
						type: 'function',
						function: { name: leg[0], arguments: JSON.stringify(leg[1]) },
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * The other door: a draft shown rather than saved. write_file by bare
	 * name, then open_file by the same name; the last leg echoes the results
	 * so the browser suite can read what the model was told.
	 */
	'mock-open-file': async (req, write) => {
		const results = req.messages.filter((m) => m.role === 'tool');
		const legs = [
			['write_file', { path: 'hello.html', content: '<!doctype html><title>hi</title><h1>hello, tab</h1>\n' }],
			['open_file', { path: 'hello.html' }],
		];
		const leg = legs[results.length];
		if (!leg) {
			write(chunk({ content: `tool said: ${results.map((r) => r.content).join(' | ')}` }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${results.length + 1}`,
						type: 'function',
						function: { name: leg[0], arguments: JSON.stringify(leg[1]) },
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * The third door: an app, not a file. Three drafts by bare name — the
	 * window's body fragment, stylesheet and script — then install_app by
	 * those names; the last leg echoes the results so the browser suite can
	 * read what the model was told. Machine off throughout: the point. The
	 * person asked for the window "every time I open this page", so the
	 * model passes autostart — the browser suite checks the page honours it.
	 */
	'mock-install-app': async (req, write) => {
		const results = req.messages.filter((m) => m.role === 'tool');
		const legs = [
			['write_file', { path: 'index.html', content: '<h1 id="marker">tick</h1>\n<p class="note">from install_app</p>\n' }],
			['write_file', { path: 'style.css', content: '.note{color:teal}\n' }],
			['write_file', { path: 'app.js', content: "document.getElementById('marker').textContent = 'hello from app.js';\n" }],
			[
				'install_app',
				{ id: 'tick', title: 'Tick Tock', description: 'a marker app', html: 'index.html', css: 'style.css', js: 'app.js', autostart: true },
			],
		];
		const leg = legs[results.length];
		if (!leg) {
			write(chunk({ content: `tool said: ${results.map((r) => r.content).join(' | ')}` }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${results.length + 1}`,
						type: 'function',
						function: { name: leg[0], arguments: JSON.stringify(leg[1]) },
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * The refusal leg of the same door: a fragment under a name `app install`
	 * would refuse. The echo is what the model was told; the browser suite
	 * checks it is the guest's words, and that nothing landed.
	 */
	'mock-install-app-bad': async (req, write) => {
		const results = req.messages.filter((m) => m.role === 'tool');
		const legs = [
			['write_file', { path: 'bad.html', content: '<h1>x</h1>\n' }],
			['install_app', { id: 'Bad App', html: 'bad.html' }],
		];
		const leg = legs[results.length];
		if (!leg) {
			write(chunk({ content: `tool said: ${results.map((r) => r.content).join(' | ')}` }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${results.length + 1}`,
						type: 'function',
						function: { name: leg[0], arguments: JSON.stringify(leg[1]) },
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * The same door with nothing said about autostart. The browser suite
	 * seeds the mirror's autostart list with this id before the install, the
	 * way a mirror used to keep a removed app's line: a fresh install is not
	 * an enable, so the line must go — and only that one.
	 */
	'mock-install-app-plain': async (req, write) => {
		const results = req.messages.filter((m) => m.role === 'tool');
		const legs = [
			['write_file', { path: 'tock.html', content: '<h1 id="marker">tock</h1>\n' }],
			['install_app', { id: 'tock', title: 'Tock', html: 'tock.html' }],
		];
		const leg = legs[results.length];
		if (!leg) {
			write(chunk({ content: `tool said: ${results.map((r) => r.content).join(' | ')}` }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${results.length + 1}`,
						type: 'function',
						function: { name: leg[0], arguments: JSON.stringify(leg[1]) },
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * A model stuck re-recalling the same missing call_id, forever. The loop's
	 * circuit breaker must cut it off: three misses count up, the fourth
	 * identical call comes back [BLOCKED] instead of being resolved. The
	 * scenario keeps calling until it sees the block (with a safety valve so a
	 * regression fails fast instead of spinning).
	 */
	'mock-recall-breaker': async (req, write) => {
		const results = req.messages.filter((m) => m.role === 'tool');
		const last = results[results.length - 1];
		if (last && String(last.content).includes('[BLOCKED]')) {
			write(chunk({ content: `blocked after ${results.length} attempts` }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		if (results.length >= 8) {
			write(chunk({ content: 'gave up: the breaker never tripped' }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${results.length + 1}`,
						type: 'function',
						function: { name: 'recall_result', arguments: JSON.stringify({ call_id: 'call_ghost' }) },
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * A delegated `task`: the parent hands one piece of work to a sub-agent, the
	 * child answers in prose, and the parent reports what came back.
	 *
	 * Parent and child reach the same endpoint on the same model, so what tells
	 * them apart here is the sub-agent contract the engine appends to a child's
	 * system message — which is also the proof that the child got a fresh
	 * context rather than a copy of the parent's.
	 */
	'mock-task': async (req, write) => {
		const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
		if (system.includes('Sub-agent contract')) {
			write(chunk({ content: 'the child reporting in' }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		if (hasToolResult(req.messages)) {
			const report = req.messages.find((m) => m.role === 'tool')?.content ?? '';
			write(chunk({ content: `sub-agent said: ${report}` }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: 'call_task_1',
						type: 'function',
						function: {
							name: 'task',
							arguments: JSON.stringify({
								description: 'count to one',
								prompt: 'Count to one and report back.',
							}),
						},
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/**
	 * The terminal assistant's round: write a file on the VM, then say so.
	 *
	 * The console page shares the VM with this panel — the assistant's
	 * run_shell runs on the same machine the person's prompt does — so the
	 * browser suite can close the loop by reading the file back at the prompt.
	 */
	'mock-console': async (req, write) => {
		if (hasToolResult(req.messages)) {
			write(chunk({ content: 'left a note on the machine' }));
			write(chunk({}, 'stop'));
			write('data: [DONE]\n\n');
			return;
		}
		write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: 'call_1',
						type: 'function',
						function: {
							name: 'run_shell',
							arguments: JSON.stringify({ command: "echo from-the-assistant > /tmp/note" }),
						},
					},
				],
			}),
		);
		write(chunk({}, 'tool_calls'));
		write('data: [DONE]\n\n');
	},

	/** Reports the system message it was sent, or that it was sent none. */
	'mock-echo-system': async (req, write) => {
		const system = req.messages.find((m) => m.role === 'system');
		write(chunk({ content: system ? `system: ${system.content}` : 'no system message' }));
		write(chunk({}, 'stop'));
		write('data: [DONE]\n\n');
	},

	/** The tool names this request offered, sorted — what the model can
	 * actually call, as the wire says it. The browser suite reads it to pin
	 * that a powered-off machine's tools are not on offer. */
	'mock-echo-tools': async (req, write) => {
		const names = (req.tools ?? []).map((t) => t?.function?.name ?? t?.name ?? '?').sort();
		write(chunk({ content: `tools: ${names.join(' ')}` }));
		write(chunk({}, 'stop'));
		write('data: [DONE]\n\n');
	},

	/** Junk between valid records: skipped, not fatal. */
	'mock-noise': async (_req, write) => {
		write(': keep-alive comment\n\n');
		write('data: {not json}\n\n');
		write(chunk({ content: 'survived' }));
		write(chunk({}, 'stop'));
		write('data: [DONE]\n\n');
	},

	/** A stream that stops without `[DONE]` or a finish reason. */
	'mock-truncated': async (_req, write) => {
		write(chunk({ content: 'cut off' }));
	},

	/**
	 * A scripted agent building an app the way the skill teaches (§13):
	 * scaffold with `app new`, edit a file with write_file, `app check
	 * --json`, pack, install, then run/start it. The kind comes from the
	 * user's message ("web app" / "service" / "command"), the id from a
	 * `named X` clause; each turn issues the next tool call in the plan,
	 * looking only at how many tool results have come back — a model
	 * following a plan, not a stub echoing one result. The final turn
	 * reports what `app list --json` said.
	 */
	'mock-app-builder': async (req, write) => {
		const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
		const id = (/named ([a-z0-9][a-z0-9-]{0,31})/.exec(user) ?? [])[1] ?? 'built-by-mock';
		const kind = /web app/i.test(user) ? 'web' : /service/i.test(user) ? 'service' : 'command';
		const n = req.messages.filter((m) => m.role === 'tool').length;
		const shell = (command, timeout = 60) => ({
			name: 'run_shell',
			arguments: JSON.stringify({ command, timeout }),
		});
		// The web edit is written the way a model writes a web page by habit
		// — a whole document, a <link> to its stylesheet, a <script src> —
		// and its app.js keeps state in localStorage. Neither is the window's
		// contract (index.html is a body fragment; the frame has no storage);
		// the shell tolerates both and `app check` names them, which is what
		// the browser suite asserts.
		const edit =
			kind === 'web'
				? n === 1
					? {
							name: 'write_file',
							arguments: JSON.stringify({
								path: `/data/work/${id}/index.html`,
								content:
									`<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${id}</title>\n` +
									`<link rel="stylesheet" href="style.css"></head>\n` +
									`<body><h1 id="title">${id}</h1>\n<p id="marker">built-by-the-model</p>\n` +
									`<button id="ping">notify</button>\n<script src="app.js"></script></body></html>\n`,
							}),
						}
					: {
							name: 'write_file',
							arguments: JSON.stringify({
								path: `/data/work/${id}/app.js`,
								content:
									`const n = Number(localStorage.getItem('opens') || 0) + 1;\n` +
									`localStorage.setItem('opens', String(n));\n` +
									`document.getElementById('title').textContent = 'hello from ${id} #' + n;\n` +
									`document.getElementById('ping').onclick = () => vinx.call('notify.show', { text: 'ping' });\n`,
							}),
						}
				: {
						name: 'write_file',
						arguments: JSON.stringify({
							path: `/data/work/${id}/run`,
							content:
								kind === 'service'
									? `#!/bin/sh\nwhile :; do echo "${id} alive $(date)"; sleep 3; done\n`
									: `#!/bin/sh\necho "${id} ran once"\n`,
						}),
					};
		const plan = [
			shell(`app new ${id} --${kind}`),
			edit,
			...(kind === 'web' ? [edit] : []), // the second web edit (app.js); `edit` reads n
			shell(`app check /data/work/${id} --json`),
			shell(`app pack /data/work/${id} && app install /data/work/${id}.vapp`),
			kind === 'web'
				? shell(`app run ${id} >/dev/null 2>&1 & sleep 1; echo window-requested`)
				: kind === 'service'
					? shell(`app start ${id}`)
					: shell(`app run ${id}`),
			shell(`app list --json`, 30),
		];
		if (n < plan.length) {
			write(
				chunk({
					tool_calls: [{ index: 0, id: `call_build_${n}`, type: 'function', function: plan[n] }],
				}),
			);
			write(chunk({}, 'tool_calls'));
			write('data: [DONE]\n\n');
			return;
		}
		const last = [...req.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
		write(chunk({ content: `built ${id} (${kind}); app list said: ${last}` }));
		write(chunk({}, 'stop'));
		write('data: [DONE]\n\n');
	},
};

/**
 * Allow the browser test to reach this from the page's origin.
 *
 * A real provider does not need to send these, because agent-core calls it from
 * a server. Calling it from a tab is the whole premise here, so any provider
 * used this way must permit it — worth knowing before deployment, not after.
 */
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization,content-type',
	'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

/** Every response carries CORS, or the browser discards it before we see it. */
function head(res, status, extra = {}) {
	res.writeHead(status, { ...CORS, ...extra });
}

/**
 * The gateway side, on the same server: `POST /api/tools/call`, answering the
 * way the device sandbox does — `{ok, output?, error?}`.
 *
 * Which tool ran is echoed back so a test can prove the right one was called
 * with the right arguments, rather than just that *something* returned.
 */
/** What the device publishes at `GET /api/tools`. */
const DEVICE_TOOLS = {
	system_prompt: 'You are running on a Vinx Linux device.',
	tools: [
		{
			name: 'gateway_info',
			safe: true,
			description: 'Report the gateway model, MAC and firmware.',
			// No `required`, exactly as the device sends it for a tool that takes
			// no arguments.
			parameters: { type: 'object', properties: {} },
		},
		{
			name: 'run_python',
			safe: false,
			description: 'Execute MicroPython on the gateway.',
			parameters: {
				type: 'object',
				properties: { code: { type: 'string', description: 'source' } },
				required: ['code'],
			},
		},
	],
};

/**
 * What the device publishes at `GET /api/config`.
 *
 * The page reads this at startup to learn which gateway it is talking to. It
 * carries no model settings and the device sends none: the endpoint is the
 * page's business, defaulted at build time and owned by its settings panel
 * afterwards.
 */
const DEVICE_CONFIG = {
	brand: 'Vinx Agent',
	gateway: { type: 'v86', mac: '02:00:00:00:00:01', firmware: 'mock' },
};

/** What Tab finds on the mock device: the top level, and one module's names. */
const CONSOLE_NAMES = {
	'': ['asyncio', 'json', 'osinfo', 'print', 'sysinfo', 'time'],
	osinfo: ['getcwd', 'hostname', 'read_file', 'read_link', 'uptime'],
};

/**
 * The console's persistent namespace, as far as the browser suite needs one:
 * `name = value` remembers the value's source text, a bare `name` reads it
 * back, everything else is echoed as `ran:`. The real semantics live in
 * src/sandbox.py and are covered by test/api.py against a real interpreter;
 * what this exists to prove is the plumbing — that the REPL's `repl: true`
 * and the assistant's `?console=1` land in the *same* map.
 */
const CONSOLE_NS = new Map();

function deviceTool(body, forConsole = false) {
	const { name, arguments: args } = body;
	if (name === 'gateway_info') {
		return { ok: true, output: 'type     v86\nmac      02:00:00:00:00:01\n' };
	}
	if (name === 'run_python') {
		// The console's Tab key: a question about the device's namespace, so
		// it carries no code either. Answered here from a fixed namespace,
		// filtered exactly as sandbox_complete filters `dir()` — enough for
		// the browser suite to prove the round trip and the three outcomes
		// (one match, a shared prefix, an ambiguous list).
		if (typeof args?.complete === 'string') {
			const dot = args.complete.lastIndexOf('.');
			const names = CONSOLE_NAMES[dot < 0 ? '' : args.complete.slice(0, dot)] ?? [];
			const prefix = args.complete.slice(dot + 1);
			return { ok: true, output: names.filter((n) => n.startsWith(prefix)).join(' ') };
		}
		// `reset` alone clears the console's namespace and runs nothing, which
		// is the one call the device answers without any code. See tools.py.
		if (args?.reset && !args?.code) {
			CONSOLE_NS.clear();
			return { ok: true, output: '' };
		}
		if (!args?.code) return { ok: false, error: "run_python requires a non-empty 'code' string" };
		// `?console=1` forces the persistent namespace whatever the arguments
		// said, exactly as src/main.py does for the terminal's assistant.
		if (forConsole || args?.repl === true) {
			const code = String(args.code).trim();
			// (?![=]) keeps `x == y` a comparison, not a binding of "= y".
			const bind = /^([A-Za-z_]\w*)\s*=(?![=])\s*(.+)$/s.exec(code);
			if (bind) {
				CONSOLE_NS.set(bind[1], bind[2].trim());
				return { ok: true, output: '' };
			}
			if (CONSOLE_NS.has(code)) return { ok: true, output: CONSOLE_NS.get(code) };
		}
		return { ok: true, output: `ran: ${args.code}` };
	}
	if (name === 'failing_tool') {
		return { ok: false, error: 'NameError: undefined', output: 'partial output' };
	}
	if (name === 'nonsense_reply') return '<html>not json at all</html>';
	return { ok: false, error: `unknown tool: ${name}` };
}

const server = createServer((req, res) => {
	if (req.method === 'OPTIONS') {
		head(res, 204);
		res.end();
		return;
	}

	let raw = '';
	req.on('data', (d) => (raw += d));
	req.on('end', async () => {
		const json = { 'Content-Type': 'application/json' };

		// The device's own documents, from the build the assets were published
		// from. No CORS header on these and none needed: they are what put the
		// page on this origin in the first place. `/terminal` is the console
		// behind the stock UI's open_terminal button.
		if (req.method === 'GET') {
			const path = new URL(req.url, 'http://d').pathname;
			const file =
				path === '/' ? DOCUMENT : path === '/terminal' || path === '/terminal/' ? TERMINAL : null;
			if (file) {
				let html;
				try {
					html = await readFile(file);
				} catch (e) {
					res.writeHead(500, { 'Content-Type': 'text/plain' });
					res.end(`the page is not built: ${e.message}`);
					return;
				}
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(html);
				return;
			}
		}

		// Both tool endpoints answer `?console=1` the way src/main.py does:
		// the terminal assistant's engine puts it on every request, the
		// briefing grows a console section, and run_python is forced into the
		// console's persistent namespace. Parsed as a URL because a query
		// string is exactly what `endsWith` would trip over.
		const asked = new URL(req.url, 'http://d');
		const forConsole = asked.searchParams.get('console') === '1';

		if (req.method === 'GET' && asked.pathname.endsWith('/api/tools')) {
			head(res, 200, json);
			const prompt = DEVICE_TOOLS.system_prompt + (forConsole ? '\n\n## Console mode' : '');
			res.end(JSON.stringify({ ...DEVICE_TOOLS, system_prompt: prompt }));
			return;
		}

		if (req.method === 'GET' && req.url.endsWith('/api/config')) {
			head(res, 200, json);
			res.end(JSON.stringify(DEVICE_CONFIG));
			return;
		}

		// What the composer's model picker is filled from. A provider is free
		// not to implement this, and the UI degrades to a read-only badge when
		// it does not — but then nothing here would cover the case where it
		// does, which is the one with a picker in it.
		if (req.method === 'GET' && req.url.endsWith('/models')) {
			head(res, 200, json);
			res.end(
				JSON.stringify({
					object: 'list',
					data: Object.keys(scenarios).map((id) => ({ id, object: 'model' })),
				}),
			);
			return;
		}

		if (asked.pathname.endsWith('/api/tools/call')) {
			let outcome;
			try {
				outcome = deviceTool(JSON.parse(raw), forConsole);
			} catch {
				head(res, 400, json);
				res.end('{"ok":false,"error":"bad json"}');
				return;
			}
			// A non-JSON body is a scenario in its own right: the shape of what a
			// misconfigured gateway returns.
			if (typeof outcome === 'string') {
				head(res, 502, { 'Content-Type': 'text/html' });
				res.end(outcome);
				return;
			}
			head(res, 200, json);
			res.end(JSON.stringify(outcome));
			return;
		}

		if (!req.url.endsWith('/chat/completions')) {
			head(res, 404, json);
			res.end('{}');
			return;
		}

		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			head(res, 400, json);
			res.end('{"error":"bad json"}');
			return;
		}

		// Scenarios that answer with a status rather than a stream.
		if (body.model === 'mock-500') {
			head(res, 500, json);
			res.end('{"error":{"message":"upstream exploded"}}');
			return;
		}
		if (body.model === 'mock-401') {
			head(res, 401, json);
			res.end('{"error":{"message":"bad key"}}');
			return;
		}
		// An upstream that takes its time before the first byte: no headers
		// for a while, then plain prose. A client that honours its stop flag
		// only once the stream is open sits through the whole wait.
		if (body.model === 'mock-slow-headers') {
			await new Promise((r) => setTimeout(r, 3000));
			if (req.destroyed || res.destroyed) return;
			head(res, 200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			});
			await scenarios['mock-text'](body, (s) => res.write(s));
			res.end();
			return;
		}
		// The overflow verdict, word for word as OpenAI phrases it. A live user
		// message that says "overflow" gets it — unless the history has already
		// been compacted (it opens with a summary) or this is the summarizer's
		// own request; both of those stream. Any other message streams too, so
		// a test can lay down history before provoking the verdict.
		if (body.model === 'mock-overflow-once') {
			const text = (m) => String(m.content ?? '');
			const live = [...body.messages].reverse().find((m) => m.role === 'user');
			const replay = body.messages.some(
				(m) =>
					(m.role === 'system' && text(m).startsWith('You are a summarizer')) ||
					(m.role === 'user' && text(m).startsWith('[Conversation Summary]')),
			);
			if (!replay && live && /overflow/i.test(text(live))) {
				head(res, 400, json);
				res.end(
					JSON.stringify({
						error: {
							message:
								"This model's maximum context length is 8192 tokens. However, your messages resulted in 9107 tokens. Please reduce the length of the messages.",
							type: 'invalid_request_error',
							param: 'messages',
							code: 'context_length_exceeded',
						},
					}),
				);
				return;
			}
		}

		const scenario = scenarios[body.model];
		if (!scenario) {
			head(res, 400, json);
			res.end(JSON.stringify({ error: { message: `unknown scenario ${body.model}` } }));
			return;
		}

		head(res, 200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		});
		await scenario(body, (s) => res.write(s));
		res.end();
	});
});

server.listen(PORT, '127.0.0.1', () => {
	const { port } = server.address();
	// The test harness reads this line to learn where we landed.
	console.log(`MOCK_LLM_URL=http://127.0.0.1:${port}/v1`);
});
