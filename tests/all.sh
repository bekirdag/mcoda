#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_BIN="${NODE_BIN:-node}"

cd "$ROOT"
exec "$NODE_BIN" "$ROOT/tests/all.js" "$@"
