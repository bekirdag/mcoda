#!/usr/bin/env bash
set -euo pipefail

# Simple packer to build a local-installable mcoda CLI tarball from dist/.
# It synthesizes a minimal package.json, a dispatcher bin, copies dist/, and runs npm pack.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${ROOT}/dist"
PACKAGE_DIR="${ROOT}/.mcoda-package"
ARTIFACTS="${ROOT}/artifacts"

if [[ ! -d "${DIST}/cli" ]]; then
  echo "dist/cli not found. Build the CLI first (tsc/esbuild) so dist/ is populated." >&2
  exit 1
fi

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  if git -C "${ROOT}" rev-parse --short HEAD >/dev/null 2>&1; then
    VERSION="0.0.0-$(git -C "${ROOT}" rev-parse --short HEAD)"
  else
    VERSION="0.0.0-local"
  fi
fi

rm -rf "${PACKAGE_DIR}"
mkdir -p "${PACKAGE_DIR}/bin" "${PACKAGE_DIR}/cli" "${ARTIFACTS}"

# Copy compiled CLI/core into the package payload.
rsync -a "${DIST}/" "${PACKAGE_DIR}/"

# Discover commands from dist/cli/*.js
mapfile -t COMMANDS < <(cd "${DIST}/cli" && ls *.js 2>/dev/null | sed 's/\.js$//')

# Build dispatcher bin that routes `mcoda <command>` to dist/cli/<command>.js
cat > "${PACKAGE_DIR}/bin/mcoda" <<'EOF'
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const commands = new Set(JSON.parse(process.env.MCODA_COMMANDS ?? "[]"));

const cmd = process.argv[2];
if (!cmd || !commands.has(cmd)) {
  console.error(`Usage: mcoda <command>\nAvailable: ${Array.from(commands).join(", ")}`);
  process.exit(1);
}

const target = path.join(__dirname, "..", "cli", `${cmd}.js`);
const child = spawn(process.execPath, [target, ...process.argv.slice(3)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
EOF
chmod +x "${PACKAGE_DIR}/bin/mcoda"

# Synthesize package.json with a single dispatcher bin.
cat > "${PACKAGE_DIR}/package.json" <<EOF
{
  "name": "mcoda-local",
  "version": "${VERSION}",
  "private": false,
  "type": "module",
  "bin": {
    "mcoda": "bin/mcoda"
  }
}
EOF

# Inject the command list for the dispatcher (avoids external deps like jq).
export MCODA_COMMANDS
MCODA_COMMANDS="$(node -e 'const cmds = process.argv.slice(1); console.log(JSON.stringify(cmds));' "${COMMANDS[@]}")"

(
  cd "${PACKAGE_DIR}"
  npm pack --pack-destination "${ARTIFACTS}"
)

echo "Packaged mcoda-local@${VERSION} → ${ARTIFACTS}"
echo "Install globally: npm install -g ${ARTIFACTS}/mcoda-local-${VERSION}.tgz"
