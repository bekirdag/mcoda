import test from "node:test";
import assert from "node:assert/strict";
import { RunContext } from "../RunContext.js";

test("RunContext computes stable contract fingerprint for identical inputs", { concurrency: false }, () => {
  const left = new RunContext("run-a", "/repo", {
    request: "fix lint failures",
    command: "run",
    workspaceRoot: "/repo",
    smart: true,
    provider: "stub",
    model: "stub-model",
    builderMode: "patch_json",
    maxRetries: 2,
    maxContextRefreshes: 1,
    maxSteps: 8,
    maxToolCalls: 6,
    timeoutMs: 120000,
  });
  const right = new RunContext("run-b", "/repo", {
    request: "fix lint failures",
    command: "run",
    workspaceRoot: "/repo",
    smart: true,
    provider: "stub",
    model: "stub-model",
    builderMode: "patch_json",
    maxRetries: 2,
    maxContextRefreshes: 1,
    maxSteps: 8,
    maxToolCalls: 6,
    timeoutMs: 120000,
  });
  assert.equal(left.fingerprint?.algorithm, "sha256");
  assert.equal(left.fingerprint?.value, right.fingerprint?.value);
});

test("RunContext fingerprint changes when request changes", { concurrency: false }, () => {
  const left = new RunContext("run-a", "/repo", {
    request: "fix lint failures",
    command: "run",
    workspaceRoot: "/repo",
  });
  const right = new RunContext("run-b", "/repo", {
    request: "add unit tests",
    command: "run",
    workspaceRoot: "/repo",
  });
  assert.notEqual(left.fingerprint?.value, right.fingerprint?.value);
});

test("RunContext tracks touched files deterministically", { concurrency: false }, () => {
  const context = new RunContext("run-1", "/repo");
  context.recordTouchedFile("b.ts");
  context.recordTouchedFile("a.ts");
  context.recordTouchedFile("b.ts");
  assert.deepEqual(context.getTouchedFiles(), ["a.ts", "b.ts"]);
});
