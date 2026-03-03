import test from "node:test";
import assert from "node:assert/strict";
import { compareAgainstBaseline } from "../RegressionComparator.js";
import type { EvalMetrics } from "../MetricTypes.js";

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
  m007_latency_ms: { sample_size: 2, missing: 0, median: 100, p95: 120 },
  m008_success_tokens: { sample_size: 2, missing: 0, median: 1000, p95: 1200 },
  m008_success_cost_usd: { sample_size: 2, missing: 0, median: 0.1, p95: 0.12 },
  ...overrides,
});

test("compareAgainstBaseline marks regressions and improvements", { concurrency: false }, () => {
  const baseline = buildMetrics({});
  const current = buildMetrics({
    m003_patch_apply_success_rate: { numerator: 1, denominator: 2, missing: 0, value: 0.5 },
    m005_hallucination_rate: { numerator: 1, denominator: 2, missing: 0, value: 0.5 },
    m007_latency_ms: { sample_size: 2, missing: 0, median: 180, p95: 200 },
  });

  const comparison = compareAgainstBaseline({
    current,
    baseline,
    baseline_report_id: "baseline-report",
    baseline_created_at: "2026-03-03T00:00:00.000Z",
  });
  assert.equal(comparison.status, "compared");
  assert.equal(comparison.baseline_report_id, "baseline-report");
  assert.ok(comparison.regression_count >= 1);
  const patchDelta = comparison.deltas.find((delta) => delta.key === "m003_patch_apply_success_rate");
  assert.ok(patchDelta);
  assert.equal(patchDelta?.regression, true);
});

test("compareAgainstBaseline handles missing baseline deterministically", { concurrency: false }, () => {
  const current = buildMetrics({});
  const comparison = compareAgainstBaseline({ current });
  assert.equal(comparison.status, "baseline_missing");
  assert.equal(comparison.regression_count, 0);
  assert.equal(comparison.deltas.length, 12);
});
