/**
 * Netplay, end to end, on real machines: the page splits in more panes
 * (all VMs share one L2 -- the same fabric a WebRTC bridge extends),
 * machine 1 hosts, machine 2 joins with no ROM of its own.
 *
 *   1. drop a ROM on machine 1 only, read machine 1's LAN address
 *   2. `nes host` in pane 1 (the banner prints the literal join line),
 *      `nes join <ip>` in pane 2: the joiner pulls ROM + machine state
 *      over the wire, lockstep starts, both sides report "sync ok at
 *      frame 0"
 *   3. both screen windows auto-open on the 256x224 modeset
 *   4. press Start on the HOST console -- the JOINER's picture must flip
 *      (the input crossed the network)
 *   5. a background FIFO script on the joiner pokes RAM on one side only:
 *      the CRC tripwire must fire, the host pushes a fresh state, and the
 *      new epoch reports sync again (the self-heal path, forced for real)
 *   6. emu.load on the joiner must be refused mid-match
 *   7. q on the host: both sides exit cleanly to their prompts
 *   8. discovery, with company: machine 1 hosts again AND machine 2 hosts
 *      its own game in the background -- two hosts on one LAN. `nes list`
 *      on machine 2 must name both games and star its own row; a bare
 *      `nes join` must refuse the coin toss and print the same menu
 *   9. the background host dies; a bare `nes join` now finds the one
 *      remaining host by itself and the short second match runs
 *  10. with only its own background host left, a bare `nes join` must
 *      refuse to join this machine itself
 *
 *   (cd web && node ../nes/test/vm-netplay.mjs)
 */
import assert from 'node:assert/strict';

import {
	canvasHash,
	DEFAULT_ROM,
	drop,
	dropRom,
	frameType,
	frameUntil,
	run,
	setup,
	steadyPicture,
} from './lib.mjs';

const ROM = process.env.ROM || DEFAULT_ROM;

/** Split machine N in and wait for its shell, browser.mjs-style. */
async function splitIn(page, n) {
	await page.click('.actions button[title*="Split right"]');
	await page.waitForSelector(`iframe[name="pane-${n}"]`, { timeout: 30_000 });
	let frame;
	for (const deadline = Date.now() + 30_000; !frame;) {
		frame = page.frame({ name: `pane-${n}` });
		if (!frame && Date.now() > deadline) throw new Error(`the pane-${n} frame never appeared`);
		if (!frame) await new Promise((r) => setTimeout(r, 100));
	}
	await frame.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 180_000,
	});
	await frameUntil(frame, (t) => /#/.test(t), `a shell prompt in pane ${n}`, 60_000);
	return frame;
}

const { page, frame: one, close } = await setup();
try {
	console.log('==> machine 1 up; dropping the ROM (machine 2 will get none)');
	await dropRom(page, one, ROM);

	// Machine 1's address on the shared LAN: 10.0.2.<inbrowser-host>.
	const ipScreen = await run(page, one, 'cat /run/inbrowser-host', 'IP-END', 30_000);
	const hostNum = ipScreen.match(/\n(\d{1,3})\s*\nIP-END/)?.[1];
	assert.ok(hostNum, `no inbrowser host number on screen:\n${ipScreen}`);
	const hostIp = `10.0.2.${hostNum}`;
	console.log(`==> machine 1 is ${hostIp}; splitting machine 2 in`);

	const two = await splitIn(page, 2);

	// Host on machine 1. The rendezvous prints before any mode-set, and
	// the banner must carry the literal, copyable join line.
	await frameType(page, one, 'nes host /data/bench.nes');
	await frameUntil(one, (t) => t.includes('waiting for P2'), 'the hosting banner', 60_000);
	await frameUntil(
		one,
		(t) => t.includes(`nes join ${hostIp}`),
		'the copyable join line in the banner',
		10_000,
	);
	console.log('==> machine 1 hosts, banner says `nes join ' + hostIp + '`');

	// `nes list` from machine 2: the host must show up, named.
	const listing = await run(page, two, 'nes list', 'LS-END', 30_000);
	assert.ok(listing.includes('1 host on this LAN'), `nes list missed the host:\n${listing}`);
	assert.ok(
		listing.includes(hostIp) && listing.includes('bench.nes'),
		`nes list has no address+game row:\n${listing}`,
	);
	console.log('==> nes list names the host and its game');

	// Join from machine 2 -- no ROM anywhere near this command. The
	// background line drives the joiner's Lua FIFO later in the match:
	// at T+25s it pokes RAM on this side only (a hand-made desync, to
	// prove the CRC tripwire and the resync for real), at T+40s it tries
	// emu.load, which must be refused during netplay.
	await frameType(
		page,
		two,
		'(sleep 25; echo "for a=0x700,0x70F do memory.write(a,0xAA) end" > /tmp/nes.ctl; ' +
			'sleep 15; echo \'emu.load("/data/nope")\' > /tmp/nes.ctl) & ' +
			`nes join ${hostIp}`,
	);
	await frameUntil(two, (t) => t.includes('pulled the ROM'), 'the ROM transfer', 60_000);
	await frameUntil(one, (t) => t.includes('P2 arrived'), 'the host-side arrival', 30_000);
	console.log('==> joined: the ROM and state crossed the wire');

	// Lockstep is live once both sides pass the frame-0 CRC exchange.
	await frameUntil(one, (t) => t.includes('sync ok at frame 0'), 'host sync 0', 30_000);
	await frameUntil(two, (t) => t.includes('sync ok at frame 0'), 'joiner sync 0', 30_000);
	console.log('==> lockstep running, frame-0 CRCs agree');

	// Both pages must have auto-opened their screen windows on the modeset.
	await one.waitForSelector('.vga-window .vga-panel canvas', { timeout: 30_000 });
	await two.waitForSelector('.vga-window .vga-panel canvas', { timeout: 30_000 });
	const mode = await two.evaluate(() => {
		const canvas = document.querySelector('.vga-panel canvas');
		return { w: canvas.width, h: canvas.height };
	});
	assert.deepEqual(mode, { w: 256, h: 224 }, 'the joiner canvas is not the native NES mode');
	const menuTwo = await steadyPicture(two, 'the joiner menu');
	await steadyPicture(one, 'the host menu');
	console.log('==> both screens lit (joiner canvas 256x224)');

	// The crossing: Start pressed on the HOST'S GAMEPAD (the canvas is the
	// PS/2 surface; the split pane's terminal sits under the window, so the
	// canvas is also the only honestly clickable thing) must flip the
	// JOINER's picture -- nestest's menu becomes the test screen.
	await one.click('.vga-panel canvas');
	await page.keyboard.press('Enter');
	let afterTwo = null;
	for (const deadline = Date.now() + 30_000; ;) {
		afterTwo = await canvasHash(two);
		if (afterTwo && afterTwo.hash !== menuTwo.hash) break;
		if (Date.now() > deadline)
			throw new Error("the joiner's picture never changed after the host pressed Start");
		await new Promise((r) => setTimeout(r, 500));
	}
	console.log(`==> input crossed the network (joiner hash ${menuTwo.hash} -> ${afterTwo.hash})`);

	// The self-heal: the FIFO poke diverged the joiner's RAM; the next CRC
	// exchange must catch it, the host must push a state, and the fresh
	// epoch must report sync again -- "sync ok at frame 600" printed BELOW
	// the resync line is the new epoch's 10-second mark, not a leftover.
	await frameUntil(one, (t) => t.includes('pushing a fresh state'), 'the host resync', 60_000);
	await frameUntil(
		two,
		(t) => {
			const at = t.indexOf('resynced to the host');
			return at >= 0 && t.lastIndexOf('sync ok at frame 600') > at;
		},
		'sync after the resync',
		60_000,
	);
	console.log('==> forced desync healed (state pushed, new epoch back in sync)');

	// emu.load mid-match: refused, with words.
	await frameUntil(
		two,
		(t) => t.includes('emu.load is disabled during netplay'),
		'the emu.load refusal',
		30_000,
	);
	console.log('==> emu.load refused during the match');

	// q on the host's gamepad: both sides must exit to their prompts.
	await one.click('.vga-panel canvas');
	await page.keyboard.press('q');
	await frameUntil(one, (t) => /nes: \d+ frames/.test(t), 'the host run summary', 30_000);
	await frameUntil(two, (t) => t.includes('the other side left'), 'the goodbye', 30_000);
	await frameUntil(two, (t) => /nes: \d+ frames/.test(t), 'the joiner run summary', 30_000);
	console.log('==> clean shutdown on both sides');

	// The windows outlive the match by design; put them away so the
	// terminals underneath are clickable again. Then wipe both screens:
	// every assertion below would otherwise happily match the first
	// match's leftovers still sitting in the scrollback.
	await one.click('.vga-window .vga-btn[title^="Close"]');
	await two.click('.vga-window .vga-btn[title^="Close"]');
	await run(page, one, 'clear', 'CLR1-END', 15_000);
	await run(page, two, 'clear', 'CLR2-END', 15_000);

	// Discovery, with company: machine 1 hosts again, and machine 2 quietly
	// hosts a game of its own in the background -- two hosts on one LAN.
	// (Machine 2 finds its own host through the kernel's local broadcast
	// loopback, and machine 1 through the /24 unicast sweep.)
	await frameType(page, one, 'nes host /data/bench.nes');
	await frameUntil(one, (t) => t.includes('waiting for P2'), 'the second hosting banner', 60_000);

	await drop(two, [{ path: ROM, name: 'other.nes' }]);
	await run(page, two, 'until [ -f /data/other.nes ]; do sleep 1; done', 'F2-END', 60_000);
	await run(page, two, 'nes host /data/other.nes & sleep 1', 'H2-END', 30_000);

	// `nes list` must see both hosts, named. The screen also carries the
	// background host's own banner, so anchor the game names to the count
	// line the listing starts with.
	const menu = await run(page, two, 'nes list', 'LS2-END', 30_000);
	const at = menu.indexOf('2 hosts on this LAN');
	assert.ok(at >= 0, `nes list did not see two hosts:\n${menu}`);
	assert.ok(
		menu.slice(at).includes('bench.nes') && menu.slice(at).includes('other.nes'),
		`nes list is missing a game name:\n${menu}`,
	);
	// ...and machine 2's own background host must wear the bridge-show star.
	assert.ok(
		/\* 10\.0\.2\.\d+\s+other\.nes/.test(menu.slice(at)) &&
			menu.slice(at).includes('(* this machine)'),
		`nes list did not star this machine's own host:\n${menu}`,
	);
	// ...and a bare join refuses the coin toss: same menu, no match.
	await frameType(page, two, 'nes join');
	await frameUntil(
		two,
		(t) => t.includes('pick one: nes join IP'),
		'the bare-join menu refusal',
		30_000,
	);
	console.log('==> two hosts: nes list names both, a bare join makes it a menu');

	// The background host bows out; one host remains, so a bare join may
	// now pick it on its own -- the short discovered match.
	await run(page, two, 'kill $(pidof nes); sleep 1', 'KL-END', 30_000);
	await frameType(page, two, 'nes join');
	await frameUntil(two, (t) => t.includes('playing bench.nes'), 'the single-host pick', 60_000);
	await frameUntil(two, (t) => t.includes('pulled the ROM'), 'the discovered transfer', 60_000);
	await frameUntil(two, (t) => t.includes('sync ok at frame 0'), 'discovered-match sync', 30_000);
	await two.click('.vga-panel canvas');
	await page.keyboard.press('q');
	await frameUntil(one, (t) => t.includes('the other side left'), 'the host goodbye', 30_000);
	console.log('==> one host left: a bare join found it by itself');

	// Last: with nobody hosting but machine 2's own background game, a
	// bare join must refuse to make a match out of one machine.
	await two.click('.vga-window .vga-btn[title^="Close"]');
	await run(page, two, 'nes host /data/other.nes & sleep 1', 'H3-END', 30_000);
	await frameType(page, two, 'nes join');
	await frameUntil(
		two,
		// The pane's console is narrower than this line, and xterm's hard
		// wrap can split it anywhere -- unwrap before matching.
		(t) => t.replace(/\n/g, '').includes('a match needs somebody else'),
		'the self-join refusal',
		30_000,
	);
	await run(page, two, 'kill $(pidof nes); sleep 1', 'KL2-END', 30_000);
	console.log('==> a bare join refuses to join this machine itself');

	console.log(
		'\n=== vm-netplay: transfer, lockstep, input crossing, self-heal, list/menu all verified ===',
	);
} finally {
	await close();
}
