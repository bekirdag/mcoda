import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseAskArgs, runAsk } from "../AskCommand.js";

test("configured ask parses effort and rejects legacy provider injection", async () => {
  const options = parseAskArgs(["Question", "--orchestration-config", "models.json", "--effort", "low"]);
  assert.equal(options.orchestrationConfig, "models.json"); assert.equal(options.effort, "low"); assert.equal(options.query, "Question");
  assert.throws(() => parseAskArgs(["Question", "--effort", "infinite"]), /low\|medium/);
  await assert.rejects(runAsk(["Question", "--orchestration-config", "unused"], { createProvider: () => { throw new Error("unexpected"); } }), /provider override/);
});

test("configured ask routes classifier/planner/final through one pinned budget without local agent defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codali-configured-ask-")); const original = globalThis.fetch;
  const models: string[] = []; const lines: string[] = [];
  const config = { schemaVersion: 1, profile: "ask-fixture", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { small: { provider: "local", catalogId: "small", revision: "v1", operations: ["chat.completions"], contextWindow: 16384, maxOutputTokens: 500 },
      large: { provider: "local", catalogId: "large", revision: "v1", operations: ["chat.completions"], contextWindow: 16384, maxOutputTokens: 500 } },
    bindings: { lead: { candidates: ["large"] }, planner: { candidates: ["small"] }, synthesizer: { useBinding: "lead" } },
    effort: { low: { maxModelCalls: 3, maxTotalTokens: 30000, maxOutputTokens: 500 } } };
  const responses = [JSON.stringify({ queryType: "general", needsPrivateData: false, needsFreshData: false, needsDocdex: false,
    needsAppTools: false, needsImageWorker: false, confidence: "high" }), JSON.stringify({ queryType: "general", subquestions: [], workerTasks: [] }), "Configured answer"];
  try {
    await writeFile(path.join(root, "models.json"), JSON.stringify(config));
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "small" }, { id: "large" }] });
      models.push(JSON.parse(String(init?.body)).model);
      const content = responses.shift(); assert.notEqual(content, undefined);
      return Response.json({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    };
    const outcome = await runAsk(["Write a short greeting", "--workspace-root", root, "--no-tools", "--json", "--orchestration-config", path.join(root, "models.json"), "--effort", "low"], {
      loadInventory: async () => { throw new Error("Legacy inventory must not be loaded"); },
      resolveRunContext: async workspaceRoot => ({ repo: { root: workspaceRoot } }), write: line => { lines.push(line); },
    });
    assert.equal(outcome.exitCode, 0, lines.join("\n")); assert.deepEqual(models, ["small", "small", "large"]);
    const result = JSON.parse(lines.join("\n")); assert.equal(result.answer, "Configured answer");
    assert.equal(result.telemetry.orchestration.usage.modelCalls, 3); assert.equal(result.telemetry.orchestration.usage.totalTokens, 45);
    assert.match(result.telemetry.orchestration.configHash, /^[a-f0-9]{64}$/);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});
