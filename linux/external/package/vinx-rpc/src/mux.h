/* mux -- the ttyS1 stream frame layer (docs/system-v2.zh-CN.md §6.9):
 *
 *   SB1 <channel> <byteLen>\n<byteLen raw bytes>
 *
 * Interactive byte streams (PTY windows), multiplexed: an ASCII header for
 * a human on the wire, then exactly byteLen raw bytes -- any bytes, no
 * terminator, no JSON, no base64 (§6.9: the control line carries messages,
 * this lane carries bytes). The reader trusts the declared length; a bad
 * header is counted and skipped, and scanning resumes at the next "SB1 ".
 * Mirrors web/app/stream-mux.ts's parser; the two must agree.
 *
 * PROTOTYPE FORMAT: §6.9 keeps the binary frame unfrozen until the PTY
 * surface and its throughput have been lived with. Change it freely --
 * both ends ship together -- but change both.
 */
#ifndef MUX_H
#define MUX_H

/* One frame's payload at most: small enough to interleave channels fairly
 * on a byte-at-a-time UART, large enough that headers stay noise. */
#define MUX_FRAME_MAX 2048

struct mux_frame {
	int channel;
	/* The payload, in the parser's buffer; valid until the next mux_next. */
	unsigned char *bytes;
	int len;
};

struct mux_parser {
	unsigned char buf[MUX_FRAME_MAX * 4 + 512];
	int len;
	int pending_drop;
	unsigned long noise_bytes;
	unsigned long bad_frames;
};

void mux_init(struct mux_parser *p);
void mux_feed(struct mux_parser *p, const unsigned char *bytes, int n);
/* 1 = a frame came out, 0 = need more bytes. Call until 0. */
int mux_next(struct mux_parser *p, struct mux_frame *out);
/* Buffered bytes (a partial frame, or nothing) -- the stall watchdog's
 * gauge, exactly like wire_pending/wire_kick on the control lane. */
int mux_pending(const struct mux_parser *p);
void mux_kick(struct mux_parser *p);

/* Frame builder; bytes written or -1 on overflow. */
int mux_frame_build(char *out, int cap, int channel, const unsigned char *bytes, int len);

#endif
