import test from "node:test";
import assert from "node:assert/strict";
import { runCodali, type CodaliRequest } from "../CodaliApi.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { ConfiguredModelScope } from "../../providers/ConfiguredModelScope.js";

const configuration = () => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "api-fixture",
    providers: { managed: { adapter: "mswarm", baseUrl: "https://models.example/v1", credentialRef: "env:CODALI_TEST_EMBEDDED_TENANT_KEY" } },
    models: { large: { provider: "managed", catalogId: "large", revision: "v1", backend: "strata", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 500 } },
    bindings: { lead: { candidates: ["large"] }, planner: { useBinding: "lead" }, synthesizer: { useBinding: "lead" }, worker: { useBinding: "lead" } },
    effort: { low: { maxModelCalls: 3, maxTotalTokens: 30000, maxOutputTokens: 500 } },
  };
  return { config, hash: orchestrationHash(config), source: "host fixture" };
};
const input = (): CodaliRequest => ({ messages: [{ role: "user", content: "Write a greeting" }], runContext: { repo: { root: process.cwd() } } });

test("configured public API preserves separate authenticated tenant identities on catalog and inference", async () => {
  const original = globalThis.fetch; const prior = process.env.CODALI_TEST_EMBEDDED_TENANT_KEY;
  process.env.CODALI_TEST_EMBEDDED_TENANT_KEY = "test-api-key";
  const counts = new Map<string, number>(); const catalogs: string[] = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers); const tenant = headers.get("x-mswarm-client-identity")!;
    assert.ok(["wodo", "heka"].includes(tenant)); assert.equal(headers.get("x-mswarm-client-product"), "logmira");
    if (String(url).endsWith("/agents")) { catalogs.push(tenant); return Response.json({ agents: [{ slug: "large", backend: "strata", health_status: "healthy" }] }); }
    assert.ok(String(url).endsWith("/chat/completions"));
    const count = (counts.get(tenant) ?? 0) + 1; counts.set(tenant, count);
    const content = count === 1 ? JSON.stringify({ queryType: "general", needsPrivateData: false, needsFreshData: false, needsDocdex: false, needsAppTools: false, needsImageWorker: false, confidence: "high" })
      : count === 2 ? JSON.stringify({ queryType: "general", subquestions: [], workerTasks: [] }) : `Hello ${tenant}`;
    return Response.json({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  try {
    const results = await Promise.all(["wodo", "heka"].map(clientIdentity => runCodali(input(), {
      orchestration: { resolved: configuration(), effort: "low", caller: { clientIdentity, clientProduct: "logmira" } },
      buildRegistry: () => new ToolRegistry(), loadInventory: async () => { throw new Error("Legacy inventory reached"); },
    })));
    for (const [index, result] of results.entries()) {
      assert.equal(result.status, "succeeded", result.answer); assert.equal(result.answer, `Hello ${["wodo", "heka"][index]}`);
      assert.equal(result.orchestration?.usage.modelCalls, 3); assert.equal(result.orchestration?.usage.totalTokens, 45);
      assert.equal(result.orchestration?.routes.length, 3); assert.ok(result.orchestration?.routes.every(route => route.backend === "strata"));
    }
    assert.deepEqual([...counts.values()], [3, 3]); assert.ok(catalogs.includes("wodo") && catalogs.includes("heka"));
  } finally { globalThis.fetch = original; if (prior === undefined) delete process.env.CODALI_TEST_EMBEDDED_TENANT_KEY; else process.env.CODALI_TEST_EMBEDDED_TENANT_KEY = prior; }
});

test("model caller identity is pinned and rejects injected headers or cross-tenant borrowed scope", () => {
  const caller = { clientIdentity: "wodo", clientProduct: "logmira" };
  const scope = new ConfiguredModelScope(configuration(), { caller });
  try {
    caller.clientIdentity = "heka";
    assert.equal(scope.matchesCaller({ clientIdentity: "wodo", clientProduct: "logmira" }), true);
    assert.equal(scope.matchesCaller(caller), false);
    assert.throws(() => new ConfiguredModelScope(configuration(), { caller: { clientIdentity: "wodo\r\nx-api-key: leak" } }), /identity/);
    assert.throws(() => new ConfiguredModelScope(configuration(), { caller: { clientProduct: "bad product" } }), /product/);
  } finally { scope.close(); }
});

test("configured public API rejects provider/media escape hatches and keeps tenant context mandatory", async () => {
  const orchestration = { resolved: configuration(), effort: "low" as const };
  await assert.rejects(runCodali(input(), { orchestration, createProvider: () => { throw new Error("bypass"); } }), /provider override/);
  await assert.rejects(runCodali({ ...input(), media: {} as NonNullable<CodaliRequest["media"]> }, { orchestration }), /media overrides/);
  const result = await runCodali({ messages: input().messages }, { orchestration });
  assert.equal(result.status, "failed"); assert.ok(result.warnings.includes("run_context_required")); assert.equal(result.orchestration?.usage.modelCalls, 0);
});
