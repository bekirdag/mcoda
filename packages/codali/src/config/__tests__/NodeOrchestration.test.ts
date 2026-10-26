import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeOrchestrationConfig } from "../NodeOrchestration.js";
import type { OrchestrationConfig } from "../OrchestrationConfig.js";

test("node profiles cannot escape the admitted runner, model, artifact or limits", async t => {
  const root = await mkdtemp(join(tmpdir(), "codali-node-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "models.json");
  const approved = { model: "strata", baseUrl: "http://127.0.0.1:11452/v1", modelDigest: "sha256:abc", contextWindow: 4096, maxOutputTokens: 100 };
  const baseline: OrchestrationConfig = { schemaVersion: 1, profile: "node",
    providers: { local: { adapter: "openai-compatible", baseUrl: approved.baseUrl } },
    models: { lead: { provider: "local", catalogId: "strata", revision: "sha256:abc", operations: ["chat.completions"], contextWindow: 4096, maxOutputTokens: 100 } },
    bindings: { lead: { candidates: ["lead"] }, worker: { useBinding: "lead" }, planner: { useBinding: "lead" }, synthesizer: { useBinding: "lead" } },
  };
  await writeFile(file, JSON.stringify(baseline));
  assert.match((await loadNodeOrchestrationConfig(file, approved)).hash, /^[0-9a-f]{64}$/);
  await assert.rejects(loadNodeOrchestrationConfig(file, { ...approved, baseUrl: "https://api.example.test/v1" }), /loopback/);
  await assert.rejects(loadNodeOrchestrationConfig("relative.json", approved), /absolute/);
  const cases: Array<[string, (config: OrchestrationConfig) => void, RegExp]> = [
    ["gateway recursion", c => { c.providers.local.baseUrl = "https://api.example.test/v1"; }, /approved runner/],
    ["different model", c => { c.models.lead.catalogId = "other"; }, /admitted model/],
    ["extra context", c => { c.models.lead.contextWindow = 8192; }, /approved model limits/],
    ["different artifact", c => { c.models.lead.revision = "sha256:def"; }, /approved artifact/],
    ["unapproved catalog", c => { c.providers.local.catalogUrl = "http://127.0.0.1:11452/admin"; }, /catalog/],
    ["extra output", c => { c.models.lead.maxOutputTokens = 200; }, /approved model limits/],
  ];
  for (const [name, change, error] of cases) await t.test(name, async () => {
    const config = structuredClone(baseline); change(config); await writeFile(file, JSON.stringify(config));
    await assert.rejects(loadNodeOrchestrationConfig(file, approved), error);
  });
});
