#include "wire.h"

#include <stdio.h>
#include <string.h>

void wire_init(struct wire_parser *p) {
	p->len = 0;
	p->pending_drop = 0;
	p->noise_bytes = 0;
	p->bad_frames = 0;
}

static void drop(struct wire_parser *p, int n) {
	if (n <= 0) return;
	if (n > p->len) n = p->len;
	memmove(p->buf, p->buf + n, (size_t)(p->len - n));
	p->len -= n;
}

void wire_feed(struct wire_parser *p, const unsigned char *bytes, int n) {
	while (n > 0) {
		int room = (int)sizeof(p->buf) - p->len;
		int take = n < room ? n : room;
		if (take == 0) {
			/* Full and unparseable: the front is noise by definition
			 * (wire_next would have consumed a frame that fit). */
			p->noise_bytes += 4096;
			drop(p, 4096);
			continue;
		}
		memcpy(p->buf + p->len, bytes, (size_t)take);
		p->len += take;
		bytes += take;
		n -= take;
	}
}

static int find_header(const struct wire_parser *p) {
	int i;
	for (i = 0; i + 4 <= p->len; i++) {
		if (p->buf[i] != 'V' || p->buf[i + 1] != 'X') continue;
		if ((p->buf[i + 2] == '1' || p->buf[i + 2] == 'A') && p->buf[i + 3] == ' ') return i;
	}
	return -1;
}

/* Parse decimal digits from i, ended by stop. 1 ok, 0 need-more, -1 bad. */
static int read_int(const struct wire_parser *p, int i, int max_digits, unsigned char stop,
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

int wire_next(struct wire_parser *p, struct wire_frame *out) {
	if (p->pending_drop) {
		drop(p, p->pending_drop);
		p->pending_drop = 0;
	}
	for (;;) {
		int at, i, is_data, r, end;
		unsigned long seq, blen;

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
		is_data = p->buf[2] == '1';

		/* Epoch: 16 lowercase hex, then a space. */
		if (p->len < 4 + WIRE_EPOCH_LEN + 2) return 0;
		for (i = 4; i < 4 + WIRE_EPOCH_LEN; i++) {
			unsigned char c = p->buf[i];
			if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) goto bad;
		}
		if (p->buf[4 + WIRE_EPOCH_LEN] != ' ') goto bad;

		r = read_int(p, 4 + WIRE_EPOCH_LEN + 1, 10, is_data ? ' ' : '\n', &seq, &end);
		if (r == 0) return 0;
		if (r < 0) goto bad;

		if (!is_data) {
			out->is_ack = 1;
			memcpy(out->epoch, p->buf + 4, WIRE_EPOCH_LEN);
			out->epoch[WIRE_EPOCH_LEN] = 0;
			out->seq = seq;
			out->json = NULL;
			out->json_len = 0;
			drop(p, end + 1);
			return 1;
		}

		r = read_int(p, end + 1, 8, ' ', &blen, &end);
		if (r == 0) return 0;
		if (r < 0) goto bad;
		if (blen > WIRE_HARD_LIMIT) goto bad;
		if (p->len < end + 1 + (int)blen + 1) return 0;
		if (p->buf[end + 1 + (int)blen] != '\n') goto bad;

		out->is_ack = 0;
		memcpy(out->epoch, p->buf + 4, WIRE_EPOCH_LEN);
		out->epoch[WIRE_EPOCH_LEN] = 0;
		out->seq = seq;
		/* NUL-terminate in place; the LF slot is ours to spend. */
		p->buf[end + 1 + (int)blen] = 0;
		out->json = (char *)p->buf + end + 1;
		out->json_len = (int)blen;
		/* The frame stays parked at the buffer head until the next call. */
		p->pending_drop = end + 1 + (int)blen + 1;
		return 1;

	bad:
		p->bad_frames++;
		p->noise_bytes += 4;
		drop(p, 4);
	}
}

int wire_pending(const struct wire_parser *p) {
	return p->len - p->pending_drop;
}

void wire_kick(struct wire_parser *p) {
	if (p->pending_drop) {
		drop(p, p->pending_drop);
		p->pending_drop = 0;
	}
	if (p->len < 4) return;
	p->bad_frames++;
	p->noise_bytes += 4;
	drop(p, 4);
}

int wire_data(char *out, int cap, const char *epoch, unsigned long seq, const char *json, int json_len) {
	int head = snprintf(out, (size_t)cap, "VX1 %s %lu %d ", epoch, seq, json_len);
	if (head < 0 || head + json_len + 1 > cap) return -1;
	memcpy(out + head, json, (size_t)json_len);
	out[head + json_len] = '\n';
	return head + json_len + 1;
}

int wire_ack(char *out, int cap, const char *epoch, unsigned long seq) {
	int n = snprintf(out, (size_t)cap, "VXA %s %lu\n", epoch, seq);
	return (n < 0 || n >= cap) ? -1 : n;
}
