/* vinx_rpc.h -- call the machine's control plane from C (or tcc).
 *
 * The control plane is rpcd on /run/vinx/rpc.sock: JSON-RPC 2.0 bodies, one
 * per line. Methods live on this machine (proc.run via rund) or on the
 * hosting browser page (http.fetch, debug.js); the caller does not care
 * which -- rpcd routes.
 *
 * Build on the target:  tcc x.c -lvinxrpc        (the .a ships in /usr/lib)
 *
 * Example:
 *   char *result; struct vinx_error err;
 *   if (vinx_call("http.fetch", "{\"url\":\"https://example.com\"}",
 *                 &result, &err) == 0) { puts(result); free(result); }
 *   else fprintf(stderr, "%s: %s\n", err.name, err.message);
 *
 * The wire ABI (frames, error codes) and this C ABI freeze separately;
 * fields are only ever appended (docs/system-v2.zh-CN.md §6.10).
 */
#ifndef VINX_RPC_H
#define VINX_RPC_H

#ifdef __cplusplus
extern "C" {
#endif

struct vinx_error {
	int code;           /* JSON-RPC code: -327xx, or Vinx 1001..1006 */
	char name[48];      /* stable: UNAVAILABLE, CANCELLED, ... */
	char message[512];  /* for people; do not parse */
	char hint[512];     /* for people and agents; may be empty */
};

/* Call METHOD with PARAMS_JSON (an object, or NULL for {}). On success
 * returns 0 and *result_json is the malloc'd result value (caller frees).
 * On failure returns -1 and *error says why -- a wire error from the far
 * side, or a local one (rpcd unreachable, deadline passed). Waits up to
 * 30 s; vinx_call_deadline chooses the budget in milliseconds. */
int vinx_call(const char *method, const char *params_json,
              char **result_json, struct vinx_error *error);

int vinx_call_deadline(const char *method, const char *params_json,
                       long deadline_ms, char **result_json,
                       struct vinx_error *error);

/* vinx_call_deadline with a file descriptor riding the request as
 * SCM_RIGHTS ancillary data (rpcd receives its own duplicate; this side
 * keeps carry_fd). What stream.open (§6.9) wants: rund passes the PTY
 * master alongside the request line. */
int vinx_call_deadline_fd(const char *method, const char *params_json,
                          long deadline_ms, int carry_fd, char **result_json,
                          struct vinx_error *error);

/* Fire-and-forget notification. 0 when it was written to rpcd. */
int vinx_notify(const char *method, const char *params_json);

#ifdef __cplusplus
}
#endif

#endif
