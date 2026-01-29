import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
import { cliHealthy, runCodaliExec } from "./CodaliCliRunner.js";

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
const UNSUPPORTED_CODALI_ADAPTERS = new Set(["gemini-cli", "zhipu-api"]);

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
}): { provider: string; sourceAdapter?: string; requiresApiKey: boolean } => {
  const sourceAdapter = params.sourceAdapter;
  const explicitProvider = params.explicitProvider;
  if (explicitProvider) {
    return {
      provider: explicitProvider,
      sourceAdapter,
      requiresApiKey: PROVIDERS_REQUIRING_API_KEY.has(explicitProvider),
    };
  }

  if (sourceAdapter) {
    if (UNSUPPORTED_CODALI_ADAPTERS.has(sourceAdapter)) {
      throw new Error(
        `CODALI_UNSUPPORTED_ADAPTER: ${sourceAdapter} is not supported; configure a codali provider explicitly or use an openai/ollama adapter.`,
      );
    }
    if (["openai-api", "openai-cli", "codex-cli"].includes(sourceAdapter)) {
      return { provider: "openai-compatible", sourceAdapter, requiresApiKey: true };
    }
    if (["ollama-remote", "ollama-cli", "local-model"].includes(sourceAdapter)) {
      return { provider: "ollama-remote", sourceAdapter, requiresApiKey: false };
    }
  }

  return { provider: "openai-compatible", sourceAdapter, requiresApiKey: true };
};

const resolveProviderInfo = (
  request: InvocationRequest,
  config: AdapterConfig,
): { provider: string; sourceAdapter?: string; requiresApiKey: boolean } => {
  const anyConfig = config as unknown as Record<string, unknown>;
  const explicitProvider = resolveString(anyConfig.provider) ?? resolveString(anyConfig.llmProvider);
  const sourceAdapter = resolveSourceAdapter(request, config);
  return resolveCodaliProviderFromAdapter({ sourceAdapter, explicitProvider });
};

const ensureApiKey = (provider: string, sourceAdapter: string | undefined, config: AdapterConfig): void => {
  if (!PROVIDERS_REQUIRING_API_KEY.has(provider)) return;
  if (config.apiKey || process.env.CODALI_API_KEY) return;
  const agentLabel = config.agent.slug ?? config.agent.id;
  const sourceLabel = sourceAdapter ? ` (source adapter: ${sourceAdapter})` : "";
  throw new Error(
    `AUTH_REQUIRED: API key missing for codali provider ${provider}${sourceLabel}; set CODALI_API_KEY or run \\\"mcoda agent auth set ${agentLabel}\\\".`,
  );
};

const resolveBaseUrl = (config: AdapterConfig): string | undefined => {
  const anyConfig = config as unknown as Record<string, unknown>;
  return resolveString(anyConfig.baseUrl) ?? resolveString(anyConfig.endpoint) ?? resolveString(anyConfig.apiBaseUrl);
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
  ensureApiKey(providerInfo.provider, providerInfo.sourceAdapter, this.config);
  const provider = providerInfo.provider;
  const agentId = resolveAgentId(request, this.config);
  const agentSlug = resolveAgentSlug(request, this.config);
  const baseUrl = resolveBaseUrl(this.config);
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
}
