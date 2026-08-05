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
    // A successful tool call is what lets worker claims keep their provenance;
    // without one they are treated as the model's own words.
    toolCalls: [{ tool: "docdex_search", status: "success", result: {} }],
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


test("a worker that retrieved nothing cannot claim a source", () => {
  // Observed with qwen3.6: zero tool calls, yet the model emitted a sourceId
  // for a file it invented. That fabricated path became a citable source and
  // the final answer stated it confidently.
  const result = normalizeCodaliEvidence({
    runId: "run-fab",
    taskId: "task-fab",
    defaultTenantScoped: true,
    toolCalls: [],
    workerOutput: {
      evidence: [
        {
          claim: "CodaliGatewayPlanner is defined in src/planner/CodaliGatewayPlanner.py",
          sourceType: "docdex",
          sourceId: "src/planner/CodaliGatewayPlanner.py",
          confidence: 0.95,
        },
      ],
    },
  });

  const evidence = result.evidence[0];
  assert.equal(evidence?.sourceType, "model_observation");
  assert.ok((evidence?.confidence ?? 1) <= 0.25, "an unretrieved claim must not read as confident");
});

test("a failed tool call does not launder a claim into a source", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-fail",
    taskId: "task-fail",
    defaultTenantScoped: true,
    toolCalls: [{ tool: "docdex_search", status: "failed", result: {} }],
    workerOutput: {
      evidence: [
        { claim: "Something was found.", sourceType: "docdex", sourceId: "doc-1", confidence: 0.9 },
      ],
    },
  });

  assert.equal(result.evidence[0]?.sourceType, "model_observation");
});

test("each record in a connector list becomes its own evidence item", () => {
  // Connector results are lists of domain records, none of which name a field
  // "claim". Before this they collapsed into one placeholder — "Tool … returned
  // structured data" — and the synthesizer never saw the underlying items.
  const commits = Array.from({ length: 12 }, (_, i) => ({
    sha: `sha${i}`,
    commit: { message: `Commit ${i} does a thing`, author: { name: "Bekir", date: "2026-08-01T00:00:00Z" } },
  }));

  const result = normalizeCodaliEvidence({
    runId: "run-list",
    taskId: "task-list",
    defaultTenantScoped: true,
    maxEvidenceItems: 40,
    toolCalls: [{ tool: "mcp:github:list_commits", status: "success", result: commits }],
  });

  assert.equal(result.evidence.length, 12);
  assert.ok(result.evidence.every((item) => /Commit \d+ does a thing/.test(item.claim)));
});

test("the describer works across connector shapes, not just one", () => {
  const shapes: Array<[string, unknown]> = [
    ["jira", [{ key: "ENG-1", fields: { summary: "Ticket summary", updated: "2026-08-01T00:00:00Z" } }]],
    ["graph mail", [{ id: "m1", subject: "Email subject", receivedDateTime: "2026-08-01T00:00:00Z" }]],
    ["teams chat", [{ id: "c1", topic: "Chat topic", lastUpdatedDateTime: "2026-08-01T00:00:00Z" }]],
  ];

  for (const [label, payload] of shapes) {
    const result = normalizeCodaliEvidence({
      runId: "run-shape",
      taskId: "task-shape",
      defaultTenantScoped: true,
      toolCalls: [{ tool: "x", status: "success", result: payload }],
    });
    assert.equal(result.evidence.length, 1, `${label} produced no evidence`);
    assert.ok(result.evidence[0]!.claim.length > 0, `${label} produced an empty claim`);
  }
});

test("an unrecognized record shape yields nothing rather than a guess", () => {
  const result = normalizeCodaliEvidence({
    runId: "run-odd",
    taskId: "task-odd",
    defaultTenantScoped: true,
    toolCalls: [{ tool: "x", status: "success", result: [{ a: 1, b: 2 }, { a: 3, b: 4 }] }],
  });
  // A placeholder is acceptable; inventing a claim from numeric fields is not.
  assert.ok(result.evidence.every((item) => !/^\d+$/.test(item.claim)));
});
