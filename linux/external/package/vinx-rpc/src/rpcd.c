/* rpcd -- the machine's end of the control plane (system-v2 §6).
 *
 * One process owns /dev/ttyS3, and this is it: opened O_NOCTTY, marked
 * TIOCEXCL, pid recorded in /run/vinx/rpcd.pid, fd CLOEXEC. Everything else
 * on this machine -- rund, rpc(1), any C client -- connects to the Unix
 * socket at /run/vinx/rpc.sock and speaks newline-delimited JSON-RPC bodies;
 * rpcd frames the tty side (VX1/VXA, wire.c) and routes by id.
 *
 * Routing is static in Phase 1 (§6.10): proc.* goes to whichever client
 * declared itself with an rpc.serve notification (that is rund); rpc.* is
 * answered here; everything else goes up the wire to the page, which said
 * in its hello what it serves. Replies may arrive out of order -- the
 * pending table maps ids back to their askers. Every end has exactly one
 * byte queue; concurrency is many pending ids, never interleaved writers.
 *
 * Sessions: the page opens one with rpc.hello at sequence 0, carrying a
 * fresh token; the frame epoch is its first 16 hex chars. A hello with a
 * new token cancels everything pending (locally-originated calls fail
 * UNAVAILABLE, rund gets rpc.cancel for page-originated work) and replies;
 * the same token replayed is answered idempotently from cache. Frames
 * wearing any other epoch are stale and die here.
 *
 * Flow control per §6.3, as measured in docs/protocol-baseline.zh-CN.md:
 * page->guest data frames are ACKed immediately (the page runs stop-and-
 * wait; a duplicate sequence gets its ACK again but is not dispatched
 * twice); guest->page is unacked, sequence numbers there are diagnostic.
 *
 * DCD is watched by polling TIOCMGET (the baseline doc's M4: the kernel's
 * own carrier plumbing is unverified under v86, so CLOCAL stays set and
 * the drop is handled here): carrier falling tears the session down early.
 * The authoritative reset is still the next hello. A tty read error or
 * hangup exits whole -- init respawns a clean owner (§6.6).
 *
 * Since Phase 6 rpcd also owns /dev/ttyS1, the stream lane (§6.9): raw
 * interactive byte streams (PTY windows), multiplexed by mux.c frames,
 * kept strictly apart from the control plane so a firehose of terminal
 * output never queues behind -- or in front of -- a control call. A local
 * client (rund) opens a stream with stream.open, passing the PTY master
 * over the socket with SCM_RIGHTS; rpcd pumps master<->ttyS1 and tells
 * the page over ttyS3 (stream.opened/closed/credit notifications).
 */
#define _GNU_SOURCE /* accept4 (musl gates it) */

#include "jsonlite.h"
#include "mux.h"
#include "wire.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdarg.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define TTY_PATH "/dev/ttyS3"
#define MUX_TTY_PATH "/dev/ttyS1"
#define SOCK_PATH "/run/vinx/rpc.sock"
#define PID_PATH "/run/vinx/rpcd.pid"
#define RUN_DIR "/run/vinx"

#define MAX_CLIENTS 16
#define MAX_PENDING 64
#define PER_CLIENT_PENDING 8
#define WIRE_PENDING 32
#define MAX_FRAME 4096
#define INLINE_MAX 1024
#define LOCAL_LINE_CAP (64 * 1024)
#define DEFAULT_DEADLINE_MS 30000
#define MAX_DEADLINE_MS 600000
#define ROUTE_GRACE_MS 5000

#define MAX_STREAMS 8
/* Page->guest per-channel window (the page starts with this much credit
 * and stops sending when it runs out; every byte written into the PTY is
 * granted back via a stream.credit notification). Sized well under the
 * §6.3 128 KiB serial cliff even with every channel busy at once. */
#define STREAM_WINDOW (8 * 1024)
/* Guest->page: stop draining PTY masters while this much is already
 * queued for ttyS1 -- the PTY buffer then fills and the app blocks,
 * which is the backpressure (§6.9). */
#define MUX_OUT_HIGH (64 * 1024)

/* Events (§6.7): a subscriber more than this many events behind gets one
 * folded rpc.gap instead of an unbounded queue. */
#define EV_BACKLOG_MAX 32
/* An emitted event's data at most (the whole notification must fit a
 * frame); an oversized emit is dropped and logged, never truncated. */
#define EV_DATA_MAX 2048

/* Third-party methods (§7.3): ext.<app-id>.<name> per registering client. */
#define EXT_PER_CLIENT 8
#define EXT_NAME_MAX 64

static const char IMPLEMENTATION[] = "vinx-rpcd/1.0";

/* protocol:1 is protocol:0's shape, frozen at the §16 gate; 0 stays
 * answerable for one version window (§16's compat rule). */
#define PROTO_MIN 0
#define PROTO_MAX 1

/* ── little growable byte queue, one per writable fd ── */

struct outq {
	char *p;
	int len, cap, off;
};

static int outq_push(struct outq *q, const char *bytes, int n) {
	if (q->len + n > q->cap) {
		int cap = q->cap ? q->cap : 8192;
		char *grown;
		while (cap < q->len + n) cap *= 2;
		if (cap > 8 * 1024 * 1024) return -1; /* a peer this far behind is gone */
		grown = realloc(q->p, (size_t)cap);
		if (!grown) return -1;
		q->p = grown;
		q->cap = cap;
	}
	memcpy(q->p + q->len, bytes, (size_t)n);
	q->len += n;
	return 0;
}

/* Flush what the fd will take. -1 on a dead fd. */
static int outq_flush(struct outq *q, int fd) {
	while (q->off < q->len) {
		ssize_t w = write(fd, q->p + q->off, (size_t)(q->len - q->off));
		if (w < 0) {
			if (errno == EINTR) continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
			return -1;
		}
		q->off += (int)w;
	}
	q->off = 0;
	q->len = 0;
	return 0;
}

/* ── state ── */

struct client {
	int fd; /* -1 = free slot */
	char in[LOCAL_LINE_CAP];
	int inlen;
	struct outq out;
	int is_rund;
	int pending;    /* calls this client originated, still in flight */
	int carried_fd; /* an SCM_RIGHTS fd riding with the current line, or -1 */
	/* Event subscription (§6.7): space-separated topic prefixes from
	 * rpc.watch; empty = not a subscriber. The queue bound is not bytes
	 * but events-behind: ev_backlog counts deliveries since this fd's
	 * outq last ran dry, and past EV_BACKLOG_MAX further events fold
	 * into one rpc.gap (ev_dropped) sent once the queue drains. */
	char watch[192];
	int ev_backlog;
	int ev_dropped;
	/* Third-party methods this connection registered with rpc.serve
	 * (§7.3): ext.<app-id>.<name>, first come first served, gone with
	 * the connection. An empty slot is ext[i][0] == 0. */
	char ext[EXT_PER_CLIENT][EXT_NAME_MAX];
};

/* One multiplexed byte stream: a PTY master pumped to/from ttyS1. */
struct stream {
	int used;
	int id; /* mux channel number, 1.. (0 is reserved) */
	int fd; /* the PTY master, ours to close */
	char app[48];
	int cols, rows;
	/* No managed app behind it (proc.pty's shell window): closing the
	 * window means stream.close, not app.stop — the page needs to know. */
	int unmanaged;
	int credit_owed; /* page->guest bytes consumed, not yet granted back */
	struct outq to_pty;
};

struct pend {
	int used;
	char id[80];
	int from; /* -1 = the page (wire), else client index */
	int to;   /* -1 = the page (wire), else client index */
	long long deadline_at;
};

static int tty_fd = -1;
static int mux_fd = -1;
static int listen_fd = -1;
static struct client clients[MAX_CLIENTS];
static struct pend pending[MAX_PENDING];
static struct stream streams[MAX_STREAMS];
static int next_stream_id = 1;
static struct outq tty_out;
static struct outq mux_out;
static struct wire_parser parser;
static struct mux_parser mparser;

static struct {
	int active;
	char token[36];
	char epoch[WIRE_EPOCH_LEN + 1];
	unsigned long tx_seq; /* last sequence sent */
	unsigned long rx_seq; /* last page sequence delivered */
	char hello_reply[1536];
	int hello_reply_len;
	char page_methods[640]; /* raw JSON array the page declared in hello */
	/* The page as an event subscriber (same ledger as struct client's). */
	char watch[192];
	int ev_backlog;
	int ev_dropped;
} S;

static unsigned long stat_stale, stat_dup;

static long long now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* stderr is /run/vinx/rpcd.log (main redirects it): a small trail that
 * answers "what did rpcd think happened" after protocol incidents. */
static void logline(const char *fmt, ...) {
	va_list ap;
	fprintf(stderr, "[%lld] ", now_ms());
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
	fflush(stderr);
}

/* ── send helpers ── */

static void wire_send_body(const char *json, int len) {
	char frame[MAX_FRAME + 128];
	int n;
	if (!S.active) return;
	n = wire_data(frame, (int)sizeof(frame), S.epoch, ++S.tx_seq, json, len);
	if (n > 0) outq_push(&tty_out, frame, n);
}

static void wire_send_ack(const char *epoch, unsigned long seq) {
	char frame[64];
	int n = wire_ack(frame, (int)sizeof(frame), epoch, seq);
	if (n > 0) outq_push(&tty_out, frame, n);
}

/* A notification body up the wire (printf-style; caller keeps it small). */
static void wire_notifyf(const char *fmt, ...) {
	char body[768];
	va_list ap;
	int n;
	if (!S.active) return;
	va_start(ap, fmt);
	n = vsnprintf(body, sizeof(body), fmt, ap);
	va_end(ap);
	if (n > 0 && n < (int)sizeof(body)) wire_send_body(body, n);
}

static void client_send_line(struct client *c, const char *json, int len) {
	if (c->fd < 0) return;
	if (outq_push(&c->out, json, len) < 0 || outq_push(&c->out, "\n", 1) < 0) {
		/* The queue burst its bound: this client stopped reading long ago. */
		shutdown(c->fd, SHUT_RDWR);
	}
}

/* Build an error response body; escapes go through jsonlite. */
static int build_error(char *out, int cap, const char *id, int code, const char *name,
                       const char *msg, const char *hint) {
	char m[600], h[600];
	int ml, hl, n;
	ml = jl_str_encode(msg, (int)strlen(msg), m, (int)sizeof(m));
	if (ml < 0) return -1;
	if (hint) {
		hl = jl_str_encode(hint, (int)strlen(hint), h, (int)sizeof(h));
		if (hl < 0) return -1;
		n = snprintf(out, (size_t)cap,
		             "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"error\":{\"code\":%d,\"name\":\"%s\",\"message\":%.*s,\"hint\":%.*s}}",
		             id, code, name, ml, m, hl, h);
	} else {
		n = snprintf(out, (size_t)cap,
		             "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"error\":{\"code\":%d,\"name\":\"%s\",\"message\":%.*s}}",
		             id, code, name, ml, m);
	}
	return (n < 0 || n >= cap) ? -1 : n;
}

static void error_to_wire(const char *id, int code, const char *name, const char *msg,
                          const char *hint) {
	char body[2048];
	int n = build_error(body, (int)sizeof(body), id, code, name, msg, hint);
	if (n > 0) wire_send_body(body, n);
}

static void error_to_client(struct client *c, const char *id, int code, const char *name,
                            const char *msg, const char *hint) {
	char body[2048];
	int n = build_error(body, (int)sizeof(body), id, code, name, msg, hint);
	if (n > 0) client_send_line(c, body, n);
}

static void error_to(int who, const char *id, int code, const char *name, const char *msg,
                     const char *hint) {
	if (who < 0) error_to_wire(id, code, name, msg, hint);
	else error_to_client(&clients[who], id, code, name, msg, hint);
}

static void cancel_notice_to(int who, const char *id) {
	char body[256];
	int n = snprintf(body, sizeof(body),
	                 "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.cancel\",\"params\":{\"id\":\"%s\"}}", id);
	if (n < 0 || n >= (int)sizeof(body)) return;
	if (who < 0) wire_send_body(body, n);
	else client_send_line(&clients[who], body, n);
}

/* ── pending table ── */

static struct pend *pend_find(const char *id) {
	int i;
	for (i = 0; i < MAX_PENDING; i++)
		if (pending[i].used && !strcmp(pending[i].id, id)) return &pending[i];
	return NULL;
}

static int pend_count(void) {
	int i, n = 0;
	for (i = 0; i < MAX_PENDING; i++) n += pending[i].used;
	return n;
}

static int wire_pend_count(void) {
	int i, n = 0;
	for (i = 0; i < MAX_PENDING; i++) n += pending[i].used && pending[i].from == -1;
	return n;
}

static struct pend *pend_add(const char *id, int from, int to, long long deadline_at) {
	int i;
	for (i = 0; i < MAX_PENDING; i++) {
		if (!pending[i].used) {
			pending[i].used = 1;
			snprintf(pending[i].id, sizeof(pending[i].id), "%s", id);
			pending[i].from = from;
			pending[i].to = to;
			pending[i].deadline_at = deadline_at;
			if (from >= 0) clients[from].pending++;
			return &pending[i];
		}
	}
	return NULL;
}

static void pend_del(struct pend *p) {
	if (p->from >= 0 && clients[p->from].pending > 0) clients[p->from].pending--;
	p->used = 0;
}

/* ── streams (the ttyS1 mux lane, §6.9) ── */

static struct stream *stream_find(int id) {
	int i;
	for (i = 0; i < MAX_STREAMS; i++)
		if (streams[i].used && streams[i].id == id) return &streams[i];
	return NULL;
}

/* Close a stream: the master fd goes (the app's slave side sees HUP and
 * the app exits on its own terms), the page hears stream.closed unless
 * the page itself is what went away. */
static void stream_drop(struct stream *s, const char *reason, int tell_page) {
	if (!s->used) return;
	logline("stream %d (%s) closed: %s", s->id, s->app, reason);
	close(s->fd);
	free(s->to_pty.p);
	memset(&s->to_pty, 0, sizeof(s->to_pty));
	s->used = 0;
	if (tell_page)
		wire_notifyf("{\"jsonrpc\":\"2.0\",\"method\":\"stream.closed\",\"params\":{\"id\":%d}}", s->id);
}

static void streams_drop_all(const char *reason, int tell_page) {
	int i;
	for (i = 0; i < MAX_STREAMS; i++)
		if (streams[i].used) stream_drop(&streams[i], reason, tell_page);
}

/* stream.open: a local client (rund) hands over a PTY master via
 * SCM_RIGHTS riding the same sendmsg as the request line. */
static void stream_open_local(int from, const char *id, const char *json, int len) {
	struct client *c = &clients[from];
	int fd = c->carried_fd;
	int vs, ve, ps, pe, i, slot = -1;
	struct stream *s;
	struct winsize ws;

	c->carried_fd = -1;
	if (fd < 0) {
		error_to_client(c, id, -32602, "INVALID_PARAMS",
		                "stream.open wants a PTY master fd riding the request (SCM_RIGHTS)", NULL);
		return;
	}
	if (!S.active) {
		/* A stream is a window; without a page there is nobody to open one. */
		close(fd);
		error_to_client(c, id, 1001, "UNAVAILABLE", "no page session to open a window on",
		                "the page opens a session (rpc.hello) when it attaches");
		return;
	}
	for (i = 0; i < MAX_STREAMS; i++)
		if (!streams[i].used) {
			slot = i;
			break;
		}
	if (slot < 0) {
		close(fd);
		error_to_client(c, id, 1006, "OVERLOADED", "every stream slot is taken",
		                "close a terminal window first; the cap is per machine");
		return;
	}

	s = &streams[slot];
	memset(s, 0, sizeof(*s));
	s->used = 1;
	s->id = next_stream_id++;
	s->fd = fd;
	s->cols = 80;
	s->rows = 24;
	snprintf(s->app, sizeof(s->app), "?");
	if (jl_obj_get(json, len, "params", &vs, &ve) == 1) {
		if (jl_obj_get(json + vs, ve - vs, "app", &ps, &pe) == 1)
			jl_str_decode(json + vs, ps, pe, s->app, sizeof(s->app));
		if (jl_obj_get(json + vs, ve - vs, "cols", &ps, &pe) == 1)
			s->cols = (int)jl_num(json + vs, ps, pe, 80);
		if (jl_obj_get(json + vs, ve - vs, "rows", &ps, &pe) == 1)
			s->rows = (int)jl_num(json + vs, ps, pe, 24);
		if (jl_obj_get(json + vs, ve - vs, "unmanaged", &ps, &pe) == 1 &&
		    pe - ps == 4 && !strncmp(json + vs + ps, "true", 4))
			s->unmanaged = 1;
	}
	if (s->cols < 2 || s->cols > 500) s->cols = 80;
	if (s->rows < 2 || s->rows > 200) s->rows = 24;

	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
	memset(&ws, 0, sizeof(ws));
	ws.ws_col = (unsigned short)s->cols;
	ws.ws_row = (unsigned short)s->rows;
	ioctl(fd, TIOCSWINSZ, &ws);

	{
		char body[192];
		int n = snprintf(body, sizeof(body),
		                 "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"id\":%d,\"window\":%d}}",
		                 id, s->id, STREAM_WINDOW);
		if (n > 0 && n < (int)sizeof(body)) client_send_line(c, body, n);
	}
	{
		char app_enc[112];
		int en = jl_str_encode(s->app, (int)strlen(s->app), app_enc, (int)sizeof(app_enc));
		if (en < 0) { en = 3; memcpy(app_enc, "\"?\"", 4); }
		app_enc[en] = 0;
		wire_notifyf("{\"jsonrpc\":\"2.0\",\"method\":\"stream.opened\","
		             "\"params\":{\"id\":%d,\"app\":%s,\"cols\":%d,\"rows\":%d,\"window\":%d,\"unmanaged\":%s}}",
		             s->id, app_enc, s->cols, s->rows, STREAM_WINDOW,
		             s->unmanaged ? "true" : "false");
	}
	logline("stream %d opened (%s, %dx%d)", s->id, s->app, s->cols, s->rows);
}

static void stream_close_req(int from, const char *id, const char *json, int len) {
	int vs, ve, ps, pe;
	struct stream *s = NULL;
	if (jl_obj_get(json, len, "params", &vs, &ve) == 1 &&
	    jl_obj_get(json + vs, ve - vs, "id", &ps, &pe) == 1)
		s = stream_find((int)jl_num(json + vs, ps, pe, -1));
	if (!s) {
		error_to(from, id, 1002, "NOT_FOUND", "no such stream", NULL);
		return;
	}
	stream_drop(s, "closed by request", 1);
	{
		char body[128];
		int n = snprintf(body, sizeof(body), "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"closed\":true}}", id);
		if (n > 0 && n < (int)sizeof(body)) {
			if (from < 0) wire_send_body(body, n);
			else client_send_line(&clients[from], body, n);
		}
	}
}

/* stream.resize rides as a notification from the page: win a race, lose a
 * race, the next Fit sends another one. TIOCSWINSZ delivers SIGWINCH. */
static void stream_resize_note(const char *json, int len) {
	int vs, ve, ps, pe;
	struct stream *s;
	struct winsize ws;
	if (jl_obj_get(json, len, "params", &vs, &ve) != 1) return;
	if (jl_obj_get(json + vs, ve - vs, "id", &ps, &pe) != 1) return;
	s = stream_find((int)jl_num(json + vs, ps, pe, -1));
	if (!s) return;
	if (jl_obj_get(json + vs, ve - vs, "cols", &ps, &pe) == 1)
		s->cols = (int)jl_num(json + vs, ps, pe, s->cols);
	if (jl_obj_get(json + vs, ve - vs, "rows", &ps, &pe) == 1)
		s->rows = (int)jl_num(json + vs, ps, pe, s->rows);
	if (s->cols < 2 || s->cols > 500) s->cols = 80;
	if (s->rows < 2 || s->rows > 200) s->rows = 24;
	memset(&ws, 0, sizeof(ws));
	ws.ws_col = (unsigned short)s->cols;
	ws.ws_row = (unsigned short)s->rows;
	ioctl(s->fd, TIOCSWINSZ, &ws);
}

/* Page bytes for a channel arrived over ttyS1. */
static void stream_bytes_in(int channel, const unsigned char *bytes, int n) {
	struct stream *s = stream_find(channel);
	if (!s) return; /* a dead window's last keystrokes; let them go */
	/* The page respects its window; a peer this far over it is broken. */
	if (s->to_pty.len - s->to_pty.off + n > STREAM_WINDOW * 2) {
		stream_drop(s, "the page overran its send window", 1);
		return;
	}
	if (outq_push(&s->to_pty, (const char *)bytes, n) < 0)
		stream_drop(s, "out of memory buffering input", 1);
}

/* Credit goes back once bytes actually land in the PTY. */
static void stream_flush_credits(void) {
	int i;
	for (i = 0; i < MAX_STREAMS; i++) {
		struct stream *s = &streams[i];
		if (!s->used || s->credit_owed <= 0) continue;
		wire_notifyf("{\"jsonrpc\":\"2.0\",\"method\":\"stream.credit\",\"params\":{\"id\":%d,\"bytes\":%d}}",
		             s->id, s->credit_owed);
		s->credit_owed = 0;
	}
}

/* Drain one PTY master into mux frames (bounded per call by MUX_OUT_HIGH). */
static void stream_pump_out(struct stream *s) {
	unsigned char buf[MUX_FRAME_MAX];
	char frame[MUX_FRAME_MAX + 32];
	while (mux_out.len - mux_out.off < MUX_OUT_HIGH) {
		ssize_t r = read(s->fd, buf, sizeof(buf));
		int fn;
		if (r < 0) {
			if (errno == EINTR) continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK) return;
			stream_drop(s, "the pty read failed", 1);
			return;
		}
		if (r == 0) {
			stream_drop(s, "the app hung up", 1);
			return;
		}
		fn = mux_frame_build(frame, (int)sizeof(frame), s->id, buf, (int)r);
		if (fn > 0) outq_push(&mux_out, frame, fn);
		if (r < (ssize_t)sizeof(buf)) return;
	}
}

/* ── events (§6.7: rpc.watch/rpc.emit, bounded queues, gap on overflow) ── */

/* `watch` is space-separated topic prefixes. A token matches a topic when
 * it equals it or names a dot-separated ancestor ("window" matches
 * "window.closed" but not "windowless"); a trailing dot is forgiven
 * ("app." means "app"); "*" matches everything. */
static int topic_matches(const char *watch, const char *topic) {
	const char *w = watch;
	size_t tlen = strlen(topic);
	while (*w) {
		const char *end = strchr(w, ' ');
		size_t wl = end ? (size_t)(end - w) : strlen(w);
		if (wl == 1 && w[0] == '*') return 1;
		while (wl > 0 && w[wl - 1] == '.') wl--;
		if (wl > 0 && wl <= tlen && !strncmp(w, topic, wl) && (tlen == wl || topic[wl] == '.'))
			return 1;
		if (!end) break;
		w = end + 1;
	}
	return 0;
}

/* One prebuilt rpc.event body to `who`, under its backlog bound. */
static void event_deliver(int who, const char *body, int n) {
	if (who < 0) {
		if (S.ev_backlog >= EV_BACKLOG_MAX) {
			S.ev_dropped++;
			return;
		}
		S.ev_backlog++;
		wire_send_body(body, n);
	} else {
		struct client *c = &clients[who];
		if (c->ev_backlog >= EV_BACKLOG_MAX) {
			c->ev_dropped++;
			return;
		}
		c->ev_backlog++;
		client_send_line(c, body, n);
	}
}

/* rpc.emit (a notification): fan the event out to every matching
 * subscriber, the emitter included if it listens to itself. */
static void route_emit(int from, const char *json, int len) {
	int vs, ve, ps, pe, n, i;
	char topic[64], tenc[136], body[MAX_FRAME];
	const char *data = "null";
	int dlen = 4;
	(void)from;
	if (jl_obj_get(json, len, "params", &vs, &ve) != 1) return;
	if (jl_obj_get(json + vs, ve - vs, "topic", &ps, &pe) != 1) return;
	if (jl_str_decode(json + vs, ps, pe, topic, sizeof(topic)) < 0) return;
	if (jl_obj_get(json + vs, ve - vs, "data", &ps, &pe) == 1) {
		if (pe - ps > EV_DATA_MAX) {
			logline("rpc.emit %s dropped: data is %d bytes (cap %d)", topic, pe - ps, EV_DATA_MAX);
			return;
		}
		data = json + vs + ps;
		dlen = pe - ps;
	}
	{
		int tn = jl_str_encode(topic, (int)strlen(topic), tenc, (int)sizeof(tenc));
		if (tn < 0) return;
		tenc[tn] = 0;
	}
	n = snprintf(body, sizeof(body),
	             "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.event\",\"params\":{\"topic\":%s,\"data\":%.*s}}",
	             tenc, dlen, data);
	if (n < 0 || n >= (int)sizeof(body)) return;
	if (S.active && S.watch[0] && topic_matches(S.watch, topic)) event_deliver(-1, body, n);
	for (i = 0; i < MAX_CLIENTS; i++)
		if (clients[i].fd >= 0 && clients[i].watch[0] && topic_matches(clients[i].watch, topic))
			event_deliver(i, body, n);
}

/* rpc.watch (a notification): replace the caller's subscription outright;
 * an empty topics array unsubscribes. */
static void route_watch(int from, const char *json, int len) {
	int vs, ve, ts, te;
	char *dst = from < 0 ? S.watch : clients[from].watch;
	size_t cap = from < 0 ? sizeof(S.watch) : sizeof(clients[from].watch);
	size_t at = 0;
	dst[0] = 0;
	if (jl_obj_get(json, len, "params", &vs, &ve) != 1) return;
	if (jl_obj_get(json + vs, ve - vs, "topics", &ts, &te) != 1) return;
	{
		const char *s = json + vs;
		int i = jl_ws(s, te, ts);
		if (i >= te || s[i] != '[') return;
		i = jl_ws(s, te, i + 1);
		while (i < te && s[i] != ']') {
			int end = jl_skip(s, te, i);
			char topic[64];
			if (end < 0) break;
			if (jl_is_str(s, i, end) && jl_str_decode(s, i, end, topic, sizeof(topic)) >= 0) {
				size_t tl = strlen(topic);
				if (tl > 0 && at + tl + 2 < cap) {
					if (at) dst[at++] = ' ';
					memcpy(dst + at, topic, tl);
					at += tl;
					dst[at] = 0;
				}
			}
			i = jl_ws(s, te, end);
			if (i < te && s[i] == ',') i = jl_ws(s, te, i + 1);
		}
	}
}

/* ── ext methods (§7.3: apps register ext.<app-id>.*, first come first
 * served, the registration dies with the connection) ── */

/* ext.<app-id>.<name>: the id obeys app(1)'s rules (lowercase, digits,
 * dashes, at most 32, not a reserved name), the rest is a non-empty
 * method path in the same alphabet plus dots and underscores. */
static int valid_ext_name(const char *m) {
	static const char *reserved[] = { "app", "enabled", "rpc", "rpcd", "rund", "vinx" };
	const char *id = m + 4;
	const char *dot, *p;
	size_t idlen, k;
	if (strncmp(m, "ext.", 4) || strlen(m) >= EXT_NAME_MAX) return 0;
	dot = strchr(id, '.');
	if (!dot || dot == id) return 0;
	idlen = (size_t)(dot - id);
	if (idlen > 32 || id[0] == '-') return 0;
	for (p = id; p < dot; p++)
		if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '-')) return 0;
	for (k = 0; k < sizeof(reserved) / sizeof(reserved[0]); k++)
		if (idlen == strlen(reserved[k]) && !strncmp(id, reserved[k], idlen)) return 0;
	if (!dot[1]) return 0;
	for (p = dot + 1; *p; p++)
		if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '-' || *p == '.' || *p == '_'))
			return 0;
	return 1;
}

/* The client index serving this ext method, or -1. */
static int ext_find(const char *method) {
	int i, k;
	for (i = 0; i < MAX_CLIENTS; i++) {
		if (clients[i].fd < 0) continue;
		for (k = 0; k < EXT_PER_CLIENT; k++)
			if (clients[i].ext[k][0] && !strcmp(clients[i].ext[k], method)) return i;
	}
	return -1;
}

static int ext_count(void) {
	int i, k, n = 0;
	for (i = 0; i < MAX_CLIENTS; i++) {
		if (clients[i].fd < 0) continue;
		for (k = 0; k < EXT_PER_CLIENT; k++) n += clients[i].ext[k][0] != 0;
	}
	return n;
}

/* The idx-th live ext method (client order, then slot order) or NULL.
 * The order is a snapshot per call; discover pages across calls may skew
 * when registrations churn, which discover's contract accepts. */
static const char *ext_at(int idx) {
	int i, k;
	for (i = 0; i < MAX_CLIENTS; i++) {
		if (clients[i].fd < 0) continue;
		for (k = 0; k < EXT_PER_CLIENT; k++) {
			if (!clients[i].ext[k][0]) continue;
			if (idx-- == 0) return clients[i].ext[k];
		}
	}
	return NULL;
}

/* rpc.serve (a notification): what this connection serves. proc.run makes
 * it rund (§6.10's static routing, unchanged); ext.* names join the
 * dynamic table (§7.3). Rejections are log lines, not replies -- the
 * registration is a notification, and a caller of an unregistered method
 * hears METHOD_NOT_FOUND, which is the operative truth either way. */
static void route_serve(int from, const char *json, int len) {
	int vs, ve, ts, te;
	const char *s;
	int i;
	if (from < 0) return; /* the page declares its methods in hello */
	if (jl_obj_get(json, len, "params", &vs, &ve) != 1) return;
	if (jl_obj_get(json + vs, ve - vs, "methods", &ts, &te) != 1) return;
	s = json + vs;
	i = jl_ws(s, te, ts);
	if (i >= te || s[i] != '[') return;
	i = jl_ws(s, te, i + 1);
	while (i < te && s[i] != ']') {
		int end = jl_skip(s, te, i);
		char name[EXT_NAME_MAX];
		if (end < 0) break;
		if (jl_is_str(s, i, end) && jl_str_decode(s, i, end, name, sizeof(name)) >= 0) {
			if (!strcmp(name, "proc.run")) {
				clients[from].is_rund = 1;
			} else if (!strncmp(name, "ext.", 4)) {
				if (!valid_ext_name(name)) {
					logline("client %d: ext method %.48s rejected (bad shape or reserved id)", from, name);
				} else if (ext_find(name) >= 0) {
					/* First come, first served: the second claimant is
					 * usually a restarted app racing its old connection;
					 * the call path stays unambiguous. */
					if (ext_find(name) != from)
						logline("client %d: ext method %.48s is already served; ignored", from, name);
				} else {
					int k, slot = -1;
					for (k = 0; k < EXT_PER_CLIENT; k++)
						if (!clients[from].ext[k][0]) {
							slot = k;
							break;
						}
					if (slot < 0) {
						logline("client %d: ext table is full (%d per connection)", from, EXT_PER_CLIENT);
					} else {
						snprintf(clients[from].ext[slot], EXT_NAME_MAX, "%s", name);
						logline("client %d: serves %s", from, name);
					}
				}
			}
			/* app.* and the rest stay statically routed; unknown names
			 * are ignored by design (§6.4). */
		}
		i = jl_ws(s, te, end);
		if (i < te && s[i] == ',') i = jl_ws(s, te, i + 1);
	}
}

/* Once a subscriber's queue runs dry, its ledger resets -- and if events
 * were folded while it lagged, one rpc.gap says how many. */
static void events_tick(void) {
	int i;
	char body[160];
	int n;
	if (S.active && tty_out.len == tty_out.off) {
		if (S.ev_dropped > 0) {
			n = snprintf(body, sizeof(body),
			             "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.event\",\"params\":{\"topic\":\"rpc.gap\",\"data\":{\"dropped\":%d}}}",
			             S.ev_dropped);
			S.ev_dropped = 0;
			S.ev_backlog = 1;
			if (n > 0 && n < (int)sizeof(body)) wire_send_body(body, n);
		} else {
			S.ev_backlog = 0;
		}
	}
	for (i = 0; i < MAX_CLIENTS; i++) {
		struct client *c = &clients[i];
		if (c->fd < 0 || c->out.len != c->out.off) continue;
		if (c->ev_dropped > 0) {
			n = snprintf(body, sizeof(body),
			             "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.event\",\"params\":{\"topic\":\"rpc.gap\",\"data\":{\"dropped\":%d}}}",
			             c->ev_dropped);
			c->ev_dropped = 0;
			c->ev_backlog = 1;
			if (n > 0 && n < (int)sizeof(body)) client_send_line(c, body, n);
		} else {
			c->ev_backlog = 0;
		}
	}
}

/* ── session ── */

static void cancel_all(const char *why) {
	int i;
	for (i = 0; i < MAX_PENDING; i++) {
		struct pend *p = &pending[i];
		if (!p->used) continue;
		if (p->to >= 0) cancel_notice_to(p->to, p->id);
		if (p->from >= 0)
			error_to_client(&clients[p->from], p->id, 1001, "UNAVAILABLE", why,
			                "the call may or may not have run; retry if it is idempotent");
		/* from == -1: the page reset itself; it is not listening for these. */
		pend_del(p);
	}
}

static void session_down(const char *why) {
	if (!S.active) return;
	logline("session %.8s… down: %s (pending %d)", S.token, why, pend_count());
	cancel_all(why);
	/* Streams are windows on the page that just left: close the masters
	 * (the apps see HUP) and tell nobody -- there is nobody to tell. */
	streams_drop_all(why, 0);
	S.active = 0;
	S.tx_seq = 0;
	S.rx_seq = 0;
}

/* ── discover ── */

/* The ext table lives with the event machinery below; discover reads it. */
static int ext_count(void);
static const char *ext_at(int idx);

struct method_row {
	const char *name;
	const char *owner;
	const char *summary;
};

static const struct method_row BUILTIN_METHODS[] = {
	{ "rpc.hello", "rpcd", "open a session (the page sends this at sequence 0)" },
	{ "rpc.discover", "rpcd", "page through every method this machine and its page serve" },
	{ "rpc.cancel", "rpcd", "notification: cancel a pending call by id" },
	{ "rpc.watch", "rpcd", "notification: subscribe this connection to event topics (rpc.event, rpc.gap)" },
	{ "rpc.emit", "rpcd", "notification: publish {topic, data} to every subscriber" },
	{ "proc.run", "rund", "run a shell command or a /data script; large output lands in /data" },
	{ "proc.pty", "rund", "a login shell on a PTY, shown as a terminal window on the page" },
	{ "app.list", "rund", "installed, enabled and managed apps with their states" },
	{ "app.start", "rund", "start an installed app as a supervised service (app-run)" },
	{ "app.stop", "rund", "stop a service: TERM the group, KILL after a grace" },
	{ "app.status", "rund", "one app's state, pid, restart count and enablement" },
	{ "stream.open", "rpcd", "attach a PTY master (SCM_RIGHTS, local clients only) as a window stream" },
	{ "stream.close", "rpcd", "tear down a terminal window stream by id" },
};
#define N_BUILTIN ((int)(sizeof(BUILTIN_METHODS) / sizeof(BUILTIN_METHODS[0])))

static const char *page_summary(const char *name) {
	if (!strcmp(name, "http.fetch")) return "fetch a URL through the hosting page (browser rules: CORS applies)";
	if (!strcmp(name, "debug.js")) return "run JavaScript on the hosting page (diagnostic channel)";
	if (!strcmp(name, "window.focus")) return "show or raise a desktop window by id (the VGA panel is 'screen')";
	if (!strcmp(name, "window.openUrl")) return "open a URL in a new browser tab (a blocked popup parks on a chip)";
	if (!strcmp(name, "notify.show")) return "a browser notification, or the page's corner toast";
	if (!strcmp(name, "speech.speak")) return "the browser speaks the text (speechSynthesis)";
	if (!strcmp(name, "media.camera.capture")) return "one webcam frame, PNG, into /data (the browser prompts)";
	if (!strncmp(name, "resource.", 9)) return "hand a staged /data/.vinx/tmp ref to the browser (open/download)";
	if (!strncmp(name, "ble.", 4)) return "Web Bluetooth, GATT-level; the picker parks on the ble chip";
	if (!strncmp(name, "network.bridge.", 15)) return "the WebRTC LAN bridge: rooms, roster, say";
	return "served by the hosting page";
}

/* The page methods array is kept verbatim from hello; walk it. Returns the
 * count, and when idx matches, decodes that entry into name/cap. */
static int page_method_at(int idx, char *name, int cap) {
	const char *s = S.page_methods;
	int n = (int)strlen(s);
	int i = jl_ws(s, n, 0);
	int count = 0;
	if (i >= n || s[i] != '[') return 0;
	i = jl_ws(s, n, i + 1);
	while (i < n && s[i] != ']') {
		int end = jl_skip(s, n, i);
		if (end < 0) return count;
		if (jl_is_str(s, i, end)) {
			if (count == idx && name) {
				if (jl_str_decode(s, i, end, name, cap) < 0) return count;
			}
			count++;
		}
		i = jl_ws(s, n, end);
		if (i < n && s[i] == ',') i = jl_ws(s, n, i + 1);
	}
	return count;
}

static void discover_reply(int who, const char *id, const char *params, int params_len) {
	char body[MAX_FRAME];
	char name[128], enc[280], ext_owner[40];
	int n_ext = ext_count();
	int total = N_BUILTIN + n_ext + page_method_at(-1, NULL, 0);
	long long cursor = 0, limit = 8;
	int vs, ve, at, i, emitted = 0;

	if (params && params_len > 0) {
		if (jl_obj_get(params, params_len, "cursor", &vs, &ve) == 1)
			cursor = jl_num(params, vs, ve, 0);
		if (jl_obj_get(params, params_len, "limit", &vs, &ve) == 1)
			limit = jl_num(params, vs, ve, 8);
	}
	if (cursor < 0) cursor = 0;
	if (limit < 1) limit = 1;
	if (limit > 16) limit = 16;

	at = snprintf(body, sizeof(body), "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"methods\":[", id);
	for (i = (int)cursor; i < total && emitted < (int)limit; i++, emitted++) {
		const char *nm, *owner, *summary;
		if (i < N_BUILTIN) {
			nm = BUILTIN_METHODS[i].name;
			owner = BUILTIN_METHODS[i].owner;
			summary = BUILTIN_METHODS[i].summary;
		} else if (i < N_BUILTIN + n_ext) {
			/* A registered third-party method (§7.3): owner is the app id
			 * between the dots of ext.<app-id>.<name>. */
			const char *m = ext_at(i - N_BUILTIN);
			const char *dot;
			if (!m) break;
			dot = strchr(m + 4, '.');
			snprintf(ext_owner, sizeof(ext_owner), "%.*s",
			         dot ? (int)(dot - (m + 4)) : 3, m + 4);
			nm = m;
			owner = ext_owner;
			summary = "registered by a running app (rpc serve); gone when it stops";
		} else {
			if (page_method_at(i - N_BUILTIN - n_ext, name, (int)sizeof(name)) <= i - N_BUILTIN - n_ext) break;
			nm = name;
			owner = "page";
			summary = page_summary(name);
		}
		{
			int en = jl_str_encode(nm, (int)strlen(nm), enc, (int)sizeof(enc));
			if (en < 0) continue;
			enc[en] = 0;
		}
		at += snprintf(body + at, sizeof(body) - (size_t)at,
		               "%s{\"name\":%s,\"owner\":\"%s\",\"summary\":\"%s\"}",
		               emitted ? "," : "", enc, owner, summary);
		if (at >= (int)sizeof(body) - 200) break;
	}
	if ((int)cursor + emitted < total) {
		at += snprintf(body + at, sizeof(body) - (size_t)at, "],\"nextCursor\":%d}}",
		               (int)cursor + emitted);
	} else {
		at += snprintf(body + at, sizeof(body) - (size_t)at, "]}}");
	}
	if (at >= (int)sizeof(body)) return;
	if (who < 0) wire_send_body(body, at);
	else client_send_line(&clients[who], body, at);
}

/* ── request routing (shared by wire and clients) ── */

static int find_rund(void) {
	int i;
	for (i = 0; i < MAX_CLIENTS; i++)
		if (clients[i].fd >= 0 && clients[i].is_rund) return i;
	return -1;
}

static long long deadline_from(const char *json, int len) {
	int vs, ve;
	long long d = DEFAULT_DEADLINE_MS;
	if (jl_obj_get(json, len, "meta", &vs, &ve) == 1) {
		int ms, me;
		if (jl_obj_get(json + vs, ve - vs, "deadlineMs", &ms, &me) == 1)
			d = jl_num(json + vs, ms, me, DEFAULT_DEADLINE_MS);
	}
	if (d < 1000) d = 1000;
	if (d > MAX_DEADLINE_MS) d = MAX_DEADLINE_MS;
	return now_ms() + d + ROUTE_GRACE_MS;
}

/* A request (id + method) arrived from `from` (-1 = wire). */
static void route_request(int from, const char *id, const char *method, const char *json, int len) {
	if (!strcmp(method, "rpc.discover")) {
		int vs, ve;
		const char *params = NULL;
		int plen = 0;
		if (jl_obj_get(json, len, "params", &vs, &ve) == 1) {
			params = json + vs;
			plen = ve - vs;
		}
		discover_reply(from, id, params, plen);
		return;
	}
	if (!strcmp(method, "rpc.hello")) {
		error_to(from, id, -32600, "INVALID_REQUEST", "hello rides sequence 0 on the wire, nowhere else", NULL);
		return;
	}
	if (!strncmp(method, "rpc.", 4)) {
		error_to(from, id, -32601, "METHOD_NOT_FOUND", "this rpcd serves rpc.hello, rpc.discover and rpc.cancel", NULL);
		return;
	}
	if (!strncmp(method, "stream.", 7)) {
		if (!strcmp(method, "stream.open")) {
			if (from < 0)
				error_to_wire(id, -32601, "METHOD_NOT_FOUND",
				              "stream.open is local-only: the fd rides the Unix socket", NULL);
			else stream_open_local(from, id, json, len);
		} else if (!strcmp(method, "stream.close")) {
			stream_close_req(from, id, json, len);
		} else {
			error_to(from, id, -32601, "METHOD_NOT_FOUND",
			         "streams answer stream.open and stream.close; resize rides as a notification", NULL);
		}
		return;
	}

	if (pend_find(id)) {
		error_to(from, id, -32600, "INVALID_REQUEST", "that id is already in flight", NULL);
		return;
	}
	if (pend_count() >= MAX_PENDING || (from >= 0 && clients[from].pending >= PER_CLIENT_PENDING) ||
	    (from < 0 && wire_pend_count() >= WIRE_PENDING)) {
		error_to(from, id, 1006, "OVERLOADED", "too many calls already pending",
		         "wait for one to finish; the caps are per client and per machine");
		return;
	}

	/* proc.* runs processes, app.* manages services — both are rund's
	 * (§6.10 static routing; §7.1 owners). */
	if (!strncmp(method, "proc.", 5) || !strncmp(method, "app.", 4)) {
		int rund = find_rund();
		if (rund < 0) {
			error_to(from, id, 1001, "UNAVAILABLE", "rund is not connected",
			         "init respawns rund; if this persists the machine is mid-boot or broken");
			return;
		}
		if (!pend_add(id, from, rund, deadline_from(json, len))) return;
		client_send_line(&clients[rund], json, len);
		return;
	}

	/* ext.<app-id>.*: served by whatever running app registered it over
	 * rpc.serve (§7.3); the registration died with any dead connection,
	 * so an unknown name here is the operative truth, not a race. */
	if (!strncmp(method, "ext.", 4)) {
		int owner = ext_find(method);
		if (owner < 0) {
			error_to(from, id, -32601, "METHOD_NOT_FOUND", "no running app serves this method",
			         "rpc discover lists what is live; is the app started?");
			return;
		}
		if (!pend_add(id, from, owner, deadline_from(json, len))) return;
		client_send_line(&clients[owner], json, len);
		return;
	}

	/* Everything else belongs to the page. */
	if (from < 0) {
		error_to_wire(id, -32601, "METHOD_NOT_FOUND",
		              "the machine serves proc.* and app.*; the page said in hello what it serves itself", NULL);
		return;
	}
	if (!S.active) {
		error_to_client(&clients[from], id, 1001, "UNAVAILABLE", "no page session",
		                "the page opens one (rpc.hello) when it attaches; is a page showing this machine?");
		return;
	}
	if (len + 64 > MAX_FRAME) {
		error_to_client(&clients[from], id, -32602, "INVALID_PARAMS", "params exceed maxFrame",
		                "large arguments ride a /data resource ref (system-v2 §6.8)");
		return;
	}
	if (!pend_add(id, from, -1, deadline_from(json, len))) return;
	wire_send_body(json, len);
}

/* An rpc.cancel notification from `from`, aimed at params.id. */
static void route_cancel(int from, const char *json, int len) {
	int vs, ve, ps, pe;
	char target[80];
	struct pend *p;
	if (jl_obj_get(json, len, "params", &vs, &ve) != 1) return;
	if (jl_obj_get(json + vs, ve - vs, "id", &ps, &pe) != 1) return;
	if (jl_str_decode(json + vs, ps, pe, target, sizeof(target)) < 0) return;
	p = pend_find(target);
	if (!p || p->from != from) return; /* only the asker may cancel */
	cancel_notice_to(p->to, target);
	/* The executor still owes its CANCELLED response; the entry stays. */
}

/* A response (id, result|error) arrived from `via` (-1 = wire). */
static void route_response(int via, const char *id, const char *json, int len) {
	struct pend *p = pend_find(id);
	if (!p || p->to != via) {
		stat_stale++;
		return;
	}
	if (p->from == -1) wire_send_body(json, len);
	else if (p->from >= 0) client_send_line(&clients[p->from], json, len);
	/* from == -2: the asker disconnected while this ran; the answer dies. */
	pend_del(p);
}

/* One JSON-RPC body, already unframed. */
static void dispatch(int from, const char *json, int len) {
	int vs, ve;
	char id[80];
	char method[128];
	int has_id = 0, has_method = 0;

	if (jl_obj_get(json, len, "id", &vs, &ve) == 1 && jl_is_str(json, vs, ve) &&
	    jl_str_decode(json, vs, ve, id, sizeof(id)) >= 0)
		has_id = 1;
	if (jl_obj_get(json, len, "method", &vs, &ve) == 1 && jl_is_str(json, vs, ve) &&
	    jl_str_decode(json, vs, ve, method, sizeof(method)) >= 0)
		has_method = 1;

	if (has_method && !has_id) {
		if (!strcmp(method, "rpc.cancel")) route_cancel(from, json, len);
		else if (!strcmp(method, "rpc.watch")) route_watch(from, json, len);
		else if (!strcmp(method, "rpc.emit")) route_emit(from, json, len);
		else if (from < 0 && !strcmp(method, "stream.resize")) stream_resize_note(json, len);
		else if (from >= 0 && !strcmp(method, "rpc.serve")) route_serve(from, json, len);
		return; /* unknown notifications are ignored by design (§6.4) */
	}
	if (has_method && has_id) {
		route_request(from, id, method, json, len);
		return;
	}
	if (has_id) {
		if (jl_obj_get(json, len, "result", &vs, &ve) == 1 ||
		    jl_obj_get(json, len, "error", &vs, &ve) == 1)
			route_response(from, id, json, len);
		return;
	}
	/* No id, no method: unaddressable noise. */
}

/* ── hello ── */

static void handle_hello(const struct wire_frame *f) {
	int vs, ve, ps, pe;
	char token[80];
	long long protocol = -1;

	if (jl_obj_get(f->json, f->json_len, "params", &vs, &ve) != 1) return;
	if (jl_obj_get(f->json + vs, ve - vs, "protocol", &ps, &pe) == 1)
		protocol = jl_num(f->json + vs, ps, pe, -1);
	{
		int tlen;
		if (jl_obj_get(f->json + vs, ve - vs, "sessionToken", &ps, &pe) != 1) return;
		tlen = jl_str_decode(f->json + vs, ps, pe, token, sizeof(token));
		if (tlen < WIRE_EPOCH_LEN || tlen >= (int)sizeof(S.token))
			return; /* not addressable as a session */
	}
	{
		/* The token's head becomes the wire epoch; it must parse as one. */
		int k;
		for (k = 0; k < WIRE_EPOCH_LEN; k++) {
			char c = token[k];
			if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return;
		}
	}

	if (protocol < PROTO_MIN || protocol > PROTO_MAX) {
		/* Answer on the hello's own epoch so the page hears the refusal. */
		char body[512];
		int n = build_error(body, (int)sizeof(body), "p.0", -32600, "INVALID_REQUEST",
		                    "this rpcd speaks protocols 0 and 1", NULL);
		char frame[1024];
		int fn;
		wire_send_ack(f->epoch, f->seq);
		fn = wire_data(frame, (int)sizeof(frame), f->epoch, 1, body, n);
		if (fn > 0) outq_push(&tty_out, frame, fn);
		return;
	}

	if (S.active && !strcmp(token, S.token)) {
		/* The same hello again: the ACK or the reply got lost. Replay. */
		logline("hello replayed (token %.8s…), answering idempotently", token);
		wire_send_ack(f->epoch, 0);
		wire_send_body(S.hello_reply, S.hello_reply_len);
		return;
	}

	logline("hello: new session %.8s… (was %s%.8s…)", token, S.active ? "" : "inactive ",
	        S.token);
	session_down("a new session replaced this one");

	snprintf(S.token, sizeof(S.token), "%s", token);
	memcpy(S.epoch, token, WIRE_EPOCH_LEN);
	S.epoch[WIRE_EPOCH_LEN] = 0;
	S.active = 1;
	S.tx_seq = 0;
	S.rx_seq = 0;
	/* Subscriptions are session state: the new page says its own watch. */
	S.watch[0] = 0;
	S.ev_backlog = 0;
	S.ev_dropped = 0;

	snprintf(S.page_methods, sizeof(S.page_methods), "[]");
	if (jl_obj_get(f->json + vs, ve - vs, "methods", &ps, &pe) == 1 && pe - ps < (int)sizeof(S.page_methods)) {
		memcpy(S.page_methods, f->json + vs + ps, (size_t)(pe - ps));
		S.page_methods[pe - ps] = 0;
	}

	/* The reply echoes the caller's protocol: both shapes are the same
	 * frozen wire, the number says which contract the session speaks. */
	S.hello_reply_len = snprintf(
	    S.hello_reply, sizeof(S.hello_reply),
	    "{\"jsonrpc\":\"2.0\",\"id\":\"p.0\",\"result\":{"
	    "\"protocol\":%d,\"implementation\":\"%s\",\"maxFrame\":%d,\"inlineMax\":%d,"
	    "\"flow\":{\"pageToGuest\":\"stop-wait\",\"guestToPage\":\"unacked\"},"
	    "\"features\":[\"duplex\",\"cancel\",\"data-ref\",\"streams\",\"events\"],"
	    "\"methods\":[\"rpc.hello\",\"rpc.discover\",\"rpc.cancel\",\"proc.run\",\"proc.pty\","
	    "\"app.list\",\"app.start\",\"app.stop\",\"app.status\"]}}",
	    (int)protocol, IMPLEMENTATION, MAX_FRAME, INLINE_MAX);

	wire_send_ack(S.epoch, 0);
	wire_send_body(S.hello_reply, S.hello_reply_len);
}

static void handle_frame(const struct wire_frame *f) {
	if (f->is_ack) return; /* the page never acks us; stray */
	if (f->seq == 0) {
		int vs, ve;
		char method[64];
		if (jl_obj_get(f->json, f->json_len, "method", &vs, &ve) == 1 &&
		    jl_str_decode(f->json, vs, ve, method, sizeof(method)) >= 0 &&
		    !strcmp(method, "rpc.hello")) {
			handle_hello(f);
			return;
		}
	}
	if (!S.active || strcmp(f->epoch, S.epoch)) {
		stat_stale++;
		logline("stale frame dropped (epoch %.8s, seq %lu, stale total %lu)", f->epoch, f->seq,
		        stat_stale);
		return; /* stale sessions get silence, not acks (§6.6) */
	}
	if (f->seq <= S.rx_seq) {
		stat_dup++;
		wire_send_ack(S.epoch, f->seq); /* its ACK was lost; not dispatched again */
		return;
	}
	S.rx_seq = f->seq;
	wire_send_ack(S.epoch, f->seq);
	dispatch(-1, f->json, f->json_len);
}

/* ── clients ── */

static void drop_client(int ci, const char *why) {
	struct client *c = &clients[ci];
	int i;
	if (c->fd < 0) return;
	close(c->fd);
	c->fd = -1;
	if (c->carried_fd >= 0) close(c->carried_fd);
	c->carried_fd = -1;
	free(c->out.p);
	memset(&c->out, 0, sizeof(c->out));
	c->inlen = 0;

	for (i = 0; i < MAX_PENDING; i++) {
		struct pend *p = &pending[i];
		if (!p->used) continue;
		if (p->from == ci) {
			/* The asker is gone: tell the executor to stop working. */
			cancel_notice_to(p->to, p->id);
			p->from = -2; /* nowhere to send the eventual response */
			c->pending = 0;
		} else if (p->to == ci) {
			/* The executor is gone: the asker must not wait out a deadline. */
			if (p->from == -1)
				error_to_wire(p->id, 1001, "UNAVAILABLE", why,
				              "the serving process dropped; init respawns it");
			else if (p->from >= 0)
				error_to_client(&clients[p->from], p->id, 1001, "UNAVAILABLE", why,
				                "the serving process dropped; init respawns it");
			pend_del(p);
		}
	}
	c->is_rund = 0;
	c->pending = 0;
	/* §7.3-4: an app's registrations vanish with its connection. */
	memset(c->ext, 0, sizeof(c->ext));
	c->watch[0] = 0;
}

static void handle_client_bytes(int ci) {
	struct client *c = &clients[ci];
	for (;;) {
		ssize_t r;
		char *nl;
		struct iovec iov;
		struct msghdr msg;
		char cbuf[CMSG_SPACE(sizeof(int) * 4)];
		struct cmsghdr *cm;
		if (c->inlen >= (int)sizeof(c->in)) {
			/* A line that cannot fit is a protocol break, not slow input
			 * (and read(fd, buf, 0) would masquerade as EOF). */
			drop_client(ci, "it sent an over-long line");
			return;
		}
		/* recvmsg, not read: stream.open rides its PTY master fd here
		 * as SCM_RIGHTS ancillary data on the same sendmsg as the line. */
		memset(&msg, 0, sizeof(msg));
		iov.iov_base = c->in + c->inlen;
		iov.iov_len = sizeof(c->in) - (size_t)c->inlen;
		msg.msg_iov = &iov;
		msg.msg_iovlen = 1;
		msg.msg_control = cbuf;
		msg.msg_controllen = sizeof(cbuf);
		r = recvmsg(c->fd, &msg, MSG_CMSG_CLOEXEC);
		if (r < 0) {
			if (errno == EINTR) continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK) break;
			drop_client(ci, "its socket failed");
			return;
		}
		if (r == 0) {
			drop_client(ci, "its client disconnected");
			return;
		}
		for (cm = CMSG_FIRSTHDR(&msg); cm; cm = CMSG_NXTHDR(&msg, cm)) {
			if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) {
				int nfds = (int)((cm->cmsg_len - CMSG_LEN(0)) / sizeof(int));
				int k, got;
				for (k = 0; k < nfds; k++) {
					memcpy(&got, (char *)CMSG_DATA(cm) + k * sizeof(int), sizeof(int));
					/* One fd per request is the contract; extras leak nothing. */
					if (c->carried_fd < 0) c->carried_fd = got;
					else close(got);
				}
			}
		}
		c->inlen += (int)r;
		while ((nl = memchr(c->in, '\n', (size_t)c->inlen))) {
			int llen = (int)(nl - c->in);
			if (llen > 0) dispatch(ci, c->in, llen);
			if (c->fd < 0) return; /* dispatch may have shut this client down */
			if (c->carried_fd >= 0) {
				/* The line that carried it did not claim it (not a
				 * stream.open): it must not haunt the next line. */
				close(c->carried_fd);
				c->carried_fd = -1;
			}
			memmove(c->in, nl + 1, (size_t)(c->inlen - llen - 1));
			c->inlen -= llen + 1;
		}
	}
}

/* ── pending sweep and carrier watch ── */

static void sweep(void) {
	long long t = now_ms();
	int i;
	for (i = 0; i < MAX_PENDING; i++) {
		struct pend *p = &pending[i];
		if (!p->used || p->deadline_at > t) continue;
		cancel_notice_to(p->to, p->id);
		if (p->from == -1)
			error_to_wire(p->id, 1003, "DEADLINE_EXCEEDED", "no response within the deadline", NULL);
		else if (p->from >= 0)
			error_to_client(&clients[p->from], p->id, 1003, "DEADLINE_EXCEEDED",
			                "no response within the deadline", NULL);
		pend_del(p);
	}
}

static void check_carrier(void) {
	static int had_carrier = -1;
	int m = 0;
	if (ioctl(tty_fd, TIOCMGET, &m) < 0) return;
	if (had_carrier == 1 && !(m & TIOCM_CD) && S.active)
		session_down("the page dropped carrier (DCD)");
	had_carrier = (m & TIOCM_CD) ? 1 : 0;
}

/* A partial frame that stops growing lied about its length (noise shaped
 * like a header) or lost its sender mid-frame. Left alone it would swallow
 * every later frame — the page's hello retries included — into its declared
 * payload. Two quiet seconds is proof: real frames finish in milliseconds.
 *
 * A stall is a link-level incident, not a bad frame: whatever was swallowed
 * is beyond reconstruction, and the page has long since started counting
 * its own retransmits toward UNAVAILABLE. So the session goes down *with*
 * the kick — a revived half-session that keeps serving swallowed retransmits
 * while the page is already re-helloing would strand every local caller
 * whose pending id dies in that reset (the first noise E2E found exactly
 * that). The stragglers the rescan turns up wear the dead session's epoch
 * and drop as stale; the page's next hello starts clean. */
static void check_stall(void) {
	static int last_pending;
	static long long stuck_since;
	int pending = wire_pending(&parser);
	long long t = now_ms();
	if (pending >= 4 && pending == last_pending) {
		if (!stuck_since) {
			stuck_since = t;
		} else if (t - stuck_since > 2000) {
			struct wire_frame f;
			logline("parser stalled on a partial frame (%d bytes); kicking", pending);
			session_down("the wire lost framing sync");
			wire_kick(&parser);
			while (wire_next(&parser, &f)) handle_frame(&f);
			stuck_since = 0;
			last_pending = wire_pending(&parser);
			return;
		}
	} else {
		stuck_since = 0;
	}
	last_pending = pending;
}

/* The mux lane gets the same watchdog, but a byte-lane stall is local to
 * itself: no session teardown, just kick the parser loose. Payloads are
 * raw bytes, so a swallowed stretch is dropped terminal output, not a
 * broken control call. */
static void check_mux_stall(void) {
	static int last_pending;
	static long long stuck_since;
	int pending = mux_pending(&mparser);
	long long t = now_ms();
	if (pending >= 4 && pending == last_pending) {
		if (!stuck_since) {
			stuck_since = t;
		} else if (t - stuck_since > 2000) {
			struct mux_frame f;
			logline("mux parser stalled on a partial frame (%d bytes); kicking", pending);
			mux_kick(&mparser);
			while (mux_next(&mparser, &f)) stream_bytes_in(f.channel, f.bytes, f.len);
			stuck_since = 0;
			last_pending = mux_pending(&mparser);
			return;
		}
	} else {
		stuck_since = 0;
	}
	last_pending = pending;
}

/* ── setup ── */

static void die_tty(const char *why) {
	/* The wire is gone; local askers must not wait out their deadlines. */
	int i;
	for (i = 0; i < MAX_PENDING; i++) {
		struct pend *p = &pending[i];
		if (!p->used) continue;
		if (p->to >= 0) cancel_notice_to(p->to, p->id);
		if (p->from >= 0)
			error_to_client(&clients[p->from], p->id, 1001, "UNAVAILABLE", why,
			                "rpcd lost the tty and exits; init restarts it");
		pend_del(p);
	}
	for (i = 0; i < MAX_CLIENTS; i++)
		if (clients[i].fd >= 0) outq_flush(&clients[i].out, clients[i].fd);
	unlink(PID_PATH);
	/* Exit whole rather than re-opening in place: a fresh open by a fresh
	 * process is the recovery path that always works (§6.6). */
	exit(0);
}

static int open_tty(const char *path) {
	int fd;
	struct termios t;
	for (;;) {
		fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
		if (fd >= 0) break;
		sleep(1); /* the port exists once the kernel settles; never storm init */
	}
	if (ioctl(fd, TIOCEXCL) < 0) { /* best effort; root can still open, but honest tools check the pid file */ }
	if (tcgetattr(fd, &t) == 0) {
		cfmakeraw(&t);
		/* CLOCAL stays set: M4 measured that this kernel's carrier plumbing
		 * is unproven under v86, so the DCD watch lives in check_carrier()
		 * where its behaviour is ours. */
		t.c_cflag |= CLOCAL | CREAD;
		t.c_cc[VMIN] = 0;
		t.c_cc[VTIME] = 0;
		tcsetattr(fd, TCSANOW, &t);
	}
	tcflush(fd, TCIOFLUSH);
	return fd;
}

static int make_listener(void) {
	struct sockaddr_un addr;
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (fd < 0) return -1;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", SOCK_PATH);
	unlink(SOCK_PATH);
	if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 || listen(fd, 8) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

int main(void) {
	int i;
	signal(SIGPIPE, SIG_IGN);
	mkdir(RUN_DIR, 0755);
	/* init gives daemons no useful stderr; a small log answers "what did
	 * rpcd think happened" after protocol incidents. /run is tmpfs. */
	freopen("/run/vinx/rpcd.log", "a", stderr);

	/* One owner. A live pid in the file means this start is a mistake. */
	{
		FILE *pf = fopen(PID_PATH, "r");
		if (pf) {
			int pid = 0;
			if (fscanf(pf, "%d", &pid) == 1 && pid > 0 && kill((pid_t)pid, 0) == 0) {
				fclose(pf);
				fprintf(stderr, "rpcd: already running as pid %d\n", pid);
				sleep(2); /* do not let a respawn loop spin */
				return 1;
			}
			fclose(pf);
		}
	}

	tty_fd = open_tty(TTY_PATH);
	mux_fd = open_tty(MUX_TTY_PATH);
	{
		FILE *pf = fopen(PID_PATH, "w");
		if (pf) {
			fprintf(pf, "%d\n", (int)getpid());
			fclose(pf);
		}
	}
	listen_fd = make_listener();
	if (listen_fd < 0) {
		fprintf(stderr, "rpcd: cannot listen on %s\n", SOCK_PATH);
		unlink(PID_PATH);
		sleep(2);
		return 1;
	}
	wire_init(&parser);
	mux_init(&mparser);
	for (i = 0; i < MAX_CLIENTS; i++) {
		clients[i].fd = -1;
		clients[i].carried_fd = -1;
	}

	for (;;) {
		struct pollfd fds[3 + MAX_CLIENTS + MAX_STREAMS];
		int map[3 + MAX_CLIENTS + MAX_STREAMS];
		int nf = 0, pi;
		int mux_room = mux_out.len - mux_out.off < MUX_OUT_HIGH;

		fds[nf].fd = tty_fd;
		fds[nf].events = POLLIN | (tty_out.len > tty_out.off ? POLLOUT : 0);
		map[nf++] = -1;
		fds[nf].fd = listen_fd;
		fds[nf].events = POLLIN;
		map[nf++] = -2;
		if (mux_fd >= 0) {
			fds[nf].fd = mux_fd;
			fds[nf].events = POLLIN | (mux_out.len > mux_out.off ? POLLOUT : 0);
			map[nf++] = -3;
		}
		for (i = 0; i < MAX_CLIENTS; i++) {
			if (clients[i].fd < 0) continue;
			fds[nf].fd = clients[i].fd;
			fds[nf].events = POLLIN | (clients[i].out.len > clients[i].out.off ? POLLOUT : 0);
			map[nf++] = i;
		}
		for (i = 0; i < MAX_STREAMS; i++) {
			if (!streams[i].used) continue;
			fds[nf].fd = streams[i].fd;
			/* Reading the master stops while ttyS1 is backed up: the PTY
			 * buffer fills, the app blocks -- backpressure, not memory. */
			fds[nf].events = (mux_room ? POLLIN : 0) |
			                 (streams[i].to_pty.len > streams[i].to_pty.off ? POLLOUT : 0);
			map[nf++] = 1000 + i;
		}

		if (poll(fds, (nfds_t)nf, 500) < 0 && errno != EINTR) die_tty("poll failed");

		for (pi = 0; pi < nf; pi++) {
			int who = map[pi];
			if (!fds[pi].revents) continue;

			if (who >= 1000) {
				struct stream *s = &streams[who - 1000];
				if (!s->used || s->fd != fds[pi].fd) continue; /* replaced mid-loop */
				if (fds[pi].revents & POLLOUT) {
					int before = s->to_pty.len - s->to_pty.off;
					if (outq_flush(&s->to_pty, s->fd) < 0) {
						stream_drop(s, "the pty write failed", 1);
						continue;
					}
					s->credit_owed += before - (s->to_pty.len - s->to_pty.off);
				}
				if (fds[pi].revents & (POLLIN | POLLHUP | POLLERR)) stream_pump_out(s);
				continue;
			}

			if (who == -3) {
				if (fds[pi].revents & (POLLERR | POLLHUP)) {
					/* The stream lane died alone; the control plane lives.
					 * v86 never hangs up a serial port, so this is theory. */
					logline("the mux tty hung up; streams close, control continues");
					streams_drop_all("the stream lane failed", 1);
					close(mux_fd);
					mux_fd = -1;
					continue;
				}
				if (fds[pi].revents & POLLOUT) {
					if (outq_flush(&mux_out, mux_fd) < 0) {
						logline("the mux tty write failed; streams close");
						streams_drop_all("the stream lane failed", 1);
						close(mux_fd);
						mux_fd = -1;
						continue;
					}
				}
				if (fds[pi].revents & POLLIN) {
					unsigned char buf[4096];
					for (;;) {
						ssize_t r = read(mux_fd, buf, sizeof(buf));
						if (r < 0) {
							if (errno == EINTR) continue;
							break; /* EAGAIN, or an error the HUP branch will see */
						}
						if (r == 0) break;
						mux_feed(&mparser, buf, (int)r);
						if (r < (ssize_t)sizeof(buf)) break;
					}
					{
						struct mux_frame f;
						while (mux_next(&mparser, &f)) stream_bytes_in(f.channel, f.bytes, f.len);
					}
					/* Land what arrived without waiting a poll round. */
					for (i = 0; i < MAX_STREAMS; i++) {
						struct stream *s = &streams[i];
						int before;
						if (!s->used || s->to_pty.len <= s->to_pty.off) continue;
						before = s->to_pty.len - s->to_pty.off;
						if (outq_flush(&s->to_pty, s->fd) < 0) {
							stream_drop(s, "the pty write failed", 1);
							continue;
						}
						s->credit_owed += before - (s->to_pty.len - s->to_pty.off);
					}
				}
				continue;
			}

			if (who == -1) {
				if (fds[pi].revents & (POLLERR | POLLHUP)) die_tty("the tty hung up");
				if (fds[pi].revents & POLLOUT) {
					if (outq_flush(&tty_out, tty_fd) < 0) die_tty("the tty write failed");
				}
				if (fds[pi].revents & POLLIN) {
					unsigned char buf[4096];
					for (;;) {
						ssize_t r = read(tty_fd, buf, sizeof(buf));
						if (r < 0) {
							if (errno == EINTR) continue;
							if (errno == EAGAIN || errno == EWOULDBLOCK) break;
							die_tty("the tty read failed");
						}
						if (r == 0) die_tty("the tty reached EOF");
						wire_feed(&parser, buf, (int)r);
						if (r < (ssize_t)sizeof(buf)) break;
					}
					{
						struct wire_frame f;
						while (wire_next(&parser, &f)) handle_frame(&f);
					}
				}
			} else if (who == -2) {
				for (;;) {
					int cfd = accept4(listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
					int slot = -1;
					if (cfd < 0) break;
					for (i = 0; i < MAX_CLIENTS; i++)
						if (clients[i].fd < 0) {
							slot = i;
							break;
						}
					if (slot < 0) {
						close(cfd); /* full house; the client sees EOF and retries */
						continue;
					}
					memset(&clients[slot], 0, sizeof(clients[slot]));
					clients[slot].fd = cfd;
					clients[slot].carried_fd = -1;
				}
			} else {
				if (fds[pi].revents & (POLLERR | POLLHUP)) {
					/* Drain what it wrote before it went: a one-shot client
					 * (vinx_notify) legitimately writes and closes. */
					handle_client_bytes(who);
					if (clients[who].fd >= 0) drop_client(who, "its client disconnected");
					continue;
				}
				if (fds[pi].revents & POLLOUT) {
					if (outq_flush(&clients[who].out, clients[who].fd) < 0)
						drop_client(who, "its socket failed");
				}
				if (clients[who].fd >= 0 && (fds[pi].revents & POLLIN)) handle_client_bytes(who);
			}
		}

		sweep();
		check_carrier();
		check_stall();
		check_mux_stall();
		stream_flush_credits();
		events_tick();
	}
}
