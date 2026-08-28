// A Wisp proxy on Cloudflare Workers — real outbound TCP for the in-page VM.
//
// The VM's v86 wisp client tunnels the guest's TCP streams over one WebSocket
// to here; this Worker terminates that WebSocket and opens a matching raw TCP
// socket per stream with `cloudflare:sockets` connect(). TLS is end-to-end
// through the raw pipe (the guest does its own TLS), so nothing is decrypted
// here.
//
// Protocol: Wisp (https://github.com/MercuryWorkshop/wisp-protocol). We speak
// v1 by sending the stream-0 CONTINUE first, which the spec says makes any
// v2 client fall back to v1 — the least code for the widest compatibility.
// TCP only; the v86 client never opens UDP streams.
//
// Free-plan limits worth knowing (see README):
//   - Outbound TCP to Cloudflare's own IP ranges is blocked, so sites hosted
//     behind Cloudflare are unreachable through this relay.
//   - Port 25 (SMTP) is blocked.
//   - Up to 6 connections may be in the "connecting" state at once; more queue.

import { connect } from 'cloudflare:sockets';

const PACKET = { CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04 };
const CLOSE = { NORMAL: 0x02, NETWORK: 0x03, INVALID: 0x41, REFUSED: 0x44 };
// How many DATA packets the client may have in flight before it must wait for
// a CONTINUE. We top it back up every REFILL packets so data keeps flowing.
const BUFFER = 128;
const REFILL = 64;

export default {
	async fetch(request) {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('vinx wisp relay: connect over WebSocket (Wisp protocol)', {
				status: 426,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
		const pair = new WebSocketPair();
		const client = pair[0];
		const ws = pair[1];
		ws.accept();
		handle(ws);
		return new Response(null, { status: 101, webSocket: client });
	},
};

function handle(ws) {
	/** streamId -> { writer, received } */
	const streams = new Map();

	const send = (bytes) => {
		try {
			ws.send(bytes);
		} catch {
			/* socket already gone */
		}
	};
	const sendContinue = (streamId, remaining) => {
		const b = new Uint8Array(9);
		const v = new DataView(b.buffer);
		v.setUint8(0, PACKET.CONTINUE);
		v.setUint32(1, streamId, true);
		v.setUint32(5, remaining, true);
		send(b);
	};
	const sendClose = (streamId, reason) => {
		const b = new Uint8Array(6);
		const v = new DataView(b.buffer);
		v.setUint8(0, PACKET.CLOSE);
		v.setUint32(1, streamId, true);
		v.setUint8(5, reason);
		send(b);
	};
	const sendData = (streamId, payload) => {
		const b = new Uint8Array(5 + payload.byteLength);
		const v = new DataView(b.buffer);
		v.setUint8(0, PACKET.DATA);
		v.setUint32(1, streamId, true);
		b.set(payload, 5);
		send(b);
	};

	// Stream 0 CONTINUE: the handshake. Sending it first pins the connection
	// to Wisp v1 (see the header note).
	sendContinue(0, BUFFER);

	const closeStream = (streamId, reason) => {
		const s = streams.get(streamId);
		if (!s) return;
		streams.delete(streamId);
		try {
			s.writer.close();
		} catch {
			/* already closing */
		}
		if (reason !== undefined) sendClose(streamId, reason);
	};

	const openStream = (streamId, payload) => {
		// CONNECT payload: type u8, port u16 LE, hostname utf8.
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		const streamType = view.getUint8(0);
		if (streamType !== 0x01) {
			// UDP (0x02) is not supported here; the v86 client never asks for it.
			sendClose(streamId, CLOSE.INVALID);
			return;
		}
		const port = view.getUint16(1, true);
		const hostname = new TextDecoder().decode(payload.subarray(3));
		if (!hostname) {
			sendClose(streamId, CLOSE.INVALID);
			return;
		}

		let socket;
		try {
			socket = connect({ hostname, port });
		} catch {
			sendClose(streamId, CLOSE.NETWORK);
			return;
		}
		const writer = socket.writable.getWriter();
		streams.set(streamId, { writer, received: 0 });

		// Pump the socket's output back to the client as DATA packets until it
		// closes, then tell the client the stream ended.
		(async () => {
			const reader = socket.readable.getReader();
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value && value.byteLength) sendData(streamId, value);
				}
				closeStream(streamId, CLOSE.NORMAL);
			} catch {
				closeStream(streamId, CLOSE.NETWORK);
			}
		})();
	};

	ws.addEventListener('message', async (event) => {
		const data = event.data;
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: typeof data === 'string'
					? new TextEncoder().encode(data)
					: new Uint8Array(data);
		if (bytes.byteLength < 5) return;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const type = view.getUint8(0);
		const streamId = view.getUint32(1, true);
		const payload = bytes.subarray(5);

		if (type === PACKET.CONNECT) {
			openStream(streamId, payload);
			return;
		}
		if (type === PACKET.DATA) {
			const s = streams.get(streamId);
			if (!s) return;
			try {
				await s.writer.write(payload);
			} catch {
				closeStream(streamId, CLOSE.NETWORK);
				return;
			}
			// Flow control: give the client a fresh allowance periodically so
			// it never stalls waiting for room.
			if (++s.received % REFILL === 0) sendContinue(streamId, BUFFER);
			return;
		}
		if (type === PACKET.CLOSE) {
			closeStream(streamId);
			return;
		}
		// CONTINUE / INFO from the client are ignored: we set no buffer limit
		// on our own sends and forced v1, so there is nothing to act on.
	});

	const teardown = () => {
		for (const streamId of [...streams.keys()]) closeStream(streamId);
	};
	ws.addEventListener('close', teardown);
	ws.addEventListener('error', teardown);
}
