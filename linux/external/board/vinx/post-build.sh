#!/bin/sh
# Buildroot deliberately removes headers and static archives while finalizing
# an appliance target. This VM intentionally carries an on-target C compiler,
# so put only the development files tcc needs back after that cleanup.
set -eu

target="$1"

mkdir -p "$target/usr/include" "$target/usr/lib/tcc"
cp -a "$STAGING_DIR/usr/include/." "$target/usr/include/"
install -m 644 "$STAGING_DIR/usr/lib/tcc/libtcc1.a" \
	"$target/usr/lib/tcc/libtcc1.a"
# The control plane's C client (system-v2 §6.10): the one static archive
# that must survive finalize, so `tcc x.c -lvinxrpc` works on the target.
install -m 644 "$STAGING_DIR/usr/lib/libvinxrpc.a" \
	"$target/usr/lib/libvinxrpc.a"

# vim ships without its runtime (BR2_PACKAGE_VIM_RUNTIME off), but the
# unconditional `make installpack`/`installtools` still drop ~1.3 MB of
# bundled plugin packs and helper scripts nothing here can use. The editor
# needs only its binary and the system vimrc.
rm -rf "$target/usr/share/vim/vim"*/pack "$target/usr/share/vim/vim"*/tools
