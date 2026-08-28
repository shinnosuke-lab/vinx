################################################################################
#
# tcc -- TinyCC running *on* the i686 target, so people can compile C inside
# the browser VM. Buildroot mainline has no tcc package; this one also serves
# as the template for adding your own packages to this external tree.
#
# Two things are unusual compared to a stock package:
#
#   - libtcc1.a (tcc's runtime) is normally built by running the freshly
#     compiled tcc, but that binary only runs on the target. The runtime's
#     three i386 objects are plain C/asm, so they are compiled here with the
#     cross gcc instead.
#
#   - A compiler is useless without headers and crt objects. This package puts
#     the crt files in the target and libtcc1.a in staging; post-build.sh
#     restores the headers and archive after Buildroot's normal final cleanup
#     deletes development files. Together that is what makes
#     `tcc hello.c` link against /lib/libc.so in the running system.
#
################################################################################

TCC_VERSION = 0.9.27
TCC_SOURCE = tcc-$(TCC_VERSION).tar.bz2
TCC_SITE = https://download.savannah.gnu.org/releases/tinycc
TCC_LICENSE = LGPL-2.1
TCC_LICENSE_FILES = COPYING
TCC_INSTALL_STAGING = YES

# tcc's configure is hand-rolled, not autotools; --config-musl picks
# /lib/ld-musl-i386.so.1 as the ELF interpreter for produced binaries.
define TCC_CONFIGURE_CMDS
	cd $(@D) && ./configure \
		--cross-prefix=$(TARGET_CROSS) \
		--cpu=i386 \
		--config-musl \
		--elfinterp=/lib/ld-musl-i386.so.1 \
		--prefix=/usr
endef

# -fcommon: tcc 0.9.27 predates gcc 10's -fno-common default and has
# tentative definitions spread over translation units.
define TCC_BUILD_CMDS
	$(TARGET_MAKE_ENV) $(MAKE) -C $(@D) CFLAGS="$(TARGET_CFLAGS) -fcommon" tcc
	cd $(@D)/lib && \
		$(TARGET_CC) $(TARGET_CFLAGS) -c libtcc1.c -o libtcc1.o && \
		$(TARGET_CC) $(TARGET_CFLAGS) -c alloca86.S -o alloca86.o && \
		$(TARGET_CC) $(TARGET_CFLAGS) -c alloca86-bt.S -o alloca86-bt.o && \
		$(TARGET_AR) rcs $(@D)/libtcc1.a libtcc1.o alloca86.o alloca86-bt.o
endef

define TCC_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 755 $(@D)/tcc $(TARGET_DIR)/usr/bin/tcc
	mkdir -p $(TARGET_DIR)/usr/lib/tcc/include
	cp -a $(@D)/include/*.h $(TARGET_DIR)/usr/lib/tcc/include/
	$(INSTALL) -m 644 $(STAGING_DIR)/lib/crt1.o $(TARGET_DIR)/usr/lib/crt1.o
	$(INSTALL) -m 644 $(STAGING_DIR)/lib/crti.o $(TARGET_DIR)/usr/lib/crti.o
	$(INSTALL) -m 644 $(STAGING_DIR)/lib/crtn.o $(TARGET_DIR)/usr/lib/crtn.o
endef

define TCC_INSTALL_STAGING_CMDS
	$(INSTALL) -D -m 644 $(@D)/libtcc1.a $(STAGING_DIR)/usr/lib/tcc/libtcc1.a
endef

$(eval $(generic-package))
