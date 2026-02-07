import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEvidenceGate } from "../EvidenceGate.js";

const baseConfig = {
  minSearchHits: 2,
  minOpenOrSnippet: 1,
  minSymbolsOrAst: 1,
  minImpact: 1,
  maxWarnings: 1,
};

const baseEvidence = {
  search_hits: 3,
  snippet_count: 1,
  symbol_files: 1,
  ast_files: 0,
  impact_files: 1,
  impact_edges: 0,
  repo_map: true,
  dag_summary: true,
};

const baseToolUsage = {
  search: 1,
  open_or_snippet: 1,
  symbols_or_ast: 1,
  impact: 1,
  tree: 0,
  dag_export: 0,
};

test("evaluateEvidenceGate passes when thresholds are met", () => {
  const result = evaluateEvidenceGate({
    config: baseConfig,
    evidence: baseEvidence,
    toolUsage: baseToolUsage,
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
  assert.equal(result.score, 1);
  assert.equal(result.threshold, 1);
});

test("evaluateEvidenceGate fails when search hits are below minimum", () => {
  const result = evaluateEvidenceGate({
    config: { ...baseConfig, minSearchHits: 4 },
    evidence: { ...baseEvidence, search_hits: 1 },
    toolUsage: baseToolUsage,
  });

  assert.equal(result.status, "fail");
  assert.ok(result.missing.includes("search_hits"));
  assert.ok(result.score < 1);
});

test("evaluateEvidenceGate fails when warnings exceed max", () => {
  const result = evaluateEvidenceGate({
    config: { ...baseConfig, maxWarnings: 0 },
    evidence: { ...baseEvidence, warnings: ["late_warning"] },
    warnings: ["latency_warning"],
    toolUsage: baseToolUsage,
  });

  assert.equal(result.status, "fail");
  assert.ok(result.missing.includes("warnings"));
  assert.equal(result.observed.warnings, 2);
});

test("evaluateEvidenceGate uses tool usage for open/snippet coverage", () => {
  const result = evaluateEvidenceGate({
    config: { ...baseConfig, minOpenOrSnippet: 2 },
    evidence: { ...baseEvidence, snippet_count: 0 },
    toolUsage: { ...baseToolUsage, open_or_snippet: 2 },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.observed.open_or_snippet, 2);
});
