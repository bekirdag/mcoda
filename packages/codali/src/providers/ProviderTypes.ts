export type ProviderRole = "system" | "user" | "assistant" | "tool";

export interface ProviderToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ProviderResponseFormat {
  type: "json" | "json_schema" | "text" | "gbnf";
  schema?: Record<string, unknown>;
  grammar?: string;
}

export interface ProviderMessage {
  role: ProviderRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  tools?: ProviderToolDefinition[];
  toolChoice?: "auto" | "none" | { name: string };
  maxTokens?: number;
  temperature?: number;
  responseFormat?: ProviderResponseFormat;
  stream?: boolean;
  onToken?: (token: string) => void;
  streamFlushMs?: number;
}

export interface ProviderResponse {
  message: ProviderMessage;
  toolCalls?: ProviderToolCall[];
  usage?: ProviderUsage;
  raw?: unknown;
}

export interface ProviderConfig {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface Provider {
  name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}
