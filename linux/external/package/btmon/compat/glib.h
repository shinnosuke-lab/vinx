/* The eight glib calls btmon actually makes, provided over libc so the
 * build does not pull in the real glib2 (which would cost megabytes in
 * the rootfs). Sits on the include path ahead of any system glib. */
#ifndef VINX_GLIB_SHIM_H
#define VINX_GLIB_SHIM_H

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

typedef int gboolean;
typedef char gchar;
typedef size_t gsize;
typedef long gssize;
typedef void *gpointer;

#ifndef TRUE
#define TRUE 1
#define FALSE 0
#endif
#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif
#ifndef MAX
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#endif

#define g_free free

char *g_strdup(const char *s);
char *g_strndup(const char *s, size_t n);
char *g_strstrip(char *s);
gboolean g_utf8_validate(const char *s, long max_len, const char **end);
gboolean g_pattern_match_simple(const char *pattern, const char *string);
char **g_strsplit_set(const char *string, const char *delimiters, int max_tokens);
void g_strfreev(char **strv);

#endif
