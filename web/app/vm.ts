/**
 * The Linux in the page.
 *
 * v86 boots the Buildroot images from `public/vm/` — an i686 kernel and a
 * busybox initramfs — entirely inside this tab. Three serial lines leave it:
 *
 *   ttyS0  the person's console. Raw bytes both ways; the terminal page
 *          attaches xterm.js to `onConsole` / `sendConsole`.
 *   ttyS1  the stream mux (§6.9): PTY window byte streams, SB1 frames,
 *          rpcd on the guest end and StreamMux (app/stream-mux.ts) here.
 *          Control (stream.opened/closed/credit) rides ttyS3. (agentd
 *          lived here until Phase 3.)
 *   ttyS2  a real serial device, when the person plugs one in: `attachSerial`
 *          pumps bytes between a Web Serial port and the guest's third UART.
 *   ttyS3  the control plane (system-v2 §6): VX1/VXA frames carrying a
 *          JSON-RPC subset, both directions. rpcd owns the guest end; this
 *          page's end is an RpcLink (app/rpc.ts) serving the page's methods
 *          (hostcall.ts: debug.js, http.fetch, the desktop capabilities).
 *          `runShell` rides it as proc.run (§15 Phase 2): rund executes,
 *          big results come back as §6.8 output refs this side reads over
 *          9p.
 *
 * runShell concurrency lives inside RpcLink and rund: many pending ids over
 * one stop-and-wait sender, eight jobs at once on the machine (OVERLOADED
 * past that). The console is not queued behind anything: keystrokes go
 * straight to the UART.
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

import type { DataEntry, ShellDevice } from '../runtime/src/device-vm';
import { appFrameUrl } from './app-frame-url';
import { bleBroker } from './ble';
import { bridgeControl } from './bridge-ctl';
import { captureFrame } from './camera';
import { triggerDownload } from './downloads';
import { pageMethods } from './hostcall';
import { rememberedPower } from './machine-power';
import { fileOpener, mimeFor, urlOpener, type OpenRequest } from './opener';
import { withOriginLock } from './origin-broker';
import { machineId } from './pane-id';
import { RpcCallError, RpcLink } from './rpc';
import { attachSharePersistence } from './share-store';
import { StreamMux } from './stream-mux';
import { windowManager } from './window-manager';

export type VmState = 'off' | 'booting' | 'ready' | 'failed';

/**
 * A need for the machine met by a machine the person left off
 * (machine-power.ts). Thrown by every implicit route into the VM — file
 * writes, the control link, run_shell — so the caller can say so instead
 * of booting behind the person's back. The message is the one line worth
 * showing; `name` is for callers that want to react rather than display.
 */
export class MachineOffError extends Error {
	override readonly name = 'MachineOffError';
	constructor() {
		super('the machine is powered off — the power key on the machine capsule (bottom right) boots it');
	}
}
export type RelayHealth = 'connecting' | 'ok' | 'down' | null;

/** Fired (on window, once, at boot) when this document lost the machine-name
 * claim to another tab and is running as an ephemeral machine: it restores
 * /data from the mirror like any boot, but nothing it writes goes back —
 * its files live and die with the tab. The current answer also lives in
 * `document.documentElement.dataset.vmIdentity` ('owner' | 'ephemeral'),
 * for UIs that mount after boot and for tests. */
export const VM_EPHEMERAL_EVENT = 'vinx:vm-ephemeral';

/** Where a boot currently is, for a UI that wants to say more than
 * "booting": image download, then kernel+userland execution. `fraction`
 * spans the whole boot, 0..1, and never moves backwards. 'ready' still
 * arrives via onState. */
export interface BootProgress {
	phase: 'download' | 'kernel';
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
	/** stdout+stderr combined. Inline up to 64 KiB (the ceiling agentd used
	 * to cut at silently); past it, the head plus an explicit truncation
	 * marker naming the §6.8 output ref that holds the rest. */
	output: string;
}

/** One port's arrival tally — enough to compute throughput and pacing
 * without hauling per-byte timestamp arrays across an evaluate boundary. */
export interface ProbeTally {
	count: number;
	/** performance.now() of the first byte since record(). */
	firstAt: number;
	lastAt: number;
	/** Inter-byte pauses ≥ 1 ms: how often delivery stalled, and the worst. */
	gaps: number;
	maxGapMs: number;
	/** The most recent ~2 KiB as text (printable ASCII and newlines, the
	 * same filter the protocol parsers apply), for content assertions. */
	tail: string;
}

export interface ModemEvent {
	line: 'dtr' | 'rts';
	value: boolean;
	at: number;
}

/** What waitCount answers: the tally when the target was crossed, stamped
 * inside the byte listener itself (no polling noise on the RTT numbers). */
export interface ProbeWaited {
	count: number;
	at: number;
	timedOut?: boolean;
}

/** A PTY window stream came or went (rpcd's stream.opened/closed over
 * ttyS3); the byte lane itself is ttyS1 (VinxVm.streamMux). `unmanaged`
 * marks a stream with no app behind it (proc.pty's shell window): closing
 * its window closes the stream, not an app. */
export type StreamEvent =
	| {
			kind: 'opened';
			id: number;
			app: string;
			cols: number;
			rows: number;
			window: number;
			unmanaged: boolean;
	  }
	| { kind: 'closed'; id: number };

/** The serial measurement instruments — see VinxVm.serialProbe(). */
export interface SerialProbe {
	/** Raw bytes page→guest: a number[] goes as-is, a string as UTF-8.
	 * Returns the milliseconds the synchronous send loop held the thread. */
	send(port: number, data: string | number[]): number;
	/** `size` copies of one byte page→guest, built here so an evaluate does
	 * not serialize a six-figure array to say "64 KiB of x". */
	sendPattern(port: number, size: number, byte?: number): number;
	/** Start (or restart) tallying guest→page bytes on a port. */
	record(port: number): void;
	/** The running tally; a snapshot, safe to serialize. */
	recorded(port: number): ProbeTally;
	/** Detach the port's tally listener; the final numbers. */
	stopRecord(port: number): ProbeTally;
	/** Resolves when the port's tally reaches `count` (record() first). */
	waitCount(port: number, count: number, timeoutMs?: number): Promise<ProbeWaited>;
	/** Start logging DTR/RTS transitions the guest's driver emits. */
	watchModem(port: number): void;
	modemEvents(port: number): ModemEvent[];
	setCts(port: number, value: boolean): void;
	setDsr(port: number, value: boolean): void;
	setDcd(port: number, value: boolean): void;
	setRing(port: number, value: boolean): void;
	/** The emulated UART's own registers and its unbounded input queue. */
	uartState(port: number): { backlog: number; ier: number; mcr: number; msr: number } | null;
}

/** How long past the guest-side timeout to wait before declaring the far
 * end gone (the transport allowance on top of the command's own budget). */
const CHANNEL_GRACE_MS = 10_000;
/**
 * Booting means kernel + userland + the control plane answering, all
 * emulated. Uncontended this is ~1-2s; the generous ceiling covers a first
 * boot that races a busy engine worker (which starves the main-thread
 * emulator) on a slow machine. Pages pre-boot at load to keep that race off
 * the critical path anyway.
 */
const BOOT_TIMEOUT_MS = 180_000;

/** Inline `command` budget before runShell stages a §6.8 scriptRef: a
 * control frame carries 4 KiB including the JSON envelope (§6.3), and
 * js(1) draws its staging line at the same 3000 for the same reason. */
const RUN_INLINE_MAX = 3000;
/** How much of a proc.run output ref comes back inline: agentd's old
 * `head -c 65536` ceiling, kept so the engine-visible contract does not
 * shrink — what changed is the explicit marker past it, where agentd cut
 * silently. */
const RUN_OUTPUT_CAP = 65536;

/** proc.run's reply (§6.8), the fields this adapter consumes. */
interface ProcRunReply {
	exitCode?: number;
	timedOut?: boolean;
	stdout?: string;
	stdoutB64?: string;
	truncated?: boolean;
	output?: { path?: string; size?: number };
	droppedBytes?: number;
}

/**
 * The slice of v86's 9p filesystem the page drives directly (§8.2: /data is
 * the page's own host9p — enumeration and unlink owe no guest round trip).
 * None of this is in v86.d.ts; the structural cast is the same reach as
 * startScreenRefresh and patchUart3Loopback, checked against the vendored
 * build's lib/filesystem.js.
 */
interface Fs9pWalk {
	/** -1 when the path does not resolve. */
	id: number;
	/** The would-be parent (-1 when even that is missing). */
	parentid: number;
	/** The missing component on the miss paths — undefined on a full hit
	 * (v86 indexes one past the walk there); never trust it for Unlink. */
	name?: string;
}
interface Fs9pInode {
	size: number;
	/** Seconds since the epoch — the unit `date -r +%s` printed. */
	mtime: number;
	mode: number;
}
interface Fs9pApi {
	SearchPath(path: string): Fs9pWalk;
	GetInode(idx: number): Fs9pInode;
	GetChildren(parentid: number): string[];
	CreateDirectory(name: string, parentid: number): number;
	/** 0 on success; -39 (ENOTEMPTY) for a non-empty directory. */
	Unlink(parentid: number, name: string): number;
	GetRecursiveList(dirid: number, list: { parentid: number; name: string }[]): void;
	IsDirectory(idx: number): boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

	// ── ttyS2, the pass-through serial port ──
	private serialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private serialBuffer: number[] = [];
	private serialFlushQueued = false;
	private serialDetach: (() => Promise<void>) | null = null;

	// ── ttyS3, the control link ──
	private rpc: RpcLink | null = null;

	// ── ttyS1, the stream mux (§6.9: PTY window byte streams) ──
	private mux: StreamMux | null = null;
	private streamListeners = new Set<(ev: StreamEvent) => void>();

	// ── guest events (§6.7: rpc.event notifications this page watches) ──
	private guestEventListeners = new Set<(topic: string, data: unknown) => void>();

	// ── the VGA head ──
	/**
	 * v86's screen adapter renders into this detached element (it creates
	 * its own canvas and text-mode div inside). Detached because the screen
	 * is optional equipment: the terminal's screen panel adopts the element
	 * when opened and orphans it again when closed — the adapter keeps
	 * painting either way.
	 */
	private screenDiv: HTMLElement | null = null;

	/** Desktop window surfaces, by the pages that render them — the
	 * window.focus method (§10.7) resolves through these. */
	private windowFocusHandlers = new Set<(id: string) => boolean>();
	/** Toast sinks for notify.show's fallback (the terminal's corner note). */
	private noteHandlers = new Set<(text: string) => void>();
	/** Where a popup-blocked open parks for its retry click (the open chip). */
	private openParkers = new Set<(req: OpenRequest) => void>();
	/** Who hears the 9p write doorbell (share-store's early snapshot). */
	private dataWriteListeners = new Set<() => void>();

	/** Closing a window that fronts an app stops the app (§15 Phase 5's
	 * close semantics, wired page-side). app.stop is idempotent and sets
	 * rund's manual-stop latch, so the sweep does not resurrect what the
	 * person just dismissed; for a pure web app (no backend) it is a no-op.
	 * Since Phase 6 the close and every rise-to-top are also *events*
	 * (§10.7 window.closed/window.focused): an rpc.emit up the link, fanned
	 * out by rpcd to whoever subscribed (a console `rpc watch window`). */
	private wireWindowCloses(): void {
		windowManager().onClosed((id, appId) => {
			this.rpc?.notify('rpc.emit', {
				topic: 'window.closed',
				data: appId ? { id, app: appId } : { id },
			});
			if (appId) {
				void this.rpcCall('app.stop', { id: appId }, { deadlineMs: 15_000 }).catch(() => {});
				return;
			}
			// An unmanaged terminal window (proc.pty's shell): no app to
			// stop — closing the stream is the close. rpcd drops the PTY
			// master, the shell gets HUP, rund reaps it. A failure here
			// leaks a shell, which is worth a loud line.
			if (id.startsWith('tty-')) {
				const streamId = Number(id.slice(4));
				if (Number.isFinite(streamId))
					void this.rpcCall('stream.close', { id: streamId }, { deadlineMs: 10_000 }).catch(
						(e) => console.error('vinx: stream.close failed for', id, e),
					);
			}
		});
		windowManager().onFocused((id) => {
			this.rpc?.notify('rpc.emit', { topic: 'window.focused', data: { id } });
		});
	}

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
		// Created eagerly so a screen panel opened before boot() still has an
		// element to adopt; v86 fills it in when the emulator starts.
		if (typeof document !== 'undefined') {
			this.screenDiv = document.createElement('div');
			this.screenDiv.className = 'vga-screen';
			this.wireWindowCloses();
		}
		// Best-effort teardown signal for rpcd (§6.6): drop DCD as the page
		// leaves. pagehide is not guaranteed to run — the next page's hello
		// is the authoritative reset — this only accelerates it.
		if (typeof window !== 'undefined') {
			window.addEventListener('pagehide', () => {
				try {
					this.emulator?.serial_set_carrier_detect(3, false);
				} catch {
					/* the emulator may already be gone */
				}
			});
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
	 * lets the number move backwards, and mirrors it onto the document for
	 * tests and status displays. */
	private emitProgress(phase: BootProgress['phase'], fraction: number) {
		const f = Math.max(this.bootFraction, Math.min(1, fraction));
		this.bootFraction = f;
		if (typeof document !== 'undefined') {
			document.documentElement.dataset.vmBootProgress = f.toFixed(3);
			// The phase too, for a reader that has only the document (the
			// vendored Apps page, see vm-status.ts).
			document.documentElement.dataset.vmBootPhase = phase;
		}
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
	 * Resolves when the control plane answers — the ttyS3 session is up and
	 * rund behind it ran a probe — which is after rcS; by then the console
	 * shell on ttyS0 is up too.
	 */
	boot(): Promise<void> {
		if (!this.booting) this.booting = this.start();
		return this.booting;
	}

	/**
	 * The one gate for an IMPLICIT need of the machine — a file write, the
	 * control link, run_shell: anything that is not the person pressing a
	 * power key. Booting or ready, wait for it. Off (or failed), what the
	 * person last left the machine as decides (machine-power.ts): left 'on'
	 * — which here means a boot failed, since every power-off writes 'off' —
	 * that is standing permission and the machine boots again; anything
	 * else refuses with MachineOffError, and the caller says so. This is
	 * what keeps "the machine boots when I say" true against every route in
	 * — before it, dropping a file into the chat booted a machine its owner
	 * had just declined. The explicit gestures call boot() directly.
	 */
	private whenUp(): Promise<void> {
		if (this.state === 'booting' || this.state === 'ready') return this.boot();
		if (rememberedPower() === 'on') return this.boot();
		return Promise.reject(new MachineOffError());
	}

	/**
	 * Claim this machine's name, origin-wide, for the life of this document.
	 *
	 * The /data mirror is keyed by machineId(), and two browser tabs can
	 * both play pane 1: both sweeping their own /data into the one bucket
	 * would interleave writes and propagate one tab's deletions over the
	 * other's files. So only the tab holding the lock writes the mirror
	 * (see share-store); a loser boots and restores /data all the same,
	 * but runs as an ephemeral machine whose writes stay in RAM.
	 *
	 * The lock is never released by code — the browser drops it when the
	 * document dies (reload included), which is precisely the lifetime of
	 * the machine. No Web Locks (an http:// LAN origin is not a secure
	 * context) means no arbiter, and the old everyone-writes behaviour.
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

	/** Whether this document holds the machine's name (see claimIdentity) and
	 * with it the right to write the /data mirror. Settled during boot; the
	 * mirror writers (share-store, drag-and-drop, camera) ask before every
	 * private write. */
	isOwner(): Promise<boolean> {
		return this.claimIdentity();
	}

	/** The reason the machine is in 'failed', or null outside that state. */
	bootError(): string | null {
		return this.state === 'failed' ? this.lastBootError : null;
	}

	private async start(): Promise<void> {
		this.setState('booting');
		this.sawKernelOutput = false;
		this.lastBootError = null;
		// A retry after 'failed' is a fresh boot: the bar starts over (the
		// document mirror too, or a status reading it would open on the
		// last boot's final number).
		this.bootFraction = 0;
		if (typeof document !== 'undefined') {
			delete document.documentElement.dataset.vmBootProgress;
			delete document.documentElement.dataset.vmBootPhase;
		}
		this.downloadedBytes.clear();
		this.milestoneHit = 0;
		this.milestoneLine = '';
		try {
			// Fetched now, on first boot, not at page load; see the import note.
			const [{ V86 }, { default: v86WasmUrl }] = await Promise.all([
				import('v86'),
				import('v86/build/v86.wasm?url'),
			]);
			// Whether this document owns the machine's name, said out loud: a
			// second tab of the same page loses the claim and silently ran as
			// a machine that persists nothing. The dataset mirrors the answer
			// for tests and for pages that mount later; the event pokes UIs
			// already listening (the machine console's "ephemeral" badge).
			const owner = await this.claimIdentity();
			// Powered off while the image was still loading: build nothing.
			if (this.state !== 'booting') throw new Error('the VM was shut down');
			if (typeof document !== 'undefined') {
				document.documentElement.dataset.vmIdentity = owner ? 'owner' : 'ephemeral';
				if (!owner) window.dispatchEvent(new Event(VM_EPHEMERAL_EVENT));
			}
			this.construct(V86, v86WasmUrl);
			// The control plane answering is the finish line (§18): agentd's
			// READY stopped gating the boot when run_shell left ttyS1.
			// controlUp waits for rpcd to hold the tty, opens the session,
			// and probes rund behind it.
			await this.controlUp();
			this.emitProgress('kernel', 1);
			this.setState('ready');
		} catch (e) {
			// Powered off mid-boot (destroy() nulled the emulator and set
			// 'off' already): the person changed their mind, which is not a
			// failure and must not read as one — no red key, no reason kept.
			if (this.state === 'off' && !this.emulator) {
				this.booting = null;
				throw e instanceof Error ? e : new Error(String(e));
			}
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

	/**
	 * Drop hub frames until the guest's NIC driver is up.
	 *
	 * v86's virtio-net hands every incoming frame to the RX virtqueue
	 * without checking that the guest has configured it. Before the driver
	 * probes (the first seconds of boot, and again for a moment while the
	 * probe resets the device) the queue's addresses are all zero, so the
	 * device reads its ring indexes out of the guest's low memory, pops a
	 * garbage descriptor chain and writes the frame — and its used-ring
	 * bookkeeping — wherever that chain points. An out-of-range write
	 * surfaces as a "RangeError: offset is out of bounds" page error; an
	 * in-range one corrupts the guest, whose driver later finds a used entry
	 * that is no chain head ("virtio_net virtio1: input.0:id 0 is not a
	 * head!") and marks its RX queue broken for good. So a machine that
	 * boots while another machine on the same hub is talking — udhcpc alone
	 * broadcasts every few seconds — comes up with a dead NIC. Real hardware
	 * has no reader before the driver either: frames are dropped here until
	 * the queue is configured and enabled and the driver has said DRIVER_OK.
	 * Wrapped on the device bus so every backend (hub, bridge, relay) is
	 * covered; a v86 build that renames these internals just leaves the
	 * frames ungated, as before.
	 */
	private gateFramesOnDriver(): void {
		type Queue = { enabled?: boolean; is_configured?: () => unknown };
		type Listener = { fn: (data: unknown) => void; this_value: unknown };
		type Nic = {
			id?: number;
			bus?: { listeners?: Record<string, Listener[]> };
			virtio?: { device_status?: number; queues?: Queue[] };
		};
		const nic = (
			this.emulator as unknown as {
				v86?: { cpu?: { devices?: { virtio_net?: Nic } } };
			} | null
		)?.v86?.cpu?.devices?.virtio_net;
		const entries = nic?.bus?.listeners?.[`net${nic.id ?? 0}-receive`];
		if (!nic || !entries?.length) return;
		const DRIVER_OK = 4;
		const driverUp = () => {
			const rx = nic.virtio?.queues?.[0];
			return (
				((nic.virtio?.device_status ?? 0) & DRIVER_OK) !== 0 &&
				rx?.enabled === true &&
				!!rx.is_configured?.()
			);
		};
		for (const entry of entries) {
			const deliver = entry.fn;
			entry.fn = (data: unknown) => {
				if (driverUp()) deliver.call(entry.this_value, data);
			};
		}
	}

	/** Build the emulator and wire every listener. */
	private construct(V86: (typeof import('v86'))['V86'], v86WasmUrl: string): void {
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
			// control-plane dialect. One query string keeps them in step.
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
			// ttyS1 idle (the future stream mux's); ttyS2 for the Web Serial
			// pass-through (attachSerial); ttyS3 for the control plane.
			// ttyS0 always exists.
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
		});
		this.emulator = emulator;
		emulator.add_listener('emulator-loaded', () => this.gateFramesOnDriver());

		emulator.add_listener('download-progress', (p) => {
			// One monotonic number out of v86's two progress emitters (see
			// BOOT_DOWNLOADS): identify the file by name, weight by bytes.
			if (this.state !== 'booting') return;
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
				if (this.state === 'booting') this.emitProgress('kernel', DOWNLOAD_SHARE);
			}
			// The boot milestones ride the same byte stream.
			if (this.state === 'booting' && this.milestoneHit < KERNEL_MILESTONES.length)
				this.trackMilestone(byte);
			this.consoleBuffer.push(byte);
			if (!this.consoleFlushQueued) {
				this.consoleFlushQueued = true;
				queueMicrotask(() => this.flushConsole());
			}
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
		// The /data doorbell (§12.1): v86 announces every guest-side 9p
		// TWRITE. A dirty flag only — the event names just a basename, and
		// mkdir/unlink/truncate never ring — so listeners treat it as "scan
		// soon", not as a locator; the periodic sweep still owns the truth.
		// Page-side writes (putFile, the boot restore) bypass the 9p
		// protocol layer and stay silent: the bell cannot answer itself.
		emulator.add_listener('9p-write-end', () => {
			for (const cb of this.dataWriteListeners) cb();
		});
		// The control link: RpcLink speaks the frames, this wires its bytes
		// to the fourth UART. Methods live in hostcall.ts; the /data back end
		// is the same 9p pair putFile/readFile use, with the /data prefix
		// stripped (9p paths are relative to the mount).
		this.rpc = new RpcLink({
			sendBytes: (bytes) => this.emulator?.serial_send_bytes(3, bytes),
			methods: pageMethods(
				{
					read: (path) => this.readFile(path.replace(/^\/data\//, '')),
					write: (path, bytes) => this.putFile(path.replace(/^\/data\//, ''), bytes),
				},
				{
					focusWindow: (id) => this.focusWindow(id),
					windows: {
						list: () => windowManager().list(),
						create: (spec) => {
							// §18: no untrusted mode without the shell. It ships
							// beside the page (see app-frame-url.ts), so this
							// trips only outside a document.
							if (!appFrameUrl()) {
								throw new Error(
									'the app shell is not available here; refusing to run an untrusted app without it',
								);
							}
							windowManager().create(spec);
						},
						close: (id) => windowManager().close(id),
						focus: (id) => windowManager().focus(id),
						move: (id, x, y) => windowManager().move(id, x, y),
						resize: (id, w, h) => windowManager().resize(id, w, h),
					},
					notify: (text) => this.desktopNotify(text),
					speak: (text) => {
						if (typeof speechSynthesis === 'undefined') return false;
						speechSynthesis.speak(new SpeechSynthesisUtterance(text));
						return true;
					},
					// One webcam per origin (§3.0): the broker turns a
					// sibling machine's capture into RESOURCE_BUSY and a
					// hidden document's into REQUIRES_FOREGROUND.
					captureCamera: (name) => withOriginLock('camera', () => captureFrame(this, name)),
					openUrl: (url) => this.openOnDesktop(urlOpener(url)),
					openFile: (name, bytes) => {
						// The opaque-type branch downloads directly: an
						// <a download> needs no popup permission, and the
						// caller hears which way it went.
						if (mimeFor(name) === 'application/octet-stream') {
							triggerDownload(name, bytes);
							return 'downloaded';
						}
						return this.openOnDesktop(fileOpener(name, bytes));
					},
					download: (name, bytes) => {
						triggerDownload(name, bytes);
						return true;
					},
					ble: bleBroker,
					bridge: bridgeControl,
				},
			),
			implementation: 'vinx-desktop/1.0',
			onSessionUp: () => {
				// Streams are session-scoped: rpcd closed every PTY master
				// when the old session died, so the page-side channels are
				// corpses too (and half a frame of old ttyS1 bytes is noise),
				// and so are the terminal windows showing them.
				this.mux?.closeAll();
				windowManager().dropAllStreams();
				// Subscriptions are session state on rpcd's side too: say
				// again what this page watches. app.* is the window
				// annotator's feed (a backend dying marks its window).
				this.rpc?.notify('rpc.watch', { topics: ['app'] });
			},
			onNotify: (method, params) => this.onGuestNotify(method, params),
			log: (line) => console.info(line),
		});
		emulator.add_listener('serial3-output-byte', (byte: number) => {
			this.rpc?.onByte(byte);
		});
		// Without this, the guest has no /dev/ttyS3 at all — see the method.
		this.patchUart3Loopback();
		// The stream lane (§6.9): raw PTY bytes over ttyS1, multiplexed.
		// Control (opened/closed/credit) rides ttyS3 through onGuestNotify.
		this.mux = new StreamMux({
			sendBytes: (bytes) => this.emulator?.serial_send_bytes(1, bytes),
		});
		emulator.add_listener('serial1-output-byte', (byte: number) => {
			this.mux?.onByte(byte);
		});
	}

	/** Guest→page notifications that are not the link's own (rpc.cancel). */
	private onGuestNotify(method: string, params: Record<string, unknown>) {
		if (method === 'stream.credit') {
			const id = typeof params.id === 'number' ? params.id : -1;
			const bytes = typeof params.bytes === 'number' ? params.bytes : 0;
			this.mux?.credit(id, bytes);
			return;
		}
		if (method === 'stream.opened') {
			const id = typeof params.id === 'number' ? params.id : -1;
			if (id < 0) return;
			const ev: StreamEvent = {
				kind: 'opened',
				id,
				app: typeof params.app === 'string' ? params.app : '?',
				cols: typeof params.cols === 'number' ? params.cols : 80,
				rows: typeof params.rows === 'number' ? params.rows : 24,
				window: typeof params.window === 'number' ? params.window : 8 * 1024,
				unmanaged: params.unmanaged === true,
			};
			// The stream is a terminal window (§6.9): put it on the desktop.
			try {
				windowManager().openStream({
					streamId: ev.id,
					app: ev.app,
					cols: ev.cols,
					rows: ev.rows,
					window: ev.window,
					unmanaged: ev.unmanaged,
				});
			} catch (e) {
				// The window cap; the stream stays open (the app runs
				// headless) until someone closes it or the app exits.
				console.warn('vinx: no window for stream', ev.id, e);
			}
			for (const cb of this.streamListeners) cb(ev);
			return;
		}
		if (method === 'stream.closed') {
			const id = typeof params.id === 'number' ? params.id : -1;
			if (id < 0) return;
			this.mux?.close(id);
			// The app died (or the stream was torn down): the window leaves
			// silently — no onClosed, there is nothing left to app.stop.
			windowManager().dropStream(id);
			for (const cb of this.streamListeners) cb({ kind: 'closed', id });
			return;
		}
		if (method === 'rpc.event') {
			const topic = typeof params.topic === 'string' ? params.topic : null;
			if (topic === null) return;
			if (topic === 'app.exited') {
				// The window annotator (§10.7): a dead backend says so in
				// its window's title. Closing stays the person's call.
				const d = (params.data ?? {}) as { id?: unknown; code?: unknown };
				if (typeof d.id === 'string')
					windowManager().markExited(d.id, typeof d.code === 'number' ? d.code : null);
			}
			for (const cb of this.guestEventListeners) cb(topic, params.data);
			return;
		}
	}

	/** Guest events this page subscribed to (rpc.watch in onSessionUp);
	 * rpc.gap rides through like any topic. Returns the unsubscribe. */
	onGuestEvent(cb: (topic: string, data: unknown) => void): () => void {
		this.guestEventListeners.add(cb);
		return () => this.guestEventListeners.delete(cb);
	}

	/** PTY window streams coming and going; returns the unsubscribe. */
	onStreamEvent(cb: (ev: StreamEvent) => void): () => void {
		this.streamListeners.add(cb);
		return () => this.streamListeners.delete(cb);
	}

	/** The ttyS1 stream lane; null before boot. A terminal window opens its
	 * channel here (mux.open) when a stream.opened event names it. */
	get streamMux(): StreamMux | null {
		return this.mux;
	}

	/** DTR on the guest's ttyS3, read off the emulated UART's MCR (the same
	 * reach as patchUart3Loopback). The kernel raises DTR|RTS when a process
	 * opens the port, only rpcd ever opens ttyS3 (the ownership invariant),
	 * and close never drops the line (baseline M4) — so DTR high reads as
	 * "rpcd holds the tty". */
	private uart3Held(): boolean {
		const uart = (
			this.emulator as unknown as {
				v86?: { cpu?: { devices?: { uart3?: { modem_control?: number } } } };
			} | null
		)?.v86?.cpu?.devices?.uart3;
		return ((uart?.modem_control ?? 0) & 0x01) !== 0;
	}

	/**
	 * Boot's finish line: the ttyS3 session is up and rund answers a probe.
	 * The session alone is not enough — rpcd answers hello before rund's
	 * rpc.serve lands (they are independently respawned daemons, §6.10), and
	 * a caller right at that boundary would get an honest UNAVAILABLE. The
	 * E2E suite gates the same way; gating the boot here spares every caller
	 * the retry.
	 */
	private async controlUp(): Promise<void> {
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		// Not a byte before rpcd holds the tty: the open-time FIFO reset
		// discards everything queued earlier (baseline M1a, recorded as a
		// startup-order constraint in its §5), and a hello sprayed into the
		// boot window comes back mangled through the pre-raw line discipline
		// as parser noise. DTR is the "held" signal; if it never rises the
		// spray-and-retry path below still recovers, just noisily.
		const dtrBy = Date.now() + 30_000;
		while (!this.uart3Held() && Date.now() < dtrBy) {
			if (!this.rpc) throw new Error('the VM was shut down');
			await new Promise((pause) => setTimeout(pause, 100));
		}
		// Open the control session. The DCD pulse is the attach signal §6.6
		// describes (teardown acceleration for whatever session a respawned
		// rpcd might think it still has); the hello that follows is the
		// authoritative reset either way, and its retry loop rides over
		// rpcd still coming up.
		this.emulator?.serial_set_carrier_detect(3, false);
		this.emulator?.serial_set_carrier_detect(3, true);
		this.rpc?.attach();
		for (;;) {
			const rpc = this.rpc;
			if (!rpc) throw new Error('the VM was shut down');
			if (rpc.state === 'up') break;
			if (Date.now() > deadline)
				throw new Error('the VM did not finish booting (no control-plane session on ttyS3)');
			await new Promise((pause) => setTimeout(pause, 100));
		}
		for (;;) {
			const rpc = this.rpc;
			if (!rpc) throw new Error('the VM was shut down');
			try {
				await rpc.call('proc.run', { command: 'true', timeoutMs: 10_000 }, { deadlineMs: 15_000 });
				return;
			} catch (e) {
				if (!(e instanceof RpcCallError)) throw e;
				if (Date.now() > deadline)
					throw new Error(`the VM did not finish booting (proc.run never answered: ${e.name})`);
				await new Promise((pause) => setTimeout(pause, 250));
			}
		}
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
		// arrive as 0x2D). Encode to UTF-8 first.
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
	 * so this is an `stty` run through runShell (proc.run); fire-and-forget
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
	 * Register a desktop window surface for the guest's `window.focus`
	 * (§10.7): the handler shows/raises its window and answers whether the
	 * id was its to show. The screen panel registers as 'screen'. Returns
	 * the unregister.
	 */
	onWindowFocus(handler: (id: string) => boolean): () => void {
		this.windowFocusHandlers.add(handler);
		return () => this.windowFocusHandlers.delete(handler);
	}

	/** Resolve a window.focus call through the registered surfaces. */
	focusWindow(id: string): boolean {
		let shown = false;
		for (const handler of this.windowFocusHandlers) shown = handler(id) || shown;
		return shown;
	}

	/** Register a toast sink for notify.show's fallback (the terminal's
	 * corner note registers here). Returns the unregister. */
	onDesktopNote(handler: (text: string) => void): () => void {
		this.noteHandlers.add(handler);
		return () => this.noteHandlers.delete(handler);
	}

	/** notify.show's carrier: a system notification where already granted
	 * (no requestPermission — outside a gesture the browser would just
	 * deny), else any registered toast. Null when neither surface exists,
	 * and the method says so instead of dropping the text. */
	desktopNotify(text: string): 'notification' | 'note' | null {
		if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
			new Notification('vinx', { body: text });
			return 'notification';
		}
		let noted = false;
		for (const handler of this.noteHandlers) {
			handler(text);
			noted = true;
		}
		return noted ? 'note' : null;
	}

	/** Register a parking spot for a popup-blocked open (the terminal's
	 * open chip: its click is the gesture the blocker respects). */
	onOpenParked(handler: (req: OpenRequest) => void): () => void {
		this.openParkers.add(handler);
		return () => this.openParkers.delete(handler);
	}

	/** The /data doorbell: fires after any guest-side 9p write (a dirty
	 * flag, no path — see the construct() listener). Returns the
	 * unregister. share-store debounces this into an early snapshot. */
	onDataWritten(handler: () => void): () => void {
		this.dataWriteListeners.add(handler);
		return () => this.dataWriteListeners.delete(handler);
	}

	/** Try an open now; a blocked one parks on any registered chip. */
	private openOnDesktop(req: OpenRequest): 'opened' | 'parked' | null {
		if (req.open()) return 'opened';
		let parked = false;
		for (const handler of this.openParkers) {
			handler(req);
			parked = true;
		}
		return parked ? 'parked' : null;
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

	// ── the serial probe, measurement gear ──

	/**
	 * Instruments over the emulated UARTs for the Phase 0 protocol
	 * measurements (docs/protocol-baseline.zh-CN.md): raw sends, arrival
	 * tallies stamped with performance.now(), modem lines both ways, and a
	 * window into the UART's unbounded input queue. Test gear in the
	 * vinxImages/vinxAudioRms stance — terminal.tsx puts it on window,
	 * app/test/serial-bench.mjs drives it, production code never calls it.
	 *
	 * Recording rides the same bus events vm.ts already listens on (the bus
	 * fans one event out to every listener), so tallying a port does not
	 * disturb the control link's parsing. Sends inject bytes the guest
	 * cannot tell from protocol traffic — the bench keeps its payloads
	 * outside frame shapes so both sides' parsers drop them as noise.
	 */
	serialProbe(): SerialProbe {
		const emulator = () => {
			if (!this.emulator) throw new Error('the serial probe needs a booted VM');
			return this.emulator;
		};
		// `serial${n}-output-byte` is a template string, not one of the
		// literal keys add_listener's generic wants; the payload type is the
		// same number for all four ports.
		const outputEvent = (port: number) => `serial${port}-output-byte` as 'serial0-output-byte';

		const tallies = new Map<number, ProbeTally>();
		const byteListeners = new Map<number, (byte: number) => void>();
		const waiters = new Map<
			number,
			{ count: number; timer: ReturnType<typeof setTimeout>; resolve: (r: ProbeWaited) => void }[]
		>();
		const modemLogs = new Map<number, ModemEvent[]>();
		const modemListeners = new Map<number, ((value: boolean) => void)[]>();

		const snapshot = (port: number): ProbeTally => {
			const t = tallies.get(port);
			return t
				? { ...t }
				: { count: 0, firstAt: 0, lastAt: 0, gaps: 0, maxGapMs: 0, tail: '' };
		};
		const settleWaiters = (port: number, r: ProbeWaited) => {
			for (const w of waiters.get(port) ?? []) {
				clearTimeout(w.timer);
				w.resolve(r);
			}
			waiters.delete(port);
		};
		const stopRecord = (port: number): ProbeTally => {
			const listener = byteListeners.get(port);
			if (listener) {
				emulator().remove_listener(outputEvent(port), listener);
				byteListeners.delete(port);
			}
			const finalTally = snapshot(port);
			settleWaiters(port, { count: finalTally.count, at: finalTally.lastAt, timedOut: true });
			return finalTally;
		};

		return {
			send: (port, data) => {
				const bytes =
					typeof data === 'string' ? encoder.encode(data) : Uint8Array.from(data);
				const started = performance.now();
				emulator().serial_send_bytes(port, bytes);
				return performance.now() - started;
			},
			sendPattern: (port, size, byte = 0x78) => {
				const bytes = new Uint8Array(size).fill(byte & 0xff);
				const started = performance.now();
				emulator().serial_send_bytes(port, bytes);
				return performance.now() - started;
			},
			record: (port) => {
				stopRecord(port);
				const tally: ProbeTally = {
					count: 0,
					firstAt: 0,
					lastAt: 0,
					gaps: 0,
					maxGapMs: 0,
					tail: '',
				};
				tallies.set(port, tally);
				const listener = (byte: number) => {
					const at = performance.now();
					if (tally.count === 0) {
						tally.firstAt = at;
					} else {
						const gap = at - tally.lastAt;
						if (gap >= 1) {
							tally.gaps++;
							if (gap > tally.maxGapMs) tally.maxGapMs = gap;
						}
					}
					tally.lastAt = at;
					tally.count++;
					if (byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)) {
						tally.tail += String.fromCharCode(byte);
						if (tally.tail.length > 4096) tally.tail = tally.tail.slice(-2048);
					}
					const queue = waiters.get(port);
					if (queue?.length) {
						for (let i = queue.length - 1; i >= 0; i--) {
							if (tally.count >= queue[i].count) {
								clearTimeout(queue[i].timer);
								queue[i].resolve({ count: tally.count, at });
								queue.splice(i, 1);
							}
						}
					}
				};
				byteListeners.set(port, listener);
				emulator().add_listener(outputEvent(port), listener);
			},
			recorded: snapshot,
			stopRecord,
			waitCount: (port, count, timeoutMs = 30_000) => {
				return new Promise<ProbeWaited>((resolve) => {
					const tally = tallies.get(port);
					if (!byteListeners.has(port)) {
						// No recorder, so nothing will ever resolve this.
						resolve({ count: tally?.count ?? 0, at: -1, timedOut: true });
						return;
					}
					if (tally && tally.count >= count) {
						resolve({ count: tally.count, at: tally.lastAt });
						return;
					}
					const queue = waiters.get(port) ?? [];
					waiters.set(port, queue);
					const entry = {
						count,
						resolve,
						timer: setTimeout(() => {
							const i = queue.indexOf(entry);
							if (i >= 0) queue.splice(i, 1);
							resolve({ count: tallies.get(port)?.count ?? 0, at: -1, timedOut: true });
						}, timeoutMs),
					};
					queue.push(entry);
				});
			},
			watchModem: (port) => {
				if (modemListeners.has(port)) return;
				const log: ModemEvent[] = [];
				modemLogs.set(port, log);
				const on = (line: ModemEvent['line']) => (value: boolean) => {
					log.push({ line, value, at: performance.now() });
				};
				const dtr = on('dtr');
				const rts = on('rts');
				// Stays a member call: v86's add_listener reaches this.bus.
				const emu = emulator() as unknown as {
					add_listener(name: string, fn: (v: boolean) => void): void;
				};
				emu.add_listener(`serial${port}-data-terminal-ready-output`, dtr);
				emu.add_listener(`serial${port}-request-to-send-output`, rts);
				modemListeners.set(port, [dtr, rts]);
			},
			modemEvents: (port) => [...(modemLogs.get(port) ?? [])],
			setCts: (port, value) => emulator().serial_set_clear_to_send(port, value),
			setDsr: (port, value) => emulator().serial_set_data_set_ready(port, value),
			setDcd: (port, value) => emulator().serial_set_carrier_detect(port, value),
			setRing: (port, value) => emulator().serial_set_ring_indicator(port, value),
			uartState: (port) => {
				const uart = (
					this.emulator as unknown as {
						v86?: {
							cpu?: {
								devices?: Record<
									string,
									{
										input?: unknown[];
										ier?: number;
										modem_control?: number;
										modem_status?: number;
									}
								>;
							};
						};
					} | null
				)?.v86?.cpu?.devices?.[`uart${port}`];
				if (!uart) return null;
				return {
					backlog: Array.isArray(uart.input) ? uart.input.length : 0,
					ier: uart.ier ?? 0,
					mcr: uart.modem_control ?? 0,
					msr: uart.modem_status ?? 0,
				};
			},
		};
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
		await this.whenUp();
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
	 * sanctioned nested paths — `share/local/<name>` (share-store's
	 * ensureLocalDir) and `.vinx/tmp/<name>` (the control plane's resource
	 * namespace, created by inittab at boot) — whose directories must already
	 * exist in the guest; v86's create_file walks the tree, it does not
	 * mkdir. Boots the VM first if needed.
	 */
	async putFile(name: string, bytes: Uint8Array): Promise<void> {
		await this.whenUp();
		const rel = name.replace(/^\/+/, '');
		// v86's create_file always makes a NEW inode (the parent's mode & 0644,
		// regular): a file that already existed is replaced, and its mode with
		// it. Rewriting a script — write_file over the `run` that `app new`
		// made executable — stripped the exec bit and `app check` then failed
		// on ENTRY_NOT_EXEC, the file the model had just edited in front of
		// it. Carry the old mode over, the way `cp` onto an existing file
		// would (the bytes change, the permissions do not).
		const fs = this.fs9p();
		const before = fs ? fs.SearchPath(rel) : null;
		const mode = before && before.id !== -1 ? fs!.GetInode(before.id).mode : null;
		await this.emulator!.create_file(rel, bytes);
		if (mode !== null && fs) {
			const after = fs.SearchPath(rel);
			if (after.id !== -1) fs.GetInode(after.id).mode = mode;
		}
	}

	/** Read a file back from the shared directory; rejects if it is missing.
	 * An existing empty file reads as empty bytes — v86's read_file rejects
	 * with FileNotFoundError for that too (get_data has no buffer for an
	 * inode nothing was ever written to and returns null), and a snapshot
	 * that took "not found" at its word would keep a stale copy of a file
	 * the guest emptied (`app disable` of the last enabled app writes a
	 * 0-byte /data/apps/enabled) for good. */
	async readFile(name: string): Promise<Uint8Array> {
		await this.whenUp();
		const rel = name.replace(/^\/+/, '');
		try {
			return await this.emulator!.read_file(rel);
		} catch (e) {
			const fs = this.fs9p();
			const walk = fs?.SearchPath(rel);
			if (fs && walk && walk.id !== -1 && !fs.IsDirectory(walk.id) && fs.GetInode(walk.id).size === 0) {
				return new Uint8Array(0);
			}
			throw e;
		}
	}

	/**
	 * List a /data directory from the page-side inodes — the page's own
	 * filesystem needs no guest round trip (§8.2). `name` is 9p-root
	 * relative; '' is /data itself. Rejects when the name is not a
	 * directory.
	 */
	async listData(name: string): Promise<DataEntry[]> {
		await this.whenUp();
		const fs = this.fs9p();
		if (!fs) throw new Error('the VM was shut down');
		const rel = name.replace(/^\/+/, '').replace(/\/+$/, '');
		let dirId = 0;
		if (rel !== '') {
			const walk = fs.SearchPath(rel);
			if (walk.id === -1) throw new Error(`no such directory in /data: ${rel}`);
			dirId = walk.id;
		}
		if (!fs.IsDirectory(dirId)) throw new Error(`not a directory: /data/${rel}`);
		return fs.GetChildren(dirId).map((child) => {
			const walk = fs.SearchPath(rel === '' ? child : `${rel}/${child}`);
			const inode = fs.GetInode(walk.id);
			return {
				name: child,
				size: inode.size,
				mtime: inode.mtime,
				mode: inode.mode,
				dir: fs.IsDirectory(walk.id),
			};
		});
	}

	/** `mkdir -p` inside /data, page-side: create_file walks but never
	 * mkdirs, so nested writes need the parents made here first. */
	async ensureDir(name: string): Promise<void> {
		await this.whenUp();
		const fs = this.fs9p();
		if (!fs) throw new Error('the VM was shut down');
		const segs = name
			.replace(/^\/+/, '')
			.split('/')
			.filter((s) => s !== '' && s !== '.');
		if (segs.some((s) => s === '..')) throw new Error(`a /data path may not climb: ${name}`);
		let parent = 0;
		let at = '';
		for (const seg of segs) {
			at = at ? `${at}/${seg}` : seg;
			const walk = fs.SearchPath(at);
			if (walk.id === -1) parent = fs.CreateDirectory(seg, parent);
			else if (!fs.IsDirectory(walk.id)) throw new Error(`not a directory: /data/${at}`);
			else parent = walk.id;
		}
	}

	/**
	 * Set or clear the execute bits on a /data file, page-side: GetInode
	 * hands back the live inode object, and the guest reads mode through 9p
	 * getattr from exactly that object — the chmod round trip share-store's
	 * restore used to make is not owed. Quietly does nothing for a missing
	 * name (a stale exec-list entry must not fail a whole restore batch).
	 */
	setExecData(name: string, exec: boolean): void {
		const fs = this.fs9p();
		if (!fs) return;
		const walk = fs.SearchPath(name.replace(/^\/+/, ''));
		if (walk.id === -1) return;
		const inode = fs.GetInode(walk.id);
		inode.mode = exec ? inode.mode | 0o111 : inode.mode & ~0o111;
	}

	/** Best-effort page-side unlink in /data (staging relays, spent output
	 * refs). A no-op before boot or for a name that is not there. */
	deleteData(name: string): void {
		const fs = this.fs9p();
		if (!fs) return;
		const rel = name.replace(/^\/+/, '');
		const walk = fs.SearchPath(rel);
		if (walk.id === -1 || walk.parentid === -1) return;
		const base = rel.split('/').pop();
		if (base) fs.Unlink(walk.parentid, base);
	}

	// ── run_shell, the proc.run adapter (§15 Phase 2) ──

	/**
	 * Run a command in the VM: `sh -c` as root, stdout+stderr combined,
	 * starting in /data. Rides proc.run on the ttyS3 control plane: rund
	 * executes (eight jobs at once; OVERLOADED past that), a long command is
	 * staged as a §6.8 scriptRef because a control frame carries 4 KiB, and
	 * a big result comes back as an output ref this side reads over 9p —
	 * whole up to the old 64 KiB ceiling, an explicit truncation marker past
	 * it. Rejects when the call could not run at all (link down, params
	 * refused): the command may never have started, which is a tool failure,
	 * not an exit code.
	 */
	async runShell(command: string, timeoutS = 30): Promise<RunResult> {
		// whenUp: waits out a boot, re-boots a machine remembered 'on' (a
		// prior 'failed' is re-attempted, not cached — boot() resets on
		// failure), and refuses with MachineOffError for one left off.
		await this.whenUp();
		const rpc = this.rpc;
		if (!rpc) throw new Error('the VM was shut down');
		const timeoutMs = Math.max(1, Math.ceil(timeoutS)) * 1000;
		const opts = { deadlineMs: timeoutMs + CHANNEL_GRACE_MS };
		const bytes = encoder.encode(command);
		let staged: string | null = null;
		try {
			let reply: unknown;
			if (bytes.length > RUN_INLINE_MAX) {
				staged = `.vinx/tmp/run-${Math.random().toString(16).slice(2, 10)}.sh`;
				await this.putFile(staged, bytes);
				reply = await rpc.call(
					'proc.run',
					{ scriptRef: { path: `/data/${staged}`, size: bytes.length }, timeoutMs },
					opts,
				);
			} else {
				reply = await rpc.call('proc.run', { command, timeoutMs }, opts);
			}
			return await this.collectRun(reply as ProcRunReply);
		} catch (e) {
			if (e instanceof RpcCallError) {
				// Surface the §6.4 name and hint rather than inventing an
				// exit code for a command that may never have started.
				throw new Error(
					`run_shell could not complete: ${e.name}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`,
				);
			}
			throw e;
		} finally {
			if (staged) this.deleteData(staged);
		}
	}

	/**
	 * Fold a proc.run reply into the adapter's {exit_code, output} shape.
	 * An output ref is this caller's to spend (§6.8 owner): read back over
	 * 9p and deleted when it fits the old inline ceiling, else the head is
	 * inlined and the marker names the ref — which stays for read_file,
	 * until the boot sweep reclaims the namespace.
	 */
	private async collectRun(reply: ProcRunReply): Promise<RunResult> {
		const exit_code = typeof reply.exitCode === 'number' ? reply.exitCode : 125;
		let output = typeof reply.stdout === 'string' ? reply.stdout : '';
		if (typeof reply.stdoutB64 === 'string') {
			try {
				output = fromBase64(reply.stdoutB64);
			} catch {
				output = '(rund sent undecodable output)';
			}
		}
		const ref = reply.truncated ? reply.output : undefined;
		if (ref && typeof ref.path === 'string') {
			const rel = ref.path.replace(/^\/data\//, '');
			try {
				const bytes = await this.readFile(rel);
				if (bytes.length <= RUN_OUTPUT_CAP) {
					output = decoder.decode(bytes);
					this.deleteData(rel);
				} else {
					// The byte cut can split a UTF-8 sequence; the lossy decode
					// (U+FFFD) is the same behaviour agentd's head -c had.
					output =
						decoder.decode(bytes.subarray(0, RUN_OUTPUT_CAP)) +
						`\n[output truncated after ${RUN_OUTPUT_CAP} bytes: ${ref.size ?? bytes.length} bytes total` +
						(reply.droppedBytes ? ` (${reply.droppedBytes} more were dropped)` : '') +
						`; the full output is at ${ref.path} — read_file can fetch it, until this machine reboots]`;
				}
			} catch {
				// The ref could not be read back (a 9p hiccup); the inline
				// head rund sent still stands, marked for what it is.
				output += `\n[output truncated: ${ref.size ?? '?'} bytes total at ${ref.path}]`;
			}
		}
		return { exit_code, output };
	}

	/** v86's 9p filesystem object (see Fs9pApi); null before construct. */
	private fs9p(): Fs9pApi | null {
		return (this.emulator as unknown as { fs9p?: Fs9pApi } | null)?.fs9p ?? null;
	}

	// ── ttyS3, the control plane's UART ──

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

	/** The control link, for tests and future adapters; null before boot. */
	get rpcLink(): RpcLink | null {
		return this.rpc;
	}

	/**
	 * Call a guest-side method over the control link (proc.run in Phase 1).
	 * Rejects with RpcCallError — code and name are the stable contract —
	 * or with MachineOffError when the machine is off and the person left it
	 * that way (whenUp, machine-power.ts).
	 */
	async rpcCall(
		method: string,
		params?: Record<string, unknown>,
		opts?: { deadlineMs?: number; signal?: AbortSignal },
	): Promise<unknown> {
		await this.whenUp();
		if (!this.rpc) throw new Error('the control link never came up');
		return this.rpc.call(method, params, opts);
	}

	/** One in-flight proc.pty at a time: rpcCall waits out the boot, so
	 * mashing the terminal button on a machine still starting would queue
	 * one call per click and burst that many shell windows at ready.
	 * While a call is in flight, further clicks are the same wish already
	 * granted — dropped, not queued. (rpcd sends stream.opened before the
	 * proc.pty reply lands, so by the unlock the window is already up and
	 * a ready machine still opens one window per deliberate click.) */
	private ptyOpening = false;

	async openShellWindow(): Promise<void> {
		if (this.ptyOpening) return;
		this.ptyOpening = true;
		try {
			await this.rpcCall('proc.pty', {}, { deadlineMs: 15_000 });
		} finally {
			this.ptyOpening = false;
		}
	}

	/** Stop the emulator; the link's detach fails everything pending. */
	destroy() {
		this.rpc?.detach();
		this.rpc = null;
		this.mux?.closeAll();
		this.mux = null;
		void this.serialDetach?.();
		this.emulator?.destroy();
		this.emulator = null;
		this.setState('off');
		this.booting = null;
	}
}

/** The page's one VM. Chat page and terminal page each get their own tab. */
let shared: VinxVm | null = null;

export function sharedVm(options?: VmOptions): VinxVm {
	if (!shared) {
		shared = new VinxVm(options);
		// Both pages get the same /data semantics: restored on boot,
		// mirrored to IndexedDB while the tab lives (owner tabs only).
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
