/* lvdemo -- the GUI link check, and a starting point for your own.
 *
 * Draws Chinese text and a click-counting button on the VGA screen
 * (/dev/fb0), moved by the page's pointer (PS/2 -> evdev). lvdemo(1)
 * compiles this in the machine itself:
 *
 *     tcc lvdemo.c -o lvdemo -llvgl
 *
 * The Chinese font ships in the image at /usr/share/fonts/cjk16.bin
 * (full GB2312 + ASCII, 16 px); should it be missing the demo speaks
 * Latin (LVGL's built-in Montserrat).
 */
#include <lvgl/lvgl.h>

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static uint32_t ms_now(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

/* The PS/2 mouse lands on whichever /dev/input/eventN psmouse registered;
 * sysfs says which one that is. */
static const char *mouse_event_path(void)
{
	static char path[32];
	for (int i = 0; i < 8; i++) {
		char sys[64], name[128];
		snprintf(sys, sizeof sys, "/sys/class/input/event%d/device/name", i);
		FILE *f = fopen(sys, "r");
		if (!f) continue;
		name[0] = 0;
		if (!fgets(name, sizeof name, f)) name[0] = 0;
		fclose(f);
		for (char *p = name; *p; p++) *p = (char)tolower((unsigned char)*p);
		if (strstr(name, "mouse")) {
			snprintf(path, sizeof path, "/dev/input/event%d", i);
			return path;
		}
	}
	return NULL;
}

static lv_obj_t *button_label;
static int clicks;

static void on_click(lv_event_t *e)
{
	(void)e;
	clicks++;
	lv_label_set_text_fmt(button_label, "clicks: %d", clicks);
	printf("lvdemo: click %d\n", clicks);
	fflush(stdout);
}

int main(void)
{
	lv_init();
	lv_tick_set_cb(ms_now);

	lv_display_t *disp = lv_linux_fbdev_create();
	if (!disp) {
		fprintf(stderr, "lvdemo: no display driver\n");
		return 1;
	}
	lv_linux_fbdev_set_file(disp, "/dev/fb0");

	lv_obj_t *scr = lv_screen_active();
	lv_obj_set_style_bg_color(scr, lv_color_hex(0x102a43), 0);

	const lv_font_t *cjk = NULL;
	if (access("/usr/share/fonts/cjk16.bin", R_OK) == 0)
		cjk = lv_binfont_create("A:/usr/share/fonts/cjk16.bin");

	lv_obj_t *title = lv_label_create(scr);
	if (cjk) {
		lv_obj_set_style_text_font(title, cjk, 0);
		lv_label_set_text(title, "你好，LVGL！中文字体已经加载。");
	} else {
		lv_label_set_text(title, "LVGL is up (no CJK font found).");
	}
	lv_obj_set_style_text_color(title, lv_color_hex(0xf0f4f8), 0);
	lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 24);

	lv_obj_t *btn = lv_button_create(scr);
	/* Generous size: the pointer is relative (PS/2), so a first-time
	 * cursor hunt should not have to be pixel-exact to hit it. */
	lv_obj_set_size(btn, 200, 90);
	lv_obj_align(btn, LV_ALIGN_CENTER, 0, 0);
	lv_obj_add_event_cb(btn, on_click, LV_EVENT_CLICKED, NULL);
	button_label = lv_label_create(btn);
	lv_label_set_text(button_label, "clicks: 0");
	lv_obj_center(button_label);

	const char *mouse = mouse_event_path();
	if (mouse) {
		lv_indev_t *ptr = lv_evdev_create(LV_INDEV_TYPE_POINTER, mouse);
		/* A small dot for a cursor: font-independent, always visible.
		 * Shifted by its radius -- LVGL pins the object's top-left to
		 * the pointer, and the dot should be centered on it. */
		lv_obj_t *cursor = lv_obj_create(lv_layer_sys());
		lv_obj_set_size(cursor, 8, 8);
		lv_obj_set_style_radius(cursor, LV_RADIUS_CIRCLE, 0);
		lv_obj_set_style_bg_color(cursor, lv_color_hex(0xffc857), 0);
		lv_obj_set_style_border_width(cursor, 0, 0);
		lv_obj_set_style_translate_x(cursor, -4, 0);
		lv_obj_set_style_translate_y(cursor, -4, 0);
		lv_indev_set_cursor(ptr, cursor);
		printf("lvdemo: pointer on %s\n", mouse);
	} else {
		printf("lvdemo: no mouse evdev found; screen only\n");
	}
	printf("lvdemo: ready\n");
	fflush(stdout);

	for (;;) {
		uint32_t wait = lv_timer_handler();
		if (wait > 500) wait = 33;
		usleep(wait * 1000);
	}
}
