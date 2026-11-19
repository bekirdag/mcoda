import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelServiceClient } from "../../providers/ConfiguredProvider.js";
import { ModelServiceError } from "../../providers/ModelServiceError.js";
import { MediaJobStore } from "./MediaJobStore.js";
import { withStateLock } from "../../session/AtomicState.js";
import { persistMediaArtifact } from "./MediaArtifactReceipt.js";
import { pinOrchestrationConfig, resolveBinding } from "../../config/OrchestrationConfig.js";
import { executeRemoteMediaJob } from "./RemoteMediaJob.js";

export const executeMediaJob = async (root: string, sessionId: string, id: string): Promise<void> => {
  const store = new MediaJobStore(root, sessionId);
  // A worker crash releases no success claim and never automatically resubmits.
  await withStateLock(`${store.file(id)}.execution`, async () => {
    const job = await store.read(id); if (job.status !== "queued") return;
    if (job.cancelRequested) { await store.update(id, state => { state.status = "failed"; state.error = "Cancelled before submission"; }); return; }
    try {
      job.resolved = pinOrchestrationConfig(job.resolved);
      const model = job.resolved.config.models[job.modelId];
      if (job.configHash !== job.resolved.hash || model?.provider !== job.providerId || model?.catalogId !== job.catalogId || job.request.model !== job.catalogId || !resolveBinding(job.resolved.config, job.binding, job.operation).some(candidate => candidate.id === job.modelId)) throw new Error("Media job route does not match its pinned configuration");
    } catch (error) { await store.update(id, state => { state.status = "failed"; state.error = error instanceof Error ? error.message : "Invalid media configuration"; }); return; }
    await store.update(id, state => { state.status = "running"; state.pid = process.pid; });
    const abort = new AbortController(); let checking = false;
    const durable = !!job.resolved.config.providers[job.providerId].mediaJobsUrl;
    const timer = setInterval(() => { if (checking || durable) return; checking = true; void store.read(id).then(state => { if (state.cancelRequested) abort.abort(new Error("Cancellation requested; remote termination is unconfirmed")); }).catch(error => abort.abort(error)).finally(() => { checking = false; }); }, 500);
    try {
      const provider = job.resolved.config.providers[job.providerId];
      if (durable) { await executeRemoteMediaJob(store, job); return; }
      const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/${job.operation.replace(".", "/")}`;
      const response = await new ModelServiceClient(provider).json(endpoint, { method: "POST", body: job.request, signal: abort.signal, timeoutMs: 60 * 60 * 1000 }) as { data?: Array<Record<string, unknown>> };
      const payload = response.data?.[0];
      const base64 = payload?.b64_json ?? payload?.b64_audio ?? payload?.b64_video;
      if (typeof base64 !== "string" || !base64 || base64.length > 89_478_488 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid or oversized media payload");
      const bytes = Buffer.from(base64, "base64");
      const artifact = await persistMediaArtifact(path.dirname(store.file(id)), job, bytes);
      await store.update(id, state => { state.status = "succeeded"; state.artifact = artifact; });
    } catch (error) {
      const rejected = error instanceof ModelServiceError && [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(error.status);
      await store.update(id, state => { state.status = rejected && !state.remote ? "failed" : "uncertain"; state.error = error instanceof Error ? error.message : "Media submission outcome is unknown"; });
    } finally { clearInterval(timer); }
  });
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  executeMediaJob(process.argv[2], process.argv[3], process.argv[4]).catch(() => { process.exitCode = 1; });
}
