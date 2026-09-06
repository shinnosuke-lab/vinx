/**
 * The machine's VGA screen and its floating window: what the footer's
 * screen chip toggles over the console. The window chrome itself is the
 * desktop's generic DesktopWindow (§15 Phase 5 unhooked it from this
 * panel); what stays here is the VGA content — the adopted v86 screen
 * element, the PS/2 keyboard/mouse forwarding, the pixel-exact fit.
 */

import {
	useEffect,
	useRef,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from 'react';

import { sharedVm } from './vm';
import { DesktopWindow } from './desktop-window';
import { ICON_MONITOR } from './icons';

/**
 * The machine's VGA screen, adopted from the VM (which keeps v86's screen
 * adapter painting into the same element whether or not it is on the page).
 * fbcon owns it at boot — a blinking cursor on black — and anything the
 * guest draws (fbdemo on /dev/fb0, nes on its own DRM mode) shows up live.
 *
 * The panel is also the machine's PS/2 keyboard, when focused: game keys
 * become scancodes on the emulated 8042 (see VinxVm.sendKey), which a guest
 * program reading /dev/input sees as real presses and releases — the input
 * a game wants, which a serial console can never carry. Focus is the
 * router: click the screen to play, click the terminal to type. Only the
 * game keys are forwarded, so browser shortcuts survive.
 */
const VGA_KEYS: Record<string, number> = {
	/* set-1 make codes; extended keys carry the 0xE0 prefix in the high byte */
	KeyW: 0x11,
	KeyA: 0x1e,
	KeyS: 0x1f,
	KeyD: 0x20,
	ArrowUp: 0xe048,
	ArrowLeft: 0xe04b,
	ArrowRight: 0xe04d,
	ArrowDown: 0xe050,
	KeyJ: 0x24,
	KeyK: 0x25,
	KeyZ: 0x2c,
	KeyX: 0x2d,
	Enter: 0x1c,
	Space: 0x39,
	KeyQ: 0x10,
	Escape: 0x01,
};

function VgaPanel() {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const vm = sharedVm();
		const el = vm.getScreen();
		const panel = host.current;
		if (el && panel) panel.appendChild(el);
		// The periodic full sweep only while someone is looking; see vm.ts.
		const stop = vm.startScreenRefresh();

		/**
		 * Fit the canvas to the panel the way emulators do. When the panel
		 * is (nearly) a whole multiple of the mode — the resting state, the
		 * window's resize snap makes sure of it — blow pixels up by whole
		 * device pixels: every game pixel an exact NxN block, sharp at any
		 * size (the devicePixelRatio math keeps it exact on Retina, where an
		 * integer of CSS pixels need not be one of device pixels). Any other
		 * shape gets exact contain with smooth filtering: the canvas fills
		 * the limiting axis completely, so a letterbox runs along one axis
		 * at most — the old unconditional floor left remainder in *both*
		 * dimensions, framing the picture in black on all four sides.
		 */
		const fit = () => {
			const canvas = el?.querySelector('canvas');
			if (!canvas || !canvas.width || !panel) return;
			// The panel's own window, not the module's, out of habit — the
			// two are one document today, but the DPI belongs to wherever
			// the panel actually renders.
			const dpr = (panel.ownerDocument.defaultView ?? window).devicePixelRatio || 1;
			const availW = panel.clientWidth * dpr;
			const availH = panel.clientHeight * dpr;
			if (!availW || !availH) return;
			const scale = Math.min(availW / canvas.width, availH / canvas.height);
			const rounded = Math.round(scale);
			const whole = rounded >= 1 && Math.abs(scale - rounded) <= 0.02 * scale;
			const device = whole ? rounded : scale;
			canvas.style.width = `${(canvas.width * device) / dpr}px`;
			canvas.style.height = `${(canvas.height * device) / dpr}px`;
			canvas.style.imageRendering = whole ? 'pixelated' : 'auto';
		};
		// The observer of the panel's own window: an observer constructed
		// in one document never fires for elements living in another, so
		// build it where the panel is.
		const View = (panel?.ownerDocument.defaultView ?? window) as typeof window;
		const ro = new View.ResizeObserver(fit);
		if (panel) ro.observe(panel);
		const unmode = vm.onScreenModeChange(fit);
		fit();

		// Orphan, not destroy: the adapter keeps the element for next time.
		return () => {
			stop();
			unmode();
			ro.disconnect();
			el?.remove();
		};
	}, []);
	const key = (down: boolean) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const code = VGA_KEYS[e.code];
		if (code === undefined) return;
		e.preventDefault();
		if (down && e.repeat) return; /* the guest kernel does its own repeat */
		sharedVm().sendKey(code, down);
	};

	// The panel is the machine's PS/2 mouse too: pointer movement over it
	// becomes relative motion in *guest* pixels (divide by the canvas's CSS
	// scale, accumulate the fractions so slow travel is not rounded away),
	// so the guest cursor tracks the hovering finger 1:1 at any zoom.
	// Buttons forward from the panel's own down/up; the context menu is
	// suppressed so the right button reaches the guest as a button.
	const frac = useRef({ x: 0, y: 0 });
	/** Pin the guest cursor under the pointer. PS/2 is relative, so travel
	 * outside the panel is invisible to the guest and every re-entry would
	 * carry a fresh offset between hand and cursor. But the guest's evdev
	 * driver clamps its position at the display edges (our LVGL patch), so
	 * an over-length sweep toward the top-left lands it at exactly 0,0 —
	 * an absolute origin — and a second burst walks it out to the pointer.
	 * Chunked to ~250 per packet (a PS/2 delta is 9 bits); the whole train
	 * drains inside one guest poll, so only the final position ever paints. */
	const anchored = useRef<{ x: number; y: number } | null>(null);
	const anchor = (e: ReactPointerEvent<HTMLDivElement>) => {
		const canvas = host.current?.querySelector('canvas');
		if (!canvas || !canvas.width) return;
		const rect = canvas.getBoundingClientRect();
		const scale = rect.width / canvas.width;
		if (!scale) return;
		const vm = sharedVm();
		const step = 250;
		for (let x = canvas.width, y = canvas.height; x > 0 || y > 0; x -= step, y -= step) {
			vm.sendMouseDelta(-Math.min(step, Math.max(x, 0)), -Math.min(step, Math.max(y, 0)));
		}
		let gx = Math.round((e.clientX - rect.x) / scale);
		let gy = Math.round((e.clientY - rect.y) / scale);
		while (gx > 0 || gy > 0) {
			const dx = Math.min(step, gx);
			const dy = Math.min(step, gy);
			vm.sendMouseDelta(dx, dy);
			gx -= dx;
			gy -= dy;
		}
		frac.current = { x: 0, y: 0 };
		// The enter that triggered this is chased by a pointermove at the
		// very same coordinates whose movementX/Y spans the off-panel jump —
		// travel the anchor already accounted for. Mark it to be dropped.
		anchored.current = { x: e.clientX, y: e.clientY };
	};
	const pointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const skip = anchored.current;
		anchored.current = null;
		if (skip && skip.x === e.clientX && skip.y === e.clientY) return;
		const canvas = host.current?.querySelector('canvas');
		if (!canvas || !canvas.width) return;
		const scale = canvas.getBoundingClientRect().width / canvas.width;
		if (!scale) return;
		const a = frac.current;
		a.x += e.movementX / scale;
		a.y += e.movementY / scale;
		const dx = Math.trunc(a.x);
		const dy = Math.trunc(a.y);
		if (!dx && !dy) return;
		a.x -= dx;
		a.y -= dy;
		sharedVm().sendMouseDelta(dx, dy);
	};
	const buttons = (e: ReactPointerEvent<HTMLDivElement>) => {
		// Capture while a button is held: a drag that wanders off the panel
		// keeps feeding motion, and the release always arrives — without it,
		// letting go outside left the guest holding a phantom button. The
		// browser releases the capture on pointerup by itself.
		if (e.buttons) e.currentTarget.setPointerCapture(e.pointerId);
		sharedVm().sendMouseButtons(!!(e.buttons & 1), !!(e.buttons & 4), !!(e.buttons & 2));
	};
	return (
		<div
			className="vga-panel"
			ref={host}
			tabIndex={0}
			title="Click to send keys to the machine (PS/2 keyboard); click the terminal to type there again"
			onKeyDown={key(true)}
			onKeyUp={key(false)}
			onPointerEnter={anchor}
			onPointerMove={pointerMove}
			onPointerDown={(e) => {
				// Re-anchor before the press: a GUI app (re)started since the
				// last enter begins its life at 0,0, and the click must land
				// where the person points, not where history says.
				anchor(e);
				buttons(e);
			}}
			onPointerUp={buttons}
			onContextMenu={(e) => e.preventDefault()}
			onWheel={(e) => sharedVm().sendMouseWheel(e.deltaY < 0)}
		/>
	);
}

/** Where the floating screen window keeps its geometry between sessions. */
const SCREEN_RECT_KEY = 'vinx.screen.rect';

/**
 * The VGA panel in a DesktopWindow: what the footer's screen chip toggles.
 * Closing only hides the window — the chip brings it back, and v86 keeps
 * painting throughout. `fitTo` is the auto-open handshake: when the guest
 * mode-sets to its own resolution (see terminal.tsx), the window sizes
 * itself to the largest integer multiple of that mode the pane can hold,
 * and resizes stay aspect-locked with a whole-multiple snap.
 */
export function VgaWindow({
	onClose,
	fitTo,
	footer = 24,
	zIndex,
	onRaise,
}: {
	onClose: () => void;
	fitTo?: { w: number; h: number } | null;
	footer?: number;
	zIndex?: number;
	onRaise?: () => void;
}) {
	return (
		<DesktopWindow
			title="screen"
			icon={ICON_MONITOR}
			closeTitle="Close the screen window (the machine keeps rendering)"
			onClose={onClose}
			storageKey={SCREEN_RECT_KEY}
			fitTo={fitTo}
			footer={footer}
			zIndex={zIndex}
			onRaise={onRaise}
		>
			<VgaPanel />
		</DesktopWindow>
	);
}
