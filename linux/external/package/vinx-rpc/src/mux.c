#include "mux.h"

#include <stdio.h>
#include <string.h>

void mux_init(struct mux_parser *p) {
	p->len = 0;
	p->pending_drop = 0;
	p->noise_bytes = 0;
	p->bad_frames = 0;
}

static void drop(struct mux_parser *p, int n) {
	if (n <= 0) return;
	if (n > p->len) n = p->len;
	memmove(p->buf, p->buf + n, (size_t)(p->len - n));
	p->len -= n;
}

void mux_feed(struct mux_parser *p, const unsigned char *bytes, int n) {
	while (n > 0) {
		int room = (int)sizeof(p->buf) - p->len;
		int take = n < room ? n : room;
		if (take == 0) {
			/* Full and unparseable: the front is noise by definition. */
			p->noise_bytes += 1024;
			drop(p, 1024);
			continue;
		}
		memcpy(p->buf + p->len, bytes, (size_t)take);
		p->len += take;
		bytes += take;
		n -= take;
	}
}

static int find_header(const struct mux_parser *p) {
	int i;
	for (i = 0; i + 4 <= p->len; i++) {
		if (p->buf[i] == 'S' && p->buf[i + 1] == 'B' && p->buf[i + 2] == '1' && p->buf[i + 3] == ' ')
			return i;
	}
	return -1;
}

/* Decimal digits from i, ended by stop. 1 ok, 0 need-more, -1 bad. */
static int read_int(const struct mux_parser *p, int i, int max_digits, unsigned char stop,
                    unsigned long *value, int *end) {
	unsigned long v = 0;
	int start = i;
	for (;; i++) {
		if (i >= p->len) return (i - start > max_digits) ? -1 : 0;
		if (p->buf[i] == stop) break;
		if (p->buf[i] < '0' || p->buf[i] > '9' || i - start >= max_digits) return -1;
		v = v * 10 + (unsigned long)(p->buf[i] - '0');
	}
	if (i == start) return -1;
	*value = v;
	*end = i;
	return 1;
}

int mux_next(struct mux_parser *p, struct mux_frame *out) {
	if (p->pending_drop) {
		drop(p, p->pending_drop);
		p->pending_drop = 0;
	}
	for (;;) {
		int at, r, end;
		unsigned long chan, blen;

		if (p->len < 4) return 0;
		at = find_header(p);
		if (at < 0) {
			int keep = p->len < 3 ? p->len : 3;
			p->noise_bytes += (unsigned long)(p->len - keep);
			drop(p, p->len - keep);
			return 0;
		}
		if (at > 0) {
			p->noise_bytes += (unsigned long)at;
			drop(p, at);
		}

		r = read_int(p, 4, 5, ' ', &chan, &end);
		if (r == 0) return 0;
		if (r < 0) goto bad;
		r = read_int(p, end + 1, 5, '\n', &blen, &end);
		if (r == 0) return 0;
		if (r < 0) goto bad;
		if (blen > MUX_FRAME_MAX) goto bad;
		if (p->len < end + 1 + (int)blen) return 0;

		out->channel = (int)chan;
		out->bytes = p->buf + end + 1;
		out->len = (int)blen;
		/* The payload stays parked at the head until the next call. */
		p->pending_drop = end + 1 + (int)blen;
		return 1;

	bad:
		p->bad_frames++;
		p->noise_bytes += 4;
		drop(p, 4);
	}
}

int mux_pending(const struct mux_parser *p) {
	return p->len - p->pending_drop;
}

void mux_kick(struct mux_parser *p) {
	if (p->pending_drop) {
		drop(p, p->pending_drop);
		p->pending_drop = 0;
	}
	if (p->len < 4) return;
	p->bad_frames++;
	p->noise_bytes += 4;
	drop(p, 4);
}

int mux_frame_build(char *out, int cap, int channel, const unsigned char *bytes, int len) {
	int head;
	if (len < 0 || len > MUX_FRAME_MAX) return -1;
	head = snprintf(out, (size_t)cap, "SB1 %d %d\n", channel, len);
	if (head < 0 || head + len > cap) return -1;
	memcpy(out + head, bytes, (size_t)len);
	return head + len;
}
