import test from "node:test";
import assert from "node:assert/strict";
import { createWorkState } from "../../session/WorkState.js";
import { workStatusPage } from "../WorkStatusPage.js";

test("large goals stay inspectable with bounded previews and exact record continuation", () => {
  const objective = 'Preserve "every" criterion.\n'.repeat(6000);
  const state = createWorkState(objective);
  for (let i = 2; i < 30; i++) {
    state.requirements.push({ id: `R${i}`, description: `Criterion ${i}: ${objective}`, required: true });
    state.tasks.push({ ...structuredClone(state.tasks[0]), id: `T${i}`, requirementIds: [`R${i}`] });
  }
  const before = structuredClone(state);
  const page = workStatusPage(state, {});
  assert.ok(JSON.stringify(page).length < 13_000);
  assert.equal(page.originalObjectiveTruncated, true);
  assert.equal((page.tasks as Array<{ recordTruncated: boolean }>)[0].recordTruncated, true);
  let combined = "", offset = 0;
  do {
    const chunk = workStatusPage(state, { record: "goal", textOffset: offset });
    assert.ok((chunk.content as string).length <= 6000);
    combined += chunk.content;
    if (chunk.nextTextOffset === null) break;
    offset = chunk.nextTextOffset as number;
  } while (true);
  assert.equal(JSON.parse(combined).originalObjective, objective);
  assert.deepEqual(state, before);
  const selected = workStatusPage(state, { taskIds: ["T28"], requirementIds: ["R28"] });
  assert.equal((selected.tasks as Array<{ id: string }>)[0].id, "T28");
  assert.equal((selected.requirements as Array<{ id: string }>)[0].id, "R28");
  assert.throws(() => workStatusPage(state, { record: "task", recordId: "unknown" }), /Unknown/);
  assert.throws(() => workStatusPage(state, { record: "goal", textOffset: -1 }), /range/);
});

test("status collections and small records remain complete and discoverable", () => {
  const state = createWorkState("Small goal");
  state.decisions.push({ id: "D1", title: "Keep API", rationale: "Compatibility", alternatives: ["Break API"], paths: [] });
  const page = workStatusPage(state, {});
  assert.equal(page.originalObjective, "Small goal");
  assert.deepEqual(page.requirements, state.requirements);
  assert.deepEqual(JSON.parse(workStatusPage(state, { record: "decision" }).content as string), state.decisions);
  assert.deepEqual(JSON.parse(workStatusPage(state, { record: "task", recordId: "T1" }).content as string), state.tasks[0]);
});
