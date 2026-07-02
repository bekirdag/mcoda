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

const readBoolean = (record: Record<string, unknown>, key: string): boolean | undefined =>
  typeof record[key] === "boolean" ? record[key] as boolean : undefined;

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
): { output?: CodaliGatewayClassifierOutput; issues: CodaliGatewayValidationIssue[] } => {
  const issues: CodaliGatewayValidationIssue[] = [];
  if (!isRecord(value)) {
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
  const queryType = readString(value, "queryType") ?? readString(value, "query_type");
  if (!queryType) {
    issues.push({
      path: "$.queryType",
      code: "expected_non_empty_string",
      message: "queryType is required.",
    });
  }
  const requiredBooleans = [
    "needsPrivateData",
    "needsFreshData",
    "needsDocdex",
    "needsAppTools",
    "needsImageWorker",
  ] as const;
  const booleans: Partial<Record<typeof requiredBooleans[number], boolean>> = {};
  for (const key of requiredBooleans) {
    const snakeKey = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    const valueForKey = readBoolean(value, key) ?? readBoolean(value, snakeKey);
    if (valueForKey === undefined) {
      issues.push({
        path: `$.${key}`,
        code: "expected_boolean",
        message: `${key} is required and must be a boolean.`,
      });
    } else {
      booleans[key] = valueForKey;
    }
  }
  const confidence =
    readString(value, "confidence") as CodaliGatewayClassifierOutput["confidence"];
  if (
    confidence !== undefined &&
    confidence !== "high" &&
    confidence !== "medium" &&
    confidence !== "low"
  ) {
    issues.push({
      path: "$.confidence",
      code: "expected_enum",
      message: "confidence must be high, medium, or low.",
    });
  }
  if (issues.length > 0 || !queryType) {
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
        readString(value, "directAnswerCandidate") ??
        readString(value, "direct_answer_candidate"),
      rationale: readString(value, "rationale"),
      confidence,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
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
      validateClassifierOutput,
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
        const validation = validateCodaliGatewayPlannerOutput(value);
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
