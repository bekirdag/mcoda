import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { retrieveSemanticTools } from "../SemanticToolRetrieval.js";
import type { ConfiguredEmbeddings } from "../../providers/ConfiguredEmbeddings.js";
import type { ToolDefinition } from "../ToolTypes.js";
test("semantic metadata cache pins model/content and charges every query without caching private text", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-selector-test-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const fake = { space: { id: "space-v1", dimensions: 2 }, embed: async (input: string[], purpose: string) => {
    calls.push(purpose); return purpose === "query" ? [[1, 0]] : input.map(text => text.includes("alpha") ? [1, 0] : [0, 1]);
  } } as unknown as ConfiguredEmbeddings;
  const tools: ToolDefinition[] = ["alpha", "beta"].map(name => ({ name, description: name, handler: async () => ({ output: "" }) }));
  const first = await retrieveSemanticTools("private query", tools, fake, root);
  assert.equal(first.ranked[0].tool.name, "alpha"); assert.equal(first.evidence.cacheHit, false);
  const second = await retrieveSemanticTools("different private query", tools, fake, root);
  assert.equal(second.evidence.cacheHit, true); assert.deepEqual(calls, ["document", "query", "query"]);
  const cache = await fs.readFile(path.join(root, "space-v1", `${first.evidence.catalogHash}.json`), "utf8"); assert.ok(!cache.includes("private query"));
  tools[0].description = "alpha changed";
  const third = await retrieveSemanticTools("query", tools, fake, root); assert.notEqual(third.evidence.catalogHash, first.evidence.catalogHash); assert.equal(third.evidence.cacheHit, false);
});
