/**
 * The page half of ble(1): Web Bluetooth driven from the guest's shell.
 *
 * The browser exposes BLE at the GATT level only, so this is a command
 * bridge — one device per machine, connect/services/read/write/notify — not
 * an adapter the guest could run BlueZ on. Two browser rules shape the flow:
 *
 *   - The device picker (and the experimental LE scan) must be called inside
 *     a user gesture, and an OSC sequence is not one. Requests park here and
 *     the footer's ble chip pulses until the person clicks it; a device
 *     Chrome already remembers reconnects silently, no click.
 *
 *   - Pairing has no API. A read or write that needs encryption makes the OS
 *     pop its own dialog, then the operation just succeeds — nothing for
 *     this module to do, which is why ble(1) has no `pair`.
 *
 * Answers travel through /data files the script polls: .ble-status for the
 *  connection, .ble-reply per command (matched by seq), .ble-notify as a
 * rolling feed shared by notifications and scan results.
 *
 * Access rule worth knowing: with `acceptAllDevices` Chrome grants only the
 * services listed in optionalServices, so every 16-bit service id — the
 * SIG's standard block and the member block — is requested wholesale. A
 * device with a custom 128-bit service needs `ble connect SERVICE` — the
 * explicit filter doubles as the access grant.
 */

import { sharedVm, type VinxVm, type VmState } from './vm';

const STATUS = '.ble-status';
const REPLY = '.ble-reply';
const FEED = '.ble-notify';

// The URL leads: with the script's `ble: ` prefix it ends inside 80 columns,
// so the terminal's chrome:// link stays whole (and clickable) even there.
const FLAG_HINT =
	'scanning needs chrome://flags/#enable-experimental-web-platform-features' +
	" -- enable it, restart the browser; or just 'ble connect' (the picker scans " +
	'in its own window)';

export interface BleRequest {
	op: 'scan' | 'connect' | 'services' | 'read' | 'write' | 'notify' | 'disconnect';
	seq?: string;
	service?: string;
	svc?: string;
	chr?: string;
	hex?: string;
	on?: boolean;
	off?: boolean;
}

// ── state: one device, one scan, at most one parked gesture ──

let device: BluetoothDevice | null = null;
let leScan: BluetoothLEScan | null = null;
let scanListener: ((e: Event) => void) | null = null;
/** A picker request waiting for the chip click ({} means no service filter). */
let pendingPick: { service?: string } | null = null;
/** A scan request waiting for the chip click. */
let pendingScan = false;
/**
 * Live notification subscriptions, keyed by the characteristic's canonical
 * uuid (so `heart_rate` and `2a37` unsubscribe the same thing), each with
 * its listener — kept so `notify ... off` can actually remove it, or a
 * re-subscribe would stack a second one and every value would float twice.
 */
const subs = new Map<string, { chr: BluetoothRemoteGATTCharacteristic; handler: () => void }>();

function dropSubs(): void {
	for (const { chr, handler } of subs.values()) {
		chr.removeEventListener('characteristicvaluechanged', handler);
	}
	subs.clear();
}

/** Let the current device go: subscriptions, GATT link, the lot. */
function release(): void {
	dropSubs();
	const d = device;
	device = null;
	d?.gatt?.disconnect();
}

let note: (msg: string) => void = () => {};

const chipListeners = new Set<() => void>();

export function onBleChange(cb: () => void): () => void {
	chipListeners.add(cb);
	return () => chipListeners.delete(cb);
}

function ping(): void {
	for (const cb of chipListeners) cb();
}

export type BleChip = {
	state: 'off' | 'pending' | 'connected';
	device: string;
};

export function bleChip(): BleChip {
	if (pendingPick || pendingScan) return { state: 'pending', device: '' };
	if (device?.gatt?.connected) return { state: 'connected', device: device.name || device.id };
	return { state: 'off', device: '' };
}

// ── /data plumbing (the bridge-ctl stance: no VM, no paperwork) ──

function vmState(vm: VinxVm): VmState {
	let s: VmState = 'off';
	vm.onState((v) => {
		s = v;
	})();
	return s;
}

async function put(name: string, text: string): Promise<void> {
	const vm = sharedVm();
	if (vmState(vm) !== 'ready') return;
	try {
		await vm.putFile(name, new TextEncoder().encode(text));
	} catch {
		/* a reload race; the next write replaces it */
	}
}

async function writeStatus(): Promise<void> {
	let text = 'state=off\n';
	if (pendingPick) text = 'state=picking\n';
	else if (device?.gatt?.connected) {
		text = `state=connected\ndevice=${device.name || 'unnamed'}\nid=${device.id}\n`;
	}
	await put(STATUS, text);
	ping();
}

async function failStatus(msg: string): Promise<void> {
	pendingPick = null;
	await put(STATUS, `state=failed\nerror=${msg}\n`);
	ping();
}

async function reply(seq: string | undefined, ok: boolean, body = ''): Promise<void> {
	if (!seq) return;
	const lines = [`seq=${seq}`, `ok=${ok ? 1 : 0}`];
	if (!ok) lines.push(`err=${body}`);
	else if (body) lines.push(body);
	await put(REPLY, lines.join('\n') + '\n');
}

// The rolling feed: notifications and scan lines share one file, newest
// last, each line "N text" with N ever-increasing so the script can tail it
// across rewrites.
let feedSeq = 0;
const feed: string[] = [];
let feedTimer: ReturnType<typeof setTimeout> | null = null;

function pushFeed(text: string): void {
	feed.push(`${++feedSeq} ${text}`);
	if (feed.length > 64) feed.shift();
	// Trailing debounce: an IMU notifying at 100Hz coalesces into one /data
	// write per 150ms instead of a hundred full rewrites a second. The guest
	// polls the feed at 1s, so it cannot tell the difference.
	feedTimer ??= setTimeout(() => {
		feedTimer = null;
		void put(FEED, feed.join('\n') + '\n');
	}, 150);
}

// ── uuid helpers ──

/** 16/32-bit shorts become numbers; names and full UUIDs pass through. */
function uuidArg(s: string): string | number {
	if (/^[0-9a-fA-F]{4}$/.test(s) || /^[0-9a-fA-F]{8}$/.test(s)) return parseInt(s, 16);
	return s.toLowerCase();
}

/** The SIG base UUID collapses back to its 16-bit short for display. */
function shortUuid(u: string): string {
	const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
	return m ? m[1] : u;
}

/**
 * The blanket optionalServices grant for acceptAll picks: every 16-bit
 * service id. 0x1800-0x18ff is the SIG's standard block; 0xfc00-0xffff is
 * the member block real gadgets actually advertise (Xiaomi 0xfe95, Fast
 * Pair 0xfe2c...). Blocklisted ids are dropped by the spec, not rejected,
 * so listing them all is safe. Custom 128-bit services stay out of reach —
 * `ble connect SERVICE` is the grant for those.
 */
function allShortServices(): number[] {
	const ids: number[] = [];
	for (let i = 0x1800; i <= 0x18ff; i++) ids.push(i);
	for (let i = 0xfc00; i <= 0xffff; i++) ids.push(i);
	return ids;
}

function hex(view: DataView): string {
	let s = '';
	for (let i = 0; i < view.byteLength; i++) s += view.getUint8(i).toString(16).padStart(2, '0');
	return s;
}

function bytesOf(hexStr: string): Uint8Array {
	const out = new Uint8Array(hexStr.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
	return out;
}

// ── the device ──

function adopt(d: BluetoothDevice): void {
	device = d;
	pendingPick = null;
	d.addEventListener(
		'gattserverdisconnected',
		() => {
			if (device === d) {
				dropSubs();
				void writeStatus();
			}
		},
		{ once: true },
	);
	void writeStatus();
}

async function openPicker(): Promise<void> {
	const want = pendingPick;
	pendingPick = null;
	try {
		const opts: RequestDeviceOptions = want?.service
			? {
					filters: [{ services: [uuidArg(want.service)] }],
					optionalServices: allShortServices(),
				}
			: { acceptAllDevices: true, optionalServices: allShortServices() };
		const d = await navigator.bluetooth!.requestDevice(opts);
		await d.gatt!.connect();
		adopt(d);
	} catch (e) {
		// NotFoundError is the picker's cancel button — an answer, not a fault.
		if (e instanceof Error && e.name === 'NotFoundError') {
			await failStatus('the picker was dismissed');
		} else {
			await failStatus(e instanceof Error ? e.message : String(e));
		}
	}
}

async function startScan(): Promise<void> {
	pendingScan = false;
	try {
		scanListener = (e) => {
			const ad = e as BluetoothAdvertisingEvent;
			let mfg = '';
			for (const [id, data] of ad.manufacturerData ?? []) {
				mfg = ` mfg=${id.toString(16).padStart(4, '0')}:${hex(data).slice(0, 16)}`;
				break;
			}
			const rssi = ad.rssi ?? '?';
			const name = ad.device.name || ad.name || '(no name)';
			pushFeed(`${rssi}dBm  ${name}  ${ad.device.id}${mfg}`);
		};
		navigator.bluetooth!.addEventListener('advertisementreceived', scanListener);
		leScan = await navigator.bluetooth!.requestLEScan!({
			acceptAllAdvertisements: true,
		});
		ping();
	} catch (e) {
		stopScan();
		note(`ble: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function stopScan(): void {
	leScan?.stop();
	leScan = null;
	pendingScan = false;
	if (scanListener) {
		navigator.bluetooth?.removeEventListener('advertisementreceived', scanListener);
		scanListener = null;
	}
	ping();
}

/** The footer chip's click — the one user gesture everything parks for. */
export async function bleChipClick(): Promise<void> {
	if (pendingPick) return openPicker();
	if (pendingScan) return startScan();
	if (device?.gatt?.connected) {
		device.gatt.disconnect();
		return;
	}
	// Idle click: offer the picker anyway — connecting from the UI first and
	// typing `ble services` after is a perfectly good order of events.
	if (navigator.bluetooth) {
		pendingPick = {};
		await openPicker();
	}
}

// ── gatt ops ──

function connectedChr(svc: string, chr: string): Promise<BluetoothRemoteGATTCharacteristic> {
	const server = device?.gatt;
	if (!server?.connected) throw new Error('no device connected (ble connect)');
	return server.getPrimaryService(uuidArg(svc)).then((s) => s.getCharacteristic(uuidArg(chr)));
}

async function listServices(): Promise<string> {
	const server = device?.gatt;
	if (!server?.connected) throw new Error('no device connected (ble connect)');
	const lines: string[] = [];
	for (const svc of await server.getPrimaryServices()) {
		lines.push(`svc ${shortUuid(svc.uuid)}`);
		for (const c of await svc.getCharacteristics()) {
			const p = c.properties;
			const props = [
				p.read && 'read',
				(p.write || p.writeWithoutResponse) && 'write',
				p.notify && 'notify',
				p.indicate && 'indicate',
			]
				.filter(Boolean)
				.join(' ');
			lines.push(`  chr ${shortUuid(c.uuid)}  ${props}`);
		}
	}
	return lines.join('\n') || '(no services granted -- try ble connect SERVICE)';
}

/**
 * One command from the guest script. Fast ops answer through .ble-reply;
 * connect, which can wait on a human, reports through .ble-status instead.
 */
export async function handleBleOsc(req: BleRequest, notify: (msg: string) => void): Promise<void> {
	note = notify;
	if (!navigator.bluetooth) {
		const msg = 'this browser has no Web Bluetooth (Chromium only)';
		if (req.op === 'connect') await failStatus(msg);
		else await reply(req.seq, false, msg);
		return;
	}

	try {
		if (req.op === 'connect') {
			// One device per machine: a second connect lets the first go,
			// or its GATT link (and its subscriptions) would linger unseen.
			release();
			// A remembered device reconnects without the picker — but only
			// when no service was named: naming one means re-picking, since
			// the filter is also the access grant.
			if (!req.service && navigator.bluetooth.getDevices) {
				try {
					for (const d of await navigator.bluetooth.getDevices()) {
						if (!d.gatt) continue;
						try {
							await d.gatt.connect();
							adopt(d);
							return;
						} catch {
							/* gone or asleep; try the next */
						}
					}
				} catch {
					/* permissions backend absent; the picker path remains */
				}
			}
			pendingPick = { service: req.service ? String(req.service) : undefined };
			await writeStatus();
			note('ble: click the ble chip in the footer to pick a device');
		} else if (req.op === 'scan') {
			if (!req.on) {
				stopScan();
				await reply(req.seq, true);
				return;
			}
			if (!navigator.bluetooth.requestLEScan) {
				await reply(req.seq, false, FLAG_HINT);
				note('ble: scanning needs chrome://flags/#enable-experimental-web-platform-features');
				return;
			}
			if (leScan) {
				await reply(req.seq, true, 'already scanning');
				return;
			}
			pendingScan = true;
			ping();
			note('ble: click the ble chip in the footer to start the scan');
			await reply(req.seq, true, 'click the ble chip in the footer to start the scan');
		} else if (req.op === 'services') {
			await reply(req.seq, true, await listServices());
		} else if (req.op === 'read') {
			const c = await connectedChr(String(req.svc), String(req.chr));
			const v = await c.readValue();
			let text = hex(v) || '(empty)';
			// A byte run that is all printable ASCII earns a peek.
			if (v.byteLength) {
				const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
				if (bytes.every((b) => b >= 0x20 && b < 0x7f)) {
					text += `  "${new TextDecoder().decode(bytes)}"`;
				}
			}
			await reply(req.seq, true, text);
		} else if (req.op === 'write') {
			const hexStr = String(req.hex || '');
			if (!/^([0-9a-fA-F]{2})+$/.test(hexStr)) throw new Error('HEX must be full bytes');
			const c = await connectedChr(String(req.svc), String(req.chr));
			await c.writeValue(bytesOf(hexStr) as Uint8Array<ArrayBuffer>);
			await reply(req.seq, true);
		} else if (req.op === 'notify') {
			// The map is keyed by the resolved uuid, so `heart_rate` and
			// `2a37` name the same subscription in both directions.
			const c = await connectedChr(String(req.svc), String(req.chr));
			if (req.off) {
				const sub = subs.get(c.uuid);
				if (sub) {
					sub.chr.removeEventListener('characteristicvaluechanged', sub.handler);
					subs.delete(c.uuid);
					await sub.chr.stopNotifications().catch(() => {});
				}
				await reply(req.seq, true);
				return;
			}
			if (subs.has(c.uuid)) {
				await reply(req.seq, true, 'already subscribed');
				return;
			}
			const label = shortUuid(c.uuid);
			const handler = () => {
				if (c.value) pushFeed(`${label}  ${hex(c.value)}`);
			};
			c.addEventListener('characteristicvaluechanged', handler);
			await c.startNotifications();
			subs.set(c.uuid, { chr: c, handler });
			await reply(req.seq, true);
		} else if (req.op === 'disconnect') {
			stopScan();
			release();
			await writeStatus();
			await reply(req.seq, true);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (req.op === 'connect') await failStatus(msg);
		else await reply(req.seq, false, msg);
	}
}
