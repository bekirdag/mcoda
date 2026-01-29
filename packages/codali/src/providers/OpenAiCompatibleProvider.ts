import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderResponseFormat,
  ProviderToolCall,
} from "./ProviderTypes.js";

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiResponse {
  choices: Array<{
    message: {
      role: string;
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const parseToolArgs = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const normalizeBaseUrl = (baseUrl?: string): string => {
  const root = baseUrl ?? "https://api.openai.com/v1";
  return root.endsWith("/") ? root : `${root}/`;
};

const toResponseFormat = (
  format: ProviderResponseFormat | undefined,
): Record<string, unknown> | undefined => {
  if (!format) return undefined;
  if (format.type === "json") {
    return { type: "json_object" };
  }
  if (format.type === "json_schema") {
    return { type: "json_schema", json_schema: format.schema ?? {} };
  }
  if (format.type === "text") {
    return { type: "text" };
  }
  return undefined;
};

export class OpenAiCompatibleProvider implements Provider {
  name = "openai-compatible";

  constructor(private config: ProviderConfig) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const url = new URL("chat/completions", baseUrl).toString();

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const body = {
      model: this.config.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        name: message.name,
        tool_call_id: message.toolCallId,
      })),
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? {},
        },
      })),
      tool_choice: request.toolChoice,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      response_format: toResponseFormat(request.responseFormat),
      stream: request.stream ?? false,
      stream_options: request.stream ? { include_usage: true } : undefined,
    };

    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI-compatible error ${response.status}: ${errorBody}`);
      }

      if (request.stream) {
        if (!response.body) {
          throw new Error("OpenAI-compatible streaming response missing body");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
        let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data) as OpenAiResponse & {
                choices?: Array<{ delta?: any }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
              };
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) {
                content += delta.content;
                request.onToken?.(delta.content);
              }
              if (Array.isArray(delta?.tool_calls)) {
                for (const call of delta.tool_calls) {
                  const index = call.index ?? 0;
                  const existing = toolCallMap.get(index) ?? {
                    id: call.id ?? `call_${index + 1}`,
                    name: "",
                    args: "",
                  };
                  if (call.function?.name) {
                    existing.name = call.function.name;
                  }
                  if (typeof call.function?.arguments === "string") {
                    existing.args += call.function.arguments;
                  }
                  toolCallMap.set(index, existing);
                }
              }
              if (chunk.usage) {
                usage = chunk.usage;
              }
            } catch {
              // ignore malformed chunks
            }
          }
        }

        const toolCalls =
          toolCallMap.size > 0
            ? Array.from(toolCallMap.entries()).map(([index, call]) => ({
                id: call.id ?? `call_${index + 1}`,
                name: call.name,
                args: parseToolArgs(call.args),
              }))
            : undefined;

        return {
          message: { role: "assistant", content },
          toolCalls,
          usage: usage
            ? {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              }
            : undefined,
          raw: { stream: true },
        };
      }

      const raw = (await response.json()) as OpenAiResponse;
      const choice = raw.choices[0]?.message;
      if (!choice) {
        throw new Error("OpenAI-compatible response missing choices");
      }

      const toolCalls: ProviderToolCall[] | undefined = choice.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        args: parseToolArgs(call.function.arguments),
      }));

      return {
        message: {
          role: "assistant",
          content: choice.content ?? "",
        },
        toolCalls,
        usage: raw.usage
          ? {
              inputTokens: raw.usage.prompt_tokens,
              outputTokens: raw.usage.completion_tokens,
              totalTokens: raw.usage.total_tokens,
            }
          : undefined,
        raw,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
