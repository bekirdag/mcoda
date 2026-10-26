import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { longWorkflowScenarios, longWorkflowPrompt, longWorkflowHash, gradeLongWorkflowState } from "../LongWorkflowJourney.js";
import { runEvaluationProcess } from "../EvaluationProcess.js";
import { createWorkState } from "../../session/WorkState.js";
import type { OrchestrationConfig } from "../../config/OrchestrationConfig.js";

test("long journeys retain module contracts without exposing reference answers", () => {
  assert.equal(longWorkflowScenarios.length, 4);
  assert.equal(new Set(longWorkflowScenarios.map(item => item.id)).size, 4);
  for (const scenario of longWorkflowScenarios) {
    const prompt = longWorkflowPrompt(scenario);
    for (const id of scenario.modules) assert.ok(prompt.includes(`modules/${id}/`));
    for (const id of ["R1", "R2", "R3", "R4", "R5"]) assert.ok(prompt.includes(id));
    assert.ok(prompt.includes(scenario.objective)); assert.ok(prompt.includes("planning-only"));
    assert.ok(!prompt.includes("hiddenChecks")); assert.ok(!prompt.includes("reference:"));
  }
  assert.match(longWorkflowHash(), /^[a-f0-9]{64}$/); assert.equal(longWorkflowHash(), longWorkflowHash());
});

function completed() {
  const state = createWorkState("Deliver all modules", ["R1", "R2", "R3", "R4", "R5", "steering-2"].map(id => ({ id, description: id, required: true })));
  state.goalRevision = 2; state.status = "completed";
  state.amendments = [{ revision: 1, at: new Date().toISOString(), reason: "Delivery inventory", previousObjective: state.objective }];
  state.phases = [{ id: "build", title: "Modules", dependsOn: [], exitRequirementIds: ["R2", "R3", "R4", "R5"] }, { id: "verify", title: "Integration", dependsOn: ["build"], exitRequirementIds: ["R1", "steering-2"] }];
  state.tasks = ["R2", "R3", "R4", "R5", "R1", "steering-2"].map(id => ({ id, title: id, requirementIds: [id], dependsOn: [], allowedPaths: [], evidenceIds: [], status: "verified", phaseId: ["R1", "steering-2"].includes(id) ? "verify" : "build" }));
  state.decisions = [{ id: "D1", title: "Modules", rationale: "Preserve boundaries", alternatives: ["Monolith"], paths: ["modules"] }];
  state.checkpoints = Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, at: new Date().toISOString(), goalRevision: 2, note: "Context compacted", uncertainInvocationIds: [] }));
  return state;
}

test("long journey grader accepts phase dependencies and rejects lost contracts", () => {
  const initial = completed(); assert.deepEqual(gradeLongWorkflowState(initial.originalObjective, initial, initial), []);
  const mutations = [
    (s: ReturnType<typeof completed>) => { s.originalObjective = "Other objective"; },
    (s: ReturnType<typeof completed>) => { s.requirements = s.requirements.filter(r => r.id !== "R3"); },
    (s: ReturnType<typeof completed>) => { s.requirements[1].description = "Weakened"; },
    (s: ReturnType<typeof completed>) => { s.tasks[0].status = "ready"; },
    (s: ReturnType<typeof completed>) => { s.status = "active"; },
    (s: ReturnType<typeof completed>) => { s.decisions[0].rationale = "Rewrite history"; },
    (s: ReturnType<typeof completed>) => { s.decisions = []; },
    (s: ReturnType<typeof completed>) => { s.amendments = []; },
    (s: ReturnType<typeof completed>) => { s.goalRevision = 1; },
    (s: ReturnType<typeof completed>) => { s.checkpoints.pop(); },
    (s: ReturnType<typeof completed>) => { s.phases![1].dependsOn = []; },
    (s: ReturnType<typeof completed>) => { s.phases = []; },
  ];
  for (const mutate of mutations) { const state = completed(); mutate(state); assert.ok(gradeLongWorkflowState(initial.originalObjective, state, initial).length > 0); }
});

const config: OrchestrationConfig = { schemaVersion: 1, profile: "fixture", providers: { test: { adapter: "mswarm", baseUrl: "http://127.0.0.1:1", credentialRef: "env:CODALI_EVAL_TEST_CREDENTIAL" } }, models: {}, bindings: {} };
test("trusted evaluation processes inherit declared credentials but not unrelated environment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-eval-process-"));
  const priorKey = process.env.CODALI_EVAL_TEST_CREDENTIAL; const priorOther = process.env.CODALI_EVAL_UNRELATED;
  try {
    process.env.CODALI_EVAL_TEST_CREDENTIAL = "fixture-value"; process.env.CODALI_EVAL_UNRELATED = "must-not-inherit";
    const file = path.join(root, "child.mjs");
    await fs.writeFile(file, "import assert from 'node:assert/strict';assert.equal(process.env.CODALI_EVAL_TEST_CREDENTIAL,'fixture-value');assert.equal(process.env.CODALI_EVAL_UNRELATED,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);assert.ok(process.env.HOME);\n");
    await runEvaluationProcess({ file, args: [], cwd: root, config, timeoutMs: 5000 });
    await fs.writeFile(file, "process.stderr.write('intentional failure');process.exitCode=2;\n");
    await assert.rejects(runEvaluationProcess({ file, args: [], cwd: root, config, timeoutMs: 5000 }), /intentional failure/);
    await fs.writeFile(file, "process.stdout.write('x'.repeat(200000));\n");
    await assert.rejects(runEvaluationProcess({ file, args: [], cwd: root, config, timeoutMs: 5000 }), /output exceeded/);
  } finally {
    if (priorKey === undefined) delete process.env.CODALI_EVAL_TEST_CREDENTIAL; else process.env.CODALI_EVAL_TEST_CREDENTIAL = priorKey;
    if (priorOther === undefined) delete process.env.CODALI_EVAL_UNRELATED; else process.env.CODALI_EVAL_UNRELATED = priorOther;
    await fs.rm(root, { recursive: true, force: true });
  }
});
