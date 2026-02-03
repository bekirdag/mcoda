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

test("ContextSelector prioritizes markup files for UI intent", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "src/server.ts" }, { path: "src/public/index.html" }],
      impact: [],
      intent: {
        intents: ["ui"],
        matches: { ui: [], content: [], behavior: [], data: [] },
      },
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/public/index.html"]);
});

test("ContextSelector avoids doc-only focus for non-doc tasks", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "docs/rfp.md" }, { path: "src/app.ts" }],
      impact: [],
      docTask: false,
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/app.ts"]);
});

test("ContextSelector allows doc focus for doc tasks", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "docs/rfp.md" }, { path: "src/app.ts" }],
      impact: [],
      docTask: true,
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["docs/rfp.md"]);
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

test("ContextSelector downranks docs for non-doc requests", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "docs/rfp.md", score: 99 },
        { path: "src/public/index.html", score: 1 },
      ],
      impact: [],
      intent: {
        intents: ["ui"],
        matches: { ui: ["header"], content: [], behavior: [], data: [] },
      },
      docTask: false,
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/public/index.html"]);
});

test("ContextSelector keeps periphery docs bounded for non-doc tasks", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "src/public/index.html", score: 3 },
        { path: "src/public/style.css", score: 2 },
        { path: "docs/rfp.md", score: 30 },
        { path: "docs/sds/app.md", score: 29 },
      ],
      impact: [],
      intent: {
        intents: ["ui"],
        matches: { ui: ["page"], content: [], behavior: [], data: [] },
      },
      docTask: false,
    },
    { maxFiles: 4, focusCount: 2 },
  );

  const docPeriphery = selection.periphery.filter((entry) => entry.startsWith("docs/"));
  assert.equal(docPeriphery.length, 0);
});

test("ContextSelector excludes test files from periphery for ui-only tasks", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "src/public/index.html", score: 3 },
        { path: "src/public/style.css", score: 2 },
        { path: "tests/footer.test.js", score: 20 },
      ],
      impact: [],
      intent: {
        intents: ["ui"],
        matches: { ui: ["header"], content: [], behavior: [], data: [] },
      },
      docTask: false,
    },
    { maxFiles: 4, focusCount: 2 },
  );

  assert.ok(!selection.periphery.includes("tests/footer.test.js"));
});
