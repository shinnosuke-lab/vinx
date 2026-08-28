#!/usr/bin/env bash
#
# Everything CI does before anything is published: build the page and run the
# suites that can fail it.
#
# The build can run inside a container (--docker) so the machine needs nothing
# but docker itself: this page wants a Rust toolchain, a wasm target, wasm-pack
# and a browser, and the image (docker/Dockerfile) bakes all of it. What
# remains here installs tools only when they are absent, which is how this
# still runs on a laptop without the image.
#
# Usage:
#   ./deploy/ci.sh            build and test here, using the toolchain on PATH
#   ./deploy/ci.sh --docker   do the same inside BUILDER_IMAGE
#
# Environment:
#   BUILDER_IMAGE    image --docker runs in (build it: ./docker/build-image.sh)

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

BUILDER_IMAGE="${BUILDER_IMAGE:-vinx-builder:v1}"
WASM_PACK_VERSION=0.15.0

if [ "${1:-}" = "--docker" ]; then
	echo "==> Building in $BUILDER_IMAGE"

	# --ipc=host: Chrome puts shared memory in /dev/shm, and the 64 MB a
	# container gets by default is not enough -- it dies partway through a page
	# with an error that names neither /dev/shm nor a size.
	#
	# bash -c, not bash -lc: a login shell sources /etc/profile, which resets
	# PATH and drops the cargo and rustup directories the image puts there.
	# The repo root is mounted, not web/: VER lives in ../version.sh.
	#
	# Everything the build writes -- node_modules, dist, runtime/pkg, the
	# screenshot -- is written by root inside the container, and on Linux that
	# is root in the workspace too. Handing them back matters on any CI agent
	# that must be able to wipe its own workspace. Kept to the exit status of
	# the build itself, so a chown that fails does not turn a red build green
	# or the other way round.
	give_back="chown -R $(id -u):$(id -g) /workdir/project 2>/dev/null || true"
	exec docker run --rm --platform linux/amd64 --ipc=host \
		-v "$REPO_DIR:/workdir/project" \
		-v vinx-cargo-registry:/usr/local/cargo/registry \
		-v vinx-npm-cache:/root/.npm \
		-w /workdir/project/web \
		"$BUILDER_IMAGE" bash -c "bash deploy/ci.sh; rc=\$?; $give_back; exit \$rc"
fi

echo "==> Toolchain"

# The container has no nvm and uses the image's node; this is for the case where
# someone runs the script outside one, the way the other deploy scripts do it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
	# shellcheck disable=SC1091
	. "$NVM_DIR/nvm.sh"
	nvm use 22 >/dev/null
fi

node_major=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
if [ -z "$node_major" ] || [ "$node_major" -lt 20 ]; then
	echo "FATAL: need Node 20+ for vite (have ${node_major:-none})." >&2
	echo "In the container that means the image's node is too old to build this" >&2
	echo "page; outside one, try 'nvm install 22'." >&2
	exit 1
fi
echo "    node $(node -v)"

if rustup target list --installed | grep -qx wasm32-unknown-unknown; then
	echo "    wasm32-unknown-unknown already installed"
else
	rustup target add wasm32-unknown-unknown
fi

if command -v wasm-pack >/dev/null 2>&1; then
	echo "    $(wasm-pack --version)"
else
	# Only reached outside the builder image. On the Jenkins agent this download
	# is the one that fails, which is what docker/Dockerfile exists to fix.
	echo "    installing wasm-pack $WASM_PACK_VERSION"
	pack=wasm-pack-v$WASM_PACK_VERSION-x86_64-unknown-linux-musl
	if ! curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v$WASM_PACK_VERSION/$pack.tar.gz" \
		| tar -xz -C /tmp; then
		echo "FATAL: could not fetch wasm-pack from GitHub." >&2
		echo "Build and push the image that carries it, from a machine that can:" >&2
		echo "    ./docker/build-image.sh" >&2
		exit 1
	fi
	install -m 755 "/tmp/$pack/wasm-pack" /usr/local/bin/wasm-pack
	wasm-pack --version
fi

# wasm-pack takes wasm-bindgen from PATH only when its version equals the
# crate's; otherwise it goes to GitHub, and on the agent that is a two minute
# hang followed by a slow `cargo install` of the same thing. Said plainly here,
# because the symptom says nothing about the cause.
locked=$(awk '/^name = "wasm-bindgen"$/ {getline; gsub(/[",]/, "", $3); print $3; exit}' Cargo.lock)
# `|| true` is load-bearing under `set -o pipefail`: a missing wasm-bindgen
# makes the left side of the pipe exit 127, and without this the script dies
# before the empty-installed branch below — which is the documented laptop path.
installed=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [ -z "$installed" ]; then
	echo "    wasm-bindgen not on PATH; wasm-pack will fetch $locked itself"
elif [ "$installed" != "$locked" ]; then
	echo "FATAL: wasm-bindgen $installed is on PATH but Cargo.lock wants $locked." >&2
	echo "wasm-pack will ignore it and download, which the Jenkins agent cannot." >&2
	echo "Rebuild the builder image: ./docker/build-image.sh" >&2
	exit 1
else
	echo "    wasm-bindgen $installed matches Cargo.lock"
fi

# Not fatal: without it wasm-pack skips the optimiser and the page still works,
# just larger. Worth a line so a bundle that suddenly grew has an explanation.
if command -v wasm-opt >/dev/null 2>&1; then
	echo "    $(wasm-opt --version)"
else
	echo "    wasm-opt missing -- the wasm will ship unoptimised"
fi

# The two hosts left that a build cannot do without. Probed rather than
# discovered: an unreachable one shows up deep inside cargo or npm as something
# that reads like a broken dependency, and this build has already lost two runs
# to exactly that.
echo ""
echo "==> Reachable"
blocked=""
for host in index.crates.io registry.npmjs.org; do
	if curl -fsS --max-time 5 -o /dev/null "https://$host/" 2>/dev/null; then
		echo "    ok      $host"
	else
		echo "    BLOCKED $host"
		blocked="$blocked $host"
	fi
done
if [ -n "$blocked" ]; then
	echo "FATAL: no route to$blocked from inside the build." >&2
	echo "Nothing below can fetch its dependencies; the failure it would produce" >&2
	echo "names a package rather than the network." >&2
	exit 1
fi

echo ""
echo "==> The chat UI"

# Forked source, built here: its own npm project, because reproducing its
# Tailwind setup in ours would mean keeping the two in step. See vite.config.ts.
#
# `npm ci` and nothing else -- the lockfile is committed alongside the source,
# so both the dependencies and where their ranges resolved are pinned.
(
	cd vendor/ui
	npm ci
	npm run build
)
if [ ! -f vendor/ui/dist/index.js ]; then
	echo "FATAL: vendor/ui/dist/index.js is missing after its build." >&2
	exit 1
fi

echo ""
echo "==> Dependencies"
npm ci
(cd runtime && npm ci)

echo ""
echo "==> Engine"
# Before the suites, not as part of them: the TypeScript half imports the types
# wasm-pack generates into runtime/pkg, and on a fresh checkout that directory
# does not exist -- `tsc --noEmit` then fails on an import, which reads like a
# broken source file rather than a missing build. browser.sh builds it again,
# by then against a warm cargo cache.
npm run build:wasm

echo ""
echo "==> Chrome"
# The browser suite asks for `channel: 'chrome'` -- real Chrome rather than
# playwright's own build. --with-deps is the apt half, which needs the root a
# container has.
#
# Baked into the builder image, so this is the laptop path. Skipping it there
# saves the 73 MB of Debian packages that installing it pulls every time.
if command -v google-chrome >/dev/null 2>&1; then
	echo "    $(google-chrome --version)"
elif npx playwright install --with-deps chrome; then
	echo "    installed"
else
	echo "FATAL: could not install Chrome for the browser suite." >&2
	echo "Nothing below covers the worker starting, wasm over HTTP, or IndexedDB" >&2
	echo "surviving a reload -- every other suite runs on an in-memory database." >&2
	exit 1
fi

echo ""
echo "==> Suites"
./deploy/test.sh
./deploy/browser.sh

# The browser suite may leave dist/ built for its own local server, so the
# last thing here is a clean production build. The site is relative-path
# static files; any static host (or `npx serve web/dist`) serves it as-is.
echo ""
echo "==> Production build"
npm run build
echo ""
echo "ci ok -- web/dist is ready for any static host"
