/**
 * The desktop's floating window chrome, content-agnostic (§15 Phase 5
 * unhooked it from the VGA panel it grew around): a title bar to drag by
 * (double-click maximizes), handles on every edge and corner to resize,
 * maximize/close buttons, geometry persisted per window. The VGA screen is
 * one tenant (vga-window.tsx); web app frames are the other.
 *
 * The CSS classes keep their historical `vga-` names on purpose: the
 * stylesheet and the E2E suite pin them (`.vga-window`, `.vga-title`,
 * `.vga-btn`, `.vga-resize-*`), and a window's chrome is the same chrome
 * whatever it frames.
 *
 * Position and size live outside React: dragging writes styles directly (a
 * re-render per pointermove would fight a canvas), React only hears about
 * the maximize flag. `fitTo` keeps the VGA behaviour available to tenants
 * that are a scaled fixed-mode picture: aspect-locked resize, snap to whole
 * multiples, auto-fit on a new mode. Tenants without it resize freely.
 */

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from 'react';

import { Icon, ICON_DROPLET, ICON_MAX, ICON_RESTORE, ICON_X } from './icons';

import './vga-window.css';

/** The opacity stops the title-bar droplet cycles through: solid first,
 * then three glass depths. Whole-window opacity (the WebGL text renderer
 * cannot paint on a transparent background, so the window fades as one
 * piece — iTerm2's background-only glass is not on the table here). */
const ALPHA_STOPS = [1, 0.9, 0.75, 0.6];

const MIN_W = 240;
const MIN_H = 180;
/** Title bar (26px) plus the 1px borders the window box adds around it.
 * The E2E suite's whole-multiple assertions bake these two numbers in. */
export const CHROME_H = 28;
export const CHROME_W = 2;

export interface WindowRect {
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
	/** Background opacity (one of ALPHA_STOPS); absent means solid. */
	alpha?: number;
}

/** What window.move/window.resize reach through (window-manager keeps the
 * id → handle table; the guest never holds a DOM node). */
export interface WindowHandle {
	setRect(r: Partial<Pick<WindowRect, 'x' | 'y' | 'w' | 'h'>>): void;
	getRect(): WindowRect;
}

function loadRect(key: string | undefined): WindowRect | null {
	if (!key) return null;
	try {
		const r = JSON.parse(localStorage.getItem(key) ?? '') as WindowRect;
		const sane = [r.x, r.y, r.w, r.h].every(Number.isFinite);
		if (!sane) return null;
		return {
			...r,
			max: !!r.max,
			fit: typeof r.fit === 'string' ? r.fit : undefined,
			alpha: ALPHA_STOPS.includes(r.alpha as number) ? r.alpha : undefined,
		};
	} catch {
		return null;
	}
}

/** The eight resize handles around the window, named like compass points. */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ResizeEdge = (typeof RESIZE_EDGES)[number];

/**
 * One floating window over the pane. Closing is the tenant's business
 * (`onClose` fires, nothing here unmounts); geometry persists under
 * `storageKey` when given, clamped back into the pane on reopen.
 *
 * `fitTo` is the auto-open handshake for fixed-mode tenants: when the mode
 * changes, the window sizes itself to the largest integer multiple the
 * pane can hold — pixel-perfect out of the box, before anyone touches a
 * handle — and resizes stay aspect-locked with a whole-multiple snap.
 *
 * `footer` is the strip along the host's bottom edge the window must keep
 * clear (the terminal pane's 24px status strip). `zIndex`/`onRaise` are the
 * window-manager's stacking hooks: any pointerdown on the window raises it.
 */
export function DesktopWindow({
	title,
	icon,
	closeTitle,
	onClose,
	storageKey,
	fitTo,
	footer = 24,
	zIndex,
	onRaise,
	handleRef,
	initial,
	titleExtra,
	children,
}: {
	title: string;
	/** An icons.tsx path `d`; no icon when omitted. */
	icon?: string;
	closeTitle?: string;
	onClose: () => void;
	storageKey?: string;
	fitTo?: { w: number; h: number } | null;
	footer?: number;
	zIndex?: number;
	onRaise?: () => void;
	handleRef?: (h: WindowHandle | null) => void;
	initial?: { w: number; h: number };
	/** Extra title-bar controls, between the title and the max button
	 * (the machine console puts its status dot and network chip here).
	 * Pointer events inside do not start a drag. */
	titleExtra?: ReactNode;
	children: ReactNode;
}) {
	const win = useRef<HTMLDivElement>(null);
	const geom = useRef<WindowRect>(
		loadRect(storageKey) ?? { x: -1, y: -1, w: initial?.w ?? 480, h: initial?.h ?? 386, max: false },
	);
	const [maximized, setMaximized] = useState(geom.current.max);
	const [alpha, setAlpha] = useState(geom.current.alpha ?? 1);

	const persist = useCallback(() => {
		if (!storageKey) return;
		try {
			localStorage.setItem(storageKey, JSON.stringify(geom.current));
		} catch {
			/* private mode: the window just forgets */
		}
	}, [storageKey]);

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
			// The host's footer strip (status dot, chips) stays visible under
			// a maximized window; on a host without one this is the full box.
			el.style.height = footer ? `calc(100% - ${footer}px)` : '100%';
			return;
		}
		const pw = pane.clientWidth;
		const ph = pane.clientHeight;
		// A hidden host (the machine console mounts once and hides with
		// display:none) measures zero; clamping against that would fold the
		// remembered geometry to the minimum. Wait for a visible box.
		if (!pw || !ph) return;
		g.w = Math.min(Math.max(g.w, MIN_W), Math.max(pw, MIN_W));
		g.h = Math.min(Math.max(g.h, MIN_H), Math.max(ph, MIN_H));
		if (g.x < 0 || g.y < 0) {
			// First open: bottom-right corner, clear of the footer strip.
			g.x = pw - g.w - 12;
			g.y = ph - g.h - (footer + 12);
		}
		g.x = Math.max(0, Math.min(g.x, pw - g.w));
		g.y = Math.max(0, Math.min(g.y, ph - g.h));
		el.style.left = `${g.x}px`;
		el.style.top = `${g.y}px`;
		el.style.width = `${g.w}px`;
		el.style.height = `${g.h}px`;
	}, [footer]);

	useEffect(() => {
		apply();
	}, [apply, maximized]);

	// The guest-facing handle (window.move/window.resize): absolute moves
	// and sizes through the same clamp-and-apply the pointer paths use.
	useEffect(() => {
		if (!handleRef) return;
		handleRef({
			setRect: (r) => {
				const g = geom.current;
				if (g.max) return;
				if (r.x !== undefined) g.x = r.x;
				if (r.y !== undefined) g.y = r.y;
				if (r.w !== undefined) g.w = r.w;
				if (r.h !== undefined) g.h = r.h;
				apply();
				persist();
			},
			getRect: () => ({ ...geom.current }),
		});
		return () => handleRef(null);
	}, [apply, persist, handleRef]);

	// Size the window to the tenant's mode, at the largest integer multiple
	// the pane can hold — but only when the mode is new. A remembered fit
	// key equal to the current mode means the stored size is already for
	// this mode (auto-fit or the user's own resize) and stays untouched;
	// without the key check, every reopen stomped a hand-set size. A
	// maximized window stays maximized (the tenant letterboxes).
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
					(pane.clientHeight - (footer + 12) - CHROME_H) / fitTo.h,
				),
			),
		);
		g.w = Math.max(MIN_W, fitTo.w * n + CHROME_W);
		g.h = Math.max(MIN_H, fitTo.h * n + CHROME_H);
		g.fit = key;
		apply();
		persist();
	}, [fitTo, footer, apply, persist]);

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
	// With a known content mode (fitTo) the resize is really one number —
	// the content scale — so the drag is aspect-locked: the axis the pointer
	// drives sets the scale, the other dimension follows, and releasing
	// snaps to the nearest whole multiple. The tenant is then exactly the
	// content's shape, so no black frame on all four sides, ever; free
	// resizing (no fitTo) letterboxes one axis at most.
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
				// (crisp) and a tenant that fits the content exactly. Below
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

	// The droplet cycles the glass: solid, then three depths, then solid
	// again. Whole-window opacity — see ALPHA_STOPS.
	const cycleAlpha = () => {
		const at = ALPHA_STOPS.indexOf(geom.current.alpha ?? 1);
		const next = ALPHA_STOPS[(at + 1) % ALPHA_STOPS.length];
		geom.current.alpha = next === 1 ? undefined : next;
		setAlpha(next);
		persist();
	};

	return (
		<div
			ref={win}
			className={`vga-window${maximized ? ' max' : ''}`}
			style={
				{
					...(zIndex !== undefined ? { zIndex } : {}),
					'--win-alpha': alpha,
				} as CSSProperties
			}
			onPointerDownCapture={onRaise}
		>
			<div
				className="vga-title"
				onPointerDown={dragStart}
				onDoubleClick={(e) => {
					if (!(e.target as HTMLElement).closest('.vga-btn, .vga-title-extra')) toggleMax();
				}}
			>
				{icon && <Icon d={icon} size={12} />}
				<span className="vga-title-text">{title}</span>
				{titleExtra && (
					<span className="vga-title-extra" onPointerDown={(e) => e.stopPropagation()}>
						{titleExtra}
					</span>
				)}
				<button
					type="button"
					className="vga-btn"
					title={`Opacity ${Math.round(alpha * 100)}% — click to cycle`}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={cycleAlpha}
				>
					<Icon d={ICON_DROPLET} size={12} />
				</button>
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
					title={closeTitle ?? `Close ${title}`}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={onClose}
				>
					<Icon d={ICON_X} size={12} />
				</button>
			</div>
			{children}
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
