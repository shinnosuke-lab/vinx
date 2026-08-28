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
  main thread, where `runtime/src/device-vm.ts` runs them on the VM's `ttyS1`
  serial line and returns `{ok, output, exit_code}`. The risky tool is behind
  agent-core's confirmation gate, as ever.
- `/terminal` (`app/terminal.tsx`) is xterm.js wired straight to `ttyS0`. The
  guest's busybox shell does the line editing, history and Tab completion; the
  page is a dumb terminal. Each pane also carries an AI assistant
  (`app/terminal-assistant.tsx`) whose `run_shell` runs on the same machine, so
  what the model does is there at the prompt.
- `app/vm.ts` owns the v86 lifecycle, the serial bridges, and the `agentd`
  command channel. One VM is shared by the chat page and the console.
- Around the VM sit the browser-hardware and networking modules:
  `app/net-bridge.ts` (the WebRTC LAN bridge — rooms, roster, frame
  switching) with `app/nostr-signal.ts` (room codes as sealed SDP through
  public Nostr relays) and `app/danmaku.ts` (`bridge say`'s floating
  overlay); `app/ble.ts` (Web Bluetooth for the guest's `ble`);
  `app/hostcall.ts` + `app/bridge-ctl.ts` (the guest's OSC command channel
  and the `bridge` status file); `app/net-panel.tsx` + `app/vm-config.ts`
  (the network control and its stored mode) and `app/i18n.ts` (the panel's
  en/zh labels).

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
fresh machine. Its one deliberate exception is `/data`: the page mirrors
those files into IndexedDB and restores them on boot, so terminal drag-and-drop
and work saved there survive reloads.

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
