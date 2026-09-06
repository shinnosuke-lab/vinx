/**
 * The guest side of the bridge: `bridge(1)` in the VM drives the WebRTC LAN
 * bridge through the network.bridge.* control-plane methods (hostcall.ts
 * serves them; this module is their implementation).
 *
 * Control only — the rooms themselves are net-bridge.ts's. start/join block
 * until the room is on (or reject with its failure), which is what lets the
 * guest CLI be one call instead of the old start-then-poll dance; status
 * reads the live room, so a room the person started with panel clicks
 * answers here too — the job /data/.bridge-status used to do, retired with
 * the rest of the file protocol in Phase 3. One room per page either way —
 * net-bridge keeps the singleton.
 */

import type { BridgeControl, BridgeStatus } from './hostcall';
import { currentRoom, hostRoom, joinRoom, type RoomBridge } from './net-bridge';

function snapshot(b: RoomBridge | null): BridgeStatus {
	if (!b || b.state === 'closed') return { state: 'off' };
	if (b.state === 'failed') return { state: 'failed', error: b.error || 'the bridge failed' };
	return {
		state: b.state === 'on' ? 'on' : 'joining',
		role: b.role,
		room: b.room,
		members: b.members.map((m) => ({ name: m.name, ip: m.ip || '?', host: m.host })),
	};
}

/** Resolve when the room reaches `on`; reject when it fails or closes.
 * The caller's deadline (rpc serve budget) bounds the wait — an abort just
 * stops this promise, the room keeps whatever it was doing. */
function untilOn(b: RoomBridge, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolve();
		};
		const check = () => {
			if (b.state === 'on') settle();
			else if (b.state === 'failed') settle(new Error(b.error || 'the bridge failed'));
			else if (b.state === 'closed') settle(new Error('the bridge closed before it came up'));
		};
		b.onChange(check);
		signal?.addEventListener('abort', () => settle(new Error('cancelled')), { once: true });
		check();
	});
}

export const bridgeControl: BridgeControl = {
	async start(name, ip, signal) {
		const b = await hostRoom(name, ip);
		await untilOn(b, signal);
		return snapshot(b);
	},

	async join(code, name, ip, signal) {
		const b = await joinRoom(code, name, ip);
		await untilOn(b, signal);
		return snapshot(b);
	},

	stop() {
		currentRoom()?.stop();
	},

	// Fire and forget past the liveness check: the danmaku overlay is the
	// delivery receipt everyone can see.
	say(text, to) {
		const b = currentRoom();
		if (!b || b.state !== 'on') return false;
		b.say(String(text), to ? String(to) : undefined);
		return true;
	},

	status() {
		return snapshot(currentRoom());
	},
};
