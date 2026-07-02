import test from "node:test";
import assert from "node:assert/strict";
import { CodaliGateway } from "../CodaliGateway.js";
import {
  CODALI_GATEWAY_REPLAY_FIXTURE_SCHEMA_VERSION,
  CODALI_GATEWAY_TRACE_EVENT_NAMES,
  CODALI_GATEWAY_TRACE_SCHEMA_VERSION,
  exportCodaliGatewayReplayFixture,
  readCodaliGatewayTrace,
} from "../GatewayTraceReplay.js";
import { createInMemoryCodaliGatewayStore } from "../CodaliGatewayStore.js";
import type { Provider } from "../../providers/ProviderTypes.js";
import type { CodaliContextPack, CodaliEvidenceItem } from "../CodaliGatewayTypes.js";

const createProvider = (): Provider => ({
  name: "test-provider",
  async generate() {
    return {
      message: {
        role: "assistant",
        content: "",
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      raw: {},
    };
  },
});

const seedTraceStore = async () => {
  const store = createInMemoryCodaliGatewayStore();
  const run = await store.createRun({
    runId: "run-trace-1",
    request: {
      id: "run-trace-1",
      query: "Which tenant policy applies?",
      mode: "accurate",
      product: { name: "OKACAM AI Chat", version: "1.0" },
      tenant: { id: "tenant-1", slug: "tenant-one" },
      conversation: { id: "conversation-1" },
      policy: {
        allowedTools: ["docdex_search", "docdex_open"],
        maxIterations: 2,
        maxRuntimeMs: 30_000,
        maxToolCalls: 4,
        maxModelCalls: 4,
        maxEvidenceItems: 8,
        maxContextPackTokens: 2_000,
        allowWrites: false,
        allowShell: false,
        allowDestructiveOperations: false,
        allowOutsideWorkspace: false,
        requireFinalLargeModel: true,
      },
      metadata: {
        headers: {
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
        },
        appToolGatewaySecret: "gateway-secret",
      },
    },
    status: "running",
    metadata: {
      mode: "accurate",
      product: "OKACAM AI Chat",
    },
  });

  const task = await store.createTask({
    id: "task-1",
    runId: run.runId,
    status: "running",
    workerRole: "retrieval_worker",
    objective: "Find tenant policy evidence",
  });
  await store.updateTask(run.runId, task.id, { status: "succeeded" });

  const evidence: CodaliEvidenceItem = {
    id: "ev-1",
    runId: run.runId,
    taskId: task.id,
    claim: "Tenant policy A applies.",
    sourceType: "docdex",
    sourceId: "doc-1",
    sourceUri: "repo://docs/policy.md",
    confidence: 0.92,
    relevance: 0.88,
    tenantScoped: true,
    usedTool: "docdex_search",
  };
  await store.appendEvidence(run.runId, [evidence]);

  await store.appendToolCall({
    id: "tool-success",
    runId: run.runId,
    taskId: task.id,
    tool: "docdex_search",
    status: "success",
    args: {
      query: "tenant policy",
      apiKey: "sk-should-redact-1234567890",
    },
    result: {
      hits: 1,
      text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    },
    latencyMs: 12,
  });
  await store.appendToolCall({
    id: "tool-failed",
    runId: run.runId,
    taskId: task.id,
    tool: "docdex_open",
    status: "failed",
    args: { path: "docs/missing.md" },
    errorCode: "not_found",
    errorMessage: "Missing doc",
    latencyMs: 4,
  });

  await store.appendModelCall({
    id: "model-classifier",
    runId: run.runId,
    role: "classifier",
    status: "success",
    agentSlug: "small-local",
    model: "phi3.5",
    provider: "ollama",
    input: { apiKey: "model-secret" },
    output: { answerability: "repo_grounded" },
    latencyMs: 20,
  });
  await store.appendModelCall({
    id: "model-planner",
    runId: run.runId,
    role: "planner",
    status: "success",
    agentSlug: "medium-local",
    model: "llama3.1",
    provider: "ollama",
    output: { workerTasks: [{ id: task.id }] },
    latencyMs: 30,
  });
  await store.appendModelCall({
    id: "model-final",
    runId: run.runId,
    role: "final_synthesizer",
    status: "success",
    agentSlug: "large-local",
    model: "qwen3",
    provider: "ollama",
    output: "Tenant policy A applies.",
    latencyMs: 40,
  });

  const contextPack: CodaliContextPack = {
    id: "pack-1",
    runId: run.runId,
    originalQuery: "Which tenant policy applies?",
    decisionFacts: [evidence],
    contradictions: [],
    missingInformation: [],
    selectedExcerpts: [{ evidenceId: evidence.id, text: "Tenant policy A applies." }],
    toolSummary: [{ tool: "docdex_search", calls: 1, statuses: { success: 1 } }],
    tokenEstimate: 256,
  };
  await store.saveContextPack(run.runId, contextPack);
  await store.saveArtifact({
    id: "artifact-1",
    runId: run.runId,
    taskId: task.id,
    type: "debug_summary",
    path: "artifacts/run-trace-1/summary.json",
    metadata: { token: "artifact-secret" },
  });

  await store.updateRun(run.runId, {
    status: "succeeded",
    warnings: ["one source was unavailable"],
    metadata: {
      finalSynthesis: {
        status: "success",
        token: "final-secret",
      },
    },
  });

  return { store, runId: run.runId };
};

test("gateway trace read API returns redacted diagnosis details", async () => {
  const { store, runId } = await seedTraceStore();

  const trace = await readCodaliGatewayTrace({ store, runId });

  assert.ok(trace);
  assert.equal(trace.schemaVersion, CODALI_GATEWAY_TRACE_SCHEMA_VERSION);
  assert.equal(trace.finalAnswer, "Tenant policy A applies.");
  assert.equal(trace.debugSummary.product, "OKACAM AI Chat");
  assert.equal(trace.debugSummary.tenantId, "tenant-1");
  assert.equal(trace.debugSummary.conversationId, "conversation-1");
  assert.equal(trace.debugSummary.taskCount, 1);
  assert.equal(trace.debugSummary.evidenceCount, 1);
  assert.equal(trace.debugSummary.toolCallCount, 2);
  assert.equal(trace.debugSummary.modelCallCount, 3);
  assert.equal(trace.debugSummary.artifactCount, 1);
  assert.deepEqual(trace.debugSummary.calledTools, ["docdex_search", "docdex_open"]);
  assert.deepEqual(trace.debugSummary.failedTools, ["docdex_open"]);
  assert.equal(trace.debugSummary.finalModel?.role, "final_synthesizer");

  const request = trace.run.request as Record<string, unknown>;
  const metadata = request.metadata as Record<string, unknown>;
  const headers = metadata.headers as Record<string, unknown>;
  assert.equal(headers.authorization, "[redacted]");
  assert.equal(metadata.appToolGatewaySecret, "[redacted]");
  assert.equal((trace.toolCalls[0]?.args as Record<string, unknown>).apiKey, "[redacted]");
  assert.equal((trace.artifacts[0]?.metadata as Record<string, unknown>).token, "[redacted]");

  const eventKinds = trace.events.map((item) => item.kind);
  assert.ok(eventKinds.includes(CODALI_GATEWAY_TRACE_EVENT_NAMES.RUN_CREATED));
  assert.ok(eventKinds.includes(CODALI_GATEWAY_TRACE_EVENT_NAMES.TOOL_CALL));
  assert.ok(eventKinds.includes(CODALI_GATEWAY_TRACE_EVENT_NAMES.MODEL_CALL));
  assert.ok(eventKinds.includes(CODALI_GATEWAY_TRACE_EVENT_NAMES.FINAL_SYNTHESIS));
  assert.equal(
    trace.events.some((item) => JSON.stringify(item).includes("final-secret")),
    false,
  );
});

test("gateway replay export freezes redacted fixtures and optional model outputs", async () => {
  const { store, runId } = await seedTraceStore();

  const fixture = await exportCodaliGatewayReplayFixture({
    store,
    runId,
    options: {
      fixtureId: "fixture-1",
      includeModelInputs: true,
      includeModelOutputs: true,
    },
  });

  assert.ok(fixture);
  assert.equal(fixture.schemaVersion, CODALI_GATEWAY_REPLAY_FIXTURE_SCHEMA_VERSION);
  assert.equal(fixture.fixtureId, "fixture-1");
  assert.deepEqual(fixture.planner.classifierOutput, { answerability: "repo_grounded" });
  assert.deepEqual(fixture.planner.plannerOutput, { workerTasks: [{ id: "task-1" }] });
  assert.deepEqual(fixture.modelFixtures[0]?.output, { answerability: "repo_grounded" });
  assert.equal(fixture.finalAnswer, "Tenant policy A applies.");
  assert.equal(
    (fixture.modelFixtures[0]?.input as Record<string, unknown>).apiKey,
    "[redacted]",
  );
  assert.equal(
    (fixture.toolFixtures[0]?.args as Record<string, unknown>).apiKey,
    "[redacted]",
  );
  assert.equal(
    (fixture.toolFixtures[0]?.result as Record<string, unknown>).text,
    "Authorization: [redacted]",
  );
  assert.equal(fixture.toolFixtures[1]?.errorCode, "not_found");
  assert.ok(fixture.events.some((item) => item.kind === CODALI_GATEWAY_TRACE_EVENT_NAMES.TOOL_CALL));
});

test("gateway replay export omits model outputs and tool results by default controls", async () => {
  const { store, runId } = await seedTraceStore();

  const fixture = await exportCodaliGatewayReplayFixture({
    store,
    runId,
    options: {
      fixtureId: "fixture-no-output",
      includeToolResults: false,
    },
  });

  assert.ok(fixture);
  assert.equal(fixture.modelFixtures[0]?.output, undefined);
  assert.equal(fixture.finalAnswer, undefined);
  assert.equal(fixture.toolFixtures[0]?.result, undefined);
  assert.equal(fixture.planner.classifierOutput, undefined);
});

test("gateway instance exposes trace and replay helpers", async () => {
  const { store, runId } = await seedTraceStore();
  const gateway = new CodaliGateway({ provider: createProvider(), store });

  const trace = await gateway.readTrace(runId);
  const fixture = await gateway.exportReplayFixture(runId, {
    fixtureId: "fixture-from-gateway",
    includeModelOutputs: true,
  });

  assert.equal(trace?.runId, runId);
  assert.equal(fixture?.fixtureId, "fixture-from-gateway");
  assert.equal(fixture?.finalAnswer, "Tenant policy A applies.");
});
