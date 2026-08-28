################################################################################
#
# nes -- the repo's own NES console (top-level nes/), compiled with the cross
# gcc at -O2 and shipped in the image as /usr/bin/nes. The tcc-on-target
# build story is retired: no optimizer on an emulated i686 reached only half
# speed, and the APU starved. The sources still live at the repo top level;
# SITE_METHOD = local rsyncs them into the build tree ONCE, at extract --
# after editing nes/src, `make nes-dirclean` (see linux/README.md's "rebuild
# one package" recipe) before the next build, or the change stays behind.
#
################################################################################

NES_VERSION = 1.0
NES_SITE = $(BR2_EXTERNAL_VINX_PATH)/../../nes
NES_SITE_METHOD = local
NES_LICENSE = MIT
NES_LICENSE_FILES = vendor/LICENSE
NES_DEPENDENCIES = lua

NES_SRCS = \
	src/core.c src/main.c src/video.c src/input.c \
	src/apu.c src/audio.c src/net.c src/lua_glue.c

# -O3 -fomit-frame-pointer after $(TARGET_CFLAGS) so they outrank the global
# -Os: the emulated CPU is the scarce resource, and freeing %ebp for an
# eighth register matters on i386. Measured with `nes --bench 600` in the
# booted VM (same host, same synthetic ROM): -O2 61.6 fps -> -O3+fomit
# 80.1 fps, a 30% core speedup.
define NES_BUILD_CMDS
	cd $(@D) && $(TARGET_CC) $(TARGET_CFLAGS) -O3 -fomit-frame-pointer \
		-DNES_LUA -DNES_APU \
		-o nes $(NES_SRCS) $(TARGET_LDFLAGS) -llua
endef

define NES_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 755 $(@D)/nes $(TARGET_DIR)/usr/bin/nes
endef

$(eval $(generic-package))
