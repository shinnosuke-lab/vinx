/* jsonlite -- the sliver of JSON the control plane needs, and nothing more.
 *
 * rpcd is a router: it reads a few top-level fields (id, method, params.id,
 * meta.deadlineMs) and forwards bodies verbatim. rund builds results whose
 * only dynamic part is a process's output. Neither needs a DOM; both need
 * to never crash on wire garbage. So this is offset arithmetic over the
 * caller's buffer: find a field, hand back its [start,end) slice, decode a
 * string when asked. Nothing allocates.
 *
 * Values are slices of (s, n): jl_obj_get points vs/ve at the value bytes
 * (for a string, quotes included). Anything malformed is -1, never a read
 * past n. Nesting deeper than 64 is treated as malformed -- the wire's
 * frames are 4 KiB, nothing honest nests that far.
 */
#ifndef JSONLITE_H
#define JSONLITE_H

/* First index >= i that is not JSON whitespace. */
int jl_ws(const char *s, int n, int i);

/* Skip one complete value starting at i; the index just past it, or -1. */
int jl_skip(const char *s, int n, int i);

/* Top-level field of the object at s[0..n): 1 found (vs/ve set), 0 absent,
 * -1 when s is not a well-formed object. Keys with escapes never match --
 * every protocol key is plain ASCII. */
int jl_obj_get(const char *s, int n, const char *key, int *vs, int *ve);

/* True when the value slice is a string. */
int jl_is_str(const char *s, int vs, int ve);

/* Decode the string slice (quotes included) into UTF-8. The byte length,
 * or -1 on malformed escapes / overflow. NUL-terminates when it fits. */
int jl_str_decode(const char *s, int vs, int ve, char *out, int cap);

/* The number slice as a long long, or fallback when it is not a number. */
long long jl_num(const char *s, int vs, int ve, long long fallback);

/* Encode len raw bytes as a JSON string, quotes included. The caller
 * guarantees UTF-8 (see jl_utf8_valid). Bytes written, or -1 on overflow. */
int jl_str_encode(const char *bytes, int len, char *out, int cap);

/* 1 when bytes[0..len) is well-formed UTF-8 (what a JSON frame may carry). */
int jl_utf8_valid(const unsigned char *bytes, int len);

/* Longest prefix of a valid UTF-8 buffer that fits cap bytes without
 * cutting a sequence. */
int jl_utf8_cut(const unsigned char *bytes, int len, int cap);

/* Standard base64. Bytes written (no NUL), or -1 on overflow. */
int jl_b64_encode(const unsigned char *in, int len, char *out, int cap);

#endif
