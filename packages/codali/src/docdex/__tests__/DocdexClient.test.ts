import test from "node:test";
import assert from "node:assert/strict";
import { DocdexClient } from "../DocdexClient.js";

type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (key: string) => string | null };
};

type FetchHandler = (url: string, init?: RequestInit) => StubResponse;

const makeJsonResponse = (payload: unknown): StubResponse => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
  headers: { get: () => "application/json" },
});

const makeTextResponse = (body: string): StubResponse => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => body,
  headers: { get: () => "text/plain" },
});

const makeErrorResponse = (status: number, body: string): StubResponse => ({
  ok: false,
  status,
  json: async () => ({ error: body }),
  text: async () => body,
  headers: { get: () => "text/plain" },
});

const withStubbedFetch = async (handler: FetchHandler, fn: () => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = handler(String(input), init);
    return response as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

test("DocdexClient caches capability probe results", { concurrency: false }, async () => {
  let probeCalls = 0;
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string; id?: string };
      if (payload.method === "docdex_capabilities") {
        probeCalls += 1;
        return makeJsonResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            retrieval: {
              score_breakdown: true,
              rerank: true,
              snippet_provenance: "available",
              retrieval_explanation: false,
              batch_search: "unknown",
            },
          },
        });
      }
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    const first = await client.getCapabilities();
    const cached = await client.getCapabilities();
    const refreshed = await client.getCapabilities(true);

    assert.equal(first.cached, false);
    assert.equal(first.source, "mcp_probe");
    assert.equal(first.capabilities.score_breakdown, "available");
    assert.equal(first.capabilities.rerank, "available");
    assert.equal(first.capabilities.snippet_provenance, "available");
    assert.equal(first.capabilities.retrieval_explanation, "unavailable");
    assert.equal(first.capabilities.batch_search, "unknown");

    assert.equal(cached.cached, true);
    assert.equal(refreshed.cached, false);
    assert.equal(probeCalls, 2);
  });
});

test("DocdexClient capability probe falls back when MCP probe is unavailable", { concurrency: false }, async () => {
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string; id?: string };
      if (payload.method === "docdex_capabilities") {
        return makeErrorResponse(404, "method not found");
      }
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    const snapshot = await client.getCapabilities();

    assert.equal(snapshot.cached, false);
    assert.equal(snapshot.source, "fallback");
    assert.equal(snapshot.capabilities.score_breakdown, "unavailable");
    assert.equal(snapshot.capabilities.rerank, "unavailable");
    assert.equal(snapshot.capabilities.snippet_provenance, "unavailable");
    assert.equal(snapshot.capabilities.retrieval_explanation, "unavailable");
    assert.equal(snapshot.capabilities.batch_search, "unavailable");
    assert.ok((snapshot.warnings?.[0] ?? "").startsWith("probe_failed:"));
  });
});

test("DocdexClient forwards metadata for memorySave and savePreference", {
  concurrency: false,
}, async () => {
  const seenCalls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as {
        method?: string;
        id?: string;
        params?: Record<string, unknown>;
      };
      seenCalls.push({ method: payload.method, params: payload.params });
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    await client.memorySave("rule text", { lifecycle_state: "candidate", score: 0.7 });
    await client.savePreference("codali", "constraint", "Do not use moment.js", {
      dedupe_key: "profile_memory::constraint::do not use moment.js",
    });
  });

  const memoryCall = seenCalls.find((entry) => entry.method === "docdex_memory_save");
  const preferenceCall = seenCalls.find((entry) => entry.method === "docdex_save_preference");
  assert.equal(memoryCall?.params?.text, "rule text");
  assert.deepEqual(memoryCall?.params?.metadata, { lifecycle_state: "candidate", score: 0.7 });
  assert.equal(preferenceCall?.params?.agent_id, "codali");
  assert.equal(preferenceCall?.params?.category, "constraint");
  assert.equal(preferenceCall?.params?.content, "Do not use moment.js");
  assert.deepEqual(preferenceCall?.params?.metadata, {
    dedupe_key: "profile_memory::constraint::do not use moment.js",
  });
});
