import test from "node:test";
import assert from "node:assert/strict";
import { ProgressTracker } from "../ProgressTracker.js";

test("test timing and temporary paths cannot defeat unchanged failure tracking", () => {
  const tracker = new ProgressTracker();
  for (let i = 1; i <= 7; i++) assert.equal(tracker.observe({ tool: "run_shell", args: { command: "node", args: ["--test"] }, ok: false,
    hashes: { "test.mjs": "abc" }, output: `duration ${i}ms; /tmp/random-${i}/test.mjs failed`, errorCode: "tool_execution_failed" }), i);
  assert.equal(tracker.observe({ tool: "run_shell", args: { command: "node", args: ["--test"] }, ok: false,
    hashes: { "test.mjs": "fixed" }, output: "failed", errorCode: "tool_execution_failed" }), 1);
});

test("read repetitions track actual content, input hashes and task attempts", () => {
  const tracker = new ProgressTracker();
  const input = { tool: "read_file", args: { path: "a.txt" }, ok: true, hashes: { "a.txt": "one" }, output: "one", task: { id: "T1", attemptId: "A1" } };
  assert.equal(tracker.observe(input), 1); assert.equal(tracker.observe(input), 2);
  assert.equal(tracker.observe({ ...input, output: "user edited content" }), 1);
  assert.equal(tracker.observe({ ...input, task: { id: "T1", attemptId: "A2" } }), 1);
  assert.equal(tracker.observe({ ...input, hashes: { "a.txt": "two" } }), 1);
  assert.equal(tracker.observe({ ...input, tool: "work_status" }), 0);
  assert.equal(tracker.observe(input), 3);
  tracker.clear(); assert.equal(tracker.observe(input), 1);
});

test("remote polling and successful tests are not treated as stalled local reads", () => {
  const tracker = new ProgressTracker();
  for (const tool of ["media_status", "work_status", "run_shell"]) for (let i = 0; i < 10; i++) {
    assert.equal(tracker.observe({ tool, args: {}, ok: true, hashes: {}, output: "pending" }), 0);
  }
});
