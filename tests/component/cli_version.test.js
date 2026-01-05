import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../../packages/cli/package.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entrypointPath = path.join(root, "packages", "cli", "dist", "bin", "McodaEntrypoint.js");

const fileExists = async (candidate) => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

test("mcoda --version prints the CLI package version", async (t) => {
  if (!(await fileExists(entrypointPath))) {
    t.skip("CLI dist output not found; run pnpm -r run build first.");
    return;
  }

  const { McodaEntrypoint } = await import(entrypointPath);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await McodaEntrypoint.run(["--version"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs[0], packageJson.version);
});
