import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { MediaJobStore, validateMediaRequest, type MediaJob } from "../MediaJobStore.js";
import { persistMediaArtifact } from "../MediaArtifactReceipt.js";
import { atomicWriteJson, withStateLock } from "../../../session/AtomicState.js";
import { createConfiguredMediaTools } from "../ConfiguredMediaTools.js";
import { orchestrationHash, type OrchestrationConfig } from "../../../config/OrchestrationConfig.js";

const descriptor = { type: "images.generations", supported_parameters: ["model", "prompt", "size", "n", "response_format", "steps"], response_formats: ["b64_json"], limits: { max_width: 512, max_height: 512, min_width: 64, min_height: 64, max_pixels: 262144, max_steps: 10 } };

test("artifact receipt reconciles a crash before completion without trusting a reused PID", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-media-recovery-"));
  const store = new MediaJobStore(root, "session");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DNsAAAAASUVORK5CYII=", "base64");
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "fixture", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { image: { provider: "local", catalogId: "image", revision: "v1", operations: ["images.generations"], contextWindow: 1024, maxOutputTokens: 1 } }, bindings: { image: { candidates: ["image"] } } };
  const job: MediaJob = { schemaVersion: 1, id: "job", sessionId: "session", operation: "images.generations", binding: "image", modelId: "image", catalogId: "image", providerId: "local", configHash: orchestrationHash(config), resolved: { config, hash: orchestrationHash(config), source: "fixture" }, request: { prompt: "Pixel", model: "image" }, status: "running", pid: process.pid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try {
    await atomicWriteJson(store.file(job.id), job);
    const artifact = await persistMediaArtifact(path.dirname(store.file(job.id)), job, png);
    const recovered = await new MediaJobStore(root, "session").reconcileProcess(job.id);
    assert.equal(recovered.status, "succeeded"); assert.deepEqual(recovered.artifact, artifact);
    await store.update(job.id, state => { state.status = "running"; delete state.artifact; });
    await fs.writeFile(artifact.path, Buffer.alloc(png.length));
    const corrupt = await store.reconcileProcess(job.id);
    assert.equal(corrupt.status, "uncertain"); assert.match(corrupt.error!, /checksum|format/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("media reconciliation does not wait behind an active execution lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-media-lock-"));
  const store = new MediaJobStore(root, "session");
  const job = { schemaVersion: 1, id: "job", sessionId: "session", status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  await atomicWriteJson(store.file("job"), job);
  const worker = withStateLock(`${store.file("job")}.execution`, async () => { entered(); await wait; });
  try {
    await ready;
    const started = Date.now(); assert.equal((await store.reconcileProcess("job")).status, "running"); assert.ok(Date.now() - started < 500);
    release(); await worker;
    assert.equal((await store.reconcileProcess("job")).status, "uncertain");
  } finally { release(); await worker; await fs.rm(root, { recursive: true, force: true }); }
});
test("media parameters must fit the advertised operation contract", () => {
  assert.equal(validateMediaRequest({ prompt: "test", size: "512x512", steps: 4 }, descriptor, "images.generations").response_format, "b64_json");
  for (const request of [{ prompt: "test", size: "1024x512" }, { prompt: "test", steps: 11 }, { prompt: "test", url: "http://private" }, { prompt: "test", model: "unconfigured" }]) assert.throws(() => validateMediaRequest(request, descriptor, "images.generations"));
});

test("cancelling a media wait returns promptly without cancelling or resubmitting the render", async () => {
  let polls = 0;
  const store = { reconcileProcess: async () => { polls++; return { id: "job", status: "running" }; } } as unknown as MediaJobStore;
  const tools = createConfiguredMediaTools({ config: { bindings: {} } } as never, () => store);
  const abort = new AbortController(); const started = Date.now();
  const waiting = tools.find(t => t.name === "media_job_wait")!.handler({ jobId: "job", waitSeconds: 600 }, { workspaceRoot: "/tmp", signal: abort.signal, onOutput: () => abort.abort() });
  await assert.rejects(waiting, /abort/i);
  assert.equal(polls, 1); assert.ok(Date.now() - started < 250);
});

test("media worker persists artifacts independently of the submitting client and export verifies checksums", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-media-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codali-media-workspace-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DNsAAAAASUVORK5CYII=", "base64");
  let submissions = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "media", operations: [descriptor] }] })); return; }
    if (request.url === "/v1/images/generations") {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const sent = JSON.parse(body); assert.equal(sent.model, "media"); assert.equal(sent.n, 1); submissions++;
      await new Promise(resolve => setTimeout(resolve, 100)); response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })); return;
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "media-test", providers: { fixture: { adapter: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1` } }, models: { image: { provider: "fixture", catalogId: "media", revision: "1", operations: ["images.generations"], contextWindow: 8192, maxOutputTokens: 1 } }, bindings: { lead: { candidates: ["image"] }, image: { candidates: ["image"] } } };
  try {
    const store = new MediaJobStore(root, "session");
    const job = await store.submit({ config, hash: orchestrationHash(config), source: "fixture" }, "image", "images.generations", { prompt: "A pixel", size: "64x64" });
    const reopened = new MediaJobStore(root, "session");
    let current = await reopened.read(job.id);
    const deadline = Date.now() + 10000;
    while (["queued", "running"].includes(current.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); current = await reopened.read(job.id); }
    assert.equal(current.status, "succeeded", current.error); assert.equal(submissions, 1);
    assert.equal(current.artifact?.bytes, png.length);
    await reopened.exportArtifact(job.id, workspace, "pixel.png");
    assert.deepEqual(await fs.readFile(path.join(workspace, "pixel.png")), png);
    await assert.rejects(reopened.exportArtifact(job.id, workspace, "pixel.png"), /EEXIST/);
    await fs.writeFile(current.artifact!.path, "corrupt");
    await assert.rejects(reopened.exportArtifact(job.id, workspace, "second.png"), /checksum/);
    await assert.rejects(new MediaJobStore(root, "another-session").read(job.id), /another session/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); await fs.rm(workspace, { recursive: true, force: true }); }
});
