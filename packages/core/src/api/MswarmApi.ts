import { GlobalRepository } from "@mcoda/db";
import {
  CryptoHelper,
  type AgentHealth,
  type AgentHealthStatus,
  type AgentModel,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "@mcoda/shared";
import { MswarmConfigStore } from "./MswarmConfigStore.js";

export interface MswarmCloudAgent {
  slug: string;
  provider: string;
  default_model: string;
  cost_per_million?: number;
  rating?: number;
  reasoning_rating?: number;
  max_complexity?: number;
  capabilities: string[];
  health_status?: string;
  context_window?: number;
  supports_tools: boolean;
  model_id?: string;
  display_name?: string;
  description?: string;
  supports_reasoning?: boolean;
  pricing_snapshot_id?: string;
  pricing_version?: string;
  sync?: Record<string, unknown>;
}

export interface MswarmCloudAgentDetail extends MswarmCloudAgent {
  pricing?: Record<string, unknown>;
  supported_parameters?: string[];
  status?: string;
  moderation_status?: string;
  mcoda_shape?: Record<string, unknown>;
}

export interface ListMswarmCloudAgentsOptions {
  provider?: string;
  limit?: number;
}

export interface MswarmApiOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  agentSlugPrefix?: string;
}

interface ResolvedMswarmApiOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  agentSlugPrefix: string;
}

export interface ManagedMswarmCloudConfig {
  managed: true;
  remoteSlug: string;
  provider: string;
  modelId?: string;
  displayName?: string;
  description?: string;
  supportsReasoning?: boolean;
  pricingSnapshotId?: string;
  pricingVersion?: string;
  catalogBaseUrl: string;
  openAiBaseUrl: string;
  sync?: Record<string, unknown>;
  syncedAt: string;
}

export interface ManagedMswarmAgentConfig extends Record<string, unknown> {
  baseUrl: string;
  apiBaseUrl: string;
  mswarmCloud: ManagedMswarmCloudConfig;
}

export interface MswarmSyncRecord {
  remoteSlug: string;
  localSlug: string;
  action: "created" | "updated";
  provider: string;
  defaultModel: string;
  pricingVersion?: string;
}

export interface MswarmSyncSummary {
  created: number;
  updated: number;
  agents: MswarmSyncRecord[];
}

interface ListMswarmCloudAgentsResponse {
  agents?: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_SLUG_PREFIX = "mswarm-cloud";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const resolveNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const resolveBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const resolveStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
};

const normalizeBaseUrl = (value: string | undefined, label: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  return parsed.toString();
};

const normalizePositiveInt = (value: number | undefined, label: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.trunc(value);
};

const resolveOptions = async (options: MswarmApiOptions = {}): Promise<ResolvedMswarmApiOptions> => {
  const envTimeoutRaw = process.env.MCODA_MSWARM_TIMEOUT_MS;
  const envTimeout = envTimeoutRaw ? Number.parseInt(envTimeoutRaw, 10) : undefined;
  const directBaseUrl = options.baseUrl ?? process.env.MCODA_MSWARM_BASE_URL;
  const directApiKey = options.apiKey ?? process.env.MCODA_MSWARM_API_KEY;
  const directTimeout = options.timeoutMs ?? envTimeout;
  const directAgentSlugPrefix = options.agentSlugPrefix ?? process.env.MCODA_MSWARM_AGENT_SLUG_PREFIX;
  const needsStoredFallback =
    directBaseUrl === undefined ||
    directApiKey === undefined ||
    directTimeout === undefined ||
    directAgentSlugPrefix === undefined;
  const stored = needsStoredFallback ? await new MswarmConfigStore().readState() : {};
  return {
    baseUrl: normalizeBaseUrl(
      directBaseUrl ?? stored.baseUrl,
      "MCODA_MSWARM_BASE_URL",
    ),
    apiKey: resolveString(directApiKey ?? stored.apiKey) ?? (() => {
      throw new Error("MCODA_MSWARM_API_KEY is required");
    })(),
    timeoutMs: normalizePositiveInt(
      directTimeout ?? stored.timeoutMs,
      "MCODA_MSWARM_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
    agentSlugPrefix:
      resolveString(directAgentSlugPrefix ?? stored.agentSlugPrefix) ?? DEFAULT_AGENT_SLUG_PREFIX,
  };
};

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.filter((value) => value.trim().length > 0)));

const toManagedLocalSlug = (prefix: string, remoteSlug: string): string => {
  const normalized = remoteSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${normalized || "agent"}`;
};

const toHealthStatus = (value: string | undefined): AgentHealthStatus | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "healthy") return "healthy";
  if (normalized === "degraded" || normalized === "unknown" || normalized === "limited") return "degraded";
  if (normalized === "unreachable" || normalized === "offline") return "unreachable";
  return undefined;
};

const isManagedMswarmConfig = (config: unknown): config is ManagedMswarmAgentConfig => {
  if (!isRecord(config)) return false;
  if (!isRecord(config.mswarmCloud)) return false;
  return config.mswarmCloud.managed === true;
};

const toManagedConfig = (
  existingConfig: Record<string, unknown> | undefined,
  catalogBaseUrl: string,
  openAiBaseUrl: string,
  agent: MswarmCloudAgent,
  syncedAt: string,
): ManagedMswarmAgentConfig => {
  const nextConfig: ManagedMswarmAgentConfig = {
    ...(existingConfig ?? {}),
    baseUrl: openAiBaseUrl,
    apiBaseUrl: openAiBaseUrl,
    mswarmCloud: {
      managed: true,
      remoteSlug: agent.slug,
      provider: agent.provider,
      modelId: agent.model_id,
      displayName: agent.display_name,
      description: agent.description,
      supportsReasoning: agent.supports_reasoning,
      pricingSnapshotId: agent.pricing_snapshot_id,
      pricingVersion: agent.pricing_version,
      catalogBaseUrl,
      openAiBaseUrl,
      sync: isRecord(agent.sync) ? agent.sync : undefined,
      syncedAt,
    },
  };
  return nextConfig;
};

const toCloudAgent = (value: unknown): MswarmCloudAgent => {
  if (!isRecord(value)) {
    throw new Error("mswarm returned an invalid cloud-agent payload");
  }
  const slug = resolveString(value.slug);
  const provider = resolveString(value.provider);
  const defaultModel = resolveString(value.default_model);
  const supportsTools = resolveBoolean(value.supports_tools);
  if (!slug || !provider || !defaultModel || supportsTools === undefined) {
    throw new Error("mswarm cloud-agent payload is missing required fields");
  }
  return {
    slug,
    provider,
    default_model: defaultModel,
    cost_per_million: resolveNumber(value.cost_per_million),
    rating: resolveNumber(value.rating),
    reasoning_rating: resolveNumber(value.reasoning_rating),
    max_complexity: resolveNumber(value.max_complexity),
    capabilities: resolveStringArray(value.capabilities),
    health_status: resolveString(value.health_status),
    context_window: resolveNumber(value.context_window),
    supports_tools: supportsTools,
    model_id: resolveString(value.model_id),
    display_name: resolveString(value.display_name),
    description: resolveString(value.description),
    supports_reasoning: resolveBoolean(value.supports_reasoning),
    pricing_snapshot_id: resolveString(value.pricing_snapshot_id),
    pricing_version: resolveString(value.pricing_version),
    sync: isRecord(value.sync) ? value.sync : undefined,
  };
};

const toCloudAgentDetail = (value: unknown): MswarmCloudAgentDetail => {
  const agent = toCloudAgent(value);
  const record = isRecord(value) ? value : {};
  return {
    ...agent,
    pricing: isRecord(record.pricing) ? record.pricing : undefined,
    supported_parameters: resolveStringArray(record.supported_parameters),
    status: resolveString(record.status),
    moderation_status: resolveString(record.moderation_status),
    mcoda_shape: isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  };
};

const toAgentModels = (agentId: string, entry: MswarmCloudAgent): AgentModel[] => [
  {
    agentId,
    modelName: entry.default_model,
    isDefault: true,
    config: {
      provider: entry.provider,
      remoteSlug: entry.slug,
      modelId: entry.model_id,
      pricingVersion: entry.pricing_version,
    },
  },
];

export class MswarmApi {
  readonly baseUrl: string;
  readonly agentSlugPrefix: string;

  constructor(
    private readonly repo: GlobalRepository,
    private readonly options: ResolvedMswarmApiOptions,
  ) {
    this.baseUrl = options.baseUrl;
    this.agentSlugPrefix = options.agentSlugPrefix;
  }

  static async create(options: MswarmApiOptions = {}): Promise<MswarmApi> {
    const repo = await GlobalRepository.create();
    return new MswarmApi(repo, await resolveOptions(options));
  }

  async close(): Promise<void> {
    await this.repo.close();
  }

  private async requestJson<T>(
    pathname: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(pathname, this.options.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        headers: {
          accept: "application/json",
          "x-api-key": this.options.apiKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`mswarm request failed (${response.status}): ${body || response.statusText}`);
      }
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new Error(
          `mswarm response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`mswarm request timed out after ${this.options.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listCloudAgents(options: ListMswarmCloudAgentsOptions = {}): Promise<MswarmCloudAgent[]> {
    const payload = await this.requestJson<ListMswarmCloudAgentsResponse>("/v1/swarm/cloud/agents", {
      shape: "mcoda",
      provider: options.provider,
      limit: options.limit,
    });
    const agents = Array.isArray(payload.agents) ? payload.agents : [];
    return agents.map(toCloudAgent);
  }

  async getCloudAgent(slug: string): Promise<MswarmCloudAgentDetail> {
    if (!slug.trim()) {
      throw new Error("Cloud-agent slug is required");
    }
    const payload = await this.requestJson<unknown>(`/v1/swarm/cloud/agents/${encodeURIComponent(slug)}`);
    return toCloudAgentDetail(payload);
  }

  async syncCloudAgents(options: ListMswarmCloudAgentsOptions = {}): Promise<MswarmSyncSummary> {
    const agents = await this.listCloudAgents(options);
    const openAiBaseUrl = new URL("/v1/swarm/openai/", this.options.baseUrl).toString();
    const syncedAt = new Date().toISOString();
    const encryptedApiKey = await CryptoHelper.encryptSecret(this.options.apiKey);
    const records: MswarmSyncRecord[] = [];

    for (const agent of agents) {
      const localSlug = toManagedLocalSlug(this.options.agentSlugPrefix, agent.slug);
      const existing = await this.repo.getAgentBySlug(localSlug);
      if (existing && (!isManagedMswarmConfig(existing.config) || existing.config.mswarmCloud.remoteSlug !== agent.slug)) {
        throw new Error(`Refusing to overwrite non-mswarm agent ${localSlug}`);
      }

      const existingConfig =
        existing && isRecord(existing.config) ? (existing.config as Record<string, unknown>) : undefined;
      const nextConfig = toManagedConfig(existingConfig, this.options.baseUrl, openAiBaseUrl, agent, syncedAt);

      const baseInput: Pick<
        CreateAgentInput,
        | "slug"
        | "adapter"
        | "defaultModel"
        | "openaiCompatible"
        | "contextWindow"
        | "supportsTools"
        | "rating"
        | "reasoningRating"
        | "costPerMillion"
        | "maxComplexity"
        | "config"
        | "capabilities"
      > = {
        slug: localSlug,
        adapter: "openai-api",
        defaultModel: agent.default_model,
        openaiCompatible: true,
        contextWindow: agent.context_window,
        supportsTools: agent.supports_tools,
        rating: agent.rating,
        reasoningRating: agent.reasoning_rating,
        costPerMillion: agent.cost_per_million,
        maxComplexity: agent.max_complexity,
        config: nextConfig,
        capabilities: uniqueStrings(agent.capabilities),
      };

      const stored = existing
        ? await this.repo.updateAgent(existing.id, baseInput as UpdateAgentInput)
        : await this.repo.createAgent(baseInput as CreateAgentInput);
      if (!stored) {
        throw new Error(`Failed to persist synced agent ${localSlug}`);
      }

      await this.repo.setAgentModels(stored.id, toAgentModels(stored.id, agent));
      await this.repo.setAgentAuth(stored.id, encryptedApiKey);
      const mappedHealth = toHealthStatus(agent.health_status);
      if (mappedHealth) {
        const health: AgentHealth = {
          agentId: stored.id,
          status: mappedHealth,
          lastCheckedAt: syncedAt,
          details: {
            source: "mswarm",
            remoteSlug: agent.slug,
            remoteHealthStatus: agent.health_status,
          },
        };
        await this.repo.setAgentHealth(health);
      }

      records.push({
        remoteSlug: agent.slug,
        localSlug,
        action: existing ? "updated" : "created",
        provider: agent.provider,
        defaultModel: agent.default_model,
        pricingVersion: agent.pricing_version,
      });
    }

    return {
      created: records.filter((record) => record.action === "created").length,
      updated: records.filter((record) => record.action === "updated").length,
      agents: records,
    };
  }
}
