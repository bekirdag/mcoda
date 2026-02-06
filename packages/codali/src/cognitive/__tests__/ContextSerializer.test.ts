import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeContextBundleForOutput, serializeContext } from "../ContextSerializer.js";
import type { ContextBundle } from "../Types.js";

const baseBundle: ContextBundle = {
  request: "Fix login",
  query_signals: {
    phrases: ["Fix login"],
    file_tokens: ["src/auth.ts"],
    keywords: ["login", "auth"],
    keyword_phrases: ["fix login"],
  },
  request_digest: {
    summary: "Update login/auth behavior in existing source files.",
    refined_query: "login auth source flow",
    confidence: "medium",
    signals: ["login", "auth", "source"],
    candidate_files: ["src/auth.ts"],
  },
  queries: ["login"],
  search_results: [
    { query: "login", hits: [{ path: "src/auth.ts", score: 12 }] },
  ],
  snippets: [],
  symbols: [{ path: "src/auth.ts", summary: "symbol-summary" }],
  ast: [{ path: "src/auth.ts", nodes: ["node"] }],
  impact: [{ file: "src/auth.ts", inbound: [], outbound: ["src/user.ts"] }],
  impact_diagnostics: [],
  dag_summary: "src/auth.ts -> src/user.ts",
  intent: {
    intents: ["ui"],
    matches: {
      ui: ["header"],
      content: [],
      behavior: [],
      data: [],
      testing: [],
      infra: [],
      security: [],
      performance: [],
      observability: [],
    },
  },
  project_info: {
    workspace_root: "/repo",
    manifests: ["package.json"],
    docs: ["docs/rfp.md"],
    file_types: [".ts", ".md"],
  },
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
  assert.ok(serialized.content.includes("INTENT:"));
  assert.ok(serialized.content.includes("PROJECT INFO:"));
  assert.ok(serialized.content.includes("QUERIES:"));
  assert.ok(serialized.content.includes("QUERY SIGNALS:"));
  assert.ok(serialized.content.includes("REQUEST DIGEST:"));
  assert.ok(serialized.content.includes("SEARCH RESULTS:"));
  assert.ok(serialized.content.includes("SYMBOLS:"));
  assert.ok(serialized.content.includes("AST:"));
  assert.ok(serialized.content.includes("IMPACT GRAPH:"));
  assert.ok(serialized.content.includes("DAG REASONING:"));
  assert.ok(serialized.content.includes("INDEX INFO:"));
  assert.ok(serialized.content.includes("Fix login"));
});

test("ContextSerializer outputs json when requested", { concurrency: false }, () => {
  const serialized = serializeContext(baseBundle, { mode: "json" });
  const parsed = JSON.parse(serialized.content);
  assert.equal(parsed.request, "Fix login");
});

test("ContextSerializer includes missing data section when provided", { concurrency: false }, () => {
  const serialized = serializeContext(
    { ...baseBundle, files: [], missing: ["no_context_files_loaded"] },
    { mode: "bundle_text" },
  );
  assert.ok(serialized.content.includes("MISSING DATA:"));
  assert.ok(serialized.content.includes("no_context_files_loaded"));
});

test("ContextSerializer sanitizes policy fields for librarian output", { concurrency: false }, () => {
  const bundle = {
    ...baseBundle,
    warnings: [
      ...baseBundle.warnings,
      "write_policy_blocks_focus",
      "write_policy_blocks_focus:src/auth.ts",
    ],
  };
  const sanitized = sanitizeContextBundleForOutput(bundle);
  assert.equal(sanitized.allow_write_paths, undefined);
  assert.equal(sanitized.read_only_paths, undefined);
  assert.ok(!sanitized.warnings.some((warning) => warning.startsWith("write_policy_")));
  assert.ok(sanitized.warnings.includes("docdex_low_confidence"));
});

test("ContextSerializer emits compact and full repo map sections when both are present", { concurrency: false }, () => {
  const serialized = serializeContext(
    {
      ...baseBundle,
      repo_map: "repo\n└── src",
      repo_map_raw: "repo\n├── docs\n└── src\n    └── index.html",
    },
    { mode: "bundle_text" },
  );
  assert.ok(serialized.content.includes("REPO MAP (COMPACT VIEW):"));
  assert.ok(serialized.content.includes("REPO MAP (FULL):"));
  assert.ok(serialized.content.includes("└── index.html"));
});

test("ContextSerializer caps large sections deterministically", { concurrency: false }, () => {
  const oversized = "x".repeat(10_000);
  const bundle: ContextBundle = {
    ...baseBundle,
    snippets: Array.from({ length: 8 }).map((_, index) => ({
      doc_id: `doc-${index}`,
      path: `src/file-${index}.ts`,
      content: oversized,
    })),
    symbols: Array.from({ length: 8 }).map((_, index) => ({
      path: `src/symbol-${index}.ts`,
      summary: oversized,
    })),
    ast: Array.from({ length: 6 }).map((_, index) => ({
      path: `src/ast-${index}.ts`,
      nodes: Array.from({ length: 120 }).map((__, nodeIndex) => ({ id: nodeIndex, kind: "node" })),
    })),
    memory: Array.from({ length: 10 }).map((_, index) => ({
      text: `memory-${index} ${oversized}`,
      source: "repo",
    })),
    profile: Array.from({ length: 10 }).map((_, index) => ({
      content: `profile-${index} ${oversized}`,
      source: "agent",
    })),
  };
  const serialized = serializeContext(bundle, { mode: "bundle_text" });
  assert.ok(serialized.content.includes("Snippet entries truncated"));
  assert.ok(serialized.content.includes("Symbol entries truncated"));
  assert.ok(serialized.content.includes("AST entries truncated"));
  assert.ok(serialized.content.includes("additional memory entries omitted"));
  assert.ok(serialized.content.includes("additional profile entries omitted"));
});
