import test from "node:test";
import assert from "node:assert/strict";
import { ConfiguredModelScope } from "../ConfiguredModelScope.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

const native = { reasoning_effort: "high", reasoning_budget_tokens: 1024 };
const contract = { transport_version: 1, parameters: Object.keys(native) };
const request = { messages: [{ role: "user" as const, content: "Review the contract" }] };
const configuration = (adapter: "mswarm" | "openai-compatible" = "mswarm", settings = native) => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "native-transport",
    providers: { service: { adapter, baseUrl: "https://models.test/v1/swarm/self-hosted/openai", ...(adapter === "mswarm" ? { credentialRef: "env:NATIVE_REASONING_FIXTURE_KEY" } : {}) } },
    models: { large: { provider: "service", catalogId: "large", revision: "test", operations: ["chat.completions"], contextWindow: 8192, maxOutputTokens: 2048, reasoning: { high: settings } } },
    bindings: { lead: { candidates: ["large"] } },
  };
  return { config, hash: orchestrationHash(config), source: "fixture" };
};

for (const advertised of [undefined, { supports_reasoning: true }, { ...contract, transport_version: 2 }, { ...contract, parameters: ["reasoning_effort"] }]) {
  test(`native reasoning refuses incomplete transport capability before inference: ${JSON.stringify(advertised)}`, { concurrency: false }, async () => {
    const original = globalThis.fetch; let dispatched = 0;
    const scope = new ConfiguredModelScope(configuration(), { effort: "high", credentials: { service: "fixture-native-credential" } });
    globalThis.fetch = async (url, init) => {
      if (init?.method === "POST") { dispatched++; throw new Error("Inference must not run"); }
      return String(url).endsWith("/agents") ? Response.json({ agents: [{ slug: "large" }] })
        : Response.json({ data: [{ id: "large", native_reasoning: advertised }] });
    };
    try {
      await assert.rejects(scope.provider("lead").generate(request), /Native reasoning transport is unavailable.*upgrade/);
      assert.equal(dispatched, 0);
      assert.equal(scope.snapshot().modelCalls, 0);
      assert.equal(scope.snapshot().pendingCalls, 0);
      assert.equal(scope.snapshot().totalTokens, 0);
    } finally { scope.close(); globalThis.fetch = original; }
  });
}

test("authenticated native transport discovery permits exact parameters, including none and zero", { concurrency: false }, async () => {
  const original = globalThis.fetch; const bodies: Record<string, unknown>[] = []; let preflights = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/agents")) return Response.json({ agents: [{ slug: "large" }] });
    if (String(url).endsWith("/models")) {
      preflights++;
      assert.equal(new Headers(init?.headers).get("x-api-key"), "fixture-native-credential");
      return Response.json({ data: [{ id: "internal-model", agent_slug: "large", native_reasoning: contract }] });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { role: "assistant", content: "Reviewed" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  try {
    for (const settings of [native, { reasoning_effort: "none", reasoning_budget_tokens: 0 }]) {
      const scope = new ConfiguredModelScope(configuration("mswarm", settings), { effort: "high", credentials: { service: "fixture-native-credential" } });
      try {
        const response = await scope.provider("lead").generate(request);
        assert.equal(response.message.content, "Reviewed");
        for (const [key, value] of Object.entries(settings)) assert.equal(bodies.at(-1)?.[key], value);
        assert.equal(scope.snapshot().totalTokens, 15);
        assert.equal(scope.snapshot().pendingCalls, 0);
      } finally { scope.close(); }
    }
    assert.equal(preflights, 2);
    assert.equal(bodies.length, 2);
  } finally { globalThis.fetch = original; }
});

test("a different model's transport advertisement cannot authorize the selected model", { concurrency: false }, async () => {
  const original = globalThis.fetch;
  const scope = new ConfiguredModelScope(configuration(), { effort: "high", credentials: { service: "fixture-native-credential" } });
  globalThis.fetch = async url => String(url).endsWith("/agents") ? Response.json({ agents: [{ slug: "large" }] })
    : Response.json({ data: [{ id: "another-model", native_reasoning: contract }] });
  try { await assert.rejects(scope.provider("lead").generate(request), /Native reasoning transport is unavailable/); assert.equal(scope.snapshot().modelCalls, 0); }
  finally { scope.close(); globalThis.fetch = original; }
});

test("direct compatible providers retain their configured native parameter contract", { concurrency: false }, async () => {
  const original = globalThis.fetch; let catalogRequests = 0;
  const scope = new ConfiguredModelScope(configuration("openai-compatible"), { effort: "high" });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) { catalogRequests++; return Response.json({ data: [{ id: "large" }] }); }
    assert.equal(JSON.parse(String(init?.body)).reasoning_budget_tokens, 1024);
    return Response.json({ choices: [{ message: { role: "assistant", content: "Direct" } }], usage: { total_tokens: 15 } });
  };
  try { await scope.provider("lead").generate(request); assert.equal(catalogRequests, 1); }
  finally { scope.close(); globalThis.fetch = original; }
});
