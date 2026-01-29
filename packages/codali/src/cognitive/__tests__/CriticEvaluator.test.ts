import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CriticEvaluator } from "../CriticEvaluator.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import type { LocalContextConfig, Plan } from "../Types.js";

class StubValidator {
  constructor(private result: { ok: boolean; errors: string[] }) {}

  async run(): Promise<{ ok: boolean; errors: string[] }> {
    return this.result;
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
    model: "gemma2:2b",
    targetTokens: 1200,
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
  const result = await evaluator.evaluate(plan, "output");
  assert.equal(result.status, "FAIL");
  assert.ok(result.reasons.includes("bad"));
});

test("CriticEvaluator passes when validation ok", { concurrency: false }, async () => {
  const evaluator = new CriticEvaluator(new StubValidator({ ok: true, errors: [] }) as any);
  const result = await evaluator.evaluate(plan, "output");
  assert.equal(result.status, "PASS");
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
  assert.ok(snapshot.messages[0].content.includes("Critic result"));
});
