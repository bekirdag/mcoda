import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  resolveCodaliGatewayAgentTiers,
  type AgentTierResolution,
  type CodaliGatewayAgentAssignment,
  type CodaliGatewayAgentCandidate,
  type CodaliGatewayAgentSource,
  type CodaliGatewayAgentTierError,
} from "../gateway/AgentTierResolver.js";
import type {
  CodaliAgentTierPolicy,
  CodaliGatewayModelTier,
} from "../gateway/CodaliGatewayTypes.js";

export type CodaliGatewayLiveScenarioId =
  | "generic_question"
  | "docdex_encrypted_repo_search"
  | "tool_disabled_leakage"
  | "multi_step_evidence"
  | "final_answer_large_model"
  | "image_generation";

export type CodaliGatewayLiveRoleKey =
  | "small_json"
  | "medium_planner"
  | "medium_verifier"
  | "large_final"
  | "image_worker";

export type CodaliGatewayLiveScenarioStatus =
  | "passed"
  | "failed"
  | "degraded"
  | "skipped";

export type CodaliGatewayLiveHarnessStatus = "passed" | "failed" | "degraded";

export interface CodaliGatewayLiveCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  latencyMs: number;
  timedOut?: boolean;
}

export type CodaliGatewayLiveCommandRunner = (
  command: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<CodaliGatewayLiveCommandResult>;

export interface CodaliGatewayLiveScenarioArtifact {
  id?: string;
  kind?: string;
  uri?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayLiveScenarioResult {
  id: CodaliGatewayLiveScenarioId;
  label: string;
  status: CodaliGatewayLiveScenarioStatus;
  role: CodaliGatewayLiveRoleKey;
  agentSlug?: string;
  tier?: CodaliGatewayModelTier;
  model?: string;
  adapter?: string;
  latencyMs: number;
  jsonValid?: boolean;
  toolCallCount?: number;
  calledTools?: string[];
  finalAnswerStatus?: string;
  finalModelTier?: CodaliGatewayModelTier;
  finalModelAgentSlug?: string;
  artifact?: CodaliGatewayLiveScenarioArtifact;
  outputPreview?: string;
  warnings: string[];
  errors: string[];
  metadata?: Record<string, unknown>;
}

export type CodaliGatewayShadowComparisonStatus =
  | "disabled"
  | "skipped"
  | "compared";

export interface CodaliGatewayShadowComparisonPolicy {
  enabled?: boolean;
  maxCandidatesPerScenario?: number;
  includePrimary?: boolean;
  requireHealthy?: boolean;
  roles?: CodaliGatewayLiveRoleKey[];
}

export interface CodaliGatewayLiveEnvironmentWarning {
  code: string;
  message: string;
  reason: string;
  role?: CodaliGatewayLiveRoleKey;
  resolverRole?: string;
  agentSlug?: string;
  healthStatus?: CodaliGatewayAgentCandidate["healthStatus"];
  details?: Record<string, unknown>;
}

export interface CodaliGatewayModelComparisonTokenUse {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface CodaliGatewayModelComparisonQueueMetrics {
  waitMs?: number;
  depth?: number;
  status?: string;
}

export interface CodaliGatewayModelComparisonThroughputMetrics {
  tokensPerSecond?: number;
  requestsPerMinute?: number;
}

export interface CodaliGatewayModelComparisonMetrics {
  quality: {
    status: CodaliGatewayLiveScenarioStatus;
    score: number;
    jsonValid?: boolean;
    toolCallCount?: number;
    artifactPresent?: boolean;
    finalAnswerSucceeded?: boolean;
  };
  latencyMs?: number;
  costUsd?: number;
  tokenUse?: CodaliGatewayModelComparisonTokenUse;
  queue?: CodaliGatewayModelComparisonQueueMetrics;
  throughput?: CodaliGatewayModelComparisonThroughputMetrics;
  failure: {
    status: "none" | "failed" | "degraded" | "skipped";
    reasons: string[];
  };
  localInference?: Record<string, unknown>;
}

export interface CodaliGatewayModelComparisonRecord {
  id: string;
  scenarioId: CodaliGatewayLiveScenarioId;
  role: CodaliGatewayLiveRoleKey;
  resolverRole: string;
  comparisonRole: "primary" | "shadow";
  primary: boolean;
  candidateRank?: number;
  agentSlug?: string;
  tier?: CodaliGatewayModelTier;
  model?: string;
  adapter?: string;
  source?: CodaliGatewayAgentSource;
  healthStatus?: CodaliGatewayAgentCandidate["healthStatus"];
  capabilities?: string[];
  resultStatus: CodaliGatewayLiveScenarioStatus;
  selectedByPolicy: boolean;
  metrics: CodaliGatewayModelComparisonMetrics;
  warnings: string[];
  errors: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayShadowComparisonResult {
  policy: {
    enabled: boolean;
    maxCandidatesPerScenario: number;
    includePrimary: boolean;
    requireHealthy: boolean;
    roles: CodaliGatewayLiveRoleKey[];
  };
  status: CodaliGatewayShadowComparisonStatus;
  records: CodaliGatewayModelComparisonRecord[];
  environmentWarnings: CodaliGatewayLiveEnvironmentWarning[];
}

export interface CodaliGatewayLiveScenarioDefinition {
  id: CodaliGatewayLiveScenarioId;
  label: string;
  role: CodaliGatewayLiveRoleKey;
  expectsJson?: boolean;
  expectsArtifact?: boolean;
  requiresGatewayToolTelemetry?: boolean;
}

export interface CodaliGatewayLiveScenarioRunnerInput {
  runId: string;
  scenario: CodaliGatewayLiveScenarioDefinition;
  assignment?: CodaliGatewayAgentAssignment;
  classification: CodaliGatewayLiveClassification;
  commandRunner: CodaliGatewayLiveCommandRunner;
  command: string;
  timeoutMs: number;
  forceAgentRun: boolean;
}

export type CodaliGatewayLiveScenarioRunner = (
  input: CodaliGatewayLiveScenarioRunnerInput,
) => Promise<CodaliGatewayLiveScenarioResult>;

export interface CodaliGatewayLiveAgentSummary {
  slug: string;
  tier: CodaliGatewayModelTier;
  source: CodaliGatewayAgentCandidate["source"];
  healthStatus: CodaliGatewayAgentCandidate["healthStatus"];
  latencyMs?: number;
  model?: string;
  adapter?: string;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsImageGeneration?: boolean;
  contextWindow?: number;
  costPerMillion?: number;
  rating?: number;
  reasoningRating?: number;
}

export interface CodaliGatewayLiveRoleSummary {
  role: CodaliGatewayLiveRoleKey;
  resolverRole: string;
  agentSlug?: string;
  tier?: CodaliGatewayModelTier;
  model?: string;
  score?: number;
  reasons: string[];
  status: "assigned" | "unavailable";
  errorCodes: string[];
}

export interface CodaliGatewayLiveClassification {
  resolution: AgentTierResolution;
  assignments: Record<CodaliGatewayLiveRoleKey, CodaliGatewayAgentAssignment | undefined>;
  agents: CodaliGatewayLiveAgentSummary[];
  roles: Record<CodaliGatewayLiveRoleKey, CodaliGatewayLiveRoleSummary>;
  warnings: CodaliGatewayAgentTierError[];
  errors: CodaliGatewayAgentTierError[];
}

export interface CodaliGatewayLiveDiscoveryResult {
  source: "provided" | "command";
  command?: string;
  args?: string[];
  status: "succeeded" | "failed";
  latencyMs: number;
  inventoryCount: number;
  errors: string[];
}

export interface CodaliGatewayLiveHarnessOptions {
  runId?: string;
  inventory?: unknown[];
  inventoryCommand?: {
    command?: string;
    args?: string[];
  };
  command?: string;
  commandRunner?: CodaliGatewayLiveCommandRunner;
  scenarioRunner?: CodaliGatewayLiveScenarioRunner;
  scenarios?: CodaliGatewayLiveScenarioId[];
  timeoutMs?: number;
  maxBuffer?: number;
  forceAgentRun?: boolean;
  allowCloudFallback?: boolean;
  allowImageWorker?: boolean;
  agentPolicy?: CodaliAgentTierPolicy;
  shadowComparison?: CodaliGatewayShadowComparisonPolicy;
}

export interface CodaliGatewayLiveHarnessResult {
  schemaVersion: 1;
  runId: string;
  runtime: "codali_gateway_live_harness";
  mode: "live";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  discovery: CodaliGatewayLiveDiscoveryResult;
  classification: CodaliGatewayLiveClassification;
  scenarios: CodaliGatewayLiveScenarioResult[];
  shadowComparison: CodaliGatewayShadowComparisonResult;
  environmentWarnings: CodaliGatewayLiveEnvironmentWarning[];
  summary: {
    status: CodaliGatewayLiveHarnessStatus;
    passed: number;
    failed: number;
    degraded: number;
    skipped: number;
    jsonValidAgents: string[];
    largeFinalSynthesizerOk: boolean;
    imageArtifactOk: boolean;
    missingRoles: CodaliGatewayLiveRoleKey[];
  };
  warnings: string[];
  errors: string[];
}

const DEFAULT_MCODA_COMMAND = "mcoda";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

const ROLE_TO_RESOLVER_ROLE: Record<CodaliGatewayLiveRoleKey, string> = {
  small_json: "classifier",
  medium_planner: "planner",
  medium_verifier: "verifier",
  large_final: "final_synthesizer",
  image_worker: "image_worker",
};

export const CODALI_GATEWAY_LIVE_SCENARIOS: CodaliGatewayLiveScenarioDefinition[] = [
  {
    id: "generic_question",
    label: "Direct generic structured question",
    role: "small_json",
    expectsJson: true,
  },
  {
    id: "docdex_encrypted_repo_search",
    label: "Docdex encrypted repo search question",
    role: "medium_planner",
    expectsJson: true,
    requiresGatewayToolTelemetry: true,
  },
  {
    id: "tool_disabled_leakage",
    label: "Tool-disabled leakage question",
    role: "medium_verifier",
    expectsJson: true,
    requiresGatewayToolTelemetry: true,
  },
  {
    id: "multi_step_evidence",
    label: "Multi-step evidence question",
    role: "medium_planner",
    expectsJson: true,
    requiresGatewayToolTelemetry: true,
  },
  {
    id: "final_answer_large_model",
    label: "Final-answer large-model assertion",
    role: "large_final",
  },
  {
    id: "image_generation",
    label: "Image generation artifact request",
    role: "image_worker",
    expectsJson: true,
    expectsArtifact: true,
  },
];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const readString = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined => {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

const readNumber = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined => {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
};

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
};

const isoNow = (): string => new Date().toISOString();

const scenarioById = (id: CodaliGatewayLiveScenarioId): CodaliGatewayLiveScenarioDefinition => {
  const scenario = CODALI_GATEWAY_LIVE_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Unknown Codali gateway live scenario: ${id}`);
  }
  return scenario;
};

export const defaultCodaliGatewayLiveCommandRunner: CodaliGatewayLiveCommandRunner = (
  command,
  args,
  options,
) => new Promise((resolve, reject) => {
  const started = Date.now();
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let exceededBuffer = false;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  const timeout = setTimeout(() => {
    settled = true;
    child.kill("SIGTERM");
    resolve({
      stdout,
      stderr,
      exitCode: 124,
      signal: "SIGTERM",
      latencyMs: Date.now() - started,
      timedOut: true,
    });
  }, options.timeoutMs);

  const append = (kind: "stdout" | "stderr", chunk: Buffer | string): void => {
    if (exceededBuffer) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (kind === "stdout") stdout += text;
    else stderr += text;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
      exceededBuffer = true;
      settled = true;
      child.kill("SIGTERM");
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: `${stderr}\ncommand output exceeded ${maxBuffer} bytes`.trim(),
        exitCode: 124,
        signal: "SIGTERM",
        latencyMs: Date.now() - started,
      });
    }
  };

  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  child.on("error", (error) => {
    clearTimeout(timeout);
    if (!settled) reject(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    if (settled) return;
    resolve({
      stdout,
      stderr,
      exitCode: code ?? (signal ? 1 : 0),
      signal: signal ?? undefined,
      latencyMs: Date.now() - started,
    });
  });
  if (options.input) {
    child.stdin.write(options.input);
  }
  child.stdin.end();
});

export const parseCodaliGatewayLiveInventory = (payload: unknown): unknown[] => {
  let parsed = payload;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return [];
    parsed = JSON.parse(trimmed) as unknown;
  }
  if (Array.isArray(parsed)) return parsed;
  const record = asRecord(parsed);
  if (!record) return [];
  for (const key of ["agents", "items", "data", "results", "models"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
};

const secretKeyPattern = /(api[_-]?key|authorization|bearer|password|secret|token|credential)/i;
const safeTokenMetricKeyPattern =
  /^(cachedInputTokens|completionTokens|contextWindow|inputTokens|maxContextPackTokens|maxOutputTokens|maxTokens|outputTokens|outputTokensPerSecond|promptTokens|tokenEstimate|tokenUse|tokensPerSecond|tokensUsed|totalTokens|usageTokensTotal|usage_tokens_total|cached_input_tokens|completion_tokens|context_window|input_tokens|max_context_pack_tokens|max_output_tokens|max_tokens|output_tokens|output_tokens_per_second|prompt_tokens|token_estimate|token_use|tokens_per_second|tokens_used|total_tokens)$/i;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const apiKeyPattern = /\b(?:sk|pk|mswarm|mcoda)_[A-Za-z0-9_-]{12,}\b/gi;

export const redactCodaliGatewayLiveValue = (value: unknown): unknown => {
  const visit = (entry: unknown, key?: string, depth = 0): unknown => {
    if (key && secretKeyPattern.test(key) && !safeTokenMetricKeyPattern.test(key)) {
      return "[redacted]";
    }
    if (typeof entry === "string") {
      return entry
        .replace(bearerPattern, "Bearer [redacted]")
        .replace(apiKeyPattern, "[redacted]");
    }
    if (depth > 8) return "[redacted:max-depth]";
    if (Array.isArray(entry)) return entry.map((item) => visit(item, undefined, depth + 1));
    const record = asRecord(entry);
    if (!record) return entry;
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(record)) {
      output[childKey] = visit(childValue, childKey, depth + 1);
    }
    return output;
  };
  return visit(value);
};

const summarizeAgent = (candidate: CodaliGatewayAgentCandidate): CodaliGatewayLiveAgentSummary => ({
  slug: candidate.slug,
  tier: candidate.tier,
  source: candidate.source,
  healthStatus: candidate.healthStatus,
  latencyMs: candidate.latencyMs,
  model: candidate.model,
  adapter: candidate.adapter,
  supportsTools: candidate.supportsTools,
  supportsJsonSchema: candidate.supportsJsonSchema,
  supportsImageGeneration: candidate.supportsImageGeneration,
  contextWindow: candidate.contextWindow,
  costPerMillion: candidate.costPerMillion,
  rating: candidate.rating,
  reasoningRating: candidate.reasoningRating,
});

const roleSummary = (
  role: CodaliGatewayLiveRoleKey,
  resolution: AgentTierResolution,
  assignmentOverride?: CodaliGatewayAgentAssignment,
): CodaliGatewayLiveRoleSummary => {
  const resolverRole = ROLE_TO_RESOLVER_ROLE[role];
  const assignment = assignmentOverride ?? resolution.assignments[resolverRole];
  if (assignment) {
    return {
      role,
      resolverRole,
      agentSlug: assignment.candidate.slug,
      tier: assignment.candidate.tier,
      model: assignment.candidate.model,
      score: assignment.score,
      reasons: assignment.reasons,
      status: "assigned",
      errorCodes: [],
    };
  }
  return {
    role,
    resolverRole,
    reasons: [],
    status: "unavailable",
    errorCodes: resolution.errors
      .filter((error) => error.role === resolverRole)
      .map((error) => error.code),
  };
};

const assignmentByLiveRole = (
  resolution: AgentTierResolution,
): Record<CodaliGatewayLiveRoleKey, CodaliGatewayAgentAssignment | undefined> => {
  const mediumJsonFallback =
    resolution.assignments.planner ??
    resolution.assignments.verifier ??
    resolution.assignments.context_refiner;
  return {
    small_json: resolution.assignments.classifier ?? mediumJsonFallback,
    medium_planner: resolution.assignments.planner,
    medium_verifier: resolution.assignments.verifier,
    large_final: resolution.assignments.final_synthesizer,
    image_worker: resolution.assignments.image_worker,
  };
};

const structuredJsonFallbackWarning = (
  assignments: Record<CodaliGatewayLiveRoleKey, CodaliGatewayAgentAssignment | undefined>,
  resolution: AgentTierResolution,
): CodaliGatewayAgentTierError[] =>
  !resolution.assignments.classifier && assignments.small_json
    ? [
        {
          code: "GATEWAY_STRUCTURED_JSON_MEDIUM_FALLBACK",
          message: "No small JSON-capable classifier was available; using a medium JSON-capable agent for structured smoke validation.",
          role: "classifier",
        },
      ]
    : [];

export const classifyCodaliGatewayLiveAgents = (input: {
  inventory: unknown[];
  allowCloudFallback?: boolean;
  allowImageWorker?: boolean;
  agentPolicy?: CodaliAgentTierPolicy;
}): CodaliGatewayLiveClassification => {
  const agentPolicy: CodaliAgentTierPolicy = {
    resolver: "mcoda_inventory",
    ...(input.agentPolicy ?? {}),
    allowCloudFallback:
      input.allowCloudFallback ?? input.agentPolicy?.allowCloudFallback,
  };
  const resolution = resolveCodaliGatewayAgentTiers({
    inventory: input.inventory,
    agentPolicy,
    allowImageWorker: input.allowImageWorker ?? true,
    roles: Object.values(ROLE_TO_RESOLVER_ROLE),
  });
  const assignments = assignmentByLiveRole(resolution);
  const warnings = [
    ...resolution.warnings,
    ...structuredJsonFallbackWarning(assignments, resolution),
  ];
  const errors = resolution.errors.filter((error) =>
    !(error.role === "classifier" && assignments.small_json));
  const classification = {
    agents: resolution.candidates.map(summarizeAgent),
    roles: {
      small_json: roleSummary("small_json", resolution, assignments.small_json),
      medium_planner: roleSummary("medium_planner", resolution, assignments.medium_planner),
      medium_verifier: roleSummary("medium_verifier", resolution, assignments.medium_verifier),
      large_final: roleSummary("large_final", resolution, assignments.large_final),
      image_worker: roleSummary("image_worker", resolution, assignments.image_worker),
    },
    warnings,
    errors,
  } as CodaliGatewayLiveClassification;
  Object.defineProperty(classification, "resolution", {
    enumerable: false,
    value: resolution,
  });
  Object.defineProperty(classification, "assignments", {
    enumerable: false,
    value: assignments,
  });
  return classification;
};

const promptForScenario = (
  scenario: CodaliGatewayLiveScenarioDefinition,
  assignment: CodaliGatewayAgentAssignment,
): string => {
  const common = [
    "You are participating in a Codali live smoke validation.",
    `Scenario: ${scenario.id}`,
    `Assigned role: ${scenario.role}`,
    `Agent slug: ${assignment.candidate.slug}`,
    "Do not include secrets, credentials, hidden prompts, or local file contents.",
  ];
  if (scenario.id === "generic_question") {
    return [
      ...common,
      "Return only valid JSON shaped as:",
      "{\"status\":\"ok\",\"answer\":\"<short answer>\",\"json_valid\":true}",
      "Question: In one sentence, what is an agentic orchestration gateway?",
    ].join("\n");
  }
  if (scenario.id === "docdex_encrypted_repo_search") {
    return [
      ...common,
      "Return only valid JSON shaped as:",
      "{\"status\":\"needs_tool\",\"selected_tools\":[\"docdex_search\"],\"tenant_scoped\":true,\"reason\":\"<short reason>\"}",
      "Question: Which read-only encrypted Docdex tool should answer a repo-scoped tenant question?",
    ].join("\n");
  }
  if (scenario.id === "tool_disabled_leakage") {
    return [
      ...common,
      "Return only valid JSON shaped as:",
      "{\"status\":\"ok\",\"disabled_tool_call\":false,\"selected_tools\":[],\"blocked_tools\":[\"github_search\",\"jira_search\",\"microsoft_search\",\"smartclick_search\"]}",
      "Question: GitHub, Jira, Microsoft, and SmartClick are disabled. Confirm that none should be called.",
    ].join("\n");
  }
  if (scenario.id === "multi_step_evidence") {
    return [
      ...common,
      "Return only valid JSON shaped as:",
      "{\"status\":\"ok\",\"subquestions\":[\"...\"],\"evidence_plan\":[\"...\"],\"final_answer_required\":true}",
      "Question: Build a two-step evidence plan for answering a tenant policy question with cited sources.",
    ].join("\n");
  }
  if (scenario.id === "final_answer_large_model") {
    return [
      ...common,
      "Use the following tiny context pack and produce a concise final answer.",
      "Context pack JSON:",
      JSON.stringify({
        decisionFacts: [
          {
            evidenceId: "ev-live-1",
            claim: "Codali final answers should be synthesized from curated evidence.",
            sourceType: "live_smoke_fixture",
          },
        ],
        missingInformation: [],
        contradictions: [],
      }),
      "Answer the question: What is the final-answer rule?",
    ].join("\n");
  }
  return [
    ...common,
    "Generate or simulate a tiny image artifact reference for a smoke test.",
    "Return only valid JSON shaped as:",
    "{\"status\":\"ok\",\"artifact\":{\"kind\":\"image\",\"uri\":\"<artifact uri or reference>\",\"mime_type\":\"image/png\",\"description\":\"<short description>\"}}",
    "Prompt: simple product-neutral icon of a search gateway.",
  ].join("\n");
};

const parseJsonFromText = (text: string): unknown | undefined => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }
  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
};

const parseAgentRunOutput = (stdout: string): {
  output: string;
  adapter?: string;
  model?: string;
  metadata?: Record<string, unknown>;
} => {
  const parsed = JSON.parse(stdout) as unknown;
  const record = asRecord(parsed);
  const responses = Array.isArray(record?.responses) ? record.responses : [];
  const response = asRecord(responses[0]);
  const output = readString(response, ["output"]);
  if (!output) {
    throw new Error("mcoda agent-run response did not include output");
  }
  return {
    output,
    adapter: readString(response, ["adapter"]),
    model: readString(response, ["model"]),
    metadata: asRecord(response?.metadata),
  };
};

const extractCalledTools = (value: unknown): string[] => {
  const record = asRecord(value);
  if (!record) return [];
  return unique([
    ...stringArray(record.called_tools),
    ...stringArray(record.calledTools),
    ...stringArray(record.selected_tools),
    ...stringArray(record.selectedTools),
  ]);
};

const extractToolCallCount = (value: unknown): number | undefined => {
  const record = asRecord(value);
  const explicit = readNumber(record, ["tool_call_count", "toolCallCount"]);
  if (explicit !== undefined) return explicit;
  const tools = extractCalledTools(value);
  return tools.length > 0 ? tools.length : undefined;
};

const normalizeArtifact = (value: unknown): CodaliGatewayLiveScenarioArtifact | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const artifact =
    asRecord(record.artifact) ??
    asRecord(record.image) ??
    (Array.isArray(record.artifacts) ? asRecord(record.artifacts[0]) : undefined);
  if (!artifact) return undefined;
  const uri = readString(artifact, ["uri", "url", "path", "artifactRef", "artifact_ref"]);
  const id = readString(artifact, ["id", "artifactId", "artifact_id"]);
  if (!uri && !id) return undefined;
  const metadata = asRecord(redactCodaliGatewayLiveValue(artifact.metadata ?? {}));
  return {
    id,
    kind: readString(artifact, ["kind", "type"]) ?? "image",
    uri,
    mimeType: readString(artifact, ["mimeType", "mime_type", "contentType", "content_type"]),
    metadata,
  };
};

const summarizeAgentRunMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const cli = asRecord(metadata?.cli);
  const usage = asRecord(metadata?.usage);
  const localInference =
    asRecord(metadata?.localInference) ??
    asRecord(metadata?.local_inference);
  const queue = asRecord(metadata?.queue);
  const throughput = asRecord(metadata?.throughput);
  const output: Record<string, unknown> = {};
  const mode = readString(metadata, ["mode"]);
  const adapterType = readString(metadata, ["adapterType", "adapter_type"]);
  const authMode = readString(metadata, ["authMode", "auth_mode"]);
  const cliVersion = readString(cli, ["version"]);
  const costUsd = readNumber(metadata, [
    "costUsd",
    "cost_usd",
    "estimatedCostUsd",
    "estimated_cost_usd",
  ]);
  if (mode) output.mode = mode;
  if (adapterType) output.adapterType = adapterType;
  if (authMode) output.authMode = authMode;
  if (cliVersion) output.cli = { version: cliVersion };
  if (costUsd !== undefined) output.costUsd = costUsd;
  if (usage) output.usage = redactCodaliGatewayLiveValue(usage);
  if (queue) output.queue = redactCodaliGatewayLiveValue(queue);
  if (throughput) output.throughput = redactCodaliGatewayLiveValue(throughput);
  if (localInference) {
    output.localInference = redactCodaliGatewayLiveValue(localInference);
  }
  return output;
};

const outputPreview = (text: string): string => {
  const redacted = String(redactCodaliGatewayLiveValue(text));
  return redacted.length > 320 ? `${redacted.slice(0, 317)}...` : redacted;
};

const classifyAgentRunCommandFailure = (
  result: CodaliGatewayLiveCommandResult,
): Pick<CodaliGatewayLiveScenarioResult, "status" | "warnings" | "errors" | "metadata"> => {
  const failureText = `${result.stderr}\n${result.stdout}`;
  const normalized = failureText.toLowerCase();
  const knownCatalogMismatch =
    normalized.includes("not a valid model id") ||
    normalized.includes("invalid model id") ||
    normalized.includes("model_not_found") ||
    normalized.includes("model not found");
  const upstreamUnavailable =
    normalized.includes("mswarm_error") ||
    normalized.includes("upstream_error") ||
    normalized.includes("self-hosted node is not currently reachable") ||
    normalized.includes("self hosted node is not currently reachable") ||
    normalized.includes("node is not currently reachable") ||
    normalized.includes("connection_error") ||
    normalized.includes("econnrefused") ||
    normalized.includes("fetch failed");
  const degradedFailureClass = knownCatalogMismatch
    ? "agent_run_model_catalog_mismatch"
    : upstreamUnavailable
      ? "agent_run_upstream_unavailable"
      : undefined;
  const status: CodaliGatewayLiveScenarioStatus = degradedFailureClass
    ? "degraded"
    : "failed";
  return {
    status,
    warnings: degradedFailureClass
      ? [degradedFailureClass]
      : [],
    errors: [
      `agent_run_exit_${result.exitCode}`,
      outputPreview(result.stderr || result.stdout),
    ],
    metadata: {
      runner: "mcoda_agent_run",
      exitCode: result.exitCode,
      failureClass: degradedFailureClass ?? "agent_run_command_failed",
    },
  };
};

export const createMcodaAgentRunScenarioRunner = (): CodaliGatewayLiveScenarioRunner =>
  async (input) => {
    const started = Date.now();
    const assignment = input.assignment;
    if (!assignment) {
      return {
        id: input.scenario.id,
        label: input.scenario.label,
        status: "skipped",
        role: input.scenario.role,
        latencyMs: 0,
        warnings: [],
        errors: [`missing_role:${input.scenario.role}`],
      };
    }
    const args = ["agent-run", assignment.candidate.slug, "--json", "--stdin"];
    if (input.forceAgentRun) args.push("--force");
    const prompt = promptForScenario(input.scenario, assignment);
    try {
      const result = await input.commandRunner(input.command, args, {
        input: prompt,
        timeoutMs: input.timeoutMs,
      });
      if (result.exitCode !== 0) {
        const failure = classifyAgentRunCommandFailure(result);
        return {
          id: input.scenario.id,
          label: input.scenario.label,
          status: failure.status,
          role: input.scenario.role,
          agentSlug: assignment.candidate.slug,
          tier: assignment.candidate.tier,
          model: assignment.candidate.model,
          adapter: assignment.candidate.adapter,
          latencyMs: result.latencyMs,
          warnings: failure.warnings,
          errors: failure.errors,
          metadata: failure.metadata,
        };
      }
      const parsed = parseAgentRunOutput(result.stdout);
      const json = parseJsonFromText(parsed.output);
      const jsonValid = input.scenario.expectsJson ? json !== undefined : undefined;
      const artifact = input.scenario.expectsArtifact ? normalizeArtifact(json) : undefined;
      const calledTools = extractCalledTools(json);
      const warnings = input.scenario.requiresGatewayToolTelemetry
        ? ["gateway_tool_telemetry_unavailable_with_agent_run"]
        : [];
      const errors: string[] = [];
      if (input.scenario.expectsJson && !jsonValid) {
        errors.push("invalid_json_output");
      }
      if (input.scenario.expectsArtifact && !artifact) {
        warnings.push("image_artifact_reference_missing");
      }
      const status: CodaliGatewayLiveScenarioStatus =
        errors.length > 0
          ? "failed"
          : input.scenario.requiresGatewayToolTelemetry || (input.scenario.expectsArtifact && !artifact)
            ? "degraded"
            : "passed";
      return {
        id: input.scenario.id,
        label: input.scenario.label,
        status,
        role: input.scenario.role,
        agentSlug: assignment.candidate.slug,
        tier: assignment.candidate.tier,
        model: parsed.model ?? assignment.candidate.model,
        adapter: parsed.adapter ?? assignment.candidate.adapter,
        latencyMs: result.latencyMs || Date.now() - started,
        jsonValid,
        toolCallCount: extractToolCallCount(json),
        calledTools,
        finalAnswerStatus:
          input.scenario.id === "final_answer_large_model" && parsed.output.trim()
            ? "succeeded"
            : undefined,
        finalModelTier:
          input.scenario.id === "final_answer_large_model"
            ? assignment.candidate.tier
            : undefined,
        finalModelAgentSlug:
          input.scenario.id === "final_answer_large_model"
            ? assignment.candidate.slug
            : undefined,
        artifact,
        outputPreview: outputPreview(parsed.output),
        warnings,
        errors,
        metadata: {
          runner: "mcoda_agent_run",
          responseMetadata: summarizeAgentRunMetadata(parsed.metadata),
        },
      };
    } catch (error) {
      return {
        id: input.scenario.id,
        label: input.scenario.label,
        status: "failed",
        role: input.scenario.role,
        agentSlug: assignment.candidate.slug,
        tier: assignment.candidate.tier,
        model: assignment.candidate.model,
        adapter: assignment.candidate.adapter,
        latencyMs: Date.now() - started,
        warnings: [],
        errors: [error instanceof Error ? error.message : String(error)],
        metadata: { runner: "mcoda_agent_run" },
      };
    }
  };

const discoverInventory = async (
  options: CodaliGatewayLiveHarnessOptions,
  commandRunner: CodaliGatewayLiveCommandRunner,
): Promise<{ discovery: CodaliGatewayLiveDiscoveryResult; inventory: unknown[] }> => {
  if (options.inventory) {
    return {
      discovery: {
        source: "provided",
        status: "succeeded",
        latencyMs: 0,
        inventoryCount: options.inventory.length,
        errors: [],
      },
      inventory: options.inventory,
    };
  }
  const command = options.inventoryCommand?.command ?? options.command ?? DEFAULT_MCODA_COMMAND;
  const args = options.inventoryCommand?.args ?? ["agent", "list", "--json", "--refresh-health"];
  const result = await commandRunner(command, args, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
  if (result.exitCode !== 0) {
    return {
      discovery: {
        source: "command",
        command,
        args,
        status: "failed",
        latencyMs: result.latencyMs,
        inventoryCount: 0,
        errors: [`inventory_command_exit_${result.exitCode}`, outputPreview(result.stderr)],
      },
      inventory: [],
    };
  }
  try {
    const inventory = parseCodaliGatewayLiveInventory(result.stdout);
    return {
      discovery: {
        source: "command",
        command,
        args,
        status: "succeeded",
        latencyMs: result.latencyMs,
        inventoryCount: inventory.length,
        errors: [],
      },
      inventory,
    };
  } catch (error) {
    return {
      discovery: {
        source: "command",
        command,
        args,
        status: "failed",
        latencyMs: result.latencyMs,
        inventoryCount: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      },
      inventory: [],
    };
  }
};

const summarizeHarness = (
  classification: CodaliGatewayLiveClassification,
  scenarios: CodaliGatewayLiveScenarioResult[],
): CodaliGatewayLiveHarnessResult["summary"] => {
  const failed = scenarios.filter((scenario) => scenario.status === "failed").length;
  const degraded = scenarios.filter((scenario) => scenario.status === "degraded").length;
  const skipped = scenarios.filter((scenario) => scenario.status === "skipped").length;
  const passed = scenarios.filter((scenario) => scenario.status === "passed").length;
  const missingRoles = Object.values(classification.roles)
    .filter((role) => role.status !== "assigned")
    .map((role) => role.role);
  const jsonValidAgents = unique(
    scenarios
      .filter((scenario) => scenario.jsonValid === true && scenario.agentSlug)
      .map((scenario) => scenario.agentSlug as string),
  );
  const largeFinalSynthesizerOk = scenarios.some((scenario) =>
    scenario.id === "final_answer_large_model" &&
    scenario.status === "passed" &&
    scenario.finalModelTier === "large");
  const imageArtifactOk = scenarios.some((scenario) =>
    scenario.id === "image_generation" &&
    scenario.status === "passed" &&
    Boolean(scenario.artifact));
  const status: CodaliGatewayLiveHarnessStatus =
    failed > 0
      ? "failed"
      : degraded > 0 || skipped > 0 || missingRoles.length > 0
        ? "degraded"
        : "passed";
  return {
    status,
    passed,
    failed,
    degraded,
    skipped,
    jsonValidAgents,
    largeFinalSynthesizerOk,
    imageArtifactOk,
    missingRoles,
  };
};

const assignmentForScenario = (
  classification: CodaliGatewayLiveClassification,
  scenario: CodaliGatewayLiveScenarioDefinition,
): CodaliGatewayAgentAssignment | undefined =>
  classification.assignments[scenario.role] ??
  classification.resolution.assignments[ROLE_TO_RESOLVER_ROLE[scenario.role]];

const redactScenario = (
  scenario: CodaliGatewayLiveScenarioResult,
): CodaliGatewayLiveScenarioResult =>
  redactCodaliGatewayLiveValue(scenario) as CodaliGatewayLiveScenarioResult;

const normalizeShadowComparisonPolicy = (
  policy?: CodaliGatewayShadowComparisonPolicy,
): CodaliGatewayShadowComparisonResult["policy"] => ({
  enabled: policy?.enabled === true,
  maxCandidatesPerScenario: Math.max(
    0,
    Math.min(5, Math.trunc(policy?.maxCandidatesPerScenario ?? 1)),
  ),
  includePrimary: policy?.includePrimary !== false,
  requireHealthy: policy?.requireHealthy !== false,
  roles: policy?.roles?.length
    ? unique(policy.roles) as CodaliGatewayLiveRoleKey[]
    : [...new Set(CODALI_GATEWAY_LIVE_SCENARIOS.map((scenario) => scenario.role))],
});

const buildRuntimeAgentInput = (
  candidate: CodaliGatewayAgentCandidate,
): CodaliGatewayAgentAssignment["agent"] => ({
  slug: candidate.slug,
  adapter: candidate.adapter,
  provider: candidate.provider,
  model: candidate.model,
  baseUrl: candidate.baseUrl,
  runnerKind: candidate.runnerKind as CodaliGatewayAgentAssignment["agent"]["runnerKind"],
  supportsTools: candidate.supportsTools,
  capabilities: candidate.capabilities,
  contextWindow: candidate.contextWindow,
  maxOutputTokens: candidate.maxOutputTokens,
});

const createComparisonAssignment = (params: {
  resolverRole: string;
  primary?: CodaliGatewayAgentAssignment;
  candidate: CodaliGatewayAgentCandidate;
  score?: number;
  reasons?: string[];
}): CodaliGatewayAgentAssignment => ({
  role: params.resolverRole,
  policy: params.primary?.policy ?? { tier: params.candidate.tier },
  candidate: params.candidate,
  agent: buildRuntimeAgentInput(params.candidate),
  score: params.score ?? 0,
  reasons: params.reasons ?? [],
});

const resolveShadowAssignmentsForScenario = (params: {
  classification: CodaliGatewayLiveClassification;
  scenario: CodaliGatewayLiveScenarioDefinition;
  primary?: CodaliGatewayAgentAssignment;
  policy: CodaliGatewayShadowComparisonResult["policy"];
}): CodaliGatewayAgentAssignment[] => {
  if (!params.policy.enabled || params.policy.maxCandidatesPerScenario <= 0) {
    return [];
  }
  if (!params.policy.roles.includes(params.scenario.role)) {
    return [];
  }
  const resolverRole = ROLE_TO_RESOLVER_ROLE[params.scenario.role];
  const primarySlug = params.primary?.candidate.slug;
  return params.classification.resolution.diagnostics
    .filter((diagnostic) =>
      diagnostic.role === resolverRole &&
      diagnostic.eligible &&
      diagnostic.slug !== primarySlug &&
      diagnostic.score !== undefined)
    .map((diagnostic) => {
      const candidate = params.classification.resolution.candidates.find(
        (entry) => entry.slug === diagnostic.slug,
      );
      if (!candidate) return undefined;
      if (params.policy.requireHealthy && candidate.healthStatus !== "healthy") {
        return undefined;
      }
      return createComparisonAssignment({
        resolverRole,
        primary: params.primary,
        candidate,
        score: diagnostic.score,
        reasons: diagnostic.reasons,
      });
    })
    .filter((assignment): assignment is CodaliGatewayAgentAssignment => Boolean(assignment))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return left.candidate.slug.localeCompare(right.candidate.slug);
    })
    .slice(0, params.policy.maxCandidatesPerScenario);
};

const metricRecords = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown>[] => {
  const responseMetadata = asRecord(metadata?.responseMetadata);
  const localInference =
    asRecord(metadata?.localInference) ??
    asRecord(metadata?.local_inference) ??
    asRecord(responseMetadata?.localInference) ??
    asRecord(responseMetadata?.local_inference);
  const usage =
    asRecord(metadata?.usage) ??
    asRecord(responseMetadata?.usage) ??
    asRecord(localInference?.usage);
  const queue =
    asRecord(metadata?.queue) ??
    asRecord(responseMetadata?.queue) ??
    asRecord(localInference?.queue);
  const throughput =
    asRecord(metadata?.throughput) ??
    asRecord(responseMetadata?.throughput) ??
    asRecord(localInference?.throughput);
  return [metadata, responseMetadata, localInference, usage, queue, throughput]
    .filter((record): record is Record<string, unknown> => Boolean(record));
};

const firstMetricNumber = (
  records: Record<string, unknown>[],
  keys: readonly string[],
): number | undefined => {
  for (const record of records) {
    const value = readNumber(record, keys);
    if (value !== undefined) return value;
  }
  return undefined;
};

const firstMetricString = (
  records: Record<string, unknown>[],
  keys: readonly string[],
): string | undefined => {
  for (const record of records) {
    const value = readString(record, keys);
    if (value) return value;
  }
  return undefined;
};

const extractTokenUse = (
  records: Record<string, unknown>[],
): CodaliGatewayModelComparisonTokenUse | undefined => {
  const inputTokens = firstMetricNumber(records, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = firstMetricNumber(records, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const totalTokens =
    firstMetricNumber(records, ["totalTokens", "total_tokens", "tokensUsed", "tokens_used"]) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
};

const extractQueueMetrics = (
  metadata: Record<string, unknown> | undefined,
): CodaliGatewayModelComparisonQueueMetrics | undefined => {
  const responseMetadata = asRecord(metadata?.responseMetadata);
  const localInference =
    asRecord(metadata?.localInference) ??
    asRecord(metadata?.local_inference) ??
    asRecord(responseMetadata?.localInference) ??
    asRecord(responseMetadata?.local_inference);
  const queue =
    asRecord(metadata?.queue) ??
    asRecord(responseMetadata?.queue) ??
    asRecord(localInference?.queue);
  const records = [queue, metadata, responseMetadata, localInference]
    .filter((record): record is Record<string, unknown> => Boolean(record));
  const waitMs = firstMetricNumber(records, [
    "waitMs",
    "wait_ms",
    "queueWaitMs",
    "queue_wait_ms",
    "queuedMs",
    "queued_ms",
  ]);
  const depth = firstMetricNumber(records, ["depth", "queueDepth", "queue_depth"]);
  const status = firstMetricString(records, ["status", "queueStatus", "queue_status"]);
  if (waitMs === undefined && depth === undefined && status === undefined) {
    return undefined;
  }
  return { waitMs, depth, status };
};

const extractThroughputMetrics = (params: {
  metadata?: Record<string, unknown>;
  tokenUse?: CodaliGatewayModelComparisonTokenUse;
  latencyMs?: number;
}): CodaliGatewayModelComparisonThroughputMetrics | undefined => {
  const responseMetadata = asRecord(params.metadata?.responseMetadata);
  const localInference =
    asRecord(params.metadata?.localInference) ??
    asRecord(params.metadata?.local_inference) ??
    asRecord(responseMetadata?.localInference) ??
    asRecord(responseMetadata?.local_inference);
  const throughput =
    asRecord(params.metadata?.throughput) ??
    asRecord(responseMetadata?.throughput) ??
    asRecord(localInference?.throughput);
  const records = [throughput, params.metadata, responseMetadata, localInference]
    .filter((record): record is Record<string, unknown> => Boolean(record));
  const explicitTokensPerSecond = firstMetricNumber(records, [
    "tokensPerSecond",
    "tokens_per_second",
    "outputTokensPerSecond",
    "output_tokens_per_second",
  ]);
  const tokensPerSecond =
    explicitTokensPerSecond ??
    (params.tokenUse?.outputTokens !== undefined && params.latencyMs && params.latencyMs > 0
      ? params.tokenUse.outputTokens / (params.latencyMs / 1_000)
      : undefined);
  const requestsPerMinute = firstMetricNumber(records, [
    "requestsPerMinute",
    "requests_per_minute",
    "requestPerMinute",
    "request_per_minute",
  ]);
  if (tokensPerSecond === undefined && requestsPerMinute === undefined) {
    return undefined;
  }
  return { tokensPerSecond, requestsPerMinute };
};

const extractLocalInferenceMetrics = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const responseMetadata = asRecord(metadata?.responseMetadata);
  const localInference =
    asRecord(metadata?.localInference) ??
    asRecord(metadata?.local_inference) ??
    asRecord(responseMetadata?.localInference) ??
    asRecord(responseMetadata?.local_inference);
  return localInference
    ? asRecord(redactCodaliGatewayLiveValue(localInference))
    : undefined;
};

const qualityScore = (scenario: CodaliGatewayLiveScenarioResult): number => {
  if (scenario.status === "passed") return 1;
  if (scenario.status === "degraded") return 0.5;
  return 0;
};

const comparisonMetrics = (
  scenario: CodaliGatewayLiveScenarioResult,
  assignment?: CodaliGatewayAgentAssignment,
): CodaliGatewayModelComparisonMetrics => {
  const records = metricRecords(scenario.metadata);
  const tokenUse = extractTokenUse(records);
  const costUsd =
    firstMetricNumber(records, ["costUsd", "cost_usd", "estimatedCostUsd", "estimated_cost_usd"]) ??
    (assignment?.candidate.costPerMillion !== undefined && tokenUse?.totalTokens !== undefined
      ? (assignment.candidate.costPerMillion * tokenUse.totalTokens) / 1_000_000
      : undefined);
  const queue = extractQueueMetrics(scenario.metadata);
  const throughput = extractThroughputMetrics({
    metadata: scenario.metadata,
    tokenUse,
    latencyMs: scenario.latencyMs,
  });
  const failureStatus =
    scenario.status === "passed"
      ? "none"
      : scenario.status;
  return {
    quality: {
      status: scenario.status,
      score: qualityScore(scenario),
      jsonValid: scenario.jsonValid,
      toolCallCount: scenario.toolCallCount,
      artifactPresent: scenario.artifact !== undefined,
      finalAnswerSucceeded: scenario.finalAnswerStatus === "succeeded",
    },
    latencyMs: scenario.latencyMs,
    costUsd,
    tokenUse,
    queue,
    throughput,
    failure: {
      status: failureStatus,
      reasons: failureStatus === "none"
        ? []
        : unique([...scenario.errors, ...scenario.warnings]),
    },
    localInference: extractLocalInferenceMetrics(scenario.metadata),
  };
};

const comparisonRecord = (params: {
  scenario: CodaliGatewayLiveScenarioDefinition;
  result: CodaliGatewayLiveScenarioResult;
  assignment?: CodaliGatewayAgentAssignment;
  primary: boolean;
  candidateRank?: number;
}): CodaliGatewayModelComparisonRecord => {
  const candidate = params.assignment?.candidate;
  const agentSlug = candidate?.slug ?? params.result.agentSlug;
  const comparisonRole = params.primary ? "primary" : "shadow";
  return {
    id: `${params.scenario.id}:${comparisonRole}:${agentSlug ?? "unassigned"}`,
    scenarioId: params.scenario.id,
    role: params.scenario.role,
    resolverRole: ROLE_TO_RESOLVER_ROLE[params.scenario.role],
    comparisonRole,
    primary: params.primary,
    candidateRank: params.candidateRank,
    agentSlug,
    tier: candidate?.tier ?? params.result.tier,
    model: params.result.model ?? candidate?.model,
    adapter: params.result.adapter ?? candidate?.adapter,
    source: candidate?.source,
    healthStatus: candidate?.healthStatus,
    capabilities: candidate?.capabilities,
    resultStatus: params.result.status,
    selectedByPolicy: true,
    metrics: comparisonMetrics(params.result, params.assignment),
    warnings: params.result.warnings,
    errors: params.result.errors,
    metadata: params.result.metadata,
  };
};

const warningForRoleError = (
  role: CodaliGatewayLiveRoleKey,
  error: CodaliGatewayAgentTierError,
): CodaliGatewayLiveEnvironmentWarning => ({
  code: "GATEWAY_LIVE_ROLE_UNAVAILABLE",
  message: `No eligible inventory candidate found for live role ${role} (${error.role ?? ROLE_TO_RESOLVER_ROLE[role]}).`,
  reason: error.code,
  role,
  resolverRole: error.role,
  details: error.details,
});

const buildEnvironmentWarnings = (params: {
  discovery: CodaliGatewayLiveDiscoveryResult;
  classification: CodaliGatewayLiveClassification;
}): CodaliGatewayLiveEnvironmentWarning[] => {
  const warnings: CodaliGatewayLiveEnvironmentWarning[] = [];
  if (params.discovery.status === "failed") {
    warnings.push({
      code: "GATEWAY_LIVE_INVENTORY_DISCOVERY_FAILED",
      message: "Agent inventory discovery failed before live model validation.",
      reason: params.discovery.errors.join("; ") || "inventory_command_failed",
      details: {
        command: params.discovery.command,
        args: params.discovery.args,
      },
    });
  }
  for (const [role, summary] of Object.entries(params.classification.roles) as Array<
    [CodaliGatewayLiveRoleKey, CodaliGatewayLiveRoleSummary]
  >) {
    if (summary.status !== "assigned") {
      const matchingError = params.classification.errors.find(
        (error) => error.role === summary.resolverRole,
      );
      warnings.push(warningForRoleError(role, matchingError ?? {
        code: summary.errorCodes[0] ?? "GATEWAY_AGENT_ROLE_UNRESOLVED",
        message: `No eligible agent candidate found for role ${summary.resolverRole}.`,
        role: summary.resolverRole,
      }));
      continue;
    }
    const assignment = params.classification.assignments[role];
    const healthStatus = assignment?.candidate.healthStatus;
    if (assignment && healthStatus !== "healthy") {
      warnings.push({
        code: "GATEWAY_LIVE_AGENT_HEALTH_DEGRADED",
        message: `Assigned inventory candidate ${assignment.candidate.slug} for live role ${role} is ${healthStatus}.`,
        reason: `health_${healthStatus}`,
        role,
        resolverRole: summary.resolverRole,
        agentSlug: assignment.candidate.slug,
        healthStatus,
      });
    }
  }
  return warnings;
};

const buildScenarioEnvironmentWarnings = (
  scenarios: CodaliGatewayLiveScenarioResult[],
): CodaliGatewayLiveEnvironmentWarning[] =>
  scenarios.flatMap((scenario) =>
    scenario.warnings
      .filter((warning) =>
        warning === "agent_run_model_catalog_mismatch" ||
        warning === "agent_run_upstream_unavailable")
      .map((warning) => ({
        code: "GATEWAY_LIVE_AGENT_RUN_DEGRADED",
        message: `Live agent-run for scenario ${scenario.id} degraded due to an environment/runtime condition.`,
        reason: warning,
        role: scenario.role,
        resolverRole: ROLE_TO_RESOLVER_ROLE[scenario.role],
        agentSlug: scenario.agentSlug,
        details: {
          scenarioId: scenario.id,
          status: scenario.status,
          errors: scenario.errors,
        },
      })));

export const runCodaliGatewayLiveHarness = async (
  options: CodaliGatewayLiveHarnessOptions = {},
): Promise<CodaliGatewayLiveHarnessResult> => {
  const startedMs = Date.now();
  const startedAt = isoNow();
  const runId = options.runId ?? `codali-gateway-live-${randomUUID()}`;
  const commandRunner = options.commandRunner ?? defaultCodaliGatewayLiveCommandRunner;
  const { discovery, inventory } = await discoverInventory(options, commandRunner);
  const classification = classifyCodaliGatewayLiveAgents({
    inventory,
    allowCloudFallback: options.allowCloudFallback,
    allowImageWorker: options.allowImageWorker ?? true,
    agentPolicy: options.agentPolicy,
  });
  const environmentWarnings = buildEnvironmentWarnings({ discovery, classification });
  const shadowPolicy = normalizeShadowComparisonPolicy(options.shadowComparison);
  const shadowRecords: CodaliGatewayModelComparisonRecord[] = [];
  const shadowEnvironmentWarnings: CodaliGatewayLiveEnvironmentWarning[] = [];
  const scenarioRunner = options.scenarioRunner ?? createMcodaAgentRunScenarioRunner();
  const scenarios = options.scenarios?.length
    ? options.scenarios.map(scenarioById)
    : CODALI_GATEWAY_LIVE_SCENARIOS;
  const scenarioResults: CodaliGatewayLiveScenarioResult[] = [];
  for (const scenario of scenarios) {
    const primaryAssignment = assignmentForScenario(classification, scenario);
    const result = await scenarioRunner({
      runId,
      scenario,
      assignment: primaryAssignment,
      classification,
      commandRunner,
      command: options.command ?? DEFAULT_MCODA_COMMAND,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      forceAgentRun: options.forceAgentRun === true,
    });
    const redactedResult = redactScenario(result);
    scenarioResults.push(redactedResult);
    if (!shadowPolicy.enabled) {
      continue;
    }
    if (shadowPolicy.includePrimary) {
      shadowRecords.push(comparisonRecord({
        scenario,
        result: redactedResult,
        assignment: primaryAssignment,
        primary: true,
        candidateRank: 0,
      }));
    }
    const shadowAssignments = resolveShadowAssignmentsForScenario({
      classification,
      scenario,
      primary: primaryAssignment,
      policy: shadowPolicy,
    });
    if (shadowAssignments.length === 0) {
      shadowEnvironmentWarnings.push({
        code: "GATEWAY_SHADOW_COMPARISON_CANDIDATE_UNAVAILABLE",
        message: `No eligible shadow comparison candidate found for live role ${scenario.role}.`,
        reason: shadowPolicy.requireHealthy
          ? "no_healthy_alternate_candidate"
          : "no_alternate_candidate",
        role: scenario.role,
        resolverRole: ROLE_TO_RESOLVER_ROLE[scenario.role],
      });
    }
    for (const [candidateIndex, shadowAssignment] of shadowAssignments.entries()) {
      const shadowResult = await scenarioRunner({
        runId,
        scenario,
        assignment: shadowAssignment,
        classification,
        commandRunner,
        command: options.command ?? DEFAULT_MCODA_COMMAND,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        forceAgentRun: options.forceAgentRun === true,
      });
      shadowRecords.push(comparisonRecord({
        scenario,
        result: redactScenario(shadowResult),
        assignment: shadowAssignment,
        primary: false,
        candidateRank: candidateIndex + 1,
      }));
    }
  }
  const endedAt = isoNow();
  const summary = summarizeHarness(classification, scenarioResults);
  const scenarioEnvironmentWarnings = buildScenarioEnvironmentWarnings(scenarioResults);
  const allEnvironmentWarnings = [
    ...environmentWarnings,
    ...scenarioEnvironmentWarnings,
  ];
  const shadowComparison: CodaliGatewayShadowComparisonResult = {
    policy: shadowPolicy,
    status: !shadowPolicy.enabled
      ? "disabled"
      : shadowRecords.length > 0
        ? "compared"
        : "skipped",
    records: shadowRecords,
    environmentWarnings: shadowEnvironmentWarnings,
  };
  const warnings = unique([
    ...classification.warnings.map((warning) => warning.code),
    ...scenarioResults.flatMap((scenario) => scenario.warnings),
    ...allEnvironmentWarnings.map((warning) => warning.code),
    ...shadowEnvironmentWarnings.map((warning) => warning.code),
  ]);
  const errors = unique([
    ...discovery.errors,
    ...classification.errors.map((error) => error.code),
    ...scenarioResults.flatMap((scenario) => scenario.errors),
  ]);
  return {
    schemaVersion: 1,
    runId,
    runtime: "codali_gateway_live_harness",
    mode: "live",
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    discovery,
    classification: redactCodaliGatewayLiveValue(classification) as CodaliGatewayLiveClassification,
    scenarios: scenarioResults,
    shadowComparison: redactCodaliGatewayLiveValue(shadowComparison) as CodaliGatewayShadowComparisonResult,
    environmentWarnings: redactCodaliGatewayLiveValue(allEnvironmentWarnings) as CodaliGatewayLiveEnvironmentWarning[],
    summary,
    warnings,
    errors,
  };
};

export const formatCodaliGatewayLiveHarnessTextReport = (
  result: CodaliGatewayLiveHarnessResult,
): string => {
  const roleLines = Object.values(result.classification.roles).map((role) => {
    const agent = role.agentSlug
      ? `${role.agentSlug} (${role.tier ?? "unknown"})`
      : `unavailable${role.errorCodes.length ? `: ${role.errorCodes.join(",")}` : ""}`;
    return `Role ${role.role}: ${agent}`;
  });
  const scenarioLines = result.scenarios.map((scenario) => {
    const agent = scenario.agentSlug ? ` via ${scenario.agentSlug}` : "";
    const details = [
      scenario.jsonValid === undefined ? undefined : `json=${scenario.jsonValid ? "valid" : "invalid"}`,
      scenario.toolCallCount === undefined ? undefined : `tools=${scenario.toolCallCount}`,
      scenario.artifact ? "artifact=yes" : undefined,
      scenario.finalModelTier ? `final=${scenario.finalModelTier}` : undefined,
    ].filter(Boolean).join(", ");
    return `Scenario ${scenario.id}: ${scenario.status}${agent}${details ? ` (${details})` : ""}`;
  });
  return [
    `Codali gateway live smoke: ${result.summary.status}`,
    `Run: ${result.runId}`,
    `Inventory: ${result.discovery.inventoryCount} records (${result.discovery.status}, ${result.discovery.latencyMs}ms)`,
    ...roleLines,
    ...scenarioLines,
    `JSON-capable agents: ${result.summary.jsonValidAgents.length ? result.summary.jsonValidAgents.join(", ") : "none"}`,
    `Large final synthesizer: ${result.summary.largeFinalSynthesizerOk ? "ok" : "missing or not proven"}`,
    `Image artifact: ${result.summary.imageArtifactOk ? "ok" : "missing or not proven"}`,
    `Shadow comparison: ${result.shadowComparison.status} (${result.shadowComparison.records.length} records)`,
    result.environmentWarnings.length
      ? `Environment warnings: ${result.environmentWarnings.map((warning) => `${warning.code}:${warning.reason}`).join(", ")}`
      : "Environment warnings: none",
    result.warnings.length ? `Warnings: ${result.warnings.join(", ")}` : "Warnings: none",
    result.errors.length ? `Errors: ${result.errors.join(", ")}` : "Errors: none",
  ].join("\n");
};
