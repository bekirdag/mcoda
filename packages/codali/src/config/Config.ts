export interface DocdexConfig {
  baseUrl: string;
  repoRoot?: string;
  repoId?: string;
}

export interface ToolConfig {
  enabled?: string[];
  allowShell?: boolean;
  shellAllowlist?: string[];
  allowOutsideWorkspace?: boolean;
}

export interface LimitsConfig {
  maxSteps: number;
  maxToolCalls: number;
  maxRetries: number;
  maxTokens?: number;
  timeoutMs: number;
}

export interface ContextConfig {
  mode: "bundle_text" | "json";
  maxFiles: number;
  maxTotalBytes: number;
  tokenBudget: number;
  focusMaxFileBytes: number;
  peripheryMaxBytes: number;
  includeRepoMap: boolean;
  includeImpact: boolean;
  includeSnippets: boolean;
  readStrategy: "docdex" | "fs";
  maxContextRefreshes: number;
  skeletonizeLargeFiles: boolean;
  redactSecrets: boolean;
  ignoreFilesFrom: string[];
  preferredFiles?: string[];
  recentFiles?: string[];
  skipSearchWhenPreferred?: boolean;
}

export interface SecurityConfig {
  redactPatterns: string[];
  readOnlyPaths: string[];
  allowDocEdits: boolean;
  allowCloudModels: boolean;
}

export interface BuilderConfig {
  mode: "tool_calls" | "patch_json" | "freeform";
  patchFormat: "search_replace" | "file_writes";
  fallbackToInterpreter?: boolean;
}

export interface InterpreterConfig {
  provider: string;
  model: string;
  format: string;
  grammar?: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface StreamingConfig {
  enabled: boolean;
  flushEveryMs: number;
}

export interface CostConfig {
  maxCostPerRun: number;
  charPerToken: number;
  pricingOverrides: Record<string, { inputPer1K?: number; outputPer1K?: number; per1K?: number }>;
}

export interface LocalContextSummarizeConfig {
  enabled: boolean;
  provider: string;
  model: string;
  targetTokens: number;
  thresholdPct: number;
}

export interface LocalContextConfig {
  enabled: boolean;
  storageDir: string;
  persistToolMessages: boolean;
  maxMessages: number;
  maxBytesPerLane: number;
  modelTokenLimits: Record<string, number>;
  summarize: LocalContextSummarizeConfig;
}

export interface RoutingPhaseConfig {
  agent?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  format?: string;
  grammar?: string;
}

export interface RoutingConfig {
  librarian?: RoutingPhaseConfig;
  architect?: RoutingPhaseConfig;
  builder?: RoutingPhaseConfig;
  critic?: RoutingPhaseConfig;
  interpreter?: RoutingPhaseConfig;
}

export interface LoggingConfig {
  directory: string;
}

export interface CodaliConfig {
  workspaceRoot: string;
  project?: string;
  command?: string;
  commandRunId?: string;
  jobId?: string;
  runId?: string;
  taskId?: string;
  taskKey?: string;
  agentId?: string;
  agentSlug?: string;
  smart?: boolean;
  planHint?: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  docdex: DocdexConfig;
  tools: ToolConfig;
  limits: LimitsConfig;
  context: ContextConfig;
  security: SecurityConfig;
  builder: BuilderConfig;
  interpreter: InterpreterConfig;
  streaming: StreamingConfig;
  cost: CostConfig;
  localContext: LocalContextConfig;
  logging: LoggingConfig;
  routing?: RoutingConfig;
}

export const DEFAULT_DOCDEX_BASE_URL = "http://127.0.0.1:28491";
export const DEFAULT_LOG_DIR = "logs/codali";

export const DEFAULT_LIMITS: LimitsConfig = {
  maxSteps: 12,
  maxToolCalls: 40,
  maxRetries: 3,
  timeoutMs: 5 * 60 * 1000,
};

export const DEFAULT_CONTEXT: ContextConfig = {
  mode: "bundle_text",
  maxFiles: 8,
  maxTotalBytes: 40_000,
  tokenBudget: 120_000,
  focusMaxFileBytes: 12_000,
  peripheryMaxBytes: 4_000,
  includeRepoMap: true,
  includeImpact: true,
  includeSnippets: true,
  readStrategy: "docdex",
  maxContextRefreshes: 1,
  skeletonizeLargeFiles: true,
  redactSecrets: true,
  ignoreFilesFrom: [".gitignore", ".codaliignore"],
  skipSearchWhenPreferred: false,
};

export const DEFAULT_SECURITY: SecurityConfig = {
  redactPatterns: ["AKIA[0-9A-Z]{16}", "-----BEGIN PRIVATE KEY-----"],
  readOnlyPaths: [
    "docs/sds",
    "docs/rfp",
    "openapi",
    "openapi.yaml",
    "openapi.yml",
    "openapi.json",
  ],
  allowDocEdits: false,
  allowCloudModels: false,
};

export const DEFAULT_BUILDER: BuilderConfig = {
  mode: "freeform",
  patchFormat: "search_replace",
  fallbackToInterpreter: true,
};

export const DEFAULT_INTERPRETER: InterpreterConfig = {
  provider: "auto",
  model: "auto",
  format: "json",
  maxRetries: 1,
  timeoutMs: 120_000,
};

export const DEFAULT_STREAMING: StreamingConfig = {
  enabled: true,
  flushEveryMs: 250,
};

export const DEFAULT_COST: CostConfig = {
  maxCostPerRun: 0.5,
  charPerToken: 4,
  pricingOverrides: {},
};

export const DEFAULT_LOCAL_CONTEXT: LocalContextConfig = {
  enabled: true,
  storageDir: "codali/context",
  persistToolMessages: false,
  maxMessages: 200,
  maxBytesPerLane: 200_000,
  modelTokenLimits: {
    llama3: 8192,
    "deepseek-coder": 128_000,
    "mistral-nemo": 32_000,
  },
  summarize: {
    enabled: true,
    provider: "librarian",
    model: "gemma2:2b",
    targetTokens: 1200,
    thresholdPct: 0.9,
  },
};

export const DEFAULT_TOOL_CONFIG: ToolConfig = {
  enabled: [],
  allowShell: false,
  shellAllowlist: [],
  allowOutsideWorkspace: false,
};

export const DEFAULT_LOGGING: LoggingConfig = {
  directory: DEFAULT_LOG_DIR,
};
