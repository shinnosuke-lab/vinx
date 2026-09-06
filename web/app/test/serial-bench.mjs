/**
 * HISTORICAL — not runnable since Phase 3. Phase 0 of the RPC work:
 * measure the serial physical layer instead of assuming it
 * (docs/system-v2.zh-CN.md §15; the results live in
 * docs/protocol-baseline.zh-CN.md §2, which is the reference now).
 *
 *   M1a  burst against a closed port     -> where bytes wait (v86's queue)
 *   M1b  burst against an unread port    -> where bytes die (guest kernel cap)
 *   M2   frame cost and throughput       -> 1/4/16/64 KiB echo round trips
 *   M3   stop-and-wait RTT               -> p50/p95 of 100 small pings
 *   M4   modem-line semantics            -> DTR/RTS visibility, CTS, DCD
 *   M5   main-thread busy delay          -> RTT inflation under a sync spin
 *
 * A standalone script in the nes/test/vm-bench.mjs stance: its own static
 * server, its own page, no browser.mjs sharing. The page side was driven
 * through window.vinxSerialProbe (vm.ts serialProbe(), registered by
 * terminal.tsx — still alive); the guest side through the probe's run() —
 * the ttyS1 agentd channel, which Phase 3 deleted along with agentd, so
 * the orchestration leg has no answerer anymore. The measured wire itself
 * also moved: ttyS3 belongs to rpcd now, whose resident reader invalidates
 * M1a/M1b's "no reader" premise. The file stays as the record of how the
 * §2 numbers were taken.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_JSON = process.env.BENCH_JSON || resolve(WEB, 'build/serial-bench.json');
const only = process.argv.slice(2).map((s) => s.toUpperCase());
const wants = (m) => only.length === 0 || only.some((o) => m.startsWith(o));

// The measured port is ttyS3 throughout — the hostcall UART, quiet unless a
// CLI calls. It is hardcoded inside the evaluate closures (they serialize,
// so an outer const cannot reach them).

// ── setup: serve dist/, boot the terminal page, wait for the channel ──

async function setup() {
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
	// The probe's run() rides agentd; one round trip proves the channel.
	const warm = await frame.evaluate(() => window.vinxSerialProbe.run('echo warm', 30));
	if (warm.exit_code !== 0) throw new Error(`agentd did not answer: ${JSON.stringify(warm)}`);

	const close = async () => {
		await browser.close();
		server.kill();
	};
	return { frame, close };
}

// ── small helpers over the frame ──

function probeOn(frame) {
	return {
		/** guest shell via ttyS1; never throws on nonzero exit. */
		sh: (cmd, timeoutS = 60) =>
			frame.evaluate(([c, t]) => window.vinxSerialProbe.run(c, t), [cmd, timeoutS]),
		sendPattern: (size, byte = 0x78) =>
			frame.evaluate(([s, b]) => window.vinxSerialProbe.sendPattern(3, s, b), [size, byte]),
		record: () => frame.evaluate(() => window.vinxSerialProbe.record(3)),
		recorded: () => frame.evaluate(() => window.vinxSerialProbe.recorded(3)),
		stopRecord: () => frame.evaluate(() => window.vinxSerialProbe.stopRecord(3)),
		uart: () => frame.evaluate(() => window.vinxSerialProbe.uartState(3)),
		watchModem: () => frame.evaluate(() => window.vinxSerialProbe.watchModem(3)),
		modemEvents: () => frame.evaluate(() => window.vinxSerialProbe.modemEvents(3)),
		setCts: (v) => frame.evaluate((x) => window.vinxSerialProbe.setCts(3, x), v),
		setDcd: (v) => frame.evaluate((x) => window.vinxSerialProbe.setDcd(3, x), v),
		/** A newline resets the page-side hostcall line assembler between
		 * phases (the probe's printable payloads accumulate there; a non-CALL
		 * line is dropped as boot noise). */
		flushLine: () => frame.evaluate(() => window.vinxSerialProbe.send(3, '\n')),
	};
}

/** stty must run per phase: termios persists, but earlier phases may kill
 * processes that held the port and a fresh raw -echo is cheap insurance. */
const STTY = 'stty -F /dev/ttyS3 raw -echo';

/** Read whatever the kernel has buffered on ttyS3 until the count holds
 * still for 2 s (drain rate is one of the unknowns being measured, so no
 * fixed read timeout can be right). Prints one number: the byte count. */
const DRAIN_READ =
	': >/tmp/rx; cat /dev/ttyS3 >/tmp/rx 2>/dev/null & CP=$!; ' +
	'prev=-1; now=$(wc -c </tmp/rx); ' +
	'while [ "$now" -ne "$prev" ]; do prev=$now; sleep 2; now=$(wc -c </tmp/rx); done; ' +
	'kill -9 $CP 2>/dev/null; wc -c </tmp/rx';

const lastNumber = (output) => {
	const m = String(output).trim().match(/(\d+)\s*$/);
	return m ? Number(m[1]) : NaN;
};

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

// ── the measurements ──

/** M1a: burst N bytes while no guest process holds the port. Everything
 * queues in v86's unbounded input array (interrupts are off) — and the
 * first run of this measurement showed the next open(2) *discarding* the
 * whole queue (the 8250 driver's startup FIFO reset clears v86's input),
 * so `arrived` is expected to be ~0 and `backlogAfterRead` tells whether
 * the queue was drained (read) or zapped (reset). */
async function m1aClosedPortBacklog(p) {
	await p.sh(STTY);
	const steps = [];
	for (const size of [4096, 16384, 65536]) {
		await p.flushLine();
		const before = await p.uart();
		const sendMs = await p.sendPattern(size);
		const after = await p.uart();
		const t0 = Date.now();
		const read = await p.sh(`${STTY}; ${DRAIN_READ}`, 240);
		steps.push({
			size,
			sendMs: round(sendMs),
			backlogBefore: before.backlog,
			backlogAfterSend: after.backlog,
			arrived: lastNumber(read.output),
			backlogAfterRead: (await p.uart()).backlog,
			drainWallMs: Date.now() - t0,
		});
		console.log('    M1a', JSON.stringify(steps.at(-1)));
	}
	return { steps };
}

/** M1b: burst against a port a guest process holds open but never reads.
 * The expectation was a kernel-side cap (tty flip buffer + ldisc); the
 * first run recovered 128 KiB intact instead, so the ladder now climbs
 * until bytes actually die (or 1 MiB survives, whichever comes first). */
async function m1bOpenPortOverflow(p) {
	const steps = [];
	for (const size of [131072, 262144, 524288, 1048576]) {
		await p.sh(`${STTY} && { sleep 120 </dev/ttyS3 >/dev/null 2>&1 & } && echo held`);
		await p.flushLine();
		const sendMs = await p.sendPattern(size);
		// Watch v86's queue drain into the kernel (or stall).
		let last = -1;
		let stable = 0;
		const t0 = Date.now();
		while (Date.now() - t0 < 120_000 && stable < 6) {
			const s = await p.uart();
			if (s.backlog === last) stable++;
			else stable = 0;
			last = s.backlog;
			await new Promise((r) => setTimeout(r, 500));
		}
		const v86DrainMs = Date.now() - t0;
		const readT0 = Date.now();
		let read;
		try {
			read = await p.sh(DRAIN_READ, 240);
		} catch (e) {
			// The first full run found this cliff at 256 KiB: the burst does
			// not lose bytes, it wedges the whole guest (interrupt pressure)
			// until even ttyS1 is declared dead. That *is* the threshold —
			// record it as such and stop climbing.
			const step = {
				sent: size,
				sendMs: round(sendMs),
				v86DrainMs,
				residualBacklog: last,
				stalled: String(e?.message ?? e),
			};
			steps.push(step);
			console.log('    M1b', JSON.stringify(step));
			// Let the guest digest the backlog and agentd answer again
			// before the next measurement leans on the channel.
			await p.sh('echo recovered', 240).catch(() => {});
			break;
		}
		await p.sh("pkill -f 'sleep 120' 2>/dev/null; true");
		const arrived = lastNumber(read.output);
		const step = {
			sent: size,
			sendMs: round(sendMs),
			v86DrainMs,
			residualBacklog: last,
			arrived,
			lost: size - arrived - (last > 0 ? last : 0),
			readWallMs: Date.now() - readT0,
		};
		steps.push(step);
		console.log('    M1b', JSON.stringify(step));
		if (step.lost > 0) break; // found the byte-loss cliff; stop climbing
	}
	return { steps };
}

/** Start the guest echo server: one cat, bytes straight back, raw tty. */
async function startEcho(p, seconds = 300) {
	await p.sh(`${STTY} && { timeout -s KILL ${seconds} cat /dev/ttyS3 >/dev/ttyS3 2>/dev/null & } && echo up`);
}
async function stopEcho(p) {
	await p.sh("pkill -f 'cat /dev/ttyS3' 2>/dev/null; true");
}

/** M2: one frame of each size, there and back through the guest echo.
 * sendMs is what the synchronous send loop costs the page's main thread;
 * rttMs is first-byte-out to last-byte-back. */
async function m2FrameCost(frame, p) {
	await startEcho(p);
	const steps = [];
	for (const [size, capMs] of [
		[1024, 30_000],
		[4096, 60_000],
		[16384, 120_000],
		[65536, 300_000],
	]) {
		await p.flushLine();
		const step = await frame.evaluate(
			async ([size, capMs]) => {
				const probe = window.vinxSerialProbe;
				probe.record(3);
				const t0 = performance.now();
				const sendMs = probe.sendPattern(3, size, 0x78);
				const waited = await probe.waitCount(3, size, capMs);
				const tally = probe.stopRecord(3);
				return {
					size,
					sendMs,
					rttMs: waited.timedOut ? null : waited.at - t0,
					timedOut: !!waited.timedOut,
					got: tally.count,
					gaps: tally.gaps,
					maxGapMs: tally.maxGapMs,
				};
			},
			[size, capMs],
		);
		step.sendMs = round(step.sendMs);
		step.rttMs = round(step.rttMs);
		step.maxGapMs = round(step.maxGapMs);
		// What a stop-and-wait protocol would get out of this frame size.
		step.goodputKiBps = step.rttMs ? round(size / 1024 / (step.rttMs / 1000)) : null;
		steps.push(step);
		console.log('    M2 ', JSON.stringify(step));
		if (step.timedOut) break; // no point escalating past a failure
	}
	await stopEcho(p);
	return { steps };
}

/** M3: stop-and-wait RTT, 100 pings of 16 bytes against the echo. The
 * numbers to hold against CONFIG_HZ=100's 10 ms scheduling floor. */
async function m3StopAndWaitRtt(frame, p) {
	await startEcho(p);
	await p.flushLine();
	const raw = await frame.evaluate(async () => {
		const probe = window.vinxSerialProbe;
		probe.record(3);
		// Two warmups: the first trip pays for the guest's read wakeup path.
		let expected = 0;
		for (let i = 0; i < 2; i++) {
			expected += 16;
			probe.sendPattern(3, 16, 0x2e);
			const w = await probe.waitCount(3, expected, 15_000);
			if (w.timedOut) return { error: 'warmup timed out', rtts: [] };
		}
		const rtts = [];
		for (let i = 0; i < 100; i++) {
			expected += 16;
			const t0 = performance.now();
			probe.sendPattern(3, 16, 0x2e);
			const w = await probe.waitCount(3, expected, 15_000);
			if (w.timedOut) return { error: `ping ${i} timed out`, rtts };
			rtts.push(w.at - t0);
		}
		probe.stopRecord(3);
		return { rtts };
	});
	await stopEcho(p);
	if (raw.error) return { error: raw.error, n: raw.rtts.length };
	const sorted = [...raw.rtts].sort((a, b) => a - b);
	const result = {
		n: sorted.length,
		minMs: round(sorted[0]),
		p50Ms: round(quantile(sorted, 0.5)),
		p95Ms: round(quantile(sorted, 0.95)),
		maxMs: round(sorted.at(-1)),
	};
	console.log('    M3 ', JSON.stringify(result));
	return result;
}

/** M4: the modem lines. Does the guest's open/close reach the page as
 * DTR/RTS events; does CTS-low actually stop anything; does DCD-low gate
 * open(2) in the guest (the one line with session-reset potential). */
async function m4ModemLines(frame, p) {
	const result = {};

	// DTR/RTS visibility: v86's UART emits the events only when an MCR bit
	// actually flips (libv86: `bits_changed & 1/2`), so record the register
	// around a deliberate open-hold-close too — if MCR never moves, the
	// silence is the kernel's (close does not drop the lines), not v86's.
	await p.watchModem();
	const mcrBefore = (await p.uart()).mcr;
	await p.sh("sh -c 'exec 3<>/dev/ttyS3; sleep 1'"); // open, hold, close
	await new Promise((r) => setTimeout(r, 800));
	const mcrAfter = (await p.uart()).mcr;
	const events = await p.modemEvents();
	result.mcr = { before: mcrBefore, after: mcrAfter, dtrBit: 0x01, rtsBit: 0x02 };
	result.openCloseEvents = events.map((e) => `${e.line}=${e.value}`);
	result.dtrVisible = events.some((e) => e.line === 'dtr');
	result.rtsVisible = events.some((e) => e.line === 'rts');

	// CTS: drop it and ping through the echo; delivery both ways answers
	// "does anything on this stack honour CTS" (§15's open question).
	await startEcho(p, 60);
	const msrBefore = (await p.uart()).msr;
	await p.setCts(false);
	const msrLow = (await p.uart()).msr;
	await p.flushLine();
	const ping = await frame.evaluate(async () => {
		const probe = window.vinxSerialProbe;
		probe.record(3);
		const t0 = performance.now();
		probe.sendPattern(3, 64, 0x2e);
		const w = await probe.waitCount(3, 64, 10_000);
		probe.stopRecord(3);
		return { timedOut: !!w.timedOut, rttMs: w.timedOut ? null : w.at - t0 };
	});
	await p.setCts(true);
	await stopEcho(p);
	result.msr = { before: msrBefore, ctsLow: msrLow, ctsBit: 0x10 };
	result.ctsLowStopsTraffic = ping.timedOut;
	result.ctsPingRttMs = round(ping.rttMs);

	// DCD: drop it and ask the guest to open the port. A blocking open would
	// show as the timeout's SIGKILL (137). The MSR readback pins whether the
	// bit really fell (0x80) — separating "v86 ignored the set" from "the
	// kernel's open path never consulted the carrier".
	await p.setDcd(false);
	const msrDcdLow = (await p.uart()).msr;
	const lowOpen = await p.sh("timeout -s KILL 3 sh -c 'echo probe > /dev/ttyS3' 2>/dev/null; echo rc=$?");
	await p.setDcd(true);
	const msrDcdHigh = (await p.uart()).msr;
	const highOpen = await p.sh("timeout -s KILL 3 sh -c 'echo probe > /dev/ttyS3' 2>/dev/null; echo rc=$?");
	result.msrDcd = { low: msrDcdLow, high: msrDcdHigh, dcdBit: 0x80 };
	result.dcdLowOpenRc = lastNumber(lowOpen.output);
	result.dcdHighOpenRc = lastNumber(highOpen.output);
	result.dcdGatesOpen = result.dcdLowOpenRc !== 0 && result.dcdHighOpenRc === 0;
	await p.flushLine(); // the probe writes above may sit in the assembler

	console.log('    M4 ', JSON.stringify(result));
	return result;
}

/** M5: RTT inflation while the page's main thread spins — v86 itself runs
 * there, so the spin stalls the whole machine, not just the listener. */
async function m5BusyMainThread(frame, p) {
	await startEcho(p);
	await p.flushLine();
	const trials = [];
	for (const busyMs of [0, 100, 300]) {
		const trial = await frame.evaluate(
			async (busyMs) => {
				const probe = window.vinxSerialProbe;
				probe.record(3);
				// warmup
				probe.sendPattern(3, 16, 0x2e);
				let w = await probe.waitCount(3, 16, 15_000);
				if (w.timedOut) return { busyMs, error: 'warmup timed out' };
				const t0 = performance.now();
				probe.sendPattern(3, 16, 0x2e);
				const spinUntil = performance.now() + busyMs;
				while (performance.now() < spinUntil) {
					/* hold the main thread — the VM stalls with us */
				}
				w = await probe.waitCount(3, 32, 15_000);
				probe.stopRecord(3);
				return { busyMs, rttMs: w.timedOut ? null : w.at - t0, timedOut: !!w.timedOut };
			},
			busyMs,
		);
		trial.rttMs = round(trial.rttMs);
		trials.push(trial);
		console.log('    M5 ', JSON.stringify(trial));
	}
	await stopEcho(p);
	return { trials };
}

// ── run ──

const { frame, close } = await setup();
const p = probeOn(frame);
const report = {
	startedAt: new Date().toISOString(),
	v86: JSON.parse(await readFile(resolve(WEB, 'node_modules/v86/package.json'), 'utf8')).version,
	measurements: {},
	errors: {},
};

const suite = [
	['M1a', () => m1aClosedPortBacklog(p)],
	['M1b', () => m1bOpenPortOverflow(p)],
	['M2', () => m2FrameCost(frame, p)],
	['M3', () => m3StopAndWaitRtt(frame, p)],
	['M4', () => m4ModemLines(frame, p)],
	['M5', () => m5BusyMainThread(frame, p)],
];

try {
	for (const [name, fn] of suite) {
		if (!wants(name)) continue;
		console.log(`==> ${name}`);
		try {
			report.measurements[name] = await fn();
		} catch (e) {
			report.errors[name] = String(e?.message ?? e);
			console.error(`    ${name} FAILED: ${report.errors[name]}`);
		}
	}
} finally {
	await close();
}

await mkdir(dirname(OUT_JSON), { recursive: true });
await writeFile(OUT_JSON, JSON.stringify(report, null, '\t') + '\n');
console.log(`\nreport: ${OUT_JSON}`);
const failed = Object.keys(report.errors).length;
if (failed) console.error(`${failed} measurement(s) failed`);
process.exit(failed ? 1 : 0);
