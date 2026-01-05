#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const run = (label, cmd, args) => {
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  const durationMs = Date.now() - start;
  const status = typeof result.status === "number" ? result.status : 1;
  return {
    label,
    cmd: [cmd, ...args].join(" "),
    status,
    durationMs,
    error: result.error ? String(result.error) : undefined,
  };
};

const results = [];

const resolvePnpm = () => {
  if (process.env.PNPM_BIN) return process.env.PNPM_BIN;
  const pnpmHome = process.env.PNPM_HOME;
  if (pnpmHome) {
    const candidate = path.join(pnpmHome, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
};

const pnpm = resolvePnpm();
let failed = false;

const collectTests = (dir) => {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "results") continue;
      files.push(...collectTests(fullPath));
    } else if (entry.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }
  return files;
};

if (process.env.MCODA_SKIP_WORKSPACE_TESTS !== "1") {
  let workspace = run("workspace-tests", pnpm, ["-r", "run", "test"]);
  if (workspace.status !== 0 && workspace.error?.includes("ENOENT")) {
    const fallback = run("workspace-tests-corepack", "corepack", ["pnpm", "-r", "run", "test"]);
    results.push(workspace, fallback);
    workspace = fallback;
  } else {
    results.push(workspace);
  }
  if (workspace.error) {
    console.error(`[${workspace.label}] ${workspace.error}`);
  }
  if (workspace.status !== 0) failed = true;
}

const testFiles = collectTests(path.join(root, "tests")).map((file) => path.relative(root, file));
const repoTests = run("repo-tests", process.execPath, ["--test", ...testFiles]);
results.push(repoTests);
if (repoTests.error) {
  console.error(`[${repoTests.label}] ${repoTests.error}`);
}
if (repoTests.status !== 0) failed = true;

const artifactsDir = path.join(root, "tests", "results");
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(
  path.join(artifactsDir, "test-summary.json"),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      results,
    },
    null,
    2,
  ) +
    "\n",
);

process.exit(failed ? 1 : 0);
