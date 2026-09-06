/* rpc -- the control plane from the shell (system-v2 §6.10).
 *
 *   rpc call METHOD [PARAMS_JSON|-] [-t SECS]   call, result JSON on stdout
 *   rpc notify METHOD [PARAMS_JSON]             fire-and-forget
 *   rpc discover                                list every method, paged
 *   rpc watch [TOPIC...]                        print events until ^C
 *   rpc serve METHOD -- HANDLER [ARG...]        host one ext.* method
 *
 * PARAMS_JSON of "-" (or a piped stdin with no argument) reads the params
 * from stdin -- shell quoting is where JSON goes to die, and jq -cn pipes
 * in cleanly. Exit 0 with a result, 1 with an error (named on stderr), 2
 * for usage. js(1) and fetch(1) are wrappers over `rpc call`.
 *
 * `watch` is the event subscription's shell consumer (§6.7): it holds its
 * own connection open (librpc is deliberately one-connection-per-call, so
 * the loop lives here), subscribes with an rpc.watch notification, and
 * prints one `TOPIC DATA_JSON` line per rpc.event. No topics means "*".
 * ^C ends it; rpcd drops the subscription with the connection.
 *
 * `serve` is §7.3's shell half: it registers ext.<app-id>.<name> over its
 * own held connection and turns every incoming request into one HANDLER
 * run -- params JSON on stdin, result JSON expected on stdout, a non-zero
 * exit becomes INTERNAL_ERROR, an rpc.cancel kills the run's process
 * group. Requests run concurrently (each is its own fork); replies go
 * back in completion order, which rpcd's id routing was built for. The
 * registration is this process's lifetime: ^C (or the app stopping)
 * unregisters by disconnecting.
 */
#include "jsonlite.h"
#include "vinx_rpc.h"

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define STDIN_CAP (60 * 1024)

static void usage(void) {
	fprintf(stderr,
	        "usage: rpc call METHOD [PARAMS_JSON|-] [-t SECS]\n"
	        "       rpc notify METHOD [PARAMS_JSON|-]\n"
	        "       rpc discover\n"
	        "       rpc watch [TOPIC...]\n"
	        "       rpc serve METHOD -- HANDLER [ARG...]\n"
	        "\n"
	        "The machine's control plane: proc.* runs here (rund); http.fetch and\n"
	        "debug.js run on the hosting browser page. `rpc discover` lists all.\n"
	        "Params ride stdin with `-` -- build them with jq -cn and pipe.\n"
	        "`watch` prints one 'TOPIC DATA' line per event until ^C; no topics\n"
	        "means every topic. Try: rpc watch window app &  then close a window.\n"
	        "`serve` registers ext.<app-id>.<name> and runs HANDLER per request:\n"
	        "params JSON on stdin, result JSON on stdout, non-zero exit = error.\n"
	        "The registration lives while this process does.\n");
	exit(2);
}

/* One connected Unix-socket fd to rpcd, or -1 with a stderr line. */
static int connect_rpcd_fd(void) {
	struct sockaddr_un addr;
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0) return -1;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", "/run/vinx/rpc.sock");
	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		fprintf(stderr, "rpc: could not reach rpcd on /run/vinx/rpc.sock\n");
		close(fd);
		return -1;
	}
	return fd;
}

static char *read_stdin(void) {
	char *buf = malloc(STDIN_CAP + 1);
	int len = 0, i;
	ssize_t r;
	if (!buf) return NULL;
	while (len < STDIN_CAP && (r = read(0, buf + len, (size_t)(STDIN_CAP - len))) > 0)
		len += (int)r;
	if (len >= STDIN_CAP) {
		fprintf(stderr, "rpc: params past %d KiB do not fit a frame; stage a /data resource ref instead\n",
		        STDIN_CAP / 1024);
		free(buf);
		return NULL;
	}
	buf[len] = 0;
	/* The socket protocol is one request per line, and these params are
	 * spliced into that line verbatim -- a newline inside them (jq ends its
	 * output with one; pretty-printers riddle theirs) would cut the request
	 * in half, and rpcd could not even name the ruin back to us. A raw
	 * newline cannot appear inside a JSON string (only as \n), so flattening
	 * them to spaces is safe for any single JSON value. */
	for (i = 0; i < len; i++)
		if (buf[i] == '\n' || buf[i] == '\r') buf[i] = ' ';
	return buf;
}

static void print_error(const struct vinx_error *e) {
	fprintf(stderr, "rpc: %s: %s\n", e->name, e->message);
	if (e->hint[0]) fprintf(stderr, "rpc: hint: %s\n", e->hint);
}

static int do_call(const char *method, const char *params, long deadline_ms) {
	char *result = NULL;
	struct vinx_error err;
	if (vinx_call_deadline(method, params, deadline_ms, &result, &err) != 0) {
		print_error(&err);
		return 1;
	}
	puts(result ? result : "{}");
	free(result);
	return 0;
}

static int do_discover(void) {
	long long cursor = 0;
	for (;;) {
		char params[64];
		char *result = NULL;
		struct vinx_error err;
		int ms, me, vs, ve, n, i;
		snprintf(params, sizeof(params), "{\"cursor\":%lld,\"limit\":16}", cursor);
		if (vinx_call_deadline("rpc.discover", params, 10000, &result, &err) != 0) {
			print_error(&err);
			return 1;
		}
		n = (int)strlen(result);
		if (jl_obj_get(result, n, "methods", &ms, &me) != 1 || result[ms] != '[') {
			fprintf(stderr, "rpc: discover answered without a methods array\n");
			free(result);
			return 1;
		}
		i = jl_ws(result, me, ms + 1);
		while (i < me && result[i] != ']') {
			int end = jl_skip(result, me, i);
			int fs, fe;
			char name[128] = "?", owner[32] = "?", summary[256] = "";
			if (end < 0) break;
			if (jl_obj_get(result + i, end - i, "name", &fs, &fe) == 1)
				jl_str_decode(result + i, fs, fe, name, sizeof(name));
			if (jl_obj_get(result + i, end - i, "owner", &fs, &fe) == 1)
				jl_str_decode(result + i, fs, fe, owner, sizeof(owner));
			if (jl_obj_get(result + i, end - i, "summary", &fs, &fe) == 1)
				jl_str_decode(result + i, fs, fe, summary, sizeof(summary));
			printf("%-14s %-5s %s\n", name, owner, summary);
			i = jl_ws(result, me, end);
			if (i < me && result[i] == ',') i = jl_ws(result, me, i + 1);
		}
		if (jl_obj_get(result, n, "nextCursor", &vs, &ve) == 1) {
			cursor = jl_num(result, vs, ve, -1);
			free(result);
			if (cursor < 0) return 0;
			continue;
		}
		free(result);
		return 0;
	}
}

/* Hold a connection, subscribe, print events line by line. */
static int watch_write_all(int fd, const char *buf, size_t n) {
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

static void watch_print(const char *line, int len) {
	int vs, ve, ps, pe;
	char method[32], topic[80];
	if (jl_obj_get(line, len, "method", &vs, &ve) != 1) return;
	if (jl_str_decode(line, vs, ve, method, sizeof(method)) < 0) return;
	if (strcmp(method, "rpc.event")) return;
	if (jl_obj_get(line, len, "params", &vs, &ve) != 1) return;
	if (jl_obj_get(line + vs, ve - vs, "topic", &ps, &pe) != 1) return;
	if (jl_str_decode(line + vs, ps, pe, topic, sizeof(topic)) < 0) return;
	if (jl_obj_get(line + vs, ve - vs, "data", &ps, &pe) == 1)
		printf("%s %.*s\n", topic, pe - ps, line + vs + ps);
	else
		printf("%s null\n", topic);
	fflush(stdout); /* a pipe reader (the E2E console) sees each event now */
}

static int do_watch(int argc, char **argv, int argi) {
	char topics[512];
	char line[640];
	char buf[8192];
	size_t at = 0;
	int fd, n, len = 0;

	topics[0] = 0;
	if (argi >= argc) {
		snprintf(topics, sizeof(topics), "\"*\"");
		at = 3;
	} else {
		int i;
		for (i = argi; i < argc; i++) {
			char enc[160];
			int el = jl_str_encode(argv[i], (int)strlen(argv[i]), enc, (int)sizeof(enc));
			if (el < 0) continue;
			if (at + (size_t)el + 2 >= sizeof(topics)) break;
			if (at) topics[at++] = ',';
			memcpy(topics + at, enc, (size_t)el);
			at += (size_t)el;
			topics[at] = 0;
		}
	}

	fd = connect_rpcd_fd();
	if (fd < 0) return 1;
	n = snprintf(line, sizeof(line),
	             "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.watch\",\"params\":{\"topics\":[%s]}}\n", topics);
	if (n < 0 || n >= (int)sizeof(line) || watch_write_all(fd, line, (size_t)n) < 0) {
		close(fd);
		return 1;
	}

	for (;;) {
		ssize_t r;
		if (len >= (int)sizeof(buf) - 1) len = 0; /* an over-long line is not an event */
		r = read(fd, buf + len, sizeof(buf) - 1 - (size_t)len);
		if (r < 0) {
			if (errno == EINTR) continue;
			break;
		}
		if (r == 0) {
			fprintf(stderr, "rpc: rpcd closed the connection\n");
			close(fd);
			return 1;
		}
		len += (int)r;
		for (;;) {
			char *nl = memchr(buf, '\n', (size_t)len);
			int llen;
			if (!nl) break;
			llen = (int)(nl - buf);
			if (llen > 0) watch_print(buf, llen);
			memmove(buf, nl + 1, (size_t)(len - llen - 1));
			len -= llen + 1;
		}
	}
	close(fd);
	return 0;
}

/* ── rpc serve: host one ext.* method from the shell (§7.3, §6.10) ── */

#define SERVE_JOBS 8
#define SERVE_OUT_CAP (60 * 1024)

struct serve_job {
	int used;
	char id[80];
	pid_t pid;
	int out_fd; /* handler stdout, nonblocking */
	char *out;
	int outlen;
	int overflow;
	int cancelled;
};

static struct serve_job sjobs[SERVE_JOBS];

static int serve_write_all(int fd, const char *buf, size_t n) {
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

static void serve_reply_error(int fd, const char *id, int code, const char *name, const char *msg) {
	char m[300], body[600];
	int ml = jl_str_encode(msg, (int)strlen(msg), m, (int)sizeof(m));
	int n;
	if (ml < 0) return;
	n = snprintf(body, sizeof(body),
	             "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"error\":{\"code\":%d,\"name\":\"%s\",\"message\":%.*s}}\n",
	             id, code, name, ml, m);
	if (n > 0 && n < (int)sizeof(body)) serve_write_all(fd, body, (size_t)n);
}

/* One request becomes one handler run: params on stdin, result on stdout.
 * The child gets its own process group so a cancel kills the whole run. */
static void serve_spawn(int sock, const char *id, const char *params, int plen, char **handler) {
	struct serve_job *j = NULL;
	int pin[2], pout[2];
	pid_t pid;
	int k;

	for (k = 0; k < SERVE_JOBS; k++)
		if (!sjobs[k].used) {
			j = &sjobs[k];
			break;
		}
	if (!j) {
		serve_reply_error(sock, id, 1006, "OVERLOADED", "8 handler runs already in flight");
		return;
	}
	if (pipe(pin) < 0 || pipe(pout) < 0) {
		serve_reply_error(sock, id, -32603, "INTERNAL_ERROR", "pipe() failed");
		return;
	}
	pid = fork();
	if (pid < 0) {
		close(pin[0]);
		close(pin[1]);
		close(pout[0]);
		close(pout[1]);
		serve_reply_error(sock, id, -32603, "INTERNAL_ERROR", "fork() failed");
		return;
	}
	if (pid == 0) {
		signal(SIGPIPE, SIG_DFL);
		setsid();
		dup2(pin[0], 0);
		dup2(pout[1], 1);
		/* stderr stays this server's own: the app's log carries it. */
		close(pin[0]);
		close(pin[1]);
		close(pout[0]);
		close(pout[1]);
		close(sock);
		execvp(handler[0], handler);
		fprintf(stderr, "rpc serve: cannot exec %s\n", handler[0]);
		_exit(127);
	}
	close(pin[0]);
	close(pout[1]);
	/* Params into the handler's stdin, whole, then EOF. A frame-sized
	 * write fits a pipe buffer, so this cannot deadlock on a slow reader. */
	serve_write_all(pin[1], params && plen > 0 ? params : "{}", params && plen > 0 ? (size_t)plen : 2);
	close(pin[1]);

	memset(j, 0, sizeof(*j));
	j->used = 1;
	snprintf(j->id, sizeof(j->id), "%s", id);
	j->pid = pid;
	j->out_fd = pout[0];
	j->out = malloc(SERVE_OUT_CAP);
	j->outlen = 0;
	if (!j->out) {
		kill(-pid, SIGKILL);
		close(pout[0]);
		j->used = 0;
		serve_reply_error(sock, id, -32603, "INTERNAL_ERROR", "out of memory");
	}
}

/* The handler finished (its stdout hit EOF): shape the reply. */
static void serve_finish(int sock, struct serve_job *j) {
	int st = 0;
	waitpid(j->pid, &st, 0);
	if (j->cancelled) {
		serve_reply_error(sock, j->id, 1002, "CANCELLED", "the run was cancelled");
	} else if (j->overflow) {
		serve_reply_error(sock, j->id, -32603, "INTERNAL_ERROR",
		                  "the handler wrote more than 60 KiB; results that size ride a /data ref (system-v2 6.8)");
	} else if (WIFEXITED(st) && WEXITSTATUS(st) == 0) {
		/* stdout must be one JSON value (or nothing, meaning {}). */
		int i = jl_ws(j->out, j->outlen, 0);
		int end = i < j->outlen ? jl_skip(j->out, j->outlen, i) : -1;
		if (i >= j->outlen) {
			char body[160];
			int n = snprintf(body, sizeof(body), "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{}}\n", j->id);
			if (n > 0 && n < (int)sizeof(body)) serve_write_all(sock, body, (size_t)n);
		} else if (end < 0 || jl_ws(j->out, j->outlen, end) < j->outlen) {
			serve_reply_error(sock, j->id, -32603, "INTERNAL_ERROR",
			                  "the handler's stdout is not one JSON value");
		} else {
			char head[128];
			int n = snprintf(head, sizeof(head), "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":", j->id);
			if (n > 0 && n < (int)sizeof(head) &&
			    (serve_write_all(sock, head, (size_t)n) < 0 ||
			     serve_write_all(sock, j->out + i, (size_t)(end - i)) < 0 ||
			     serve_write_all(sock, "}\n", 2) < 0)) {
				/* the socket died; the main loop will see it too */
			}
		}
	} else {
		char msg[80];
		snprintf(msg, sizeof(msg), "the handler exited %d",
		         WIFEXITED(st) ? WEXITSTATUS(st) : (WIFSIGNALED(st) ? 128 + WTERMSIG(st) : 125));
		serve_reply_error(sock, j->id, -32603, "INTERNAL_ERROR", msg);
	}
	close(j->out_fd);
	free(j->out);
	j->used = 0;
}

static void serve_dispatch_line(int sock, const char *line, int len, const char *method, char **handler) {
	int vs, ve;
	char id[80], m[128];
	int has_id = 0, has_method = 0;
	if (jl_obj_get(line, len, "id", &vs, &ve) == 1 && jl_is_str(line, vs, ve) &&
	    jl_str_decode(line, vs, ve, id, sizeof(id)) >= 0)
		has_id = 1;
	if (jl_obj_get(line, len, "method", &vs, &ve) == 1 && jl_is_str(line, vs, ve) &&
	    jl_str_decode(line, vs, ve, m, sizeof(m)) >= 0)
		has_method = 1;
	if (has_method && !has_id) {
		/* rpc.cancel is the one notification with our name on it. */
		if (!strcmp(m, "rpc.cancel")) {
			int ps, pe;
			char target[80];
			int k;
			if (jl_obj_get(line, len, "params", &vs, &ve) == 1 &&
			    jl_obj_get(line + vs, ve - vs, "id", &ps, &pe) == 1 &&
			    jl_str_decode(line + vs, ps, pe, target, sizeof(target)) >= 0) {
				for (k = 0; k < SERVE_JOBS; k++)
					if (sjobs[k].used && !strcmp(sjobs[k].id, target)) {
						sjobs[k].cancelled = 1;
						kill(-sjobs[k].pid, SIGKILL);
					}
			}
		}
		return;
	}
	if (!has_method || !has_id) return;
	if (strcmp(m, method)) {
		serve_reply_error(sock, id, -32601, "METHOD_NOT_FOUND", "this server hosts one method");
		return;
	}
	{
		const char *params = NULL;
		int plen = 0;
		if (jl_obj_get(line, len, "params", &vs, &ve) == 1) {
			params = line + vs;
			plen = ve - vs;
		}
		serve_spawn(sock, id, params, plen, handler);
	}
}

static int do_serve(int argc, char **argv, int argi) {
	const char *method;
	char **handler = NULL;
	char reg[256], menc[160];
	char inbuf[64 * 1024];
	int inlen = 0;
	int sock, n, i;

	if (argi >= argc) usage();
	method = argv[argi++];
	for (i = argi; i < argc; i++)
		if (!strcmp(argv[i], "--")) {
			handler = &argv[i + 1];
			break;
		}
	if (!handler || !handler[0]) usage();
	if (strncmp(method, "ext.", 4)) {
		fprintf(stderr, "rpc: serve hosts ext.<app-id>.<name> methods only (system-v2 7.3)\n");
		return 2;
	}

	sock = connect_rpcd_fd();
	if (sock < 0) return 1;
	{
		int ml = jl_str_encode(method, (int)strlen(method), menc, (int)sizeof(menc));
		if (ml < 0) return 2;
		n = snprintf(reg, sizeof(reg), "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.serve\",\"params\":{\"methods\":[%.*s]}}\n",
		             ml, menc);
		if (n < 0 || n >= (int)sizeof(reg) || serve_write_all(sock, reg, (size_t)n) < 0) {
			close(sock);
			return 1;
		}
	}
	signal(SIGPIPE, SIG_IGN);
	fprintf(stderr, "rpc: serving %s (^C stops; the registration dies with this process)\n", method);

	for (;;) {
		struct pollfd fds[1 + SERVE_JOBS];
		int map[1 + SERVE_JOBS];
		int nf = 0, pi;
		fds[nf].fd = sock;
		fds[nf].events = POLLIN;
		map[nf++] = -1;
		for (i = 0; i < SERVE_JOBS; i++) {
			if (!sjobs[i].used) continue;
			fds[nf].fd = sjobs[i].out_fd;
			fds[nf].events = POLLIN;
			map[nf++] = i;
		}
		if (poll(fds, (nfds_t)nf, -1) < 0) {
			if (errno == EINTR) continue;
			return 1;
		}
		for (pi = 0; pi < nf; pi++) {
			int who = map[pi];
			if (!fds[pi].revents) continue;
			if (who >= 0) {
				struct serve_job *j = &sjobs[who];
				ssize_t r = read(j->out_fd, j->out + j->outlen,
				                 (size_t)(SERVE_OUT_CAP - 1 - j->outlen));
				if (r > 0) {
					j->outlen += (int)r;
					if (j->outlen >= SERVE_OUT_CAP - 1) {
						j->overflow = 1;
						kill(-j->pid, SIGKILL);
					}
					continue;
				}
				if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
				serve_finish(sock, j); /* EOF (or a read error): the run is over */
				continue;
			}
			if (fds[pi].revents & (POLLERR | POLLHUP)) {
				fprintf(stderr, "rpc: rpcd closed the connection\n");
				return 1;
			}
			{
				ssize_t r = read(sock, inbuf + inlen, sizeof(inbuf) - 1 - (size_t)inlen);
				char *nl;
				if (r == 0) {
					fprintf(stderr, "rpc: rpcd closed the connection\n");
					return 1;
				}
				if (r < 0) {
					if (errno == EINTR || errno == EAGAIN) continue;
					return 1;
				}
				inlen += (int)r;
				if (inlen >= (int)sizeof(inbuf) - 1) inlen = 0; /* an over-long line is not ours */
				while ((nl = memchr(inbuf, '\n', (size_t)inlen))) {
					int llen = (int)(nl - inbuf);
					if (llen > 0) serve_dispatch_line(sock, inbuf, llen, method, handler);
					memmove(inbuf, nl + 1, (size_t)(inlen - llen - 1));
					inlen -= llen + 1;
				}
			}
		}
	}
}

int main(int argc, char **argv) {
	const char *verb, *method = NULL;
	char *params = NULL;
	char *from_stdin = NULL;
	long deadline_ms = 30000;
	int i, rc;

	if (argc < 2) usage();
	verb = argv[1];

	if (!strcmp(verb, "discover")) return do_discover();
	if (!strcmp(verb, "watch")) return do_watch(argc, argv, 2);
	if (!strcmp(verb, "serve")) return do_serve(argc, argv, 2);
	if (strcmp(verb, "call") && strcmp(verb, "notify")) usage();

	for (i = 2; i < argc; i++) {
		if (!strcmp(argv[i], "-t")) {
			long secs;
			if (i + 1 >= argc) usage();
			secs = atol(argv[++i]);
			if (secs < 1) secs = 1;
			if (secs > 600) secs = 600;
			deadline_ms = secs * 1000;
		} else if (!method) {
			method = argv[i];
		} else if (!params) {
			params = argv[i];
		} else {
			usage();
		}
	}
	if (!method) usage();
	if ((params && !strcmp(params, "-")) || (!params && !isatty(0))) {
		from_stdin = read_stdin();
		if (!from_stdin) return 1;
		params = from_stdin[0] ? from_stdin : NULL;
	}

	if (!strcmp(verb, "notify")) {
		rc = vinx_notify(method, params) == 0 ? 0 : 1;
		if (rc) fprintf(stderr, "rpc: could not reach rpcd on /run/vinx/rpc.sock\n");
	} else {
		rc = do_call(method, params, deadline_ms);
	}
	free(from_stdin);
	return rc;
}
