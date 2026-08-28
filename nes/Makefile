# The machine itself ships in the vinx image: linux/external/package/nes
# cross-compiles these sources at -O2 into /usr/bin/nes, so inside the VM
# there is nothing to build -- drop a ROM and run.
#
# This Makefile is only the off-target harness: `make host` builds a
# benchmark-grade binary (no framebuffer blit target, no Lua) with the
# system compiler, for --bench and --wav runs on the development host.

SRC = src/core.c src/main.c src/video.c src/input.c src/apu.c src/audio.c src/net.c

# -DNES_APU is spelled in the rule, not CFLAGS, so CFLAGS overrides can't
# accidentally build a silent machine.
.PHONY: host
host: $(SRC) src/nes.h vendor/agnes.c vendor/agnes.h
	cc -O2 -DNES_APU -o nes $(SRC)

.PHONY: clean
clean:
	rm -f nes
