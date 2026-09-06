/**
 * The broken-manifest corpus (system-v2 §16-7): twenty app directories,
 * each wrong in a way `app check --json` must name with a stable
 * {code, path} — the error surface a model repairs against (§13.2).
 *
 * One source, two consumers: browser.mjs pins every sample's codes as a
 * regression (the contract test), and manifest-repair-eval.mjs feeds the
 * samples to a real model and measures the two-round repair rate (the
 * freeze-gate evidence, run by hand — it needs a real endpoint).
 *
 * Sample ids are app ids (lowercase/digits/dashes): they become directory
 * names, and a bad directory name is its own finding (ID_INVALID), which
 * these samples deliberately avoid triggering.
 */

const RUN_OK = '#!/bin/sh\necho hi\n';

/** files: path -> content; exec: paths to chmod +x; expect: sorted codes. */
export const CORPUS = [
	{
		id: 'no-manifest',
		files: { 'README.md': 'no manifest here\n' },
		exec: [],
		expect: ['NO_MANIFEST'],
	},
	{
		id: 'bad-json',
		files: { 'app.json': '{ "schema": 0, oops\n' },
		exec: [],
		expect: ['BAD_JSON'],
	},
	{
		id: 'empty-manifest',
		files: { 'app.json': '' },
		exec: [],
		expect: ['BAD_JSON'],
	},
	{
		id: 'schema-unknown',
		files: { 'app.json': '{"schema":7,"kind":"command","exec":"./run"}\n', run: RUN_OK },
		exec: ['run'],
		expect: ['SCHEMA_UNKNOWN'],
	},
	{
		id: 'schema-string',
		files: { 'app.json': '{"schema":"zero","kind":"command","exec":"./run"}\n', run: RUN_OK },
		exec: ['run'],
		expect: ['SCHEMA_UNKNOWN'],
	},
	{
		id: 'kind-unknown',
		files: { 'app.json': '{"schema":0,"kind":"daemon","exec":"./run"}\n', run: RUN_OK },
		exec: ['run'],
		expect: ['KIND_UNKNOWN'],
	},
	{
		id: 'kind-empty',
		files: { 'app.json': '{"schema":0,"kind":"","exec":"./run"}\n', run: RUN_OK },
		exec: ['run'],
		expect: ['KIND_UNKNOWN'],
	},
	{
		id: 'ui-missing',
		files: { 'app.json': '{"schema":0,"kind":"window","exec":"./run"}\n', run: RUN_OK },
		exec: ['run'],
		expect: ['UI_MISSING'],
	},
	{
		id: 'ui-unknown',
		files: {
			'app.json': '{"schema":0,"kind":"window","ui":{"type":"native"},"exec":"./run"}\n',
			run: RUN_OK,
		},
		exec: ['run'],
		expect: ['UI_UNKNOWN'],
	},
	{
		id: 'ui-numeric',
		files: {
			'app.json': '{"schema":0,"kind":"window","ui":{"type":123},"exec":"./run"}\n',
			run: RUN_OK,
		},
		exec: ['run'],
		expect: ['UI_UNKNOWN'],
	},
	{
		id: 'cmd-no-entry',
		files: { 'app.json': '{"schema":0,"kind":"command"}\n' },
		exec: [],
		expect: ['ENTRY_NOT_FOUND'],
	},
	{
		id: 'svc-no-entry',
		files: { 'app.json': '{"schema":0,"kind":"service"}\n' },
		exec: [],
		expect: ['ENTRY_NOT_FOUND'],
	},
	{
		id: 'exec-missing',
		files: { 'app.json': '{"schema":0,"kind":"command","exec":"./main"}\n' },
		exec: [],
		expect: ['ENTRY_NOT_FOUND'],
	},
	{
		id: 'entry-not-exec',
		files: { 'app.json': '{"schema":0,"kind":"command","exec":"./run"}\n', run: RUN_OK },
		exec: [], // the point: run exists but is not executable
		expect: ['ENTRY_NOT_EXEC'],
	},
	{
		id: 'entry-absolute',
		files: { 'app.json': '{"schema":0,"kind":"command","exec":"/bin/sh"}\n' },
		exec: [],
		expect: ['ENTRY_ESCAPES'],
	},
	{
		id: 'entry-dotdot',
		files: { 'app.json': '{"schema":0,"kind":"command","exec":"../up"}\n' },
		exec: [],
		expect: ['ENTRY_ESCAPES'],
	},
	{
		id: 'entry-sneaky',
		files: { 'app.json': '{"schema":0,"kind":"command","exec":"./x/../../up"}\n' },
		exec: [],
		expect: ['ENTRY_ESCAPES'],
	},
	{
		id: 'web-no-html',
		files: { 'app.json': '{"schema":0,"kind":"window","ui":{"type":"web"}}\n' },
		exec: [],
		expect: ['ENTRY_NOT_FOUND'], // path ui.html: the window's entry
	},
	{
		id: 'tty-no-entry',
		files: { 'app.json': '{"schema":0,"kind":"window","ui":{"type":"tty"}}\n' },
		exec: [],
		expect: ['ENTRY_NOT_FOUND'],
	},
	{
		id: 'hybrid-double',
		// Two findings at once: the backend entry is not executable AND
		// the web window has no index.html — a repair needs both.
		files: {
			'app.json': '{"schema":0,"kind":"window","ui":{"type":"web"},"exec":"./run"}\n',
			run: RUN_OK,
		},
		exec: [],
		expect: ['ENTRY_NOT_EXEC', 'ENTRY_NOT_FOUND'],
	},
];

/** Shell commands that materialise one sample under baseDir (base64 keeps
 * quoting out of the argument; busybox base64 -d decodes it). */
export function sampleCommands(sample, baseDir) {
	const dir = `${baseDir}/${sample.id}`;
	const cmds = [`mkdir -p ${dir}`];
	for (const [path, content] of Object.entries(sample.files)) {
		const b64 = Buffer.from(content, 'utf8').toString('base64');
		cmds.push(`echo ${b64} | base64 -d > ${dir}/${path}`);
	}
	for (const path of sample.exec) cmds.push(`chmod +x ${dir}/${path}`);
	return cmds;
}

export function expectedCodes(sample) {
	return [...sample.expect].sort().join(',');
}
