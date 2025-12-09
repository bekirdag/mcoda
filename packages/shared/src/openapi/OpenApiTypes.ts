export type AgentHealthStatus = "healthy" | "degraded" | "unreachable";

export interface Agent {
  id: string;
  slug: string;
  adapter: string;
  defaultModel?: string;
  config?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  slug: string;
  adapter: string;
  defaultModel?: string;
  config?: Record<string, unknown>;
  capabilities?: string[];
  prompts?: AgentPromptManifest;
}

export interface UpdateAgentInput {
  adapter?: string;
  defaultModel?: string;
  config?: Record<string, unknown>;
  capabilities?: string[];
  prompts?: AgentPromptManifest;
}

export interface AgentCapability {
  agentId: string;
  capability: string;
}

export interface AgentPromptManifest {
  agentId?: string;
  jobPrompt?: string;
  characterPrompt?: string;
  commandPrompts?: Record<string, string>;
  jobPath?: string;
  characterPath?: string;
}

export interface AgentAuthMetadata {
  agentId: string;
  configured: boolean;
  lastUpdatedAt?: string;
  lastVerifiedAt?: string;
}

export interface AgentAuthSecret extends AgentAuthMetadata {
  encryptedSecret: string;
}

export interface AgentHealth {
  agentId: string;
  status: AgentHealthStatus;
  lastCheckedAt: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface WorkspaceDefault {
  workspaceId: string;
  commandName: string;
  agentId: string;
  updatedAt: string;
}
