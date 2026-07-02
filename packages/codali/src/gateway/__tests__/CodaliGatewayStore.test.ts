import test from "node:test";
import assert from "node:assert/strict";
import {
  createInMemoryCodaliGatewayStore,
  redactCodaliGatewaySecrets,
} from "../CodaliGatewayStore.js";
import type { CodaliContextPack, CodaliEvidenceItem } from "../CodaliGatewayTypes.js";

test("in-memory gateway store captures run trace records", async () => {
  const store = createInMemoryCodaliGatewayStore();
  const run = await store.createRun({
    runId: "run-1",
    request: {
      query: "Find tenant policy",
      policy: { apiKey: "sk-should-redact-1234567890" },
    } as never,
    status: "running",
  });

  const task = await store.createTask({
    runId: run.runId,
    id: "task-1",
    workerRole: "rag_worker",
    objective: "Find tenant policy evidence",
  });

  await store.updateTask(run.runId, task.id, { status: "succeeded" });

  const evidence: CodaliEvidenceItem = {
    id: "ev-1",
    runId: run.runId,
    taskId: task.id,
    claim: "Tenant policy exists.",
    sourceType: "docdex",
    confidence: 0.9,
    relevance: 0.8,
    tenantScoped: true,
    usedTool: "docdex_search",
  };
  await store.appendEvidence(run.runId, [evidence]);

  await store.appendToolCall({
    id: "tool-1",
    runId: run.runId,
    taskId: task.id,
    tool: "docdex_search",
    status: "success",
    args: { query: "policy", token: "secret-token-value" },
    result: { count: 1 },
  });

  await store.appendModelCall({
    id: "model-1",
    runId: run.runId,
    role: "planner",
    status: "success",
    model: "local-medium",
    output: { workerTasks: 1 },
  });

  const contextPack: CodaliContextPack = {
    id: "pack-1",
    runId: run.runId,
    originalQuery: "Find tenant policy",
    decisionFacts: [evidence],
    contradictions: [],
    missingInformation: [],
    selectedExcerpts: [{ evidenceId: evidence.id, text: "Tenant policy exists." }],
    toolSummary: [{ tool: "docdex_search", calls: 1, statuses: { success: 1 } }],
    tokenEstimate: 128,
  };
  await store.saveContextPack(run.runId, contextPack);

  await store.saveArtifact({
    id: "artifact-1",
    runId: run.runId,
    taskId: task.id,
    type: "image",
    uri: "artifact://image-1",
    prompt: "Tenant policy diagram",
  });

  await store.updateRun(run.runId, { status: "succeeded" });

  const trace = await store.readRunTrace(run.runId);
  assert.equal(trace?.run.status, "succeeded");
  assert.equal(trace?.tasks[0]?.status, "succeeded");
  assert.equal(trace?.evidence[0]?.claim, "Tenant policy exists.");
  assert.equal(trace?.toolCalls[0]?.tool, "docdex_search");
  assert.equal(trace?.modelCalls[0]?.role, "planner");
  assert.equal(trace?.contextPack?.id, "pack-1");
  assert.equal(trace?.contextPack?.tokenEstimate, 128);
  assert.equal(trace?.artifacts[0]?.type, "image");
});

test("gateway store redacts nested secret keys and bearer-like values", async () => {
  const store = createInMemoryCodaliGatewayStore();
  await store.createRun({
    runId: "run-redact",
    request: {
      query: "safe",
      headers: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
      },
      nested: {
        api_key: "sk-thisshouldredact000000000000",
      },
    } as never,
    metadata: {
      credentialSource: "attached_mswarm_api_key",
      safe: "visible",
    },
  });

  await store.appendToolCall({
    runId: "run-redact",
    tool: "docdex_search",
    status: "success",
    args: {
      query: "safe",
      password: "do-not-store",
      text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    },
  });

  const trace = await store.readRunTrace("run-redact");
  assert.ok(trace);
  assert.equal(
    (trace.run.request as Record<string, unknown>)?.headers &&
      ((trace.run.request as Record<string, unknown>).headers as Record<string, unknown>)
        .authorization,
    "[redacted]",
  );
  assert.equal(
    ((trace.run.request as Record<string, unknown>)?.nested as Record<string, unknown>)
      .api_key,
    "[redacted]",
  );
  assert.equal(trace?.run.metadata?.credentialSource, "[redacted]");
  assert.equal(trace?.run.metadata?.safe, "visible");
  assert.equal(
    (trace?.toolCalls[0]?.args as Record<string, unknown>).password,
    "[redacted]",
  );
  assert.equal(
    (trace?.toolCalls[0]?.args as Record<string, unknown>).text,
    "Authorization: [redacted]",
  );
});

test("redaction helper does not mutate caller-owned payloads", () => {
  const payload = {
    token: "secret",
    nested: { safe: "value" },
  };

  const redacted = redactCodaliGatewaySecrets(payload);
  assert.equal(redacted.token, "[redacted]");
  assert.equal(payload.token, "secret");
  assert.equal(redacted.nested.safe, "value");
});
