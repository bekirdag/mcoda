import test from "node:test";
import assert from "node:assert/strict";
import { DocdexClient } from "../DocdexClient.js";

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
