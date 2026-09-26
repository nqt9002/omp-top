#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v bun >/dev/null 2>&1; then
  echo "error: Bun >= 1.3.14 is required." >&2
  exit 1
fi
exec bun "$SCRIPT_DIR/src/main.mjs" install
