#!/usr/bin/env bash
set -euo pipefail
DEST="${OMP_TOP_HOME:-$HOME/.local/share/omp-top}"
BIN_DIR="${OMP_TOP_BIN_DIR:-$HOME/.local/bin}"
rm -f "$BIN_DIR/omp-top"
rm -rf "$DEST"
echo "Removed omp-top."
