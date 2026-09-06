/**
 * The §16-7 repair-rate evaluation: feed each broken manifest in
 * manifest-corpus.mjs to a real model with `app check --json`'s findings,
 * apply its patch, re-check — at most two rounds — and report the repair
 * rate. The freeze gate wants >= 90%.
 *
 * This is hand-run evidence, not CI: it needs a real OpenAI-compatible
 * endpoint (a mock cannot repair anything) and a served page with VM
 * images. The corpus regression itself (codes stay stable) lives in
 * browser.mjs and runs in every suite.
 *
 * Usage:
 *   # 1. serve the page with images, e.g.:  cd web && npm run dev
 *   # 2. point the evaluator at it and at a model:
 *   APP_URL=http://127.0.0.1:5173/ \
 *   EVAL_URL=https://api.openai.com/v1 EVAL_KEY=sk-... EVAL_MODEL=gpt-4o-mini \
 *   node app/test/manifest-repair-eval.mjs
 *
 * The model sees the app's files and the check findings, and must answer
 * pure JSON: {"files": {path: content}, "exec": [path...]} — the repaired
 * tree, whole. Two rounds of that is the §13.2 loop an agent would run.
 */

import { chromium } from 'playwright';

import { CORPUS, sampleCommands } from './manifest-corpus.mjs';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const EVAL_URL = (process.env.EVAL_URL ?? '').replace(/\/$/, '');
const EVAL_KEY = process.env.EVAL_KEY ?? '';
const EVAL_MODEL = process.env.EVAL_MODEL ?? '';
const ROUNDS = 2;

if (!EVAL_URL || !EVAL_MODEL) {
	console.error('manifest-repair-eval: set EVAL_URL, EVAL_MODEL (and usually EVAL_KEY).');
	console.error('This evaluator needs a real model; the corpus regression in browser.mjs does not.');
	process.exit(2);
}

async function askModel(sample, files, exec, findings) {
	const fileDump = Object.entries(files)
		.map(([p, c]) => `--- ${p} ---\n${c}`)
		.join('\n');
	const body = {
		model: EVAL_MODEL,
		temperature: 0,
		messages: [
			{
				role: 'system',
				content:
					'You repair small app packages for the vinx system. The manifest is app.json ' +
					'(fields: schema (must be 0 or 1), kind (command|service|window), exec (a relative ' +
					'path inside the app, no .. and not absolute), ui.type (web|tty|fb, only for kind window). ' +
					'A window+web app needs index.html; every other kind needs its exec entry to exist and be ' +
					'executable. Answer ONLY JSON, no fences: {"files": {"path": "content", ...}, "exec": ["path", ...]} ' +
					'— the complete repaired file set (files you omit are deleted), exec lists the paths that ' +
					'must be executable. Keep the app\'s apparent intent.',
			},
			{
				role: 'user',
				content:
					`App directory "${sample.id}" currently contains:\n${fileDump || '(no files)'}\n\n` +
					`Executable: ${exec.join(', ') || '(nothing)'}\n\n` +
					`app check --json says:\n${JSON.stringify(findings, null, 1)}\n\nRepair it.`,
			},
		],
	};
	const res = await fetch(`${EVAL_URL}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(EVAL_KEY ? { authorization: `Bearer ${EVAL_KEY}` } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`the model endpoint answered ${res.status}: ${await res.text()}`);
	const data = await res.json();
	const text = String(data.choices?.[0]?.message?.content ?? '').trim();
	const naked = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	const patch = JSON.parse(naked);
	if (typeof patch !== 'object' || patch === null || typeof patch.files !== 'object')
		throw new Error('the model did not answer {files, exec}');
	return { files: patch.files, exec: Array.isArray(patch.exec) ? patch.exec.map(String) : [] };
}

async function main() {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	await page.goto(new URL('terminal/', APP_URL).href, { waitUntil: 'networkidle' });
	await page.waitForSelector('iframe[name="pane-1"]', { timeout: 30_000 });
	let frame;
	for (const deadline = Date.now() + 30_000; ; ) {
		frame = page.frame({ name: 'pane-1' });
		if (frame) break;
		if (Date.now() > deadline) throw new Error('the pane frame never appeared');
		await new Promise((r) => setTimeout(r, 100));
	}
	await frame.waitForFunction(() => document.documentElement?.dataset.vmState === 'ready', null, {
		timeout: 180_000,
	});
	for (const deadline = Date.now() + 60_000; ; ) {
		const r = await frame.evaluate(() => window.vinxRpc?.call('proc.run', { command: 'true' }, 10_000));
		if (r?.ok) break;
		if (Date.now() > deadline) throw new Error(`the control plane never came up: ${JSON.stringify(r)}`);
		await new Promise((p) => setTimeout(p, 500));
	}
	const sh = async (command) => {
		const r = await frame.evaluate((c) => window.vinxRpc.run(c, 60), command);
		return r;
	};

	const results = [];
	for (const sample of CORPUS) {
		// The evaluator owns the sample's state: files + exec bits. Guest
		// trees are rebuilt from this state every round, so the model's
		// patch is authoritative and auditable.
		let files = { ...sample.files };
		let exec = [...sample.exec];
		let repairedAt = -1;
		let failure = '';

		for (let round = 0; round <= ROUNDS; round++) {
			// Materialise the current state.
			const dir = `/tmp/eval/${sample.id}`;
			const cmds = [`rm -rf ${dir}`, ...sampleCommands({ id: sample.id, files, exec }, '/tmp/eval')];
			const put = await sh(cmds.join(' && '));
			if (put.exit_code !== 0) throw new Error(`staging ${sample.id} failed: ${put.output}`);

			const chk = await sh(`app check ${dir} --json`);
			let findings;
			try {
				findings = JSON.parse(chk.output.replace(/\[exit code: \d+\]\s*$/, ''));
			} catch {
				throw new Error(`${sample.id}: check did not answer JSON: ${chk.output}`);
			}
			if (findings.ok) {
				repairedAt = round;
				break;
			}
			if (round === ROUNDS) {
				failure = JSON.stringify(findings.errors);
				break;
			}
			try {
				const patch = await askModel(sample, files, exec, findings);
				files = Object.fromEntries(Object.entries(patch.files).map(([p, c]) => [p, String(c)]));
				exec = patch.exec;
			} catch (e) {
				failure = `model: ${e.message}`;
				break;
			}
		}
		const verdict = repairedAt > 0 ? `repaired in ${repairedAt} round(s)` : repairedAt === 0 ? 'was never broken?' : `NOT repaired (${failure})`;
		console.log(`  ${sample.id.padEnd(16)} ${verdict}`);
		results.push({ id: sample.id, repaired: repairedAt > 0 });
	}

	await sh('rm -rf /tmp/eval');
	await browser.close();

	const repaired = results.filter((r) => r.repaired).length;
	const rate = (repaired / results.length) * 100;
	console.log(`\nrepair rate: ${repaired}/${results.length} = ${rate.toFixed(0)}% (the §16-7 gate is 90%)`);
	process.exit(rate >= 90 ? 0 : 1);
}

main().catch((e) => {
	console.error(`manifest-repair-eval: ${e.message}`);
	process.exit(1);
});
