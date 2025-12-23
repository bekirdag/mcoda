import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_TEMPERATURE = 0.1;

const normalizeBaseUrl = (value?: unknown): string | undefined => {
  if (!value) return undefined;
  const str = String(value).trim();
  if (!str) return undefined;
  return str.endsWith("/") ? str.slice(0, -1) : str;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extractUsage = (usage: any) => {
  if (!usage || typeof usage !== "object") return undefined;
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
  if (tokensPrompt === undefined && tokensCompletion === undefined && tokensTotal === undefined) return undefined;
  return { tokensPrompt, tokensCompletion, tokensTotal };
};

type ZhipuConfig = AdapterConfig & {
  baseUrl?: string;
  headers?: Record<string, string>;
  temperature?: number;
  thinking?: boolean;
  extraBody?: Record<string, unknown>;
};

export class ZhipuApiAdapter implements AgentAdapter {
  private baseUrl: string;
  private headers: Record<string, string> | undefined;
  private temperature: number | undefined;
  private thinking: boolean | undefined;
  private extraBody: Record<string, unknown> | undefined;

  constructor(private config: ZhipuConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl) ?? DEFAULT_BASE_URL;
    this.headers = isRecord((config as any).headers) ? ((config as any).headers as Record<string, string>) : undefined;
    this.temperature = typeof (config as any).temperature === "number" ? (config as any).temperature : undefined;
    this.thinking = typeof (config as any).thinking === "boolean" ? (config as any).thinking : undefined;
    this.extraBody = isRecord((config as any).extraBody) ? ((config as any).extraBody as Record<string, unknown>) : undefined;
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
        details: { reason: "missing_api_key" },
      };
    }
    return {
      agentId: this.config.agent.id,
      status: "healthy",
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 0,
      details: { adapter: "zhipu-api", model: this.config.model, baseUrl: this.baseUrl },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const url = this.ensureBaseUrl();
    const model = this.ensureModel();
    const apiKey = this.ensureApiKey();
    const body = this.buildBody(request.input, model, false);
    const resp = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey, false),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Zhipu chat completions failed (${resp.status}): ${text}`);
    }
    const data: any = await resp.json().catch(() => ({}));
    const choice = data?.choices?.[0];
    const message = choice?.message;
    const content = typeof message?.content === "string" ? message.content : undefined;
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : undefined;
    const output = content ?? reasoning ?? (typeof data?.output_text === "string" ? data.output_text : JSON.stringify(data));
    const usage = extractUsage(data?.usage);

    return {
      output: output.trim(),
      adapter: this.config.adapter ?? "zhipu-api",
      model,
      metadata: {
        mode: "api",
        adapterType: this.config.adapter ?? "zhipu-api",
        baseUrl: url,
        capabilities: this.config.capabilities,
        usage: data?.usage,
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
    const body = this.buildBody(request.input, model, true);
    const resp = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey, true),
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) {
      const text = !resp.ok ? await resp.text().catch(() => "") : "";
      throw new Error(`Zhipu chat completions (stream) failed (${resp.status}): ${text}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latestUsage: { tokensPrompt?: number; tokensCompletion?: number; tokensTotal?: number } | undefined;
    const buildChunk = (payload: string): InvocationResult | null => {
      const data = JSON.parse(payload);
      const choice = data?.choices?.[0];
      const delta = choice?.delta ?? choice?.message ?? {};
      const content = typeof delta?.content === "string" ? delta.content : "";
      const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
      const usage = extractUsage(data?.usage);
      if (usage) latestUsage = usage;
      const output = content || reasoning || "";
      const shouldEmit = Boolean(output) || Boolean(usage);
      if (!shouldEmit) return null;
      return {
        output,
        adapter: this.config.adapter ?? "zhipu-api",
        model,
        metadata: {
          mode: "api",
          adapterType: this.config.adapter ?? "zhipu-api",
          baseUrl: url,
          capabilities: this.config.capabilities,
          streaming: true,
          reasoning,
          usage: data?.usage,
          tokensPrompt: latestUsage?.tokensPrompt,
          tokensCompletion: latestUsage?.tokensCompletion,
          tokensTotal: latestUsage?.tokensTotal,
          tokens_prompt: latestUsage?.tokensPrompt,
          tokens_completion: latestUsage?.tokensCompletion,
          tokens_total: latestUsage?.tokensTotal,
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
          // Ignore malformed lines; keep streaming.
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
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
          // Ignore malformed lines; keep streaming.
        }
      }
    }
  }

  private assertConfig() {
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new Error("Zhipu baseUrl must start with http:// or https://");
    }
  }

  private ensureBaseUrl(): string {
    return this.baseUrl;
  }

  private ensureModel(): string {
    if (!this.config.model) {
      throw new Error("Zhipu model is not configured for this agent");
    }
    return this.config.model;
  }

  private ensureApiKey(): string {
    if (!this.config.apiKey) {
      throw new Error("AUTH_REQUIRED: Zhipu API key missing; run `mcoda agent auth set <name>`");
    }
    return this.config.apiKey;
  }

  private buildHeaders(apiKey: string, streaming: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(streaming ? { Accept: "text/event-stream" } : {}),
      ...(this.headers ?? {}),
    };
  }

  private buildBody(input: string, model: string, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: input }],
      stream,
    };
    const temperature = this.temperature ?? DEFAULT_TEMPERATURE;
    if (typeof temperature === "number") body.temperature = temperature;
    if (typeof this.thinking === "boolean") body.thinking = this.thinking;
    if (this.extraBody) {
      for (const [key, value] of Object.entries(this.extraBody)) {
        if (body[key] === undefined) body[key] = value;
      }
    }
    return body;
  }
}
