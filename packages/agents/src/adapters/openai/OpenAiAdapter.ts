import { AgentHealth } from "@mcoda/shared";
import {
  AdapterConfig,
  AgentAdapter,
  InvocationRequest,
  InvocationResult,
  type DocdexRuntimeContext,
} from "../AdapterTypes.js";
import { parseUsageLimitError } from "../../AgentService/UsageLimitParser.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_RESPONSE_DETAIL_CHARS = 500;
const RATE_LIMIT_HEADER_NAMES = [
  "retry-after",
  "x-ratelimit-reset-after",
  "x-ratelimit-reset",
  "x-ratelimit-reset-at",
  "x-ratelimit-remaining",
] as const;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const resolveString = (value: unknown): string | undefined => {
  const raw = asString(value)?.trim();
  return raw ? raw : undefined;
};

const resolveBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeBaseUrl = (value?: unknown): string | undefined => {
  const str = resolveString(value);
  if (!str) return undefined;
  return str.endsWith("/") ? str.slice(0, -1) : str;
};

const resolveStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => resolveString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length ? entries : undefined;
};

const normalizeBooleanMap = (value: unknown): Record<string, boolean | undefined> | undefined => {
  if (!isRecord(value)) return undefined;
  const output: Record<string, boolean | undefined> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") output[key] = entry;
  }
  return Object.keys(output).length ? output : undefined;
};

const firstDefined = <T>(...values: Array<T | undefined>): T | undefined =>
  values.find((value): value is T => value !== undefined);

const readRecord = (record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const buildRateLimitProbeMessage = (response: Response, responseText: string): string => {
  const parts = [`openai_probe http ${response.status}`];
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const retryAfterSeconds = Number.parseInt(retryAfter, 10);
    parts.push(
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? `Retry after ${retryAfterSeconds} seconds`
        : `Retry after ${retryAfter}`,
    );
  }
  for (const headerName of RATE_LIMIT_HEADER_NAMES) {
    if (headerName === "retry-after") continue;
    const headerValue = response.headers.get(headerName)?.trim();
    if (headerValue) {
      parts.push(`${headerName}: ${headerValue}`);
    }
  }
  const trimmedResponse = responseText.trim();
  if (trimmedResponse) {
    parts.push(trimmedResponse);
  }
  return parts.join(". ");
};

const resolveRetryAfterMs = (resetAt: string | undefined, nowMs: number): number | undefined => {
  if (!resetAt) return undefined;
  const timestampMs = Date.parse(resetAt);
  if (!Number.isFinite(timestampMs)) return undefined;
  return Math.max(0, timestampMs - nowMs);
};

const resolveBaseUrl = (config: AdapterConfig): string => {
  const anyConfig = config as unknown as Record<string, unknown>;
  const agentConfig = (config.agent as unknown as Record<string, unknown>)?.config as
    | Record<string, unknown>
    | undefined;
  return (
    normalizeBaseUrl(anyConfig.baseUrl) ??
    normalizeBaseUrl(anyConfig.endpoint) ??
    normalizeBaseUrl(anyConfig.apiBaseUrl) ??
    normalizeBaseUrl(agentConfig?.baseUrl) ??
    normalizeBaseUrl(agentConfig?.endpoint) ??
    normalizeBaseUrl(agentConfig?.apiBaseUrl) ??
    DEFAULT_BASE_URL
  );
};

const isManagedMswarmConfig = (config: AdapterConfig): boolean => {
  const anyConfig = config as unknown as Record<string, unknown>;
  const agentConfig = (config.agent as unknown as Record<string, unknown>)?.config as
    | Record<string, unknown>
    | undefined;
  const cloud = readRecord(anyConfig, "mswarmCloud") ?? readRecord(agentConfig, "mswarmCloud");
  const selfHosted = readRecord(anyConfig, "mswarmSelfHosted") ?? readRecord(agentConfig, "mswarmSelfHosted");
  const worker = readRecord(anyConfig, "mswarmWorker") ?? readRecord(agentConfig, "mswarmWorker");
  return cloud?.managed === true || selfHosted?.managed === true || worker?.managed === true;
};

const resolveDocdexContext = (
  config: AdapterConfig,
  metadata: Record<string, unknown> | undefined,
): DocdexRuntimeContext | undefined => {
  if (!isManagedMswarmConfig(config)) return undefined;
  const anyConfig = config as unknown as Record<string, unknown>;
  const configDocdex = isRecord(anyConfig.docdex) ? anyConfig.docdex : undefined;
  const metadataDocdexValue = metadata?.docdex;
  const metadataDocdex = isRecord(metadataDocdexValue) ? metadataDocdexValue : undefined;
  const enabled = firstDefined(
    resolveBoolean(metadataDocdex?.enabled),
    resolveBoolean(metadata?.docdexEnabled),
    resolveBoolean(metadata?.docdex_enabled),
    resolveBoolean(configDocdex?.enabled),
  );
  if (enabled === false) return undefined;

  const baseUrl = firstDefined(
    resolveString(metadataDocdex?.baseUrl),
    resolveString(metadataDocdex?.base_url),
    resolveString(metadata?.docdexBaseUrl),
    resolveString(metadata?.docdex_base_url),
    resolveString(anyConfig.docdexBaseUrl),
    resolveString(configDocdex?.baseUrl),
    resolveString(configDocdex?.base_url),
  );
  const repoId = firstDefined(
    resolveString(metadataDocdex?.repoId),
    resolveString(metadataDocdex?.repo_id),
    resolveString(metadata?.docdexRepoId),
    resolveString(metadata?.docdex_repo_id),
    resolveString(anyConfig.docdexRepoId),
    resolveString(configDocdex?.repoId),
    resolveString(configDocdex?.repo_id),
  );
  const repoRoot = firstDefined(
    resolveString(metadataDocdex?.repoRoot),
    resolveString(metadataDocdex?.repo_root),
    resolveString(metadata?.docdexRepoRoot),
    resolveString(metadata?.docdex_repo_root),
    resolveString(anyConfig.docdexRepoRoot),
    resolveString(configDocdex?.repoRoot),
    resolveString(configDocdex?.repo_root),
  );
  const required = firstDefined(
    resolveBoolean(metadataDocdex?.required),
    resolveBoolean(metadata?.docdexRequired),
    resolveBoolean(metadata?.docdex_required),
    resolveBoolean(configDocdex?.required),
  );
  const allowedOperations = firstDefined(
    resolveStringArray(metadataDocdex?.allowedOperations),
    resolveStringArray(metadataDocdex?.allowed_operations),
    resolveStringArray(metadata?.docdexAllowedOperations),
    resolveStringArray(metadata?.docdex_allowed_operations),
    resolveStringArray(configDocdex?.allowedOperations),
    resolveStringArray(configDocdex?.allowed_operations),
  );
  const credentialSource = firstDefined(
    resolveString(metadataDocdex?.credentialSource),
    resolveString(metadataDocdex?.credential_source),
    resolveString(metadata?.docdexCredentialSource),
    resolveString(metadata?.docdex_credential_source),
    resolveString(configDocdex?.credentialSource),
    resolveString(configDocdex?.credential_source),
  );
  const capabilities = firstDefined(
    normalizeBooleanMap(metadataDocdex?.capabilities),
    normalizeBooleanMap(metadata?.docdexCapabilities),
    normalizeBooleanMap(metadata?.docdex_capabilities),
    normalizeBooleanMap(configDocdex?.capabilities),
  );
  const dagSessionId = firstDefined(
    resolveString(metadataDocdex?.dagSessionId),
    resolveString(metadataDocdex?.dag_session_id),
    resolveString(metadata?.docdexDagSessionId),
    resolveString(metadata?.docdex_dag_session_id),
    resolveString(configDocdex?.dagSessionId),
    resolveString(configDocdex?.dag_session_id),
  );
  const initialize = firstDefined(resolveBoolean(metadataDocdex?.initialize), resolveBoolean(configDocdex?.initialize));
  const allowWeb = firstDefined(
    resolveBoolean(metadataDocdex?.allowWeb),
    resolveBoolean(metadataDocdex?.allow_web),
    resolveBoolean(configDocdex?.allowWeb),
    resolveBoolean(configDocdex?.allow_web),
  );
  const allowMemoryWrite = firstDefined(
    resolveBoolean(metadataDocdex?.allowMemoryWrite),
    resolveBoolean(metadataDocdex?.allow_memory_write),
    resolveBoolean(configDocdex?.allowMemoryWrite),
    resolveBoolean(configDocdex?.allow_memory_write),
  );
  const allowProfileWrite = firstDefined(
    resolveBoolean(metadataDocdex?.allowProfileWrite),
    resolveBoolean(metadataDocdex?.allow_profile_write),
    resolveBoolean(configDocdex?.allowProfileWrite),
    resolveBoolean(configDocdex?.allow_profile_write),
  );
  const allowIndexRebuild = firstDefined(
    resolveBoolean(metadataDocdex?.allowIndexRebuild),
    resolveBoolean(metadataDocdex?.allow_index_rebuild),
    resolveBoolean(configDocdex?.allowIndexRebuild),
    resolveBoolean(configDocdex?.allow_index_rebuild),
  );

  const hasContext =
    baseUrl !== undefined ||
    repoId !== undefined ||
    repoRoot !== undefined ||
    required !== undefined ||
    allowedOperations !== undefined ||
    capabilities !== undefined ||
    dagSessionId !== undefined ||
    initialize !== undefined ||
    allowWeb !== undefined ||
    allowMemoryWrite !== undefined ||
    allowProfileWrite !== undefined ||
    allowIndexRebuild !== undefined ||
    metadataDocdex !== undefined ||
    configDocdex !== undefined;
  if (!hasContext) return undefined;

  return {
    enabled: true,
    baseUrl,
    repoId,
    repoRoot,
    dagSessionId,
    required,
    allowedOperations,
    credentialSource: credentialSource ?? "attached_mswarm_api_key",
    capabilities,
    initialize,
    allowWeb,
    allowMemoryWrite,
    allowProfileWrite,
    allowIndexRebuild,
  };
};

const toDocdexRequestBody = (context: DocdexRuntimeContext): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  if (context.baseUrl !== undefined) body.base_url = context.baseUrl;
  if (context.repoId !== undefined) body.repo_id = context.repoId;
  if (context.repoRoot !== undefined) body.repo_root = context.repoRoot;
  if (context.dagSessionId !== undefined) body.dag_session_id = context.dagSessionId;
  if (context.required !== undefined) body.required = context.required;
  if (context.allowedOperations !== undefined) body.allowed_operations = context.allowedOperations;
  if (context.credentialSource !== undefined) body.credential_source = context.credentialSource;
  if (context.capabilities !== undefined) body.capabilities = context.capabilities;
  if (context.initialize !== undefined) body.initialize = context.initialize;
  if (context.allowWeb !== undefined) body.allow_web = context.allowWeb;
  if (context.allowMemoryWrite !== undefined) body.allow_memory_write = context.allowMemoryWrite;
  if (context.allowProfileWrite !== undefined) body.allow_profile_write = context.allowProfileWrite;
  if (context.allowIndexRebuild !== undefined) body.allow_index_rebuild = context.allowIndexRebuild;
  return body;
};

const extractUsage = (usage: unknown) => {
  if (!isRecord(usage)) return undefined;
  const tokensPrompt =
    typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage.promptTokens === "number"
        ? usage.promptTokens
        : undefined;
  const tokensCompletion =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.completionTokens === "number"
        ? usage.completionTokens
        : undefined;
  let tokensTotal =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : undefined;
  if (tokensTotal === undefined && typeof tokensPrompt === "number" && typeof tokensCompletion === "number") {
    tokensTotal = tokensPrompt + tokensCompletion;
  }
  if (tokensPrompt === undefined && tokensCompletion === undefined && tokensTotal === undefined) {
    return undefined;
  }
  return { tokensPrompt, tokensCompletion, tokensTotal };
};

const collectContentText = (value: unknown): string[] => {
  const direct = asString(value);
  if (direct !== undefined) return [direct];
  if (Array.isArray(value)) return value.flatMap((entry) => collectContentText(entry));
  if (!isRecord(value)) return [];

  const partType = resolveString(value.type)?.toLowerCase();
  if (partType?.startsWith("reasoning")) return [];

  if (asString(value.text) !== undefined) return [value.text as string];
  if (asString(value.output_text) !== undefined) return [value.output_text as string];
  if (asString(value.input_text) !== undefined) return [value.input_text as string];
  if ("content" in value) return collectContentText(value.content);
  return [];
};

const collectReasoningText = (value: unknown): string[] => {
  const direct = asString(value);
  if (direct !== undefined) return [direct];
  if (Array.isArray(value)) return value.flatMap((entry) => collectReasoningText(entry));
  if (!isRecord(value)) return [];

  const partType = resolveString(value.type)?.toLowerCase();
  if (partType?.startsWith("reasoning")) {
    if (asString(value.text) !== undefined) return [value.text as string];
    if ("content" in value) return collectReasoningText(value.content);
  }

  const reasoningFields = [value.reasoning_content, value.reasoning_text, value.summary, value.reasoning];
  const segments = reasoningFields.flatMap((entry) => collectReasoningText(entry));
  if (segments.length > 0) return segments;
  return [];
};

const collapseText = (segments: string[]): string | undefined => {
  const joined = segments.join("");
  const trimmed = joined.trim();
  return trimmed ? trimmed : undefined;
};

const extractResponseText = (data: unknown): { output?: string; reasoning?: string } => {
  const payload = isRecord(data) ? data : {};
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0];
  const message = isRecord(choice) && (isRecord(choice.message) ? choice.message : isRecord(choice.delta) ? choice.delta : {})
    ? (isRecord(choice.message) ? choice.message : choice.delta) as Record<string, unknown>
    : {};
  const content = collapseText(collectContentText(message.content ?? message));
  const reasoning = collapseText(collectReasoningText(message.reasoning ?? message));
  const fallback =
    resolveString(payload.output_text) ??
    collapseText(collectContentText(payload.output ?? payload.response ?? payload.data));
  return { output: content ?? reasoning ?? fallback, reasoning };
};

type OpenAiConfig = AdapterConfig & {
  baseUrl?: string;
  endpoint?: string;
  apiBaseUrl?: string;
  headers?: Record<string, string>;
  temperature?: number;
  extraBody?: Record<string, unknown>;
};

export class OpenAiAdapter implements AgentAdapter {
  private baseUrl: string;
  private headers: Record<string, string> | undefined;
  private temperature: number | undefined;
  private extraBody: Record<string, unknown> | undefined;

  constructor(private config: OpenAiConfig) {
    this.baseUrl = resolveBaseUrl(config);
    this.headers = isRecord((config as any).headers) ? ((config as any).headers as Record<string, string>) : undefined;
    this.temperature = typeof (config as any).temperature === "number" ? (config as any).temperature : undefined;
    this.extraBody = isRecord((config as any).extraBody)
      ? ((config as any).extraBody as Record<string, unknown>)
      : undefined;
    this.assertConfig();
  }

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities;
  }

  async healthCheck(): Promise<AgentHealth> {
    if (!this.config.apiKey) {
      return {
        agentId: this.config.agent.id,
        status: "unreachable",
        lastCheckedAt: new Date().toISOString(),
        details: {
          adapter: "openai-api",
          source: "openai_probe",
          model: this.config.model,
          baseUrl: this.baseUrl,
          reason: "missing_api_key",
        },
      };
    }
    const startedAt = Date.now();
    try {
      const model = this.ensureModel();
      const apiKey = this.ensureApiKey();
      const url = this.ensureBaseUrl();
      const response = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(apiKey, false),
        body: JSON.stringify(this.buildHealthCheckBody(model)),
      });
      const responseText = await response.text().catch(() => "");
      const checkedAtMs = Date.now();
      const lastCheckedAt = new Date(checkedAtMs).toISOString();
      const latencyMs = checkedAtMs - startedAt;
      if (!response.ok) {
        if (response.status === 429) {
          const parsedLimit = parseUsageLimitError(
            new Error(buildRateLimitProbeMessage(response, responseText)),
            checkedAtMs,
          );
          return {
            agentId: this.config.agent.id,
            status: "healthy",
            lastCheckedAt,
            latencyMs,
            details: {
              adapter: "openai-api",
              source: "openai_probe",
              model,
              baseUrl: url,
              reason: "rate_limited",
              transient: true,
              rateLimited: true,
              httpStatus: response.status,
              response: responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS),
              resetAt: parsedLimit?.resetAt,
              resetAtSource: parsedLimit?.resetAtSource,
              retryAfterMs: resolveRetryAfterMs(parsedLimit?.resetAt, checkedAtMs),
              windowTypes: parsedLimit?.windowTypes,
            },
          };
        }
        return {
          agentId: this.config.agent.id,
          status: "unreachable",
          lastCheckedAt,
          latencyMs,
          details: {
            adapter: "openai-api",
            source: "openai_probe",
            model,
            baseUrl: url,
            reason: "http_error",
            httpStatus: response.status,
            response: responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS),
          },
        };
      }
      return {
        agentId: this.config.agent.id,
        status: "healthy",
        lastCheckedAt,
        latencyMs,
        details: {
          adapter: "openai-api",
          source: "openai_probe",
          model,
          baseUrl: url,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /model is not configured/i.test(message)
        ? "missing_model"
        : /missing api key/i.test(message)
          ? "missing_api_key"
          : "probe_failed";
      return {
        agentId: this.config.agent.id,
        status: "unreachable",
        lastCheckedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        details: {
          adapter: "openai-api",
          source: "openai_probe",
          model: this.config.model,
          baseUrl: this.baseUrl,
          reason,
          error: message,
        },
      };
    }
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const url = this.ensureBaseUrl();
    const model = this.ensureModel();
    const apiKey = this.ensureApiKey();
    const docdex = resolveDocdexContext(this.config, request.metadata);
    const resp = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey, false, docdex),
      body: JSON.stringify(this.buildBody(request.input, model, false, docdex)),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`OpenAI chat completions failed (${resp.status}): ${text}`);
    }
    const data: unknown = await resp.json().catch(() => ({}));
    const usage = extractUsage(isRecord(data) ? data.usage : undefined);
    const { output, reasoning } = extractResponseText(data);

    return {
      output: (output ?? JSON.stringify(data)).trim(),
      adapter: this.config.adapter ?? "openai-api",
      model,
      metadata: {
        mode: "api",
        capabilities: this.config.capabilities,
        prompts: this.config.prompts,
        authMode: "api",
        adapterType: this.config.adapter ?? "openai-api",
        baseUrl: url,
        usage: isRecord(data) ? data.usage : undefined,
        tokensPrompt: usage?.tokensPrompt,
        tokensCompletion: usage?.tokensCompletion,
        tokensTotal: usage?.tokensTotal,
        tokens_prompt: usage?.tokensPrompt,
        tokens_completion: usage?.tokensCompletion,
        tokens_total: usage?.tokensTotal,
        reasoning,
      },
    };
  }

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
    const url = this.ensureBaseUrl();
    const model = this.ensureModel();
    const apiKey = this.ensureApiKey();
    const docdex = resolveDocdexContext(this.config, request.metadata);
    const resp = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey, true, docdex),
      body: JSON.stringify(this.buildBody(request.input, model, true, docdex)),
    });
    if (!resp.ok || !resp.body) {
      const text = !resp.ok ? await resp.text().catch(() => "") : "";
      throw new Error(`OpenAI chat completions (stream) failed (${resp.status}): ${text}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latestUsage: { tokensPrompt?: number; tokensCompletion?: number; tokensTotal?: number } | undefined;

    const buildChunk = (payload: string): InvocationResult | null => {
      const data = JSON.parse(payload) as unknown;
      const usage = extractUsage(isRecord(data) ? data.usage : undefined);
      if (usage) latestUsage = usage;
      const { output, reasoning } = extractResponseText(data);
      if (!output && !usage) return null;
      return {
        output: output ?? "",
        adapter: this.config.adapter ?? "openai-api",
        model,
        metadata: {
          mode: "api",
          authMode: "api",
          adapterType: this.config.adapter ?? "openai-api",
          baseUrl: url,
          capabilities: this.config.capabilities,
          prompts: this.config.prompts,
          streaming: true,
          usage: isRecord(data) ? data.usage : undefined,
          tokensPrompt: latestUsage?.tokensPrompt,
          tokensCompletion: latestUsage?.tokensCompletion,
          tokensTotal: latestUsage?.tokensTotal,
          tokens_prompt: latestUsage?.tokensPrompt,
          tokens_completion: latestUsage?.tokensCompletion,
          tokens_total: latestUsage?.tokensTotal,
          reasoning,
          raw: payload,
        },
      };
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return;
        try {
          const chunk = buildChunk(payload);
          if (chunk) yield chunk;
        } catch {
          // Ignore malformed SSE lines and continue streaming.
        }
      }
    }

    const tail = buffer.trim();
    if (!tail) return;
    const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = buildChunk(payload);
        if (chunk) yield chunk;
      } catch {
        // Ignore malformed SSE lines and continue streaming.
      }
    }
  }

  private assertConfig() {
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new Error("OpenAI baseUrl must start with http:// or https://");
    }
  }

  private ensureBaseUrl(): string {
    return this.baseUrl;
  }

  private ensureModel(): string {
    if (!this.config.model) {
      throw new Error("OpenAI model is not configured for this agent");
    }
    return this.config.model;
  }

  private ensureApiKey(): string {
    if (!this.config.apiKey) {
      throw new Error(
        `AUTH_REQUIRED: OpenAI API key missing; run \`mcoda agent auth set ${this.config.agent.slug ?? this.config.agent.id}\``,
      );
    }
    return this.config.apiKey;
  }

  private buildHeaders(
    apiKey: string,
    streaming: boolean,
    docdex?: DocdexRuntimeContext,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: streaming ? "text/event-stream" : "application/json",
      ...(docdex?.repoId ? { "x-docdex-repo-id": docdex.repoId } : {}),
      ...(docdex?.repoRoot ? { "x-docdex-repo-root": docdex.repoRoot } : {}),
      ...(docdex?.dagSessionId ? { "x-docdex-dag-session": docdex.dagSessionId } : {}),
      ...(this.headers ?? {}),
    };
  }

  private buildBody(
    input: string,
    model: string,
    stream: boolean,
    docdex?: DocdexRuntimeContext,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: input }],
      stream,
    };
    if (docdex) {
      body.docdex = toDocdexRequestBody(docdex);
    }
    if (typeof this.temperature === "number") {
      body.temperature = this.temperature;
    }
    if (this.extraBody) {
      for (const [key, value] of Object.entries(this.extraBody)) {
        if (body[key] === undefined) body[key] = value;
      }
    }
    if (stream && body.stream_options === undefined) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private buildHealthCheckBody(model: string): Record<string, unknown> {
    const body = this.buildBody("healthcheck", model, false);
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
      body.max_tokens = 1;
    }
    if (body.temperature === undefined) {
      body.temperature = 0;
    }
    return body;
  }
}
