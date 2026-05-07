import { AgentHealth } from "@mcoda/shared";
import {
  AdapterConfig,
  AgentAdapter,
  InvocationRequest,
  InvocationResult,
} from "../AdapterTypes.js";

const MAX_RESPONSE_DETAIL_CHARS = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveString = (value: unknown): string | undefined => {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || undefined;
};

const resolveBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const readRecord = (
  record: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

function resolveWorkerConfig(config: AdapterConfig): Record<string, unknown> {
  const anyConfig = config as unknown as Record<string, unknown>;
  const agentConfig = (config.agent as unknown as Record<string, unknown>)
    ?.config as Record<string, unknown> | undefined;
  const worker = readRecord(anyConfig, "mswarmWorker") ?? readRecord(agentConfig, "mswarmWorker");
  if (!worker || worker.managed !== true) {
    throw new Error("mswarm-worker adapter requires a managed mswarmWorker config");
  }
  return worker;
}

function resolveRunUrl(config: AdapterConfig, worker: Record<string, unknown>): string {
  const explicit = resolveString(worker.apiRunUrl) ?? resolveString(worker.api_run_url);
  if (explicit) {
    return explicit;
  }
  const workerId =
    resolveString(worker.workerId) ??
    resolveString(worker.worker_id) ??
    resolveString(worker.remoteSlug);
  if (!workerId) {
    throw new Error("mswarm-worker adapter config is missing workerId");
  }
  const catalogBase =
    resolveString(worker.catalogBaseUrl) ??
    resolveString(worker.catalog_base_url) ??
    resolveString(config.baseUrl);
  if (!catalogBase) {
    throw new Error("mswarm-worker adapter config is missing catalogBaseUrl");
  }
  return `${normalizeBaseUrl(catalogBase)}/v1/swarm/workers/${encodeURIComponent(workerId)}/run`;
}

function parseWorkerOutput(payload: Record<string, unknown>): string {
  const direct = resolveString(payload.output);
  if (direct !== undefined) return direct;
  const result = isRecord(payload.result) ? payload.result : {};
  return resolveString(result.output) ?? JSON.stringify(payload);
}

const resolveIdempotencyKey = (
  metadata: Record<string, unknown> | undefined
): string | undefined =>
  resolveString(metadata?.idempotencyKey) ??
  resolveString(metadata?.idempotency_key) ??
  resolveString(metadata?.runId) ??
  resolveString(metadata?.run_id);

export class MswarmWorkerAdapter implements AgentAdapter {
  private readonly worker: Record<string, unknown>;
  private readonly runUrl: string;

  constructor(private readonly config: AdapterConfig) {
    this.worker = resolveWorkerConfig(config);
    this.runUrl = resolveRunUrl(config, this.worker);
  }

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities ?? [];
  }

  async healthCheck(): Promise<AgentHealth> {
    const configured = Boolean(this.config.apiKey);
    const workerMetadata = readRecord(this.worker, "worker") ?? {};
    const enabled =
      resolveBoolean(this.worker.enabled) ?? resolveBoolean(workerMetadata.enabled);
    return {
      agentId: this.config.agent.id,
      status: configured && enabled !== false ? "healthy" : "unreachable",
      lastCheckedAt: new Date().toISOString(),
      details: {
        source: "mswarm_worker",
        workerId: resolveString(this.worker.workerId),
        remoteSlug: resolveString(this.worker.remoteSlug),
        reason: !configured
          ? "missing_api_key"
          : enabled === false
            ? "worker_disabled"
            : "catalog_metadata_only",
      },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    if (!this.config.apiKey) {
      throw new Error(
        "AUTH_REQUIRED: Managed mswarm worker is missing the synced API key; run `mcoda config set mswarm-api-key <KEY>` and `mcoda workers sync`."
      );
    }
    const started = Date.now();
    const response = await fetch(this.runUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": this.config.apiKey,
        ...(resolveIdempotencyKey(request.metadata)
          ? { "idempotency-key": resolveIdempotencyKey(request.metadata) }
          : {}),
      },
      body: JSON.stringify({
        text: request.input,
        input: request.input,
        metadata: request.metadata ?? {},
      }),
    });
    const responseText = await response.text();
    let payload: Record<string, unknown> = {};
    if (responseText.trim()) {
      try {
        const parsed = JSON.parse(responseText) as unknown;
        payload = isRecord(parsed) ? parsed : { output: responseText };
      } catch {
        payload = { output: responseText };
      }
    }
    if (!response.ok) {
      throw new Error(
        `mswarm_worker request failed (${response.status}): ${
          responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS) || response.statusText
        }`
      );
    }
    const result = isRecord(payload.result) ? payload.result : {};
    return {
      output: parseWorkerOutput(payload),
      adapter: "mswarm-worker",
      model:
        resolveString(payload.model) ??
        resolveString(result.model) ??
        this.config.model,
      metadata: {
        mswarmWorker: {
          runUrl: this.runUrl,
          workerId: resolveString(this.worker.workerId),
          remoteSlug: resolveString(this.worker.remoteSlug),
          durationMs: Date.now() - started,
          response: payload,
        },
      },
    };
  }
}
