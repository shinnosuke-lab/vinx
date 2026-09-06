/**
 * The VM tool surface: dispatch, escaping, and the file lanes.
 *
 * The ShellDevice here is a stub with just enough shape: `runShell` records
 * commands and plays scripted results, `readFile`/`putFile` stand in for the
 * /data 9p lane. What matters is what commands the tools construct (quoting,
 * `--`), how outcomes map to the ok/exit_code philosophy, and that the pure
 * snapshot-diff logic the app's share-store leans on holds its corners.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	shq,
	vmCallHandler,
	vmToolsPayload,
	type DataEntry,
	type ShellDevice,
	type VmExtras,
} from '../src/device-vm';
import {
	diffSnapshot,
	listingFromEntries,
	MAX_MIRROR_DEPTH,
	MAX_MIRROR_FILES,
	mirrorable,
	mirrorablePath,
	totalBytes,
	walkListing,
} from '../../app/share-diff';

const enc = (s: string) => new TextEncoder().encode(s);

interface StubOptions {
	/** Bytes `readFile` returns (direct /data reads and staged relays alike). */
	fileBytes?: Uint8Array;
	/** Exit/output for the staging command (the one that cps to /data). */
	stage?: { exit_code: number; output: string };
	/** Exit/output for anything else (list_dir, run_shell, landing cp). */
	run?: { exit_code: number; output: string };
	/** What the page-side /data listing answers. */
	entries?: DataEntry[];
	/** Leave out the 9p lane entirely. */
	no9p?: boolean;
}

function stubVm(options: StubOptions = {}) {
	const commands: string[] = [];
	const reads: string[] = [];
	const deleted: string[] = [];
	const dirs: string[] = [];
	let put: { name: string; bytes: Uint8Array } | null = null;
	const vm: ShellDevice = {
		runShell: vi.fn(async (command: string) => {
			commands.push(command);
			// Staging is the guest-to-page direction: cp from the target into
			// the relay. The landing cp (page-to-guest) reads the other way.
			if (command.includes('cp -- "$f" /data/.vinx/tmp/io-')) {
				return options.stage ?? { exit_code: 0, output: '' };
			}
			return options.run ?? { exit_code: 0, output: '' };
		}),
		...(options.no9p
			? {}
			: {
					readFile: async (name: string) => {
						reads.push(name);
						return options.fileBytes ?? new Uint8Array();
					},
					putFile: async (name: string, bytes: Uint8Array) => {
						put = { name, bytes };
					},
					listData: async (name: string) => {
						if (!options.entries) throw new Error(`no such directory in /data: ${name}`);
						return options.entries;
					},
					ensureDir: async (name: string) => {
						dirs.push(name);
					},
					deleteData: (name: string) => {
						deleted.push(name);
					},
				}),
	};
	return {
		vm,
		commands,
		reads,
		deleted,
		dirs,
		lastPut: () => put?.bytes ?? null,
		putName: () => put?.name ?? null,
	};
}

function call(vm: ShellDevice, name: string, args: unknown, extras?: VmExtras) {
	return vmCallHandler(vm, extras)(JSON.stringify({ name, arguments: args }));
}

function body(res: { body: string }) {
	return JSON.parse(res.body) as { ok: boolean; output?: string; error?: string; exit_code?: number };
}

describe('shq', () => {
	it('wraps plainly', () => {
		expect(shq('/tmp/a.txt')).toBe("'/tmp/a.txt'");
	});
	it('survives embedded single quotes', () => {
		expect(shq("it's")).toBe("'it'\\''s'");
	});
	it('keeps spaces and dashes inert', () => {
		expect(shq('-rf and spaces')).toBe("'-rf and spaces'");
	});
});

describe('dispatch', () => {
	it('rejects broken JSON', async () => {
		const { vm } = stubVm();
		const res = await vmCallHandler(vm)('not json');
		expect(res.status).toBe(400);
		expect(body(res).ok).toBe(false);
	});
	it('404s an unknown tool', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'reboot_world', {});
		expect(res.status).toBe(404);
	});
});

describe('run_shell', () => {
	it('reports a non-zero exit as data, not failure', async () => {
		const { vm } = stubVm({ run: { exit_code: 1, output: 'nope' } });
		const res = await call(vm, 'run_shell', { command: 'test -f /x' });
		const out = body(res);
		expect(out.ok).toBe(true);
		expect(out.output).toContain('[exit code: 1]');
	});
	it('names the timeout kill', async () => {
		const { vm } = stubVm({ run: { exit_code: 137, output: '' } });
		const res = await call(vm, 'run_shell', { command: 'sleep 999', timeout: 5 });
		expect(body(res).output).toContain('[killed: exceeded 5s]');
	});
	it('refuses an empty command', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'run_shell', { command: '   ' });
		expect(res.status).toBe(400);
	});
});

describe('read_file', () => {
	it('returns exact text through the 9p lane', async () => {
		const { vm, commands, deleted } = stubVm({ fileBytes: enc('alpha\nbeta\n') });
		const res = await call(vm, 'read_file', { path: '/tmp/a b.txt' });
		expect(body(res).output).toContain('alpha');
		// The staging command carries the path shell-quoted, dash-safe, and
		// relays through the §6.8 tmp namespace.
		expect(commands[0]).toContain(shq('/tmp/a b.txt'));
		expect(commands[0]).toContain('cp -- "$f" /data/.vinx/tmp/io-');
		// And the relay is unlinked page-side afterwards.
		expect(deleted.some((n) => n.startsWith('.vinx/tmp/io-'))).toBe(true);
	});
	it('reads a clean /data path directly, no guest round trip', async () => {
		const { vm, commands, reads } = stubVm({ fileBytes: enc('direct\n') });
		const res = await call(vm, 'read_file', { path: '/data/notes.txt' });
		expect(body(res).output).toContain('direct');
		expect(reads).toEqual(['notes.txt']);
		expect(commands).toEqual([]);
	});
	it('sends a dot-segment /data path to the guest lane', async () => {
		const { vm, commands } = stubVm({
			stage: { exit_code: 1, output: 'not a regular file: /data/../etc/shadow\n' },
		});
		await call(vm, 'read_file', { path: '/data/../etc/shadow' });
		// The shell resolves ".." for real; the direct lane must not guess.
		expect(commands.length).toBeGreaterThan(0);
	});
	it('slices with offset/limit and says which lines', async () => {
		const { vm } = stubVm({ fileBytes: enc('l1\nl2\nl3\nl4\nl5') });
		const res = await call(vm, 'read_file', { path: '/f', offset: 1, limit: 2 });
		const out = body(res).output!;
		expect(out).toContain('l2\nl3');
		expect(out).not.toContain('l4');
		expect(out).toContain('[lines 2–3 of 5]');
	});
	it('refuses binaries toward download_file', async () => {
		const { vm } = stubVm({ fileBytes: new Uint8Array([65, 0, 66]) });
		const res = await call(vm, 'read_file', { path: '/bin/thing' });
		expect(body(res).output).toContain('binary');
	});
	it('passes staging failures through as data', async () => {
		const { vm } = stubVm({ stage: { exit_code: 1, output: 'not a regular file: /nope\n' } });
		const res = await call(vm, 'read_file', { path: '/nope' });
		const out = body(res);
		expect(out.ok).toBe(true);
		expect(out.output).toContain('not a regular file');
	});
	it('rejects paths with newlines outright', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'read_file', { path: '/tmp/a\nb' });
		expect(res.status).toBe(400);
	});
	it('says so when the device has no 9p lane', async () => {
		const { vm } = stubVm({ no9p: true });
		const res = await call(vm, 'read_file', { path: '/x' });
		expect(body(res).output).toContain('no /data lane');
	});
});

describe('list_dir', () => {
	it('constructs a flag-proof ls', async () => {
		const { vm, commands } = stubVm({ run: { exit_code: 0, output: 'total 0' } });
		await call(vm, 'list_dir', { path: '-rf' });
		expect(commands[0]).toBe(`ls -la -- ${shq('-rf')}`);
	});
	it('lists /data from the page-side inodes, no guest round trip', async () => {
		const { vm, commands } = stubVm({
			entries: [
				{ name: 'tool.sh', size: 123, mtime: 1_756_400_000, mode: 0o100755, dir: false },
				{ name: 'share', size: 0, mtime: 1_756_400_000, mode: 0o040755, dir: true },
			],
		});
		const res = await call(vm, 'list_dir', { path: '/data' });
		const out = body(res).output!;
		expect(out).toContain('-rwxr-xr-x');
		expect(out).toContain('tool.sh');
		expect(out).toContain('share/');
		expect(commands).toEqual([]);
	});
	it('reports a missing /data directory as data, not a tool failure', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'list_dir', { path: '/data/absent' });
		const out = body(res);
		expect(out.ok).toBe(true);
		expect(out.exit_code).toBe(1);
		expect(out.output).toContain('no such directory');
	});
});

describe('write_file', () => {
	it('lands exact bytes via the 9p lane', async () => {
		const { vm, commands, lastPut } = stubVm();
		const res = await call(vm, 'write_file', { path: "/etc/it's.conf", content: 'x=1\n' });
		expect(body(res).output).toContain('wrote 4 bytes');
		expect(new TextDecoder().decode(lastPut()!)).toBe('x=1\n');
		const landing = commands.find((c) => c.includes('cp -- /data/.vinx/tmp/io-'));
		expect(landing).toContain(`f=${shq("/etc/it's.conf")}`);
	});
	it('writes a clean /data path directly, parents made page-side', async () => {
		const { vm, commands, dirs, putName, lastPut } = stubVm();
		const res = await call(vm, 'write_file', { path: '/data/sub/deep/a.txt', content: 'hi' });
		expect(body(res).output).toContain('wrote 2 bytes');
		expect(dirs).toEqual(['sub/deep']);
		expect(putName()).toBe('sub/deep/a.txt');
		expect(new TextDecoder().decode(lastPut()!)).toBe('hi');
		expect(commands).toEqual([]);
	});
	it('creates missing parent directories on the way', async () => {
		const { vm, commands } = stubVm();
		await call(vm, 'write_file', { path: '/newdir/sub/a.txt', content: 'hi' });
		const landing = commands.find((c) => c.includes('cp -- /data/.vinx/tmp/io-'))!;
		expect(landing).toContain('mkdir -p --');
	});
	it('uses a unique relay name and removes it whatever cp did', async () => {
		const { vm, commands } = stubVm();
		await call(vm, 'write_file', { path: '/a', content: '1' });
		await call(vm, 'write_file', { path: '/b', content: '2' });
		const relays = commands
			.map((c) => c.match(/\/data\/\.vinx\/tmp\/(io-\w+)/)?.[1])
			.filter((r): r is string => !!r);
		expect(new Set(relays).size).toBeGreaterThan(1);
		for (const c of commands) {
			if (c.includes('cp -- /data/.vinx/tmp/io-')) expect(c).toContain('rm -f /data/.vinx/tmp/io-');
		}
	});
	it('requires content to be a string', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'write_file', { path: '/x', content: 7 });
		expect(res.status).toBe(400);
	});
});

describe('edit_file', () => {
	it('replaces a unique match and writes back', async () => {
		const { vm, lastPut } = stubVm({ fileBytes: enc('a=1\nb=2\n') });
		const res = await call(vm, 'edit_file', { path: '/f', old_string: 'b=2', new_string: 'b=3' });
		expect(body(res).output).toContain('replaced 1 occurrence');
		expect(new TextDecoder().decode(lastPut()!)).toBe('a=1\nb=3\n');
	});
	it('reports a miss as data', async () => {
		const { vm } = stubVm({ fileBytes: enc('a=1\n') });
		const res = await call(vm, 'edit_file', { path: '/f', old_string: 'zz', new_string: 'y' });
		const out = body(res);
		expect(out.ok).toBe(true);
		expect(out.output).toContain('not found');
	});
	it('demands uniqueness unless replace_all', async () => {
		const { vm, lastPut } = stubVm({ fileBytes: enc('x x x') });
		const ambiguous = await call(vm, 'edit_file', { path: '/f', old_string: 'x', new_string: 'y' });
		expect(body(ambiguous).output).toContain('3 times');
		const all = await call(vm, 'edit_file', {
			path: '/f',
			old_string: 'x',
			new_string: 'y',
			replace_all: true,
		});
		expect(body(all).output).toContain('replaced 3 occurrences');
		expect(new TextDecoder().decode(lastPut()!)).toBe('y y y');
	});
	it('refuses binaries', async () => {
		const { vm } = stubVm({ fileBytes: new Uint8Array([0]) });
		const res = await call(vm, 'edit_file', { path: '/f', old_string: 'a', new_string: 'b' });
		expect(body(res).output).toContain('binary');
	});
});

describe('download_file', () => {
	it('hands sanitized name and exact bytes to the sink', async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const { vm } = stubVm({ fileBytes: bytes });
		const got: Array<[string, Uint8Array]> = [];
		const res = await call(
			vm,
			'download_file',
			{ path: '/root/my app!.bin' },
			{ download: (n, b) => got.push([n, b]) },
		);
		expect(body(res).output).toContain('browser download');
		expect(got).toHaveLength(1);
		expect(got[0][0]).toBe('my_app_.bin');
		expect(got[0][1]).toEqual(bytes);
	});
	it('is refused where the page offers no sink', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'download_file', { path: '/x' });
		expect(res.status).toBe(400);
	});
});

describe('share_local', () => {
	it('runs the guest share(1) with the path quoted and kicks the snapshot', async () => {
		const { vm, commands } = stubVm({ run: { exit_code: 0, output: 'share: ...' } });
		const onShared = vi.fn();
		const res = await call(vm, 'share_local', { path: "/root/it's done.txt" }, { onShared });
		expect(body(res).ok).toBe(true);
		expect(commands[0]).toBe("share local '/root/it'\\''s done.txt'");
		expect(onShared).toHaveBeenCalledTimes(1);
	});
	it('reports a failed share as data and does not kick the snapshot', async () => {
		const { vm } = stubVm({ run: { exit_code: 1, output: 'share: /x: no such file' } });
		const onShared = vi.fn();
		const res = await call(vm, 'share_local', { path: '/x' }, { onShared });
		const out = body(res);
		expect(out.ok).toBe(true);
		expect(out.exit_code).toBe(1);
		expect(out.output).toContain('no such file');
		expect(onShared).not.toHaveBeenCalled();
	});
	it('requires a sane path', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'share_local', { path: 'a\nb' });
		expect(res.status).toBe(400);
	});
});

describe('run_js', () => {
	it('runs through the page-provided executor with the timeout in ms', async () => {
		const { vm } = stubVm();
		const runJs = vi.fn(async () => ({ ok: true, output: '42' }));
		const res = await call(vm, 'run_js', { code: '6*7', timeout: 5 }, { runJs });
		expect(body(res).ok).toBe(true);
		expect(body(res).output).toBe('42');
		expect(runJs).toHaveBeenCalledWith('6*7', 5000);
	});
	it('reports a script that threw as data with exit 1, not a tool failure', async () => {
		const { vm } = stubVm();
		const runJs = vi.fn(async () => ({ ok: false, output: 'TypeError: nope' }));
		const res = await call(vm, 'run_js', { code: 'nope()' }, { runJs });
		const out = body(res);
		expect(out.ok).toBe(true);
		expect(out.exit_code).toBe(1);
		expect(out.output).toContain('TypeError: nope');
	});
	it('refuses an empty script', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'run_js', { code: '  ' }, { runJs: async () => ({ ok: true, output: '' }) });
		expect(res.status).toBe(400);
	});
	it('is refused on pages without an executor', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'run_js', { code: '1' });
		expect(res.status).toBe(400);
	});
});

describe('read_terminal', () => {
	it('reads through the page-provided reader with clamped lines', async () => {
		const { vm } = stubVm();
		const read = vi.fn(() => 'the screen');
		const res = await call(vm, 'read_terminal', { lines: 99999 }, { terminal: { read } });
		expect(body(res).output).toBe('the screen');
		expect(read).toHaveBeenCalledWith(1000);
	});
	it('describes an empty screen instead of returning nothing', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'read_terminal', {}, { terminal: { read: () => '  ' } });
		expect(body(res).output).toContain('empty');
	});
	it('is refused on pages without a terminal', async () => {
		const { vm } = stubVm();
		const res = await call(vm, 'read_terminal', {});
		expect(res.status).toBe(400);
	});
});

describe('vmToolsPayload', () => {
	const names = (p: unknown) => (p as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
	it('always carries the file tools, run_shell and share_local', () => {
		expect(names(vmToolsPayload())).toEqual([
			'run_shell',
			'read_file',
			'list_dir',
			'write_file',
			'edit_file',
			'share_local',
		]);
	});
	it('declares download/terminal/run_js only when the page can serve them', () => {
		const full = names(vmToolsPayload({ download: true, terminal: true, runJs: true }));
		expect(full).toContain('download_file');
		expect(full).toContain('read_terminal');
		expect(full).toContain('run_js');
		expect(names(vmToolsPayload({ download: true }))).not.toContain('read_terminal');
		expect(names(vmToolsPayload({ download: true }))).not.toContain('run_js');
	});
	it('marks exactly the read-only tools safe', () => {
		const tools = (vmToolsPayload({ download: true, terminal: true, runJs: true }) as any).tools;
		const safe = Object.fromEntries(tools.map((t: any) => [t.name, t.safe]));
		expect(safe).toEqual({
			run_shell: false,
			read_file: true,
			list_dir: true,
			write_file: false,
			edit_file: false,
			// Copies the person's own file where their other tabs see it;
			// nothing executes and nothing leaves the machine.
			share_local: true,
			download_file: true,
			// Arbitrary code on the page: gated exactly like run_shell.
			run_js: false,
			read_terminal: true,
		});
	});
});

describe('share-diff', () => {
	it('folds inode entries into the listing: regular visible files only', () => {
		const entries: DataEntry[] = [
			{ name: 'a|b.txt', size: 12, mtime: 1700000000, mode: 0o100644, dir: false },
			{ name: 'run.sh', size: 9, mtime: 7, mode: 0o100755, dir: false },
			{ name: 'share', size: 0, mtime: 1, mode: 0o040755, dir: true },
			// Dot-names stay out by rule (§12.1), not by a glob's luck.
			{ name: '.vinx', size: 0, mtime: 1, mode: 0o040755, dir: true },
			{ name: '.secret', size: 5, mtime: 1, mode: 0o100644, dir: false },
			// A symlink is not bytes the mirror can carry.
			{ name: 'link', size: 4, mtime: 1, mode: 0o120777, dir: false },
			{ name: 'x'.repeat(129), size: 1, mtime: 1, mode: 0o100644, dir: false },
		];
		const listing = listingFromEntries(entries);
		expect([...listing.keys()].sort()).toEqual(['a|b.txt', 'run.sh']);
		expect(listing.get('a|b.txt')).toEqual({ size: 12, mtime: 1700000000, exec: false });
		// The executable bit rides out of the mode.
		expect(listing.get('run.sh')).toEqual({ size: 9, mtime: 7, exec: true });
	});
	it('tags the shared tier with its sanctioned prefix', () => {
		const listing = listingFromEntries(
			[{ name: 'a.txt', size: 5, mtime: 6, mode: 0o100644, dir: false }],
			'share/local/',
		);
		expect(listing.get('share/local/a.txt')).toEqual({ size: 5, mtime: 6, exec: false });
	});
	it('mirrorable refuses dot-dirs, slashes and monsters', () => {
		expect(mirrorable('ok.txt')).toBe(true);
		expect(mirrorable('.')).toBe(false);
		expect(mirrorable('a/b')).toBe(false);
		expect(mirrorable('x'.repeat(129))).toBe(false);
	});
	it('diffs additions, changes, mirror gaps and removals', () => {
		const prev = new Map([
			['same', { size: 1, mtime: 1, exec: false }],
			['grew', { size: 1, mtime: 1, exec: false }],
			['gone', { size: 1, mtime: 1, exec: false }],
			['bit', { size: 1, mtime: 1, exec: false }],
		]);
		const next = new Map([
			['same', { size: 1, mtime: 1, exec: false }],
			['grew', { size: 2, mtime: 2, exec: false }],
			['new', { size: 3, mtime: 3, exec: false }],
			// chmod +x moves no bytes and (on a fast machine) no mtime; the
			// exec flag alone must be enough to re-read.
			['bit', { size: 1, mtime: 1, exec: true }],
		]);
		const mirrored = new Set(['grew', 'gone', 'bit']); // 'same' missing: a failed earlier write
		const { read, remove } = diffSnapshot(prev, next, mirrored);
		expect(read.sort()).toEqual(['bit', 'grew', 'new', 'same']);
		expect(remove).toEqual(['gone']);
	});
	it('sums listing sizes for the quota gate', () => {
		expect(
			totalBytes(
				new Map([
					['a', { size: 10, mtime: 0, exec: false }],
					['b', { size: 5, mtime: 0, exec: false }],
				]),
			),
		).toBe(15);
	});
	it('mirrorablePath carries sane trees and refuses the §12.1 rejects', () => {
		expect(mirrorablePath('proj/sub/main.c')).toBe(true);
		expect(mirrorablePath('apps/clock.vapp')).toBe(true);
		expect(mirrorablePath('')).toBe(false);
		expect(mirrorablePath('a//b')).toBe(false);
		expect(mirrorablePath('a/../b')).toBe(false);
		expect(mirrorablePath('.vinx/tmp/x')).toBe(false);
		expect(mirrorablePath('proj/.git/config')).toBe(false);
		expect(mirrorablePath('a|b/c')).toBe(false);
		expect(mirrorablePath('a\nb')).toBe(false);
		expect(mirrorablePath(`${'d/'.repeat(MAX_MIRROR_DEPTH)}f`)).toBe(false);
		expect(mirrorablePath('x'.repeat(513))).toBe(false);
	});
});

describe('walkListing', () => {
	/** A /data tree as walkListing sees it: rel path -> entries. */
	function lister(tree: Record<string, DataEntry[]>) {
		return {
			listData: async (rel: string) => tree[rel] ?? [],
		};
	}
	const file = (name: string, size = 1, mode = 0o100644): DataEntry => ({
		name,
		size,
		mtime: 1,
		mode,
		dir: false,
	});
	const dir = (name: string): DataEntry => ({ name, size: 0, mtime: 1, mode: 0o040755, dir: true });

	it('walks nested trees, keys on relative paths, carries the exec bit', async () => {
		const { listing, overflow } = await walkListing(
			lister({
				'': [file('top.txt', 5), dir('proj')],
				proj: [dir('sub'), file('build.sh', 9, 0o100755)],
				'proj/sub': [file('main.c', 7)],
			}),
		);
		expect(overflow).toBe(false);
		expect([...listing.keys()].sort()).toEqual(['proj/build.sh', 'proj/sub/main.c', 'top.txt']);
		expect(listing.get('proj/build.sh')).toEqual({ size: 9, mtime: 1, exec: true });
	});
	it('skips share/ and host/ at the root only, dot-names anywhere', async () => {
		const { listing } = await walkListing(
			lister({
				'': [dir('share'), dir('host'), dir('.vinx'), dir('proj')],
				proj: [dir('host'), file('a.txt'), dir('.git')],
				'proj/host': [file('inner.txt')],
				// Never listed: the walk must not even descend into these.
				share: [file('local-should-not-appear')],
				host: [file('disk-should-not-appear')],
				'.vinx': [file('tmp-should-not-appear')],
				'proj/.git': [file('config')],
			}),
		);
		expect([...listing.keys()].sort()).toEqual(['proj/a.txt', 'proj/host/inner.txt']);
	});
	it('drops symlinks and unsayable names, cuts past the depth cap', async () => {
		const deep: Record<string, DataEntry[]> = {
			'': [file('ok.txt'), { name: 'ln', size: 4, mtime: 1, mode: 0o120777, dir: false }, dir('d1')],
		};
		let rel = 'd1';
		for (let i = 1; i < MAX_MIRROR_DEPTH + 2; i++) {
			deep[rel] = [file(`f${i}.txt`), dir(`d${i + 1}`)];
			rel = `${rel}/d${i + 1}`;
		}
		const { listing } = await walkListing(lister(deep));
		expect(listing.has('ok.txt')).toBe(true);
		expect(listing.has('ln')).toBe(false);
		// Depth 1..MAX-1 files fit; the directory at MAX is not entered.
		expect(listing.has(`d1/f1.txt`)).toBe(true);
		const past = [...listing.keys()].filter((k) => k.split('/').length > MAX_MIRROR_DEPTH);
		expect(past).toEqual([]);
	});
	it('marks overflow past the file-count cap instead of half-carrying', async () => {
		const many = Array.from({ length: MAX_MIRROR_FILES + 1 }, (_, i) => file(`f${i}.txt`));
		const { overflow } = await walkListing(lister({ '': many }));
		expect(overflow).toBe(true);
	});
});
