import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalCommand, EvalCommandError, EVAL_EXIT_CODES, parseEvalArgs } from "../EvalCommand.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(testDir, "..", "..", "cli.js");

const withCliEntry = async (fn: () => Promise<void>): Promise<void> => {
  const previous = process.argv[1];
  process.argv[1] = cliEntry;
  try {
    await fn();
  } finally {
    process.argv[1] = previous;
  }
};

test("parseEvalArgs parses supported eval flags", { concurrency: false }, () => {
  const parsed = parseEvalArgs([
    "--suite",
    "suite.json",
    "--output",
    "json",
    "--provider",
    "stub",
    "--model",
    "stub-model",
    "--workspace-root",
    "/tmp/workspace",
    "--profile",
    "fix",
    "--smart",
    "--no-deep-investigation",
  ]);
  assert.equal(parsed.suite_path, "suite.json");
  assert.equal(parsed.output, "json");
  assert.equal(parsed.provider, "stub");
  assert.equal(parsed.model, "stub-model");
  assert.equal(parsed.workspace_root, "/tmp/workspace");
  assert.equal(parsed.workflow_profile, "fix");
  assert.equal(parsed.smart, true);
  assert.equal(parsed.no_deep_investigation, true);
});

test("parseEvalArgs rejects unknown flags deterministically", { concurrency: false }, () => {
  assert.throws(
    () => parseEvalArgs(["--suite", "suite.json", "--unknown"]),
    (error) => {
      assert.ok(error instanceof EvalCommandError);
      assert.equal(error.exitCode, EVAL_EXIT_CODES.usage_error);
      return true;
    },
  );
});

test("EvalCommand.run returns success on passing suite and thresholds", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-eval-cmd-"));
  const srcDir = path.join(workspaceRoot, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");
  const taskFile = path.join(workspaceRoot, "task.txt");
  writeFileSync(taskFile, "update value", "utf8");
  const suitePath = path.join(workspaceRoot, "suite.json");
  writeFileSync(
    suitePath,
    JSON.stringify({
      schema_version: 1,
      suite_id: "eval-pass",
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

  await withCliEntry(async () => {
    await EvalCommand.run([
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
    ]);
  });
});

test("EvalCommand.run returns gate failure with deterministic exit code", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-eval-cmd-fail-"));
  const srcDir = path.join(workspaceRoot, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "index.ts"), "const value = 1;\n", "utf8");
  const taskFile = path.join(workspaceRoot, "task.txt");
  writeFileSync(taskFile, "update value", "utf8");
  const suitePath = path.join(workspaceRoot, "suite-fail.json");
  writeFileSync(
    suitePath,
    JSON.stringify({
      schema_version: 1,
      suite_id: "eval-gate-fail",
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

  await withCliEntry(async () => {
    await assert.rejects(
      () =>
        EvalCommand.run([
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
        ]),
      (error) => {
        assert.ok(error instanceof EvalCommandError);
        assert.equal(error.exitCode, EVAL_EXIT_CODES.gate_failure);
        return true;
      },
    );
  });
});
