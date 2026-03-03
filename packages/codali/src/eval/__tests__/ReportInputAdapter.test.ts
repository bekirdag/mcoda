import test from "node:test";
import assert from "node:assert/strict";
import { adaptRunSummaryForReport } from "../ReportInputAdapter.js";

test("adaptRunSummaryForReport normalizes complete run summary payloads", { concurrency: false }, () => {
  const normalized = adaptRunSummaryForReport({
    runSummary: {
      run_id: "run-1",
      task_id: "task-1",
      fingerprint: "fp-1",
      durationMs: 125,
      touchedFiles: ["src/b.ts", "src/a.ts", "src/a.ts"],
      actualCost: 0.021,
      final_disposition: {
        status: "fail",
        failure_class: "verification_failure",
        reason_codes: ["verification_policy_minimum_unmet", "verification_policy_minimum_unmet"],
        retryable: false,
      },
      verification: {
        outcome: "verified_failed",
      },
      artifact_references: [
        { phase: "verify", kind: "verification_report", status: "present", path: "/tmp/verify.json" },
        { phase: "retrieve", kind: "summary", status: "missing", reason_code: "artifact_not_emitted" },
      ],
      quality_dimensions: {
        plan: "available",
        retrieval: "degraded",
        patch: "available",
        verification: "missing",
        final_disposition: "available",
      },
      phase_telemetry: [
        {
          phase: "act",
          provider: "openai-compatible",
          model: "gpt-5.1",
          duration_ms: 55,
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          cost: { usd: 0.021, source: "actual_usage" },
        },
      ],
    },
  });

  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.run_id, "run-1");
  assert.equal(normalized.task_id, "task-1");
  assert.equal(normalized.final_status, "fail");
  assert.equal(normalized.failure_class, "verification_failure");
  assert.deepEqual(normalized.reason_codes, ["verification_policy_minimum_unmet"]);
  assert.deepEqual(normalized.touched_files, ["src/a.ts", "src/b.ts"]);
  assert.equal(normalized.verification_outcome, "verified_failed");
  assert.equal(normalized.usage_tokens_total, 150);
  assert.equal(normalized.cost_usd, 0.021);
  assert.deepEqual(normalized.missing_artifacts, ["retrieve:summary"]);
  assert.equal(normalized.missing_data_markers.length, 0);
});

test("adaptRunSummaryForReport emits explicit missing-data markers for partial inputs", { concurrency: false }, () => {
  const normalized = adaptRunSummaryForReport({
    runId: "fallback-run",
    taskId: "fallback-task",
    touchedFiles: ["src/fallback.ts"],
  });

  assert.equal(normalized.run_id, "fallback-run");
  assert.equal(normalized.task_id, "fallback-task");
  assert.equal(normalized.final_status, "unknown");
  assert.deepEqual(normalized.touched_files, ["src/fallback.ts"]);
  assert.equal(normalized.phase_outcomes.length, 4);
  assert.ok(normalized.missing_data_markers.includes("run_summary_missing"));
  assert.ok(normalized.missing_data_markers.includes("final_disposition_missing"));
  assert.ok(normalized.missing_data_markers.includes("phase_telemetry_missing"));
  assert.ok(normalized.missing_data_markers.includes("verification_outcome_missing"));
});

test("adaptRunSummaryForReport derives usage and cost from phase telemetry when top-level fields are absent", { concurrency: false }, () => {
  const normalized = adaptRunSummaryForReport({
    runSummary: {
      run_id: "run-derive",
      final_disposition: {
        status: "degraded",
        reason_codes: ["fallback_used"],
      },
      phase_telemetry: [
        {
          phase: "plan",
          usage: { total_tokens: 25 },
          cost: { usd: 0.002, source: "actual_usage" },
        },
        {
          phase: "act",
          usage: { input_tokens: 60, output_tokens: 40 },
          missing_cost_reason: "pricing_unavailable",
        },
      ],
    },
  });

  assert.equal(normalized.usage_tokens_total, 125);
  assert.equal(normalized.cost_usd, 0.002);
  assert.equal(normalized.final_status, "degraded");
  assert.ok(!normalized.missing_data_markers.includes("usage_tokens_missing"));
});
