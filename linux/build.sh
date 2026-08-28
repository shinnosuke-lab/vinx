#!/usr/bin/env bash
#
# Build the Linux the page boots: an i686 kernel (bzImage) and a busybox
# initramfs (rootfs.img -- a gzipped cpio; see container-build.sh for why it
# does not keep the .gz name), produced by Buildroot inside Docker and copied
# into web/app/public/vm/ where v86 loads them from.
#
# Docker because Buildroot requires a Linux host; named volumes because the
# Buildroot tree, its download cache and its build tree are all cache, and
# only the two images belong in the repository.
#
# Usage:
#   ./linux/build.sh              build (incremental where possible)
#   ./linux/build.sh --clean      drop the build volume first, then build
#   ./linux/build.sh --shell      a shell inside the build container instead
#
# Environment:
#   BUILDROOT_VERSION   default pinned below

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BUILDROOT_VERSION="${BUILDROOT_VERSION:-2025.02.9}"
IMAGE=vinx-linux-builder:v1
VOL_DL=vinx-buildroot-dl
VOL_BUILD=vinx-buildroot-build

MODE=build
case "${1:-}" in
	--clean) docker volume rm -f "$VOL_BUILD" >/dev/null; shift ;;
	--shell) MODE=shell; shift ;;
esac

echo "==> Builder image"
docker build -q -t "$IMAGE" "$SCRIPT_DIR" >/dev/null
echo "    $IMAGE"

run() {
	docker run --rm -i \
		-v "$REPO_DIR:/x/repo" \
		-v "$VOL_DL:/x/dl" \
		-v "$VOL_BUILD:/x/build" \
		-e "BUILDROOT_VERSION=$BUILDROOT_VERSION" \
		"$@"
}

if [ "$MODE" = shell ]; then
	run -t "$IMAGE" bash
	exit 0
fi

run "$IMAGE" bash /x/repo/linux/container-build.sh

echo ""
echo "==> Images"
ls -la "$REPO_DIR/web/app/public/vm/"
