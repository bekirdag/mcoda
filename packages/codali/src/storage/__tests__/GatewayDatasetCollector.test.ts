import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryCodaliGatewayStore } from "../../gateway/CodaliGatewayStore.js";
import type {
  CodaliContextPack,
  CodaliEvidenceItem,
  CodaliGatewayPolicy,
  CodaliGatewayRequest,
  CodaliGatewayResult,
} from "../../gateway/CodaliGatewayTypes.js";
import {
  createGatewayDatasetCollector,
  createInMemoryGatewayDatasetObjectStore,
} from "../GatewayDatasetStore.js";

const fixedNow = () => new Date("2026-07-03T11:00:00.000Z");

const basePolicy = (
  overrides: Partial<CodaliGatewayPolicy> = {},
): CodaliGatewayPolicy => ({
  allowedTools: ["docdex_search"],
  deniedTools: [],
  maxIterations: 2,
  maxRuntimeMs: 60_000,
  maxToolCalls: 4,
  maxModelCalls: 8,
  maxEvidenceItems: 10,
  maxContextPackTokens: 2_000,
  allowWrites: false,
  allowShell: false,
  allowDestructiveOperations: false,
  allowOutsideWorkspace: false,
  requireFinalLargeModel: true,
  ...overrides,
});

const baseRequest = (): CodaliGatewayRequest => ({
  id: "collector-run",
  query: "Summarize the local-only dataset policy.",
  mode: "balanced",
  product: { name: "product-neutral", version: "local" },
  tenant: { id: "tenant-alpha" },
  conversation: { id: "conversation-alpha" },
  policy: basePolicy(),
});

const evidence = (): CodaliEvidenceItem => ({
  id: "ev-local-only",
  runId: "collector-run",
  claim: "Dataset upload and training are disabled by default.",
  sourceType: "docdex",
  sourceId: "docs/planning/phase-8.md",
  confidence: 0.91,
  relevance: 0.88,
  freshness: "fresh",
  usedTool: "docdex_search",
  tenantScoped: true,
});

const seedTrace = async () => {
  const store = createInMemoryCodaliGatewayStore();
  const request = baseRequest();
  const run = await store.createRun({
    runId: request.id,
    request,
    status: "running",
  });
  await store.appendEvidence(run.runId, [evidence()]);
  await store.appendModelCall({
    id: "model-classifier",
    runId: run.runId,
    role: "classifier",
    status: "repaired",
    input: { prompt: "classify" },
    output: { queryType: "policy", needsFreshData: false },
    metadata: { repairAttempts: 1 },
  });
  await store.appendModelCall({
    id: "model-planner-failed",
    runId: run.runId,
    role: "planner",
    status: "failed",
    input: { prompt: "plan" },
    errorCode: "JSON_SCHEMA_VALIDATION_FAILED",
    errorMessage: "Planner output did not match the schema.",
  });
  await store.appendModelCall({
    id: "model-planner-retry",
    runId: run.runId,
    role: "planner",
    status: "success",
    input: { prompt: "plan again" },
    output: { workerTasks: [] },
  });
  await store.appendModelCall({
    id: "model-final",
    runId: run.runId,
    role: "final_synthesizer",
    status: "success",
    input: { contextPackId: "ctx-collector-run" },
    output: "Dataset upload and training remain disabled by default.",
  });
  await store.updateRun(run.runId, { status: "succeeded" });
  const trace = await store.readRunTrace(run.runId);
  assert.ok(trace);
  return { request, trace };
};

const gatewayResult = (trace: NonNullable<Awaited<ReturnType<typeof seedTrace>>["trace"]>): CodaliGatewayResult => ({
  runId: trace.run.runId,
  status: "succeeded",
  answer: "Dataset upload and training remain disabled by default.",
  sources: [{ evidenceId: "ev-local-only", sourceType: "docdex" }],
  confidence: "high",
  evidence: [evidence()],
  finalModel: { agentSlug: "large-final-agent", tier: "large", model: "large-final-model" },
  trace: {
    runId: trace.run.runId,
    mode: "balanced",
    status: "succeeded",
    iterations: trace.tasks.length,
    toolCallCount: trace.toolCalls.length,
    modelCallCount: trace.modelCalls.length,
    consideredTools: ["docdex_search"],
    calledTools: ["docdex_search"],
    warnings: [],
    errors: [],
    toolCalls: [],
    modelCalls: trace.modelCalls.map((call) => ({
      role: call.role,
      status: call.status === "repaired" ? "success" : call.status,
      agentSlug: call.agentSlug,
      model: call.model,
      provider: call.provider,
      latencyMs: call.latencyMs,
      errorCode: call.errorCode,
    })),
    events: [],
  },
  telemetry: { usage: { totalTokens: 42 } },
});

test("GatewayDatasetCollector builds run, model, schema failure, and gold target records", async () => {
  const { request, trace } = await seedTrace();
  const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
  const collector = createGatewayDatasetCollector();

  const collectInput = await collector.buildCollectInput({
    request,
    result: gatewayResult(trace),
    trace,
    objectStore,
    now: fixedNow,
    goldTargets: [
      {
        id: "accepted-answer",
        kind: "accepted",
        sourceRecordId: "dataset-collector-run",
        target: { answer: "Dataset upload and training remain disabled by default." },
      },
      {
        id: "corrected-planner",
        kind: "corrected",
        failedAttemptModelCallId: "model-planner-failed",
        sourceModelCallId: "model-planner-retry",
        target: { workerTasks: [] },
      },
      {
        id: "reviewed-answer",
        kind: "reviewed",
        reviewerId: "reviewer-1",
        reasons: ["verified against local-only policy"],
        target: { answer: "Reviewed target answer." },
      },
    ],
  });

  const records = collectInput.records;
  const modelRecords = records.filter((record) => record.datasetKind === "model_call");
  const finalRecords = records.filter((record) => record.metadata?.exampleType === "final_answer");
  const evidenceRecords = records.filter((record) => record.metadata?.exampleType === "evidence_item");
  const schemaFailureRecords = records.filter((record) =>
    record.metadata?.exampleType === "schema_failure");
  const goldRecords = records.filter((record) => record.metadata?.exampleType === "gold_target");
  const failedPlannerRecord = modelRecords.find((record) =>
    record.metadata?.modelCallId === "model-planner-failed");
  const retryPlannerRecord = modelRecords.find((record) =>
    record.metadata?.modelCallId === "model-planner-retry");
  const failedPlannerSchemaRecord = schemaFailureRecords.find((record) =>
    record.metadata?.failedAttemptModelCallId === "model-planner-failed");
  const correctedGoldRecord = goldRecords.find((record) =>
    record.metadata?.goldTargetKind === "corrected");

  assert.equal(records.length, 12);
  assert.equal(finalRecords.length, 1);
  assert.equal(evidenceRecords.length, 1);
  assert.equal(modelRecords.length, trace.modelCalls.length);
  assert.equal(schemaFailureRecords.length, 2);
  assert.equal(goldRecords.length, 3);
  assert.ok(failedPlannerRecord);
  assert.ok(retryPlannerRecord);
  assert.equal(
    failedPlannerSchemaRecord?.metadata?.failedAttemptRecordId,
    failedPlannerRecord.recordId,
  );
  assert.equal(
    failedPlannerSchemaRecord?.metadata?.correctedByRecordId,
    retryPlannerRecord.recordId,
  );
  assert.equal(correctedGoldRecord?.metadata?.failedAttemptRecordId, failedPlannerRecord.recordId);
  assert.equal(correctedGoldRecord?.datasetKind, "curated_example");
  assert.equal(goldRecords.every((record) =>
    record.inputRef.deletionGroupId === record.outputRef?.deletionGroupId
    && record.metadata?.deletionGroupId === record.outputRef?.deletionGroupId), true);
  assert.equal(records.every((record) => record.privacy.uploadAllowed === false), true);
  assert.equal(records.every((record) => record.privacy.trainingAllowed === false), true);
  assert.ok(modelRecords.every((record) => record.quality?.labels?.includes("auto:model_call")));
  assert.equal(collectInput.metadata?.collectionMode, "gateway_trace_collector");
});

test("GatewayDatasetCollector can disable trace-derived records when policy does not allow them", async () => {
  const { request, trace } = await seedTrace();
  const collector = createGatewayDatasetCollector();

  const collectInput = await collector.buildCollectInput({
    request,
    result: gatewayResult(trace),
    trace,
    now: fixedNow,
    collectModelCalls: false,
    collectSchemaFailures: false,
    collectGoldTargets: false,
    collectRagRetrievals: false,
    collectToolDecisions: false,
    collectEvidenceItems: false,
    collectContextPacks: false,
    collectFinalAnswers: false,
    collectArtifacts: false,
    collectPolicyEvents: false,
  });

  assert.equal(collectInput.records.length, 1);
  assert.equal(collectInput.records[0]?.metadata?.exampleType, "gateway_run");
});

test("GatewayDatasetRag GatewayDatasetTool GatewayDatasetEvidence GatewayDatasetAnswer captures Phase 9 records safely", async () => {
  const runId = "phase9-run";
  const request: CodaliGatewayRequest = {
    id: runId,
    query: "Summarize policy evidence and artifacts.",
    mode: "balanced",
    product: { name: "product-neutral", version: "local" },
    tenant: { id: "tenant-alpha" },
    policy: basePolicy({
      allowedTools: [
        "docdex_search",
        "docdex_open",
        "app_lookup",
        "create_ticket",
        "shell_exec",
        "delete_record",
      ],
      deniedTools: ["denied_lookup"],
      maxToolCalls: 8,
      maxImageArtifacts: 2,
    }),
  };
  const phase9Evidence: CodaliEvidenceItem = {
    id: "ev-phase9",
    runId,
    taskId: "tool-task",
    claim: "Phase 9 records must remain local-only and object-ref based.",
    sourceType: "docdex",
    sourceId: "docs/planning/phase-9.md",
    sourceTitle: "phase-9.md",
    rawExcerpt: "Do not store app-tool signatures or image bytes.",
    confidence: 0.94,
    relevance: 0.9,
    freshness: "fresh",
    usedTool: "docdex_search",
    tenantScoped: true,
  };
  const contextPack: CodaliContextPack = {
    id: "ctx-phase9",
    runId,
    originalQuery: request.query,
    decisionFacts: [phase9Evidence],
    contradictions: [],
    missingInformation: [],
    selectedExcerpts: [{ evidenceId: phase9Evidence.id, text: "Object refs only." }],
    toolSummary: [
      { tool: "docdex_search", calls: 1, statuses: { success: 1 } },
      { tool: "app_lookup", calls: 1, statuses: { blocked: 1 } },
    ],
    tokenEstimate: 256,
  };
  const store = createInMemoryCodaliGatewayStore();
  await store.createRun({ runId, request, status: "running" });
  await store.createTask({
    id: "tool-task",
    runId,
    status: "succeeded",
    workerRole: "rag_worker",
    objective: "Collect policy evidence.",
    metadata: {
      allowedTools: ["docdex_search", "docdex_open", "app_lookup"],
      removedTools: ["create_ticket", "shell_exec", "delete_record"],
    },
  });
  await store.appendEvidence(runId, [phase9Evidence]);
  await store.appendToolCall({
    id: "tool-docdex-search",
    runId,
    taskId: "tool-task",
    tool: "docdex_search",
    status: "success",
    args: { q: "phase 9 dataset", apiKey: "sk-secret-docdex-key-123456789" },
    result: { hits: [{ path: "docs/planning/phase-9.md", score: 0.9 }] },
  });
  await store.appendToolCall({
    id: "tool-app-tenant-scope",
    runId,
    taskId: "tool-task",
    tool: "app_lookup",
    status: "blocked",
    args: {
      query: "customer status",
      tenant_id: "tenant-override",
      signature: "sha256=app-secret-signature",
      headers: { authorization: "Bearer signed-request-secret-token" },
    },
    errorCode: "GATEWAY_SCOPE_OVERRIDE_BLOCKED",
    errorMessage: "Tenant override blocked.",
  });
  await store.appendToolCall({
    id: "tool-docdex-scope",
    runId,
    taskId: "tool-task",
    tool: "docdex_open",
    status: "blocked",
    args: { repo_id: "other-repo", token: "sk-docdex-scope-secret-123456789" },
    errorCode: "GATEWAY_SCOPE_OVERRIDE_BLOCKED",
    errorMessage: "Docdex scope override blocked.",
  });
  await store.saveContextPack(runId, contextPack);
  await store.saveArtifact({
    id: "artifact-image",
    runId,
    taskId: "tool-task",
    type: "image/png",
    uri: "object://codali/artifacts/artifact-image",
    model: "image-model",
    prompt: "Render a neutral policy chart.",
    metadata: {
      mimeType: "image/png",
      data: "raw-image-bytes",
      base64Data: "base64-image-payload",
      binaryData: "binary-image-payload",
      blobPayload: "blob-image-payload",
      fileContent: "file-image-payload",
      dataUrl: "data:image/png;base64,inline-image-payload",
      payload: { bytes: "nested-raw-image-bytes" },
    },
  });
  await store.updateRun(runId, {
    status: "succeeded",
    warnings: ["worker_task_tools_removed:tool-task:create_ticket,shell_exec,delete_record"],
  });
  const trace = await store.readRunTrace(runId);
  assert.ok(trace);

  const result: CodaliGatewayResult = {
    runId,
    status: "succeeded",
    answer: "Phase 9 collection keeps secrets redacted and image data as object refs.",
    sources: [{ evidenceId: phase9Evidence.id, sourceType: "docdex", title: "phase-9.md" }],
    confidence: "high",
    evidence: [phase9Evidence],
    contextPack,
    finalModel: { agentSlug: "large-final-agent", tier: "large", model: "large-final-model" },
    trace: {
      runId,
      mode: "balanced",
      status: "succeeded",
      iterations: trace.tasks.length,
      toolCallCount: trace.toolCalls.length,
      modelCallCount: trace.modelCalls.length,
      consideredTools: request.policy.allowedTools,
      calledTools: trace.toolCalls.map((call) => call.tool),
      warnings: trace.run.warnings,
      errors: trace.run.errors,
      toolCalls: trace.toolCalls.map((call) => ({
        tool: call.tool,
        status: call.status,
        taskId: call.taskId,
        errorCode: call.errorCode,
        errorMessage: call.errorMessage,
      })),
      modelCalls: [],
      events: [],
    },
    telemetry: { usage: { totalTokens: 128 } },
  };
  const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
  const collector = createGatewayDatasetCollector();

  const collectInput = await collector.buildCollectInput({
    request,
    result,
    trace,
    objectStore,
    now: fixedNow,
  });
  const records = collectInput.records;
  const byExampleType = (exampleType: string) =>
    records.filter((record) => record.metadata?.exampleType === exampleType);
  const policyEventTypes = new Set(
    byExampleType("policy_event").map((record) => record.metadata?.policyEventType),
  );
  const artifactRecord = byExampleType("artifact")[0];
  assert.ok(artifactRecord?.outputRef);
  const artifactPayload = await objectStore.readObject?.(artifactRecord.outputRef);
  const payloads = [];
  for (const ref of objectStore.listObjects()) {
    payloads.push(await objectStore.readObject?.(ref));
  }
  const serializedPayloads = JSON.stringify(payloads);

  assert.equal(byExampleType("rag_retrieval").length, 2);
  assert.equal(byExampleType("tool_decision").length, 6);
  assert.equal(byExampleType("evidence_item").length, 1);
  assert.equal(byExampleType("context_pack").length, 1);
  assert.equal(byExampleType("final_answer").length, 1);
  assert.equal(byExampleType("artifact").length, 1);
  assert.ok(policyEventTypes.has("denied_tool"));
  assert.ok(policyEventTypes.has("write_block"));
  assert.ok(policyEventTypes.has("shell_block"));
  assert.ok(policyEventTypes.has("destructive_block"));
  assert.ok(policyEventTypes.has("tenant_scope_override"));
  assert.ok(policyEventTypes.has("docdex_scope_override"));
  assert.equal(records.every((record) => record.privacy.uploadAllowed === false), true);
  assert.equal(records.every((record) => record.privacy.trainingAllowed === false), true);
  assert.equal(artifactRecord.outputRef.kind, "artifact");
  assert.equal(JSON.stringify(artifactRecord).includes("raw-image-bytes"), false);
  assert.equal(serializedPayloads.includes("app-secret-signature"), false);
  assert.equal(serializedPayloads.includes("signed-request-secret-token"), false);
  assert.equal(serializedPayloads.includes("raw-image-bytes"), false);
  assert.equal(serializedPayloads.includes("base64-image-payload"), false);
  assert.equal(serializedPayloads.includes("binary-image-payload"), false);
  assert.equal(serializedPayloads.includes("blob-image-payload"), false);
  assert.equal(serializedPayloads.includes("file-image-payload"), false);
  assert.equal(serializedPayloads.includes("inline-image-payload"), false);
  assert.equal(serializedPayloads.includes("[redacted]"), true);
  assert.equal(serializedPayloads.includes("[object-ref-only]"), true);
  assert.equal(
    (artifactPayload as { metadata?: Record<string, unknown> }).metadata?.data,
    "[object-ref-only]",
  );
  assert.equal(
    (artifactPayload as { metadata?: Record<string, unknown> }).metadata?.base64Data,
    "[object-ref-only]",
  );
  assert.equal(
    (artifactPayload as { metadata?: Record<string, unknown> }).metadata?.binaryData,
    "[object-ref-only]",
  );
  assert.equal(
    (artifactPayload as { metadata?: Record<string, unknown> }).metadata?.blobPayload,
    "[object-ref-only]",
  );
  assert.equal(
    (artifactPayload as { metadata?: Record<string, unknown> }).metadata?.fileContent,
    "[object-ref-only]",
  );
  assert.equal(
    (artifactPayload as { metadata?: Record<string, unknown> }).metadata?.dataUrl,
    "[object-ref-only]",
  );
});
