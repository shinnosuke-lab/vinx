/**
 * The AI panel a terminal pane opens — everything the assistant needs, loaded
 * the first time someone asks for it.
 *
 * The terminal page boots without any of this: no React chat components, no
 * wasm engine, no worker. Clicking a pane's ✦ button imports this module
 * (`import()` in terminal.tsx makes it its own chunk), which brings up the
 * engine once for the page and renders upstream's `TerminalAgentChat` into the
 * pane. Two panes mean two panels and two conversations, but one engine.
 *
 * What makes this assistant different from the main chat is one mount flag:
 * `console: true`. It briefs the model that the console on ttyS0 shares this
 * machine — the same filesystem and processes its own `run_shell` sees on
 * ttyS1 — so a file it writes is there at the person's prompt, and theirs is
 * there for it. Upstream's v1 assistant sits beside a PTY it cannot touch;
 * this one shares the box for real, because both lines are the same VM.
 *
 * The VM is the same instance the console booted (`sharedVm()`), so opening
 * the panel does not start a second Linux.
 */

import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { TerminalAgentChat, type TerminalAgentChatHandle } from '@vinx/agent-chat';
import '@vinx/agent-chat/styles.css';
// After the library's sheet so its rules win; the tac-* copy and the terminal
// palette for it. See the file header for where it comes from.
import './terminal-assistant.css';

import { mount } from '../runtime/src/index';
import { runJs } from './hostcall';
import { sharedVm } from './vm';
import { shareLocalFile, requestSnapshot } from './share-store';
import { installBundledSkill } from './bundled-skill';
import { guardRunningTurns, type LeaveGuard } from './leaving';
import { RunShellTool } from './run-shell-tool';
import { VM_TOOL_CARDS } from './vm-tool-cards';
import { readTerminal } from './terminal-buffer';
import { triggerDownload } from './downloads';
import workerUrl from '../runtime/src/worker.ts?worker&url';

/** Every VM tool drawn as itself, exactly as on the chat page. */
const TOOL_CARDS = { run_shell: RunShellTool, ...VM_TOOL_CARDS };

/**
 * One engine per page, however many opens ask. The promise is the lock: a
 * second caller while the first is still mounting awaits the same boot.
 */
let engine: Promise<void> | null = null;

function ensureEngine(): Promise<void> {
	engine ??= (async () => {
		let leaving: LeaveGuard | null = null;
		const agent = await mount({
			workerUrl,
			// The same Linux the console booted. run_shell rides its ttyS1.
			vm: sharedVm(),
			// One namespace for the whole page, so the panel's sessions land
			// in the main page's history, marked by their origin.
			namespace: 'vinx',
			// The whole point of this panel; see the module header.
			console: true,
			// The console's screen, as the read_terminal tool: "look at this
			// error" stops meaning "paste it for me".
			terminal: { read: readTerminal },
			// download_file's way out of the VM.
			download: triggerDownload,
			// run_js executes on this page's main thread; see app/hostcall.ts.
			runJs,
			// Attachments to the panel land in /data/share/local too, exactly as
			// on the chat page — one rule wherever a file enters the agent.
			onUpload: (name, _mime, bytes) => {
				void shareLocalFile(sharedVm(), name, bytes)
					.then((safe) => console.info(`attachment → /data/share/local/${safe}`))
					.catch((e) => console.warn(`attachment not shared to the VM: ${e}`));
			},
			// share_local landed a file: mirror-and-announce now, not in 15 s.
			onShared: requestSnapshot,
			onTurnStarted: () => leaving?.started(),
			meta: { brand: 'Vinx Agent', version: __APP_VERSION__ },
			skillsRepo: __SKILLS_REPO__,
			defaults: __DEFAULTS__,
		});
		// A turn runs in this tab, so closing it stops the turn; same guard as
		// the chat page.
		leaving = guardRunningTurns(agent.client);
		if (!agent.configured) console.info('no model endpoint yet — the panel will say so');
		// Not awaited, as on the chat page: the panel can open while the
		// Linux reference installs behind it.
		installBundledSkill().catch((e) => console.warn(`could not install the bundled skill: ${e}`));
	})();
	return engine;
}

export default function TerminalAssistant({
	seedRef,
	handleRef,
	onReady,
}: {
	/**
	 * Text to open the composer with — a selection, or '' for just "open".
	 * A ref rather than a value: an "Ask AI" clicked while the engine is
	 * still booting lands in it, and what counts is what is there when the
	 * panel actually opens.
	 */
	seedRef: MutableRefObject<string>;
	/** How the pane reaches the panel later ("Ask AI" on a selection). */
	handleRef: MutableRefObject<TerminalAgentChatHandle | null>;
	/** The pane hides its own ✦ button on this; the panel's takes over. */
	onReady: () => void;
}) {
	const [ready, setReady] = useState(false);
	const opened = useRef(false);

	useEffect(() => {
		let alive = true;
		ensureEngine().then(
			() => alive && setReady(true),
			(e) => console.error('the assistant could not start:', e),
		);
		return () => {
			alive = false;
		};
	}, []);

	useEffect(() => {
		if (!ready || opened.current) return;
		// Once, not per render: openWithText appends to the composer.
		opened.current = true;
		onReady();
		handleRef.current?.openWithText(seedRef.current);
		// The refs are fixed for the panel's lifetime; this effect is "the
		// engine is up, open the panel", not a subscription.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready]);

	if (!ready) return null;
	// Upstream's terminal SPA carries `acc-root dark` on its root, and the
	// library leans on those ancestors: `.dark .hljs-*` picks the dark syntax
	// palette, portals and dark detection look for the nearest `.acc-root`.
	// Without them the panel's code blocks come out GitHub-light on Tokyo
	// Night. `display: contents` makes the div classes-only — no box, no
	// layout change — while custom properties and descendant selectors still
	// see it. The panel's own palette (terminal-assistant.css) re-declares
	// the tokens it wants different, which beats what `.dark` sets here.
	return (
		<div className="acc-root dark" style={{ display: 'contents' }}>
			<TerminalAgentChat
				ref={(h) => {
					handleRef.current = h;
				}}
				toolRenderers={TOOL_CARDS}
			/>
		</div>
	);
}
