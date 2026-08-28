/**
 * The whole agent in a page.
 *
 * This is agent-core's own SPA entry with `mount()` added before render.
 * Everything the UI asks for over HTTP is answered by the worker, so
 * `CopilotApp` is used exactly as it is upstream — including its settings panel,
 * which is where the model endpoint and key are entered.
 *
 * The device is a Linux machine emulated in this same tab (v86): its `run_shell`
 * tool runs commands on it. The /terminal page runs machines of its own — what
 * the pages share is the session history and /data/share/local, not a VM. It
 * boots lazily on the first turn that needs it, not on page load — a chat that
 * never runs a command never pays for a VM.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CopilotApp } from '@vinx/agent-chat';
import '@vinx/agent-chat/styles.css';
// After the UI's own sheet, so its rules are the ones that lose; see the file
// for what it hides and why it is not a theme.
import './capabilities.css';

import { mount } from '../runtime/src/index';
import { runJs } from './hostcall';
import { sharedVm } from './vm';
import { shareLocalFile, requestSnapshot } from './share-store';
import { relayLabel, resolveRelay } from './vm-config';
import { mountNetFab } from './net-panel';
import { mountDanmaku } from './danmaku';
import { triggerDownload } from './downloads';
// The Linux reference this page carries; installed after mount. Shared with
// the terminal's assistant panel, which is why it is its own module.
import { installBundledSkill } from './bundled-skill';
import { guardRunningTurns, type LeaveGuard } from './leaving';
// The device's own tool, drawn as the command it carries; see the file.
import { RunShellTool } from './run-shell-tool';
import { VM_TOOL_CARDS } from './vm-tool-cards';
// Vite only bundles a worker when the URL is written statically, and the
// client's own default is deliberately bundler-agnostic — so name it here.
import workerUrl from '../runtime/src/worker.ts?worker&url';

const root = createRoot(document.getElementById('root')!);

/** Somewhere to look when the engine itself will not load. */
function fatal(message: string) {
	root.render(
		<div style={{ padding: '2rem', fontFamily: 'system-ui', lineHeight: 1.6 }}>
			<h1 style={{ fontSize: '1.1rem' }}>The agent could not start</h1>
			<pre style={{ whiteSpace: 'pre-wrap', color: '#b00' }}>{message}</pre>
		</div>,
	);
}

try {
	// Set below, from the client this mount returns. Nothing can start a turn
	// before then — the UI does not exist yet — so the hole is only in the
	// order the two are written.
	let leaving: LeaveGuard | null = null;

	// The VM's network, from `?relay=` / localStorage; see vm-config.ts. The
	// first sharedVm() call fixes the option for the page's lifetime.
	const relay = resolveRelay();
	console.info(`vm network: ${relayLabel(relay)}${relay && relay !== 'fetch' ? ` (${relay})` : ''}`);

	const agent = await mount({
		workerUrl,
		// A turn runs in this tab, so closing it stops the turn; see leaving.ts.
		onTurnStarted: () => leaving?.started(),
		// The Linux VM as the device. Constructed here, booted on first use.
		vm: sharedVm({ networkRelay: relay }),
		// download_file works from the chat page too — compiled artifacts have
		// a way out wherever the VM is. (No terminal here, so no read_terminal.)
		download: triggerDownload,
		// run_js executes on this page's main thread; see app/hostcall.ts.
		runJs,
		// Chat attachments land in the VM's /data/share/local as well as the
		// engine's upload store, so the model's file tools — which live on the
		// VM — can open what the person just attached, and every other VM on
		// this origin (terminal panes, other tabs) sees it too.
		onUpload: (name, _mime, bytes) => {
			void shareLocalFile(sharedVm(), name, bytes)
				.then((safe) => console.info(`attachment → /data/share/local/${safe}`))
				.catch((e) => console.warn(`attachment not shared to the VM: ${e}`));
		},
		// share_local landed a file: mirror-and-announce now, not in 15 s.
		onShared: requestSnapshot,
		// One history for the page, whichever surface a session started on.
		namespace: 'vinx',
		meta: { brand: 'Vinx Agent', version: __APP_VERSION__ },
		// Empty unless a repository was published; see version.sh.
		skillsRepo: __SKILLS_REPO__,
		// The endpoint a fresh browser starts with, baked in at build time.
		// Seeds the settings panel; whatever is in it already wins.
		defaults: __DEFAULTS__,
	});

	leaving = guardRunningTurns(agent.client);

	if (agent.status.ephemeral) {
		// Worth saying out loud rather than letting someone lose a day's history:
		// a private window or a denied quota falls back to in-memory storage.
		console.warn('storage is unavailable; sessions will not survive a reload');
	}
	if (!agent.configured) {
		console.info('no model endpoint yet — set one in settings');
	}
	console.info(
		agent.tools.length
			? `device tools: ${agent.tools.join(', ')}`
			: 'no device tools; this agent can only talk',
	);

	// Not awaited: the page has everything it needs to render, and a skill the
	// model has not asked for yet is not worth a blank screen.
	installBundledSkill().catch((e) => console.warn(`could not install the bundled skill: ${e}`));

	// Pre-boot the VM in the idle window right after load. Uncontended it takes
	// a second or two; deferring it to the first run_shell would instead boot
	// while the engine worker is busy-waiting on that very call, which starves
	// the main-thread emulator and makes the first command take far longer than
	// it should. run_shell is the agent's core capability, so this is worth
	// paying eagerly. Fire-and-forget: a failure surfaces when a tool runs.
	void sharedVm().boot().catch(() => {});

	// The VM's speaker wakes on the first gesture (the autoplay policy keeps
	// its AudioContext suspended until one); every later call is a no-op.
	window.addEventListener('pointerdown', () => sharedVm().resumeAudio(), { passive: true });
	window.addEventListener('keydown', () => sharedVm().resumeAudio(), { passive: true });

	root.render(
		<StrictMode>
			<CopilotApp basePath="" toolRenderers={{ run_shell: RunShellTool, ...VM_TOOL_CARDS }} />
		</StrictMode>,
	);

	// A floating "net: …" button, mounted outside the vendored CopilotApp tree,
	// so the network can be switched from the chat page too.
	mountNetFab();
	// Bridge chat floats over this page as well: same LAN, same danmaku.
	mountDanmaku();
} catch (e) {
	fatal(e instanceof Error ? (e.stack ?? e.message) : String(e));
}
