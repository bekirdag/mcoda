import { GlobalRepository } from "@mcoda/db";
import {
  CryptoHelper,
  isLocalOpenAiCompatibleAdapter,
  normalizeLocalOpenAiCompatibleRunnerConfig,
  type Agent,
  type LocalOpenAiCompatibleRunnerConfig,
  type LocalRunnerAuthMode,
  type LocalRunnerKind,
  type LocalRunnerResponseFormatStrategy,
} from "@mcoda/shared";

export interface AgentResolutionOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedAgentConfig {
  agent: Agent;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  requiresApiKey: boolean;
  localRunner?: LocalOpenAiCompatibleRunnerConfig;
  runnerKind?: LocalRunnerKind;
  authMode?: LocalRunnerAuthMode;
  dummyBearerToken?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  responseFormatStrategy?: LocalRunnerResponseFormatStrategy;
  healthPath?: string;
  modelsPath?: string;
  requireModelInRequest?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsGbnf?: boolean;
}

const PROVIDERS_REQUIRING_API_KEY = new Set(["openai-compatible", "mswarm-worker"]);
const PROVIDERS_REQUIRING_BASE_URL = new Set(["ollama-remote", "mswarm-worker"]);
const SESSION_AUTH_ADAPTERS = new Set(["codex-cli", "openai-cli", "gemini-cli"]);
const UNSUPPORTED_CODALI_ADAPTERS = new Set(["gemini-cli", "zhipu-api"]);

const resolveString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value : undefined;
};

const readRecord = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : undefined;
};

const resolveBaseUrl = (agent: Agent): string | undefined => {
  const config = (agent.config ?? {}) as Record<string, unknown>;
  const worker = readRecord(config, "mswarmWorker");
  return (
    resolveString(worker?.apiRunUrl) ??
    resolveString(worker?.api_run_url) ??
    resolveString(config.baseUrl) ??
    resolveString(config.endpoint) ??
    resolveString(config.apiBaseUrl)
  );
};

export const resolveProviderFromAdapter = (
  adapter: string,
  explicitProvider?: string,
): { provider: string; requiresApiKey: boolean; localOpenAiCompatible: boolean } => {
  const localOpenAiCompatible = isLocalOpenAiCompatibleAdapter(adapter);
  if (explicitProvider) {
    const requiresApiKey =
      PROVIDERS_REQUIRING_API_KEY.has(explicitProvider) &&
      !SESSION_AUTH_ADAPTERS.has(adapter) &&
      !localOpenAiCompatible;
    return { provider: explicitProvider, requiresApiKey, localOpenAiCompatible };
  }
  if (UNSUPPORTED_CODALI_ADAPTERS.has(adapter)) {
    throw new Error(
      `CODALI_UNSUPPORTED_ADAPTER: ${adapter} is not supported; configure a codali provider explicitly or choose a different agent.`,
    );
  }
  if (adapter === "openai-api") {
    return { provider: "openai-compatible", requiresApiKey: true, localOpenAiCompatible };
  }
  if (localOpenAiCompatible) {
    return { provider: "openai-compatible", requiresApiKey: false, localOpenAiCompatible };
  }
  if (["openai-cli", "codex-cli"].includes(adapter)) {
    return { provider: "codex-cli", requiresApiKey: false, localOpenAiCompatible };
  }
  if (["ollama-remote", "ollama-cli", "local-model"].includes(adapter)) {
    return { provider: "ollama-remote", requiresApiKey: false, localOpenAiCompatible };
  }
  if (adapter === "mswarm-worker") {
    return { provider: "mswarm-worker", requiresApiKey: true, localOpenAiCompatible };
  }
  throw new Error(
    `CODALI_UNSUPPORTED_ADAPTER: ${adapter} is not supported; configure a codali provider explicitly or choose a different agent.`,
  );
};

const compactLocalRunnerConfig = (
  agent: Agent,
): LocalOpenAiCompatibleRunnerConfig | undefined => {
  const normalized = normalizeLocalOpenAiCompatibleRunnerConfig({
    adapter: agent.adapter,
    config: agent.config,
    agentConfig: agent.config,
  });
  const entries = Object.entries(normalized.config).filter(([, value]) => value !== undefined);
  if (!normalized.isLocalOpenAiCompatible && entries.length === 0) return undefined;
  return Object.fromEntries(entries) as LocalOpenAiCompatibleRunnerConfig;
};

export const resolveAgentConfigFromRecord = async (
  agent: Agent,
  repo: GlobalRepository,
  overrides: AgentResolutionOverrides = {},
): Promise<ResolvedAgentConfig> => {
  const { provider, requiresApiKey, localOpenAiCompatible } = resolveProviderFromAdapter(
    agent.adapter,
    overrides.provider,
  );
  const localRunner = compactLocalRunnerConfig(agent);
  const effectiveRequiresApiKey =
    requiresApiKey || (localOpenAiCompatible && localRunner?.authMode === "bearer");
  if (provider === "openai-compatible" && agent.openaiCompatible === false && !localOpenAiCompatible) {
    const label = agent.slug ?? agent.id;
    throw new Error(
      `Agent ${label} is not marked openai-compatible; update the agent metadata or choose a different provider.`,
    );
  }
  const model = overrides.model ?? agent.defaultModel;
  if (!model) {
    const label = agent.slug ?? agent.id;
    throw new Error(`Agent ${label} has no default model`);
  }
  const baseUrl = overrides.baseUrl ?? localRunner?.baseUrl ?? resolveBaseUrl(agent);
  if ((PROVIDERS_REQUIRING_BASE_URL.has(provider) || localOpenAiCompatible) && !baseUrl) {
    const label = agent.slug ?? agent.id;
    throw new Error(
      `Agent ${label} is missing a baseUrl for provider ${provider}; update the agent config.`,
    );
  }
  let apiKey = overrides.apiKey;
  if (!apiKey && effectiveRequiresApiKey) {
    const secret = await repo.getAgentAuthSecret(agent.id);
    if (secret?.encryptedSecret) {
      apiKey = await CryptoHelper.decryptSecret(secret.encryptedSecret);
    }
  }
  if (effectiveRequiresApiKey && !apiKey) {
    const label = agent.slug ?? agent.id;
    throw new Error(
      `AUTH_REQUIRED: API key missing for agent ${label}; run \"mcoda agent auth set ${label}\".`,
    );
  }

  return {
    agent,
    provider,
    model,
    baseUrl,
    apiKey,
    requiresApiKey: effectiveRequiresApiKey,
    localRunner,
    runnerKind: localRunner?.runnerKind,
    authMode: localRunner?.authMode,
    dummyBearerToken: localRunner?.dummyBearerToken,
    headers: localRunner?.headers,
    extraBody: localRunner?.extraBody,
    responseFormatStrategy: localRunner?.responseFormatStrategy,
    healthPath: localRunner?.healthPath,
    modelsPath: localRunner?.modelsPath,
    requireModelInRequest: localRunner?.requireModelInRequest,
    supportsStreaming: localRunner?.supportsStreaming,
    supportsTools: localRunner?.supportsTools,
    supportsJsonSchema: localRunner?.supportsJsonSchema,
    supportsGbnf: localRunner?.supportsGbnf,
  };
};

export const resolveAgentConfig = async (
  agentRef: string,
  overrides: AgentResolutionOverrides = {},
): Promise<ResolvedAgentConfig> => {
  const repo = await GlobalRepository.create();
  try {
    const agent =
      (await repo.getAgentById(agentRef)) ?? (await repo.getAgentBySlug(agentRef));
    if (!agent) {
      throw new Error(`Agent ${agentRef} not found`);
    }
    return await resolveAgentConfigFromRecord(agent, repo, overrides);
  } finally {
    await repo.close();
  }
};
