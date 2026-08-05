import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFinalizerMode,
  formatArtifactAnswer,
  formatDeterministicAnswer,
} from "../Finalizer.js";
import type {
  CodaliContextPack,
  CodaliEvidenceItem,
  CodaliGatewayRequest,
} from "../CodaliGatewayTypes.js";

const evidence = (overrides: Partial<CodaliEvidenceItem> = {}): CodaliEvidenceItem =>
  ({
    id: "ev-1",
    runId: "run-1",
    claim: "France's 2025 GDP was about 3.1 trillion USD.",
    sourceType: "web",
    sourceId: "worldbank",
    sourceTitle: "World Bank",
    confidence: 0.92,
    relevance: 0.9,
    freshness: "fresh",
    ...overrides,
  }) as CodaliEvidenceItem;

const contextPack = (
  overrides: Partial<CodaliContextPack> = {},
): CodaliContextPack =>
  ({
    id: "pack-1",
    runId: "run-1",
    originalQuery: "What was France's GDP in 2025?",
    decisionFacts: [evidence()],
    selectedExcerpts: [],
    contradictions: [],
    missingInformation: [],
    toolSummary: [],
    tokenEstimate: 100,
    ...overrides,
  }) as CodaliContextPack;

const request = (overrides: Partial<CodaliGatewayRequest> = {}): CodaliGatewayRequest =>
  ({
    query: "What was France's GDP in 2025?",
    policy: { allowedTools: [] },
    ...overrides,
  }) as CodaliGatewayRequest;

test("a direct lookup with a single high-confidence fact skips the large model", () => {
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack(),
    artifacts: [],
    directLookup: true,
  });
  assert.equal(decision.mode, "deterministic");
});

test("without the router's direct-lookup signal, one good fact still synthesizes", () => {
  // A single solid fact is not grounds to skip reasoning: "why is X failing?"
  // can rest on one fact and still need the synthesizer.
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack(),
    artifacts: [],
  });
  assert.equal(decision.mode, "synthesizer");
  assert.equal(decision.reason, "not a direct lookup");
});

test("multiple facts require the synthesizer", () => {
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack({
      decisionFacts: [evidence(), evidence({ id: "ev-2" })],
    }),
    artifacts: [],
    directLookup: true,
  });
  assert.equal(decision.mode, "synthesizer");
});

test("contradictory evidence requires the synthesizer even with one fact", () => {
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack({
      contradictions: [{ summary: "conflicting", evidenceIds: ["ev-1", "ev-2"] }],
    }),
    artifacts: [],
    directLookup: true,
  });
  assert.equal(decision.mode, "synthesizer");
  assert.equal(decision.reason, "contradictory evidence");
});

test("known missing information requires the synthesizer so uncertainty is stated", () => {
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack({ missingInformation: ["Q4 figures unavailable"] }),
    artifacts: [],
    directLookup: true,
  });
  assert.equal(decision.mode, "synthesizer");
});

test("a low-confidence fact is not finished deterministically", () => {
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack({ decisionFacts: [evidence({ confidence: 0.4 })] }),
    artifacts: [],
    directLookup: true,
  });
  assert.equal(decision.mode, "synthesizer");
});

test("a caller-supplied response schema always forces the synthesizer", () => {
  const decision = decideFinalizerMode({
    request: request({ response: { schema: { type: "object" } } }),
    contextPack: contextPack(),
    artifacts: [],
    directLookup: true,
  });
  assert.equal(decision.mode, "synthesizer");
  assert.equal(decision.reason, "caller supplied a response schema");
});

test("artifacts take precedence and select the artifact formatter", () => {
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack(),
    artifacts: [{ id: "art-1", type: "image", path: "/tmp/puppy.png" }],
  });
  assert.equal(decision.mode, "artifact");
});

test("no evidence at all requires the synthesizer, never a blank deterministic answer", () => {
  const decision = decideFinalizerMode({
    request: request(),
    contextPack: contextPack({ decisionFacts: [] }),
    artifacts: [],
    directLookup: true,
  });
  assert.equal(decision.mode, "synthesizer");
  assert.equal(decision.reason, "no decision facts");
});

test("the deterministic formatter attributes its claim to a source", () => {
  const answer = formatDeterministicAnswer(contextPack());
  assert.match(answer, /3\.1 trillion/);
  assert.match(answer, /Source: World Bank \[ev-1\]/);
});

test("the artifact formatter reports where the artifact landed", () => {
  const answer = formatArtifactAnswer([
    { id: "art-1", type: "image", path: "/tmp/puppy.png" },
  ]);
  assert.match(answer, /Generated artifact:/);
  assert.match(answer, /- image: \/tmp\/puppy\.png/);
});
