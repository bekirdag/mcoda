import test from "node:test";
import assert from "node:assert/strict";
import { ConfiguredModelScope, verifiedTokenUsage, type ScopedModelEvent } from "../ConfiguredModelScope.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

const configuration = (maxModelCalls = 2) => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "scope-test",
    providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { small: { provider: "local", catalogId: "small", revision: "v1", operations: ["chat.completions"], contextWindow: 4096, maxOutputTokens: 100 },
      large: { provider: "local", catalogId: "large", revision: "v1", operations: ["chat.completions"], contextWindow: 4096, maxOutputTokens: 100 } },
    bindings: { lead: { candidates: ["large"] }, planner: { candidates: ["small"] }, worker: { useBinding: "lead" } },
    effort: { low: { maxModelCalls, maxTotalTokens: 2000, maxOutputTokens: 100 } },
  };
  return { config, hash: orchestrationHash(config), source: "fixture" };
};
const request = { messages: [{ role: "user" as const, content: "Hello" }] };

test("trusted credentials are pinned per scope for both discovery and inference", async () => {
  const original = globalThis.fetch; const seen: string[] = [];
  const credentials = { local: "fixture-node-private-credential" };
  const scope = new ConfiguredModelScope(configuration(), { effort: "low", credentials });
  credentials.local = "changed-after-construction";
  globalThis.fetch = async (url, init) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "large" }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  try {
    await scope.provider("lead").generate(request);
    assert.deepEqual(seen, ["Bearer fixture-node-private-credential", "Bearer fixture-node-private-credential"]);
    assert.doesNotMatch(JSON.stringify(scope.snapshot()), /credential/);
  } finally { scope.close(); globalThis.fetch = original; }
});

test("constructor options cannot mutate pinned effort or cancellation ownership", async () => {
  const abort = new AbortController();
  const options: { effort: "low" | "high"; signal: AbortSignal } = { effort: "low", signal: abort.signal };
  const scope = new ConfiguredModelScope(configuration(), options);
  try {
    options.effort = "high"; options.signal = new AbortController().signal;
    assert.equal(scope.effort, "low");
    abort.abort(new Error("original cancelled"));
    await assert.rejects(scope.provider("lead").generate(request), /original cancelled/);
  } finally { scope.close(); }
});

test("configured stages reserve one shared budget before concurrent dispatch", { concurrency: false }, async () => {
  const original = globalThis.fetch; const models: string[] = []; const events: ScopedModelEvent[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "small" }, { id: "large" }] });
    models.push(JSON.parse(String(init?.body)).model);
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  const scope = new ConfiguredModelScope(configuration(1), { effort: "low", onEvent: event => { events.push(event); } });
  try {
    const outcomes = await Promise.allSettled([scope.provider("planner").generate(request), scope.provider("worker").generate(request)]);
    assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(models.length, 1);
    assert.deepEqual(events.map(event => event.type), ["intent", "receipt"]);
    assert.deepEqual(scope.snapshot(), { modelCalls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false, pendingCalls: 0 });
    await assert.rejects(scope.provider("lead").generate(request), /budget exhausted/);
  } finally { scope.close(); globalThis.fetch = original; }
});

test("missing accounting retains the reservation and malformed usage never lowers budgets", { concurrency: false }, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith("/models") ? Response.json({ data: [{ id: "large" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: -5000, total_tokens: -5000 } });
  const scope = new ConfiguredModelScope(configuration(), { effort: "low" });
  try {
    await scope.provider("lead").generate(request);
    assert.ok(scope.snapshot().totalTokens >= 100);
    assert.equal(scope.snapshot().estimated, true);
    assert.equal(scope.snapshot().inputTokens, 0);
    assert.equal(scope.snapshot().pendingCalls, 0);
  } finally { scope.close(); globalThis.fetch = original; }
  for (const usage of [{ totalTokens: NaN }, { totalTokens: -1 }, { totalTokens: Infinity }, { inputTokens: 50, totalTokens: 20 }, { inputTokens: 10, outputTokens: 20, totalTokens: 15 }]) assert.equal(verifiedTokenUsage(usage), undefined);
  assert.deepEqual(verifiedTokenUsage({ inputTokens: 10, outputTokens: 5 }), { input: 10, output: 5, total: 15 });
});

test("failed requests are not replayed and retain unknown accounting", { concurrency: false }, async () => {
  const original = globalThis.fetch; let dispatched = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "small" }, { id: "large" }] });
    dispatched++; throw new Error("Connection lost after dispatch");
  };
  const scope = new ConfiguredModelScope(configuration(), { effort: "low" });
  try {
    await assert.rejects(scope.provider("lead").generate(request), /Connection lost/);
    assert.equal(dispatched, 1); assert.equal(scope.snapshot().pendingCalls, 1);
    assert.equal(scope.snapshot().estimated, true); assert.ok(scope.snapshot().totalTokens > 0);
  } finally { scope.close(); globalThis.fetch = original; }
});

test("a scope pins configuration, rejects undeclared roles and observes cancellation", async () => {
  const resolved = configuration(); const abort = new AbortController();
  const scope = new ConfiguredModelScope(resolved, { signal: abort.signal });
  try {
    resolved.config.bindings.newRole = { candidates: ["large"] };
    assert.throws(() => scope.provider("newRole"), /Unknown|Missing|binding/i);
    abort.abort(new Error("Host cancelled the run"));
    await assert.rejects(scope.provider("lead").generate(request), /Host cancelled/);
    assert.equal(scope.snapshot().modelCalls, 0);
  } finally { scope.close(); }
  assert.throws(() => new ConfiguredModelScope({ ...configuration(), hash: "wrong" }), /hash/);
});
