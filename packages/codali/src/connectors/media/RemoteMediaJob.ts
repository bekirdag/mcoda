import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelServiceClient } from "../../providers/ConfiguredProvider.js";
import { pinOrchestrationConfig, resolveBinding } from "../../config/OrchestrationConfig.js";
import { persistMediaArtifact } from "./MediaArtifactReceipt.js";
import type { MediaJob, MediaJobStore } from "./MediaJobStore.js";

interface RemoteReceipt {
  protocol: string; client_id: string; job_id: string; invocation_id?: string; node_id?: string;
  operation: string; model: string; status: string; expires_at?: string; result_sha256?: string;
  cancel_requested?: boolean; cancel_confirmed?: boolean; usage?: Record<string, unknown>;
  error?: string; result?: { data?: Array<Record<string, unknown>> };
}
const connection = (job: MediaJob) => {
  const resolved = pinOrchestrationConfig(job.resolved);
  const provider = resolved.config.providers[job.providerId];
  const model = resolved.config.models[job.modelId];
  if (!provider?.mediaJobsUrl || resolved.hash !== job.configHash || job.request.model !== job.catalogId || model?.provider !== job.providerId || model?.catalogId !== job.catalogId || !resolveBinding(resolved.config, job.binding, job.operation).some(candidate => candidate.id === job.modelId)) throw new Error("Remote media job does not match its pinned configuration");
  return { client: new ModelServiceClient(provider), url: `${provider.mediaJobsUrl.replace(/\/$/, "")}/${job.id}` };
};
const receipt = (job: MediaJob, value: unknown): RemoteReceipt => {
  const v = value as RemoteReceipt;
  if (!v || v.protocol !== "mswarm-media-jobs-v1" || v.client_id !== job.id || typeof v.job_id !== "string" || !/^shj_media_[a-f0-9]{64}$/.test(v.job_id) || v.operation !== job.operation || v.model !== job.catalogId || !["admitting", "queued", "running", "succeeded", "failed", "cancelled", "uncertain", "expired"].includes(v.status)) throw new Error("Remote media receipt identity or contract mismatch");
  if (job.remote?.jobId && job.remote.jobId !== v.job_id) throw new Error("Remote media job identity changed");
  if (v.status === "cancelled" && v.cancel_confirmed !== true) throw new Error("The service has not confirmed media cancellation");
  return v;
};
const saveReceipt = (store: MediaJobStore, job: MediaJob, remote: RemoteReceipt) => store.update(job.id, state => {
  if (!state.remote) throw new Error("Missing remote submission intent");
  Object.assign(state.remote, { jobId: remote.job_id, invocationId: remote.invocation_id ?? undefined, status: remote.status, nodeId: remote.node_id ?? undefined, expiresAt: remote.expires_at ?? undefined, resultSha256: remote.result_sha256, cancelRequested: remote.cancel_requested === true, cancelConfirmed: remote.cancel_confirmed === true, usage: remote.usage });
});

/** This path only reads/cancels/acknowledges a known client job id. It never
 * submits again, including after a lost admission response or process crash. */
export const reconcileRemoteMediaJob = async (store: MediaJobStore, job: MediaJob, signal?: AbortSignal): Promise<MediaJob> => {
  const { client, url } = connection(job);
  if (job.cancelRequested && !job.remote?.cancelRequested) {
    const cancelled = receipt(job, await client.json(url, { method: "DELETE", signal }));
    job = await saveReceipt(store, job, cancelled);
  }
  const remote = receipt(job, await client.json(`${url}?result=1`, { signal }));
  job = await saveReceipt(store, job, remote);
  if (remote.status === "succeeded") {
    if (!remote.result || typeof remote.result_sha256 !== "string" || createHash("sha256").update(JSON.stringify(remote.result)).digest("hex") !== remote.result_sha256) throw new Error("Remote media result checksum mismatch");
    const data = remote.result.data?.[0];
    const base64 = data?.b64_json ?? data?.b64_audio ?? data?.b64_video;
    if (typeof base64 !== "string" || !base64 || base64.length > 89_478_488 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid or oversized media payload");
    const artifact = await persistMediaArtifact(path.dirname(store.file(job.id)), job, Buffer.from(base64, "base64"));
    // A local durable artifact precedes server acknowledgement. If ACK fails,
    // the successful local receipt remains usable and the server TTL bounds it.
    job = await store.update(job.id, current => { current.status = "succeeded"; current.artifact = artifact; current.error = undefined; });
    try {
      await client.json(`${url}/ack`, { method: "POST", body: { result_sha256: remote.result_sha256 }, signal });
      job = await store.update(job.id, current => { current.remote!.acknowledgedAt = new Date().toISOString(); });
    } catch { /* Do not downgrade a verified artifact after a lost ACK. */ }
    return job;
  }
  return store.update(job.id, current => {
    current.status = remote.status === "cancelled" ? "cancelled" : ["failed", "expired"].includes(remote.status) ? "failed" : remote.status === "uncertain" ? "uncertain" : "running";
    current.error = remote.error ?? (remote.status === "uncertain" ? "Remote admission or execution is unresolved" : undefined);
  });
};

export const executeRemoteMediaJob = async (store: MediaJobStore, job: MediaJob): Promise<void> => {
  const { client, url } = connection(job);
  if (!job.remote) {
    // Persist before the first network byte. Recovery always uses GET, even
    // when the process dies before it can store the server acknowledgement.
    job = await store.update(job.id, current => { current.remote = { protocol: "mswarm-media-jobs-v1", submissionStartedAt: new Date().toISOString() }; });
    const accepted = receipt(job, await client.json(url, { method: "PUT", body: { operation: job.operation, request: job.request } }));
    job = await saveReceipt(store, job, accepted);
  }
  const deadline = Date.parse(job.remote!.submissionStartedAt) + 60 * 60_000;
  while (Date.now() < deadline) {
    job = await reconcileRemoteMediaJob(store, await store.read(job.id));
    if (["succeeded", "failed", "cancelled", "uncertain"].includes(job.status)) return;
    await delay(2000);
  }
  await store.update(job.id, current => { current.status = "uncertain"; current.error = "Media observation deadline elapsed; inspect the original remote job before further work"; });
};
