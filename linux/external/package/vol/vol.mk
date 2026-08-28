################################################################################
#
# vol -- the volume knob (see src/vol.c for why the image needs one). A
# single C file, cross-built and installed as /usr/bin/vol plus the S25vol
# boot script that unmutes the card.
#
################################################################################

VOL_VERSION = 1.0
VOL_SITE = $(BR2_EXTERNAL_VINX_PATH)/package/vol/src
VOL_SITE_METHOD = local
VOL_LICENSE = MIT

define VOL_BUILD_CMDS
	cd $(@D) && $(TARGET_CC) $(TARGET_CFLAGS) -o vol vol.c $(TARGET_LDFLAGS)
endef

define VOL_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 755 $(@D)/vol $(TARGET_DIR)/usr/bin/vol
endef

define VOL_INSTALL_INIT_SYSV
	$(INSTALL) -D -m 755 $(VOL_PKGDIR)/S25vol $(TARGET_DIR)/etc/init.d/S25vol
endef

$(eval $(generic-package))
