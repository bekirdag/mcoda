import test from "node:test";
import assert from "node:assert/strict";
import { automaticVerificationReceipts } from "../VerificationReceiptSelection.js";

const check = (id: string, cwd: string, extra = {}) => ({ id, taskId: "T1", attemptId: "A1", tool: "run_shell", status: "success", args: { command: "node", args: ["--test", "check.test.mjs"], cwd }, inputHashes: { "value.mjs": "current" }, ...extra });
const select = (receipts: ReturnType<typeof check>[]) => automaticVerificationReceipts(receipts, "T1", "A1").map(receipt => receipt.id);

test("automatic evidence is bounded, distinct, and tied to the current attempt and snapshot", () => {
  const receipts = [check("old-a", "a"), check("other-task", "b", { taskId: "T2" }), check("old-attempt", "c", { attemptId: "A0" }),
    check("stale", "stale", { inputHashes: { "value.mjs": "old" } }), check("a", "a"), check("b", "b"), check("c", "c")];
  assert.deepEqual(select(receipts), ["c", "b", "a"]);
  assert.deepEqual(select(Array.from({ length: 12 }, (_, i) => check(String(i), String(i)))), ["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"]);
  assert.deepEqual(select([check("read", "a", { tool: "read_file" })]), []);
  assert.deepEqual(select([check("not-check", "a", { args: { command: "node", args: ["--version"], cwd: "." } })]), []);
});

test("a newer failed command never uncovers its older passing receipt", () => {
  assert.throws(() => select([check("passed", "a"), check("failed", "a", { status: "failed" })]), /latest check.*did not succeed/);
  assert.deepEqual(select([check("passed", "a"), check("failed", "a", { status: "failed" }), check("other", "b")]), ["other"]);
  assert.deepEqual(select([check("failed", "a", { status: "failed" }), check("repaired", "a")]), ["repaired"]);
});

test("equivalent snapshot key order and default cwd do not duplicate evidence", () => {
  assert.deepEqual(select([
    check("old", ".", { args: { command: "node", args: ["--test", "check.test.mjs"] }, inputHashes: { b: "2", a: "1" } }),
    check("new", ".", { inputHashes: { a: "1", b: "2" } }),
    check("other", "module", { inputHashes: { b: "2", a: "1" } }),
  ]), ["other", "new"]);
});
