// Pack the apps this page ships with (§9 — the bundled apps) into .vapp
// files the page seeds into a fresh machine's /data/apps on first load.
//
//   ../apps/<id>/            the source of each: an app directory as `app
//                            pack` would take it (app.json, its files)
//   app/gen/apps/<id>.vapp   its package — the same tar.gz `app pack` writes
//   app/gen/bundled-apps.json  what the page needs to know without opening
//                            one: id, kind, whether it is a pure web window,
//                            title, description, size, sha256
//
// Runs before `vite` (see package.json's dev/build); the page module is
// app/bundled-apps.ts. The output lives under app/gen/, which is ignored by
// git — the source of truth is ../apps/.
//
// The package is written here rather than by the host's tar: busybox tar in
// the machine and the page's reader (app/vapp.ts) both speak plain ustar,
// and a host tar adds pax headers, platform mtimes and the builder's uid to
// every entry — three ways for the same source to make different bytes.
// Entries are `./path`, uid/gid 0, mtime 0, mode 0755 where the source file
// is executable (an `exec` entry point must be) and 0644 otherwise, in name
// order: the same source packs to the same package on any machine.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'apps');
const gen = join(here, 'app', 'gen');
const out = join(gen, 'apps');

// The manifest rules `app check` applies (app/app-check.ts spells the same
// numbers for the page): an id is short and lower-case, a title fits a card,
// a description a tooltip.
const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_IDS = new Set(['app', 'enabled', 'factory', 'rpc', 'rpcd', 'rund', 'vinx']);
const TITLE_MAX = 64;
const DESCRIPTION_MAX = 240;
const KINDS = new Set(['window', 'service', 'command']);
const BLOCK = 512;

/** Regular files under `dir`, paths relative to it, name order; dotfiles
 * (editor droppings) stay out — `app pack` would take them, a repository
 * should not ship them. */
function walk(dir, prefix = '') {
	const names = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (entry.name.startsWith('.')) continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) names.push(...walk(join(dir, entry.name), rel));
		else if (entry.isFile()) names.push(rel);
	}
	return names;
}

/** One ustar header block (the layout app/vapp.ts's reader and writer use). */
function header(name, size, mode) {
	const block = Buffer.alloc(BLOCK);
	const put = (at, len, text) => block.write(text, at, len, 'latin1');
	const oct = (at, len, n) => put(at, len, n.toString(8).padStart(len - 1, '0'));
	put(0, 100, name);
	oct(100, 8, mode);
	oct(108, 8, 0); // uid
	oct(116, 8, 0); // gid
	oct(124, 12, size);
	oct(136, 12, 0); // mtime
	block.write('        ', 148, 8, 'latin1'); // checksum: spaces while summing
	block[156] = 0x30; // '0': a regular file
	put(257, 6, 'ustar');
	put(263, 2, '00');
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += block[i];
	// Six octal digits, a NUL, a space — what every tar writes here.
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
	return block;
}

/** The package: a gzipped ustar of `files` ({name, data, mode}), `./`-prefixed
 * entries and the two-block trailer, as `tar czf out -C dir .` lays them. */
function pack(files) {
	const parts = [];
	for (const { name, data, mode } of files) {
		parts.push(header(`./${name}`, data.length, mode), data);
		const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
		if (pad) parts.push(Buffer.alloc(pad));
	}
	parts.push(Buffer.alloc(BLOCK * 2));
	return gzipSync(Buffer.concat(parts), { level: 9 });
}

function fail(id, why) {
	throw new Error(`apps/${id}: ${why}`);
}

/** Read and check one app directory the way `app check` would; returns the
 * summary the page keeps and the files to pack. */
function readApp(id) {
	const dir = join(source, id);
	if (!APP_ID.test(id) || RESERVED_IDS.has(id)) fail(id, 'not a usable app id (lower-case letters, digits, dashes; 32 at most)');
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'));
	} catch (e) {
		fail(id, `app.json does not parse: ${e instanceof Error ? e.message : e}`);
	}
	if (manifest.schema !== 1) fail(id, `app.json schema ${JSON.stringify(manifest.schema)} (this page speaks 1)`);
	const kind = manifest.kind ?? 'command';
	if (!KINDS.has(kind)) fail(id, `kind ${JSON.stringify(kind)} is none of window, service, command`);
	const title = manifest.title ?? '';
	const description = manifest.description ?? '';
	if (typeof title !== 'string' || title.length > TITLE_MAX) fail(id, `title is not a string of at most ${TITLE_MAX} characters`);
	if (typeof description !== 'string' || description.length > DESCRIPTION_MAX)
		fail(id, `description is not a string of at most ${DESCRIPTION_MAX} characters`);
	const names = walk(dir);
	const files = names.map((name) => {
		const mode = statSync(join(dir, name)).mode & 0o111 ? 0o755 : 0o644;
		return { name, data: readFileSync(join(dir, name)), mode };
	});
	const uiType = manifest.ui?.type ?? '';
	const exec = manifest.exec ?? '';
	const web = kind === 'window' && uiType === 'web' && exec === '';
	if (exec) {
		const entry = exec.replace(/^\.\//, '');
		const file = files.find((f) => f.name === entry);
		if (!file) fail(id, `exec ${exec} names no file in the directory`);
		if (file.mode !== 0o755) fail(id, `exec ${exec} is not executable (chmod +x it)`);
	} else if (!web) {
		fail(id, `no exec, and not a pure web window (kind window, ui.type web)`);
	}
	if (web && !names.includes('index.html')) fail(id, 'a pure web window without index.html');
	return { id, kind, web, title, description, files };
}

const ids = readdirSync(source, { withFileTypes: true })
	.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
	.map((e) => e.name)
	.sort();

mkdirSync(out, { recursive: true });
// Stale packages of apps no longer in ../apps/ would otherwise ride along in
// a build forever.
for (const name of readdirSync(out)) {
	if (name.endsWith('.vapp') && !ids.includes(name.slice(0, -'.vapp'.length))) rmSync(join(out, name));
}

const summary = [];
for (const id of ids) {
	const app = readApp(id);
	const bytes = pack(app.files);
	writeFileSync(join(out, `${id}.vapp`), bytes);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	summary.push({
		id,
		kind: app.kind,
		web: app.web,
		title: app.title,
		description: app.description,
		files: app.files.length,
		bytes: bytes.length,
		sha256,
	});
	console.log(
		`${id} (${app.kind}${app.web ? ', web' : ''}): ${app.files.length} file(s), ${bytes.length} bytes -> ${relative(here, join(out, `${id}.vapp`))}`,
	);
	console.log(`  sha256 ${sha256}`);
}
writeFileSync(join(gen, 'bundled-apps.json'), `${JSON.stringify(summary, null, '\t')}\n`);
if (!ids.length) console.log(`no apps under ${relative(here, source)}; the page seeds none`);
