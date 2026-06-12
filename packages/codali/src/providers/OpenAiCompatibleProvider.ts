import {
  normalizeLocalOpenAiCompatibleRunnerConfig,
  type LocalOpenAiCompatibleRunnerConfig,
  type LocalRunnerAuthMode,
  type LocalRunnerConfigIssue,
  type LocalRunnerResponseFormatStrategy,
} from "@mcoda/shared";
import type {
  Provider,
  ProviderConfig,
  ProviderMessage,
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

const enforcedIssueCodes = new Set<LocalRunnerConfigIssue["code"]>([
  "invalid_auth_mode",
  "invalid_headers",
  "invalid_header_value",
  "secret_header",
  "invalid_extra_body",
  "reserved_extra_body_key",
]);

const assertLocalConfigIssues = (issues: LocalRunnerConfigIssue[]): void => {
  const enforced = issues.filter((issue) => enforcedIssueCodes.has(issue.code));
  if (enforced.length === 0) return;
  throw new Error(
    `Invalid OpenAI-compatible local runner config: ${enforced
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ")}`,
  );
};

interface AuthResolution {
  mode: LocalRunnerAuthMode;
  authorization?: string;
}

const toResponseFormat = (
  format: ProviderResponseFormat | undefined,
  strategy: LocalRunnerResponseFormatStrategy = "openai",
): Record<string, unknown> | undefined => {
  if (!format) return undefined;
  if (strategy === "none" || strategy === "prompt-only" || strategy === "gbnf") {
    return undefined;
  }
  if (strategy === "json-object") {
    if (format.type === "text") return { type: "text" };
    if (format.type === "json" || format.type === "json_schema") {
      return { type: "json_object" };
    }
    return undefined;
  }
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

const buildPromptOnlyFormatInstruction = (format: ProviderResponseFormat | undefined): string | undefined => {
  if (!format || format.type === "text") return undefined;
  if (format.type === "json") {
    return [
      "Output format constraint:",
      "Return exactly one valid JSON object.",
      "Do not include markdown fences, reasoning, commentary, or text outside the JSON object.",
    ].join("\n");
  }
  if (format.type === "json_schema") {
    return [
      "Output format constraint:",
      "Return exactly one valid JSON object matching this schema:",
      JSON.stringify(format.schema ?? {}),
      "Do not include markdown fences, reasoning, commentary, or text outside the JSON object.",
    ].join("\n");
  }
  if (format.type === "gbnf") {
    return [
      "Output format constraint:",
      "Return output that conforms to this GBNF grammar:",
      format.grammar ?? "",
      "Do not include markdown fences, reasoning, commentary, or text outside the grammar output.",
    ].join("\n");
  }
  return undefined;
};

export class OpenAiCompatibleProvider implements Provider {
  name = "openai-compatible";
  private localRunner: LocalOpenAiCompatibleRunnerConfig;
  private authMode: LocalRunnerAuthMode;
  private responseFormatStrategy: LocalRunnerResponseFormatStrategy;

  constructor(private config: ProviderConfig) {
    const normalizedLocal = normalizeLocalOpenAiCompatibleRunnerConfig({
      config,
      agentConfig: config.localRunner,
    });
    assertLocalConfigIssues(normalizedLocal.issues);
    this.localRunner = normalizedLocal.config;
    this.authMode = normalizedLocal.config.authMode ?? (config.apiKey ? "bearer" : "none");
    this.responseFormatStrategy = normalizedLocal.config.responseFormatStrategy ?? "openai";
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const baseUrl = normalizeBaseUrl(this.localRunner.baseUrl ?? this.config.baseUrl);
    const url = new URL("chat/completions", baseUrl).toString();
    const auth = this.resolveAuth();
    const emitToken = (token: string) => {
      if (request.onEvent) {
        request.onEvent({ type: "token", content: token });
        return;
      }
      request.onToken?.(token);
    };

    const headers: Record<string, string> = {
      ...(this.localRunner.headers ?? {}),
      "content-type": "application/json",
      ...(auth.authorization ? { authorization: auth.authorization } : {}),
    };

    const promptOnlyInstruction =
      this.responseFormatStrategy === "prompt-only"
        ? buildPromptOnlyFormatInstruction(request.responseFormat)
        : undefined;
    const messages: Array<{
      role: ProviderMessage["role"];
      content: string;
      name?: string;
      tool_call_id?: string;
    }> = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      name: message.name,
      tool_call_id: message.toolCallId,
    }));
    if (promptOnlyInstruction) {
      messages.unshift({ role: "system", content: promptOnlyInstruction });
    }

    const body: Record<string, unknown> = {
      ...(this.localRunner.requireModelInRequest === false ? {} : { model: this.config.model }),
      messages,
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
      response_format: toResponseFormat(request.responseFormat, this.responseFormatStrategy),
      stream: request.stream ?? false,
      stream_options: request.stream ? { include_usage: true } : undefined,
    };
    if (
      this.responseFormatStrategy === "gbnf" &&
      request.responseFormat?.type === "gbnf" &&
      request.responseFormat.grammar
    ) {
      body.grammar = request.responseFormat.grammar;
    }
    if (this.localRunner.extraBody) {
      for (const [key, value] of Object.entries(this.localRunner.extraBody)) {
        if (body[key] === undefined) body[key] = value;
      }
    }

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
                emitToken(delta.content);
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

  private resolveAuth(): AuthResolution {
    if (this.authMode === "none") {
      return { mode: "none" };
    }
    if (this.authMode === "dummy-bearer") {
      return {
        mode: "dummy-bearer",
        authorization: `Bearer ${this.localRunner.dummyBearerToken ?? "local"}`,
      };
    }
    if (!this.config.apiKey) {
      throw new Error("AUTH_REQUIRED: OpenAI-compatible provider API key missing; set CODALI_API_KEY.");
    }
    return { mode: "bearer", authorization: `Bearer ${this.config.apiKey}` };
  }
}
