/**
 * The guest side of the bridge: `bridge(1)` in the VM speaks OSC 7770 to the
 * page, and the page answers through a file.
 *
 * Command flow: the script prints `bridge;<b64 JSON>` and the terminal's OSC
 * handler calls `handleBridgeOsc`. Result flow: every change to the room —
 * created, joined, roster moved, failed, stopped — is rendered into
 * `/data/.bridge-status`, a flat key=value file the script polls and parses
 * with nothing fancier than a shell `case`. The file is the *only* return
 * channel: run_shell output is not OSC-parsed, and the console cannot be
 * written to without colliding with whatever the person is typing.
 *
 * The same tracking serves the panel: rooms started from the UI also land in
 * the status file (when a VM is running), so `bridge show` in the guest sees
 * a room the person started with clicks. One room per page either way —
 * net-bridge keeps the singleton.
 */

import { currentRoom, hostRoom, joinRoom, type RoomBridge } from './net-bridge';
import { sharedVm, type VinxVm, type VmState } from './vm';

const STATUS_FILE = '.bridge-status';

export interface BridgeRequest {
	op: 'start' | 'join' | 'stop' | 'say';
	code?: string;
	name?: string;
	ip?: string;
	text?: string;
	to?: string;
}

function statusText(b: RoomBridge | null, error = ''): string {
	if (!b || b.state === 'closed') {
		return error ? `state=failed\nerror=${error}\n` : 'state=off\n';
	}
	if (b.state === 'failed') {
		return `state=failed\nerror=${b.error || error}\n`;
	}
	const lines = [
		`state=${b.state === 'on' ? 'on' : 'joining'}`,
		`role=${b.role}`,
		`room=${b.room}`,
		`members=${b.members.length}`,
	];
	for (const m of b.members) {
		lines.push(`member=${m.name} ${m.ip || '?'}${m.host ? ' host' : ''}`);
	}
	return lines.join('\n') + '\n';
}

function vmState(vm: VinxVm): VmState {
	let s: VmState = 'off';
	vm.onState((v) => {
		s = v;
	})();
	return s;
}

async function writeStatus(text: string): Promise<void> {
	const vm = sharedVm();
	// Never *boot* a machine just to file paperwork: without a running VM
	// there is no reader (and on the chat page, no terminal either).
	if (vmState(vm) !== 'ready') return;
	try {
		await vm.putFile(STATUS_FILE, new TextEncoder().encode(text));
	} catch {
		/* a reload race; the next change rewrites it */
	}
}

/** Follow a room's life and mirror every change into the guest's file.
 * Deliberately does not touch the stored network mode: bridging is a live
 * action, and `vinx.vm.relay` belongs to the panel's Save button alone.
 * The panel reads the live room at open and shows "Bridge LAN" anyway. */
export function trackRoom(b: RoomBridge): void {
	void writeStatus(statusText(b));
	b.onChange(() => void writeStatus(statusText(b)));
}

/**
 * One command from the guest script. Resolution is asynchronous by design:
 * the script polls the status file, so this only kicks things off.
 */
export async function handleBridgeOsc(req: BridgeRequest): Promise<void> {
	const name = (req.name || 'someone').slice(0, 32);
	const ip = (req.ip || '').slice(0, 15);
	if (req.op === 'start') {
		await writeStatus('state=starting\n');
		try {
			trackRoom(await hostRoom(name, ip));
		} catch (e) {
			await writeStatus(statusText(null, e instanceof Error ? e.message : String(e)));
		}
	} else if (req.op === 'join') {
		if (!req.code) {
			await writeStatus(statusText(null, 'join needs a room code'));
			return;
		}
		await writeStatus('state=joining\n');
		try {
			trackRoom(await joinRoom(req.code, name, ip));
		} catch (e) {
			await writeStatus(statusText(null, e instanceof Error ? e.message : String(e)));
		}
	} else if (req.op === 'stop') {
		currentRoom()?.stop();
		await writeStatus('state=off\n');
	} else if (req.op === 'say') {
		// Fire and forget: the script checked state=on before sending, and
		// the danmaku overlay is the delivery receipt everyone can see.
		currentRoom()?.say(String(req.text || ''), req.to ? String(req.to) : undefined);
	}
}
