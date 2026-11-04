import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MediaJobStore, type MediaJob } from "../MediaJobStore.js";
import { executeRemoteMediaJob, reconcileRemoteMediaJob } from "../RemoteMediaJob.js";
import { atomicWriteJson } from "../../../session/AtomicState.js";
import { orchestrationHash, type OrchestrationConfig } from "../../../config/OrchestrationConfig.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DNsAAAAASUVORK5CYII=";
const result = { model: "image-fixture", data: [{ b64_json: png }] };
const resultSha = createHash("sha256").update(JSON.stringify(result)).digest("hex");
const fixture = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "fixture", providers: { local: { adapter: "openai-compatible", baseUrl: `${origin}/v1`, mediaJobsUrl: `${origin}/v1/media/jobs` } }, models: { image: { provider: "local", catalogId: "image-fixture", revision: "v1", operations: ["images.generations"], contextWindow: 1024, maxOutputTokens: 1 }, text: { provider: "local", catalogId: "text-fixture", revision: "v1", operations: ["chat.completions"], contextWindow: 1024, maxOutputTokens: 1 } }, bindings: { lead: { candidates: ["text"] }, image: { candidates: ["image"] } } };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-remote-media-")); const store = new MediaJobStore(root, "session");
  const at = new Date().toISOString(); const id = randomUUID(); const hash = orchestrationHash(config);
  const job: MediaJob = { schemaVersion: 1, id, sessionId: "session", operation: "images.generations", binding: "image", modelId: "image", catalogId: "image-fixture", providerId: "local", configHash: hash, resolved: { config, hash, source: "fixture" }, request: { model: "image-fixture", prompt: "a pixel" }, status: "running", createdAt: at, updatedAt: at };
  await atomicWriteJson(store.file(id), job);
  const remote = (status: string, additions: Record<string, unknown> = {}) => ({ protocol: "mswarm-media-jobs-v1", client_id: id, job_id: `shj_media_${"a".repeat(64)}`, operation: job.operation, model: job.catalogId, status, ...additions });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); };
  return { job, store, remote, close };
};

test("a lost admission response recovers the original media result without another PUT", async () => {
  let puts = 0; let acks = 0; let current!: Awaited<ReturnType<typeof fixture>>;
  current = await fixture((req, res) => {
    if (req.method === "PUT") { puts++; req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") { acks++; res.end('{"acknowledged":true}'); return; }
    res.end(JSON.stringify(current.remote("succeeded", { result, result_sha256: resultSha })));
  });
  try {
    await assert.rejects(executeRemoteMediaJob(current.store, current.job), /fetch/);
    assert.ok((await current.store.read(current.job.id)).remote?.submissionStartedAt);
    const recovered = await new MediaJobStore(current.store.root, "session").reconcileProcess(current.job.id);
    assert.equal(recovered.status, "succeeded", recovered.error); assert.equal(puts, 1); assert.equal(acks, 1);
    assert.deepEqual(await fs.readFile(recovered.artifact!.path), Buffer.from(png, "base64"));
  } finally { await current.close(); }
});

test("a crash before dispatch remains unresolved and never silently submits on resume", async () => {
  let writes = 0; const f = await fixture((req, res) => { if (req.method !== "GET") writes++; res.statusCode = 404; res.end('{}'); });
  try {
    await f.store.update(f.job.id, state => { state.remote = { protocol: "mswarm-media-jobs-v1", submissionStartedAt: new Date().toISOString() }; });
    const recovered = await f.store.reconcileProcess(f.job.id);
    assert.equal(recovered.status, "uncertain"); assert.equal(writes, 0);
  } finally { await f.close(); }
});

test("remote receipt and payload substitution cannot create an accepted artifact", async () => {
  let mismatch = true; let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture((_req, res) => res.end(JSON.stringify(f.remote("succeeded", { result, result_sha256: mismatch ? resultSha : "0".repeat(64), ...(mismatch ? { client_id: randomUUID() } : {}) }))));
  try {
    const job = await f.store.update(f.job.id, state => { state.remote = { protocol: "mswarm-media-jobs-v1", submissionStartedAt: new Date().toISOString() }; });
    await assert.rejects(reconcileRemoteMediaJob(f.store, job), /identity/);
    mismatch = false;
    await assert.rejects(reconcileRemoteMediaJob(f.store, job), /checksum/);
    assert.equal((await f.store.read(job.id)).artifact, undefined);
  } finally { await f.close(); }
});

test("requested cancellation remains running until a confirmed terminal response", async () => {
  let confirmed = false; let deletes = 0; let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture((req, res) => { if (req.method === "DELETE") deletes++; res.end(JSON.stringify(f.remote(confirmed ? "cancelled" : "running", { cancel_requested: true, cancel_confirmed: confirmed }))); });
  try {
    let job = await f.store.update(f.job.id, state => { state.cancelRequested = true; state.remote = { protocol: "mswarm-media-jobs-v1", submissionStartedAt: new Date().toISOString() }; });
    job = await reconcileRemoteMediaJob(f.store, job); assert.equal(job.status, "running"); assert.equal(job.remote?.cancelConfirmed, false);
    confirmed = true; job = await reconcileRemoteMediaJob(f.store, job); assert.equal(job.status, "cancelled"); assert.equal(deletes, 1);
  } finally { await f.close(); }
});

test("lost acknowledgement does not downgrade a verified local artifact", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture((req, res) => { if (req.method === "POST") { req.socket.destroy(); return; } res.end(JSON.stringify(f.remote("succeeded", { result, result_sha256: resultSha }))); });
  try {
    const job = await f.store.update(f.job.id, state => { state.remote = { protocol: "mswarm-media-jobs-v1", submissionStartedAt: new Date().toISOString() }; });
    const recovered = await reconcileRemoteMediaJob(f.store, job);
    assert.equal(recovered.status, "succeeded"); assert.ok(recovered.artifact); assert.equal(recovered.remote?.acknowledgedAt, undefined);
  } finally { await f.close(); }
});

test("cancelling a remote status read preserves job state and returns control", async () => {
  let requested!: () => void; const ready = new Promise<void>(resolve => { requested = resolve; });
  const f = await fixture(() => { requested(); });
  try {
    await f.store.update(f.job.id, state => { state.remote = { protocol: "mswarm-media-jobs-v1", submissionStartedAt: new Date().toISOString() }; });
    const abort = new AbortController(); const pending = f.store.reconcileProcess(f.job.id, abort.signal);
    await Promise.race([ready, pending.then(() => { throw new Error("Status read finished before contacting the fixture service"); })]); const at = Date.now(); abort.abort(); await assert.rejects(pending, /abort/i);
    assert.ok(Date.now() - at < 250); assert.equal((await f.store.read(f.job.id)).status, "running");
  } finally { await f.close(); }
});
