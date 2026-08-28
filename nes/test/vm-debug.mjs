/**
 * A looking glass, not a test: run the image's /usr/bin/nes in the VM,
 * screenshot the canvas (with the lib's region hash printed) before and
 * after a serial Start, then quit with q. SHOTDIR chooses where the PNGs
 * land.
 *
 *   (cd web && SHOTDIR=../nes/test/shots node ../nes/test/vm-debug.mjs)
 */
import { writeFile } from 'node:fs/promises';

import { DEFAULT_ROM, dropRom, frameScreen, frameUntil, frameType, setup } from './lib.mjs';

const ROM = process.env.ROM || DEFAULT_ROM;

async function shot(frame, name) {
	const got = await frame.evaluate(() => {
		const canvas = document.querySelector('.vga-panel canvas');
		if (!canvas || !canvas.width) return null;
		const ctx = canvas.getContext('2d', { alpha: false });
		const w = 200;
		const d = ctx.getImageData(
			((canvas.width - w) / 2) | 0,
			((canvas.height - w) / 2) | 0,
			w,
			w,
		).data;
		let sum = 0;
		for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
		return { sum, png: canvas.toDataURL('image/png').split(',')[1] };
	});
	if (!got) return console.log(`shot ${name}: no canvas`);
	await writeFile(`${process.env.SHOTDIR || '/tmp'}/${name}.png`, Buffer.from(got.png, 'base64'));
	console.log(`shot ${name}: region sum = ${got.sum}`);
}

const { page, frame, close } = await setup();
try {
	await dropRom(page, frame, ROM);

	await frameType(page, frame, 'nes /data/bench.nes');
	await frameUntil(frame, (t) => t.includes('input:'), 'the banner', 30_000);
	// The modeset auto-opens the screen window; no chip click needed.
	await frame.waitForSelector('.vga-panel canvas', { timeout: 30_000 });
	console.log('--- console after launch ---');
	console.log((await frameScreen(frame)).split('\n').slice(-8).join('\n'));

	await new Promise((r) => setTimeout(r, 3000));
	await shot(frame, 'nes-1-launch');
	// The whole page too: the canvas shot sees only the picture, this one
	// shows the floating window chrome sitting over the console.
	await page.screenshot({ path: `${process.env.SHOTDIR || '/tmp'}/nes-1-page.png` });

	await frame.click('.xterm-screen');
	await page.keyboard.press('Enter');
	await new Promise((r) => setTimeout(r, 3000));
	await shot(frame, 'nes-2-after-enter');

	await page.keyboard.press('q');
	await new Promise((r) => setTimeout(r, 2000));
	console.log('--- console after quit ---');
	console.log((await frameScreen(frame)).split('\n').slice(-8).join('\n'));
} finally {
	await close();
}
