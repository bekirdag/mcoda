import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import {
  buildCodaliGatewayFinalSynthesizerMessages,
  createCodaliGateway,
  runCodaliGateway,
} from "../CodaliGateway.js";
import { createInMemoryCodaliGatewayStore } from "../CodaliGatewayStore.js";
import type {
  CodaliEvidenceItem,
  CodaliGatewayPolicy,
  CodaliGatewayRequest,
} from "../CodaliGatewayTypes.js";

type StubItem = ProviderResponse | Error;

class StubProvider implements Provider {
  name = "stub-final-provider";
  requests: ProviderRequest[] = [];

  constructor(private readonly responses: StubItem[]) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No stub response configured");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

const jsonResponse = (value: unknown): ProviderResponse => ({
  message: { role: "assistant", content: JSON.stringify(value) },
});

const textResponse = (
  content: string,
  usage: ProviderResponse["usage"] = { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
): ProviderResponse => ({
  message: { role: "assistant", content },
  usage,
});

const retryableError = (message = "temporary final model timeout"): Error =>
  Object.assign(new Error(message), {
    code: "TEMPORARY_FINAL_TIMEOUT",
    retryable: true,
  });

const nonRetryableError = (message = "final model rejected request"): Error =>
  Object.assign(new Error(message), {
    code: "FINAL_MODEL_REJECTED",
    retryable: false,
  });

const basePolicy = (
  overrides: Partial<CodaliGatewayPolicy> = {},
): CodaliGatewayPolicy => ({
  allowedTools: ["docdex_search"],
  deniedTools: [],
  maxIterations: 3,
  maxRuntimeMs: 60_000,
  maxToolCalls: 8,
  maxModelCalls: 6,
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
  id: "final-run",
  query: "What does the tenant policy require?",
  mode: "balanced",
  policy: basePolicy(),
  ...overrides,
});

const largeAgent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "large-final-agent",
  adapter: "openai-api",
  model: "large-final-model",
  tier: "large",
  contextWindow: 64_000,
  reasoningRating: 9,
  rating: 9,
  healthStatus: "healthy",
  capabilities: ["final_answer_synthesis"],
  ...overrides,
});

const smallAgent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "small-final-agent",
  adapter: "openai-api",
  model: "small-model",
  tier: "small",
  contextWindow: 8_000,
  reasoningRating: 3,
  rating: 4,
  healthStatus: "healthy",
  capabilities: ["structured_output"],
  ...overrides,
});

const evidence = (
  id: string,
  overrides: Partial<CodaliEvidenceItem> = {},
): CodaliEvidenceItem => ({
  id,
  runId: "final-run",
  taskId: "task-1",
  claim: `Claim ${id}`,
  summary: `Summary ${id}`,
  sourceType: "docdex",
  sourceId: `doc-${id}`,
  sourceTitle: `${id}.md`,
  rawExcerpt: `Excerpt ${id}`,
  confidence: 0.9,
  relevance: 0.9,
  freshness: "fresh",
  usedTool: "docdex_search",
  tenantScoped: true,
  ...overrides,
});

const seedRun = async (
  request: CodaliGatewayRequest,
  items: CodaliEvidenceItem[] = [evidence("ev-allowed")],
) => {
  const store = createInMemoryCodaliGatewayStore();
  await store.createRun({
    runId: request.id ?? "final-run",
    request,
    status: "running",
  });
  if (items.length > 0) {
    await store.appendEvidence(request.id ?? "final-run", items);
  }
  return store;
};

test("runCodaliGateway uses the final synthesizer instead of classifier direct answer", async () => {
  const provider = new StubProvider([
    jsonResponse({
      queryType: "general",
      needsPrivateData: false,
      needsFreshData: false,
      needsDocdex: false,
      needsAppTools: false,
      needsImageWorker: false,
      directAnswerCandidate: "small model draft answer",
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

  const result = await runCodaliGateway(
    baseRequest({ policy: basePolicy({ allowedTools: [] }) }),
    {
    provider,
    agentInventory: [largeAgent()],
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.answer, "large final answer");
  assert.equal(result.finalModel?.agentSlug, "large-final-agent");
  assert.equal(result.finalModel?.tier, "large");
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.requests[2]?.toolChoice, "none");
  assert.equal(result.trace.modelCalls.at(-1)?.role, "final_synthesizer");
});

test("final synthesizer prompt and sources use only allowed context-pack evidence", async () => {
  const request = baseRequest({
    id: "filtered-final-run",
    policy: basePolicy({
      allowedTools: ["docdex_search"],
      deniedTools: ["github_search"],
    }),
  });
  const store = await seedRun(request, [
    evidence("ev-allowed", {
      runId: "filtered-final-run",
      claim: "Tenant policy requires manager approval.",
      sourceTitle: "policy.md",
      rawExcerpt: "Approval must come from the manager.",
      usedTool: "docdex_search",
    }),
    evidence("ev-denied", {
      runId: "filtered-final-run",
      claim: "Denied GitHub evidence should not be cited.",
      sourceType: "github",
      sourceTitle: "github.md",
      usedTool: "github_search",
    }),
  ]);
  const provider = new StubProvider([textResponse("Use manager approval [ev-allowed].")]);

  const result = await createCodaliGateway({
    provider,
    store,
    agentInventory: [largeAgent()],
  }).synthesizeFinalAnswer({ runId: "filtered-final-run", request });

  const prompt = provider.requests[0]?.messages.map((message) => message.content).join("\n") ?? "";
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.sources.map((source) => source.evidenceId), ["ev-allowed"]);
  assert.match(prompt, /ev-allowed/);
  assert.doesNotMatch(prompt, /ev-denied/);
  assert.doesNotMatch(prompt, /github_search/);
});

test("final telemetry includes Docdex request ids from evidence and tool calls", async () => {
  const request = baseRequest({ id: "docdex-telemetry-final-run" });
  const store = await seedRun(request, [
    evidence("ev-docdex-telemetry", {
      runId: "docdex-telemetry-final-run",
      claim: "Tenant policy evidence came from encrypted Docdex search.",
      metadata: {
        docdex_request_id: "evidence-req-1",
        docdex_operation: "search",
      },
    }),
  ]);
  await store.appendToolCall({
    runId: "docdex-telemetry-final-run",
    taskId: "task-1",
    tool: "docdex_search",
    status: "success",
    latencyMs: 24,
    result: {
      meta: {
        docdex_request_id: "tool-result-req-1",
        docdex_operation: "search",
      },
      results: [],
    },
    metadata: {
      docdex_request_id: "tool-call-req-1",
    },
  });
  const provider = new StubProvider([textResponse("Docdex telemetry answer [ev-docdex-telemetry].")]);

  const result = await createCodaliGateway({
    provider,
    store,
    agentInventory: [largeAgent()],
  }).synthesizeFinalAnswer({ runId: "docdex-telemetry-final-run", request });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.telemetry.docdexRequestIds, [
    "tool-result-req-1",
    "tool-call-req-1",
    "evidence-req-1",
  ]);
  assert.equal(result.trace.toolCalls[0]?.metadata?.docdex_request_id, "tool-result-req-1");
  assert.equal(result.trace.toolCalls[0]?.metadata?.docdex_operation, "search");
  assert.deepEqual(result.trace.metadata?.docdexRequestIds, [
    "tool-result-req-1",
    "tool-call-req-1",
    "evidence-req-1",
  ]);
});

test("requireFinalLargeModel blocks a non-large final assignment before provider call", async () => {
  const request = baseRequest({
    id: "small-final-block-run",
    agentPolicy: {
      resolver: "mcoda_inventory",
      roles: {
        final_synthesizer: { tier: "small" },
      },
    },
  });
  const store = await seedRun(request, []);
  const provider = new StubProvider([textResponse("should not be called")]);

  const result = await createCodaliGateway({
    provider,
    store,
    agentInventory: [smallAgent()],
  }).synthesizeFinalAnswer({ runId: "small-final-block-run", request });

  assert.equal(result.status, "failed");
  assert.equal(provider.requests.length, 0);
  assert.equal(result.telemetry.finalBlocked, true);
  assert.match(result.answer, /large model is required/i);
});

test("final synthesizer retries one retryable provider failure and records telemetry", async () => {
  const request = baseRequest({ id: "retry-final-run" });
  const store = await seedRun(request, [
    evidence("ev-retry", { runId: "retry-final-run", claim: "Retry evidence exists." }),
  ]);
  const provider = new StubProvider([
    retryableError(),
    textResponse("retry succeeded [ev-retry]."),
  ]);

  const result = await createCodaliGateway({
    provider,
    store,
    agentInventory: [largeAgent()],
  }).synthesizeFinalAnswer({ runId: "retry-final-run", request });

  const trace = await store.readRunTrace("retry-final-run");
  assert.equal(result.status, "succeeded");
  assert.equal(result.telemetry.finalAttempts, 2);
  assert.equal(provider.requests.length, 2);
  assert.equal(trace?.modelCalls.filter((call) => call.role === "final_synthesizer").length, 2);
  assert.ok(result.trace.warnings.some((warning) => warning.includes("final_synthesizer_retry")));
});

test("final model failure returns operational failure unless degraded fallback is allowed", async () => {
  const strictRequest = baseRequest({ id: "strict-final-failure-run" });
  const strictStore = await seedRun(strictRequest, [
    evidence("ev-strict", { runId: "strict-final-failure-run" }),
  ]);
  const strictProvider = new StubProvider([nonRetryableError()]);

  const strict = await createCodaliGateway({
    provider: strictProvider,
    store: strictStore,
    agentInventory: [largeAgent()],
  }).synthesizeFinalAnswer({ runId: "strict-final-failure-run", request: strictRequest });

  assert.equal(strict.status, "failed");
  assert.equal(strict.telemetry.finalFailed, true);
  assert.match(strict.answer, /final synthesis failed/i);

  const degradedRequest = baseRequest({
    id: "degraded-final-failure-run",
    policy: basePolicy({ allowDegradedFinalAnswer: true }),
  });
  const degradedStore = await seedRun(degradedRequest, [
    evidence("ev-degraded", {
      runId: "degraded-final-failure-run",
      claim: "Degraded fallback can cite context-pack evidence.",
    }),
  ]);
  const degradedProvider = new StubProvider([nonRetryableError()]);

  const degraded = await createCodaliGateway({
    provider: degradedProvider,
    store: degradedStore,
    agentInventory: [largeAgent()],
  }).synthesizeFinalAnswer({
    runId: "degraded-final-failure-run",
    request: degradedRequest,
  });

  assert.equal(degraded.status, "partial");
  assert.equal(degraded.telemetry.finalDegraded, true);
  assert.match(degraded.answer, /degraded evidence summary/i);
  assert.match(degraded.answer, /ev-degraded/);
});

test("final synthesizer prompt helper does not include internal trace text", () => {
  const request = baseRequest();
  const messages = buildCodaliGatewayFinalSynthesizerMessages(request, {
    id: "context-pack-final-run",
    runId: "final-run",
    originalQuery: request.query,
    decisionFacts: [evidence("ev-helper")],
    contradictions: [],
    missingInformation: [],
    selectedExcerpts: [{ evidenceId: "ev-helper", text: "curated excerpt" }],
    toolSummary: [{ tool: "docdex_search", calls: 1, statuses: { success: 1 } }],
    tokenEstimate: 120,
  });
  const prompt = messages.map((message) => message.content).join("\n");

  assert.match(prompt, /curated context pack/i);
  assert.match(prompt, /ev-helper/);
  assert.doesNotMatch(prompt, /raw worker transcript/i);
  assert.doesNotMatch(prompt, /modelCalls/);
  assert.doesNotMatch(prompt, /toolCalls/);
});
