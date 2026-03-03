import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValidationRunner } from "../ValidationRunner.js";

test("ValidationRunner skips shell steps when shell validation is disabled", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: false,
    shellAllowlist: [],
    workspaceRoot: process.cwd(),
  });

  const result = await runner.run(["npm test", "curl -sf http://localhost:3000/healthz"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.outcome, "unverified_with_reason");
  assert.ok(result.reason_codes.includes("verification_shell_disabled"));
});

test("ValidationRunner returns verified_passed for allowlisted successful checks", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: true,
    shellAllowlist: [process.execPath],
    workspaceRoot: process.cwd(),
  });
  const result = await runner.run([`${process.execPath} -e process.exit(0)`], {
    policyName: "test",
    minimumChecks: 1,
    enforceHighConfidence: true,
    touchedFiles: ["src/index.ts"],
  });
  assert.equal(result.outcome, "verified_passed");
  assert.equal(result.report.outcome, "verified_passed");
  assert.equal(result.policy.policy_name, "test");
  assert.equal(result.totals.passed, 1);
  assert.equal(result.report.policy.enforce_high_confidence, true);
});

test("ValidationRunner classifies command failure with deterministic reason", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: true,
    shellAllowlist: [process.execPath],
    workspaceRoot: process.cwd(),
  });
  const result = await runner.run([`${process.execPath} -e process.exit(2)`], {
    policyName: "general",
  });
  assert.equal(result.outcome, "verified_failed");
  assert.ok(result.reason_codes.includes("verification_command_failed"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("ValidationRunner classifies non-allowlisted checks as unverified", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: true,
    shellAllowlist: ["pnpm"],
    workspaceRoot: process.cwd(),
  });
  const result = await runner.run([`${process.execPath} -e process.exit(0)`], {
    policyName: "general",
  });
  assert.equal(result.outcome, "unverified_with_reason");
  assert.ok(result.reason_codes.includes("verification_command_not_allowlisted"));
});

test("ValidationRunner emits docdex_unavailable for hooks checks without client", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: true,
    shellAllowlist: ["pnpm"],
    workspaceRoot: process.cwd(),
  });
  const result = await runner.run(["docdex:hooks:src/index.ts"], {
    policyName: "general",
  });
  assert.equal(result.outcome, "unverified_with_reason");
  assert.ok(result.reason_codes.includes("verification_docdex_unavailable"));
});

test("ValidationRunner enforces minimum checks deterministically", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: true,
    shellAllowlist: [process.execPath],
    workspaceRoot: process.cwd(),
  });
  const result = await runner.run(
    [`${process.execPath} -e process.exit(0)`],
    { policyName: "strict", minimumChecks: 2 },
  );
  assert.equal(result.outcome, "unverified_with_reason");
  assert.ok(result.reason_codes.includes("verification_policy_minimum_unmet"));
  assert.equal(result.totals.passed, 1);
});

test("ValidationRunner classifies timed-out checks", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: true,
    shellAllowlist: [process.execPath],
    workspaceRoot: process.cwd(),
    shellTimeoutMs: 10,
  });
  const result = await runner.run([`${process.execPath} -e setTimeout(() => process.exit(0), 1000)`], {
    policyName: "general",
  });
  assert.equal(result.outcome, "verified_failed");
  assert.ok(result.reason_codes.includes("verification_command_timeout"));
});

test("ValidationRunner resolves deterministic derived verification plans", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: false,
    shellAllowlist: [],
    workspaceRoot: process.cwd(),
  });
  let firstPlan: unknown;
  let secondPlan: unknown;
  const first = await runner.run([], {
    policyName: "test",
    touchedFiles: ["src/index.ts"],
    onResolvedPlan: (plan) => {
      firstPlan = plan;
    },
  });
  const second = await runner.run([], {
    policyName: "test",
    touchedFiles: ["src/index.ts"],
    onResolvedPlan: (plan) => {
      secondPlan = plan;
    },
  });

  assert.deepEqual(firstPlan, secondPlan);
  assert.equal(first.report.resolved_checks_source, "derived");
  assert.ok(first.report.project_signals?.includes("package_json"));
  assert.equal(second.report.resolved_checks_source, "derived");
});

test("ValidationRunner skips derived docdex hooks outside git repos", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-validation-nogit-"));
  mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "tmp" }), "utf8");

  const runner = new ValidationRunner({
    allowShell: false,
    shellAllowlist: [],
    workspaceRoot,
  });
  let resolvedPlan: unknown;
  await runner.run([], {
    policyName: "test",
    touchedFiles: ["src/index.ts"],
    onResolvedPlan: (plan) => {
      resolvedPlan = plan;
    },
  });

  const checks = Array.isArray((resolvedPlan as { checks?: unknown[] } | undefined)?.checks)
    ? ((resolvedPlan as { checks: Array<{ check_type?: string }> }).checks)
    : [];
  assert.equal(checks.some((check) => check.check_type === "docdex_hooks"), false);
});
