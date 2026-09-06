# The page

agent-core's engine compiled to WebAssembly, its chat UI, and a Linux VM, all
in a browser tab. No server holds the session; no backend proxies the model.
This directory is the whole front end. For the project overview and the Linux
image build, see the [root README](../README.md).

## What runs where

- **The engine** (`crates/agent-web-core/`, Rust → `wasm32-unknown-unknown`)
  runs the agent loop, streams agent-core's SSE frames, and keeps sessions in
  SQLite over an IndexedDB VFS. It lives in a Web Worker so a long turn never
  janks the page.
- **A TypeScript client** (`runtime/src/client.ts`) speaks to the worker over
  `postMessage`, and **a fetch shim** (`runtime/src/shim.ts`) answers `/api/*`
  from it — so the vendored chat UI mounts unmodified, same routes and same SSE
  as it would get from a real server.
- **The device is a Linux VM** in the same tab (v86). Its one tool, `run_shell`,
  and the `/terminal` console both operate it; see below.
- **The pages** are `app/main.tsx` (chat) and `app/terminal.tsx` (console),
  two Vite entries sharing one asset tree.

The build is a plain JS + wasm pair that any static host can serve. The base is
relative (`vite.config.ts`), so it works from a subpath or `file://` with no
configuration.

## The device is the VM

Upstream's device is a gateway or shell over HTTP and its terminal is a PTY over
WebSocket. Here both are the in-page VM:

- `run_shell` calls leave the engine as an HTTP POST to an internal address the
  worker's own `fetch` intercepts (`runtime/src/worker.ts`) and bounces to the
  main thread, where `runtime/src/device-vm.ts` runs them as `proc.run` on the
  VM's ttyS3 control plane (rpcd routes, rund executes; long commands stage a
  scriptRef, big output comes back as a /data ref with an explicit truncation
  marker) and returns `{ok, output, exit_code}`. The risky tool is behind
  agent-core's confirmation gate, as ever.
- `/terminal` (`app/terminal.tsx`) is xterm.js wired straight to `ttyS0`. The
  guest's busybox shell does the line editing, history and Tab completion; the
  page is a dumb terminal. Each pane also carries an AI assistant
  (`app/terminal-assistant.tsx`) whose `run_shell` runs on the same machine, so
  what the model does is there at the prompt.
- `app/vm.ts` owns the v86 lifecycle, the serial bridges, and the control
  plane (`app/rpc.ts` frames it, `app/hostcall.ts` serves the page's methods;
  `app/stream-mux.ts` is the ttyS1 byte lane — PTY window streams,
  credit-metered, kept apart from control traffic). One VM is shared by the
  chat page and the console.
- Around the VM sit the browser-hardware and networking modules:
  `app/net-bridge.ts` (the WebRTC LAN bridge — rooms, roster, frame
  switching) with `app/nostr-signal.ts` (room codes as sealed SDP through
  public Nostr relays) and `app/danmaku.ts` (`bridge say`'s floating
  overlay); `app/ble.ts` (the Web Bluetooth broker behind the `ble.*`
  methods); `app/hostcall.ts` (every method the page serves over the
  control link — executors, notify/speak/camera/open, resources, the
  `window.*` family) with `app/bridge-ctl.ts` (the `network.bridge.*`
  control); `app/origin-broker.ts` (Web Locks arbitration of the origin's
  camera/BLE between machines); `app/net-panel.tsx` + `app/vm-config.ts`
  (the network control and its stored mode) and `app/i18n.ts` (the panel's
  en/zh labels).
- The desktop's windows: `app/desktop-window.tsx` (the generic floating
  chrome), `app/window-manager.ts` (the per-document window table behind
  `window.*` — web bundles, tty streams and the native screen),
  `app/vga-window.tsx` (the VGA screen tenant),
  `app/app-frame.tsx` (a web app's sandboxed frame plus the MessageChannel
  bridge; the shell document itself is `app/public/app-frame.html`, a static
  file with its CSP in a `<meta>` that ships in dist/ beside the page — see
  deploy/self-host.md for the optional separate-site deploy) and
  `app/byte-stream-term.tsx` (one xterm over one byte stream — the console
  panel and every PTY window are both it; a tty app's window wires it to
  the app's mux channel, resize rides a `stream.resize` notification).

Everything else — chat, sessions, skills, themes, attachments, the `task`
sub-agent, steering and queueing — is agent-core's, working off the shim.

## The tab is the process

Upstream's agent is a daemon and the browser is a viewer; here the agent *is*
the tab — the engine is wasm in a worker the document owns — so:

- A reload, a navigation away, or a closed tab ends whatever turn was running.
  What survives is what the turn had already committed.
- A background tab is throttled; Chrome's Memory Saver can discard it outright.
- `app/leaving.ts` puts up a `beforeunload` guard while a turn is running, so a
  close is confirmed rather than silent.

The VM is the same kind of thing: it lives in the tab and a reload starts a
fresh machine. Its one deliberate exception is `/data`: the page mirrors that
tree into IndexedDB (recursively, fingerprint-diffed, nudged by the 9p write
doorbell — `app/share-store.ts` and `app/share-diff.ts`) and restores it on
boot, so terminal drag-and-drop, project trees and installed apps survive
reloads.

## Build

```bash
(cd vendor/ui && npm ci && npm run build)   # the chat UI (its own npm project)
npm install
npm run build:wasm                          # Rust engine -> wasm (see below)
npm run build                               # build:wasm + build:skill + vite build
npm run dev                                 # dev server
npm run dev:https                           # dev server over HTTPS, LAN-reachable
```

`dev:https` exists for testing from *another* machine: Web Serial, Web
Bluetooth and the folder mount live only in secure contexts, so over plain
HTTP on a LAN address Chromium withholds them and the footer's serial, ble
and mount chips vanish (the footer says why). The certificate is self-signed
— the other machine's browser asks for one "proceed anyway" click. Deployed
sites (GitHub Pages etc.) are HTTPS already and need none of this.

`npm run build:wasm` needs `wasm-pack`, the `wasm32-unknown-unknown` target and
a `wasm-bindgen` CLI matching `Cargo.lock`. `./deploy/ci.sh --docker` does the
whole build in a container that carries all of it — build that image with
`./docker/build-image.sh`. The prebuilt Linux images under `app/public/vm/` are
committed, so `npm run dev` needs no Docker unless you are changing the guest.

## Tests

```bash
./deploy/test.sh      # wasm engine/store suites + the TypeScript runtime suite (Node) + app typecheck
./deploy/browser.sh   # the built page in real Chrome (needs app/public/vm/ images)
./deploy/live.sh      # against a real provider, opt-in (.env.live)
```

The Node suites need no browser and no VM. The browser suite boots the actual
VM, so it needs the Linux images built first (`../linux/build.sh`).

## The forked engine and UI

The engine and UI under `vendor/` are a fork of agent-core (fork point in
`vendor/VENDOR.json`), edited directly — no sync script, no patch layer. The
fork's history, what was taken, and what is reimplemented for the browser are
in [docs/UPSTREAM.md](docs/UPSTREAM.md). Background on the wasm port and its
size budget is in [docs/WASM-FEASIBILITY.md](docs/WASM-FEASIBILITY.md).
