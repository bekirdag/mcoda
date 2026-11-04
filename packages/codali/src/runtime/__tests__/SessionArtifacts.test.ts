import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionController } from "../SessionController.js";
import { WorkspaceLock } from "../WorkspaceLock.js";
import type { MediaJob } from "../../connectors/media/MediaJobStore.js";
import { persistMediaArtifact } from "../../connectors/media/MediaArtifactReceipt.js";
import { atomicWriteJson } from "../../session/AtomicState.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { artifactViewer, openTerminalArtifact } from "../../cli/TerminalArtifacts.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DNsAAAAASUVORK5CYII=", "base64");
const config: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["model"] } } };
const resolved = { config, hash: orchestrationHash(config), source: "test" };
const seed = async (controller: SessionController) => {
  await controller.start("Keep the original goal and verification requirements");
  const store = controller.mediaStore(); const now = new Date().toISOString();
  const job: MediaJob = { schemaVersion: 1, id: "job", sessionId: controller.sessionId!, operation: "images.generations", binding: "image", modelId: "image", catalogId: "image", providerId: "local", configHash: resolved.hash, resolved, request: { prompt: "Pixel" }, status: "succeeded", createdAt: now, updatedAt: now };
  await atomicWriteJson(store.file(job.id), job);
  job.artifact = await persistMediaArtifact(path.dirname(store.file(job.id)), job, png);
  await atomicWriteJson(store.file(job.id), job);
  return { store, job };
};

test("explicit export obeys approvals, cancellation, workspace locks and completion evidence", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codali-artifact-action-")));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let entered!: () => void; const approval = new Promise<void>(resolve => { entered = resolve; });
  const controller = new SessionController({ workspaceRoot: workspace, storageRoot: path.join(root, "state"), resolved, docdex: false, permissions: "ask",
    approve: async (_request, signal) => { entered(); return new Promise(resolve => { signal!.addEventListener("abort", () => resolve({ allow: false }), { once: true }); if (signal!.aborted) resolve({ allow: false }); }); } });
  await seed(controller);
  const exporting = controller.exportArtifact("job", "user export.png");
  await approval; assert.equal(controller.busy, true); controller.cancel();
  await assert.rejects(exporting, /Cancelled/);
  assert.equal(controller.busy, false); await assert.rejects(fs.access(path.join(workspace, "user export.png")));
  controller.gate.setProfile("plan");
  await assert.rejects(controller.exportArtifact("job", "denied.png"), /Planning mode/);
  controller.gate.setProfile("workspace");
  const other = new WorkspaceLock(path.dirname(controller.store.storageDir), "another-session"); await other.acquire();
  try { await assert.rejects(controller.exportArtifact("job", "locked.png"), /locked/); } finally { await other.release(); }
  const fence = path.join(path.dirname(controller.store.storageDir), "workspace-invocation.json");
  await atomicWriteJson(fence, { invocationId: "unresolved" });
  await assert.rejects(controller.exportArtifact("job", "fenced.png"), /unresolved workspace/); await fs.unlink(fence);
  await assert.rejects(controller.exportArtifact("job", "../escape.png"), /escapes/);
  await fs.mkdir(path.join(workspace, ".git"));
  await assert.rejects(controller.exportArtifact("job", ".git/config"), /control metadata/);
  const exported = await controller.exportArtifact("job", "user export.png");
  assert.deepEqual(await fs.readFile(exported.path), png);
  await assert.rejects(controller.exportArtifact("job", "user export.png"), /EEXIST/);
  assert.equal(controller.state!.evidence.length, 0); assert.notEqual(controller.state!.status, "completed");
  const events = await controller.store.readTranscript(controller.sessionId!);
  assert.ok(events.some(item => (item.data.event as { type: string })?.type === "artifact_exported"));
});

test("viewer choices explain headless and unsupported desktops", () => {
  assert.equal(artifactViewer("darwin", {}), "open");
  assert.equal(artifactViewer("linux", { DISPLAY: ":1" }), "xdg-open");
  assert.equal(artifactViewer("linux", { WAYLAND_DISPLAY: "wayland-0" }), "xdg-open");
  assert.throws(() => artifactViewer("linux", {}), /export JOB_ID PATH/);
  assert.throws(() => artifactViewer("win32", {}), /download/);
});

test("opening an artifact passes its verified path literally and refuses corrupt or forged receipts", { skip: process.platform !== "linux" }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codali viewer $(literal) '-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  const controller = new SessionController({ workspaceRoot: workspace, storageRoot: path.join(root, "state"), resolved, docdex: false });
  const { store, job } = await seed(controller); const bin = path.join(root, "bin"); await fs.mkdir(bin);
  const log = path.join(root, "opened.json");
  await fs.writeFile(path.join(bin, "xdg-open"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const previous = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY };
  process.env.PATH = bin; process.env.DISPLAY = ":fixture";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const active = new AbortController();
  assert.equal(await openTerminalArtifact(store, "job", active.signal), job.artifact!.path);
  assert.deepEqual(JSON.parse(await fs.readFile(log, "utf8")), [job.artifact!.path]); await fs.unlink(log);
  active.abort(); await assert.rejects(openTerminalArtifact(store, "job", active.signal), /abort/i);
  await fs.writeFile(job.artifact!.path, Buffer.alloc(png.length));
  await assert.rejects(openTerminalArtifact(store, "job", new AbortController().signal), /checksum|format/);
  await fs.writeFile(job.artifact!.path, png);
  await store.update("job", item => { item.artifact!.path = path.join(root, "outside.png"); });
  await assert.rejects(openTerminalArtifact(store, "job", new AbortController().signal), /durable receipt/);
  await assert.rejects(fs.access(log));
});
