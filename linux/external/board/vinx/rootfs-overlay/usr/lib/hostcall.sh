# Shared by js(1) and fetch(1): the guest half of the hostcall channel on
# /dev/ttyS3 -- a guest-initiated request/answer line, the mirror image of
# agentd's ttyS1. The page side (protocol, executors, /data overflow) lives in
# web/app/hostcall.ts; the wire format is agentd's shape:
#
#   ->  CALL <id> <kind> <len> <base64(json)>
#   <-  DONE <id> <0|1> <len> <base64(json)>
#
# Why a UART and not the OSC escapes the other browser-facing commands use:
# OSC only reaches the page when stdout is the console (ttyS0). Run through
# run_shell, stdout is captured by agentd and the escapes go nowhere. This
# channel works the same from the console, from run_shell, from a script.
#
# The one non-obvious rule in here: the tty is opened ONCE, read-write, and
# both the CALL write and the DONE read go through that fd. A serial port
# receives only while some process holds it open -- write-close-reopen-read
# would leave a gap for the reply to fall into, and it would, sometimes.
#
# Payloads too big for a byte-at-a-time UART ride /data instead: a request
# past 32 KiB of base64 is written to /data/.hostcall-req-<id> and the CALL
# carries {req: <name>}; a big reply comes back as {file: <name>} naming
# /data/.hostcall-<id>. Both files are this side's to delete.

HOSTCALL_TTY=/dev/ttyS3
HOSTCALL_LOCK=/run/hostcall.lock
HOSTCALL_REQ_MAX=32768

# hostcall KIND JSON [TIMEOUT_S] -> reply JSON on stdout.
# Returns 0 whenever a DONE arrived (the JSON's .ok says how the call went),
# non-zero only for transport trouble: no tty, no reply, lock failure.
hostcall() {
	_hc_kind=$1
	_hc_json=$2
	_hc_tmo=${3:-30}
	if [ ! -e "$HOSTCALL_TTY" ]; then
		echo "hostcall: $HOSTCALL_TTY does not exist (kernel without 4 UARTs?)" >&2
		return 1
	fi
	# Raw and silent every time, not just at boot: a getty never owns this
	# line, but echo would bounce the page's DONE straight back at it.
	stty -F "$HOSTCALL_TTY" raw -echo 2>/dev/null
	# PID + epoch second. A collision needs a recycled PID landing on the
	# same second as an interrupted earlier call whose DONE is still in
	# flight -- the drain loop's id check absorbs even that.
	_hc_id="$$-$(date +%s)"
	_hc_b64=$(printf '%s' "$_hc_json" | base64 | tr -d '\n')
	_hc_req=
	if [ "${#_hc_b64}" -gt "$HOSTCALL_REQ_MAX" ]; then
		if ! grep -q ' /data 9p ' /proc/mounts; then
			echo "hostcall: request too large for the wire and no /data mount to relay it" >&2
			return 1
		fi
		_hc_req="/data/.hostcall-req-$_hc_id"
		printf '%s' "$_hc_json" > "$_hc_req"
		_hc_b64=$(printf '{"req":".hostcall-req-%s"}' "$_hc_id" | base64 | tr -d '\n')
	fi
	# The subshell scopes the lock (fd 9) and the tty (fd 3); flock
	# serialises concurrent callers so DONE lines never interleave readers.
	# Waiting longer than the page's own budget (timeout + 10s grace there,
	# + 5 more here) means a dead page, not a slow call.
	(
		flock 9 || exit 1
		exec 3<>"$HOSTCALL_TTY" || exit 1
		printf 'CALL %s %s %s %s\n' "$_hc_id" "$_hc_kind" "${#_hc_b64}" "$_hc_b64" >&3
		_hc_deadline=$((_hc_tmo + 15))
		while :; do
			_hc_verb=; _hc_rid=; _hc_ok=; _hc_len=; _hc_data=
			if ! read -r -t "$_hc_deadline" _hc_verb _hc_rid _hc_ok _hc_len _hc_data <&3; then
				echo "hostcall: no reply from the page within ${_hc_deadline}s" >&2
				exit 1
			fi
			# Stale lines from an aborted earlier call drain here harmlessly.
			[ "$_hc_verb" = "DONE" ] && [ "$_hc_rid" = "$_hc_id" ] && break
		done
		if [ -n "$_hc_len" ] && [ "${#_hc_data}" -ne "$_hc_len" ]; then
			echo "hostcall: the reply arrived truncated (${#_hc_data} of $_hc_len chars)" >&2
			exit 1
		fi
		printf '%s' "$_hc_data" | base64 -d
	) 9>"$HOSTCALL_LOCK"
	_hc_rc=$?
	[ -n "$_hc_req" ] && rm -f "$_hc_req"
	return $_hc_rc
}

# hostcall_body REPLY_JSON -> the reply's body bytes on stdout, wherever they
# are: inline text (.output or .body), inline base64 (.bodyB64), or a /data
# overflow file (.file) -- which is consumed (deleted) here.
hostcall_body() {
	_hb_file=$(printf '%s' "$1" | jq -r '.file // empty')
	if [ -n "$_hb_file" ]; then
		cat "/data/$_hb_file"
		rm -f "/data/$_hb_file"
		return
	fi
	_hb_b64=$(printf '%s' "$1" | jq -r '.bodyB64 // empty')
	if [ -n "$_hb_b64" ]; then
		printf '%s' "$_hb_b64" | base64 -d
		return
	fi
	printf '%s' "$1" | jq -rj '.output // .body // empty'
}
