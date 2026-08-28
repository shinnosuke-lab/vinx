/**
 * The machine's VGA screen and the floating window around it: what the
 * footer's screen chip toggles over the console.
 */

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from 'react';

import { sharedVm } from './vm';
import { Icon, ICON_MAX, ICON_MONITOR, ICON_RESTORE, ICON_X } from './icons';

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
			const dpr = window.devicePixelRatio || 1;
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
		const ro = new ResizeObserver(fit);
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

const MIN_W = 240;
const MIN_H = 180;
/** Title bar (26px) plus the 1px borders the window box adds around it. */
const CHROME_H = 28;
const CHROME_W = 2;

interface ScreenRect {
	x: number;
	y: number;
	w: number;
	h: number;
	max: boolean;
	/** Which guest mode ("256x224") the size was last set for — by the
	 * auto-fit or by hand. The fit effect only recomputes when the mode
	 * key changes, so reopening the same game keeps a hand-set size
	 * instead of stomping it back to the integer fit. */
	fit?: string;
}

function loadScreenRect(): ScreenRect | null {
	try {
		const r = JSON.parse(localStorage.getItem(SCREEN_RECT_KEY) ?? '') as ScreenRect;
		const sane = [r.x, r.y, r.w, r.h].every(Number.isFinite);
		if (!sane) return null;
		return { ...r, max: !!r.max, fit: typeof r.fit === 'string' ? r.fit : undefined };
	} catch {
		return null;
	}
}

/** The eight resize handles around the window, named like compass points. */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ResizeEdge = (typeof RESIZE_EDGES)[number];

/**
 * The floating window around the VGA panel: a title bar to drag it by (or
 * double-click to maximize), handles on every edge and corner to resize it,
 * and buttons to maximize or close it. Closing only hides the window — the
 * footer's screen chip brings it back, and v86 keeps painting throughout.
 * Geometry persists in localStorage, clamped back into the pane on reopen.
 *
 * `fitTo` is the auto-open handshake: when the guest mode-sets to its own
 * resolution (see terminal.tsx), the window sizes itself to the largest
 * integer multiple of that mode the pane can hold — pixel-perfect out of
 * the box, before anyone touches a handle.
 */
export function VgaWindow({
	onClose,
	fitTo,
}: {
	onClose: () => void;
	fitTo?: { w: number; h: number } | null;
}) {
	const win = useRef<HTMLDivElement>(null);
	// Position and size live outside React: dragging writes styles directly
	// (a re-render per pointermove would fight the canvas), React only hears
	// about the maximize flag because the buttons need it.
	const geom = useRef<ScreenRect>(loadScreenRect() ?? { x: -1, y: -1, w: 480, h: 386, max: false });
	const [maximized, setMaximized] = useState(geom.current.max);

	const persist = useCallback(() => {
		try {
			localStorage.setItem(SCREEN_RECT_KEY, JSON.stringify(geom.current));
		} catch {
			/* private mode: the window just forgets */
		}
	}, []);

	// Clamp the remembered rect into the pane and write it as inline styles;
	// maximized means the pane is the window.
	const apply = useCallback(() => {
		const el = win.current;
		const pane = el?.parentElement;
		if (!el || !pane) return;
		const g = geom.current;
		if (g.max) {
			el.style.left = '0';
			el.style.top = '0';
			el.style.width = '100%';
			// The footer (status dot, chips) stays visible under a maximized
			// window; 24px is its fixed height in terminal.css.
			el.style.height = 'calc(100% - 24px)';
			return;
		}
		const pw = pane.clientWidth;
		const ph = pane.clientHeight;
		g.w = Math.min(Math.max(g.w, MIN_W), Math.max(pw, MIN_W));
		g.h = Math.min(Math.max(g.h, MIN_H), Math.max(ph, MIN_H));
		if (g.x < 0 || g.y < 0) {
			// First open: bottom-right corner, clear of the footer strip.
			g.x = pw - g.w - 12;
			g.y = ph - g.h - 36;
		}
		g.x = Math.max(0, Math.min(g.x, pw - g.w));
		g.y = Math.max(0, Math.min(g.y, ph - g.h));
		el.style.left = `${g.x}px`;
		el.style.top = `${g.y}px`;
		el.style.width = `${g.w}px`;
		el.style.height = `${g.h}px`;
	}, []);

	useEffect(() => {
		apply();
	}, [apply, maximized]);

	// Size the window to the guest's mode, at the largest integer multiple
	// the pane can hold — but only when the mode is new. A remembered fit
	// key equal to the current mode means the stored size is already for
	// this mode (auto-fit or the user's own resize) and stays untouched;
	// without the key check, every reopen stomped a hand-set size. A
	// maximized window stays maximized (the panel letterboxes).
	useEffect(() => {
		if (!fitTo) return;
		const pane = win.current?.parentElement;
		const g = geom.current;
		if (!pane || g.max) return;
		const key = `${fitTo.w}x${fitTo.h}`;
		if (g.fit === key) return;
		const n = Math.max(
			1,
			Math.floor(
				Math.min(
					(pane.clientWidth - CHROME_W) / fitTo.w,
					(pane.clientHeight - 36 - CHROME_H) / fitTo.h,
				),
			),
		);
		g.w = Math.max(MIN_W, fitTo.w * n + CHROME_W);
		g.h = Math.max(MIN_H, fitTo.h * n + CHROME_H);
		g.fit = key;
		apply();
		persist();
	}, [fitTo, apply, persist]);

	useEffect(() => {
		const el = win.current;
		const pane = el?.parentElement;
		if (!el || !pane) return;
		// A shrinking pane must not strand the window outside the visible
		// area; re-clamp. (Resizing the window itself goes through the
		// handles below, which persist on release.)
		const ro = new ResizeObserver(() => apply());
		ro.observe(pane);
		return () => ro.disconnect();
	}, [apply]);

	const dragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (geom.current.max || e.button !== 0) return;
		const bar = e.currentTarget;
		const dx = e.clientX - geom.current.x;
		const dy = e.clientY - geom.current.y;
		bar.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => {
			geom.current.x = ev.clientX - dx;
			geom.current.y = ev.clientY - dy;
			apply();
		};
		const up = () => {
			bar.removeEventListener('pointermove', move);
			bar.removeEventListener('pointerup', up);
			bar.removeEventListener('pointercancel', up);
			persist();
		};
		bar.addEventListener('pointermove', move);
		bar.addEventListener('pointerup', up);
		// A cancelled gesture (touch/pen) must clean up too, or the leaked
		// move listener makes the window chase a merely hovering pointer.
		bar.addEventListener('pointercancel', up);
	};

	// One pointer-capture drag per handle: east/south move the far edge,
	// west/north move the near edge and the origin with it, corners do both.
	//
	// With a known guest mode (fitTo) the resize is really one number — the
	// content scale — so the drag is aspect-locked: the axis the pointer
	// drives sets the scale, the other dimension follows, and releasing
	// snaps to the nearest whole multiple. The panel is then exactly the
	// content's shape, so no black frame on all four sides, ever; free
	// resizing (no fitTo: the fbcon console) letterboxes one axis at most
	// (see VgaPanel's fit).
	const resizeStart = (edge: ResizeEdge) => (e: ReactPointerEvent<HTMLDivElement>) => {
		if (geom.current.max || e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget;
		const start = { ...geom.current };
		const px = e.clientX;
		const py = e.clientY;
		const lock = fitTo ? { ...fitTo } : null;
		// The smallest scale at which the window still meets both minimums.
		const minScale = lock
			? Math.max((MIN_W - CHROME_W) / lock.w, (MIN_H - CHROME_H) / lock.h)
			: 0;
		/** Aspect-locked window size for a scale, moving the near edges the
		 * way the free path does. */
		const sizeTo = (scale: number) => {
			if (!lock) return;
			const g = geom.current;
			const w = Math.round(lock.w * scale) + CHROME_W;
			const h = Math.round(lock.h * scale) + CHROME_H;
			if (edge.includes('w')) g.x = start.x + (start.w - w);
			if (edge.includes('n')) g.y = start.y + (start.h - h);
			g.w = w;
			g.h = h;
		};
		handle.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - px;
			const dy = ev.clientY - py;
			const g = geom.current;
			if (lock) {
				// Each axis the handle owns proposes a scale; the larger one
				// wins, so corner drags follow the pointer's outward axis.
				const w = edge.includes('e') ? start.w + dx : edge.includes('w') ? start.w - dx : null;
				const h = edge.includes('s') ? start.h + dy : edge.includes('n') ? start.h - dy : null;
				const scale = Math.max(
					minScale,
					w === null ? -Infinity : (w - CHROME_W) / lock.w,
					h === null ? -Infinity : (h - CHROME_H) / lock.h,
				);
				sizeTo(scale);
				apply();
				return;
			}
			if (edge.includes('e')) g.w = Math.max(MIN_W, start.w + dx);
			if (edge.includes('s')) g.h = Math.max(MIN_H, start.h + dy);
			if (edge.includes('w')) {
				const w = Math.max(MIN_W, start.w - dx);
				g.x = start.x + (start.w - w);
				g.w = w;
			}
			if (edge.includes('n')) {
				const h = Math.max(MIN_H, start.h - dy);
				g.y = start.y + (start.h - h);
				g.h = h;
			}
			apply();
		};
		const up = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handle.removeEventListener('pointercancel', up);
			const g = geom.current;
			if (lock) {
				// Snap to a whole multiple of the mode: whole-pixel scaling
				// (crisp) and a panel that fits the content exactly. Below
				// 1x there is no whole multiple; the aspect-true size stays.
				const scale = (g.w - CHROME_W) / lock.w;
				sizeTo(scale >= 1 ? Math.max(1, Math.round(scale)) : Math.max(minScale, scale));
				apply();
			}
			// A hand-set size is the law for this mode from now on: the fit
			// effect must not overwrite it on the next open (fit keys match).
			g.fit = lock ? `${lock.w}x${lock.h}` : undefined;
			persist();
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	};

	const toggleMax = () => {
		geom.current.max = !geom.current.max;
		setMaximized(geom.current.max);
		persist();
	};

	return (
		<div ref={win} className={`vga-window${maximized ? ' max' : ''}`}>
			<div
				className="vga-title"
				onPointerDown={dragStart}
				onDoubleClick={(e) => {
					if (!(e.target as HTMLElement).closest('.vga-btn')) toggleMax();
				}}
			>
				<Icon d={ICON_MONITOR} size={12} />
				<span className="vga-title-text">screen</span>
				<button
					type="button"
					className="vga-btn"
					title={maximized ? 'Restore the window' : 'Maximize over the pane'}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={toggleMax}
				>
					<Icon d={maximized ? ICON_RESTORE : ICON_MAX} size={12} />
				</button>
				<button
					type="button"
					className="vga-btn"
					title="Close the screen window (the machine keeps rendering)"
					onPointerDown={(e) => e.stopPropagation()}
					onClick={onClose}
				>
					<Icon d={ICON_X} size={12} />
				</button>
			</div>
			<VgaPanel />
			{!maximized &&
				RESIZE_EDGES.map((edge) => (
					<div
						key={edge}
						className={`vga-resize vga-resize-${edge}`}
						onPointerDown={resizeStart(edge)}
					/>
				))}
		</div>
	);
}
