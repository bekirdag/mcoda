import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_WORKFLOW_PROFILE,
  DEFAULT_WORKFLOW_PROFILES,
  WORKFLOW_PROFILE_NAMES,
  DEFAULT_EVAL,
  DEFAULT_LEARNING,
  DEFAULT_DOCDEX_BASE_URL,
  DEFAULT_BUILDER,
  DEFAULT_CONTEXT,
  DEFAULT_COST,
  DEFAULT_DEEP_INVESTIGATION,
  DEFAULT_INTERPRETER,
  DEFAULT_LOCAL_CONTEXT,
  DEFAULT_LIMITS,
  DEFAULT_LOGGING,
  DEFAULT_SECURITY,
  DEFAULT_STREAMING,
  DEFAULT_TOOL_CONFIG,
  type BuilderConfig,
  type ContextConfig,
  type CostConfig,
  type DeepInvestigationBudgetConfig,
  type DeepInvestigationConfig,
  type DeepInvestigationEvidenceConfig,
  type DeepInvestigationToolQuotaConfig,
  type DocdexConfig,
  type EvalConfig,
  type EvalGateConfig,
  type LearningConfig,
  type LimitsConfig,
  type LocalContextConfig,
  type LoggingConfig,
  type CodaliConfig,
  type InterpreterConfig,
  type RoutingConfig,
  type RoutingPhaseConfig,
  type SecurityConfig,
  type StreamingConfig,
  type ToolConfig,
  type WorkflowConfig,
  type WorkflowOutputContract,
  type WorkflowProfile,
  type WorkflowProfileName,
  type WorkflowProfileSource,
} from "./Config.js";

type DeepInvestigationConfigSource = Partial<
  Omit<DeepInvestigationConfig, "toolQuota" | "investigationBudget" | "evidenceGate">
> & {
  toolQuota?: Partial<DeepInvestigationToolQuotaConfig>;
  investigationBudget?: Partial<DeepInvestigationBudgetConfig>;
  evidenceGate?: Partial<DeepInvestigationEvidenceConfig>;
};

type WorkflowConfigSource = Partial<WorkflowConfig> & {
  profiles?: Partial<Record<WorkflowProfileName, Partial<WorkflowProfile>>>;
};

type EvalConfigSource = Partial<Omit<EvalConfig, "gates">> & {
  gates?: Partial<EvalGateConfig>;
};

type LearningConfigSource = Partial<LearningConfig>;

const WORKFLOW_OUTPUT_CONTRACTS: WorkflowOutputContract[] = [
  "general",
  "patch_summary",
  "review_findings",
  "explanation",
  "verification_summary",
];

const COMMAND_PROFILE_MAP: Partial<Record<string, WorkflowProfileName>> = {
  fix: "fix",
  review: "review",
  explain: "explain",
  test: "test",
};

export interface ConfigSource {
  workspaceRoot?: string;
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
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  workflow?: WorkflowConfigSource;
  docdex?: Partial<DocdexConfig>;
  tools?: Partial<ToolConfig>;
  limits?: Partial<LimitsConfig>;
  context?: Partial<ContextConfig>;
  deepInvestigation?: DeepInvestigationConfigSource;
  security?: Partial<SecurityConfig>;
  builder?: Partial<BuilderConfig>;
  interpreter?: Partial<InterpreterConfig>;
  streaming?: Partial<StreamingConfig>;
  cost?: Partial<CostConfig>;
  localContext?: Partial<LocalContextConfig>;
  eval?: EvalConfigSource;
  learning?: LearningConfigSource;
  logging?: Partial<LoggingConfig>;
  routing?: Partial<RoutingConfig>;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cli?: ConfigSource;
  configPath?: string;
}

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
};

const parseNumberStrict = (value: string | undefined, label: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}: expected number.`);
  }
  return parsed;
};

const parseBooleanStrict = (value: string | undefined, label: string): boolean | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${label}: expected boolean.`);
};

const parseList = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};

const parseJson = <T>(value: string | undefined): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const isWorkflowProfileName = (value: string): value is WorkflowProfileName =>
  (WORKFLOW_PROFILE_NAMES as readonly string[]).includes(value);

const normalizeStringField = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Invalid ${label}: expected non-empty string.`);
  }
  return normalized;
};

const normalizeWorkflowProfileName = (
  value: unknown,
  label: string,
): WorkflowProfileName | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected workflow profile name.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!isWorkflowProfileName(normalized)) {
    throw new Error(`Invalid ${label}: unsupported workflow profile "${value}".`);
  }
  return normalized;
};

const normalizeNumberField = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: expected number.`);
  }
  return value;
};

const normalizeBooleanField = (value: unknown, label: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}: expected boolean.`);
  }
  return value;
};

const normalizeWorkflowProfileOverride = (
  value: unknown,
  label: string,
): Partial<WorkflowProfile> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const source = value as Record<string, unknown>;
  const normalized: Partial<WorkflowProfile> = {};
  const name = normalizeWorkflowProfileName(source.name, `${label}.name`);
  if (name !== undefined) normalized.name = name;
  const description = normalizeStringField(source.description, `${label}.description`);
  if (description !== undefined) normalized.description = description;
  const smart = normalizeBooleanField(source.smart, `${label}.smart`);
  if (smart !== undefined) normalized.smart = smart;
  const builderMode = source.builderMode;
  if (builderMode !== undefined) {
    if (
      builderMode !== "tool_calls"
      && builderMode !== "patch_json"
      && builderMode !== "freeform"
    ) {
      throw new Error(`Invalid ${label}.builderMode: expected tool_calls|patch_json|freeform.`);
    }
    normalized.builderMode = builderMode;
  }
  const fallbackToInterpreter = normalizeBooleanField(
    source.fallbackToInterpreter,
    `${label}.fallbackToInterpreter`,
  );
  if (fallbackToInterpreter !== undefined) {
    normalized.fallbackToInterpreter = fallbackToInterpreter;
  }
  const retryBudget = normalizeNumberField(source.retryBudget, `${label}.retryBudget`);
  if (retryBudget !== undefined) normalized.retryBudget = retryBudget;
  const verificationPolicy = normalizeStringField(
    source.verificationPolicy,
    `${label}.verificationPolicy`,
  );
  if (verificationPolicy !== undefined) normalized.verificationPolicy = verificationPolicy;
  const verificationMinimumChecks = normalizeNumberField(
    source.verificationMinimumChecks,
    `${label}.verificationMinimumChecks`,
  );
  if (verificationMinimumChecks !== undefined) {
    normalized.verificationMinimumChecks = verificationMinimumChecks;
  }
  const verificationEnforceHighConfidence = normalizeBooleanField(
    source.verificationEnforceHighConfidence,
    `${label}.verificationEnforceHighConfidence`,
  );
  if (verificationEnforceHighConfidence !== undefined) {
    normalized.verificationEnforceHighConfidence = verificationEnforceHighConfidence;
  }
  const outputContract = source.outputContract;
  if (outputContract !== undefined) {
    if (
      typeof outputContract !== "string"
      || !WORKFLOW_OUTPUT_CONTRACTS.includes(outputContract as WorkflowOutputContract)
    ) {
      throw new Error(
        `Invalid ${label}.outputContract: expected ${WORKFLOW_OUTPUT_CONTRACTS.join("|")}.`,
      );
    }
    normalized.outputContract = outputContract as WorkflowOutputContract;
  }
  const allowWrites = normalizeBooleanField(source.allowWrites, `${label}.allowWrites`);
  if (allowWrites !== undefined) normalized.allowWrites = allowWrites;
  return Object.keys(normalized).length ? normalized : undefined;
};

const normalizeWorkflowConfig = (
  value: unknown,
  label: string,
): WorkflowConfigSource | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const config = value as Record<string, unknown>;
  const normalized: WorkflowConfigSource = {};
  const profile = normalizeWorkflowProfileName(config.profile, `${label}.profile`);
  if (profile !== undefined) normalized.profile = profile;
  const profilesValue = config.profiles;
  if (profilesValue !== undefined) {
    if (!profilesValue || typeof profilesValue !== "object" || Array.isArray(profilesValue)) {
      throw new Error(`Invalid ${label}.profiles: expected object.`);
    }
    const entries = profilesValue as Record<string, unknown>;
    const profiles: Partial<Record<WorkflowProfileName, Partial<WorkflowProfile>>> = {};
    for (const [profileName, override] of Object.entries(entries)) {
      const normalizedName = normalizeWorkflowProfileName(
        profileName,
        `${label}.profiles.${profileName}`,
      );
      if (!normalizedName) continue;
      const normalizedOverride = normalizeWorkflowProfileOverride(
        override,
        `${label}.profiles.${profileName}`,
      );
      if (normalizedOverride) {
        profiles[normalizedName] = normalizedOverride;
      }
    }
    if (Object.keys(profiles).length) {
      normalized.profiles = profiles;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
};

const normalizeToolQuota = (
  value: unknown,
  label: string,
): Partial<DeepInvestigationToolQuotaConfig> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const quota = value as Record<string, unknown>;
  const normalized: Partial<DeepInvestigationToolQuotaConfig> = {};
  const search = normalizeNumberField(quota.search, `${label}.search`);
  if (search !== undefined) normalized.search = search;
  const openOrSnippet = normalizeNumberField(quota.openOrSnippet, `${label}.openOrSnippet`);
  if (openOrSnippet !== undefined) normalized.openOrSnippet = openOrSnippet;
  const symbolsOrAst = normalizeNumberField(quota.symbolsOrAst, `${label}.symbolsOrAst`);
  if (symbolsOrAst !== undefined) normalized.symbolsOrAst = symbolsOrAst;
  const impact = normalizeNumberField(quota.impact, `${label}.impact`);
  if (impact !== undefined) normalized.impact = impact;
  const tree = normalizeNumberField(quota.tree, `${label}.tree`);
  if (tree !== undefined) normalized.tree = tree;
  const dagExport = normalizeNumberField(quota.dagExport, `${label}.dagExport`);
  if (dagExport !== undefined) normalized.dagExport = dagExport;
  return Object.keys(normalized).length ? normalized : undefined;
};

const normalizeBudget = (
  value: unknown,
  label: string,
): Partial<DeepInvestigationBudgetConfig> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const budget = value as Record<string, unknown>;
  const normalized: Partial<DeepInvestigationBudgetConfig> = {};
  const minCycles = normalizeNumberField(budget.minCycles, `${label}.minCycles`);
  if (minCycles !== undefined) normalized.minCycles = minCycles;
  const minSeconds = normalizeNumberField(budget.minSeconds, `${label}.minSeconds`);
  if (minSeconds !== undefined) normalized.minSeconds = minSeconds;
  const maxCycles = normalizeNumberField(budget.maxCycles, `${label}.maxCycles`);
  if (maxCycles !== undefined) normalized.maxCycles = maxCycles;
  return Object.keys(normalized).length ? normalized : undefined;
};

const normalizeEvidence = (
  value: unknown,
  label: string,
): Partial<DeepInvestigationEvidenceConfig> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const evidence = value as Record<string, unknown>;
  const normalized: Partial<DeepInvestigationEvidenceConfig> = {};
  const minSearchHits = normalizeNumberField(evidence.minSearchHits, `${label}.minSearchHits`);
  if (minSearchHits !== undefined) normalized.minSearchHits = minSearchHits;
  const minOpenOrSnippet = normalizeNumberField(
    evidence.minOpenOrSnippet,
    `${label}.minOpenOrSnippet`,
  );
  if (minOpenOrSnippet !== undefined) normalized.minOpenOrSnippet = minOpenOrSnippet;
  const minSymbolsOrAst = normalizeNumberField(
    evidence.minSymbolsOrAst,
    `${label}.minSymbolsOrAst`,
  );
  if (minSymbolsOrAst !== undefined) normalized.minSymbolsOrAst = minSymbolsOrAst;
  const minImpact = normalizeNumberField(evidence.minImpact, `${label}.minImpact`);
  if (minImpact !== undefined) normalized.minImpact = minImpact;
  const maxWarnings = normalizeNumberField(evidence.maxWarnings, `${label}.maxWarnings`);
  if (maxWarnings !== undefined) normalized.maxWarnings = maxWarnings;
  return Object.keys(normalized).length ? normalized : undefined;
};

const normalizeDeepInvestigationConfig = (
  value: unknown,
  label: string,
): DeepInvestigationConfigSource | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const config = value as Record<string, unknown>;
  const normalized: DeepInvestigationConfigSource = {};
  const enabled = normalizeBooleanField(config.enabled, `${label}.enabled`);
  if (enabled !== undefined) normalized.enabled = enabled;
  const deepScanPreset = normalizeBooleanField(
    config.deepScanPreset,
    `${label}.deepScanPreset`,
  );
  if (deepScanPreset !== undefined) normalized.deepScanPreset = deepScanPreset;
  const toolQuota = normalizeToolQuota(config.toolQuota, `${label}.toolQuota`);
  if (toolQuota) normalized.toolQuota = toolQuota;
  const investigationBudget = normalizeBudget(
    config.investigationBudget,
    `${label}.investigationBudget`,
  );
  if (investigationBudget) normalized.investigationBudget = investigationBudget;
  const evidenceGate = normalizeEvidence(config.evidenceGate, `${label}.evidenceGate`);
  if (evidenceGate) normalized.evidenceGate = evidenceGate;
  return Object.keys(normalized).length ? normalized : undefined;
};

const normalizeEvalConfig = (
  value: unknown,
  label: string,
): EvalConfigSource | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const source = value as Record<string, unknown>;
  const normalized: EvalConfigSource = {};
  const reportDir = normalizeStringField(source.report_dir ?? source.reportDir, `${label}.report_dir`);
  if (reportDir !== undefined) normalized.report_dir = reportDir;
  const gatesValue = source.gates;
  if (gatesValue !== undefined) {
    if (!gatesValue || typeof gatesValue !== "object" || Array.isArray(gatesValue)) {
      throw new Error(`Invalid ${label}.gates: expected object.`);
    }
    const gatesSource = gatesValue as Record<string, unknown>;
    const gates: Partial<EvalGateConfig> = {};
    const patchApplyDropMax = normalizeNumberField(
      gatesSource.patch_apply_drop_max ?? gatesSource.patchApplyDropMax,
      `${label}.gates.patch_apply_drop_max`,
    );
    if (patchApplyDropMax !== undefined) gates.patch_apply_drop_max = patchApplyDropMax;
    const verificationPassRateMin = normalizeNumberField(
      gatesSource.verification_pass_rate_min ?? gatesSource.verificationPassRateMin,
      `${label}.gates.verification_pass_rate_min`,
    );
    if (verificationPassRateMin !== undefined) {
      gates.verification_pass_rate_min = verificationPassRateMin;
    }
    const hallucinationRateMax = normalizeNumberField(
      gatesSource.hallucination_rate_max ?? gatesSource.hallucinationRateMax,
      `${label}.gates.hallucination_rate_max`,
    );
    if (hallucinationRateMax !== undefined) gates.hallucination_rate_max = hallucinationRateMax;
    const scopeViolationRateMax = normalizeNumberField(
      gatesSource.scope_violation_rate_max ?? gatesSource.scopeViolationRateMax,
      `${label}.gates.scope_violation_rate_max`,
    );
    if (scopeViolationRateMax !== undefined) {
      gates.scope_violation_rate_max = scopeViolationRateMax;
    }
    if (Object.keys(gates).length) normalized.gates = gates;
  }
  return Object.keys(normalized).length ? normalized : undefined;
};

const normalizeLearningConfig = (
  value: unknown,
  label: string,
): LearningConfigSource | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  const source = value as Record<string, unknown>;
  const normalized: LearningConfigSource = {};
  const persistenceMinConfidence = normalizeNumberField(
    source.persistence_min_confidence ?? source.persistenceMinConfidence,
    `${label}.persistence_min_confidence`,
  );
  if (persistenceMinConfidence !== undefined) {
    normalized.persistence_min_confidence = persistenceMinConfidence;
  }
  const enforcementMinConfidence = normalizeNumberField(
    source.enforcement_min_confidence ?? source.enforcementMinConfidence,
    `${label}.enforcement_min_confidence`,
  );
  if (enforcementMinConfidence !== undefined) {
    normalized.enforcement_min_confidence = enforcementMinConfidence;
  }
  const requireConfirmation = normalizeBooleanField(
    source.require_confirmation_for_low_confidence ?? source.requireConfirmationForLowConfidence,
    `${label}.require_confirmation_for_low_confidence`,
  );
  if (requireConfirmation !== undefined) {
    normalized.require_confirmation_for_low_confidence = requireConfirmation;
  }
  const autoEnforceHigh = normalizeBooleanField(
    source.auto_enforce_high_confidence ?? source.autoEnforceHighConfidence,
    `${label}.auto_enforce_high_confidence`,
  );
  if (autoEnforceHigh !== undefined) {
    normalized.auto_enforce_high_confidence = autoEnforceHigh;
  }
  const candidateStoreFile = normalizeStringField(
    source.candidate_store_file ?? source.candidateStoreFile,
    `${label}.candidate_store_file`,
  );
  if (candidateStoreFile !== undefined) {
    normalized.candidate_store_file = candidateStoreFile;
  }
  return Object.keys(normalized).length ? normalized : undefined;
};

const findConfigFile = (cwd: string): string | undefined => {
  const candidates = ["codali.config.json", ".codalirc"];
  for (const candidate of candidates) {
    const candidatePath = path.join(cwd, candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
};

const readConfigFile = async (configPath?: string): Promise<ConfigSource | undefined> => {
  if (!configPath) return undefined;
  if (!existsSync(configPath)) return undefined;
  const content = await readFile(configPath, "utf8");
  if (!content.trim()) return undefined;
  return JSON.parse(content) as ConfigSource;
};

const loadEnvConfig = (env: NodeJS.ProcessEnv): ConfigSource => {
  const limits: Partial<LimitsConfig> = {};
  const maxSteps = parseNumber(env.CODALI_LIMIT_MAX_STEPS);
  if (maxSteps !== undefined) limits.maxSteps = maxSteps;
  const maxToolCalls = parseNumber(env.CODALI_LIMIT_MAX_TOOL_CALLS);
  if (maxToolCalls !== undefined) limits.maxToolCalls = maxToolCalls;
  const maxRetries = parseNumber(env.CODALI_LIMIT_MAX_RETRIES);
  if (maxRetries !== undefined) limits.maxRetries = maxRetries;
  const maxTokens = parseNumber(env.CODALI_LIMIT_MAX_TOKENS);
  if (maxTokens !== undefined) limits.maxTokens = maxTokens;
  const timeoutMs = parseNumber(env.CODALI_LIMIT_TIMEOUT_MS);
  if (timeoutMs !== undefined) limits.timeoutMs = timeoutMs;

  const routing: Partial<RoutingConfig> = {};
  const setRouting = (
    phase: keyof RoutingConfig,
    key: "agent" | "provider" | "model" | "temperature" | "format" | "grammar",
    value: string | number | undefined,
  ): void => {
    if (value === undefined || value === "") return;
    routing[phase] = {
      ...(routing[phase] ?? {}),
      [key]: value,
    };
  };

  setRouting("librarian", "model", env.CODALI_MODEL_LIBRARIAN);
  setRouting("architect", "model", env.CODALI_MODEL_ARCHITECT);
  setRouting("builder", "model", env.CODALI_MODEL_BUILDER);
  setRouting("critic", "model", env.CODALI_MODEL_CRITIC);
  setRouting("interpreter", "model", env.CODALI_MODEL_INTERPRETER);
  setRouting("librarian", "agent", env.CODALI_AGENT_LIBRARIAN);
  setRouting("architect", "agent", env.CODALI_AGENT_ARCHITECT);
  setRouting("builder", "agent", env.CODALI_AGENT_BUILDER);
  setRouting("critic", "agent", env.CODALI_AGENT_CRITIC);
  setRouting("interpreter", "agent", env.CODALI_AGENT_INTERPRETER);
  setRouting("librarian", "provider", env.CODALI_PROVIDER_LIBRARIAN);
  setRouting("architect", "provider", env.CODALI_PROVIDER_ARCHITECT);
  setRouting("builder", "provider", env.CODALI_PROVIDER_BUILDER);
  setRouting("critic", "provider", env.CODALI_PROVIDER_CRITIC);
  setRouting("interpreter", "provider", env.CODALI_PROVIDER_INTERPRETER);
  setRouting("librarian", "format", env.CODALI_FORMAT_LIBRARIAN);
  setRouting("architect", "format", env.CODALI_FORMAT_ARCHITECT);
  setRouting("builder", "format", env.CODALI_FORMAT_BUILDER);
  setRouting("critic", "format", env.CODALI_FORMAT_CRITIC);
  setRouting("interpreter", "format", env.CODALI_FORMAT_INTERPRETER);
  setRouting("librarian", "grammar", env.CODALI_GRAMMAR_LIBRARIAN);
  setRouting("architect", "grammar", env.CODALI_GRAMMAR_ARCHITECT);
  setRouting("builder", "grammar", env.CODALI_GRAMMAR_BUILDER);
  setRouting("critic", "grammar", env.CODALI_GRAMMAR_CRITIC);
  setRouting("interpreter", "grammar", env.CODALI_GRAMMAR_INTERPRETER);

  const tools: Partial<ToolConfig> = {};
  const enabledTools = parseList(env.CODALI_TOOLS_ENABLED);
  if (enabledTools) tools.enabled = enabledTools;
  const allowShell = parseBoolean(env.CODALI_ALLOW_SHELL);
  if (allowShell !== undefined) tools.allowShell = allowShell;
  const shellAllowlist = parseList(env.CODALI_SHELL_ALLOWLIST);
  if (shellAllowlist) tools.shellAllowlist = shellAllowlist;
  const allowOutsideWorkspace = parseBoolean(env.CODALI_ALLOW_OUTSIDE_WORKSPACE);
  if (allowOutsideWorkspace !== undefined) tools.allowOutsideWorkspace = allowOutsideWorkspace;
  const allowDestructiveOperations =
    parseBoolean(env.CODALI_ALLOW_DESTRUCTIVE_OPERATIONS) ??
    parseBoolean(env.CODALI_ALLOW_DESTRUCTIVE_ACTIONS);
  if (allowDestructiveOperations !== undefined) {
    tools.allowDestructiveOperations = allowDestructiveOperations;
  }

  const docdex: Partial<DocdexConfig> = {};
  const docdexBaseUrl = env.CODALI_DOCDEX_BASE_URL ?? env.DOCDEX_HTTP_BASE_URL;
  if (docdexBaseUrl) docdex.baseUrl = docdexBaseUrl;
  if (env.CODALI_DOCDEX_REPO_ROOT) docdex.repoRoot = env.CODALI_DOCDEX_REPO_ROOT;
  if (env.CODALI_DOCDEX_REPO_ID) docdex.repoId = env.CODALI_DOCDEX_REPO_ID;

  const logging: Partial<LoggingConfig> = {};
  if (env.CODALI_LOG_DIR) logging.directory = env.CODALI_LOG_DIR;

  const context: Partial<ContextConfig> = {};
  const contextMode = env.CODALI_CONTEXT_MODE;
  if (contextMode === "bundle_text" || contextMode === "json") context.mode = contextMode;
  const contextMaxFiles = parseNumber(env.CODALI_CONTEXT_MAX_FILES);
  if (contextMaxFiles !== undefined) context.maxFiles = contextMaxFiles;
  const contextMaxTotalBytes = parseNumber(env.CODALI_CONTEXT_MAX_TOTAL_BYTES);
  if (contextMaxTotalBytes !== undefined) context.maxTotalBytes = contextMaxTotalBytes;
  const contextTokenBudget = parseNumber(env.CODALI_CONTEXT_TOKEN_BUDGET);
  if (contextTokenBudget !== undefined) context.tokenBudget = contextTokenBudget;
  const focusMaxBytes = parseNumber(env.CODALI_CONTEXT_FOCUS_MAX_BYTES);
  if (focusMaxBytes !== undefined) context.focusMaxFileBytes = focusMaxBytes;
  const peripheryMaxBytes = parseNumber(env.CODALI_CONTEXT_PERIPHERY_MAX_BYTES);
  if (peripheryMaxBytes !== undefined) context.peripheryMaxBytes = peripheryMaxBytes;
  const includeRepoMap = parseBoolean(env.CODALI_CONTEXT_INCLUDE_REPO_MAP);
  if (includeRepoMap !== undefined) context.includeRepoMap = includeRepoMap;
  const includeImpact = parseBoolean(env.CODALI_CONTEXT_INCLUDE_IMPACT);
  if (includeImpact !== undefined) context.includeImpact = includeImpact;
  const includeSnippets = parseBoolean(env.CODALI_CONTEXT_INCLUDE_SNIPPETS);
  if (includeSnippets !== undefined) context.includeSnippets = includeSnippets;
  const readStrategy = env.CODALI_CONTEXT_READ_STRATEGY;
  if (readStrategy === "docdex" || readStrategy === "fs") context.readStrategy = readStrategy;
  const maxRefreshes = parseNumber(env.CODALI_CONTEXT_MAX_REFRESHES);
  if (maxRefreshes !== undefined) context.maxContextRefreshes = maxRefreshes;
  const skeletonize = parseBoolean(env.CODALI_CONTEXT_SKELETONIZE);
  if (skeletonize !== undefined) context.skeletonizeLargeFiles = skeletonize;
  const redactSecrets = parseBoolean(env.CODALI_CONTEXT_REDACT_SECRETS);
  if (redactSecrets !== undefined) context.redactSecrets = redactSecrets;
  const ignoreFilesFrom = parseList(env.CODALI_CONTEXT_IGNORE_FILES_FROM);
  if (ignoreFilesFrom) context.ignoreFilesFrom = ignoreFilesFrom;
  const preferredFiles = parseList(env.CODALI_CONTEXT_PREFERRED_FILES);
  if (preferredFiles) context.preferredFiles = preferredFiles;
  const recentFiles = parseList(env.CODALI_CONTEXT_RECENT_FILES);
  if (recentFiles) context.recentFiles = recentFiles;
  const skipSearchWhenPreferred = parseBoolean(env.CODALI_CONTEXT_SKIP_SEARCH);
  if (skipSearchWhenPreferred !== undefined) {
    context.skipSearchWhenPreferred = skipSearchWhenPreferred;
  }

  const deepInvestigation: DeepInvestigationConfigSource = {};
  const deepInvestigationEnabled = parseBooleanStrict(
    env.CODALI_DEEP_INVESTIGATION_ENABLED,
    "CODALI_DEEP_INVESTIGATION_ENABLED",
  );
  if (deepInvestigationEnabled !== undefined) {
    deepInvestigation.enabled = deepInvestigationEnabled;
  }
  const deepScanPreset = parseBooleanStrict(
    env.CODALI_DEEP_INVESTIGATION_DEEP_SCAN_PRESET,
    "CODALI_DEEP_INVESTIGATION_DEEP_SCAN_PRESET",
  );
  if (deepScanPreset !== undefined) {
    deepInvestigation.deepScanPreset = deepScanPreset;
  }

  const toolQuota: Partial<DeepInvestigationToolQuotaConfig> = {};
  const toolQuotaSearch = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SEARCH,
    "CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SEARCH",
  );
  if (toolQuotaSearch !== undefined) toolQuota.search = toolQuotaSearch;
  const toolQuotaOpen = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_OPEN_OR_SNIPPET,
    "CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_OPEN_OR_SNIPPET",
  );
  if (toolQuotaOpen !== undefined) toolQuota.openOrSnippet = toolQuotaOpen;
  const toolQuotaSymbols = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SYMBOLS_OR_AST,
    "CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SYMBOLS_OR_AST",
  );
  if (toolQuotaSymbols !== undefined) toolQuota.symbolsOrAst = toolQuotaSymbols;
  const toolQuotaImpact = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_IMPACT,
    "CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_IMPACT",
  );
  if (toolQuotaImpact !== undefined) toolQuota.impact = toolQuotaImpact;
  const toolQuotaTree = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_TREE,
    "CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_TREE",
  );
  if (toolQuotaTree !== undefined) toolQuota.tree = toolQuotaTree;
  const toolQuotaDag = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_DAG_EXPORT,
    "CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_DAG_EXPORT",
  );
  if (toolQuotaDag !== undefined) toolQuota.dagExport = toolQuotaDag;
  if (Object.values(toolQuota).some((value) => value !== undefined)) {
    deepInvestigation.toolQuota = toolQuota;
  }

  const investigationBudget: Partial<DeepInvestigationBudgetConfig> = {};
  const budgetMinCycles = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_BUDGET_MIN_CYCLES,
    "CODALI_DEEP_INVESTIGATION_BUDGET_MIN_CYCLES",
  );
  if (budgetMinCycles !== undefined) investigationBudget.minCycles = budgetMinCycles;
  const budgetMinSeconds = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_BUDGET_MIN_SECONDS,
    "CODALI_DEEP_INVESTIGATION_BUDGET_MIN_SECONDS",
  );
  if (budgetMinSeconds !== undefined) investigationBudget.minSeconds = budgetMinSeconds;
  const budgetMaxCycles = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_BUDGET_MAX_CYCLES,
    "CODALI_DEEP_INVESTIGATION_BUDGET_MAX_CYCLES",
  );
  if (budgetMaxCycles !== undefined) investigationBudget.maxCycles = budgetMaxCycles;
  if (Object.values(investigationBudget).some((value) => value !== undefined)) {
    deepInvestigation.investigationBudget = investigationBudget;
  }

  const evidenceGate: Partial<DeepInvestigationEvidenceConfig> = {};
  const evidenceMinSearch = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_SEARCH_HITS,
    "CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_SEARCH_HITS",
  );
  if (evidenceMinSearch !== undefined) evidenceGate.minSearchHits = evidenceMinSearch;
  const evidenceMinOpen = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_OPEN_OR_SNIPPET,
    "CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_OPEN_OR_SNIPPET",
  );
  if (evidenceMinOpen !== undefined) evidenceGate.minOpenOrSnippet = evidenceMinOpen;
  const evidenceMinSymbols = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_SYMBOLS_OR_AST,
    "CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_SYMBOLS_OR_AST",
  );
  if (evidenceMinSymbols !== undefined) evidenceGate.minSymbolsOrAst = evidenceMinSymbols;
  const evidenceMinImpact = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_IMPACT,
    "CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_IMPACT",
  );
  if (evidenceMinImpact !== undefined) evidenceGate.minImpact = evidenceMinImpact;
  const evidenceMaxWarnings = parseNumberStrict(
    env.CODALI_DEEP_INVESTIGATION_EVIDENCE_MAX_WARNINGS,
    "CODALI_DEEP_INVESTIGATION_EVIDENCE_MAX_WARNINGS",
  );
  if (evidenceMaxWarnings !== undefined) evidenceGate.maxWarnings = evidenceMaxWarnings;
  if (Object.values(evidenceGate).some((value) => value !== undefined)) {
    deepInvestigation.evidenceGate = evidenceGate;
  }

  const security: Partial<SecurityConfig> = {};
  const redactPatterns = parseList(env.CODALI_SECURITY_REDACT_PATTERNS);
  if (redactPatterns) security.redactPatterns = redactPatterns;
  const readOnlyPaths =
    parseList(env.CODALI_SECURITY_READONLY_PATHS) ?? parseList(env.CODALI_SECURITY_READ_ONLY_PATHS);
  if (readOnlyPaths) security.readOnlyPaths = readOnlyPaths;
  const allowDocEdits = parseBoolean(env.CODALI_SECURITY_ALLOW_DOC_EDITS);
  if (allowDocEdits !== undefined) security.allowDocEdits = allowDocEdits;
  const allowCloudModels =
    parseBoolean(env.CODALI_SECURITY_ALLOW_CLOUD_MODELS) ??
    parseBoolean(env.CODALI_ALLOW_CLOUD_MODELS);
  if (allowCloudModels !== undefined) security.allowCloudModels = allowCloudModels;

  const builder: Partial<BuilderConfig> = {};
  const builderMode = env.CODALI_BUILDER_MODE;
  if (builderMode === "tool_calls" || builderMode === "patch_json" || builderMode === "freeform") {
    builder.mode = builderMode;
  }
  const patchFormat = env.CODALI_BUILDER_PATCH_FORMAT;
  if (patchFormat === "search_replace" || patchFormat === "file_writes") builder.patchFormat = patchFormat;
  const fallbackInterpreter = parseBoolean(env.CODALI_BUILDER_FALLBACK_INTERPRETER);
  if (fallbackInterpreter !== undefined) builder.fallbackToInterpreter = fallbackInterpreter;
  const fallbackMode = env.CODALI_BUILDER_FALLBACK;
  if (fallbackMode) {
    const normalized = fallbackMode.trim().toLowerCase();
    builder.fallbackToInterpreter =
      normalized === "interpreter" || normalized === "freeform" || normalized === "true" || normalized === "1";
  }

  const interpreter: Partial<InterpreterConfig> = {};
  if (env.CODALI_INTERPRETER_PROVIDER) interpreter.provider = env.CODALI_INTERPRETER_PROVIDER;
  if (env.CODALI_INTERPRETER_MODEL) interpreter.model = env.CODALI_INTERPRETER_MODEL;
  if (env.CODALI_INTERPRETER_FORMAT) interpreter.format = env.CODALI_INTERPRETER_FORMAT;
  if (env.CODALI_INTERPRETER_GRAMMAR) interpreter.grammar = env.CODALI_INTERPRETER_GRAMMAR;
  const interpreterMaxRetries = parseNumber(env.CODALI_INTERPRETER_MAX_RETRIES);
  if (interpreterMaxRetries !== undefined) interpreter.maxRetries = interpreterMaxRetries;
  const interpreterTimeoutMs = parseNumber(env.CODALI_INTERPRETER_TIMEOUT_MS);
  if (interpreterTimeoutMs !== undefined) interpreter.timeoutMs = interpreterTimeoutMs;

  const streaming: Partial<StreamingConfig> = {};
  const streamingFlush = parseNumber(env.CODALI_STREAMING_FLUSH_MS);
  if (streamingFlush !== undefined) streaming.flushEveryMs = streamingFlush;

  const cost: Partial<CostConfig> = {};
  const maxCostPerRun = parseNumber(env.CODALI_COST_MAX_PER_RUN);
  if (maxCostPerRun !== undefined) cost.maxCostPerRun = maxCostPerRun;
  const charPerToken = parseNumber(env.CODALI_COST_CHAR_PER_TOKEN);
  if (charPerToken !== undefined) cost.charPerToken = charPerToken;
  const pricingOverrides = parseJson<CostConfig["pricingOverrides"]>(env.CODALI_COST_PRICING_OVERRIDES);
  if (pricingOverrides) cost.pricingOverrides = pricingOverrides;

  const localContext: Partial<LocalContextConfig> = {};
  const localContextEnabled = parseBoolean(env.CODALI_LOCAL_CONTEXT_ENABLED);
  if (localContextEnabled !== undefined) localContext.enabled = localContextEnabled;
  if (env.CODALI_LOCAL_CONTEXT_STORAGE_DIR) localContext.storageDir = env.CODALI_LOCAL_CONTEXT_STORAGE_DIR;
  const persistToolMessages = parseBoolean(env.CODALI_LOCAL_CONTEXT_PERSIST_TOOL_MESSAGES);
  if (persistToolMessages !== undefined) localContext.persistToolMessages = persistToolMessages;
  const maxMessages = parseNumber(env.CODALI_LOCAL_CONTEXT_MAX_MESSAGES);
  if (maxMessages !== undefined) localContext.maxMessages = maxMessages;
  const maxBytesPerLane = parseNumber(env.CODALI_LOCAL_CONTEXT_MAX_BYTES_PER_LANE);
  if (maxBytesPerLane !== undefined) localContext.maxBytesPerLane = maxBytesPerLane;
  const modelTokenLimits = parseJson<LocalContextConfig["modelTokenLimits"]>(
    env.CODALI_LOCAL_CONTEXT_MODEL_TOKEN_LIMITS,
  );
  if (modelTokenLimits) localContext.modelTokenLimits = modelTokenLimits;
  const summarize: Partial<LocalContextConfig["summarize"]> = {};
  const summarizeEnabled = parseBoolean(env.CODALI_LOCAL_CONTEXT_SUMMARIZE_ENABLED);
  if (summarizeEnabled !== undefined) summarize.enabled = summarizeEnabled;
  if (env.CODALI_LOCAL_CONTEXT_SUMMARIZE_PROVIDER) {
    summarize.provider = env.CODALI_LOCAL_CONTEXT_SUMMARIZE_PROVIDER;
  }
  if (env.CODALI_LOCAL_CONTEXT_SUMMARIZE_MODEL) {
    summarize.model = env.CODALI_LOCAL_CONTEXT_SUMMARIZE_MODEL;
  }
  const summarizeTargetTokens = parseNumber(env.CODALI_LOCAL_CONTEXT_SUMMARIZE_TARGET_TOKENS);
  if (summarizeTargetTokens !== undefined) summarize.targetTokens = summarizeTargetTokens;
  const summarizeThreshold = parseNumber(env.CODALI_LOCAL_CONTEXT_SUMMARIZE_THRESHOLD_PCT);
  if (summarizeThreshold !== undefined) {
    summarize.thresholdPct = summarizeThreshold > 1 ? summarizeThreshold / 100 : summarizeThreshold;
  }
  if (Object.keys(summarize).length) {
    localContext.summarize = summarize as LocalContextConfig["summarize"];
  }

  const workflow: WorkflowConfigSource = {};
  if (env.CODALI_WORKFLOW_PROFILE || env.CODALI_PROFILE) {
    workflow.profile = (env.CODALI_WORKFLOW_PROFILE ?? env.CODALI_PROFILE)?.trim().toLowerCase() as
      | WorkflowProfileName
      | undefined;
  }
  const workflowProfiles = parseJson<WorkflowConfigSource["profiles"]>(
    env.CODALI_WORKFLOW_PROFILES,
  );
  if (workflowProfiles) {
    workflow.profiles = workflowProfiles;
  }

  const evalConfig: EvalConfigSource = {};
  if (env.CODALI_EVAL_REPORT_DIR) evalConfig.report_dir = env.CODALI_EVAL_REPORT_DIR;
  const evalGates: Partial<EvalGateConfig> = {};
  const patchApplyDropMax = parseNumberStrict(
    env.CODALI_EVAL_GATE_PATCH_APPLY_DROP_MAX,
    "CODALI_EVAL_GATE_PATCH_APPLY_DROP_MAX",
  );
  if (patchApplyDropMax !== undefined) evalGates.patch_apply_drop_max = patchApplyDropMax;
  const verificationPassRateMin = parseNumberStrict(
    env.CODALI_EVAL_GATE_VERIFICATION_PASS_RATE_MIN,
    "CODALI_EVAL_GATE_VERIFICATION_PASS_RATE_MIN",
  );
  if (verificationPassRateMin !== undefined) {
    evalGates.verification_pass_rate_min = verificationPassRateMin;
  }
  const hallucinationRateMax = parseNumberStrict(
    env.CODALI_EVAL_GATE_HALLUCINATION_RATE_MAX,
    "CODALI_EVAL_GATE_HALLUCINATION_RATE_MAX",
  );
  if (hallucinationRateMax !== undefined) evalGates.hallucination_rate_max = hallucinationRateMax;
  const scopeViolationRateMax = parseNumberStrict(
    env.CODALI_EVAL_GATE_SCOPE_VIOLATION_RATE_MAX,
    "CODALI_EVAL_GATE_SCOPE_VIOLATION_RATE_MAX",
  );
  if (scopeViolationRateMax !== undefined) {
    evalGates.scope_violation_rate_max = scopeViolationRateMax;
  }
  if (Object.keys(evalGates).length) evalConfig.gates = evalGates;

  const learning: LearningConfigSource = {};
  const persistenceMinConfidence = parseNumberStrict(
    env.CODALI_LEARNING_PERSISTENCE_MIN_CONFIDENCE,
    "CODALI_LEARNING_PERSISTENCE_MIN_CONFIDENCE",
  );
  if (persistenceMinConfidence !== undefined) {
    learning.persistence_min_confidence = persistenceMinConfidence;
  }
  const enforcementMinConfidence = parseNumberStrict(
    env.CODALI_LEARNING_ENFORCEMENT_MIN_CONFIDENCE,
    "CODALI_LEARNING_ENFORCEMENT_MIN_CONFIDENCE",
  );
  if (enforcementMinConfidence !== undefined) {
    learning.enforcement_min_confidence = enforcementMinConfidence;
  }
  const requireConfirmation = parseBoolean(
    env.CODALI_LEARNING_REQUIRE_CONFIRMATION_FOR_LOW_CONFIDENCE,
  );
  if (requireConfirmation !== undefined) {
    learning.require_confirmation_for_low_confidence = requireConfirmation;
  }
  const autoEnforceHigh = parseBoolean(env.CODALI_LEARNING_AUTO_ENFORCE_HIGH_CONFIDENCE);
  if (autoEnforceHigh !== undefined) {
    learning.auto_enforce_high_confidence = autoEnforceHigh;
  }
  if (env.CODALI_LEARNING_CANDIDATE_STORE_FILE) {
    learning.candidate_store_file = env.CODALI_LEARNING_CANDIDATE_STORE_FILE;
  }

  const hasDeepInvestigation = Object.values(deepInvestigation).some(
    (value) => value !== undefined,
  );
  const config: ConfigSource = {
    limits,
    tools,
    docdex,
    logging,
    context,
    deepInvestigation: hasDeepInvestigation ? deepInvestigation : undefined,
    security,
    builder,
    interpreter,
    streaming,
    cost,
    localContext,
    eval: Object.keys(evalConfig).length ? evalConfig : undefined,
    learning: Object.keys(learning).length ? learning : undefined,
    workflow: Object.keys(workflow).length ? workflow : undefined,
    routing: Object.keys(routing).length ? routing : undefined,
  };

  if (env.CODALI_WORKSPACE_ROOT) config.workspaceRoot = env.CODALI_WORKSPACE_ROOT;
  if (env.CODALI_PROJECT) config.project = env.CODALI_PROJECT;
  if (env.CODALI_COMMAND) config.command = env.CODALI_COMMAND;
  if (env.CODALI_COMMAND_RUN_ID) config.commandRunId = env.CODALI_COMMAND_RUN_ID;
  if (env.CODALI_JOB_ID) config.jobId = env.CODALI_JOB_ID;
  if (env.CODALI_RUN_ID) config.runId = env.CODALI_RUN_ID;
  if (env.CODALI_TASK_ID) config.taskId = env.CODALI_TASK_ID;
  if (env.CODALI_TASK_KEY) config.taskKey = env.CODALI_TASK_KEY;
  if (env.CODALI_AGENT_ID) config.agentId = env.CODALI_AGENT_ID;
  if (env.CODALI_AGENT_SLUG) config.agentSlug = env.CODALI_AGENT_SLUG;
  const smart = parseBoolean(env.CODALI_SMART);
  if (smart !== undefined) config.smart = smart;
  if (env.CODALI_PLAN_HINT) config.planHint = env.CODALI_PLAN_HINT;
  if (env.CODALI_PROVIDER) config.provider = env.CODALI_PROVIDER;
  if (env.CODALI_MODEL) config.model = env.CODALI_MODEL;
  if (env.CODALI_API_KEY) config.apiKey = env.CODALI_API_KEY;
  if (env.CODALI_BASE_URL) config.baseUrl = env.CODALI_BASE_URL;

  return config;
};

const mergeDeepInvestigationConfigs = (
  defaults: DeepInvestigationConfig | undefined,
  ...sources: Array<DeepInvestigationConfigSource | undefined>
): DeepInvestigationConfig | undefined => {
  const hasAny = Boolean(defaults) || sources.some(Boolean);
  if (!hasAny) return undefined;
  const merged = Object.assign({}, defaults ?? {}, ...sources.filter(Boolean)) as DeepInvestigationConfig;
  const toolQuotaSources = sources.map((source) => source?.toolQuota);
  const budgetSources = sources.map((source) => source?.investigationBudget);
  const evidenceSources = sources.map((source) => source?.evidenceGate);
  merged.toolQuota = Object.assign(
    {},
    defaults?.toolQuota ?? {},
    ...toolQuotaSources.filter(Boolean),
  ) as DeepInvestigationToolQuotaConfig;
  merged.investigationBudget = Object.assign(
    {},
    defaults?.investigationBudget ?? {},
    ...budgetSources.filter(Boolean),
  ) as DeepInvestigationBudgetConfig;
  merged.evidenceGate = Object.assign(
    {},
    defaults?.evidenceGate ?? {},
    ...evidenceSources.filter(Boolean),
  ) as DeepInvestigationEvidenceConfig;
  return merged;
};

const mergeWorkflowConfig = (
  defaults: WorkflowConfig | undefined,
  ...sources: Array<WorkflowConfigSource | undefined>
): WorkflowConfig => {
  const profiles = Object.fromEntries(
    WORKFLOW_PROFILE_NAMES.map((profileName) => [
      profileName,
      {
        ...DEFAULT_WORKFLOW_PROFILES[profileName],
        ...(defaults?.profiles?.[profileName] ?? {}),
      },
    ]),
  ) as Record<WorkflowProfileName, WorkflowProfile>;

  for (const source of sources) {
    if (!source?.profiles) continue;
    for (const profileName of WORKFLOW_PROFILE_NAMES) {
      const override = source.profiles[profileName];
      if (!override) continue;
      profiles[profileName] = {
        ...profiles[profileName],
        ...override,
        name: profileName,
      };
    }
  }

  let profile = defaults?.profile;
  for (const source of sources) {
    if (source?.profile) {
      profile = source.profile;
    }
  }
  return { profile: profile ?? DEFAULT_WORKFLOW_PROFILE, profiles };
};

const mergeEvalConfig = (
  defaults: EvalConfig,
  ...sources: Array<EvalConfigSource | undefined>
): EvalConfig => {
  const merged: EvalConfig = {
    ...defaults,
    report_dir: defaults.report_dir,
    gates: {
      ...defaults.gates,
    },
  };
  for (const source of sources) {
    if (!source) continue;
    if (source.report_dir !== undefined) merged.report_dir = source.report_dir;
    if (source.gates) {
      merged.gates = {
        ...merged.gates,
        ...source.gates,
      };
    }
  }
  return merged;
};

const mergeLearningConfig = (
  defaults: LearningConfig,
  ...sources: Array<LearningConfigSource | undefined>
): LearningConfig => {
  const merged: LearningConfig = {
    ...defaults,
  };
  for (const source of sources) {
    if (!source) continue;
    if (source.persistence_min_confidence !== undefined) {
      merged.persistence_min_confidence = source.persistence_min_confidence;
    }
    if (source.enforcement_min_confidence !== undefined) {
      merged.enforcement_min_confidence = source.enforcement_min_confidence;
    }
    if (source.require_confirmation_for_low_confidence !== undefined) {
      merged.require_confirmation_for_low_confidence =
        source.require_confirmation_for_low_confidence;
    }
    if (source.auto_enforce_high_confidence !== undefined) {
      merged.auto_enforce_high_confidence = source.auto_enforce_high_confidence;
    }
    if (source.candidate_store_file !== undefined) {
      merged.candidate_store_file = source.candidate_store_file;
    }
  }
  return merged;
};

const resolveCommandProfileName = (command: string | undefined): WorkflowProfileName | undefined => {
  if (!command) return undefined;
  const normalized = command.trim().toLowerCase();
  if (!normalized || normalized === "run") return undefined;
  return COMMAND_PROFILE_MAP[normalized];
};

const resolveWorkflowProfile = (params: {
  command?: string;
  mergedWorkflow: WorkflowConfig | undefined;
  fileWorkflow?: WorkflowConfigSource;
  envWorkflow?: WorkflowConfigSource;
  cliWorkflow?: WorkflowConfigSource;
}): { profile: WorkflowProfile; source: WorkflowProfileSource } => {
  const profiles = params.mergedWorkflow?.profiles as Record<WorkflowProfileName, WorkflowProfile> | undefined;
  const availableProfiles = profiles ?? DEFAULT_WORKFLOW_PROFILES;
  const commandProfile = resolveCommandProfileName(params.command);
  if (commandProfile) {
    return { profile: availableProfiles[commandProfile], source: "command" };
  }
  const selectedProfile =
    params.cliWorkflow?.profile
    ?? params.envWorkflow?.profile
    ?? params.fileWorkflow?.profile
    ?? params.mergedWorkflow?.profile
    ?? DEFAULT_WORKFLOW_PROFILE;
  const source: WorkflowProfileSource =
    params.cliWorkflow?.profile ? "cli"
      : params.envWorkflow?.profile ? "env"
        : params.fileWorkflow?.profile ? "config"
          : "default";
  return {
    profile: availableProfiles[selectedProfile],
    source,
  };
};

const mergeConfigs = (
  defaults: CodaliConfig,
  fileConfig?: ConfigSource,
  envConfig?: ConfigSource,
  cliConfig?: ConfigSource,
): CodaliConfig => {
  const fileWorkflow = normalizeWorkflowConfig(fileConfig?.workflow, "config.workflow");
  const envWorkflow = normalizeWorkflowConfig(envConfig?.workflow, "env.workflow");
  const cliWorkflow = normalizeWorkflowConfig(cliConfig?.workflow, "cli.workflow");
  const fileEval = normalizeEvalConfig(fileConfig?.eval, "config.eval");
  const envEval = normalizeEvalConfig(envConfig?.eval, "env.eval");
  const cliEval = normalizeEvalConfig(cliConfig?.eval, "cli.eval");
  const fileLearning = normalizeLearningConfig(fileConfig?.learning, "config.learning");
  const envLearning = normalizeLearningConfig(envConfig?.learning, "env.learning");
  const cliLearning = normalizeLearningConfig(cliConfig?.learning, "cli.learning");
  const deepInvestigation = mergeDeepInvestigationConfigs(
    defaults.deepInvestigation,
    normalizeDeepInvestigationConfig(fileConfig?.deepInvestigation, "config.deepInvestigation"),
    normalizeDeepInvestigationConfig(envConfig?.deepInvestigation, "env.deepInvestigation"),
    normalizeDeepInvestigationConfig(cliConfig?.deepInvestigation, "cli.deepInvestigation"),
  );
  const workflow = mergeWorkflowConfig(defaults.workflow, fileWorkflow, envWorkflow, cliWorkflow);
  const evalConfig = mergeEvalConfig(defaults.eval, fileEval, envEval, cliEval);
  const learningConfig = mergeLearningConfig(
    defaults.learning,
    fileLearning,
    envLearning,
    cliLearning,
  );
  const docdex = {
    ...defaults.docdex,
    ...fileConfig?.docdex,
    ...envConfig?.docdex,
    ...cliConfig?.docdex,
  };
  const tools = {
    ...defaults.tools,
    ...fileConfig?.tools,
    ...envConfig?.tools,
    ...cliConfig?.tools,
  };
  const limits = {
    ...defaults.limits,
    ...fileConfig?.limits,
    ...envConfig?.limits,
    ...cliConfig?.limits,
  };
  const context = {
    ...defaults.context,
    ...fileConfig?.context,
    ...envConfig?.context,
    ...cliConfig?.context,
  };
  const security = {
    ...defaults.security,
    ...fileConfig?.security,
    ...envConfig?.security,
    ...cliConfig?.security,
  };
  const builder = {
    ...defaults.builder,
    ...fileConfig?.builder,
    ...envConfig?.builder,
    ...cliConfig?.builder,
  };
  const interpreter = {
    ...defaults.interpreter,
    ...fileConfig?.interpreter,
    ...envConfig?.interpreter,
    ...cliConfig?.interpreter,
  };
  const streaming = {
    ...defaults.streaming,
    ...fileConfig?.streaming,
    ...envConfig?.streaming,
    ...cliConfig?.streaming,
  };
  const cost = {
    ...defaults.cost,
    ...fileConfig?.cost,
    ...envConfig?.cost,
    ...cliConfig?.cost,
  };
  const localContext = {
    ...defaults.localContext,
    ...fileConfig?.localContext,
    ...envConfig?.localContext,
    ...cliConfig?.localContext,
    modelTokenLimits: {
      ...defaults.localContext.modelTokenLimits,
      ...fileConfig?.localContext?.modelTokenLimits,
      ...envConfig?.localContext?.modelTokenLimits,
      ...cliConfig?.localContext?.modelTokenLimits,
    },
    summarize: {
      ...defaults.localContext.summarize,
      ...fileConfig?.localContext?.summarize,
      ...envConfig?.localContext?.summarize,
      ...cliConfig?.localContext?.summarize,
    },
  };
  const routing = mergeRoutingConfigs(
    defaults.routing,
    fileConfig?.routing,
    envConfig?.routing,
    cliConfig?.routing,
  );
  const logging = {
    ...defaults.logging,
    ...fileConfig?.logging,
    ...envConfig?.logging,
    ...cliConfig?.logging,
  };

  return {
    ...defaults,
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
    deepInvestigation,
    docdex,
    tools,
    limits,
    context,
    security,
    builder,
    interpreter,
    streaming,
    cost,
    localContext,
    eval: evalConfig,
    learning: learningConfig,
    workflow,
    logging,
    routing,
  };
};

const mergeRoutingConfigs = (
  ...sources: Array<RoutingConfig | Partial<RoutingConfig> | undefined>
): RoutingConfig | undefined => {
  const phases: Array<keyof RoutingConfig> = [
    "librarian",
    "architect",
    "builder",
    "critic",
    "interpreter",
  ];
  const merged: RoutingConfig = {};
  for (const phase of phases) {
    const phaseConfigs = sources.map((source) => {
      if (!source) return undefined;
      return Object.prototype.hasOwnProperty.call(source, phase) ? source[phase] : undefined;
    });
    const combined = Object.assign({}, ...phaseConfigs.filter(Boolean)) as RoutingPhaseConfig;
    const hasPhase = phaseConfigs.some((config) => config !== undefined);
    if (hasPhase) {
      merged[phase] = combined;
    }
  }
  return Object.keys(merged).length ? merged : undefined;
};

const finalizeConfig = (cwd: string, config: CodaliConfig): CodaliConfig => {
  const workspaceRoot = path.resolve(cwd, config.workspaceRoot);
  return {
    ...config,
    streaming: {
      ...config.streaming,
      enabled: true,
    },
    workspaceRoot,
  };
};

const assertRequired = (config: CodaliConfig): void => {
  const missing: string[] = [];
  if (!config.workspaceRoot) missing.push("workspaceRoot");
  const hasRoutingAgent =
    config.smart &&
    Object.values(config.routing ?? {}).some((phase) => Boolean(phase?.agent));
  if (!config.smart && !config.provider) missing.push("provider");
  if (!config.smart && !config.model) missing.push("model");
  if (config.smart && !config.provider && !hasRoutingAgent) {
    // allow auto-selection from agent DB
  }
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }
};

const assertValid = (config: CodaliConfig): void => {
  const errors: string[] = [];
  const { localContext } = config;
  if (localContext.maxMessages < 0) errors.push("localContext.maxMessages");
  if (localContext.maxBytesPerLane < 0) errors.push("localContext.maxBytesPerLane");
  if (localContext.summarize.targetTokens < 0) errors.push("localContext.summarize.targetTokens");
  if (
    localContext.summarize.thresholdPct <= 0 ||
    localContext.summarize.thresholdPct > 1
  ) {
    errors.push("localContext.summarize.thresholdPct");
  }
  if (config.interpreter.maxRetries < 0) errors.push("interpreter.maxRetries");
  if (config.interpreter.timeoutMs < 0) errors.push("interpreter.timeoutMs");
  for (const [key, value] of Object.entries(localContext.modelTokenLimits)) {
    if (value <= 0) errors.push(`localContext.modelTokenLimits.${key}`);
  }
  const workflowProfile = config.resolvedWorkflowProfile;
  if (workflowProfile) {
    if (workflowProfile.retryBudget < 0) errors.push("resolvedWorkflowProfile.retryBudget");
    if (!workflowProfile.verificationPolicy.trim()) {
      errors.push("resolvedWorkflowProfile.verificationPolicy");
    }
    if (workflowProfile.verificationMinimumChecks < 0) {
      errors.push("resolvedWorkflowProfile.verificationMinimumChecks");
    }
    if (!workflowProfile.description.trim()) {
      errors.push("resolvedWorkflowProfile.description");
    }
  }
  const deepInvestigation = config.deepInvestigation;
  if (deepInvestigation) {
    const nonNegative = (value: number | undefined, label: string): void => {
      if (value !== undefined && value < 0) errors.push(label);
    };
    const { toolQuota, investigationBudget, evidenceGate } = deepInvestigation;
    if (toolQuota) {
      nonNegative(toolQuota.search, "deepInvestigation.toolQuota.search");
      nonNegative(toolQuota.openOrSnippet, "deepInvestigation.toolQuota.openOrSnippet");
      nonNegative(toolQuota.symbolsOrAst, "deepInvestigation.toolQuota.symbolsOrAst");
      nonNegative(toolQuota.impact, "deepInvestigation.toolQuota.impact");
      nonNegative(toolQuota.tree, "deepInvestigation.toolQuota.tree");
      nonNegative(toolQuota.dagExport, "deepInvestigation.toolQuota.dagExport");
    }
    if (investigationBudget) {
      nonNegative(investigationBudget.minCycles, "deepInvestigation.investigationBudget.minCycles");
      nonNegative(
        investigationBudget.minSeconds,
        "deepInvestigation.investigationBudget.minSeconds",
      );
      nonNegative(investigationBudget.maxCycles, "deepInvestigation.investigationBudget.maxCycles");
      if (
        investigationBudget.minCycles !== undefined
        && investigationBudget.maxCycles !== undefined
        && investigationBudget.maxCycles < investigationBudget.minCycles
      ) {
        errors.push("deepInvestigation.investigationBudget.maxCycles");
      }
    }
    if (evidenceGate) {
      nonNegative(evidenceGate.minSearchHits, "deepInvestigation.evidenceGate.minSearchHits");
      nonNegative(evidenceGate.minOpenOrSnippet, "deepInvestigation.evidenceGate.minOpenOrSnippet");
      nonNegative(evidenceGate.minSymbolsOrAst, "deepInvestigation.evidenceGate.minSymbolsOrAst");
      nonNegative(evidenceGate.minImpact, "deepInvestigation.evidenceGate.minImpact");
      nonNegative(evidenceGate.maxWarnings, "deepInvestigation.evidenceGate.maxWarnings");
    }
  }
  const evalGates = config.eval.gates;
  const validateRate = (value: number, label: string): void => {
    if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(label);
  };
  validateRate(evalGates.patch_apply_drop_max, "eval.gates.patch_apply_drop_max");
  validateRate(evalGates.verification_pass_rate_min, "eval.gates.verification_pass_rate_min");
  validateRate(evalGates.hallucination_rate_max, "eval.gates.hallucination_rate_max");
  validateRate(evalGates.scope_violation_rate_max, "eval.gates.scope_violation_rate_max");
  if (!config.eval.report_dir.trim()) errors.push("eval.report_dir");
  validateRate(
    config.learning.persistence_min_confidence,
    "learning.persistence_min_confidence",
  );
  validateRate(
    config.learning.enforcement_min_confidence,
    "learning.enforcement_min_confidence",
  );
  if (
    config.learning.enforcement_min_confidence < config.learning.persistence_min_confidence
  ) {
    errors.push("learning.enforcement_min_confidence");
  }
  if (!config.learning.candidate_store_file.trim()) {
    errors.push("learning.candidate_store_file");
  }
  if (errors.length) {
    throw new Error(`Invalid config values: ${errors.join(", ")}`);
  }
};

export const loadConfig = async (options: LoadConfigOptions = {}): Promise<CodaliConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? findConfigFile(cwd);
  const fileConfig = await readConfigFile(configPath);
  const envConfig = loadEnvConfig(env);
  const fileWorkflow = normalizeWorkflowConfig(fileConfig?.workflow, "config.workflow");
  const envWorkflow = normalizeWorkflowConfig(envConfig?.workflow, "env.workflow");
  const cliWorkflow = normalizeWorkflowConfig(options.cli?.workflow, "cli.workflow");

  const defaults: CodaliConfig = {
    workspaceRoot: ".",
    provider: "",
    model: "",
    apiKey: undefined,
    baseUrl: undefined,
    smart: true,
    docdex: {
      baseUrl: envConfig.docdex?.baseUrl ?? DEFAULT_DOCDEX_BASE_URL,
      repoRoot: envConfig.docdex?.repoRoot,
      repoId: envConfig.docdex?.repoId,
    },
    tools: DEFAULT_TOOL_CONFIG,
    limits: DEFAULT_LIMITS,
    context: DEFAULT_CONTEXT,
    deepInvestigation: DEFAULT_DEEP_INVESTIGATION,
    security: DEFAULT_SECURITY,
    builder: DEFAULT_BUILDER,
    interpreter: DEFAULT_INTERPRETER,
    streaming: DEFAULT_STREAMING,
    cost: DEFAULT_COST,
    localContext: DEFAULT_LOCAL_CONTEXT,
    eval: DEFAULT_EVAL,
    learning: DEFAULT_LEARNING,
    workflow: {
      profile: DEFAULT_WORKFLOW_PROFILE,
      profiles: DEFAULT_WORKFLOW_PROFILES,
    },
    logging: DEFAULT_LOGGING,
    routing: undefined,
  };

  const merged = mergeConfigs(defaults, fileConfig, envConfig, options.cli);
  const hasExplicitSmart =
    fileConfig?.smart !== undefined
    || envConfig.smart !== undefined
    || options.cli?.smart !== undefined;
  const hasExplicitBuilderMode =
    fileConfig?.builder?.mode !== undefined
    || envConfig.builder?.mode !== undefined
    || options.cli?.builder?.mode !== undefined;
  const hasExplicitBuilderFallback =
    fileConfig?.builder?.fallbackToInterpreter !== undefined
    || envConfig.builder?.fallbackToInterpreter !== undefined
    || options.cli?.builder?.fallbackToInterpreter !== undefined;
  const hasExplicitRetryBudget =
    fileConfig?.limits?.maxRetries !== undefined
    || envConfig.limits?.maxRetries !== undefined
    || options.cli?.limits?.maxRetries !== undefined;
  const workflowResolution = resolveWorkflowProfile({
    command: merged.command,
    mergedWorkflow: merged.workflow,
    fileWorkflow,
    envWorkflow,
    cliWorkflow,
  });
  merged.resolvedWorkflowProfile = {
    ...workflowResolution.profile,
    source: workflowResolution.source,
    command: (merged.command ?? "run").trim().toLowerCase() || "run",
  };
  merged.workflow = {
    profile: merged.resolvedWorkflowProfile.name,
    profiles: merged.workflow?.profiles ?? DEFAULT_WORKFLOW_PROFILES,
  };
  if (!hasExplicitSmart) {
    merged.smart = merged.resolvedWorkflowProfile.smart;
  }
  if (!hasExplicitBuilderMode) {
    merged.builder.mode = merged.resolvedWorkflowProfile.builderMode;
  }
  if (!hasExplicitBuilderFallback) {
    merged.builder.fallbackToInterpreter = merged.resolvedWorkflowProfile.fallbackToInterpreter;
  }
  if (!hasExplicitRetryBudget) {
    merged.limits.maxRetries = merged.resolvedWorkflowProfile.retryBudget;
  }
  const finalized = finalizeConfig(cwd, merged);
  assertRequired(finalized);
  assertValid(finalized);
  return finalized;
};
