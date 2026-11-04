import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionController } from "../SessionController.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

test("resume resolves unique prefixes, prefers exact IDs and preserves current state on lookup errors", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-resume-prefix-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-resume-store-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["model"] } } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: { config, hash: orchestrationHash(config), source: "test" }, docdex: false });
  for (const sessionId of ["uniqueid-one", "ambiguous-one", "ambiguous-two", "exact-id", "exact-id-more"])
    await controller.store.createSession({ sessionId, repoRoot: root, task: `Goal ${sessionId}`, kind: "work" });
  await controller.resume(" uniqueid-on ");
  assert.equal(controller.sessionId, "uniqueid-one");
  assert.equal(controller.state?.objective, "Goal uniqueid-one");
  await assert.rejects(controller.resume("ambiguous"), /matches several sessions/);
  await assert.rejects(controller.resume("missing-session"), /No saved session matches.*\/sessions/);
  await assert.rejects(controller.resume("uni"), /No saved session matches/);
  await assert.rejects(controller.resume(""), /Use \/resume SESSION_ID/);
  assert.equal(controller.sessionId, "uniqueid-one");
  await controller.resume("exact-id");
  assert.equal(controller.sessionId, "exact-id");
  assert.equal(controller.busy, false);
});
