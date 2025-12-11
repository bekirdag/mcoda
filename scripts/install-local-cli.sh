#!/usr/bin/env bash
set -euo pipefail

# Build the workspace and link the mcoda CLI globally for local development.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-pnpm}"

if ! command -v "${PNPM_BIN}" >/dev/null 2>&1; then
  echo "pnpm not found. Install it with 'npm install -g pnpm' or point PNPM_BIN to your pnpm binary." >&2
  exit 1
fi

echo "Installing workspace dependencies..."
"${PNPM_BIN}" -C "${ROOT}" install

echo "Building all packages (includes CLI dependencies)..."
"${PNPM_BIN}" -C "${ROOT}" -r run build

echo "Linking mcoda CLI globally..."
"${PNPM_BIN}" -C "${ROOT}/packages/cli" link --global

echo
echo "mcoda is now linked globally. Verify with: mcoda --version"
