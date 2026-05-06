export type McodaRuntimeMode = "programmatic" | "cli_fallback" | "custom";

export interface McodaRuntimeInfo {
  mode: McodaRuntimeMode;
  requiresMcodaCli: boolean;
}

export type McodaAgentSource =
  | "local_registry"
  | "cloud_catalog"
  | "self_hosted_catalog";

export type McodaAgentManagedKind = "cloud" | "self_hosted" | null;

export type McodaPreferredSource =
  | "cloud"
  | "self_hosted"
  | "cloud_or_self_hosted"
  | null;

export interface McodaStageDefinition {
  stageKey: string;
  displayName: string;
  description?: string;
  defaultAgentSlug?: string | null;
  recommendedUsage?: string | null;
  preferredSource?: McodaPreferredSource;
  fallbackStageKey?: string | null;
  nullable?: boolean;
}

export interface McodaAgentCatalogEntry {
  slug: string;
  source: McodaAgentSource;
  synced: boolean;
  remoteSlug: string | null;
  managedKind?: McodaAgentManagedKind;
  nodeId?: string | null;
  serverName?: string | null;
  serverId?: string | null;
  serverLabel?: string | null;
  displayName: string | null;
  provider: string | null;
  adapter: string | null;
  model: string | null;
  defaultModel: string | null;
  healthStatus: string | null;
  supportsTools: boolean | null;
  rating: number | null;
  reasoningRating: number | null;
  maxComplexity: number | null;
  costPerMillion: number | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  bestUsage?: string | null;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface McodaSelfHostedServer {
  id: string;
  label: string;
  nodeId?: string | null;
  serverName?: string | null;
  status?: string | null;
  remoteSlugPrefix?: string | null;
  agentCount: number;
  agents: McodaAgentCatalogEntry[];
}

export interface McodaAgentCatalog {
  localAgents: McodaAgentCatalogEntry[];
  cloudAgents: McodaAgentCatalogEntry[];
  selfHostedAgents: McodaAgentCatalogEntry[];
  selfHostedServers: McodaSelfHostedServer[];
  errors: Record<string, string>;
  generatedAt: string;
}

export interface McodaAgentSetupSnapshot {
  provider: "mcoda_mswarm" | string;
  runtime: McodaRuntimeInfo;
  mswarmApiKeyConfigured: boolean;
  mswarmApiKeyLast4: string | null;
  mswarmConfiguredAt: string | null;
  stages: McodaStageDefinition[];
  assignments: Record<string, string | null>;
  catalog: McodaAgentCatalog;
  updatedAt: string | null;
  fetchedAt: string;
}

export interface McodaAgentTestResult {
  slug: string;
  ok: boolean;
  output?: string;
  model?: string;
  adapter?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface McodaAgentSetupClient {
  fetchSnapshot(): Promise<McodaAgentSetupSnapshot>;
  configureMswarmApiKey(input: {
    apiKey: string;
    reasonCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<McodaAgentSetupSnapshot>;
  syncAgents(input?: {
    reasonCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<McodaAgentSetupSnapshot>;
  updateAssignments(input: {
    assignments: Record<string, string | null>;
    reasonCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<McodaAgentSetupSnapshot>;
  testAgent?(input: {
    slug: string;
    prompt?: string;
    timeoutMs?: number;
  }): Promise<McodaAgentTestResult>;
}

export interface McodaAgentListInput {
  provider?: string;
  refreshHealth?: boolean;
  includeUnreachable?: boolean;
}

export interface McodaAgentSyncInput extends McodaAgentListInput {
  pruneMissing?: boolean;
}

export interface McodaRuntimeAdapter {
  runtime: McodaRuntimeInfo;
  configureMswarmApiKey(input: {
    apiKey: string;
    actor?: string;
    reasonCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  listCloudAgents(input?: McodaAgentListInput): Promise<McodaAgentCatalogEntry[]>;
  syncCloudAgents(input?: McodaAgentSyncInput): Promise<McodaAgentCatalogEntry[]>;
  listSelfHostedAgents(
    input?: McodaAgentListInput
  ): Promise<McodaAgentCatalogEntry[]>;
  syncSelfHostedAgents(
    input?: McodaAgentSyncInput
  ): Promise<McodaAgentCatalogEntry[]>;
  listLocalAgents(input?: McodaAgentListInput): Promise<McodaAgentCatalogEntry[]>;
  testAgent?(input: {
    slug: string;
    prompt?: string;
    timeoutMs?: number;
  }): Promise<McodaAgentTestResult>;
}

export interface McodaAgentSettingsSnapshot {
  assignments: Record<string, string | null>;
  mswarmApiKeyConfigured: boolean;
  mswarmApiKeyLast4: string | null;
  mswarmConfiguredAt: string | null;
  updatedAt: string | null;
}

export interface McodaAgentSettingsStore {
  load(): Promise<McodaAgentSettingsSnapshot>;
  saveMswarmKeyMetadata(input: {
    configured: boolean;
    last4: string | null;
    configuredAt: string;
    actor?: string;
    reasonCode?: string;
  }): Promise<void>;
  saveAssignments(input: {
    assignments: Record<string, string | null>;
    actor?: string;
    reasonCode?: string;
  }): Promise<void>;
}

export interface McodaSetupLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface McodaAgentSetupServerOptions {
  settingsStore: McodaAgentSettingsStore;
  authorize?: (request: unknown) => Promise<void> | void;
  mcoda?: McodaRuntimeAdapter;
  logger?: McodaSetupLogger;
  defaultStages?: McodaStageDefinition[];
  operationTimeoutMs?: number;
  provider?: string;
}

export interface McodaAgentSetupService {
  fetchSnapshot(request?: unknown): Promise<McodaAgentSetupSnapshot>;
  configureMswarmApiKey(
    input: {
      apiKey: string;
      actor?: string;
      reasonCode?: string;
      metadata?: Record<string, unknown>;
    },
    request?: unknown
  ): Promise<McodaAgentSetupSnapshot>;
  syncAgents(
    input?: {
      actor?: string;
      reasonCode?: string;
      metadata?: Record<string, unknown>;
    },
    request?: unknown
  ): Promise<McodaAgentSetupSnapshot>;
  updateAssignments(
    input: {
      assignments: Record<string, string | null>;
      actor?: string;
      reasonCode?: string;
      metadata?: Record<string, unknown>;
    },
    request?: unknown
  ): Promise<McodaAgentSetupSnapshot>;
  testAgent(
    input: {
      slug: string;
      prompt?: string;
      timeoutMs?: number;
    },
    request?: unknown
  ): Promise<McodaAgentTestResult>;
}

export interface McodaAgentSetupHttpRequest {
  method: string;
  path?: string;
  url?: string;
  body?: unknown;
  raw?: unknown;
}

export interface McodaAgentSetupHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
