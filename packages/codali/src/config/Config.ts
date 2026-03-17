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
  allowDestructiveOperations?: boolean;
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

/**
 * Minimum tool usage required during deep investigation.
 * Counts are category-based and only enforced when deep investigation is enabled.
 */
export interface DeepInvestigationToolQuotaConfig {
  search: number;
  openOrSnippet: number;
  symbolsOrAst: number;
  impact: number;
  tree: number;
  dagExport: number;
}

/**
 * Minimum investigation budget required before planning.
 * Values are only enforced when deep investigation is enabled.
 */
export interface DeepInvestigationBudgetConfig {
  minCycles: number;
  minSeconds: number;
  maxCycles: number;
}

/**
 * Evidence thresholds used to decide if investigation is sufficient.
 * Values are only enforced when deep investigation is enabled.
 */
export interface DeepInvestigationEvidenceConfig {
  minSearchHits: number;
  minOpenOrSnippet: number;
  minSymbolsOrAst: number;
  minImpact: number;
  maxWarnings: number;
}

/**
 * Deep investigation configuration bundle.
 */
export interface DeepInvestigationConfig {
  enabled: boolean;
  deepScanPreset: boolean;
  toolQuota: DeepInvestigationToolQuotaConfig;
  investigationBudget: DeepInvestigationBudgetConfig;
  evidenceGate: DeepInvestigationEvidenceConfig;
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

export const WORKFLOW_PROFILE_NAMES = ["run", "fix", "review", "explain", "test"] as const;
export type WorkflowProfileName = (typeof WORKFLOW_PROFILE_NAMES)[number];
export type WorkflowProfileSource = "command" | "cli" | "env" | "config" | "default";
export type WorkflowOutputContract =
  | "general"
  | "patch_summary"
  | "review_findings"
  | "explanation"
  | "verification_summary";

export interface WorkflowProfile {
  name: WorkflowProfileName;
  description: string;
  smart: boolean;
  builderMode: BuilderConfig["mode"];
  fallbackToInterpreter: boolean;
  retryBudget: number;
  verificationPolicy: string;
  verificationMinimumChecks: number;
  verificationEnforceHighConfidence: boolean;
  outputContract: WorkflowOutputContract;
  allowWrites: boolean;
}

export interface WorkflowConfig {
  profile?: WorkflowProfileName;
  profiles?: Partial<Record<WorkflowProfileName, Partial<WorkflowProfile>>>;
}

export interface ResolvedWorkflowProfile extends WorkflowProfile {
  source: WorkflowProfileSource;
  command: string;
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
  model?: string;
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

export interface EvalGateConfig {
  patch_apply_drop_max: number;
  verification_pass_rate_min: number;
  hallucination_rate_max: number;
  scope_violation_rate_max: number;
}

export interface EvalConfig {
  report_dir: string;
  gates: EvalGateConfig;
}

export interface LearningConfig {
  persistence_min_confidence: number;
  enforcement_min_confidence: number;
  require_confirmation_for_low_confidence: boolean;
  auto_enforce_high_confidence: boolean;
  candidate_store_file: string;
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
  workflow?: WorkflowConfig;
  resolvedWorkflowProfile?: ResolvedWorkflowProfile;
  docdex: DocdexConfig;
  tools: ToolConfig;
  limits: LimitsConfig;
  context: ContextConfig;
  /** 
   * Deep investigation controls. When unset or disabled, deep mode is inactive.
   * Deep investigation requires the smart pipeline; builder-only runs fail closed.
   */
  deepInvestigation?: DeepInvestigationConfig;
  security: SecurityConfig;
  builder: BuilderConfig;
  interpreter: InterpreterConfig;
  streaming: StreamingConfig;
  cost: CostConfig;
  localContext: LocalContextConfig;
  eval: EvalConfig;
  learning: LearningConfig;
  logging: LoggingConfig;
  routing?: RoutingConfig;
}

export const DEFAULT_DOCDEX_BASE_URL = "http://127.0.0.1:28491";
export const DEFAULT_LOG_DIR = "logs/codali";
export const DEFAULT_WORKFLOW_PROFILE: WorkflowProfileName = "run";
export const DEFAULT_WORKFLOW_PROFILES: Record<WorkflowProfileName, WorkflowProfile> = {
  run: {
    name: "run",
    description: "General-purpose workflow profile for advanced usage.",
    smart: true,
    builderMode: "patch_json",
    fallbackToInterpreter: true,
    retryBudget: 3,
    verificationPolicy: "general",
    verificationMinimumChecks: 0,
    verificationEnforceHighConfidence: false,
    outputContract: "general",
    allowWrites: true,
  },
  fix: {
    name: "fix",
    description: "Apply code changes and emit a patch-oriented summary.",
    smart: true,
    builderMode: "patch_json",
    fallbackToInterpreter: true,
    retryBudget: 3,
    verificationPolicy: "fix",
    verificationMinimumChecks: 0,
    verificationEnforceHighConfidence: false,
    outputContract: "patch_summary",
    allowWrites: true,
  },
  review: {
    name: "review",
    description: "Analyze risks/findings without applying write-oriented changes by default.",
    smart: true,
    builderMode: "patch_json",
    fallbackToInterpreter: true,
    retryBudget: 2,
    verificationPolicy: "review",
    verificationMinimumChecks: 0,
    verificationEnforceHighConfidence: false,
    outputContract: "review_findings",
    allowWrites: false,
  },
  explain: {
    name: "explain",
    description: "Produce explanation-first output without applying write-oriented changes by default.",
    smart: true,
    builderMode: "patch_json",
    fallbackToInterpreter: true,
    retryBudget: 2,
    verificationPolicy: "explain",
    verificationMinimumChecks: 0,
    verificationEnforceHighConfidence: false,
    outputContract: "explanation",
    allowWrites: false,
  },
  test: {
    name: "test",
    description: "Produce verification-first output without applying write-oriented changes by default.",
    smart: true,
    builderMode: "patch_json",
    fallbackToInterpreter: true,
    retryBudget: 2,
    verificationPolicy: "test",
    verificationMinimumChecks: 1,
    verificationEnforceHighConfidence: true,
    outputContract: "verification_summary",
    allowWrites: false,
  },
};

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

// Deep investigation defaults are only enforced when deep mode is enabled.
export const DEFAULT_DEEP_INVESTIGATION_TOOL_QUOTA: DeepInvestigationToolQuotaConfig = {
  search: 3,
  openOrSnippet: 3,
  symbolsOrAst: 2,
  impact: 1,
  tree: 1,
  dagExport: 0,
};

export const DEFAULT_DEEP_INVESTIGATION_BUDGET: DeepInvestigationBudgetConfig = {
  minCycles: 2,
  minSeconds: 0,
  maxCycles: 6,
};

export const DEFAULT_DEEP_INVESTIGATION_EVIDENCE: DeepInvestigationEvidenceConfig = {
  minSearchHits: 0,
  minOpenOrSnippet: 0,
  minSymbolsOrAst: 0,
  minImpact: 0,
  maxWarnings: 2,
};

export const DEFAULT_DEEP_INVESTIGATION: DeepInvestigationConfig = {
  enabled: true,
  deepScanPreset: false,
  toolQuota: DEFAULT_DEEP_INVESTIGATION_TOOL_QUOTA,
  investigationBudget: DEFAULT_DEEP_INVESTIGATION_BUDGET,
  evidenceGate: DEFAULT_DEEP_INVESTIGATION_EVIDENCE,
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
  mode: "patch_json",
  patchFormat: "search_replace",
  fallbackToInterpreter: true,
};

export const DEFAULT_INTERPRETER: InterpreterConfig = {
  provider: "auto",
  model: "auto",
  format: "json",
  maxRetries: 1,
  timeoutMs: 300_000,
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
  // Populated dynamically from selected phase-agent context windows when available.
  modelTokenLimits: {},
  summarize: {
    enabled: true,
    provider: "librarian",
    // Intentionally unset so the summarizer uses the selected phase agent model.
    model: undefined,
    targetTokens: 1200,
    thresholdPct: 0.9,
  },
};

export const DEFAULT_TOOL_CONFIG: ToolConfig = {
  enabled: [],
  allowShell: false,
  shellAllowlist: [],
  allowOutsideWorkspace: false,
  allowDestructiveOperations: false,
};

export const DEFAULT_EVAL_GATES: EvalGateConfig = {
  patch_apply_drop_max: 0.02,
  verification_pass_rate_min: 0.9,
  hallucination_rate_max: 0.02,
  scope_violation_rate_max: 0,
};

export const DEFAULT_EVAL: EvalConfig = {
  report_dir: `${DEFAULT_LOG_DIR}/eval`,
  gates: DEFAULT_EVAL_GATES,
};

export const DEFAULT_LEARNING: LearningConfig = {
  persistence_min_confidence: 0.45,
  enforcement_min_confidence: 0.85,
  require_confirmation_for_low_confidence: true,
  auto_enforce_high_confidence: true,
  candidate_store_file: `${DEFAULT_LOG_DIR}/learning-rules.json`,
};

export const DEFAULT_LOGGING: LoggingConfig = {
  directory: DEFAULT_LOG_DIR,
};
