import test from "node:test";
import assert from "node:assert/strict";
import { createWorkState } from "../../session/WorkState.js";
import { inspectPlanDiff } from "../TerminalPlan.js";

test("plan inspection distinguishes scope/dependency changes from execution progress", () => {
  const state = createWorkState("Deliver the feature");
  state.tasks[0].allowedPaths = ["src/b.ts", "src/a.ts"];
  state.planHistory = [{ revision: 1, goalRevision: 1, at: state.createdAt, reason: "Narrow scope", tasks: structuredClone(state.tasks), phases: [] }];
  state.planRevision = 2;
  state.tasks[0].status = "verified"; state.tasks[0].evidenceIds = ["actual-receipt"];
  state.tasks[0].allowedPaths.reverse();
  assert.deepEqual(inspectPlanDiff(state).tasks, [], "Execution status and set ordering are not plan changes");
  state.tasks[0].allowedPaths = ["src/a.ts"];
  state.tasks.push({ ...structuredClone(state.tasks[0]), id: "T2", title: "Integration", dependsOn: ["T1"] });
  state.phases = [{ id: "integration", title: "Integration", dependsOn: [], exitRequirementIds: ["R1"] }];
  const original = JSON.stringify(state);
  const diff = inspectPlanDiff(state);
  assert.equal(diff.fromRevision, 1); assert.equal(diff.toRevision, 2);
  assert.deepEqual(diff.tasks.map(change => change.id), ["T1", "T2"]);
  assert.deepEqual(diff.tasks[0].before?.allowedPaths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(diff.tasks[0].after?.allowedPaths, ["src/a.ts"]);
  assert.deepEqual(diff.tasks[1].after?.dependsOn, ["T1"]);
  assert.equal(diff.tasks[1].before, undefined);
  assert.equal(diff.phases[0].after?.id, "integration");
  const reverse = inspectPlanDiff(state, 2, 1);
  assert.equal(reverse.tasks[1].after, undefined, "Removed tasks remain reviewable");
  assert.equal(JSON.stringify(state), original, "Inspection must not mutate saved contracts");
});

test("plan diff handles legacy initial plans and refuses unknown or invalid revisions", () => {
  const state = createWorkState("Legacy objective"); delete state.planRevision; delete state.planHistory;
  assert.deepEqual(inspectPlanDiff(state), { fromRevision: 1, toRevision: 1, tasks: [], phases: [] });
  for (const revision of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => inspectPlanDiff(state, revision), /positive integers/);
  assert.throws(() => inspectPlanDiff(state, 2), /Unknown plan revision 2/);
  assert.throws(() => inspectPlanDiff(state, undefined, 2), /Unknown plan revision 2/);
});
