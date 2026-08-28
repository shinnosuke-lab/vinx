################################################################################
#
# btmon -- bluez's protocol analyzer, extracted from the bluez tarball
# without running its configure. Configure hard-requires glib2 and dbus
# even when only btmon is wanted; that would grow the rootfs by megabytes
# for a tool whose glib footprint is eight string helpers. So this package
# compiles the btmon sources directly against three small shims (see
# compat/): a glib subset over libc, a stderr logger in place of
# bluetoothd's linker-section logger, and a no-op GATT-cache loader.
#
# The build was derived from monitor_btmon_SOURCES in the tarball's
# Makefile.tools; src/shared and lib go into an archive so the linker
# takes only what btmon references. Version bumps mean re-checking that
# list and the shim surface.
#
################################################################################

BTMON_VERSION = 5.79
BTMON_SOURCE = bluez-$(BTMON_VERSION).tar.xz
BTMON_SITE = $(BR2_KERNEL_MIRROR)/linux/bluetooth
BTMON_LICENSE = GPL-2.0+
BTMON_LICENSE_FILES = COPYING

# The btmon link list, minus src/log.c and src/settings.c (replaced by
# stubs in compat/ -- the real ones want glib's GKeyFile and a linker
# section nothing here populates).
BTMON_MONITOR_SRCS = \
	monitor/main.c monitor/display.c monitor/hcidump.c monitor/ellisys.c \
	monitor/control.c monitor/packet.c monitor/vendor.c monitor/lmp.c \
	monitor/crc.c monitor/ll.c monitor/l2cap.c monitor/sdp.c \
	monitor/avctp.c monitor/avdtp.c monitor/a2dp.c monitor/rfcomm.c \
	monitor/bnep.c monitor/hwdb.c monitor/keys.c monitor/analyze.c \
	monitor/intel.c monitor/broadcom.c monitor/msft.c monitor/jlink.c \
	monitor/att.c src/textfile.c \
	vinx-compat/glib-shim.c vinx-compat/log-stub.c vinx-compat/settings-stub.c

# vinx-include/bluetooth -> lib satisfies the <bluetooth/*.h> includes the
# way bluez's own build does; STORAGEDIR is a configure output.
BTMON_CFLAGS = $(TARGET_CFLAGS) -I. -Ivinx-include -Ivinx-compat \
	-DHAVE_CONFIG_H -D_GNU_SOURCE -DSTORAGEDIR='"/var/lib/bluetooth"' -w

# Excluded from the archive: the glib/ell event-loop variants (btmon uses
# src/shared/mainloop.c), glib-only tester/shell/ad, all unreferenced.
define BTMON_BUILD_CMDS
	mkdir -p $(@D)/vinx-o $(@D)/vinx-include
	ln -sf ../lib $(@D)/vinx-include/bluetooth
	cp -r $(BTMON_PKGDIR)/compat $(@D)/vinx-compat
	cp $(BTMON_PKGDIR)/compat/config.h $(@D)/config.h
	cd $(@D) && \
	for f in $(BTMON_MONITOR_SRCS); do \
		$(TARGET_CC) $(BTMON_CFLAGS) -c $$f \
			-o vinx-o/$$(echo $$f | tr / _ | sed 's/\.c$$/.o/') || exit 1; \
	done && \
	for f in src/shared/*.c lib/bluetooth.c lib/hci.c lib/sdp.c lib/uuid.c; do \
		case $$f in \
		*-glib.c|*-ell.c|*/tester.c|*/shell.c|*/ad.c) continue ;; \
		esac; \
		$(TARGET_CC) $(BTMON_CFLAGS) -c $$f \
			-o vinx-o/a_$$(echo $$f | tr / _ | sed 's/\.c$$/.o/') || exit 1; \
	done && \
	$(TARGET_AR) rcs vinx-o/libbt.a vinx-o/a_*.o && \
	$(TARGET_CC) vinx-o/monitor_*.o vinx-o/src_textfile.o vinx-o/vinx-compat_*.o \
		vinx-o/libbt.a -o btmon $(TARGET_LDFLAGS)
endef

define BTMON_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 755 $(@D)/btmon $(TARGET_DIR)/usr/bin/btmon
endef

$(eval $(generic-package))
