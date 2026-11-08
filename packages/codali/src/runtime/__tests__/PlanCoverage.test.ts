import test from "node:test";
import assert from "node:assert/strict";
import { retainRootCoverage } from "../PlanCoverage.js";
test("root coverage is retained only on an unambiguous terminal task without weakening criteria", () => {
  const tasks = [{ id: "a", requirementIds: ["R2"], dependsOn: [] }, { id: "b", requirementIds: ["R3"], dependsOn: ["a"] }];
  const before = structuredClone(tasks), planned = retainRootCoverage(tasks, "R1");
  assert.deepEqual(tasks, before);
  assert.deepEqual(planned[0], tasks[0]);
  assert.deepEqual(planned[1], { ...tasks[1], requirementIds: ["R3", "R1"] });
  assert.equal(retainRootCoverage(planned, "R1"), planned);
  const ambiguous = [tasks[0], { ...tasks[1], dependsOn: [] }];
  assert.equal(retainRootCoverage(ambiguous, "R1"), ambiguous);
  const cycle = [{ ...tasks[0], dependsOn: ["b"] }, tasks[1]];
  assert.equal(retainRootCoverage(cycle, "R1"), cycle);
  assert.deepEqual(retainRootCoverage([], "R1"), []);
});
