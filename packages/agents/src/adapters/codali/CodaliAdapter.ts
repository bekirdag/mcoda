import {
  AgentHealth,
  isLocalOpenAiCompatibleAdapter,
  normalizeLocalOpenAiCompatibleRunnerConfig,
  type LocalOpenAiCompatibleRunnerConfig,
} from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
import { cliHealthy, runCodaliExec, runCodaliStream, type CodaliCliOptions } from "./CodaliCliRunner.js";

const resolveString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

const resolveMetadataValue = (metadata: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const resolved = resolveString(metadata[key]);
    if (resolved) return resolved;
  }
  return undefined;
};

const resolveWorkspaceRoot = (request: InvocationRequest): string => {
  const metadata = request.metadata ?? {};
  return (
    resolveString(metadata.workspaceRoot) ??
    resolveString(metadata.workspace_root) ??
    resolveString(metadata.repoRoot) ??
    process.cwd()
  );
};

const resolveCodaliEnv = (metadata: Record<string, unknown>): Record<string, string> | undefined => {
  const raw = metadata.codaliEnv ?? metadata.codali_env;
  if (!raw || typeof raw !== "object") return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (value.trim().length > 0) env[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      env[key] = String(value);
    }
  }
  return Object.keys(env).length ? env : undefined;
};

const PROVIDERS_REQUIRING_API_KEY = new Set(["openai-compatible"]);
const SESSION_AUTH_ADAPTERS = new Set(["codex-cli", "openai-cli", "gemini-cli"]);
const UNSUPPORTED_CODALI_ADAPTERS = new Set(["gemini-cli", "zhipu-api"]);

type CodaliProviderResolution = {
  provider: string;
  sourceAdapter?: string;
  requiresApiKey: boolean;
  localOpenAiCompatible: boolean;
};

const resolveSourceAdapter = (request: InvocationRequest, config: AdapterConfig): string | undefined => {
  const metadata = request.metadata ?? {};
  return (
    resolveString((metadata as Record<string, unknown>).sourceAdapter) ??
    resolveString((metadata as Record<string, unknown>).agentAdapter) ??
    resolveString((metadata as Record<string, unknown>).agent_adapter) ??
    resolveString((config.agent as unknown as Record<string, unknown>)?.adapter) ??
    resolveString((config as unknown as Record<string, unknown>).sourceAdapter)
  );
};

const resolveAgentId = (request: InvocationRequest, config: AdapterConfig): string | undefined => {
  const metadata = request.metadata ?? {};
  return (
    resolveString((metadata as Record<string, unknown>).agentId) ??
    resolveString((metadata as Record<string, unknown>).agent_id) ??
    resolveString((config.agent as unknown as Record<string, unknown>)?.id)
  );
};

const resolveAgentSlug = (request: InvocationRequest, config: AdapterConfig): string | undefined => {
  const metadata = request.metadata ?? {};
  return (
    resolveString((metadata as Record<string, unknown>).agentSlug) ??
    resolveString((metadata as Record<string, unknown>).agent_slug) ??
    resolveString((config.agent as unknown as Record<string, unknown>)?.slug)
  );
};

export const resolveCodaliProviderFromAdapter = (params: {
  sourceAdapter?: string;
  explicitProvider?: string;
}): CodaliProviderResolution => {
  const sourceAdapter = params.sourceAdapter;
  const explicitProvider = params.explicitProvider;
  const localOpenAiCompatible = isLocalOpenAiCompatibleAdapter(sourceAdapter);
  if (explicitProvider) {
    const providerRequires = PROVIDERS_REQUIRING_API_KEY.has(explicitProvider);
    const sourceUsesSessionAuth = SESSION_AUTH_ADAPTERS.has(sourceAdapter ?? "") || localOpenAiCompatible;
    const requiresApiKey = providerRequires && !sourceUsesSessionAuth;
    return {
      provider: explicitProvider,
      sourceAdapter,
      requiresApiKey,
      localOpenAiCompatible,
    };
  }

  if (sourceAdapter) {
    if (UNSUPPORTED_CODALI_ADAPTERS.has(sourceAdapter)) {
      throw new Error(
        `CODALI_UNSUPPORTED_ADAPTER: ${sourceAdapter} is not supported; configure a codali provider explicitly or use an openai/ollama adapter.`,
      );
    }
    if (sourceAdapter === "openai-api") {
      return { provider: "openai-compatible", sourceAdapter, requiresApiKey: true, localOpenAiCompatible };
    }
    if (localOpenAiCompatible) {
      return { provider: "openai-compatible", sourceAdapter, requiresApiKey: false, localOpenAiCompatible };
    }
    if (["openai-cli", "codex-cli"].includes(sourceAdapter)) {
      return { provider: "codex-cli", sourceAdapter, requiresApiKey: false, localOpenAiCompatible };
    }
    if (["ollama-remote", "ollama-cli", "local-model"].includes(sourceAdapter)) {
      return { provider: "ollama-remote", sourceAdapter, requiresApiKey: false, localOpenAiCompatible };
    }
  }

  const requiresApiKey =
    PROVIDERS_REQUIRING_API_KEY.has("openai-compatible") && !SESSION_AUTH_ADAPTERS.has(sourceAdapter ?? "");
  return { provider: "openai-compatible", sourceAdapter, requiresApiKey, localOpenAiCompatible };
};

const resolveProviderInfo = (
  request: InvocationRequest,
  config: AdapterConfig,
): CodaliProviderResolution => {
  const anyConfig = config as unknown as Record<string, unknown>;
  const explicitProvider = resolveString(anyConfig.provider) ?? resolveString(anyConfig.llmProvider);
  const sourceAdapter = resolveSourceAdapter(request, config);
  return resolveCodaliProviderFromAdapter({ sourceAdapter, explicitProvider });
};

const ensureApiKey = (
  provider: string,
  sourceAdapter: string | undefined,
  requiresApiKey: boolean,
  config: AdapterConfig,
): void => {
  if (!requiresApiKey || !PROVIDERS_REQUIRING_API_KEY.has(provider)) return;
  if (config.apiKey || process.env.CODALI_API_KEY) return;
  const agentLabel = config.agent.slug ?? config.agent.id;
  const sourceLabel = sourceAdapter ? ` (source adapter: ${sourceAdapter})` : "";
  throw new Error(
    `AUTH_REQUIRED: API key missing for codali provider ${provider}${sourceLabel}; set CODALI_API_KEY or run \\\"mcoda agent auth set ${agentLabel}\\\".`,
  );
};

const ensureLocalOpenAiCompatibleBaseUrl = (
  providerInfo: CodaliProviderResolution,
  baseUrl: string | undefined,
): void => {
  if (providerInfo.provider !== "openai-compatible" || !providerInfo.localOpenAiCompatible || baseUrl) return;
  const sourceLabel = providerInfo.sourceAdapter ? ` (source adapter: ${providerInfo.sourceAdapter})` : "";
  throw new Error(
    `CONFIG_REQUIRED: baseUrl missing for local OpenAI-compatible codali provider${sourceLabel}; set config.baseUrl or agent.config.baseUrl.`,
  );
};

const resolveBaseUrl = (config: AdapterConfig): string | undefined => {
  const anyConfig = config as unknown as Record<string, unknown>;
  const agentConfig = (config.agent as unknown as Record<string, unknown>)?.config as
    | Record<string, unknown>
    | undefined;
  return (
    resolveString(anyConfig.baseUrl) ??
    resolveString(anyConfig.endpoint) ??
    resolveString(anyConfig.apiBaseUrl) ??
    resolveString(agentConfig?.baseUrl) ??
    resolveString(agentConfig?.endpoint) ??
    resolveString(agentConfig?.apiBaseUrl)
  );
};

const compactLocalRunnerConfig = (
  config: AdapterConfig,
): LocalOpenAiCompatibleRunnerConfig | undefined => {
  const normalized = normalizeLocalOpenAiCompatibleRunnerConfig({
    adapter: config.adapter ?? config.agent.adapter,
    config,
    agentConfig: config.agent.config,
  });
  const entries = Object.entries(normalized.config).filter(([, value]) => value !== undefined);
  if (!normalized.isLocalOpenAiCompatible && entries.length === 0) return undefined;
  return Object.fromEntries(entries) as LocalOpenAiCompatibleRunnerConfig;
};

const resolveLocalRunnerCliOptions = (
  config: AdapterConfig,
): Pick<
  CodaliCliOptions,
  | "localRunner"
  | "runnerKind"
  | "authMode"
  | "dummyBearerToken"
  | "headers"
  | "extraBody"
  | "responseFormatStrategy"
  | "healthPath"
  | "modelsPath"
  | "requireModelInRequest"
  | "supportsStreaming"
  | "supportsTools"
  | "supportsJsonSchema"
  | "supportsGbnf"
> => {
  const localRunner = compactLocalRunnerConfig(config);
  return {
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

const resolveDocdexBaseUrl = (config: AdapterConfig): string | undefined => {
  const anyConfig = config as unknown as Record<string, unknown>;
  return resolveString(anyConfig.docdexBaseUrl) ?? resolveString((anyConfig.docdex as any)?.baseUrl);
};

const resolveDocdexRepoId = (config: AdapterConfig): string | undefined => {
  const anyConfig = config as unknown as Record<string, unknown>;
  return resolveString(anyConfig.docdexRepoId) ?? resolveString((anyConfig.docdex as any)?.repoId);
};

const resolveDocdexRepoRoot = (config: AdapterConfig): string | undefined => {
  const anyConfig = config as unknown as Record<string, unknown>;
  return resolveString(anyConfig.docdexRepoRoot) ?? resolveString((anyConfig.docdex as any)?.repoRoot);
};

const resolveRunId = (metadata: Record<string, unknown>): string | undefined => {
  const explicit = resolveMetadataValue(metadata, ["runId", "run_id"]);
  if (explicit) return explicit;
  const commandRunId = resolveMetadataValue(metadata, ["commandRunId", "command_run_id"]);
  const taskKey = resolveMetadataValue(metadata, ["taskKey", "task_key"]);
  if (!commandRunId || !taskKey) return undefined;
  const raw = `${commandRunId}-${taskKey}`;
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
};

export class CodaliAdapter implements AgentAdapter {
  constructor(private config: AdapterConfig) {}

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities;
  }

  async healthCheck(): Promise<AgentHealth> {
    const started = Date.now();
    const health = cliHealthy();
    const status: AgentHealth["status"] = health.ok ? "healthy" : "unreachable";
    return {
      agentId: this.config.agent.id,
      status,
      lastCheckedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      details: { adapter: "codali-cli", ...(health.details ?? {}) },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
  const metadata = (request.metadata ?? {}) as Record<string, unknown>;
  const workspaceRoot = resolveWorkspaceRoot(request);
  const providerInfo = resolveProviderInfo(request, this.config);
  ensureApiKey(providerInfo.provider, providerInfo.sourceAdapter, providerInfo.requiresApiKey, this.config);
  const provider = providerInfo.provider;
  const agentId = resolveAgentId(request, this.config);
  const agentSlug = resolveAgentSlug(request, this.config);
  const baseUrl = resolveBaseUrl(this.config);
  ensureLocalOpenAiCompatibleBaseUrl(providerInfo, baseUrl);
  const localRunnerOptions = resolveLocalRunnerCliOptions(this.config);
  const docdexBaseUrl =
    resolveMetadataValue(metadata, ["docdexBaseUrl", "docdex_base_url"]) ?? resolveDocdexBaseUrl(this.config);
  const docdexRepoId =
    resolveMetadataValue(metadata, ["docdexRepoId", "docdex_repo_id"]) ?? resolveDocdexRepoId(this.config);
  const docdexRepoRoot =
    resolveMetadataValue(metadata, ["docdexRepoRoot", "docdex_repo_root"]) ?? resolveDocdexRepoRoot(this.config);
  const codaliEnv = resolveCodaliEnv(metadata);
  const runId = resolveRunId(metadata);
  const taskId = resolveMetadataValue(metadata, ["taskId", "task_id"]);
  const taskKey = resolveMetadataValue(metadata, ["taskKey", "task_key"]);
  const project = resolveMetadataValue(metadata, ["projectKey", "project_key", "project"]);
  const command = resolveMetadataValue(metadata, ["command"]);
    const commandRunId = resolveMetadataValue(metadata, ["commandRunId", "command_run_id"]);
    const jobId = resolveMetadataValue(metadata, ["jobId", "job_id"]);
    const result = runCodaliExec(request.input, {
      workspaceRoot,
      project,
      command,
    commandRunId,
    jobId,
    runId,
    taskId,
    taskKey,
    agentId,
    agentSlug,
    provider,
    model: this.config.model ?? "default",
    apiKey: this.config.apiKey,
    baseUrl,
    ...localRunnerOptions,
    docdexBaseUrl,
    docdexRepoId,
    docdexRepoRoot,
    env: codaliEnv,
  });

    return {
      output: result.output,
      adapter: this.config.adapter ?? "codali-cli",
      model: this.config.model,
      metadata: {
        mode: "cli",
        capabilities: this.config.capabilities,
        adapterType: this.config.adapter ?? "codali-cli",
        authMode: "cli",
        provider,
        sourceAdapter: providerInfo.sourceAdapter,
        baseUrl,
        logPath: result.meta?.logPath,
        touchedFiles: result.meta?.touchedFiles,
        runId: result.meta?.runId,
        command,
        commandRunId,
        jobId,
        agentId,
        agentSlug,
        project,
        taskId,
        taskKey,
        raw: result.raw,
      },
    };
  }

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
    const metadata = (request.metadata ?? {}) as Record<string, unknown>;
    const workspaceRoot = resolveWorkspaceRoot(request);
    const providerInfo = resolveProviderInfo(request, this.config);
    ensureApiKey(providerInfo.provider, providerInfo.sourceAdapter, providerInfo.requiresApiKey, this.config);
  const provider = providerInfo.provider;
  const agentId = resolveAgentId(request, this.config);
  const agentSlug = resolveAgentSlug(request, this.config);
  const baseUrl = resolveBaseUrl(this.config);
  ensureLocalOpenAiCompatibleBaseUrl(providerInfo, baseUrl);
  const localRunnerOptions = resolveLocalRunnerCliOptions(this.config);
    const docdexBaseUrl =
      resolveMetadataValue(metadata, ["docdexBaseUrl", "docdex_base_url"]) ?? resolveDocdexBaseUrl(this.config);
    const docdexRepoId =
      resolveMetadataValue(metadata, ["docdexRepoId", "docdex_repo_id"]) ?? resolveDocdexRepoId(this.config);
    const docdexRepoRoot =
      resolveMetadataValue(metadata, ["docdexRepoRoot", "docdex_repo_root"]) ?? resolveDocdexRepoRoot(this.config);
    const codaliEnv = resolveCodaliEnv(metadata);
    const runId = resolveRunId(metadata);
    const taskId = resolveMetadataValue(metadata, ["taskId", "task_id"]);
    const taskKey = resolveMetadataValue(metadata, ["taskKey", "task_key"]);
    const project = resolveMetadataValue(metadata, ["projectKey", "project_key", "project"]);
    const command = resolveMetadataValue(metadata, ["command"]);
    const commandRunId = resolveMetadataValue(metadata, ["commandRunId", "command_run_id"]);
    const jobId = resolveMetadataValue(metadata, ["jobId", "job_id"]);

    const baseMetadata = {
      mode: "cli",
      capabilities: this.config.capabilities,
      adapterType: this.config.adapter ?? "codali-cli",
      authMode: "cli",
      provider,
      sourceAdapter: providerInfo.sourceAdapter,
      baseUrl,
      command,
      commandRunId,
      jobId,
      agentId,
      agentSlug,
      project,
      taskId,
      taskKey,
    };

    const stream = runCodaliStream(request.input, {
      workspaceRoot,
      project,
      command,
      commandRunId,
      jobId,
      runId,
      taskId,
      taskKey,
      agentId,
      agentSlug,
      provider,
      model: this.config.model ?? "default",
      apiKey: this.config.apiKey,
      baseUrl,
      ...localRunnerOptions,
      docdexBaseUrl,
      docdexRepoId,
      docdexRepoRoot,
      env: codaliEnv,
    });

    for await (const chunk of stream) {
      const mergedMetadata = chunk.meta ? { ...baseMetadata, ...chunk.meta } : undefined;
      yield {
        output: chunk.output,
        adapter: this.config.adapter ?? "codali-cli",
        model: this.config.model,
        metadata: mergedMetadata,
      };
    }
  }
}
