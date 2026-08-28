/**
 * The network control: a small trigger + popover for choosing the VM's
 * network, so nobody has to run a script or edit a `?relay=` URL.
 *
 * Four choices, matching vm-config.ts, sorted by who can see whom:
 *   - Relay LAN (a ws(s):// URL): a wsproxy server — everyone on it shares
 *     one ethernet segment and the server NATs them out to the internet.
 *     v86's public relay is prefilled, so this works with zero setup.
 *   - Internet (a wisp(s):// URL): pure outbound internet through a wisp
 *     proxy the user runs themselves; peers never see each other. The panel
 *     links to the repo docs for how.
 *   - Host LAN (host): the default. VMs in your tabs reach each other,
 *     nothing reaches the internet. No server, no risk.
 *   - Bridge LAN (bridge): the same hub, plus the bridge section for joining
 *     it to friends' LANs over WebRTC.
 *
 * Host and Bridge share the v86 backend, so moving between them applies on
 * the spot; only a relay leg changing restarts the VM (Save reloads the
 * page). This component owns its own open state and its own dark styling, so
 * it drops into either page without touching the vendored chat UI.
 *
 *   <NetworkControl variant="inline" />   the terminal footer chip
 *   <NetworkControl variant="fab" />      a floating button for the chat page
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { currentRelay, relayLabel, setRelay, WSPROXY_DEFAULT_RELAY } from './vm-config';
import {
	currentManual,
	currentRoom,
	hostRoom,
	iceList,
	joinRoom,
	manualAnswer,
	manualInvite,
	MANUAL_ROOM,
	onBridgeActivity,
	setIceList,
} from './net-bridge';
import { bridgeRelays, setBridgeRelays } from './nostr-signal';
import { trackRoom } from './bridge-ctl';
import { t, tf } from './i18n';
import { existingVm, sharedVm, type RelayHealth, type VmState } from './vm';
import { VINX_LOGO } from '../vendor/ui/src/assets/vinx-logo';
import './net-panel.css';

// Where the two "how do I run one?" links point: this repo's own
// deploy/self-host.md, one Docker command per relay flavor. Replace
// <user>/<repo> after publishing (same placeholder as the
// Deploy-to-Cloudflare button).
const DOCS_URL = 'https://github.com/your-org/vinx/blob/main/deploy/self-host.md#internet-wisp';
const V86_NET_DOCS_URL =
	'https://github.com/your-org/vinx/blob/main/deploy/self-host.md#relay-lan-wsproxy-wsnic';

/** A translated label with `backtick` runs rendered as <code>. */
function T({ k }: { k: string }) {
	const parts = t(k).split('`');
	return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}

type Choice = 'host' | 'bridge' | 'wsproxy' | 'wisp';

/**
 * Whether the Bridge LAN surfaces (the mode card, the bridge panel and the
 * chip's shortcut into it) render at all. Hidden by default: WebRTC between
 * arbitrary home networks proved too flaky to sell as a mode — even peers on
 * one router can fail to connect (AP isolation, mDNS candidates going
 * nowhere). The machinery all stays: the guest's `bridge start` CLI still
 * works, and setting `localStorage['vinx.bridge.ui'] = '1'` brings the UI
 * back (the E2E suite does exactly that).
 */
function bridgeUi(): boolean {
	try {
		return localStorage.getItem('vinx.bridge.ui') === '1';
	} catch {
		return false;
	}
}

function initialChoice(token: string): { choice: Choice; url: string } {
	// With the bridge UI hidden, a stored `bridge` wears the Host LAN card:
	// the two share the in-browser hub backend, so that is what actually
	// runs — and Save writes `host`, retiring the stale token.
	if (token === 'bridge') return { choice: bridgeUi() ? 'bridge' : 'host', url: '' };
	if (token === 'host' || token === 'fetch') return { choice: 'host', url: '' };
	if (/^wisps?:\/\//i.test(token)) return { choice: 'wisp', url: token };
	return { choice: 'wsproxy', url: token }; // a ws(s):// URL
}

function isWsproxyUrl(v: string): boolean {
	return /^wss?:\/\/\S+/i.test(v.trim());
}

function isWispUrl(v: string): boolean {
	return /^wisps?:\/\/\S+/i.test(v.trim());
}

type RelayChoice = Extract<Choice, 'wsproxy' | 'wisp'>;
type ProbeStatus =
	| 'testing'
	| 'ok'
	| 'failed'
	| 'timeout'
	| 'mixed'
	| 'policy'
	| 'denied'
	| 'insecure';

/** A host that lives on the local network or loopback, as far as a string
 * can tell: the private/link-local/loopback IPv4 literals plus localhost.
 * Hostnames that *resolve* to private addresses are invisible here — this is
 * a best-effort gate for the self-hosted-relay case, which is IP literals. */
function isLocalHost(host: string): boolean {
	if (/^(localhost|.*\.local)$/i.test(host)) return true;
	return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(host);
}

/** Why a WebSocket to the local network never answers: Chrome's Local
 * Network Access gate. A frame without the `local-network-access` policy
 * (or a site the person blocked) gets its request *parked*, not rejected —
 * no error event ever fires, and a probe would misreport it as a timeout.
 * Asking the policy and permission up front turns that silence into words.
 * Browsers without either API (Firefox, older Chrome) report nothing. */
async function localNetworkVerdict(): Promise<'policy' | 'denied' | 'insecure' | null> {
	const doc = document as Document & {
		permissionsPolicy?: { allowsFeature: (f: string) => boolean; features?: () => string[] };
		featurePolicy?: { allowsFeature: (f: string) => boolean; features?: () => string[] };
	};
	try {
		const policy = doc.permissionsPolicy ?? doc.featurePolicy;
		// allowsFeature() answers false for feature names the browser has
		// never heard of — only a browser that *knows* the feature and still
		// says no is actually blocking us.
		if (
			policy?.features?.().includes('local-network-access') &&
			!policy.allowsFeature('local-network-access')
		) {
			return 'policy';
		}
	} catch {
		/* an unknown feature name throws in some builds; stay quiet */
	}
	try {
		const perm = await navigator.permissions.query({
			name: 'local-network-access' as PermissionName,
		});
		// On a plain-http page (a LAN IP, not localhost) the permission is
		// unobtainable: Chrome answers "denied" without ever prompting.
		// That is a different disease than a person having clicked Block —
		// the cure is https or localhost, not the site-settings page.
		if (perm.state === 'denied') {
			return window.isSecureContext ? 'denied' : 'insecure';
		}
	} catch {
		/* the permission name is unknown here; stay quiet */
	}
	return null;
}

/** Try the exact WebSocket handshake v86 will use. Wisp's two schemes are
 * presentation-only: its adapter makes this same mapping before constructing
 * the socket. Opening proves DNS, TCP, TLS (when applicable) and the upgrade;
 * no application data is sent. */
async function probeRelay(
	kind: RelayChoice,
	rawUrl: string,
): Promise<Exclude<ProbeStatus, 'testing'>> {
	const url =
		kind === 'wisp'
			? rawUrl.trim().replace(/^wisp:/i, 'ws:').replace(/^wisps:/i, 'wss:')
			: rawUrl.trim();
	if (location.protocol === 'https:' && /^ws:/i.test(url)) {
		return 'mixed';
	}
	let host = '';
	try {
		host = new URL(url).hostname;
	} catch {
		return 'failed';
	}
	if (isLocalHost(host)) {
		const verdict = await localNetworkVerdict();
		if (verdict) return verdict;
	}
	return new Promise((resolve) => {
		let socket: WebSocket;
		let settled = false;
		const finish = (status: Exclude<ProbeStatus, 'testing'>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.onopen = null;
			socket.onerror = null;
			socket.onclose = null;
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close();
			}
			resolve(status);
		};
		let timer: ReturnType<typeof setTimeout>;
		try {
			socket = new WebSocket(url);
		} catch {
			return resolve('failed');
		}
		timer = setTimeout(() => finish('timeout'), 5_000);
		socket.onopen = () => finish('ok');
		socket.onerror = () => finish('failed');
		socket.onclose = () => finish('failed');
	});
}

/** This machine's name and LAN address, when a VM is up to ask. The roster
 * shows these to everyone in the room; a page with no running VM (the chat
 * page before boot) is just "browser". */
async function guestIdentity(): Promise<{ name: string; ip: string }> {
	const vm = sharedVm();
	// The cast keeps the union: TS cannot see the synchronous onState call
	// below assigning, and would otherwise narrow `state` to 'off' for good.
	let state = 'off' as VmState;
	vm.onState((s) => {
		state = s;
	})();
	if (state !== 'ready') return { name: 'browser', ip: '' };
	try {
		const r = await vm.runShell('cat /run/inbrowser-host', 5);
		const n = r.output.match(/(\d+)/)?.[1];
		if (n) return { name: `vinx${n}`, ip: `10.0.2.${n}` };
	} catch {
		/* boot race; the name is cosmetic */
	}
	return { name: 'browser', ip: '' };
}

/**
 * One small schematic per network story, so the words above it have a
 * picture: where do this machine's packets go? Drawn in the panel's muted
 * ink (currentColor), so both themes get it for free.
 */
function ModeDiagram({ kind }: { kind: 'host' | 'wsproxy' | 'wisp' | 'room' | 'manual' }) {
	const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 } as const;
	const tx = { fill: 'currentColor', fontSize: 9, stroke: 'none' } as const;
	if (kind === 'host') {
		return (
			<svg className="np-diagram" viewBox="0 0 260 62" aria-hidden>
				<rect x="8" y="6" width="52" height="22" rx="3" {...s} />
				<text x="34" y="20" textAnchor="middle" {...tx}>{t('npDgVmTab')}</text>
				<rect x="72" y="6" width="52" height="22" rx="3" {...s} />
				<text x="98" y="20" textAnchor="middle" {...tx}>{t('npDgVmTab')}</text>
				<path d="M34 28v8M98 28v8M18 36h96" {...s} />
				<text x="66" y="52" textAnchor="middle" {...tx}>{t('npDgHub')}</text>
				<circle cx="202" cy="21" r="11" {...s} />
				<path d="M194 13l16 16" {...s} />
				<text x="202" y="52" textAnchor="middle" {...tx}>{t('npDgNoNet')}</text>
			</svg>
		);
	}
	if (kind === 'wsproxy') {
		// Two boxes feed the relay: this VM and everyone else on it — the
		// point of wsproxy is that they all land on one shared segment.
		return (
			<svg className="np-diagram" viewBox="0 0 260 78" aria-hidden>
				<rect x="8" y="4" width="52" height="22" rx="3" {...s} />
				<text x="34" y="18" textAnchor="middle" {...tx}>{t('npDgVmTab')}</text>
				<rect x="8" y="32" width="52" height="22" rx="3" {...s} />
				<text x="34" y="46" textAnchor="middle" {...tx}>{t('npDgOthers')}</text>
				<path d="M60 15 96 25M60 43 96 33" {...s} />
				<rect x="96" y="18" width="60" height="22" rx="3" {...s} />
				<text x="126" y="32" textAnchor="middle" {...tx}>{t('npDgWsproxy')}</text>
				<path d="M156 29h32m0 0-5-3.5M188 29l-5 3.5" {...s} />
				<circle cx="206" cy="29" r="11" {...s} />
				<path d="M195 29h22M206 18c-5 6-5 16 0 22c5-6 5-16 0-22" {...s} />
				<text x="206" y="57" textAnchor="middle" {...tx}>{t('npDgNet')}</text>
				<text x="130" y="73" textAnchor="middle" {...tx} opacity={0.7} fontSize={8}>{t('npDgWsNote')}</text>
			</svg>
		);
	}
	if (kind === 'wisp') {
		return (
			<svg className="np-diagram" viewBox="0 0 260 76" aria-hidden>
				<rect x="8" y="15" width="52" height="22" rx="3" {...s} />
				<text x="34" y="29" textAnchor="middle" {...tx}>{t('npDgVmTab')}</text>
				<path d="M60 26h32m0 0-5-3.5M92 26l-5 3.5" {...s} />
				<rect x="96" y="15" width="60" height="22" rx="3" {...s} />
				<text x="126" y="29" textAnchor="middle" {...tx}>{t('npDgWisp')}</text>
				<path d="M156 26h32m0 0-5-3.5M188 26l-5 3.5" {...s} />
				<circle cx="206" cy="26" r="11" {...s} />
				<path d="M195 26h22M206 15c-5 6-5 16 0 22c5-6 5-16 0-22" {...s} />
				<text x="206" y="54" textAnchor="middle" {...tx}>{t('npDgNet')}</text>
				<text x="130" y="71" textAnchor="middle" {...tx} opacity={0.7} fontSize={8}>{t('npDgWispNote')}</text>
			</svg>
		);
	}
	// Both WebRTC legs share the two-hub stage; only the middle differs.
	const hubs = (
		<>
			<rect x="8" y="8" width="34" height="16" rx="3" {...s} />
			<text x="25" y="19" textAnchor="middle" {...tx}>VM</text>
			<rect x="48" y="8" width="34" height="16" rx="3" {...s} />
			<text x="65" y="19" textAnchor="middle" {...tx}>VM</text>
			<path d="M25 24v8M65 24v8M14 32h64" {...s} />
			<text x="46" y="46" textAnchor="middle" {...tx}>{t('npDgYourHub')}</text>
			<rect x="218" y="8" width="34" height="16" rx="3" {...s} />
			<text x="235" y="19" textAnchor="middle" {...tx}>VM</text>
			<rect x="258" y="8" width="34" height="16" rx="3" {...s} />
			<text x="275" y="19" textAnchor="middle" {...tx}>VM</text>
			<path d="M235 24v8M275 24v8M224 32h64" {...s} />
			<text x="256" y="46" textAnchor="middle" {...tx}>{t('npDgTheirHub')}</text>
		</>
	);
	if (kind === 'room') {
		return (
			<svg className="np-diagram" viewBox="0 0 300 88" aria-hidden>
				{hubs}
				<rect x="122" y="2" width="58" height="16" rx="3" {...s} />
				<text x="151" y="13" textAnchor="middle" {...tx} fontSize={8}>{t('npDgCodeRelay')}</text>
				<path d="M78 32L126 18M224 32L176 18" {...s} strokeDasharray="3 3" />
				<path d="M78 32C120 58 182 58 224 32" {...s} />
				<text x="151" y="66" textAnchor="middle" {...tx}>{t('npDgP2P')}</text>
				<text x="151" y="82" textAnchor="middle" {...tx} opacity={0.7}>{t('npDgRoomNote')}</text>
			</svg>
		);
	}
	// manual: nothing above the hubs — the codes ride whatever channel you have.
	return (
		<svg className="np-diagram" viewBox="0 0 300 88" aria-hidden>
			{hubs}
			<path d="M78 32C120 6 182 6 224 32" {...s} strokeDasharray="3 3" />
			<text x="151" y="10" textAnchor="middle" {...tx} fontSize={8}>{t('npDgCarry')}</text>
			<path d="M78 32C120 58 182 58 224 32" {...s} />
			<text x="151" y="66" textAnchor="middle" {...tx}>{t('npDgP2P')}</text>
			<text x="151" y="82" textAnchor="middle" {...tx} opacity={0.7}>{t('npDgManualNote')}</text>
		</svg>
	);
}

/**
 * "Bridge to friends": join this origin's LAN to other people's over WebRTC
 * (net-bridge.ts). Two ways in, differing only in how the handshake codes
 * travel. The room path: host a room, read the six-letter code aloud,
 * friends type it — SDP travels sealed through public Nostr relays. The
 * manual path carries the same SDP by clipboard instead, no relay involved —
 * the result is the same room, roster, `bridge say` and all. Bridges outlive
 * the panel (module singletons), so reopening it resumes wherever things
 * stand.
 *
 * Its own popover on purpose: minting and carrying codes is a live,
 * call-like action, not a setting — the network dialog's Save/Cancel never
 * governs anything here. Reached from the Bridge LAN card's "Manage
 * bridge…" button, or straight from the footer chip while a bridge runs.
 *
 * A bridge extends the *in-browser hub*. A VM whose NIC was wired to a
 * relay/wisp at boot is not on that hub — a room would connect and carry
 * nothing — so the actions gate on the running backend.
 */
function BridgePanel({ onClose }: { onClose: () => void }) {
	const [, force] = useReducer((n: number) => n + 1, 0);
	const [mode, setMode] = useState<'idle' | 'joining' | 'manual-join'>('idle');
	// Which way the handshake codes travel. Panel-local and not persisted:
	// the room path is the right default whenever the panel opens fresh.
	const [sig, setSig] = useState<'room' | 'manual'>('room');
	const [paste, setPaste] = useState('');
	const [code, setCode] = useState('');
	const [err, setErr] = useState('');
	const room = currentRoom();
	const manual = currentManual();
	const isManual = room?.room === MANUAL_ROOM;
	// The manual exchange is still in flight: the fold shows the codes. The
	// answering side is 'on' (it switches from the start) but alone until
	// the invite side pastes the answer, so members counts too.
	const manualPending =
		!!room &&
		isManual &&
		(room.state === 'signalling' || (room.state === 'on' && room.members.length < 2));
	// A manual exchange in flight commandeers the manual card: the pairing
	// codes must stay on screen whichever card was picked before.
	const path: 'room' | 'manual' = manualPending ? 'manual' : sig;

	useEffect(() => {
		room?.onChange(force);
	}, [room]);

	const guard = (work: () => Promise<unknown>) => {
		setErr('');
		work().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
	};

	const reset = () => {
		room?.stop();
		setMode('idle');
		setPaste('');
		setCode('');
		setErr('');
		force();
	};

	const host = () =>
		guard(async () => {
			const me = await guestIdentity();
			trackRoom(await hostRoom(me.name, me.ip));
			force();
		});

	const join = () =>
		guard(async () => {
			const me = await guestIdentity();
			setMode('idle');
			trackRoom(await joinRoom(code, me.name, me.ip));
			force();
		});

	// The bridge extends the in-browser hub; a NIC wired to a relay/wisp at
	// boot never touches that hub, so a room would be an empty promise.
	// (Reading options creates the singleton but boots nothing.)
	const hubBacked = sharedVm().options.networkRelay === 'inbrowser';

	return (
		<div className="np-backdrop" onClick={onClose}>
			<div className="np-panel" onClick={(e) => e.stopPropagation()}>
				<div className="np-title">{t('npBridgeTitle')}</div>
				<div className="np-bridge">
					<div className="np-opt-d">
						<T k="npBridgeIntro" />
					</div>

					{!hubBacked && <div className="np-offhub">{t('npBridgeOffHub')}</div>}

					{hubBacked && (!room || manualPending) && (
						<div className="np-sig">
							<label className={`np-opt np-sig-opt np-sig-room${path === 'room' ? ' on' : ''}`}>
								<input
									type="radio"
									name="np-sig"
									checked={path === 'room'}
									disabled={manualPending}
									onChange={() => { setSig('room'); setMode('idle'); setErr(''); }}
								/>
								<div>
									<div className="np-opt-h">{t('npSigRoomH')}</div>
									<div className="np-opt-d">{t('npSigRoomD')}</div>
									{path === 'room' && (
										<>
											<ModeDiagram kind="room" />
											{mode === 'idle' && (
												<div className="np-bridge-row">
													<button type="button" className="np-room-host" onClick={host}>
														{t('npHostRoom')}
													</button>
													<button type="button" className="np-room-join" onClick={() => setMode('joining')}>
														{t('npHaveCode')}
													</button>
												</div>
											)}
											{mode === 'joining' && (
												<div className="np-bridge-row">
													<input
														className="np-room-code-input"
														type="text"
														spellCheck={false}
														autoFocus
														maxLength={6}
														placeholder={t('npRoomCodePh')}
														value={code}
														onChange={(e) => setCode(e.target.value.trim().toLowerCase())}
														onKeyDown={(e) => {
															if (e.key === 'Enter' && code.trim().length >= 4) join();
														}}
													/>
													<button type="button" onClick={() => { setMode('idle'); setCode(''); setErr(''); }}>
														{t('npBack')}
													</button>
													<button
														type="button"
														className="np-room-go"
														disabled={code.trim().length < 4}
														onClick={join}
													>
														{t('npJoin')}
													</button>
												</div>
											)}
											<AdvancedFold />
										</>
									)}
								</div>
							</label>
							<label className={`np-opt np-sig-opt np-sig-manual${path === 'manual' ? ' on' : ''}`}>
								<input
									type="radio"
									name="np-sig"
									checked={path === 'manual'}
									disabled={manualPending}
									onChange={() => { setSig('manual'); setMode('idle'); setErr(''); }}
								/>
								<div>
									<div className="np-opt-h">{t('npSigManualH')}</div>
									<div className="np-opt-d">{t('npSigManualD')}</div>
									{path === 'manual' && !manualPending && (
										<>
											<ModeDiagram kind="manual" />
											{mode !== 'manual-join' && (
												<div className="np-bridge-row">
													<button
														type="button"
														className="np-bridge-create"
														onClick={() =>
															guard(async () => {
																const me = await guestIdentity();
																trackRoom((await manualInvite(me.name, me.ip)).room);
																force();
															})
														}
													>
														{t('npCreateInvite')}
													</button>
													<button type="button" className="np-bridge-join" onClick={() => setMode('manual-join')}>
														{t('npHaveInvite')}
													</button>
												</div>
											)}
											{mode === 'manual-join' && (
												<>
													<textarea
														className="np-bridge-paste"
														placeholder={t('npPasteInvite')}
														spellCheck={false}
														value={paste}
														onChange={(e) => setPaste(e.target.value)}
													/>
													<div className="np-bridge-row">
														<button type="button" onClick={() => { setMode('idle'); setPaste(''); setErr(''); }}>
															{t('npBack')}
														</button>
														<button
															type="button"
															className="np-bridge-answer"
															disabled={!paste.trim()}
															onClick={() =>
																guard(async () => {
																	const me = await guestIdentity();
																	trackRoom((await manualAnswer(paste, me.name, me.ip)).room);
																	setPaste('');
																	setMode('idle');
																	force();
																})
															}
														>
															{t('npMakeAnswer')}
														</button>
													</div>
												</>
											)}
										</>
									)}
									{manualPending && manual && (
										<>
											<div className="np-opt-d">
												{manual.complete ? t('npSendInvite') : t('npSendAnswer')}
											</div>
											<textarea
												className="np-bridge-code"
												readOnly
												value={manual.code}
												onFocus={(e) => e.currentTarget.select()}
											/>
											{manual.complete ? (
												<>
													<textarea
														className="np-bridge-paste"
														placeholder={t('npPasteAnswer')}
														spellCheck={false}
														value={paste}
														onChange={(e) => setPaste(e.target.value)}
													/>
													<div className="np-bridge-row">
														<button type="button" onClick={reset}>{t('npCancel')}</button>
														<button
															type="button"
															className="np-bridge-connect"
															disabled={!paste.trim()}
															onClick={() => guard(async () => { await manual.complete!(paste); setPaste(''); })}
														>
															{t('npConnect')}
														</button>
													</div>
												</>
											) : (
												<div className="np-bridge-row">
													<button type="button" onClick={reset}>{t('npCancel')}</button>
													<span className="np-bridge-wait">{t('npWaitOther')}</span>
												</div>
											)}
										</>
									)}
								</div>
							</label>
						</div>
					)}

					{room && room.state === 'signalling' && !isManual && (
						<div className="np-bridge-row">
							<span className="np-bridge-wait">{tf('npConnecting', room.room)}</span>
							<button type="button" onClick={reset}>{t('npCancel')}</button>
						</div>
					)}

					{room && room.state === 'on' && !manualPending && (
						<>
							<div className="np-bridge-row">
								{isManual ? (
									<span className="np-bridge-status on">{t('npBridgedOne')}</span>
								) : (
									<>
										<span className="np-room-code" title={t('npCodeTitle')}>
											{room.room}
										</span>
										<button
											type="button"
											onClick={() => void navigator.clipboard?.writeText(room.room)}
											title={t('npCopyTitle')}
										>
											{t('npCopy')}
										</button>
									</>
								)}
								<button type="button" className="np-bridge-stop" onClick={reset}>
									{t('npDisconnect')}
								</button>
							</div>
							<div className="np-roster">
								{room.members.map((m) => (
									<div key={`${m.name}-${m.ip}`} className="np-roster-row">
										<span className="np-roster-name">{m.name}</span>
										<span className="np-roster-ip">{m.ip || '—'}</span>
										{m.host && <span className="np-roster-tag">{t('npHostTag')}</span>}
									</div>
								))}
								{!isManual && room.role === 'host' && room.members.length === 1 && (
									<div className="np-roster-row np-roster-empty">
										{t('npWaitFriends')} <code>bridge join {room.room}</code>
									</div>
								)}
							</div>
						</>
					)}

					{room && (room.state === 'failed' || room.state === 'closed') && (
						<div className="np-bridge-row">
							<span className="np-bridge-status">
								{room.state === 'failed' ? room.error : t('npClosed')}
							</span>
							<button type="button" onClick={reset}>{t('npReset')}</button>
						</div>
					)}

					{err && <div className="np-err">{err}</div>}
				</div>
				<div className="np-actions">
					<button type="button" className="np-cancel" onClick={onClose}>{t('npClose')}</button>
				</div>
			</div>
		</div>
	);
}

/** The settings dialog's one word about bridging: a live bridge under a
 * non-bridge radio deserves a warning — saving a relay mode takes this
 * machine off the bridged segment — and a kill switch. */
function BridgeStillUp({ netChoice }: { netChoice: Choice }) {
	const [, force] = useReducer((n: number) => n + 1, 0);
	const room = currentRoom();
	useEffect(() => {
		room?.onChange(force);
	}, [room]);
	if (netChoice === 'bridge' || !room || room.state === 'closed' || room.state === 'failed') {
		return null;
	}
	return (
		<div className="np-bridge">
			<div className="np-opt-h">{t('npBridgeTitle')}</div>
			<div className="np-bridge-row">
				<span className="np-bridge-status">{t('npStillUp')}</span>
				<button
					type="button"
					className="np-bridge-stop"
					onClick={() => {
						room.stop();
						force();
					}}
				>
					{t('npDisconnect')}
				</button>
			</div>
		</div>
	);
}

/** The room-code (Nostr) relay list and the ICE server list: stored locally,
 * read the next time a room or handshake is opened — no restart needed. An
 * empty field restores that list's defaults. Its own Save on purpose: these
 * apply immediately, unlike the mode radios governed by the dialog's Save. */
function AdvancedFold() {
	const [relays, setRelays] = useState(bridgeRelays().join(', '));
	const [ice, setIce] = useState(iceList().join(', '));
	const [saved, setSaved] = useState(false);

	const save = () => {
		setBridgeRelays(relays.trim());
		setIceList(ice.trim());
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	};

	return (
		<details className="np-fold">
			<summary>{t('npAdvSummary')}</summary>
			<div className="np-opt-d">{t('npAdvD')}</div>
			<input
				className="np-url"
				type="text"
				spellCheck={false}
				placeholder="wss://relay.example, wss://…"
				value={relays}
				onChange={(e) => setRelays(e.target.value)}
			/>
			<div className="np-opt-d"><T k="npAdvIceD" /></div>
			<input
				className="np-url"
				type="text"
				spellCheck={false}
				placeholder="stun:stun.example:3478, turn:turn.example:3478|user|pass"
				value={ice}
				onChange={(e) => setIce(e.target.value)}
			/>
			<div className="np-bridge-row">
				<button type="button" className="np-room-go" onClick={save}>
					{saved ? t('npSaved') : t('npSave')}
				</button>
			</div>
		</details>
	);
}

function Panel({ onClose, onManageBridge }: { onClose: () => void; onManageBridge: () => void }) {
	const token = currentRelay();
	const start = initialChoice(token);
	// A live bridge is the "Bridge LAN" mode in effect, whatever the stored
	// token says (bridging never writes storage — only Save does). Open on
	// what is actually running, so the bridge card lights up instead of
	// greeting the person with a "still up" warning. Only with the bridge
	// UI shown: hidden, a CLI-started room keeps the warning row instead.
	const live = currentRoom();
	if (
		bridgeUi() &&
		start.choice === 'host' &&
		live &&
		live.state !== 'closed' &&
		live.state !== 'failed'
	) {
		start.choice = 'bridge';
	}
	const [choice, setChoice] = useState<Choice>(start.choice);
	// One URL box per relay flavor, so switching cards never clobbers the
	// other's address. Each starts from the stored URL when it matches, else
	// from the flavor's natural default.
	const [wsUrl, setWsUrl] = useState(
		start.choice === 'wsproxy' && start.url ? start.url : WSPROXY_DEFAULT_RELAY,
	);
	const [wispUrl, setWispUrl] = useState(
		start.choice === 'wisp' && start.url ? start.url : 'wisp://127.0.0.1:5001/',
	);
	const [error, setError] = useState('');
	const [probe, setProbe] = useState<{ kind: RelayChoice; status: ProbeStatus } | null>(null);
	const probeSeq = useRef(0);

	// Host and Bridge share the v86 backend (the in-browser hub), so moving
	// between them applies on the spot. Only a relay leg changing requires a
	// restart: the VM wires its network at boot.
	const isRelay = (c: Choice) => c === 'wsproxy' || c === 'wisp';
	const needsReload = isRelay(choice) || isRelay(start.choice);

	const runProbe = async (kind: RelayChoice, url: string) => {
		if (kind === 'wsproxy' ? !isWsproxyUrl(url) : !isWispUrl(url)) {
			setError(t(kind === 'wsproxy' ? 'npWsUrlErr' : 'npWispUrlErr'));
			return;
		}
		setError('');
		const seq = ++probeSeq.current;
		setProbe({ kind, status: 'testing' });
		const status = await probeRelay(kind, url);
		if (seq === probeSeq.current) setProbe({ kind, status });
	};
	const resetProbe = () => {
		probeSeq.current++;
		setProbe(null);
		setError('');
	};
	const probeMessage = (kind: RelayChoice) => {
		if (probe?.kind !== kind) return null;
		const key = {
			testing: 'npProbeTesting',
			ok: 'npProbeOk',
			failed: 'npProbeFailed',
			timeout: 'npProbeTimeout',
			mixed: 'npProbeMixed',
			policy: 'npProbePolicy',
			denied: 'npProbeDenied',
			insecure: 'npProbeInsecure',
		}[probe.status];
		return (
			<div className={`np-probe-status ${probe.status === 'ok' ? 'ok' : probe.status === 'testing' ? '' : 'bad'}`}>
				{t(key)}
			</div>
		);
	};

	const save = () => {
		if (choice === 'wsproxy') {
			if (!isWsproxyUrl(wsUrl)) {
				setError(t('npWsUrlErr'));
				return;
			}
			setRelay(wsUrl.trim());
		} else if (choice === 'wisp') {
			if (!isWispUrl(wispUrl)) {
				setError(t('npWispUrlErr'));
				return;
			}
			setRelay(wispUrl.trim());
		} else {
			setRelay(choice);
		}
		if (!needsReload) {
			onClose();
			return;
		}
		// The VM starts its network at boot, so apply by restarting the page.
		// Inside a terminal pane the shell restarts *every* machine instead:
		// the mode is page-wide (localStorage), and two machines running
		// different networks would be a lie the UI tells.
		if (window.parent !== window) {
			window.parent.postMessage({ vinx: 'relay-changed' }, location.origin);
			return;
		}
		location.reload();
	};

	return (
		<div className="np-backdrop" onClick={onClose}>
			<div className="np-panel" onClick={(e) => e.stopPropagation()}>
				<div className="np-title">{t('npTitle')}</div>

				<label className={`np-opt np-opt-wsproxy${choice === 'wsproxy' ? ' on' : ''}`}>
					<input type="radio" name="np" checked={choice === 'wsproxy'} onChange={() => setChoice('wsproxy')} />
					<div>
						<div className="np-opt-h">{t('npWsproxyH')}</div>
						<div className="np-opt-d">
							<T k="npWsproxyD" />{' '}
							<a href={V86_NET_DOCS_URL} target="_blank" rel="noreferrer">{t('npHowRun')}</a>
						</div>
						{choice === 'wsproxy' && (
							<>
								<ModeDiagram kind="wsproxy" />
								<div className="np-probe-row">
									<input
										className="np-url"
										type="text"
										spellCheck={false}
										placeholder={WSPROXY_DEFAULT_RELAY}
										value={wsUrl}
										onChange={(e) => { setWsUrl(e.target.value); resetProbe(); }}
									/>
									<button
										type="button"
										className="np-probe"
										disabled={probe?.status === 'testing'}
										onClick={(e) => { e.preventDefault(); void runProbe('wsproxy', wsUrl); }}
									>
										{t('npProbe')}
									</button>
								</div>
								{probeMessage('wsproxy')}
							</>
						)}
					</div>
				</label>

				<label className={`np-opt np-opt-wisp${choice === 'wisp' ? ' on' : ''}`}>
					<input type="radio" name="np" checked={choice === 'wisp'} onChange={() => setChoice('wisp')} />
					<div>
						<div className="np-opt-h">{t('npWispH')}</div>
						<div className="np-opt-d">
							{t('npWispD')}{' '}
							<a href={DOCS_URL} target="_blank" rel="noreferrer">{t('npHowRun')}</a>
						</div>
						{choice === 'wisp' && (
							<>
								<ModeDiagram kind="wisp" />
								<div className="np-probe-row">
									<input
										className="np-url"
										type="text"
										spellCheck={false}
										placeholder="wisps://your-relay.example/"
										value={wispUrl}
										onChange={(e) => { setWispUrl(e.target.value); resetProbe(); }}
									/>
									<button
										type="button"
										className="np-probe"
										disabled={probe?.status === 'testing'}
										onClick={(e) => { e.preventDefault(); void runProbe('wisp', wispUrl); }}
									>
										{t('npProbe')}
									</button>
								</div>
								{probeMessage('wisp')}
							</>
						)}
					</div>
				</label>

				<label className={`np-opt np-opt-host${choice === 'host' ? ' on' : ''}`}>
					<input type="radio" name="np" checked={choice === 'host'} onChange={() => setChoice('host')} />
					<div>
						<div className="np-opt-h">{t('npHostH')} <span className="np-tag">{t('npDefaultTag')}</span></div>
						<div className="np-opt-d">{t('npHostD')}</div>
						{choice === 'host' && <ModeDiagram kind="host" />}
					</div>
				</label>

				{bridgeUi() && (
					<label className={`np-opt np-opt-bridge${choice === 'bridge' ? ' on' : ''}`}>
						<input type="radio" name="np" checked={choice === 'bridge'} onChange={() => setChoice('bridge')} />
						<div>
							<div className="np-opt-h">{t('npBridgeH')}</div>
							<div className="np-opt-d"><T k="npBridgeD" /></div>
							{choice === 'bridge' && (
								<div className="np-bridge-row">
									<button type="button" className="np-manage-bridge" onClick={onManageBridge}>
										{t('npManageBridge')}
									</button>
								</div>
							)}
						</div>
					</label>
				)}

				{error && <div className="np-err">{error}</div>}

				<BridgeStillUp netChoice={choice} />

				<div className="np-actions">
					<button type="button" className="np-cancel" onClick={onClose}>{t('npCancel')}</button>
					<button type="button" className="np-save" onClick={save}>
						{needsReload ? t('npSaveReload') : t('npSave')}
					</button>
				</div>
			</div>
		</div>
	);
}

/** The trigger's status glyph: which way packets leave the tab, as a shape.
 * Feathers borrowed from lucide (network / globe), inlined. Sized by the
 * caller: 15 suits the chat fab, 12 the terminal footer chip. */
function NetGlyph({ label, size = 15 }: { label: string; size?: number }) {
	const common = {
		width: size,
		height: size,
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 1.8,
		strokeLinecap: 'round' as const,
		strokeLinejoin: 'round' as const,
		'aria-hidden': true,
	};
	if (label === 'lan') {
		return (
			<svg {...common}>
				<rect x="16" y="16" width="6" height="6" rx="1" />
				<rect x="2" y="16" width="6" height="6" rx="1" />
				<rect x="9" y="2" width="6" height="6" rx="1" />
				<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
				<path d="M12 12V8" />
			</svg>
		);
	}
	// relay (and the debug-only `fetch`): packets reach the world.
	return (
		<svg {...common}>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
			<path d="M2 12h20" />
		</svg>
	);
}

export function NetworkControl({ variant }: { variant: 'inline' | 'fab' }) {
	const [open, setOpen] = useState<'none' | 'settings' | 'bridge'>('none');
	const [health, setHealth] = useState<RelayHealth>(null);
	const [, force] = useReducer((n: number) => n + 1, 0);
	// The chip wears the bridge: ⇄N while this LAN is joined to N-1 others.
	useEffect(() => onBridgeActivity(force), []);
	const relay = currentRelay();
	useEffect(() => {
		if (!/^(?:wss?|wisps?):\/\//i.test(relay)) {
			setHealth(null);
			return;
		}
		const read = () => setHealth(existingVm()?.relayHealth() ?? 'connecting');
		read();
		const timer = window.setInterval(read, 3_000);
		return () => clearInterval(timer);
	}, [relay]);
	const label = relayLabel(relay);
	const room = currentRoom();
	const bridged = room?.state === 'on' && room.members.length > 1 ? room.members.length : 0;
	const suffix = bridged ? ` ⇄${bridged}` : '';
	const down = health === 'down';
	const statusTitle = down ? t('npRelayDownTitle') : t('npChipTitle');
	// A live bridge makes the trigger a shortcut to its own panel — the
	// person clicking a ⇄2 chip wants the roster, not the mode radios.
	// With the bridge UI hidden the chip always opens settings, where the
	// "still up" row carries the disconnect button for CLI-started rooms.
	const live = bridgeUi() && !!room && room.state !== 'closed' && room.state !== 'failed';
	const openPanel = () => setOpen(live ? 'bridge' : 'settings');
	return (
		<>
			{variant === 'fab' ? (
				<button
					type="button"
					className={`np-fab${down ? ' np-relay-down' : ''}`}
					title={down ? statusTitle : tf('npFabTitle', `${label}${suffix}`)}
					aria-label={down ? statusTitle : tf('npFabTitle', `${label}${suffix}`)}
					onClick={openPanel}
				>
					<img className="np-fab-logo" src={VINX_LOGO} alt="" />
					<NetGlyph label={label} />
				</button>
			) : (
				<button
					type="button"
					className={`np-chip${down ? ' np-relay-down' : ''}`}
					title={statusTitle}
					onClick={openPanel}
				>
					<NetGlyph label={label} size={12} />
					{label}
					{suffix}
					{down && ` · ${t('npDisconnected')}`}
				</button>
			)}
			{open === 'settings' && (
				<Panel onClose={() => setOpen('none')} onManageBridge={() => setOpen('bridge')} />
			)}
			{open === 'bridge' && <BridgePanel onClose={() => setOpen('none')} />}
		</>
	);
}

/** Chat page helper: mount a floating network button without touching the
 * vendored CopilotApp tree. */
export function mountNetFab() {
	const el = document.createElement('div');
	document.body.appendChild(el);
	createRoot(el).render(<NetworkControl variant="fab" />);
}

// The terminal's first-run nudge. The default network is LAN-only, and
// discovering that usually takes a failed `curl`; this is the one relay that
// needs no setup, offered once. Answered either way, a localStorage flag
// retires the banner for good (tests preseed the flag to keep it out).
const PROMPT_KEY = 'vinx.net.prompted';

/** One slim "go online?" bar, rendered by the terminal shell document — a
 * single instance floating above the panes, never inside one. */
export function NetPrompt() {
	const [show, setShow] = useState(() => {
		try {
			return currentRelay() === 'host' && !localStorage.getItem(PROMPT_KEY);
		} catch {
			return false;
		}
	});
	if (!show) return null;
	const dismiss = () => {
		try {
			localStorage.setItem(PROMPT_KEY, '1');
		} catch {
			/* a private window sees the banner again next load; harmless */
		}
		setShow(false);
	};
	return (
		<div className="np-prompt">
			<span className="np-prompt-msg">{t('npPromptMsg')}</span>
			<button
				type="button"
				className="np-prompt-go"
				onClick={() => {
					dismiss();
					setRelay(WSPROXY_DEFAULT_RELAY);
					// This runs in the shell (top) document: reloading it
					// restarts every pane's VM with the new network.
					location.reload();
				}}
			>
				{t('npPromptGo')}
			</button>
			<button type="button" className="np-prompt-stay" onClick={dismiss}>
				{t('npPromptStay')}
			</button>
		</div>
	);
}
