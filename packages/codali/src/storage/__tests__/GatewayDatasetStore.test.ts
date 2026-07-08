import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runCodaliGateway,
} from "../../gateway/CodaliGateway.js";
import type {
  CodaliEvidenceItem,
  CodaliGatewayPolicy,
  CodaliGatewayRequest,
  CodaliGatewayResult,
} from "../../gateway/CodaliGatewayTypes.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "../../providers/ProviderTypes.js";
import {
  buildGatewayDatasetCollectInputFromGatewayResult,
  buildGatewayDatasetServiceSignatureHeaders,
  collectGatewayDatasetResultNonBlocking,
  createGatewayDatasetServiceClient,
  createInMemoryGatewayDatasetObjectStore,
  createInMemoryGatewayDatasetStore,
  createLocalJsonlGatewayDatasetObjectStore,
  createLocalJsonlGatewayDatasetStore,
  hashGatewayDatasetRequestBody,
  type GatewayDatasetFetch,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStore,
} from "../GatewayDatasetStore.js";

class StubProvider implements Provider {
  name = "stub-dataset-provider";
  requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No stub response configured");
    return response;
  }
}

const fixedNow = () => new Date("2026-07-03T10:00:00.000Z");

const jsonResponse = (value: unknown): ProviderResponse => ({
  message: { role: "assistant", content: JSON.stringify(value) },
});

const textResponse = (content: string): ProviderResponse => ({
  message: { role: "assistant", content },
  usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
});

const basePolicy = (
  overrides: Partial<CodaliGatewayPolicy> = {},
): CodaliGatewayPolicy => ({
  allowedTools: [],
  deniedTools: [],
  maxIterations: 2,
  maxRuntimeMs: 60_000,
  maxToolCalls: 0,
  maxModelCalls: 6,
  maxEvidenceItems: 10,
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
  id: "dataset-run",
  query: "Summarize the active retention policy.",
  mode: "balanced",
  product: { name: "product-neutral", version: "local" },
  tenant: { id: "tenant-alpha" },
  policy: basePolicy(),
  ...overrides,
});

const largeAgent = (): Record<string, unknown> => ({
  slug: "large-final-agent",
  adapter: "openai-api",
  model: "large-final-model",
  tier: "large",
  contextWindow: 64_000,
  reasoningRating: 9,
  rating: 9,
  healthStatus: "healthy",
  capabilities: ["final_answer_synthesis"],
});

const evidence = (): CodaliEvidenceItem => ({
  id: "ev-retention",
  runId: "dataset-run",
  taskId: "task-1",
  claim: "The default retention policy keeps dataset objects local-only.",
  summary: "Dataset objects remain local unless policy metadata allows upload.",
  sourceType: "docdex",
  sourceId: "docs/planning/phase-7.md",
  sourceTitle: "phase-7.md",
  confidence: 0.9,
  relevance: 0.9,
  freshness: "fresh",
  usedTool: "docdex_search",
  tenantScoped: true,
});

const gatewayResult = (
  overrides: Partial<CodaliGatewayResult> = {},
): CodaliGatewayResult => ({
  runId: "dataset-run",
  status: "succeeded",
  answer: "Dataset objects remain local-only unless policy metadata allows upload.",
  sources: [
    {
      evidenceId: "ev-retention",
      title: "phase-7.md",
      sourceType: "docdex",
    },
  ],
  confidence: "high",
  evidence: [evidence()],
  contextPack: {
    id: "ctx-dataset-run",
    runId: "dataset-run",
    originalQuery: "Summarize the active retention policy.",
    decisionFacts: [evidence()],
    contradictions: [],
    missingInformation: [],
    selectedExcerpts: [],
    toolSummary: [],
    tokenEstimate: 128,
  },
  finalModel: { agentSlug: "large-final-agent", tier: "large", model: "large-final-model" },
  trace: {
    runId: "dataset-run",
    mode: "balanced",
    status: "succeeded",
    iterations: 0,
    toolCallCount: 0,
    modelCallCount: 1,
    consideredTools: [],
    calledTools: [],
    warnings: [],
    errors: [],
    toolCalls: [],
    modelCalls: [],
    events: [],
  },
  telemetry: { usage: { totalTokens: 20 } },
  ...overrides,
});

const buildCollectInput = async (objectStore?: GatewayDatasetObjectStore) =>
  buildGatewayDatasetCollectInputFromGatewayResult({
    request: baseRequest(),
    result: gatewayResult(),
    objectStore,
    now: fixedNow,
  });

const response = (status: number, body: unknown, statusText?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  text: async () => JSON.stringify(body),
});

test("GatewayDatasetStore stores validated records in memory without external services", async () => {
  const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
  const store = createInMemoryGatewayDatasetStore();
  const collectInput = await buildCollectInput(objectStore);

  const result = await store.collect(collectInput);
  const replay = await store.collect(collectInput);
  const records = store.listRecords();
  const runRecord = records.find((record) => record.metadata?.exampleType === "gateway_run");
  assert.ok(runRecord);
  const inputPayload = await objectStore.readObject?.(runRecord.inputRef);

  assert.equal(result.accepted, true);
  assert.equal(result.status, "stored");
  assert.equal(replay.replayed, true);
  assert.equal(records.length, 4);
  assert.equal(records.some((record) => record.metadata?.exampleType === "final_answer"), true);
  assert.equal(records.some((record) => record.metadata?.exampleType === "evidence_item"), true);
  assert.equal(records.some((record) => record.metadata?.exampleType === "context_pack"), true);
  assert.equal(records.every((record) => record.privacy.uploadAllowed === false), true);
  assert.equal(records.every((record) => record.privacy.trainingAllowed === false), true);
  assert.equal(objectStore.listObjects().length, 10);
  assert.deepEqual(inputPayload, {
    requestId: "dataset-run",
    query: "Summarize the active retention policy.",
    mode: "balanced",
    traceRunId: "dataset-run",
    traceStatus: "succeeded",
    taskCount: 0,
    modelCallCount: 0,
  });
});

test("GatewayDatasetStore writes local JSONL records and file object references for dry runs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-dataset-store-"));
  try {
    const objectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "objects"),
      now: fixedNow,
    });
    const store = createLocalJsonlGatewayDatasetStore({ directory, now: fixedNow });
    const collectInput = await buildCollectInput(objectStore);

    const result = await store.collect(collectInput);
    const recordsFile = await readFile(path.join(directory, "records.jsonl"), "utf8");
    const objects = await readdir(path.join(directory, "objects"));
    const line = JSON.parse(recordsFile.trim()) as Record<string, unknown>;

    assert.equal(result.accepted, true);
    assert.equal(result.status, "stored");
    assert.equal(line.idempotencyKey, collectInput.idempotencyKey);
    assert.equal(objects.length, 10);
    assert.ok(collectInput.records[0]?.inputRef.uri?.startsWith("file://"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GatewayDatasetServiceClient batches, retries, signs, and preserves idempotency", async () => {
  const collectInput = await buildCollectInput();
  const firstRecord = collectInput.records[0];
  assert.ok(firstRecord);
  const secondRecord = {
    ...firstRecord,
    recordId: `${firstRecord.recordId}-second`,
    sourceGatewayRecordId: `${firstRecord.sourceGatewayRecordId}-second`,
    metadata: {
      ...(firstRecord.metadata ?? {}),
      batchTestRecord: 2,
    },
  };
  const calls: Array<{ url: string; request: Parameters<GatewayDatasetFetch>[1] }> = [];
  const fetch: GatewayDatasetFetch = async (url, request) => {
    calls.push({ url, request });
    if (calls.length === 1) {
      return response(503, { error: "temporary" }, "Service Unavailable");
    }
    return response(202, { accepted: 1, batchId: "storage-batch" });
  };
  const client = createGatewayDatasetServiceClient({
    baseUrl: "https://storage.example",
    serviceToken: "writer-token",
    hmacSecret: "hmac-secret",
    fetch,
    batchSize: 1,
    maxRetries: 1,
    retryBaseMs: 0,
    now: fixedNow,
    nonceFactory: () => `nonce-${calls.length + 1}`,
  });

  const result = await client.collect({
    ...collectInput,
    records: [firstRecord, secondRecord],
    idempotencyKey: "idem-1",
  });
  const secondRequest = calls[1]?.request;
  const secondBody = JSON.parse(secondRequest?.body ?? "{}") as Record<string, unknown>;
  const thirdRequest = calls[2]?.request;
  const thirdBody = JSON.parse(thirdRequest?.body ?? "{}") as Record<string, unknown>;
  const expectedSignatureHeaders = buildGatewayDatasetServiceSignatureHeaders({
    scope: collectInput.scope,
    body: secondBody,
    hmacSecret: "hmac-secret",
    timestamp: fixedNow().toISOString(),
    nonce: "nonce-2",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.recordCount, 2);
  assert.deepEqual(result.metadata?.batchCount, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.url, "https://storage.example/v1/gateway/batches");
  assert.equal(calls[2]?.url, "https://storage.example/v1/gateway/batches");
  assert.equal(secondRequest?.headers.authorization, "Bearer writer-token");
  assert.equal(secondRequest?.headers["x-codali-storage-idempotency-key"], "idem-1:1");
  assert.equal(thirdRequest?.headers["x-codali-storage-idempotency-key"], "idem-1:2");
  assert.equal(secondRequest?.headers["x-codali-storage-tenant"], "tenant-alpha");
  assert.equal(secondRequest?.headers["x-codali-storage-body-sha256"], hashGatewayDatasetRequestBody(secondBody));
  assert.equal(secondRequest?.headers["x-codali-storage-signature"], expectedSignatureHeaders["x-codali-storage-signature"]);
  assert.equal((secondBody.records as Array<{ recordId: string }>)[0]?.recordId, firstRecord.recordId);
  assert.equal((thirdBody.records as Array<{ recordId: string }>)[0]?.recordId, secondRecord.recordId);
  assert.equal((secondBody.metadata as Record<string, unknown>).batchIndex, 0);
  assert.equal((secondBody.metadata as Record<string, unknown>).batchCount, 2);
  assert.equal((thirdBody.metadata as Record<string, unknown>).batchIndex, 1);
  assert.equal((thirdBody.metadata as Record<string, unknown>).batchCount, 2);
  assert.equal(calls[0]?.request.headers["x-codali-storage-nonce"], "nonce-1");
  assert.equal(calls[1]?.request.headers["x-codali-storage-nonce"], "nonce-2");
  assert.equal(calls[2]?.request.headers["x-codali-storage-nonce"], "nonce-3");
});

test("GatewayDatasetStore non-blocking collection falls back without throwing", async () => {
  const fallbackStore = createInMemoryGatewayDatasetStore();
  const failingStore: GatewayDatasetStore = {
    async collect() {
      throw new Error("storage unavailable");
    },
  };
  const settled = new Promise<void>((resolve) => {
    const queued = collectGatewayDatasetResultNonBlocking({
      store: failingStore,
      fallbackStore,
      request: baseRequest(),
      result: gatewayResult(),
      now: fixedNow,
      onResult: (result) => {
        assert.equal(result.fallbackUsed, true);
        assert.equal(result.status, "stored");
        resolve();
      },
    });
    assert.equal(queued.status, "queued");
  });

  await settled;
  assert.equal(fallbackStore.listRecords().length, 4);
});

test("CodaliGateway answers are not blocked by dataset storage failures", async () => {
  const provider = new StubProvider([
    jsonResponse({
      queryType: "general",
      needsPrivateData: false,
      needsFreshData: false,
      needsDocdex: false,
      needsAppTools: false,
      needsImageWorker: false,
      confidence: "high",
    }),
    jsonResponse({
      queryType: "general",
      subquestions: [],
      workerTasks: [],
      requiresFinalLargeModel: true,
    }),
    textResponse("large final answer"),
  ]);
  const failingStore: GatewayDatasetStore = {
    async collect() {
      throw new Error("dataset store down");
    },
  };
  let observedError: unknown;
  let resolveObserved: () => void = () => {};
  const observed = new Promise<void>((resolve) => {
    resolveObserved = resolve;
  });
  const result = await runCodaliGateway(baseRequest({ id: "dataset-run-gateway" }), {
    provider,
    agentInventory: [largeAgent()],
    datasetStore: failingStore,
    datasetCollection: {
      now: fixedNow,
      onError: (error) => {
        observedError = error;
        resolveObserved();
      },
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.answer, "large final answer");
  await observed;
  assert.ok(observedError instanceof Error);
  assert.equal(provider.requests.length, 3);
});
