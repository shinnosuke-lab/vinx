/**
 * The keyboard upgrade, end to end: the focused VGA panel turns page keys
 * into PS/2 scancodes (vm.sendKey), the guest kernel turns those into evdev
 * events, and the game reads them as real presses and releases.
 *
 * The serial console is never focused after launch, so any reaction proves
 * the evdev path -- nestest's menu flips to its test screen on Start.
 *
 *   (cd web && node ../nes/test/vm-kbd.mjs)     # needs a fresh `npm run build`
 */
import assert from 'node:assert/strict';

import {
	canvasHash,
	DEFAULT_ROM,
	dropRom,
	frameUntil,
	frameType,
	setup,
	steadyPicture,
} from './lib.mjs';

const ROM = process.env.ROM || DEFAULT_ROM;

const { page, frame, close } = await setup();
try {
	console.log('==> VM up; dropping the ROM');
	await dropRom(page, frame, ROM);

	console.log('==> launching the game');
	await frameType(page, frame, 'nes /data/bench.nes');
	const banner = await frameUntil(frame, (t) => t.includes('input:'), 'the input banner', 60_000);
	assert.match(banner, /input: evdev\+serial/, 'the game did not find the evdev keyboard');

	// The modeset auto-opens the screen window; no chip click needed.
	await frame.waitForSelector('.vga-panel canvas', { timeout: 30_000 });

	// The menu must be on screen and steady before poking at it.
	const before = await steadyPicture(frame, 'the menu');

	// Focus the panel -- from here on, keys are PS/2 scancodes, not serial.
	console.log('==> pressing Start through the PS/2 keyboard');
	await frame.click('.vga-panel');
	const focused = await frame.evaluate(() => document.activeElement?.className);
	assert.equal(focused, 'vga-panel', `the panel did not take focus: ${focused}`);
	await page.keyboard.press('Enter');

	let after = null;
	for (const deadline = Date.now() + 30_000; ;) {
		after = await canvasHash(frame);
		if (after && after.hash !== before.hash) break;
		if (Date.now() > deadline) throw new Error('the picture never changed after Start via PS/2');
		await new Promise((r) => setTimeout(r, 500));
	}
	console.log(`==> evdev input ok (canvas hash ${before.hash} -> ${after.hash})`);

	// Quit through the same path; the run summary proves a clean exit.
	await page.keyboard.press('q');
	await frameUntil(
		frame,
		(t) => /nes: \d+ frames \(\d+ blits\)/.test(t),
		'the run summary',
		30_000,
	);
	console.log('==> q through PS/2 quit the game cleanly');

	console.log('\n=== vm-kbd: the PS/2 -> evdev path works ===');
} finally {
	await close();
}
