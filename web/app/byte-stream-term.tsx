/**
 * One xterm over one byte stream — the shared terminal chrome that
 * vm-console's ttyS0 console and the PTY windows (§6.9) both are. This
 * component owns what every byte-stream terminal needs and nothing more:
 * the xterm construction (addons, unicode 11, links, clipboard), fit +
 * ResizeObserver with the hidden-box guard, copy-on-select, the
 * StrictMode-safe one-frame-late open(), and focus-on-active.
 *
 * The stream itself is the caller's: `onData` carries keystrokes out,
 * `attach` wires bytes in (it receives the Terminal and returns its
 * cleanup), `onResize` hears the grid change after every fit. Props ride
 * refs so a re-render never rebuilds the terminal.
 */

import { useEffect, useRef } from 'react';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { copyToClipboard } from '@vinx/agent-chat';

import { consoleTerminalOptions, loadWebglRenderer } from './term-theme';

import '@xterm/xterm/css/xterm.css';

export function ByteStreamTerm({
	onData,
	onResize,
	attach,
	active = true,
	className = 'vmc-term',
}: {
	/** Typed bytes out, exactly as xterm reports them. */
	onData: (data: string) => void;
	/** The grid changed (a fit landed): push cols×rows to the far side. */
	onResize?: (cols: number, rows: number) => void;
	/** Mount hook: wire incoming bytes to term.write(); returns cleanup. */
	attach: (term: Terminal) => () => void;
	/** Focus the cursor when this turns true (a panel became visible). */
	active?: boolean;
	className?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const onDataRef = useRef(onData);
	onDataRef.current = onData;
	const onResizeRef = useRef(onResize);
	onResizeRef.current = onResize;
	const attachRef = useRef(attach);
	attachRef.current = attach;

	useEffect(() => {
		// The shared options, solid background included: the WebGL renderer
		// does not do allowTransparency (it clears to black — the banner's
		// transparent logo sat on a black slab), so every console paints on
		// the same solid Tokyo Night ground and the window glass is the
		// chrome's whole-window opacity instead (see desktop-window.tsx).
		const term = new Terminal(consoleTerminalOptions());
		termRef.current = term;
		const fit = new FitAddon();
		term.loadAddon(fit);
		// Emoji and the newer Unicode blocks measured right; the built-in
		// table stops at Unicode 6.
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = '11';
		term.loadAddon(new WebLinksAddon());
		term.loadAddon(new ClipboardAddon());
		// iTerm2's inline-image protocol (OSC 1337) and sixel: the boot
		// banner's logo and imgcat(1) render wherever a console is — the
		// chat page's machine panel and every PTY window included, not
		// just the terminal page. Disposed by hand before the terminal
		// (see the cleanup): its teardown dereferences renderer internals
		// that term.dispose()'s addon sweep has already torn down.
		const images = new ImageAddon();
		term.loadAddon(images);

		// Typed bytes out; the far side echoes, so no local echo here.
		const typed = term.onData((data) => onDataRef.current(data));
		const detach = attachRef.current(term);

		let lastCols = 0;
		let lastRows = 0;
		const pushSize = () => {
			if (term.cols === lastCols && term.rows === lastRows) return;
			lastCols = term.cols;
			lastRows = term.rows;
			onResizeRef.current?.(term.cols, term.rows);
		};
		// The host's own window's observer: one constructed here (the main
		// window) never fires for elements in a popped-out document, and a
		// pop-out shell would keep its opening cols/rows forever.
		const View = (host.current?.ownerDocument.defaultView ?? window) as typeof window;
		const resize = new View.ResizeObserver(() => {
			// A host sized to zero (a hidden panel) makes fit() divide by it.
			if (host.current?.clientWidth) {
				fit.fit();
				pushSize();
			}
		});

		// Touching the DOM waits one frame, for StrictMode's throwaway
		// first mount; terminal.tsx tells the full story.
		const raf = requestAnimationFrame(() => {
			term.open(host.current!);
			// Crisp text; falls back to the DOM renderer without WebGL.
			loadWebglRenderer(term);
			if (host.current!.clientWidth) {
				fit.fit();
				pushSize();
			}
			resize.observe(host.current!);
		});

		// Selecting is copying, like iTerm2 and the terminal page. The
		// library's helper carries the insecure-context fallback.
		const copySelection = () => {
			const text = term.getSelection();
			if (text) void copyToClipboard(text);
		};
		const hostEl = host.current!;
		hostEl.addEventListener('mouseup', copySelection);
		hostEl.addEventListener('touchend', copySelection);

		return () => {
			cancelAnimationFrame(raf);
			typed.dispose();
			detach();
			hostEl.removeEventListener('mouseup', copySelection);
			hostEl.removeEventListener('touchend', copySelection);
			resize.disconnect();
			termRef.current = null;
			// The image addon first, defensively: disposed inside
			// term.dispose()'s sweep (after the renderer is gone) it
			// dereferences torn-down internals and the throw would take the
			// whole React unmount with it — a closed PTY window must never
			// cost the page its tree.
			try {
				images.dispose();
			} catch {
				/* already half-gone; the terminal teardown below still runs */
			}
			try {
				term.dispose();
			} catch {
				/* a disposed-addon straggler; the terminal is gone either way */
			}
		};
	}, []);

	// The panel just became visible: put the cursor where the person is
	// looking (the ResizeObserver above handles the refit on its own).
	useEffect(() => {
		if (active) termRef.current?.focus();
	}, [active]);

	return <div className={className} ref={host} />;
}
