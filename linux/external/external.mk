# Pull in every package this external tree carries (package/*/*.mk) -- see
# package/tcc/tcc.mk, which doubles as the template for adding your own.
include $(sort $(wildcard $(BR2_EXTERNAL_VINX_PATH)/package/*/*.mk))

# Mainline sqlite builds the sqlite3 CLI with the whole engine compiled in
# (~1.4 MB) while also shipping libsqlite3.so for tcc to link against --
# the engine twice over. This flag links the CLI against the shared library
# instead; external.mk is included after the package .mk files, so the
# append lands before configure runs.
SQLITE_CONF_OPTS += --disable-static-shell
