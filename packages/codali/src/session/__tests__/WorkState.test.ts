import test from "node:test";
import assert from "node:assert/strict";
import { activeWorkContext, createWorkState, replaceWorkPlan, updateWorkPlan, claimWorkTask, assertWorkAttempt, recordWorkEvidence, verifyWorkTask, completeWorkGoal, amendWorkGoal, recordDecision, refreshStaleEvidence, releaseWorkTask, reopenVerifiedTask } from "../WorkState.js";
import type { WorkState } from "../WorkTypes.js";

const task = (id: string, dependsOn: string[] = []) => ({ id, title: id, requirementIds: ["R1"], dependsOn, allowedPaths: ["src"] });
const evidence = (state: WorkState, attempt: string) => recordWorkEvidence(state, "T1", attempt, { id: "E1", taskId: "T1", criterionIds: ["R1"], kind: "tool", ok: true, summary: "Regression check passed", invocationId: "I1", inputHashes: { "src/a.ts": "old" }, at: new Date().toISOString() });

test("plans reject cycles and missing prerequisites without replacing the current plan", () => {
  const state = createWorkState("Fix parser");
  assert.throws(() => replaceWorkPlan(state, [task("A", ["B"]), task("B", ["A"])]), /dependency cycle/);
  assert.throws(() => replaceWorkPlan(state, [task("A", ["missing"])]), /missing\/self dependency/);
  assert.deepEqual(state.tasks.map(t => t.id), ["T1"]);
});

test("planning must cover requirements and reject traversal scopes", () => {
  const state = createWorkState("Fix parser");
  assert.throws(() => replaceWorkPlan(state, []), /Uncovered requirement/);
  assert.throws(() => replaceWorkPlan(state, [{ ...task("T1"), allowedPaths: ["../outside"] }]), /invalid path/);
});

test("dependency readiness and one workspace writer are enforced", () => {
  const state = createWorkState("Fix parser");
  replaceWorkPlan(state, [task("T1"), task("T2"), task("T3", ["T1"])]);
  assert.equal(state.tasks[2].status, "planned");
  assert.throws(() => claimWorkTask(state, "T3"), /not ready/);
  claimWorkTask(state, "T1");
  assert.throws(() => claimWorkTask(state, "T2"), /already owns/);
});

test("focused plan updates retain verified work and pending deliverables with the original safety gates", () => {
  const state = createWorkState("Deliver parser and integration evidence");
  replaceWorkPlan(state, [{ ...task("T1"), phaseId: "build" }, task("integration", ["T1"]), { ...task("delivery"), allowedPaths: [] }],
    [{ id: "build", title: "Implementation", dependsOn: [], exitRequirementIds: ["R1"] }]);
  const first = claimWorkTask(state, "T1").attemptId!; evidence(state, first); verifyWorkTask(state, "T1", first, { "src/a.ts": "old" });
  const verified = structuredClone(state.tasks[0]); const requirements = structuredClone(state.requirements);
  updateWorkPlan(state, [{ ...task("delivery"), allowedPaths: ["DELIVERY.md"] }, task("integration", ["T1", "delivery"])], undefined, "Scope the new delivery artifact");
  assert.deepEqual(state.tasks[0], verified); assert.deepEqual(state.requirements, requirements);
  assert.equal(state.phases?.[0].id, "build"); assert.equal(state.tasks[1].status, "planned"); assert.equal(state.tasks[2].status, "ready");
  assert.deepEqual(state.tasks[2].allowedPaths, ["DELIVERY.md"]); assert.equal(state.planHistory?.at(-1)?.tasks[2].allowedPaths.length, 0);
  const before = structuredClone(state);
  for (const apply of [
    () => updateWorkPlan(state, [task("delivery", ["integration"])]),
    () => updateWorkPlan(state, [{ ...task("T1"), title: "Silently replace verified behavior" }]),
    () => updateWorkPlan(state, [task("delivery"), task("delivery")]),
    () => updateWorkPlan(state, [], [{ id: "build", title: "Changed architecture", dependsOn: [], exitRequirementIds: ["R1"] }]),
  ]) { assert.throws(apply); assert.deepEqual(state, before); }
  claimWorkTask(state, "delivery");
  assert.throws(() => updateWorkPlan(state, [task("delivery")]), /current attempt/);
});

test("focused updates cannot silently reopen unrelated blocked or retired work", () => {
  const state = createWorkState("Keep blocked work explicit");
  replaceWorkPlan(state, [task("T1"), task("blocked"), task("cancelled"), task("superseded")]);
  state.tasks[1].status = "blocked"; state.tasks[1].blocker = "Waiting for an external dependency";
  state.tasks[2].status = "cancelled"; state.tasks[3].status = "superseded";
  const retained = structuredClone(state.tasks.slice(1));
  updateWorkPlan(state, [{ ...task("T1"), allowedPaths: ["src/parser.ts"] }]);
  assert.deepEqual(state.tasks.slice(1), retained);
  const before = structuredClone(state);
  assert.throws(() => updateWorkPlan(state, [{ ...task("T1"), requirementIds: ["unknown"] }]), /unknown/);
  assert.deepEqual(state, before);
});

test("releasing an attempt permits replanning without certifying work or accepting late results", () => {
  const state = createWorkState("Fix parser without dependencies");
  const attempt = claimWorkTask(state, "T1").attemptId!;
  evidence(state, attempt);
  assert.throws(() => releaseWorkTask(state, "T1", "stale", "Refine scope"), /stale/);
  releaseWorkTask(state, "T1", attempt, "Add the missing source scope");
  assert.equal(state.originalObjective, "Fix parser without dependencies");
  assert.equal(state.tasks[0].status, "ready");
  assert.equal(state.evidence.length, 1);
  assert.deepEqual(state.tasks[0].evidenceIds, []);
  assert.throws(() => assertWorkAttempt(state, "T1", attempt), /Stale/);
  replaceWorkPlan(state, [task("T1")]);
  const next = claimWorkTask(state, "T1").attemptId!;
  assert.notEqual(next, attempt);
  assert.throws(() => verifyWorkTask(state, "T1", next, { "src/a.ts": "old" }), /Unverified/);
  assert.match(state.checkpoints.at(-1)!.note, /Add the missing source scope/);
});

test("unverified work and stale evidence cannot certify completion", () => {
  const state = createWorkState("Fix parser");
  assert.throws(() => completeWorkGoal(state, {}), /Required task work remains/);
  const attempt = claimWorkTask(state, "T1").attemptId!;
  assert.throws(() => verifyWorkTask(state, "T1", attempt, {}), /Unverified/);
  evidence(state, attempt);
  assert.throws(() => verifyWorkTask(state, "T1", attempt, { "src/a.ts": "new" }), /stale criterion/);
  verifyWorkTask(state, "T1", attempt, { "src/a.ts": "old" });
  assert.throws(() => completeWorkGoal(state, { "src/a.ts": "new" }), /stale criterion/);
  assert.throws(() => completeWorkGoal(state, { "src/a.ts": "old" }, ["unknown-operation"]), /unresolved side effects/);
  completeWorkGoal(state, { "src/a.ts": "old" });
  assert.equal(state.status, "completed");
});

test("disproven verification reopens dependent phases and fences attempts without rewriting criteria", () => {
  const state = createWorkState("Fix ordering and preserve user data");
  replaceWorkPlan(state, [{ ...task("T1"), phaseId: "build" }, { ...task("T2"), phaseId: "test" }, task("T3", ["T2"]), task("independent")], [
    { id: "build", title: "Implementation", dependsOn: [], exitRequirementIds: ["R1"] },
    { id: "test", title: "Validation", dependsOn: ["build"], exitRequirementIds: ["R1"] },
  ]);
  const requirements = structuredClone(state.requirements); const planRevision = state.planRevision;
  const first = claimWorkTask(state, "T1").attemptId!; evidence(state, first);
  verifyWorkTask(state, "T1", first, { "src/a.ts": "old" });
  const downstream = claimWorkTask(state, "T2").attemptId!;
  assert.throws(() => reopenVerifiedTask(state, "T1", ""), /new evidence/);
  assert.equal(state.tasks[0].status, "verified");
  assert.deepEqual(reopenVerifiedTask(state, "T1", "New regression test finds duplicate-edge ordering failure"), ["T1", "T2", "T3"]);
  assert.equal(state.tasks[0].status, "ready"); assert.equal(state.tasks[1].status, "planned"); assert.equal(state.tasks[3].status, "ready");
  assert.equal(state.planRevision, planRevision); assert.deepEqual(state.requirements, requirements);
  assert.equal(state.evidence.length, 1); assert.deepEqual(state.tasks[0].evidenceIds, []);
  assert.throws(() => assertWorkAttempt(state, "T2", downstream), /Stale/);
  const repair = claimWorkTask(state, "T1").attemptId!;
  assert.notEqual(repair, first);
  assert.throws(() => verifyWorkTask(state, "T1", repair, { "src/a.ts": "old" }), /Unverified/);
  assert.throws(() => completeWorkGoal(state, { "src/a.ts": "old" }), /Required task/);
  assert.throws(() => reopenVerifiedTask(state, "T1", "still incomplete"), /Only a verified/);
  assert.match(state.checkpoints.at(-1)!.note, /duplicate-edge/);
});

test("steering fences stale attempts and preserves original intent", () => {
  const state = createWorkState("Fix parser without new dependencies");
  const attempt = claimWorkTask(state, "T1").attemptId!;
  amendWorkGoal(state, "Fix parser and support unicode", "User requested unicode support");
  assert.equal(state.originalObjective, "Fix parser without new dependencies");
  assert.equal(state.goalRevision, 2);
  assert.throws(() => assertWorkAttempt(state, "T1", attempt), /Stale task attempt/);
  assert.equal(state.amendments.length, 1);
});

test("expired leases and unrelated receipts are rejected", () => {
  const state = createWorkState("Fix parser");
  const task = claimWorkTask(state, "T1");
  task.leaseExpiresAt = new Date(0).toISOString();
  assert.throws(() => evidence(state, task.attemptId!), /lease expired/);
});

test("verified tasks and architecture history cannot be silently rewritten", () => {
  const state = createWorkState("Fix parser");
  const attempt = claimWorkTask(state, "T1").attemptId!;
  evidence(state, attempt); verifyWorkTask(state, "T1", attempt, { "src/a.ts": "old" });
  assert.throws(() => replaceWorkPlan(state, [{ ...task("T1"), title: "Different feature" }]), /rewrite verified/);
  recordDecision(state, { id: "D1", title: "Retain parser", rationale: "Preserves API", alternatives: ["Rewrite"], paths: ["src"] });
  assert.throws(() => recordDecision(state, { id: "D2", title: "Replace", rationale: "New evidence", alternatives: [], paths: [], supersedes: "missing" }), /does not exist/);
});

test("changed evidence reopens work and invalidates dependent acceptance", () => {
  const state = createWorkState("Fix parser");
  replaceWorkPlan(state, [task("T1"), task("T2", ["T1"])]);
  const first = claimWorkTask(state, "T1").attemptId!;
  evidence(state, first); verifyWorkTask(state, "T1", first, { "src/a.ts": "old" });
  const second = claimWorkTask(state, "T2").attemptId!;
  recordWorkEvidence(state, "T2", second, { id: "E2", taskId: "T2", criterionIds: ["R1"], kind: "review", ok: true, summary: "Review", inputHashes: {}, at: new Date().toISOString() });
  verifyWorkTask(state, "T2", second, {});
  assert.deepEqual(refreshStaleEvidence(state, { "src/a.ts": "changed" }), ["T1", "T2"]);
  assert.equal(state.tasks[0].status, "ready"); assert.equal(state.tasks[1].status, "planned");
  assert.equal(state.evidence.length, 2);
});

test("phase dependencies gate dispatch, retain plan history, and reject cross-phase cycles", () => {
  const state = createWorkState("Implement in phases");
  const phases = [{ id: "design", title: "Design", dependsOn: [], exitRequirementIds: ["R1"] }, { id: "build", title: "Build", dependsOn: ["design"], exitRequirementIds: ["R1"] }];
  const tasks = [{ ...task("T1"), phaseId: "design" }, { ...task("T2"), phaseId: "build" }];
  replaceWorkPlan(state, tasks, phases, "Separate architecture and implementation");
  assert.equal(state.planRevision, 2);
  assert.equal(state.planHistory?.[0].tasks[0].title, "Implement in phases");
  assert.throws(() => claimWorkTask(state, "T2"), /not ready/);
  const first = claimWorkTask(state, "T1").attemptId!;
  evidence(state, first); verifyWorkTask(state, "T1", first, { "src/a.ts": "old" });
  assert.equal(state.tasks[1].status, "ready");
  const broken = createWorkState("Prevent phase cycle");
  assert.throws(() => replaceWorkPlan(broken, [{ ...tasks[0], dependsOn: ["T2"] }, tasks[1]], phases), /dependency cycle/);
  assert.equal(broken.planRevision, 1);
  assert.equal(broken.planHistory?.length, 0);
});

test("review-pending work keeps the only writer lease", () => {
  const state = createWorkState("Review before advancing");
  replaceWorkPlan(state, [task("T1"), task("T2")]);
  const attempt = claimWorkTask(state, "T1").attemptId!;
  evidence(state, attempt);
  assert.throws(() => claimWorkTask(state, "T2"), /already owns/);
});

test("replanning cannot rewrite verified phase gates or add unmet prerequisites beneath verified work", () => {
  const state = createWorkState("Preserve reviewed architecture");
  const phases = [{ id: "design", title: "Design", dependsOn: [], exitRequirementIds: ["R1"] }, { id: "build", title: "Build", dependsOn: ["design"], exitRequirementIds: ["R1"] }];
  const tasks = [{ ...task("T1"), phaseId: "design" }, { ...task("T2"), phaseId: "build" }];
  replaceWorkPlan(state, tasks, phases);
  const first = claimWorkTask(state, "T1").attemptId!;
  evidence(state, first); verifyWorkTask(state, "T1", first, { "src/a.ts": "old" });
  const second = claimWorkTask(state, "T2").attemptId!;
  recordWorkEvidence(state, "T2", second, { id: "E2", taskId: "T2", criterionIds: ["R1"], kind: "review", ok: true, summary: "Reviewed", inputHashes: {}, at: new Date().toISOString() });
  verifyWorkTask(state, "T2", second, {});
  const before = structuredClone(state);
  assert.throws(() => replaceWorkPlan(state, tasks, [{ ...phases[0], title: "Different architecture" }, phases[1]]), /phase contract/);
  assert.deepEqual(state, before);
  assert.throws(() => replaceWorkPlan(state, [...tasks, { ...task("T3"), phaseId: "design" }], phases), /unverified prerequisite/);
  assert.deepEqual(state, before);
  // Adding a new downstream phase remains a routine valid refinement.
  replaceWorkPlan(state, [...tasks, { ...task("T3"), phaseId: "release" }], [...phases, { id: "release", title: "Release", dependsOn: ["build"], exitRequirementIds: ["R1"] }]);
  assert.equal(state.tasks[2].status, "ready");
});

test("superseded architecture decisions fence a running transitive dependent", () => {
  const state = createWorkState("Keep implementation aligned with decisions");
  const tasks = [task("T1"), { ...task("T2", ["T1"]), allowedPaths: ["tests"] }, { ...task("T3", ["T2"]), allowedPaths: ["docs"] }];
  replaceWorkPlan(state, tasks);
  recordDecision(state, { id: "D1", title: "Parser API", rationale: "Preserve callers", alternatives: [], paths: ["src"] });
  const first = claimWorkTask(state, "T1").attemptId!;
  evidence(state, first); verifyWorkTask(state, "T1", first, { "src/a.ts": "old" });
  const second = claimWorkTask(state, "T2").attemptId!;
  recordWorkEvidence(state, "T2", second, { id: "E2", taskId: "T2", criterionIds: ["R1"], kind: "review", ok: true, summary: "Reviewed", inputHashes: {}, at: new Date().toISOString() });
  verifyWorkTask(state, "T2", second, {});
  const third = claimWorkTask(state, "T3").attemptId!;
  recordDecision(state, { id: "D2", title: "Revised parser API", rationale: "New constraint", alternatives: [], paths: ["src"], supersedes: "D1" });
  assert.deepEqual(state.tasks.map(t => t.status), ["ready", "planned", "planned"]);
  assert.throws(() => assertWorkAttempt(state, "T3", third), /Stale task attempt/);
  assert.equal(state.evidence.length, 2);
  assert.equal(state.decisions.length, 2);
});

test("stale prerequisite evidence fences active work and reopens a completed goal", () => {
  const state = createWorkState("Detect external changes");
  replaceWorkPlan(state, [task("T1"), task("T2", ["T1"])]);
  const first = claimWorkTask(state, "T1").attemptId!;
  evidence(state, first); verifyWorkTask(state, "T1", first, { "src/a.ts": "old" });
  const second = claimWorkTask(state, "T2").attemptId!;
  assert.deepEqual(refreshStaleEvidence(state, { "src/a.ts": "new" }), ["T1", "T2"]);
  assert.throws(() => assertWorkAttempt(state, "T2", second), /Stale task attempt/);
  const completed = createWorkState("A completed task can become stale");
  const attempt = claimWorkTask(completed, "T1").attemptId!;
  evidence(completed, attempt); verifyWorkTask(completed, "T1", attempt, { "src/a.ts": "old" });
  completeWorkGoal(completed, { "src/a.ts": "old" });
  refreshStaleEvidence(completed, { "src/a.ts": "new" });
  assert.equal(completed.status, "active");
});

test("large-backlog context keeps the active contract and leaves every omitted criterion canonical", () => {
  const requirements = Array.from({ length: 200 }, (_, index) => ({ id: `R${index + 1}`, description: `Required behavior ${index + 1}: ${"Detailed acceptance evidence. ".repeat(10)}`, required: true }));
  const state = createWorkState("Preserve the full delivery objective", requirements);
  state.constraints = ["Keep the existing public API"];
  replaceWorkPlan(state, requirements.map((r, index) => ({ ...task(`T${index + 1}`), requirementIds: [r.id] })));
  claimWorkTask(state, "T150");
  recordDecision(state, { id: "D1", title: "Keep parser interface", rationale: "Existing callers", alternatives: [], paths: ["src"] });
  const before = structuredClone(state);
  const encoded = activeWorkContext(state, 5000);
  const view = JSON.parse(encoded);
  assert.ok(encoded.length <= 5000);
  assert.equal(view.contextPartial, true);
  assert.equal(view.originalObjective, state.originalObjective);
  assert.deepEqual(view.constraints, state.constraints);
  assert.equal(view.activeTask.id, "T150");
  assert.deepEqual(view.requirements, [requirements[149]]);
  assert.equal(view.decisions[0].id, "D1");
  assert.equal(view.totalRequirements, 200);
  assert.deepEqual(state, before);
  assert.throws(() => completeWorkGoal(state, {}), /Required task work remains/);
  assert.throws(() => activeWorkContext(state, 100), /Active goal.*exceed/);
});
