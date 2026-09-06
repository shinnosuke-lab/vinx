/**
 * The page-side `app check` (app/app-check.ts): what `install_app` refuses
 * and what it warns about, in the guest's codes and words. The regexes are
 * the ones usr/bin/app greps with; a change on one side that the other does
 * not follow shows up here as a finding the guest would not have raised, or
 * a silence where it would have.
 */

import { describe, expect, it } from 'vitest';

import {
	APP_ID,
	DESCRIPTION_MAX,
	RESERVED_IDS,
	TITLE_MAX,
	checkWebApp,
	formatFindings,
	type Finding,
} from '../../app/app-check';
import { PART_MAX } from '../../app/vapp';

const enc = new TextEncoder();

function app(over: Partial<{ id: string; title: string; description: string; html: string; css: string; js: string }> = {}) {
	const src = { id: 'timer', html: '<h1 id="t">tick</h1>\n', ...over };
	return {
		id: src.id,
		title: src.title,
		description: src.description,
		html: enc.encode(src.html),
		css: src.css === undefined ? undefined : enc.encode(src.css),
		js: src.js === undefined ? undefined : enc.encode(src.js),
	};
}

const codes = (f: Finding[]) => f.map((x) => `${x.sev}:${x.code}`);

describe('checkWebApp', () => {
	it('passes the scaffold `app new --web` makes', () => {
		expect(
			checkWebApp(
				app({
					title: 'Timer',
					description: 'a countdown',
					css: 'body{margin:0}\n',
					js: "document.getElementById('t').textContent = 'hello from js';\n",
				}),
			),
		).toEqual([]);
	});

	it('refuses ids the guest’s check_id refuses, and its reserved names', () => {
		for (const bad of ['', 'Timer', '-timer', 'my_timer', 'a'.repeat(33), 'timer.vapp', '../x']) {
			expect(APP_ID.test(bad)).toBe(false);
			expect(codes(checkWebApp(app({ id: bad })))).toEqual(['E:ID_INVALID']);
		}
		for (const ok of ['t', '2048', 'my-timer', 'a'.repeat(32)]) expect(codes(checkWebApp(app({ id: ok })))).toEqual([]);
		for (const reserved of RESERVED_IDS) expect(codes(checkWebApp(app({ id: reserved })))).toEqual(['E:ID_RESERVED']);
	});

	it('refuses an empty fragment, and the listing words past the guest’s caps', () => {
		expect(codes(checkWebApp(app({ html: '' })))).toEqual(['E:ENTRY_NOT_FOUND']);
		expect(codes(checkWebApp(app({ title: 'x'.repeat(TITLE_MAX) })))).toEqual([]);
		expect(codes(checkWebApp(app({ title: 'x'.repeat(TITLE_MAX + 1) })))).toEqual(['E:TITLE_INVALID']);
		expect(codes(checkWebApp(app({ description: 'y'.repeat(DESCRIPTION_MAX) })))).toEqual([]);
		expect(codes(checkWebApp(app({ description: 'y'.repeat(DESCRIPTION_MAX + 1) })))).toEqual(['E:DESCRIPTION_INVALID']);
	});

	it('caps each part where the window stages it', () => {
		expect(codes(checkWebApp(app({ css: 'a'.repeat(PART_MAX) })))).toEqual([]);
		expect(codes(checkWebApp(app({ css: 'a'.repeat(PART_MAX + 1) })))).toEqual(['E:PART_TOO_BIG']);
		const big = checkWebApp(app({ js: 'b'.repeat(PART_MAX + 1) }));
		expect(big[0].path).toBe('app.js');
	});

	it('warns about a whole document or its own <link>/<script src>, once, as HTML_EXTERNAL_REF', () => {
		expect(codes(checkWebApp(app({ html: '<!doctype html><html><body><h1>x</h1></body></html>' })))).toEqual([
			'W:HTML_EXTERNAL_REF',
		]);
		expect(codes(checkWebApp(app({ html: '<link rel="stylesheet" href="style.css"><h1>x</h1>' })))).toEqual([
			'W:HTML_EXTERNAL_REF',
		]);
		expect(codes(checkWebApp(app({ html: '<h1>x</h1><script src="app.js"></script>' })))).toEqual(['W:HTML_EXTERNAL_REF']);
		// Words the guest's grep does not trip on: a heading that says "html",
		// an inline script, a data attribute.
		expect(checkWebApp(app({ html: '<h1>html is fun</h1><script>1</script><p data-body="x"></p>' }))).toEqual([]);
	});

	it('warns about storage and network in app.js as JS_SANDBOX_API, separately', () => {
		expect(codes(checkWebApp(app({ js: 'localStorage.setItem("a", 1)' })))).toEqual(['W:JS_SANDBOX_API']);
		expect(codes(checkWebApp(app({ js: 'const c = document.cookie' })))).toEqual(['W:JS_SANDBOX_API']);
		expect(codes(checkWebApp(app({ js: 'fetch("/x")' })))).toEqual(['W:JS_SANDBOX_API']);
		expect(codes(checkWebApp(app({ js: 'const ws = new WebSocket(u)' })))).toEqual(['W:JS_SANDBOX_API']);
		expect(codes(checkWebApp(app({ js: 'const m = await import("./x.js")' })))).toEqual(['W:JS_SANDBOX_API']);
		expect(codes(checkWebApp(app({ js: 'indexedDB.open("a"); fetch("/x")' })))).toEqual(['W:JS_SANDBOX_API', 'W:JS_SANDBOX_API']);
		// The system's own door, and lookalikes: not the sandbox's APIs.
		expect(checkWebApp(app({ js: "vinx.call('proc.run', {}); state.myfetch(); import x from 'y'; const sessionStorageLike = 1;" }))).toEqual([]);
	});

	it('formats findings the way `app check` prints them', () => {
		const lines = formatFindings(checkWebApp(app({ id: 'App', html: '<html></html>' })));
		expect(lines.split('\n')).toEqual([
			"app check: error ID_INVALID (App): 'App' is not an app id -- lowercase letters, digits and dashes, 1-32 characters, starting with a letter or digit",
			'app check: warning HTML_EXTERNAL_REF (ui.html): index.html is a whole document (<html>/<head>/<body>) -- make it a body fragment: the window supplies the document; only the body content is yours',
		]);
	});
});
