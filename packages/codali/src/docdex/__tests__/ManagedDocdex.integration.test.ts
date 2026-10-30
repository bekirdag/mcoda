import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagedDocdex } from "../ManagedDocdex.js";
import { inspectManagedDocdexRuntime } from "../ManagedRuntime.js";
import { ConfiguredEmbeddings, type EmbeddingReceipt } from "../../providers/ConfiguredEmbeddings.js";
import { orchestrationHash, validateOrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { workspaceGit } from "../../runtime/WorkspaceSnapshot.js";

// The real daemon is deliberate: HTTP stubs cannot detect hidden workspace writes
// or mismatched MCP authentication and embedding configuration.
test("managed Docdex preserves the workspace, persists scoped memory and refuses incompatible embeddings", {
  skip: !process.env.CODALI_TEST_DOCDEX_BINARY, timeout: 120_000,
}, async () => {
  const runtime = await inspectManagedDocdexRuntime(process.env.CODALI_TEST_DOCDEX_BINARY!);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-managed-docdex-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "Metrics listen on port 5123.\n");
  await fs.writeFile(path.join(workspace, "source.js"), "export function probe() { return 1; }\n");
  await workspaceGit(workspace, ["init"]);
  const baseline = await workspaceGit(workspace, ["status", "--porcelain"]);
  const receipts: EmbeddingReceipt[] = [];
  const inputs: string[] = [];
  let invalid = false;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "embed" }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    inputs.push(...body.input);
    response.end(JSON.stringify({ model: "embed", data: body.input.map((_: string, index: number) => ({ index, embedding: invalid ? [1] : [3, 4] })), usage: { prompt_tokens: 8, total_tokens: 8 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = validateOrchestrationConfig({ schemaVersion: 1, profile: "managed-docdex-test",
    providers: { local: { adapter: "openai-compatible", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` } },
    models: {
      text: { provider: "local", catalogId: "text", revision: "r1", operations: ["chat.completions"], contextWindow: 4096, maxOutputTokens: 100 },
      embed: { provider: "local", catalogId: "embed", revision: "sha256:test", operations: ["embeddings"], contextWindow: 8192, maxOutputTokens: 1,
        embeddingDimensions: 2, embedding: { queryPrefix: "search_query: ", documentPrefix: "search_document: ", normalization: "l2", pooling: "mean" } },
    }, bindings: { lead: { candidates: ["text"] }, embedding: { candidates: ["embed"], embeddingSpace: "fixture-v1" } } });
  const embeddings = new ConfiguredEmbeddings({ config, hash: orchestrationHash(config), source: "test" }, async receipt => { receipts.push(receipt); });
  const create = (binarySha256 = runtime.binarySha256) => new ManagedDocdex({ workspaceRoot: workspace, stateRoot: path.join(root, "state"), embeddings,
    binary: runtime.binary, binarySha256, startupTimeoutMs: 30_000,
    provider: { name: "no-hidden-inference", generate: async () => { throw new Error("Unexpected hidden text inference"); } },
  });
  let managed = create();
  try {
    const rejected = create("0".repeat(64));
    await assert.rejects(rejected.start(), /runtime checksum mismatch/); await rejected.close();
    assert.equal(inputs.length, 0);
    let client = await managed.start();
    await client.waitForIndex(30_000);
    await client.indexIngest("source.js");
    const symbols = await client.symbols("source.js") as { outcome: { status: string }; symbols: Array<{ name: string }> };
    assert.equal(symbols.outcome.status, "ok");
    assert.ok(symbols.symbols.some(symbol => symbol.name === "probe"));
    assert.equal((await client.impactGraph("source.js") as { source: string }).source, "source.js");
    await client.memorySave("Metrics listen on port 5123.");
    assert.match(JSON.stringify(await client.memoryRecall("metrics port")), /5123/);
    await client.savePreference("managed-test", "constraint", "Keep metrics on port 5123.");
    invalid = true;
    await assert.rejects(client.memorySave("This must not be stored with a hash fallback."), /embedding|inference/i);
    invalid = false;
    await managed.close();
    managed = create(); client = await managed.start();
    assert.match(JSON.stringify(await client.memoryRecall("metrics port")), /5123/);
    assert.doesNotMatch(JSON.stringify(await client.memoryRecall("fallback")), /must not be stored/);
    assert.match(JSON.stringify(await client.getProfile("managed-test")), /5123/);
    assert.ok(inputs.some(input => input.startsWith("search_query: ")));
    assert.ok(inputs.some(input => input.startsWith("search_document: ")));
    assert.ok(receipts.some(receipt => receipt.purpose === "query"));
    assert.ok(receipts.some(receipt => receipt.purpose === "document"));
    assert.equal(await workspaceGit(workspace, ["status", "--porcelain"]), baseline);
    await assert.rejects(fs.stat(path.join(workspace, ".docdex")), { code: "ENOENT" });
  } finally {
    await managed.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
