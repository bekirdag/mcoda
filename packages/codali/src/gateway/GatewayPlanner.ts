import type {
  Provider,
  ProviderMessage,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import {
  validateCodaliGatewayPlannerOutput,
} from "./CodaliGatewaySchemas.js";
import type {
  CodaliGatewayClassifierOutput,
  CodaliGatewayPlannerOutput,
  CodaliGatewayRequest,
  CodaliGatewaySubquestion,
  CodaliGatewayValidationIssue,
  CodaliGatewayWorkerTask,
} from "./CodaliGatewayTypes.js";
import {
  compileCodaliGatewayPolicy,
  type GatewayPolicyCompilation,
} from "./GatewayPolicyCompiler.js";
import { CODALI_GATEWAY_SECURITY_PROMPT_HARDENING } from "./GatewaySecurityPolicy.js";

export interface CodaliGatewayPlannerToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface GatewayPlannerInput {
  request: CodaliGatewayRequest;
  policyCompilation?: GatewayPolicyCompilation;
  toolDescriptions?: Record<string, string | CodaliGatewayPlannerToolDescriptor>;
}

export interface CodaliGatewayPlanningResult {
  policyCompilation: GatewayPolicyCompilation;
  classifier: CodaliGatewayClassifierOutput;
  planner: CodaliGatewayPlannerOutput;
  warnings: string[];
  classifierRepairAttempts: number;
  plannerRepairAttempts: number;
  classifierRawContent: string;
  plannerRawContent: string;
}

export interface CodaliGatewayPlannerOptions {
  maxRepairAttempts?: number;
  maxTokens?: number;
  temperature?: number;
}

export class CodaliGatewayPlannerError extends Error {
  readonly code: string;
  readonly issues?: CodaliGatewayValidationIssue[];

  constructor(code: string, message: string, issues?: CodaliGatewayValidationIssue[]) {
    super(`${code}: ${message}`);
    this.name = "CodaliGatewayPlannerError";
    this.code = code;
    this.issues = issues;
  }
}

export const CODALI_GATEWAY_CLASSIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "queryType",
    "needsPrivateData",
    "needsFreshData",
    "needsDocdex",
    "needsAppTools",
    "needsImageWorker",
  ],
  properties: {
    queryType: { type: "string", minLength: 1 },
    needsPrivateData: { type: "boolean" },
    needsFreshData: { type: "boolean" },
    needsDocdex: { type: "boolean" },
    needsAppTools: { type: "boolean" },
    needsImageWorker: { type: "boolean" },
    directAnswerCandidate: { type: "string" },
    rationale: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    metadata: { type: "object" },
  },
} as const;

export const CODALI_GATEWAY_PLANNER_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["queryType", "subquestions", "workerTasks"],
  properties: {
    runId: { type: "string" },
    queryType: { type: "string", minLength: 1 },
    summary: { type: "string" },
    subquestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "question"],
        properties: {
          id: { type: "string", minLength: 1 },
          question: { type: "string", minLength: 1 },
          rationale: { type: "string" },
          priority: { type: "number" },
        },
      },
    },
    workerTasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "workerRole", "objective", "toolsAllowed", "outputFormat"],
        properties: {
          id: { type: "string", minLength: 1 },
          workerRole: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          query: { type: "string" },
          toolsAllowed: { type: "array", items: { type: "string" } },
          outputFormat: { type: "string", minLength: 1 },
          expectedSources: { type: "array", items: { type: "string" } },
          constraints: { type: "array", items: { type: "string" } },
          priority: { type: "number" },
          metadata: { type: "object" },
        },
      },
    },
    expectedEvidenceCount: { type: "number" },
    maxIterations: { type: "number" },
    requiresFinalLargeModel: { type: "boolean" },
    metadata: { type: "object" },
  },
} as const;

const CLASSIFIER_RESPONSE_FORMAT: ProviderResponseFormat = {
  type: "json_schema",
  schema: CODALI_GATEWAY_CLASSIFIER_SCHEMA as Record<string, unknown>,
};

const PLANNER_RESPONSE_FORMAT: ProviderResponseFormat = {
  type: "json_schema",
  schema: CODALI_GATEWAY_PLANNER_SCHEMA as Record<string, unknown>,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readString = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === "string" && record[key].trim()
    ? (record[key] as string).trim()
    : undefined;

const readFlexibleBoolean = (
  record: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const snakeKey = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
  for (const candidateKey of [key, snakeKey]) {
    const value = record[candidateKey];
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "y", "1", "needed", "required"].includes(normalized)) {
        return true;
      }
      if (["false", "no", "n", "0", "none", "not_needed", "not required"].includes(normalized)) {
        return false;
      }
    }
  }
  return undefined;
};

const readClassifierQueryType = (record: Record<string, unknown>): string | undefined =>
  readString(record, "queryType") ??
  readString(record, "query_type") ??
  readString(record, "intent") ??
  readString(record, "type") ??
  readString(record, "category") ??
  readString(record, "route");

const CLASSIFIER_WRAPPER_KEYS = [
  "classifier",
  "classification",
  "routing",
  "route",
  "output",
  "result",
] as const;

const hasClassifierSignals = (record: Record<string, unknown>): boolean =>
  Boolean(
    readClassifierQueryType(record) ||
    "needsPrivateData" in record ||
    "needs_private_data" in record ||
    "needsFreshData" in record ||
    "needs_fresh_data" in record ||
    "needsDocdex" in record ||
    "needs_docdex" in record ||
    "needsAppTools" in record ||
    "needs_app_tools" in record ||
    "needsImageWorker" in record ||
    "needs_image_worker" in record,
  );

const unwrapClassifierRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  if (hasClassifierSignals(value)) return value;
  for (const key of CLASSIFIER_WRAPPER_KEYS) {
    const nested = value[key];
    if (isRecord(nested) && hasClassifierSignals(nested)) {
      return nested;
    }
  }
  return value;
};

const readAliasValue = (
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown => {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
};

const readStringFromKeys = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }
  return undefined;
};

const stringListFromValue = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const items = value
      .flatMap((item) => {
        if (typeof item === "string") return [item.trim()];
        if (isRecord(item)) {
          const name = readStringFromKeys(item, ["name", "tool", "id", "source"]);
          return name ? [name] : [];
        }
        return [];
      })
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string") {
    const items = value
      .split(/[\n,;]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
};

const hasAppToolContract = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return Object.keys(value).length > 0;
};

const inferClassifierDefaults = (
  input?: GatewayPlannerInput,
  policyCompilation?: GatewayPolicyCompilation,
): Pick<
  CodaliGatewayClassifierOutput,
  "queryType" | "needsPrivateData" | "needsFreshData" | "needsDocdex" | "needsAppTools" | "needsImageWorker"
> => {
  const request = input?.request;
  const allowedTools =
    policyCompilation
      ? allowedToolNames(policyCompilation)
      : request?.policy.allowedTools ?? [];
  const hasDocdexTool = allowedTools.some((tool) => tool === "docdex_search" || tool.startsWith("docdex_"));
  const docdex = request?.docdex;
  const needsDocdex = Boolean(
    docdex?.required === true ||
    docdex?.enabled === true ||
    docdex?.repoId ||
    docdex?.repoRoot ||
    hasDocdexTool,
  );
  const appToolNames = new Set<string>();
  for (const tool of request?.policy.appVirtualTools ?? []) {
    appToolNames.add(tool);
  }
  if (hasAppToolContract(request?.policy.appToolContracts)) {
    for (const tool of Object.keys(request?.policy.appToolContracts ?? {})) {
      appToolNames.add(tool);
    }
  }
  for (const tool of allowedTools) {
    if (tool !== "docdex_search" && !tool.startsWith("docdex_")) {
      appToolNames.add(tool);
    }
  }
  const needsAppTools = Boolean(appToolNames.size > 0 || request?.policy.appToolGateway);
  const tenantScoped = Boolean(request?.tenant?.id || request?.tenant?.slug || request?.tenant?.realm);
  const usesRuntimeData = needsDocdex || needsAppTools;
  return {
    queryType: request?.mode === "image" ? "image" : "general",
    needsPrivateData: Boolean((tenantScoped && usesRuntimeData) || docdex?.required === true),
    needsFreshData: needsAppTools,
    needsDocdex,
    needsAppTools,
    needsImageWorker: request?.mode === "image" && request?.policy.allowImageWorker === true,
  };
};

const parseJsonObject = (content: string): unknown => {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new CodaliGatewayPlannerError(
      "GATEWAY_JSON_PARSE_FAILED",
      "Planner stage returned non-JSON content.",
    );
  }
};

const validateClassifierOutput = (
  value: unknown,
  input?: GatewayPlannerInput,
  policyCompilation?: GatewayPolicyCompilation,
): { output?: CodaliGatewayClassifierOutput; issues: CodaliGatewayValidationIssue[] } => {
  const issues: CodaliGatewayValidationIssue[] = [];
  const record = unwrapClassifierRecord(value);
  if (!record) {
    return {
      issues: [
        {
          path: "$",
          code: "expected_object",
          message: "Classifier output must be an object.",
        },
      ],
    };
  }
  const defaults = inferClassifierDefaults(input, policyCompilation);
  const queryType = readClassifierQueryType(record) ?? defaults.queryType;
  const requiredBooleans = [
    "needsPrivateData",
    "needsFreshData",
    "needsDocdex",
    "needsAppTools",
    "needsImageWorker",
  ] as const;
  const booleans: Partial<Record<typeof requiredBooleans[number], boolean>> = {};
  for (const key of requiredBooleans) {
    booleans[key] = readFlexibleBoolean(record, key) ?? defaults[key];
  }
  const confidenceValue = readString(record, "confidence")?.toLowerCase();
  const confidence =
    confidenceValue === "high" || confidenceValue === "medium" || confidenceValue === "low"
      ? confidenceValue
      : undefined;
  if (issues.length > 0) {
    return { issues };
  }
  return {
    issues,
    output: {
      queryType,
      needsPrivateData: booleans.needsPrivateData ?? false,
      needsFreshData: booleans.needsFreshData ?? false,
      needsDocdex: booleans.needsDocdex ?? false,
      needsAppTools: booleans.needsAppTools ?? false,
      needsImageWorker: booleans.needsImageWorker ?? false,
      directAnswerCandidate:
        readString(record, "directAnswerCandidate") ??
        readString(record, "direct_answer_candidate"),
      rationale: readString(record, "rationale"),
      confidence,
      metadata: isRecord(record.metadata) ? record.metadata : undefined,
    },
  };
};

const describeTool = (
  name: string,
  descriptors: GatewayPlannerInput["toolDescriptions"],
): string => {
  const descriptor = descriptors?.[name];
  if (!descriptor) {
    return `${name}: read-only allowed tool`;
  }
  if (typeof descriptor === "string") {
    return `${name}: ${descriptor}`;
  }
  return `${name}: ${descriptor.description ?? "read-only allowed tool"}`;
};

const allowedToolNames = (compilation: GatewayPolicyCompilation): string[] =>
  [...compilation.effectiveAllowedTools].sort();

export const buildCodaliGatewayClassifierMessages = (
  input: GatewayPlannerInput,
): ProviderMessage[] => {
  const policy = input.policyCompilation ?? compileCodaliGatewayPolicy({ request: input.request });
  const tools = allowedToolNames(policy);
  const system = [
    "You are Codali gateway classifier.",
    "Return JSON only. Do not answer the user.",
    "Classify the request into routing facts for a product-neutral orchestration gateway.",
    "Small models only produce structured artifacts; final user-visible prose is handled later.",
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.policyImmutability,
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.tenantScope,
  ].join("\n");
  const user = [
    `Query: ${input.request.query}`,
    `Mode: ${input.request.mode ?? "balanced"}`,
    `Product: ${input.request.product?.name ?? "generic"}`,
    `Tenant scoped: ${input.request.tenant?.id || input.request.tenant?.slug ? "yes" : "unknown"}`,
    `Image worker allowed: ${input.request.policy.allowImageWorker === true ? "yes" : "no"}`,
    `Available tools: ${tools.length > 0 ? tools.join(", ") : "none"}`,
    "Decide these booleans: needsPrivateData, needsFreshData, needsDocdex, needsAppTools, needsImageWorker.",
    "If a direct answer is possible without private/runtime tools, include directAnswerCandidate.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
};

export const buildCodaliGatewayPlannerMessages = (
  input: GatewayPlannerInput,
  classifier: CodaliGatewayClassifierOutput,
): ProviderMessage[] => {
  const policy = input.policyCompilation ?? compileCodaliGatewayPolicy({ request: input.request });
  const tools = allowedToolNames(policy);
  const toolLines =
    tools.length > 0
      ? tools.map((tool) => `- ${describeTool(tool, input.toolDescriptions)}`).join("\n")
      : "- none";
  const workerRoles = [
    "direct_answer",
    "rag_worker",
    "tool_worker",
    "extractor",
    "verifier",
    input.request.policy.allowImageWorker === true ? "image_worker" : undefined,
  ].filter(Boolean).join(", ");
  const system = [
    "You are Codali gateway planner.",
    "Return JSON only. Do not answer the user.",
    "Create bounded worker tasks that gather evidence or produce structured artifacts.",
    "Only use tool names listed in the allowed tool section.",
    "Do not include denied, disabled, write, shell, destructive, or outside-workspace tools.",
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.toolOutputBoundary,
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.policyImmutability,
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.tenantScope,
  ].join("\n");
  const user = [
    `Query: ${input.request.query}`,
    `Classifier: ${JSON.stringify(classifier)}`,
    `Policy limits: maxIterations=${input.request.policy.maxIterations}, maxToolCalls=${policy.security.limits.maxToolCalls}, maxModelCalls=${policy.security.limits.maxModelCalls}, maxEvidenceItems=${policy.security.limits.maxEvidenceItems}, maxImageArtifacts=${policy.security.limits.maxImageArtifacts}`,
    `Worker roles available: ${workerRoles}`,
    "Allowed tools:",
    toolLines,
    "Output planner JSON with queryType, subquestions, workerTasks, expectedEvidenceCount, maxIterations, requiresFinalLargeModel, and metadata.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
};

const buildRepairMessages = (
  stage: string,
  originalMessages: ProviderMessage[],
  rawContent: string,
  error: unknown,
): ProviderMessage[] => [
  ...originalMessages,
  { role: "assistant", content: rawContent },
  {
    role: "user",
    content: [
      `Repair the ${stage} JSON output.`,
      "Return JSON only and match the required schema exactly.",
      `Validation error: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n"),
  },
];

const PLANNER_WRAPPER_KEYS = [
  "planner",
  "planning",
  "plan",
  "routing",
  "output",
  "result",
] as const;

const hasPlannerSignals = (record: Record<string, unknown>): boolean =>
  Boolean(
    readStringFromKeys(record, ["queryType", "query_type", "intent", "type", "category"]) ||
    readAliasValue(record, ["subquestions", "sub_questions", "questions"]) ||
    readAliasValue(record, ["workerTasks", "worker_tasks", "tasks", "steps", "workers"]),
  );

const unwrapPlannerRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (Array.isArray(value)) {
    return { workerTasks: value };
  }
  if (!isRecord(value)) return undefined;
  if (hasPlannerSignals(value)) return value;
  for (const key of PLANNER_WRAPPER_KEYS) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return { workerTasks: nested };
    }
    if (isRecord(nested) && hasPlannerSignals(nested)) {
      return nested;
    }
  }
  return value;
};

const normalizePlannerSubquestions = (
  record: Record<string, unknown>,
  request: CodaliGatewayRequest,
): CodaliGatewaySubquestion[] => {
  const input = readAliasValue(record, [
    "subquestions",
    "sub_questions",
    "questions",
    "researchQuestions",
    "research_questions",
  ]);
  if (!Array.isArray(input)) {
    return [];
  }
  const output: CodaliGatewaySubquestion[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (typeof item === "string" && item.trim()) {
      output.push({ id: `sq-${index + 1}`, question: item.trim() });
      continue;
    }
    if (!isRecord(item)) continue;
    const question =
      readStringFromKeys(item, ["question", "query", "objective", "task", "description"]) ??
      request.query;
    output.push({
      id: readStringFromKeys(item, ["id", "name", "key"]) ?? `sq-${index + 1}`,
      question,
      rationale: readStringFromKeys(item, ["rationale", "reason"]),
    });
  }
  return output;
};

const defaultPlannerTools = (
  classifier: CodaliGatewayClassifierOutput,
  policyCompilation: GatewayPolicyCompilation,
): string[] => {
  if (
    !classifier.needsDocdex &&
    !classifier.needsAppTools &&
    !classifier.needsFreshData &&
    !classifier.needsPrivateData
  ) {
    return [];
  }
  return allowedToolNames(policyCompilation);
};

const defaultWorkerRole = (
  toolsAllowed: string[],
  classifier: CodaliGatewayClassifierOutput,
): string => {
  if (classifier.needsImageWorker) return "image_worker";
  if (toolsAllowed.some((tool) => tool !== "docdex_search" && !tool.startsWith("docdex_"))) {
    return "tool_worker";
  }
  if (toolsAllowed.length > 0 || classifier.needsDocdex) {
    return "rag_worker";
  }
  return "direct_answer";
};

const normalizePlannerWorkerTask = (
  item: unknown,
  index: number,
  request: CodaliGatewayRequest,
  classifier: CodaliGatewayClassifierOutput,
  policyCompilation: GatewayPolicyCompilation,
): CodaliGatewayWorkerTask | undefined => {
  const fallbackTools = defaultPlannerTools(classifier, policyCompilation);
  if (typeof item === "string" && item.trim()) {
    return {
      id: `task-${index + 1}`,
      workerRole: defaultWorkerRole(fallbackTools, classifier),
      objective: item.trim(),
      query: request.query,
      toolsAllowed: fallbackTools,
      outputFormat: fallbackTools.length > 0 ? "evidence_items" : "answer_outline",
    };
  }
  if (!isRecord(item)) return undefined;
  const toolsAllowed =
    stringListFromValue(readAliasValue(item, [
      "toolsAllowed",
      "tools_allowed",
      "allowedTools",
      "allowed_tools",
      "tools",
      "toolNames",
      "tool_names",
      "tool",
    ])) ?? fallbackTools;
  const query = readStringFromKeys(item, [
    "query",
    "searchQuery",
    "search_query",
    "question",
  ]);
  const objective =
    readStringFromKeys(item, [
      "objective",
      "task",
      "description",
      "instruction",
      "question",
      "query",
    ]) ?? request.query;
  const task: CodaliGatewayWorkerTask = {
    id: readStringFromKeys(item, ["id", "name", "key"]) ?? `task-${index + 1}`,
    workerRole:
      readStringFromKeys(item, ["workerRole", "worker_role", "worker", "role"]) ??
      defaultWorkerRole(toolsAllowed, classifier),
    objective,
    toolsAllowed,
    outputFormat:
      readStringFromKeys(item, ["outputFormat", "output_format", "format", "expectedOutput"]) ??
      (toolsAllowed.length > 0 ? "evidence_items" : "answer_outline"),
  };
  if (query) {
    task.query = query;
  }
  const expectedSources = stringListFromValue(
    readAliasValue(item, ["expectedSources", "expected_sources", "sources", "sourceTypes"]),
  );
  if (expectedSources) {
    task.expectedSources = expectedSources;
  }
  const constraints = stringListFromValue(readAliasValue(item, ["constraints"]));
  if (constraints) {
    task.constraints = constraints;
  }
  const metadata = isRecord(item.metadata) ? item.metadata : undefined;
  if (metadata) {
    task.metadata = metadata;
  }
  return task;
};

const normalizePlannerWorkerTasks = (
  record: Record<string, unknown>,
  request: CodaliGatewayRequest,
  classifier: CodaliGatewayClassifierOutput,
  policyCompilation: GatewayPolicyCompilation,
): CodaliGatewayWorkerTask[] => {
  const input = readAliasValue(record, [
    "workerTasks",
    "worker_tasks",
    "tasks",
    "steps",
    "workers",
    "toolTasks",
    "tool_tasks",
  ]);
  const rawTasks = Array.isArray(input) ? input : [];
  const tasks = rawTasks
    .map((item, index) => normalizePlannerWorkerTask(
      item,
      index,
      request,
      classifier,
      policyCompilation,
    ))
    .filter((task): task is CodaliGatewayWorkerTask => Boolean(task));
  if (tasks.length > 0) {
    return tasks;
  }
  const toolsAllowed = defaultPlannerTools(classifier, policyCompilation);
  if (toolsAllowed.length === 0) {
    return [];
  }
  return [
    {
      id: "task-1",
      workerRole: defaultWorkerRole(toolsAllowed, classifier),
      objective: "Gather relevant evidence for the user request.",
      query: request.query,
      toolsAllowed,
      outputFormat: "evidence_items",
    },
  ];
};

const normalizePlannerOutput = (
  value: unknown,
  input: GatewayPlannerInput,
  classifier: CodaliGatewayClassifierOutput,
  policyCompilation: GatewayPolicyCompilation,
): unknown => {
  const record = unwrapPlannerRecord(value);
  if (!record) return value;
  const workerTasks = normalizePlannerWorkerTasks(
    record,
    input.request,
    classifier,
    policyCompilation,
  );
  const normalized: CodaliGatewayPlannerOutput = {
    queryType:
      readStringFromKeys(record, ["queryType", "query_type", "intent", "type", "category"]) ??
      classifier.queryType,
    summary: readStringFromKeys(record, ["summary", "rationale", "reasoning"]),
    subquestions: normalizePlannerSubquestions(record, input.request),
    workerTasks,
    expectedEvidenceCount: workerTasks.length > 0 ? Math.max(workerTasks.length, 1) : undefined,
    maxIterations: Math.max(1, Math.min(input.request.policy.maxIterations, Math.max(workerTasks.length, 1))),
    requiresFinalLargeModel: input.request.policy.requireFinalLargeModel,
    metadata: isRecord(record.metadata) ? record.metadata : undefined,
  };
  return normalized;
};

const sanitizePlannerOutput = (
  planner: CodaliGatewayPlannerOutput,
  input: GatewayPlannerInput,
): { planner: CodaliGatewayPlannerOutput; warnings: string[] } => {
  const policy = input.policyCompilation ?? compileCodaliGatewayPolicy({ request: input.request });
  const allowed = new Set(allowedToolNames(policy));
  const warnings: string[] = [];
  const workerTasks: CodaliGatewayWorkerTask[] = [];

  for (const task of planner.workerTasks) {
    if (task.workerRole === "image_worker" && input.request.policy.allowImageWorker !== true) {
      warnings.push(`planner_task_removed_image_worker_disabled:${task.id}`);
      continue;
    }
    const filteredTools = task.toolsAllowed.filter((tool) => allowed.has(tool));
    const removed = task.toolsAllowed.filter((tool) => !allowed.has(tool));
    if (removed.length > 0) {
      warnings.push(`planner_task_tools_removed:${task.id}:${removed.join(",")}`);
    }
    workerTasks.push({ ...task, toolsAllowed: filteredTools });
  }

  if (input.request.docdex?.required === true) {
    const requiredDocdexTool = [
      "docdex_search",
      "docdex_batch_search",
      ...allowed,
    ].find((tool) => allowed.has(tool) && tool.startsWith("docdex_"));
    if (requiredDocdexTool) {
      const existingIndex = workerTasks.findIndex((task) =>
        task.toolsAllowed.includes(requiredDocdexTool));
      if (existingIndex >= 0) {
        const existing = workerTasks[existingIndex];
        workerTasks[existingIndex] = {
          ...existing,
          metadata: {
            ...(existing.metadata ?? {}),
            required: true,
            requiredToolCalls: [requiredDocdexTool],
          },
        };
      } else {
        const taskIds = new Set(workerTasks.map((task) => task.id));
        let taskId = "required-docdex-search";
        let suffix = 2;
        while (taskIds.has(taskId)) {
          taskId = `required-docdex-search-${suffix}`;
          suffix += 1;
        }
        workerTasks.unshift({
          id: taskId,
          workerRole: "rag_worker",
          objective: "Search Docdex for authoritative evidence before synthesis.",
          query: input.request.query,
          toolsAllowed: [requiredDocdexTool],
          outputFormat: "evidence_items",
          expectedSources: ["docdex"],
          metadata: {
            required: true,
            requiredToolCalls: [requiredDocdexTool],
          },
        });
        warnings.push(`planner_required_docdex_task_added:${requiredDocdexTool}`);
      }
    }
  }

  return {
    warnings,
    planner: {
      ...planner,
      maxIterations:
        planner.maxIterations === undefined
          ? undefined
          : Math.min(planner.maxIterations, input.request.policy.maxIterations),
      workerTasks,
    },
  };
};

export class CodaliGatewayPlanner {
  private readonly maxRepairAttempts: number;

  constructor(
    private readonly provider: Provider,
    private readonly options: CodaliGatewayPlannerOptions = {},
  ) {
    this.maxRepairAttempts = options.maxRepairAttempts ?? 1;
  }

  async classify(input: GatewayPlannerInput): Promise<{
    classifier: CodaliGatewayClassifierOutput;
    repairAttempts: number;
    rawContent: string;
    warnings: string[];
  }> {
    const messages = buildCodaliGatewayClassifierMessages(input);
    const response = await this.generateValidated(
      "classifier",
      messages,
      CLASSIFIER_RESPONSE_FORMAT,
      (value) => validateClassifierOutput(value, input, input.policyCompilation),
    );
    const warnings: string[] = [];
    const classifier = { ...response.value };
    if (classifier.needsImageWorker && input.request.policy.allowImageWorker !== true) {
      classifier.needsImageWorker = false;
      warnings.push("classifier_image_worker_disabled");
    }
    return { ...response, classifier, warnings };
  }

  async plan(input: GatewayPlannerInput): Promise<CodaliGatewayPlanningResult> {
    const policyCompilation =
      input.policyCompilation ?? compileCodaliGatewayPolicy({ request: input.request });
    if (!policyCompilation.ok) {
      throw new CodaliGatewayPlannerError(
        "GATEWAY_POLICY_COMPILE_FAILED",
        "Cannot plan with invalid gateway policy.",
      );
    }

    const classifierResult = await this.classify({ ...input, policyCompilation });
    const plannerMessages = buildCodaliGatewayPlannerMessages(
      { ...input, policyCompilation },
      classifierResult.classifier,
    );
    const plannerResult = await this.generateValidated(
      "planner",
      plannerMessages,
      PLANNER_RESPONSE_FORMAT,
      (value) => {
        const validation = validateCodaliGatewayPlannerOutput(
          normalizePlannerOutput(
            value,
            { ...input, policyCompilation },
            classifierResult.classifier,
            policyCompilation,
          ),
        );
        return validation.ok
          ? { output: validation.value, issues: [] }
          : { issues: validation.issues };
      },
    );
    const sanitized = sanitizePlannerOutput(
      plannerResult.value,
      { ...input, policyCompilation },
    );

    return {
      policyCompilation,
      classifier: classifierResult.classifier,
      planner: sanitized.planner,
      warnings: [...classifierResult.warnings, ...sanitized.warnings],
      classifierRepairAttempts: classifierResult.repairAttempts,
      plannerRepairAttempts: plannerResult.repairAttempts,
      classifierRawContent: classifierResult.rawContent,
      plannerRawContent: plannerResult.rawContent,
    };
  }

  private async generateValidated<T>(
    stage: string,
    messages: ProviderMessage[],
    responseFormat: ProviderResponseFormat,
    validator: (value: unknown) => { output?: T; issues: CodaliGatewayValidationIssue[] },
  ): Promise<{ value: T; repairAttempts: number; rawContent: string }> {
    let currentMessages = messages;
    let repairAttempts = 0;
    let lastError: unknown;
    let lastRaw = "";

    for (;;) {
      const response = await this.provider.generate({
        messages: currentMessages,
        maxTokens: this.options.maxTokens,
        temperature: this.options.temperature ?? 0,
        responseFormat,
      });
      lastRaw = response.message.content;
      try {
        const parsed = parseJsonObject(lastRaw);
        const validated = validator(parsed);
        if (validated.output) {
          return { value: validated.output, repairAttempts, rawContent: lastRaw };
        }
        throw new CodaliGatewayPlannerError(
          "GATEWAY_STAGE_SCHEMA_INVALID",
          `${stage} output failed schema validation.`,
          validated.issues,
        );
      } catch (error) {
        lastError = error;
        if (repairAttempts >= this.maxRepairAttempts) {
          if (error instanceof CodaliGatewayPlannerError) {
            throw error;
          }
          throw new CodaliGatewayPlannerError(
            "GATEWAY_STAGE_SCHEMA_INVALID",
            `${stage} output could not be parsed or validated.`,
          );
        }
        repairAttempts += 1;
        currentMessages = buildRepairMessages(stage, messages, lastRaw, lastError);
      }
    }
  }
}

export const createCodaliGatewayPlanner = (
  provider: Provider,
  options?: CodaliGatewayPlannerOptions,
): CodaliGatewayPlanner => new CodaliGatewayPlanner(provider, options);
