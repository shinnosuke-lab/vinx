#!/usr/bin/env bash
#
# The built page in a real browser, served the way it is actually deployed: a
# single-origin static site, no server side at all.
#
# Separate from `test.sh` because it needs a browser and a build. Everything it
# covers is invisible to the Node suite, which runs the engine with an
# in-memory database -- a tab that cannot remember a conversation would pass all
# of it. The console/VM leg additionally boots the emulated Linux; it is
# skipped unless the images under app/public/vm/ are present.
#
#   ./deploy/browser.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Only when the node already on PATH will not do: a GitHub runner has nvm in
# $HOME with nothing installed under it and Node 22 from setup-node on PATH,
# and `nvm use 22` there fails, which under set -e ended the suite before it
# began. nvm.sh itself is not clean under set -u, hence the bracket.
node_major=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || true)  # missing node: reported below, not a pipefail exit
if [ -z "$node_major" ] || [ "$node_major" -lt 20 ]; then
	export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
	if [ -s "$NVM_DIR/nvm.sh" ]; then
		set +u
		# shellcheck disable=SC1091
		. "$NVM_DIR/nvm.sh"
		nvm use 22 >/dev/null 2>&1 || true
		set -u
	fi
fi
# The wasm build looks for its tools on PATH; a laptop keeps them under cargo.
export PATH="$HOME/.cargo/bin:$PATH"

PIDS=()
MOCK_LOG=""
SERVE_LOG=""
cleanup() {
	for pid in "${PIDS[@]:-}"; do
		[ -n "$pid" ] && { kill "$pid" && wait "$pid"; } 2>/dev/null || true
	done
	rm -f "$MOCK_LOG" "$SERVE_LOG"
}
trap cleanup EXIT

# Serve dist/ from one origin. Started before the build so the port is known
# for the skills-repo URL baked into the bundle; the directory is emptied and
# refilled by the build below.
mkdir -p dist
SERVE_LOG="$(mktemp)"
python3 -u deploy/assets-server.py dist >"$SERVE_LOG" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do
	PORT=$(sed -n 's/^ASSETS_PORT=//p' "$SERVE_LOG")
	[ -n "$PORT" ] && break
	sleep 0.1
done
if [ -z "${PORT:-}" ]; then
	echo "FATAL: could not serve dist/."
	cat "$SERVE_LOG"
	exit 1
fi
APP_URL="http://127.0.0.1:$PORT/"

# A skills repository on the same origin, seeded after the build (which empties
# dist/). Baked into the bundle, so it is exported before building.
export SKILLS_REPO="http://127.0.0.1:$PORT/skills"

# The app shell (system-v2 §10.3) ships beside the page — app/public/
# app-frame.html lands in dist/ — and the desktop resolves it relative to
# its own document, so it is served by the same origin as everything else.
# VINX_APP_FRAME_URL stays unset: the suite proves the default, not a deploy
# that moved the shell to another site.
APP_FRAME_URL="${APP_URL}app-frame.html"

echo "==> building the page for $APP_URL (app shell at $APP_FRAME_URL)"
npm run build >/dev/null

echo "==> seeding a skills repository at $SKILLS_REPO"
python3 - dist/skills <<'PYEOF'
import json, os, sys, zipfile
root = sys.argv[1]
os.makedirs(os.path.join(root, "skill-packages"), exist_ok=True)

def package(name, version, env):
    path = os.path.join(root, "skill-packages", f"{name}.zip")
    declared = f"env: {', '.join(env)}\n" if env else ""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            f"{name}/SKILL.md",
            f"---\nname: {name}\ndescription: installed from a repository by the browser suite\n"
            f"version: {version}\n{declared}---\n\n# {name}\n\nProof that the market path works.\n",
        )
        z.writestr(f"{name}/CHANGELOG.md", f"# {version}\n\nFirst release.\n")
    return path

entries = []
for name, env in [("browser-demo", [])]:
    version = "1.0.0"
    path = package(name, version, env)
    entries.append({
        "name": name, "version": version,
        "description": "installed from a repository by the browser suite",
        "url": f"skill-packages/{name}.zip", "size": os.path.getsize(path),
    })

with open(os.path.join(root, "index.json"), "w") as f:
    json.dump({"format": 1, "generated_at": "2026-01-01T00:00:00Z", "skills": entries}, f)
print(f"    seeded {len(entries)} package(s)")
PYEOF

MOCK_LOG="$(mktemp)"
node runtime/test/mock-llm.mjs 0 >"$MOCK_LOG" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do
	MOCK_LLM_URL=$(sed -n 's/^MOCK_LLM_URL=//p' "$MOCK_LOG")
	[ -n "$MOCK_LLM_URL" ] && break
	sleep 0.1
done
if [ -z "${MOCK_LLM_URL:-}" ]; then
	echo "FATAL: the mock endpoint did not start."
	cat "$MOCK_LOG"
	exit 1
fi

# The console/VM test runs only when the images are built into the bundle.
VM_IMAGES=0
if [ -f dist/vm/bzImage ] && [ -f dist/vm/rootfs.img ]; then
	VM_IMAGES=1
	echo "==> VM images present; the console leg will boot Linux"
else
	echo "==> no VM images (../linux/build.sh); the console leg will be skipped"
fi

export APP_URL APP_FRAME_URL MOCK_LLM_URL VM_IMAGES
echo "==> $APP_URL (model at $MOCK_LLM_URL)"
node app/test/browser.mjs
