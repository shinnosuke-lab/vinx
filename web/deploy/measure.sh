#!/usr/bin/env bash
#
# What the browser actually downloads, at each stage of the pipeline.
#
# The number that matters is the last column: gzip over the wire. Raw .wasm is
# roughly three times that and quoting it is how size budgets get set wrong.
#
# Two rounds, because SQLite is the one dependency big enough to be worth
# choosing deliberately: it is a bundled C library, and the alternative is
# hand-rolling session storage over IndexedDB.
#
# Usage: ./deploy/measure.sh [--keep]

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

KEEP=false
[[ "${1:-}" == "--keep" ]] && KEEP=true

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
OUT=build/measure
rm -rf "$OUT"
mkdir -p "$OUT"

command -v wasm-pack >/dev/null || {
	echo "FATAL: wasm-pack not found -- cargo install wasm-pack" >&2
	exit 1
}

round() {
	local label=$1 features=$2 dir="$OUT/$1"

	echo ""
	echo "==> $label  (features: ${features:-none})"

	local args=(build crates/agent-web-core --release --target web --out-dir "$PWD/$dir" --no-typescript)
	[[ -n "$features" ]] && args+=(-- --features "$features")

	# wasm-pack drives wasm-bindgen (which rewrites the module and emits the JS
	# glue) and then wasm-opt. Both shrink things a lot, so measuring before
	# them -- as a plain `cargo build` does -- overstates the result badly.
	if ! wasm-pack "${args[@]}" >"$dir.log" 2>&1; then
		echo "    FAILED, see $dir.log" >&2
		tail -20 "$dir.log" >&2
		return 1
	fi

	local wasm js
	wasm=$(ls "$dir"/*_bg.wasm)
	js=$(ls "$dir"/*.js | head -1)

	local raw opt gz jsgz
	raw=$(wc -c < "$TARGET_DIR/wasm32-unknown-unknown/release/agent_web_core.wasm")
	opt=$(wc -c < "$wasm")
	gz=$(gzip -9 -c "$wasm" | wc -c)
	jsgz=$(gzip -9 -c "$js" | wc -c)

	printf '    %-22s %10s\n' "cargo .wasm (raw)" "$(fmt "$raw")"
	printf '    %-22s %10s\n' "+ bindgen + wasm-opt" "$(fmt "$opt")"
	printf '    %-22s %10s\n' "+ gzip (over the wire)" "$(fmt "$gz")"
	printf '    %-22s %10s\n' "JS glue, gzipped" "$(fmt "$jsgz")"

	echo "$label $gz $jsgz" >> "$OUT/summary.txt"
}

fmt() { printf "%'d" "$1" 2>/dev/null || echo "$1"; }

: > "$OUT/summary.txt"
round engine-only size-probe
round with-sqlite "size-probe,sqlite"

echo ""
echo "================================================================"
python3 - "$OUT/summary.txt" <<'PY'
import sys

rows = [l.split() for l in open(sys.argv[1]) if l.strip()]
by = {r[0]: (int(r[1]), int(r[2])) for r in rows}
print(" over the wire (gzip), which is the only figure worth quoting")
print("=" * 64)
for name, (gz, jsgz) in by.items():
    print("  %-14s wasm %9s   + JS glue %8s   = %9s"
          % (name, f"{gz:,}", f"{jsgz:,}", f"{gz + jsgz:,}"))
if "engine-only" in by and "with-sqlite" in by:
    d = by["with-sqlite"][0] - by["engine-only"][0]
    print("=" * 64)
    print("  SQLite costs %s gzipped." % f"{d:,}")
print("=" * 64)
PY

if [ "$KEEP" = false ]; then
	rm -rf "$OUT"/engine-only "$OUT"/with-sqlite
fi
