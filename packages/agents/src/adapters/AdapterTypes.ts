import { Agent, AgentAuthMetadata, AgentHealth, AgentPromptManifest } from "@mcoda/shared";

export interface AdapterConfig {
  agent: Agent;
  capabilities: string[];
  model?: string;
  apiKey?: string;
  prompts?: AgentPromptManifest;
  authMetadata?: AgentAuthMetadata;
  adapter?: string;
}

export interface AgentAdapter {
  getCapabilities(): Promise<string[]>;
  healthCheck(): Promise<AgentHealth>;
  invoke?(request: InvocationRequest): Promise<InvocationResult>;
  invokeStream?(_input: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown>;
}

export interface InvocationRequest {
  input: string;
  adapterType?: string;
  authMode?: "api" | "cli" | "local" | "none";
  metadata?: Record<string, unknown>;
}

export interface InvocationResult {
  output: string;
  adapter: string;
  model?: string;
  metadata?: Record<string, unknown>;
}
