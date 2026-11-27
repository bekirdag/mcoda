import test from "node:test";
import assert from "node:assert/strict";
import { ProgressTracker } from "../ProgressTracker.js";

test("duplicate operations in one response allow feedback before counting a retry", () => {
  const tracker = new ProgressTracker();
  const input = { tool: "run_shell", args: { command: "node", args: ["--test"] }, ok: false,
    hashes: {}, output: "failed", errorCode: "tool_execution_failed" };
  for (let i = 0; i < 4; i++) assert.equal(tracker.observe({ ...input, feedbackRound: 1 }), 1);
  assert.equal(tracker.observe({ ...input, feedbackRound: 2 }), 2);
  assert.equal(tracker.observe({ ...input, feedbackRound: 3 }), 3);
  tracker.clear();
  assert.equal(tracker.observe({ ...input, feedbackRound: 3 }), 1);
});

test("new read evidence starts a new count even within a feedback round", () => {
  const tracker = new ProgressTracker();
  const input = { tool: "read_file", args: { path: "source.ts" }, ok: true, hashes: {}, output: "v1", feedbackRound: 1 };
  assert.equal(tracker.observe(input), 1);
  assert.equal(tracker.observe({ ...input, feedbackRound: 2 }), 2);
  assert.equal(tracker.observe({ ...input, output: "v2", feedbackRound: 2 }), 1);
});

test("test timing and temporary paths cannot defeat unchanged failure tracking", () => {
  const tracker = new ProgressTracker();
  for (let i = 1; i <= 7; i++) assert.equal(tracker.observe({ tool: "run_shell", args: { command: "node", args: ["--test"] }, ok: false,
    hashes: { "test.mjs": "abc" }, output: `duration ${i}ms; /tmp/random-${i}/test.mjs failed`, errorCode: "tool_execution_failed" }), i);
  assert.equal(tracker.observe({ tool: "run_shell", args: { command: "node", args: ["--test"] }, ok: false,
    hashes: { "test.mjs": "fixed" }, output: "failed", errorCode: "tool_execution_failed" }), 1);
});

test("read repetitions track actual content and task attempts, not observation inventory", () => {
  const tracker = new ProgressTracker();
  const input = { tool: "read_file", args: { path: "a.txt" }, ok: true, hashes: { "a.txt": "one" }, output: "one", task: { id: "T1", attemptId: "A1" } };
  assert.equal(tracker.observe(input), 1); assert.equal(tracker.observe(input), 2);
  assert.equal(tracker.observe({ ...input, output: "user edited content" }), 1);
  assert.equal(tracker.observe({ ...input, task: { id: "T1", attemptId: "A2" } }), 1);
  assert.equal(tracker.observe({ ...input, hashes: { "a.txt": "one", "other.txt": "two" } }), 3);
  assert.equal(tracker.observe({ ...input, tool: "work_status" }), 0);
  assert.equal(tracker.observe(input), 4);
  tracker.clear(); assert.equal(tracker.observe(input), 1);
});

test("remote polling and successful tests are not treated as stalled local reads", () => {
  const tracker = new ProgressTracker();
  for (const tool of ["media_status", "work_status", "run_shell"]) for (let i = 0; i < 10; i++) {
    assert.equal(tracker.observe({ tool, args: {}, ok: true, hashes: {}, output: "pending" }), 0);
  }
});

test("interleaved directory discovery cannot hide unchanged read loops", () => {
  const tracker = new ProgressTracker();
  const hashes: Record<string, string> = {};
  for (let i = 1; i <= 8; i++) {
    hashes[`discovered-${i}.txt`] = String(i);
    tracker.observe({ tool: "read_file", args: { path: `discovered-${i}.txt` }, ok: true, hashes, output: String(i) });
    assert.equal(tracker.observe({ tool: "read_file", args: { path: "package.json" }, ok: true, hashes, output: "unchanged" }), i);
    assert.equal(tracker.observe({ tool: "list_files", args: { path: "." }, ok: true, hashes, output: "same listing" }), i);
  }
  assert.equal(tracker.observe({ tool: "list_files", args: { path: "." }, ok: true, hashes, output: "new listing" }), 1);
});

test("preparation loops ignore changing receipt IDs but respect source and pagination changes", () => {
  const tracker = new ProgressTracker();
  const input = { tool: "prepare_edit", args: { path: "src/app.js" }, ok: true,
    hashes: { "src/app.js": "same-source" }, task: { id: "T1", attemptId: "A1" }, output: "receipt-one" };
  assert.equal(tracker.observe(input), 1);
  assert.equal(tracker.observe({ ...input, output: "receipt-two", args: { path: "./src/app.js", offset: 0 } }), 2);
  assert.equal(tracker.observe({ ...input, args: { path: "src/app.js", offset: 4000 } }), 1);
  assert.equal(tracker.observe({ ...input, hashes: { "src/app.js": "edited-source" } }), 1);
  assert.equal(tracker.observe({ ...input, task: { id: "T1", attemptId: "A2" } }), 1);
  assert.equal(tracker.observe({ ...input, hashes: { "src/app.js": "same-source", "other.js": "new-observation" } }), 3);
  assert.equal(tracker.observe({ ...input, hashes: {} }), 0);
});
