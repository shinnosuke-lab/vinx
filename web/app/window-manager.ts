/**
 * The desktop document's window table (§10.7): what window.list / create /
 * close / focus / move / resize resolve through, and what the page renders
 * app windows from. One instance per document — a desktop document is
 * the scope of window.* (§3.0), so two panes are two tables.
 *
 * Three kinds of tenant:
 *
 *   - web windows, created by window.create with a §10.3 bundle; this
 *     module owns their lifecycle and hands React a snapshot to render
 *     (web-windows.tsx puts each in a DesktopWindow around an app frame);
 *   - tty windows (§6.9), opened by the guest's stream.opened notification
 *     (never by window.create): a DesktopWindow around an xterm wired to
 *     the ttyS1 mux channel. Closed by hand they stop their app (the
 *     onClosed→app.stop wire); closed by the guest (stream.closed, the
 *     app died) they leave silently through dropStream;
 *   - native windows — the VGA screen — which predate the table and stay
 *     owned by their pages (screenOpen state); they register open/close
 *     shims so window.list sees them and window.close works on them.
 *
 * Stacking is one integer per window, raised on pointerdown. The band is
 * 20..29: below the boot veil (30) and the transient chips (31), above the
 * xterm — the desktop's fixed layers stay fixed (vga-window.css's note).
 */

import type { WindowHandle } from './desktop-window';

/** A §10.3 bundle: structured parts, never a whole document. */
export interface WebBundle {
	html: string;
	css: string;
	js: string;
}

export interface WebWindowSpec {
	surface: 'web';
	id: string;
	title: string;
	/** The installed app this window fronts, when one does (§10.3's
	 * {machineId, appId} identity rides on this). */
	appId?: string;
	bundle: WebBundle;
}

export interface TtyWindowSpec {
	surface: 'tty';
	id: string;
	title: string;
	/** The app whose PTY this is — closing the window stops it. */
	appId?: string;
	/** The mux channel (§6.9): rpcd's stream id. */
	streamId: number;
	cols: number;
	rows: number;
	/** The page→guest send window granted in stream.opened. */
	window: number;
}

export type WindowSpec = WebWindowSpec | TtyWindowSpec;

interface WindowState {
	spec: WindowSpec;
	z: number;
	handle: WindowHandle | null;
}

interface NativeWindow {
	isOpen(): boolean;
	open(): void;
	close(): void;
}

const Z_BASE = 20;
const Z_CEIL = 29;
/** Windows per desktop; past this window.create answers OVERLOADED. */
const MAX_WINDOWS = 6;

export class WindowManager {
	private webs = new Map<string, WindowState>();
	private natives = new Map<string, { win: NativeWindow; z: number }>();
	private listeners = new Set<() => void>();
	private closedCbs = new Set<(id: string, appId?: string) => void>();
	private focusedCbs = new Set<(id: string) => void>();
	private zNext = Z_BASE + 1;

	// ── the React side ──

	/** Re-render trigger; fires on any table or stacking change. */
	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private ping(): void {
		for (const cb of this.listeners) cb();
	}

	/** The app windows (web and tty) to render, bottom to top. */
	snapshot(): { spec: WindowSpec; z: number }[] {
		return [...this.webs.values()]
			.map((w) => ({ spec: w.spec, z: w.z }))
			.sort((a, b) => a.z - b.z);
	}

	/** DesktopWindow's imperative handle, once mounted (move/resize land here). */
	setHandle(id: string, handle: WindowHandle | null): void {
		const w = this.webs.get(id);
		if (w) w.handle = handle;
	}

	/** The pages' own windows (the VGA screen) join the table through
	 * shims, so list/close/focus see them. Returns the unregister. */
	registerNative(id: string, win: NativeWindow): () => void {
		this.natives.set(id, { win, z: Z_BASE });
		this.ping();
		return () => {
			this.natives.delete(id);
			this.ping();
		};
	}

	/** A window's stacking order (inline z-index). */
	zOf(id: string): number {
		return this.webs.get(id)?.z ?? this.natives.get(id)?.z ?? Z_BASE;
	}

	/** Raise on pointerdown. The band is narrow (20..29) on purpose — when
	 * the counter would leave it, every window is renumbered from the
	 * bottom, order preserved. */
	raise(id: string): void {
		const entry = this.webs.get(id) ?? this.natives.get(id);
		if (!entry) return;
		// Coming to the top is a focus change; being tapped while already
		// on top is not an event worth an emit.
		const wasTop = entry.z === this.zNext - 1;
		if (!wasTop) for (const cb of this.focusedCbs) cb(id);
		entry.z = this.zNext++;
		if (this.zNext > Z_CEIL) {
			const all = [
				...[...this.webs.values()].map((w) => ({ set: (z: number) => (w.z = z), z: w.z })),
				...[...this.natives.values()].map((n) => ({ set: (z: number) => (n.z = z), z: n.z })),
			].sort((a, b) => a.z - b.z);
			let z = Z_BASE;
			for (const w of all) w.set(z++);
			this.zNext = z;
		}
		this.ping();
	}

	/** Hears every close, with the app the window fronted (vm.ts wires
	 * this to app.stop for hybrid apps). */
	onClosed(cb: (id: string, appId?: string) => void): () => void {
		this.closedCbs.add(cb);
		return () => this.closedCbs.delete(cb);
	}

	/** Hears every rise-to-top (vm.ts emits window.focused from this). */
	onFocused(cb: (id: string) => void): () => void {
		this.focusedCbs.add(cb);
		return () => this.focusedCbs.delete(cb);
	}

	// ── the window.* service (§10.7) ──

	list(): { id: string; title: string; surface: string; open: boolean }[] {
		const out: { id: string; title: string; surface: string; open: boolean }[] = [];
		for (const [id, n] of this.natives) {
			out.push({ id, title: id, surface: 'screen', open: n.win.isOpen() });
		}
		for (const [id, w] of this.webs) {
			out.push({ id, title: w.spec.title, surface: w.spec.surface, open: true });
		}
		return out;
	}

	/** A new web window. Throws plain Errors; the hostcall handler maps
	 * them (§6.4) — duplicate ids are replaced, not erred: a re-run app
	 * gets its fresh bundle shown, which is what the person meant. */
	create(spec: Omit<WebWindowSpec, 'surface'>): void {
		this.place({ surface: 'web', ...spec });
	}

	/** A terminal window for a guest PTY stream (stream.opened drives
	 * this, never window.create). The id namespace is the stream's. An
	 * unmanaged stream (proc.pty's shell) fronts no app: no appId, so
	 * closing it goes through stream.close instead of app.stop. */
	openStream(spec: {
		streamId: number;
		app: string;
		cols: number;
		rows: number;
		window: number;
		unmanaged?: boolean;
	}): void {
		this.place({
			surface: 'tty',
			id: `tty-${spec.streamId}`,
			title: spec.app,
			appId: spec.unmanaged ? undefined : spec.app,
			streamId: spec.streamId,
			cols: spec.cols,
			rows: spec.rows,
			window: spec.window,
		});
	}

	/** The guest closed the stream (the app exited): the window leaves
	 * without the onClosed fanfare — there is no app left to stop. */
	dropStream(streamId: number): boolean {
		const id = `tty-${streamId}`;
		if (!this.webs.delete(id)) return false;
		this.ping();
		return true;
	}

	/** A new control session: every stream died with the old one (rpcd
	 * closed the masters), so every terminal window is a corpse. */
	dropAllStreams(): void {
		let hit = false;
		for (const [id, w] of [...this.webs]) {
			if (w.spec.surface === 'tty') {
				this.webs.delete(id);
				hit = true;
			}
		}
		if (hit) this.ping();
	}

	/** The app behind a window exited (the §10.7 app.exited event): say so
	 * in the title and leave the window up — closing is the person's call
	 * (they may want to read what it last said). */
	markExited(appId: string, code: number | null): void {
		let hit = false;
		for (const w of this.webs.values()) {
			if (w.spec.appId !== appId || w.spec.title.includes('(exited')) continue;
			w.spec = {
				...w.spec,
				title: `${w.spec.title} (exited${typeof code === 'number' ? ` ${code}` : ''})`,
			};
			hit = true;
		}
		if (hit) this.ping();
	}

	private place(spec: WindowSpec): void {
		if (!this.webs.has(spec.id) && this.webs.size >= MAX_WINDOWS) {
			throw new Error(`this desktop already shows ${MAX_WINDOWS} app windows (close one first)`);
		}
		const existing = this.webs.get(spec.id);
		this.webs.set(spec.id, { spec, z: existing?.z ?? this.zNext, handle: existing?.handle ?? null });
		if (!existing) this.zNext++;
		this.raise(spec.id);
	}

	close(id: string): boolean {
		const native = this.natives.get(id);
		if (native) {
			if (!native.win.isOpen()) return true;
			native.win.close();
			this.ping();
			return true;
		}
		const w = this.webs.get(id);
		if (!w) return false;
		this.webs.delete(id);
		this.ping();
		for (const cb of this.closedCbs) cb(id, w.spec.appId);
		return true;
	}

	focus(id: string): boolean {
		const native = this.natives.get(id);
		if (native) {
			native.win.open();
			this.raise(id);
			return true;
		}
		if (!this.webs.has(id)) return false;
		this.raise(id);
		return true;
	}

	move(id: string, x: number, y: number): boolean {
		const w = this.webs.get(id);
		if (!w?.handle) return false;
		w.handle.setRect({ x, y });
		return true;
	}

	resize(id: string, wpx: number, hpx: number): boolean {
		const w = this.webs.get(id);
		if (!w?.handle) return false;
		w.handle.setRect({ w: wpx, h: hpx });
		return true;
	}
}

/** This document's one window table. */
let manager: WindowManager | null = null;

export function windowManager(): WindowManager {
	manager ??= new WindowManager();
	return manager;
}
