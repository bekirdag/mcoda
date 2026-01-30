import { GlobalRepository } from "@mcoda/db";
import { CryptoHelper, type Agent } from "@mcoda/shared";

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
}

const PROVIDERS_REQUIRING_API_KEY = new Set(["openai-compatible"]);
const PROVIDERS_REQUIRING_BASE_URL = new Set(["ollama-remote"]);
const SESSION_AUTH_ADAPTERS = new Set(["codex-cli", "openai-cli", "gemini-cli"]);
const UNSUPPORTED_CODALI_ADAPTERS = new Set(["gemini-cli", "zhipu-api"]);

const resolveString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value : undefined;
};

const resolveBaseUrl = (agent: Agent): string | undefined => {
  const config = (agent.config ?? {}) as Record<string, unknown>;
  return (
    resolveString(config.baseUrl) ??
    resolveString(config.endpoint) ??
    resolveString(config.apiBaseUrl)
  );
};

export const resolveProviderFromAdapter = (
  adapter: string,
  explicitProvider?: string,
): { provider: string; requiresApiKey: boolean } => {
  if (explicitProvider) {
    const requiresApiKey =
      PROVIDERS_REQUIRING_API_KEY.has(explicitProvider) &&
      !SESSION_AUTH_ADAPTERS.has(adapter);
    return { provider: explicitProvider, requiresApiKey };
  }
  if (UNSUPPORTED_CODALI_ADAPTERS.has(adapter)) {
    throw new Error(
      `CODALI_UNSUPPORTED_ADAPTER: ${adapter} is not supported; configure a codali provider explicitly or choose a different agent.`,
    );
  }
  if (adapter === "openai-api") {
    return { provider: "openai-compatible", requiresApiKey: true };
  }
  if (["openai-cli", "codex-cli"].includes(adapter)) {
    return { provider: "codex-cli", requiresApiKey: false };
  }
  if (["ollama-remote", "ollama-cli", "local-model"].includes(adapter)) {
    return { provider: "ollama-remote", requiresApiKey: false };
  }
  throw new Error(
    `CODALI_UNSUPPORTED_ADAPTER: ${adapter} is not supported; configure a codali provider explicitly or choose a different agent.`,
  );
};

export const resolveAgentConfigFromRecord = async (
  agent: Agent,
  repo: GlobalRepository,
  overrides: AgentResolutionOverrides = {},
): Promise<ResolvedAgentConfig> => {
  const { provider, requiresApiKey } = resolveProviderFromAdapter(
    agent.adapter,
    overrides.provider,
  );
  if (provider === "openai-compatible" && agent.openaiCompatible === false) {
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
  const baseUrl = overrides.baseUrl ?? resolveBaseUrl(agent);
  if (PROVIDERS_REQUIRING_BASE_URL.has(provider) && !baseUrl) {
    const label = agent.slug ?? agent.id;
    throw new Error(
      `Agent ${label} is missing a baseUrl for provider ${provider}; update the agent config.`,
    );
  }
  let apiKey = overrides.apiKey;
  if (!apiKey && requiresApiKey) {
    const secret = await repo.getAgentAuthSecret(agent.id);
    if (secret?.encryptedSecret) {
      apiKey = await CryptoHelper.decryptSecret(secret.encryptedSecret);
    }
  }
  if (requiresApiKey && !apiKey) {
    const label = agent.slug ?? agent.id;
    throw new Error(
      `AUTH_REQUIRED: API key missing for agent ${label}; run \"mcoda agent auth set ${label}\".`,
    );
  }

  return { agent, provider, model, baseUrl, apiKey, requiresApiKey };
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
