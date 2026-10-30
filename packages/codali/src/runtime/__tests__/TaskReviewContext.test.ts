import test from "node:test";
import assert from "node:assert/strict";
import { reviewPromptContext, taskReviewContext } from "../TaskReviewContext.js";
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
  assert.deepEqual(context.requirements, state.requirements, "integration reviews every canonical criterion, including refinements");
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

test("large whole-goal review references duplicate text without losing original requirements or steering", () => {
  const objective = "Preserve exact decimal values and every public API boundary. ".repeat(120);
  const state = createWorkState(objective);
  state.objective += "\nUser steering: add DELIVERY.md without removing any original requirement.";
  const input = { changedPaths: ["task.mjs"], observedPaths: ["task.mjs"], contextPaths: [], currentHashes: { "task.mjs": "a".repeat(64) } };
  const context = taskReviewContext(state, state.tasks[0], input);
  const before = JSON.stringify(context);
  const prompt = reviewPromptContext(context, input.currentHashes);
  assert.equal(prompt.goal, state.objective);
  assert.equal(prompt.requirements.length, context.requirements.length);
  for (let i = 0; i < prompt.requirements.length; i++) {
    const requirement = prompt.requirements[i];
    const ref = "descriptionReference" in requirement ? requirement.descriptionReference : undefined;
    const description: string | undefined = ref ? prompt.goal!.slice(ref.offset, ref.offset + ref.length) : requirement.description;
    assert.equal(description, context.requirements[i].description);
    assert.equal(requirement.id, context.requirements[i].id);
    assert.equal(requirement.required, context.requirements[i].required);
  }
  assert.ok(JSON.stringify(prompt).length < before.length - 6000);
  assert.equal(JSON.stringify(context), before);
  assert.deepEqual(prompt.sourceRoles, context.sourceRoles);
  assert.match(prompt.reviewSnapshotHash, /^[a-f0-9]{64}$/);
  assert.notEqual(reviewPromptContext(context, { "task.mjs": "b".repeat(64) }).reviewSnapshotHash, prompt.reviewSnapshotHash);
});

test("review compression preserves distinct criteria and binds only the reviewable snapshot", () => {
  const { state, input } = fixture();
  const context = taskReviewContext(state, state.tasks[0], input);
  const prompt = reviewPromptContext(context, input.currentHashes);
  assert.deepEqual(prompt.requirements, context.requirements);
  assert.deepEqual(prompt.constraints, context.constraints);
  assert.deepEqual(prompt.decisions, context.decisions);
  assert.deepEqual(prompt.deferredRequirements, context.deferredRequirements);
  const extra = { ...input.currentHashes, "outside.txt": "outside" };
  assert.equal(reviewPromptContext(context, extra).reviewSnapshotHash, prompt.reviewSnapshotHash);
  const reordered = { ...context, reviewPaths: [...context.reviewPaths].reverse() };
  assert.equal(reviewPromptContext(reordered, input.currentHashes).reviewSnapshotHash, prompt.reviewSnapshotHash);
  const alternate = { ...context, goal: "Different objective. " + "details ".repeat(120) };
  assert.deepEqual(reviewPromptContext(alternate, input.currentHashes).requirements, context.requirements);
});
