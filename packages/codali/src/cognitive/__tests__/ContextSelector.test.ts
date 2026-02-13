import test from "node:test";
import assert from "node:assert/strict";
import { selectContextFiles } from "../ContextSelector.js";

const impact = [
  { file: "src/auth.ts", inbound: ["src/login.ts"], outbound: ["src/user.ts"] },
  { file: "src/login.ts", inbound: [], outbound: [] },
];

const emptyMatches = {
  ui: [],
  content: [],
  behavior: [],
  data: [],
  testing: [],
  infra: [],
  security: [],
  performance: [],
  observability: [],
};

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
        matches: emptyMatches,
      },
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/public/index.html"]);
});

test("ContextSelector injects UI scaffold coverage from preferred files", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "src/public/app.js", score: 4 }, { path: "tests/all.js", score: 10 }],
      impact: [],
      preferredFiles: ["src/public/index.html", "src/public/style.css"],
      intent: {
        intents: ["ui"],
        matches: { ...emptyMatches, ui: ["page"] },
      },
      docTask: false,
    },
    { maxFiles: 4, focusCount: 2 },
  );

  assert.ok(selection.focus.includes("src/public/index.html"));
  assert.ok(selection.focus.includes("src/public/style.css"));
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
        matches: { ...emptyMatches, ui: ["header"] },
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
        matches: { ...emptyMatches, ui: ["page"] },
      },
      docTask: false,
    },
    { maxFiles: 4, focusCount: 2 },
  );

  const docPeriphery = selection.periphery.filter((entry) => entry.startsWith("docs/"));
  assert.equal(docPeriphery.length, 1);
});

test("ContextSelector can retain a bounded test periphery entry for ui tasks", { concurrency: false }, () => {
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
        matches: { ...emptyMatches, ui: ["header"] },
      },
      docTask: false,
    },
    { maxFiles: 4, focusCount: 2 },
  );

  assert.ok(selection.periphery.includes("tests/footer.test.js"));
});

test("ContextSelector prioritizes test files for testing intent", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [{ path: "src/app.ts", score: 2 }, { path: "tests/app.test.ts", score: 1 }],
      impact: [],
      intent: {
        intents: ["testing"],
        matches: { ...emptyMatches, testing: ["test"] },
      },
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["tests/app.test.ts"]);
});

test("ContextSelector prioritizes infra files for infra intent", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "src/app.ts", score: 2 },
        { path: ".github/workflows/ci.yml", score: 1 },
        { path: "Dockerfile", score: 1 },
      ],
      impact: [],
      intent: {
        intents: ["infra"],
        matches: { ...emptyMatches, infra: ["ci"] },
      },
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, [".github/workflows/ci.yml"]);
});

test("ContextSelector prioritizes security files for security intent", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "src/app.ts", score: 2 },
        { path: "src/security/policy.ts", score: 1 },
      ],
      impact: [],
      intent: {
        intents: ["security"],
        matches: { ...emptyMatches, security: ["policy"] },
      },
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/security/policy.ts"]);
});

test("ContextSelector boosts observability files for observability intent", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "src/server.ts", score: 2 },
        { path: "src/observability/logger.ts", score: 1 },
      ],
      impact: [],
      intent: {
        intents: ["observability"],
        matches: { ...emptyMatches, observability: ["logging"] },
      },
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/observability/logger.ts"]);
});

test("ContextSelector boosts performance files for performance intent", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "src/server.ts", score: 2 },
        { path: "src/perf/cache.ts", score: 1 },
      ],
      impact: [],
      intent: {
        intents: ["performance"],
        matches: { ...emptyMatches, performance: ["cache"] },
      },
    },
    { maxFiles: 2, focusCount: 1 },
  );

  assert.deepEqual(selection.focus, ["src/perf/cache.ts"]);
});

test("ContextSelector supports combined intent coverage", { concurrency: false }, () => {
  const selection = selectContextFiles(
    {
      hits: [
        { path: "src/server.ts", score: 2 },
        { path: "src/security/policy.ts", score: 1 },
        { path: "src/observability/metrics.ts", score: 1 },
      ],
      impact: [],
      intent: {
        intents: ["security", "observability", "behavior"],
        matches: {
          ...emptyMatches,
          security: ["policy"],
          observability: ["metrics"],
          behavior: ["server"],
        },
      },
    },
    { maxFiles: 3, focusCount: 2 },
  );

  assert.ok(selection.all.includes("src/security/policy.ts"));
  assert.ok(selection.all.includes("src/observability/metrics.ts"));
});
