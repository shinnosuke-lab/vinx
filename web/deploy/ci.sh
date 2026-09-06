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
# The binaryen release wasm-pack 0.15 pins; docker/Dockerfile bakes the same.
BINARYEN_VERSION=version_117

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
# Only when the node already on PATH will not do: a GitHub runner has nvm in
# $HOME with nothing installed under it and Node 22 from setup-node on PATH --
# `nvm use 22` there fails, and under set -e that ended the build before it
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

node_major=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || true)  # missing node: reported below, not a pipefail exit
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

# Where a tool this script fetches goes: /usr/local/bin when running as root
# (the builder image); a GitHub runner is not root, so there it goes beside
# cargo's own binaries, which rustup already put on PATH, or failing that into
# ~/.local/bin. Then `install`s the file there and makes sure PATH sees it.
place_tool() {
	if [ -w /usr/local/bin ]; then
		bindir=/usr/local/bin
	elif [ -d "${CARGO_HOME:-$HOME/.cargo}/bin" ] && [ -w "${CARGO_HOME:-$HOME/.cargo}/bin" ]; then
		bindir="${CARGO_HOME:-$HOME/.cargo}/bin"
	else
		bindir="$HOME/.local/bin"
		mkdir -p "$bindir"
	fi
	case ":$PATH:" in *":$bindir:"*) ;; *) export PATH="$bindir:$PATH" ;; esac
	install -m 755 "$1" "$bindir/$(basename "$1")"
}

# The tarballs fetched below are Linux x86_64 builds: the hosts that reach
# these downloads are the GitHub runner and the image. On anything else a
# missing tool is named, with the `cargo install` that provides it, rather
# than fetched -- a Linux binary installed on a Mac fails one line later with
# an error that says nothing about why.
case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) can_fetch=1 ;;
	*) can_fetch= ;;
esac

if command -v wasm-pack >/dev/null 2>&1; then
	echo "    $(wasm-pack --version)"
elif [ -z "$can_fetch" ]; then
	echo "FATAL: wasm-pack is not on PATH." >&2
	echo "    cargo install wasm-pack --version $WASM_PACK_VERSION" >&2
	exit 1
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
	place_tool "/tmp/$pack/wasm-pack"
	wasm-pack --version
fi

# wasm-pack runs with --mode no-install here (runtime/package.json, test.sh), so
# it never downloads wasm-bindgen: the CLI has to be on PATH, at exactly the
# version of the wasm-bindgen crate in Cargo.lock, or the build dies after the
# whole cargo step with "Not able to find or install a local wasm-bindgen."
# The image bakes it and a laptop has it from cargo install; a GitHub runner
# has neither, so it is fetched here the way wasm-pack is. Said plainly,
# because the symptom says nothing about the cause.
locked=$(awk '/^name = "wasm-bindgen"$/ {getline; gsub(/[",]/, "", $3); print $3; exit}' Cargo.lock)
# `|| true` is load-bearing under `set -o pipefail`: a missing wasm-bindgen
# makes the left side of the pipe exit 127, and without this the script dies
# before the fetch below.
installed=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [ -z "$installed" ] && [ -z "$can_fetch" ]; then
	echo "FATAL: wasm-bindgen is not on PATH, and wasm-pack (--mode no-install) will not fetch it." >&2
	echo "    cargo install wasm-bindgen-cli --version $locked" >&2
	exit 1
elif [ -z "$installed" ]; then
	echo "    installing wasm-bindgen $locked"
	bindgen=wasm-bindgen-$locked-x86_64-unknown-linux-musl
	if ! curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$locked/$bindgen.tar.gz" \
		| tar -xz -C /tmp; then
		echo "FATAL: could not fetch wasm-bindgen $locked from GitHub." >&2
		echo "wasm-pack runs with --mode no-install and will not fetch it either." >&2
		echo "Build and push the image that carries it, from a machine that can:" >&2
		echo "    ./docker/build-image.sh" >&2
		exit 1
	fi
	place_tool "/tmp/$bindgen/wasm-bindgen"
	# Same tarball; what `wasm-pack test` (deploy/test.sh) runs the suites with.
	place_tool "/tmp/$bindgen/wasm-bindgen-test-runner"
	wasm-bindgen --version
elif [ "$installed" != "$locked" ]; then
	echo "FATAL: wasm-bindgen $installed is on PATH but Cargo.lock wants $locked." >&2
	echo "wasm-pack runs with --mode no-install and will not fetch the right one." >&2
	echo "In the builder image: rebuild it with ./docker/build-image.sh" >&2
	echo "Elsewhere: cargo install wasm-bindgen-cli --version $locked" >&2
	exit 1
else
	echo "    wasm-bindgen $installed matches Cargo.lock"
fi

# Not fatal: without it wasm-pack skips the optimiser and the page still works,
# just larger. But a runner would then publish a bigger wasm than the image
# builds, so it is fetched when missing, and only the failure to fetch is
# reported -- worth a line so a bundle that suddenly grew has an explanation.
if command -v wasm-opt >/dev/null 2>&1; then
	echo "    $(wasm-opt --version)"
elif [ -z "$can_fetch" ]; then
	echo "    wasm-opt missing -- the wasm will ship unoptimised"
else
	echo "    installing wasm-opt ($BINARYEN_VERSION)"
	if curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN_VERSION/binaryen-$BINARYEN_VERSION-x86_64-linux.tar.gz" \
		| tar -xz -C /tmp; then
		place_tool "/tmp/binaryen-$BINARYEN_VERSION/bin/wasm-opt"
		wasm-opt --version
	else
		echo "    wasm-opt could not be fetched -- the wasm will ship unoptimised"
	fi
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
