#!/usr/bin/env bash
# Idempotent Stockfish setup for ChessDNA.
#
# Strategy:
#   1. If backend/bin/stockfish already exists and answers UCI, keep it.
#   2. Try `apt-get install -y stockfish`, then COPY the binary into
#      backend/bin/stockfish so it survives VM replacement (system paths
#      under /usr are wiped; $HOME persists).
#   3. Fall back to downloading the official Linux x86-64 tarball from the
#      official-stockfish/Stockfish GitHub releases into backend/bin/.
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

# --- 2) GitHub release download -------------------------------------------
if ! uci_ok "$BIN"; then
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
    curl -fL "$URL" -o "$TMP/sf.tar"
    tar -xf "$TMP/sf.tar" -C "$TMP"
    # Tarball contains stockfish/stockfish-<flavour> (or similar); find the executable.
    CANDIDATE="$(find "$TMP" -type f -name 'stockfish*' -perm -u+x | head -1)"
    if [ -z "$CANDIDATE" ]; then
        echo "ERROR: no stockfish executable found in tarball" >&2
        exit 1
    fi
    cp "$CANDIDATE" "$BIN"
    chmod +x "$BIN"
fi

# --- Verify ---------------------------------------------------------------
if uci_ok "$BIN"; then
    echo "Stockfish verified: $BIN"
    printf 'uci\nquit\n' | "$BIN" | grep -m1 -i "id name" || true
else
    echo "ERROR: $BIN does not respond to UCI" >&2
    exit 1
fi
