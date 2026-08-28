/**
 * LVGL configuration for the vinx machine -- departures from the defaults
 * only. lv_conf_internal.h fills in everything not defined here with
 * LVGL's own defaults (all core widgets on, software rendering, 33 ms
 * refresh), which keeps this file short and survives version bumps
 * without re-diffing the 1400-line template.
 */

#ifndef LV_CONF_H
#define LV_CONF_H

/* The Bochs DRM framebuffer is XRGB8888; matching it means the fbdev
 * driver flushes without per-pixel conversion. */
#define LV_COLOR_DEPTH 32

/* The machine runs full Linux with 128 MB: the C library's malloc beats
 * a fixed built-in arena that a CJK font cache would have to fit. */
#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB

/* Montserrat 14 (the default) plus 16, the size the bundled GB2312
 * font comes in -- mixing Latin 16 with CJK 16 lines up. */
#define LV_FONT_MONTSERRAT_16 1

/* Runtime-loaded fonts with thousands of glyphs (lv_binfont_create on
 * /usr/share/fonts/cjk16.bin) need the wide glyph-table offsets, and
 * may come compressed. */
#define LV_FONT_FMT_TXT_LARGE 1
#define LV_USE_FONT_COMPRESSED 1

/* lv_binfont_create reads through LVGL's own fs layer; POSIX driver on
 * letter 'A', default, so "A:/usr/share/fonts/cjk16.bin" and a bare
 * "/usr/share/fonts/cjk16.bin" both open. */
#define LV_USE_FS_POSIX 1
#define LV_FS_POSIX_LETTER 'A'
#define LV_FS_DEFAULT_DRIVER_LETTER 'A'

/* The machine's display and inputs: /dev/fb0 (Bochs DRM's fbdev face,
 * the same surface fbdemo paints and the screen panel shows) and evdev
 * (the emulated PS/2 keyboard and mouse land there). */
#define LV_USE_LINUX_FBDEV 1
#define LV_USE_EVDEV 1

#endif /* LV_CONF_H */
