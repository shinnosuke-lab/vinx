/* wire -- the ttyS3 frame layer (docs/system-v2.zh-CN.md §6.3):
 *
 *   VX1 <epoch:16hex> <seq> <byteLen> <json>\n     data
 *   VXA <epoch:16hex> <seq>\n                      ack
 *
 * The reader trusts the declared length, then requires the LF; a bad header
 * or a missing LF is counted and skipped, and scanning resumes at the next
 * "VX1 "/"VXA ". Mirrors web/app/rpc.ts's FrameParser; the two must agree.
 */
#ifndef WIRE_H
#define WIRE_H

#define WIRE_EPOCH_LEN 16
/* Non-negotiable receiver bound; maxFrame (4096) is what polite peers use. */
#define WIRE_HARD_LIMIT (64 * 1024)

struct wire_frame {
	int is_ack;
	char epoch[WIRE_EPOCH_LEN + 1];
	unsigned long seq;
	/* Data frames: the payload, NUL-terminated in the parser's buffer.
	 * Valid until the next wire_next() call. */
	char *json;
	int json_len;
};

struct wire_parser {
	unsigned char buf[WIRE_HARD_LIMIT + 512];
	int len;
	/* A delivered data frame stays parked at the head (out->json points into
	 * buf) until the next wire_next() consumes it through this. */
	int pending_drop;
	unsigned long noise_bytes;
	unsigned long bad_frames;
};

void wire_init(struct wire_parser *p);
/* Append received bytes (drops the oldest noise if the buffer would burst). */
void wire_feed(struct wire_parser *p, const unsigned char *bytes, int n);
/* 1 = a frame came out, 0 = need more bytes. Call until 0. */
int wire_next(struct wire_parser *p, struct wire_frame *out);
/* Bytes currently buffered (a partial frame, or nothing). The owner's event
 * loop watches this: a partial frame that stops growing is a liar about its
 * length (or its sender died mid-frame) and would swallow every later frame
 * into its payload — wire_kick() skips its header so scanning resumes. */
int wire_pending(const struct wire_parser *p);
void wire_kick(struct wire_parser *p);

/* Frame builders; bytes written or -1 on overflow. */
int wire_data(char *out, int cap, const char *epoch, unsigned long seq, const char *json, int json_len);
int wire_ack(char *out, int cap, const char *epoch, unsigned long seq);

#endif
