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

const resolveNode = () => {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  return process.platform === "win32" ? "node.exe" : "node";
};

const pnpm = resolvePnpm();
const nodeBin = resolveNode();
console.log(`[tests] using node: ${nodeBin}`);
let failed = false;
let markerPrinted = false;
let winTestHome;

if (process.env.DOCDEX_UPDATE_CHECK == null) {
  process.env.DOCDEX_UPDATE_CHECK = "0";
}

const printMarker = () => {
  if (markerPrinted) return;
  markerPrinted = true;
  console.log(`MCODA_RUN_ALL_TESTS_COMPLETE status=${failed ? "failed" : "passed"}`);
};

process.on("exit", () => {
  printMarker();
});

process.on("uncaughtException", (error) => {
  failed = true;
  console.error(error);
  printMarker();
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  failed = true;
  console.error(error);
  printMarker();
  process.exit(1);
});

if (process.platform === "win32") {
  winTestHome = mkdtempSync(path.join(os.tmpdir(), "mcoda-win-home-"));
  const parsed = path.parse(winTestHome);
  process.env.HOME = winTestHome;
  process.env.USERPROFILE = winTestHome;
  process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
  process.env.HOMEPATH = winTestHome.slice(parsed.root.length - 1);
  process.env.MCODA_SKIP_DOCDEX_CHECKS = "1";
  process.env.MCODA_SKIP_DOCDEX_CLIENT_TESTS = "1";
  if (!process.env.MCODA_FS_RM_RETRIES) {
    process.env.MCODA_FS_RM_RETRIES = "20";
  }
  if (!process.env.MCODA_FS_RM_DELAY_MS) {
    process.env.MCODA_FS_RM_DELAY_MS = "100";
  }
  const patchPath = path.join(root, "tests", "helpers", "win32-fs-patch.cjs");
  const existingNodeOptions = process.env.NODE_OPTIONS ?? "";
  const requireFlag = `--require=${patchPath}`;
  if (!existingNodeOptions.includes(requireFlag)) {
    process.env.NODE_OPTIONS = `${existingNodeOptions} ${requireFlag}`.trim();
  }
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
  path.join("packages", "db", "dist", "__tests__", "WorkspaceMigrations.test.js"),
  path.join("packages", "db", "dist", "__tests__", "GlobalRepository.test.js"),
  path.join("packages", "db", "dist", "__tests__", "WorkspaceRepository.test.js"),
  path.join("packages", "core", "dist", "services", "agents", "__tests__", "GatewayHandoff.test.js"),
  path.join("packages", "core", "dist", "services", "agents", "__tests__", "GatewayAgentService.test.js"),
  path.join("packages", "core", "dist", "api", "__tests__", "AgentsApi.test.js"),
  path.join("packages", "core", "dist", "services", "docs", "__tests__", "DocsService.test.js"),
  path.join("packages", "core", "dist", "services", "execution", "__tests__", "WorkOnTasksService.test.js"),
  path.join("packages", "core", "dist", "services", "execution", "__tests__", "TaskStateService.test.js"),
  path.join("packages", "core", "dist", "services", "execution", "__tests__", "QaTasksService.test.js"),
  path.join("packages", "core", "dist", "services", "estimate", "__tests__", "VelocityAndEstimate.test.js"),
  path.join("packages", "core", "dist", "services", "review", "__tests__", "CodeReviewService.test.js"),
  path.join("packages", "core", "dist", "services", "telemetry", "__tests__", "TelemetryService.test.js"),
  path.join("packages", "core", "dist", "services", "shared", "__tests__", "ProjectGuidance.test.js"),
  path.join("packages", "core", "dist", "services", "backlog", "__tests__", "TaskOrderingHeuristics.test.js"),
  path.join("packages", "core", "dist", "services", "backlog", "__tests__", "TaskOrderingService.test.js"),
  path.join("packages", "core", "dist", "services", "execution", "__tests__", "GatewayTrioService.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "GatewayTrioCommand.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "AgentRunCommand.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "TestAgentCommand.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "AgentsCommands.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "RoutingCommands.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "TelemetryCommands.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "JobsCommands.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "BacklogCommands.test.js"),
  path.join("packages", "cli", "dist", "__tests__", "EstimateCommands.test.js"),
  path.join("packages", "integrations", "dist", "docdex", "__tests__", "DocdexRuntime.test.js"),
  path.join("packages", "integrations", "dist", "docdex", "__tests__", "DocdexClient.test.js"),
];

const repoOverride = (process.env.MCODA_REPO_TEST_FILES ?? "")
  .split(",")
  .map((file) => file.trim())
  .filter(Boolean)
  .map((file) => (path.isAbsolute(file) ? path.relative(root, file) : file));
const testFiles = repoOverride.length
  ? []
  : collectTests(path.join(root, "tests")).map((file) => path.relative(root, file));
const resolvedExtras = repoOverride.length
  ? []
  : [...extraTests, ...extraWorkspaceTests].filter((file) => existsSync(path.join(root, file)));
const allTests = repoOverride.length ? Array.from(new Set(repoOverride)) : Array.from(new Set([...testFiles, ...resolvedExtras]));
if (process.env.MCODA_SKIP_REPO_TESTS !== "1") {
  const repoTests = run("repo-tests", nodeBin, ["--test", ...allTests]);
  results.push(repoTests);
  if (repoTests.error) {
    console.error(`[${repoTests.label}] ${repoTests.error}`);
  }
  if (repoTests.status !== 0) failed = true;
}

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

printMarker();
process.exit(failed ? 1 : 0);
