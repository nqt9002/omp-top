#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${OMP_TOP_HOME:-$HOME/.local/share/omp-top}"
BIN_DIR="${OMP_TOP_BIN_DIR:-$HOME/.local/bin}"
OMP_BIN="${OMP_TOP_OMP_BIN:-omp}"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: Bun is required (OMP currently requires Bun >= 1.3.14)." >&2
  exit 1
fi
if ! command -v "$OMP_BIN" >/dev/null 2>&1; then
  echo "error: OMP binary '$OMP_BIN' was not found in PATH." >&2
  exit 1
fi

OMP_VERSION="${OMP_TOP_OMP_VERSION:-}"
if [[ -z "$OMP_VERSION" ]]; then
  VERSION_TEXT="$($OMP_BIN --version 2>/dev/null || true)"
  OMP_VERSION="$(printf '%s\n' "$VERSION_TEXT" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
fi
if [[ -z "$OMP_VERSION" ]]; then
  echo "error: could not detect OMP version. Re-run with OMP_TOP_OMP_VERSION=x.y.z ./install.sh" >&2
  exit 1
fi

echo "Installing omp-top v0.3.0 for OMP $OMP_VERSION"
mkdir -p "$DEST" "$BIN_DIR"

if [[ "$SCRIPT_DIR" != "$DEST" ]]; then
  rm -rf "$DEST/src" "$DEST/test"
  cp -R "$SCRIPT_DIR/src" "$DEST/src"
  cp -R "$SCRIPT_DIR/test" "$DEST/test"
  cp "$SCRIPT_DIR/package.json" "$DEST/package.json"
  cp "$SCRIPT_DIR/tsconfig.json" "$DEST/tsconfig.json"
  cp "$SCRIPT_DIR/README.md" "$DEST/README.md"
  cp "$SCRIPT_DIR/install.sh" "$DEST/install.sh"
  cp "$SCRIPT_DIR/uninstall.sh" "$DEST/uninstall.sh"
fi

cd "$DEST"
rm -rf node_modules bun.lock bun.lockb
bun add --exact \
  "@oh-my-pi/omp-stats@$OMP_VERSION" \
  "@oh-my-pi/pi-tui@$OMP_VERSION" \
  "@oh-my-pi/pi-utils@$OMP_VERSION"

bun test

# Use zsh on macOS so an invalid/deleted caller cwd can be repaired before Bun
# starts. Bun itself asks libuv for cwd during startup and otherwise aborts with
# uv_cwd/EPERM before our TypeScript gets a chance to run.
cat > "$BIN_DIR/omp-top" <<SHIM
#!/bin/zsh
if ! builtin pwd -P >/dev/null 2>&1; then
  builtin cd "\$HOME" || exit 1
fi
export OMP_TOP_OMP_BIN="${OMP_BIN}"
exec bun "$DEST/src/main.ts" "\$@"
SHIM
chmod +x "$BIN_DIR/omp-top" "$DEST/install.sh" "$DEST/uninstall.sh"

echo
echo "Installed: $BIN_DIR/omp-top"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "NOTE: $BIN_DIR is not currently in PATH. Add this to ~/.zshrc:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo "Then run: source ~/.zshrc"
fi
echo "Run: omp-top"
