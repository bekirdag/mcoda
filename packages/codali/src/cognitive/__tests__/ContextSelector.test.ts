import test from "node:test";
import assert from "node:assert/strict";
import { selectContextFiles } from "../ContextSelector.js";

const impact = [
  { file: "src/auth.ts", inbound: ["src/login.ts"], outbound: ["src/user.ts"] },
  { file: "src/login.ts", inbound: [], outbound: [] },
];

test("ContextSelector returns focus and periphery", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "src/auth.ts" }, { path: "src/login.ts" }],
      impact,
    },
    { maxFiles: 4, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/auth.ts"]);
  assert.ok(selection.periphery.includes("src/user.ts"));
  assert.ok(selection.all.includes("src/auth.ts"));
  assert.equal(selection.low_confidence, false);
});

test("ContextSelector flags low confidence when no hits", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [],
      impact: [],
    },
    { maxFiles: 3 },
  );

  assert.equal(selection.low_confidence, true);
  assert.deepEqual(selection.focus, []);
});

test("ContextSelector respects preferred files and min hit count", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "src/legacy.ts" }],
      impact: [],
      preferredFiles: ["src/preferred.ts"],
    },
    { maxFiles: 2, focusCount: 1, minHitCount: 2 },
  );

  assert.deepEqual(selection.focus, ["src/preferred.ts"]);
  assert.equal(selection.low_confidence, false);
});

test("ContextSelector flags low confidence for weak hits", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "src/only.ts" }],
      impact: [],
    },
    { maxFiles: 2, minHitCount: 2 },
  );

  assert.equal(selection.low_confidence, true);
});
