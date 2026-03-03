import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhaseTelemetryRecord,
  normalizeRunEventPayload,
  normalizeRunSummaryData,
  RunTelemetryValidationError,
} from "../RunTelemetryTypes.js";

test("normalizeRunSummaryData fills schema defaults and aliases", { concurrency: false }, () => {
  const summary = normalizeRunSummaryData({
    runId: "run-telemetry-1",
    durationMs: 42,
    touchedFiles: ["src/b.ts", "src/a.ts", "src/a.ts"],
    final_disposition: {
      status: "fail",
      reason_codes: ["verification_policy_minimum_unmet"],
    },
    phase_telemetry: [
      {
        phase: "verify",
        missing_usage_reason: "usage_missing",
        missing_cost_reason: "cost_missing",
      },
    ],
  });

  assert.equal(summary.schema_version, 1);
  assert.equal(summary.run_id, "run-telemetry-1");
  assert.equal(summary.runId, "run-telemetry-1");
  assert.deepEqual(summary.touchedFiles, ["src/a.ts", "src/b.ts"]);
  assert.equal(summary.final_disposition.status, "fail");
  assert.equal(summary.final_disposition.failure_class, "unknown_failure");
  assert.equal(summary.phase_telemetry[0]?.run_id, "run-telemetry-1");
});

test("normalizePhaseTelemetryRecord rejects missing usage reason", { concurrency: false }, () => {
  assert.throws(
    () =>
      normalizePhaseTelemetryRecord({
        run_id: "run-telemetry-2",
        phase: "plan",
        missing_cost_reason: "cost_missing",
      }),
    (error) =>
      error instanceof RunTelemetryValidationError
      && error.code === "phase_telemetry_missing_usage_reason",
  );
});

test("normalizeRunEventPayload is deterministic for equivalent objects", { concurrency: false }, () => {
  const left = normalizeRunEventPayload("event", {
    z: 1,
    nested: { b: 2, a: 1 },
    a: 0,
  });
  const right = normalizeRunEventPayload("event", {
    a: 0,
    nested: { a: 1, b: 2 },
    z: 1,
  });

  assert.equal(JSON.stringify(left), JSON.stringify(right));
});
