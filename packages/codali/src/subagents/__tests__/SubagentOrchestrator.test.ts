import test from "node:test";
import assert from "node:assert/strict";
import { SubagentOrchestrator, assertNoOverlappingWriteScopes } from "../SubagentOrchestrator.js";

test("SubagentOrchestrator runs subagents and captures results", { concurrency: false }, async () => {
  const started: string[] = [];
  const orchestrator = new SubagentOrchestrator({
    parentRunId: "run-1",
    maxParallel: 2,
    runner: async ({ spec }) => {
      started.push(spec.id);
      return {
        output: `result:${spec.goal}`,
        toolCallsExecuted: 1,
        touchedFiles: [],
      };
    },
  });

  const results = await orchestrator.run([
    { role: "explorer", goal: "map repo" },
    { role: "reviewer", goal: "review plan" },
  ]);

  assert.deepEqual(started.sort(), ["explorer-1", "reviewer-2"]);
  assert.equal(results[0]?.status, "completed");
  assert.equal(results[0]?.toolCallsExecuted, 1);
  assert.match(results[1]?.summary ?? "", /review plan/);
});

test("SubagentOrchestrator rejects overlapping worker write scopes", () => {
  assert.throws(
    () =>
      assertNoOverlappingWriteScopes([
        {
          id: "worker-a",
          role: "worker",
          goal: "edit runtime",
          permissions: { readOnly: false, writePaths: ["packages/codali/src"] },
        },
        {
          id: "worker-b",
          role: "worker",
          goal: "edit runtime test",
          permissions: { readOnly: false, writePaths: ["packages/codali/src/runtime"] },
        },
      ]),
    /write scopes overlap/,
  );
});

test("SubagentOrchestrator records failed subagents without failing the whole batch", { concurrency: false }, async () => {
  const orchestrator = new SubagentOrchestrator({
    parentRunId: "run-1",
    maxParallel: 1,
    runner: async ({ spec }) => {
      if (spec.role === "reviewer") throw new Error("review failed");
      return { output: "ok" };
    },
  });

  const results = await orchestrator.run([
    { role: "explorer", goal: "map repo" },
    { role: "reviewer", goal: "review plan" },
  ]);

  assert.equal(results[0]?.status, "completed");
  assert.equal(results[1]?.status, "failed");
  assert.equal(results[1]?.error, "review failed");
});
