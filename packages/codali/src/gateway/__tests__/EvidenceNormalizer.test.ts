import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodaliEvidence } from "../EvidenceNormalizer.js";

test("normalizer converts Docdex search hits into cited evidence", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-docdex",
    taskId: "task-docdex",
    originalQuery: "Where is the gateway policy?",
    defaultTenantScoped: true,
    toolCalls: [
      {
        tool: "docdex_search",
        status: "success",
        args: { query: "gateway policy" },
        result: {
          results: [
            {
              doc_id: "doc-123",
              rel_path: "packages/codali/src/gateway/GatewayPolicyCompiler.ts",
              title: "GatewayPolicyCompiler.ts",
              snippet: "Gateway policies must disable writes and shell access.",
              score: 0.82,
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.evidence.length, 1);
  const evidence = result.evidence[0];
  assert.equal(evidence?.sourceType, "docdex");
  assert.equal(evidence?.sourceId, "doc-123");
  assert.equal(evidence?.sourceTitle, "GatewayPolicyCompiler.ts");
  assert.equal(evidence?.rawExcerpt, "Gateway policies must disable writes and shell access.");
  assert.equal(evidence?.usedTool, "docdex_search");
  assert.equal(evidence?.tenantScoped, true);
  assert.ok((evidence?.relevance ?? 0) >= 0.82);
  assert.match(evidence?.metadata?.path as string, /GatewayPolicyCompiler/);
});

test("normalizer propagates encrypted Docdex request ids from result metadata", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-encrypted-docdex",
    taskId: "task-encrypted-docdex",
    originalQuery: "What policy applies?",
    defaultTenantScoped: true,
    toolCalls: [
      {
        tool: "docdex_search",
        status: "success",
        args: { query: "tenant policy" },
        metadata: { docdex_request_id: "worker-tool-req" },
        result: {
          meta: {
            docdex_request_id: "encrypted-search-req",
            docdex_operation: "search",
          },
          results: [
            {
              doc_id: "tenant-doc-1",
              rel_path: "tenant/policies/approval.md",
              snippet: "Manager approval is required for this tenant.",
              score: 0.88,
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.evidence.length, 1);
  const evidence = result.evidence[0];
  assert.equal(evidence?.sourceType, "docdex");
  assert.equal(evidence?.sourceId, "tenant-doc-1");
  assert.equal(evidence?.metadata?.docdex_request_id, "encrypted-search-req");
  assert.equal(evidence?.metadata?.docdex_operation, "search");
});

test("normalizer converts app tool facts into cited evidence with source URLs", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-app",
    taskId: "task-app",
    originalQuery: "Is SmartClick enabled?",
    defaultTenantScoped: true,
    toolCalls: [
      {
        tool: "smartclick_account_lookup",
        status: "success",
        result: {
          facts: [
            {
              claim: "SmartClick CRM is enabled for the tenant.",
              source: {
                id: "crm-tenant-1",
                url: "https://smartclick.example.test/tenant/1",
                title: "SmartClick tenant profile",
                timestamp: "2026-07-02T07:00:00.000Z",
              },
              confidence: 0.91,
              relevance: 0.76,
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.evidence.length, 1);
  const evidence = result.evidence[0];
  assert.equal(evidence?.sourceType, "app_tool");
  assert.equal(evidence?.sourceId, "crm-tenant-1");
  assert.equal(evidence?.sourceUri, "https://smartclick.example.test/tenant/1");
  assert.equal(evidence?.sourceTimestamp, "2026-07-02T07:00:00.000Z");
  assert.equal(evidence?.usedTool, "smartclick_account_lookup");
  assert.equal(evidence?.confidence, 0.91);
});

test("normalizer deduplicates evidence by source and claim fingerprint", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-dup",
    taskId: "task-dup",
    defaultTenantScoped: true,
    workerOutput: {
      evidence: [
        {
          claim: "The tenant policy requires read-only tool access.",
          sourceType: "docdex",
          sourceId: "doc-policy",
          rawExcerpt: "read-only tool access",
          confidence: 0.7,
          relevance: 0.6,
        },
        {
          claim: "The tenant policy requires read-only tool access.",
          sourceType: "docdex",
          sourceId: "doc-policy",
          rawExcerpt: "read-only tool access",
          confidence: 0.9,
          relevance: 0.8,
        },
      ],
    },
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.evidence[0]?.confidence, 0.9);
  assert.equal(result.evidence[0]?.relevance, 0.8);
  assert.equal(result.evidence[0]?.metadata?.duplicateCount, 1);
});

test("malformed worker JSON becomes low-confidence model observation without tenant-scope requirement", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-malformed",
    taskId: "task-malformed",
    workerOutput: "{not valid json",
  });

  assert.equal(result.evidence.length, 1);
  assert.match(result.warnings.join("\n"), /malformed_worker_json/);
  const evidence = result.evidence[0];
  assert.equal(evidence?.sourceType, "model_observation");
  assert.equal(evidence?.tenantScoped, false);
  assert.ok((evidence?.confidence ?? 1) <= 0.25);
});

test("tenant-scope policy rejects evidence without tenant scope", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-scope",
    taskId: "task-scope",
    requireTenantScope: true,
    defaultTenantScoped: false,
    workerOutput: {
      facts: [
        {
          claim: "A tenant setting exists.",
          source: { id: "setting-1", title: "Tenant settings" },
          confidence: 0.8,
        },
      ],
    },
  });

  assert.equal(result.evidence.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.reason, "tenant_scope_required");
});

test("unprovenanced facts are retained only as low-confidence model observations", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-observation",
    taskId: "task-observation",
    workerOutput: {
      facts: ["The tenant may have an unusual policy exception."],
    },
  });

  assert.equal(result.evidence.length, 1);
  const evidence = result.evidence[0];
  assert.equal(evidence?.sourceType, "model_observation");
  assert.equal(evidence?.metadata?.unprovenanced, true);
  assert.ok((evidence?.confidence ?? 1) <= 0.25);
});
