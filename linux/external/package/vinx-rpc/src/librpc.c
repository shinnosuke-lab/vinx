/* librpc -- the socket client behind vinx_rpc.h and rpc(1).
 *
 * One connection per call keeps the library free of state and the failure
 * modes obvious; rpcd's event loop is built for many short-lived clients.
 * Requests carry meta.deadlineMs so the far side can shed work; this side
 * waits a little longer than that, then settles locally.
 */
#include "vinx_rpc.h"
#include "jsonlite.h"

#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define SOCK_PATH "/run/vinx/rpc.sock"
#define REPLY_CAP (256 * 1024)
#define WAIT_GRACE_MS 5000

static long long now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void set_err(struct vinx_error *e, int code, const char *name, const char *msg, const char *hint) {
	if (!e) return;
	e->code = code;
	snprintf(e->name, sizeof(e->name), "%s", name);
	snprintf(e->message, sizeof(e->message), "%s", msg);
	snprintf(e->hint, sizeof(e->hint), "%s", hint ? hint : "");
}

static int connect_rpcd(struct vinx_error *err) {
	struct sockaddr_un addr;
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0) {
		set_err(err, 1001, "UNAVAILABLE", "socket() failed", NULL);
		return -1;
	}
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", SOCK_PATH);
	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		close(fd);
		set_err(err, 1001, "UNAVAILABLE", "rpcd is not answering on " SOCK_PATH,
		        "rpcd owns /dev/ttyS3 and is respawned by init; check `ps` and /run/vinx/rpcd.pid");
		return -1;
	}
	return fd;
}

static int write_all(int fd, const char *buf, size_t n) {
	while (n > 0) {
		ssize_t w = write(fd, buf, n);
		if (w < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		buf += w;
		n -= (size_t)w;
	}
	return 0;
}

/* Build one request/notification line. Returns malloc'd string. */
static char *build_line(const char *method, const char *params_json, const char *id,
                        long deadline_ms) {
	char mkey[256];
	const char *params = params_json && params_json[0] ? params_json : "{}";
	size_t cap;
	char *line;
	int mlen = jl_str_encode(method, (int)strlen(method), mkey, sizeof(mkey));
	if (mlen < 0) return NULL;
	cap = strlen(params) + (size_t)mlen + 160;
	line = malloc(cap);
	if (!line) return NULL;
	if (id) {
		snprintf(line, cap, "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"method\":%.*s,\"params\":%s,\"meta\":{\"deadlineMs\":%ld}}\n",
		         id, mlen, mkey, params, deadline_ms);
	} else {
		snprintf(line, cap, "{\"jsonrpc\":\"2.0\",\"method\":%.*s,\"params\":%s}\n", mlen, mkey, params);
	}
	return line;
}

/* Parse one response line for our id. 1 = handled (rc set), 0 = not ours. */
static int parse_response(const char *line, int len, const char *id, char **result_json,
                          struct vinx_error *err, int *rc) {
	int vs, ve;
	char got[80];
	if (jl_obj_get(line, len, "id", &vs, &ve) != 1) return 0;
	if (!jl_is_str(line, vs, ve)) return 0;
	if (jl_str_decode(line, vs, ve, got, sizeof(got)) < 0) return 0;
	if (strcmp(got, id)) return 0;

	if (jl_obj_get(line, len, "error", &vs, &ve) == 1) {
		int fs, fe;
		char buf[512];
		set_err(err, -32603, "INTERNAL_ERROR", "the far side sent a malformed error", NULL);
		/* jl_obj_get offsets are relative to the error object slice. */
		if (jl_obj_get(line + vs, ve - vs, "code", &fs, &fe) == 1)
			err->code = (int)jl_num(line + vs, fs, fe, -32603);
		if (jl_obj_get(line + vs, ve - vs, "name", &fs, &fe) == 1 &&
		    jl_str_decode(line + vs, fs, fe, buf, sizeof(buf)) >= 0)
			snprintf(err->name, sizeof(err->name), "%s", buf);
		if (jl_obj_get(line + vs, ve - vs, "message", &fs, &fe) == 1 &&
		    jl_str_decode(line + vs, fs, fe, buf, sizeof(buf)) >= 0)
			snprintf(err->message, sizeof(err->message), "%s", buf);
		if (jl_obj_get(line + vs, ve - vs, "hint", &fs, &fe) == 1 &&
		    jl_str_decode(line + vs, fs, fe, buf, sizeof(buf)) >= 0)
			snprintf(err->hint, sizeof(err->hint), "%s", buf);
		*rc = -1;
		return 1;
	}
	if (jl_obj_get(line, len, "result", &vs, &ve) == 1) {
		if (result_json) {
			*result_json = malloc((size_t)(ve - vs) + 1);
			if (!*result_json) {
				set_err(err, -32603, "INTERNAL_ERROR", "out of memory", NULL);
				*rc = -1;
				return 1;
			}
			memcpy(*result_json, line + vs, (size_t)(ve - vs));
			(*result_json)[ve - vs] = 0;
		}
		*rc = 0;
		return 1;
	}
	return 0;
}

/* The whole line in one sendmsg, carry_fd as SCM_RIGHTS. One shot: fd
 * attachment must not straddle a partial write (rpcd binds the fd to the
 * line it arrives with). */
static int sendmsg_with_fd(int fd, const char *buf, size_t n, int carry_fd) {
	struct iovec iov;
	struct msghdr msg;
	char cbuf[CMSG_SPACE(sizeof(int))];
	struct cmsghdr *cm;
	ssize_t w;
	memset(&msg, 0, sizeof(msg));
	iov.iov_base = (void *)buf;
	iov.iov_len = n;
	msg.msg_iov = &iov;
	msg.msg_iovlen = 1;
	msg.msg_control = cbuf;
	msg.msg_controllen = sizeof(cbuf);
	cm = CMSG_FIRSTHDR(&msg);
	cm->cmsg_level = SOL_SOCKET;
	cm->cmsg_type = SCM_RIGHTS;
	cm->cmsg_len = CMSG_LEN(sizeof(int));
	memcpy(CMSG_DATA(cm), &carry_fd, sizeof(int));
	do {
		w = sendmsg(fd, &msg, 0);
	} while (w < 0 && errno == EINTR);
	if (w < 0) return -1;
	/* A Unix stream socket takes a small line whole; anything else is a
	 * protocol-breaking partial and the caller treats it as failure. */
	return (size_t)w == n ? 0 : -1;
}

int vinx_call_deadline_fd(const char *method, const char *params_json, long deadline_ms,
                          int carry_fd, char **result_json, struct vinx_error *error) {
	static int counter;
	char id[64];
	char *line;
	char *reply;
	int reply_len = 0;
	long long give_up;
	int fd, rc = -1, done = 0;

	if (result_json) *result_json = NULL;
	if (deadline_ms <= 0) deadline_ms = 30000;

	fd = connect_rpcd(error);
	if (fd < 0) return -1;

	snprintf(id, sizeof(id), "g.%d.%d", (int)getpid(), ++counter);
	line = build_line(method, params_json, id, deadline_ms);
	if (!line) {
		close(fd);
		set_err(error, -32603, "INTERNAL_ERROR", "could not build the request", NULL);
		return -1;
	}
	if (carry_fd >= 0 ? sendmsg_with_fd(fd, line, strlen(line), carry_fd) < 0
	                  : write_all(fd, line, strlen(line)) < 0) {
		free(line);
		close(fd);
		set_err(error, 1001, "UNAVAILABLE", "rpcd hung up mid-request", NULL);
		return -1;
	}
	free(line);

	reply = malloc(REPLY_CAP);
	if (!reply) {
		close(fd);
		set_err(error, -32603, "INTERNAL_ERROR", "out of memory", NULL);
		return -1;
	}

	give_up = now_ms() + deadline_ms + WAIT_GRACE_MS;
	while (!done) {
		struct pollfd pfd = { fd, POLLIN, 0 };
		long long left = give_up - now_ms();
		ssize_t r;
		int p;
		if (left <= 0) {
			set_err(error, 1003, "DEADLINE_EXCEEDED", "no response within the deadline",
			        "the page may be gone; rpcd will cancel the call");
			break;
		}
		p = poll(&pfd, 1, (int)(left > 1000 ? 1000 : left));
		if (p < 0 && errno != EINTR) {
			set_err(error, 1001, "UNAVAILABLE", "poll() failed waiting for rpcd", NULL);
			break;
		}
		if (p <= 0) continue;
		if (reply_len >= REPLY_CAP - 1) {
			set_err(error, -32603, "INTERNAL_ERROR", "the reply outgrew this client's buffer",
			        "results this large should ride a /data resource ref");
			break;
		}
		r = read(fd, reply + reply_len, (size_t)(REPLY_CAP - 1 - reply_len));
		if (r < 0) {
			if (errno == EINTR) continue;
			set_err(error, 1001, "UNAVAILABLE", "read() from rpcd failed", NULL);
			break;
		}
		if (r == 0) {
			set_err(error, 1001, "UNAVAILABLE", "rpcd closed the connection",
			        "rpcd restarting cancels in-flight calls; retry");
			break;
		}
		reply_len += (int)r;
		for (;;) {
			char *nl = memchr(reply, '\n', (size_t)reply_len);
			int llen;
			if (!nl) break;
			llen = (int)(nl - reply);
			if (parse_response(reply, llen, id, result_json, error, &rc)) {
				done = 1;
				break;
			}
			memmove(reply, nl + 1, (size_t)(reply_len - llen - 1));
			reply_len -= llen + 1;
		}
	}

	free(reply);
	close(fd);
	return done ? rc : -1;
}

int vinx_call_deadline(const char *method, const char *params_json, long deadline_ms,
                       char **result_json, struct vinx_error *error) {
	return vinx_call_deadline_fd(method, params_json, deadline_ms, -1, result_json, error);
}

int vinx_call(const char *method, const char *params_json, char **result_json,
              struct vinx_error *error) {
	return vinx_call_deadline(method, params_json, 30000, result_json, error);
}

int vinx_notify(const char *method, const char *params_json) {
	struct vinx_error err;
	char *line;
	int fd = connect_rpcd(&err);
	int rc;
	if (fd < 0) return -1;
	line = build_line(method, params_json, NULL, 0);
	if (!line) {
		close(fd);
		return -1;
	}
	rc = write_all(fd, line, strlen(line));
	free(line);
	close(fd);
	return rc;
}
