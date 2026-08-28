/**
 * The floating screen window, end to end in the real VM.
 *
 * Replays the browser suite's fbdemo leg (chip opens the panel, fbdemo
 * lights the canvas, chip closes it) against the window chrome, then
 * exercises what the chrome added: dragging by the title bar, the corner
 * and edge resize handles, maximize/restore, the close button, and the
 * geometry surviving a close/reopen through localStorage.
 *
 * fbdemo paints the console's own 1024x768 mode and never mode-sets, so
 * nothing here auto-opens -- the chip clicks are the point. The auto-open
 * and pixel-perfect legs live in vm-play, where nes switches the mode.
 *
 *   (cd web && npm run build && node ../nes/test/vm-float.mjs)
 */
import assert from 'node:assert/strict';

import { frameType, frameUntil, setup } from './lib.mjs';

const near = (a, b, slack, what) =>
	assert.ok(Math.abs(a - b) <= slack, `${what}: expected ~${b}, got ${a}`);

const { page, frame, close } = await setup();
try {
	// ── the fbdemo leg, as in the browser suite ──
	console.log('==> opening the screen window');
	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-window .vga-panel canvas', { timeout: 10_000 });

	await frameType(page, frame, 'fbdemo');
	await frameUntil(frame, (t) => /fbdemo: painted \d+x\d+/.test(t), 'the fbdemo report', 60_000);

	const deadline = Date.now() + 15_000;
	for (;;) {
		const px = await frame.evaluate(() => {
			const canvas = document.querySelector('.vga-panel canvas');
			if (!canvas || !canvas.width) return null;
			const ctx = canvas.getContext('2d', { alpha: false });
			if (!ctx) return null;
			const d = ctx.getImageData((canvas.width / 2) | 0, (canvas.height / 2) | 0, 1, 1).data;
			return [d[0], d[1], d[2]];
		});
		if (px && px[0] + px[1] + px[2] > 120) break;
		if (Date.now() > deadline) {
			throw new Error(`the canvas stayed dark after fbdemo: ${JSON.stringify(px)}`);
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	console.log('==> fbdemo leg ok (canvas lit)');

	// fbcon's 1024x768 shown in this small window is a downscale: the fit
	// logic must pick smooth interpolation there (nearest-neighbor *down*
	// drops rows unevenly). The pixelated blowup case is vm-play's, where
	// the game mode-sets to 256x224 and the canvas scales up.
	const rendering = await frame.evaluate(
		() => getComputedStyle(document.querySelector('.vga-panel canvas')).imageRendering,
	);
	assert.equal(rendering, 'auto', `a downscale should smooth, got ${rendering}`);

	// ── drag by the title bar ──
	const box = () => frame.locator('.vga-window').boundingBox();
	const before = await box();
	const bar = await frame.locator('.vga-title').boundingBox();
	await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
	await page.mouse.down();
	await page.mouse.move(bar.x + bar.width / 2 - 120, bar.y + bar.height / 2 - 80, { steps: 6 });
	await page.mouse.up();
	const moved = await box();
	near(moved.x, before.x - 120, 3, 'x after drag');
	near(moved.y, before.y - 80, 3, 'y after drag');
	console.log(`==> drag ok (${before.x},${before.y} -> ${moved.x},${moved.y})`);

	// ── the south-east corner handle ──
	await page.mouse.move(moved.x + moved.width - 4, moved.y + moved.height - 4);
	await page.mouse.down();
	await page.mouse.move(moved.x + moved.width + 76, moved.y + moved.height + 46, { steps: 6 });
	await page.mouse.up();
	const grown = await box();
	near(grown.width, moved.width + 80, 6, 'width after resize');
	near(grown.height, moved.height + 50, 6, 'height after resize');
	console.log(
		`==> corner resize ok (${moved.width}x${moved.height} -> ${grown.width}x${grown.height})`,
	);

	// ── the west edge handle: dragging left grows the window leftward ──
	await page.mouse.move(grown.x + 2, grown.y + grown.height / 2);
	await page.mouse.down();
	await page.mouse.move(grown.x + 2 - 60, grown.y + grown.height / 2, { steps: 6 });
	await page.mouse.up();
	const wider = await box();
	near(wider.x, grown.x - 60, 3, 'x after west drag');
	near(wider.width, grown.width + 60, 6, 'width after west drag');
	console.log(`==> west-edge resize ok (x ${grown.x} -> ${wider.x})`);

	// ── maximize fills the pane minus the 24px footer; restore comes back ──
	await frame.click('.vga-btn[title*="Maximize"]');
	const pane = await frame.locator('.pane').boundingBox();
	const maxed = await box();
	near(maxed.width, pane.width, 3, 'maximized width');
	near(maxed.height, pane.height - 24, 3, 'maximized height (footer stays)');
	await frame.click('.vga-btn[title*="Restore"]');
	const restored = await box();
	near(restored.width, wider.width, 3, 'width after restore');
	near(restored.x, wider.x, 3, 'x after restore');
	console.log('==> maximize/restore ok');

	// ── close from the title bar; geometry survives the reopen ──
	await frame.click('.vga-btn[title*="Close"]');
	await frame.waitForSelector('.vga-window', { state: 'detached', timeout: 5_000 });
	const chipOn = await frame.evaluate(
		() => document.querySelector('.screen-chip')?.classList.contains('on') ?? false,
	);
	assert.equal(chipOn, false, 'the footer chip stayed lit after close');

	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-window .vga-panel canvas', { timeout: 10_000 });
	const reopened = await box();
	near(reopened.x, restored.x, 3, 'x after reopen');
	near(reopened.y, restored.y, 3, 'y after reopen');
	near(reopened.width, restored.width, 3, 'width after reopen');
	near(reopened.height, restored.height, 3, 'height after reopen');
	const stored = await frame.evaluate(() => localStorage.getItem('vinx.screen.rect'));
	assert.ok(stored && JSON.parse(stored).w === Math.round(restored.width), `bad rect: ${stored}`);
	console.log(`==> close/reopen ok (geometry ${stored})`);

	// ── the chip still toggles the window away, as the browser suite expects ──
	await frame.click('.screen-chip');
	await frame.waitForSelector('.vga-panel', { state: 'detached', timeout: 10_000 });

	console.log(
		'\n=== vm-float: fbdemo leg, drag, resize, maximize, close and persistence verified ===',
	);
} finally {
	await close();
}
