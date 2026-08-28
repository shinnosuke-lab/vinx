# The toolchain web/ is built with, baked so a build is reproducible and never
# waits on tool downloads.
#
# Four things wasm-pack would otherwise fetch at build time are pre-installed:
#
#   wasm-pack            the release binary
#   wasm-bindgen CLI     wasm-pack fetches it at build time otherwise
#   wasm-opt (binaryen)  same, and wasm-pack pins version_117
#   Chrome               apt, from Google's repo, plus ~73 MB of Debian deps
#
# wasm-pack looks each tool up on PATH before it downloads anything ("First
# attempt to look up in PATH. If found assume it works." -- its find_wasm_opt),
# so baking them is enough; nothing upstream has to be patched.
FROM --platform=linux/amd64 rust:1-bookworm

# WASM_BINDGEN_VERSION must equal the wasm-bindgen version in web/Cargo.lock.
# wasm-pack compares them and silently falls back to downloading on a mismatch.
# deploy/ci.sh asserts the pair on every build so the mismatch is reported,
# not suffered.
ARG WASM_PACK_VERSION=0.15.0
ARG WASM_BINDGEN_VERSION=0.2.126
ARG BINARYEN_VERSION=version_117
ARG PLAYWRIGHT_VERSION=1.62.1
ARG NODE_MAJOR=22

# Node 20+ for vite; NodeSource because bookworm's node is far older.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

RUN curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
        | tar -xz -C /tmp \
    && install -m 755 "/tmp/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack" /usr/local/bin/ \
    && rm -rf /tmp/wasm-pack-*

# wasm-bindgen-test-runner comes in the same tarball and is what `wasm-pack
# test` runs the wasm suites with.
RUN curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
        | tar -xz -C /tmp \
    && install -m 755 "/tmp/wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl/wasm-bindgen" /usr/local/bin/ \
    && install -m 755 "/tmp/wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl/wasm-bindgen-test-runner" /usr/local/bin/ \
    && rm -rf /tmp/wasm-bindgen-*

# The version wasm-pack would have fetched itself. The page's Cargo.toml passes
# its own --enable flags, so this needs to be recent enough to know them rather
# than exactly this release, but matching what upstream pins costs nothing.
RUN curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
        | tar -xz -C /tmp \
    && install -m 755 "/tmp/binaryen-${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/ \
    && rm -rf /tmp/binaryen-*

# Real Chrome, not playwright's own build: the browser suite asks for
# `channel: 'chrome'` because that is what a person opens the page with.
# --with-deps is the apt half -- fonts, libgl, xvfb, ~50 packages -- and it is
# the slowest thing in a build that installs it every time, since the container
# is --rm. The playwright package version only chooses which installer runs;
# the browser it installs is Google's current stable either way.
RUN npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chrome \
    && rm -rf /root/.npm/_npx /var/lib/apt/lists/*

# Fail here rather than in CI. An image whose tools are missing or whose
# wasm-bindgen does not match the lockfile is one that looks fine until a
# build discovers it mid-run.
RUN set -e; \
    rustup target list --installed | grep -qx wasm32-unknown-unknown; \
    wasm-pack --version; \
    wasm-bindgen --version; \
    wasm-bindgen-test-runner --version; \
    wasm-opt --version; \
    google-chrome --version; \
    node --version; \
    test "$(wasm-bindgen --version | awk '{print $2}')" = "${WASM_BINDGEN_VERSION}"

WORKDIR /workdir/project
