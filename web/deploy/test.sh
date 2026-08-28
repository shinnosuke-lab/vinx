#!/usr/bin/env bash
#
# Run the test suite against real SQLite compiled to wasm.
#
# The tests use the in-memory VFS, so they cover the schema, the C API wrapper
# and the search semantics, but not IndexedDB persistence -- that needs a real
# browser. See `wasm-pack test --headless --firefox` for that.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/crates/agent-web-core"

# The test runner's harness is an ES module using `node:` specifiers, so an old
# node fails with a bare "Cannot find module 'node:process'" that gives no hint
# about the real cause. Prefer nvm when it is around.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
	# shellcheck disable=SC1091
	. "$NVM_DIR/nvm.sh"
	nvm use 22 >/dev/null
fi

node_major=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
if [ -z "$node_major" ] || [ "$node_major" -lt 18 ]; then
	echo "FATAL: need Node 18+ for the wasm-bindgen test harness (have ${node_major:-none});"
	echo "       try 'nvm install 22'."
	exit 1
fi
echo "node $(node -v)"

# A mock OpenAI endpoint on a real socket, so the turn tests exercise reqwest,
# chunked transfer and SSE reassembly instead of a stubbed client. Port 0 lets
# the OS pick, which keeps concurrent runs from colliding.
MOCK_LOG="$(mktemp)"
node "$ROOT/runtime/test/mock-llm.mjs" 0 >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
	kill "$MOCK_PID" 2>/dev/null || true
	rm -f "$MOCK_LOG"
}
trap cleanup EXIT

# Wait for it to announce its port rather than sleeping a guessed interval.
for _ in $(seq 1 50); do
	MOCK_LLM_URL=$(sed -n 's/^MOCK_LLM_URL=//p' "$MOCK_LOG")
	[ -n "$MOCK_LLM_URL" ] && break
	sleep 0.1
done

if [ -z "${MOCK_LLM_URL:-}" ]; then
	echo "FATAL: the mock model endpoint did not start; turn tests would silently skip."
	cat "$MOCK_LOG"
	exit 1
fi
export MOCK_LLM_URL
echo "mock model endpoint at $MOCK_LLM_URL"

echo ""
echo "==> engine, store and live turns (wasm)"
# --mode no-install: use the wasm-bindgen on PATH, never fetch one. Left to
# itself wasm-pack goes to GitHub, which the Jenkins agent cannot reach and
# spends two silent minutes finding out. deploy/ci.sh checks the version on
# PATH against Cargo.lock, which is the condition that makes this safe.
wasm-pack test --mode no-install --node --features sqlite

# The TypeScript half runs against a stub worker, so it needs no wasm build.
if [ -d "$ROOT/runtime/node_modules" ]; then
	echo ""
	echo "==> runtime (typescript)"
	cd "$ROOT/runtime"
	npx tsc --noEmit         # src/, browser-typed (no node globals)
	npx tsc --noEmit -p test # test/, node-typed (vitest runs under node)
	npx vitest run
else
	echo ""
	echo "SKIPPED runtime tests: run 'npm install' in runtime/ first"
fi

# The pages themselves (web/app). Types only -- the behaviour is browser.sh's
# job. Needs the vendored UI built: @vinx/agent-chat's types are its dist/.
if [ -d "$ROOT/node_modules" ] && [ -f "$ROOT/vendor/ui/dist/index.d.ts" ]; then
	echo ""
	echo "==> app (typescript)"
	cd "$ROOT"
	npx tsc --noEmit -p app
else
	echo ""
	echo "SKIPPED app typecheck: run 'npm install' and build vendor/ui first"
fi
