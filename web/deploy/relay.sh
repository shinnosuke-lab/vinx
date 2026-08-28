#!/usr/bin/env bash
#
# A network relay for the VM: real outbound TCP instead of the default
# internet-less in-browser LAN. Starts a local wisp server (MercuryWorkshop's
# wisp-js), and with --tunnel also exposes it through a free Cloudflare quick
# tunnel (trycloudflare.com, no account needed) so a page served anywhere can
# use it.
#
# Point the page at it with the printed `?relay=` URL — the choice persists in
# localStorage, `?relay=host` reverts to the default. What the relay changes
# inside the guest: TLS (`curl https://...`), WebSocket and raw TCP start
# working, and plain HTTP stops being CORS-bound. What it does not change:
# listening sockets still do not work (wisp has no server sockets), and ping
# is still answered locally by the emulator.
#
#   ./deploy/relay.sh                local only:  ?relay=wisp://127.0.0.1:5001/
#   ./deploy/relay.sh --tunnel      + public URL: ?relay=wisps://<x>.trycloudflare.com/
#   ./deploy/relay.sh --port 6001    another port
#
# The quick tunnel's hostname is random and ephemeral — fine for trying things
# out, not for bookmarking. For something stable, run a named Cloudflare
# tunnel (free, needs an account and a domain) or deploy
# deploy/cloudflare-wisp/ to Workers.

set -euo pipefail

PORT=5001
TUNNEL=false
while [[ $# -gt 0 ]]; do
	case "$1" in
		--port)   PORT="$2"; shift 2 ;;
		--tunnel) TUNNEL=true; shift ;;
		*) echo "Unknown option: $1" >&2; exit 1 ;;
	esac
done

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
	# shellcheck disable=SC1091
	. "$NVM_DIR/nvm.sh"
	nvm use 22 >/dev/null 2>&1 || true
fi

PIDS=()
TUNNEL_LOG=""
cleanup() {
	for pid in "${PIDS[@]:-}"; do
		[ -n "$pid" ] && { kill "$pid" && wait "$pid"; } 2>/dev/null || true
	done
	rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

echo "==> wisp relay on ws://127.0.0.1:$PORT/"
npx --yes @mercuryworkshop/wisp-js -H 127.0.0.1 -P "$PORT" -L WARN &
PIDS+=($!)

if [ "$TUNNEL" = true ]; then
	if ! command -v cloudflared >/dev/null 2>&1; then
		echo "FATAL: cloudflared is not installed (brew install cloudflared)." >&2
		exit 1
	fi
	TUNNEL_LOG="$(mktemp)"
	echo "==> opening a Cloudflare quick tunnel (free, no account, random hostname)"
	cloudflared tunnel --url "http://127.0.0.1:$PORT" >"$TUNNEL_LOG" 2>&1 &
	PIDS+=($!)
	HOSTNAME_RE='https://[a-z0-9-]+\.trycloudflare\.com'
	TUNNEL_URL=""
	for _ in $(seq 1 60); do
		TUNNEL_URL=$(grep -oE "$HOSTNAME_RE" "$TUNNEL_LOG" | head -1 || true)
		[ -n "$TUNNEL_URL" ] && break
		sleep 0.5
	done
	if [ -z "$TUNNEL_URL" ]; then
		echo "FATAL: the tunnel never announced a hostname:" >&2
		cat "$TUNNEL_LOG" >&2
		exit 1
	fi
	WISPS="wisps://${TUNNEL_URL#https://}/"
	echo ""
	echo "    public relay:  $WISPS"
	echo "    open the page with:  ?relay=$WISPS"
else
	# wisp:// (not ws://): the scheme picks the protocol, and this server speaks
	# Wisp. ws:// would select v86's wsproxy backend and carry nothing here.
	echo ""
	echo "    open the page with:  ?relay=wisp://127.0.0.1:$PORT/"
fi
echo "    (persists in the browser; ?relay=host reverts to the default)"
echo ""
echo "Ctrl+C stops the relay."
wait
