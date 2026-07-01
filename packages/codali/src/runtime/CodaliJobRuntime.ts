import { randomUUID } from "node:crypto";
import {
  runCodaliTask,
  type CodaliRuntimeAgentInput,
  type CodaliRuntimeEvent,
  type CodaliRuntimeInput,
  type CodaliRuntimePolicy,
  type CodaliRuntimeProviderInput,
  type CodaliRuntimeResult,
  type CodaliRuntimeTelemetry,
  type CodaliRuntimeToolManifest,
} from "./CodaliRuntime.js";
import type { ProviderMessage, ProviderUsage } from "../providers/ProviderTypes.js";

export type CodaliJobStageKind =
  | "router"
  | "planner"
  | "worker"
  | "adjudicator"
  | "synthesizer"
  | "verifier"
  | "repair"
  | (string & {});

export type CodaliJobStageStatus = "completed" | "failed" | "skipped";
export type CodaliJobStatus = "succeeded" | "failed" | "partial" | "needs_clarification";

export interface CodaliJobStageDefinition {
  id: string;
  kind: CodaliJobStageKind;
  role?: string;
  title?: string;
  goal?: string;
  prompt?: string;
  dependsOn?: string[];
  optional?: boolean;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  mode?: CodaliRuntimePolicy["mode"];
  agent?: CodaliRuntimeAgentInput;
  provider?: CodaliRuntimeProviderInput;
  response?: CodaliRuntimeInput["response"];
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CodaliJobBudgets {
  maxRuntimeMs?: number;
  maxToolCalls?: number;
  maxFollowups?: number;
  maxParallelStages?: number;
}

export interface CodaliJobAgentPolicy {
  defaultAgent?: CodaliRuntimeAgentInput;
  defaultProvider?: CodaliRuntimeProviderInput;
  stageAgents?: Record<string, CodaliRuntimeAgentInput>;
  stageProviders?: Record<string, CodaliRuntimeProviderInput>;
  preferSmallLocal?: boolean;
  allowCloudFallback?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CodaliJobResponsePolicy {
  format?: "text" | "json" | "json_schema";
  schema?: Record<string, unknown>;
  requireEvidence?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CodaliJobRequest {
  id?: string;
  jobType: string;
  input?: unknown;
  context?: Record<string, unknown>;
  tenant?: Record<string, unknown>;
  requester?: Record<string, unknown>;
  toolManifest?: CodaliRuntimeToolManifest;
  stages?: CodaliJobStageDefinition[];
  budgets?: CodaliJobBudgets;
  agentPolicy?: CodaliJobAgentPolicy;
  response?: CodaliJobResponsePolicy;
  metadata?: Record<string, unknown>;
}

export interface CodaliEvidenceCard {
  id?: string;
  stageId?: string;
  source?: string;
  title?: string;
  summary?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface CodaliVerifierResult {
  passed: boolean;
  summary?: string;
  issues?: string[];
  repairPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliJobRuntimeError {
  stageId?: string;
  code: string;
  message: string;
  retryable?: boolean;
}

export interface CodaliJobStageResult {
  id: string;
  kind: CodaliJobStageKind;
  status: CodaliJobStageStatus;
  attempt: number;
  output: string;
  parsedOutput?: Record<string, unknown>;
  usage?: ProviderUsage;
  messages: ProviderMessage[];
  toolCallsExecuted: number;
  touchedFiles: string[];
  warnings: string[];
  telemetry?: CodaliRuntimeTelemetry;
  evidence: CodaliEvidenceCard[];
  verifier?: CodaliVerifierResult;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  agentSlug?: string;
  model?: string;
  error?: CodaliJobRuntimeError;
  metadata?: Record<string, unknown>;
}

export type CodaliJobEvent =
  | { type: "job_start"; runId: string; jobId: string; jobType: string; at: string }
  | {
      type: "stage_start";
      runId: string;
      jobId: string;
      stageId: string;
      kind: CodaliJobStageKind;
      attempt: number;
      at: string;
    }
  | {
      type: "stage_result";
      runId: string;
      jobId: string;
      stageId: string;
      kind: CodaliJobStageKind;
      status: CodaliJobStageStatus;
      durationMs: number;
      toolCallsExecuted: number;
      at: string;
    }
  | {
      type: "stage_error";
      runId: string;
      jobId: string;
      stageId: string;
      kind: CodaliJobStageKind;
      code: string;
      message: string;
      at: string;
    }
  | {
      type: "runtime_event";
      runId: string;
      jobId: string;
      stageId: string;
      event: CodaliRuntimeEvent;
      at: string;
    }
  | {
      type: "job_result";
      runId: string;
      jobId: string;
      status: CodaliJobStatus;
      stageCount: number;
      toolCallsExecuted: number;
      at: string;
    };

export interface CodaliJobTelemetryStage {
  id: string;
  kind: CodaliJobStageKind;
  status: CodaliJobStageStatus;
  attempt: number;
  durationMs: number;
  toolCallsExecuted: number;
  agentSlug?: string;
  model?: string;
  errorCode?: string;
}

export interface CodaliJobTelemetry {
  runId: string;
  runtime: "codali";
  mode: "job";
  jobId: string;
  jobType: string;
  status: CodaliJobStatus;
  stageCount: number;
  toolCallCount: number;
  calledTools: string[];
  consideredTools: string[];
  warnings: string[];
  errors: CodaliJobRuntimeError[];
  stages: CodaliJobTelemetryStage[];
}

export interface CodaliJobRuntimeResult {
  output: string;
  status: CodaliJobStatus;
  runId: string;
  jobId: string;
  jobType: string;
  stages: CodaliJobStageResult[];
  evidence: CodaliEvidenceCard[];
  verifier?: CodaliVerifierResult;
  messages: ProviderMessage[];
  usage?: ProviderUsage;
  toolCallsExecuted: number;
  touchedFiles: string[];
  warnings: string[];
  errors: CodaliJobRuntimeError[];
  events: CodaliJobEvent[];
  telemetry: CodaliJobTelemetry;
  metadata?: Record<string, unknown>;
}

export type CodaliTaskRunner = (input: CodaliRuntimeInput) => Promise<CodaliRuntimeResult>;

export interface CodaliJobRuntimeInput {
  request: CodaliJobRequest;
  runtime: Omit<CodaliRuntimeInput, "task" | "messages" | "metadata" | "onEvent"> & {
    messages?: ProviderMessage[];
    metadata?: CodaliRuntimeInput["metadata"];
    onEvent?: CodaliRuntimeInput["onEvent"];
  };
  onEvent?: (event: CodaliJobEvent) => void | Promise<void>;
  runTask?: CodaliTaskRunner;
}

const DEFAULT_JOB_TYPE = "codali_job";
const DEFAULT_MAX_RUNTIME_MS = 3_600_000;
const DEFAULT_MAX_FOLLOWUPS = 1;
const DEFAULT_MAX_PARALLEL_STAGES = 2;

const DEFAULT_STAGES: CodaliJobStageDefinition[] = [
  {
    id: "router",
    kind: "router",
    goal: "Classify the request, identify the relevant tools, and decide whether clarification is needed.",
  },
  {
    id: "planner",
    kind: "planner",
    dependsOn: ["router"],
    goal: "Create a concise execution plan grounded in the available context and tool manifest.",
  },
  {
    id: "worker",
    kind: "worker",
    dependsOn: ["planner"],
    goal: "Answer the request or produce the requested artifact using only allowed read-only capabilities unless writes are explicitly enabled.",
  },
  {
    id: "adjudicator",
    kind: "adjudicator",
    dependsOn: ["worker"],
    goal: "Check whether the worker output follows the plan and policy.",
  },
  {
    id: "synthesizer",
    kind: "synthesizer",
    dependsOn: ["worker", "adjudicator"],
    goal: "Produce the final user-facing response from the prior stages.",
  },
  {
    id: "verifier",
    kind: "verifier",
    dependsOn: ["synthesizer"],
    goal: "Verify the final response. Return JSON with passed, summary, issues, and repairPrompt when possible.",
    response: { format: "json" },
  },
];

const nowIso = (): string => new Date().toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const cleanText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const normalizeDependsOn = (stage: CodaliJobStageDefinition): string[] => {
  const value =
    stage.dependsOn ??
    (stage as CodaliJobStageDefinition & { depends_on?: string[] }).depends_on ??
    [];
  return Array.isArray(value)
    ? value.map((entry) => cleanText(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
};

const normalizeStage = (stage: CodaliJobStageDefinition, index: number): CodaliJobStageDefinition => {
  const id = cleanText(stage.id) ?? `${stage.kind || "stage"}-${index + 1}`;
  const kind = cleanText(stage.kind) ?? "worker";
  return {
    ...stage,
    id: id.replace(/[^a-zA-Z0-9._-]+/g, "_"),
    kind,
    dependsOn: normalizeDependsOn(stage),
  };
};

const normalizeStages = (stages: CodaliJobStageDefinition[] | undefined): CodaliJobStageDefinition[] =>
  (stages?.length ? stages : DEFAULT_STAGES).map(normalizeStage);

const validateStageDag = (stages: CodaliJobStageDefinition[]): void => {
  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) {
      throw new Error(`Duplicate Codali job stage id: ${stage.id}`);
    }
    ids.add(stage.id);
  }
  for (const stage of stages) {
    for (const dependency of stage.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`Codali job stage ${stage.id} depends on unknown stage ${dependency}`);
      }
      if (dependency === stage.id) {
        throw new Error(`Codali job stage ${stage.id} depends on itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const visit = (stage: CodaliJobStageDefinition) => {
    if (visited.has(stage.id)) return;
    if (visiting.has(stage.id)) {
      throw new Error(`Codali job stage dependency cycle includes ${stage.id}`);
    }
    visiting.add(stage.id);
    for (const dependency of stage.dependsOn ?? []) {
      const dep = byId.get(dependency);
      if (dep) visit(dep);
    }
    visiting.delete(stage.id);
    visited.add(stage.id);
  };
  for (const stage of stages) visit(stage);
};

const describeUnknown = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const truncate = (value: string, max = 6000): string =>
  value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;

const formatPriorStageResults = (results: CodaliJobStageResult[]): string => {
  if (!results.length) return "None yet.";
  return results
    .map((result) => {
      const header = `${result.id} (${result.kind}, ${result.status})`;
      const error = result.error ? `\nError: ${result.error.code}: ${result.error.message}` : "";
      return `### ${header}\n${truncate(result.output || "", 2000)}${error}`;
    })
    .join("\n\n");
};

const buildStageTask = (input: {
  request: CodaliJobRequest;
  stage: CodaliJobStageDefinition;
  priorResults: CodaliJobStageResult[];
  evidence: CodaliEvidenceCard[];
  toolManifest?: CodaliRuntimeToolManifest;
  repairPrompt?: string;
}): string => {
  const { request, stage, priorResults, evidence, toolManifest, repairPrompt } = input;
  const lines = [
    "Codali multi-stage job runtime",
    `Job id: ${request.id ?? "unspecified"}`,
    `Job type: ${request.jobType || DEFAULT_JOB_TYPE}`,
    `Stage id: ${stage.id}`,
    `Stage kind: ${stage.kind}`,
    stage.role ? `Stage role: ${stage.role}` : "",
    stage.title ? `Stage title: ${stage.title}` : "",
    stage.goal ? `Stage goal: ${stage.goal}` : "",
    stage.prompt ? `Stage instructions:\n${stage.prompt}` : "",
    repairPrompt ? `Verifier repair request:\n${repairPrompt}` : "",
    "Original job input:",
    truncate(describeUnknown(request.input) || "(no explicit input)"),
    request.context ? `Job context:\n${truncate(describeUnknown(request.context))}` : "",
    request.tenant ? `Tenant scope:\n${truncate(describeUnknown(request.tenant), 2000)}` : "",
    toolManifest ? `Runtime tool manifest:\n${truncate(describeUnknown(toolManifest), 3000)}` : "",
    evidence.length ? `Evidence accumulated:\n${truncate(describeUnknown(evidence), 3000)}` : "",
    "Prior stage results:",
    formatPriorStageResults(priorResults),
    request.response?.requireEvidence
      ? "When making factual claims, include evidence cards in a JSON evidence array when the response format allows it."
      : "",
    "Stay within the active runtime policy and tenant/workspace scope.",
  ];
  return lines.filter(Boolean).join("\n\n");
};

const parseJsonLikeObject = (content: string): Record<string, unknown> | undefined => {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const tryParse = (value: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const exact = tryParse(body);
  if (exact) return exact;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return tryParse(body.slice(first, last + 1));
  }
  return undefined;
};

const normalizeEvidence = (
  stageId: string,
  parsed: Record<string, unknown> | undefined,
): CodaliEvidenceCard[] => {
  const raw = parsed?.evidence;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((entry, index) => ({
    id: cleanText(entry.id) ?? `${stageId}-evidence-${index + 1}`,
    stageId,
    source: cleanText(entry.source),
    title: cleanText(entry.title),
    summary: cleanText(entry.summary) ?? cleanText(entry.text) ?? cleanText(entry.content),
    confidence: typeof entry.confidence === "number" ? entry.confidence : undefined,
    metadata: isRecord(entry.metadata) ? entry.metadata : undefined,
  }));
};

const normalizeVerifier = (
  stage: CodaliJobStageDefinition,
  parsed: Record<string, unknown> | undefined,
): CodaliVerifierResult | undefined => {
  if (stage.kind !== "verifier" && parsed?.passed === undefined) return undefined;
  const issues = Array.isArray(parsed?.issues)
    ? parsed.issues.map((issue) => cleanText(issue)).filter((issue): issue is string => Boolean(issue))
    : undefined;
  return {
    passed: parsed?.passed === true,
    summary: cleanText(parsed?.summary) ?? cleanText(parsed?.message),
    issues,
    repairPrompt: cleanText(parsed?.repairPrompt) ?? cleanText(parsed?.repair_prompt),
    metadata: isRecord(parsed?.metadata) ? parsed.metadata : undefined,
  };
};

const needsClarification = (parsed: Record<string, unknown> | undefined): boolean =>
  parsed?.status === "needs_clarification" ||
  parsed?.needsClarification === true ||
  parsed?.needs_clarification === true ||
  typeof parsed?.clarifyingQuestion === "string" ||
  typeof parsed?.clarifying_question === "string";

const mergeUsage = (left: ProviderUsage | undefined, right: ProviderUsage | undefined): ProviderUsage | undefined => {
  if (!right) return left;
  const inputTokens = (left?.inputTokens ?? 0) + (right.inputTokens ?? 0);
  const outputTokens = (left?.outputTokens ?? 0) + (right.outputTokens ?? 0);
  const totalTokens = (left?.totalTokens ?? 0) + (right.totalTokens ?? right.inputTokens ?? 0) + (right.outputTokens ?? 0);
  return { inputTokens, outputTokens, totalTokens };
};

const mergeUnique = (values: string[][]): string[] => Array.from(new Set(values.flat().filter(Boolean)));

const resolveStageAgent = (
  request: CodaliJobRequest,
  runtime: CodaliJobRuntimeInput["runtime"],
  stage: CodaliJobStageDefinition,
): CodaliRuntimeAgentInput | undefined =>
  stage.agent ??
  request.agentPolicy?.stageAgents?.[stage.id] ??
  (stage.role ? request.agentPolicy?.stageAgents?.[stage.role] : undefined) ??
  request.agentPolicy?.stageAgents?.[stage.kind] ??
  request.agentPolicy?.defaultAgent ??
  runtime.agent;

const resolveStageProvider = (
  request: CodaliJobRequest,
  runtime: CodaliJobRuntimeInput["runtime"],
  stage: CodaliJobStageDefinition,
): CodaliRuntimeProviderInput =>
  stage.provider ??
  request.agentPolicy?.stageProviders?.[stage.id] ??
  (stage.role ? request.agentPolicy?.stageProviders?.[stage.role] : undefined) ??
  request.agentPolicy?.stageProviders?.[stage.kind] ??
  request.agentPolicy?.defaultProvider ??
  runtime.provider;

const responseForStage = (
  request: CodaliJobRequest,
  runtime: CodaliJobRuntimeInput["runtime"],
  stage: CodaliJobStageDefinition,
): CodaliRuntimeInput["response"] | undefined => {
  if (stage.response) return stage.response;
  if (stage.outputSchema) return { format: "json_schema", schema: stage.outputSchema };
  if (request.response?.format === "json_schema") {
    return { format: "json_schema", schema: request.response.schema };
  }
  if (request.response?.format === "json") return { format: "json" };
  return runtime.response;
};

const runWithLimit = async <T, R>(
  items: T[],
  maxParallel: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, maxParallel), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
};

const errorStageResult = (input: {
  stage: CodaliJobStageDefinition;
  attempt: number;
  startedAt: string;
  error: CodaliJobRuntimeError;
  agentSlug?: string;
  model?: string;
}): CodaliJobStageResult => {
  const ended = Date.now();
  const started = Date.parse(input.startedAt);
  return {
    id: input.stage.id,
    kind: input.stage.kind,
    status: "failed",
    attempt: input.attempt,
    output: "",
    messages: [],
    toolCallsExecuted: 0,
    touchedFiles: [],
    warnings: [],
    evidence: [],
    startedAt: input.startedAt,
    endedAt: new Date(ended).toISOString(),
    durationMs: Number.isFinite(started) ? ended - started : 0,
    agentSlug: input.agentSlug,
    model: input.model,
    error: input.error,
  };
};

const buildTelemetry = (input: {
  runId: string;
  jobId: string;
  jobType: string;
  status: CodaliJobStatus;
  stages: CodaliJobStageResult[];
  warnings: string[];
  errors: CodaliJobRuntimeError[];
}): CodaliJobTelemetry => ({
  runId: input.runId,
  runtime: "codali",
  mode: "job",
  jobId: input.jobId,
  jobType: input.jobType,
  status: input.status,
  stageCount: input.stages.length,
  toolCallCount: input.stages.reduce((sum, stage) => sum + stage.toolCallsExecuted, 0),
  calledTools: mergeUnique(input.stages.map((stage) => stage.telemetry?.calledTools ?? [])),
  consideredTools: mergeUnique(input.stages.map((stage) => stage.telemetry?.consideredTools ?? [])),
  warnings: input.warnings,
  errors: input.errors,
  stages: input.stages.map((stage) => ({
    id: stage.id,
    kind: stage.kind,
    status: stage.status,
    attempt: stage.attempt,
    durationMs: stage.durationMs,
    toolCallsExecuted: stage.toolCallsExecuted,
    agentSlug: stage.agentSlug,
    model: stage.model,
    errorCode: stage.error?.code,
  })),
});

const pickFinalOutput = (stages: CodaliJobStageResult[]): string => {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const stage = stages[index]!;
    if ((stage.kind === "repair" || stage.kind === "synthesizer") && stage.status === "completed" && stage.output) {
      return stage.output;
    }
  }
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const stage = stages[index]!;
    if (stage.status === "completed" && stage.output) {
      return stage.output;
    }
  }
  return "";
};

export const runCodaliJob = async (input: CodaliJobRuntimeInput): Promise<CodaliJobRuntimeResult> => {
  const jobId = input.request.id ?? input.runtime.metadata?.jobId ?? randomUUID();
  const jobType = input.request.jobType || DEFAULT_JOB_TYPE;
  const runId = input.runtime.metadata?.requestId ?? jobId;
  const runTask = input.runTask ?? runCodaliTask;
  const stages = normalizeStages(input.request.stages);
  validateStageDag(stages);

  const warnings: string[] = [];
  const errors: CodaliJobRuntimeError[] = [];
  const events: CodaliJobEvent[] = [];
  const results: CodaliJobStageResult[] = [];
  const resultById = new Map<string, CodaliJobStageResult>();
  const started = Date.now();
  const maxRuntimeMs = input.request.budgets?.maxRuntimeMs ?? input.runtime.policy.timeoutMs ?? DEFAULT_MAX_RUNTIME_MS;
  const deadline = started + maxRuntimeMs;
  const maxParallel = input.request.budgets?.maxParallelStages ?? DEFAULT_MAX_PARALLEL_STAGES;
  let remainingToolCalls = input.request.budgets?.maxToolCalls ?? input.runtime.policy.maxToolCalls;
  let status: CodaliJobStatus = "succeeded";
  let usage: ProviderUsage | undefined;
  let stopped = false;

  const emit = async (event: CodaliJobEvent) => {
    events.push(event);
    await input.onEvent?.(event);
  };

  await emit({ type: "job_start", runId, jobId, jobType, at: nowIso() });

  const runStage = async (
    stage: CodaliJobStageDefinition,
    allocatedToolCalls: number,
    attempt: number,
    repairPrompt?: string,
  ): Promise<CodaliJobStageResult> => {
    const stageAgent = resolveStageAgent(input.request, input.runtime, stage);
    const stageProvider = resolveStageProvider(input.request, input.runtime, stage);
    const startedAt = nowIso();
    await emit({ type: "stage_start", runId, jobId, stageId: stage.id, kind: stage.kind, attempt, at: startedAt });

    if (Date.now() >= deadline) {
      const error = { stageId: stage.id, code: "job_timeout", message: "Codali job runtime budget expired." };
      await emit({ type: "stage_error", runId, jobId, kind: stage.kind, ...error, at: nowIso() });
      return errorStageResult({ stage, attempt, startedAt, error, agentSlug: stageAgent?.slug, model: stageProvider.model });
    }

    if (allocatedToolCalls < 0) {
      const error = { stageId: stage.id, code: "tool_budget_exhausted", message: "Codali job tool-call budget is exhausted." };
      await emit({ type: "stage_error", runId, jobId, kind: stage.kind, ...error, at: nowIso() });
      return errorStageResult({ stage, attempt, startedAt, error, agentSlug: stageAgent?.slug, model: stageProvider.model });
    }

    const priorResults = results.slice();
    const task = buildStageTask({
      request: input.request,
      stage,
      priorResults,
      evidence: results.flatMap((result) => result.evidence),
      toolManifest: input.request.toolManifest ?? input.runtime.docdex?.toolManifest,
      repairPrompt,
    });
    const timeoutMs = Math.max(
      0,
      Math.min(stage.timeoutMs ?? input.runtime.policy.timeoutMs, deadline - Date.now()),
    );
    const policy: CodaliRuntimePolicy = {
      ...input.runtime.policy,
      mode: stage.mode ?? input.runtime.policy.mode,
      maxSteps: stage.maxSteps ?? input.runtime.policy.maxSteps,
      maxToolCalls: Math.max(0, Math.min(stage.maxToolCalls ?? allocatedToolCalls, allocatedToolCalls)),
      timeoutMs,
    };
    try {
      const runtimeResult = await runTask({
        ...input.runtime,
        task,
        messages: input.runtime.messages,
        provider: stageProvider,
        agent: stageAgent,
        policy,
        response: responseForStage(input.request, input.runtime, stage),
        docdex: {
          ...input.runtime.docdex,
          toolManifest: input.request.toolManifest ?? input.runtime.docdex?.toolManifest,
        },
        metadata: {
          ...input.runtime.metadata,
          jobId,
          requestId: `${runId}:${stage.id}:attempt-${attempt}`,
          agentSlug: stageAgent?.slug ?? input.runtime.metadata?.agentSlug,
        },
        onEvent: async (event) => {
          await input.runtime.onEvent?.(event);
          await emit({ type: "runtime_event", runId, jobId, stageId: stage.id, event, at: nowIso() });
        },
      });
      const ended = Date.now();
      const parsedOutput = parseJsonLikeObject(runtimeResult.finalMessage);
      const evidence = normalizeEvidence(stage.id, parsedOutput);
      const verifier = normalizeVerifier(stage, parsedOutput);
      const stageWarnings = [...runtimeResult.warnings];
      if (runtimeResult.toolCallsExecuted > policy.maxToolCalls) {
        stageWarnings.push(
          `Stage ${stage.id} reported ${runtimeResult.toolCallsExecuted} tool calls, above allocated budget ${policy.maxToolCalls}.`,
        );
      }
      const stageResult: CodaliJobStageResult = {
        id: stage.id,
        kind: stage.kind,
        status: "completed",
        attempt,
        output: runtimeResult.finalMessage,
        parsedOutput,
        usage: runtimeResult.usage,
        messages: runtimeResult.messages,
        toolCallsExecuted: runtimeResult.toolCallsExecuted,
        touchedFiles: runtimeResult.touchedFiles,
        warnings: stageWarnings,
        telemetry: runtimeResult.telemetry,
        evidence,
        verifier,
        startedAt,
        endedAt: new Date(ended).toISOString(),
        durationMs: ended - Date.parse(startedAt),
        agentSlug: stageAgent?.slug,
        model: stageProvider.model,
        metadata: stage.metadata,
      };
      await emit({
        type: "stage_result",
        runId,
        jobId,
        stageId: stage.id,
        kind: stage.kind,
        status: stageResult.status,
        durationMs: stageResult.durationMs,
        toolCallsExecuted: stageResult.toolCallsExecuted,
        at: nowIso(),
      });
      return stageResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runtimeError = {
        stageId: stage.id,
        code: error instanceof Error ? error.name : "stage_error",
        message,
      };
      await emit({ type: "stage_error", runId, jobId, kind: stage.kind, ...runtimeError, at: nowIso() });
      return errorStageResult({
        stage,
        attempt,
        startedAt,
        error: runtimeError,
        agentSlug: stageAgent?.slug,
        model: stageProvider.model,
      });
    }
  };

  const pending = new Map(stages.map((stage) => [stage.id, stage]));
  while (pending.size && !stopped) {
    const ready = Array.from(pending.values()).filter((stage) =>
      (stage.dependsOn ?? []).every((dependency) => resultById.has(dependency)),
    );
    if (!ready.length) {
      throw new Error("Codali job stage scheduler stalled; dependency validation may be incomplete.");
    }
    const active = ready.slice(0, Math.max(1, maxParallel));
    const allocations = new Map<string, number>();
    const requested = active.map((stage) => Math.max(0, stage.maxToolCalls ?? remainingToolCalls));
    const requestedTotal = requested.reduce((sum, value) => sum + value, 0);
    if (requestedTotal <= remainingToolCalls) {
      active.forEach((stage, index) => allocations.set(stage.id, requested[index] ?? 0));
    } else {
      let rest = remainingToolCalls;
      active.forEach((stage, index) => {
        const slotsLeft = active.length - index;
        const fairShare = Math.floor(rest / slotsLeft);
        const allocation = Math.min(requested[index] ?? 0, fairShare);
        allocations.set(stage.id, allocation);
        rest -= allocation;
      });
    }

    const waveResults = await runWithLimit(active, maxParallel, async (stage) => {
      if (remainingToolCalls <= 0 && (stage.maxToolCalls ?? input.runtime.policy.maxToolCalls) > 0) {
        const startedAt = nowIso();
        const error = {
          stageId: stage.id,
          code: "tool_budget_exhausted",
          message: "Codali job tool-call budget is exhausted.",
        };
        return errorStageResult({ stage, attempt: 1, startedAt, error });
      }
      return runStage(stage, allocations.get(stage.id) ?? 0, 1);
    });

    for (const stageResult of waveResults) {
      pending.delete(stageResult.id);
      results.push(stageResult);
      resultById.set(stageResult.id, stageResult);
      usage = mergeUsage(usage, stageResult.usage);
      remainingToolCalls -= stageResult.toolCallsExecuted;
      warnings.push(...stageResult.warnings);
      if (stageResult.error) {
        errors.push(stageResult.error);
        const originalStage = stages.find((stage) => stage.id === stageResult.id);
        if (!originalStage?.optional) {
          status = "failed";
          stopped = true;
        } else {
          status = status === "succeeded" ? "partial" : status;
        }
      }
      if (needsClarification(stageResult.parsedOutput)) {
        status = "needs_clarification";
        stopped = true;
      }
    }
  }

  const verifier = results.find((stage) => stage.verifier)?.verifier;
  if (status === "succeeded" && verifier && !verifier.passed) {
    status = "partial";
    warnings.push(verifier.summary ?? "Verifier did not pass the synthesized result.");
    const maxFollowups = input.request.budgets?.maxFollowups ?? DEFAULT_MAX_FOLLOWUPS;
    if (maxFollowups > 0 && remainingToolCalls > 0) {
      const repairStage: CodaliJobStageDefinition = {
        id: "repair-1",
        kind: "repair",
        goal: "Repair the synthesized answer using the verifier feedback.",
        prompt: verifier.repairPrompt,
        dependsOn: [],
        maxToolCalls: remainingToolCalls,
      };
      const repairResult = await runStage(repairStage, remainingToolCalls, 1, verifier.repairPrompt);
      results.push(repairResult);
      usage = mergeUsage(usage, repairResult.usage);
      remainingToolCalls -= repairResult.toolCallsExecuted;
      warnings.push(...repairResult.warnings);
      if (repairResult.error) {
        errors.push(repairResult.error);
      }
    }
  }

  if (status !== "failed" && remainingToolCalls < 0) {
    status = "failed";
    errors.push({
      code: "tool_budget_exceeded",
      message: "Codali job exceeded its total tool-call budget.",
    });
  }

  const output = pickFinalOutput(results);
  const evidence = results.flatMap((stage) => stage.evidence);
  const messages = results.flatMap((stage) => stage.messages);
  const touchedFiles = mergeUnique(results.map((stage) => stage.touchedFiles));
  const toolCallsExecuted = results.reduce((sum, stage) => sum + stage.toolCallsExecuted, 0);
  const telemetry = buildTelemetry({ runId, jobId, jobType, status, stages: results, warnings, errors });

  await emit({
    type: "job_result",
    runId,
    jobId,
    status,
    stageCount: results.length,
    toolCallsExecuted,
    at: nowIso(),
  });

  return {
    output,
    status,
    runId,
    jobId,
    jobType,
    stages: results,
    evidence,
    verifier,
    messages,
    usage,
    toolCallsExecuted,
    touchedFiles,
    warnings,
    errors,
    events,
    telemetry,
    metadata: input.request.metadata,
  };
};
