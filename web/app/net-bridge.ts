/**
 * Bridge this browser's LAN to other machines', over WebRTC.
 *
 * The in-browser LAN is v86's inbrowser hub: every VM on this origin posts
 * its raw ethernet frames onto `BroadcastChannel('v86-inbrowser-0')` and
 * hears everyone else's. A bridge is a member of that channel that forwards
 * frames over RTCDataChannels to bridges on other people's machines, and
 * injects what comes back — several LANs, one segment, ping and nc across
 * the internet. BroadcastChannel never echoes to its own sender, so a bridge
 * cannot re-hear its own injections: no loop.
 *
 * Two ways in:
 *
 *   - A room (the default): the host mints a six-character code, everyone
 *     else types it. SDP travels sealed through public Nostr relays
 *     (nostr-signal.ts) — no server of ours, no pasting. The host's tab is
 *     the hub of a star: a learning switch that forwards frames between its
 *     local LAN and every member, so N browsers share one segment. A second
 *     reliable channel per member carries the control plane: who's here,
 *     under what name and IP — the roster every side displays.
 *
 *   - A hand-carried code pair (the fallback): the same offer/answer SDPs,
 *     deflated into pasteable strings and carried by a human, for when the
 *     relays are unreachable. The result is the same room — roster,
 *     `bridge say`, the guest's bridge(1) — just 1:1.
 *
 * ICE uses a public STUN server, which only discovers addresses — the
 * traffic itself always flows peer to peer.
 *
 * The frame channel is unordered and non-retransmitting, like the wire it
 * stands in for: a lost frame is the guests' TCP stacks' problem. The
 * control channel is ordered and reliable, like the bookkeeping it is.
 *
 * One bridge per LAN: two tabs on the same origin both bridging would
 * duplicate every frame. The module keeps page-level singletons and stops
 * the old before starting the new.
 */

import { mintRoomCode, openSignal, type Signal } from './nostr-signal';

/** vinx runs every VM on the default hub (v86 `net_device.id` 0). */
const LAN_CHANNEL = 'v86-inbrowser-0';

/** STUN discovers each side's public address and never carries traffic.
 * Several servers, probed in parallel, whichever answers wins: any single
 * one can be unreachable from some networks (Google's notably is not from
 * mainland China), and without a srflx candidate two peers whose mDNS
 * `.local` host candidates don't resolve across machines have no pair at
 * all -- even on the same router. */
const DEFAULT_ICE = [
	'stun:stun.l.google.com:19302',
	'stun:stun.miwifi.com:3478',
	'stun:stun.qq.com:3478',
];

const ICE_KEY = 'vinx.bridge.ice';

/** The ICE server list: localStorage (comma-separated) or the defaults.
 * An entry is a STUN/TURN URI, optionally `uri|username|credential` --
 * TURN needs credentials and its URI scheme has nowhere to put them. A
 * user-supplied `turn:` is the only cure for symmetric NAT on both sides;
 * vinx ships none. */
export function iceList(): string[] {
	try {
		const stored = localStorage.getItem(ICE_KEY)?.trim();
		if (stored) return stored.split(',').map((s) => s.trim()).filter(Boolean);
	} catch {
		/* private windows fall through to the defaults */
	}
	return DEFAULT_ICE;
}

export function setIceList(value: string): void {
	try {
		if (value.trim()) localStorage.setItem(ICE_KEY, value.trim());
		else localStorage.removeItem(ICE_KEY);
	} catch {
		/* ignored */
	}
}

function rtcConfig(): RTCConfiguration {
	return {
		iceServers: iceList().map((entry) => {
			const [urls, username, credential] = entry.split('|').map((s) => s.trim());
			return username ? { urls, username, credential: credential ?? '' } : { urls };
		}),
	};
}

// ── shared plumbing ──

/** Wait out ICE gathering so the SDP carries the candidates (no trickle —
 * the signalling round-trip is expensive either way). Capped: mDNS or a
 * filtered STUN can stall 'complete' forever. 8s, not less: a reachable
 * but slow STUN (the list spans continents) must get its srflx into the
 * SDP -- a candidate that arrives after this moment is lost for good. */
function gathered(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === 'complete') return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			if (pc.iceGatheringState !== 'complete') return;
			pc.removeEventListener('icegatheringstatechange', done);
			resolve();
		};
		pc.addEventListener('icegatheringstatechange', done);
		setTimeout(resolve, 8_000);
	});
}

// ── one bridge per origin ──
//
// Every tab and pane on this origin shares the BroadcastChannel hub, so a
// second bridge would not just duplicate frames: a host bridge in one tab
// and a member bridge in another form a loop through the hub, and one
// broadcast frame circulates forever. A Web Lock is the origin-wide mutex
// with exactly the right lifetime — released on stop, released by the
// browser when the holding tab dies.

let releaseLock: (() => void) | null = null;

function tryLock(): Promise<boolean> {
	if (releaseLock) return Promise.resolve(true); // this page already holds it
	if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(true);
	return new Promise((resolve) => {
		navigator.locks
			.request('vinx-bridge', { ifAvailable: true }, (lock) => {
				if (!lock) {
					resolve(false);
					return;
				}
				resolve(true);
				return new Promise<void>((release) => {
					releaseLock = release;
				});
			})
			.catch(() => resolve(true)); // a broken locks API should not block bridging
	});
}

async function acquireBridgeLock(): Promise<void> {
	if (await tryLock()) return;
	// A bridge this page just stopped releases its lock asynchronously; give
	// that one beat before concluding that another tab holds it.
	await new Promise((r) => setTimeout(r, 150));
	if (await tryLock()) return;
	throw new Error(
		'another tab or pane on this origin already bridges this LAN — same-origin tabs share the LAN without a bridge',
	);
}

function releaseBridgeLock(): void {
	releaseLock?.();
	releaseLock = null;
}

function macAt(frame: Uint8Array, off: number): string {
	let s = '';
	for (let i = off; i < off + 6; i++) s += String.fromCharCode(frame[i]);
	return s;
}

/** Group/broadcast bit: these frames go everywhere by definition. */
function isMulticast(frame: Uint8Array): boolean {
	return (frame[0] & 1) === 1;
}

// ── the room bridge ──

export interface Member {
	name: string;
	ip: string;
	host: boolean;
}

export type RoomState = 'signalling' | 'on' | 'failed' | 'closed';

export interface RoomBridge {
	readonly role: 'host' | 'member';
	readonly room: string;
	state: RoomState;
	error: string;
	/** Everyone on the bridge, host first, this machine included. */
	members: Member[];
	onChange(cb: () => void): void;
	/** Float words across every member's screen — or one member's, with `to`. */
	say(text: string, to?: string): void;
	stop(): void;
}

let activeRoom: RoomBridgeImpl | null = null;

export function currentRoom(): RoomBridge | null {
	return activeRoom;
}

/** Fires on any bridge lifecycle change, for chrome outside the panel (the
 * footer chip shows ⇄N while a bridge is up). */
const activityListeners = new Set<() => void>();

export function onBridgeActivity(cb: () => void): () => void {
	activityListeners.add(cb);
	return () => activityListeners.delete(cb);
}

function pingActivity(): void {
	for (const cb of activityListeners) cb();
}

// ── chat ──

export interface ChatMessage {
	from: string;
	text: string;
	/** Addressed to this machine alone (`say @name`), not the whole room. */
	direct?: boolean;
	/** This page's own words, echoed locally on send. */
	self?: boolean;
}

/**
 * Every delivered chat line goes out on one channel, and the danmaku overlay
 * listens there — in this tab and in every other same-origin tab (they share
 * the LAN; only this one runs the bridge). BroadcastChannel hands a message
 * to every instance but the posting one, same-context instances included,
 * so a single post reaches our own overlay and the neighbours' alike.
 */
export const CHAT_CHANNEL = 'vinx-chat';
let chatOut: BroadcastChannel | null = null;

function deliverChat(m: ChatMessage): void {
	chatOut ??= new BroadcastChannel(CHAT_CHANNEL);
	chatOut.postMessage(m);
}

interface PeerLink {
	pc: RTCPeerConnection;
	lan: RTCDataChannel | null;
	ctl: RTCDataChannel | null;
	name: string;
	ip: string;
}

interface CtlHello {
	t: 'hello';
	name: string;
	ip: string;
}

interface CtlRoster {
	t: 'roster';
	members: Member[];
}

interface CtlChat {
	t: 'chat';
	from: string;
	text: string;
	/** A member name: deliver to that machine only. Absent: the whole room. */
	to?: string;
}

interface SigOffer {
	t: 'offer';
	peer: string;
	sdp: string;
}

interface SigAnswer {
	t: 'answer';
	peer: string;
	sdp: string;
}

class RoomBridgeImpl implements RoomBridge {
	state: RoomState = 'signalling';
	error = '';
	members: Member[] = [];
	private bc: BroadcastChannel | null = null;
	private signal: Signal | null = null;
	private listeners: (() => void)[] = [];
	// Host side: every joined member, keyed by their signalling peer id.
	private peers = new Map<string, PeerLink>();
	// Host side: which port (peer id, or 'local') each learned MAC sits behind.
	private macs = new Map<string, string>();
	// Member side: the one connection to the host.
	private hostPc: RTCPeerConnection | null = null;
	private hostLan: RTCDataChannel | null = null;
	private hostCtl: RTCDataChannel | null = null;

	constructor(
		readonly role: 'host' | 'member',
		readonly room: string,
		private selfName: string,
		private selfIp: string,
	) {}

	// ── host ──

	async startHost(): Promise<void> {
		this.signal = await openSignal(this.room);
		this.signal.onMessage((payload) => {
			const msg = payload as SigOffer;
			if (msg?.t === 'offer' && typeof msg.peer === 'string' && typeof msg.sdp === 'string') {
				this.accept(msg.peer, msg.sdp)
					.then((sdp) =>
						this.signal?.publish({ t: 'answer', peer: msg.peer, sdp } satisfies SigAnswer),
					)
					.catch(() => {
						/* a broken offer is just ignored; the joiner times out */
					});
			}
		});
		this.openLan();
		this.state = 'on';
		this.updateRoster();
	}

	/** Manual host: take a hand-carried offer, come up switching, mint the answer. */
	async startManualHost(offerSdp: string): Promise<string> {
		const sdp = await this.accept('manual', offerSdp);
		this.openLan();
		this.state = 'on';
		this.updateRoster();
		return sdp;
	}

	/** Take one joiner's offer and return the answer SDP — however either travels. */
	private async accept(peerId: string, sdp: string): Promise<string> {
		if (this.peers.has(peerId)) throw new Error('already answered'); // duplicate relay delivery
		const pc = new RTCPeerConnection(rtcConfig());
		const link: PeerLink = { pc, lan: null, ctl: null, name: '', ip: '' };
		this.peers.set(peerId, link);
		pc.addEventListener('datachannel', (e) => {
			if (e.channel.label === 'lan') this.attachPeerLan(peerId, link, e.channel);
			else if (e.channel.label === 'ctl') this.attachPeerCtl(peerId, link, e.channel);
		});
		pc.addEventListener('connectionstatechange', () => {
			const s = pc.connectionState;
			if (s === 'failed' || s === 'disconnected' || s === 'closed') {
				this.dropPeer(peerId);
			}
		});
		await pc.setRemoteDescription({ type: 'offer', sdp });
		await pc.setLocalDescription(await pc.createAnswer());
		await gathered(pc);
		return pc.localDescription!.sdp;
	}

	private attachPeerLan(peerId: string, link: PeerLink, dc: RTCDataChannel): void {
		dc.binaryType = 'arraybuffer';
		link.lan = dc;
		dc.addEventListener('message', (e) => {
			const frame = new Uint8Array(e.data as ArrayBuffer);
			if (frame.length < 14) return;
			// The switch learns: this source MAC sits behind this member.
			this.macs.set(macAt(frame, 6), peerId);
			const owner = isMulticast(frame) ? undefined : this.macs.get(macAt(frame, 0));
			if (owner && owner !== 'local' && owner !== peerId) {
				this.sendTo(owner, frame); // known unicast to another member
			} else if (owner === 'local') {
				this.bc?.postMessage(frame); // known unicast to this LAN
			} else {
				// Broadcast, or unknown: this LAN plus every other member.
				this.bc?.postMessage(frame);
				this.flood(frame, peerId);
			}
		});
		dc.addEventListener('close', () => this.dropPeer(peerId));
	}

	private attachPeerCtl(peerId: string, link: PeerLink, dc: RTCDataChannel): void {
		link.ctl = dc;
		dc.addEventListener('message', (e) => {
			try {
				const msg = JSON.parse(String(e.data)) as CtlHello | CtlChat;
				if (msg.t === 'hello') {
					link.name = String(msg.name || '').slice(0, 32) || 'someone';
					link.ip = String(msg.ip || '').slice(0, 15);
					this.updateRoster();
				} else if (msg.t === 'chat') {
					// The hello name, not the claimed one: nobody speaks as
					// someone else. The sender echoed locally; skip them.
					const chat: CtlChat = {
						t: 'chat',
						from: link.name || 'someone',
						text: String(msg.text || '').slice(0, 512),
					};
					if (msg.to) chat.to = String(msg.to).slice(0, 32);
					if (!chat.text.trim()) return;
					this.fanoutChat(chat, peerId);
					if (!chat.to || chat.to === this.selfName) {
						deliverChat({ from: chat.from, text: chat.text, direct: !!chat.to });
					}
				}
			} catch {
				/* not ours */
			}
		});
	}

	/** Host: send a chat line to its audience — every member, or one name. */
	private fanoutChat(msg: CtlChat, exceptPeer?: string): void {
		const line = JSON.stringify(msg);
		for (const [id, link] of this.peers) {
			if (id === exceptPeer) continue;
			if (msg.to && link.name !== msg.to) continue;
			if (link.ctl?.readyState === 'open') {
				try {
					link.ctl.send(line);
				} catch {
					/* closing */
				}
			}
		}
	}

	private sendTo(peerId: string, frame: Uint8Array): void {
		const link = this.peers.get(peerId);
		if (link?.lan?.readyState === 'open') {
			try {
				link.lan.send(frame as Uint8Array<ArrayBuffer>);
			} catch {
				/* closing under us; the state handler follows up */
			}
		}
	}

	private flood(frame: Uint8Array, except?: string): void {
		for (const [id] of this.peers) {
			if (id !== except) this.sendTo(id, frame);
		}
	}

	private dropPeer(peerId: string): void {
		const link = this.peers.get(peerId);
		if (!link) return;
		this.peers.delete(peerId);
		for (const [mac, owner] of this.macs) {
			if (owner === peerId) this.macs.delete(mac);
		}
		link.pc.close();
		this.updateRoster();
	}

	/** Host: recompute the roster, tell the members, tell the page. */
	private updateRoster(): void {
		this.members = [
			{ name: this.selfName, ip: this.selfIp, host: true },
			...[...this.peers.values()]
				.filter((l) => l.ctl?.readyState === 'open' && l.name)
				.map((l) => ({ name: l.name, ip: l.ip, host: false })),
		];
		const frame = JSON.stringify({ t: 'roster', members: this.members } satisfies CtlRoster);
		for (const link of this.peers.values()) {
			if (link.ctl?.readyState === 'open') {
				try {
					link.ctl.send(frame);
				} catch {
					/* closing */
				}
			}
		}
		this.emit();
	}

	// ── member ──

	async startMember(): Promise<void> {
		const signal = await openSignal(this.room);
		this.signal = signal;
		const peerId = crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
		const offerSdp = await this.memberOffer();

		const answered = new Promise<void>((resolve, reject) => {
			const giveUp = setTimeout(
				() => reject(new Error(`nobody answered in room ${this.room} — is the host still up?`)),
				30_000,
			);
			signal.onMessage((payload) => {
				const msg = payload as SigAnswer;
				if (msg?.t !== 'answer' || msg.peer !== peerId || typeof msg.sdp !== 'string') return;
				clearTimeout(giveUp);
				this.memberComplete(msg.sdp).then(resolve, reject);
			});
		});
		await signal.publish({ t: 'offer', peer: peerId, sdp: offerSdp } satisfies SigOffer);
		await answered;
	}

	/** Build the one connection to the host and mint the offer SDP. */
	async memberOffer(): Promise<string> {
		const pc = new RTCPeerConnection(rtcConfig());
		this.hostPc = pc;

		const lan = pc.createDataChannel('lan', { ordered: false, maxRetransmits: 0 });
		const ctl = pc.createDataChannel('ctl');
		this.hostLan = lan;
		this.hostCtl = ctl;

		lan.binaryType = 'arraybuffer';
		lan.addEventListener('open', () => {
			this.openLan();
			this.state = 'on';
			this.signal?.close();
			this.signal = null;
			this.emit();
		});
		lan.addEventListener('message', (e) => {
			this.bc?.postMessage(new Uint8Array(e.data as ArrayBuffer));
		});
		lan.addEventListener('close', () => {
			if (this.state === 'on') this.close();
		});

		ctl.addEventListener('open', () => {
			ctl.send(JSON.stringify({ t: 'hello', name: this.selfName, ip: this.selfIp } satisfies CtlHello));
		});
		ctl.addEventListener('message', (e) => {
			try {
				const msg = JSON.parse(String(e.data)) as CtlRoster | CtlChat;
				if (msg.t === 'roster' && Array.isArray(msg.members)) {
					this.members = msg.members;
					this.emit();
				} else if (msg.t === 'chat') {
					const from = String(msg.from || '').slice(0, 32) || 'someone';
					const text = String(msg.text || '').slice(0, 512);
					if (text.trim()) deliverChat({ from, text, direct: !!msg.to });
				}
			} catch {
				/* not ours */
			}
		});

		pc.addEventListener('connectionstatechange', () => {
			const s = pc.connectionState;
			if (s === 'failed') {
				this.fail('the connection failed — both sides behind strict NAT? (try from another network)');
			} else if (s === 'disconnected' || s === 'closed') {
				if (this.state === 'on') this.close();
			}
		});

		await pc.setLocalDescription(await pc.createOffer());
		await gathered(pc);
		return pc.localDescription!.sdp;
	}

	/** The host's answer came back — however it travelled. */
	async memberComplete(sdp: string): Promise<void> {
		await this.hostPc!.setRemoteDescription({ type: 'answer', sdp });
	}

	// ── shared ──

	/** Join the local hub; on the host side, learn which MACs are local. */
	private openLan(): void {
		if (this.bc) return;
		this.bc = new BroadcastChannel(LAN_CHANNEL);
		this.bc.addEventListener('message', (e) => {
			const frame = e.data as Uint8Array;
			if (!(frame instanceof Uint8Array) || frame.length < 14) return;
			if (this.role === 'member') {
				if (this.hostLan?.readyState === 'open') {
					try {
						this.hostLan.send(frame as Uint8Array<ArrayBuffer>);
					} catch {
						/* closing */
					}
				}
				return;
			}
			this.macs.set(macAt(frame, 6), 'local');
			const owner = isMulticast(frame) ? undefined : this.macs.get(macAt(frame, 0));
			if (owner && owner !== 'local') this.sendTo(owner, frame);
			else this.flood(frame);
		});
	}

	private fail(msg: string): void {
		if (this.state === 'failed' || this.state === 'closed') return;
		this.state = 'failed';
		this.error = msg;
		this.teardown();
		this.emit();
	}

	private close(): void {
		if (this.state === 'closed') return;
		this.state = 'closed';
		this.teardown();
		this.emit();
	}

	private teardown(): void {
		this.bc?.close();
		this.bc = null;
		this.signal?.close();
		this.signal = null;
		for (const link of this.peers.values()) link.pc.close();
		this.peers.clear();
		this.macs.clear();
		this.hostPc?.close();
		this.hostPc = null;
		releaseBridgeLock();
	}

	onChange(cb: () => void): void {
		this.listeners.push(cb);
	}

	say(text: string, to?: string): void {
		if (this.state !== 'on') return;
		const t = String(text).slice(0, 512).trim();
		if (!t) return;
		const msg: CtlChat = { t: 'chat', from: this.selfName, text: t };
		if (to) msg.to = String(to).slice(0, 32);
		if (this.role === 'host') {
			this.fanoutChat(msg);
		} else if (this.hostCtl?.readyState === 'open') {
			try {
				this.hostCtl.send(JSON.stringify(msg));
			} catch {
				/* closing */
			}
		}
		// The sender's own screen floats it too; nobody reflects it back.
		deliverChat({ from: msg.from, text: msg.text, direct: !!msg.to, self: true });
	}

	private emit(): void {
		for (const cb of this.listeners) cb();
		pingActivity();
	}

	stop(): void {
		this.close();
		if (activeRoom === this) activeRoom = null;
		pingActivity();
	}
}

function stopEverything(): void {
	activeRoom?.stop();
}

/** Host a room: mints the code (or reuses a given one) and answers joiners. */
export async function hostRoom(name: string, ip: string, room?: string): Promise<RoomBridge> {
	stopEverything();
	await acquireBridgeLock();
	const b = new RoomBridgeImpl('host', (room || mintRoomCode()).trim().toLowerCase(), name, ip);
	try {
		await b.startHost();
	} catch (e) {
		b.stop();
		throw e;
	}
	activeRoom = b;
	return b;
}

/** Join a room by its code; resolves once the offer is answered. */
export async function joinRoom(room: string, name: string, ip: string): Promise<RoomBridge> {
	stopEverything();
	await acquireBridgeLock();
	const b = new RoomBridgeImpl('member', room.trim().toLowerCase(), name, ip);
	activeRoom = b;
	try {
		await b.startMember();
	} catch (e) {
		b.stop();
		throw e;
	}
	return b;
}

// ── the hand-carried fallback: the same room, a human for a relay ──
//
// When no signalling relay is reachable (offline LAN, filtered network), the
// offer and answer travel by clipboard instead. Everything after signalling
// is the very same RoomBridge — control channel, roster, `bridge say` — so
// the guest's bridge(1) cannot tell the difference. The invite side plays
// the member and the answering side the host: an SDP exchange has to start
// with the offer, and the member is the side that offers.

/** A room code can never collide: the code alphabet has no 'l'. */
export const MANUAL_ROOM = 'manual';

export interface ManualBridge {
	readonly room: RoomBridge;
	/** The code to hand across: the invite, or the answer to one. */
	readonly code: string;
	/** Invite side only: paste the answer code to connect. */
	complete?(answerCode: string): Promise<void>;
}

let activeManual: ManualBridge | null = null;

/** The page's manual bridge while it is the active room — the panel resumes showing it. */
export function currentManual(): ManualBridge | null {
	return activeManual && activeManual.room === activeRoom ? activeManual : null;
}

// codes: SDP, deflated, base64url

async function encodeSignal(desc: RTCSessionDescriptionInit): Promise<string> {
	const raw = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
	const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function decodeSignal(code: string): Promise<RTCSessionDescriptionInit> {
	const b64 = code.trim().replaceAll('-', '+').replaceAll('_', '/');
	const bin = atob(b64);
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	const json = await new Response(stream).text();
	const { t, s } = JSON.parse(json) as { t: RTCSdpType; s: string };
	if (!t || typeof s !== 'string') throw new Error('not a bridge code');
	return { type: t, sdp: s };
}

/** Mint an invite: the room sits in 'signalling' until the answer is pasted back. */
export async function manualInvite(name: string, ip: string): Promise<ManualBridge> {
	stopEverything();
	await acquireBridgeLock();
	const b = new RoomBridgeImpl('member', MANUAL_ROOM, name, ip);
	activeRoom = b;
	try {
		const sdp = await b.memberOffer();
		const code = await encodeSignal({ type: 'offer', sdp });
		const mb: ManualBridge = {
			room: b,
			code,
			complete: async (answerCode: string) => {
				const desc = await decodeSignal(answerCode);
				if (desc.type !== 'answer') {
					throw new Error('that is an invite code — this side wants their answer');
				}
				await b.memberComplete(desc.sdp!);
			},
		};
		activeManual = mb;
		return mb;
	} catch (e) {
		b.stop();
		throw e;
	}
}

/** Take an invite, mint the answer; connects when the invite side pastes it. */
export async function manualAnswer(
	inviteCode: string,
	name: string,
	ip: string,
): Promise<ManualBridge> {
	const desc = await decodeSignal(inviteCode);
	if (desc.type !== 'offer') {
		throw new Error('that is an answer code — paste it on the inviting side');
	}
	stopEverything();
	await acquireBridgeLock();
	const b = new RoomBridgeImpl('host', MANUAL_ROOM, name, ip);
	activeRoom = b;
	try {
		const sdp = await b.startManualHost(desc.sdp!);
		const mb: ManualBridge = { room: b, code: await encodeSignal({ type: 'answer', sdp }) };
		activeManual = mb;
		return mb;
	} catch (e) {
		b.stop();
		throw e;
	}
}
