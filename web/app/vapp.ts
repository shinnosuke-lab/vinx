/**
 * A `.vapp` opened on the page, without the machine.
 *
 * `app pack` makes a plain tar.gz of the app directory (§12.4), and a pure
 * web app — `kind: "window"`, `ui.type: "web"`, no `exec` — needs nothing
 * from Linux to run: its window is a sandboxed frame on the app shell fed
 * a `{html, css, js}` bundle over a MessageChannel (§10.3), and app-run(8)'s
 * only job for it is to read three files and call window.create. So a
 * powered-off machine's web apps can open from the page: the package is
 * in the machine's mirror (share-store), and this reads it the way app-run
 * would — the same three files, the same bundle shape — so the window is
 * the same window whichever side opened it.
 *
 * The reader speaks ustar only: busybox tar writes it, app ids and the
 * scaffold's file names are short, and `app install` refuses links and
 * escaping paths before a package ever lands. Anything else (a long-name
 * extension header, a bad checksum) makes the whole package "not a web app
 * I can open here", which sends the caller back to the guest path.
 *
 * The writer at the bottom (`packVapp`) is the same format in the other
 * direction — what the workspace `install_app` uses to put a web app the
 * model wrote into the mirror while the machine is off (app-install.ts).
 */

/** The §10.3 single-file bundle a web window is fed (window-manager's
 * WebBundle, spelled here so this module stays free of the UI tree). */
export interface WebBundle {
	html: string;
	css: string;
	js: string;
}

/** The manifest fields this cares about (schema 1, §9). */
export interface VappManifest {
	kind: string;
	ui?: { type?: string };
	exec?: string;
	title?: string;
	description?: string;
}

/**
 * The files of a package, paths relative to the app directory, no `./`.
 *
 * Shared by the reader and the writer below: what `unpackVapp` gives back is
 * exactly what `packVapp` takes, so a round trip is the identity.
 */
export type VappFiles = Map<string, Uint8Array>;

const BLOCK = 512;
/** What app-run stages at most (hostcall's BUNDLE_MAX is the receiving cap;
 * this stays under it with the JSON quoting overhead counted). */
export const PART_MAX = 160 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A NUL-terminated field of a tar header. */
function field(block: Uint8Array, at: number, len: number): string {
	let end = at;
	while (end < at + len && block[end] !== 0) end++;
	return decoder.decode(block.subarray(at, end));
}

/** An octal size field; tar pads with spaces and NULs. */
function octal(block: Uint8Array, at: number, len: number): number {
	const text = field(block, at, len).trim();
	return text ? parseInt(text, 8) : 0;
}

/** The header checksum: every byte summed, the checksum field itself as
 * spaces. A block that fails it is not a header — the archive's zero-block
 * trailer, or not a tar at all. */
function checksumOk(block: Uint8Array): boolean {
	const claimed = octal(block, 148, 8);
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
	return sum === claimed;
}

/**
 * Unpack a `.vapp`: the regular files, by relative path. Directories are
 * implied; anything that is not a regular file (links, devices — which
 * `app install` refused anyway) or that lies outside ustar is a reason to
 * give up on the package as a whole (null), never to skip silently.
 */
export async function unpackVapp(bytes: Uint8Array): Promise<VappFiles | null> {
	let tar: Uint8Array;
	try {
		tar = await gunzip(bytes);
	} catch {
		return null;
	}
	const files: VappFiles = new Map();
	for (let at = 0; at + BLOCK <= tar.byteLength; ) {
		const block = tar.subarray(at, at + BLOCK);
		if (block.every((b) => b === 0)) break; // the end-of-archive marker
		if (!checksumOk(block)) return null;
		const type = block[156];
		const size = octal(block, 124, 12);
		let name = field(block, 0, 100);
		const magic = field(block, 257, 6);
		if (magic === 'ustar') {
			const prefix = field(block, 345, 155);
			if (prefix) name = `${prefix}/${name}`;
		}
		// A pax extended header (type x/g) rides ahead of its entry with
		// attributes this reader does not need — mtimes, or a name longer
		// than ustar's 100 bytes. Skip it: for the short names `app pack`
		// produces the ustar name that follows is the whole truth. (macOS
		// tar writes one per file; busybox writes none.) A GNU long-name
		// header (L/K) is different: there the ustar name is a stub and the
		// real one is in the data — nothing this reader can trust, so out.
		if (type === 0x4c /* L */ || type === 0x4b /* K */) return null;
		name = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
		const dataAt = at + BLOCK;
		if (dataAt + size > tar.byteLength) return null;
		if (type === 0x78 /* x */ || type === 0x67 /* g */) {
			// skipped, see above
		} else if (type === 0x30 /* '0' */ || type === 0 /* old regular */) {
			if (!name || name.startsWith('/') || name.split('/').includes('..')) return null;
			files.set(name, tar.slice(dataAt, dataAt + size));
		} else if (type !== 0x35 /* '5' directory */) {
			return null;
		}
		at = dataAt + Math.ceil(size / BLOCK) * BLOCK;
	}
	return files;
}

/** The manifest, or null when the package has none that parses. */
export function manifestOf(files: VappFiles): VappManifest | null {
	const raw = files.get('app.json');
	if (!raw) return null;
	try {
		const m = JSON.parse(decoder.decode(raw)) as unknown;
		if (!m || typeof m !== 'object') return null;
		const o = m as Record<string, unknown>;
		return {
			kind: typeof o.kind === 'string' ? o.kind : 'command',
			ui: o.ui && typeof o.ui === 'object' ? (o.ui as { type?: string }) : undefined,
			exec: typeof o.exec === 'string' ? o.exec : undefined,
			title: typeof o.title === 'string' ? o.title : undefined,
			description: typeof o.description === 'string' ? o.description : undefined,
		};
	} catch {
		return null;
	}
}

/** A pure web window: the one kind the page can run with no machine. */
export function isPureWebApp(m: VappManifest | null): boolean {
	return !!m && m.kind === 'window' && m.ui?.type === 'web' && !m.exec;
}

/**
 * Write a `.vapp` — the inverse of `unpackVapp`, and the shape `app pack`
 * produces: a gzipped ustar archive of the app directory, entries named
 * `./app.json` and so on, regular files only, directories implied. Busybox
 * tar unpacks it on the machine (app-run stages from it at first run), this
 * module reads it on the page, and the guest's `app install` accepts it as a
 * package it could have made itself.
 *
 * ustar only, like the reader: names must fit the 100-byte field — the
 * scaffold's do by a mile, and an installer that lets a longer one through
 * has bigger problems than this. Anything else is a caller bug, so it throws.
 */
export async function packVapp(files: VappFiles): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	const mtime = Math.floor(Date.now() / 1000);
	for (const [name, data] of files) {
		if (!name || name.startsWith('/') || name.split('/').includes('..')) {
			throw new Error(`packVapp: bad entry name ${JSON.stringify(name)}`);
		}
		const entry = encoder.encode(`./${name}`);
		if (entry.byteLength > 100) throw new Error(`packVapp: name too long for ustar: ${name}`);
		parts.push(header(entry, data.byteLength, mtime), data);
		const slack = (BLOCK - (data.byteLength % BLOCK)) % BLOCK;
		if (slack) parts.push(new Uint8Array(slack));
	}
	parts.push(new Uint8Array(BLOCK * 2)); // end-of-archive marker
	const tar = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let at = 0;
	for (const p of parts) {
		tar.set(p, at);
		at += p.byteLength;
	}
	return gzip(tar);
}

/** One ustar header block for a regular file. */
function header(name: Uint8Array, size: number, mtime: number): Uint8Array {
	const block = new Uint8Array(BLOCK);
	const put = (at: number, text: string) => block.set(encoder.encode(text), at);
	// Octal fields are NUL-terminated within their width, as busybox writes them.
	const oct = (at: number, len: number, n: number) => put(at, n.toString(8).padStart(len - 1, '0'));
	block.set(name, 0);
	oct(100, 8, 0o644); // mode
	oct(108, 8, 0); // uid
	oct(116, 8, 0); // gid
	oct(124, 12, size);
	oct(136, 12, mtime);
	block[156] = 0x30; // '0': regular file
	put(257, 'ustar');
	put(263, '00');
	put(265, 'root');
	put(297, 'root');
	// The checksum: every byte summed with the checksum field read as spaces.
	block.fill(0x20, 148, 156);
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += block[i];
	put(148, sum.toString(8).padStart(6, '0'));
	block[154] = 0;
	block[155] = 0x20;
	return block;
}

/**
 * The bundle app-run would stage for this package — index.html required,
 * style.css and app.js optional — or null when it is not a pure web app,
 * or a part is missing or too big to be the §10.3 single-file bundle.
 */
export function webBundleOf(files: VappFiles): WebBundle | null {
	if (!isPureWebApp(manifestOf(files))) return null;
	const html = files.get('index.html');
	if (!html) return null;
	const css = files.get('style.css') ?? new Uint8Array();
	const js = files.get('app.js') ?? new Uint8Array();
	for (const part of [html, css, js]) if (part.byteLength > PART_MAX) return null;
	return { html: decoder.decode(html), css: decoder.decode(css), js: decoder.decode(js) };
}
