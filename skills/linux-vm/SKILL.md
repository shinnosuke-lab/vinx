---
name: linux-vm
description: Reference for the emulated Linux this page runs — the busybox userland, the toolchain (tcc, nasm/ndisasm for x86 assembly, make, lua, micropython, qjs, sqlite3, jq, strace, btmon for btsnoop Bluetooth captures) and micropython's stdlib limits, GUI programs with LVGL (tcc -llvgl, lvdemo, a bundled GB2312 Chinese font) and terminal UIs with ncurses/termbox2, the tool set (run_shell, run_js, file tools, share_local, download_file, read_terminal), the guest's browser-facing commands (open, imgcat, download, notify, say, camera, share, alpine, js, fetch, bridge, ble, nes) plus the page-visible hardware — the VGA screen window the guest paints via /dev/fb0 (fbdemo is the reference) with the mouse forwarded to evdev, the /dev/dsp sound card, a Web Serial device on ttyS2 — the /data persistent directory where every shell starts and the /data/share/local directory every machine shares, and what the network can and cannot reach. Read this before doing anything non-trivial.
version: 0.7.0
author: vinx
---

# The Linux in this page

The device behind `run_shell` is a 32-bit x86 Linux built with Buildroot and
emulated in the browser by [v86](https://github.com/copy/v86). It is real
Linux — a real kernel, a real filesystem, real processes — but small and
slow: think "router shell", not "build server".

## What is there

- **busybox**, not GNU coreutils. One binary provides `sh` (ash), `ls`, `ps`,
  `grep`, `sed`, `awk`, `wget`, `nc`, `ip`, `mount`, and friends. Flags
  are the busybox subset: `grep -P` does not exist, `sed -i` takes no suffix,
  `ps aux` is `ps` or `ps -o`.
- `vi`/`vim` is real vim (built without its runtime: no syntax highlighting
  or help files, but full multibyte support — it edits Chinese correctly).
  It is interactive, so it is for the human at the terminal; from `run_shell`
  use the file tools or `sed`/redirection instead.
- `sh` is ash, not bash. No arrays, no `[[ ]]`, no process substitution.
  `#!/bin/sh` scripts with POSIX constructs run fine.
- Everything is UTF-8: Chinese (or any Unicode) in file names, file contents
  and command lines works — busybox is built with Unicode support and the
  console's locale is `C.UTF-8`.
- **Compilers and interpreters.** `tcc` compiles real C — headers and crt are
  installed, so `tcc hello.c -o hello && ./hello` and `tcc -run hello.c` both
  work (link against musl; no gcc). GNU `make` is installed, so tcc scales to
  small multi-file projects (`make CC=tcc`). `lua` is standard Lua 5.4 (64-bit
  numbers), and its headers and `liblua.so` are installed too: embed it with
  `tcc host.c -llua -o host` (no -lm needed on musl), or build a C module
  with `tcc -shared ext.c -o ext.so` and `require 'ext'` it. `micropython`
  is Python-shaped but **not CPython** — see its own section below before
  writing any Python. `qjs` runs modern JavaScript (QuickJS; no npm, no Node
  APIs). Keep programs small: one CPU, 128 MB RAM, no swap.
- **Assembly, both dialects.** This is a real i686, so assembly runs natively.
  `nasm` assembles Intel syntax — `nasm -f elf32 x.asm -o x.o && tcc x.o -o x`
  (tcc doubles as the linker; `_start` via `-nostdlib`, or `main` against
  libc) — and `ndisasm -b 32` disassembles. tcc itself assembles GNU-syntax
  `.S` files and inline asm in C. `strace ./prog` shows the syscalls when a
  program misbehaves — the debugger that fits a non-interactive channel
  (there is no gdb).
- **Bluetooth captures.** `btmon -r FILE` decodes a btsnoop file (HCI, L2CAP,
  ATT/GATT, SMP…) — drop a `.btsnoop`/`.log` capture on the terminal and read
  it. Offline analysis only: the machine has no Bluetooth controller (live
  device work goes through `ble`, below).
- **Data tools.** `sqlite3` — the CLI for wrangling and persisting tabular
  data (a database in `/data` survives reloads), and `libsqlite3.so` +
  `sqlite3.h`, so `tcc app.c -lsqlite3` compiles and links out of the box.
  `jq` for JSON on the shell — the natural partner of `curl` on a relay
  network. (No Python `sqlite3` module — drive the CLI from shell, or link
  the C library.)
- **GUI and terminal UI.** LVGL v9 is a system library: `tcc gui.c -llvgl`
  builds a real GUI onto the VGA screen (`/dev/fb0`, the footer's screen
  chip), pointer included — the screen window forwards the mouse as PS/2,
  which the kernel exposes on `/dev/input/eventN` (evdev, what LVGL reads).
  `lvdemo` compiles and runs the shipped example; its source,
  `/usr/share/lvgl/lvdemo.c`, is the starting point to copy (display setup,
  mouse discovery, a button with a click handler). Chinese text is one call
  away: a full GB2312 font ships at `/usr/share/fonts/cjk16.bin`, and
  `lv_binfont_create("A:/usr/share/fonts/cjk16.bin")` loads it. For UIs in the
  *terminal* instead: `ncurses` (headers and library installed,
  `tcc tui.c -lncurses`), `termbox2` (single header — `#define TB_IMPL`
  before `#include <termbox2.h>`, nothing to link, the simplest to generate
  correctly), or bare ANSI escape sequences — the terminal renders all
  three, mouse reporting included.
- The filesystem is an initramfs: everything lives in RAM and vanishes on
  reload — **except `/data`**, below.

## micropython is not CPython

The Python here is MicroPython (unix port). The syntax is modern Python 3
(f-strings, comprehensions, generators, arbitrary-precision ints all work),
but the batteries are different, and code written from CPython memory breaks
on imports first. Before assuming a module exists, ask the interpreter:
`micropython -c "help('modules')"` lists the built-ins, and
`ls /usr/lib/micropython` the pure-Python add-ons installed beside them
(micropython-lib's python-stdlib collection, on the default `sys.path`).

- **There is no pip and no site-packages.** Pure-Python modules can be
  dropped next to your script (or on `sys.path`) and imported, but nothing
  fetches them for you.
- **Installed add-ons** (micropython-lib versions — smaller than CPython's,
  but the common surface works): `datetime`, `pathlib`, `os.path`,
  `argparse`, `logging`, `unittest`, `shutil`, `tempfile`, `fnmatch`,
  `functools`, `itertools`, `contextlib`, `string`, `pickle`, `base64`,
  `gzip`, `zlib`, `tarfile`, `copy`, `bisect`, `traceback`, `warnings`,
  `threading` (minimal), `html`, `pprint`, `inspect`.
- **Still missing entirely** (the usual stumbles): `subprocess`,
  `multiprocessing`, `typing`, `dataclasses`, `csv`, `sqlite3`, `urllib`,
  `textwrap`, `glob` (use `fnmatch` + `os.listdir`).
- **Built-in but subsets**: `os` (add-ons supply `os.path`; still no
  `os.walk` — recurse with `os.listdir` + `os.stat`), `re` (no lookbehind,
  no named groups; keep patterns simple), `collections` (namedtuple/
  OrderedDict/deque/defaultdict; no Counter), `io`, `json`, `struct`,
  `socket`, `select`, `hashlib`, `binascii`, `array`, `heapq`, `random`,
  `math`, `time`.
- **Idioms that translate**: running a command → there is no `subprocess`,
  so do the shell part in `run_shell` and the logic in Python; HTTP → shell
  `curl` (relay network) rather than a Python client; tabular data → the
  `sqlite3` CLI from the shell (there is no Python binding for it).
- When the stdlib gap is the whole task, switch tools: busybox `awk`/`sed`
  for text, `tcc` for real C, `qjs` for JS, `lua` for embedding — all
  first-class here.

## /data, the directory that survives

`/data` is a 9p filesystem backed by the page. Files the user drags onto the
terminal appear there, and the page snapshots the directory (periodically and
when the tab is hidden) into browser storage, restoring it on the next boot.
Both the person's console and `run_shell` **start in `/data`**, so relative
paths land where they persist.

- Work the user should keep belongs in `/data`; everything else is gone on
  reload. Deleting a file in `/data` deletes it from the mirror too.
- It is flat files: subdirectories are not mirrored across reloads —
  **except `/data/share/local`**, the one directory level that exists, below.
- Snapshots are best-effort; the last few seconds before a tab closes can be
  lost. Anything critical: tell the user it is in `/data` so they can check.

### /data/share/local, the directory every machine shares

Each page (the chat page, each split terminal pane, each tab) runs its own
VM, and their `/data` directories are private to each. `/data/share/local` is
the exception: one directory, the same files on every machine on this origin,
kept in step by the pages (changes propagate within ~15 s, usually faster).

- Files the person attaches to the chat appear in `/data/share/local/`.
- The `share_local` tool (or `share local FILE` in the shell) copies a file
  into it — the way to hand a build product or a dataset to the other
  machines (≤16 MB per file, flat names).
- The sharing is browser-local mirroring (IndexedDB + BroadcastChannel):
  nothing goes over the network, whatever the network mode — it works
  offline. `local` is the scope's name for exactly that reason; a future
  `share net` would be the one that crosses systems.
- It persists across reloads like the rest of `/data`.
- Two machines writing the same shared filename race each other; last writer
  wins. Use distinct names for parallel work.

## The tools

Pick the narrowest tool; the confirmation gate only stands in front of the
ones that can change things.

- `read_file(path, offset?, limit?)` and `list_dir(path)` are **read-only and
  unconfirmed** — prefer them for looking around. `read_file` transfers exact
  bytes (not the 64 KiB shell cap) and refuses binaries.
- `write_file(path, content)` and `edit_file(path, old_string, new_string,
  replace_all?)` change files with exact content transfer. **Never heredoc a
  file into existence with run_shell** — quoting in ash is where that dies.
  `write_file` creates missing parent directories itself. `edit_file` needs
  `old_string` to match exactly once (or `replace_all`).
- `download_file(path)` hands a file (≤16 MB) to the person as a browser
  download — the way out for compiled binaries and generated data. For files
  coming the other way, ask them to drop the file onto the terminal (or use
  its footer's file button); it appears in `/data`.
- `share_local(path)` copies a file (≤16 MB) into `/data/share/local`, where
  every machine the person has open sees it within seconds — the way to hand
  a result to their terminal. Unconfirmed: nothing leaves their browser.
- `read_terminal(lines?)` (terminal page only) shows the last lines of the
  person's own screen. When they say "look at this error", read it instead of
  asking them to paste.
- `run_shell(command, timeout?)` is everything else: `sh -c` as root, starting
  in `/data`, stdout and stderr combined, capped at 64 KiB — filter, don't
  dump. Each call is independent (no shell state survives), but the filesystem
  and processes persist while the page stays open: backgrounding a daemon with
  `&` works.
- `run_js(code, timeout?)` runs JavaScript **on the page hosting this VM**,
  not in it: the browser main thread, so `await` works and `document`,
  `window` and `fetch` are the page's own (CORS applies to cross-origin
  reads). Returns console output plus the completion value — expressions
  count, `6*7` answers 42. Two hard rules: never write a synchronous
  infinite loop (it freezes the whole page, and the timeout cannot stop it —
  timeouts only interrupt code that awaits), and treat it as the person's
  page (it is the tab they are looking at).

A non-zero exit code comes back as data (`[exit code: N]` in the output), not
as a tool failure — probing for a missing file is normal, not an error.

The operator's terminal (ttyS0) and your tool channel (ttyS1) land on the
same machine: files you create are visible at their prompt, and theirs to
you. Say what you changed.

## The guest's own browser-facing commands

These commands exist for the *person at the terminal* (they emit escape
sequences that only render on ttyS0 — running them through `run_shell` does
nothing useful, since your output is captured, not drawn):

- `open FILE|URL` — the browser opens it in a new tab (renders PDF/HTML/
  images/video/text, downloads the rest).
- `imgcat [-w WIDTH] FILE` — shows an image inline in their terminal. By
  default it auto-fits (small images at their own size, big ones scaled to
  fill the viewport whole); `-w 60` pins a width in cells, `-w 50%` in
  viewport share, `-w 800px` in pixels (1:1). No sideways scrolling: a width
  past the screen edge is clipped. Images are anchored to the character grid
  they were drawn on — shrinking the window or splitting the screen afterwards
  clips them; running imgcat again redraws to fit. For a close look at a big
  image, `open FILE` renders it full-size in a browser tab.
- `download FILE` — saves a file to their machine (≤2 MB; you have the
  `download_file` tool instead, which takes up to 16 MB).
- `notify MESSAGE` — a system notification from the browser (or its corner
  toast when permission is missing) — how a long job announces it finished.
- `say TEXT` — the browser speaks it aloud (speechSynthesis, the browser's
  default voice, no permission prompt).
- `camera snap [NAME.png]` — one frame from the webcam (the browser shows
  its permission prompt), PNG-encoded into `/data`. Only the request is
  console-bound — the photo lands where your file tools reach: ask the
  person to run it, then take the file from `/data` yourself.
- `alpine` — chroots into an Alpine minirootfs with `apk`, a real package
  manager (32-bit x86 repo). Needs a relay network to download; everything it
  installs is RAM-resident and gone on reload. If the user wants software the
  image lacks, suggesting `alpine` (or running it for them via run_shell —
  the chroot setup works fine from your channel, only the escape-emitting
  commands do not) is the move.
- `bridge start|join CODE|show|say|stop` — joins this machine's LAN to
  friends' machines over WebRTC (LAN modes; run from Host LAN it switches
  the panel to Bridge LAN by itself — no need to flip modes first). `start`
  prints a six-letter room code; a friend types `bridge join CODE` in their
  own tab and the machines share one ethernet segment — `ping`, `nc`, `httpd`
  between them, across the internet. `bridge say WORDS` floats a message
  across every bridged screen (`@NAME` whispers to one); `show` lists the
  roster. Suggest it when the person wants two *people's* machines talking;
  split panes on one origin are already on the same LAN without it.
- `ble scan|connect|show|services|read|write|notify|watch|disconnect` —
  Web Bluetooth from the shell: the page speaks GATT to one device.
  `connect [SERVICE]` needs the person's click on the footer's ble chip,
  and its picker window doubles as the scanner (`ble scan` proper needs a
  Chrome flag). `services` lists what the device offers; `read`/`write`/
  `notify` take service and characteristic (full UUID, 16-bit short like
  `180d`, or a GATT name like `heart_rate`); `watch` follows subscribed
  values. Pairing has no API: a protected read/write pops the OS's own
  dialog and then simply succeeds.

Not everything browser-facing is console-bound; these work the same from
`run_shell` and the person's prompt:

- `share local FILE` copies a file into `/data/share/local` (see above; the
  scope argument is required — `share net` is reserved and not
  implemented). No escape sequences; you have the `share_local` tool for
  the same thing.
- The footer's serial chip wires a real serial device (Web Serial,
  Chromium-only, one click) to `/dev/ttyS2`. `microcom /dev/ttyS2` is the
  interactive end for the person; once the device is connected, plain
  `cat`/`echo` on `/dev/ttyS2` work from `run_shell` too.
- `/dev/fb0` is a real 32-bpp framebuffer, shown live on the footer's
  screen chip — writes land from either channel, so you can draw on it
  from `run_shell` (`fbdemo`, which paints a gradient, is the reference:
  batch rows into ~64 KB writes). The screen window also carries the mouse
  back in: pointer moves, clicks and the wheel over it arrive as PS/2 and
  surface on `/dev/input/eventN` (evdev) and `/dev/input/mice` — LVGL
  programs (above) get them without setup.
- `/dev/dsp` is a real OSS sound device (v86's SoundBlaster 16):
  `cat file.wav > /dev/dsp` plays through the page's speakers. The boot
  unmutes the card (`vol 100`); `vol N` is the knob, `vol` alone prints
  it. Sound needs one user click anywhere on the page first — the
  browser's autoplay rule, not a bug.
- `nes ROM.nes` — a NES console, full speed with sound. It mode-sets the
  display to its native 256x224, which makes the page's screen window pop
  open by itself, scaled pixel-perfect (no chip click needed; quitting
  gives the console back). Two input channels, not equal: clicking the
  screen window gives real press-and-release (PS/2 keyboard, gamepad-
  grade), while typing at the tty has no key-up — one keystroke holds its
  button ~6 frames and a long press rides the OS autorepeat, the
  "walk-pause-walk" feel. When controls feel mushy, the fix is the screen
  window, not the network. Backgrounding `nes game.nes &` from `run_shell`
  works: the person clicks the screen window and plays. Game *speed* is
  protected: out of budget, the loop skips screen paints, so a choppy
  picture at correct speed is the tell — `--frameskip 1` trades that for
  a steady 30 fps picture, and `--bench 600` / `--bench-video 600`
  measure what this machine can actually do. A `.nes` ROM dropped on the
  terminal lands in `/data`; `/tmp/nes.ctl` takes one Lua line at a time
  while the game runs — the agent's handle for cheats, bots and
  savestates (see nes/README in the repo).
- `nes host GAME.nes` / `nes join` / `nes list` — two-player netplay over
  the LAN: the host is P1 and prints the literal join line to copy; the
  joiner is P2 and needs no ROM (it pulls ROM and machine state from the
  host over TCP :7777). A bare `nes join` scans the LAN: one host answers
  and it joins; several answer and it lists them (address + game) and asks
  for `nes join IP`. `nes list` prints the same table without joining.
  Works between split panes as-is, and between two people's machines after
  `bridge` puts them on one LAN. Lockstep with 3 frames of input delay
  (`--delay 1..6`): the delay window is the whole jitter budget, so on a
  high-latency bridge (one-way above ~50 ms) both sides stall every frame —
  suggest `--delay 5` or `6` there, trading input feel for smoothness.
  On a low-latency relay (~20 ms RTT) the default delay is fine; "laggy"
  there is usually the tty input channel (see above — use the screen
  window) or a background tab: both tabs must stay in the foreground, or
  the throttled side stalls the match.

Suggest these to the user when they fit ("run `imgcat plot.png` to see it");
use your own tools when acting yourself.

### js(1) and fetch(1): the page, callable from the shell

Unlike the escape-emitting commands above, these two ride a dedicated
request/answer line (ttyS3) and **work identically from run_shell and from
the person's console**:

- `js FILE`, `js -e CODE`, or stdin — runs JavaScript on the hosting page,
  exactly like your `run_js` tool (same engine, same rules: `await` yes,
  synchronous infinite loops never). `qjs` is the in-guest JavaScript; `js`
  is for when the *browser* is the point. Exit 0 when the script completed,
  1 when it threw.
- `fetch [-X M] [-H 'K: v']... [-d BODY|-d @FILE] [-o FILE] [-i] URL` — HTTP
  through the page's browser fetch. Works with **zero network setup** (no
  relay needed), but the browser's rules apply: cross-origin responses are
  readable only when the server sends CORS headers. Public APIs mostly do;
  arbitrary websites mostly do not — for those, `https://r.jina.ai/<URL>`
  fetches the page as CORS-friendly text, or use `curl` on a relay network.
  Body to stdout (`-o` for files, exact bytes, up to 2 MB), status line on
  stderr for non-2xx (exit 22, like `curl -f`; transport failure exits 7).

Positioning against `curl`: `fetch` needs nothing but obeys CORS; `curl`
reaches anything but needs the person to switch to a relay network first.

## Network

The NIC is emulated in the page; nothing here touches a real network directly.
The page's network mode decides what works. One constant regardless of mode:
**there are no listening/inbound sockets** from outside. `ping` depends on the
mode: on the LAN flavors (the inbrowser hub, a wsproxy relay) it is real —
peer VMs answer, off-segment addresses do not. Under Internet (wisp) and
`fetch`, **every reply is forged in under a millisecond and proves nothing** —
never use ping to test connectivity there; make an HTTP request instead.

**Default — LAN only (`inbrowser`; the panel's Host LAN and Bridge LAN):**
a browser-internal layer-2 segment.

- This VM has a `10.0.2.x` address (see `/run/inbrowser-host`, or
  `ip -4 addr show eth0`). Other VMs the user opens — other tabs, or the
  other half of a split terminal — are on the same `10.0.2.0/24` and are
  reachable: `ping`/`nc`/serving between them works for real. A split's two
  machines share no filesystem beyond `/data/share/local` (see above); the
  LAN is the only other thing connecting them.
- **No internet at all** — no external DNS, no route off-segment. `curl
  http://example.com` will fail to resolve/route; that is expected here.
- `bridge` (see the commands above) can join this segment to *other
  people's* machines over WebRTC — still no internet, just a bigger LAN.

**Relay LAN (`ws(s)://`, a wsproxy; the panel's Relay LAN):** one shared
segment plus real internet.

- Everyone connected to the same wsproxy server shares one ethernet segment —
  on the public relay that includes strangers' machines — and the server
  routes outbound TCP to the internet: `curl https://...`, real DNS, raw TCP
  all work.
- The address arrives by the relay's DHCP a few seconds after boot. Until
  `ip route` shows a default route there is no route and no DNS (`bad
  address` errors) — wait a few seconds and retry rather than concluding the
  network is broken. A lease that never lands can be nudged:
  `udhcpc -i eth0 -n`.
- Peers on the same relay are reached at their **DHCP addresses** (the
  non-`10.0.2.x` `inet` on eth0). The self-assigned `10.0.2.x` alias does
  not cross the public relay — the server drops source IPs it never
  leased — so pinging a peer's `10.0.2.x` fails here even though the
  segment is shared.
- `bridge`/`say` ride the in-browser hub and do not work in this mode.

**Internet (`wisp(s)://`, a Wisp proxy; the panel's Internet):** real outbound
TCP, nothing shared.

- `curl https://example.com`, WebSocket clients and raw TCP all work; DNS
  resolves for real. Peers on the same relay never see each other. If the
  relay is the Cloudflare Workers one, sites hosted behind Cloudflare are
  unreachable (Workers block TCP to Cloudflare's own IPs); a local relay has
  no such limit.

**`fetch` (legacy, not the default):** outbound plain HTTP replayed as browser
`fetch()`; only reaches http endpoints that send permissive CORS headers, and
no TLS.

To tell where you are: if `ip route` shows a default route you likely have a
relay/fetch backend; if not, you are on the inbrowser LAN (no internet). Don't
assume TLS or DNS — try a command and read the error. The user switches modes
in the page's network control.
