/*
 * The screen: the Bochs DRM head, mode-set to the game's own picture.
 *
 * The first cut of this file wrote software-scaled pixels into fbcon's
 * 1024x768 fbdev -- about 2.2 MB a frame through write(2), the single
 * biggest cost on an emulated CPU (and the reason --scale existed). This
 * one speaks KMS directly: set the display mode to the visible NES picture
 * (256x224 -- the PPU's 256x240 minus the 8 overscan lines at each edge a
 * CRT never showed), render 1:1 into an mmap'd dumb buffer, and let the
 * page scale it up. ~229 KB a frame, no syscall per blit, no borders baked
 * into the picture, and the garbage games leave in the overscan rows is
 * cropped the way every television cropped it.
 *
 * Plain UAPI ioctls, no libdrm (nothing extra to link on musl; the structs
 * below are the slice of uapi/drm/drm_mode.h this file needs). Restore is
 * the kernel's own lastclose: when the fd closes -- video_close, a crash,
 * a kill -9 -- DRM puts fbcon back on its 1024x768 mode by itself.
 */
#include "nes.h"

#ifdef __linux__

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

/* ── the DRM UAPI slice (layouts per uapi/drm/drm_mode.h, i386 ABI) ── */

struct drm_mode_card_res {
	uint64_t fb_id_ptr, crtc_id_ptr, connector_id_ptr, encoder_id_ptr;
	uint32_t count_fbs, count_crtcs, count_connectors, count_encoders;
	uint32_t min_width, max_width, min_height, max_height;
};

struct drm_mode_modeinfo {
	uint32_t clock;
	uint16_t hdisplay, hsync_start, hsync_end, htotal, hskew;
	uint16_t vdisplay, vsync_start, vsync_end, vtotal, vscan;
	uint32_t vrefresh, flags, type;
	char name[32];
};

struct drm_mode_crtc {
	uint64_t set_connectors_ptr;
	uint32_t count_connectors, crtc_id, fb_id, x, y, gamma_size, mode_valid;
	struct drm_mode_modeinfo mode;
};

struct drm_mode_create_dumb {
	uint32_t height, width, bpp, flags, handle, pitch;
	uint64_t size;
};

struct drm_mode_map_dumb {
	uint32_t handle, pad;
	uint64_t offset;
};

struct drm_mode_fb_cmd {
	uint32_t fb_id, width, height, pitch, bpp, depth, handle;
};

#define DRM_IOWR(nr, type) \
	(unsigned)((3u << 30) | ((uint32_t)sizeof(type) << 16) | ('d' << 8) | (nr))
#define DRM_IOCTL_MODE_GETRESOURCES DRM_IOWR(0xA0, struct drm_mode_card_res)
#define DRM_IOCTL_MODE_SETCRTC DRM_IOWR(0xA2, struct drm_mode_crtc)
#define DRM_IOCTL_MODE_ADDFB DRM_IOWR(0xAE, struct drm_mode_fb_cmd)
#define DRM_IOCTL_MODE_CREATE_DUMB DRM_IOWR(0xB2, struct drm_mode_create_dumb)
#define DRM_IOCTL_MODE_MAP_DUMB DRM_IOWR(0xB3, struct drm_mode_map_dumb)

/* The visible picture: a TV's overscan hid the PPU's top and bottom rows,
 * and games treat them as scratch -- crop them like the TV did. */
#define OVERSCAN 8
#define OUT_W AGNES_SCREEN_WIDTH
#define OUT_H (AGNES_SCREEN_HEIGHT - 2 * OVERSCAN)

static int drm_fd = -1;
static uint8_t *pixels; /* the mmap'd dumb buffer -- VRAM, scanned out live */
static size_t pixels_len;
static uint32_t pitch;
static char describe_buf[64];

/* The last frame's indices, row by row: a row that did not change skips the
 * 4x palette expansion and the VRAM stores entirely. memcmp on 256 bytes is
 * a fraction of that work, so still frames (menus, dialogue, anything not
 * scrolling) blit almost for free; a full-screen scroll pays one extra
 * memcpy per row, the cheap end of the trade. Invalidated on video_open:
 * after a mode-set the dumb buffer is fresh and owes a full paint.
 *
 * Measured (paced play, static screen, same host): the auto skipper kept
 * ~18 blits/s before this and the -O3 build, ~53 blits/s after. */
static uint8_t prev_rows[OUT_H][AGNES_SCREEN_WIDTH];
static bool prev_valid;

static bool fail(const char *what) {
	fprintf(stderr, "nes: drm %s failed\n", what);
	if (drm_fd >= 0) close(drm_fd);
	drm_fd = -1;
	return false;
}

bool video_open(void) {
	drm_fd = open("/dev/dri/card0", O_RDWR);
	if (drm_fd < 0) {
		fprintf(stderr, "nes: cannot open /dev/dri/card0 -- no Bochs DRM in this kernel?\n");
		return false;
	}

	/* One head, one connector on this hardware; the two-call dance is the
	 * UAPI's, not ours. */
	struct drm_mode_card_res res;
	uint32_t crtcs[4] = {0}, conns[4] = {0};
	memset(&res, 0, sizeof(res));
	if (ioctl(drm_fd, DRM_IOCTL_MODE_GETRESOURCES, &res)) return fail("GETRESOURCES");
	if (res.count_crtcs > 4) res.count_crtcs = 4;
	if (res.count_connectors > 4) res.count_connectors = 4;
	res.crtc_id_ptr = (uint64_t)(uintptr_t)crtcs;
	res.connector_id_ptr = (uint64_t)(uintptr_t)conns;
	res.fb_id_ptr = res.encoder_id_ptr = 0;
	res.count_fbs = res.count_encoders = 0;
	if (ioctl(drm_fd, DRM_IOCTL_MODE_GETRESOURCES, &res) || !crtcs[0] || !conns[0]) {
		return fail("GETRESOURCES (ids)");
	}

	struct drm_mode_create_dumb dumb;
	memset(&dumb, 0, sizeof(dumb));
	dumb.width = OUT_W;
	dumb.height = OUT_H;
	dumb.bpp = 32;
	if (ioctl(drm_fd, DRM_IOCTL_MODE_CREATE_DUMB, &dumb)) return fail("CREATE_DUMB");
	pitch = dumb.pitch;
	pixels_len = (size_t)dumb.size;

	struct drm_mode_fb_cmd fb;
	memset(&fb, 0, sizeof(fb));
	fb.width = OUT_W;
	fb.height = OUT_H;
	fb.pitch = dumb.pitch;
	fb.bpp = 32;
	fb.depth = 24;
	fb.handle = dumb.handle;
	if (ioctl(drm_fd, DRM_IOCTL_MODE_ADDFB, &fb)) return fail("ADDFB");

	struct drm_mode_map_dumb map;
	memset(&map, 0, sizeof(map));
	map.handle = dumb.handle;
	if (ioctl(drm_fd, DRM_IOCTL_MODE_MAP_DUMB, &map)) return fail("MAP_DUMB");
	pixels = mmap(NULL, pixels_len, PROT_READ | PROT_WRITE, MAP_SHARED, drm_fd, (off_t)map.offset);
	if (pixels == MAP_FAILED) {
		pixels = NULL;
		return fail("mmap");
	}

	/* A custom mode: bochs has no real CRTC timings, only the size counts,
	 * but the fields still have to look like a monitor could sync to them. */
	struct drm_mode_crtc crtc;
	memset(&crtc, 0, sizeof(crtc));
	crtc.set_connectors_ptr = (uint64_t)(uintptr_t)&conns[0];
	crtc.count_connectors = 1;
	crtc.crtc_id = crtcs[0];
	crtc.fb_id = fb.fb_id;
	crtc.mode_valid = 1;
	crtc.mode.hdisplay = OUT_W;
	crtc.mode.hsync_start = OUT_W + 8;
	crtc.mode.hsync_end = OUT_W + 16;
	crtc.mode.htotal = OUT_W + 44;
	crtc.mode.vdisplay = OUT_H;
	crtc.mode.vsync_start = OUT_H + 4;
	crtc.mode.vsync_end = OUT_H + 8;
	crtc.mode.vtotal = OUT_H + 16;
	crtc.mode.clock = (uint32_t)(((OUT_W + 44) * (OUT_H + 16) * 60) / 1000);
	crtc.mode.vrefresh = 60;
	crtc.mode.type = 1u << 6; /* DRM_MODE_TYPE_DRIVER */
	snprintf(crtc.mode.name, sizeof(crtc.mode.name), "%dx%d", OUT_W, OUT_H);
	if (ioctl(drm_fd, DRM_IOCTL_MODE_SETCRTC, &crtc)) {
		munmap(pixels, pixels_len);
		pixels = NULL;
		return fail("SETCRTC");
	}

	snprintf(describe_buf, sizeof(describe_buf), "%dx%d native (the page scales it)", OUT_W,
	         OUT_H);
	prev_valid = false;
	return true;
}

void video_close(void) {
	if (pixels) munmap(pixels, pixels_len);
	pixels = NULL;
	if (drm_fd >= 0) close(drm_fd); /* lastclose: the kernel restores fbcon */
	drm_fd = -1;
}

void video_blit(const uint8_t *indices, const uint32_t palette[64]) {
	if (!pixels) return;
	for (int y = 0; y < OUT_H; y++) {
		const uint8_t *src = indices + (y + OVERSCAN) * AGNES_SCREEN_WIDTH;
		if (prev_valid && memcmp(prev_rows[y], src, AGNES_SCREEN_WIDTH) == 0) continue;
		memcpy(prev_rows[y], src, AGNES_SCREEN_WIDTH);
		uint32_t *dst = (uint32_t *)(pixels + (size_t)y * pitch);
		for (int x = 0; x < AGNES_SCREEN_WIDTH; x++) dst[x] = palette[src[x] & 0x3f];
	}
	prev_valid = true;
}

const char *video_describe(void) {
	return describe_buf;
}

#else /* !__linux__: a host build only benches the core, there is no screen */

#include <stdio.h>

bool video_open(void) {
	fprintf(stderr, "nes: no display on this platform (host build)\n");
	return false;
}
void video_close(void) {}
void video_blit(const uint8_t *indices, const uint32_t palette[64]) {
	(void)indices;
	(void)palette;
}
const char *video_describe(void) {
	return "none";
}

#endif
