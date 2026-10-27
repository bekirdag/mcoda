import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionController, type SessionEvent } from "../../runtime/SessionController.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import type { Provider, ProviderResponse } from "../../providers/ProviderTypes.js";
import { atomicWriteJson } from "../../session/AtomicState.js";

export const mixedMediaObjective = "Correct value.mjs to export two and deliver the requested pixel as assets/pixel.png. Preserve USER_NOTES.md. Recover the original render across configuration changes; never submit a replacement render.";
export const mixedMediaConfig = (origin: string, alternative = false): OrchestrationConfig => ({
  schemaVersion: 1, profile: alternative ? "mixed-media-alternative-v1" : "mixed-media-original-v1",
  providers: { fixture: { adapter: "openai-compatible", baseUrl: `${origin}/${alternative ? "alternate/" : ""}v1`, mediaJobsUrl: `${origin}/${alternative ? "alternate/" : ""}v1/media/jobs` } },
  models: {
    text: { provider: "fixture", catalogId: "text-fixture", revision: "v1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true },
    image: { provider: "fixture", catalogId: alternative ? "replacement-image" : "original-image", revision: "v1", operations: ["images.generations"], contextWindow: 1024, maxOutputTokens: 1 },
  },
  bindings: { lead: { candidates: ["text"] }, reviewer: { useBinding: "lead" }, image: { candidates: ["image"] } },
});
const reply = (content: string): ProviderResponse => ({ message: { role: "assistant", content }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
const call = (name: string, args: unknown): ProviderResponse => ({ ...reply(""), toolCalls: [{ id: `${name}-${Math.random()}`, name, args }] });

/** Scripted controller/transport integration, not a model-quality evaluation. */
export async function runMixedMediaRecoveryStage(workspaceRoot: string, storageRoot: string, origin: string, stage: number): Promise<void> {
  assert.ok([1, 2, 3].includes(stage));
  const handoffPath = path.join(storageRoot, "mixed-media.json");
  const prior = stage > 1 ? JSON.parse(await fs.readFile(handoffPath, "utf8")) as { sessionId: string; jobId: string } : undefined;
  const original = mixedMediaConfig(origin); const alternative = mixedMediaConfig(origin, true);
  const resolve = (config: OrchestrationConfig) => ({ config, hash: orchestrationHash(config), source: "mixed-media-fixture" });
  const events: SessionEvent[] = [];
  let step = 0; let reviewed = false; let controller!: SessionController;
  const provider: Provider = { name: "scripted-mixed-media", supportsToolCalls: true, generate: async request => {
    if (!request.tools?.length) {
      assert.equal(stage, 3, "No review is allowed to certify incomplete media work");
      const input = JSON.parse(request.messages.at(-1)!.content);
      assert.match(input.source["value.mjs"], /value = 2/);
      assert.ok(input.changedPaths.includes("assets/pixel.png"));
      assert.ok(input.receipts.some((r: { status: string; tool: string; output: string }) => r.status === "success" && r.tool === "run_shell" && /# pass 1/.test(r.output)));
      reviewed = true; return reply('{"passed":true,"findings":[]}');
    }
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    const previousData = () => JSON.parse(previous().split("\n")[0]);
    step++;
    if (stage === 1) {
      switch (step) {
        case 1: return call("work_refine", { requirements: [{ id: "R2", description: "value.mjs exports two" }, { id: "R3", description: "Deliver the original requested pixel in assets/pixel.png without a second render" }], constraints: ["Preserve USER_NOTES.md"], nonGoals: ["Generate replacement images"], tasks: [{ id: "T1", title: "Deliver code and the original image", requirementIds: ["R1", "R2", "R3"], dependsOn: [], allowedPaths: ["value.mjs", "assets"] }] });
        case 2: return call("work_decision", { id: "D1", title: "Pin admitted media", rationale: "Configuration changes apply to new work; reconcile the admitted job using its original model and endpoint", alternatives: ["Resubmit after configuration changes"], paths: ["assets"] });
        case 3: return call("work_claim", { taskId: "T1" });
        case 4: return call("read_file", { path: "value.mjs" });
        case 5: return call("write_file", { path: "value.mjs", content: "export const value = 2;\n" });
        case 6: return call("tools_enable", { names: ["media_generate_image"] });
        case 7: return call("media_generate_image", { prompt: "A pixel", size: "64x64" });
        case 8: return call("work_complete", {});
        case 9: assert.match(previous(), /Required task work remains|unresolved/i); return call("work_block", { taskId: "T1", reason: "Render admission response was lost; recover the original job before integration" });
        default: return reply("The code and image goal remains incomplete.");
      }
    }
    if (stage === 2) {
      switch (step) {
        case 1: return call("work_claim", { taskId: "T1" });
        case 2: return call("tools_enable", { names: ["media_job_status", "media_export_artifact"] });
        case 3: return call("media_job_status", { jobId: prior!.jobId });
        case 4: assert.equal(previousData().status, "succeeded"); return call("read_file", { path: "USER_NOTES.md" });
        case 5: assert.match(previous(), /concurrent correction/); return call("read_file", { path: "assets/pixel.png" });
        case 6: return call("media_export_artifact", { jobId: prior!.jobId, path: "assets/pixel.png" });
        case 7: assert.equal(previousData().jobId, prior!.jobId); return call("work_complete", {});
        case 8: assert.match(previous(), /Required task work remains/); return call("work_block", { taskId: "T1", reason: "Original artifact recovered; final integrated code and artifact check remains" });
        default: return reply("Artifact recovery alone does not complete the coding task.");
      }
    }
    switch (step) {
      case 1: return call("work_claim", { taskId: "T1" });
      case 2: return call("run_shell", { command: "node", args: ["--test", "integration.test.mjs"] });
      case 3: return call("work_verify", { taskId: "T1", attemptId: controller.state!.tasks[0].attemptId, summary: "The integration test checks code, the exact original image bytes and preserved user notes." });
      case 4: assert.equal(previousData().verified, true); return call("work_complete", {});
      default: return reply("All requested code and original artifact checks passed.");
    }
  } };
  controller = new SessionController({ workspaceRoot, storageRoot, resolved: resolve(stage === 3 ? alternative : original), provider,
    docdex: false, permissions: "workspace", allowMedia: true, effort: "high", onEvent: event => { events.push(event); } });
  assert.equal(controller.isolation.available, true, controller.isolation.reason);
  if (stage === 1) await controller.start(mixedMediaObjective);
  else {
    await controller.resume(prior!.sessionId);
    await controller.reloadConfiguration(resolve(stage === 2 ? alternative : original));
    const pinned = await controller.mediaStore().read(prior!.jobId);
    assert.equal(pinned.configHash, orchestrationHash(original)); assert.equal(pinned.catalogId, "original-image");
    assert.equal(controller.state!.decisions[0].id, "D1");
  }
  const result = await controller.run();
  assert.equal(result.completed, stage === 3);
  assert.equal(controller.state!.originalObjective, mixedMediaObjective);
  assert.deepEqual(controller.state!.requirements.map(r => r.id), ["R1", "R2", "R3"]);
  const jobs = await controller.mediaStore().list(); assert.equal(jobs.length, 1);
  let job = jobs[0];
  if (stage === 1) {
    const deadline = Date.now() + 10000;
    while (["queued", "running"].includes(job.status) && Date.now() < deadline) { await delay(25); job = await controller.mediaStore().read(job.id); }
    assert.equal(job.status, "uncertain", job.error); assert.ok(job.remote?.submissionStartedAt);
    await assert.rejects(controller.fork(), /Reconcile pending operations/);
  } else {
    assert.equal(job.id, prior!.jobId); assert.equal(job.status, "succeeded");
    assert.equal(job.artifact!.configHash, orchestrationHash(original));
    assert.deepEqual(await fs.readFile(job.artifact!.path), await fs.readFile(path.join(workspaceRoot, "assets/pixel.png")));
  }
  for (let i = 0; i < (stage === 3 ? 1 : 2); i++) await controller.compact();
  if (stage === 3) { assert.equal(reviewed, true); assert.equal(controller.state!.checkpoints.filter(c => c.note.startsWith("Context compacted")).length, 5); }
  await atomicWriteJson(handoffPath, { schemaVersion: 1, sessionId: controller.sessionId, jobId: job.id, stage, completed: result.completed, configHash: job.configHash,
    mediaStatus: job.status, requirements: controller.state!.requirements.map(r => r.id), compactions: controller.state!.checkpoints.filter(c => c.note.startsWith("Context compacted")).length,
    failedTools: events.filter(e => e.type === "tool_receipt" && (e.data.receipt as { status: string }).status === "failed").map(e => (e.data.receipt as { tool: string }).tool) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMixedMediaRecoveryStage(process.argv[2], process.argv[3], process.argv[4], Number(process.argv[5])).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
