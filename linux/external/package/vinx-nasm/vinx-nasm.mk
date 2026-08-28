################################################################################
#
# vinx-nasm -- mainline's nasm is host-only ($(eval $(host-autotools-package))
# and no Config.in), so a target build needs its own package; the VINX_ prefix
# keeps its make variables clear of the mainline host package's NASM_* ones.
# Same tarball, same hash, cross-compiled with the target autotools flow.
#
################################################################################

VINX_NASM_VERSION = 2.16.03
VINX_NASM_SOURCE = nasm-$(VINX_NASM_VERSION).tar.xz
VINX_NASM_SITE = https://www.nasm.us/pub/nasm/releasebuilds/$(VINX_NASM_VERSION)
VINX_NASM_LICENSE = BSD-2-Clause
VINX_NASM_LICENSE_FILES = LICENSE

# The tools the machine needs are the assembler and the disassembler; the
# default install also drops man pages, which target-finalize purges anyway.
define VINX_NASM_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 755 $(@D)/nasm $(TARGET_DIR)/usr/bin/nasm
	$(INSTALL) -D -m 755 $(@D)/ndisasm $(TARGET_DIR)/usr/bin/ndisasm
endef

$(eval $(autotools-package))
