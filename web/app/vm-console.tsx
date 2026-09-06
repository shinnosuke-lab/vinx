/**
 * The machine console: this page's own Linux, opened in place.
 *
 * Every document is one computer (see pane-id.ts): the chat page carries a
 * machine of its own, and until this panel existed that machine was headless
 * — the agent could run commands on it, but the person had no console and no
 * screen. This floating panel is that machine's desktop surface: ttyS0 as an
 * xterm, the VGA window over it, and the network control inside it. The
 * /terminal page is *other* computers; nothing here navigates there.
 *
 * The panel mounts once at page load and hides instead of unmounting, so the
 * xterm hears ttyS0 from the first kernel line (a console attached on first
 * open would have missed the whole boot) and `read_terminal` always has a
 * screen to read. Closing the panel never stops the machine.
 */

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { sharedVm, VM_EPHEMERAL_EVENT, type VmState } from './vm';
import { ByteStreamTerm } from './byte-stream-term';
import { DesktopWindow } from './desktop-window';
import { type OpenRequest } from './opener';
import { setTerminalReader } from './terminal-buffer';
import { VgaWindow } from './vga-window';
import { windowManager } from './window-manager';
import { WebWindows, useWindowTable } from './web-windows';
import { ICON_TERMINAL } from './icons';
import { t } from './i18n';

import './vm-console.css';

/** Anything on the page opens the console by firing this on window: the
 * capsule's mascot segment (net-panel.tsx), the open_terminal tool card. */
export const OPEN_VM_CONSOLE_EVENT = 'vinx:open-console';

export function openVmConsole(): void {
	window.dispatchEvent(new Event(OPEN_VM_CONSOLE_EVENT));
}

/** The capsule's screen segment: toggle the VGA window (a peer of the
 * console — it opens without the console). */
export const TOGGLE_VM_SCREEN_EVENT = 'vinx:toggle-screen';

export function toggleVmScreen(): void {
	window.dispatchEvent(new Event(TOGGLE_VM_SCREEN_EVENT));
}

/**
 * The ttyS0 side of the panel: ByteStreamTerm carries the terminal chrome
 * (fit, copy-on-select, StrictMode dance — it was extracted from here);
 * what stays is the console's own business — the UART byte pipe, `stty`
 * only once the machine is ready, the read_terminal feed and the boot
 * failure line. The terminal page's OSC handlers, boot veil and drop
 * targets stay there: this console is a viewport, not a second feature
 * surface.
 */
function ConsoleTerm({ active }: { active: boolean }) {
	return (
		<ByteStreamTerm
			active={active}
			onData={(data) => sharedVm().sendConsole(data)}
			onResize={(cols, rows) => {
				const vm = sharedVm();
				if (vm.getState() === 'ready') vm.setConsoleSize(cols, rows);
			}}
			attach={(term) => {
				const vm = sharedVm();
				// UART bytes straight to the screen.
				const fromVm = vm.onConsole((bytes) => term.write(bytes));

				// The console for the browser suite: under the WebGL
				// renderer the DOM has no text rows, so tests read the
				// buffer through this (the terminal page does the same).
				(window as { __vinxConsole?: unknown }).__vinxConsole = term;

				// What feeds the agent's read_terminal: the last N lines of
				// this buffer, scrollback included, trailing blanks trimmed.
				setTerminalReader((lines: number) => {
					const buf = term.buffer.active;
					const end = buf.length;
					const rows: string[] = [];
					for (let i = Math.max(0, end - lines); i < end; i++) {
						rows.push(buf.getLine(i)?.translateToString(true) ?? '');
					}
					while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
					return rows.join('\n');
				});

				const unwatch = vm.onState((s) => {
					// The resize path gated on 'ready'; push the size it
					// could not, now that stty will land.
					if (s === 'ready') vm.setConsoleSize(term.cols, term.rows);
					if (s === 'failed') {
						term.write(
							`\r\n\x1b[31mThe Linux VM could not start: ${vm.bootError() ?? 'unknown'}\x1b[0m\r\n`,
						);
					}
				});

				return () => {
					fromVm();
					unwatch();
					setTerminalReader(null);
					// The machine keeps running; only the page's death stops it.
				};
			}}
		/>
	);
}

function VmConsoleHost() {
	const [open, setOpen] = useState(false);
	const [screenOpen, setScreenOpen] = useState(false);
	const [screenFit, setScreenFit] = useState<{ w: number; h: number } | null>(null);
	const [state, setState] = useState<VmState>('off');
	// The chat page's window table (§10.7): the host layer is this
	// machine's desktop — the console, the VGA screen, web app and
	// terminal windows all float on it as peers (macOS-style, one system
	// behind them all). The console and the screen join the table through
	// native shims, so window.list/focus/close see every window alike.
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
	const openRef = useRef(false);
	openRef.current = open;
	useEffect(
		() =>
			windowManager().registerNative('console', {
				isOpen: () => openRef.current,
				open: () => setOpen(true),
				close: () => setOpen(false),
			}),
		[],
	);
	// The identity verdict may predate this mount (boot wrote the dataset) or
	// arrive later (the event); read one, listen for the other.
	const [ephemeral, setEphemeral] = useState(
		() => document.documentElement.dataset.vmIdentity === 'ephemeral',
	);
	// A popup-blocked open(1) parks here for its retry click — the same
	// affordance the terminal page's open chip gives. Without it the chat
	// page silently ate the guest's open and the model looked broken.
	const [pendingOpen, setPendingOpen] = useState<OpenRequest | null>(null);
	useEffect(() => sharedVm().onOpenParked(setPendingOpen), []);

	useEffect(() => {
		const show = () => setOpen(true);
		window.addEventListener(OPEN_VM_CONSOLE_EVENT, show);
		return () => window.removeEventListener(OPEN_VM_CONSOLE_EVENT, show);
	}, []);

	// The capsule's screen segment: the VGA window is a peer of the
	// console and toggles on its own.
	useEffect(() => {
		const toggle = () => setScreenOpen((v) => !v);
		window.addEventListener(TOGGLE_VM_SCREEN_EVENT, toggle);
		return () => window.removeEventListener(TOGGLE_VM_SCREEN_EVENT, toggle);
	}, []);

	useEffect(() => {
		const mark = () => setEphemeral(true);
		window.addEventListener(VM_EPHEMERAL_EVENT, mark);
		return () => window.removeEventListener(VM_EPHEMERAL_EVENT, mark);
	}, []);

	// Published for the guest, same as the terminal page: lvdemo(1) calls
	// `rpc call window.focus '{"id":"screen"}'` before painting — drawing
	// on /dev/fb0 changes no video mode, so the auto-open below never hears
	// about it; the guest says so itself. (The old window.vinxScreenShow
	// global went with Phase 3.)
	useEffect(() => {
		const unregister = sharedVm().onWindowFocus((id) => {
			if (id !== 'screen') return false;
			setScreenOpen(true);
			return true;
		});
		return unregister;
	}, []);

	// Auto-open panel and screen when the guest sets a graphical mode of its
	// own — the baseline dance is terminal.tsx's, see the comment there.
	useEffect(() => {
		const vm = sharedVm();
		let modeBaseline: string | null = null;
		let unwatchMode: (() => void) | null = null;
		const unwatch = vm.onState((s) => {
			setState(s);
			if (s !== 'ready') return;
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
		return () => {
			unwatch();
			unwatchMode?.();
		};
	}, []);

	// Opening the console is also the retry gesture: a pre-boot that failed
	// (see main.tsx) starts over here instead of showing a dead prompt.
	useEffect(() => {
		if (open) void sharedVm().boot().catch(() => {});
	}, [open]);

	return (
		// The host is this machine's desktop: a full-viewport, click-through
		// layer where the console, the VGA screen, terminal windows and web
		// app windows all float as PEERS (macOS-style — many windows, one
		// system). The host itself never hides; each window has its own
		// life. The console hides with display:none (never unmounts), so
		// its xterm keeps hearing ttyS0 from the first boot line.
		<div className="vmc-host">
			<div className={`vmc-console${open ? '' : ' vmc-hidden'}`} data-testid="vm-console">
				<DesktopWindow
					title={t('vmcTitle')}
					icon={ICON_TERMINAL}
					closeTitle={t('vmcClose')}
					onClose={() => setOpen(false)}
					storageKey="vinx.vmconsole.rect"
					footer={0}
					// Tall enough for the whole boot banner (the lynx, the
					// name, the command table — ~37 rows): at 520px the logo
					// painted and immediately scrolled out of view, which
					// read as "the boot logo is gone". Clamped to the
					// viewport on small hosts.
					initial={{ w: 760, h: 740 }}
					zIndex={wm.zOf('console')}
					onRaise={() => wm.raise('console')}
					titleExtra={
						// The machine's state and identity only: network,
						// terminal and screen live on the capsule (the
						// chat page's np-fab, net-panel.tsx).
						<>
							<span className="vmc-dot" data-state={state} />
							{ephemeral && (
								<span className="vmc-ephemeral" title={t('vmcEphemeralTitle')}>
									{t('vmcEphemeral')}
								</span>
							)}
						</>
					}
				>
					<div className="vmc-body">
						<ConsoleTerm active={open} />
					</div>
				</DesktopWindow>
			</div>
			{/* Peers of the console, not tenants: they live whether or not
			    the console shows. Unmounted when closed — a hidden box would
			    clamp the geometry; the remembered rect brings them back. */}
			{screenOpen && (
				<VgaWindow
					onClose={() => setScreenOpen(false)}
					fitTo={screenFit}
					footer={0}
					zIndex={wm.zOf('screen')}
					onRaise={() => wm.raise('screen')}
				/>
			)}
			<WebWindows footer={0} />
			{pendingOpen && (
				<button
					type="button"
					className="vmc-open-chip"
					title="The popup blocker stopped it; this click is allowed to open it"
					onClick={() => {
						pendingOpen.open();
						setPendingOpen(null);
					}}
				>
					↗ open {pendingOpen.label}
				</button>
			)}
		</div>
	);
}

/** Chat page helper: mount the console panel outside the vendored CopilotApp
 * tree, the same stance as mountNetFab/mountDanmaku. */
export function mountVmConsole(): void {
	const el = document.createElement('div');
	document.body.appendChild(el);
	createRoot(el).render(<VmConsoleHost />);
}
