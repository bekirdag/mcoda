import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunCommand, parseArgs } from "../RunCommand.js";
import { getGlobalWorkspaceDir } from "../../runtime/StoragePaths.js";

test("legacy run keeps separate workflow and orchestration configuration flags", async () => {
  const parsed = parseArgs(["--config", "workflow.json", "--orchestration-config", "models.json", "--effort", "high", "Explain"]);
  assert.equal(parsed.configPath, "workflow.json"); assert.equal(parsed.orchestrationConfig, "models.json"); assert.equal(parsed.effort, "high");
  assert.throws(() => parseArgs(["--effort", "unlimited"]), /low\|medium/);
  assert.throws(() => parseArgs(["--orchestration-config"]), /file path/);
  await assert.rejects(RunCommand.run(["--orchestration-config", "unused", "--provider", "legacy"]), /legacy model\/provider\/agent overrides/);
});

test("legacy direct command uses pinned configuration and records actual route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codali-configured-run-"));
  const storage = getGlobalWorkspaceDir(root); const original = globalThis.fetch; const models: string[] = [];
  const beforeSignals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    await assert.rejects(readdir(storage), { code: "ENOENT" });
    const config = { schemaVersion: 1, profile: "cli-fixture", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
      models: { lead: { provider: "local", catalogId: "configured-large", revision: "v1", supportsTools: true, supportsStreaming: false,
        operations: ["chat.completions"], contextWindow: 8192, maxOutputTokens: 100 } }, bindings: { lead: { candidates: ["lead"] } },
      effort: { low: { maxModelCalls: 1, maxTotalTokens: 20000, maxOutputTokens: 100 } } };
    await writeFile(path.join(root, "models.json"), JSON.stringify(config));
    await writeFile(path.join(root, "workflow.json"), JSON.stringify({ smart: false, provider: "legacy-must-not-run", model: "legacy-model",
      deepInvestigation: { enabled: false }, logging: { directory: "logs" }, localContext: { enabled: false }, builder: { fallbackToInterpreter: false }, streaming: { enabled: false }, tools: { enabled: ["read_file"], allowShell: false } }));
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "configured-large" }] });
      assert.ok(String(url).endsWith("/chat/completions"));
      models.push(JSON.parse(String(init?.body)).model);
      return Response.json({ choices: [{ message: { role: "assistant", content: "Configured route verified" } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    };
    await RunCommand.run(["--workspace-root", root, "--config", path.join(root, "workflow.json"), "--orchestration-config", path.join(root, "models.json"), "--effort", "low", "Explain the routing"]);
    assert.deepEqual(models, ["configured-large"]);
    const logs = await readdir(path.join(storage, "logs"));
    const contents = (await Promise.all(logs.filter(file => file.endsWith(".jsonl")).map(file => readFile(path.join(storage, "logs", file), "utf8")))).join("\n");
    assert.match(contents, /configured_runtime_usage/); assert.match(contents, /configured-large/);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], beforeSignals);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); await rm(storage, { recursive: true, force: true }); }
});
