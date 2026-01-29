import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderResponseFormat,
  ProviderToolCall,
} from "./ProviderTypes.js";

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface OllamaResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
}

const parseToolArgs = (raw: string | Record<string, unknown>): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const toToolCalls = (value: unknown): ProviderToolCall[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toToolCalls(entry));
  }
  if (!isObject(value)) return [];

  if (Array.isArray(value.tool_calls)) {
    return toToolCalls(value.tool_calls);
  }

  const functionPayload = isObject(value.function) ? value.function : undefined;
  if (functionPayload && typeof functionPayload.name === "string") {
    const rawArgs = functionPayload.arguments ?? functionPayload.args ?? {};
    return [
      {
        id: `call_1`,
        name: functionPayload.name,
        args: parseToolArgs(rawArgs as string | Record<string, unknown>),
      },
    ];
  }

  const name =
    (typeof value.tool === "string" && value.tool) ||
    (typeof value.name === "string" && value.name) ||
    (typeof value.tool_name === "string" && value.tool_name);
  if (!name) return [];
  const rawArgs = (value.args ?? value.arguments ?? value.params ?? value.parameters ?? {}) as
    | string
    | Record<string, unknown>;
  return [
    {
      id: `call_1`,
      name,
      args: parseToolArgs(rawArgs),
    },
  ];
};

const extractToolCallsFromContent = (content: string | undefined): ProviderToolCall[] => {
  if (!content) return [];
  const trimmed = content.trim();
  const jsonBlocks: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    const block = match[1]?.trim();
    if (block) jsonBlocks.push(block);
  }
  if (jsonBlocks.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    jsonBlocks.push(trimmed);
  }

  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block) as unknown;
      const calls = toToolCalls(parsed);
      if (calls.length) {
        return calls.map((call, index) => ({ ...call, id: `call_${index + 1}` }));
      }
    } catch {
      // ignore parsing errors
    }
  }
  return [];
};

const normalizeBaseUrl = (baseUrl?: string): string => {
  const root = baseUrl ?? "http://127.0.0.1:11434";
  return root.endsWith("/") ? root : `${root}/`;
};

const applyResponseFormat = (
  body: Record<string, unknown>,
  format: ProviderResponseFormat | undefined,
): void => {
  if (!format) return;
  if (format.type === "json") {
    body.format = "json";
    return;
  }
  if (format.type === "json_schema") {
    body.format = format.schema ?? "json";
    return;
  }
  if (format.type === "gbnf" && format.grammar) {
    body.grammar = format.grammar;
  }
};

export class OllamaRemoteProvider implements Provider {
  name = "ollama-remote";

  constructor(private config: ProviderConfig) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const url = new URL("api/chat", baseUrl).toString();

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        name: message.name,
      })),
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? {},
        },
      })),
      stream: request.stream ?? false,
    };

    if (request.temperature !== undefined) {
      body.options = { temperature: request.temperature };
    }
    applyResponseFormat(body, request.responseFormat);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama error ${response.status}: ${errorBody}`);
    }

    if (request.stream) {
      if (!response.body) {
        throw new Error("Ollama streaming response missing body");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let toolCalls: ProviderToolCall[] | undefined;
      const rawChunks: OllamaResponse[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const chunk = JSON.parse(trimmed) as OllamaResponse;
            rawChunks.push(chunk);
            const message = chunk.message ?? {};
            if (message.content) {
              content += message.content;
              request.onToken?.(message.content);
            }
            if (message.tool_calls && message.tool_calls.length > 0) {
              toolCalls = message.tool_calls.map((call, index) => ({
                id: call.id ?? `call_${index + 1}`,
                name: call.function.name,
                args: parseToolArgs(call.function.arguments),
              }));
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer) as OllamaResponse;
          rawChunks.push(chunk);
          const message = chunk.message ?? {};
          if (message.content) {
            content += message.content;
            request.onToken?.(message.content);
          }
          if (message.tool_calls && message.tool_calls.length > 0) {
            toolCalls = message.tool_calls.map((call, index) => ({
              id: call.id ?? `call_${index + 1}`,
              name: call.function.name,
              args: parseToolArgs(call.function.arguments),
            }));
          }
        } catch {
          // ignore trailing parse errors
        }
      }

      if (!toolCalls || toolCalls.length === 0) {
        const fallback = extractToolCallsFromContent(content);
        if (fallback.length) {
          toolCalls = fallback;
        }
      }

      return {
        message: { role: "assistant", content },
        toolCalls,
        raw: rawChunks,
      };
    }

    const raw = (await response.json()) as OllamaResponse;
    const message = raw.message ?? {};
    let toolCalls: ProviderToolCall[] | undefined = message.tool_calls?.map((call, index) => ({
      id: call.id ?? `call_${index + 1}`,
      name: call.function.name,
      args: parseToolArgs(call.function.arguments),
    }));
    if (!toolCalls || toolCalls.length === 0) {
      const fallback = extractToolCallsFromContent(message.content);
      if (fallback.length) {
        toolCalls = fallback;
      }
    }

    return {
      message: {
        role: "assistant",
        content: message.content ?? "",
      },
      toolCalls,
      raw,
    };
  }
}
