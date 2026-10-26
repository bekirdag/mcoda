import test from "node:test";
import assert from "node:assert/strict";
import { taskReviewContext } from "../TaskReviewContext.js";
import { createWorkState, replaceWorkPlan } from "../../session/WorkState.js";

function fixture() {
  const state = createWorkState("Implement both modules and produce DELIVERY.md.");
  state.requirements.push({ id: "module", description: "Implement module A.", required: true });
  replaceWorkPlan(state, [
    { id: "A", title: "Module A", requirementIds: ["module"], dependsOn: [], allowedPaths: ["src/a", "test/a.test.mjs"] },
    { id: "integration", title: "Integrate", requirementIds: ["R1"], dependsOn: ["A"], allowedPaths: ["DELIVERY.md"] },
  ]);
  state.constraints = ["Preserve module exports"];
  state.nonGoals = ["No database migrations"];
  state.decisions = [
    { id: "old", title: "Old", rationale: "Old behavior", alternatives: [], paths: [] },
    { id: "global", title: "Current", rationale: "Current behavior", alternatives: [], paths: [], supersedes: "old" },
    { id: "parent", title: "Source conventions", rationale: "Applies to A", alternatives: [], paths: ["src"] },
    { id: "unrelated", title: "Other module", rationale: "Only B", alternatives: [], paths: ["src/b"] },
    { id: "dependency", title: "Shared contract", rationale: "Read-only dependency", alternatives: [], paths: ["shared"] },
  ];
  const input = { changedPaths: ["src/b/value.mjs", "src/a/value.mjs"],
    observedPaths: ["src/b/value.mjs", "src/a/value.mjs", "shared/api.mjs"], contextPaths: ["shared/api.mjs"],
    currentHashes: { "src/a/value.mjs": "a", "src/b/value.mjs": "b", "test/a.test.mjs": "t", "test/b.test.mjs": "u", "shared/api.mjs": "s" } };
  return { state, input };
}

test("assigned review separates sibling edits and deferred requirements while retaining readonly dependencies", () => {
  const { state, input } = fixture();
  const context = taskReviewContext(state, state.tasks[0], input);
  assert.equal(context.reviewScope, "assigned_task");
  assert.equal(context.goal, undefined);
  assert.deepEqual(context.requirements.map(value => value.id), ["module"]);
  assert.deepEqual(context.changedPaths, ["src/a/value.mjs"]);
  assert.deepEqual(context.otherTaskChangedPaths, ["src/b/value.mjs"]);
  assert.deepEqual(context.reviewPaths, ["src/a/value.mjs", "test/a.test.mjs", "shared/api.mjs"]);
  assert.equal(context.sourceRoles["shared/api.mjs"], "read_only_context");
  assert.deepEqual(context.decisions.map(value => value.id), ["global", "parent", "dependency"]);
  assert.deepEqual(context.constraints, state.constraints);
  assert.deepEqual(context.nonGoals, state.nonGoals);
  assert.deepEqual(context.deferredRequirements, [{ id: "R1", owners: [{ taskId: "integration", status: "planned" }] }]);
  assert.equal(state.tasks[1].status, "planned");
});

test("whole-objective review retains all changes and current steering despite a narrow writable scope", () => {
  const { state, input } = fixture();
  state.objective += "\nUser steering: include a delivery inventory.";
  const context = taskReviewContext(state, state.tasks[1], input);
  assert.equal(context.reviewScope, "whole_goal");
  assert.equal(context.goal, state.objective);
  assert.deepEqual(context.changedPaths, input.changedPaths);
  assert.deepEqual(context.otherTaskChangedPaths, []);
  assert.ok(context.reviewPaths.includes("test/b.test.mjs"));
  assert.deepEqual(context.decisions.map(value => value.id), ["global", "parent", "unrelated", "dependency"]);
});

test("read context never makes another task's changes count as this task's implementation or added tests", () => {
  const { state, input } = fixture();
  input.contextPaths.push("src/b/value.mjs", "test/b.test.mjs");
  input.changedPaths.push("test/b.test.mjs");
  const context = taskReviewContext(state, state.tasks[0], input);
  assert.deepEqual(context.changedPaths, ["src/a/value.mjs"]);
  assert.equal(context.sourceRoles["test/b.test.mjs"], "read_only_context");
  assert.equal(context.sourceRoles["src/b/value.mjs"], "read_only_context");
  assert.ok(context.decisions.some(value => value.id === "unrelated"), "a read dependency's contract remains relevant");
});
