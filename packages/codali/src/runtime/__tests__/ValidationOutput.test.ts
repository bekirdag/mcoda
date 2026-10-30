import test from "node:test";
import assert from "node:assert/strict";
import { validationOutputExcerpt } from "../ValidationOutput.js";

test("short validation output remains exact and invalid bounds fail", () => {
  assert.equal(validationOutputExcerpt("not ok 1 - broken\n"), "not ok 1 - broken\n");
  for (const bound of [0, 599, 8001, NaN, Infinity, 700.5]) assert.throws(() => validationOutputExcerpt("", bound), /bound/);
});

for (const failure of [
  "not ok 11 - rejects C1 controls\n  error: 'Missing expected exception'\n  actual: C1-control\n",
  "=================== FAILURES ===================\nAssertionError: expected rollback\n",
  "FAILED test_accounting.py::test_settlement - AssertionError: count was refunded\n",
  "src/task.ts(14,3): error TS2345: Type 'string' is not assignable\n",
  "error[E0308]: mismatched types\n --> src/main.rs:3:4\n",
  "thread 'worker' panicked at src/main.rs:5: expected fencing\n",
]) test(`validation context retains late failure: ${failure.split("\n")[0]}`, () => {
  const start = "Validation command\n"; const tail = "\n# tests 100\n# pass 99\n# fail 1\n";
  const output = start + "ok - successful earlier check\n".repeat(500) + failure + "  later detail\n".repeat(300) + tail;
  for (const maximum of [600, 900, 2400, 8000]) {
    const excerpt = validationOutputExcerpt(output, maximum);
    assert.ok(excerpt.length <= maximum); assert.ok(excerpt.startsWith(start)); assert.ok(excerpt.endsWith(tail));
    assert.ok(excerpt.includes(failure)); assert.match(excerpt, /output omitted from this excerpt/);
  }
});

test("failure at either edge is not removed by overlap handling", () => {
  for (const position of [0, 1, 179, 181, 1200, 2900]) {
    const failure = "\nnot ok 7 - preserve this failure\n";
    const output = "x".repeat(position) + failure + "y".repeat(3000 - position);
    const excerpt = validationOutputExcerpt(output, 600);
    assert.ok(excerpt.length <= 600); assert.ok(excerpt.includes("not ok 7 - preserve this failure"));
  }
});

test("unrecognized formats retain both ends without claiming success", () => {
  const output = "Command header\n" + "unclassified output\n".repeat(500) + "result unavailable\n";
  const excerpt = validationOutputExcerpt(output, 900);
  assert.equal(excerpt.length, 900); assert.ok(excerpt.startsWith("Command header")); assert.ok(excerpt.endsWith("result unavailable\n"));
});

test("color escapes do not hide a late failure heading", () => {
  const output = "ok - earlier\n".repeat(700) + "\u001b[31mnot ok 7 - actual failure\u001b[0m\n" + "detail\n".repeat(700) + "# fail 1\n";
  const excerpt = validationOutputExcerpt(output, 900);
  assert.ok(excerpt.includes("not ok 7 - actual failure")); assert.ok(excerpt.endsWith("# fail 1\n")); assert.ok(excerpt.length <= 900);
});
