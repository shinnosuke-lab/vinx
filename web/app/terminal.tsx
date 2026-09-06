/**
 * The terminal page — a thin shell over one or two Linux machines.
 *
 * The document at `/terminal/` renders no terminal itself: it is the shell,
 * hosting one iframe (`?pane=1`) by default and a second (`?pane=2`) when
 * asked to split. Each iframe is a complete, independent instance of this
 * same page in pane mode: its own v86 Linux, its own engine, its own AI
 * panel. Two panes are two machines — separate filesystems, one browser-side
 * LAN (v86's inbrowser hub is shared per origin), so they can ping/nc/serve
 * to each other out of the box.
 *
 * Always through an iframe, even for one pane: splitting must not restart the
 * machine you already have, and that only works when pane 1 lives in a frame
 * from the start.
 *
 * In pane mode this file is what it always was: a dumb terminal. xterm.js on
 * one side of the wire, the guest's getty on the other, bytes both ways over
 * ttyS0. The shell does its own line editing and history because it is a real
 * shell. The AI panel shares the same machine over the ttyS3 control plane.
 */

import { lazy, StrictMode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
// A type costs nothing at runtime; the components behind it stay in the lazy
// chunk below.
import type { TerminalAgentChatHandle } from '@vinx/agent-chat';

import { sharedVm, type BootProgress, type SerialProbe, type VmState } from './vm';
import { RpcCallError } from './rpc';
import { t } from './i18n';
import { consoleTerminalOptions, loadWebglRenderer } from './term-theme';
import { resolveRelay } from './vm-config';
import { NetPrompt, NetworkControl } from './net-panel';
import { isShellDocument, type PaneId } from './pane-id';
import { setTerminalReader } from './terminal-buffer';
import { type OpenRequest } from './opener';
import { setBleNote } from './ble';
import { mountDanmaku } from './danmaku';
import { autostartWebApps } from './app-autostart';
import { windowManager } from './window-manager';
import { WebWindows, useWindowTable } from './web-windows';
import { Icon, ICON_MONITOR, ICON_SPARK, ICON_SPLIT_H, ICON_SPLIT_V, ICON_TERMINAL, ICON_UPLOAD } from './icons';
import {
	BleControl,
	MountControl,
	SecureContextHint,
	SerialControl,
	VolumeControl,
} from './footer-chips';
import { VgaWindow } from './vga-window';
import { VINX_LOGO } from '../vendor/ui/src/assets/vinx-logo';
import {
	MAX_SHARE_FILE_BYTES,
	MAX_SHARE_TOTAL_BYTES,
	SHARE_QUOTA_EVENT,
	storedShareBytes,
	storeShareFile,
} from './share-store';

import '@xterm/xterm/css/xterm.css';
import './terminal.css';

/** The AI panel and the engine behind it, fetched on the first click. */
const Assistant = lazy(() => import('./terminal-assistant'));

/** What the console is doing, drawn as a colored dot in the status strip. */
export type StatusKind = 'idle' | 'busy' | 'ok' | 'err';
interface PaneStatus {
	kind: StatusKind;
	text: string;
}

const STATE_STATUS: Record<VmState, PaneStatus> = {
	off: { kind: 'busy', text: 'starting…' },
	booting: { kind: 'busy', text: 'booting Linux…' },
	ready: { kind: 'ok', text: 'connected' },
	failed: { kind: 'err', text: 'the VM failed to start' },
};

/**
 * What a dropped file gets called inside /data: flat names with the shell
 * metacharacters (spaces, quotes, `$`…) flattened but letters of any script
 * kept — 中文名.txt survives as itself. Nothing downstream needs ASCII: the
 * write is a direct 9p create_file, the snapshot loop quotes every name it
 * round-trips, and the guest speaks UTF-8. The slice counts code points so
 * a cut never splits a surrogate pair.
 */
function shareName(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? 'file';
	const clean = base.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '_');
	return [...(clean || 'file')].slice(0, 64).join('');
}

/**
 * Put text on the clipboard from any context this page runs in. The async
 * clipboard API only exists in secure contexts — on plain http from a LAN
 * address (a common way to reach a dev box) `navigator.clipboard` is
 * undefined and select-to-copy would silently do nothing. The fallback is
 * the old execCommand path: it borrows focus for a beat (an off-screen
 * textarea must hold the selection), so it hands focus back when done.
 */
async function copyText(text: string): Promise<boolean> {
	if (navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* permission or focus denied; the textarea path still works */
		}
	}
	const prev = document.activeElement as HTMLElement | null;
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.readOnly = true;
	ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	ta.remove();
	prev?.focus?.();
	return ok;
}

/**
 * The console: xterm wired to the VM's ttyS0, and nothing else.
 *
 * The terminal is a byte pipe in both directions. The only cleverness is a
 * `stty` on resize (a serial line carries no window-size signal), and even
 * that is best-effort.
 */
function Console({ onAskAI }: { onAskAI: (text: string) => void }) {
	const host = useRef<HTMLDivElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const [status, setStatus] = useState<PaneStatus>(STATE_STATUS.off);
	// The boot veil over the terminal: which stage the machine is in, and
	// whether the veil has finished fading (it unmounts then, so the fade
	// plays out instead of the element vanishing mid-transition). `stalled`
	// is the veil stepping aside when a boot takes suspiciously long — the
	// one time the console scroll it hides is exactly what the person needs
	// to see. `bootErr` and the failure card replace a dead black veil when
	// the boot gives up entirely.
	const [vmPhase, setVmPhase] = useState<VmState>('off');
	const [bootProgress, setBootProgress] = useState<BootProgress | null>(null);
	const [veilGone, setVeilGone] = useState(false);
	const [stalled, setStalled] = useState(false);
	const [bootErr, setBootErr] = useState<string | null>(null);
	const [diagCopied, setDiagCopied] = useState(false);
	// The waiting game on the veil: gameOn mounts its host div, the ref
	// holds the live instance (loaded lazily, only if someone plays).
	const [gameOn, setGameOn] = useState(false);
	const gameHost = useRef<HTMLDivElement>(null);
	const gameRef = useRef<import('./boot-game').BootGame | null>(null);
	// The read_terminal closure, also reachable from the failure card so
	// "copy diagnostics" can include the console tail.
	const readTail = useRef<((lines: number) => string) | null>(null);
	const [selected, setSelected] = useState('');
	const [dragging, setDragging] = useState(false);
	const [dropNote, setDropNote] = useState('');
	// The VGA screen panel; the machine renders whether it is shown or not.
	const [screenOpen, setScreenOpen] = useState(false);
	// This desktop document's window table (§10.7): web app windows live in
	// it entirely; the screen joins through a native shim below so
	// window.list/close/focus see it too. Subscribing here keeps the
	// screen's z-index fresh as windows raise over each other.
	const wm = useWindowTable();
	const screenOpenRef = useRef(false);
	screenOpenRef.current = screenOpen;
	useEffect(
		() =>
			windowManager().registerNative('screen', {
				isOpen: () => screenOpenRef.current,
				open: () => setScreenOpen(true),
				close: () => setScreenOpen(false),
			}),
		[],
	);
	// Published for the guest: lvdemo(1) calls `rpc call window.focus
	// '{"id":"screen"}'` before painting — drawing on /dev/fb0 changes no
	// video mode, so the auto-open below never hears about it; the guest
	// says so itself. The window.focus registration lives in the boot
	// effect below — a bare sharedVm() here would run first (effects fire
	// in declaration order) and create the VM with default options,
	// discarding `?relay=` (the trap existingVm()'s doc names). The old
	// window.vinxScreenShow global went with Phase 3, its callers all on
	// rpc call window.focus since Phase 2.
	// The guest's own graphical mode while it differs from the boot console's
	// (nes's 256x224); the screen window auto-sizes to an integer multiple.
	const [screenFit, setScreenFit] = useState<{ w: number; h: number } | null>(null);
	// open(1) in the guest, blocked by the popup blocker: the chip that turns
	// the retry into a user gesture the blocker respects.
	const [pendingOpen, setPendingOpen] = useState<OpenRequest | null>(null);
	const dropNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const note = useCallback((text: string) => {
		setDropNote(text);
		if (dropNoteTimer.current) clearTimeout(dropNoteTimer.current);
		dropNoteTimer.current = setTimeout(() => setDropNote(''), 4000);
	}, []);

	// Files dropped on the console (or picked with the footer button) land in
	// the guest's /data and in the IndexedDB mirror, so they survive reloads.
	// The quota preflight works off the mirror — it lags the live directory by
	// one snapshot at most, which is fine for a guardrail.
	const sendFiles = useCallback(
		async (files: File[]) => {
			if (!files.length) return;
			const vm = sharedVm();
			let used = await storedShareBytes().catch(() => 0);
			for (const f of files) {
				if (f.size > MAX_SHARE_FILE_BYTES) {
					note(`${f.name}: over ${MAX_SHARE_FILE_BYTES / (1024 * 1024)} MB, not sent`);
					continue;
				}
				if (used + f.size > MAX_SHARE_TOTAL_BYTES) {
					note(
						`${f.name}: /data would exceed ${MAX_SHARE_TOTAL_BYTES / (1024 * 1024)} MB, not sent`,
					);
					continue;
				}
				const name = shareName(f.name);
				try {
					const bytes = new Uint8Array(await f.arrayBuffer());
					await vm.putFile(name, bytes);
					// Only the owner tab writes the machine's mirror; on an
					// ephemeral machine the file still lands in the guest and
					// lives as long as the tab does.
					if (await vm.isOwner()) await storeShareFile(name, bytes);
					used += bytes.byteLength;
					note(`${f.name} → /data/${name}`);
				} catch (err) {
					note(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		},
		[note],
	);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragging(false);
			void sendFiles([...(e.dataTransfer?.files ?? [])]);
		},
		[sendFiles],
	);

	// The snapshot loop pauses itself past the quota; surface that here rather
	// than letting persistence silently stop.
	useEffect(() => {
		const over = () =>
			note(
				`/data is over ${MAX_SHARE_TOTAL_BYTES / (1024 * 1024)} MB — persistence paused, delete something`,
			);
		window.addEventListener(SHARE_QUOTA_EVENT, over);
		return () => window.removeEventListener(SHARE_QUOTA_EVENT, over);
	}, [note]);

	useEffect(() => {
		// The VM's network, from `?relay=` / localStorage; see vm-config.ts.
		const vm = sharedVm({ networkRelay: resolveRelay() });
		// The guest's window.focus (§10.7): the VGA panel answers to 'screen'.
		const unregisterFocus = vm.onWindowFocus((id) => {
			if (id !== 'screen') return false;
			setScreenOpen(true);
			return true;
		});
		// Palette, font and input conventions shared with the chat page's
		// machine console; see term-theme.ts.
		const term = new Terminal(consoleTerminalOptions());
		const fit = new FitAddon();
		term.loadAddon(fit);
		// Emoji and the newer Unicode blocks measured right; the built-in
		// table stops at Unicode 6 (CJK is fine there, emoji is not).
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = '11';
		// URLs in output become links (click opens a tab), and guest programs
		// can put text on the clipboard with OSC 52.
		term.loadAddon(new WebLinksAddon());
		term.loadAddon(new ClipboardAddon());
		// chrome:// URLs too (ble(1) prints the scan flag's address), but a
		// page cannot navigate to a privileged scheme, gesture or not — the
		// click copies instead, and a toast says where to paste.
		term.registerLinkProvider({
			provideLinks(y, callback) {
				// Match on the logical line — soft-wrapped rows joined back
				// together — or a URL broken across a wrap would never match.
				// Untrimmed rows are exactly `cols` cells wide, so a string
				// offset maps to (row, col) by plain division; honest for the
				// ASCII lines ble(1) prints (wide CJK cells earlier in the
				// line would shift it — the corner WebLinksAddon spends real
				// code on, not worth it for one scheme).
				const buf = term.buffer.active;
				let first = y;
				while (first > 1 && buf.getLine(first - 1)?.isWrapped) first--;
				let text = '';
				for (let row = first; ; row++) {
					const line = buf.getLine(row - 1);
					if (!line || (row > first && !line.isWrapped)) break;
					text += line.translateToString(false);
				}
				if (!text.includes('chrome://')) return callback(undefined);
				const cols = term.cols;
				const links = [];
				for (const m of text.matchAll(/chrome:\/\/[\w/#-]+/g)) {
					const last = m.index + m[0].length - 1;
					const startRow = first + Math.floor(m.index / cols);
					const endRow = first + Math.floor(last / cols);
					// xterm asks row by row; answer only for rows the match
					// actually crosses.
					if (y < startRow || y > endRow) continue;
					links.push({
						text: m[0],
						range: {
							start: { x: (m.index % cols) + 1, y: startRow },
							end: { x: (last % cols) + 1, y: endRow },
						},
						activate: (_e: Event, url: string) => {
							void copyText(url).then((ok) =>
								note(
									ok
										? 'copied — open a new tab and paste it into the address bar'
										: `copy failed — the address is ${url}`,
								),
							);
						},
					});
				}
				callback(links.length ? links : undefined);
			},
		});
		// imgcat(1) in the guest: iTerm2's inline-image protocol (and sixel),
		// drawn on the addon's own canvas layer over the DOM renderer. The
		// instance is visible to the browser suite (storageUsage says whether
		// an image actually decoded), the same stance as data-vm-state.
		const images = new ImageAddon();
		term.loadAddon(images);
		(window as { vinxImages?: ImageAddon }).vinxImages = images;

		// The console itself, visible to the browser suite: with the WebGL
		// renderer the DOM carries no text rows, so the tests read the
		// screen through the buffer API instead of .xterm-rows.
		(window as { __vinxConsole?: Terminal }).__vinxConsole = term;

		// The audio probe, visible to the test suites (the same stance as
		// vinxImages and data-audio-state): does sound actually flow?
		(window as { vinxAudioRms?: (ms?: number) => Promise<unknown> }).vinxAudioRms = (ms?: number) =>
			vm.audioRms(ms);

		// The serial probe, same stance again: raw UART instruments for the
		// Phase 0 protocol measurements (app/test/serial-bench.mjs) and the
		// failure-case suite. Nothing on the page calls it.
		(window as { vinxSerialProbe?: SerialProbe }).vinxSerialProbe = vm.serialProbe();

		// The control link, for the E2E suite: plain-data answers that cross
		// frame.evaluate cleanly (an RpcCallError would serialise to {}).
		(window as { vinxRpc?: unknown }).vinxRpc = {
			call: (method: string, params?: Record<string, unknown>, deadlineMs?: number) =>
				vm.rpcCall(method, params, { deadlineMs }).then(
					(result) => ({ ok: true, result }),
					(e: unknown) => ({
						ok: false,
						error:
							e instanceof RpcCallError
								? { code: e.code, name: e.name, message: e.message, hint: e.hint }
								: { name: 'Error', message: String(e) },
					}),
				),
			// The runShell adapter itself (scriptRef staging, output-ref
			// folding) — what the engine's run_shell rides; the suite pins
			// its truncation marker here. A rejection comes back plain-data.
			run: (command: string, timeoutS?: number) =>
				vm.runShell(command, timeoutS).then(
					(r) => r,
					(e: unknown) => ({ exit_code: -1, output: e instanceof Error ? e.message : String(e) }),
				),
			state: () => vm.rpcLink?.state,
			stats: () => vm.rpcLink?.stats(),
			peer: () => vm.rpcLink?.peerHello,
			reattach: () => vm.rpcLink?.attach(),
			// The ttyS1 stream lane's ledger (§6.9), for the E2E suite: is
			// the mux actually moving bytes, dropping any, seeing noise?
			mux: () => ({ ...(vm.streamMux?.stats ?? {}) }),
		};

		// The guest's browser capabilities — notify(1), say(1), camera(1),
		// open(1), download(1), ble(1), bridge(1) — arrive as control-plane
		// methods now (§15 Phase 3; hostcall.ts serves them, vm.ts wires the
		// desktop surfaces). What this page still registers is its own UI:
		// the corner toast for notify's fallback and the ble chip's hints,
		// and the open chip a popup-blocked open parks on. imgcat's OSC 1337
		// (inline=1) stays with the image addon — it is terminal rendering,
		// not a capability.
		const unregisterNote = vm.onDesktopNote((text) => note(`notify: ${text}`));
		setBleNote(note);
		const unregisterParker = vm.onOpenParked(setPendingOpen);

		// Typed bytes straight to the UART; the shell echoes them back, so the
		// terminal deliberately does not echo locally.
		const typed = term.onData((data) => vm.sendConsole(data));
		// UART bytes straight to the screen.
		const fromVm = vm.onConsole((bytes) => term.write(bytes));

		let lastCols = 0;
		let lastRows = 0;
		const pushSize = () => {
			if (term.cols === lastCols && term.rows === lastRows) return;
			lastCols = term.cols;
			lastRows = term.rows;
			vm.setConsoleSize(term.cols, term.rows);
		};
		const resize = new ResizeObserver(() => {
			// A pane sized to zero (a hidden tab) makes fit() divide by it.
			if (host.current?.clientWidth) {
				fit.fit();
				if (vm.getState() === 'ready') pushSize();
			}
		});

		// Touching the DOM waits one frame. Not for the DOM's sake — for
		// StrictMode's: in dev React mounts, unmounts and remounts every
		// component, and its throwaway first pass lives for less than a frame.
		// A terminal that opened in that pass is disposed with a render
		// callback still queued, which then dereferences the torn-down
		// renderer ("Cannot read properties of undefined (reading
		// 'dimensions')"). Deferring open() to the next frame means the
		// doomed instance never opens at all: the cleanup below cancels this
		// before it runs. The surviving mount opens one frame later, which no
		// one can see.
		const raf = requestAnimationFrame(() => {
			term.open(host.current!);
			// Crisp text; falls back to the DOM renderer without WebGL.
			loadWebglRenderer(term);
			fit.fit();
			term.focus();
			resize.observe(host.current!);
		});

		// What feeds the footer's "Ask AI": xterm clears the selection on the
		// next click, which is also what hides the button again.
		const sel = term.onSelectionChange(() => {
			setSelected(term.getSelection());
		});
		// Selecting is copying, like iTerm2 — written when the gesture ends,
		// not on every change mid-drag: copyText's execCommand fallback (the
		// insecure-context path) borrows focus, which would cancel a drag
		// still in progress. Failures stay silent; the browser being careful
		// is not worth reporting.
		const copySelection = () => {
			const text = term.getSelection();
			if (text) void copyText(text);
		};
		const hostEl = host.current!;
		hostEl.addEventListener('mouseup', copySelection);
		hostEl.addEventListener('touchend', copySelection);

		// What feeds the assistant's read_terminal: the last N lines of this
		// buffer, scrollback included, trailing blanks trimmed. The failure
		// card borrows the same closure for its diagnostics.
		const readBuffer = (lines: number) => {
			const buf = term.buffer.active;
			const end = buf.length;
			const rows: string[] = [];
			for (let i = Math.max(0, end - lines); i < end; i++) {
				rows.push(buf.getLine(i)?.translateToString(true) ?? '');
			}
			while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
			return rows.join('\n');
		};
		setTerminalReader(readBuffer);
		readTail.current = readBuffer;

		// Auto-open the screen window when the guest sets a graphical mode of
		// its own. The baseline is whatever mode boot left behind (fbcon's
		// 1024x768) — nes switching to its native 256x224 is a departure from
		// it and pops the window, sized to that mode (see VgaWindow's fitTo);
		// quitting restores the baseline, which never pops. Armed at ready so
		// the boot-time fbcon modeset can't fire it.
		let modeBaseline: string | null = null;
		let unwatchMode: (() => void) | null = null;
		const unwatchProgress = vm.onBootProgress(setBootProgress);
		const unwatch = vm.onState((s) => {
			setStatus(STATE_STATUS[s]);
			setVmPhase(s);
			setBootErr(s === 'failed' ? vm.bootError() : null);
			if (s !== 'ready') return;
			pushSize();
			unwatchMode ??= vm.onScreenModeChange((w, h) => {
				const mode = `${w}x${h}`;
				if (modeBaseline === null) {
					modeBaseline = mode;
				} else if (mode === modeBaseline) {
					setScreenFit(null);
				} else {
					setScreenFit({ w, h });
					setScreenOpen(true);
				}
			});
		});

		// The speaker's AudioContext starts suspended (the autoplay policy;
		// boot is no gesture) — any click or keystroke un-mutes the machine.
		// Kept subscribed rather than once: resume is a no-op when running,
		// and a re-created emulator needs the next gesture to work too.
		const resumeAudio = () => vm.resumeAudio();
		window.addEventListener('pointerdown', resumeAudio, { passive: true });
		window.addEventListener('keydown', resumeAudio, { passive: true });

		// The boot writes to ttyS0 as the kernel comes up, so the screen fills
		// on its own; a failure is reported on the status strip and on screen.
		vm.boot().catch((e) => {
			term.write(`\r\n\x1b[31mThe Linux VM could not start: ${e?.message ?? e}\x1b[0m\r\n`);
		});

		return () => {
			cancelAnimationFrame(raf);
			typed.dispose();
			fromVm();
			sel.dispose();
			hostEl.removeEventListener('mouseup', copySelection);
			hostEl.removeEventListener('touchend', copySelection);
			unwatch();
			unwatchProgress();
			unwatchMode?.();
			unregisterFocus();
			unregisterNote();
			unregisterParker();
			setBleNote(() => {});
			resize.disconnect();
			window.removeEventListener('pointerdown', resumeAudio);
			window.removeEventListener('keydown', resumeAudio);
			setTerminalReader(null);
			readTail.current = null;
			// The image addon before the terminal, defensively: inside
			// term.dispose()'s addon sweep (renderer already gone) its
			// teardown dereferences torn-down internals and would throw
			// through the React unmount (see ByteStreamTerm's cleanup).
			try {
				images.dispose();
			} catch {
				/* already half-gone */
			}
			try {
				term.dispose();
			} catch {
				/* a disposed-addon straggler */
			}
			// The VM keeps running: the AI panel shares it, and a reload is what
			// tears it down.
		};
	}, []);

	// The veil covers the terminal until the machine is usable, then fades;
	// it stays mounted through the fade so the transition can play. A boot
	// stuck past 30 s in the kernel phase (normally seconds; downloads are
	// excluded, they may honestly take minutes on slow links) drops the
	// veil early: whatever the kernel is printing is the diagnosis, and this
	// exact veil once hid an initramfs unpack failure for three minutes.
	const booting = vmPhase === 'off' || vmPhase === 'booting';
	const veilUp = booting && !stalled;
	useEffect(() => {
		if (!booting) setStalled(false);
	}, [booting]);
	useEffect(() => {
		if (!booting || bootProgress?.phase !== 'kernel') return;
		const timer = setTimeout(() => setStalled(true), 30_000);
		return () => clearTimeout(timer);
	}, [booting, bootProgress?.phase]);
	useEffect(() => {
		if (veilUp) {
			setVeilGone(false);
			return;
		}
		const timer = setTimeout(() => setVeilGone(true), 600);
		return () => clearTimeout(timer);
	}, [veilUp]);
	useEffect(() => {
		if (vmPhase !== 'failed') setDiagCopied(false);
	}, [vmPhase]);
	// The waiting game: armed while the veil is up, born on the first space
	// (or a click on the hint), dynamically imported so it never rides the
	// main bundle. It plays through the veil's fade — the final score's one
	// moment on stage — and dies when the veil unmounts.
	useEffect(() => {
		if (!veilUp || gameOn) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.code !== 'Space' && e.code !== 'ArrowUp') return;
			const el = e.target as HTMLElement | null;
			// Someone typing a prompt in the AI panel keeps their spaces;
			// xterm's hidden textarea is exempt, the veiled terminal eats
			// no input anyway.
			const typing =
				el &&
				!el.classList?.contains('xterm-helper-textarea') &&
				(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
			if (typing) return;
			e.preventDefault();
			setGameOn(true);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [veilUp, gameOn]);
	useEffect(() => {
		if (!gameOn) return;
		let dead = false;
		void import('./boot-game').then((m) => {
			if (dead || gameRef.current || !gameHost.current) return;
			gameRef.current = m.startBootGame(gameHost.current);
		});
		return () => {
			dead = true;
		};
	}, [gameOn]);
	useEffect(() => {
		if (!veilGone) return;
		gameRef.current?.dispose();
		gameRef.current = null;
		setGameOn(false);
	}, [veilGone]);
	useEffect(
		() => () => {
			gameRef.current?.dispose();
			gameRef.current = null;
		},
		[],
	);
	// One number for the whole boot (vm.ts keeps it monotonic); the stage
	// line says which leg that number is in.
	const bootPercent = bootProgress ? `${Math.round(bootProgress.fraction * 100)}%` : '';
	const bootStage =
		(bootProgress?.phase === 'kernel' ? t('bootKernel') : t('bootDownload')) +
		(bootPercent ? ` ${bootPercent}` : '');

	// Everything a bug report needs, one click: versions, mode, phase, the
	// recorded reason and the console's last words.
	const copyDiagnostics = useCallback(async () => {
		const report = [
			`vinx ${__APP_VERSION__}`,
			`network: ${resolveRelay() || '(none)'}`,
			`boot phase: ${bootProgress?.phase ?? '(none)'}`,
			`error: ${bootErr ?? '(none)'}`,
			`userAgent: ${navigator.userAgent}`,
			'--- console tail ---',
			readTail.current?.(40) ?? '(no terminal)',
		].join('\n');
		if (await copyText(report)) setDiagCopied(true);
	}, [bootProgress?.phase, bootErr]);

	return (
		<section
			className="pane"
			onDragOver={(e) => {
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			{screenOpen && (
				<VgaWindow
					onClose={() => setScreenOpen(false)}
					fitTo={screenFit}
					zIndex={wm.zOf('screen')}
					onRaise={() => wm.raise('screen')}
				/>
			)}
			<WebWindows />
			<div className="screen" ref={host} />
			{!veilGone && (
				<div className={`boot-veil${veilUp ? '' : ' boot-veil-done'}`}>
					<img className="boot-logo" src={VINX_LOGO} alt="" />
					<div className="boot-stage">{bootStage}</div>
					<div className="boot-bar">
						<div
							className={`boot-bar-fill${bootProgress ? '' : ' boot-bar-scan'}`}
							style={
								bootProgress
									? { width: `${Math.round(bootProgress.fraction * 100)}%` }
									: undefined
							}
						/>
					</div>
					{gameOn ? (
						<div className="boot-game" ref={gameHost} />
					) : (
						<button type="button" className="boot-hint" onClick={() => setGameOn(true)}>
							{t('bootPlayHint')}
						</button>
					)}
				</div>
			)}
			{stalled && booting && <div className="boot-slow-note">{t('bootSlow')}</div>}
			{vmPhase === 'failed' && (
				<div className="boot-fail">
					<div className="boot-fail-title">{t('bootFailedTitle')}</div>
					{bootErr && <div className="boot-fail-reason">{bootErr}</div>}
					<div className="boot-fail-actions">
						<button type="button" onClick={() => void copyDiagnostics()}>
							{diagCopied ? t('bootCopied') : t('bootCopyDiag')}
						</button>
						<button
							type="button"
							onClick={() => {
								// boot() dropped its cached promise on failure, so
								// this is a genuine second attempt.
								sharedVm()
									.boot()
									.catch(() => {});
							}}
						>
							{t('bootRetry')}
						</button>
					</div>
				</div>
			)}
			{dragging && <div className="drop-cover">drop to copy into /data</div>}
			{dropNote && <div className="drop-note">{dropNote}</div>}
			{pendingOpen && (
				<button
					type="button"
					className="open-chip"
					title="The popup blocker stopped it; this click is allowed to open it"
					onClick={() => {
						pendingOpen.open();
						setPendingOpen(null);
					}}
				>
					↗ open {pendingOpen.label}
				</button>
			)}
			<footer title={status.text}>
				<span className={`st ${status.kind}`} />
				<span className="status-text">{status.text}</span>
				<NetworkControl variant="inline" />
				<VolumeControl />
				<SerialControl />
				<BleControl />
				<MountControl note={note} />
				<SecureContextHint />
				<button
					type="button"
					className={`screen-chip${screenOpen ? ' on' : ''}`}
					title={screenOpen ? 'Hide the VGA screen' : "Show the machine's VGA screen (/dev/fb0)"}
					onClick={() => setScreenOpen((o) => !o)}
				>
					<Icon d={ICON_MONITOR} size={12} />
					screen
				</button>
				<button
					type="button"
					className="screen-chip"
					title="Open a shell in a new terminal window (proc.pty)"
					onClick={() => {
						void sharedVm()
							.openShellWindow()
							.catch((e) => note(`terminal: ${e instanceof Error ? e.message : String(e)}`));
					}}
				>
					<Icon d={ICON_TERMINAL} size={12} />
					terminal
				</button>
				<button
					type="button"
					className="upload-btn"
					title="Send a file to /data"
					onClick={() => picker.current?.click()}
				>
					<Icon d={ICON_UPLOAD} size={12} />
					file
				</button>
				<input
					ref={picker}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						void sendFiles([...(e.target.files ?? [])]);
						e.target.value = '';
					}}
				/>
				<span className="spacer" />
				{selected.trim() !== '' && (
					<button type="button" className="ask-ai" onClick={() => onAskAI(selected)}>
						<Icon d={ICON_SPARK} size={12} />
						Ask AI
					</button>
				)}
			</footer>
		</section>
	);
}

/** One pane: the console plus its lazily-loaded AI panel. */
function PaneApp() {
	// The AI assistant. Nothing exists until the first ask: `idle` is a plain
	// button, `loading` is the chunk and the engine on their way, and at
	// `ready` the panel is on screen and owns its own button. Whatever was
	// selected or asked in the meantime rides in seedRef.
	const [phase, setPhase] = useState<'idle' | 'loading' | 'ready'>('idle');
	const seedRef = useRef('');
	const handleRef = useRef<TerminalAgentChatHandle | null>(null);

	const askAI = useCallback((text: string) => {
		if (handleRef.current) handleRef.current.openWithText(text);
		else {
			seedRef.current = text;
			setPhase((p) => (p === 'idle' ? 'loading' : p));
		}
	}, []);

	return (
		<div className="console bare">
			<main>
				<Console onAskAI={askAI} />
				{/* The stand-in ✦ until the assistant chunk is up; the panel
				    then renders its own in the same corner and this one
				    leaves. Floated over the console, not in the header. */}
				{phase !== 'ready' && (
					<button
						type="button"
						className={`ai-fab${phase === 'loading' ? ' waking' : ''}`}
						title="AI assistant"
						aria-label="AI assistant"
						onClick={() => askAI('')}
					>
						<img className="ai-fab-logo" src={VINX_LOGO} alt="" />
					</button>
				)}
				{phase !== 'idle' && (
					<Suspense fallback={null}>
						<Assistant seedRef={seedRef} handleRef={handleRef} onReady={() => setPhase('ready')} />
					</Suspense>
				)}
			</main>
		</div>
	);
}

// ── The shell: layout, split buttons, and one or two machine frames ──

interface ShellLayout {
	dir: 'row' | 'col';
	open: PaneId[];
	ratio: number;
}

const LAYOUT_KEY = 'vinx.terminal.layout';

const clampRatio = (r: number) => Math.min(0.8, Math.max(0.2, r));

function loadLayout(): ShellLayout {
	try {
		const raw = sessionStorage.getItem(LAYOUT_KEY);
		if (raw) {
			const p = JSON.parse(raw) as Partial<ShellLayout>;
			const open = [...new Set((p.open ?? []).filter((x): x is PaneId => x === '1' || x === '2'))];
			if ((p.dir === 'row' || p.dir === 'col') && open.length >= 1) {
				return {
					dir: p.dir,
					open: open.slice(0, 2),
					ratio: clampRatio(Number(p.ratio) || 0.5),
				};
			}
		}
	} catch {
		/* fresh layout below */
	}
	return { dir: 'row', open: ['1'], ratio: 0.5 };
}

/** The iframe URL for a pane, keeping the shell's own query (`?relay=`…). */
function paneSrc(id: PaneId): string {
	const params = new URLSearchParams(location.search);
	params.set('pane', id);
	return `./?${params.toString()}`;
}

function ShellApp() {
	const [layout, setLayout] = useState<ShellLayout>(loadLayout);
	const [dragging, setDragging] = useState(false);
	const framesRef = useRef<HTMLDivElement>(null);
	const frameEls = useRef(new Map<PaneId, HTMLIFrameElement | null>());

	useEffect(() => {
		try {
			sessionStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
		} catch {
			/* private windows still get the session's layout */
		}
	}, [layout]);

	// A pane that changes the network mode asks the shell to restart every
	// machine: the mode is page-wide (localStorage) and two machines running
	// different networks would be a lie the UI tells.
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.origin !== location.origin) return;
			if ((e.data as { vinx?: string } | null)?.vinx !== 'relay-changed') return;
			for (const el of frameEls.current.values()) el?.contentWindow?.location.reload();
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	// Dragging the divider: window-level listeners, and the frames stop
	// eating pointer events while it lasts (see .dragging in the stylesheet).
	useEffect(() => {
		if (!dragging) return;
		const onMove = (e: MouseEvent) => {
			const rect = framesRef.current?.getBoundingClientRect();
			if (!rect) return;
			const frac =
				layout.dir === 'row'
					? (e.clientX - rect.left) / rect.width
					: (e.clientY - rect.top) / rect.height;
			setLayout((l) => ({ ...l, ratio: clampRatio(frac) }));
		};
		const onUp = () => setDragging(false);
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
		return () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
	}, [dragging, layout.dir]);

	const split = (dir: 'row' | 'col') => {
		setLayout((l) => {
			if (l.open.length >= 2) return { ...l, dir };
			const other: PaneId = l.open[0] === '1' ? '2' : '1';
			return { dir, open: [...l.open, other].sort() as PaneId[], ratio: 0.5 };
		});
	};

	const close = (id: PaneId) => {
		frameEls.current.set(id, null);
		setLayout((l) => ({ ...l, open: l.open.filter((p) => p !== id) }));
	};

	const two = layout.open.length === 2;

	return (
		<div className="console shell">
			<header>
				<div className="brand">
					{/* The traffic lights are iTerm2's window signature;
					    decoration only, the page has no window to close. */}
					<span className="lights" aria-hidden="true">
						<i className="r" />
						<i className="y" />
						<i className="g" />
					</span>
					Vinx Linux
					{two && <span className="shell-note">two machines · one LAN</span>}
				</div>
				<div className="actions">
					{!two && (
						<>
							<button
								type="button"
								title="Split right (a second Linux)"
								onClick={() => split('row')}
							>
								<Icon d={ICON_SPLIT_H} />
							</button>
							<button
								type="button"
								title="Split down (a second Linux)"
								onClick={() => split('col')}
							>
								<Icon d={ICON_SPLIT_V} />
							</button>
						</>
					)}
					{two && (
						<button
							type="button"
							title="Swap split direction"
							onClick={() =>
								setLayout((l) => ({
									...l,
									dir: l.dir === 'row' ? 'col' : 'row',
								}))
							}
						>
							<Icon d={layout.dir === 'row' ? ICON_SPLIT_V : ICON_SPLIT_H} />
						</button>
					)}
				</div>
			</header>

			<div ref={framesRef} className={`shell-frames ${layout.dir}${dragging ? ' dragging' : ''}`}>
				{layout.open.map((id, i) => (
					<div
						key={id}
						className="shell-frame"
						style={{
							flexBasis: `${(i === 0 ? layout.ratio : 1 - layout.ratio) * 100}%`,
						}}
					>
						<iframe
							ref={(el) => {
								frameEls.current.set(id, el);
							}}
							name={`pane-${id}`}
							title={`Linux ${id}`}
							src={paneSrc(id)}
							// Every permissions-policy-gated capability the pane
							// document uses, spelled out. Most default to 'self'
							// and same-origin frames inherit them — but Chrome's
							// Local Network Access does not (an intranet relay
							// WebSocket silently hangs in a frame without the
							// explicit grant), so none of these ride on
							// inheritance anymore:
							//   local-network-access  ws:// to an intranet relay
							//   clipboard-*           copy-on-select, paste
							//   serial                the footer's serial chip
							//   bluetooth             ble(1)
							//   camera                camera(1) getUserMedia
							//   autoplay              v86's SB16 AudioContext
							allow="local-network-access; clipboard-read; clipboard-write; serial; bluetooth; camera; autoplay"
						/>
						{two && (
							<button
								type="button"
								className="frame-close"
								title={`Close Linux ${id} (the machine is discarded)`}
								onClick={() => close(id)}
							>
								✕
							</button>
						)}
						{two && <span className="frame-tag">Linux {id}</span>}
					</div>
				))}
				{two && (
					<div
						className={`shell-divider ${layout.dir}`}
						style={
							layout.dir === 'row'
								? { left: `${layout.ratio * 100}%` }
								: { top: `${layout.ratio * 100}%` }
						}
						onMouseDown={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
					/>
				)}
			</div>

			{/* Once per browser: the LAN-only default deserves one offer of the
			    zero-setup way online, before a failed curl teaches it. */}
			<NetPrompt />
		</div>
	);
}

// Chat floats over the shell document, which spans the whole window; the
// pane iframes stay clean or every line would show once per pane.
if (isShellDocument()) mountDanmaku();
// Each pane is a machine's desktop, and a page load is its boot: the pure
// web apps enabled on that machine open in the pane now, from its mirror.
else void autostartWebApps();

createRoot(document.getElementById('root')!).render(
	<StrictMode>{isShellDocument() ? <ShellApp /> : <PaneApp />}</StrictMode>,
);
