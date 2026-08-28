/* bluetoothd's logger drags in a linker-section registry of debug
 * descriptors (__start___debug/__stop___debug) that nothing in btmon
 * populates; btmon only ever calls the printf-like entry points, so
 * stderr passthrough is the whole job. */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>

#include "src/log.h"

static void logv(const char *format, va_list ap) {
	vfprintf(stderr, format, ap);
	fputc('\n', stderr);
}

#define BODY \
	{ \
		va_list ap; \
		va_start(ap, format); \
		logv(format, ap); \
		va_end(ap); \
	}

void info(const char *format, ...) BODY
void btd_log(uint16_t index, int priority, const char *format, ...) BODY
void btd_error(uint16_t index, const char *format, ...) BODY
void btd_warn(uint16_t index, const char *format, ...) BODY
void btd_info(uint16_t index, const char *format, ...) BODY

void btd_debug(uint16_t index, const char *format, ...) {
	(void)index;
	(void)format;
}

void __btd_log_init(const char *debug, int detach) {
	(void)debug;
	(void)detach;
}

void __btd_log_cleanup(void) {}

void __btd_toggle_debug(void) {}

void __btd_enable_debug(struct btd_debug_desc *start, struct btd_debug_desc *stop) {
	(void)start;
	(void)stop;
}
