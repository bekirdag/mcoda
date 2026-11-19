import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../tools/shell/AsyncProcess.js";
import { executorStatus } from "../../tools/shell/IsolatedExecutor.js";

test("mixed code/media goal survives lost admission, configuration upgrade/rollback and two process restarts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-mixed-recovery-v1-"));
  const workspace = path.join(root, "workspace"); const storage = path.join(root, "state");
  await fs.mkdir(workspace); await fs.mkdir(storage); await fs.mkdir(path.join(workspace, "assets"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const isolation = executorStatus();
  if (!isolation.available) { t.skip(isolation.reason); return; }
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DNsAAAAASUVORK5CYII=";
  const result = { model: "original-image", data: [{ b64_json: png }] };
  const sha = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  const descriptor = { type: "images.generations", supported_parameters: ["prompt", "size", "model", "n", "response_format"], response_formats: ["b64_json"], limits: { min_width: 64, min_height: 64, max_width: 512, max_height: 512, max_pixels: 262144 } };
  let completedRemotely = false; let puts = 0; let gets = 0; let acks = 0; let alternateRequests = 0; let clientId: string | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/alternate/")) { alternateRequests++; res.statusCode = 503; res.end('{}'); return; }
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "original-image", operations: [descriptor] }] })); return; }
    const parsed = new URL(req.url!, "http://localhost");
    const match = parsed.pathname.match(/^\/v1\/media\/jobs\/([a-zA-Z0-9-]+)(\/ack)?$/);
    if (!match) { res.statusCode = 404; res.end('{}'); return; }
    if (req.method === "PUT") {
      let body = ""; for await (const chunk of req) body += String(chunk);
      assert.equal(JSON.parse(body).request.model, "original-image");
      clientId = match[1]; puts++; req.socket.destroy(); return;
    }
    assert.equal(match[1], clientId);
    if (req.method === "POST") { acks++; res.end('{"acknowledged":true}'); return; }
    gets++; assert.equal(req.method, "GET");
    res.end(JSON.stringify({ protocol: "mswarm-media-jobs-v1", client_id: clientId, job_id: `shj_media_${"a".repeat(64)}`, operation: "images.generations", model: "original-image",
      status: completedRemotely ? "succeeded" : "running", ...(completedRemotely ? { result, result_sha256: sha, usage: { renders: 1 } } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await fs.writeFile(path.join(workspace, "value.mjs"), "export const value = 1;\n");
  await fs.writeFile(path.join(workspace, "USER_NOTES.md"), "Pre-existing user work.\n");
  await fs.writeFile(path.join(workspace, "integration.test.mjs"), `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import {value} from './value.mjs';\nassert.equal(value,2); assert.deepEqual(await readFile(new URL('./assets/pixel.png',import.meta.url)),Buffer.from(${JSON.stringify(png)},'base64')); assert.match(await readFile(new URL('./USER_NOTES.md',import.meta.url),'utf8'),/concurrent correction/);\n`);
  const testHash = createHash("sha256").update(await fs.readFile(path.join(workspace, "integration.test.mjs"))).digest("hex");
  const fixture = fileURLToPath(new URL("../fixtures/MixedMediaRecoveryJourney.js", import.meta.url));
  for (const stage of [1, 2, 3]) {
    if (stage === 2) { completedRemotely = true; await fs.appendFile(path.join(workspace, "USER_NOTES.md"), "A concurrent correction must survive.\n"); }
    await runProcess(process.execPath, [fixture, workspace, storage, origin, String(stage)], { workspaceRoot: workspace, shellTimeoutMs: 30000 });
    const handoff = JSON.parse(await fs.readFile(path.join(storage, "mixed-media.json"), "utf8"));
    assert.equal(handoff.stage, stage); assert.equal(handoff.completed, stage === 3); assert.equal(handoff.jobId, clientId);
    assert.equal(handoff.mediaStatus, stage === 1 ? "uncertain" : "succeeded");
    assert.deepEqual(handoff.requirements, ["R1", "R2", "R3"]);
    assert.equal(puts, 1); assert.equal(alternateRequests, 0);
    if (stage < 3) assert.ok(handoff.failedTools.includes("work_complete"));
    else { assert.equal(handoff.compactions, 5); assert.deepEqual(handoff.failedTools, []); }
  }
  assert.equal(acks, 1); assert.ok(gets >= 1);
  assert.deepEqual(await fs.readFile(path.join(workspace, "assets/pixel.png")), Buffer.from(png, "base64"));
  assert.equal(await fs.readFile(path.join(workspace, "USER_NOTES.md"), "utf8"), "Pre-existing user work.\nA concurrent correction must survive.\n");
  assert.equal(createHash("sha256").update(await fs.readFile(path.join(workspace, "integration.test.mjs"))).digest("hex"), testHash);
});
