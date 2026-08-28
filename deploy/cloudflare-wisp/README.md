# vinx-wisp — a Wisp relay on Cloudflare Workers

A ~200-line Worker that gives the in-page Linux VM real outbound TCP, for free
and with no server to run. The VM's v86 wisp client tunnels the guest's TCP
streams over one WebSocket to this Worker, which opens a matching raw socket
per stream with Cloudflare's `connect()` API. TLS is end-to-end through the
pipe (the guest does its own), so nothing is decrypted here.

## Deploy

```bash
cd deploy/cloudflare-wisp
npx wrangler login        # once
npx wrangler deploy
```

Wrangler prints a URL like `https://vinx-wisp.<your-account>.workers.dev`.
Open the page pointed at it:

```
https://<your-site>/?relay=wisps://vinx-wisp.<your-account>.workers.dev/
```

The choice persists in the browser; `?relay=host` reverts to the default
in-page network. Either way the page's network control (the terminal
footer's chip, the chat page's floating button) shows and switches the mode
without URL editing — the URL parameter is just the scriptable way in.

## What works, and the free-plan limits

Behind this relay the guest gets real outbound TCP: `curl https://...`,
WebSocket clients, and raw TCP all work, and plain HTTP is no longer
CORS-bound. Two hard limits come from the platform, not this code:

- **Cloudflare-hosted sites are unreachable.** Workers block outbound TCP to
  Cloudflare's own IP ranges, so a destination behind Cloudflare (a large
  slice of the web) will fail to connect. This is the main reason to prefer a
  local relay + `cloudflared` tunnel (`web/deploy/relay.sh --tunnel`) when you
  need to reach arbitrary sites.
- **Six connections may be "connecting" at once**; a seventh queues until one
  finishes connecting. Fine for interactive use, not for fan-out.

Other notes: port 25 (SMTP) is blocked; a single WebSocket message is capped
at 32 MiB; the free plan allows 100,000 requests/day (each WebSocket counts as
one request, messages are free). Listening/inbound sockets are not supported
by Wisp at all.

## Protocol

Wisp v1 (forced by sending the stream-0 `CONTINUE` first, which makes any v2
client fall back). TCP streams only — the v86 client never opens UDP. See
[worker.js](worker.js) for the framing and flow control.
