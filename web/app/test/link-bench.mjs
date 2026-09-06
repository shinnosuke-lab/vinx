/**
 * HISTORICAL — not runnable since Phase 3. This was Phase 2's closing
 * measurement: the same guest commands over the two command channels,
 * while both still existed — ttyS1 agentd (RUN/DONE, the pre-Phase-2
 * link) and ttyS3 proc.run (rund behind rpcd). Phase 3 deleted agentd
 * (and the probe's `run()` this script's old leg rode), so the
 * comparison is unmeasurable now, exactly as planned; the numbers live
 * in docs/protocol-baseline.zh-CN.md §6 beside the Phase 0 physical-
 * layer baseline, and this file stays as the record of how they were
 * taken.
 *
 *   L1  round-trip latency   -> p50/p95/max of `true`, 100 runs per link
 *   L2  the output boundary  -> 512 B and 100 kB results on each link
 *   L3  the error surface    -> exit codes, timeouts, an oversized command
 *   L4  concurrency          -> four 1 s sleeps, wall clock each way
 *
 * Instruments were: window.vinxSerialProbe.run (the agentd leg, deleted
 * with agentd) and window.vinxRpc.call (raw proc.run — still alive; the
 * runShell adapter's scriptRef staging and ref-folding sit above it and
 * are browser.mjs's to prove). Timings were taken inside the page, so
 * the evaluate hop was not billed.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_JSON = process.env.BENCH_JSON || resolve(WEB, 'build/link-bench.json');

// ── setup: serve dist/, boot the terminal page, prove both channels ──

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
	// Ready means the control plane answered (vm.ts controlUp); the agentd
	// warm-up below proves the old leg too.
	await frame.waitForFunction(() => document.documentElement.dataset.vmState === 'ready', null, {
		timeout: 180_000,
	});
	const warm = await frame.evaluate(() => window.vinxSerialProbe.run('echo warm', 30));
	if (warm.exit_code !== 0) throw new Error(`agentd did not answer: ${JSON.stringify(warm)}`);
	const probe = await frame.evaluate(() => window.vinxRpc.call('proc.run', { command: 'true' }, 15_000));
	if (!probe.ok) throw new Error(`proc.run did not answer: ${JSON.stringify(probe)}`);

	const close = async () => {
		await browser.close();
		server.kill();
	};
	return { frame, close };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n);
const stats = (times) => {
	const s = [...times].sort((a, b) => a - b);
	return { p50: round(quantile(s, 0.5)), p95: round(quantile(s, 0.95)), max: round(s[s.length - 1]) };
};

// ── L1: round-trip latency ──

async function l1Latency(frame) {
	const RUNS = 100;
	const agentd = await frame.evaluate(async (n) => {
		const times = [];
		for (let i = 0; i < n; i++) {
			const t0 = performance.now();
			await window.vinxSerialProbe.run('true', 30);
			times.push(performance.now() - t0);
		}
		return times;
	}, RUNS);
	const procRun = await frame.evaluate(async (n) => {
		const times = [];
		for (let i = 0; i < n; i++) {
			const t0 = performance.now();
			await window.vinxRpc.call('proc.run', { command: 'true' }, 30_000);
			times.push(performance.now() - t0);
		}
		return times;
	}, RUNS);
	return { runs: RUNS, agentdMs: stats(agentd), procRunMs: stats(procRun) };
}

// ── L2: the output boundary ──

async function l2Output(frame) {
	const small = 'yes 0123456789abcde | head -c 512';
	const big = 'yes 0123456789abcde | head -c 100000';
	const agentdSmall = await frame.evaluate(([c]) => window.vinxSerialProbe.run(c, 60), [small]);
	const agentdBig = await frame.evaluate(([c]) => window.vinxSerialProbe.run(c, 60), [big]);
	const procSmall = await frame.evaluate(
		([c]) => window.vinxRpc.call('proc.run', { command: c }, 60_000),
		[small],
	);
	const procBig = await frame.evaluate(
		([c]) => window.vinxRpc.call('proc.run', { command: c }, 60_000),
		[big],
	);
	// The new link's ref carries the exact bytes; wc through a second call
	// proves it (and cleans up, the ref is this caller's).
	const refPath = procBig.ok ? procBig.result?.output?.path : null;
	const refWc = refPath
		? await frame.evaluate(
				([p]) => window.vinxRpc.call('proc.run', { command: `wc -c < ${p} && rm -f ${p}` }, 30_000),
				[refPath],
			)
		: null;
	return {
		agentd: {
			smallBytes: agentdSmall.output.length,
			bigBytes: agentdBig.output.length,
			bigExit: agentdBig.exit_code,
			marker: /trunc/i.test(agentdBig.output),
		},
		procRun: {
			smallInlineBytes: procSmall.ok ? (procSmall.result.stdout ?? '').length : -1,
			bigInlineBytes: procBig.ok ? (procBig.result.stdout ?? '').length : -1,
			bigTruncated: procBig.ok ? procBig.result.truncated === true : null,
			refSize: procBig.ok ? (procBig.result.output?.size ?? null) : null,
			refReadBack: refWc?.ok ? Number((refWc.result.stdout ?? '').trim()) : null,
		},
	};
}

// ── L3: the error surface ──

async function l3Errors(frame) {
	const agentdExit = await frame.evaluate(() => window.vinxSerialProbe.run('exit 7', 30));
	const procExit = await frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'exit 7' }, 30_000),
	);
	const agentdTimeout = await frame.evaluate(() => window.vinxSerialProbe.run('sleep 5', 1));
	const procTimeout = await frame.evaluate(() =>
		window.vinxRpc.call('proc.run', { command: 'sleep 5', timeoutMs: 1000 }, 30_000),
	);
	// A command far past the 4 KiB frame: the old link carries any length
	// (the RUN line is length-checked, not capped); the new link refuses
	// locally and callers stage a scriptRef — vm.ts's runShell does.
	const longCmd = `x='${'A'.repeat(8000)}'; printf %s "$x" | wc -c`;
	const agentdLong = await frame.evaluate(([c]) => window.vinxSerialProbe.run(c, 30), [longCmd]);
	const procLong = await frame.evaluate(
		([c]) => window.vinxRpc.call('proc.run', { command: c }, 30_000),
		[longCmd],
	);
	return {
		exitCode: {
			agentd: agentdExit.exit_code,
			procRun: procExit.ok ? procExit.result.exitCode : procExit.error?.name,
		},
		timeout: {
			agentd: { exit: agentdTimeout.exit_code, marked: false },
			procRun: procTimeout.ok
				? { exit: procTimeout.result.exitCode, marked: procTimeout.result.timedOut === true }
				: procTimeout.error?.name,
		},
		oversizedCommand: {
			agentd: { carried: /8000/.test(agentdLong.output), exit: agentdLong.exit_code },
			procRun: procLong.ok ? 'accepted' : procLong.error?.name,
		},
	};
}

// ── L4: concurrency ──

async function l4Concurrency(frame) {
	const agentdWallMs = await frame.evaluate(async () => {
		const t0 = performance.now();
		await Promise.all(
			[0, 1, 2, 3].map(() => window.vinxSerialProbe.run('sleep 1', 30)),
		);
		return performance.now() - t0;
	});
	const procWallMs = await frame.evaluate(async () => {
		const t0 = performance.now();
		await Promise.all(
			[0, 1, 2, 3].map(() =>
				window.vinxRpc.call('proc.run', { command: 'sleep 1', timeoutMs: 30_000 }, 30_000),
			),
		);
		return performance.now() - t0;
	});
	return { jobs: 4, agentdWallMs: round(agentdWallMs), procRunWallMs: round(procWallMs) };
}

// ── run ──

const { frame, close } = await setup();
try {
	const results = {};
	console.log('==> L1 latency (100 runs per link)');
	results.L1 = await l1Latency(frame);
	console.log('   ', JSON.stringify(results.L1));
	console.log('==> L2 output boundary');
	results.L2 = await l2Output(frame);
	console.log('   ', JSON.stringify(results.L2));
	console.log('==> L3 error surface');
	results.L3 = await l3Errors(frame);
	console.log('   ', JSON.stringify(results.L3));
	console.log('==> L4 concurrency (4 × sleep 1)');
	results.L4 = await l4Concurrency(frame);
	console.log('   ', JSON.stringify(results.L4));

	await mkdir(dirname(OUT_JSON), { recursive: true });
	await writeFile(OUT_JSON, JSON.stringify(results, null, '\t'));
	console.log(`\nwrote ${OUT_JSON}`);
} finally {
	await close();
}
