# Building the Linux

The Linux the page boots is two files — `bzImage` (an i686 kernel) and
`rootfs.img` (a busybox initramfs: a gzipped cpio under a neutral name, so
no static server ever serves it with `Content-Encoding: gzip` — see
`container-build.sh`) — produced by
[Buildroot](https://buildroot.org) and loaded by v86 straight from
`web/app/public/vm/`. This directory is everything needed to rebuild or
customize them.

```bash
./linux/build.sh            # build (incremental; first run takes a while)
./linux/build.sh --clean    # drop the build tree first
./linux/build.sh --shell    # a shell inside the build container
```

Docker is the only requirement: Buildroot needs a Linux host, so the build
runs in a container. Three named volumes make rebuilds fast — the Buildroot
tree and build outputs (`vinx-buildroot-build`) and every downloaded
source tarball (`vinx-buildroot-dl`) survive between runs. The images are
copied into `web/app/public/vm/` at the end; run `npm run build` in `web/` (or
just reload the dev server) to see them in the page.

## Layout

Everything project-specific lives in `external/`, a
[Buildroot external tree](https://buildroot.org/downloads/manual/manual.html#outside-br-custom)
— Buildroot itself is never patched:

    external/
      configs/vinx_v86_defconfig    what the system is (target, packages)
      board/vinx/
        linux.fragment                  kernel options on top of the i386 defconfig
        busybox.fragment                busybox applets on top of the default set
        post-build.sh                   restores tcc development files after cleanup
        rootfs-overlay/                 files copied verbatim into the image
      package/tcc/                      a custom package (and the template for yours)
      package/micropython-pylib/        micropython-lib's python-stdlib add-ons
      package/nes/                      the repo's NES console (../nes) -> /usr/bin/nes
      package/vol/                      the volume knob; S25vol unmutes the card at boot
      Config.in, external.mk            the external tree's wiring

## Recipes

**Add a package.** Find its option name, add it to
`configs/vinx_v86_defconfig`, rebuild:

```bash
./linux/build.sh --shell
# inside the container: browse packages interactively
make -C /x/build/buildroot-* O=/x/build/out BR2_EXTERNAL=/x/repo/linux/external menuconfig
```

Most packages are one line (`BR2_PACKAGE_QUICKJS=y`). If you used menuconfig
to experiment, write the result back with `savedefconfig`:

```bash
make -C /x/build/buildroot-* O=/x/build/out BR2_EXTERNAL=/x/repo/linux/external \
    savedefconfig BR2_DEFCONFIG=/x/repo/linux/external/configs/vinx_v86_defconfig
```

Mind the size: the whole rootfs is downloaded by every visitor and lives in
the VM's RAM. A few MB is fine; a hundred is not.

**Add files to the image.** Drop them into `board/vinx/rootfs-overlay/`
mirroring the target layout (`rootfs-overlay/usr/sbin/agentd` becomes
`/usr/sbin/agentd`). Mode bits are preserved; make scripts executable.

**Change a kernel option.** Append to `board/vinx/linux.fragment`.
Buildroot does not notice fragment edits on its own — force the kernel step,
then rebuild:

```bash
docker run --rm -v "$PWD:/x/repo" -v vinx-buildroot-dl:/x/dl -v vinx-buildroot-build:/x/build \
    vinx-linux-builder:v1 make -C /x/build/buildroot-2025.02.9 O=/x/build/out \
    BR2_EXTERNAL=/x/repo/linux/external linux-dirclean
./linux/build.sh
```

**Change a busybox applet.** Same story with `busybox.fragment` and
`busybox-dirclean`.

**Rebuild one package after editing it.** `make <name>-dirclean` (same
container invocation as above), then `./linux/build.sh`.

**Write your own package.** Copy `package/tcc/` — it shows the whole surface:
`Config.in` (the option), `<name>.mk` (download, configure, build, install),
`<name>.hash` (source/license integrity), plus registration in
`external/Config.in` and `external/external.mk`. Tcc also demonstrates one
unusual case: Buildroot intentionally strips target headers and static
archives, so `board/vinx/post-build.sh` restores the small development
subset an on-target compiler needs after normal cleanup. The
[Buildroot manual](https://buildroot.org/downloads/manual/manual.html#adding-packages)
covers the details.

## What is actually in the image

See the comments in
[`configs/vinx_v86_defconfig`](external/configs/vinx_v86_defconfig) —
they are the inventory: musl, busybox (plus `timeout` and `nc`), TLS-capable
curl with CA certificates, tcc with headers to compile C on the target, GNU
make, lua (with liblua and headers), micropython (plus micropython-pylib's
pure-Python stdlib add-ons) and quickjs, sqlite3 and jq, nasm and ndisasm
(Intel-syntax assembly on a machine that really is an i686), strace, btmon
(bluez's analyzer built without bluez, for offline btsnoop captures), a
runtime-less vim, LVGL v9 as a system library (`tcc gui.c -llvgl` draws on
the VGA screen; `package/vinx-lvgl` compiles it, and the overlay ships a
full GB2312 font at `/usr/share/fonts/cjk16.bin`), termbox2's single
header and ncurses for terminal UIs, and the repo's own NES console as
`/usr/bin/nes`. The overlay carries the
two serial services (the console on ttyS0, agentd on ttyS1) and the guest's
browser-facing commands — `open`, `imgcat`, `download`, `share`, `js`,
`fetch`, `notify`/`say`/`camera`, `ble`, `bridge`, `alpine`, `fbdemo`,
`lvdemo` (plus `/usr/share/lvgl/lvdemo.c`, the GUI template) — under
`rootfs-overlay/usr/bin/`. The kernel fragment keeps it uniprocessor, no
modules, with virtio networking, the framebuffer, PS/2 mouse input (evdev,
fed by the page's screen window) and sound the screen chip
and speakers need, and the 9p share the page mounts drag-and-drop files
into.
