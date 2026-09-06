/**
 * The page-side reader and writer of a `.vapp` (app/vapp.ts): the tar.gz
 * `app pack` makes, opened without the machine so a pure web app can run
 * while it is off — and written without it, so the model can install one.
 * The reader's fixtures are real archives from the host's tar — the same
 * ustar layout busybox writes for these short names; the writer's output is
 * checked by that same tar, not only by our own reader.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isPureWebApp, manifestOf, packVapp, unpackVapp, webBundleOf } from '../../app/vapp';

/** `app pack` in miniature: files → dir → `tar czf out -C dir .` */
function pack(files: Record<string, string>, tarArgs: string[] = []): Uint8Array {
	const dir = mkdtempSync(join(tmpdir(), 'vapp-'));
	for (const [path, body] of Object.entries(files)) {
		const full = join(dir, path);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, body);
	}
	const out = join(dir, '..', `${dir.split('/').pop()}.vapp`);
	// COPYFILE_DISABLE: macOS's bsdtar would add `._*` AppleDouble twins
	// for every file — a host artefact busybox tar never writes.
	execFileSync('tar', ['czf', out, ...tarArgs, '-C', dir, '.'], {
		env: { ...process.env, COPYFILE_DISABLE: '1' },
	});
	return new Uint8Array(readFileSync(out));
}

const WEB = {
	'app.json': '{"schema":1,"kind":"window","ui":{"type":"web"},"title":"Two Oh Four Eight"}\n',
	'index.html': '<h1 id="t">hi</h1>\n',
	'style.css': 'body{margin:0}\n',
	'app.js': "document.getElementById('t').textContent='from js'\n",
	'README.md': 'a web app\n',
};

describe('unpackVapp', () => {
	it('reads every regular file of a packed app, paths relative to the app directory', async () => {
		const files = await unpackVapp(pack(WEB));
		expect(files).not.toBeNull();
		expect([...files!.keys()].sort()).toEqual(['README.md', 'app.js', 'app.json', 'index.html', 'style.css']);
		expect(new TextDecoder().decode(files!.get('index.html'))).toBe(WEB['index.html']);
	});

	it('keeps nested paths and skips directory entries', async () => {
		const files = await unpackVapp(pack({ 'app.json': '{"kind":"command"}', run: '#!/bin/sh\n', 'lib/util.sh': 'x=1\n' }));
		expect(files).not.toBeNull();
		expect([...files!.keys()].sort()).toEqual(['app.json', 'lib/util.sh', 'run']);
	});

	it('gives up on bytes that are not a gzip, or not a tar inside', async () => {
		expect(await unpackVapp(new Uint8Array([1, 2, 3, 4]))).toBeNull();
		// A gzip of junk: inflates, then the first block fails the checksum.
		const junk = pack({ 'x.txt': 'hello' });
		const tar = new Uint8Array(await new Response(new Blob([junk.slice().buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
		tar[0] ^= 0xff; // break the name → the checksum no longer matches
		const regz = new Uint8Array(await new Response(new Blob([tar.slice().buffer]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
		expect(await unpackVapp(regz)).toBeNull();
	});
});

describe('webBundleOf', () => {
	it('stages the three files app-run would, in the §10.3 bundle shape', async () => {
		const files = (await unpackVapp(pack(WEB)))!;
		const m = manifestOf(files);
		expect(m?.kind).toBe('window');
		expect(m?.title).toBe('Two Oh Four Eight');
		expect(isPureWebApp(m)).toBe(true);
		expect(webBundleOf(files)).toEqual({ html: WEB['index.html'], css: WEB['style.css'], js: WEB['app.js'] });
	});

	it('leaves the optional parts empty rather than missing', async () => {
		const files = (await unpackVapp(pack({ 'app.json': WEB['app.json'], 'index.html': '<p>solo</p>' })))!;
		expect(webBundleOf(files)).toEqual({ html: '<p>solo</p>', css: '', js: '' });
	});

	it('is null for anything that needs the machine: a service, a hybrid window, a tty window, no index.html', async () => {
		const svc = (await unpackVapp(pack({ 'app.json': '{"kind":"service","exec":"./run"}', run: '#!/bin/sh\n' })))!;
		expect(isPureWebApp(manifestOf(svc))).toBe(false);
		expect(webBundleOf(svc)).toBeNull();
		const hybrid = (await unpackVapp(pack({ ...WEB, 'app.json': '{"kind":"window","ui":{"type":"web"},"exec":"./server"}', server: '#!/bin/sh\n' })))!;
		expect(webBundleOf(hybrid)).toBeNull();
		const tty = (await unpackVapp(pack({ 'app.json': '{"kind":"window","ui":{"type":"tty"},"exec":"./run"}', run: '#!/bin/sh\n' })))!;
		expect(webBundleOf(tty)).toBeNull();
		const noHtml = (await unpackVapp(pack({ 'app.json': WEB['app.json'], 'app.js': '1' })))!;
		expect(webBundleOf(noHtml)).toBeNull();
	});
});

describe('packVapp', () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	const files = new Map(Object.entries(WEB).map(([k, v]) => [k, enc(v)]));

	it('round-trips through our own reader byte for byte', async () => {
		const back = await unpackVapp(await packVapp(files));
		expect(back).not.toBeNull();
		expect([...back!.keys()].sort()).toEqual([...files.keys()].sort());
		for (const [name, data] of files) expect(back!.get(name)).toEqual(data);
		expect(webBundleOf(back!)).toEqual({ html: WEB['index.html'], css: WEB['style.css'], js: WEB['app.js'] });
	});

	it('is a tar.gz the system tar unpacks to the same files, ./-prefixed like `app pack`', async () => {
		const bytes = await packVapp(files);
		const dir = mkdtempSync(join(tmpdir(), 'vapp-out-'));
		const pkg = join(dir, 'x.vapp');
		writeFileSync(pkg, bytes);
		const listing = execFileSync('tar', ['tzf', pkg]).toString().trim().split('\n').sort();
		expect(listing).toEqual(Object.keys(WEB).map((n) => `./${n}`).sort());
		const out = join(dir, 'tree');
		mkdirSync(out);
		execFileSync('tar', ['xzf', pkg, '-C', out]);
		expect(readdirSync(out).sort()).toEqual(Object.keys(WEB).sort());
		for (const [name, body] of Object.entries(WEB)) expect(readFileSync(join(out, name), 'utf8')).toBe(body);
	});

	it('pads data to 512-byte blocks and handles an empty part', async () => {
		const back = await unpackVapp(await packVapp(new Map([['app.json', enc('{}')], ['style.css', new Uint8Array()], ['index.html', enc('x'.repeat(513))]])));
		expect(back!.get('style.css')).toEqual(new Uint8Array());
		expect(back!.get('index.html')!.byteLength).toBe(513);
	});

	it('refuses names that could escape or that ustar cannot hold', async () => {
		await expect(packVapp(new Map([['../x', enc('1')]]))).rejects.toThrow(/bad entry name/);
		await expect(packVapp(new Map([['/abs', enc('1')]]))).rejects.toThrow(/bad entry name/);
		await expect(packVapp(new Map([['a'.repeat(120), enc('1')]]))).rejects.toThrow(/too long/);
	});
});
