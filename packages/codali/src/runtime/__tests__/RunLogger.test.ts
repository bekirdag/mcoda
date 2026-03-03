import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunLogger, buildPhaseArtifact } from "../RunLogger.js";
import { RunTelemetryValidationError } from "../RunTelemetryTypes.js";

test("RunLogger writes JSONL entries", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-1");
  await logger.log("event", { ok: true });

  const content = readFileSync(logger.logPath, "utf8");
  assert.match(content, /"type":"event"/);
  assert.match(content, /"ok":true/);
});

test("RunLogger writes phase artifacts", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-2");
  const artifactPath = await logger.writePhaseArtifact("architect", "plan", {
    steps: ["step"],
  });

  assert.ok(existsSync(artifactPath));
  const content = readFileSync(artifactPath, "utf8");
  assert.match(content, /"schema_version": 1/);
  assert.match(content, /"phase": "architect"/);
  assert.match(content, /"kind": "plan"/);
  assert.match(content, /"steps"/);
});

test("buildPhaseArtifact computes deterministic timing metadata", { concurrency: false }, () => {
  const artifact = buildPhaseArtifact({
    runId: "run-3",
    phase: "builder",
    kind: "summary",
    payload: { status: "completed" },
    startedAtMs: 10,
    endedAtMs: 25,
  });

  assert.equal(artifact.schema_version, 1);
  assert.equal(artifact.run_id, "run-3");
  assert.equal(artifact.duration_ms, 15);
  assert.equal((artifact.payload as { status?: string }).status, "completed");
});

test("RunLogger writes versioned safety telemetry events", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-safety");
  await logger.logSafetyEvent({
    phase: "act",
    category: "tool",
    code: "tool_permission_denied",
    disposition: "non_retryable",
    tool: "run_shell",
    message: "blocked by policy",
    details: { reason_code: "destructive_operation_blocked" },
  });

  const content = readFileSync(logger.logPath, "utf8");
  assert.match(content, /"type":"safety_event"/);
  assert.match(content, /"schema_version":1/);
  assert.match(content, /"run_id":"run-safety"/);
  assert.match(content, /"code":"tool_permission_denied"/);
});

test("RunLogger writes verification report events", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-verify");
  await logger.logVerificationReport({
    schema_version: 1,
    outcome: "unverified_with_reason",
    reason_codes: ["verification_no_runnable_checks"],
    policy: {
      policy_name: "run",
      minimum_checks: 1,
      enforce_high_confidence: true,
    },
    checks: [],
    totals: {
      configured: 1,
      runnable: 0,
      attempted: 0,
      passed: 0,
      failed: 0,
      unverified: 1,
    },
  });

  const content = readFileSync(logger.logPath, "utf8");
  assert.match(content, /"type":"verification_report"/);
  assert.match(content, /"outcome":"unverified_with_reason"/);
  assert.match(content, /"verification_no_runnable_checks"/);
});

test("RunLogger writes normalized run_summary payloads", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-summary");
  await logger.logRunSummary({
    runId: "run-summary",
    durationMs: 25,
    touchedFiles: ["src/b.ts", "src/a.ts"],
    final_disposition: { status: "pass", reason_codes: [] },
    phase_telemetry: [
      {
        phase: "act",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        cost: { usd: 0.1, source: "actual_usage" },
      },
    ],
  });

  const lines = readFileSync(logger.logPath, "utf8").trim().split("\n");
  const event = JSON.parse(lines[0]) as { type: string; data: Record<string, unknown> };
  const summary = event.data as { schema_version?: number; run_id?: string; touchedFiles?: string[] };
  assert.equal(event.type, "run_summary");
  assert.equal(summary.schema_version, 1);
  assert.equal(summary.run_id, "run-summary");
  assert.deepEqual(summary.touchedFiles, ["src/a.ts", "src/b.ts"]);
});

test("RunLogger rejects invalid phase telemetry payloads deterministically", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-invalid");
  await assert.rejects(
    () =>
      logger.log("phase_telemetry", {
        phase: "plan",
      }),
    (error) =>
      error instanceof RunTelemetryValidationError
      && error.code === "phase_telemetry_missing_usage_reason",
  );
});
