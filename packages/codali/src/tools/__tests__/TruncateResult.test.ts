import assert from "node:assert/strict";
import test from "node:test";
import { truncateToolResult } from "../TruncateResult.js";

const commits = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}`.padEnd(40, "0"),
    message: `Commit number ${i} with a reasonably long message to take up room`,
    author: { name: "Bekir Dag", email: "bekir@example.com" },
    date: "2026-08-01T00:00:00Z",
  }));

const ser = (value: unknown) => JSON.stringify(value, null, 2);

test("a result inside the budget is returned untouched", () => {
  const payload = commits(2);
  const result = truncateToolResult(payload, ser(payload), 100_000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, ser(payload));
});

test("an oversized list stays valid JSON", () => {
  // The whole point: a character cut leaves the model a document ending
  // mid-token, which it cannot read at all.
  const payload = commits(40);
  const result = truncateToolResult(payload, ser(payload), 4_000);

  assert.equal(result.truncated, true);
  const body = result.text.split("[TRUNCATED")[0] as string;
  const parsed = JSON.parse(body);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length > 0 && parsed.length < 40);
});

test("it says how many items were dropped", () => {
  const payload = commits(40);
  const result = truncateToolResult(payload, ser(payload), 4_000);
  assert.equal((result.keptItems ?? 0) + (result.droppedItems ?? 0), 40);
  assert.match(result.text, /showing \d+ of 40 items/);
});

test("the notice tells the model the result is incomplete", () => {
  const payload = commits(40);
  const result = truncateToolResult(payload, ser(payload), 4_000);
  assert.match(result.text, /INCOMPLETE/);
  assert.match(result.text, /do not present it as the full set/i);
});

test("a list wrapped in an envelope is found and trimmed", () => {
  // Connectors rarely put the array at the root: Graph uses `value`, Jira
  // uses `issues`.
  const payload = { "@odata.context": "https://…", value: commits(40) };
  const result = truncateToolResult(payload, ser(payload), 4_000);

  const parsed = JSON.parse(result.text.split("[TRUNCATED")[0] as string);
  assert.ok(Array.isArray(parsed.value));
  assert.ok(parsed.value.length < 40);
  // The envelope survives, so the model still sees the shape it expects.
  assert.equal(parsed["@odata.context"], "https://…");
});

test("the largest array wins when several are present", () => {
  const payload = { warnings: ["a", "b"], issues: commits(30) };
  const result = truncateToolResult(payload, ser(payload), 3_000);
  const parsed = JSON.parse(result.text.split("[TRUNCATED")[0] as string);
  assert.equal(parsed.warnings.length, 2, "the small array is untouched");
  assert.ok(parsed.issues.length < 30);
});

test("prose with no list falls back to a character cut", () => {
  const text = "x".repeat(5_000);
  const result = truncateToolResult(text, text, 1_000);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length < 1_400);
  assert.match(result.text, /more characters were cut/);
});

test("a single oversized item still returns something usable", () => {
  const payload = [{ body: "y".repeat(20_000) }];
  const result = truncateToolResult(payload, ser(payload), 1_000);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length > 0);
});

test("trimming a large list does not take quadratic time", () => {
  // Binary search over prefixes; dropping one item at a time would
  // re-serialize hundreds of times.
  const payload = commits(600);
  const started = Date.now();
  const result = truncateToolResult(payload, ser(payload), 5_000);
  assert.equal(result.truncated, true);
  assert.ok(Date.now() - started < 1_000);
});
