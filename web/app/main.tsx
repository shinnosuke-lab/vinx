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
import { relayAppExits, vmAppsBridge } from './vm-apps';
import { mountVmConsole, openVmConsole, toggleVmScreen } from './vm-console';
import { rememberedPower } from './vm-status';
import { readTerminal } from './terminal-buffer';
import { triggerDownload } from './downloads';
import { APP_META } from './app-meta';
// The Linux reference this page carries; installed after mount. Shared with
// the terminal's assistant panel, which is why it is its own module.
import { installBundledSkill } from './bundled-skill';
import { seedBundledApps } from './bundled-apps';
import { guardRunningTurns, type LeaveGuard } from './leaving';
// The device's own tool, drawn as the command it carries; see the file.
import { RunShellTool } from './run-shell-tool';
import { OpenTerminalTool } from './open-terminal-tool';
import { OpenFileTool } from './open-file-tool';
import { InstallAppTool } from './install-app-tool';
import { installWebApp } from './app-install';
import { autostartWebApps } from './app-autostart';
import { attachWorkspace } from './workspace-files';
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
	const vm = sharedVm({ networkRelay: relay });

	// The machine comes back the way the person left it (machine-power.ts):
	// left 'on', it boots now, in the idle window right after load —
	// uncontended it takes a second or two, and the first run_shell then
	// finds a machine instead of starting one while the engine worker
	// busy-waits on that very call. Left 'off' it stays off until the power
	// key; never decided, it stays off and the capsule asks, once.
	// Before mount(): the engine's toolbox follows the machine's state
	// (onPower below), and a boot already underway when it subscribes puts
	// the tools in before the first render. Fire-and-forget: a failure
	// surfaces on the capsule.
	if (rememberedPower() === 'on') void vm.boot().catch(() => {});

	const agent = await mount({
		workerUrl,
		// A turn runs in this tab, so closing it stops the turn; see leaving.ts.
		onTurnStarted: () => leaving?.started(),
		// The Linux VM as the device. Constructed here; whether and when it
		// boots is the person's call (the capsule asks; vm-status.ts).
		vm,
		// Its tools follow its power: a model beside a powered-off machine
		// is not offered a shell it cannot have, and is briefed to point at
		// the power key instead. Boot and ready both count as up — a call
		// made while booting waits for the machine, as before.
		onPower: (listener) => vm.onState((s) => listener(s === 'booting' || s === 'ready')),
		// The machine console (vm-console.tsx) is this page's terminal; the
		// model can read its screen the same as on the terminal page.
		terminal: { read: readTerminal },
		// download_file works from the chat page too — compiled artifacts have
		// a way out wherever the VM is.
		download: triggerDownload,
		// install_app: a pure web app the model wrote, onto the Apps page —
		// the machine's mirror of /data/apps, and the live tree when it is up.
		// See app-install.ts; nothing of it needs the machine.
		installApp: (app) => installWebApp(vm, app),
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
		meta: APP_META,
		// Empty unless a repository was published; see version.sh.
		skillsRepo: __SKILLS_REPO__,
		// The Apps page (#/apps) manages this machine's .vapp's — see
		// vm-apps.ts: rund's app.list behind the list, the guest `app` CLI
		// behind start/stop/remove/install, and the page itself for what a
		// powered-off machine still has to offer (its mirrored packages,
		// and a pure web app's window).
		vmApps: vmAppsBridge(vm),
		// The apps repository (apps-hub); empty hides the tab. See version.sh.
		appsRepo: __APPS_REPO__,
		// The endpoint a fresh browser starts with, baked in at build time.
		// Seeds the settings panel; whatever is in it already wins.
		defaults: __DEFAULTS__,
	});

	leaving = guardRunningTurns(agent.client);
	// The open_file card reads the offered file back through the runtime.
	attachWorkspace(agent.client);

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
	// Likewise the apps the page ships with (bundled-apps.ts): once per
	// machine, and the Apps page hears about them when they land.
	seedBundledApps(vm).catch((e) => console.warn(`could not seed the bundled apps: ${e}`));
	// And about a backend that ends on its own (the §10.7 app.exited
	// event): the card is a play button again without a refresh.
	relayAppExits(vm);

	// The VM's speaker wakes on the first gesture (the autoplay policy keeps
	// its AudioContext suspended until one); every later call is a no-op.
	window.addEventListener('pointerdown', () => sharedVm().resumeAudio(), { passive: true });
	window.addEventListener('keydown', () => sharedVm().resumeAudio(), { passive: true });

	root.render(
		<StrictMode>
			<CopilotApp
				basePath=""
				toolRenderers={{
					run_shell: RunShellTool,
					// The chat page's "open terminal" opens this machine's own
					// console, not the /terminal page (a different computer).
					open_terminal: OpenTerminalTool,
					// The workspace's "show the person a file": an Open button.
					open_file: OpenFileTool,
					// And its "put an app on the Apps page": the install's line
					// and an Open button for the window.
					install_app: InstallAppTool,
					...VM_TOOL_CARDS,
				}}
			/>
		</StrictMode>,
	);

	// This machine's desktop surface: console, screen and network, in one
	// floating panel outside the vendored CopilotApp tree.
	mountVmConsole();
	// The mascot badge in the corner: this machine's console, one click.
	mountNetFab(openVmConsole, toggleVmScreen);
	// Bridge chat floats over this page as well: same LAN, same danmaku.
	mountDanmaku();
	// The desktop's boot: the pure web apps the person enabled open now,
	// from the machine's mirror — its power state has no say (§10.7).
	void autostartWebApps();
} catch (e) {
	fatal(e instanceof Error ? (e.stack ?? e.message) : String(e));
}
