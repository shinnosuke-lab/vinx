/**
 * The tenant inside a web app window: the sandboxed iframe running the
 * §10.3 bundle on the app shell, and the host half of the one-shot
 * MessageChannel bridge beside it.
 *
 * Trust shape (§10.3/§11.2): the frame is sandboxed without
 * allow-same-origin/popups/top-navigation — an opaque origin wherever the
 * shell is served from, by default beside the page — and the shell's CSP
 * forbids network, external scripts and child frames. Identity is the
 * port: the desktop maps *this* MessagePort to {machineId, appId} and
 * never trusts an opaque frame's event.origin or an id inside a message.
 * The app calls host-allowlisted methods over the port; the host enforces
 * the allowlist, a message size cap and a pending cap, and fronts the
 * user-gesture surfaces itself.
 */

import { useEffect, useRef } from 'react';

import { appFrameUrl } from './app-frame-url';
import { sharedVm } from './vm';
import { windowManager, type WebWindowSpec } from './window-manager';

/** What an app window may ask of the desktop, first cut: say something
 * (attributed), and close itself. Growth is one entry at a time, never a
 * pass-through to the whole method table. */
const ALLOWED = new Set(['notify.show', 'window.close']);
/** One port message may carry this much JSON. */
const MSG_MAX = 64 * 1024;
/** Calls in flight per app window; past it the answer is a refusal. */
const PENDING_MAX = 4;

export function AppFrame({ spec }: { spec: WebWindowSpec }) {
	const ref = useRef<HTMLIFrameElement>(null);

	useEffect(() => {
		const iframe = ref.current;
		if (!iframe || !appFrameUrl()) return;
		const chan = new MessageChannel();
		const host = chan.port1;
		let pending = 0;

		const answer = (id: number, ok: boolean, body: unknown) => {
			host.postMessage(ok ? { re: id, ok: true, result: body } : { re: id, ok: false, error: String(body) });
		};

		host.onmessage = (ev) => {
			const m = ev.data as { t?: unknown; id?: unknown; method?: unknown; params?: unknown };
			if (!m || m.t !== 'call' || typeof m.id !== 'number') return;
			const id = m.id;
			try {
				if (JSON.stringify(ev.data).length > MSG_MAX) {
					answer(id, false, `the message is over ${MSG_MAX} bytes`);
					return;
				}
			} catch {
				answer(id, false, 'the message does not serialize');
				return;
			}
			const method = typeof m.method === 'string' ? m.method : '';
			if (!ALLOWED.has(method)) {
				answer(id, false, `${method || '(no method)'} is not allowed from an app window`);
				return;
			}
			if (pending >= PENDING_MAX) {
				answer(id, false, `${PENDING_MAX} calls already pending`);
				return;
			}
			pending++;
			try {
				const params = (m.params ?? {}) as Record<string, unknown>;
				if (method === 'window.close') {
					// The app asked to go; same path as the title-bar button
					// (a fronted hybrid app's backend stops with it).
					answer(id, true, { closed: true });
					windowManager().close(spec.id);
				} else if (method === 'notify.show') {
					const text = typeof params.text === 'string' ? params.text.slice(0, 512) : '';
					// Attributed: the person hears which app spoke (§6.5's
					// stance — identity comes from the host's own mapping).
					const via = text ? sharedVm().desktopNotify(`[${spec.id}] ${text}`) : null;
					if (via) answer(id, true, { via });
					else answer(id, false, text ? 'nowhere to show a notification' : 'notify.show wants {text}');
				}
			} finally {
				pending--;
			}
		};

		// One shot, on load: the bundle and the app's end of the channel.
		// targetOrigin is '*' by necessity — a sandboxed frame without
		// allow-same-origin is an opaque origin no string can name; the
		// port, not the origin, is what the trust rides on.
		const onLoad = () => {
			iframe.contentWindow?.postMessage(
				{ t: 'vinx-bundle', html: spec.bundle.html, css: spec.bundle.css, js: spec.bundle.js },
				'*',
				[chan.port2],
			);
		};
		iframe.addEventListener('load', onLoad);
		return () => {
			iframe.removeEventListener('load', onLoad);
			// The window went away: the port dies with it, and anything the
			// app still had pending is torn off (§11.2 — close cancels).
			host.close();
		};
	}, [spec]);

	const shellUrl = appFrameUrl();
	if (!shellUrl) {
		// window.create refuses without a shell, so this renders only if a
		// window somehow outlived its config; be honest rather than blank.
		return <div className="app-frame-missing">the app shell is not available here</div>;
	}
	return (
		<iframe
			ref={ref}
			className="app-frame"
			title={spec.title}
			src={shellUrl}
			// No allow-same-origin (the frame is an opaque origin), no
			// popups, no top-navigation: scripts only (§10.3).
			sandbox="allow-scripts"
		/>
	);
}
