/**
 * Bridge chat, painted as danmaku: every line a room member `bridge say`s
 * floats once across this window, right to left, above whatever the page is
 * doing. Receiving needs nothing running in the guest — the overlay is the
 * inbox — which also keeps chat away from the console tty entirely (v86's
 * UART starves a tty writer whenever the tty has a concurrent reader).
 *
 * One source, one path: net-bridge posts every delivered line on the
 * CHAT_CHANNEL BroadcastChannel and this module only listens there. A single
 * post reaches the overlay in the bridging tab (same-context instances hear
 * each other) and in every other same-origin tab — those tabs share the LAN,
 * so they share the chatter. The terminal page mounts this in the shell
 * document only: the shell spans the whole window, and the pane iframes
 * underneath would each float a duplicate.
 */

import { CHAT_CHANNEL, type ChatMessage } from './net-bridge';

import './danmaku.css';

const MAX_LIVE = 24; // a flood scrolls by, it does not wallpaper the screen
const LANES = 8;

let layer: HTMLElement | null = null;
let lane = 0;
let mounted = false;

function float(m: ChatMessage): void {
	const from = String(m?.from ?? '').slice(0, 32) || 'someone';
	const text = String(m?.text ?? '')
		.slice(0, 512)
		.trim();
	if (!text) return;
	if (!layer) {
		layer = document.createElement('div');
		layer.className = 'danmaku';
		document.body.append(layer);
	}
	while (layer.childElementCount >= MAX_LIVE) layer.firstElementChild?.remove();

	const item = document.createElement('div');
	item.className = 'dmk-item' + (m.self ? ' dmk-self' : '') + (m.direct ? ' dmk-direct' : '');
	const who = document.createElement('span');
	who.className = 'dmk-from';
	who.textContent = from;
	item.append(who, ` ${text}`);
	// Lanes rotate, and a little jitter in the speed keeps two messages in
	// one lane from riding bumper to bumper.
	item.style.top = `${5 + (lane++ % LANES) * 5.5}%`;
	item.style.animationDuration = `${9 + Math.random() * 3}s`;
	item.addEventListener('animationend', () => item.remove());
	layer.append(item);
}

/** Start floating bridge chat over this document. Idempotent. */
export function mountDanmaku(): void {
	if (mounted) return;
	mounted = true;
	new BroadcastChannel(CHAT_CHANNEL).addEventListener('message', (e) => {
		float(e.data as ChatMessage);
	});
}
