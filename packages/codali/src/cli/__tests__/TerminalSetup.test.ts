import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTerminalConfig } from "../TerminalCommand.js";
import { resolveBinding } from "../../config/OrchestrationConfig.js";

test("setup negotiates durable media and preserves a model's multiple operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-setup-"));
  const originalFetch = globalThis.fetch; const originalKey = process.env.MCODA_MSWARM_API_KEY;
  const urls: string[] = []; process.env.MCODA_MSWARM_API_KEY = "setup-fixture-key";
  globalThis.fetch = async input => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/v1/media/jobs")) return Response.json({ protocol: "mswarm-media-jobs-v1" });
    return Response.json({ agents: [{ slug: "fixture-strata", adapter: "strata-local", supports_tools: true, health_status: "healthy", context_window: 32768, operations: [{ type: "chat.completions" }, { type: "images.generations" }, { type: "audio.generations" }] }] });
  };
  try {
    const result = await setupTerminalConfig(path.join(root, "orchestration.json"));
    assert.equal(result.config.providers.mswarm.mediaJobsUrl, "https://api.mswarm.org/v1/media/jobs");
    assert.equal(resolveBinding(result.config, "lead", "chat.completions")[0].model.backend, "strata");
    assert.equal(resolveBinding(result.config, "image", "images.generations")[0].id, "fixture-strata");
    assert.equal(resolveBinding(result.config, "audio", "audio.generations")[0].id, "fixture-strata");
    assert.equal(result.config.bindings.video.enabled, false);
    assert.equal(urls.length, 2); assert.equal(urls.some(url => url.endsWith("/completions")), false);
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
