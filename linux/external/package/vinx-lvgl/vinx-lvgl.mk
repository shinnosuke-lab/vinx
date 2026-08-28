################################################################################
#
# vinx-lvgl -- LVGL v9 compiled into one liblvgl.so for on-target use. The
# upstream build systems (CMake, Kconfig) are skipped on purpose: every
# .c under src/ compiles against our lv_conf.h in a single cross-gcc call,
# which is the whole build. lv_conf.h lives next to this file and is the
# one artifact to touch when enabling features; it only lists departures
# from LVGL's defaults (lv_conf_internal.h fills in the rest), so version
# bumps do not need a template re-diff.
#
# Headers go to staging in the "lv_conf.h next to the lvgl folder" layout
# (/usr/include/lvgl/..., /usr/include/lv_conf.h). gcc auto-detects the
# conf via __has_include; tcc (no __has_include) falls back to including
# ../../lv_conf.h from inside lvgl/src, which resolves to the same file.
# post-build.sh copies staging includes into the target, so the on-target
# compilers see them without extra install steps here. The thorvg vector
# engine's headers stay out: it is C++ (nothing on the target compiles
# that), disabled in lv_conf, and its tree is a meaningful slice of the
# initramfs.
#
################################################################################

VINX_LVGL_VERSION = 9.3.0
VINX_LVGL_SITE = $(call github,lvgl,lvgl,v$(VINX_LVGL_VERSION))
VINX_LVGL_LICENSE = MIT
VINX_LVGL_LICENSE_FILES = LICENCE.txt
VINX_LVGL_INSTALL_STAGING = YES

define VINX_LVGL_BUILD_CMDS
	cp $(VINX_LVGL_PKGDIR)/lv_conf.h $(@D)/lv_conf.h
	cd $(@D) && $(TARGET_CC) $(TARGET_CFLAGS) -fPIC -shared \
		-I$(@D) $$(find src -name '*.c' | sort) \
		-o liblvgl.so -Wl,-soname,liblvgl.so $(TARGET_LDFLAGS) -lm
endef

define VINX_LVGL_INSTALL_STAGING_CMDS
	$(INSTALL) -D -m 755 $(@D)/liblvgl.so $(STAGING_DIR)/usr/lib/liblvgl.so
	$(INSTALL) -D -m 644 $(@D)/lv_conf.h $(STAGING_DIR)/usr/include/lv_conf.h
	$(INSTALL) -D -m 644 $(@D)/lvgl.h $(STAGING_DIR)/usr/include/lvgl/lvgl.h
	$(INSTALL) -D -m 644 $(@D)/lv_version.h \
		$(STAGING_DIR)/usr/include/lvgl/lv_version.h
	mkdir -p $(STAGING_DIR)/usr/include/lvgl
	cd $(@D) && find src -name '*.h' -not -path 'src/libs/thorvg/*' \
		-exec cp --parents {} $(STAGING_DIR)/usr/include/lvgl/ \;
endef

define VINX_LVGL_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 755 $(@D)/liblvgl.so $(TARGET_DIR)/usr/lib/liblvgl.so
endef

$(eval $(generic-package))
