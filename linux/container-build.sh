#!/usr/bin/env bash
# The half of linux/build.sh that runs inside the container. Everything under
# /x/dl and /x/build lives in named volumes; /x/repo is the repository.
set -euo pipefail

BR="buildroot-$BUILDROOT_VERSION"
TARBALL="/x/dl/$BR.tar.gz"
TREE="/x/build/$BR"
OUT="/x/build/out"

echo "==> Buildroot $BUILDROOT_VERSION"
if [ ! -f "$TARBALL" ]; then
	wget -q -O "$TARBALL.tmp" "https://buildroot.org/downloads/$BR.tar.gz"
	mv "$TARBALL.tmp" "$TARBALL"
	echo "    downloaded"
else
	echo "    cached"
fi
if [ ! -d "$TREE" ]; then
	tar -xzf "$TARBALL" -C /x/build
	echo "    unpacked"
fi

# BR2_DL_DIR keeps every source package Buildroot fetches in the volume, so a
# --clean rebuild re-downloads nothing.
export BR2_DL_DIR=/x/dl/packages
mkdir -p "$BR2_DL_DIR"

# The container runs as root, which host-tar's configure refuses on principle.
# Everything here is a throwaway build tree inside a container; the check
# protects nothing.
export FORCE_UNSAFE_CONFIGURE=1

echo "==> Configure"
make -C "$TREE" O="$OUT" BR2_EXTERNAL=/x/repo/linux/external \
	vinx_v86_defconfig

echo "==> Build ($(nproc) jobs; the first run takes a while -- it builds a"
echo "    cross toolchain, a kernel and a userland)"
make -C "$TREE" O="$OUT" -j"$(nproc)"

echo "==> Install"
install -d /x/repo/web/app/public/vm
install -m 644 "$OUT/images/bzImage" /x/repo/web/app/public/vm/bzImage
# Installed as .img, not its Buildroot name rootfs.cpio.gz: static servers
# treat a .gz extension as "pre-compressed content" and add
# Content-Encoding: gzip (vite's sirv does), so the browser transparently
# decompresses and v86 hands the kernel a ~3x larger raw-cpio initrd --
# which stopped fitting the 128 MB guest's unpack budget ("Initramfs
# unpacking failed: write error", half of /usr missing). The kernel sniffs
# the compression from content, so the neutral name costs nothing.
install -m 644 "$OUT/images/rootfs.cpio.gz" /x/repo/web/app/public/vm/rootfs.img
ls -la /x/repo/web/app/public/vm/
