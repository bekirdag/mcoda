import { GlobalRepository } from '@mcoda/db';
import {
  CryptoHelper,
  type Agent,
  type AgentHealth,
  type AgentHealthStatus,
  type AgentModel,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@mcoda/shared';
import { MswarmConfigStore } from './MswarmConfigStore.js';

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
  max_output_tokens?: number;
  supports_tools: boolean;
  best_usage?: string;
  model_id?: string;
  display_name?: string;
  description?: string;
  supports_reasoning?: boolean;
  pricing_snapshot_id?: string;
  pricing_version?: string;
  rating_samples?: number;
  rating_last_score?: number;
  rating_updated_at?: string;
  complexity_samples?: number;
  complexity_updated_at?: string;
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
  maxCostPerMillion?: number;
  minContextWindow?: number;
  minReasoningRating?: number;
  sortByCatalogRating?: boolean;
  pruneMissing?: boolean;
}

export interface MswarmApiOptions {
  baseUrl?: string;
  openAiBaseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  agentSlugPrefix?: string;
}

export interface MswarmConsentResponse {
  consent_token: string;
  expires_in_seconds?: number;
  consent_types?: string[];
  issued_at_ms?: number;
  client_id?: string;
  client_type?: string;
  tenant_id?: string;
  upload_signing_secret?: string;
}

export interface RegisterFreeMcodaClientOptions {
  clientId?: string;
  policyVersion?: string;
  productVersion: string;
}

export interface RequestMswarmDataDeletionInput {
  consentToken: string;
  product: string;
  clientId?: string;
  clientType?: string;
  reason?: string;
}

export interface MswarmDataDeletionResponse {
  accepted: boolean;
  request_id: number;
  product: string;
  client_id?: string;
  client_type?: string;
  tenant_id?: string;
  status: string;
  requested_at?: string;
}

interface ResolvedMswarmApiOptions {
  baseUrl: string;
  openAiBaseUrl?: string;
  apiKey?: string;
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
  action: 'created' | 'updated' | 'deleted';
  provider: string;
  defaultModel: string;
  pricingVersion?: string;
}

export interface MswarmSyncSummary {
  created: number;
  updated: number;
  deleted: number;
  agents: MswarmSyncRecord[];
}

export interface MswarmManagedAuthRefreshSummary {
  updated: number;
  agents: string[];
}

interface ListMswarmCloudAgentsResponse {
  agents?: unknown;
}

const DEFAULT_BASE_URL = 'https://api.mswarm.org/';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_SLUG_PREFIX = 'mswarm-cloud';
export const MSWARM_CONSENT_POLICY_VERSION = '2026-03-18';
export const MCODA_FREE_CLIENT_TYPE = 'free_mcoda_client';
const MCODA_PRODUCT_SLUG = 'mcoda';
const MCODA_CONSENT_TYPES = ['anonymous', 'non_anonymous'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resolveString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const resolveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const resolveBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const resolveTimestamp = (value: unknown): string | undefined => {
  const candidate = resolveString(value);
  if (!candidate) return undefined;
  return Number.isNaN(Date.parse(candidate)) ? undefined : candidate;
};

const resolveStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0
  );
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

const normalizePositiveInt = (
  value: number | undefined,
  label: string,
  fallback: number
): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.trunc(value);
};

const normalizeOptionalPositiveInt = (
  value: number | undefined,
  label: string
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.trunc(value);
};

const normalizeOptionalNonNegativeNumber = (
  value: number | undefined,
  label: string
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
};

const resolveOptions = async (
  options: MswarmApiOptions = {}
): Promise<ResolvedMswarmApiOptions> => {
  const envTimeoutRaw = process.env.MCODA_MSWARM_TIMEOUT_MS;
  const envTimeout = envTimeoutRaw
    ? Number.parseInt(envTimeoutRaw, 10)
    : undefined;
  const directBaseUrl = options.baseUrl ?? process.env.MCODA_MSWARM_BASE_URL;
  const directOpenAiBaseUrl =
    options.openAiBaseUrl ?? process.env.MCODA_MSWARM_OPENAI_BASE_URL;
  const directApiKey = options.apiKey ?? process.env.MCODA_MSWARM_API_KEY;
  const directTimeout = options.timeoutMs ?? envTimeout;
  const directAgentSlugPrefix =
    options.agentSlugPrefix ?? process.env.MCODA_MSWARM_AGENT_SLUG_PREFIX;
  const needsStoredFallback =
    directBaseUrl === undefined ||
    directApiKey === undefined ||
    directTimeout === undefined ||
    directAgentSlugPrefix === undefined;
  const stored = needsStoredFallback
    ? await new MswarmConfigStore().readState()
    : {};
  return {
    baseUrl: normalizeBaseUrl(
      directBaseUrl ?? stored.baseUrl ?? DEFAULT_BASE_URL,
      'MCODA_MSWARM_BASE_URL'
    ),
    openAiBaseUrl: directOpenAiBaseUrl
      ? normalizeBaseUrl(directOpenAiBaseUrl, 'MCODA_MSWARM_OPENAI_BASE_URL')
      : undefined,
    apiKey: resolveString(directApiKey ?? stored.apiKey),
    timeoutMs: normalizePositiveInt(
      directTimeout ?? stored.timeoutMs,
      'MCODA_MSWARM_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS
    ),
    agentSlugPrefix:
      resolveString(directAgentSlugPrefix ?? stored.agentSlugPrefix) ??
      DEFAULT_AGENT_SLUG_PREFIX,
  };
};

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.filter((value) => value.trim().length > 0)));

const resolveFromRecordOrShape = <T>(
  record: Record<string, unknown>,
  keys: string[],
  parser: (value: unknown) => T | undefined
): T | undefined => {
  const sources = [
    record,
    isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  ].filter(isRecord);
  for (const source of sources) {
    for (const key of keys) {
      const resolved = parser(source[key]);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

const resolveStringArrayFromRecordOrShape = (
  record: Record<string, unknown>,
  keys: string[]
): string[] => {
  const sources = [
    record,
    isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  ].filter(isRecord);
  const values = sources.flatMap((source) =>
    keys.flatMap((key) => resolveStringArray(source[key]))
  );
  return uniqueStrings(values);
};

const hasCapabilityFragment = (
  capabilities: string[],
  fragments: string[]
): boolean =>
  capabilities.some((capability) =>
    fragments.some((fragment) => capability.includes(fragment))
  );

const inferCloudBestUsage = (
  agent: Pick<MswarmCloudAgent, 'capabilities' | 'default_model'>
): string => {
  const capabilities = agent.capabilities.map((capability) =>
    capability.trim().toLowerCase()
  );
  const model = agent.default_model.trim().toLowerCase();
  if (hasCapabilityFragment(capabilities, ['code_review', 'review']))
    return 'code_review';
  if (hasCapabilityFragment(capabilities, ['qa', 'test'])) return 'qa_testing';
  if (hasCapabilityFragment(capabilities, ['research', 'search', 'discover']))
    return 'deep_research';
  if (
    hasCapabilityFragment(capabilities, [
      'code_write',
      'coding',
      'tool_runner',
      'iterative_coding',
      'structured_output',
    ]) ||
    model.includes('codex')
  ) {
    return 'code_write';
  }
  if (hasCapabilityFragment(capabilities, ['architect', 'plan']))
    return 'system_architecture';
  if (hasCapabilityFragment(capabilities, ['doc'])) return 'doc_generation';
  return 'general';
};

const DEFAULT_CONTEXT_WINDOW = 8_192;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_MAX_COMPLEXITY = 5;

const toSyncedAgentInput = (
  existing: Agent | undefined,
  agent: MswarmCloudAgent,
  localSlug: string,
  config: Record<string, unknown>,
  syncedAt: string
): CreateAgentInput => {
  const rating = existing?.rating ?? agent.rating;
  const reasoningRating =
    existing?.reasoningRating ?? agent.reasoning_rating ?? rating;
  const maxComplexity =
    existing?.maxComplexity ?? agent.max_complexity ?? DEFAULT_MAX_COMPLEXITY;
  const ratingSamples = existing?.ratingSamples ?? agent.rating_samples ?? 0;
  const ratingLastScore =
    existing?.ratingLastScore ?? agent.rating_last_score ?? rating;
  const ratingUpdatedAt =
    existing?.ratingUpdatedAt ?? agent.rating_updated_at ?? syncedAt;
  const complexitySamples =
    existing?.complexitySamples ?? agent.complexity_samples ?? 0;
  const complexityUpdatedAt =
    existing?.complexityUpdatedAt ?? agent.complexity_updated_at ?? syncedAt;

  return {
    slug: localSlug,
    adapter: 'openai-api',
    defaultModel: agent.default_model,
    openaiCompatible: true,
    contextWindow:
      agent.context_window ?? existing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      agent.max_output_tokens ??
      existing?.maxOutputTokens ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    supportsTools: agent.supports_tools,
    rating,
    reasoningRating,
    bestUsage:
      agent.best_usage ?? existing?.bestUsage ?? inferCloudBestUsage(agent),
    costPerMillion: agent.cost_per_million ?? existing?.costPerMillion,
    maxComplexity,
    ratingSamples,
    ratingLastScore,
    ratingUpdatedAt,
    complexitySamples,
    complexityUpdatedAt,
    config,
    capabilities: uniqueStrings(agent.capabilities),
  };
};

const toManagedLocalSlug = (prefix: string, remoteSlug: string): string => {
  const normalized = remoteSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix}-${normalized || 'agent'}`;
};

const toHealthStatus = (
  value: string | undefined
): AgentHealthStatus | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'healthy') return 'healthy';
  if (
    normalized === 'degraded' ||
    normalized === 'unknown' ||
    normalized === 'limited'
  )
    return 'degraded';
  if (normalized === 'unreachable' || normalized === 'offline')
    return 'unreachable';
  return undefined;
};

const isSyncManagedHealth = (health: AgentHealth | undefined): boolean =>
  isRecord(health?.details) &&
  (health.details.source === 'mswarm' ||
    health.details.source === 'mswarm_catalog');

const isAuthMissingManagedHealth = (
  health: AgentHealth | undefined
): boolean => {
  if (!isRecord(health?.details)) return false;
  const reason = resolveString(health.details.reason);
  const error = resolveString(health.details.error) ?? '';
  return (
    reason === 'missing_api_key' ||
    /AUTH_REQUIRED/i.test(error) ||
    /missing the synced API key/i.test(error)
  );
};

const shouldReplaceManagedHealth = (
  health: AgentHealth | undefined
): boolean =>
  !health || isSyncManagedHealth(health) || isAuthMissingManagedHealth(health);

const isManagedMswarmConfig = (
  config: unknown
): config is ManagedMswarmAgentConfig => {
  if (!isRecord(config)) return false;
  if (!isRecord(config.mswarmCloud)) return false;
  return config.mswarmCloud.managed === true;
};

const toManagedConfig = (
  existingConfig: Record<string, unknown> | undefined,
  catalogBaseUrl: string,
  openAiBaseUrl: string,
  agent: MswarmCloudAgent,
  syncedAt: string
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

const toManagedSyncRecord = (
  config: ManagedMswarmAgentConfig,
  localSlug: string,
  defaultModel: string,
  action: MswarmSyncRecord['action']
): MswarmSyncRecord => ({
  remoteSlug: config.mswarmCloud.remoteSlug,
  localSlug,
  action,
  provider: config.mswarmCloud.provider,
  defaultModel,
  pricingVersion: config.mswarmCloud.pricingVersion,
});

const toCloudAgent = (value: unknown): MswarmCloudAgent => {
  if (!isRecord(value)) {
    throw new Error('mswarm returned an invalid cloud-agent payload');
  }
  const slug = resolveFromRecordOrShape(value, ['slug'], resolveString);
  const provider = resolveFromRecordOrShape(value, ['provider'], resolveString);
  const defaultModel = resolveFromRecordOrShape(
    value,
    ['default_model', 'defaultModel'],
    resolveString
  );
  const supportsTools = resolveFromRecordOrShape(
    value,
    ['supports_tools', 'supportsTools'],
    resolveBoolean
  );
  if (!slug || !provider || !defaultModel || supportsTools === undefined) {
    throw new Error('mswarm cloud-agent payload is missing required fields');
  }
  return {
    slug,
    provider,
    default_model: defaultModel,
    cost_per_million: resolveFromRecordOrShape(
      value,
      ['cost_per_million', 'costPerMillion'],
      resolveNumber
    ),
    rating: resolveFromRecordOrShape(value, ['rating'], resolveNumber),
    reasoning_rating: resolveFromRecordOrShape(
      value,
      ['reasoning_rating', 'reasoningRating'],
      resolveNumber
    ),
    max_complexity: resolveFromRecordOrShape(
      value,
      ['max_complexity', 'maxComplexity'],
      resolveNumber
    ),
    capabilities: resolveStringArrayFromRecordOrShape(value, ['capabilities']),
    health_status: resolveFromRecordOrShape(
      value,
      ['health_status', 'healthStatus'],
      resolveString
    ),
    context_window: resolveFromRecordOrShape(
      value,
      ['context_window', 'contextWindow'],
      resolveNumber
    ),
    max_output_tokens: resolveFromRecordOrShape(
      value,
      ['max_output_tokens', 'maxOutputTokens'],
      resolveNumber
    ),
    supports_tools: supportsTools,
    best_usage: resolveFromRecordOrShape(
      value,
      ['best_usage', 'bestUsage'],
      resolveString
    ),
    model_id: resolveFromRecordOrShape(
      value,
      ['model_id', 'modelId'],
      resolveString
    ),
    display_name: resolveFromRecordOrShape(
      value,
      ['display_name', 'displayName'],
      resolveString
    ),
    description: resolveFromRecordOrShape(
      value,
      ['description'],
      resolveString
    ),
    supports_reasoning: resolveFromRecordOrShape(
      value,
      ['supports_reasoning', 'supportsReasoning'],
      resolveBoolean
    ),
    pricing_snapshot_id: resolveFromRecordOrShape(
      value,
      ['pricing_snapshot_id', 'pricingSnapshotId'],
      resolveString
    ),
    pricing_version: resolveFromRecordOrShape(
      value,
      ['pricing_version', 'pricingVersion'],
      resolveString
    ),
    rating_samples: resolveFromRecordOrShape(
      value,
      ['rating_samples', 'ratingSamples'],
      resolveNumber
    ),
    rating_last_score: resolveFromRecordOrShape(
      value,
      ['rating_last_score', 'ratingLastScore'],
      resolveNumber
    ),
    rating_updated_at: resolveFromRecordOrShape(
      value,
      ['rating_updated_at', 'ratingUpdatedAt'],
      resolveTimestamp
    ),
    complexity_samples: resolveFromRecordOrShape(
      value,
      ['complexity_samples', 'complexitySamples'],
      resolveNumber
    ),
    complexity_updated_at: resolveFromRecordOrShape(
      value,
      ['complexity_updated_at', 'complexityUpdatedAt'],
      resolveTimestamp
    ),
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

const hasAdvancedCloudAgentSelection = (
  options: ListMswarmCloudAgentsOptions
): boolean =>
  options.maxCostPerMillion !== undefined ||
  options.minContextWindow !== undefined ||
  options.minReasoningRating !== undefined ||
  options.sortByCatalogRating === true;

const sortCloudAgentsByCatalogRating = (
  agents: MswarmCloudAgent[]
): MswarmCloudAgent[] =>
  [...agents].sort((left, right) => {
    const ratingDelta =
      (right.rating ?? Number.NEGATIVE_INFINITY) -
      (left.rating ?? Number.NEGATIVE_INFINITY);
    if (ratingDelta !== 0) return ratingDelta;
    return left.slug.localeCompare(right.slug);
  });

const applyCloudAgentListOptions = (
  agents: MswarmCloudAgent[],
  options: ListMswarmCloudAgentsOptions
): MswarmCloudAgent[] => {
  const maxCostPerMillion = normalizeOptionalNonNegativeNumber(
    options.maxCostPerMillion,
    'maxCostPerMillion'
  );
  const minContextWindow = normalizeOptionalPositiveInt(
    options.minContextWindow,
    'minContextWindow'
  );
  const minReasoningRating = normalizeOptionalNonNegativeNumber(
    options.minReasoningRating,
    'minReasoningRating'
  );
  const limit = normalizeOptionalPositiveInt(options.limit, 'limit');

  let next = [...agents];
  if (maxCostPerMillion !== undefined) {
    next = next.filter(
      (agent) =>
        agent.cost_per_million !== undefined &&
        agent.cost_per_million <= maxCostPerMillion
    );
  }
  if (minContextWindow !== undefined) {
    next = next.filter(
      (agent) =>
        agent.context_window !== undefined &&
        agent.context_window >= minContextWindow
    );
  }
  if (minReasoningRating !== undefined) {
    next = next.filter(
      (agent) =>
        agent.reasoning_rating !== undefined &&
        agent.reasoning_rating >= minReasoningRating
    );
  }
  if (options.sortByCatalogRating) {
    next = sortCloudAgentsByCatalogRating(next);
  }
  if (limit !== undefined) {
    next = next.slice(0, limit);
  }
  return next;
};

const toAgentModels = (
  agentId: string,
  entry: MswarmCloudAgent
): AgentModel[] => [
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
    private readonly options: ResolvedMswarmApiOptions
  ) {
    this.baseUrl = options.baseUrl;
    this.agentSlugPrefix = options.agentSlugPrefix;
  }

  static async create(options: MswarmApiOptions = {}): Promise<MswarmApi> {
    const repo = await GlobalRepository.create();
    return new MswarmApi(repo, await resolveOptions(options));
  }

  static async refreshManagedAgentAuth(
    apiKey: string
  ): Promise<MswarmManagedAuthRefreshSummary> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error('mswarm api key is required');
    }
    const repo = await GlobalRepository.create();
    try {
      const encryptedApiKey = await CryptoHelper.encryptSecret(trimmed);
      const agents = await repo.listAgents();
      const managedAgents = agents.filter((agent) =>
        isManagedMswarmConfig(agent.config)
      );
      for (const agent of managedAgents) {
        await repo.setAgentAuth(agent.id, encryptedApiKey);
      }
      return {
        updated: managedAgents.length,
        agents: managedAgents.map((agent) => agent.slug),
      };
    } finally {
      await repo.close();
    }
  }

  async close(): Promise<void> {
    await this.repo.close();
  }

  async refreshManagedAgentAuth(): Promise<MswarmManagedAuthRefreshSummary> {
    return MswarmApi.refreshManagedAgentAuth(this.requireApiKey());
  }

  private requireApiKey(): string {
    if (!this.options.apiKey) {
      throw new Error('MCODA_MSWARM_API_KEY is required');
    }
    return this.options.apiKey;
  }

  private async requestJson<T>(
    pathname: string,
    query?: Record<string, string | number | undefined>,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> }
  ): Promise<T> {
    const url = new URL(pathname, this.options.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs
    );
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(init?.headers ?? {}),
      };
      if (this.options.apiKey) {
        headers['x-api-key'] = this.options.apiKey;
      }
      let body: string | undefined;
      if (init?.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.body);
      }
      const response = await fetch(url.toString(), {
        method: init?.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `mswarm request failed (${response.status}): ${body || response.statusText}`
        );
      }
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new Error(
          `mswarm response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `mswarm request timed out after ${this.options.timeoutMs}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listCloudAgents(
    options: ListMswarmCloudAgentsOptions = {}
  ): Promise<MswarmCloudAgent[]> {
    const remoteLimit = hasAdvancedCloudAgentSelection(options)
      ? undefined
      : options.limit;
    const payload = await this.requestJson<ListMswarmCloudAgentsResponse>(
      '/v1/swarm/cloud/agents',
      {
        shape: 'mcoda',
        provider: options.provider,
        limit: remoteLimit,
      }
    );
    const agents = Array.isArray(payload.agents) ? payload.agents : [];
    return applyCloudAgentListOptions(agents.map(toCloudAgent), options);
  }

  async getCloudAgent(slug: string): Promise<MswarmCloudAgentDetail> {
    if (!slug.trim()) {
      throw new Error('Cloud-agent slug is required');
    }
    const payload = await this.requestJson<unknown>(
      `/v1/swarm/cloud/agents/${encodeURIComponent(slug)}`
    );
    return toCloudAgentDetail(payload);
  }

  async syncCloudAgents(
    options: ListMswarmCloudAgentsOptions = {}
  ): Promise<MswarmSyncSummary> {
    if (
      options.pruneMissing &&
      (options.limit !== undefined || hasAdvancedCloudAgentSelection(options))
    ) {
      throw new Error(
        'pruneMissing cannot be combined with limit or advanced cloud-agent filters'
      );
    }
    const agents = await this.listCloudAgents(options);
    const openAiBaseUrl =
      this.options.openAiBaseUrl ??
      new URL('/v1/swarm/openai/', this.options.baseUrl).toString();
    const syncedAt = new Date().toISOString();
    const encryptedApiKey = await CryptoHelper.encryptSecret(
      this.requireApiKey()
    );
    const records: MswarmSyncRecord[] = [];

    for (const agent of agents) {
      const localSlug = toManagedLocalSlug(
        this.options.agentSlugPrefix,
        agent.slug
      );
      const existing = await this.repo.getAgentBySlug(localSlug);
      if (
        existing &&
        (!isManagedMswarmConfig(existing.config) ||
          existing.config.mswarmCloud.remoteSlug !== agent.slug)
      ) {
        throw new Error(`Refusing to overwrite non-mswarm agent ${localSlug}`);
      }

      const existingConfig =
        existing && isRecord(existing.config)
          ? (existing.config as Record<string, unknown>)
          : undefined;
      const nextConfig = toManagedConfig(
        existingConfig,
        this.options.baseUrl,
        openAiBaseUrl,
        agent,
        syncedAt
      );
      const createInput = toSyncedAgentInput(
        existing,
        agent,
        localSlug,
        nextConfig,
        syncedAt
      );
      const { slug: _ignoredSlug, ...updateInput } = createInput;
      const stored = existing
        ? await this.repo.updateAgent(
            existing.id,
            updateInput as UpdateAgentInput
          )
        : await this.repo.createAgent(createInput);
      if (!stored) {
        throw new Error(`Failed to persist synced agent ${localSlug}`);
      }

      await this.repo.setAgentModels(
        stored.id,
        toAgentModels(stored.id, agent)
      );
      await this.repo.setAgentAuth(stored.id, encryptedApiKey);
      const existingHealth = existing
        ? await this.repo.getAgentHealth(existing.id)
        : undefined;
      const mappedHealth = toHealthStatus(agent.health_status);
      if (mappedHealth && shouldReplaceManagedHealth(existingHealth)) {
        const health: AgentHealth = {
          agentId: stored.id,
          status: mappedHealth,
          lastCheckedAt: syncedAt,
          details: {
            source: 'mswarm',
            remoteSlug: agent.slug,
            remoteHealthStatus: agent.health_status,
          },
        };
        await this.repo.setAgentHealth(health);
      }

      records.push(
        toManagedSyncRecord(
          nextConfig,
          localSlug,
          agent.default_model,
          existing ? 'updated' : 'created'
        )
      );
    }

    if (options.pruneMissing) {
      const remoteSlugs = new Set(agents.map((agent) => agent.slug));
      const localAgents = await this.repo.listAgents();
      for (const localAgent of localAgents) {
        const managedConfig = isManagedMswarmConfig(localAgent.config)
          ? localAgent.config
          : undefined;
        if (!managedConfig) continue;
        if (
          options.provider &&
          managedConfig.mswarmCloud.provider !== options.provider
        ) {
          continue;
        }
        if (remoteSlugs.has(managedConfig.mswarmCloud.remoteSlug)) continue;
        await this.repo.deleteAgent(localAgent.id);
        records.push(
          toManagedSyncRecord(
            managedConfig,
            localAgent.slug,
            localAgent.defaultModel ?? managedConfig.mswarmCloud.modelId ?? '-',
            'deleted'
          )
        );
      }
    }

    return {
      created: records.filter((record) => record.action === 'created').length,
      updated: records.filter((record) => record.action === 'updated').length,
      deleted: records.filter((record) => record.action === 'deleted').length,
      agents: records,
    };
  }

  async issuePaidConsent(
    policyVersion = MSWARM_CONSENT_POLICY_VERSION
  ): Promise<MswarmConsentResponse> {
    const apiKey = this.requireApiKey();
    return this.requestJson<MswarmConsentResponse>(
      '/v1/swarm/consent/issue',
      undefined,
      {
        method: 'POST',
        body: {
          consent_types: [...MCODA_CONSENT_TYPES],
          policy_version: policyVersion,
          timestamp_ms: Date.now(),
          proof: {
            type: 'api_key',
            value: apiKey,
          },
        },
      }
    );
  }

  async registerFreeMcodaClient(
    options: RegisterFreeMcodaClientOptions
  ): Promise<MswarmConsentResponse> {
    return this.requestJson<MswarmConsentResponse>(
      '/v1/swarm/mcoda/free-client/register',
      undefined,
      {
        method: 'POST',
        body: {
          client_id: options.clientId,
          product: MCODA_PRODUCT_SLUG,
          product_version: options.productVersion,
          policy_version:
            options.policyVersion ?? MSWARM_CONSENT_POLICY_VERSION,
          timestamp_ms: Date.now(),
          consent_types: [...MCODA_CONSENT_TYPES],
        },
      }
    );
  }

  async revokeConsent(
    consentToken: string,
    reason?: string
  ): Promise<{ revoked: boolean; revoked_at_ms?: number }> {
    return this.requestJson<{ revoked: boolean; revoked_at_ms?: number }>(
      '/v1/swarm/consent/revoke',
      undefined,
      {
        method: 'POST',
        body: {
          consent_token: consentToken,
          reason,
        },
      }
    );
  }

  async requestDataDeletion(
    input: RequestMswarmDataDeletionInput
  ): Promise<MswarmDataDeletionResponse> {
    return this.requestJson<MswarmDataDeletionResponse>(
      '/v1/swarm/data/deletion-request',
      undefined,
      {
        method: 'POST',
        body: {
          consent_token: input.consentToken,
          product: input.product,
          client_id: input.clientId,
          client_type: input.clientType,
          reason: input.reason,
        },
      }
    );
  }
}
