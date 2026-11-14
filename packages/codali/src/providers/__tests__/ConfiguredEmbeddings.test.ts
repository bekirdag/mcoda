import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuredEmbeddingSpace, validateOrchestrationConfig, orchestrationHash } from "../../config/OrchestrationConfig.js";
import { ConfiguredEmbeddings, type EmbeddingReceipt, type EmbeddingIntent } from "../ConfiguredEmbeddings.js";

function config(baseUrl: string) {
  return validateOrchestrationConfig({ schemaVersion: 1, profile: "embedding-test", providers: { local: { adapter: "openai-compatible", baseUrl } },
    models: { text: { provider: "local", catalogId: "text", revision: "r1", operations: ["chat.completions"], contextWindow: 4096, maxOutputTokens: 100 },
      embed: { provider: "local", catalogId: "embed", revision: "sha256:pinned-artifact", operations: ["embeddings"], contextWindow: 8192, maxOutputTokens: 1,
        embeddingDimensions: 2, embedding: { queryPrefix: "search_query: ", documentPrefix: "search_document: ", normalization: "l2", pooling: "mean" } } },
    bindings: { lead: { candidates: ["text"] }, embedding: { candidates: ["embed"], embeddingSpace: "nomic-test-v1" } } });
}

test("embedding identities reject unpinned or incompatible failover candidates", () => {
  const value = config("http://127.0.0.1:1234/v1");
  const compatible = structuredClone(value);
  compatible.models.second = { ...compatible.models.embed, host: "other-host", catalogId: "other-catalog-id" };
  compatible.bindings.embedding.candidates!.push("second");
  assert.equal(configuredEmbeddingSpace(compatible).id, configuredEmbeddingSpace(value).id);
  compatible.models.second.embeddingDimensions = 3;
  assert.throws(() => validateOrchestrationConfig(compatible), /incompatible/);
  value.models.embed.revision = "catalog-unversioned";
  assert.throws(() => validateOrchestrationConfig(value), /pinned/);
});

test("configured embeddings prefix queries, validate results, report usage and fence index upgrades", async () => {
  let received: Record<string, unknown> | undefined;
  let bad = false;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "embed" }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString());
    response.end(JSON.stringify({ model: "embed", data: [{ index: 0, embedding: bad ? [1] : [3, 4] }], usage: { prompt_tokens: 8, total_tokens: 8 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const value = config(`http://127.0.0.1:${address.port}/v1`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-embedding-"));
  const receipts: EmbeddingReceipt[] = [];
  const client = new ConfiguredEmbeddings({ config: value, hash: orchestrationHash(value), source: "test" }, async receipt => { receipts.push(receipt); });
  try {
    await client.pin(root); await client.pin(root);
    assert.deepEqual(await client.embed(["hello"], "query"), [[0.6, 0.8]]);
    assert.deepEqual(received?.input, ["search_query: hello"]);
    assert.equal(receipts[0].reportedTokens, 8);
    bad = true;
    await assert.rejects(client.embed(["hello"], "document"), /dimension/);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].status, "succeeded");
    assert.equal(receipts[1].status, "failed");
    assert.equal(receipts[1].failureCode, "invalid_response");
    assert.equal(receipts[1].reportedTokens, undefined);
    value.models.embed.revision = "sha256:new-artifact";
    const upgraded = new ConfiguredEmbeddings({ config: value, hash: orchestrationHash(value), source: "test" });
    await assert.rejects(upgraded.pin(root), /rebuild into a separate index/);
    const persisted = JSON.parse(await fs.readFile(path.join(root, "embedding-space.json"), "utf8"));
    assert.equal(persisted.space.id, client.space.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("embedding failures settle each admitted intent without leaking input or inventing usage", async () => {
  const privateInput = "private repository objective";
  let outcome: "relay" | "http" | "aborted" = "relay";
  const controller = new AbortController();
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "embed" }] })); return; }
    for await (const _ of request) { /* drain the submitted request */ }
    if (outcome === "aborted") { controller.abort(); return; }
    response.statusCode = outcome === "http" ? 502 : 200;
    response.end(JSON.stringify({ error: { code: "upstream_error", message: privateInput } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = config(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
  const receipts: EmbeddingReceipt[] = [];
  const intents: EmbeddingIntent[] = [];
  const client = new ConfiguredEmbeddings({ config: value, hash: orchestrationHash(value), source: "test" },
    async receipt => { receipts.push(receipt); }, async intent => { intents.push(intent); });
  try {
    await assert.rejects(client.embed([privateInput], "query"), /Embedding upstream execution failed/);
    outcome = "http";
    await assert.rejects(client.embed([privateInput], "document"));
    outcome = "aborted";
    await assert.rejects(client.embed([privateInput], "query", controller.signal));
    assert.equal(receipts.length, 3);
    assert.deepEqual(receipts.map(receipt => receipt.id), intents.map(intent => intent.id));
    assert.deepEqual(receipts.map(receipt => receipt.failureCode), ["upstream_error", "request_failed", "aborted"]);
    assert.ok(receipts.every(receipt => receipt.status === "failed" && receipt.reportedTokens === undefined));
    assert.ok(intents.every(intent => intent.estimatedTokens > 0));
    assert.ok(!JSON.stringify(receipts).includes(privateInput));
    const denied = new ConfiguredEmbeddings({ config: value, hash: orchestrationHash(value), source: "test" },
      async receipt => { receipts.push(receipt); }, async () => { throw new Error("Budget exhausted"); });
    await assert.rejects(denied.embed([privateInput], "query"), /Budget exhausted/);
    assert.equal(receipts.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
