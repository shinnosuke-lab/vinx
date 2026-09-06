/**
 * The xterm construction options both consoles share.
 *
 * The terminal page and the chat page's machine console are two views of the
 * same kind of thing — ttyS0 of a vinx machine — and must read identically:
 * same Tokyo Night palette, same iTerm2 font stack, same input conventions.
 * One options factory keeps them from drifting; each caller still loads its
 * own addons (both carry images — the boot banner's logo and imgcat render
 * on every console — the terminal page adds its own link providers).
 */

import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

/**
 * The WebGL renderer, wherever a terminal opens: text lands crisp (the DOM
 * renderer's glyphs go soft under macOS compositing) and scrolling stops
 * costing layout. Call after `term.open()` — the addon wants the element.
 * Guard rails for a page with many terminals (console, PTY windows): a
 * browser caps live WebGL contexts, so a refused context falls back to the
 * DOM renderer silently, and a lost context (the cap evicting us later)
 * disposes back to DOM instead of leaving a blank canvas. The test suite
 * reads screens through the buffer API, which serves either renderer.
 */
export function loadWebglRenderer(term: Terminal): void {
	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => webgl.dispose());
		term.loadAddon(webgl);
	} catch {
		/* no WebGL here; the DOM renderer keeps working */
	}
}

export function consoleTerminalOptions(): ITerminalOptions {
	return {
		// The unicode11 addon registers through a proposed API, and the
		// clipboard addon's OSC 52 path likewise.
		allowProposedApi: true,
		cursorBlink: true,
		cursorStyle: 'block',
		cursorInactiveStyle: 'outline',
		// iTerm2's "Left Option acts as Esc+": Option-B/F word motion and
		// friends work in shells instead of typing ∫ and ƒ.
		macOptionIsMeta: true,
		scrollback: 5000,
		// iTerm2's stack: Monaco first, then the monos a Mac or a Linux box
		// actually has. 11px, one notch under iTerm2's default — denser
		// suits windows that share a page; the loose line height and
		// letter spacing are what professional terminals ship and xterm's
		// defaults lack.
		fontFamily: "Monaco, 'SF Mono', Menlo, 'JetBrains Mono', 'Cascadia Code', monospace",
		fontSize: 11,
		lineHeight: 1.15,
		letterSpacing: 0.5,
		// Rendering is the WebGL addon's (loadWebglRenderer, after open());
		// the DOM renderer is the automatic fallback. The browser suite
		// reads screens through the buffer API, so either renderer serves.
		// Tokyo Night's palette — deep blue-grey ground, soft pastels, a
		// cyan that reads as terminal without glaring.
		theme: {
			background: '#1a1b26',
			foreground: '#c0caf5',
			cursor: '#cd751d',
			selectionBackground: '#33467c',
			black: '#15161e',
			red: '#f7768e',
			green: '#9ece6a',
			yellow: '#e0af68',
			blue: '#7aa2f7',
			magenta: '#bb9af7',
			cyan: '#7dcfff',
			white: '#a9b1d6',
			brightBlack: '#414868',
			brightRed: '#f7768e',
			brightGreen: '#9ece6a',
			brightYellow: '#e0af68',
			brightBlue: '#7aa2f7',
			brightMagenta: '#bb9af7',
			brightCyan: '#7dcfff',
			brightWhite: '#c0caf5',
		},
	};
}
