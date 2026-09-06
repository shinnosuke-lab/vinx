# Self-hosting the network relays

The network control offers two relay-backed modes, and both are one Docker
command to run yourself. Which one you want:

- **Relay LAN (wsproxy)** — a shared ethernet segment *plus* internet.
  Machines on the same relay see each other (`ping`, `nc`, `httpd`), and the
  relay NATs them out to the world. Run this to network VMs across
  computers, or to stop depending on v86's public relay.
- **Internet (wisp)** — outbound TCP only. The guest gets `curl https://`,
  WebSocket and raw TCP; machines on the relay never see each other. Run
  this when the VM just needs the internet, with the smallest possible
  footprint (pure userspace, non-root).

Serving the *page* over plain `http://` (the dev server, a LAN address)
pairs fine with `ws://` and `wisp://` relays. A page served over `https://`
must use `wss://`/`wisps://` (browsers block mixed content) — put the relay
behind TLS (wsnic's built-in stunnel below, or a Caddy/nginx/cloudflared
front) when you deploy for real.

## Relay LAN (wsproxy): wsnic

[wsnic](https://github.com/chschnell/wsnic) is the wsproxy server v86's own
docs recommend: one Linux bridge, a TAP device per client, dnsmasq handing
out DHCP/DNS.

```bash
docker run --rm -it \
    --cap-add=NET_ADMIN \
    --device /dev/net/tun:/dev/net/tun \
    -p 8086:8086 \
    chschnell86/wsnic -i
```

Then in the network control pick **Relay LAN** and fill in
`ws://<the-docker-host's-LAN-IP>:8086/` — every machine that should share
the segment fills in the same address (`127.0.0.1` only reaches the machine
running Docker). Save & reload; the guest's address arrives from the
relay's DHCP a few seconds after boot (`ip route` shows a default route
once it's ready), and machines reach each other at those addresses
(`ip -4 addr show eth0`).

What the flags are for, honestly: wsnic moves raw ethernet frames, so it
builds a bridge and TAP devices — that is kernel networking and needs the
`NET_ADMIN` capability plus `/dev/net/tun` *inside the container*. No
`--privileged`, no root on the host beyond running Docker itself; there is
no pure-userspace implementation of an L2 relay to reach for instead.
`-i` enables NAT so guests get internet through the relay host — leave it
off if VM-to-VM networking is all you need (see the security notes).

Tested here: two VMs got DHCP addresses and pinged each other on the first
try. The image is `linux/amd64`; Docker Desktop on Apple silicon runs it
emulated, which relays frames fine but stalled the `-i` NAT leg in our
testing — treat guest internet through wsnic as native-x86-Linux territory,
and the shared segment as the part that works everywhere.

For `wss://` (a TLS certificate mounted in, stunnel inside the container):

```bash
docker run --rm -it \
    --cap-add=NET_ADMIN \
    --device /dev/net/tun:/dev/net/tun \
    -p 8086:8086 -p 8087:8087 \
    -v ~/cert/cert.crt:/opt/wsnic/cert/cert.crt \
    -v ~/cert/cert.key:/opt/wsnic/cert/cert.key \
    chschnell86/wsnic -i
```

Alternatives, if wsnic doesn't fit: v86's
[networking docs](https://github.com/copy/v86/blob/master/docs/networking.md)
list the older websockproxy images and more.

## Internet (wisp)

Wisp servers are plain userspace programs — the container runs as the
unprivileged `node` user, no capabilities, no devices:

```bash
docker run --rm -it --user node -p 5001:5001 node:22 \
    npx --yes @mercuryworkshop/wisp-js -H 0.0.0.0 -P 5001 -L WARN
```

(The full `node:22` image, not `-alpine`/`-slim`: wisp-js depends on the
native `bufferutil` module, which compiles at install time and needs the
toolchain the smaller images strip. First start downloads the package;
give it a minute.)

Then pick **Internet (wisp)** and fill in `wisp://<the-docker-host's-IP>:5001/`.
This is the same server [`web/deploy/relay.sh`](../web/deploy/relay.sh)
runs without Docker (add `--tunnel` there for a free public `wisps://` URL
through a Cloudflare quick tunnel). For a permanent relay with no machine
at all, deploy the ~200-line Worker in
[`deploy/cloudflare-wisp/`](cloudflare-wisp/) to your own Cloudflare
account.

## Security notes

Running a relay inside your home or office network is low-drama, but know
what each piece can and cannot do:

- **Broadcast storms and rogue DHCP stay inside the container.** wsnic's
  bridge is its own L2 segment; it is not bridged onto your physical
  network, and only the WebSocket port is published. A guest flooding
  broadcasts burns the relay container's CPU, not your LAN, and wsnic's
  dnsmasq cannot answer DHCP for your real machines.
- **`-i` is the one flag with reach.** With NAT on, guests browse with the
  relay host's identity — including *into* your LAN (the router's admin
  page, a NAS, other machines). If VMs only need each other, omit `-i`.
  If they need the internet but not your intranet, drop forwards to
  private ranges on the Docker host (Linux; the container's address is in
  `docker inspect`):

  ```bash
  iptables -I DOCKER-USER -s <container-ip> -d 10.0.0.0/8     -j DROP
  iptables -I DOCKER-USER -s <container-ip> -d 172.16.0.0/12  -j DROP
  iptables -I DOCKER-USER -s <container-ip> -d 192.168.0.0/16 -j DROP
  ```

  (Docker Desktop on macOS/Windows has no host iptables to edit — there
  the honest options are omitting `-i` or trusting everyone on the LAN.)
- **Neither server authenticates.** Anyone who can reach the port joins
  your segment (wsnic) or borrows your IP for outbound TCP (wisp). On a
  network with strangers, publish to localhost only
  (`-p 127.0.0.1:8086:8086`) or firewall the port to known machines.
- **One segment means mutual visibility.** wsnic clients can sniff and
  spoof each other, exactly like the public relay's caveat — the people
  change, the physics don't.
- **Wisp can refuse your intranet.** If guests should never connect into
  private address space,
  [wisp-server-python](https://github.com/MercuryWorkshop/wisp-server-python)
  blocks loopback and private destinations unless `--allow-loopback` /
  `--allow-private` are passed — a good pick for shared deployments.

## The app shell (web app windows)

Guest apps with a web UI (`app new NAME --web`) render inside a sandboxed
iframe whose document is `web/app/public/app-frame.html` — one static file,
no build step, copied into `dist/` beside the page. **Nothing to configure:**
the desktop loads it as `app-frame.html` relative to its own document, so it
is served by whatever serves the page, GitHub Pages included. Two walls make
it a wall rather than a decoration (system-v2 §10.3), and neither depends on
where the file is hosted:

- the frame's `sandbox="allow-scripts"` (no `allow-same-origin`): the
  document is an opaque origin — no storage, no cookie, no reach into the
  page's DOM, even though it comes from the page's own host;
- the policy in the file's own `<meta http-equiv="Content-Security-Policy">`
  — `default-src 'none'; script-src 'unsafe-inline'; style-src
  'unsafe-inline'; img-src data:` — no network, no external script, no
  child frame. A meta policy binds exactly like a response header; later
  policies can only tighten it, and app text arrives via `innerHTML`, where
  a `<meta http-equiv>` is inert anyway.

What hosting the shell on the page's own site does *not* buy is a guaranteed
separate renderer process: desktop Chromium (127+) gives a sandboxed frame
its own process regardless of site, but Firefox, Safari and mobile browsers
may run it in the page's. There the walls above still hold, but a buggy
app's synchronous infinite loop hangs the whole tab until you reload it
(the machine's `/data` persists; the boot does not). Vinx is a local page —
your own model writing apps for your own browser — so that is the default
trade. If you want the process wall on every browser, host a copy of the
same file on a different *site* (a different registrable domain or a
separate `*.pages.dev`/`*.github.io` project) and bake its URL into the
build:

```bash
VINX_APP_FRAME_URL=https://apps.example.net/app-frame.html npm run build
```

The copy needs no headers of its own — the policy travels in the file.
