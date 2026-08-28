################################################################################
#
# micropython-pylib -- the pure-Python complement to micropython's built-in
# modules: datetime, pathlib, argparse, logging, unittest, shutil, os.path
# and friends, installed under /usr/lib/micropython (which the unix port's
# default sys.path already searches).
#
# Buildroot mainline dropped its micropython-lib package, so this external
# tree carries its own -- under a different name and config symbol, because
# mainline micropython.mk still holds a dormant BR2_PACKAGE_MICROPYTHON_LIB
# block that would expect the dropped package's .built_pylib and fail
# micropython's target install if that symbol were reused. The upstream
# tarball keeps its original name, so the hash and download cache carry over.
#
# Only python-stdlib/ is installed: python-ecosys/ (requests etc.) assumes
# sockets that work like CPython's, and unix-ffi/ assumes libffi -- neither
# earns its bytes here. Each module's container directory is the packaging
# unit, not the import path, so the first path segment is stripped:
# datetime/datetime.py installs as datetime.py, os-path/os/path.py as
# os/path.py.
#
# json/ is excluded: filesystem modules shadow built-ins, and that package
# (a CPython port needing re.VERBOSE, which the built-in re lacks) would
# replace the perfectly good built-in json with one that dies on import.
# textwrap/ is excluded for the same class of reason: its module-level
# re.compile(..., re.MULTILINE) dies on the built-in re. contextlib needs
# ucontextlib, which lives in the collection's micropython/ tree rather
# than python-stdlib/, so that one file is installed explicitly.
#
################################################################################

MICROPYTHON_PYLIB_VERSION = 1.22.2
MICROPYTHON_PYLIB_SOURCE = micropython-lib-$(MICROPYTHON_PYLIB_VERSION).tar.gz
MICROPYTHON_PYLIB_SITE = $(call github,micropython,micropython-lib,v$(MICROPYTHON_PYLIB_VERSION))
MICROPYTHON_PYLIB_LICENSE = MIT, PSF-2.0
MICROPYTHON_PYLIB_LICENSE_FILES = LICENSE

define MICROPYTHON_PYLIB_INSTALL_TARGET_CMDS
	mkdir -p $(TARGET_DIR)/usr/lib/micropython
	cd $(@D)/python-stdlib && find . -name '*.py' \
		! -name 'manifest.py' ! -name 'test_*.py' \
		! -name 'example*.py' ! -path '*/examples/*' \
		! -path './json/*' ! -path './textwrap/*' | \
	while read f; do \
		$(INSTALL) -D -m 644 "$$f" \
			"$(TARGET_DIR)/usr/lib/micropython/$${f#./*/}" || exit 1; \
	done
	$(INSTALL) -D -m 644 $(@D)/micropython/ucontextlib/ucontextlib.py \
		$(TARGET_DIR)/usr/lib/micropython/ucontextlib.py
endef

$(eval $(generic-package))
