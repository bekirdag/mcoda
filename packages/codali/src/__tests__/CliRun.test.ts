import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getGlobalWorkspaceDir } from "../runtime/StoragePaths.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "..", "cli.js");

test("codali run executes with stub provider", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  writeFileSync(taskFile, "hello", "utf8");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--task",
      taskFile,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout ?? "", /stub:hello/);
  assert.match(result.stderr ?? "", /Preflight/);
});

test("codali run --smart executes smart pipeline with stub provider", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-smart-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  writeFileSync(taskFile, "hello", "utf8");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "--smart",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--task",
      taskFile,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout ?? "", /stub:/);
  assert.match(result.stderr ?? "", /Preflight/);
});

test("codali run --smart persists local context when enabled", { concurrency: false }, () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-context-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-home-"));
  const taskFile = path.join(workspaceRoot, "task.txt");
  writeFileSync(taskFile, "hello", "utf8");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "--smart",
      "--workspace-root",
      workspaceRoot,
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--task",
      taskFile,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDir,
        CODALI_LOCAL_CONTEXT_ENABLED: "1",
      },
    },
  );

  assert.equal(result.status, 0);
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  const contextDir = path.join(getGlobalWorkspaceDir(workspaceRoot), "codali", "context");
  process.env.HOME = originalHome;
  const files = existsSync(contextDir) ? readdirSync(contextDir) : [];
  assert.ok(files.some((file) => file.endsWith(".jsonl")));
});
