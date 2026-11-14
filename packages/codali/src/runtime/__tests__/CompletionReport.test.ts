import test from "node:test";
import assert from "node:assert/strict";
import { completionReport, interruptedReport } from "../CompletionReport.js";
import { createWorkState } from "../../session/WorkState.js";

test("stopped-run handoff retains pending work without inventing verification", () => {
  const state = createWorkState("Complete the original application");
  state.tasks[0].status = "blocked"; state.tasks[0].blocker = "Build still fails";
  const original = structuredClone(state);
  const report = interruptedReport(state, "session-id", ["src/app.ts"], ["uncertain-call"]);
  assert.match(report, /Work is incomplete/);
  assert.match(report, /Recorded verification: 0 task/);
  assert.match(report, /Build still fails/);
  assert.match(report, /src\/app.ts/);
  assert.match(report, /1 operation outcome/);
  assert.match(report, /\/resume session-id, then \/continue/);
  assert.deepEqual(state, original);
});

test("completion reports use only currently accepted review summaries", () => {
  const state = createWorkState("Deliver"); state.status = "completed";
  state.tasks[0].status = "verified"; state.tasks[0].evidenceIds = ["accepted", "tool"];
  state.evidence = [
    { id: "old", taskId: "T1", criterionIds: ["R1"], kind: "review", ok: true, summary: "Stale invented claim", inputHashes: {}, at: "old" },
    { id: "accepted", taskId: "T1", criterionIds: ["R1"], kind: "review", ok: true, summary: "The report preserves the documented inclusive boundary.", inputHashes: {}, at: "now" },
    { id: "tool", taskId: "T1", criterionIds: ["R1"], kind: "tool", ok: true, summary: "Unreviewed tool prose", inputHashes: {}, at: "now" },
  ];
  const report = completionReport(state);
  assert.match(report, /documented inclusive boundary/);
  assert.doesNotMatch(report, /Stale invented|Unreviewed tool|budget was exhausted/);
  assert.match(completionReport(state, true), /budget was exhausted/);
  state.tasks[0].status = "ready";
  assert.doesNotMatch(completionReport(state), /inclusive boundary/);
});

test("completion reports bound large backlogs while keeping full evidence in storage", () => {
  const state = createWorkState("Deliver"); state.status = "completed";
  state.tasks[0].status = "verified";
  state.evidence = Array.from({ length: 20 }, (_, i) => ({ id: `E${i}`, taskId: "T1", criterionIds: ["R1"], kind: "review" as const, ok: true, summary: `Summary ${i}: ` + "x".repeat(6000), inputHashes: {}, at: "now" }));
  state.tasks[0].evidenceIds = state.evidence.map(item => item.id);
  const report = completionReport(state);
  assert.ok(report.length < 11000); assert.match(report, /15 additional accepted task summaries/);
  assert.match(report, /Summary 19/); assert.doesNotMatch(report, /Summary 0:/);
  assert.equal(state.evidence[0].summary.length, 6011);
});
