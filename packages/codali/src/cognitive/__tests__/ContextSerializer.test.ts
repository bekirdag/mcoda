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
  allow_write_paths: ["src/auth.ts"],
  read_only_paths: ["docs/sds"],
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
  assert.ok(serialized.content.includes("WRITE POLICY:"));
  assert.ok(serialized.content.includes("Fix login"));
});

test("ContextSerializer shows allow-all when only read-only paths provided", { concurrency: false }, () => {
  const serialized = serializeContext(
    {
      ...baseBundle,
      allow_write_paths: [],
      read_only_paths: ["docs/sds", "docs/rfp"],
    },
    { mode: "bundle_text" },
  );
  assert.ok(serialized.content.includes("Allowed write paths: all (except read-only)"));
  assert.ok(serialized.content.includes("Read-only paths: docs/sds, docs/rfp"));
});

test("ContextSerializer outputs json when requested", { concurrency: false }, () => {
  const serialized = serializeContext(baseBundle, { mode: "json" });
  const parsed = JSON.parse(serialized.content);
  assert.equal(parsed.request, "Fix login");
});
