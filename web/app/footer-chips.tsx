/**
 * The terminal footer's device chips: real hardware wired into the machine.
 * Serial (Web Serial → /dev/ttyS2), Bluetooth (the visible end of ble(1)),
 * and the mount (a real directory ↔ /data/host). All Chromium-only, each
 * gated on its own API and invisible elsewhere.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { existingVm, sharedVm } from './vm';
import { bleChip, bleChipClick, onBleChange } from './ble';
import {
	clearHandle,
	startMount,
	storedHandle,
	storeHandle,
	type MountSession,
} from './host-mount';
import {
	Icon,
	ICON_BLUETOOTH,
	ICON_FOLDER,
	ICON_PLUG,
	ICON_VOLUME,
	ICON_VOLUME_OFF,
} from './icons';

/**
 * The footer's volume control: the page-side master gain (vm.setVolume), a
 * knob of the person's own that multiplies with the guest's vol(1) and
 * survives guest reboots. Unlike its chip neighbours this needs no Chromium
 * API, so it renders everywhere; the value persists in localStorage.
 */
const VOLUME_KEY = 'vinx.volume';

export function VolumeControl() {
	const [volume, setVolume] = useState(() => {
		const stored = Number(localStorage.getItem(VOLUME_KEY) ?? NaN);
		return Number.isFinite(stored) ? Math.max(0, Math.min(100, Math.round(stored))) : 100;
	});
	const [muted, setMuted] = useState(false);

	// Apply on every change. existingVm, pointedly: this chip's effect runs
	// before the parent Console's (children first), and sharedVm() here
	// would create the VM ahead of the caller that owns its options. A
	// volume knob must never boot the machine — it polls until someone
	// else has, and until the speaker adapter exists inside it.
	useEffect(() => {
		localStorage.setItem(VOLUME_KEY, String(volume));
		const effective = muted ? 0 : volume / 100;
		if (existingVm()?.setVolume(effective)) return;
		const timer = setInterval(() => {
			if (existingVm()?.setVolume(effective)) clearInterval(timer);
		}, 500);
		return () => clearInterval(timer);
	}, [volume, muted]);

	const off = muted || volume === 0;
	return (
		<span
			className={`vol-chip${off ? '' : ' on'}`}
			title="Page volume — the guest's own vol(1) is a separate knob"
		>
			<button
				type="button"
				className="vol-mute"
				title={muted ? 'Unmute' : 'Mute'}
				onClick={() => setMuted((m) => !m)}
			>
				<Icon d={off ? ICON_VOLUME_OFF : ICON_VOLUME} size={12} />
			</button>
			<input
				type="range"
				min={0}
				max={100}
				value={muted ? 0 : volume}
				aria-label="Volume"
				onChange={(e) => {
					setMuted(false);
					setVolume(Number(e.target.value));
				}}
			/>
		</span>
	);
}

/**
 * Why serial, ble and mount are missing, said out loud: over plain HTTP on
 * a LAN address Chromium withholds Web Serial, Web Bluetooth and the
 * directory picker entirely (secure contexts only), and three chips
 * vanishing without a word reads as a bug. Renders only where they WOULD
 * have shown — a Chromium missing all three on an insecure origin.
 */
export function SecureContextHint() {
	if (window.isSecureContext || !('chrome' in window)) return null;
	return (
		<span
			className="chip-hint"
			title={
				'Web Serial, Web Bluetooth and folder mounting exist only in secure contexts. ' +
				'Open this page on localhost or over HTTPS (npm run dev:https serves one for the LAN).'
			}
		>
			serial/ble/mount need HTTPS
		</span>
	);
}

/**
 * The footer's serial-port control: a Web Serial device wired to the guest's
 * /dev/ttyS2 (vm.attachSerial). Chromium-only, so the chip only renders where
 * `navigator.serial` exists; the picker needs a user gesture, which the
 * Connect button provides. One device per machine (per pane).
 */
const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SerialControl() {
	const [open, setOpen] = useState(false);
	const [baud, setBaud] = useState(115200);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState('');
	const detachRef = useRef<(() => Promise<void>) | null>(null);
	if (!navigator.serial) return null;

	const connect = async () => {
		try {
			const port = await navigator.serial!.requestPort();
			detachRef.current = await sharedVm().attachSerial(port, baud, () => {
				// The device went away on its own (unplugged).
				detachRef.current = null;
				setConnected(false);
			});
			setConnected(true);
			setError('');
			setOpen(false);
		} catch (e) {
			// NotFoundError is the picker's cancel button; stay quiet on it.
			if (e instanceof Error && e.name === 'NotFoundError') return;
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const disconnect = async () => {
		await detachRef.current?.();
		detachRef.current = null;
		setConnected(false);
	};

	return (
		<>
			<button
				type="button"
				className={`serial-chip${connected ? ' on' : ''}`}
				title={
					connected
						? `Serial device on /dev/ttyS2 at ${baud} baud — click to disconnect`
						: 'Connect a real serial device as /dev/ttyS2'
				}
				onClick={() => (connected ? void disconnect() : setOpen(true))}
			>
				<Icon d={ICON_PLUG} size={12} />
				{connected ? `ttyS2 @${baud}` : 'serial'}
			</button>
			{open && (
				<div className="np-backdrop" onClick={() => setOpen(false)}>
					<div className="np-panel" onClick={(e) => e.stopPropagation()}>
						<div className="np-title">Serial device → /dev/ttyS2</div>
						<div className="np-opt-d">
							Pick a serial device (USB adapter, Arduino, ESP32…) and it becomes this machine&apos;s{' '}
							<code>/dev/ttyS2</code> — try <code>microcom /dev/ttyS2</code>. The speed is set here,
							on the real port; guest-side <code>stty</code> changes are ignored.
						</div>
						<label className="serial-baud">
							Baud rate
							<select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
								{BAUDS.map((b) => (
									<option key={b} value={b}>
										{b}
									</option>
								))}
							</select>
						</label>
						{error && <div className="np-err">{error}</div>}
						<div className="np-actions">
							<button type="button" className="np-cancel" onClick={() => setOpen(false)}>
								Cancel
							</button>
							<button type="button" className="np-save" onClick={() => void connect()}>
								Choose device…
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

/**
 * The footer's Bluetooth control: the visible end of ble(1). Web Bluetooth's
 * picker (and its experimental scan) must start from a click, so a guest
 * `ble connect` parks here and the chip pulses until the person provides
 * one; clicked while idle it opens the picker directly, clicked while
 * connected it lets the device go. Chromium-only, like the serial chip.
 */
export function BleControl() {
	const [, bump] = useState(0);
	useEffect(() => onBleChange(() => bump((v) => v + 1)), []);
	if (!navigator.bluetooth) return null;
	const chip = bleChip();
	const cls = chip.state === 'connected' ? ' on' : chip.state === 'pending' ? ' pending' : '';
	return (
		<button
			type="button"
			className={`ble-chip${cls}`}
			title={
				chip.state === 'connected'
					? `${chip.device} connected — click to disconnect`
					: chip.state === 'pending'
						? 'The guest asked for Bluetooth — click to continue'
						: 'Connect a Bluetooth (BLE) device — ble(1) in the guest speaks to it'
			}
			onClick={() => void bleChipClick()}
		>
			<Icon d={ICON_BLUETOOTH} size={12} />
			{chip.state === 'connected' ? chip.device : 'ble'}
		</button>
	);
}

/**
 * The footer's mount control: a real directory from the person's disk, synced
 * both ways with the guest's /data/host (host-mount.ts). Chromium-only —
 * `showDirectoryPicker` is the feature gate. The handle survives reloads in
 * IndexedDB but its permission does not, so after a reload the chip shows the
 * remembered name dimmed and one click re-asks.
 */
export function MountControl({ note }: { note: (msg: string) => void }) {
	// 'none': nothing mounted. 'stored': a remembered handle awaiting its
	// permission click. 'on': syncing.
	const [state, setState] = useState<'none' | 'stored' | 'on'>('none');
	const [dirName, setDirName] = useState('');
	const session = useRef<MountSession | null>(null);
	const handleRef = useRef<FileSystemDirectoryHandle | null>(null);

	const begin = useCallback(
		(handle: FileSystemDirectoryHandle) => {
			session.current?.stop();
			handleRef.current = handle;
			session.current = startMount(sharedVm(), handle, note);
			setDirName(handle.name || 'folder');
			setState('on');
		},
		[note],
	);

	useEffect(() => {
		if (!window.showDirectoryPicker) return;
		let cancelled = false;
		void storedHandle().then(async (handle) => {
			if (cancelled || !handle) return;
			// OPFS-style handles have no queryPermission and need none.
			const perm = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
			if (cancelled) return;
			if (perm === 'granted') begin(handle);
			else {
				handleRef.current = handle;
				setDirName(handle.name || 'folder');
				setState('stored');
			}
		});
		// The E2E hook: tests mount an OPFS directory, which no picker can
		// reach and no permission guards, by throwing its handle over the
		// fence.
		const testMount = (e: Event) => begin((e as CustomEvent).detail as FileSystemDirectoryHandle);
		window.addEventListener('vinx:mount', testMount);
		return () => {
			cancelled = true;
			window.removeEventListener('vinx:mount', testMount);
			session.current?.stop();
			session.current = null;
		};
	}, [begin]);

	if (!window.showDirectoryPicker) return null;

	const click = async () => {
		if (state === 'on') {
			// Unmount: stop the sync and forget the handle. The guest keeps
			// its /data/host copy until the reload wipes RAM.
			session.current?.stop();
			session.current = null;
			await clearHandle();
			setState('none');
			return;
		}
		if (state === 'stored' && handleRef.current) {
			const perm = await handleRef.current.requestPermission?.({
				mode: 'readwrite',
			});
			if (perm === 'granted') begin(handleRef.current);
			else note('mount: permission was not granted');
			return;
		}
		try {
			const handle = await window.showDirectoryPicker!({ mode: 'readwrite' });
			await storeHandle(handle).catch(() => {});
			begin(handle);
		} catch (e) {
			// AbortError is the picker's cancel button; stay quiet on it.
			if (e instanceof Error && e.name === 'AbortError') return;
			note(`mount: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	return (
		<button
			type="button"
			className={`mount-chip${state === 'on' ? ' on' : ''}`}
			title={
				state === 'on'
					? `${dirName} ↔ /data/host — click to unmount`
					: state === 'stored'
						? `Reconnect ${dirName} as /data/host (the browser asks once per session)`
						: 'Mount a real folder as /data/host, synced both ways'
			}
			onClick={() => void click()}
		>
			<Icon d={ICON_FOLDER} size={12} />
			{state === 'none' ? 'mount' : dirName}
		</button>
	);
}
