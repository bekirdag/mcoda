import test from "node:test";
import assert from "node:assert/strict";
import { ConfiguredProvider, ModelServiceClient } from "../ConfiguredProvider.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

const service = { adapter: "mswarm" as const, baseUrl: "https://discovery.test/v1/swarm/self-hosted/openai", credentialRef: "env:DISCOVERY_FIXTURE" };
const catalog = { agents: [{ slug: "large", supports_tools: true }] };
const native = { data: [{ id: "large", native_reasoning: { transport_version: 1, parameters: ["reasoning_effort"] } }] };

test("temporary catalog and native-discovery failures precede exactly one inference", { concurrency: false }, async t => {
  const gets = { catalog: 0, native: 0 }; let posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++; return Response.json({ choices: [{ message: { role: "assistant", content: "ready" } }], usage: { total_tokens: 4 } });
    }
    const lane = String(url).endsWith("/agents") ? "catalog" : "native";
    if (++gets[lane] < 3) return Response.json({ error: { code: "upstream_error" } }, { status: 503 });
    return Response.json(lane === "catalog" ? catalog : native);
  });
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "discovery-retry", providers: { service },
    models: { large: { provider: "service", catalogId: "large", revision: "fixture", operations: ["chat.completions"], contextWindow: 8192,
      maxOutputTokens: 512, reasoning: { high: { reasoning_effort: "high" } } } }, bindings: { lead: { candidates: ["large"] } } };
  const provider = new ConfiguredProvider({ config, hash: orchestrationHash(config), source: "fixture" }, "lead", { effort: "high", credentials: { service: "fixture-key" } });
  const result = await provider.generate({ messages: [{ role: "user", content: "Inspect the contract." }] });
  assert.equal(result.message.content, "ready"); assert.equal(posts, 1);
  assert.deepEqual(gets, { catalog: 3, native: 3 });
});

for (const status of [401, 403, 429, 503]) {
  test(`discovery retry is bounded and preserves HTTP ${status} refusal`, { concurrency: false }, async t => {
    let gets = 0;
    t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      assert.notEqual(init?.method, "POST"); gets++;
      return Response.json({ error: { code: "upstream_error" } }, { status });
    });
    const client = new ModelServiceClient(service, "fixture-key");
    await assert.rejects(client.requireNativeReasoning("large", ["reasoning_effort"]), new RegExp(`HTTP ${status}`));
    assert.equal(gets, status === 503 ? 3 : 1);
  });
}

test("cancelling discovery stops retries before inference", { concurrency: false }, async t => {
  const abort = new AbortController(); let gets = 0;
  t.mock.method(globalThis, "fetch", async () => {
    gets++; abort.abort(new Error("Cancelled discovery"));
    return Response.json({ error: { code: "upstream_error" } }, { status: 503 });
  });
  const client = new ModelServiceClient(service, "fixture-key");
  await assert.rejects(client.catalog(abort.signal), /Cancelled discovery|abort/i);
  assert.equal(gets, 1);
});

for (const reason of ["long-backoff", "quota"] as const) {
  test(`HTTP 503 discovery preserves ${reason} without an early retry`, { concurrency: false }, async t => {
    let gets = 0;
    t.mock.method(globalThis, "fetch", async () => {
      gets++;
      return Response.json({ error: { code: reason === "quota" ? "quota_exhausted" : "upstream_error" } },
        { status: 503, headers: reason === "long-backoff" ? { "retry-after": "60" } : {} });
    });
    await assert.rejects(new ModelServiceClient(service, "fixture-key").catalog(), reason === "quota" ? /quota_exhausted/ : /503/);
    assert.equal(gets, 1);
  });
}

test("malformed discovery and inference failures are never replayed by discovery retries", { concurrency: false }, async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ data: "invalid" }); });
  await assert.rejects(new ModelServiceClient(service, "fixture-key").catalog(), /Invalid model catalog/);
  assert.equal(requests, 1);
  requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "POST"); requests++;
    return Response.json({ error: { code: "upstream_error" } }, { status: 503 });
  });
  await assert.rejects(new ModelServiceClient(service, "fixture-key").json(service.baseUrl + "/chat/completions", { method: "POST", body: {} }), /503/);
  assert.equal(requests, 1);
});
