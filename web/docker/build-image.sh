#!/usr/bin/env bash
#
# Build the image deploy/ci.sh runs the page build in.
#
# Rebuild it when web/Cargo.lock's wasm-bindgen version moves. deploy/ci.sh
# compares the two on every build and says so, so this is not something anyone
# has to remember unprompted.
#
# Usage:
#   ./docker/build-image.sh                 # local build
#   ./docker/build-image.sh --push          # build + push (set --tag first)
#   ./docker/build-image.sh --no-cache      # force a rebuild
#   ./docker/build-image.sh --tag myimg:v2  # custom tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_TAG="vinx-builder:v1"
DOCKER_EXTRA_ARGS=()
PUSH=false

while [[ $# -gt 0 ]]; do
	case "$1" in
		--tag)      IMAGE_TAG="$2"; shift 2 ;;
		--no-cache) DOCKER_EXTRA_ARGS+=(--no-cache); shift ;;
		--push)     PUSH=true; shift ;;
		--no-push)  PUSH=false; shift ;;
		*) echo "Unknown option: $1" >&2; exit 1 ;;
	esac
done

# From the lockfile rather than from a constant here: wasm-pack refuses a
# wasm-bindgen CLI whose version differs from the crate's, and the failure it
# produces on a machine without GitHub is a two minute hang.
version=$(awk '/^name = "wasm-bindgen"$/ {getline; gsub(/[",]/, "", $3); print $3; exit}' \
	"$PROJECT_DIR/Cargo.lock")
if [ -z "$version" ]; then
	echo "FATAL: no wasm-bindgen version in $PROJECT_DIR/Cargo.lock" >&2
	exit 1
fi

echo "==> Building $IMAGE_TAG (wasm-bindgen $version)"
docker build \
	--platform linux/amd64 \
	--build-arg "WASM_BINDGEN_VERSION=$version" \
	-f "$SCRIPT_DIR/Dockerfile" \
	-t "$IMAGE_TAG" \
	"${DOCKER_EXTRA_ARGS[@]+"${DOCKER_EXTRA_ARGS[@]}"}" \
	"$SCRIPT_DIR"

echo ""
echo "==> Built: $IMAGE_TAG"
# Filtered rather than piped through head: with pipefail set, head closing the
# pipe early makes a successful build exit 141.
docker image ls --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' "$IMAGE_TAG"

if [ "$PUSH" = true ]; then
	echo ""
	echo "==> Pushing $IMAGE_TAG"
	docker push "$IMAGE_TAG"
	echo "==> Push done"
else
	echo ""
	echo "==> Skipped push (--no-push). Run manually:"
	echo "    docker push $IMAGE_TAG"
fi
