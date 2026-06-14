import { randomUUID } from "node:crypto";
import {
  MswarmApi,
  type MswarmCapabilityRequestOptions,
  type MswarmGenericJobArtifactUploadInput,
  type MswarmGenericJobArtifactUploadResult,
  type MswarmGenericJobArtifactsResult,
  type MswarmGenericJobEventsResult,
  type MswarmGenericJobLifecycleSnapshot,
  type MswarmGenericJobLogsResult,
  type MswarmGenericJobOpsRequestOptions,
  type MswarmGenericJobOpsSummary,
  type MswarmGenericJobReference,
  type MswarmGenericNodeJobEnvelope
} from "@mcoda/core";

type MswarmGenericJobRequestInput = MswarmGenericNodeJobEnvelope["job"];
type McodaGpuJobCreateInput = MswarmGenericNodeJobEnvelope | MswarmGenericJobRequestInput;
type McodaGpuJobEvent = MswarmGenericJobEventsResult["events"][number];

export interface McodaGpuJobEventStreamOptions extends Partial<MswarmGenericJobReference> {
  intervalMs?: number;
  stopOnTerminal?: boolean;
}

export interface McodaGpuJobsNamespace {
  create(
    job: McodaGpuJobCreateInput,
    input?: Partial<MswarmGenericJobReference>
  ): Promise<MswarmGenericJobLifecycleSnapshot>;
  run(
    job: McodaGpuJobCreateInput,
    input?: Partial<MswarmGenericJobReference>
  ): Promise<MswarmGenericJobLifecycleSnapshot>;
  status(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLifecycleSnapshot>;
  logs(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLogsResult>;
  events(
    jobIdOrInput: string | (Partial<MswarmGenericJobReference> & { jobId: string }),
    input?: McodaGpuJobEventStreamOptions
  ): AsyncIterable<McodaGpuJobEvent>;
  eventsSnapshot(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobEventsResult>;
  artifacts(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobArtifactsResult>;
  cancel(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLifecycleSnapshot>;
  retry(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLifecycleSnapshot>;
  ops(input?: Partial<MswarmGenericJobOpsRequestOptions>): Promise<MswarmGenericJobOpsSummary>;
}

export interface CreateMcodaGpuJobClientInput {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  nodeBaseUrl?: string;
  nodeId?: string;
  signingSecret?: string;
  token?: string;
  tokenTtlSeconds?: number;
}

export interface McodaGpuJobClient {
  close(): Promise<void>;
  jobs: McodaGpuJobsNamespace;
  listGpus(input?: Partial<MswarmCapabilityRequestOptions>): Promise<Record<string, unknown>>;
  uploadArtifact(input: Omit<MswarmGenericJobArtifactUploadInput, keyof MswarmGenericJobReference> & Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobArtifactUploadResult>;
  runJob(job: McodaGpuJobCreateInput, input?: Partial<MswarmGenericJobReference>): Promise<MswarmGenericJobLifecycleSnapshot>;
  create(job: McodaGpuJobCreateInput, input?: Partial<MswarmGenericJobReference>): Promise<MswarmGenericJobLifecycleSnapshot>;
  status(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLifecycleSnapshot>;
  logs(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLogsResult>;
  events(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobEventsResult>;
  artifacts(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobArtifactsResult>;
  cancel(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLifecycleSnapshot>;
  retry(input: Partial<MswarmGenericJobReference> & { jobId: string }): Promise<MswarmGenericJobLifecycleSnapshot>;
  ops(input?: Partial<MswarmGenericJobOpsRequestOptions>): Promise<MswarmGenericJobOpsSummary>;
}

export async function createMcodaGpuJobClient(
  input: CreateMcodaGpuJobClientInput = {}
): Promise<McodaGpuJobClient> {
  const api = await MswarmApi.create({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs
  });
  const defaults = {
    nodeBaseUrl: input.nodeBaseUrl,
    nodeId: input.nodeId,
    signingSecret: input.signingSecret,
    token: input.token,
    tokenTtlSeconds: input.tokenTtlSeconds
  };
  const withDefaults = <T extends Record<string, unknown>>(request: T): T & typeof defaults => ({
    ...defaults,
    ...request
  });
  const requireText = (value: string | undefined, label: string): string => {
    if (!value || value.trim() === "") {
      throw new Error(`${label} is required`);
    }
    return value.trim();
  };
  const normalizeJobEnvelope = (
    job: McodaGpuJobCreateInput,
    request: Partial<MswarmGenericJobReference> = {}
  ): MswarmGenericNodeJobEnvelope => {
    if ("job" in job && typeof job.job_id === "string" && typeof job.request_id === "string" && typeof job.node_id === "string") {
      return job;
    }
    const merged = withDefaults(request);
    return {
      job_id: request.jobId || `job-${randomUUID()}`,
      request_id: request.requestId || `req-${randomUUID()}`,
      node_id: requireText(merged.nodeId, "nodeId"),
      job: job as MswarmGenericJobRequestInput
    };
  };
  const create = (
    job: McodaGpuJobCreateInput,
    request: Partial<MswarmGenericJobReference> = {}
  ): Promise<MswarmGenericJobLifecycleSnapshot> =>
    api.runGenericJob(normalizeJobEnvelope(job, request), withDefaults(request));
  const terminalStates = new Set(["succeeded", "failed", "cancelled", "expired", "blocked"]);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  async function* streamEvents(
    jobIdOrInput: string | (Partial<MswarmGenericJobReference> & { jobId: string }),
    request: McodaGpuJobEventStreamOptions = {}
  ): AsyncIterable<McodaGpuJobEvent> {
    const { intervalMs = 1000, stopOnTerminal = true, ...requestRest } = request;
    const reference = typeof jobIdOrInput === "string"
      ? withDefaults({ ...requestRest, jobId: jobIdOrInput })
      : withDefaults({ ...jobIdOrInput, ...requestRest });
    const seen = new Set<string>();
    while (true) {
      const events = await api.getGenericJobEvents(reference);
      for (const event of events.events) {
        const key = `${event.sequence}:${event.timestamp}:${event.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          yield event;
        }
      }
      if (stopOnTerminal) {
        const snapshot = await api.getGenericJob(reference);
        if (terminalStates.has(snapshot.job.state)) {
          return;
        }
      }
      await sleep(intervalMs);
    }
  }
  const jobs: McodaGpuJobsNamespace = {
    create,
    run: create,
    status: (request) => api.getGenericJob(withDefaults(request)),
    logs: (request) => api.getGenericJobLogs(withDefaults(request)),
    events: streamEvents,
    eventsSnapshot: (request) => api.getGenericJobEvents(withDefaults(request)),
    artifacts: (request) => api.getGenericJobArtifacts(withDefaults(request)),
    cancel: (request) => api.cancelGenericJob(withDefaults(request)),
    retry: (request) => api.retryGenericJob(withDefaults(request)),
    ops: (request = {}) => api.getGenericJobOps(withDefaults(request))
  };
  return {
    close: () => api.close(),
    jobs,
    listGpus: (request = {}) => api.listGpuCapabilities(withDefaults(request)),
    uploadArtifact: (request) => api.uploadGenericJobArtifact(withDefaults(request)),
    runJob: create,
    create,
    status: jobs.status,
    logs: jobs.logs,
    events: jobs.eventsSnapshot,
    artifacts: jobs.artifacts,
    cancel: jobs.cancel,
    retry: jobs.retry,
    ops: jobs.ops
  };
}
