# Buildroot's build environment. Buildroot only runs on a Linux host, so on
# macOS (and everywhere else, for reproducibility) the build happens in here.
# No --platform pin: the container runs the host's native architecture and
# cross-compiles to i686, which is what Buildroot is for.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        bc \
        binutils \
        bison \
        build-essential \
        bzip2 \
        ca-certificates \
        cpio \
        file \
        flex \
        libelf-dev \
        libncurses-dev \
        libssl-dev \
        patch \
        perl \
        python3 \
        rsync \
        unzip \
        wget \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /x
