import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReportStore } from "../ReportStore.js";
import type { EvalReport } from "../ReportSerializer.js";

const buildReport = (overrides: Partial<EvalReport>): EvalReport => ({
  schema_version: 1,
  report_id: "report-1",
  created_at: new Date().toISOString(),
  suite: {
    suite_id: "suite-1",
    suite_name: "Suite",
    suite_path: "/tmp/suite.json",
    suite_fingerprint: "fingerprint-1",
    task_count: 1,
  },
  summary: {
    exit_code: 0,
    passed: true,
    gate_passed: true,
    task_total: 1,
    task_passed: 1,
    task_failed: 0,
    execution_errors: 0,
  },
  run: {
    schema_version: 1,
    suite_id: "suite-1",
    suite_fingerprint: "fingerprint-1",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 1,
    task_results: [],
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      execution_errors: 0,
    },
  },
  metrics: {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    task_count: 1,
    m001_task_success_rate: { numerator: 1, denominator: 1, missing: 0, value: 1 },
    m002_first_pass_success_rate: { numerator: 1, denominator: 1, missing: 0, value: 1 },
    m003_patch_apply_success_rate: { numerator: 1, denominator: 1, missing: 0, value: 1 },
    m004_verification_pass_rate: { numerator: 1, denominator: 1, missing: 0, value: 1 },
    m005_hallucination_rate: { numerator: 0, denominator: 1, missing: 0, value: 0 },
    m006_scope_violation_rate: { numerator: 0, denominator: 1, missing: 0, value: 0 },
    m007_latency_ms: { sample_size: 1, missing: 0, median: 1, p95: 1 },
    m008_success_tokens: { sample_size: 1, missing: 0, median: 1, p95: 1 },
    m008_success_cost_usd: { sample_size: 1, missing: 0, median: 0, p95: 0 },
  },
  regression: {
    schema_version: 1,
    status: "baseline_missing",
    deltas: [],
    regression_count: 0,
    improved_count: 0,
    unchanged_count: 0,
  },
  gates: {
    schema_version: 1,
    passed: true,
    thresholds: {
      patch_apply_drop_max: 0.02,
      verification_pass_rate_min: 0.9,
      hallucination_rate_max: 0.02,
      scope_violation_rate_max: 0,
    },
    failures: [],
  },
  ...overrides,
});

test("ReportStore saves and resolves latest report per suite", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-eval-report-store-"));
  const store = new ReportStore(workspaceRoot, "logs/codali/eval-test");
  const first = buildReport({ report_id: "report-1" });
  const second = buildReport({ report_id: "report-2" });
  await store.save(first);
  await store.save(second);
  const latest = await store.findLatestForSuite({ suite_fingerprint: "fingerprint-1" });
  assert.ok(latest);
  assert.equal(latest?.report.suite.suite_fingerprint, "fingerprint-1");
  assert.equal(latest?.report.report_id, "report-2");
});
