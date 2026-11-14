import test from "node:test";
import assert from "node:assert/strict";
import { runConfiguredGateway, type ConfiguredGatewayHostOptions } from "../ConfiguredGateway.js";
import { createInMemoryCodaliGatewayStore } from "../CodaliGatewayStore.js";
import type { CodaliGatewayRequest } from "../CodaliGatewayTypes.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { ConfiguredModelScope } from "../../providers/ConfiguredModelScope.js";

const configuration = (maxModelCalls = 6) => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "gateway-test",
    providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { planner: { provider: "local", catalogId: "small", revision: "v1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 1024 },
      lead: { provider: "local", catalogId: "large-a", revision: "v1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 1024 },
      fallback: { provider: "local", catalogId: "large-b", revision: "v1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 1024 } },
    bindings: { lead: { candidates: ["lead", "fallback"] }, planner: { candidates: ["planner"] }, synthesizer: { useBinding: "lead" } },
    effort: { low: { maxModelCalls, maxTotalTokens: 32000, maxOutputTokens: 1024 } },
  };
  return { config, hash: orchestrationHash(config), source: "fixture" };
};
const request = (): CodaliGatewayRequest => ({ query: "Explain recursion", mode: "balanced", policy: {
  allowedTools: [], deniedTools: [], maxIterations: 3, maxRuntimeMs: 60000, maxToolCalls: 8, maxModelCalls: 6,
  maxEvidenceItems: 20, maxContextPackTokens: 2000, allowWrites: false, allowShell: false,
  allowDestructiveOperations: false, allowOutsideWorkspace: false, requireFinalLargeModel: true,
} });
const inventory = () => ["large-a", "large-b"].map(slug => ({ slug, model: slug, adapter: "openai-api", tier: "large",
  contextWindow: 32768, reasoningRating: 9, rating: 9, healthStatus: "healthy", capabilities: ["final_answer_synthesis"] }));
const mockService = () => {
  const original = globalThis.fetch; const dispatched: string[] = [];
  const contents = [JSON.stringify({ queryType: "general", needsPrivateData: false, needsFreshData: false, needsDocdex: false,
    needsAppTools: false, needsImageWorker: false, confidence: "high" }),
  JSON.stringify({ queryType: "general", subquestions: [], workerTasks: [], requiresFinalLargeModel: true }), "A recursive function calls itself."];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "small" }, { id: "large-b" }] });
    dispatched.push(JSON.parse(String(init?.body)).model);
    return Response.json({ choices: [{ message: { role: "assistant", content: contents.shift() } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  return { dispatched, restore: () => { globalThis.fetch = original; } };
};

test("configured gateway shares a budget and traces the actual eligible fallback", async () => {
  const mock = mockService();
  try {
    const store = createInMemoryCodaliGatewayStore();
    const input = request(); input.id = "configured-success";
    const output = await runConfiguredGateway(input, { orchestration: configuration(), effort: "low", configure: () => ({ agentInventory: inventory(), store }) });
    assert.equal(output.result.status, "succeeded");
    assert.deepEqual(mock.dispatched, ["small", "small", "large-b"]);
    assert.equal(output.result.finalModel?.agentSlug, "large-b");
    assert.equal(output.result.finalModel?.tier, "large");
    assert.equal(output.usage.modelCalls, 3); assert.equal(output.usage.totalTokens, 45);
    assert.equal(((await store.readRunTrace(input.id))?.modelCalls.at(-1)?.metadata?.route as { catalogId: string }).catalogId, "large-b");
  } finally { mock.restore(); }
});

test("configured gateway borrows the admitted parent scope and rejects substitutions", async () => {
  const mock = mockService(); const resolved = configuration();
  const scope = new ConfiguredModelScope(resolved, { effort: "low", caller: { clientIdentity: "tenant-a" } });
  try {
    const output = await runConfiguredGateway(request(), { orchestration: resolved, effort: "low", scope, caller: { clientIdentity: "tenant-a" }, configure: () => ({ agentInventory: inventory() }) });
    assert.equal(output.result.status, "succeeded"); assert.equal(scope.signal.aborted, false); assert.equal(scope.snapshot().modelCalls, 3);
    for (const options of [{ effort: "high" as const }, { caller: { clientIdentity: "tenant-b" } }, { orchestration: configuration(1) }]) {
      await assert.rejects(runConfiguredGateway(request(), { orchestration: resolved, scope, ...options }), /does not match/);
      assert.equal(scope.signal.aborted, false);
    }
    assert.equal(mock.dispatched.length, 3);
  } finally { scope.close(); mock.restore(); }
});

test("configured gateway stops synthesis at the shared model-call limit", async () => {
  const mock = mockService();
  try {
    const output = await runConfiguredGateway(request(), { orchestration: configuration(2), effort: "low", configure: () => ({ agentInventory: inventory() }) });
    assert.notEqual(output.result.status, "succeeded");
    assert.deepEqual(mock.dispatched, ["small", "small"]);
    assert.equal(output.usage.modelCalls, 2);
  } finally { mock.restore(); }
});

test("all configured final candidates must satisfy the host large-model requirement before any dispatch", async () => {
  const mock = mockService();
  try {
    const agents = inventory(); agents[1].tier = "small";
    await assert.rejects(runConfiguredGateway(request(), { orchestration: configuration(), configure: () => ({ agentInventory: agents }) }), /no eligible large-model assignment/);
    assert.equal(mock.dispatched.length, 0);
    await assert.rejects(runConfiguredGateway(request(), { orchestration: configuration(), configure: () => ({ provider: {} } as unknown as ConfiguredGatewayHostOptions) }), /legacy provider/);
  } finally { mock.restore(); }
});

test("optional final-model policy does not label an unqualified model as large", async () => {
  const mock = mockService();
  try {
    const input = request(); input.id = "configured-optional"; input.policy.requireFinalLargeModel = false;
    const store = createInMemoryCodaliGatewayStore();
    const output = await runConfiguredGateway(input, { orchestration: configuration(), effort: "low", configure: () => ({ store }) });
    assert.equal(output.result.status, "succeeded");
    assert.equal(output.result.finalModel, undefined);
    assert.equal(((await store.readRunTrace(input.id))?.modelCalls.at(-1)?.metadata?.route as { catalogId: string }).catalogId, "large-b");
  } finally { mock.restore(); }
});
