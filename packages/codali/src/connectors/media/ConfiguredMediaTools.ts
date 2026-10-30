import type { ResolvedOrchestrationConfig, ModelOperation } from "../../config/OrchestrationConfig.js";
import type { ToolDefinition, ToolSchemaDefinition } from "../../tools/ToolTypes.js";
import { MediaJobStore, type MediaJob } from "./MediaJobStore.js";
import { setTimeout as delay } from "node:timers/promises";

export const mediaJobSummary = (job: MediaJob): Record<string, unknown> => ({ id: job.id, operation: job.operation, status: job.status, model: job.modelId, configHash: job.configHash, cancelRequested: job.cancelRequested, remote: job.remote, error: job.error, artifact: job.artifact });
export const createConfiguredMediaTools = (resolved: ResolvedOrchestrationConfig, store: () => MediaJobStore): ToolDefinition[] => {
  const properties: Record<string, ToolSchemaDefinition> = { prompt: { type: "string", minLength: 1 }, negative_prompt: { type: "string" }, size: { type: "string" }, seed: { type: "integer" }, steps: { type: "integer", minimum: 1 }, high_noise_steps: { type: "integer", minimum: 1 }, duration_seconds: { type: "number", minimum: 0 }, fps: { type: "integer", minimum: 1 }, video_frames: { type: "integer", minimum: 1 }, sample_rate: { type: "integer", minimum: 1 } };
  const tools: ToolDefinition[] = [];
  for (const [binding, operation] of [["image", "images.generations"], ["audio", "audio.generations"], ["video", "videos.generations"]] as const) if (resolved.config.bindings[binding]?.enabled !== false && resolved.config.bindings[binding]) tools.push({
    name: `media_generate_${binding}`, description: `Submit a ${binding} generation job using the approved model configuration. Returns a durable job ID; use media_job_wait to obtain its artifact. Never resubmit uncertain jobs.`, capability: "media", readOnly: false,
    inputSchema: { type: "object", properties, required: ["prompt"], additionalProperties: false },
    handler: async (args, context) => { const data = mediaJobSummary(await store().submit(resolved, binding, operation as ModelOperation, args as Record<string, unknown>, context.signal)); return { output: JSON.stringify(data), data }; },
  });
  for (const action of ["status", "wait", "cancel"] as const) tools.push({
    name: `media_job_${action}`, description: `${action} a durable media job. Wait suspends locally without additional model calls and reports progress; cancelling a wait leaves the render running. An uncertain remote outcome must be reconciled before another submission.`, capability: "media", readOnly: action !== "cancel", inputSchema: { type: "object", properties: { jobId: { type: "string" }, ...(action === "wait" ? { waitSeconds: { type: "integer" as const, minimum: 1, maximum: 600 } } : {}) }, required: ["jobId"], additionalProperties: false },
    handler: async (args, context) => {
      const id = (args as { jobId: string }).jobId;
      if (action === "cancel") { const data = mediaJobSummary(await store().cancel(id)); return { output: JSON.stringify(data), data }; }
      let job = await store().reconcileProcess(id, context.signal);
      const waitSeconds = (args as { waitSeconds?: number }).waitSeconds ?? 300;
      const until = Date.now() + waitSeconds * 1000;
      let lastProgress = 0;
      while (action === "wait" && ["queued", "running"].includes(job.status) && Date.now() < until) {
        context.signal?.throwIfAborted();
        if (Date.now() - lastProgress >= 5000) {
          context.onOutput?.("stdout", `Media ${id}: ${job.status}\n`);
          lastProgress = Date.now();
        }
        await delay(Math.min(500, Math.max(1, until - Date.now())), undefined, { signal: context.signal });
        job = await store().reconcileProcess(id, context.signal);
      }
      const data = mediaJobSummary(job); return { output: JSON.stringify(data), data };
    },
  });
  tools.push({ name: "media_export_artifact", description: "Copy a completed, checksum-verified media artifact to a new workspace file. Requires workspace write permission and a claimed task scope.", capability: "workspace", readOnly: false, inputSchema: { type: "object", properties: { jobId: { type: "string" }, path: { type: "string" } }, required: ["jobId", "path"], additionalProperties: false }, handler: async (args, context) => { const { jobId, path } = args as { jobId: string; path: string }; const data = await store().exportArtifact(jobId, context.workspaceRoot, path, resolvedPath => context.checkPath?.(resolvedPath, "write") ?? Promise.resolve()); context.recordTouchedFile?.(path); return { output: JSON.stringify(data), data }; } });
  return tools;
};
