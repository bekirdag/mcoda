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

test("parseEvalArgs parses gateway live smoke flags", { concurrency: false }, () => {
  const parsed = parseEvalArgs([
    "--gateway-live-smoke",
    "--output",
    "json",
    "--live-timeout-ms",
    "90000",
    "--live-mcoda-command",
    "/usr/local/bin/mcoda",
    "--allow-cloud-fallback",
    "--no-image-worker",
    "--agent-run-force",
    "--shadow-comparison",
    "--shadow-max-candidates",
    "2",
    "--strict",
  ]);
  assert.equal(parsed.gateway_live_smoke, true);
  assert.equal(parsed.output, "json");
  assert.equal(parsed.live_timeout_ms, 90_000);
  assert.equal(parsed.live_mcoda_command, "/usr/local/bin/mcoda");
  assert.equal(parsed.live_allow_cloud_fallback, true);
  assert.equal(parsed.live_no_image_worker, true);
  assert.equal(parsed.live_agent_run_force, true);
  assert.equal(parsed.live_shadow_comparison, true);
  assert.equal(parsed.live_shadow_max_candidates, 2);
  assert.equal(parsed.live_strict, true);
});

test("parseEvalArgs parses gateway eval smoke flag", { concurrency: false }, () => {
  const parsed = parseEvalArgs([
    "--gateway-smoke",
    "--dataset-replay-fixture",
    "fixture.json",
    "--output",
    "json",
  ]);

  assert.equal(parsed.gateway_smoke, true);
  assert.equal(parsed.dataset_replay_fixture_path, "fixture.json");
  assert.equal(parsed.output, "json");
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

test("EvalCommand.run returns success on gateway eval smoke", { concurrency: false }, async () => {
  await withCliEntry(async () => {
    await EvalCommand.run(["--gateway-smoke", "--output", "json"]);
  });
});

test("EvalCommand.run applies gateway smoke baseline regression gates", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-gateway-baseline-"));
  const baselinePath = path.join(workspaceRoot, "gateway-baseline.json");
  writeFileSync(
    baselinePath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-07-07T00:00:00.000Z",
      latencyMs: { median: 1, p95: 1 },
      costUsd: { median: 0.001, p95: 0.001 },
      tokensUsed: { median: 1, p95: 1 },
    }),
    "utf8",
  );

  await withCliEntry(async () => {
    await assert.rejects(
      () => EvalCommand.run([
        "--gateway-smoke",
        "--baseline",
        baselinePath,
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
