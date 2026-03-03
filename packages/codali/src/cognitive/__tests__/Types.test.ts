import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_PHASE_SEQUENCE,
  type RetrievalReportV1,
  type RetryDecision,
  type RuntimePhaseTransitionErrorMetadata,
  type VerificationReport,
} from "../Types.js";

test("Runtime phase sequence is canonical and stable", { concurrency: false }, () => {
  assert.deepEqual(RUNTIME_PHASE_SEQUENCE, ["retrieve", "plan", "act", "verify", "answer"]);
});

test("Runtime phase transition metadata carries deterministic fields", { concurrency: false }, () => {
  const metadata: RuntimePhaseTransitionErrorMetadata = {
    code: "CODALI_INVALID_PHASE_TRANSITION",
    from_phase: "plan",
    to_phase: "verify",
    requested_phase: "critic",
    allowed_next_phases: ["retrieve", "plan", "act"],
    phase_trace: ["retrieve", "plan"],
  };
  assert.equal(metadata.code, "CODALI_INVALID_PHASE_TRANSITION");
  assert.deepEqual(metadata.allowed_next_phases, ["retrieve", "plan", "act"]);
});

test("Retry decision contract is machine-readable", { concurrency: false }, () => {
  const decision: RetryDecision = {
    phase: "verify",
    reason_code: "critic_retryable_failure",
    disposition: "retry",
    attempt: 1,
    max_attempts: 3,
    details: ["validation failed"],
  };
  assert.equal(decision.disposition, "retry");
  assert.equal(decision.reason_code, "critic_retryable_failure");
});

test("Retrieval report contract supports typed accountability fields", { concurrency: false }, () => {
  const report: RetrievalReportV1 = {
    schema_version: 1,
    mode: "normal",
    created_at_ms: 1,
    confidence: "high",
    disposition: "resolved",
    preflight: [
      { check: "docdex_health", status: "ok" },
      { check: "docdex_initialize", status: "ok" },
      { check: "docdex_stats", status: "ok" },
      { check: "docdex_files", status: "ok" },
    ],
    selection: {
      focus: ["src/app.ts"],
      periphery: [],
      all: ["src/app.ts"],
      low_confidence: false,
      entries: [{ path: "src/app.ts", role: "focus", inclusion_reasons: ["search_hit"] }],
      reason_summary: [{ code: "search_hit", count: 1 }],
    },
    dropped: [],
    truncated: [],
    unresolved_gaps: [],
    tool_execution: [
      { tool: "docdex.search", category: "search", disposition: "executed" },
    ],
    warnings: [],
  };
  assert.equal(report.selection.entries[0]?.inclusion_reasons[0], "search_hit");
  assert.equal(report.tool_execution[0]?.category, "search");
});

test("Verification report contract supports explicit classification schema", { concurrency: false }, () => {
  const report: VerificationReport = {
    schema_version: 1,
    outcome: "unverified_with_reason",
    reason_codes: ["verification_policy_minimum_unmet"],
    policy: {
      policy_name: "test",
      minimum_checks: 1,
      enforce_high_confidence: true,
    },
    checks: [
      {
        step: "pnpm test --filter codali",
        check_type: "shell",
        status: "unverified",
        targeted: true,
        reason_code: "verification_shell_disabled",
      },
    ],
    totals: {
      configured: 1,
      runnable: 0,
      attempted: 0,
      passed: 0,
      failed: 0,
      unverified: 1,
    },
  };
  assert.equal(report.outcome, "unverified_with_reason");
  assert.equal(report.policy.enforce_high_confidence, true);
  assert.equal(report.checks[0]?.reason_code, "verification_shell_disabled");
});
