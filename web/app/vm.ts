/**
 * The Linux in the page.
 *
 * v86 boots the Buildroot images from `public/vm/` — an i686 kernel and a
 * busybox initramfs — entirely inside this tab. Three serial lines leave it:
 *
 *   ttyS0  the person's console. Raw bytes both ways; the terminal page
 *          attaches xterm.js to `onConsole` / `sendConsole`.
 *   ttyS1  agentd, the command channel behind the `run_shell` tool. A line
 *          protocol (`RUN` out, `DONE` back, payloads base64) documented in
 *          linux/external/board/vinx/rootfs-overlay/usr/sbin/agentd.
 *   ttyS2  a real serial device, when the person plugs one in: `attachSerial`
 *          pumps bytes between a Web Serial port and the guest's third UART.
 *   ttyS3  hostcall, the guest-initiated mirror of ttyS1: the js(1) and
 *          fetch(1) CLIs send `CALL` lines and this page answers `DONE` —
 *          protocol and executors in app/hostcall.ts.
 *
 * One request at a time on ttyS1 — agentd is a `while read` loop — so
 * `runShell` queues. The console is not queued behind anything: keystrokes go
 * straight to the UART. ttyS3 needs no queue here: the guest side serialises
 * callers with a lock, and replies are id-matched anyway.
 *
 * The VM is optional equipment: `boot()` failing (images not built, wasm
 * refused) leaves the page a chat client, the same stance mount() takes for a
 * device that does not answer.
 */

// v86 (and its `?url` wasm asset) is imported dynamically inside boot(), not
// at module load: the chat page constructs a VinxVm eagerly but only boots
// it on the first run_shell, so a conversation that never runs a command never
// pays for v86's ~140 KB of JS or fetches its ~900 KB wasm. Type-only import
// here keeps the field typed without pulling the module into this chunk.
import type { V86 as V86Type } from 'v86';

import type { ShellDevice } from '../runtime/src/device-vm';
import { answerHostcall, buildDoneLine, parseCallLine } from './hostcall';
import { machineId } from './pane-id';
import { attachSharePersistence } from './share-store';
import { dropSnapshot, loadSnapshot, saveSnapshot } from './vm-snapshot';

export type VmState = 'off' | 'booting' | 'ready' | 'failed';
export type RelayHealth = 'connecting' | 'ok' | 'down' | null;

/** Where a boot currently is, for a UI that wants to say more than
 * "booting": image download, kernel+userland execution, or snapshot
 * restore. `fraction` spans the whole boot, 0..1, and never moves
 * backwards — even across a failed restore falling back to a cold boot.
 * 'ready' still arrives via onState. */
export interface BootProgress {
	phase: 'download' | 'kernel' | 'restore';
	fraction: number;
}

/**
 * Byte weights for everything a cold boot fetches, in fetch order: v86
 * reports per-file progress (v86.wasm through its own emitter with
 * file_count:1, then the four images with file_count:4), so a bar built on
 * file counts fills up and resets — and equal weights would hand the two
 * BIOSes (0.8% of the bytes) half the bar. Weighing by bytes instead makes
 * one honest, monotonic number. The sizes are weights, not checksums:
 * refresh them when an image changes materially, staleness only skews the
 * bar a little.
 */
const BOOT_DOWNLOADS = [
	{ key: 'wasm', re: /v86\.wasm/, bytes: 2_096_474 },
	{ key: 'bios', re: /seabios\.bin/, bytes: 131_072 },
	{ key: 'vgabios', re: /vgabios\.bin/, bytes: 36_352 },
	{ key: 'kernel', re: /bzImage/, bytes: 9_085_440 },
	{ key: 'rootfs', re: /rootfs\.img/, bytes: 13_002_658 },
] as const;
const BOOT_BYTES_TOTAL = BOOT_DOWNLOADS.reduce((sum, d) => sum + d.bytes, 0);

/** The download leg's share of the overall bar; the emulated boot fills
 * the rest. Downloads dominate a first visit (tens of MB), the boot is
 * 1-2s — but the boot is the part with no bytes to count, so it gets a
 * visible slice walked by the milestones below. */
const DOWNLOAD_SHARE = 0.85;

/**
 * Stable console lines between the first kernel byte and READY, in boot
 * order — all from userspace (loglevel=4 keeps the kernel's own chatter
 * off ttyS0): busybox rcS service lines, then the login banner. Matched
 * as substrings; 'Starting network' deliberately omits the OK so a FAIL
 * (no NIC configured) still advances the bar.
 */
const KERNEL_MILESTONES = [
	'Seeding ',
	'Starting syslogd: ',
	'Running sysctl: ',
	'Starting network: ',
	'Starting crond: ',
	'vinx linux',
] as const;

export interface VmOptions {
	/** Where the images live; default is the site's own `vm/` directory. */
	assetsBase?: string;
	memoryMb?: number;
	/**
	 * v86 network backend, handed to `net_device.relay_url`: `inbrowser`
	 * (default) is a server-less L2 hub shared by same-origin VMs — they can
	 * talk to each other but not the internet; `fetch` replays outbound HTTP
	 * as browser fetch(); a `wisp(s)://`/`ws(s)://` URL is a real-TCP relay.
	 * Empty string disables networking entirely. See app/vm-config.ts.
	 */
	networkRelay?: string;
}

export interface RunResult {
	exit_code: number;
	/** stdout+stderr combined, as agentd captured it (64 KiB cap). */
	output: string;
}

interface QueuedRun {
	command: string;
	timeoutS: number;
	resolve: (r: RunResult) => void;
	reject: (e: Error) => void;
}

/** How long past the guest-side timeout to wait before declaring agentd gone. */
const CHANNEL_GRACE_MS = 10_000;
/**
 * Booting means kernel + userland + agentd's READY, all emulated. Uncontended
 * this is ~1-2s; the generous ceiling covers a first boot that races a busy
 * engine worker (which starves the main-thread emulator) on a slow machine.
 * Pages pre-boot at load to keep that race off the critical path anyway.
 */
const BOOT_TIMEOUT_MS = 180_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(text: string): string {
	const bytes = encoder.encode(text);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function fromBase64(b64: string): string {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return decoder.decode(bytes);
}

/** The `vinx.net=` cmdline token: the guest's one word for which network
 * story this boot lives in (see profile.d/netinfo.sh in the overlay). */
function netMode(relay: string): string {
	if (!relay) return 'none';
	if (relay === 'inbrowser') return 'hub';
	if (relay === 'fetch') return 'fetch';
	return /^wisps?:\/\//i.test(relay) ? 'wisp' : 'wsproxy';
}

export class VinxVm implements ShellDevice {
	readonly options: Required<VmOptions>;

	private emulator: V86Type | null = null;
	private state: VmState = 'off';
	private booting: Promise<void> | null = null;
	private stateListeners = new Set<(s: VmState) => void>();
	private progressListeners = new Set<(p: BootProgress) => void>();
	private sawKernelOutput = false;
	/** The monotonic boot fraction (see emitProgress) and its inputs:
	 * max bytes seen per download, milestones passed, current console line. */
	private bootFraction = 0;
	private downloadedBytes = new Map<string, number>();
	private milestoneHit = 0;
	private milestoneLine = '';
	/** Why the last boot failed, kept for the failure card (the rejection
	 * itself goes to whoever awaited boot(), but the veil UI watches state
	 * changes and needs the reason after the fact). */
	private lastBootError: string | null = null;
	/** The one attempt at the machine-name lock; see claimIdentity. */
	private identityClaim: Promise<boolean> | null = null;

	// ── ttyS0, the console ──
	private consoleListeners = new Set<(bytes: Uint8Array) => void>();
	/** Bytes arrive one listener call per byte; they are coalesced per task. */
	private consoleBuffer: number[] = [];
	private consoleFlushQueued = false;

	// ── ttyS1, agentd ──
	private channelLine = '';
	private channelReady: Promise<void>;
	private channelReadySettle!: () => void;
	private queue: QueuedRun[] = [];
	private inFlight: {
		id: number;
		run: QueuedRun;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	/** Random base, not 1: a restored snapshot may hold a stale DONE from a
	 * command the *previous* page had in flight at save time, and small ids
	 * restart from the same place every load. */
	private nextRunId = 1 + Math.floor(Math.random() * 1_000_000);

	// ── ttyS2, the pass-through serial port ──
	private serialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private serialBuffer: number[] = [];
	private serialFlushQueued = false;
	private serialDetach: (() => Promise<void>) | null = null;

	// ── ttyS3, hostcall ──
	private hostcallLine = '';

	// ── the VGA head ──
	/**
	 * v86's screen adapter renders into this detached element (it creates
	 * its own canvas and text-mode div inside). Detached because the screen
	 * is optional equipment: the terminal's screen panel adopts the element
	 * when opened and orphans it again when closed — the adapter keeps
	 * painting either way.
	 */
	private screenDiv: HTMLElement | null = null;

	constructor(options: VmOptions = {}) {
		// Anchored on this module's own URL, not the document's: the chat page
		// lives at the site root but the terminal is `/terminal/`, and a
		// document-relative `vm/` would resolve to `/terminal/vm/` there. In
		// the production build this module lands in `assets/`, which sits
		// beside `vm/` under the deploy root at every page depth. The dev
		// server is a different geography: this module is imported through
		// the runtime (outside the vite root), so its URL is the /@fs/
		// filesystem namespace, where `../vm/` names a directory that does
		// not exist — and every image request gets the HTML fallback page.
		// Dev always serves the site at the server root, so the public
		// directory is plain `/vm/` there.
		const base =
			options.assetsBase ??
			(import.meta.env.DEV ? '/vm/' : new URL('../vm/', import.meta.url).href);
		this.options = {
			assetsBase: base.endsWith('/') ? base : `${base}/`,
			memoryMb: options.memoryMb ?? 128,
			networkRelay: options.networkRelay ?? 'inbrowser',
		};
		this.channelReady = new Promise((resolve) => {
			this.channelReadySettle = resolve;
		});
		// Created eagerly so a screen panel opened before boot() still has an
		// element to adopt; v86 fills it in when the emulator starts.
		if (typeof document !== 'undefined') {
			this.screenDiv = document.createElement('div');
			this.screenDiv.className = 'vga-screen';
		}
	}

	getState(): VmState {
		return this.state;
	}

	/** The browser-side WebSocket behind a relay-backed NIC. v86 deliberately
	 * swallows socket errors and retries every ten seconds; exposing the small
	 * readyState here lets the page tell the person instead of failing silently.
	 * Non-relay backends have no remote connection to report. */
	relayHealth(): RelayHealth {
		const relay = this.options.networkRelay;
		const isWisp = /^wisps?:\/\//i.test(relay);
		if (!isWisp && !/^wss?:\/\//i.test(relay)) return null;
		if (this.state === 'failed') return 'down';
		const adapter = (
			this.emulator as unknown as {
				network_adapter?: {
					socket?: WebSocket;
					wispws?: WebSocket;
				};
			} | null
		)?.network_adapter;
		const socket = isWisp ? adapter?.wispws : adapter?.socket;
		if (!socket) return 'connecting';
		if (socket.readyState === WebSocket.OPEN) return 'ok';
		if (socket.readyState === WebSocket.CONNECTING) return 'connecting';
		return 'down';
	}

	/** Observe state changes; fires immediately with the current state. */
	onState(listener: (s: VmState) => void): () => void {
		this.stateListeners.add(listener);
		listener(this.state);
		return () => this.stateListeners.delete(listener);
	}

	/** Observe boot progress (see BootProgress). Only fires while booting. */
	onBootProgress(listener: (p: BootProgress) => void): () => void {
		this.progressListeners.add(listener);
		return () => this.progressListeners.delete(listener);
	}

	/** The one gate every progress signal passes: clamps to 0..1, never
	 * lets the number move backwards (a restore that falls back to a cold
	 * boot re-reports cached downloads from zero), and mirrors it onto the
	 * document for tests and status displays. */
	private emitProgress(phase: BootProgress['phase'], fraction: number) {
		const f = Math.max(this.bootFraction, Math.min(1, fraction));
		this.bootFraction = f;
		if (typeof document !== 'undefined')
			document.documentElement.dataset.vmBootProgress = f.toFixed(3);
		for (const l of this.progressListeners) l({ phase, fraction: f });
	}

	/** Feed one console byte to the milestone matcher: rcS's service lines
	 * and the banner walk the bar through the emulated boot, the leg with
	 * no bytes to count. Lines only — a match mid-line waits for its \n,
	 * which at console speed is the same moment. */
	private trackMilestone(byte: number) {
		if (byte === 0x0a || byte === 0x0d) {
			const line = this.milestoneLine;
			this.milestoneLine = '';
			// Scan from the far end: a missed line (format drift) must not
			// wedge the ladder, later milestones still advance it.
			for (let i = KERNEL_MILESTONES.length - 1; i >= this.milestoneHit; i--) {
				if (!line.includes(KERNEL_MILESTONES[i])) continue;
				this.milestoneHit = i + 1;
				// +1 in the denominator keeps the last milestone short of
				// 100%; only READY (via start()) completes the bar.
				this.emitProgress(
					'kernel',
					DOWNLOAD_SHARE +
						(1 - DOWNLOAD_SHARE) * (this.milestoneHit / (KERNEL_MILESTONES.length + 1)),
				);
				break;
			}
		} else if (byte >= 0x20 && byte < 0x7f && this.milestoneLine.length < 300) {
			this.milestoneLine += String.fromCharCode(byte);
		}
	}

	private setState(s: VmState) {
		if (this.state === s) return;
		this.state = s;
		// Reflect onto the document so a status indicator (or a test) can see
		// the VM come up without subscribing. Harmless where there is no DOM.
		if (typeof document !== 'undefined') document.documentElement.dataset.vmState = s;
		for (const l of this.stateListeners) l(s);
	}

	/**
	 * Start the VM. Idempotent: every caller gets the same boot.
	 *
	 * Resolves when agentd has said READY on ttyS1, which is after rcS — by
	 * then the console shell on ttyS0 is up too.
	 */
	boot(): Promise<void> {
		if (!this.booting) this.booting = this.start();
		return this.booting;
	}

	/** Whether this boot may use the snapshot cache. Relay-backed networks
	 * stay out: a restored guest would keep a DHCP lease and connection
	 * state the relay has long forgotten, and "fast boot into a broken
	 * network" is worse than a cold boot. The in-browser hub is stateless
	 * on the wire, fetch replays per-request, and no-network has nothing
	 * to go stale. Dev never snapshots: __APP_VERSION__ does not change
	 * between local rootfs rebuilds, so a stale snapshot would keep waking
	 * yesterday's image and a freshly built rootfs would never boot. */
	private snapshotable(): boolean {
		if (import.meta.env.DEV) return false;
		return ['inbrowser', 'fetch', ''].includes(this.options.networkRelay);
	}

	/**
	 * Claim this machine's name, origin-wide, for the life of this document.
	 *
	 * Snapshots are keyed by machineId(), and two browser tabs both play
	 * pane 1: restoring the same image in both would put two NICs with the
	 * same MAC — and the same MAC-derived 10.0.2.x address — on one
	 * in-browser hub, and "open another terminal tab to network two VMs"
	 * (the boot banner's own promise) would stop working. So only the tab
	 * holding the lock may restore or save; a loser cold-boots into a fresh
	 * random MAC, exactly what made two tabs interoperable before snapshots.
	 *
	 * The lock is never released by code — the browser drops it when the
	 * document dies (reload included), which is precisely the lifetime of
	 * the machine. No Web Locks (an http:// LAN origin is not a secure
	 * context) means no arbiter, and the old restore-always behaviour.
	 */
	private claimIdentity(): Promise<boolean> {
		this.identityClaim ??=
			typeof navigator === 'undefined' || !navigator.locks
				? Promise.resolve(true)
				: new Promise((resolve) => {
						navigator.locks
							.request(`vinx.vm.machine.${machineId()}`, { ifAvailable: true }, (lock) => {
								resolve(lock !== null);
								// Returning a pending promise is how a lock is held.
								return lock ? new Promise<never>(() => {}) : undefined;
							})
							.catch(() => resolve(true));
					});
		return this.identityClaim;
	}

	/** What a snapshot must match to be trusted: the app version (agentd
	 * protocol, rootfs contents), the exact network option and the memory
	 * size — v86 requires identical construction, and the cmdline's
	 * vinx.net token bakes the mode into the guest. */
	private snapshotStamp(): string {
		return `${__APP_VERSION__}|${this.options.networkRelay}|${this.options.memoryMb}`;
	}

	/** The reason the machine is in 'failed', or null outside that state. */
	bootError(): string | null {
		return this.state === 'failed' ? this.lastBootError : null;
	}

	private async start(): Promise<void> {
		this.setState('booting');
		this.sawKernelOutput = false;
		this.lastBootError = null;
		// A retry after 'failed' is a fresh boot: the bar starts over.
		this.bootFraction = 0;
		this.downloadedBytes.clear();
		this.milestoneHit = 0;
		this.milestoneLine = '';
		try {
			// Fetched now, on first boot, not at page load; see the import note.
			const [{ V86 }, { default: v86WasmUrl }] = await Promise.all([
				import('v86'),
				import('v86/build/v86.wasm?url'),
			]);
			let how: 'cold' | 'restored' = 'cold';
			if (this.snapshotable() && (await this.claimIdentity())) {
				const saved = await loadSnapshot(machineId(), this.snapshotStamp());
				if (saved) {
					this.emitProgress('restore', 0.05);
					if (await this.tryRestore(V86, v86WasmUrl, saved)) how = 'restored';
					// A snapshot that failed once will fail every time —
					// forget it rather than stall every boot on it.
					else await dropSnapshot(machineId());
				}
			}
			if (how === 'cold') {
				this.construct(V86, v86WasmUrl, null);
				await this.channelUp();
			}
			// Observability for tests and the curious: which path booted us.
			if (typeof document !== 'undefined') document.documentElement.dataset.vmBoot = how;
			// READY is the finish line, whatever legs led to it.
			this.emitProgress(how === 'restored' ? 'restore' : 'kernel', 1);
			this.setState('ready');
			if (how === 'cold') this.scheduleSnapshotSave();
		} catch (e) {
			// Recorded before setState so a listener reacting to 'failed' can
			// already read the reason.
			this.lastBootError = e instanceof Error ? e.message : String(e);
			this.setState('failed');
			this.emulator?.destroy();
			this.emulator = null;
			// Let a later call try again rather than caching this rejection
			// forever: a transient hiccup (a slow wasm fetch) should not wedge
			// the VM until a reload. A permanent failure (missing images) still
			// fails fast on the next attempt, so this does not spin.
			this.booting = null;
			throw e instanceof Error ? e : new Error(String(e));
		}
	}

	/** Build the emulator and wire every listener. Identical construction on
	 * both paths (v86 requires it for state restore); the restore path adds
	 * `initial_state`, which wins over the freshly loaded kernel image once
	 * applied — those image fetches come out of the HTTP cache that the
	 * cold boot which saved the snapshot already filled. */
	private construct(
		V86: (typeof import('v86'))['V86'],
		v86WasmUrl: string,
		initialState: ArrayBuffer | null,
	): void {
		const base = this.options.assetsBase;
		const emulator = new V86({
			wasm_path: v86WasmUrl,
			memory_size: this.options.memoryMb * 1024 * 1024,
			// Enough VRAM for the Bochs display's 1024x768x32 (3 MB) with
			// headroom; at the old 2 MB the DRM driver would have had to
			// pick a smaller mode.
			vga_memory_size: 8 * 1024 * 1024,
			// The VGA head. Rendering into a detached div costs nothing
			// visible until the terminal's screen panel adopts it.
			screen_container: this.screenDiv,
			// The images carry the page's version as a cache-buster: their
			// filenames are not content-hashed like the JS bundles, and a
			// stale cached rootfs under a new page would speak yesterday's
			// agentd protocol. One query string keeps them in step.
			// rootfs.img is a gzipped cpio under a neutral name: a .gz
			// extension makes static servers (vite's sirv among them) add
			// Content-Encoding: gzip, the browser then decompresses in
			// flight, and the kernel gets a ~3x initrd it cannot unpack in
			// 128 MB. The kernel sniffs the compression, the name is free.
			bios: { url: `${base}seabios.bin?v=${__APP_VERSION__}` },
			vga_bios: { url: `${base}vgabios.bin?v=${__APP_VERSION__}` },
			bzimage: { url: `${base}bzImage?v=${__APP_VERSION__}` },
			initrd: { url: `${base}rootfs.img?v=${__APP_VERSION__}` },
			// tsc=reliable and friends are what v86's own Linux profiles
			// use: the emulated TSC fails the kernel's stability checks and
			// costs boot time when distrusted. loglevel=4 keeps warnings
			// like "hrtimer: interrupt took Nms" (the emulator stalling on
			// a busy main thread, harmless) off the console; they stay in
			// dmesg, and actual errors still print. The snd_sb16 knobs aim
			// the driver at v86's SB16: isapnp=0 because the emulated card
			// is legacy ISA (with PnP compiled in, the driver would wait
			// for a PnP announcement that never comes), the rest are the
			// resources v86 wires it to.
			// vinx.net tells the guest which network story it woke up in
			// (the kernel ignores unknown tokens; profile.d/netinfo.sh
			// reads it from /proc/cmdline and prints the right hints —
			// the 10.0.2.x advice is a lie on a wsproxy relay).
			// rootfstype=ramfs: without it the kernel mounts rootfs as
			// tmpfs capped at half the early-boot RAM (~40 MB here), and
			// unpacking today's ~35 MB initramfs plus per-file overhead
			// dies at "Initramfs unpacking failed: write error" with the
			// tail of /usr silently missing. ramfs has no cap; /tmp keeps
			// its own tmpfs limit and /data its 9p quota, so the only new
			// way to fill RAM is writing into / itself.
			cmdline:
				'console=ttyS0,115200n8 loglevel=4 tsc=reliable mitigations=off random.trust_cpu=on ' +
				'rootfstype=ramfs ' +
				'snd_sb16.isapnp=0 snd_sb16.port=0x220 snd_sb16.irq=5 snd_sb16.dma8=1 snd_sb16.dma16=5 ' +
				`vinx.net=${netMode(this.options.networkRelay)}`,
			// ttyS1 for agentd; ttyS2 for the Web Serial pass-through
			// (attachSerial); ttyS3 for hostcall. ttyS0 always exists.
			uart1: true,
			uart2: true,
			uart3: true,
			// The page owns keyboard and mouse; without these v86 grabs
			// document-level input events and the terminal fights its own VM.
			disable_keyboard: true,
			disable_mouse: true,
			// The speaker stays on: v86 emulates a SoundBlaster 16 and a PC
			// speaker through an AudioContext, so `cat x.wav > /dev/dsp`
			// in the guest is audible. The context starts suspended under
			// the autoplay policy; the first gesture resumes it (below).
			net_device: this.options.networkRelay
				? { type: 'virtio', relay_url: this.options.networkRelay }
				: undefined,
			// An empty 9p filesystem, mounted by the guest at /data (see
			// the overlay's inittab): the page's side of drag-and-drop
			// uploads and of reload-persistence (share-store.ts).
			filesystem: {},
			autostart: true,
			// The snapshot, when there is one: applied after the images load,
			// it wins over the fresh kernel. The MAC must ride along — the
			// guest derived its hub address from it at boot and will not
			// redo DHCP for a card it never saw disappear; snapshots are
			// per-machine (see vm-snapshot.ts), so no two panes share one.
			...(initialState
				? { initial_state: { buffer: initialState }, preserve_mac_from_state_image: true }
				: {}),
		});
		this.emulator = emulator;

		emulator.add_listener('download-progress', (p) => {
			// One monotonic number out of v86's two progress emitters (see
			// BOOT_DOWNLOADS): identify the file by name, weight by bytes.
			if (this.state !== 'booting' || initialState) return;
			const name = String(p.file_name ?? '');
			const idx = BOOT_DOWNLOADS.findIndex((d) => d.re.test(name));
			if (idx < 0) return;
			// Fetches are strictly sequential: a later file reporting at all
			// means every earlier one has fully landed (its final progress
			// event is not guaranteed to say loaded === total).
			for (let i = 0; i < idx; i++)
				this.downloadedBytes.set(BOOT_DOWNLOADS[i].key, BOOT_DOWNLOADS[i].bytes);
			const entry = BOOT_DOWNLOADS[idx];
			const done = p.lengthComputable && p.total ? Math.min(1, p.loaded / p.total) : 0;
			this.downloadedBytes.set(
				entry.key,
				Math.max(this.downloadedBytes.get(entry.key) ?? 0, done * entry.bytes),
			);
			let sum = 0;
			for (const b of this.downloadedBytes.values()) sum += b;
			this.emitProgress('download', (sum / BOOT_BYTES_TOTAL) * DOWNLOAD_SHARE);
		});
		emulator.add_listener('serial0-output-byte', (byte: number) => {
			// The first console byte is the kernel talking: downloads over,
			// emulated boot running.
			if (!this.sawKernelOutput) {
				this.sawKernelOutput = true;
				if (this.state === 'booting' && !initialState) this.emitProgress('kernel', DOWNLOAD_SHARE);
			}
			// The boot milestones ride the same byte stream (cold boots
			// only: a restored guest went through rcS in another life).
			if (
				this.state === 'booting' &&
				!initialState &&
				this.milestoneHit < KERNEL_MILESTONES.length
			)
				this.trackMilestone(byte);
			this.consoleBuffer.push(byte);
			if (!this.consoleFlushQueued) {
				this.consoleFlushQueued = true;
				queueMicrotask(() => this.flushConsole());
			}
		});
		emulator.add_listener('serial1-output-byte', (byte: number) => {
			this.onChannelByte(byte);
		});
		emulator.add_listener('serial2-output-byte', (byte: number) => {
			// Nothing attached: the guest is talking to a dangling wire,
			// exactly like real hardware, and the bytes fall on the floor.
			if (!this.serialWriter) return;
			this.serialBuffer.push(byte);
			if (!this.serialFlushQueued) {
				this.serialFlushQueued = true;
				queueMicrotask(() => this.flushSerial());
			}
		});
		emulator.add_listener('serial3-output-byte', (byte: number) => {
			this.onHostcallByte(byte);
		});
		// Without this, the guest has no /dev/ttyS3 at all — see the method.
		this.patchUart3Loopback();
	}

	/**
	 * Wake a saved machine instead of booting one. The restored guest said
	 * READY ages ago and will not say it again, so liveness is proven with
	 * one round-trip over ttyS1 — a probe that also does the housekeeping a
	 * wake-up needs: the guest's clock still shows save time, and /data
	 * still holds the files of that moment, which must yield to the mirror
	 * restore (share-store) that runs at 'ready', exactly as it does after
	 * a cold boot. Any failure tears the emulator down and reports false;
	 * the caller cold-boots.
	 */
	private async tryRestore(
		V86: (typeof import('v86'))['V86'],
		v86WasmUrl: string,
		state: ArrayBuffer,
	): Promise<boolean> {
		try {
			this.construct(V86, v86WasmUrl, state);
			// Serial bytes sent before the devices exist fall on the floor.
			// 'emulator-loaded' fires once v86 has applied the state image and
			// called run() — only after that can agentd hear the probe.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error('the restored emulator never started')),
					30_000,
				);
				this.emulator?.add_listener('emulator-loaded', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			// The state image is applied and running; the liveness probe is
			// all that separates this from ready.
			this.emitProgress('restore', 0.6);
			const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
			const probe = await this.enqueueRun(
				`date -u -s '${now}' >/dev/null 2>&1; ` +
					'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; echo awake',
				20,
			);
			if (probe.exit_code !== 0 || !probe.output.includes('awake')) return this.abandonRestore();
			// The console shell of the saved session is still logged in and
			// silent; a bare newline makes it print a prompt so the fresh
			// xterm is not a blank stare.
			this.sendConsole('\r');
			return true;
		} catch {
			return this.abandonRestore();
		}
	}

	private abandonRestore(): false {
		this.emulator?.destroy();
		this.emulator = null;
		if (this.inFlight) {
			clearTimeout(this.inFlight.timer);
			this.inFlight.run.reject(new Error('the snapshot did not wake up'));
			this.inFlight = null;
		}
		for (const run of this.queue.splice(0)) run.reject(new Error('the snapshot did not wake up'));
		this.channelLine = '';
		this.hostcallLine = '';
		return false;
	}

	/**
	 * Save this boot for next time, once things go quiet: ~10 s after ready
	 * the mirror restore and the login banner are long done, and the machine
	 * is a freshly booted idle system — which is exactly the state worth
	 * replaying. /data content rides along in the state image but is wiped
	 * again on restore (see tryRestore), so the mirror stays the one source
	 * of truth. Best-effort: a failed save costs the next boot nothing but
	 * the time a cold boot always cost.
	 */
	private scheduleSnapshotSave() {
		if (!this.snapshotable() || typeof indexedDB === 'undefined') return;
		setTimeout(async () => {
			if (this.state !== 'ready' || !this.emulator) return;
			// A tab that lost the identity claim must not save either: it
			// would overwrite the winner's snapshot with its own MAC.
			if (!(await this.claimIdentity())) return;
			try {
				const state = await this.emulator.save_state();
				await saveSnapshot(machineId(), this.snapshotStamp(), state);
			} catch {
				/* see above: best-effort */
			}
		}, 10_000);
	}

	private async channelUp(): Promise<void> {
		let timer: ReturnType<typeof setTimeout>;
		await Promise.race([
			this.channelReady,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('the VM did not finish booting (no READY from agentd)')),
					BOOT_TIMEOUT_MS,
				);
			}),
		]).finally(() => clearTimeout(timer));
	}

	// ── ttyS0 ──

	/** Console output. Returns an unsubscribe; bytes are raw UART traffic. */
	onConsole(listener: (bytes: Uint8Array) => void): () => void {
		this.consoleListeners.add(listener);
		return () => this.consoleListeners.delete(listener);
	}

	/** Keystrokes for the console, exactly as xterm reports them. */
	sendConsole(data: string) {
		// Not `serial0_send`: that walks UTF-16 code units and feeds each
		// low byte to the UART, mangling anything beyond ASCII (U+4E2D would
		// arrive as 0x2D). Encode to UTF-8 like the ttyS1 channel does.
		this.emulator?.serial_send_bytes(0, encoder.encode(data));
	}

	/**
	 * One key into the emulated PS/2 keyboard. `disable_keyboard` above only
	 * suppresses v86's document-level adapter -- the 8042 is still there, and
	 * `keyboard_send_scancodes` feeds it straight over the bus. That is what
	 * lets the screen panel type into the guest when focused (a game reading
	 * /dev/input gets real press *and* release) while keys everywhere else
	 * stay the page's.
	 *
	 * `code` is a set-1 make code; extended keys carry their 0xE0 prefix in
	 * the high byte (ArrowUp = 0xe048). `down: false` sends the break code.
	 */
	sendKey(code: number, down: boolean) {
		const codes =
			code > 0xff
				? [code >> 8, down ? code & 0xff : (code & 0xff) | 0x80]
				: [down ? code : code | 0x80];
		void this.emulator?.keyboard_send_scancodes(codes);
	}

	/** The bus behind v86's public API — the same internal reach as
	 * startScreenRefresh and patchUart3Loopback, here for the mouse
	 * messages the 8042 registers but no public method exposes. */
	private busSend(name: string, value: unknown) {
		(
			this.emulator as unknown as {
				bus?: { send: (name: string, value: unknown) => void };
			} | null
		)?.bus?.send(name, value);
	}

	/**
	 * Pointer input into the emulated PS/2 mouse. `disable_mouse` above only
	 * suppresses v86's document-level adapter — the 8042's AUX port is still
	 * there, and these bus messages feed it the packets the guest's psmouse
	 * driver turns into /dev/input events (evdev for LVGL, /dev/input/mice
	 * for anything speaking raw PS/2). The screen panel calls this with
	 * deltas scaled to guest pixels, so pointer travel maps 1:1 onto the
	 * guest's screen no matter how the panel is zoomed.
	 *
	 * dy is negated on the wire: screen coordinates grow downward, PS/2
	 * movement counts up — the same flip v86's own adapter does.
	 */
	sendMouseDelta(dx: number, dy: number) {
		this.busSend('mouse-delta', [dx, -dy]);
	}

	sendMouseButtons(left: boolean, middle: boolean, right: boolean) {
		this.busSend('mouse-click', [left, middle, right]);
	}

	/** One wheel step; `up` scrolls content up (wheel away from the hand). */
	sendMouseWheel(up: boolean) {
		this.busSend('mouse-wheel', [up ? 1 : -1, 0]);
	}

	private flushConsole() {
		this.consoleFlushQueued = false;
		if (!this.consoleBuffer.length) return;
		const bytes = new Uint8Array(this.consoleBuffer);
		this.consoleBuffer = [];
		for (const l of this.consoleListeners) l(bytes);
	}

	/**
	 * Tell the guest the console's size. A serial line carries no TIOCSWINSZ,
	 * so this is an `stty` run over the command channel; fire-and-forget
	 * because a lost resize is a cosmetic problem.
	 */
	setConsoleSize(cols: number, rows: number) {
		const c = Math.max(2, Math.floor(cols));
		const r = Math.max(2, Math.floor(rows));
		this.runShell(`stty -F /dev/ttyS0 cols ${c} rows ${r}`, 5).catch(() => {});
	}

	// ── the VGA head ──

	/**
	 * The element v86 paints the VGA screen into: a canvas once the guest
	 * sets a graphics mode (fbcon does at boot), the text-mode div before
	 * that. The caller may append it anywhere and orphan it again; there is
	 * exactly one, shared, because there is exactly one screen.
	 */
	getScreen(): HTMLElement | null {
		return this.screenDiv;
	}

	/**
	 * Observe the guest's graphical mode. This v86 build sends no bus event
	 * when the guest changes the display mode; the one observable trace is
	 * its screen adapter resizing the canvas inside screenDiv, and `width`
	 * on a canvas is a reflected attribute a MutationObserver can watch —
	 * panel adopted or not (a detached tree mutates all the same). Fires
	 * once with the current mode when a canvas already exists.
	 */
	onScreenModeChange(listener: (w: number, h: number) => void): () => void {
		const div = this.screenDiv;
		if (!div) return () => {};
		let lastW = 0;
		let lastH = 0;
		const report = () => {
			const canvas = div.querySelector('canvas');
			if (!canvas || !canvas.width) return;
			if (canvas.width === lastW && canvas.height === lastH) return;
			lastW = canvas.width;
			lastH = canvas.height;
			listener(lastW, lastH);
		};
		const observer = new MutationObserver(report);
		observer.observe(div, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['width', 'height'],
		});
		report();
		return () => observer.disconnect();
	}

	/**
	 * Keep the visible screen honest while a panel shows it. v86's SVGA path
	 * repaints only what its per-page dirty bitmap caught, and the kernel's
	 * fbdev damage blits demonstrably slip through it: a full-screen rewrite
	 * from the guest always lands, the same pixels written page by page
	 * mostly never do. Rather than fight the bitmap (it lives inside the
	 * wasm heap, unreachable from here), bypass it — a few times a second,
	 * read the whole VBE framebuffer straight out of VRAM, swizzle BGRX to
	 * RGBA and put it on v86's own canvas. ~3 MB per sweep on a 1024x768
	 * head, milliseconds of work, and it shows exactly what the guest wrote.
	 * Returns the stop function.
	 */
	startScreenRefresh(): () => void {
		let frame: ImageData | null = null;
		const timer = setInterval(() => {
			const cpu = (
				this.emulator as unknown as {
					v86?: {
						cpu?: {
							wasm_memory?: WebAssembly.Memory;
							devices?: {
								vga?: {
									svga_enabled?: boolean;
									svga_bpp?: number;
									svga_width?: number;
									svga_height?: number;
									svga_offset?: number;
									svga_memory?: { byteOffset: number };
								};
							};
						};
					};
				} | null
			)?.v86?.cpu;
			const vga = cpu?.devices?.vga;
			if (!cpu?.wasm_memory || !vga?.svga_enabled || vga.svga_bpp !== 32) return;
			const w = vga.svga_width!;
			const h = vga.svga_height!;
			const canvas = this.screenDiv?.querySelector('canvas');
			// Same context options as v86's own getContext, or this returns null.
			const ctx = canvas?.getContext('2d', { alpha: false });
			if (!ctx || !vga.svga_memory) return;
			const src = new Uint8Array(
				cpu.wasm_memory.buffer,
				vga.svga_memory.byteOffset + (vga.svga_offset ?? 0) * 4,
				w * h * 4,
			);
			if (frame?.width !== w || frame.height !== h) frame = new ImageData(w, h);
			const out = frame.data;
			for (let i = 0; i < out.length; i += 4) {
				out[i] = src[i + 2];
				out[i + 1] = src[i + 1];
				out[i + 2] = src[i];
				out[i + 3] = 255;
			}
			ctx.putImageData(frame, 0, 0);
		}, 300);
		return () => clearInterval(timer);
	}

	// ── the speaker ──

	/**
	 * Unmute the guest: v86's speaker adapter opens its AudioContext at boot,
	 * which is not a user gesture, so the autoplay policy leaves the context
	 * suspended. Call from any gesture handler (a click, a keystroke);
	 * idempotent and cheap once the context runs.
	 *
	 * The outcome lands on `data-audio-state` of the document element —
	 * "running" is sound, "suspended" is the policy still winning, "none" is
	 * no adapter to resume (boot not done, or a v86 rename) — so a test (or
	 * a person with devtools) can see the audio path without a speaker.
	 * A suspended context does more than mute: v86's DAC stops consuming,
	 * the SB16 DMA throttles, and a guest pacing itself by blocking writes
	 * to /dev/dsp (nes does) stutters.
	 */
	resumeAudio() {
		const context = (
			this.emulator as unknown as {
				speaker_adapter?: { audio_context?: AudioContext };
			} | null
		)?.speaker_adapter?.audio_context;
		const reflect = () => {
			document.documentElement.dataset.audioState = context ? context.state : 'none';
		};
		if (!context) {
			reflect();
			return;
		}
		context.resume().then(reflect, reflect);
	}

	/** The page's own master gain, spliced in by the first setVolume call.
	 * Keyed to its AudioContext: a failed boot retried (or destroy + boot)
	 * builds a fresh emulator and a fresh audio graph, and a gain node from
	 * the old one would take settings into the void. */
	private pageGain: { context: AudioContext; node: GainNode } | null = null;

	/**
	 * The page-side volume knob (the footer slider): a GainNode spliced
	 * between v86's mixer and the speakers on first use. Deliberately NOT
	 * the guest's mixer — vol(1) writes SB16 registers and S25vol resets
	 * them every boot, while this knob is the person's own: it multiplies
	 * with the guest's and survives reboots, like hardware volume next to
	 * application volume. audioRms taps BEFORE this node on purpose, so a
	 * slider at zero cannot fail the "does the guest sing" assertions.
	 *
	 * The applied value lands on `data-volume` of the document element
	 * (the observability convention of data-audio-state). Returns false
	 * while the speaker adapter is not up yet — callers retry.
	 */
	setVolume(volume: number): boolean {
		const adapter = (
			this.emulator as unknown as {
				speaker_adapter?: {
					audio_context?: AudioContext;
					mixer?: { node_merger?: AudioNode };
				};
			} | null
		)?.speaker_adapter;
		const context = adapter?.audio_context;
		const merger = adapter?.mixer?.node_merger;
		if (!context || !merger) return false;
		if (this.pageGain?.context !== context) {
			const node = context.createGain();
			merger.disconnect(context.destination);
			merger.connect(node);
			node.connect(context.destination);
			this.pageGain = { context, node };
		}
		const clamped = Math.max(0, Math.min(1, volume));
		this.pageGain.node.gain.value = clamped;
		// The requested value, not the AudioParam read back: gain.value is a
		// float32 and returns 0.3 as 0.30000001192092896.
		document.documentElement.dataset.volume = String(clamped);
		return true;
	}

	/**
	 * Measure whether sound actually *flows*, not just whether the graph
	 * runs: `data-audio-state` can say "running" while every sample is zero.
	 * Taps v86's audio graph with AnalyserNodes at two points — the DAC
	 * output (guest samples as they leave the SB16 emulation) and the
	 * mixer's final merge (what the speakers get) — and reports the peak
	 * RMS seen at each over `ms` milliseconds. 0 at a tap is dead silence
	 * there; null means the adapter (or an expected node) is missing.
	 * Works headless: the samples still cross the analysers on the way to
	 * a null sink.
	 */
	async audioRms(ms = 1500): Promise<{ dac: number; master: number } | null> {
		const adapter = (
			this.emulator as unknown as {
				speaker_adapter?: {
					audio_context?: AudioContext;
					dac?: { node_output?: AudioNode };
					mixer?: { node_merger?: AudioNode };
				};
			} | null
		)?.speaker_adapter;
		const context = adapter?.audio_context;
		const dacNode = adapter?.dac?.node_output;
		const masterNode = adapter?.mixer?.node_merger;
		if (!context || !dacNode || !masterNode) return null;

		const tap = (node: AudioNode) => {
			const analyser = context.createAnalyser();
			analyser.fftSize = 2048;
			node.connect(analyser); // an extra fan-out, existing wiring untouched
			return analyser;
		};
		const taps = [tap(dacNode), tap(masterNode)];
		const peaks = [0, 0];
		const buf = new Float32Array(2048);
		try {
			for (const deadline = performance.now() + ms; performance.now() < deadline;) {
				taps.forEach((analyser, i) => {
					analyser.getFloatTimeDomainData(buf);
					let sum = 0;
					for (let j = 0; j < buf.length; j++) sum += buf[j] * buf[j];
					peaks[i] = Math.max(peaks[i], Math.sqrt(sum / buf.length));
				});
				await new Promise((r) => setTimeout(r, 50));
			}
		} finally {
			dacNode.disconnect(taps[0]);
			masterNode.disconnect(taps[1]);
		}
		return { dac: peaks[0], master: peaks[1] };
	}

	// ── ttyS2, the pass-through serial port ──

	/**
	 * Bridge a Web Serial port to the guest's /dev/ttyS2: a dumb byte pump in
	 * both directions, which is the entire semantics of a serial device — the
	 * guest's 8250 driver talks to v86's emulated 16550 and never knows the
	 * other end is real hardware. The baud rate is set on the real port here;
	 * the emulated UART's divisor is decorative, so guest-side `stty` speed
	 * changes are ignored (as the connect dialog says).
	 *
	 * One port at a time; attaching replaces the previous one. Returns a
	 * detach function that closes the port. `onClose` fires when the device
	 * goes away on its own (unplugged) — not on an explicit detach.
	 */
	async attachSerial(
		port: SerialPort,
		baudRate: number,
		onClose?: () => void,
	): Promise<() => Promise<void>> {
		await this.boot();
		await this.serialDetach?.();
		await port.open({ baudRate });
		const writer = port.writable!.getWriter();
		const reader = port.readable!.getReader();
		this.serialWriter = writer;
		let closing = false;
		const detach = async () => {
			if (closing) return;
			closing = true;
			this.serialWriter = null;
			this.serialDetach = null;
			this.serialBuffer = [];
			// cancel() settles the read loop; the locks must go before close().
			await reader.cancel().catch(() => {});
			reader.releaseLock();
			await writer.close().catch(() => {});
			await port.close().catch(() => {});
		};
		this.serialDetach = detach;
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value?.length) this.emulator?.serial_send_bytes(2, value);
				}
			} catch {
				// The read loop only throws when the device disappears.
			}
			if (!closing) {
				await detach();
				onClose?.();
			}
		})();
		return detach;
	}

	private flushSerial() {
		this.serialFlushQueued = false;
		if (!this.serialBuffer.length || !this.serialWriter) return;
		const bytes = new Uint8Array(this.serialBuffer);
		this.serialBuffer = [];
		// Serialized by the stream's own queue; a write error means the
		// device is gone and the read loop is already tearing down.
		this.serialWriter.write(bytes).catch(() => {});
	}

	// ── /data, the 9p filesystem ──

	/**
	 * Put a file into the persistent directory (guest: `/data/<name>`). Paths
	 * are relative to the 9p root: a bare name for the private tier, or the
	 * one sanctioned nested path, `share/local/<name>` — whose directories
	 * must already exist in the guest (share-store's ensureLocalDir); v86's
	 * create_file walks the tree, it does not mkdir. Boots the VM first if
	 * needed.
	 */
	async putFile(name: string, bytes: Uint8Array): Promise<void> {
		await this.boot();
		await this.emulator!.create_file(name.replace(/^\/+/, ''), bytes);
	}

	/** Read a file back from the shared directory; rejects if it is missing. */
	async readFile(name: string): Promise<Uint8Array> {
		await this.boot();
		return await this.emulator!.read_file(name.replace(/^\/+/, ''));
	}

	// ── ttyS1 ──

	/**
	 * Run a command in the VM: `sh -c` as root, stdout+stderr combined.
	 *
	 * Queued: agentd answers one request at a time, and interleaving two would
	 * interleave their DONE lines. Rejects when the VM is not up or the
	 * channel goes quiet past the guest-side timeout.
	 */
	async runShell(command: string, timeoutS = 30): Promise<RunResult> {
		// No fast-fail on a prior 'failed': boot() resets its cached promise on
		// failure, so awaiting it here re-attempts (and re-throws if it fails
		// again) rather than being stuck until a reload.
		await this.boot();
		return this.enqueueRun(command, timeoutS);
	}

	/** The queue entry itself, without the boot() gate — the restore probe
	 * runs while start() is still the pending boot promise, and awaiting
	 * boot() from inside it would deadlock. */
	private enqueueRun(command: string, timeoutS: number): Promise<RunResult> {
		return new Promise<RunResult>((resolve, reject) => {
			this.queue.push({ command, timeoutS, resolve, reject });
			this.pump();
		});
	}

	private pump() {
		if (this.inFlight || !this.queue.length || !this.emulator) return;
		const run = this.queue.shift()!;
		const id = this.nextRunId++;
		const timer = setTimeout(
			() => {
				// agentd itself KILLs at timeoutS; reaching this means the
				// channel is gone, not just the command slow.
				if (this.inFlight?.id === id) {
					this.inFlight = null;
					run.reject(new Error('the VM stopped answering on the command channel'));
					this.pump();
				}
			},
			run.timeoutS * 1000 + CHANNEL_GRACE_MS,
		);
		this.inFlight = { id, run, timer };
		// The payload's character count travels ahead of it: a long line that
		// loses its tail on the way used to decode cleanly whenever the cut
		// fell on a base64 boundary, and the guest ran half a command without
		// either side noticing. agentd now refuses a payload whose length
		// disagrees — see the protocol notes in the overlay's agentd.
		const payload = toBase64(run.command);
		const line = `RUN ${id} ${Math.max(1, Math.ceil(run.timeoutS))} ${payload.length} ${payload}\n`;
		this.emulator.serial_send_bytes(1, encoder.encode(line));
	}

	private onChannelByte(byte: number) {
		if (byte === 0x0a) {
			const line = this.channelLine;
			this.channelLine = '';
			this.onChannelLine(line);
			return;
		}
		// The protocol is pure ASCII (verbs, digits, base64), so anything else
		// is line noise and dropped here. This is not hypothetical: v86's
		// second UART emits a stray 0xFF as the guest brings the port up, and
		// left in place it glued itself onto "READY agentd" and made the
		// startsWith check miss the one line boot() waits for.
		if (byte < 0x20 || byte > 0x7e) return;
		this.channelLine += String.fromCharCode(byte);
		// A runaway line without newlines would grow forever; agentd never
		// legitimately sends one longer than ~90k (64 KiB base64-encoded).
		if (this.channelLine.length > 200_000) this.channelLine = '';
	}

	// ── ttyS3, hostcall ──

	/**
	 * Teach v86's fourth UART the loopback trick Linux demands of COM4.
	 *
	 * The kernel's legacy port table marks 0x3F8/0x2F8/0x3E8 `UPF_SKIP_TEST`
	 * but not 0x2E8: historic COM4 clones were flaky, so that one port must
	 * pass autoconfig's loopback test — MCR is set to LOOP|OUT2|RTS (0x1A)
	 * and MSR is expected to mirror it as DCD|CTS (0x90). v86's UART never
	 * implemented loopback (its own images stop at ttyS2, where the test is
	 * skipped), the mirror comes back empty, and the kernel writes the port
	 * off as PORT_UNKNOWN — every open of /dev/ttyS3 fails with EIO from
	 * then on.
	 *
	 * The UART is plain JS inside v86 (reached the way startScreenRefresh
	 * reaches the VGA), and its MSR read handler returns `this.modem_status`.
	 * Replacing that data property with an accessor that computes the 16550
	 * loopback mapping while MCR bit 4 is up is the entire fix; with the loop
	 * down it answers the stored value as before. Installed by a short poll:
	 * the devices object appears during v86's async init, milliseconds in,
	 * while the kernel's probe is over a second of emulated boot away.
	 */
	private patchUart3Loopback() {
		const started = Date.now();
		const tryPatch = () => {
			const uart3 = (
				this.emulator as unknown as {
					v86?: { cpu?: { devices?: { uart3?: { modem_control?: number } } } };
				} | null
			)?.v86?.cpu?.devices?.uart3;
			if (!uart3) {
				if (Date.now() - started < 30_000) setTimeout(tryPatch, 25);
				return;
			}
			// A failed boot retried inside the poll window leaves two polls
			// aimed at the same (new) uart3; the accessor is not configurable,
			// so the second install would throw. The first one won.
			if (Object.getOwnPropertyDescriptor(uart3, 'modem_status')?.get) return;
			// Keep whatever v86 initialised (DSR|CTS|DCD): open(2) on a tty
			// without CLOCAL blocks until DCD, so zeroing this would matter.
			let stored = (uart3 as { modem_status?: number }).modem_status ?? 0;
			Object.defineProperty(uart3, 'modem_status', {
				get() {
					const mcr = (this as { modem_control?: number }).modem_control ?? 0;
					if (!(mcr & 0x10)) return stored;
					return (
						(mcr & 0x02 ? 0x10 : 0) | // RTS  -> CTS
						(mcr & 0x01 ? 0x20 : 0) | // DTR  -> DSR
						(mcr & 0x04 ? 0x40 : 0) | // OUT1 -> RI
						(mcr & 0x08 ? 0x80 : 0) // OUT2 -> DCD
					);
				},
				set(v: number) {
					stored = v;
				},
			});
		};
		tryPatch();
	}

	private onHostcallByte(byte: number) {
		if (byte === 0x0a) {
			const line = this.hostcallLine;
			this.hostcallLine = '';
			void this.onHostcallLine(line);
			return;
		}
		// The same defence onChannelByte earned the hard way: v86's UARTs
		// emit a stray 0xFF as the guest brings the port up, and the protocol
		// is pure ASCII anyway.
		if (byte < 0x20 || byte > 0x7e) return;
		this.hostcallLine += String.fromCharCode(byte);
		if (this.hostcallLine.length > 200_000) this.hostcallLine = '';
	}

	/**
	 * One CALL, one DONE — on *every* path. The guest CLI blocks on its read
	 * with only a coarse timeout as backstop; an unanswered failure here
	 * would leave it staring at the wire for that whole timeout.
	 */
	private async onHostcallLine(line: string) {
		const call = parseCallLine(line);
		if (!call) return; // boot noise, or something that never named an id
		let reply: Record<string, unknown>;
		if (call.error) {
			reply = { ok: false, error: `hostcall: ${call.error}` };
		} else {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				let payload = call.payload;
				// A too-big request arrived as {req: <file>}: the real payload
				// waits in /data, written by the CLI, deleted by the CLI.
				const req = (payload as { req?: unknown } | null)?.req;
				if (typeof req === 'string') {
					if (!/^\.hostcall-[\w.-]+$/.test(req)) {
						throw new Error(`hostcall: not a request relay name: ${req}`);
					}
					payload = JSON.parse(decoder.decode(await this.readFile(req)));
				}
				// The executors carry their own timeouts; this outer race only
				// exists so a wedged one still answers the wire.
				const budgetMs =
					Math.min(120_000, Math.max(1_000, Number((payload as any)?.timeoutMs) || 30_000)) +
					10_000;
				reply = await Promise.race([
					answerHostcall(call.kind, payload, call.id, (name, bytes) => this.putFile(name, bytes)),
					new Promise<Record<string, unknown>>((resolve) => {
						timer = setTimeout(
							() =>
								resolve({
									ok: false,
									error: 'hostcall: the page timed out answering',
								}),
							budgetMs,
						);
					}),
				]);
			} catch (e) {
				reply = {
					ok: false,
					error: e instanceof Error ? e.message : String(e),
				};
			} finally {
				clearTimeout(timer);
			}
		}
		this.emulator?.serial_send_bytes(3, encoder.encode(buildDoneLine(call.id, reply)));
	}

	private onChannelLine(line: string) {
		if (line.startsWith('READY')) {
			this.channelReadySettle();
			return;
		}
		if (!line.startsWith('DONE ')) return; // boot noise, or a partial line
		const [, id, code, b64 = ''] = line.split(' ');
		const flight = this.inFlight;
		if (!flight || String(flight.id) !== id) return; // a timed-out ghost
		clearTimeout(flight.timer);
		this.inFlight = null;
		let output = '';
		try {
			output = b64 ? fromBase64(b64) : '';
		} catch {
			output = '(agentd sent undecodable output)';
		}
		flight.run.resolve({ exit_code: Number(code), output });
		this.pump();
	}

	/** Stop the emulator and reject everything queued. */
	destroy() {
		void this.serialDetach?.();
		this.emulator?.destroy();
		this.emulator = null;
		this.setState('off');
		this.booting = null;
		const stranded = this.queue.splice(0);
		if (this.inFlight) {
			clearTimeout(this.inFlight.timer);
			stranded.push(this.inFlight.run);
			this.inFlight = null;
		}
		for (const run of stranded) run.reject(new Error('the VM was shut down'));
	}
}

/** The page's one VM. Chat page and terminal page each get their own tab. */
let shared: VinxVm | null = null;

export function sharedVm(options?: VmOptions): VinxVm {
	if (!shared) {
		shared = new VinxVm(options);
		// Both pages get the same /data semantics: restored on boot,
		// snapshotted to IndexedDB while the tab lives.
		attachSharePersistence(shared);
	}
	return shared;
}

/**
 * The VM if someone has made one — for observers that must never make it.
 * Whoever creates the VM decides its options (the terminal page passes the
 * network relay), so a mere gauge calling sharedVm() early would create it
 * with defaults and silently discard theirs; React runs children's effects
 * before the parent's, which is exactly that order.
 */
export function existingVm(): VinxVm | null {
	return shared;
}
