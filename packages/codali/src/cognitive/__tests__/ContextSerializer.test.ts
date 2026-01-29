import test from "node:test";
import assert from "node:assert/strict";
import { serializeContext } from "../ContextSerializer.js";
import type { ContextBundle } from "../Types.js";

const baseBundle: ContextBundle = {
  request: "Fix login",
  queries: [],
  snippets: [],
  symbols: [],
  ast: [],
  impact: [],
  impact_diagnostics: [],
  memory: [],
  preferences_detected: [],
  profile: [],
  index: { last_updated_epoch_ms: 0, num_docs: 0 },
  warnings: ["docdex_low_confidence"],
  files: [
    {
      path: "src/auth.ts",
      role: "focus",
      content: "export const login = () => {};",
      size: 10,
      truncated: false,
      sliceStrategy: "full",
      origin: "fs",
    },
    {
      path: "src/user.ts",
      role: "periphery",
      content: "interface User { id: string }",
      size: 10,
      truncated: false,
      sliceStrategy: "symbols",
      origin: "docdex",
    },
  ],
};

test("ContextSerializer outputs bundle_text with headers", { concurrency: false }, () => {
  const serialized = serializeContext(baseBundle, { mode: "bundle_text" });
  assert.ok(serialized.content.includes("[FOCUS FILE]"));
  assert.ok(serialized.content.includes("[DEPENDENCY]"));
  assert.ok(serialized.content.includes("Fix login"));
});

test("ContextSerializer outputs json when requested", { concurrency: false }, () => {
  const serialized = serializeContext(baseBundle, { mode: "json" });
  const parsed = JSON.parse(serialized.content);
  assert.equal(parsed.request, "Fix login");
});
