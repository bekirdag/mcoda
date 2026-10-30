import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTerminalConfig } from "../TerminalCommand.js";
import { resolveBinding } from "../../config/OrchestrationConfig.js";
import { ConfiguredProvider } from "../../providers/ConfiguredProvider.js";

test("setup pins only compatible qualified embedding replicas and never treats an update timestamp as a model revision", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-setup-embedding-"));
  const originalFetch = globalThis.fetch; const originalKey = process.env.MCODA_MSWARM_API_KEY;
  t.after(async () => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.MCODA_MSWARM_API_KEY; else process.env.MCODA_MSWARM_API_KEY = originalKey; await fs.rm(root, { recursive: true, force: true }); });
  process.env.MCODA_MSWARM_API_KEY = "setup-embedding-fixture";
  const embedding = { queryPrefix: "query: ", documentPrefix: "document: ", normalization: "l2", pooling: "mean" };
  const model = { health_status: "healthy", digest: `sha256:${"a".repeat(64)}`, embedding, operations: [{ type: "embeddings", limits: { embedding_dimensions: 768 } }] };
  const lead = { slug: "lead", adapter: "strata-local", supports_tools: true, health_status: "healthy", updated_at: "2026-10-26", operations: [{ type: "chat.completions" }] };
  let entries = [
    { ...model, slug: "b-replica" }, { ...model, slug: "a-selected" },
    { ...model, slug: "c-different-weights", digest: `sha256:${"b".repeat(64)}` },
    { ...model, slug: "d-different-prefix", embedding: { ...embedding, queryPrefix: "different: " } },
    { ...model, slug: "0-unhealthy", health_status: "unreachable" },
    { ...model, slug: "0-pool", load_balanced: true },
    { ...model, slug: "0-no-digest", digest: "latest" },
    { ...model, slug: "0-invalid-preprocessing", embedding: { ...embedding, pooling: "" } },
    { ...model, slug: "0-invalid-size", operations: [{ type: "embeddings", limits: { embedding_dimensions: 5000 } }] },
  ];
  const unqualifiedIntent = { slug: "local-qwen3-4b-instruct-2507", adapter: "llama-cpp-local", health_status: "healthy", operations: [{ type: "chat.completions" }] };
  globalThis.fetch = async input => String(input).endsWith("/v1/media/jobs") ? Response.json({}, { status: 404 }) : Response.json({ agents: [lead, unqualifiedIntent, ...entries] });
  const selected = await setupTerminalConfig(path.join(root, "selected.json"));
  assert.deepEqual(selected.config.bindings.embedding.candidates, ["a-selected", "b-replica"]);
  assert.deepEqual(selected.config.models["a-selected"].embedding, embedding);
  assert.equal(selected.config.models["a-selected"].revision, model.digest);
  assert.equal(selected.config.models.lead.revision, "catalog-unversioned");
  assert.deepEqual(selected.config.bindings.intent, { useBinding: "lead" }, "healthy small-model availability is not current dispatch qualification");
  assert.equal(selected.config.interaction?.promptVersion, "interaction-v11");
  assert.equal(selected.config.models["c-different-weights"], undefined);
  const failedPath = path.join(root, "failed-runtime.json");
  await assert.rejects(setupTerminalConfig(failedPath, { prepareRuntime: async () => { throw new Error("unqualified runtime"); } }), /unqualified runtime/);
  await assert.rejects(fs.stat(failedPath), /ENOENT/);
  const prepared = await setupTerminalConfig(path.join(root, "qualified-runtime.json"), { prepareRuntime: async () => ({ binary: "/private/docdexd", binarySha256: "c".repeat(64), version: "0.0.0-test" }) });
  assert.deepEqual(prepared.config.docdex, { binary: "/private/docdexd", binarySha256: "c".repeat(64) });
  entries = entries.filter(entry => entry.slug.startsWith("0-"));
  const unavailable = await setupTerminalConfig(path.join(root, "unavailable.json"));
  assert.deepEqual(unavailable.config.bindings.embedding, { enabled: false });
});

test("setup pins local specialist media, preserves multiple operations and rejects backend drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-setup-"));
  const originalFetch = globalThis.fetch; const originalKey = process.env.MCODA_MSWARM_API_KEY;
  const urls: string[] = []; process.env.MCODA_MSWARM_API_KEY = "setup-fixture-key";
  let mediaBackend = "openai-compatible-local";
  globalThis.fetch = async input => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/v1/media/jobs")) return Response.json({ protocol: "mswarm-media-jobs-v1" });
    return Response.json({ agents: [
      { slug: "fixture-strata", adapter: "strata-local", supports_tools: true, health_status: "healthy", context_window: 32768, operations: [{ type: "chat.completions" }, { type: "images.generations" }, { type: "audio.generations" }] },
      { slug: "fixture-local-media", adapter: mediaBackend, health_status: "healthy", operations: [{ type: "images.generations" }, { type: "audio.generations" }] },
      { slug: "fixture-cloud-media", adapter: "cloud", health_status: "healthy", operations: [{ type: "images.generations" }, { type: "videos.generations" }] },
      { slug: "fixture-unknown-video", health_status: "healthy", operations: [{ type: "videos.generations" }] },
    ] });
  };
  try {
    const result = await setupTerminalConfig(path.join(root, "orchestration.json"));
    assert.equal(result.config.providers.mswarm.mediaJobsUrl, "https://api.mswarm.org/v1/media/jobs");
    assert.equal(resolveBinding(result.config, "lead", "chat.completions")[0].model.backend, "strata");
    assert.equal(resolveBinding(result.config, "image", "images.generations")[0].id, "fixture-local-media");
    assert.equal(resolveBinding(result.config, "audio", "audio.generations")[0].id, "fixture-local-media");
    assert.equal(result.config.models["fixture-local-media"].backend, "openai-compatible-local");
    assert.equal(result.config.models["fixture-cloud-media"], undefined);
    assert.equal(result.config.models["fixture-unknown-video"], undefined);
    assert.equal(result.config.bindings.video.enabled, false);
    assert.equal(urls.length, 2); assert.equal(urls.some(url => url.endsWith("/completions")), false);
    mediaBackend = "cloud";
    await assert.rejects(new ConfiguredProvider(result, "image").select("images.generations"), /backend identity not verified/);
    await assert.rejects(setupTerminalConfig(result.source), /already exists/);
  } finally { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.MCODA_MSWARM_API_KEY; else process.env.MCODA_MSWARM_API_KEY = originalKey; await fs.rm(root, { recursive: true, force: true }); }
});

test("older servers remain explicitly synchronous and authentication failures do not become capability absence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-setup-legacy-")); const originalFetch = globalThis.fetch; const originalKey = process.env.MCODA_MSWARM_API_KEY;
  process.env.MCODA_MSWARM_API_KEY = "setup-fixture-key"; let status = 404;
  globalThis.fetch = async input => String(input).endsWith("/v1/media/jobs") ? Response.json({ error: { message: "Unavailable" } }, { status }) : Response.json({ agents: [{ slug: "fixture-strata", adapter: "strata-local", supports_tools: true, health_status: "healthy", operations: [{ type: "chat.completions" }] }] });
  try {
    const result = await setupTerminalConfig(path.join(root, "legacy.json")); assert.equal(result.config.providers.mswarm.mediaJobsUrl, undefined);
    status = 403; await assert.rejects(setupTerminalConfig(path.join(root, "forbidden.json")), { name: "ModelServiceError", status: 403 });
    await assert.rejects(fs.stat(path.join(root, "forbidden.json")), /ENOENT/);
  } finally { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.MCODA_MSWARM_API_KEY; else process.env.MCODA_MSWARM_API_KEY = originalKey; await fs.rm(root, { recursive: true, force: true }); }
});
