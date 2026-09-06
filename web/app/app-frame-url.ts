/**
 * Where the app shell lives (§10.3, §18).
 *
 * By default beside the page's assets: `app/public/app-frame.html` ships at
 * the deploy root of dist/, next to `assets/` and `vm/`, so the shell is one
 * static file in the same directory as everything else — nothing to
 * configure, on any host (GitHub Pages under /repo/ included; base is './').
 * The frame is sandboxed without allow-same-origin, so being served from the
 * desktop's own origin grants it nothing: it is an opaque origin behind the
 * shell's meta CSP either way.
 *
 * Resolved the way vm.ts finds `vm/`: relative to this module, which the
 * production build lands in `assets/` at every page depth (the terminal page
 * lives one directory down, so the document is the wrong anchor); the dev
 * server serves the public directory at its root.
 *
 * A deploy that wants the shell on a different *site* — a separate process
 * on every browser, not only desktop Chromium (see the shell's own header)
 * — names a copy of the same file at build time:
 * VINX_APP_FRAME_URL → __APP_FRAME_URL__.
 */
export function appFrameUrl(): string {
	if (__APP_FRAME_URL__) return __APP_FRAME_URL__;
	if (import.meta.env.DEV) return new URL('/app-frame.html', location.href).href;
	return new URL('../app-frame.html', import.meta.url).href;
}
