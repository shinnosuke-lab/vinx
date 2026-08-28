/*
 * The vendored agnes core, swallowed whole.
 *
 * agnes_t is opaque in agnes.h and the amalgamation marks every internal
 * `static` -- so the only way to reach the PPU's screen buffer, the palette
 * table and the CPU bus without patching the vendored file is to compile
 * agnes.c inside this translation unit. Everything below is the small,
 * stable window the rest of the program looks through.
 */
#include "../vendor/agnes.c"

#include "nes.h"

const uint8_t *core_screen(const agnes_t *agnes) {
	return agnes->ppu.screen_buffer;
}

void core_palette_bgrx(uint32_t out[64]) {
	/* /dev/fb0 is XRGB little-endian: byte order B, G, R, X. */
	for (int i = 0; i < 64; i++) {
		agnes_color_t c = g_colors[i];
		out[i] = (uint32_t)c.b | ((uint32_t)c.g << 8) | ((uint32_t)c.r << 16);
	}
}

uint64_t core_cycles(const agnes_t *agnes) {
	return agnes->cpu.cycles;
}

uint8_t core_bus_read(agnes_t *agnes, uint16_t addr) {
	return cpu_read8(&agnes->cpu, addr);
}

void core_bus_write(agnes_t *agnes, uint16_t addr, uint8_t val) {
	cpu_write8(&agnes->cpu, addr, val);
}
