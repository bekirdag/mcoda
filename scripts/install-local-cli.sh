#!/usr/bin/env bash
set -euo pipefail

# Build the workspace and link the CLI binaries globally for local development.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-pnpm}"

if ! command -v "${PNPM_BIN}" >/dev/null 2>&1; then
  echo "pnpm not found. Install it with 'npm install -g pnpm' or point PNPM_BIN to your pnpm binary." >&2
  exit 1
fi

echo "Installing local CLI binaries..."
"${PNPM_BIN}" -C "${ROOT}" run install:local:bins
