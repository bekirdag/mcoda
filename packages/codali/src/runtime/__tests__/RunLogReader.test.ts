import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunLogger } from "../RunLogger.js";
import { RunLogReader } from "../RunLogReader.js";
import { getGlobalWorkspaceDir } from "../StoragePaths.js";

test("RunLogReader resolves last run for touched file", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-reader-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const logger = new RunLogger(storageRoot, "logs", "run-42");
  await logger.log("run_summary", {
    runId: "run-42",
    touchedFiles: ["src/example.ts"],
  });

  const reader = new RunLogReader(workspaceRoot, "logs");
  const runId = await reader.findLastRunForFile("src/example.ts");
  assert.equal(runId, "run-42");
});

test("RunLogReader extracts run intent from phase artifact payload", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-intent-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const logger = new RunLogger(storageRoot, "logs", "run-99");
  const artifactPath = await logger.writePhaseArtifact("librarian", "input", {
    request: "implement retry guard",
  });
  await logger.log("phase_input", {
    phase: "librarian",
    path: artifactPath,
  });

  const reader = new RunLogReader(workspaceRoot, "logs");
  const intent = await reader.getRunIntent("run-99");
  assert.equal(intent, "implement retry guard");
});

test("RunLogReader returns structured phase artifacts", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-artifacts-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const logger = new RunLogger(storageRoot, "logs", "run-11");
  await logger.writePhaseArtifact("builder", "input", { plan: { steps: ["a"] } });
  await logger.writePhaseArtifact("builder", "summary", { status: "completed" });

  const reader = new RunLogReader(workspaceRoot, "logs");
  const artifacts = await reader.getPhaseArtifacts("run-11", "builder");
  assert.equal(artifacts.length, 2);
  assert.ok(artifacts.every((entry) => entry.schema_version === 1));
  assert.ok(artifacts.some((entry) => entry.kind === "summary"));
});

test("RunLogReader reads legacy phase artifacts for run intent", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-legacy-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const logger = new RunLogger(storageRoot, "logs", "run-legacy");
  const phaseDir = path.join(storageRoot, "logs", "phase");
  mkdirSync(phaseDir, { recursive: true });
  const legacyArtifactPath = path.join(phaseDir, "run-legacy-librarian-input-1.json");
  writeFileSync(
    legacyArtifactPath,
    JSON.stringify({ request: "legacy request shape" }, null, 2),
    "utf8",
  );
  await logger.log("phase_input", {
    phase: "librarian",
    path: legacyArtifactPath,
  });

  const reader = new RunLogReader(workspaceRoot, "logs");
  const intent = await reader.getRunIntent("run-legacy");
  assert.equal(intent, "legacy request shape");
});

test("RunLogReader queries safety events by code and phase", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-safety-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const logger = new RunLogger(storageRoot, "logs", "run-safe-1");
  await logger.logSafetyEvent({
    phase: "act",
    category: "patch",
    code: "patch_outside_allowed_scope",
    disposition: "non_retryable",
    source: "builder_runner",
    message: "Patch target is outside allowed scope",
  });
  await logger.logSafetyEvent({
    phase: "verify",
    category: "critic",
    code: "scope_violation",
    disposition: "non_retryable",
    source: "critic_evaluator",
    message: "touched files outside allowed paths",
  });

  const reader = new RunLogReader(workspaceRoot, "logs");
  const all = await reader.getSafetyEvents("run-safe-1");
  assert.equal(all.length, 2);
  const actOnly = await reader.getSafetyEvents("run-safe-1", { phase: "act" });
  assert.equal(actOnly.length, 1);
  assert.equal(actOnly[0]?.code, "patch_outside_allowed_scope");
  const byCode = await reader.getSafetyEvents("run-safe-1", { code: "scope_violation" });
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0]?.phase, "verify");
});

test("RunLogReader returns verification reports from artifacts and log events", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-verify-reader-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const logger = new RunLogger(storageRoot, "logs", "run-verify-1");
  await logger.writePhaseArtifact("verify", "verification_report", {
    schema_version: 1,
    outcome: "verified_passed",
    reason_codes: [],
    policy: {
      policy_name: "test",
      minimum_checks: 1,
      enforce_high_confidence: true,
    },
    checks: [],
    totals: {
      configured: 1,
      runnable: 1,
      attempted: 1,
      passed: 1,
      failed: 0,
      unverified: 0,
    },
  });
  await logger.logVerificationReport({
    schema_version: 1,
    outcome: "verified_passed",
    reason_codes: [],
    policy: {
      policy_name: "test",
      minimum_checks: 1,
      enforce_high_confidence: true,
    },
    checks: [],
    totals: {
      configured: 1,
      runnable: 1,
      attempted: 1,
      passed: 1,
      failed: 0,
      unverified: 0,
    },
  });
  const reader = new RunLogReader(workspaceRoot, "logs");
  const reports = await reader.getVerificationReports("run-verify-1");
  assert.ok(reports.length >= 1);
  assert.equal(reports[0]?.outcome, "verified_passed");
  assert.equal(reports[0]?.policy.enforce_high_confidence, true);
});

test("RunLogReader queryEvents filters by run/task/phase/failure class with deterministic pagination", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-query-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const runOne = new RunLogger(storageRoot, "logs", "run-query-1");
  const runTwo = new RunLogger(storageRoot, "logs", "run-query-2");

  await runOne.log("run_failed", {
    run_id: "run-query-1",
    task_id: "task-a",
    phase: "verify",
    failure_class: "verification_failure",
    reasons: ["verification_policy_minimum_unmet"],
  });
  await runOne.logRunSummary({
    run_id: "run-query-1",
    durationMs: 10,
    touchedFiles: ["src/a.ts"],
    final_disposition: {
      status: "fail",
      failure_class: "verification_failure",
      reason_codes: ["verification_policy_minimum_unmet"],
      stage: "verify",
    },
    quality_dimensions: {
      plan: "available",
      retrieval: "available",
      patch: "available",
      verification: "degraded",
      final_disposition: "available",
    },
    phase_telemetry: [
      {
        phase: "verify",
        missing_usage_reason: "usage_missing",
        missing_cost_reason: "cost_missing",
      },
    ],
    task_id: "task-a",
  });

  await runTwo.log("run_failed", {
    run_id: "run-query-2",
    task_id: "task-b",
    phase: "act",
    failure_class: "patch_failure",
    reasons: ["patch_apply_failed"],
  });

  const reader = new RunLogReader(workspaceRoot, "logs");
  const filtered = await reader.queryEvents({
    filters: {
      run_id: "run-query-1",
      task_id: "task-a",
      phase: "verify",
      failure_class: "verification_failure",
    },
  });
  assert.equal(filtered.total, 2);
  assert.equal(filtered.events[0]?.run_id, "run-query-1");
  assert.equal(filtered.events[0]?.task_id, "task-a");
  assert.equal(filtered.events[0]?.phase, "verify");
  assert.equal(filtered.events[0]?.failure_class, "verification_failure");

  const paged = await reader.queryEvents({
    filters: { run_id: "run-query-1" },
    limit: 1,
    offset: 1,
    sort: "asc",
  });
  assert.equal(paged.returned, 1);
  assert.equal(paged.next_offset, null);
});

test("RunLogReader queryEvents tolerates malformed log lines", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-run-query-malformed-"));
  const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
  const logger = new RunLogger(storageRoot, "logs", "run-query-3");
  await logger.log("run_failed", {
    run_id: "run-query-3",
    phase: "act",
    failure_class: "execution_failure",
    reasons: ["runner_step_limit_exceeded"],
  });
  appendFileSync(logger.logPath, "{this is invalid json}\n", "utf8");

  const reader = new RunLogReader(workspaceRoot, "logs");
  const result = await reader.queryEvents({
    filters: { run_id: "run-query-3", event_type: "run_failed" },
  });
  assert.equal(result.total, 1);
  assert.equal(result.events[0]?.run_id, "run-query-3");
  assert.equal(result.events[0]?.failure_class, "execution_failure");
});
