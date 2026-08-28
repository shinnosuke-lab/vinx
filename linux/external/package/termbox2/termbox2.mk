################################################################################
#
# termbox2 -- a single-header TUI library, shipped as exactly that: the
# header into staging include, which post-build.sh carries into the
# target's /usr/include. Nothing is compiled here; the one program that
# #defines TB_IMPL before including it owns the implementation, which is
# the arrangement tcc handles best (no library to link at all).
#
################################################################################

TERMBOX2_VERSION = 2.5.0
TERMBOX2_SITE = $(call github,termbox,termbox2,v$(TERMBOX2_VERSION))
TERMBOX2_LICENSE = MIT
TERMBOX2_LICENSE_FILES = LICENSE
TERMBOX2_INSTALL_STAGING = YES
# Header-only: nothing lands in the target directly (see above).
TERMBOX2_INSTALL_TARGET = NO

define TERMBOX2_INSTALL_STAGING_CMDS
	$(INSTALL) -D -m 644 $(@D)/termbox2.h $(STAGING_DIR)/usr/include/termbox2.h
endef

$(eval $(generic-package))
