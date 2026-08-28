#include <ctype.h>
#include <fnmatch.h>

#include "glib.h"

char *g_strdup(const char *s) { return s ? strdup(s) : NULL; }

char *g_strndup(const char *s, size_t n) {
	if (!s) return NULL;
	size_t len = strnlen(s, n);
	char *out = malloc(len + 1);
	if (!out) return NULL;
	memcpy(out, s, len);
	out[len] = 0;
	return out;
}

char *g_strstrip(char *s) {
	size_t len = strlen(s);
	while (len && isspace((unsigned char)s[len - 1])) s[--len] = 0;
	char *p = s;
	while (*p && isspace((unsigned char)*p)) p++;
	if (p != s) memmove(s, p, strlen(p) + 1);
	return s;
}

gboolean g_utf8_validate(const char *s, long max_len, const char **end) {
	const unsigned char *p = (const unsigned char *)s;
	long i = 0;
	while ((max_len < 0 && p[i]) || (max_len >= 0 && i < max_len)) {
		unsigned char c = p[i];
		int n;
		if (c < 0x80) n = 0;
		else if ((c & 0xe0) == 0xc0 && c >= 0xc2) n = 1;
		else if ((c & 0xf0) == 0xe0) n = 2;
		else if ((c & 0xf8) == 0xf0 && c <= 0xf4) n = 3;
		else break;
		long j;
		for (j = 1; j <= n; j++) {
			if (max_len >= 0 && i + j >= max_len) goto bad;
			if ((p[i + j] & 0xc0) != 0x80) goto bad;
		}
		i += n + 1;
	}
	if (max_len < 0 ? p[i] == 0 : i == max_len) {
		if (end) *end = s + i;
		return 1;
	}
bad:
	if (end) *end = s + i;
	return 0;
}

/* glib patterns are * and ? only; fnmatch adds [] which no caller uses. */
gboolean g_pattern_match_simple(const char *pattern, const char *string) {
	return fnmatch(pattern, string, 0) == 0;
}

char **g_strsplit_set(const char *string, const char *delims, int max_tokens) {
	if (max_tokens < 1) max_tokens = 0x7fffffff;
	size_t cap = 8, n = 0;
	char **out = malloc(cap * sizeof(char *));
	const char *p = string;
	while (n + 1 < (size_t)max_tokens) {
		size_t span = strcspn(p, delims);
		if (!p[span]) break;
		if (n + 2 > cap) out = realloc(out, (cap *= 2) * sizeof(char *));
		out[n++] = g_strndup(p, span);
		p += span + 1;
	}
	if (n + 2 > cap) out = realloc(out, (cap + 2) * sizeof(char *));
	out[n++] = strdup(p);
	out[n] = NULL;
	return out;
}

void g_strfreev(char **strv) {
	if (!strv) return;
	for (char **p = strv; *p; p++) free(*p);
	free(strv);
}
