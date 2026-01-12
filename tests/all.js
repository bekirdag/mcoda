#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const run = (label, cmd, args, options = {}) => {
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...options,
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
let winTestHome;

if (process.env.DOCDEX_UPDATE_CHECK == null) {
  process.env.DOCDEX_UPDATE_CHECK = "0";
}

if (process.platform === "win32") {
  winTestHome = mkdtempSync(path.join(os.tmpdir(), "mcoda-win-home-"));
  const parsed = path.parse(winTestHome);
  process.env.HOME = winTestHome;
  process.env.USERPROFILE = winTestHome;
  process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
  process.env.HOMEPATH = winTestHome.slice(parsed.root.length - 1);
  process.env.MCODA_SKIP_DOCDEX_CHECKS = "1";
  process.env.MCODA_SKIP_DOCDEX_CLIENT_TESTS = "1";
  if (!process.env.NODE_TEST_CONCURRENCY) {
    process.env.NODE_TEST_CONCURRENCY = "1";
  }
  process.on("exit", () => {
    try {
      rmSync(winTestHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });
}

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
  const shell = process.platform === "win32";
  if (process.platform === "win32") {
    const workspacePackages = [
      "@mcoda/shared",
      "@mcoda/generators",
      "@mcoda/integrations",
      "@mcoda/db",
      "@mcoda/agents",
      "@mcoda/core",
      "mcoda",
      "@mcoda/testing",
    ];
    for (const pkg of workspacePackages) {
      let workspace = run(`workspace-tests:${pkg}`, pnpm, ["--filter", pkg, "run", "test"], { shell });
      if (workspace.error) {
        const fallback = run(`workspace-tests-corepack:${pkg}`, "corepack", ["pnpm", "--filter", pkg, "run", "test"], {
          shell,
        });
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
  } else {
    let workspace = run("workspace-tests", pnpm, ["-r", "run", "test"], { shell });
    if (workspace.error) {
      const fallback = run("workspace-tests-corepack", "corepack", ["pnpm", "-r", "run", "test"], { shell });
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
}

// NOTE: Register any new standalone test scripts here if they are not discovered automatically.
const extraTests = [
  path.join("tests", "gateway-trio-plan.test.js"),
];
// NOTE: Add dist test files here when a package test is not covered by the workspace runner or needs explicit inclusion.
const extraWorkspaceTests = [
  path.join("packages", "db", "dist", "__tests__", "WorkspaceRepository.test.js"),
  path.join("packages", "core", "dist", "services", "agents", "__tests__", "GatewayHandoff.test.js"),
  path.join("packages", "core", "dist", "api", "__tests__", "AgentsApi.test.js"),
  path.join("packages", "core", "dist", "services", "docs", "__tests__", "DocsService.test.js"),
  path.join("packages", "core", "dist", "services", "execution", "__tests__", "WorkOnTasksService.test.js"),
  path.join("packages", "core", "dist", "services", "execution", "__tests__", "QaTasksService.test.js"),
  path.join("packages", "core", "dist", "services", "review", "__tests__", "CodeReviewService.test.js"),
  path.join("packages", "core", "dist", "services", "shared", "__tests__", "ProjectGuidance.test.js"),
  path.join("packages", "core", "dist", "services", "execution", "__tests__", "GatewayTrioService.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "GatewayTrioCommand.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "AgentRunCommand.test.js"),
  path.join("packages", "integrations", "dist", "docdex", "__tests__", "DocdexRuntime.test.js"),
];

const testFiles = collectTests(path.join(root, "tests")).map((file) => path.relative(root, file));
const resolvedExtras = [...extraTests, ...extraWorkspaceTests].filter((file) => existsSync(path.join(root, file)));
const allTests = Array.from(new Set([...testFiles, ...resolvedExtras]));
const repoTests = run("repo-tests", process.execPath, ["--test", ...allTests]);
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

console.log(`MCODA_RUN_ALL_TESTS_COMPLETE status=${failed ? "failed" : "passed"}`);
process.exit(failed ? 1 : 0);
