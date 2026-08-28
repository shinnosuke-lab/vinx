/**
 * Room-code signalling over Nostr: how two bridges find each other without
 * anyone running a server.
 *
 * A WebRTC connection needs one round of SDP exchange. The old way was a
 * human carrying two pasted blobs; this module replaces the human with the
 * public Nostr relay network — a few thousand independent WebSocket servers
 * that forward signed JSON events to whoever subscribed to matching tags.
 * We use ephemeral events (kind 20000–29999), which relays forward but do
 * not store: exactly the semantics of a signalling channel.
 *
 * Privacy comes from the room code, not the relay. The code (six characters,
 * ~30 bits) is stretched with PBKDF2 into two secrets: an AES-GCM key that
 * seals every payload, and a room tag that names the rendezvous. A relay —
 * or anyone watching one — sees only that *someone* exchanged sealed blobs
 * under a random-looking tag. Deriving the tag costs the same PBKDF2 work as
 * the key, so grinding codes out of observed tags is as expensive as
 * grinding the encryption itself.
 *
 * Each signal session signs its events with a throwaway secp256k1 key, as
 * NIP-01 requires; identity lives inside the encrypted payload, not in the
 * Nostr pubkey.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Ephemeral kind: relays fan it out and forget it. Arbitrary in the range. */
const KIND = 21313;

/** Public relays with years of uptime; overridable for tests and taste. */
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

const RELAYS_KEY = 'vinx.bridge.relays';

/** The relay list: localStorage (comma-separated) or the public defaults. */
export function bridgeRelays(): string[] {
	try {
		const stored = localStorage.getItem(RELAYS_KEY)?.trim();
		if (stored) return stored.split(',').map((s) => s.trim()).filter(Boolean);
	} catch {
		/* private windows fall through to the defaults */
	}
	return DEFAULT_RELAYS;
}

export function setBridgeRelays(value: string): void {
	try {
		if (value.trim()) localStorage.setItem(RELAYS_KEY, value.trim());
		else localStorage.removeItem(RELAYS_KEY);
	} catch {
		/* ignored */
	}
}

/** Six characters from an alphabet with no 0/O/1/l confusion (~30 bits). */
export function mintRoomCode(): string {
	const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	let code = '';
	for (const b of bytes) code += alphabet[b % alphabet.length];
	return code;
}

// ── the room's two secrets, both behind PBKDF2 ──
//
// Pure-JS crypto (@noble) rather than WebCrypto: crypto.subtle exists only
// in secure contexts, and a page opened over plain HTTP from another machine
// on the LAN must still be able to bridge. Parameters and wire format match
// the earlier WebCrypto code exactly, so old and new pages interoperate.

interface RoomKeys {
	key: Uint8Array; // AES-GCM-256 key bytes, seals every payload
	tag: string; // 32 hex chars, the rendezvous name relays see
}

async function deriveRoom(code: string): Promise<RoomKeys> {
	const bytes = await pbkdf2Async(sha256, code.trim().toLowerCase(), 'vinx-bridge-v1', {
		c: 100_000,
		dkLen: 64,
	});
	return { key: bytes.slice(0, 32), tag: bytesToHex(bytes.slice(32, 48)) };
}

async function seal(keys: RoomKeys, payload: unknown): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = gcm(keys.key, iv).encrypt(new TextEncoder().encode(JSON.stringify(payload)));
	const joined = new Uint8Array(iv.length + ct.length);
	joined.set(iv);
	joined.set(ct, iv.length);
	let bin = '';
	for (const b of joined) bin += String.fromCharCode(b);
	return btoa(bin);
}

async function unseal(keys: RoomKeys, content: string): Promise<unknown | null> {
	try {
		const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
		const plain = gcm(keys.key, bytes.slice(0, 12)).decrypt(bytes.slice(12));
		return JSON.parse(new TextDecoder().decode(plain));
	} catch {
		return null; // not ours (wrong room, or noise on the tag)
	}
}

// ── NIP-01 events, signed with a throwaway key ──

interface NostrEvent {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
	sig: string;
}

function makeEvent(seckey: Uint8Array, pubkey: string, tag: string, content: string): NostrEvent {
	const created_at = Math.floor(Date.now() / 1000);
	const tags = [['d', tag]];
	const serialized = JSON.stringify([0, pubkey, created_at, KIND, tags, content]);
	const idBytes = sha256(new TextEncoder().encode(serialized));
	const sig = bytesToHex(schnorr.sign(idBytes, seckey));
	return { id: bytesToHex(idBytes), pubkey, created_at, kind: KIND, tags, content, sig };
}

// ── the session: N relays, one subscription, sealed payloads both ways ──

export interface Signal {
	/** Seal and publish a payload to every connected relay. */
	publish(payload: unknown): Promise<void>;
	/** Payloads sealed by others in the room (own events are filtered out). */
	onMessage(cb: (payload: unknown) => void): void;
	close(): void;
}

/**
 * Open the room's signalling channel. Resolves when at least one relay has
 * accepted the subscription; rejects if every relay fails.
 */
export async function openSignal(roomCode: string, relays = bridgeRelays()): Promise<Signal> {
	const keys = await deriveRoom(roomCode);
	const seckey = schnorr.utils.randomSecretKey();
	const pubkey = bytesToHex(schnorr.getPublicKey(seckey));
	const subId = 'vinx-' + keys.tag.slice(0, 8);

	const sockets = new Map<string, WebSocket>(); // relay url -> open socket
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const listeners: ((payload: unknown) => void)[] = [];
	const seen = new Set<string>(); // event ids, de-duped across relays
	let closed = false;

	const handleEvent = async (ev: NostrEvent) => {
		if (ev.pubkey === pubkey || seen.has(ev.id)) return;
		seen.add(ev.id);
		const payload = await unseal(keys, ev.content);
		if (payload === null) return;
		for (const cb of listeners) cb(payload);
	};

	const connect = (url: string) =>
		new Promise<WebSocket | null>((resolve) => {
			let ws: WebSocket;
			try {
				ws = new WebSocket(url);
			} catch {
				resolve(null);
				return;
			}
			const giveUp = setTimeout(() => {
				ws.close();
				resolve(null);
			}, 8_000);
			ws.addEventListener('open', () => {
				clearTimeout(giveUp);
				ws.send(JSON.stringify(['REQ', subId, { kinds: [KIND], '#d': [keys.tag] }]));
				resolve(ws);
			});
			ws.addEventListener('error', () => {
				clearTimeout(giveUp);
				resolve(null);
			});
			ws.addEventListener('message', (e) => {
				if (closed) return;
				try {
					const msg = JSON.parse(String(e.data)) as unknown[];
					if (msg[0] === 'EVENT' && msg[1] === subId) void handleEvent(msg[2] as NostrEvent);
				} catch {
					/* not JSON; not ours */
				}
			});
		});

	// A host keeps this channel open for the room's whole life, and a public
	// relay will not honour that: idle sockets get dropped. Reconnect with
	// backoff and re-subscribe — events are de-duplicated by id above, so an
	// overlapping delivery after a reconnect is harmless.
	const adopt = (url: string, ws: WebSocket): void => {
		sockets.set(url, ws);
		ws.addEventListener('close', () => {
			sockets.delete(url);
			retry(url, 0);
		});
	};

	const retry = (url: string, attempt: number): void => {
		if (closed) return;
		const delay = Math.min(5_000 * 3 ** attempt, 60_000);
		const t = setTimeout(() => {
			timers.delete(t);
			if (closed) return;
			void connect(url).then((ws) => {
				if (closed) {
					ws?.close();
				} else if (ws) {
					adopt(url, ws);
				} else {
					retry(url, attempt + 1);
				}
			});
		}, delay);
		timers.add(t);
	};

	const results = await Promise.all(relays.map(connect));
	relays.forEach((url, i) => {
		const ws = results[i];
		if (ws) adopt(url, ws);
		else retry(url, 0);
	});
	if (sockets.size === 0) {
		closed = true;
		for (const t of timers) clearTimeout(t);
		throw new Error(
			'could not reach a signalling relay — the network panel\'s Manual bridge' +
				` works without one (tried ${relays.join(', ')})`,
		);
	}

	return {
		async publish(payload: unknown): Promise<void> {
			const content = await seal(keys, payload);
			const event = makeEvent(seckey, pubkey, keys.tag, content);
			const frame = JSON.stringify(['EVENT', event]);
			for (const ws of sockets.values()) {
				if (ws.readyState === WebSocket.OPEN) ws.send(frame);
			}
		},
		onMessage(cb: (payload: unknown) => void): void {
			listeners.push(cb);
		},
		close(): void {
			closed = true;
			for (const t of timers) clearTimeout(t);
			timers.clear();
			for (const ws of sockets.values()) {
				try {
					if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId]));
					ws.close();
				} catch {
					/* already down */
				}
			}
			sockets.clear();
		},
	};
}
