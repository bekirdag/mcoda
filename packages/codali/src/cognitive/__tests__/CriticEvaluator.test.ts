import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CriticEvaluator } from "../CriticEvaluator.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import type { LocalContextConfig, Plan, VerificationReport } from "../Types.js";

class StubValidator {
  constructor(
    private result: Partial<{
      ok: boolean;
      errors: string[];
      outcome: VerificationReport["outcome"];
      reason_codes: VerificationReport["reason_codes"];
      report: VerificationReport;
    }>,
  ) {}

  async run(): Promise<{
    ok: boolean;
    errors: string[];
    outcome: VerificationReport["outcome"];
    reason_codes: VerificationReport["reason_codes"];
    report: VerificationReport;
  }> {
    const ok = this.result.ok ?? true;
    const errors = this.result.errors ?? [];
    const inferredOutcome =
      this.result.outcome
      ?? ((!ok || errors.length > 0) ? "verified_failed" : "verified_passed");
    const inferredReasonCodes = this.result.reason_codes
      ?? (inferredOutcome === "verified_failed" ? ["verification_command_failed"] : []);
    const report = this.result.report ?? {
      schema_version: 1,
      outcome: inferredOutcome,
      reason_codes: inferredReasonCodes,
      policy: {
        policy_name: "general",
        minimum_checks: 0,
        enforce_high_confidence: false,
      },
      checks: [],
      totals: {
        configured: 1,
        runnable: 1,
        attempted: 1,
        passed: inferredOutcome === "verified_passed" ? 1 : 0,
        failed: inferredOutcome === "verified_failed" ? 1 : 0,
        unverified: 0,
      },
      touched_files: ["file.ts"],
      language_signals: ["typescript"],
    } satisfies VerificationReport;
    return {
      ok,
      errors,
      outcome: inferredOutcome,
      reason_codes: inferredReasonCodes,
      report,
    };
  }
}

const makeConfig = (overrides: Partial<LocalContextConfig> = {}): LocalContextConfig => ({
  enabled: true,
  storageDir: "codali/context",
  persistToolMessages: false,
  maxMessages: 200,
  maxBytesPerLane: 200_000,
  modelTokenLimits: {},
  summarize: {
    enabled: false,
    provider: "librarian",
    model: "test-model",
    targetTokens: 1200,
    thresholdPct: 0.9,
  },
  ...overrides,
});

const plan: Plan = {
  steps: ["step"],
  target_files: ["file.ts"],
  risk_assessment: "low",
  verification: ["echo ok"],
};

test("CriticEvaluator fails on empty output", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const result = await evaluator.evaluate(plan, "");
  assert.equal(result.status, "FAIL");
});

test("CriticEvaluator fails when validation errors", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: false, errors: ["bad"] }) as any);
  const result = await evaluator.evaluate(plan, "output", ["file.ts"]);
  assert.equal(result.status, "FAIL");
  assert.ok(result.reasons.includes("bad"));
});

test("CriticEvaluator passes when validation ok", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const result = await evaluator.evaluate(plan, "output", ["file.ts"]);
  assert.equal(result.status, "PASS");
  assert.equal(result.report?.verification?.outcome, "verified_passed");
  assert.equal(result.report?.high_confidence, true);
  assert.deepEqual(result.report?.alignment_evidence?.matched_targets, ["file.ts"]);
});

test("CriticEvaluator includes unverified classification when high confidence is not enforced", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(
    new StubValidator({
      outcome: "unverified_with_reason",
      reason_codes: ["verification_shell_disabled"],
      report: {
        schema_version: 1,
        outcome: "unverified_with_reason",
        reason_codes: ["verification_shell_disabled"],
        policy: {
          policy_name: "general",
          minimum_checks: 0,
          enforce_high_confidence: false,
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
      },
    }) as any,
  );
  const result = await evaluator.evaluate(plan, "output", ["file.ts"]);
  assert.equal(result.status, "PASS");
  assert.equal(result.report?.verification?.outcome, "unverified_with_reason");
  assert.equal(result.report?.high_confidence, false);
});

test("CriticEvaluator blocks unverified outcomes when high confidence is required", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(
    new StubValidator({
      outcome: "unverified_with_reason",
      reason_codes: ["verification_policy_minimum_unmet"],
      report: {
        schema_version: 1,
        outcome: "unverified_with_reason",
        reason_codes: ["verification_policy_minimum_unmet"],
        policy: {
          policy_name: "test",
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
      },
    }) as any,
  );
  const result = await evaluator.evaluate(plan, "output", ["file.ts"], {
    enforceHighConfidence: true,
    minimumVerificationChecks: 1,
    verificationPolicyName: "test",
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, false);
  assert.ok(result.reasons.some((reason) => reason.includes("verification_")));
});

test("CriticEvaluator fails when touched files miss plan targets", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const result = await evaluator.evaluate(plan, "output", ["other.ts"]);
  assert.equal(result.status, "FAIL");
});

test("CriticEvaluator fails when no files touched for plan targets", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const result = await evaluator.evaluate(plan, "output", []);
  assert.equal(result.status, "FAIL");
});

test("CriticEvaluator fails when touched files are read-only", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const result = await evaluator.evaluate(plan, "output", ["docs/sds/spec.md"], {
    readOnlyPaths: ["docs/sds"],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, false);
  assert.equal(result.guardrail?.reason_code, "doc_edit_guard");
  assert.equal(result.guardrail?.disposition, "non_retryable");
  assert.ok(result.reasons.some((reason) => reason.includes("read-only")));
});

test("CriticEvaluator fails when touched files are outside allowed paths", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const result = await evaluator.evaluate(plan, "output", ["src/other.ts"], {
    allowedPaths: ["src/allowed.ts"],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, false);
  assert.equal(result.guardrail?.reason_code, "scope_violation");
  assert.equal(result.guardrail?.disposition, "non_retryable");
  assert.ok(result.reasons.some((reason) => reason.includes("allowed paths")));
});

test("CriticEvaluator infers touched files from patch output", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const patchOutput = JSON.stringify({
    patches: [
      {
        action: "replace",
        file: "file.ts",
        search_block: "a",
        replace_block: "b",
      },
    ],
  });
  const result = await evaluator.evaluate(plan, patchOutput);
  assert.equal(result.status, "PASS");
});

test("CriticEvaluator fails when inferred patch targets miss plan", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const patchOutput = JSON.stringify({
    files: [{ path: "other.ts", content: "export const x = 1;" }],
  });
  const result = await evaluator.evaluate(plan, patchOutput);
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, false);
  assert.equal(result.guardrail?.reason_code, "scope_violation");
});

test("CriticEvaluator classifies guardrails from validation errors", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: false, errors: ["merge_conflict"] }) as any);
  const result = await evaluator.evaluate(plan, "output", ["file.ts"]);
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, false);
  assert.equal(result.guardrail?.reason_code, "merge_conflict");
  assert.equal(result.guardrail?.disposition, "non_retryable");
});

test("CriticEvaluator classifies destructive operation guardrails", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(
    new StubValidator({ ok: false, errors: ["destructive_operation_blocked"] }) as any,
  );
  const result = await evaluator.evaluate(plan, "output", ["file.ts"]);
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, false);
  assert.equal(result.guardrail?.reason_code, "destructive_operation_guard");
  assert.equal(result.guardrail?.disposition, "non_retryable");
});

test("CriticEvaluator fails when plan has no concrete targets", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const noTargetsPlan: Plan = {
    steps: ["step"],
    target_files: [],
    risk_assessment: "low",
    verification: ["echo ok"],
  };
  const result = await evaluator.evaluate(noTargetsPlan, "output", ["src/index.ts"]);
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, false);
  assert.equal(result.guardrail?.reason_code, "scope_violation");
  assert.ok(result.reasons.includes("alignment_missing_plan_targets"));
});

test("CriticEvaluator appends summary to context manager", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-critic-"));
  const store = new ContextStore({ workspaceRoot, storageDir: "codali/context" });
  const contextManager = new ContextManager({ config: makeConfig(), store });
  const lane = await contextManager.getLane({ jobId: "job-crit", taskId: "task-crit", role: "critic" });
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any, {
    contextManager,
    laneId: lane.id,
    model: "test",
  });

  await evaluator.evaluate(plan, "output");
  const snapshot = await store.loadLane(lane.id);
  assert.equal(snapshot.messageCount, 1);
  assert.ok(snapshot.messages[0].content.includes("CRITIC_RESULT v1"));
});
