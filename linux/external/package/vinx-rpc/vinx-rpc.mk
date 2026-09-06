################################################################################
#
# vinx-rpc -- the guest half of the ttyS3 control plane (protocol:0):
#
#   rpcd        owns /dev/ttyS3 (TIOCEXCL, /run/vinx/rpcd.pid), frames the
#               wire (VX1/VXA), routes JSON-RPC between the page and the
#               Unix socket clients on /run/vinx/rpc.sock
#   rund        connects to rpcd and serves proc.run
#   rpc         the CLI (`rpc call METHOD JSON`), what js(1)/fetch(1) ride
#   libvinxrpc  vinx_call/vinx_notify for C and tcc, zero dependencies --
#               the .a and vinx_rpc.h ship on the target for tcc users
#
# SITE_METHOD = local rsyncs src/ ONCE, at extract -- after editing,
# `make vinx-rpc-dirclean` (linux/README.md's "rebuild one package" recipe)
# or the change stays behind.
#
################################################################################

VINX_RPC_VERSION = 0.1
VINX_RPC_SITE = $(BR2_EXTERNAL_VINX_PATH)/package/vinx-rpc/src
VINX_RPC_SITE_METHOD = local
VINX_RPC_LICENSE = MIT

define VINX_RPC_BUILD_CMDS
	cd $(@D) && \
	$(TARGET_CC) $(TARGET_CFLAGS) -c jsonlite.c wire.c mux.c librpc.c && \
	$(TARGET_AR) rcs libvinxrpc.a librpc.o jsonlite.o && \
	$(TARGET_CC) $(TARGET_CFLAGS) -o rpcd rpcd.c wire.o mux.o jsonlite.o $(TARGET_LDFLAGS) && \
	$(TARGET_CC) $(TARGET_CFLAGS) -o rund rund.c jsonlite.o libvinxrpc.a $(TARGET_LDFLAGS) && \
	$(TARGET_CC) $(TARGET_CFLAGS) -o rpc rpc.c libvinxrpc.a $(TARGET_LDFLAGS)
endef

define VINX_RPC_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 755 $(@D)/rpcd $(TARGET_DIR)/usr/sbin/rpcd
	$(INSTALL) -D -m 755 $(@D)/rund $(TARGET_DIR)/usr/sbin/rund
	$(INSTALL) -D -m 755 $(@D)/rpc $(TARGET_DIR)/usr/bin/rpc
endef

# The header and the archive go to staging: Buildroot's target finalize
# strips /usr/include and *.a from the target, and post-build.sh puts the
# development files back from staging for the on-target tcc (the same route
# every other library's headers take).
VINX_RPC_INSTALL_STAGING = YES
define VINX_RPC_INSTALL_STAGING_CMDS
	$(INSTALL) -D -m 644 $(@D)/libvinxrpc.a $(STAGING_DIR)/usr/lib/libvinxrpc.a
	$(INSTALL) -D -m 644 $(@D)/vinx_rpc.h $(STAGING_DIR)/usr/include/vinx_rpc.h
endef

$(eval $(generic-package))
