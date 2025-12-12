import { AgentHealth } from "@mcoda/shared";
import { Agent as HttpsAgent } from "node:https";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";

const normalizeBaseUrl = (value?: unknown): string | undefined => {
  if (!value) return undefined;
  const str = String(value).trim();
  if (!str) return undefined;
  return str.endsWith("/") ? str.slice(0, -1) : str;
};

export class OllamaRemoteAdapter implements AgentAdapter {
  private baseUrl: string | undefined;
  private headers: Record<string, string> | undefined;
  private verifyTls: boolean | undefined;
  private tlsAgent: HttpsAgent | undefined;

  constructor(private config: AdapterConfig & { baseUrl?: string; headers?: Record<string, string>; verifyTls?: boolean }) {
    this.baseUrl = normalizeBaseUrl((config as any).baseUrl);
    const headers = (config as any).headers;
    this.headers = headers && typeof headers === "object" ? headers : undefined;
    this.verifyTls = typeof (config as any).verifyTls === "boolean" ? Boolean((config as any).verifyTls) : undefined;
    if (this.verifyTls === false) {
      this.tlsAgent = new HttpsAgent({ rejectUnauthorized: false });
    }
    this.assertConfig();
  }

  private assertConfig() {
    if (!this.baseUrl) {
      throw new Error("Ollama baseUrl is not configured; set config.baseUrl to http://host:11434");
    }
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new Error("Ollama baseUrl must start with http:// or https://");
    }
  }

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities;
  }

  async healthCheck(): Promise<AgentHealth> {
    const url = this.baseUrl;
    if (!url) {
      return {
        agentId: this.config.agent.id,
        status: "unreachable",
        lastCheckedAt: new Date().toISOString(),
        details: { reason: "missing_base_url" },
      };
    }
    const started = Date.now();
    try {
      const resp = await fetch(`${url}/api/tags`);
      const healthy = resp.ok;
      return {
        agentId: this.config.agent.id,
        status: healthy ? "healthy" : "unreachable",
        lastCheckedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        details: { adapter: "ollama-remote", baseUrl: url, status: resp.status },
      };
    } catch (error) {
      return {
        agentId: this.config.agent.id,
        status: "unreachable",
        lastCheckedAt: new Date().toISOString(),
        details: { reason: "connection_error", error: (error as Error).message, baseUrl: url },
      };
    }
  }

  private ensureBaseUrl(): string {
    return this.baseUrl as string;
  }

  private ensureModel(): string {
    const model = this.config.model;
    if (!model) {
      throw new Error("Ollama model is not configured for this agent");
    }
    return model;
  }

  private extractMetrics(data: any): Record<string, unknown> | undefined {
    const metrics: Record<string, unknown> = {};
    if (typeof data?.prompt_eval_count === "number") metrics.promptEvalCount = data.prompt_eval_count;
    if (typeof data?.eval_count === "number") metrics.evalCount = data.eval_count;
    if (typeof data?.total_duration === "number") metrics.totalDurationNs = data.total_duration;
    if (Object.keys(metrics).length === 0) return undefined;
    return metrics;
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const url = this.ensureBaseUrl();
    const model = this.ensureModel();
    const init: any = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.headers ?? {}) },
      body: JSON.stringify({ model, prompt: request.input, stream: false }),
    };
    if (this.tlsAgent) init.agent = this.tlsAgent;
    const resp = await fetch(`${url}/api/generate`, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Ollama generate failed (${resp.status}): ${text}`);
    }
    const data: any = await resp.json().catch(() => ({}));
    const metrics = this.extractMetrics(data);
    const output: string =
      typeof data?.response === "string"
        ? data.response
        : typeof data?.message === "string"
          ? data.message
          : JSON.stringify(data);
    return {
      output: output.trim(),
      adapter: this.config.adapter ?? "ollama-remote",
      model,
      metadata: {
        adapterType: this.config.adapter ?? "ollama-remote",
        baseUrl: url,
        capabilities: this.config.capabilities,
        metrics,
      },
    };
  }

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
    const url = this.ensureBaseUrl();
    const model = this.ensureModel();
    const init: any = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.headers ?? {}) },
      body: JSON.stringify({ model, prompt: request.input, stream: true }),
    };
    if (this.tlsAgent) init.agent = this.tlsAgent;
    const resp = await fetch(`${url}/api/generate`, init);
    if (!resp.ok || !resp.body) {
      const text = !resp.ok ? await resp.text().catch(() => "") : "";
      throw new Error(`Ollama generate (stream) failed (${resp.status}): ${text}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const data = JSON.parse(line);
          const chunk =
            typeof data?.response === "string"
              ? data.response
              : typeof data?.message === "string"
                ? data.message
                : "";
          const metrics = this.extractMetrics(data);
          if (chunk) {
            yield {
              output: chunk,
              adapter: this.config.adapter ?? "ollama-remote",
              model,
              metadata: {
                adapterType: this.config.adapter ?? "ollama-remote",
                baseUrl: url,
                capabilities: this.config.capabilities,
                streaming: true,
                metrics,
                raw: line,
              },
            };
          }
          if (data?.done) {
            return;
          }
        } catch {
          // Ignore malformed lines; keep streaming.
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      yield {
        output: tail,
        adapter: this.config.adapter ?? "ollama-remote",
        model,
        metadata: {
          adapterType: this.config.adapter ?? "ollama-remote",
          baseUrl: url,
          capabilities: this.config.capabilities,
          streaming: true,
          raw: tail,
        },
      };
    }
  }
}
