import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvedReview, contractReviewFixture } from "../../eval/fixtures/ContractReviewProvider.js";
import { SessionController } from "../SessionController.js";
import type { Provider, ProviderResponse } from "../../providers/ProviderTypes.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

const config: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
  models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } },
  bindings: { lead: { candidates: ["model"] }, reviewer: { useBinding: "lead" } } };
const resolved = { config, hash: orchestrationHash(config), source: "test" };
const reply = (content: string): ProviderResponse => ({ message: { role: "assistant", content }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
const call = (name: string, args: unknown): ProviderResponse => ({ ...reply(""), toolCalls: [{ id: `${name}-${Math.random()}`, name, args }] });

// A sign-up service (written for this test) whose settings live in an ini file
// and whose README the request asks for. The README is not written with the
// first task, and when it is written it states a link lifetime the
// configuration does not have.
test("verification names requested delivery documents still missing and rejects a document lifetime the settings lack", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-delivery-docs-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-delivery-docs-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "config"));
  const objective = "Configure the sign-up service in config/app.ini and deliver README.md describing its settings.";
  let step = 0; let attemptId = ""; const results: Record<string, unknown>[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    const contract = contractReviewFixture(request); if (contract) return contract;
    if (!request.tools?.length) return reply(approvedReview(request));
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_refine", { requirements: [{ id: "R2", description: "config/app.ini sets the sign-up link lifetime." }, { id: "R3", description: "README.md describes the settings." }], constraints: [], nonGoals: [], tasks: [
        { id: "settings", title: "Settings", requirementIds: ["R2"], dependsOn: [], allowedPaths: ["config/app.ini"] },
        { id: "docs", title: "README", requirementIds: ["R3"], dependsOn: ["settings"], allowedPaths: ["README.md"] },
        { id: "integration", title: "Final review", requirementIds: ["R1"], dependsOn: ["docs"], allowedPaths: [] },
      ] });
      case 1: return call("work_claim", { taskId: "settings" });
      case 2: attemptId = JSON.parse(previous()).attemptId; return call("write_file", { path: "config/app.ini", content: "[signup]\nlink_ttl_hours = 48\n" });
      case 3: return call("work_verify", { taskId: "settings", attemptId, invocationIds: [], summary: "The link lifetime is configured." });
      case 4: results.push(JSON.parse(previous())); return call("work_claim", { taskId: "docs" });
      case 5: attemptId = JSON.parse(previous()).attemptId; return call("write_file", { path: "README.md", content: "# Sign-up service\n\nSign-up links expire after 24 hours.\n" });
      case 6: return call("work_verify", { taskId: "docs", attemptId, invocationIds: [], summary: "README describes the settings." });
      case 7: results.push(JSON.parse(previous())); return call("write_file", { path: "README.md", content: "# Sign-up service\n\nSign-up links expire after 48 hours.\n" });
      case 8: return call("work_verify", { taskId: "docs", attemptId, invocationIds: [], summary: "README describes the settings." });
      case 9: results.push(JSON.parse(previous())); return call("work_block", { taskId: "integration", reason: "The test ends before the final review." });
      default: return reply("Stopped before the final review.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" });
  await controller.run(objective);
  assert.equal(results.length, 3);
  assert.equal(results[0].verified, true);
  assert.match(String(results[0].deliveryDocuments), /names README\.md, which do not exist yet/);
  assert.equal(results[1].verified, false);
  assert.match((results[1].findings as string[])[0], /^README\.md:3 states 24 hours .*config\/app\.ini:2 link_ttl_hours = 48/);
  assert.equal(results[2].verified, true);
  assert.equal(results[2].deliveryDocuments, undefined);
});
