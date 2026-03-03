import test from "node:test";
import assert from "node:assert/strict";
import { aggregateMetrics } from "../MetricsAggregator.js";
import type { EvalTaskExecution } from "../EvalTaskExecutor.js";
import type { EvalRunResult } from "../EvalRunner.js";

const buildTask = (
  id: string,
  overrides: Partial<EvalTaskExecution>,
): EvalTaskExecution => ({
  task_id: id,
  title: id,
  command: "run",
  mode: "success",
  started_at: new Date(0).toISOString(),
  ended_at: new Date(1).toISOString(),
  duration_ms: 1,
  exit_code: 0,
  run_succeeded: true,
  task_passed: true,
  first_pass: true,
  patch_apply_success: true,
  verification_outcome: "verified_passed",
  verification_passed: true,
  hallucination_detected: false,
  scope_violation_detected: false,
  latency_ms: 100,
  tokens_used: 1000,
  cost_usd: 0.1,
  assertion_results: [],
  stdout: "",
  stderr: "",
  command_line: [],
  safety_events: [],
  ...overrides,
});

test("aggregateMetrics computes M-001..M-008 with mixed outcomes", { concurrency: false }, () => {
  const run: EvalRunResult = {
    schema_version: 1,
    suite_id: "suite",
    suite_fingerprint: "fp",
    started_at: new Date(0).toISOString(),
    ended_at: new Date(10).toISOString(),
    duration_ms: 10,
    task_results: [
      buildTask("task-1", { latency_ms: 100, tokens_used: 1000, cost_usd: 0.1 }),
      buildTask("task-2", {
        task_passed: false,
        run_succeeded: false,
        exit_code: 1,
        first_pass: false,
        patch_apply_success: false,
        verification_outcome: "verified_failed",
        verification_passed: false,
        hallucination_detected: true,
        scope_violation_detected: false,
        latency_ms: 400,
      }),
      buildTask("task-3", {
        verification_outcome: null,
        verification_passed: null,
        patch_apply_success: null,
        scope_violation_detected: true,
        latency_ms: 250,
      }),
    ],
    summary: {
      total: 3,
      passed: 2,
      failed: 1,
      execution_errors: 0,
    },
  };

  const metrics = aggregateMetrics(run);
  assert.equal(metrics.schema_version, 1);
  assert.equal(metrics.task_count, 3);
  assert.equal(metrics.m001_task_success_rate.value, 2 / 3);
  assert.equal(metrics.m002_first_pass_success_rate.value, 2 / 3);
  assert.equal(metrics.m003_patch_apply_success_rate.denominator, 2);
  assert.equal(metrics.m004_verification_pass_rate.denominator, 2);
  assert.equal(metrics.m005_hallucination_rate.value, 1 / 3);
  assert.equal(metrics.m006_scope_violation_rate.value, 1 / 3);
  assert.ok(metrics.m007_latency_ms.median !== null);
  assert.ok(metrics.m007_latency_ms.p95 !== null);
  assert.equal(metrics.m008_success_tokens.sample_size, 2);
  assert.equal(metrics.m008_success_cost_usd.sample_size, 2);
});

test("aggregateMetrics surfaces missing denominators explicitly", { concurrency: false }, () => {
  const run: EvalRunResult = {
    schema_version: 1,
    suite_id: "suite",
    suite_fingerprint: "fp",
    started_at: new Date(0).toISOString(),
    ended_at: new Date(10).toISOString(),
    duration_ms: 10,
    task_results: [
      buildTask("task-1", {
        verification_outcome: null,
        verification_passed: null,
        patch_apply_success: null,
      }),
    ],
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      execution_errors: 0,
    },
  };
  const metrics = aggregateMetrics(run);
  assert.equal(metrics.m003_patch_apply_success_rate.value, null);
  assert.equal(metrics.m004_verification_pass_rate.value, null);
});
