import { runCodali, type CodaliMessage, type CodaliRequest, type CodaliResult } from "./CodaliApi.js";
import type { RunContext } from "../runcontext/RunContextResolver.js";

/**
 * OpenAI-compatible chat-completions adapter.
 *
 * okacam AI chat already speaks this shape. Rather than changing AI chat to
 * learn Codali's contract, Codali speaks AI chat's — the product points its
 * existing client at a different base URL and gets orchestration, tools, and
 * citations without a rewrite.
 *
 * The adapter is deliberately thin. It maps message shapes and nothing else;
 * all routing, tool selection and budget enforcement stay in the one code path
 * `runCodali` provides, so the adapter cannot drift from the CLI's behaviour.
 */

export interface ChatCompletionMessage {
  role: string;
  content: string | null;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  response_format?: { type?: string; json_schema?: { schema?: Record<string, unknown> } };
  /** Codali-specific extras, ignored by a plain OpenAI client. */
  codali?: {
    runContext?: RunContext;
    workspaceRoot?: string;
    mode?: CodaliRequest["mode"];
    media?: CodaliRequest["media"];
    budgets?: CodaliRequest["budgets"];
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length" | "content_filter";
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /**
   * Codali's provenance, carried alongside the OpenAI shape. A plain client
   * ignores this; a product that wants citations reads it. Without it the
   * adapter would throw away the very thing that makes an orchestrated answer
   * trustworthy.
   */
  codali: {
    status: CodaliResult["status"];
    sources: CodaliResult["sources"];
    artifacts: CodaliResult["artifacts"];
    warnings: string[];
    traceId: string;
    output?: unknown;
  };
}

const CHAT_ROLES = new Set(["system", "user", "assistant"]);

export const toCodaliMessages = (
  messages: readonly ChatCompletionMessage[],
): CodaliMessage[] =>
  messages
    .filter((message) => CHAT_ROLES.has(message.role) && typeof message.content === "string")
    .map((message) => ({
      role: message.role as CodaliMessage["role"],
      content: message.content as string,
    }));

const readResponseSchema = (
  request: ChatCompletionRequest,
): Record<string, unknown> | undefined => {
  const format = request.response_format;
  if (!format) return undefined;
  if (format.type === "json_schema") return format.json_schema?.schema;
  return undefined;
};

export interface ChatAdapterDependencies {
  run?: typeof runCodali;
}

export const handleChatCompletion = async (
  request: ChatCompletionRequest,
  deps: ChatAdapterDependencies = {},
): Promise<ChatCompletionResponse> => {
  const run = deps.run ?? runCodali;
  const result = await run({
    messages: toCodaliMessages(request.messages),
    runContext: request.codali?.runContext,
    workspaceRoot: request.codali?.workspaceRoot,
    mode: request.codali?.mode,
    media: request.codali?.media,
    budgets: request.codali?.budgets,
    responseSchema: readResponseSchema(request),
    responseMode: request.response_format?.type === "json_object" ? "json" : "text",
    product: { name: "chat-completions" },
  });

  return {
    id: `chatcmpl-${result.traceId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? "codali",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.answer },
        // A partial or clarification-seeking answer is not a normal stop. A
        // client that only inspects finish_reason must not mistake it for a
        // complete response.
        finish_reason: result.status === "succeeded" ? "stop" : "length",
      },
    ],
    codali: {
      status: result.status,
      sources: result.sources,
      artifacts: result.artifacts,
      warnings: result.warnings,
      traceId: result.traceId,
      output: result.output,
    },
  };
};
