/**
 * `app check` for a web app that never touched the machine.
 *
 * The workspace `install_app` (app-install.ts) lands a pure web app in the
 * machine's /data/apps without the machine — so the validation the guest
 * `app install` would have run (usr/bin/app's check_tree) runs here, on the
 * page, over the same shape: the manifest fields the model gave and the
 * three parts it wrote. Same codes, same words, same hints, so the model
 * reads one language whichever side refused it, and the linux-vm skill's
 * §13.2 table describes both. What the guest checks that cannot fail here
 * (a manifest we write ourselves, an entry we do not have) is left out.
 *
 * Pure: no DOM, no store — runtime/test exercises it under node.
 */

import type { WebAppSource } from '../runtime/src/protocol';
import { PART_MAX } from './vapp';

export interface Finding {
	sev: 'E' | 'W';
	code: string;
	/** The guest's "path" column: the would-be manifest field (ui.html,
	 * ui.js) or the file the finding is about. */
	path: string;
	message: string;
	hint: string;
}

/** App ids are package-name shaped (§9.2); the guest's check_id, verbatim. */
export const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Names /data/apps and the CLI keep for themselves (check_id). */
export const RESERVED_IDS = new Set(['app', 'enabled', 'rpc', 'rpcd', 'rund', 'vinx']);
export const TITLE_MAX = 64;
export const DESCRIPTION_MAX = 240;

const decoder = new TextDecoder();

/** The guest's index.html greps (usr/bin/app, the HTML_EXTERNAL_REF pair). */
const LINKS_PARTS = /<(link[^>]+rel=["']?stylesheet|script[^>]+src=)/i;
const WHOLE_DOCUMENT = /<(!doctype|html|head|body)([ >]|$)/im;
/** And its app.js greps (JS_SANDBOX_API, storage then network). */
const SANDBOX_STORAGE = /(^|[^A-Za-z0-9_$.])(localStorage|sessionStorage|indexedDB)([^A-Za-z0-9_$]|$)|document\.cookie/m;
const SANDBOX_NETWORK = /(^|[^A-Za-z0-9_$.])fetch\(|XMLHttpRequest|new WebSocket|import\(/m;

function finding(sev: Finding['sev'], code: string, path: string, message: string, hint: string): Finding {
	return { sev, code, path, message, hint };
}

/**
 * Every finding for the app as `install_app` handed it over, errors and
 * warnings together, in the guest's order: id, entry, the window contract,
 * the listing words, sizes. Empty means a clean `app check: ok`.
 */
export function checkWebApp(app: WebAppSource): Finding[] {
	const out: Finding[] = [];
	const id = app.id;
	if (!APP_ID.test(id)) {
		out.push(
			finding(
				'E',
				'ID_INVALID',
				id,
				`'${id}' is not an app id`,
				'lowercase letters, digits and dashes, 1-32 characters, starting with a letter or digit',
			),
		);
	} else if (RESERVED_IDS.has(id)) {
		out.push(finding('E', 'ID_RESERVED', id, `'${id}' is a reserved name`, 'pick another id'));
	}
	if (app.html.byteLength === 0) {
		out.push(
			finding('E', 'ENTRY_NOT_FOUND', 'ui.html', 'index.html is empty', 'the html part is the window: give it a body fragment'),
		);
	} else {
		const html = decoder.decode(app.html);
		if (LINKS_PARTS.test(html)) {
			out.push(
				finding(
					'W',
					'HTML_EXTERNAL_REF',
					'ui.html',
					'index.html links style.css / app.js by <link> or <script src>',
					'drop them: the window injects style.css and app.js itself; index.html is a body fragment',
				),
			);
		} else if (WHOLE_DOCUMENT.test(html)) {
			out.push(
				finding(
					'W',
					'HTML_EXTERNAL_REF',
					'ui.html',
					'index.html is a whole document (<html>/<head>/<body>)',
					'make it a body fragment: the window supplies the document; only the body content is yours',
				),
			);
		}
	}
	if (app.js) {
		const js = decoder.decode(app.js);
		if (SANDBOX_STORAGE.test(js)) {
			out.push(
				finding(
					'W',
					'JS_SANDBOX_API',
					'ui.js',
					'app.js uses localStorage/sessionStorage/indexedDB/cookie, which the sandboxed window does not have',
					'state lives only while the window is open (an in-memory stand-in); for persistence put a service behind the window (kind window + exec)',
				),
			);
		}
		if (SANDBOX_NETWORK.test(js)) {
			out.push(
				finding(
					'W',
					'JS_SANDBOX_API',
					'ui.js',
					'app.js reaches for the network (fetch/XMLHttpRequest/WebSocket/import), which the window CSP forbids',
					'a web window has no network: bundle everything into the three files, and talk to the system only through vinx.call',
				),
			);
		}
	}
	// The two words a listing shows: optional, short (the guest's caps).
	// Length in code units, as jq's `length` counts a string.
	for (const [name, value, cap] of [
		['title', app.title, TITLE_MAX],
		['description', app.description, DESCRIPTION_MAX],
	] as const) {
		if (value !== undefined && value.length > cap) {
			out.push(
				finding('E', `${name.toUpperCase()}_INVALID`, 'app.json', `${name} is longer than ${cap} characters`, `a shorter ${name}`),
			);
		}
	}
	// The engine capped the parts before handing them over; the page is the
	// last word because it is the one that stages them into a window.
	for (const [path, bytes] of [
		['index.html', app.html],
		['style.css', app.css],
		['app.js', app.js],
	] as const) {
		if (bytes && bytes.byteLength > PART_MAX) {
			out.push(
				finding(
					'E',
					'PART_TOO_BIG',
					path,
					`${path} is ${bytes.byteLength} bytes; a window stages at most ${PART_MAX} per part`,
					'trim it, or move data the window needs into the fragment as it is used',
				),
			);
		}
	}
	return out;
}

/** The guest's plain report, one line per finding — what `app check` prints
 * and what the model already knows how to read. */
export function formatFindings(findings: Finding[]): string {
	return findings
		.map((f) => `app check: ${f.sev === 'E' ? 'error' : 'warning'} ${f.code} (${f.path}): ${f.message} -- ${f.hint}`)
		.join('\n');
}
