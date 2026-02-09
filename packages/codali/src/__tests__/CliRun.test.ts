import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getGlobalWorkspaceDir } from "../runtime/StoragePaths.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "..", "cli.js");
const buildEnv = (homeDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODALI_") || key.startsWith("DOCDEX_") || key.startsWith("MCODA_")) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...overrides,
  };
};

const TRANSIENT_CLI_FAILURES = [
  /Docdex health check failed/i,
  /fetch failed/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /Workspace is locked by run/i,
];

const formatCliFailure = (result: SpawnSyncReturns<string>): string => {
  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  return [
    `status=${String(result.status)} signal=${String(result.signal)} error=${String(result.error ?? "")}`,
    `stdout:\n${stdout}`,
    `stderr:\n${stderr}`,
  ].join("\n");
};

const runCodali = (
  args: string[],
  env: NodeJS.ProcessEnv,
  maxRetries = 1,
): SpawnSyncReturns<string> => {
  let attempt = 0;
  let result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env,
  }) as SpawnSyncReturns<string>;
  while (result.status !== 0 && attempt < maxRetries) {
    const stderr = (result.stderr ?? "").toString();
    if (!TRANSIENT_CLI_FAILURES.some((pattern) => pattern.test(stderr))) {
      break;
    }
    attempt += 1;
    result = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      env,
    }) as SpawnSyncReturns<string>;
  }
  return result;
};

const buildSmartEnv = (homeDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  buildEnv(homeDir, {
    // Keep smart tests anchored to the workspace file the stub pipeline edits.
    CODALI_CONTEXT_PREFERRED_FILES: "src/index.ts",
    ...overrides,
  });

test("codali run executes with stub provider", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "hello", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "run",
      "--no-deep-investigation",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--interpreter-provider",
      "stub",
      "--interpreter-model",
      "stub-model",
      "--task",
      taskFile,
    ],
    buildEnv(homeDir, { CODALI_SMART: "0" }),
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  assert.match(result.stdout ?? "", /(stub:|"patches")/);
  assert.match(result.stderr ?? "", /Preflight/);
});

test("codali run emits status events", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-status-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "hello", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "run",
      "--no-deep-investigation",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--interpreter-provider",
      "stub",
      "--interpreter-model",
      "stub-model",
      "--task",
      taskFile,
    ],
    buildEnv(homeDir, { CODALI_SMART: "0" }),
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  assert.match(result.stdout ?? "", /stub:/);
  assert.match(result.stderr ?? "", /\[thinking\]/);
});

test("codali run --smart executes smart pipeline with stub provider", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-smart-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "hello", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "run",
      "--smart",
      "--no-deep-investigation",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--interpreter-provider",
      "stub",
      "--interpreter-model",
      "stub-model",
      "--task",
      taskFile,
    ],
    buildSmartEnv(homeDir),
    2,
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  assert.match(result.stdout ?? "", /(stub:|"patches")/);
  assert.match(result.stderr ?? "", /Preflight/);
});

test("codali run accepts inline task input", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-inline-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const srcDir = path.join(workspaceRoot, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "--no-deep-investigation",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--interpreter-provider",
      "stub",
      "--interpreter-model",
      "stub-model",
      "hello inline",
    ],
    { encoding: "utf8", env: buildEnv(homeDir, { CODALI_SMART: "0" }) },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout ?? "", /stub:/);
});

test("codali run --smart freeform uses interpreter", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-freeform-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "update index", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "run",
      "--smart",
      "--no-deep-investigation",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--task",
      taskFile,
      "--builder-mode",
      "freeform",
      "--interpreter-provider",
      "stub",
      "--interpreter-model",
      "stub-model",
      "--interpreter-format",
      "json",
    ],
    buildSmartEnv(homeDir),
    2,
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  const updated = readFileSync(path.join(srcDir, "index.ts"), "utf8");
  assert.match(updated, /const value = 2;/);
});

test("codali run --smart persists local context when enabled", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-context-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "hello", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "run",
      "--smart",
      "--no-deep-investigation",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--interpreter-provider",
      "stub",
      "--interpreter-model",
      "stub-model",
      "--task",
      taskFile,
    ],
    buildSmartEnv(homeDir, { CODALI_LOCAL_CONTEXT_ENABLED: "1" }),
    2,
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  const contextDir = path.join(getGlobalWorkspaceDir(workspaceRoot), "codali", "context");
  process.env.HOME = originalHome;
  const files = existsSync(contextDir) ? readdirSync(contextDir) : [];
  assert.ok(files.some((file) => file.endsWith(".jsonl")));
});
