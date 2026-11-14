import test from "node:test";
import assert from "node:assert/strict";
import { DocdexClient } from "../DocdexClient.js";
import { DocdexRuntimeError } from "../DocdexClient.js";

test("retrieval accounting runs before dispatch and can stop hidden HTTP work", async () => {
  const original = globalThis.fetch; let requests = 0; let reservations = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ hits: [] }); };
  const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoRoot: process.cwd(), repoId: "test", localSearchOnly: true,
    beforeRequest: () => { reservations++; throw new Error("Retrieval budget exhausted"); } });
  try {
    await assert.rejects(client.search("query"), /Retrieval budget exhausted/);
    assert.ok(reservations > 0); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test("cancellation while reserving retrieval never sends the request", async () => {
  const original = globalThis.fetch; const abort = new AbortController(); let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ hits: [] }); };
  const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoRoot: process.cwd(), repoId: "test", localSearchOnly: true,
    signal: () => abort.signal, beforeRequest: async () => { abort.abort(new Error("Host stopped retrieval")); } });
  try {
    await assert.rejects(client.search("query"), /Host stopped retrieval/); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

for (const outcome of ["ok", "unavailable", "mismatched", "malformed"]) test(`local search never enters the web waterfall (${outcome})`, async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url.endsWith("/healthz")) return new Response("ok");
    assert.ok(url.endsWith("/v1/search/batch")); assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { queries: ["retryLimit"], limit: 3, include_libs: false, repo_id: "fixture" });
    if (outcome === "unavailable") return Response.json({ error: "unsupported" }, { status: 404 });
    if (outcome === "malformed") return Response.json({ results: [] });
    return Response.json({ results: [{ query: outcome === "mismatched" ? "different" : "retryLimit", response: { hits: [{ path: "src/settings.js", snippet: "retryLimit = 7" }] } }], truncated: false });
  });
  const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoId: "fixture", localSearchOnly: true });
  if (outcome === "ok") assert.match(JSON.stringify(await client.search("retryLimit", { limit: 3 })), /retryLimit = 7/);
  else await assert.rejects(client.search("retryLimit", { limit: 3 }));
  assert.equal(requests.length, 2);
  await assert.rejects(client.search("outside", { forceWeb: true }), /separately authorized/);
  assert.equal(requests.length, 2);
});

for (const error of [new DOMException("Timed out", "TimeoutError"),
  new DocdexRuntimeError("docdex_unavailable", "Proxy timed out", { status: 500 }),
  new DocdexRuntimeError("docdex_auth_failed", "Denied", { status: 401 })]) {
  test(`web research does not replay an uncertain or denied request: ${error.message}`, async t => {
    const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoId: "fixture" });
    t.mock.method(client, "callMcp", async () => { throw error; });
    const fallback = t.mock.method(globalThis, "fetch", async () => { throw new Error("No HTTP replay allowed"); });
    await assert.rejects(client.webResearch("official documentation"), value => value === error);
    assert.equal(fallback.mock.callCount(), 0);
  });
}
