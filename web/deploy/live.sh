#!/usr/bin/env bash
#
# One real turn against a real provider.
#
# Separate from `test.sh` because it costs money, needs network, and depends on
# a third party being up -- none of which belong in the suite you run on every
# change. Credentials come from `.env.live` (gitignored) so a key never lands in
# your shell history or a build artifact.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env.live ]; then
	echo "FATAL: no .env.live -- copy .env.live.example and fill in your key."
	exit 1
fi

# `set -a` exports everything the file defines, which is what the test reads.
set -a
# shellcheck disable=SC1091
. ./.env.live
set +a

if [ -z "${LIVE_BASE_URL:-}" ] || [ -z "${LIVE_MODEL:-}" ]; then
	echo "FATAL: .env.live must set LIVE_BASE_URL and LIVE_MODEL."
	exit 1
fi

# Only when the node already on PATH will not do (see deploy/test.sh): an nvm
# with nothing installed under it makes `nvm use 22` fail, and under set -e that
# is the end of the run. nvm.sh itself is not clean under set -u, hence the bracket.
node_major=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || true)  # missing node: reported below, not a pipefail exit
if [ -z "$node_major" ] || [ "$node_major" -lt 18 ]; then
	export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
	if [ -s "$NVM_DIR/nvm.sh" ]; then
		set +u
		# shellcheck disable=SC1091
		. "$NVM_DIR/nvm.sh"
		nvm use 22 >/dev/null 2>&1 || true
		set -u
	fi
fi

echo "==> live turn against $LIVE_BASE_URL ($LIVE_MODEL)"
cd crates/agent-web-core
wasm-pack test --node --features sqlite --test live
