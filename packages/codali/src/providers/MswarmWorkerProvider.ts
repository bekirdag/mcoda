import type {
  Provider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
} from "./ProviderTypes.js";

const MAX_RESPONSE_DETAIL_CHARS = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const messagesToText = (messages: ProviderMessage[]): string =>
  messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");

const parseWorkerOutput = (payload: Record<string, unknown>): string => {
  const direct = resolveString(payload.output);
  if (direct) return direct;
  const result = isRecord(payload.result) ? payload.result : {};
  return resolveString(result.output) ?? JSON.stringify(payload);
};

const parseToolCalls = (payload: Record<string, unknown>): ProviderToolCall[] | undefined => {
  const result = isRecord(payload.result) ? payload.result : {};
  const raw = Array.isArray(result.tool_calls)
    ? result.tool_calls
    : Array.isArray(payload.tool_calls)
      ? payload.tool_calls
      : undefined;
  if (!raw) return undefined;
  const calls: ProviderToolCall[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const name = resolveString(entry.name);
    if (!name) return;
    calls.push({
      id: resolveString(entry.id) ?? `worker-tool-${index + 1}`,
      name,
      args: entry.args ?? entry.arguments ?? {},
    });
  });
  return calls.length > 0 ? calls : undefined;
};

export class MswarmWorkerProvider implements Provider {
  readonly name = "mswarm-worker";
  private readonly runUrl: string;
  private readonly apiKey: string;

  constructor(private readonly config: { model: string; apiKey?: string; baseUrl?: string; timeoutMs?: number }) {
    if (!config.apiKey) {
      throw new Error("AUTH_REQUIRED: mswarm-worker provider requires a synced Worker API key.");
    }
    if (!config.baseUrl) {
      throw new Error("mswarm-worker provider requires a Worker run URL in baseUrl.");
    }
    this.runUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timeout =
      this.config.timeoutMs && this.config.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.config.timeoutMs)
        : undefined;
    try {
      const response = await fetch(this.runUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          text: messagesToText(request.messages),
          input: messagesToText(request.messages),
          messages: request.messages,
          tools: request.tools ?? [],
          tool_choice: request.toolChoice ?? "auto",
          response_format: request.responseFormat,
          model: this.config.model,
          metadata: {
            caller: "codali",
            provider: "mswarm-worker",
          },
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
          `mswarm-worker request failed (${response.status}): ${
            responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS) || response.statusText
          }`
        );
      }
      const content = parseWorkerOutput(payload);
      request.onToken?.(content);
      request.onEvent?.({ type: "token", content });
      return {
        message: {
          role: "assistant",
          content,
        },
        toolCalls: parseToolCalls(payload),
        raw: payload,
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
