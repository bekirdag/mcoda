import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, tryStateLock, withStateLock } from "../../session/AtomicState.js";
import { pinOrchestrationConfig, type ModelOperation, type ResolvedOrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { ConfiguredProvider } from "../../providers/ConfiguredProvider.js";
import { recoverMediaArtifact } from "./MediaArtifactReceipt.js";
import { reconcileRemoteMediaJob } from "./RemoteMediaJob.js";

export interface MediaArtifact { id: string; jobId: string; path: string; mimeType: string; bytes: number; sha256: string; model: string; configHash: string; createdAt: string; }
export interface MediaJob {
  schemaVersion: 1; id: string; sessionId: string; operation: ModelOperation; binding: string; modelId: string;
  catalogId: string; providerId: string; configHash: string; resolved: ResolvedOrchestrationConfig;
  request: Record<string, unknown>; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "uncertain";
  createdAt: string; updatedAt: string; pid?: number; cancelRequested?: boolean; error?: string; artifact?: MediaArtifact;
  reconciliation?: { at: string; outcome: "failed"; note: string };
  remote?: {
    protocol: "mswarm-media-jobs-v1"; submissionStartedAt: string; jobId?: string; invocationId?: string;
    status?: string; nodeId?: string; expiresAt?: string; resultSha256?: string; acknowledgedAt?: string;
    cancelRequested?: boolean; cancelConfirmed?: boolean; usage?: Record<string, unknown>;
  };
}
const validId = (id: string): string => { if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Error("Invalid media job id"); return id; };
export class MediaJobStore {
  constructor(readonly root: string, readonly sessionId: string) { validId(sessionId); }
  file(id: string): string { return path.join(this.root, validId(id), "job.json"); }
  async read(id: string): Promise<MediaJob> {
    const job = JSON.parse(await fs.readFile(this.file(id), "utf8")) as MediaJob;
    if (job.schemaVersion !== 1 || job.sessionId !== this.sessionId || job.id !== id) throw new Error("Media job belongs to another session");
    return job;
  }
  async update(id: string, mutate: (job: MediaJob) => void): Promise<MediaJob> {
    return withStateLock(this.file(id), async () => { const job = await this.read(id); mutate(job); job.updatedAt = new Date().toISOString(); await atomicWriteJson(this.file(id), job); return job; });
  }
  async list(): Promise<MediaJob[]> {
    let names: string[]; try { names = await fs.readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const jobs: MediaJob[] = [];
    for (const id of names) { if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) continue; const job = await this.read(id); jobs.push(job); }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async submit(resolved: ResolvedOrchestrationConfig, binding: string, operation: ModelOperation, request: Record<string, unknown>, signal?: AbortSignal): Promise<MediaJob> {
    resolved = pinOrchestrationConfig(resolved);
    if ((await this.list()).some(job => ["queued", "running", "uncertain"].includes(job.status))) throw new Error("Resolve the active or uncertain media job before submitting another render in this session");
    const selected = await new ConfiguredProvider(resolved, binding).select(operation, signal);
    const descriptor = (selected.actual.raw.operations as Array<Record<string, unknown>> | undefined)?.find(v => v.type === operation);
    if (!descriptor) throw new Error("The service did not advertise this media operation contract");
    const body = validateMediaRequest(request, descriptor, operation);
    signal?.throwIfAborted();
    const at = new Date().toISOString(); const id = randomUUID();
    const job: MediaJob = { schemaVersion: 1, id, sessionId: this.sessionId, operation, binding, modelId: selected.id, catalogId: selected.model.catalogId, providerId: selected.model.provider, configHash: resolved.hash, resolved, request: { ...body, model: selected.model.catalogId }, status: "queued", createdAt: at, updatedAt: at };
    await withStateLock(path.join(this.root, ".submission"), async () => {
      if ((await this.list()).some(existing => ["queued", "running", "uncertain"].includes(existing.status))) throw new Error("Resolve the active or uncertain media job before submitting another render in this session");
      await atomicWriteJson(this.file(id), job);
    });
    const credentialName = selected.provider.credentialRef?.slice(4);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG };
    if (credentialName && process.env[credentialName]) env[credentialName] = process.env[credentialName];
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./MediaJobWorker.js", import.meta.url)), this.root, this.sessionId, id], { detached: true, stdio: "ignore", env });
      child.unref();
      child.once("error", () => { void this.update(id, state => { state.status = "failed"; state.error = "Media worker could not start"; }).catch(() => undefined); });
      await this.update(id, state => { state.pid = child.pid; });
    } catch { await this.update(id, state => { state.status = "failed"; state.error = "Media worker could not start"; }); }
    return this.read(id);
  }
  async cancel(id: string): Promise<MediaJob> {
    return this.update(id, job => { if (!["succeeded", "failed", "cancelled"].includes(job.status)) job.cancelRequested = true; });
  }
  /** Trusted user/host action, deliberately unavailable as an agent tool. */
  async reconcileFailure(id: string, note: string): Promise<MediaJob> {
    if (!note.trim() || note.length > 4000) throw new Error("Describe the confirmed remote failure or cancellation (1–4000 characters)");
    return this.update(id, job => {
      if (job.status !== "uncertain") throw new Error("Only an uncertain media job needs manual reconciliation");
      job.status = "failed";
      job.reconciliation = { at: new Date().toISOString(), outcome: "failed", note };
      job.error = "Remote failure/cancellation confirmed by user; see reconciliation record";
    });
  }
  async reconcileProcess(id: string, signal?: AbortSignal): Promise<MediaJob> {
    signal?.throwIfAborted();
    const job = await this.read(id);
    if (["succeeded", "failed", "cancelled"].includes(job.status) || job.status === "queued" && Date.now() - Date.parse(job.createdAt) <= 60000) return job;
    const recovery = await tryStateLock(`${this.file(id)}.execution`, async () => {
      const current = await this.read(id);
      if (["succeeded", "failed", "cancelled"].includes(current.status)) return current;
      let artifact: MediaArtifact | undefined; let failure: string | undefined;
      try { artifact = await recoverMediaArtifact(path.dirname(this.file(id)), current); }
      catch (error) { failure = error instanceof Error ? error.message : "Artifact recovery failed"; }
      if (!artifact && !failure && current.remote) {
        try { return await reconcileRemoteMediaJob(this, current, signal); }
        catch (error) { signal?.throwIfAborted(); failure = error instanceof Error ? error.message : "Remote media recovery failed"; }
      }
      return this.update(id, state => {
        if (["succeeded", "failed", "cancelled"].includes(state.status)) return;
        if (artifact) { state.status = "succeeded"; state.artifact = artifact; state.error = undefined; }
        else { state.status = "uncertain"; state.error = failure ?? "Media worker stopped without a complete local receipt; remote execution may have occurred. Do not resubmit automatically."; }
      });
    });
    return recovery.acquired ? recovery.value : job;
  }
  async verifiedArtifact(id: string): Promise<MediaArtifact> {
    const job = await this.read(id);
    if (job.status !== "succeeded" || !job.artifact) throw new Error("Media artifact is not ready");
    const artifact = await recoverMediaArtifact(path.dirname(this.file(id)), job);
    if (!artifact || Object.entries(artifact).some(([key, value]) => job.artifact![key as keyof MediaArtifact] !== value)) throw new Error("Media artifact does not match its durable receipt");
    return artifact;
  }
  async exportArtifact(id: string, workspaceRoot: string, destination: string, checkPath?: (resolvedPath: string) => Promise<void>, signal?: AbortSignal): Promise<MediaArtifact> {
    signal?.throwIfAborted();
    const artifact = await this.verifiedArtifact(id);
    const target = path.resolve(workspaceRoot, destination);
    const root = await fs.realpath(workspaceRoot);
    const parent = await fs.realpath(path.dirname(target));
    if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Artifact destination escapes the workspace");
    const canonicalTarget = path.join(parent, path.basename(target));
    if ([".git", ".mcoda"].includes(path.relative(root, canonicalTarget).split(path.sep)[0])) throw new Error("Artifact cannot overwrite repository control metadata");
    await checkPath?.(canonicalTarget);
    const bytes = await fs.readFile(artifact.path);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Artifact checksum mismatch");
    signal?.throwIfAborted();
    await fs.writeFile(canonicalTarget, bytes, { flag: "wx", mode: 0o600 });
    return { ...artifact, path: canonicalTarget };
  }
}

export const validateMediaRequest = (request: Record<string, unknown>, descriptor: Record<string, unknown>, operation: ModelOperation): Record<string, unknown> => {
  const allowlist = descriptor.supported_parameters as string[];
  if (!Array.isArray(allowlist)) throw new Error("Missing advertised media parameters");
  for (const name of Object.keys(request)) if (!allowlist.includes(name) || ["model", "response_format", "n"].includes(name)) throw new Error(`Unsupported media parameter: ${name}`);
  const limits = (descriptor.limits ?? {}) as Record<string, number>;
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > (limits.max_prompt_chars ?? 8192)) throw new Error("Invalid media prompt length");
  const body = { ...request, n: 1, response_format: operation === "images.generations" ? "b64_json" : operation === "audio.generations" ? "wav" : "webm" };
  if (!(descriptor.response_formats as string[] | undefined)?.includes(body.response_format)) throw new Error("Required media output format is not supported");
  for (const name of ["steps", "high_noise_steps", "duration_seconds", "sample_rate", "fps", "video_frames"]) {
    const value = request[name]; if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (name !== "duration_seconds" && !Number.isInteger(value))) throw new Error(`Invalid media ${name}`);
    if (limits[`min_${name}`] !== undefined && value < limits[`min_${name}`] || limits[`max_${name}`] !== undefined && value > limits[`max_${name}`]) throw new Error(`Media ${name} exceeds advertised limits`);
  }
  if (request.size !== undefined) {
    if (typeof request.size !== "string" || !/^\d+x\d+$/.test(request.size)) throw new Error("Invalid media size");
    const [width, height] = request.size.split("x").map(Number);
    for (const [name, value] of [["width", width], ["height", height]] as const) if (value < (limits[`min_${name}`] ?? 1) || value > (limits[`max_${name}`] ?? 4096)) throw new Error(`Media ${name} exceeds advertised limits`);
    if (width * height > (limits.max_pixels ?? 16_777_216)) throw new Error("Media pixel count exceeds advertised limit");
  }
  if (typeof request.negative_prompt === "string" && request.negative_prompt.length > (limits.max_negative_prompt_chars ?? 8192)) throw new Error("Negative prompt too long");
  if (request.seed !== undefined && (typeof request.seed !== "number" || !Number.isSafeInteger(request.seed))) throw new Error("Invalid seed");
  if (Buffer.byteLength(JSON.stringify(body)) > (limits.max_request_bytes ?? 131072)) throw new Error("Media request exceeds byte limit");
  return body;
};
