import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodaliContextPack,
  createCodaliContextPackBuilder,
  estimateCodaliContextPackTokens,
} from "../ContextPackBuilder.js";
import { createInMemoryCodaliGatewayStore } from "../CodaliGatewayStore.js";
import type {
  CodaliEvidenceItem,
  CodaliGatewayPolicy,
  CodaliGatewayRequest,
} from "../CodaliGatewayTypes.js";
import type { CodaliGatewayVerificationLoopResult } from "../GatewayStateMachine.js";

const basePolicy = (
  overrides: Partial<CodaliGatewayPolicy> = {},
): CodaliGatewayPolicy => ({
  allowedTools: ["docdex_search"],
  deniedTools: [],
  maxIterations: 3,
  maxRuntimeMs: 60_000,
  maxToolCalls: 8,
  maxModelCalls: 4,
  maxEvidenceItems: 20,
  maxContextPackTokens: 2_000,
  allowWrites: false,
  allowShell: false,
  allowDestructiveOperations: false,
  allowOutsideWorkspace: false,
  requireFinalLargeModel: true,
  ...overrides,
});

const baseRequest = (
  overrides: Partial<CodaliGatewayRequest> = {},
): CodaliGatewayRequest => ({
  id: "context-pack-run",
  query: "Summarize tenant policy evidence",
  mode: "balanced",
  policy: basePolicy(),
  ...overrides,
});

const evidence = (
  id: string,
  overrides: Partial<CodaliEvidenceItem> = {},
): CodaliEvidenceItem => ({
  id,
  runId: "context-pack-run",
  taskId: "task-1",
  claim: `Claim ${id}`,
  summary: `Summary ${id}`,
  sourceType: "docdex",
  sourceId: `doc-${id}`,
  sourceTitle: `${id}.md`,
  rawExcerpt: `Raw excerpt for ${id}`,
  confidence: 0.8,
  relevance: 0.8,
  freshness: "unknown",
  usedTool: "docdex_search",
  tenantScoped: true,
  ...overrides,
});

const verification = (
  overrides: Partial<CodaliGatewayVerificationLoopResult> = {},
): CodaliGatewayVerificationLoopResult => ({
  passed: false,
  stopReason: "no_useful_followups",
  iterations: [],
  missingInformation: [],
  contradictions: [],
  issues: [],
  followUpTaskCount: 0,
  rejectedFollowUpTasks: [],
  ...overrides,
});

test("context pack ranks evidence, collapses duplicate claims, and keeps source mapping", () => {
  const result = buildCodaliContextPack({
    runId: "context-pack-run",
    originalQuery: "Summarize tenant policy evidence",
    evidence: [
      evidence("weak", {
        claim: "Tenant policy requires approval.",
        sourceType: "model_observation",
        sourceId: undefined,
        confidence: 0.6,
        relevance: 0.45,
        rawExcerpt: "Low confidence model note.",
      }),
      evidence("best", {
        claim: "Tenant policy requires approval.",
        confidence: 0.95,
        relevance: 0.94,
        freshness: "fresh",
        rawExcerpt: "Policy says approval is required before release.",
      }),
      evidence("other", {
        claim: "Tenant policy allows Docdex search.",
        confidence: 0.82,
        relevance: 0.88,
        freshness: "recent",
      }),
    ],
    maxContextPackTokens: 2_000,
  });

  assert.deepEqual(result.selectedEvidenceIds, ["best", "other"]);
  assert.equal(result.contextPack.decisionFacts.length, 2);
  assert.equal(result.contextPack.decisionFacts[0]?.id, "best");
  assert.equal(result.contextPack.decisionFacts[0]?.rawExcerpt, undefined);
  assert.equal(result.contextPack.selectedExcerpts[0]?.evidenceId, "best");
  assert.match(result.contextPack.selectedExcerpts[0]?.text ?? "", /approval is required/);
  assert.deepEqual(
    result.contextPack.decisionFacts[0]?.metadata?.mergedEvidenceIds,
    ["weak"],
  );
  assert.ok(result.droppedEvidenceIds.includes("weak"));
});

test("context pack respects evidence count and token budget with deterministic drops", () => {
  const items = Array.from({ length: 6 }, (_, index) =>
    evidence(`ev-${index}`, {
      claim: `Ranked fact ${index}`,
      confidence: 0.9 - index * 0.03,
      relevance: 0.9 - index * 0.02,
      rawExcerpt: `Detailed excerpt ${index} `.repeat(80),
    }));

  const result = buildCodaliContextPack({
    runId: "context-pack-run",
    originalQuery: "Budgeted context",
    evidence: items,
    maxDecisionFacts: 3,
    maxExcerptChars: 90,
    maxContextPackTokens: 260,
  });

  assert.ok(result.contextPack.decisionFacts.length <= 3);
  assert.ok(result.contextPack.tokenEstimate <= 260);
  assert.ok(estimateCodaliContextPackTokens(result.contextPack) <= 260);
  assert.ok(result.droppedEvidenceIds.length > 0);
  assert.ok(
    result.contextPack.selectedExcerpts.every((excerpt) => excerpt.text.length <= 90),
  );
  assert.deepEqual(
    result.contextPack.decisionFacts.map((item) => item.id),
    result.selectedEvidenceIds,
  );
});

test("context pack summarizes tool calls by tool and status", () => {
  const result = buildCodaliContextPack({
    runId: "context-pack-run",
    originalQuery: "Summarize tools",
    evidence: [evidence("ev-1")],
    toolCalls: [
      {
        id: "tool-1",
        runId: "context-pack-run",
        tool: "docdex_search",
        status: "success",
        startedAt: "2026-07-02T08:00:00.000Z",
      },
      {
        id: "tool-2",
        runId: "context-pack-run",
        tool: "docdex_search",
        status: "failed",
        startedAt: "2026-07-02T08:00:01.000Z",
      },
      {
        id: "tool-3",
        runId: "context-pack-run",
        tool: "app_contract_lookup",
        status: "blocked",
        startedAt: "2026-07-02T08:00:02.000Z",
      },
    ],
  });

  assert.deepEqual(result.contextPack.toolSummary, [
    {
      tool: "app_contract_lookup",
      calls: 1,
      statuses: { blocked: 1 },
    },
    {
      tool: "docdex_search",
      calls: 2,
      statuses: { success: 1, failed: 1 },
    },
  ]);
});

test("context pack preserves verifier gaps and contradictions and persists to store", async () => {
  const store = createInMemoryCodaliGatewayStore();
  const request = baseRequest({
    id: "context-pack-run",
    policy: basePolicy({ maxContextPackTokens: 1_500 }),
  });
  await store.createRun({
    runId: "context-pack-run",
    request,
    status: "running",
    metadata: {
      verification: verification({
        missingInformation: ["Need current Jira status."],
        contradictions: [
          {
            summary: "Two sources disagree on integration availability.",
            evidenceIds: ["ev-docdex", "ev-app"],
          },
        ],
      }),
    },
  });
  await store.appendEvidence("context-pack-run", [
    evidence("ev-docdex", {
      claim: "Docdex search is enabled.",
      confidence: 0.91,
      relevance: 0.92,
    }),
    evidence("ev-app", {
      claim: "App contract reports Jira unavailable.",
      sourceType: "app_tool",
      sourceId: "jira-contract",
      usedTool: "jira_contract_snapshot",
      confidence: 0.86,
      relevance: 0.9,
    }),
  ]);
  await store.appendToolCall({
    id: "tool-1",
    runId: "context-pack-run",
    tool: "docdex_search",
    status: "success",
  });

  const builder = createCodaliContextPackBuilder({ store });
  const result = await builder.buildAndPersist({ runId: "context-pack-run" });
  const trace = await store.readRunTrace("context-pack-run");

  assert.equal(result.contextPack.originalQuery, "Summarize tenant policy evidence");
  assert.deepEqual(result.contextPack.missingInformation, ["Need current Jira status."]);
  assert.equal(
    result.contextPack.contradictions[0]?.summary,
    "Two sources disagree on integration availability.",
  );
  assert.deepEqual(result.contextPack.contradictions[0]?.evidenceIds, [
    "ev-docdex",
    "ev-app",
  ]);
  assert.equal(trace?.contextPack?.id, "context-pack-context-pack-run");
  assert.equal(
    estimateCodaliContextPackTokens(trace?.contextPack ?? result.contextPack),
    result.contextPack.tokenEstimate,
  );
});
