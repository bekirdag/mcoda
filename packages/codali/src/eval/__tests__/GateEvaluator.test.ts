import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EVAL_GATE_THRESHOLDS,
  evaluateGates,
  resolveGateThresholds,
} from "../GateEvaluator.js";
import type { EvalMetrics } from "../MetricTypes.js";
import type { EvalRegressionComparison } from "../RegressionComparator.js";

const buildMetrics = (overrides: Partial<EvalMetrics>): EvalMetrics => ({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  task_count: 2,
  m001_task_success_rate: { numerator: 2, denominator: 2, missing: 0, value: 1 },
  m002_first_pass_success_rate: { numerator: 2, denominator: 2, missing: 0, value: 1 },
  m003_patch_apply_success_rate: { numerator: 2, denominator: 2, missing: 0, value: 1 },
  m004_verification_pass_rate: { numerator: 2, denominator: 2, missing: 0, value: 1 },
  m005_hallucination_rate: { numerator: 0, denominator: 2, missing: 0, value: 0 },
  m006_scope_violation_rate: { numerator: 0, denominator: 2, missing: 0, value: 0 },
  m007_latency_ms: { sample_size: 2, missing: 0, median: 100, p95: 150 },
  m008_success_tokens: { sample_size: 2, missing: 0, median: 1000, p95: 1500 },
  m008_success_cost_usd: { sample_size: 2, missing: 0, median: 0.1, p95: 0.15 },
  ...overrides,
});

const buildComparison = (delta: number): EvalRegressionComparison => ({
  schema_version: 1,
  status: "compared",
  baseline_report_id: "baseline",
  baseline_created_at: new Date().toISOString(),
  deltas: [
    {
      key: "m003_patch_apply_success_rate",
      unit: "ratio",
      higher_is_better: true,
      baseline: 1,
      current: 1 + delta,
      delta,
      direction: delta === 0 ? "flat" : (delta > 0 ? "up" : "down"),
      regression: delta < 0,
      improved: delta > 0,
    },
  ],
  regression_count: delta < 0 ? 1 : 0,
  improved_count: delta > 0 ? 1 : 0,
  unchanged_count: delta === 0 ? 1 : 0,
});

test("resolveGateThresholds merges and validates override values", { concurrency: false }, () => {
  const thresholds = resolveGateThresholds(DEFAULT_EVAL_GATE_THRESHOLDS, {
    verification_pass_rate_min: 0.95,
  });
  assert.equal(thresholds.verification_pass_rate_min, 0.95);
  assert.throws(() => resolveGateThresholds({ hallucination_rate_max: 2 }), /between 0 and 1/i);
});

test("evaluateGates passes when all thresholds are satisfied", { concurrency: false }, () => {
  const metrics = buildMetrics({});
  const result = evaluateGates({
    metrics,
    thresholds: DEFAULT_EVAL_GATE_THRESHOLDS,
    comparison: buildComparison(-0.01),
  });
  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
});

test("evaluateGates fails deterministically on threshold breaches", { concurrency: false }, () => {
  const metrics = buildMetrics({
    m004_verification_pass_rate: { numerator: 1, denominator: 2, missing: 0, value: 0.5 },
    m005_hallucination_rate: { numerator: 1, denominator: 2, missing: 0, value: 0.5 },
    m006_scope_violation_rate: { numerator: 1, denominator: 2, missing: 0, value: 0.5 },
  });
  const result = evaluateGates({
    metrics,
    thresholds: DEFAULT_EVAL_GATE_THRESHOLDS,
    comparison: buildComparison(-0.2),
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.code === "gate_patch_apply_drop_exceeded"));
  assert.ok(result.failures.some((failure) => failure.code === "gate_verification_rate_below_min"));
  assert.ok(result.failures.some((failure) => failure.code === "gate_hallucination_rate_exceeded"));
  assert.ok(result.failures.some((failure) => failure.code === "gate_scope_violation_rate_exceeded"));
});
