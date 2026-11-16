#!/usr/bin/env bash
# Idempotent Stockfish setup for ChessDNA.
#
# Strategy:
#   1. If backend/bin/stockfish already exists and answers UCI, keep it.
#   2. Try `apt-get install -y stockfish`, then COPY the binary into
#      backend/bin/stockfish so it survives VM replacement (system paths
#      under /usr are wiped; $HOME persists).
#   3. On x86-64, fall back to downloading the official Linux tarball from
#      the official-stockfish/Stockfish GitHub releases into backend/bin/.
#   4. On ARM64 (no official Ubuntu binary exists) or if the download
#      fails, build Stockfish 17.1 from source (needs g++/make/git).
#
# Usage: bash backend/scripts/setup_stockfish.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"
BIN="$BIN_DIR/stockfish"
mkdir -p "$BIN_DIR"

uci_ok() {
    [ -x "$1" ] && printf 'uci\nquit\n' | timeout 10 "$1" 2>/dev/null | grep -q "uciok"
}

if uci_ok "$BIN"; then
    echo "Stockfish already present and working: $BIN"
    "$BIN" uci 2>/dev/null | head -1 || true
    exit 0
fi

# --- 1) apt ---------------------------------------------------------------
# NOTE: apt sources can hang behind restricted egress proxies, so every
# apt invocation is time-boxed; on timeout we fall through to the download.
if command -v apt-get >/dev/null 2>&1; then
    echo "Trying apt-get install stockfish..."
    if timeout 120 apt-get install -y stockfish >/dev/null 2>&1 \
        || (timeout 120 apt-get update -qq >/dev/null 2>&1 && timeout 180 apt-get install -y stockfish >/dev/null 2>&1); then
        if command -v stockfish >/dev/null 2>&1; then
            echo "apt install succeeded; copying binary to $BIN for durability."
            cp "$(command -v stockfish)" "$BIN"
            chmod +x "$BIN"
        fi
    else
        echo "apt install failed; falling back to GitHub release download."
    fi
fi

# --- 2) GitHub release download (x86-64 only) ------------------------------
# Stockfish publishes no official Ubuntu ARM64 binary, so ARM64 machines
# skip straight to the source build in section 3. A failed download also
# falls through to the source build instead of aborting.
ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ] && ! uci_ok "$BIN"; then
    echo "Downloading official Stockfish release tarball..."
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT

    # Pick the best binary flavour the CPU supports.
    FLAVOUR="ubuntu-x86-64-avx2"
    if ! grep -qi avx2 /proc/cpuinfo 2>/dev/null; then
        FLAVOUR="ubuntu-x86-64"
    fi

    API="https://api.github.com/repos/official-stockfish/Stockfish/releases/latest"
    URL="$(curl -fsSL "$API" 2>/dev/null \
        | grep -o '"browser_download_url": *"[^"]*'"$FLAVOUR"'[^"]*"' \
        | head -1 | sed 's/.*: *"//; s/"$//')" || true

    if [ -z "${URL:-}" ]; then
        # Pinned fallback (Stockfish 17.1 release assets).
        URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_17.1/stockfish-${FLAVOUR}.tar"
        echo "GitHub API lookup failed; using pinned fallback: $URL"
    fi

    echo "Fetching: $URL"
    if curl -fL "$URL" -o "$TMP/sf.tar" 2>/dev/null && tar -xf "$TMP/sf.tar" -C "$TMP" 2>/dev/null; then
        # Tarball contains stockfish/stockfish-<flavour> (or similar); find the executable.
        CANDIDATE="$(find "$TMP" -type f -name 'stockfish*' -perm -u+x | head -1)"
        if [ -n "$CANDIDATE" ]; then
            cp "$CANDIDATE" "$BIN"
            chmod +x "$BIN"
        fi
    fi
    if ! uci_ok "$BIN"; then
        echo "Release download did not produce a working binary; falling back to a source build."
    fi
    rm -rf "$TMP"
    trap - EXIT
fi

# --- 3) Build from source --------------------------------------------------
# Reached on ARM64, or when apt + download both failed. Builds the pinned
# Stockfish 17.1 tag; ARCH=armv8 on ARM, native detect on x86-64.
if ! uci_ok "$BIN"; then
    command -v git >/dev/null 2>&1 || { echo "ERROR: git is required to build Stockfish from source" >&2; exit 1; }
    command -v make >/dev/null 2>&1 || { echo "ERROR: make is required to build Stockfish from source" >&2; exit 1; }
    command -v g++ >/dev/null 2>&1 || { echo "ERROR: g++ is required to build Stockfish from source" >&2; exit 1; }
    echo "Building Stockfish 17.1 from source..."
    BUILD_DIR="$(mktemp -d)"
    trap 'rm -rf "$BUILD_DIR"' EXIT
    git clone -q --depth 1 --branch sf_17.1 https://github.com/official-stockfish/Stockfish.git "$BUILD_DIR/sf"
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        BUILD_ARCH="armv8"
    else
        BUILD_ARCH="x86-64"
    fi
    (cd "$BUILD_DIR/sf/src" && make -j"$(nproc 2>/dev/null || echo 2)" build ARCH="$BUILD_ARCH" >/dev/null 2>&1) \
        || (cd "$BUILD_DIR/sf/src" && make -j"$(nproc 2>/dev/null || echo 2)" build ARCH=general-64 >/dev/null 2>&1) \
        || { echo "ERROR: Stockfish source build failed" >&2; exit 1; }
    cp "$BUILD_DIR/sf/src/stockfish" "$BIN"
    chmod +x "$BIN"
    rm -rf "$BUILD_DIR"
    trap - EXIT
fi

# --- Verify ---------------------------------------------------------------
if uci_ok "$BIN"; then
    echo "Stockfish verified: $BIN"
    printf 'uci\nquit\n' | "$BIN" | grep -m1 -i "id name" || true
else
    echo "ERROR: $BIN does not respond to UCI" >&2
    exit 1
fi
