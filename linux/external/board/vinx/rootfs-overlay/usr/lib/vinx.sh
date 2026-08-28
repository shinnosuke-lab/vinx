# Shared by imgcat(1), download(1) and open(1): the guest half of the escape
# pipe to the page. A file becomes one OSC sequence -- base64 payload, no
# newlines (the page's parsers are strict RFC 4648) -- written straight to the
# terminal, where the page-side handlers pick it up.
#
# 2 MiB cap: the payload crosses the emulated UART byte by byte, and past a
# couple of MB the wait stops feeling instant. Bigger things belong in /data
# (the page mirrors it) or the agent's download_file tool (9p, no UART).

VINX_MAX=2097152

# vm_file_ok CMD FILE -> 0 if FILE is a regular file under the cap.
vm_file_ok() {
	if [ ! -f "$2" ]; then
		echo "$1: $2: no such file" >&2
		return 1
	fi
	if [ "$(wc -c < "$2")" -gt "$VINX_MAX" ]; then
		echo "$1: $2: larger than 2 MB -- copy it to /data, or ask the agent to download_file it" >&2
		return 1
	fi
	return 0
}

# base64 of a file, one line.
vm_b64() {
	base64 "$1" | tr -d '\n'
}

# base64 of a string, one line.
vm_b64s() {
	printf '%s' "$1" | base64 | tr -d '\n'
}
