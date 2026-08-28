/**
 * Package the repository's own skill into an asset the page can install.
 *
 * `skills/linux-vm/` is the reference for the Linux this page emulates: what
 * the busybox userland can and cannot do, how run_shell behaves, where the
 * network does and does not reach. In the system prompt it would be sent on
 * every single request; as a skill it costs a name and a description until the
 * model asks for it, and it can be as long as it needs to be.
 *
 * This writes a zip into the page's assets, and `app/main.tsx` installs it
 * into the workspace on first load. The same zip is what would be published to
 * a skills repository (see version.sh's SKILLS_REPO), so the format has to be
 * exactly what `/api/skills/import` accepts.
 *
 * Written with no compression, which keeps the writer to the three record types
 * the format cannot do without. A `zip(1)` dependency would buy a smaller file
 * and a build that fails differently on someone's machine.
 *
 * Run by `npm run build` and `npm run dev`; output is gitignored.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SKILL = 'linux-vm';
const source = resolve(here, '..', 'skills', SKILL);
const gen = resolve(here, 'app', 'gen');

/** Every file under `dir`, as paths relative to it, sorted for reproducibility. */
function walk(dir, prefix = '') {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (entry.name.startsWith('.')) continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip of `files`, each `{ name, data }`. */
function zip(files) {
	const locals = [];
	const central = [];
	let offset = 0;

	for (const { name, data } of files) {
		const path = Buffer.from(name);
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(path.length, 26);
		locals.push(local, path, data);

		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(path.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, path);

		offset += local.length + path.length + data.length;
	}

	const body = Buffer.concat(locals);
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(body.length, 16);

	return Buffer.concat([body, directory, end]);
}

const names = walk(source);
if (!names.includes('SKILL.md')) {
	throw new Error(`${source} has no SKILL.md; a skill package without one is refused on import`);
}

const files = names.map((name) => ({ name: `${SKILL}/${name}`, data: readFileSync(join(source, name)) }));
const skillMd = readFileSync(join(source, 'SKILL.md'), 'utf8');
const version = /^version:\s*(.+)$/m.exec(skillMd)?.[1]?.trim();
if (!version) {
	// The page reinstalls when the version changes, so an unversioned skill
	// would be either never updated or reinstalled on every load.
	throw new Error(`${join(source, 'SKILL.md')} has no \`version:\` in its frontmatter`);
}

const bytes = zip(files);
mkdirSync(gen, { recursive: true });
writeFileSync(join(gen, `${SKILL}.zip`), bytes);
writeFileSync(
	join(gen, 'bundled-skill.json'),
	`${JSON.stringify({ name: SKILL, version, files: names.length, bytes: bytes.length }, null, '\t')}\n`,
);

console.log(
	`${SKILL} ${version}: ${names.length} file(s), ${bytes.length} bytes -> ${relative(here, join(gen, `${SKILL}.zip`))}`,
);
// A repository index names each package's sha256; printing it here is what
// makes publishing this zip a copy and a paste rather than a second script.
console.log(`  sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
