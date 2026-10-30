import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuredEmbeddingSpace, loadOrchestrationConfig, orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { proposeTerminalModel, saveTerminalModel } from "../TerminalModels.js";

const config: OrchestrationConfig = {
  schemaVersion: 1, profile: "selection-test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
  models: {
    primary: { provider: "local", catalogId: "primary", revision: "1", backend: "strata", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true },
    alternate: { provider: "local", catalogId: "alternate", revision: "1", backend: "strata", operations: ["chat.completions"], contextWindow: 16384, maxOutputTokens: 2048, supportsTools: true },
    forbidden: { provider: "local", catalogId: "forbidden", revision: "1", backend: "other", operations: ["chat.completions"], contextWindow: 16384, maxOutputTokens: 2048, supportsTools: true },
    embed: { provider: "local", catalogId: "embed", revision: "sha256:pinned", operations: ["embeddings"], contextWindow: 8192, maxOutputTokens: 1, embeddingDimensions: 2, embedding: { queryPrefix: "query: ", documentPrefix: "document: ", normalization: "l2", pooling: "mean" } },
  },
  bindings: { lead: { candidates: ["primary"] }, reviewer: { useBinding: "lead" }, helper: { enabled: false }, retrieval: { candidates: ["embed"], embeddingSpace: "pinned" }, embedding: { useBinding: "retrieval" } },
  routing: { strategy: "capability-and-capacity", requiredBackends: { lead: ["strata"], reviewer: ["strata"] } },
};
config.models.replica = { ...structuredClone(config.models.embed), catalogId: "replica" };
config.models.incompatible = { ...structuredClone(config.models.embed), catalogId: "incompatible", revision: "sha256:another" };
const resolved = { config, hash: orchestrationHash(config), source: "fixture" };

test("selection changes only an existing binding and retains shared limits and aliases", () => {
  const before = JSON.stringify(config);
  const next = proposeTerminalModel(resolved, "lead", "alternate");
  assert.deepEqual(next.config.bindings.lead, { enabled: true, candidates: ["alternate"] });
  assert.deepEqual(next.config.bindings.reviewer, { useBinding: "lead" });
  assert.deepEqual(next.config.routing, config.routing); assert.deepEqual(next.config.models, config.models);
  assert.equal(JSON.stringify(config), before); assert.notEqual(next.hash, resolved.hash);
  assert.deepEqual(proposeTerminalModel(resolved, "helper", "alternate").config.bindings.helper, { enabled: true, candidates: ["alternate"] });
  for (const [binding, model] of [["unknown", "primary"], ["lead", "unknown"], ["lead", "__proto__"], ["toString", "primary"], ["lead", "forbidden"], ["lead", "embed"]]) assert.throws(() => proposeTerminalModel(resolved, binding, model));
});

test("compatible embedding replicas retain vector identity and incompatible selection cannot reuse an index", () => {
  const next = proposeTerminalModel(resolved, "embedding", "replica");
  assert.equal(configuredEmbeddingSpace(next.config).id, configuredEmbeddingSpace(config).id);
  assert.equal(next.config.bindings.embedding.embeddingSpace, "pinned");
  assert.throws(() => proposeTerminalModel(resolved, "embedding", "incompatible"), /fresh session.*separate index/);
});

test("saving model choices detects concurrent edits and cancellation without overwriting shared settings", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-model-selection-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json"); await fs.writeFile(file, JSON.stringify(config));
  const original = await loadOrchestrationConfig(file);
  const a = proposeTerminalModel(original, "lead", "alternate"); const b = proposeTerminalModel(original, "helper", "alternate");
  const signal = new AbortController().signal;
  const results = await Promise.allSettled([saveTerminalModel(original, a, signal), saveTerminalModel(original, b, signal)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /changed on disk/);
  const current = await loadOrchestrationConfig(file); assert.ok([a.hash, b.hash].includes(current.hash));
  assert.deepEqual(current.config.routing, config.routing);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(saveTerminalModel(current, proposeTerminalModel(current, "lead", "primary"), cancelled.signal), /abort/i);
  assert.equal((await loadOrchestrationConfig(file)).hash, current.hash);
  await assert.rejects(saveTerminalModel(current, { ...current, hash: "forged" }, signal), /hash mismatch/);
  await assert.rejects(saveTerminalModel(current, { ...current, source: path.join(root, "elsewhere.json") }, signal), /retain.*source/);
});
