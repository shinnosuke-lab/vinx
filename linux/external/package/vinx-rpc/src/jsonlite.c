#include "jsonlite.h"

#include <string.h>

int jl_ws(const char *s, int n, int i) {
	while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
	return i;
}

/* Past the closing quote of the string opening at i (s[i] == '"'), or -1. */
static int skip_string(const char *s, int n, int i) {
	i++; /* opening quote */
	while (i < n) {
		unsigned char c = (unsigned char)s[i];
		if (c == '"') return i + 1;
		if (c == '\\') {
			i += 2;
			continue;
		}
		i++;
	}
	return -1;
}

int jl_skip(const char *s, int n, int i) {
	int depth = 0;
	i = jl_ws(s, n, i);
	if (i >= n) return -1;
	for (;;) {
		char c;
		if (i >= n) return depth == 0 ? i : -1;
		c = s[i];
		if (c == '"') {
			i = skip_string(s, n, i);
			if (i < 0) return -1;
		} else if (c == '{' || c == '[') {
			if (++depth > 64) return -1;
			i++;
		} else if (c == '}' || c == ']') {
			if (depth == 0) return -1;
			depth--;
			i++;
		} else if (c == 't') {
			if (n - i < 4 || memcmp(s + i, "true", 4)) return -1;
			i += 4;
		} else if (c == 'f') {
			if (n - i < 5 || memcmp(s + i, "false", 5)) return -1;
			i += 5;
		} else if (c == 'n') {
			if (n - i < 4 || memcmp(s + i, "null", 4)) return -1;
			i += 4;
		} else if (c == '-' || (c >= '0' && c <= '9')) {
			i++;
			while (i < n && (s[i] == '.' || s[i] == '+' || s[i] == '-' || s[i] == 'e' ||
			                 s[i] == 'E' || (s[i] >= '0' && s[i] <= '9')))
				i++;
		} else if (depth > 0 && (c == ',' || c == ':' || c == ' ' || c == '\t' || c == '\n' || c == '\r')) {
			i++;
		} else {
			return -1;
		}
		if (depth == 0) return i;
	}
}

int jl_obj_get(const char *s, int n, const char *key, int *vs, int *ve) {
	int klen = (int)strlen(key);
	int i = jl_ws(s, n, 0);
	if (i >= n || s[i] != '{') return -1;
	i = jl_ws(s, n, i + 1);
	if (i < n && s[i] == '}') return 0;
	for (;;) {
		int ks, ke, end;
		if (i >= n || s[i] != '"') return -1;
		ks = i;
		ke = skip_string(s, n, i);
		if (ke < 0) return -1;
		i = jl_ws(s, n, ke);
		if (i >= n || s[i] != ':') return -1;
		i = jl_ws(s, n, i + 1);
		end = jl_skip(s, n, i);
		if (end < 0) return -1;
		/* A key with escapes cannot equal a plain-ASCII protocol key. */
		if (ke - ks - 2 == klen && !memchr(s + ks + 1, '\\', (size_t)klen) &&
		    !memcmp(s + ks + 1, key, (size_t)klen)) {
			*vs = i;
			*ve = end;
			return 1;
		}
		i = jl_ws(s, n, end);
		if (i < n && s[i] == ',') {
			i = jl_ws(s, n, i + 1);
			continue;
		}
		if (i < n && s[i] == '}') return 0;
		return -1;
	}
}

int jl_is_str(const char *s, int vs, int ve) {
	return ve > vs && s[vs] == '"';
}

static int put_utf8(unsigned long cp, char *out, int cap, int at) {
	if (cp < 0x80) {
		if (at + 1 > cap) return -1;
		out[at++] = (char)cp;
	} else if (cp < 0x800) {
		if (at + 2 > cap) return -1;
		out[at++] = (char)(0xc0 | (cp >> 6));
		out[at++] = (char)(0x80 | (cp & 0x3f));
	} else if (cp < 0x10000) {
		if (at + 3 > cap) return -1;
		out[at++] = (char)(0xe0 | (cp >> 12));
		out[at++] = (char)(0x80 | ((cp >> 6) & 0x3f));
		out[at++] = (char)(0x80 | (cp & 0x3f));
	} else {
		if (at + 4 > cap) return -1;
		out[at++] = (char)(0xf0 | (cp >> 18));
		out[at++] = (char)(0x80 | ((cp >> 12) & 0x3f));
		out[at++] = (char)(0x80 | ((cp >> 6) & 0x3f));
		out[at++] = (char)(0x80 | (cp & 0x3f));
	}
	return at;
}

static int hex4(const char *s) {
	int v = 0, k;
	for (k = 0; k < 4; k++) {
		char c = s[k];
		v <<= 4;
		if (c >= '0' && c <= '9') v |= c - '0';
		else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
		else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
		else return -1;
	}
	return v;
}

int jl_str_decode(const char *s, int vs, int ve, char *out, int cap) {
	int i = vs + 1, at = 0;
	if (!jl_is_str(s, vs, ve) || s[ve - 1] != '"') return -1;
	while (i < ve - 1) {
		unsigned char c = (unsigned char)s[i];
		if (c != '\\') {
			if (at + 1 > cap) return -1;
			out[at++] = (char)c;
			i++;
			continue;
		}
		if (i + 1 >= ve - 1) return -1;
		switch (s[i + 1]) {
		case '"': case '\\': case '/':
			if (at + 1 > cap) return -1;
			out[at++] = s[i + 1];
			i += 2;
			break;
		case 'b': if (at + 1 > cap) return -1; out[at++] = '\b'; i += 2; break;
		case 'f': if (at + 1 > cap) return -1; out[at++] = '\f'; i += 2; break;
		case 'n': if (at + 1 > cap) return -1; out[at++] = '\n'; i += 2; break;
		case 'r': if (at + 1 > cap) return -1; out[at++] = '\r'; i += 2; break;
		case 't': if (at + 1 > cap) return -1; out[at++] = '\t'; i += 2; break;
		case 'u': {
			unsigned long cp;
			int v;
			if (i + 6 > ve - 1) return -1;
			v = hex4(s + i + 2);
			if (v < 0) return -1;
			cp = (unsigned long)v;
			i += 6;
			if (cp >= 0xd800 && cp <= 0xdbff) {
				/* Surrogate pair: the low half must follow. */
				int lo;
				if (i + 6 > ve - 1 || s[i] != '\\' || s[i + 1] != 'u') return -1;
				lo = hex4(s + i + 2);
				if (lo < 0xdc00 || lo > 0xdfff) return -1;
				cp = 0x10000 + ((cp - 0xd800) << 10) + ((unsigned long)lo - 0xdc00);
				i += 6;
			} else if (cp >= 0xdc00 && cp <= 0xdfff) {
				return -1;
			}
			at = put_utf8(cp, out, cap, at);
			if (at < 0) return -1;
			break;
		}
		default:
			return -1;
		}
	}
	if (at < cap) out[at] = 0;
	return at;
}

long long jl_num(const char *s, int vs, int ve, long long fallback) {
	long long v = 0;
	int i = vs, neg = 0;
	if (i < ve && s[i] == '-') {
		neg = 1;
		i++;
	}
	if (i >= ve || s[i] < '0' || s[i] > '9') return fallback;
	for (; i < ve && s[i] >= '0' && s[i] <= '9'; i++) {
		if (v > (long long)1 << 55) return fallback; /* absurd for a protocol field */
		v = v * 10 + (s[i] - '0');
	}
	/* Trailing fraction/exponent: take the integer part, it is a deadline. */
	return neg ? -v : v;
}

static const char HEXD[] = "0123456789abcdef";

int jl_str_encode(const char *bytes, int len, char *out, int cap) {
	int i, at = 0;
	if (at + 1 > cap) return -1;
	out[at++] = '"';
	for (i = 0; i < len; i++) {
		unsigned char c = (unsigned char)bytes[i];
		if (c == '"' || c == '\\') {
			if (at + 2 > cap) return -1;
			out[at++] = '\\';
			out[at++] = (char)c;
		} else if (c == '\n') {
			if (at + 2 > cap) return -1;
			out[at++] = '\\';
			out[at++] = 'n';
		} else if (c == '\r') {
			if (at + 2 > cap) return -1;
			out[at++] = '\\';
			out[at++] = 'r';
		} else if (c == '\t') {
			if (at + 2 > cap) return -1;
			out[at++] = '\\';
			out[at++] = 't';
		} else if (c < 0x20) {
			if (at + 6 > cap) return -1;
			out[at++] = '\\';
			out[at++] = 'u';
			out[at++] = '0';
			out[at++] = '0';
			out[at++] = HEXD[c >> 4];
			out[at++] = HEXD[c & 15];
		} else {
			if (at + 1 > cap) return -1;
			out[at++] = (char)c;
		}
	}
	if (at + 1 > cap) return -1;
	out[at++] = '"';
	return at;
}

int jl_utf8_valid(const unsigned char *b, int len) {
	int i = 0;
	while (i < len) {
		unsigned char c = b[i];
		int follow, k;
		unsigned long cp;
		if (c < 0x80) {
			i++;
			continue;
		} else if ((c & 0xe0) == 0xc0) {
			follow = 1;
			cp = c & 0x1f;
			if (cp < 2) return 0; /* overlong */
		} else if ((c & 0xf0) == 0xe0) {
			follow = 2;
			cp = c & 0x0f;
		} else if ((c & 0xf8) == 0xf0) {
			follow = 3;
			cp = c & 0x07;
		} else {
			return 0;
		}
		if (i + follow >= len) return 0;
		for (k = 1; k <= follow; k++) {
			if ((b[i + k] & 0xc0) != 0x80) return 0;
			cp = (cp << 6) | (b[i + k] & 0x3f);
		}
		if (follow == 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) return 0;
		if (follow == 3 && (cp < 0x10000 || cp > 0x10ffff)) return 0;
		i += follow + 1;
	}
	return 1;
}

int jl_utf8_cut(const unsigned char *b, int len, int cap) {
	int end;
	if (len <= cap) return len;
	end = cap;
	/* Back off continuation bytes, then the lead byte they belong to. */
	while (end > 0 && (b[end] & 0xc0) == 0x80) end--;
	return end;
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int jl_b64_encode(const unsigned char *in, int len, char *out, int cap) {
	int i, at = 0;
	for (i = 0; i < len; i += 3) {
		unsigned long v = (unsigned long)in[i] << 16;
		int rest = len - i;
		if (rest > 1) v |= (unsigned long)in[i + 1] << 8;
		if (rest > 2) v |= in[i + 2];
		if (at + 4 > cap) return -1;
		out[at++] = B64[(v >> 18) & 63];
		out[at++] = B64[(v >> 12) & 63];
		out[at++] = rest > 1 ? B64[(v >> 6) & 63] : '=';
		out[at++] = rest > 2 ? B64[v & 63] : '=';
	}
	return at;
}
