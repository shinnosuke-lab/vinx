# Shared by imgcat(1) -- the one tool still on the escape pipe (terminal
# rendering, not a capability) -- and by open(1)/download(1) for the size
# gate on what they stage into /data/.vinx/tmp for their resource.* calls.
#
# 2 MiB cap: imgcat's payload crosses the emulated UART byte by byte, and
# past a couple of MB the wait stops feeling instant; the staged tools keep
# the same ceiling so "too big" means one thing. Bigger things belong in
# /data (the page mirrors it) or the agent's download_file tool.

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
