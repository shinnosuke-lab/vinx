/**
 * Builds the page: the chat UI, the worker, the wasm engine, and the VM.
 *
 * The UI lives in this repository, source and lockfile, forked at the same
 * commit as the engine — see `vendor/VENDOR.json`. It used to be read out of
 * an external checkout, which meant the page could be built against a UI
 * newer than the engine beside it and CI had to clone a second repository to
 * build at all.
 *
 * What is consumed is the `dist/` its own build produces, not its source:
 * compiling it here would mean reproducing its Tailwind setup and keeping the
 * two in step, for no benefit. Its build is a separate npm project, so run it
 * first:
 *
 *     (cd web/vendor/ui && npm ci && npm run build)
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repo = import.meta.dirname;
const uiSrc = resolve(repo, 'vendor/ui');
const chatUi = resolve(uiSrc, 'dist');

// Otherwise this surfaces far from its cause — as an unresolved bare import
// somewhere inside the bundler.
if (!existsSync(resolve(chatUi, 'index.js'))) {
	throw new Error(
		`@vinx/agent-chat is vendored but not built.\nRun: (cd ${uiSrc} && npm ci && npm run build)`,
	);
}

// From the repo's version.sh, not this package.json: the same VER is shown in
// the corner of the page, so the number there is the one that would be quoted
// in a bug report. package.json's version is inert npm metadata.
const versionSh = readFileSync(resolve(repo, '../version.sh'), 'utf8');
const version = /^VER=(.+)$/m.exec(versionSh)?.[1];
if (!version) {
	throw new Error(`No VER= in ${resolve(repo, '../version.sh')}`);
}

// Which build this is, in the same words upstream's SPA uses (`vendor/ui`'s
// vite.app.config.ts) because it lands in the same place: the About popover's
// "Built" row, which reads the global and shows a dash without it.
const buildTime = new Date()
	.toISOString()
	.replace('T', ' ')
	.replace(/\.\d+Z$/, ' UTC');

// Where installable skills are published. Empty hides the market tab; see
// version.sh.
const skillsRepo = declared('SKILLS_REPO');

// Where installable apps (.vapp packages) are published — the apps-hub.
// Empty hides the Apps page's repository tab the same way.
const appsRepo = declared('APPS_REPO');

// The endpoint the page starts with. The settings panel remains the authority
// once anyone has used it. Anything set here lands in the bundle in clear,
// which is why version.sh insists DEFAULT_API_KEY stays empty in anything
// published.
const defaults = {
	baseUrl: declared('DEFAULT_BASE_URL'),
	model: declared('DEFAULT_MODEL'),
	apiKey: declared('DEFAULT_API_KEY'),
};

/**
 * One `NAME=value` from version.sh, overridable by the environment.
 *
 * Absent and empty are the same answer here: every one of these means "the page
 * asks instead", and a build should not fail over a line someone commented out.
 *
 * version.sh is read as text, not run, so `NAME=${NAME:-default}` — how it lets
 * a test suite override a line — arrives here unexpanded. Left alone, the
 * literal `${SKILLS_REPO:-…}` was baked into the bundle and the page asked its
 * own origin for `/$%7BSKILLS_REPO:-…%7D/index.json`. So that one idiom is
 * understood here, and anything else still carrying a `${` stops the build: a
 * shell construct this does not evaluate is a wrong value, and it is cheaper
 * to fail now than to find it in a 404 later.
 */
function declared(name: string): string {
	const fromEnv = process.env[name];
	if (fromEnv !== undefined) return fromEnv;
	const raw = new RegExp(`^${name}=(.*)$`, 'm').exec(versionSh)?.[1] ?? '';
	const value = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-(.*)\}$/.exec(raw)?.[1] ?? raw;
	if (value.includes('${')) {
		throw new Error(
			`${name} in version.sh is a shell expression this build cannot evaluate: ${raw}\n` +
				`Write a plain value, or set ${name} in the environment.`,
		);
	}
	return value;
}

export default defineConfig(() => ({
	root: resolve(repo, 'app'),
	// Relative, so the built site works from any directory on any static host
	// (GitHub Pages under /repo/, a CDN subpath, file previews). There is no
	// server side at all: the Linux the terminal talks to is emulated in the
	// page itself.
	base: './',
	// dev:https sets HTTPS_DEV: a self-signed certificate, so another machine
	// on the LAN gets a *secure context* — Web Serial, Web Bluetooth and the
	// directory picker exist only there, and plain `vite --host` over HTTP
	// silently loses all three chips. One "proceed anyway" click per browser.
	plugins: [react(), ...(process.env.HTTPS_DEV ? [basicSsl()] : [])],
	resolve: {
		alias: {
			'@vinx/agent-chat/styles.css': resolve(chatUi, 'styles.css'),
			'@vinx/agent-chat': resolve(chatUi, 'index.js'),
		},
		// The UI is built in its own npm project, which has its own React in
		// `node_modules`. Two copies of React means every hook throws, with an
		// error that blames the component rather than the duplication.
		dedupe: ['react', 'react-dom'],
	},
	define: {
		__APP_VERSION__: JSON.stringify(version),
		__BUILD_TIME__: JSON.stringify(buildTime),
		__SKILLS_REPO__: JSON.stringify(skillsRepo),
		__APPS_REPO__: JSON.stringify(appsRepo),
		__DEFAULTS__: JSON.stringify(defaults),
		// Where the app shell lives (§10.3). Empty — the default — means the
		// copy shipped beside the page (app/public/app-frame.html, resolved
		// at runtime by app/app-frame-url.ts). Set to put it on a different
		// site instead; see the shell's own header for what that buys.
		__APP_FRAME_URL__: JSON.stringify(process.env.VINX_APP_FRAME_URL ?? ''),
	},
	build: {
		outDir: resolve(repo, 'dist'),
		emptyOutDir: true,
		target: 'es2022',
		// Two documents, one asset tree: the chat page and the terminal. The
		// terminal is a directory index so the site answers at `/terminal/`,
		// which is the URL the vendored UI's apps page and open_terminal
		// button both use (static hosts redirect `/terminal` there too).
		rollupOptions: {
			input: {
				main: resolve(repo, 'app/index.html'),
				terminal: resolve(repo, 'app/terminal/index.html'),
			},
		},
	},
	server: {
		// SQLite in wasm wants shared memory only when threaded; this is the
		// single-threaded build, so no COOP/COEP headers are needed. Kept as a
		// note because the first instinct on a wasm+SQLite failure is to add them.
		port: 5173,
		fs: {
			// The page's root is `app/`, but it imports the runtime and the UI
			// from elsewhere in the repository. Without this the dev server
			// refuses to serve them.
			allow: [repo],
		},
	},
}));
