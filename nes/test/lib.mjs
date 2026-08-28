/**
 * The shared plumbing of the in-VM checks: serve the built page, boot the
 * terminal in headless chromium, drop files on the console, type commands
 * and wait for their completion markers.
 *
 * Everything mirrors web/app/test/browser.mjs -- same selectors, same
 * screen-reading -- but stays a separate copy so the nes/ directory never
 * reaches into the page's own test suite.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NES = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = resolve(NES, '../web');

/* nestest, the public-domain CPU test cart every script defaults to. Not
 * committed; fetch once with:
 *   curl -fsSL -o test/roms/nestest.nes \
 *     https://raw.githubusercontent.com/christopherpow/nes-test-roms/master/other/nestest.nes */
export const DEFAULT_ROM = resolve(NES, 'test/roms/nestest.nes');

/* playwright lives in web/node_modules; this script does not. */
const { chromium } = createRequire(resolve(WEB, 'package.json'))('playwright');

export function frameScreen(frame) {
	return frame.evaluate(() =>
		[...document.querySelectorAll('.xterm-rows > div')]
			.map((row) => row.textContent.replace(/\u00a0/g, ' ').replace(/\s+$/, ''))
			.join('\n')
			.replace(/\n+$/, ''),
	);
}

export async function frameUntil(frame, matches, what, timeout = 120_000) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const text = await frameScreen(frame);
		if (matches(text)) return text;
		if (Date.now() > deadline) throw new Error(`the console never showed ${what}:\n${text}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

export async function frameType(page, frame, line) {
	await frame.click('.xterm-screen');
	await page.keyboard.type(line);
	await page.keyboard.press('Enter');
}

/* The typed command echoes on screen too; a completion marker must not
 * appear verbatim in the line that produces it. `echo "MK""-END"` shows the
 * quotes in the echo but prints MK-END only when it actually ran. */
export function mark(tag) {
	return `echo "${tag.slice(0, 2)}""${tag.slice(2)}"`;
}

/** Type `cmd && <marker>`, wait for the marker (or a make/tcc error). */
export async function run(page, frame, cmd, tag, timeout = 120_000) {
	await frameType(page, frame, `${cmd} && ${mark(tag)}`);
	const text = await frameUntil(
		frame,
		(t) => t.includes(tag) || t.includes('error:') || t.includes('make: ***'),
		tag,
		timeout,
	);
	if (!text.includes(tag)) throw new Error(`${tag} never appeared:\n${text}`);
	return text;
}

/** Serve web/dist, boot the terminal page, wait for the shell prompt. */
export async function setup() {
	const server = spawn('python3', ['-u', 'deploy/assets-server.py', 'dist'], { cwd: WEB });
	const port = await new Promise((res, rej) => {
		let out = '';
		server.stdout.on('data', (d) => {
			out += d;
			const m = out.match(/^ASSETS_PORT=(\d+)/m);
			if (m) res(m[1]);
		});
		server.on('exit', () => rej(new Error(`assets server died:\n${out}`)));
	});

	const browser = await chromium.launch();
	const page = await browser.newPage();
	// The terminal's one-time "go online?" banner floats over the panes;
	// answer it up front so it never intercepts a click meant for the pane.
	await page.addInitScript(() => localStorage.setItem('vinx.net.prompted', '1'));
	page.on('pageerror', (e) => console.error('[pageerror]', e.message));
	await page.goto(`http://127.0.0.1:${port}/terminal/`);

	await page.waitForSelector('iframe[name="pane-1"]', { timeout: 30_000 });
	let frame;
	for (const deadline = Date.now() + 30_000; !frame; ) {
		frame = page.frame({ name: 'pane-1' });
		if (!frame && Date.now() > deadline) throw new Error('the pane-1 frame never appeared');
		if (!frame) await new Promise((r) => setTimeout(r, 100));
	}
	await frame.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 180_000,
	});
	await frameUntil(frame, (t) => /#/.test(t), 'a shell prompt', 60_000);

	const close = async () => {
		await browser.close();
		server.kill();
	};
	return { page, frame, close };
}

/** Drop local files onto the console; they land in /data. */
export async function drop(frame, files) {
	const payload = [];
	for (const { path, name } of files) {
		payload.push([name, (await readFile(path)).toString('base64')]);
	}
	await frame.evaluate((entries) => {
		const transfer = new DataTransfer();
		for (const [name, b64] of entries) {
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			transfer.items.add(new File([bytes], name));
		}
		document
			.querySelector('.pane')
			.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
	}, payload);
}

/**
 * Sum + position-sensitive hash of the WHOLE canvas. The whole canvas,
 * pointedly: nestest's Start flips a column of `~~` to `OK` near the left
 * edge and nothing else -- a "center region" sample once missed it and
 * called the input dead when the picture had changed fine.
 */
export function canvasHash(frame) {
	return frame.evaluate(() => {
		const canvas = document.querySelector('.vga-panel canvas');
		if (!canvas || !canvas.width) return null;
		const ctx = canvas.getContext('2d', { alpha: false });
		if (!ctx) return null;
		const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		let sum = 0;
		let h = 0x811c9dc5;
		for (let i = 0; i < d.length; i += 4) {
			const v = d[i] + d[i + 1] + d[i + 2];
			sum += v;
			h = ((h ^ v) * 0x01000193) >>> 0;
		}
		return { sum, hash: h };
	});
}

/** Wait until the picture is lit and holds still across two samples. */
export async function steadyPicture(frame, what, timeout = 30_000) {
	let last = null;
	for (const deadline = Date.now() + timeout; ; ) {
		const now = await canvasHash(frame);
		if (now && now.sum > 5_000 && last && now.hash === last.hash) return now;
		last = now;
		if (Date.now() > deadline) throw new Error(`${what}: the picture never settled`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

/** Drop a ROM and wait for it to land -- the shared preamble. The machine
 * itself ships in the image as /usr/bin/nes; there is nothing to build. */
export async function dropRom(page, frame, romPath) {
	await drop(frame, [{ path: romPath, name: 'bench.nes' }]);
	await run(page, frame, 'until [ -f /data/bench.nes ]; do sleep 1; done', 'FILES-END', 60_000);
}
