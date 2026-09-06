/* rund -- the process runner behind proc.run and the app.* lifecycle
 * (system-v2 §9.3; Phase 1 cut the runner, Phase 4 added services).
 *
 * rund never touches the tty: it is one more client on /run/vinx/rpc.sock.
 * On connect it declares itself with an rpc.serve notification, and rpcd
 * statically routes proc.* and app.* here (§6.10). proc.run requests run
 * concurrently -- each job is a fork into its own process group, output
 * through one merged pipe, stdin on /dev/null -- and replies go back
 * whenever they finish, in any order. That is agentd's execution story
 * (timeout(1)-style SIGKILL, file size rlimit, start in /data) without
 * agentd's one-at-a-time wire.
 *
 * The result shape follows §6.8: a small output rides inline (stdout when
 * it is UTF-8, stdoutB64 when it is not); past inlineMax the full bytes
 * land in /data/.vinx/tmp/ and the reply carries {stdout: <head>,
 * truncated: true, output: {path, size, owner, expiresWithSession}}. With
 * no /data mounted, oversized output is DATA_PLANE_UNAVAILABLE -- an
 * honest error instead of a silent 64 KiB cut. scriptRef points at a file
 * the caller already staged under /data/.vinx/tmp/, so multi-KB scripts
 * never squeeze through 4 KiB frames.
 *
 * Cancellation is a forwarded rpc.cancel: the process group dies and the
 * reply is a CANCELLED error, because every accepted request is answered
 * exactly once (§6.4) -- rpcd's cancel on a disconnected asker lands here
 * the same way. Losing the rpcd socket kills every proc.run job (nobody is
 * left to hear them) and reconnects.
 *
 * Services (§9.3) are the other half: app.start/stop/status/list manage
 * long-running apps by id, each exec'd through app-run(8) into its own
 * process group with stdout+stderr appended to /run/vinx/apps/<id>/log and
 * pid/state/exit files beside it (an observation surface -- control stays
 * on this socket). Services deliberately do NOT die with the rpcd socket:
 * a page reload must not take a pure-Linux service down. Enabled services
 * (one id per line in /data/apps/enabled -- user policy, not manifest
 * data) are started by a periodic sweep and restarted with bounded backoff
 * after a crash; a burst of fast crashes parks the service as `failed`
 * until someone asks for it again. A respawned rund re-adopts services
 * from their pid files (kill(pid,0) tells living from stale) -- it cannot
 * waitpid an orphan, so an adopted service that later dies reports its
 * exit as unknown. Truth over invention, both directions.
 */
#define _GNU_SOURCE

#include "jsonlite.h"
#include "vinx_rpc.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <utmp.h>

#define SOCK_PATH "/run/vinx/rpc.sock"
#define TMP_DIR "/data/.vinx/tmp"
#define MAX_JOBS 8
#define INLINE_MAX 1024
/* What a job may say at most; past this the tail is dropped, not buffered.
 * The full cap still lands in /data, so it is 32x agentd's 64 KiB. */
#define OUT_HARD_CAP (2 * 1024 * 1024)
/* What a job may write to files (agentd's ulimit -f, in bytes). */
#define FSIZE_LIMIT (32 * 1024 * 1024)
#define DEFAULT_TIMEOUT_MS 30000
#define MAX_TIMEOUT_MS 600000
#define LINE_CAP (64 * 1024)

/* ── services (§9.3) ── */
#define MAX_SERVICES 8
/* The observation surface: /run/vinx/apps/<id>/{state,pid,exit,log}. */
#define APPS_RUN_DIR "/run/vinx/apps"
/* Installed packages and the enable list (user policy, one id per line);
 * both live in /data proper, so the page's recursive mirror carries them
 * across reboots -- that persistence IS the autostart story. */
#define APPS_DATA_DIR "/data/apps"
#define ENABLED_FILE APPS_DATA_DIR "/enabled"
/* How often the sweep looks at the enable list and due restarts. */
#define SERVICE_TICK_MS 5000
/* stop is two-staged: TERM, then KILL after this grace. */
#define STOP_GRACE_MS 2000
/* A crash faster than this counts toward the give-up threshold... */
#define CRASH_FAST_MS 10000
/* ...and this many consecutive fast crashes park the service as failed. */
#define CRASH_MAX 5

struct job {
	int used;
	char id[80];
	pid_t pid;
	int out_fd; /* pipe read end, nonblocking */
	char *out;
	int outlen;
	long long dropped; /* bytes past OUT_HARD_CAP */
	long long kill_at;
	int timed_out;
	int cancelled;
};

/* One managed app. Identity is the app id -- a service outlives any single
 * request, so unlike struct job it cannot borrow a request id for a name;
 * the one pending reply it may owe (a blocking app.stop) is kept aside. */
struct service {
	int used;
	char sid[40];
	pid_t pid; /* 0 while not running */
	/* Recovered from a previous rund (init respawned us): not our child,
	 * so no waitpid -- liveness is kill(pid,0) and the exit is unknown. */
	int adopted;
	long long started_at;
	int restarts;          /* consecutive fast crashes */
	long long restart_at;  /* backoff deadline; 0 = none scheduled */
	int failed;            /* crash-looped past CRASH_MAX; sweep hands off */
	int stopping;          /* TERM sent, KILL at kill_at */
	long long kill_at;
	int manual_stop;       /* stopped by hand: no autostart this boot */
	char stop_reply[80];   /* request id owed a reply when the exit lands */
	/* Started with a PTY window (app.start {pty:true}, §6.9): spawn goes
	 * through openpty/login_tty and the master rides stream.open to rpcd.
	 * Remembered so a backoff restart opens its window again. */
	int pty;
};

/* ── pty shells (proc.pty): a terminal window that is just a shell ── */
#define MAX_PTYS 8

/* One spawned shell on a PTY whose master lives with rpcd (§6.9). No
 * restart semantics, no state files: closing the window closes the stream,
 * the shell gets HUP and dies, we reap it here. */
struct ptyshell {
	int used;
	pid_t pid;
	long long stream_id;
};

static struct job jobs[MAX_JOBS];
static struct service services[MAX_SERVICES];
static struct ptyshell ptys[MAX_PTYS];
static int sock_fd = -1;

static long long now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* stderr is /run/vinx/rund.log (main redirects it): the trail that answers
 * "what did rund think happened" -- crash loops, adoptions, kills. */
static void logline(const char *fmt, ...) {
	va_list ap;
	fprintf(stderr, "[%lld] ", now_ms());
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
	fflush(stderr);
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

static void send_line(const char *body, int len) {
	if (sock_fd < 0) return;
	if (write_all(sock_fd, body, (size_t)len) < 0 || write_all(sock_fd, "\n", 1) < 0) {
		close(sock_fd);
		sock_fd = -1;
	}
}

static void send_error(const char *id, int code, const char *name, const char *msg, const char *hint) {
	char m[600], h[600], body[2048];
	int ml, hl, n;
	ml = jl_str_encode(msg, (int)strlen(msg), m, (int)sizeof(m));
	if (ml < 0) return;
	if (hint) {
		hl = jl_str_encode(hint, (int)strlen(hint), h, (int)sizeof(h));
		if (hl < 0) return;
		n = snprintf(body, sizeof(body),
		             "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"error\":{\"code\":%d,\"name\":\"%s\",\"message\":%.*s,\"hint\":%.*s}}",
		             id, code, name, ml, m, hl, h);
	} else {
		n = snprintf(body, sizeof(body),
		             "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"error\":{\"code\":%d,\"name\":\"%s\",\"message\":%.*s}}",
		             id, code, name, ml, m);
	}
	if (n > 0 && n < (int)sizeof(body)) send_line(body, n);
}

static int data_mounted(void) {
	FILE *f = fopen("/proc/mounts", "r");
	char line[512];
	int found = 0;
	if (!f) return 0;
	while (fgets(line, sizeof(line), f)) {
		if (strstr(line, " /data ")) {
			found = 1;
			break;
		}
	}
	fclose(f);
	return found;
}

/* ── starting a job ── */

static void job_spawn(const char *id, const char *mode, const char *arg, const char *cwd,
                      long long timeout_ms) {
	struct job *j = NULL;
	int pfd[2];
	pid_t pid;
	int i;

	for (i = 0; i < MAX_JOBS; i++)
		if (!jobs[i].used) {
			j = &jobs[i];
			break;
		}
	if (!j) {
		send_error(id, 1006, "OVERLOADED", "8 processes already running for proc.run",
		           "wait for one to finish");
		return;
	}
	if (pipe2(pfd, O_CLOEXEC) < 0) {
		send_error(id, -32603, "INTERNAL_ERROR", "pipe() failed", NULL);
		return;
	}

	pid = fork();
	if (pid < 0) {
		close(pfd[0]);
		close(pfd[1]);
		send_error(id, -32603, "INTERNAL_ERROR", "fork() failed", NULL);
		return;
	}
	if (pid == 0) {
		struct rlimit rl = { FSIZE_LIMIT, FSIZE_LIMIT };
		int devnull = open("/dev/null", O_RDONLY);
		/* rund ignores SIGPIPE for its socket writes, and an ignored
		 * disposition survives exec: without this reset, `yes | head`
		 * never dies of a closed pipe and every such job runs to its
		 * timeout instead (found by the first smoke test). */
		signal(SIGPIPE, SIG_DFL);
		setsid(); /* its own process group: one kill reaps the whole tree */
		if (devnull >= 0) dup2(devnull, 0);
		dup2(pfd[1], 1);
		dup2(pfd[1], 2);
		setrlimit(RLIMIT_FSIZE, &rl);
		/* agentd's environment story, kept identical for the Phase 2 swap. */
		setenv("CURL_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt", 1);
		setenv("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt", 1);
		setenv("SSL_CERT_DIR", "/etc/ssl/certs", 1);
		if (chdir(cwd && cwd[0] ? cwd : "/data") < 0) {
			if (chdir("/") < 0) _exit(126);
		}
		if (!strcmp(mode, "command")) execl("/bin/sh", "sh", "-c", arg, (char *)NULL);
		else execl("/bin/sh", "sh", arg, (char *)NULL);
		_exit(127);
	}

	close(pfd[1]);
	fcntl(pfd[0], F_SETFL, O_NONBLOCK);
	memset(j, 0, sizeof(*j));
	j->used = 1;
	snprintf(j->id, sizeof(j->id), "%s", id);
	j->pid = pid;
	j->out_fd = pfd[0];
	j->out = malloc(OUT_HARD_CAP);
	if (!j->out) {
		kill(-pid, SIGKILL);
		close(pfd[0]);
		j->used = 0;
		send_error(id, -32603, "INTERNAL_ERROR", "out of memory for the output buffer", NULL);
		return;
	}
	j->kill_at = now_ms() + timeout_ms;
}

static void handle_proc_run(const char *id, const char *json, int len) {
	int ps, pe, vs, ve;
	static char command[LINE_CAP];
	char cwd[256] = "";
	char script[300] = "";
	long long timeout_ms = DEFAULT_TIMEOUT_MS;

	if (jl_obj_get(json, len, "params", &ps, &pe) != 1) {
		send_error(id, -32602, "INVALID_PARAMS", "params must be an object", NULL);
		return;
	}
	if (jl_obj_get(json + ps, pe - ps, "timeoutMs", &vs, &ve) == 1) {
		timeout_ms = jl_num(json + ps, vs, ve, DEFAULT_TIMEOUT_MS);
		if (timeout_ms < 1000) timeout_ms = 1000;
		if (timeout_ms > MAX_TIMEOUT_MS) timeout_ms = MAX_TIMEOUT_MS;
	}
	if (jl_obj_get(json + ps, pe - ps, "cwd", &vs, &ve) == 1) {
		if (jl_str_decode(json + ps, vs, ve, cwd, sizeof(cwd)) < 0) {
			send_error(id, -32602, "INVALID_PARAMS", "cwd is not a usable string", NULL);
			return;
		}
	}

	if (jl_obj_get(json + ps, pe - ps, "scriptRef", &vs, &ve) == 1) {
		int fs, fe;
		long long declared = -1;
		struct stat st;
		const char *ref = json + ps + vs;
		int ref_len = ve - vs;
		if (jl_obj_get(ref, ref_len, "path", &fs, &fe) != 1 ||
		    jl_str_decode(ref, fs, fe, script, sizeof(script)) < 0) {
			send_error(id, 1005, "RESOURCE_INVALID", "scriptRef.path is missing or unusable", NULL);
			return;
		}
		if (jl_obj_get(ref, ref_len, "size", &fs, &fe) == 1) declared = jl_num(ref, fs, fe, -1);
		if (strncmp(script, TMP_DIR "/", strlen(TMP_DIR) + 1) || strstr(script, "..") ||
		    strchr(script + strlen(TMP_DIR) + 1, '/')) {
			send_error(id, 1005, "RESOURCE_INVALID", "scriptRef.path must name a file directly under " TMP_DIR,
			           "stage the script there first (the page's file tools do)");
			return;
		}
		if (stat(script, &st) < 0 || !S_ISREG(st.st_mode)) {
			send_error(id, 1005, "RESOURCE_INVALID", "scriptRef.path does not exist",
			           data_mounted() ? "was it deleted?" : "no /data is mounted on this boot");
			return;
		}
		if (declared >= 0 && st.st_size != (off_t)declared) {
			send_error(id, 1005, "RESOURCE_INVALID", "scriptRef.size does not match the staged file",
			           "the writer and the caller disagree; re-stage it");
			return;
		}
		job_spawn(id, "script", script, cwd, timeout_ms);
		return;
	}

	if (jl_obj_get(json + ps, pe - ps, "command", &vs, &ve) == 1) {
		if (jl_str_decode(json + ps, vs, ve, command, sizeof(command)) < 0) {
			send_error(id, -32602, "INVALID_PARAMS", "command is not a usable string", NULL);
			return;
		}
		if (!command[0]) {
			send_error(id, -32602, "INVALID_PARAMS", "command is empty", NULL);
			return;
		}
		job_spawn(id, "command", command, cwd, timeout_ms);
		return;
	}

	send_error(id, -32602, "INVALID_PARAMS", "proc.run wants command or scriptRef",
	           "short commands inline; long scripts stage under " TMP_DIR " and ride scriptRef");
}

/* ── finishing a job ── */

static void sanitize_id(const char *id, char *out, int cap) {
	int i, at = 0;
	for (i = 0; id[i] && at < cap - 1; i++) {
		char c = id[i];
		out[at++] = ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
		             c == '.' || c == '-' || c == '_')
		                ? c
		                : '_';
	}
	out[at] = 0;
}

static void job_finish(struct job *j) {
	int st = 0, exit_code;
	char body[8192];
	int at;

	close(j->out_fd);
	if (waitpid(j->pid, &st, 0) < 0) st = 0;
	/* The group may hold stragglers; the pipe's EOF says they closed their
	 * stdout, which is all the protocol waits for. */
	exit_code = WIFEXITED(st) ? WEXITSTATUS(st) : (WIFSIGNALED(st) ? 128 + WTERMSIG(st) : 125);

	if (j->cancelled) {
		send_error(j->id, 1002, "CANCELLED", "the process group was killed on request", NULL);
		goto done;
	}

	at = snprintf(body, sizeof(body), "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"exitCode\":%d",
	              j->id, exit_code);
	if (j->timed_out) at += snprintf(body + at, sizeof(body) - (size_t)at, ",\"timedOut\":true");

	if (j->outlen <= INLINE_MAX && j->dropped == 0) {
		char enc[INLINE_MAX * 6 + 8];
		if (jl_utf8_valid((unsigned char *)j->out, j->outlen)) {
			int n = jl_str_encode(j->out, j->outlen, enc, (int)sizeof(enc));
			if (n > 0) at += snprintf(body + at, sizeof(body) - (size_t)at, ",\"stdout\":%.*s", n, enc);
		} else {
			int n = jl_b64_encode((unsigned char *)j->out, j->outlen, enc, (int)sizeof(enc));
			if (n > 0)
				at += snprintf(body + at, sizeof(body) - (size_t)at, ",\"stdoutB64\":\"%.*s\"", n, enc);
		}
		at += snprintf(body + at, sizeof(body) - (size_t)at, "}}");
		if (at < (int)sizeof(body)) send_line(body, at);
		goto done;
	}

	/* Oversized: the full bytes belong to the data plane. */
	if (!data_mounted()) {
		send_error(j->id, 1004, "DATA_PLANE_UNAVAILABLE",
		           "the output outgrew the inline budget and no /data is mounted to carry it",
		           "mount /data (the page does when it has a filesystem) or make the command quieter");
		goto done;
	}
	{
		char safe[96], path[160];
		FILE *f;
		int head, n;
		char enc[INLINE_MAX * 6 + 8];
		mkdir("/data/.vinx", 0755);
		mkdir(TMP_DIR, 0755);
		sanitize_id(j->id, safe, (int)sizeof(safe));
		snprintf(path, sizeof(path), TMP_DIR "/proc-%s.out", safe);
		f = fopen(path, "w");
		if (!f || fwrite(j->out, 1, (size_t)j->outlen, f) != (size_t)j->outlen) {
			if (f) fclose(f);
			send_error(j->id, 1004, "DATA_PLANE_UNAVAILABLE", "writing the output to /data failed",
			           "is the 9p mount healthy?");
			goto done;
		}
		fclose(f);

		head = jl_utf8_cut((unsigned char *)j->out, j->outlen, INLINE_MAX);
		if (jl_utf8_valid((unsigned char *)j->out, head)) {
			n = jl_str_encode(j->out, head, enc, (int)sizeof(enc));
			if (n > 0) at += snprintf(body + at, sizeof(body) - (size_t)at, ",\"stdout\":%.*s", n, enc);
		}
		at += snprintf(body + at, sizeof(body) - (size_t)at,
		               ",\"truncated\":true,\"output\":{\"path\":\"%s\",\"size\":%d,\"owner\":\"caller\",\"expiresWithSession\":true}",
		               path, j->outlen);
		if (j->dropped > 0)
			at += snprintf(body + at, sizeof(body) - (size_t)at, ",\"droppedBytes\":%lld", j->dropped);
		at += snprintf(body + at, sizeof(body) - (size_t)at, "}}");
		if (at < (int)sizeof(body)) send_line(body, at);
	}

done:
	free(j->out);
	j->used = 0;
}

static void job_read(struct job *j) {
	for (;;) {
		char waste[4096];
		char *dst = j->outlen < OUT_HARD_CAP ? j->out + j->outlen : waste;
		size_t room = j->outlen < OUT_HARD_CAP ? (size_t)(OUT_HARD_CAP - j->outlen) : sizeof(waste);
		ssize_t r = read(j->out_fd, dst, room);
		if (r < 0) {
			if (errno == EINTR) continue;
			return; /* EAGAIN: drained for now */
		}
		if (r == 0) {
			job_finish(j);
			return;
		}
		if (dst == waste) j->dropped += r;
		else j->outlen += (int)r;
	}
}

static void job_cancel(const char *target) {
	int i;
	for (i = 0; i < MAX_JOBS; i++) {
		if (jobs[i].used && !strcmp(jobs[i].id, target)) {
			jobs[i].cancelled = 1;
			kill(-jobs[i].pid, SIGKILL);
			return;
		}
	}
}

static void kill_all_jobs(void) {
	int i;
	for (i = 0; i < MAX_JOBS; i++) {
		if (!jobs[i].used) continue;
		kill(-jobs[i].pid, SIGKILL);
		close(jobs[i].out_fd);
		waitpid(jobs[i].pid, NULL, 0);
		free(jobs[i].out);
		jobs[i].used = 0;
	}
}

/* ── services (§9.3): the app.* lifecycle ── */

/* App ids are package-name shaped: lowercase, digits, inner dashes, short.
 * Checked here as well as in app(1) -- the id becomes filesystem paths. */
static int valid_app_id(const char *s) {
	int i;
	if (!s[0] || s[0] == '-') return 0;
	for (i = 0; s[i]; i++) {
		char c = s[i];
		if (i >= 32) return 0;
		if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return 0;
	}
	return 1;
}

/* One small file on the observation surface (state/pid/exit). /run is
 * tmpfs with one writer (control stays on this socket -- §9.3), so a
 * truncating rewrite is enough. */
static void svc_file(const char *sid, const char *leaf, const char *text) {
	char path[160];
	FILE *f;
	mkdir("/run/vinx", 0755);
	mkdir(APPS_RUN_DIR, 0755);
	snprintf(path, sizeof(path), APPS_RUN_DIR "/%s", sid);
	mkdir(path, 0755);
	snprintf(path, sizeof(path), APPS_RUN_DIR "/%s/%s", sid, leaf);
	f = fopen(path, "w");
	if (!f) return;
	fputs(text, f);
	fputc('\n', f);
	fclose(f);
}

/* What status/list report and the state file says. A not-running service
 * is `stopped` (or `failed` after a crash loop); exits are recorded by the
 * reaper. */
static const char *svc_state_name(const struct service *s) {
	if (s->pid > 0) return s->stopping ? "stopping" : "running";
	if (s->failed) return "failed";
	return "stopped";
}

static struct service *svc_find(const char *sid) {
	int i;
	for (i = 0; i < MAX_SERVICES; i++)
		if (services[i].used && !strcmp(services[i].sid, sid)) return &services[i];
	return NULL;
}

static struct service *svc_slot(const char *sid) {
	struct service *s = svc_find(sid);
	int i;
	if (s) return s;
	for (i = 0; i < MAX_SERVICES; i++) {
		if (services[i].used) continue;
		s = &services[i];
		memset(s, 0, sizeof(*s));
		s->used = 1;
		snprintf(s->sid, sizeof(s->sid), "%s", sid);
		return s;
	}
	return NULL;
}

/* Is this id on the user's enable list? Read fresh each time -- the list
 * is a /data file app(1) edits; caching it would just add a staleness
 * window to a sub-millisecond read. */
static int svc_enabled(const char *sid) {
	FILE *f = fopen(ENABLED_FILE, "r");
	char line[64];
	int hit = 0;
	if (!f) return 0;
	while (fgets(line, sizeof(line), f)) {
		line[strcspn(line, "\r\n")] = 0;
		if (!strcmp(line, sid)) {
			hit = 1;
			break;
		}
	}
	fclose(f);
	return hit;
}

/* Fork one service through app-run(8): its own session/group, stdin from
 * /dev/null, stdout+stderr appended to the log -- a daemon's environment,
 * not a captured pipe (§9.3). The child owns the log fd from here on, so
 * a dead rund costs no log lines.
 *
 * The PTY variant (§6.9, app.start {pty:true}): openpty here, the child
 * takes the slave as its controlling tty (login_tty: setsid + TIOCSCTTY +
 * stdin/out/err), and the master rides a stream.open call to rpcd over a
 * short-lived librpc connection with SCM_RIGHTS -- a local-socket round
 * trip rpcd answers itself in microseconds, so the loop is not stalled.
 * After the handoff rpcd owns the pumping; rund closes its copy. The app's
 * output goes to the window, not the log -- terminal semantics; the log
 * keeps rund's own trail. Returns 0, -1 (fork machinery), or -2 (no
 * stream: usually no page session to open a window on). */
static int svc_spawn(struct service *s) {
	char logpath[160];
	char pidtext[24];
	int logfd = -1;
	int master = -1, slave = -1;
	pid_t pid;

	svc_file(s->sid, "state", "starting"); /* also mkdirs the surface */
	if (!s->pty) {
		snprintf(logpath, sizeof(logpath), APPS_RUN_DIR "/%s/log", s->sid);
		logfd = open(logpath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
		if (logfd < 0) return -1;
	} else {
		struct winsize ws;
		memset(&ws, 0, sizeof(ws));
		ws.ws_col = 80;
		ws.ws_row = 24;
		if (openpty(&master, &slave, NULL, NULL, &ws) < 0) {
			logline("app %s: openpty failed (%d)", s->sid, errno);
			return -1;
		}
		fcntl(master, F_SETFD, FD_CLOEXEC);
	}

	pid = fork();
	if (pid < 0) {
		if (logfd >= 0) close(logfd);
		if (master >= 0) close(master);
		if (slave >= 0) close(slave);
		return -1;
	}
	if (pid == 0) {
		signal(SIGPIPE, SIG_DFL);
		if (s->pty) {
			close(master);
			if (login_tty(slave) < 0) _exit(126);
			setenv("TERM", "xterm", 1);
		} else {
			int devnull = open("/dev/null", O_RDONLY);
			setsid();
			if (devnull >= 0) dup2(devnull, 0);
			dup2(logfd, 1);
			dup2(logfd, 2);
		}
		setenv("CURL_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt", 1);
		setenv("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt", 1);
		setenv("SSL_CERT_DIR", "/etc/ssl/certs", 1);
		execl("/usr/sbin/app-run", "app-run", s->sid, (char *)NULL);
		_exit(127);
	}
	if (logfd >= 0) close(logfd);
	if (slave >= 0) close(slave);

	if (s->pty) {
		char params[128], sid_enc[96];
		char *result = NULL;
		struct vinx_error err;
		int se = jl_str_encode(s->sid, (int)strlen(s->sid), sid_enc, (int)sizeof(sid_enc));
		int rc = -1;
		if (se > 0) {
			sid_enc[se] = 0;
			snprintf(params, sizeof(params), "{\"app\":%s,\"cols\":80,\"rows\":24}", sid_enc);
			rc = vinx_call_deadline_fd("stream.open", params, 5000, master, &result, &err);
		}
		close(master); /* rpcd holds its own duplicate now (or nobody does) */
		if (rc != 0) {
			logline("app %s: stream.open failed (%s); killing the spawn",
			        s->sid, se > 0 ? err.name : "bad id");
			kill(-pid, SIGKILL);
			waitpid(pid, NULL, 0);
			svc_file(s->sid, "state", "stopped");
			svc_file(s->sid, "pid", "");
			free(result);
			return -2;
		}
		{
			int vs, ve;
			long long stream_id = -1;
			if (result && jl_obj_get(result, (int)strlen(result), "id", &vs, &ve) == 1)
				stream_id = jl_num(result, vs, ve, -1);
			logline("app %s: pty stream %lld opened", s->sid, stream_id);
		}
		free(result);
	}

	s->pid = pid;
	s->adopted = 0;
	s->started_at = now_ms();
	s->stopping = 0;
	s->kill_at = 0;
	s->stop_reply[0] = 0;
	snprintf(pidtext, sizeof(pidtext), "%d", (int)pid);
	svc_file(s->sid, "pid", pidtext);
	svc_file(s->sid, "state", "running");
	logline("app %s: started pid %d%s", s->sid, (int)pid, s->pty ? " (pty window)" : "");
	return 0;
}

static void svc_send_status(const char *id, const struct service *s, const char *sid) {
	char body[512];
	int n;
	const char *state = s ? svc_state_name(s) : "stopped";
	if (s && s->pid > 0) {
		n = snprintf(body, sizeof(body),
		             "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"id\":\"%s\",\"state\":\"%s\",\"pid\":%d,"
		             "\"restarts\":%d,\"enabled\":%s}}",
		             id, sid, state, (int)s->pid, s->restarts, svc_enabled(sid) ? "true" : "false");
	} else {
		n = snprintf(body, sizeof(body),
		             "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"id\":\"%s\",\"state\":\"%s\","
		             "\"restarts\":%d,\"enabled\":%s}}",
		             id, sid, state, s ? s->restarts : 0, svc_enabled(sid) ? "true" : "false");
	}
	if (n > 0 && n < (int)sizeof(body)) send_line(body, n);
}

/* The id param every app.* method (except list) wants. */
static int app_id_param(const char *id, const char *json, int len, char *sid, int cap) {
	int ps, pe, vs, ve;
	if (jl_obj_get(json, len, "params", &ps, &pe) != 1 ||
	    jl_obj_get(json + ps, pe - ps, "id", &vs, &ve) != 1 ||
	    jl_str_decode(json + ps, vs, ve, sid, cap) < 0 || !valid_app_id(sid)) {
		send_error(id, -32602, "INVALID_PARAMS", "this method wants {id}: a lowercase app id",
		           "letters, digits and dashes, at most 32");
		return -1;
	}
	return 0;
}

static void handle_app_start(const char *id, const char *json, int len) {
	char sid[40];
	char vapp[160];
	struct stat st;
	struct service *s;
	int want_pty = 0;
	int rc;
	if (app_id_param(id, json, len, sid, (int)sizeof(sid)) < 0) return;
	{
		int ps, pe, vs, ve;
		if (jl_obj_get(json, len, "params", &ps, &pe) == 1 &&
		    jl_obj_get(json + ps, pe - ps, "pty", &vs, &ve) == 1 &&
		    ve - vs == 4 && !strncmp(json + ps + vs, "true", 4))
			want_pty = 1;
	}
	snprintf(vapp, sizeof(vapp), APPS_DATA_DIR "/%s.vapp", sid);
	if (stat(vapp, &st) < 0 || !S_ISREG(st.st_mode)) {
		send_error(id, 1005, "RESOURCE_INVALID", "no such installed app",
		           data_mounted() ? "app install FILE.vapp first (app list shows what is here)"
		                          : "no /data is mounted on this boot");
		return;
	}
	s = svc_slot(sid);
	if (!s) {
		send_error(id, 1006, "OVERLOADED", "8 services already managed", "app stop one first");
		return;
	}
	if (s->pid > 0) {
		svc_send_status(id, s, sid); /* already running: an answer, not an error */
		return;
	}
	/* A start by hand resets the crash ledger and the manual-stop latch. */
	s->failed = 0;
	s->restarts = 0;
	s->restart_at = 0;
	s->manual_stop = 0;
	s->pty = want_pty;
	rc = svc_spawn(s);
	if (rc == -2) {
		send_error(id, 1001, "UNAVAILABLE", "no terminal window could open",
		           "a PTY app wants a page session (is a browser showing this machine?)");
		return;
	}
	if (rc < 0) {
		send_error(id, -32603, "INTERNAL_ERROR", "could not fork the service", NULL);
		return;
	}
	svc_send_status(id, s, sid);
}

static void handle_app_stop(const char *id, const char *json, int len) {
	char sid[40];
	struct service *s;
	if (app_id_param(id, json, len, sid, (int)sizeof(sid)) < 0) return;
	s = svc_find(sid);
	if (!s || s->pid <= 0) {
		if (s) {
			s->manual_stop = 1;
			s->restart_at = 0;
		}
		svc_send_status(id, s, sid); /* already stopped: idempotent */
		return;
	}
	s->manual_stop = 1;
	s->restart_at = 0;
	if (!s->stopping) {
		s->stopping = 1;
		s->kill_at = now_ms() + STOP_GRACE_MS;
		kill(-s->pid, SIGTERM);
		svc_file(s->sid, "state", "stopping");
		logline("app %s: stop requested (TERM to group %d)", s->sid, (int)s->pid);
	}
	/* The reply lands when the exit does -- stop means stopped, not asked. */
	snprintf(s->stop_reply, sizeof(s->stop_reply), "%s", id);
}

static void handle_app_status(const char *id, const char *json, int len) {
	char sid[40];
	if (app_id_param(id, json, len, sid, (int)sizeof(sid)) < 0) return;
	svc_send_status(id, svc_find(sid), sid);
}

/* The app's manifest kind (command|service|window). The install writes it
 * beside the package (/data/apps/<id>.kind) exactly so it is knowable
 * before anything ran this boot; the tree app-run unpacked is the
 * fallback for a package installed before the sidecar existed. Returns 0
 * with `out` filled, -1 when neither source has it. */
static int app_kind(const char *sid, char *out, int outsz) {
	char path[160];
	char buf[2048];
	int fd, n, vs, ve;
	snprintf(path, sizeof(path), APPS_DATA_DIR "/%s.kind", sid);
	fd = open(path, O_RDONLY);
	if (fd >= 0) {
		n = (int)read(fd, buf, sizeof(buf) - 1);
		close(fd);
		if (n > 0) {
			buf[n] = 0;
			buf[strcspn(buf, "\r\n")] = 0;
			if (buf[0] && (int)strlen(buf) < outsz && !strpbrk(buf, "\"\\")) {
				snprintf(out, (size_t)outsz, "%s", buf);
				return 0;
			}
		}
	}
	snprintf(path, sizeof(path), "/run/vinx/pkg/%s/app.json", sid);
	fd = open(path, O_RDONLY);
	if (fd < 0) return -1;
	n = (int)read(fd, buf, sizeof(buf) - 1);
	close(fd);
	if (n <= 0) return -1;
	buf[n] = 0;
	if (jl_obj_get(buf, n, "kind", &vs, &ve) != 1 || !jl_is_str(buf, vs, ve)) return -1;
	if (jl_str_decode(buf, vs, ve, out, outsz) < 0) return -1;
	return 0;
}

/* A command app runs to completion; there is nothing to supervise (§9.3's
 * supervision is for services). Unknown kinds are services -- that was the
 * only behaviour before kinds were told apart, and a package installed
 * before the sidecar existed keeps it. */
static int app_is_command(const char *sid) {
	char kind[16];
	return app_kind(sid, kind, (int)sizeof(kind)) == 0 && !strcmp(kind, "command");
}

/* A pure web app -- kind window, ui web, no exec -- is a window on the
 * desktop and nothing else: no process for this rund to start or watch.
 * The install (guest `app install`, or the page's own for a package it
 * wrote) marks one with a sidecar beside the package
 * (/data/apps/<id>.web) so the enabled sweep can tell it apart from a
 * window app with a backend without opening the package. Enabled, it
 * means "the desktop opens it when the page loads" (§10.7), which the
 * page does from its mirror -- machine on or off. */
static int app_is_pure_web(const char *sid) {
	char path[160];
	snprintf(path, sizeof(path), APPS_DATA_DIR "/%s.web", sid);
	return access(path, F_OK) == 0;
}

/* app.list: the union of what is installed (/data/apps/*.vapp), what is
 * enabled, and what this rund currently manages. */
static void handle_app_list(const char *id) {
	char body[4096];
	char seen[24][40];
	int nseen = 0, at, i;
	DIR *d;

	at = snprintf(body, sizeof(body), "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"apps\":[", id);

	for (i = 0; i < MAX_SERVICES && nseen < 24; i++) {
		if (!services[i].used) continue;
		/* A slot whose package left (app remove) and whose process is
		 * gone is history, not an installed app — the CLI's remove
		 * cannot clear the slot (it lives in this rund), so the list
		 * skips the ghost. Still running with the package gone stays
		 * listed: the process is real until it exits. */
		if (services[i].pid <= 0) {
			char vapp[160];
			struct stat st;
			snprintf(vapp, sizeof(vapp), APPS_DATA_DIR "/%s.vapp", services[i].sid);
			if (stat(vapp, &st) < 0) continue;
		}
		snprintf(seen[nseen], sizeof(seen[0]), "%s", services[i].sid);
		nseen++;
	}
	d = opendir(APPS_DATA_DIR);
	if (d) {
		struct dirent *e;
		while ((e = readdir(d)) && nseen < 24) {
			char sid[40];
			size_t n = strlen(e->d_name);
			int k, dup = 0;
			if (n < 6 || n - 5 >= sizeof(sid) || strcmp(e->d_name + n - 5, ".vapp")) continue;
			memcpy(sid, e->d_name, n - 5);
			sid[n - 5] = 0;
			if (!valid_app_id(sid)) continue;
			for (k = 0; k < nseen; k++)
				if (!strcmp(seen[k], sid)) dup = 1;
			if (dup) continue;
			snprintf(seen[nseen], sizeof(seen[0]), "%s", sid);
			nseen++;
		}
		closedir(d);
	}

	for (i = 0; i < nseen; i++) {
		const struct service *s = svc_find(seen[i]);
		char kind[16] = "";
		char vapp[160];
		struct stat st;
		long long size = 0;
		snprintf(vapp, sizeof(vapp), APPS_DATA_DIR "/%s.vapp", seen[i]);
		if (stat(vapp, &st) == 0 && S_ISREG(st.st_mode)) size = (long long)st.st_size;
		at += snprintf(body + at, sizeof(body) - (size_t)at,
		               "%s{\"id\":\"%s\",\"state\":\"%s\",\"enabled\":%s,\"size\":%lld",
		               i ? "," : "", seen[i], s ? svc_state_name(s) : "stopped",
		               svc_enabled(seen[i]) ? "true" : "false", size);
		if (app_kind(seen[i], kind, (int)sizeof(kind)) == 0)
			at += snprintf(body + at, sizeof(body) - (size_t)at, ",\"kind\":\"%s\"", kind);
		/* Only when it is one: the page's lists read absence as "not". */
		if (app_is_pure_web(seen[i]))
			at += snprintf(body + at, sizeof(body) - (size_t)at, ",\"web\":true");
		at += snprintf(body + at, sizeof(body) - (size_t)at, "}");
		if (at >= (int)sizeof(body) - 96) break; /* full page; list stays honest but bounded */
	}
	at += snprintf(body + at, sizeof(body) - (size_t)at, "]}}");
	if (at > 0 && at < (int)sizeof(body)) send_line(body, at);
}

/* An exited service: record the exit, then either reschedule (enabled,
 * crashed fast a bounded number of times) or park. `code` < 0 = unknown
 * (an adopted orphan we could not waitpid). */
static void svc_exited(struct service *s, int code) {
	char text[24];
	long long alive = now_ms() - s->started_at;
	s->pid = 0;
	s->adopted = 0;
	if (code >= 0) snprintf(text, sizeof(text), "%d", code);
	else snprintf(text, sizeof(text), "unknown");
	svc_file(s->sid, "exit", text);
	svc_file(s->sid, "pid", "");

	/* The event (§10.7 via §6.7): subscribers -- the page annotating a
	 * window, a console `rpc watch` -- hear the exit as it lands. The
	 * state files above stay the poll-side truth. */
	{
		char sid_enc[96], ev[256];
		int se = jl_str_encode(s->sid, (int)strlen(s->sid), sid_enc, (int)sizeof(sid_enc));
		if (se > 0) {
			int n;
			sid_enc[se] = 0;
			if (code >= 0)
				n = snprintf(ev, sizeof(ev),
				             "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.emit\",\"params\":{\"topic\":\"app.exited\",\"data\":{\"id\":%s,\"code\":%d}}}",
				             sid_enc, code);
			else
				n = snprintf(ev, sizeof(ev),
				             "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.emit\",\"params\":{\"topic\":\"app.exited\",\"data\":{\"id\":%s,\"code\":null}}}",
				             sid_enc);
			if (n > 0 && n < (int)sizeof(ev)) send_line(ev, n);
		}
	}

	if (s->stopping || s->manual_stop) {
		s->stopping = 0;
		svc_file(s->sid, "state", "stopped");
		logline("app %s: stopped (exit %s)", s->sid, text);
	} else if (app_is_command(s->sid)) {
		/* A command ran to its end: that is the whole plan. Its exit code
		 * is on record (exit file, app.exited above); re-running a program
		 * that finished -- well or badly -- is not supervision, it is a
		 * loop nobody asked for. Enabled, it runs once per boot (the
		 * sweep). */
		svc_file(s->sid, "state", "stopped");
		logline("app %s: finished (exit %s)", s->sid, text);
	} else {
		/* A crash. Fast ones count toward the give-up threshold; a run
		 * that lived a while starts a fresh ledger. */
		s->restarts = (alive < CRASH_FAST_MS) ? s->restarts + 1 : 1;
		if (s->restarts > CRASH_MAX) {
			s->failed = 1;
			s->restart_at = 0;
			svc_file(s->sid, "state", "failed");
			logline("app %s: %d fast crashes; parked as failed (app start resets)", s->sid,
			        s->restarts - 1);
		} else {
			long long backoff = 1000LL << s->restarts; /* 2s, 4s, ... */
			if (backoff > 60000) backoff = 60000;
			s->restart_at = now_ms() + backoff;
			svc_file(s->sid, "state", "crashed");
			logline("app %s: exit %s after %lldms; retry in %lldms (attempt %d)", s->sid, text,
			        alive, backoff, s->restarts);
		}
	}
	if (s->stop_reply[0]) {
		char idbuf[80];
		snprintf(idbuf, sizeof(idbuf), "%s", s->stop_reply);
		s->stop_reply[0] = 0;
		svc_send_status(idbuf, s, s->sid);
	}
}

/* Every loop: reap our own children (WNOHANG is cheap); probe adopted
 * orphans (not our children -- kill(pid,0) is all the truth there is). */
static void reap_services(void) {
	int i;
	for (i = 0; i < MAX_SERVICES; i++) {
		struct service *s = &services[i];
		if (!s->used || s->pid <= 0) continue;
		if (s->adopted) {
			if (kill(s->pid, 0) < 0 && errno == ESRCH) svc_exited(s, -1);
			continue;
		}
		{
			int st;
			pid_t got = waitpid(s->pid, &st, WNOHANG);
			if (got == s->pid) {
				int code = WIFEXITED(st) ? WEXITSTATUS(st)
				                         : (WIFSIGNALED(st) ? 128 + WTERMSIG(st) : 125);
				svc_exited(s, code);
			}
		}
	}
}

/* The periodic sweep: escalate overdue stops, recycle slots whose app is
 * gone, start what the enable list says should run (including after the
 * page restored /data/apps on a fresh boot -- this tick IS the autostart),
 * and retry due backoffs. */
static void sweep_services(void) {
	long long t = now_ms();
	int i;
	FILE *f;

	for (i = 0; i < MAX_SERVICES; i++) {
		struct service *s = &services[i];
		if (s->used && s->pid > 0 && s->stopping && t >= s->kill_at) {
			kill(-s->pid, SIGKILL);
			s->kill_at = t + STOP_GRACE_MS; /* re-arm; the reaper ends it */
		}
		/* An idle slot whose package left (app remove) is history: free it,
		 * or eight removed demos would refuse the ninth start until a
		 * reboot. Running with the package gone stays: the process is
		 * real until it exits, and the reaper needs the slot to say so. */
		if (s->used && s->pid <= 0) {
			char vapp[160];
			struct stat st;
			snprintf(vapp, sizeof(vapp), APPS_DATA_DIR "/%s.vapp", s->sid);
			if (stat(vapp, &st) < 0) {
				logline("app %s: package gone; slot released", s->sid);
				memset(s, 0, sizeof(*s));
			}
		}
	}

	f = fopen(ENABLED_FILE, "r");
	if (f) {
		char line[64];
		while (fgets(line, sizeof(line), f)) {
			struct service *s;
			struct stat st;
			char vapp[160];
			line[strcspn(line, "\r\n")] = 0;
			if (!valid_app_id(line)) continue;
			snprintf(vapp, sizeof(vapp), APPS_DATA_DIR "/%s.vapp", line);
			if (stat(vapp, &st) < 0) continue; /* not restored/installed yet */
			/* A pure web app's autostart is the desktop's (it opens the
			 * window when the page loads); there is no process here, and
			 * spawning its app-run would pop the window and read as a
			 * crash. Skipped before it takes a slot. */
			if (app_is_pure_web(line)) continue;
			s = svc_slot(line);
			if (!s || s->pid > 0 || s->failed || s->manual_stop) continue;
			if (s->restart_at && t < s->restart_at) continue;
			/* An enabled command runs once per boot, not once per tick:
			 * a slot that has started anything is one that already did. */
			if (s->started_at && app_is_command(s->sid)) continue;
			s->restart_at = 0;
			if (svc_spawn(s) < 0) logline("app %s: autostart fork failed", s->sid);
		}
		fclose(f);
	}
}

/* A respawned rund re-adopts what the pid files say is alive, and corrects
 * what they say about the dead (§9.3: recover or clean up the truth --
 * inventing nothing either way). */
static void recover_services(void) {
	DIR *d = opendir(APPS_RUN_DIR);
	struct dirent *e;
	if (!d) return;
	while ((e = readdir(d))) {
		char path[192];
		char buf[24];
		FILE *f;
		long pid = 0;
		struct service *s;
		if (!valid_app_id(e->d_name)) continue;
		snprintf(path, sizeof(path), APPS_RUN_DIR "/%s/pid", e->d_name);
		f = fopen(path, "r");
		if (!f) continue;
		if (fgets(buf, sizeof(buf), f)) pid = atol(buf);
		fclose(f);
		if (pid > 1 && kill((pid_t)pid, 0) == 0) {
			s = svc_slot(e->d_name);
			if (!s) continue;
			s->pid = (pid_t)pid;
			s->adopted = 1;
			s->started_at = now_ms();
			svc_file(s->sid, "state", "running");
			logline("app %s: adopted running pid %ld from a previous rund", s->sid, pid);
		} else if (pid > 1) {
			svc_file(e->d_name, "state", "stopped");
			svc_file(e->d_name, "exit", "unknown");
			svc_file(e->d_name, "pid", "");
			logline("app %s: pid %ld from a previous rund is gone; marked stopped", e->d_name, pid);
		}
	}
	closedir(d);
}

/* ── proc.pty: a shell in a terminal window (§6.9) ── */

/* Spawn a login shell (or `sh -lc COMMAND`) on a fresh PTY and hand the
 * master to rpcd as a stream — the desktop opens a terminal window over
 * it, exactly the machinery a tty app rides (svc_spawn's pty branch),
 * minus the supervision: no restarts, no state files. The stream is
 * marked unmanaged so the page knows closing the window means
 * stream.close (HUP to the shell), not app.stop. */
static void handle_proc_pty(const char *id, const char *json, int len) {
	char command[2048] = "";
	struct ptyshell *p = NULL;
	int master = -1, slave = -1;
	struct winsize ws;
	pid_t pid;
	int i;

	for (i = 0; i < MAX_PTYS; i++)
		if (!ptys[i].used) {
			p = &ptys[i];
			break;
		}
	if (!p) {
		send_error(id, 1006, "OVERLOADED", "8 shell windows already open", "close one first");
		return;
	}
	{
		int ps, pe, vs, ve;
		if (jl_obj_get(json, len, "params", &ps, &pe) == 1 &&
		    jl_obj_get(json + ps, pe - ps, "command", &vs, &ve) == 1 &&
		    jl_is_str(json + ps, vs, ve)) {
			if (jl_str_decode(json + ps, vs, ve, command, sizeof(command)) < 0) {
				send_error(id, -32602, "INVALID_PARAMS", "command does not fit (2 KiB)",
				           "long scripts belong in a file; run that");
				return;
			}
		}
	}

	memset(&ws, 0, sizeof(ws));
	ws.ws_col = 80;
	ws.ws_row = 24;
	if (openpty(&master, &slave, NULL, NULL, &ws) < 0) {
		send_error(id, -32603, "INTERNAL_ERROR", "openpty failed", NULL);
		return;
	}
	fcntl(master, F_SETFD, FD_CLOEXEC);

	pid = fork();
	if (pid < 0) {
		close(master);
		close(slave);
		send_error(id, -32603, "INTERNAL_ERROR", "fork() failed", NULL);
		return;
	}
	if (pid == 0) {
		signal(SIGPIPE, SIG_DFL);
		close(master);
		if (login_tty(slave) < 0) _exit(126);
		/* The same environment console-shell exports on ttyS0: without
		 * HOME the login shell never sources /root/.profile, and the
		 * prompt falls back from root@vinx:/data# to the busybox stock. */
		setenv("HOME", "/root", 1);
		setenv("TERM", "xterm-256color", 1);
		setenv("LANG", "C.UTF-8", 1);
		setenv("COLORTERM", "truecolor", 1);
		setenv("CURL_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt", 1);
		setenv("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt", 1);
		setenv("SSL_CERT_DIR", "/etc/ssl/certs", 1);
		if (chdir("/data") < 0 && chdir("/") < 0) _exit(126);
		/* A login shell: /etc/profile runs, the banner greets the window. */
		if (command[0]) execl("/bin/sh", "sh", "-lc", command, (char *)NULL);
		else execl("/bin/sh", "sh", "-l", (char *)NULL);
		_exit(127);
	}
	close(slave);

	{
		char *result = NULL;
		struct vinx_error err;
		long long stream_id = -1;
		int rc = vinx_call_deadline_fd("stream.open",
		                               "{\"app\":\"shell\",\"cols\":80,\"rows\":24,\"unmanaged\":true}",
		                               5000, master, &result, &err);
		close(master); /* rpcd holds its own duplicate now (or nobody does) */
		if (rc != 0) {
			logline("proc.pty: stream.open failed (%s); killing the shell", err.name);
			kill(-pid, SIGKILL);
			waitpid(pid, NULL, 0);
			free(result);
			send_error(id, 1001, "UNAVAILABLE", "no terminal window could open",
			           "a shell window wants a page session (is a browser showing this machine?)");
			return;
		}
		{
			int vs, ve;
			if (result && jl_obj_get(result, (int)strlen(result), "id", &vs, &ve) == 1)
				stream_id = jl_num(result, vs, ve, -1);
		}
		free(result);
		p->used = 1;
		p->pid = pid;
		p->stream_id = stream_id;
		logline("proc.pty: shell pid %d on stream %lld", (int)pid, stream_id);
		{
			char body[160];
			int n = snprintf(body, sizeof(body),
			                 "{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"id\":%lld,\"pid\":%d}}",
			                 id, stream_id, (int)pid);
			if (n > 0 && n < (int)sizeof(body)) send_line(body, n);
		}
	}
}

/* Every loop: a closed window closed the stream, the shell got HUP and
 * exited — collect it. No restarts; a window is not a service. */
static void reap_ptys(void) {
	int i;
	for (i = 0; i < MAX_PTYS; i++) {
		struct ptyshell *p = &ptys[i];
		int st;
		if (!p->used) continue;
		if (waitpid(p->pid, &st, WNOHANG) == p->pid) {
			logline("proc.pty: shell pid %d exited", (int)p->pid);
			p->used = 0;
		}
	}
}

/* ── the socket side ── */

static void dispatch_line(const char *json, int len) {
	int vs, ve;
	char id[80] = "";
	char method[64] = "";
	int has_id = 0;

	if (jl_obj_get(json, len, "id", &vs, &ve) == 1 && jl_is_str(json, vs, ve) &&
	    jl_str_decode(json, vs, ve, id, sizeof(id)) >= 0)
		has_id = 1;
	if (jl_obj_get(json, len, "method", &vs, &ve) == 1)
		jl_str_decode(json, vs, ve, method, sizeof(method));

	if (!method[0]) return; /* responses are never routed to rund */

	if (!has_id) {
		if (!strcmp(method, "rpc.cancel")) {
			int ps, pe, is, ie;
			char target[80];
			if (jl_obj_get(json, len, "params", &ps, &pe) == 1 &&
			    jl_obj_get(json + ps, pe - ps, "id", &is, &ie) == 1 &&
			    jl_str_decode(json + ps, is, ie, target, sizeof(target)) >= 0)
				job_cancel(target);
		}
		return;
	}
	if (!strcmp(method, "proc.run")) {
		handle_proc_run(id, json, len);
		return;
	}
	if (!strcmp(method, "proc.pty")) {
		handle_proc_pty(id, json, len);
		return;
	}
	if (!strcmp(method, "app.start")) {
		handle_app_start(id, json, len);
		return;
	}
	if (!strcmp(method, "app.stop")) {
		handle_app_stop(id, json, len);
		return;
	}
	if (!strcmp(method, "app.status")) {
		handle_app_status(id, json, len);
		return;
	}
	if (!strcmp(method, "app.list")) {
		handle_app_list(id);
		return;
	}
	send_error(id, -32601, "METHOD_NOT_FOUND", "rund serves proc.run and app.*",
	           "app.list names the lifecycle methods (system-v2 §9.3)");
}

static int connect_rpcd(void) {
	struct sockaddr_un addr;
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0) return -1;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", SOCK_PATH);
	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

int main(void) {
	static char in[LINE_CAP];
	int inlen = 0;
	long long next_sweep = 0;

	signal(SIGPIPE, SIG_IGN);
	/* init gives daemons no useful stderr; a small log answers "what did
	 * rund think happened" after a crash loop or an adoption. /run is
	 * tmpfs, so rotation is a reboot's job. */
	mkdir("/run/vinx", 0755);
	freopen("/run/vinx/rund.log", "a", stderr);
	logline("rund starting");
	recover_services();

	for (;;) {
		sock_fd = connect_rpcd();
		if (sock_fd < 0) {
			/* rpcd is respawning; keep the services swept meanwhile --
			 * they live on this daemon, not on that socket. */
			reap_services();
			if (now_ms() >= next_sweep) {
				sweep_services();
				next_sweep = now_ms() + SERVICE_TICK_MS;
			}
			sleep(1);
			continue;
		}
		inlen = 0;
		{
			static const char serve[] =
			    "{\"jsonrpc\":\"2.0\",\"method\":\"rpc.serve\",\"params\":{\"methods\":[\"proc.run\",\"app.start\",\"app.stop\",\"app.status\",\"app.list\"]}}\n";
			if (write_all(sock_fd, serve, sizeof(serve) - 1) < 0) {
				close(sock_fd);
				sock_fd = -1;
				sleep(1);
				continue;
			}
		}

		while (sock_fd >= 0) {
			struct pollfd fds[1 + MAX_JOBS];
			int map[1 + MAX_JOBS];
			int nf = 0, i, pi;
			long long t;

			fds[nf].fd = sock_fd;
			fds[nf].events = POLLIN;
			map[nf++] = -1;
			for (i = 0; i < MAX_JOBS; i++) {
				if (!jobs[i].used) continue;
				fds[nf].fd = jobs[i].out_fd;
				fds[nf].events = POLLIN;
				map[nf++] = i;
			}

			if (poll(fds, (nfds_t)nf, 200) < 0 && errno != EINTR) break;

			for (pi = 0; pi < nf; pi++) {
				int who = map[pi];
				if (!fds[pi].revents) continue;
				if (who >= 0) {
					/* POLLHUP alone still means readable-until-EOF. */
					job_read(&jobs[who]);
					continue;
				}
				if (fds[pi].revents & (POLLERR | POLLHUP)) {
					close(sock_fd);
					sock_fd = -1;
					break;
				}
				if (fds[pi].revents & POLLIN) {
					char *nl;
					ssize_t r;
					if (inlen >= (int)sizeof(in)) {
						close(sock_fd);
						sock_fd = -1;
						break;
					}
					r = read(sock_fd, in + inlen, sizeof(in) - (size_t)inlen);
					if (r <= 0) {
						if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
						close(sock_fd);
						sock_fd = -1;
						break;
					}
					inlen += (int)r;
					while ((nl = memchr(in, '\n', (size_t)inlen))) {
						int llen = (int)(nl - in);
						if (llen > 0) dispatch_line(in, llen);
						memmove(in, nl + 1, (size_t)(inlen - llen - 1));
						inlen -= llen + 1;
					}
				}
			}

			/* Timeouts: SIGKILL the group; the pipe EOF finishes the job. */
			t = now_ms();
			for (i = 0; i < MAX_JOBS; i++) {
				if (jobs[i].used && !jobs[i].timed_out && !jobs[i].cancelled && t >= jobs[i].kill_at) {
					jobs[i].timed_out = 1;
					kill(-jobs[i].pid, SIGKILL);
				}
			}

			/* Services: reap exits every turn (WNOHANG is cheap); sweep
			 * the enable list and due restarts on the slower tick. */
			reap_services();
			reap_ptys();
			if (t >= next_sweep) {
				sweep_services();
				next_sweep = t + SERVICE_TICK_MS;
			}
		}

		/* The control plane went away: nobody is left to hear these jobs,
		 * and a fresh rpcd means a fresh session anyway. Services are the
		 * deliberate exception (§9.3): a page reload must not take a
		 * pure-Linux service down, so they ride across the reconnect --
		 * only a stop request they owed a reply loses its answer (rpcd
		 * fails pending calls itself when a client drops). */
		kill_all_jobs();
		sleep(1);
	}
}
