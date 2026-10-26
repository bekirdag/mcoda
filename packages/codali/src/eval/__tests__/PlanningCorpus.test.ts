import test from "node:test";
import assert from "node:assert/strict";
import { gradePlanningState, planningCorpus, planningCorpusHash, planningPrompt, referencePlanningState } from "../PlanningCorpus.js";
import { createWorkState } from "../../session/WorkState.js";
import type { WorkState } from "../../session/WorkTypes.js";

test("planning corpus references pass while unplanned goals fail, with no hidden answer in the prompt", () => {
  const corpus = planningCorpus();
  assert.equal(corpus.length, 6); assert.equal(new Set(corpus.map(c => c.id)).size, 6);
  assert.match(planningCorpusHash(), /^[a-f0-9]{64}$/); assert.equal(planningCorpusHash(), planningCorpusHash());
  for (const item of corpus) {
    assert.equal(gradePlanningState(item, referencePlanningState(item)).passed, true, item.id);
    assert.equal(gradePlanningState(item, createWorkState(planningPrompt(item))).passed, false, item.id);
    assert.ok(!planningPrompt(item).includes('"accepted"'));
    assert.ok(!planningPrompt(item).includes(item.decision.rationale));
  }
});

const mutations: Array<[string, (state: WorkState) => void, RegExp]> = [
  ["drop criterion", state => { state.requirements = state.requirements.filter(r => r.id !== "R5"); }, /Lost or rewritten criterion R5/],
  ["weaken criterion", state => { state.requirements.find(r => r.id === "R6")!.description = "Run one happy-path test"; }, /Lost or rewritten criterion R6/],
  ["invent scope", state => { state.requirements.push({ id: "R8", description: "Add a new UI", required: false }); }, /Invented criteria/],
  ["omit prerequisite", state => { state.tasks.find(t => t.id === "task-R4")!.dependsOn = []; }, /Missing prerequisite R3 before R4/],
  ["reverse prerequisite", state => { state.tasks.find(t => t.id === "task-R3")!.dependsOn = ["task-R4"]; }, /cycle/],
  ["widen paths", state => { state.tasks.find(t => t.id === "task-R3")!.allowedPaths = ["."]; }, /Scope mismatch: R3/],
  ["omit required file", state => { state.tasks.find(t => t.id === "task-R5")!.allowedPaths = []; }, /Scope mismatch: R5/],
  ["move implementation before design", state => { state.tasks.find(t => t.id === "task-R3")!.phaseId = "design"; }, /Wrong phase: R3/],
  ["unsafe architecture", state => { state.decisions[0].title = state.decisions[0].alternatives[0]; }, /Architecture choice/],
  ["claim done", state => { state.status = "completed"; }, /Planning falsely claimed/],
  ["drop constraint", state => { state.constraints = []; }, /constraints changed/],
  ["rename objective", state => { state.originalObjective = "Ship unrelated feature"; }, /Original planning objective changed/],
  ["skip integration order", state => { state.tasks.find(t => t.id === "integrate")!.dependsOn = []; }, /Final integration/],
  ["drop final criterion", state => { state.tasks = state.tasks.filter(t => t.id !== "integrate"); }, /Final integration/],
];
for (const [name, mutate, expected] of mutations) test(`planning grader rejects ${name}`, () => {
  for (const item of planningCorpus()) {
    const state = referencePlanningState(item); mutate(state);
    const result = gradePlanningState(item, state);
    assert.equal(result.passed, false, item.id); assert.match(result.failures.join("\n"), expected, item.id);
  }
});

test("phase prerequisites may express ordering without duplicate explicit task edges", () => {
  for (const item of planningCorpus()) {
    const state = referencePlanningState(item);
    state.tasks.find(t => t.id === "task-R3")!.dependsOn = [];
    state.tasks.find(t => t.id === "task-R6")!.dependsOn = [];
    assert.equal(gradePlanningState(item, state).passed, true, item.id);
  }
});
