/**
 * The in-page VM presented as a device.
 *
 * The engine's device layer speaks two HTTP shapes: a `GET /api/tools` payload
 * (tools + system prompt) and a `POST /api/tools/call` exchange. A real
 * gateway serves those over the network; the VM serves them from this module —
 * the payload is a constant, and calls are answered by `vmCallHandler`, which
 * the worker reaches via the `VM_ENDPOINT` bounce (see worker.ts and
 * `ClientOptions.onVmCall`).
 *
 * The tool surface is a small set of operations on this Linux, not just a
 * shell: structured read/list tools can *promise* to be read-only, which a
 * shell command never can — that is what lets them run without the
 * confirmation gate. Structured write tools carry file content as data, which
 * kills the busybox quoting traps a model hits when it heredocs a file into
 * existence. Everything else stays `run_shell`.
 *
 * Exact file bytes travel through /data (the 9p filesystem both sides can
 * touch), not the shell channel: command output inlines up to 64 KiB (with
 * an explicit truncation marker past it, backed by a §6.8 output ref), 9p
 * reads are exact and memory-speed. See `readGuestFile`/`writeGuestFile`.
 */

import type { DeviceConfig } from './device';

/**
 * The routing tag the engine POSTs tool calls to. Never fetched from the
 * network: the worker's fetch bounces anything on this host back to the main
 * thread. Kept in lockstep with `VM_HOST` in worker.ts.
 */
export const VM_ENDPOINT = 'http://vm.internal/tools/call';

/**
 * What this module needs of a VM.
 *
 * Structural on purpose — the concrete `VinxVm` lives in the app layer
 * (it imports v86 and vite `?url` assets, which only vite can resolve), and
 * keeping this side to an interface is what lets the runtime stay pure and
 * node-testable. `readFile`/`putFile` are the /data 9p endpoints; optional
 * because a bare ShellDevice (tests, exotic hosts) may not carry them — the
 * file tools then degrade with a clear error.
 */
export interface ShellDevice {
	runShell(command: string, timeoutS?: number): Promise<{ exit_code: number; output: string }>;
	/** Read `/data/<name>` exactly, via 9p. */
	readFile?(name: string): Promise<Uint8Array>;
	/** Write `/data/<name>` exactly, via 9p. */
	putFile?(name: string, bytes: Uint8Array): Promise<void>;
	/** List `/data/<name>` from the page-side inodes: no guest round trip. */
	listData?(name: string): Promise<DataEntry[]>;
	/** `mkdir -p /data/<name>`, page-side. */
	ensureDir?(name: string): Promise<void>;
	/** Best-effort page-side unlink of `/data/<name>` (staging relays). */
	deleteData?(name: string): void;
}

/** One /data directory entry, straight from the page-side 9p inode. */
export interface DataEntry {
	name: string;
	size: number;
	/** Seconds since the epoch. */
	mtime: number;
	mode: number;
	dir: boolean;
}

/** The terminal page's screen, offered to the model as `read_terminal`. */
export interface TerminalReader {
	/** The last `lines` lines of the visible buffer, ANSI already resolved. */
	read(lines: number): string;
}

/** Page-side capabilities the runtime cannot provide for itself. */
export interface VmExtras {
	/** Present on the terminal page: lets the model see the user's screen. */
	terminal?: TerminalReader;
	/** Hands bytes to the person as a browser download (an <a download> click). */
	download?: (filename: string, bytes: Uint8Array) => void;
	/**
	 * Runs a script on the hosting page and reports its console output and
	 * completion value — the app's hostcall.ts executor, injected here so the
	 * runtime stays free of page code. `ok: false` means the script threw or
	 * timed out, which is data for the model, not a tool failure.
	 */
	runJs?: (code: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
	/**
	 * Called after share_local lands a file in /data/share/local, so the page
	 * can snapshot-and-announce right away instead of waiting out the
	 * 15-second mirror interval (share-store's requestSnapshot).
	 */
	onShared?: () => void;
}

/** What tools the payload should declare, mirroring the extras at hand. */
export interface VmToolsOptions {
	console?: boolean;
	terminal?: boolean;
	download?: boolean;
	runJs?: boolean;
}

/** Files bigger than this stay in the VM: they would not fit /data's lane. */
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
/** edit_file loads the whole file into the page; keep that honest. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
/** What read_file hands the model at most — context is not a pastebin. */
const MAX_READ_CHARS = 48_000;
/**
 * A staging relay in the §6.8 tmp namespace: unique per transfer, so two
 * overlapping calls (or a stale cleanup from a previous one) can never touch
 * each other's bytes. Lives under /data/.vinx/tmp — the namespace
 * persistence explicitly excludes and the boot sweep reclaims — not a
 * root-level dotfile that merely hoped no glob would match (§12.1).
 */
function ioName(): string {
	return `.vinx/tmp/io-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The 9p-relative name for a clean path inside /data, or null when the path
 * is not (or not provably) there — dot segments go to the guest lane, where
 * the shell resolves them for real. /data itself is the empty name.
 */
function dataRel(path: string): string | null {
	if (path === '/data' || path === '/data/') return '';
	if (!path.startsWith('/data/')) return null;
	const rel = path.slice('/data/'.length);
	const segs = rel.split('/');
	if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
	return rel;
}

const PROMPT = `You are attached to a small Linux machine emulated inside this browser tab \
(v86: one i686 CPU, 128 MB RAM, busybox userland, root, no password). It is real Linux, \
but think "router shell", not "build server": keep commands small, filter output instead \
of dumping it.

Tools: read_file and list_dir are read-only and run without confirmation — prefer them \
for looking around. write_file and edit_file change files with exact content transfer \
(no shell quoting traps — never heredoc a file into existence with run_shell). \
download_file hands a file from the VM to the person as a browser download; for files \
going the other way, ask them to drop the file onto the terminal — it appears in /data. \
run_shell executes one command line with \`sh -c\` as root and returns stdout and stderr \
combined (inline up to 64 KiB; a bigger result is cut there with a marker naming the \
/data file that holds the full text). Commands start in /data — the one directory that survives \
reloads — as does the person's console. Each call is independent — no shell state \
survives between calls — but the filesystem and processes do, for as long as the page \
stays open. \
run_js executes JavaScript on the page hosting this VM (browser main thread: \`await\`, \
\`document\`, \`fetch\` — CORS applies to cross-origin reads); never write a synchronous \
infinite loop there, it would freeze the page. \
On long multi-step tasks, keep update_task_state current (goal, progress, key facts \
with their call_ids, next steps) — that block survives context compaction verbatim. \
When an old tool result shows as a [compacted: ...] placeholder, recall_result with \
its call_id retrieves the original — never re-run a command just to re-read output \
you already had. \
Everything lives in RAM and a reload erases the machine, with one exception: /data \
persists across reloads (the page mirrors it). Put anything worth keeping in /data — \
but /data is THIS machine's own disk: the person's terminal page is a different \
machine and does not see it. To hand a file to their other machines (the chat page's \
VM, each split pane's, other tabs') use the share_local tool — it lands in \
/data/share/local on all of them, and files the person attaches to the chat appear \
there too. That sharing is browser-local mirroring: nothing goes over the network, \
whatever the network mode. \
For programming there are \`tcc\` (real C, headers included — \`tcc -run\` works), \
\`micropython\` (NOT CPython: no pip, a stdlib subset plus micropython-lib add-ons — \
check the linux-vm skill before assuming a module exists) and \`qjs\` (QuickJS). \
GNU \`make\`, \`sqlite3\` (CLI and C library — \`tcc x.c -lsqlite3\` links) and \`jq\` \
are installed; so are \`nasm\` (Intel-syntax x86 assembly — \`nasm -f elf32 x.asm && \
tcc x.o -o x\`, plus \`ndisasm\`), \`strace\`, and \`btmon\` (decodes btsnoop Bluetooth \
captures: \`btmon -r FILE\`). No gcc, no pip/npm. \
GUI programs are real: LVGL v9 is installed (\`tcc gui.c -llvgl\`) and draws on the \
VGA screen the page shows; the screen window forwards the mouse (evdev). \`lvdemo\` \
runs the shipped example, /usr/share/lvgl/lvdemo.c is the template to copy, and a \
full GB2312 Chinese font ships at /usr/share/fonts/cjk16.bin \
(\`lv_binfont_create("A:/usr/share/fonts/cjk16.bin")\`). Terminal UIs: \`ncurses\` \
(\`-lncurses\`) or \`termbox2\` (single header, \`#define TB_IMPL\`, nothing to link). \
The guest also has \`js\` (runs JavaScript on the \
hosting page, same engine as run_js) and \`fetch\` (HTTP through the page's browser \
fetch — works with zero network setup, but cross-origin reads need the server to \
allow CORS; CORS-friendly readers like https://r.jina.ai/URL fetch arbitrary pages \
as text). Both work from run_shell and from the person's console alike. \
You can build the person real apps. An "app" here is an entry on the Apps page of \
this page — a .vapp package in /data/apps, listed and started from there and by the \
\`app\` CLI; a standalone HTML file is not one. \`app new NAME --command|--service|--web|--tty|--fb\` \
scaffolds one that runs as generated, \`app check --json\` names what to fix, \
\`app pack\`/\`app install\` put it on the Apps page, \`app start\` runs it as a supervised \
service. A --web app is three files in a sandboxed window (index.html body fragment, \
style.css, app.js — no <link>/<script src>, no network, no storage) with no process \
behind it; once installed it opens from the Apps page even with the machine off. A web or tty \
app opens a floating window on their page (a tty app runs on a real PTY shown in an \
xterm window — start it with \`app start\`, never \`app run\`, from run_shell: your \
channel has no tty); an fb app draws on the machine's screen (fb-run runs one FB \
program at a time). \`rpc\` is the control plane raw: \`rpc discover\` lists every \
live method, \`rpc watch\` prints events (app.exited, window.closed...) as lines, \
and \`rpc serve ext.APP.NAME -- ./script\` turns a script into a method every \
process and the page can call while it runs.

The shell is ash and the userland is busybox, not GNU: no bash-isms, no \`grep -P\`, \
short flags only. Networking has three modes and by default there is NO internet: the \
default is a browser-only LAN (this VM is 10.0.2.x; other VMs in the user's other tabs \
or split panes share 10.0.2.0/24 and are reachable, but nothing off-segment is). If the \
user switches to a relay, real outbound TCP works (\`curl https://...\`, WebSocket); a \
legacy fetch mode does CORS-bound plain HTTP only. Ping always "succeeds" against any \
address because the reply is forged — never treat it as a connectivity test; run an \
HTTP request and read the error, and do not assume you have internet. The installed \
linux-vm skill describes the userland, its traps, and all three network modes in \
detail — read it before anything non-trivial.`;

/** Appended when the engine sits beside the terminal page's console. */
const CONSOLE_PROMPT = `

The person you are helping has a console open on this same machine (ttyS0): they see \
the files you create and the processes you start, and you see theirs. Say what you \
changed rather than making them hunt for it. When they mention "this error" or \
something on their screen, read_terminal shows you their last lines — read before \
asking them to paste.`;

/**
 * The briefing for a machine the person has left powered off: no tools,
 * one paragraph. A tool-less payload still carries a system prompt, and
 * that is the point — the model is told why the shell it may remember from
 * another session is not here, and what to say instead of guessing.
 */
export const NO_MACHINE_PROMPT = `This page has a small Linux machine (emulated in the browser tab) \
that the person has not powered on — booting it is their decision, not yours, and \
it costs a download the first time. You have no shell, no files on it, and no way \
to run programs until they do. If a task needs one, say so plainly and point them \
to the machine capsule at the bottom right of the page (its power key boots the \
machine; your tools appear on the next message once it is up), then help with \
whatever does not need it. Plenty does not: what you write into your workspace \
(a page, a script, a document) reaches the person without any machine — open_file \
puts an Open button on its card that shows the file in a new browser tab (pages, \
images, PDFs, text), download_file saves them a copy — so do not send them to the \
power key for something you can simply show or hand over. Apps neither: an "app" on \
this page is an entry on its Apps page (a package the machine keeps in /data/apps). \
Web apps already installed there open without the machine, and install_app installs a \
new pure web app without it — the window's body fragment, stylesheet and script, \
written as drafts (no <html>/<head>/<body>, no <link> or <script src>: the window \
injects style.css and app.js itself, and its sandbox has no network and no storage) \
— so the person finds it on the Apps page and the card gets an Open button. Its \
autostart flag (the window opens whenever the page loads, machine on or off) is for \
when the person asked for an app that shows up every time; otherwise leave it off. Only an \
app with a program behind it (a service, a command, a tty program) needs the machine.`;

/** `vmToolsPayload`'s shape with nothing in it but the briefing above. */
export const NO_MACHINE_PAYLOAD: unknown = { tools: [], system_prompt: NO_MACHINE_PROMPT };

/** What a gateway would publish at `GET /api/tools`. */
export function vmToolsPayload(options: VmToolsOptions = {}): unknown {
	const tools: unknown[] = [
		{
			name: 'run_shell',
			// Arbitrary code as root: gated behind the same confirmation the
			// desktop agent uses, and full-auto turns it off knowingly.
			safe: false,
			description:
				'Run a shell command on the Linux VM in this page (sh -c, as root, ' +
				'starting in /data). Returns stdout and stderr combined, inline up to ' +
				'64 KiB — a bigger result is truncated with a marker naming the /data ' +
				'file holding the full text. busybox userland; only /data persists ' +
				'across a page reload.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The command line to run.' },
					timeout: {
						type: 'number',
						description: 'Seconds before the command is killed. Default 30, max 120.',
					},
				},
				required: ['command'],
			},
		},
		{
			name: 'read_file',
			// Strictly read-only by construction, so no confirmation gate.
			safe: true,
			description:
				'Read a text file from the VM with exact bytes (not truncated at 64 KiB). ' +
				'Returns at most ~48 KB of text; use offset/limit for big files. ' +
				'Binary files are refused — use download_file for those.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Absolute or ~-free path of the file.' },
					offset: { type: 'number', description: '0-based line to start from.' },
					limit: { type: 'number', description: 'Maximum number of lines to return.' },
				},
				required: ['path'],
			},
		},
		{
			name: 'list_dir',
			safe: true,
			description: 'List a directory on the VM (ls -la). Read-only.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Directory to list.' },
				},
				required: ['path'],
			},
		},
		{
			name: 'write_file',
			safe: false,
			description:
				'Create or overwrite a file on the VM with exactly this content; missing ' +
				'parent directories are created. Prefer this over shell heredocs/echo: the ' +
				'content is transferred as data, no quoting or escaping applies.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Where to write the file.' },
					content: { type: 'string', description: 'The entire file content.' },
				},
				required: ['path', 'content'],
			},
		},
		{
			name: 'edit_file',
			safe: false,
			description:
				'Replace an exact string in a text file on the VM. old_string must match ' +
				'exactly once (or pass replace_all). For whole-file rewrites use write_file.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file to edit.' },
					old_string: { type: 'string', description: 'Exact text to replace.' },
					new_string: { type: 'string', description: 'What to replace it with.' },
					replace_all: {
						type: 'boolean',
						description: 'Replace every occurrence instead of requiring uniqueness.',
					},
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
	];

	tools.push({
		name: 'share_local',
		// Copies the person's own file where their other tabs can see it —
		// visible, local, nothing executes and nothing leaves the machine.
		safe: true,
		description:
			'Share a VM file with every other machine the person has open on this ' +
			"site (the chat page's VM, split panes, other tabs): copies it into " +
			'/data/share/local, which every machine sees within seconds. Browser-local ' +
			'mirroring only — nothing is uploaded anywhere, works offline. Up to 16 MB.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The VM file to share.' },
			},
			required: ['path'],
		},
	});

	if (options.download) {
		tools.push({
			name: 'download_file',
			// Hands the user's own data to the user, visibly, as a browser
			// download; nothing about the VM changes.
			safe: true,
			description:
				'Send a file from the VM to the person as a browser download — the way ' +
				'out for compiled binaries and generated data. Up to 16 MB.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The VM file to download.' },
				},
				required: ['path'],
			},
		});
	}

	if (options.runJs) {
		tools.push({
			name: 'run_js',
			// Arbitrary code on the page's main thread: gated like run_shell.
			// §14 splits this from the guest: run_js is the page DIAGNOSTIC
			// (debug.js on the wire, like js(1) in the guest); Linux work
			// belongs to run_shell.
			safe: false,
			description:
				'Run JavaScript on the page hosting this VM — a page diagnostic (browser main ' +
				"thread, not the Linux; use run_shell for Linux work). `await` works; `document`, " +
				"`window` and `fetch` are the page's own, so " +
				'network requests obey CORS. Returns console output plus the completion value ' +
				'(expression results count: `6*7` returns 42). The timeout only interrupts code ' +
				'that awaits — a synchronous infinite loop freezes the page, so never write one.',
			parameters: {
				type: 'object',
				properties: {
					code: { type: 'string', description: 'The JavaScript to run.' },
					timeout: {
						type: 'number',
						description: 'Seconds before an awaiting script is abandoned. Default 10, max 120.',
					},
				},
				required: ['code'],
			},
		});
	}

	if (options.terminal) {
		tools.push({
			name: 'read_terminal',
			safe: true,
			description:
				"The last lines of the user's own terminal screen (the console on this " +
				'machine). Use it when they refer to something they are looking at — an ' +
				'error, an output — instead of asking them to paste it.',
			parameters: {
				type: 'object',
				properties: {
					lines: { type: 'number', description: 'How many lines back to read. Default 200.' },
				},
			},
		});
	}

	return {
		system_prompt: options.console ? PROMPT + CONSOLE_PROMPT : PROMPT,
		tools,
	};
}

/** What a gateway would answer at `GET /api/config`. */
export function vmDeviceConfig(): DeviceConfig {
	return { brand: 'Vinx Agent', gateway: { type: 'v86', firmware: 'linux' } };
}

/** POSIX single-quote escaping: the only shell-proof way to carry a path. */
export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Paths travel inside a shell line; newlines and NULs cannot. */
function validPath(p: unknown): p is string {
	return typeof p === 'string' && p.trim() !== '' && !/[\n\r\0]/.test(p);
}

function decodeText(bytes: Uint8Array): { text: string; binary: boolean } {
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) return { text: '', binary: true };
	}
	return { text: new TextDecoder().decode(bytes), binary: false };
}

/** The exit-code philosophy, shared by every tool that ran something: a
 * command that *executed* is `ok: true` whatever it printed — a non-zero exit
 * is data for the model, not a tool failure (the engine aborts a turn after
 * three failed calls, and probing for a missing file is not a failure). */
function ranOutcome(output: string, exit_code: number, timeoutNote?: string) {
	let text = output;
	if (timeoutNote) {
		text += `${text.endsWith('\n') ? '' : '\n'}${timeoutNote}`;
	} else if (exit_code !== 0) {
		text += `${text.endsWith('\n') ? '' : '\n'}[exit code: ${exit_code}]`;
	}
	return { status: 200, body: JSON.stringify({ ok: true, output: text, exit_code }) };
}

/**
 * Pull exact file bytes out of the guest. A clean /data path is the page's
 * own filesystem: read it directly, no guest round trip, no relay (§8.2).
 * Anything else stages through the §6.8 tmp namespace, because 9p reads are
 * exact while shell output inlines with a ceiling.
 */
async function readGuestFile(
	vm: ShellDevice,
	path: string,
	maxBytes: number,
): Promise<{ bytes: Uint8Array } | { failed: string; exit_code: number }> {
	if (!vm.readFile) return { failed: 'this device has no /data lane for exact reads', exit_code: 1 };
	const direct = dataRel(path);
	if (direct) {
		let bytes: Uint8Array;
		try {
			bytes = await vm.readFile(direct);
		} catch {
			return { failed: `not a regular file: ${path}`, exit_code: 1 };
		}
		if (bytes.byteLength > maxBytes) {
			return { failed: `${path} is ${bytes.byteLength} bytes (limit ${maxBytes})`, exit_code: 1 };
		}
		return { bytes };
	}
	const relay = ioName();
	const staged = await vm.runShell(
		`f=${shq(path)}; ` +
			`[ -f "$f" ] || { echo "not a regular file: $f"; exit 1; }; ` +
			`sz=$(wc -c < "$f"); [ "$sz" -le ${maxBytes} ] || { echo "$f is $sz bytes (limit ${maxBytes})"; exit 1; }; ` +
			`grep -q ' /data 9p ' /proc/mounts || { echo 'no /data mount in this image'; exit 1; }; ` +
			`cp -- "$f" /data/${relay}`,
		30,
	);
	if (staged.exit_code !== 0) return { failed: staged.output.trim(), exit_code: staged.exit_code };
	try {
		const bytes = await vm.readFile(relay);
		return { bytes };
	} finally {
		// Unlinked on the page side, which cannot race the next transfer's
		// staging cp the way a fire-and-forget guest rm once did; the shell
		// fallback (awaited, for bare ShellDevices) keeps the same property.
		if (vm.deleteData) vm.deleteData(relay);
		else await vm.runShell(`rm -f /data/${relay}`, 10).catch(() => {});
	}
}

/** The reverse lane: exact bytes into the guest. A clean /data path lands
 * page-side (parents created there); anything else stages through the tmp
 * namespace and a guest cp installs it. */
async function writeGuestFile(
	vm: ShellDevice,
	path: string,
	bytes: Uint8Array,
): Promise<{ ok: true } | { failed: string; exit_code: number }> {
	if (!vm.putFile) return { failed: 'this device has no /data lane for exact writes', exit_code: 1 };
	const direct = dataRel(path);
	if (direct) {
		try {
			const dir = direct.includes('/') ? direct.slice(0, direct.lastIndexOf('/')) : '';
			if (dir && vm.ensureDir) await vm.ensureDir(dir);
			await vm.putFile(direct, bytes);
			return { ok: true };
		} catch (e) {
			return {
				failed: `could not write ${path}: ${e instanceof Error ? e.message : String(e)}`,
				exit_code: 1,
			};
		}
	}
	const relay = ioName();
	await vm.putFile(relay, bytes);
	// Parent directories are created on the way: "write a file into a
	// directory that does not exist yet" is a thing models do constantly, and
	// failing it teaches them nothing useful. The prefix-strip is empty for a
	// root-level file, hence the `:-/` fallback; a bare filename (no slash)
	// skips the mkdir entirely. The relay is removed on every path out.
	const landed = await vm.runShell(
		`f=${shq(path)}; ` +
			`grep -q ' /data 9p ' /proc/mounts || { echo 'no /data mount in this image'; exit 1; }; ` +
			`case "$f" in */*) d="\${f%/*}"; mkdir -p -- "\${d:-/}" || { rm -f /data/${relay}; exit 1; };; esac; ` +
			`cp -- /data/${relay} "$f"; s=$?; rm -f /data/${relay}; exit $s`,
		30,
	);
	if (landed.exit_code !== 0) return { failed: landed.output.trim(), exit_code: landed.exit_code };
	return { ok: true };
}

/**
 * Answer one engine tool call with the VM.
 *
 * The reply body is the `CallOutcome` shape the engine parses: `{ok, output,
 * error}`. `ok: false` is reserved for the VM being unreachable or the call
 * itself being malformed; anything that ran reports through `ranOutcome`.
 */
export function vmCallHandler(vm: ShellDevice, extras: VmExtras = {}) {
	return async (body: string): Promise<{ status: number; body: string }> => {
		let name: unknown;
		let args: any;
		try {
			({ name, arguments: args } = JSON.parse(body));
		} catch {
			return refuse(400, 'the tool call was not valid JSON');
		}

		const started = Date.now();
		const outcome = await dispatch(vm, extras, name, args);
		// Wall-clock rides along on anything that ran, for the tool cards.
		try {
			const parsed = JSON.parse(outcome.body);
			if (parsed && parsed.ok === true) {
				parsed.duration_ms = Date.now() - started;
				return { status: outcome.status, body: JSON.stringify(parsed) };
			}
		} catch {
			/* not JSON we made; hand it back untouched */
		}
		return outcome;
	};
}

async function dispatch(
	vm: ShellDevice,
	extras: VmExtras,
	name: unknown,
	args: any,
): Promise<{ status: number; body: string }> {
	try {
		switch (name) {
			case 'run_shell':
				return await runShellTool(vm, args);
			case 'read_file':
				return await readFileTool(vm, args);
			case 'list_dir':
				return await listDirTool(vm, args);
			case 'write_file':
				return await writeFileTool(vm, args);
			case 'edit_file':
				return await editFileTool(vm, args);
			case 'share_local':
				return await shareLocalTool(vm, extras, args);
			case 'download_file':
				return await downloadFileTool(vm, extras, args);
			case 'run_js':
				return await runJsTool(extras, args);
			case 'read_terminal':
				return readTerminalTool(extras, args);
			default:
				return refuse(404, `no such tool: ${String(name)}`);
		}
	} catch (e) {
		// The VM itself is the failure here — not booted, or gone quiet.
		return refuse(200, e instanceof Error ? e.message : String(e));
	}
}

async function runShellTool(vm: ShellDevice, args: any) {
	const command = args?.command;
	if (typeof command !== 'string' || !command.trim()) {
		return refuse(400, "run_shell requires a non-empty 'command' string");
	}
	const timeout = clamp(Number(args?.timeout) || 30, 1, 120);
	const ran = await vm.runShell(command, timeout);
	// 137 is the guest-side SIGKILL-on-timeout (rund kills the process
	// group at timeoutMs, the same convention agentd used).
	return ranOutcome(
		ran.output,
		ran.exit_code,
		ran.exit_code === 137 ? `[killed: exceeded ${timeout}s]` : undefined,
	);
}

async function shareLocalTool(vm: ShellDevice, extras: VmExtras, args: any) {
	if (!validPath(args?.path)) return refuse(400, "share_local requires a 'path' string");
	// The guest's share(1) does the copy, the size check and the wording of
	// the result; the page-side snapshot mirrors and announces it. The
	// budget is generous for what is one cp: sharing is exactly the moment
	// two machines run at once (this VM and the tab being handed the file),
	// and two emulated CPUs on one host thread can make even a cp crawl —
	// 30 s was measured to starve under a long E2E suite's heat.
	const ran = await vm.runShell(`share local ${shq(args.path)}`, 60);
	if (ran.exit_code === 0) extras.onShared?.();
	return ranOutcome(ran.output, ran.exit_code);
}

async function readFileTool(vm: ShellDevice, args: any) {
	if (!validPath(args?.path)) return refuse(400, "read_file requires a 'path' string");
	const got = await readGuestFile(vm, args.path, MAX_TRANSFER_BYTES);
	if ('failed' in got) return ranOutcome(got.failed, got.exit_code);
	const { text, binary } = decodeText(got.bytes);
	if (binary) {
		return ranOutcome(
			`${args.path} is binary (${got.bytes.byteLength} bytes) — use download_file to hand it to the person, or run_shell with od/strings to inspect it`,
			0,
		);
	}
	const lines = text.split('\n');
	const offset = Math.max(0, Math.floor(Number(args?.offset) || 0));
	const limit = args?.limit != null ? Math.max(1, Math.floor(Number(args.limit))) : lines.length;
	let slice = lines.slice(offset, offset + limit).join('\n');
	let note = '';
	if (slice.length > MAX_READ_CHARS) {
		slice = slice.slice(0, MAX_READ_CHARS);
		note = `\n[truncated at ${MAX_READ_CHARS} chars — use offset/limit]`;
	} else if (offset > 0 || offset + limit < lines.length) {
		note = `\n[lines ${offset + 1}–${Math.min(offset + limit, lines.length)} of ${lines.length}]`;
	}
	return ranOutcome(slice + note, 0);
}

async function listDirTool(vm: ShellDevice, args: any) {
	if (!validPath(args?.path)) return refuse(400, "list_dir requires a 'path' string");
	// /data is the page's own filesystem: list it from the inodes (§8.2).
	const rel = dataRel(args.path);
	if (rel !== null && vm.listData) {
		try {
			return ranOutcome(formatListing(await vm.listData(rel)), 0);
		} catch (e) {
			return ranOutcome(e instanceof Error ? e.message : String(e), 1);
		}
	}
	// `--` so a name starting with a dash stays a name; the output rides the
	// shell channel (a listing fits the inline ceiling or the directory
	// needs run_shell with filters anyway).
	const ran = await vm.runShell(`ls -la -- ${shq(args.path)}`, 30);
	return ranOutcome(ran.output, ran.exit_code);
}

/** An ls-shaped listing from page-side inodes: type + permission bits,
 * size, mtime, name — /data listed without waking the guest. */
function formatListing(entries: DataEntry[]): string {
	if (entries.length === 0) return '(empty)';
	return [...entries]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((e) => {
			let bits = '';
			for (let i = 0; i < 9; i++) bits += e.mode & (0o400 >> i) ? 'rwxrwxrwx'[i] : '-';
			const when = new Date(e.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ');
			return `${e.dir ? 'd' : '-'}${bits} ${String(e.size).padStart(9)} ${when} ${e.name}${e.dir ? '/' : ''}`;
		})
		.join('\n');
}

async function writeFileTool(vm: ShellDevice, args: any) {
	if (!validPath(args?.path)) return refuse(400, "write_file requires a 'path' string");
	if (typeof args?.content !== 'string') {
		return refuse(400, "write_file requires a 'content' string");
	}
	const bytes = new TextEncoder().encode(args.content);
	if (bytes.byteLength > MAX_TRANSFER_BYTES) {
		return refuse(400, `content is ${bytes.byteLength} bytes; the ceiling is ${MAX_TRANSFER_BYTES}`);
	}
	const wrote = await writeGuestFile(vm, args.path, bytes);
	if ('failed' in wrote) return ranOutcome(wrote.failed, wrote.exit_code);
	return ranOutcome(`wrote ${bytes.byteLength} bytes to ${args.path}`, 0);
}

async function editFileTool(vm: ShellDevice, args: any) {
	if (!validPath(args?.path)) return refuse(400, "edit_file requires a 'path' string");
	const oldStr = args?.old_string;
	const newStr = args?.new_string;
	if (typeof oldStr !== 'string' || oldStr === '' || typeof newStr !== 'string') {
		return refuse(400, "edit_file requires non-empty 'old_string' and 'new_string' strings");
	}
	const got = await readGuestFile(vm, args.path, MAX_EDIT_BYTES);
	if ('failed' in got) return ranOutcome(got.failed, got.exit_code);
	const { text, binary } = decodeText(got.bytes);
	if (binary) return ranOutcome(`${args.path} is binary; edit_file only handles text`, 1);

	const hits = text.split(oldStr).length - 1;
	if (hits === 0) return ranOutcome(`old_string not found in ${args.path}`, 1);
	if (hits > 1 && !args?.replace_all) {
		return ranOutcome(
			`old_string appears ${hits} times in ${args.path}; extend it to be unique or pass replace_all`,
			1,
		);
	}
	const replaced = args?.replace_all
		? text.split(oldStr).join(newStr)
		: text.replace(oldStr, newStr);
	const wrote = await writeGuestFile(vm, args.path, new TextEncoder().encode(replaced));
	if ('failed' in wrote) return ranOutcome(wrote.failed, wrote.exit_code);
	return ranOutcome(`replaced ${hits} occurrence${hits === 1 ? '' : 's'} in ${args.path}`, 0);
}

async function downloadFileTool(vm: ShellDevice, extras: VmExtras, args: any) {
	if (!extras.download) return refuse(400, 'downloads are not available on this page');
	if (!validPath(args?.path)) return refuse(400, "download_file requires a 'path' string");
	const got = await readGuestFile(vm, args.path, MAX_TRANSFER_BYTES);
	if ('failed' in got) return ranOutcome(got.failed, got.exit_code);
	const base = args.path.split('/').pop() || 'file';
	const filename = base.replace(/[^\w.-]/g, '_') || 'file';
	extras.download(filename, got.bytes);
	return ranOutcome(
		`sent ${args.path} (${got.bytes.byteLength} bytes) to the person as a browser download (${filename})`,
		0,
	);
}

async function runJsTool(extras: VmExtras, args: any) {
	if (!extras.runJs) return refuse(400, 'run_js is not available on this page');
	if (typeof args?.code !== 'string' || !args.code.trim()) {
		return refuse(400, "run_js requires a non-empty 'code' string");
	}
	const timeout = clamp(Number(args?.timeout) || 10, 1, 120);
	// A script that threw still *ran*: ok:true with the error as output, so
	// the model reads it as data instead of tripping the three-failure fuse.
	const ran = await extras.runJs(args.code, timeout * 1000);
	return ranOutcome(ran.output, ran.ok ? 0 : 1);
}

function readTerminalTool(extras: VmExtras, args: any) {
	if (!extras.terminal) return refuse(400, 'there is no terminal on this page');
	const lines = clamp(Math.floor(Number(args?.lines) || 200), 1, 1000);
	const text = extras.terminal.read(lines);
	return ranOutcome(text.trim() === '' ? '(the screen is empty)' : text, 0);
}

function refuse(status: number, error: string) {
	return { status, body: JSON.stringify({ ok: false, error }) };
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}
