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

const extractRunMeta = (result: SpawnSyncReturns<string>): Record<string, unknown> | undefined => {
  const stderr = (result.stderr ?? "").toString();
  const match = stderr.match(/CODALI_RUN_META\s+({.*})/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
  const meta = extractRunMeta(result);
  assert.equal((meta?.workflow as { name?: string } | undefined)?.name, "run");
});

test("codali fix command resolves fix workflow profile", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-fix-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "fix the value", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "fix",
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
    2,
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  const meta = extractRunMeta(result);
  const workflow = meta?.workflow as { name?: string; source?: string } | undefined;
  assert.equal(workflow?.name, "fix");
  assert.equal(workflow?.source, "command");
});

test("codali run --profile explain uses no-write workflow profile", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-profile-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  const targetFile = path.join(srcDir, "index.ts");
  writeFileSync(taskFile, "explain what this file does", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(targetFile, "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "run",
      "--profile",
      "explain",
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
    2,
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  assert.equal(readFileSync(targetFile, "utf8"), "const value = 1;\n");
  const meta = extractRunMeta(result);
  const workflow = meta?.workflow as { name?: string; source?: string; allowWrites?: boolean } | undefined;
  assert.equal(workflow?.name, "explain");
  assert.equal(workflow?.source, "cli");
  assert.equal(workflow?.allowWrites, false);
});

test("command-derived profile wins over --profile override", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-profile-precedence-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "fix the value", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");

  const result = runCodali(
    [
      "fix",
      "--profile",
      "explain",
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
    2,
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  const meta = extractRunMeta(result);
  const workflow = meta?.workflow as { name?: string; source?: string } | undefined;
  assert.equal(workflow?.name, "fix");
  assert.equal(workflow?.source, "command");
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

test("codali run --smart exits non-zero when smart pipeline fails", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-smart-fail-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  const srcDir = path.join(workspaceRoot, "src");
  writeFileSync(taskFile, "update the homepage", "utf8");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "main.ts"), "const value = 1;\n", "utf8");

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
  );

  assert.notEqual(result.status, 0, "smart pipeline failure should return non-zero exit status");
  assert.match(
    result.stderr ?? "",
    /(Smart pipeline failed|Architect quality gate failed|patch_apply_failed|ENOENT: no such file or directory)/i,
  );
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

test("codali eval executes suite and emits metrics", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-eval-run-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const srcDir = path.join(workspaceRoot, "src");
  const taskFile = path.join(workspaceRoot, "task.txt");
  const suitePath = path.join(workspaceRoot, "suite.json");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");
  writeFileSync(taskFile, "update the value", "utf8");
  writeFileSync(
    suitePath,
    JSON.stringify({
      schema_version: 1,
      suite_id: "cli-eval-pass",
      thresholds: {
        verification_pass_rate_min: 0,
        hallucination_rate_max: 1,
        scope_violation_rate_max: 1,
      },
      tasks: [
        {
          id: "task-1",
          task_file: taskFile,
          command: "run",
          assertions: {
            expect_success: true,
          },
        },
      ],
    }),
    "utf8",
  );

  const result = runCodali(
    [
      "eval",
      "--suite",
      suitePath,
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--smart",
      "--no-deep-investigation",
      "--output",
      "json",
    ],
    buildSmartEnv(homeDir, { CODALI_LOCAL_CONTEXT_ENABLED: "0" }),
    2,
  );

  assert.equal(result.status, 0, formatCliFailure(result));
  assert.match(result.stdout ?? "", /"m001_task_success_rate"/);
  assert.match(result.stdout ?? "", /"gates"/);
});

test("codali eval returns deterministic non-zero on gate failures", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-eval-gate-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const srcDir = path.join(workspaceRoot, "src");
  const taskFile = path.join(workspaceRoot, "task.txt");
  const suitePath = path.join(workspaceRoot, "suite-gate.json");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");
  writeFileSync(taskFile, "update the value", "utf8");
  writeFileSync(
    suitePath,
    JSON.stringify({
      schema_version: 1,
      suite_id: "cli-eval-gate-fail",
      thresholds: {
        verification_pass_rate_min: 1,
      },
      tasks: [
        {
          id: "task-1",
          task_file: taskFile,
          command: "run",
          assertions: {
            expect_success: true,
          },
        },
      ],
    }),
    "utf8",
  );

  const result = runCodali(
    [
      "eval",
      "--suite",
      suitePath,
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--smart",
      "--no-deep-investigation",
      "--output",
      "json",
    ],
    buildSmartEnv(homeDir, { CODALI_LOCAL_CONTEXT_ENABLED: "0" }),
    2,
  );

  assert.equal(result.status, 5, formatCliFailure(result));
  assert.match(result.stderr ?? "", /Eval regression gates failed/i);
});
