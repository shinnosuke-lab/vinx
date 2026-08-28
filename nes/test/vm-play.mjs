/**
 * The whole console, end to end, inside the real VM: video on the screen
 * panel, serial input, the Lua control FIFO, and a state save.
 *
 *   1. drop a ROM (the machine ships in the image)
 *   2. play a square wave through /dev/dsp and assert the page's master
 *      audio tap HEARS it (real samples, not just a running context --
 *      this is what catches a muted mixer, the bug S25vol fixes)
 *   3. launch the game with a background script feeding /tmp/nes.ctl
 *   4. the game mode-sets the display to 256x224 -- the page must open the
 *      screen window BY ITSELF (nobody clicks the chip here)
 *   5. assert the canvas shows a picture (video path) and the speaker's
 *      AudioContext is running (a click happened; the gesture unmutes)
 *   6. press Enter on the console, assert the picture changed (input path)
 *   7. the FIFO script saves a state and quits the game (Lua path)
 *   8. assert the state file exists and the run summary printed
 *
 * nestest.nes works well here: its menu draws immediately and Start flips
 * it to a busy test screen -- a visible change from one keypress.
 *
 *   (cd web && node ../nes/test/vm-play.mjs)
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

	// Sound, sample-level: a full-scale ~444 Hz square wave through /dev/dsp
	// (OSS defaults, no ioctls) must register at the page's master audio tap.
	// "AudioContext running" and a paced fps CANNOT catch a muted mixer --
	// the DMA still runs, the samples still die. This did happen: ALSA boots
	// the SB16 with every control at zero, and until S25vol turned the knob
	// the machine played perfect silence. The typing above already clicked
	// the console, so the context has its user gesture; wait out the resume.
	console.log('==> probing real audio output (square wave to /dev/dsp)');
	for (const deadline = Date.now() + 5_000; ;) {
		const state = await frame.evaluate(() => document.documentElement.dataset.audioState);
		if (state === 'running' || Date.now() > deadline) break;
		await new Promise((r) => setTimeout(r, 200));
	}
	await frameType(
		page,
		frame,
		"micropython -c \"f=open('/dev/dsp','wb'); " +
			"f.write((b'\\xff'*9+b'\\x00'*9)*1350); f.close()\" " +
			'&& echo "WA""VE-END"',
	);
	const rms = await frame.evaluate(() => window.vinxAudioRms(4000));
	await frameUntil(frame, (t) => t.includes('WAVE-END'), 'the square wave', 30_000);
	assert.ok(rms, 'the audio probe found no speaker adapter');
	assert.ok(rms.dac > 0.1, `the DAC tap stayed silent (RMS ${rms.dac})`);
	assert.ok(rms.master > 0.1, `the mixer ate the sound (master RMS ${rms.master})`);
	console.log(
		`==> real sound flows (RMS: dac ${rms.dac.toFixed(3)}, master ${rms.master.toFixed(3)})`,
	);

	// The background line drives the Lua FIFO while the game holds the tty:
	// prove the FIFO executes chunks, save a state, then quit the game.
	// Note no screen-chip click anywhere: the window must open on its own.
	console.log('==> launching the game');
	await frameType(
		page,
		frame,
		'(sleep 20; echo "emu.message(\\"fifo works\\")" > /tmp/nes.ctl; ' +
			'sleep 2; echo "emu.save(\\"/data/t.state\\")" > /tmp/nes.ctl; ' +
			'sleep 2; echo "emu.quit()" > /tmp/nes.ctl) & ' +
			'nes /data/bench.nes; ' +
			'ls -la /data/t.state && echo "PL""AY-END"',
	);
	const banner = await frameUntil(
		frame,
		(t) => t.includes('screen panel'),
		'the game banner',
		60_000,
	);
	// The guest has /dev/dsp (v86's SB16): sound must have come up, and its
	// blocking writes become the pacer -- the fps assert below proves it.
	assert.match(banner, /sound: on \(\/dev\/dsp/, 'the sound banner never printed');
	console.log('==> sound on (/dev/dsp)');

	// The game's modeset must have popped the screen window, sized around a
	// canvas that IS the native picture -- no chip click, no software scale.
	await frame.waitForSelector('.vga-window .vga-panel canvas', {
		timeout: 30_000,
	});
	const mode = await frame.evaluate(() => {
		const canvas = document.querySelector('.vga-panel canvas');
		return { w: canvas.width, h: canvas.height };
	});
	assert.deepEqual(mode, { w: 256, h: 224 }, 'the canvas is not the native NES mode');
	console.log('==> auto-open ok (the window popped, canvas 256x224)');

	// Video: the menu must reach the canvas and hold still.
	const before = await steadyPicture(frame, 'the menu');
	console.log(`==> video ok (canvas hash ${before.hash})`);

	// Input: Enter is Start; nestest flips its menu to the results screen.
	await frame.click('.xterm-screen');

	// That click was a user gesture, so the speaker's AudioContext must be
	// running (vm.ts reflects its state onto the document element, a promise
	// tick after the gesture). Suspended would mean silence AND stutter: the
	// DAC stops consuming and the guest's blocking /dev/dsp writes lose
	// their pace.
	let audio = null;
	for (const deadline = Date.now() + 5_000; ;) {
		audio = await frame.evaluate(() => document.documentElement.dataset.audioState);
		if (audio === 'running' || Date.now() > deadline) break;
		await new Promise((r) => setTimeout(r, 200));
	}
	assert.equal(audio, 'running', `the AudioContext is "${audio}", not running`);
	console.log('==> audio unlocked (AudioContext running)');

	await page.keyboard.press('Enter');
	let after = null;
	for (const deadline = Date.now() + 30_000; ;) {
		after = await canvasHash(frame);
		if (after && after.hash !== before.hash) break;
		if (Date.now() > deadline) throw new Error('the picture never changed after Start');
		await new Promise((r) => setTimeout(r, 500));
	}
	console.log(`==> input ok (canvas hash ${before.hash} -> ${after.hash})`);

	// Lua: the FIFO script quits the game; the state file must be real.
	const done = await frameUntil(frame, (t) => t.includes('PLAY-END'), 'the run summary', 120_000);
	assert.match(done, /fifo works/, 'the FIFO message never printed');
	assert.match(done, /nes: \d+ frames \(\d+ blits\)/, 'the run summary never printed');

	// Paced by the audio clock, the run must hold NTSC speed (with slack
	// for the pre-fill sprint and the emulated machine's mood).
	const fps = Number(done.match(/nes: \d+ frames \(\d+ blits\) in [\d.]+s -- ([\d.]+) fps/)?.[1]);
	assert.ok(fps > 54 && fps < 68, `the audio-paced run drifted off 60 fps: ${fps}`);
	console.log(`==> sound pacing ok (${fps} fps)`);
	const size = Number(done.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+).*t\.state/m)?.[1]);
	assert.ok(size > 60_000, `the state file looks too small: ${size}`);
	console.log(`==> lua ok (state file ${size} bytes)`);

	console.log('\n=== vm-play: video, input, lua and state save all verified ===');
} finally {
	await close();
}
