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
import { requestTouchesOwnData } from "./GroundingMode.js";
import { renderCapabilityLines, renderToolLines } from "./ToolExposure.js";
import { buildTemporalContext, renderTemporalContext } from "./TemporalContext.js";

export interface CodaliGatewayPlannerToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Capability group used for two-level tool exposure. See ToolExposure.ts. */
  capability?: string;
  readOnly?: boolean;
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
    capabilities: { type: "array", items: { type: "string" } },
    needsClarification: { type: "string" },
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

/**
 * Returns every complete, brace-balanced span in the text, in order, ignoring
 * braces inside string literals. Prose can contain braces of its own, so the
 * caller tries each span and keeps the first that is actually valid JSON.
 */
const extractBalancedJsonObjects = (text: string): string[] => {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, index + 1));
      }
    }
  }
  return found;
};

const summarizeRawStageContent = (content: string) => {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "<empty response>";
  }
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}… (${collapsed.length} chars)` : collapsed;
};

const parseJsonObject = (content: string): unknown => {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Models wrap the object in prose, emit the fence mid-message, or add
    // trailing commentary. Taking everything between the first '{' and the last
    // '}' is not valid JSON whenever that surrounding text has braces of its
    // own, and the resulting SyntaxError escaped unwrapped: it is not a
    // CodaliGatewayPlannerError, so generateValidated fell through to its
    // generic "could not be parsed or validated" and the model's actual output
    // was discarded. A caller that degrades on a gateway stage failure then
    // silently loses its whole tool layer for the turn, with nothing in the
    // logs to diagnose it.
    for (const balanced of extractBalancedJsonObjects(candidate)) {
      try {
        return JSON.parse(balanced);
      } catch {
        // Not this span - prose braces look balanced too. Try the next one.
      }
    }
    throw new CodaliGatewayPlannerError(
      "GATEWAY_JSON_PARSE_FAILED",
      `Planner stage returned non-JSON content: ${summarizeRawStageContent(candidate)}`,
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
      capabilities: readCapabilities(record),
      needsClarification: (() => {
        const asked =
          readString(record, "needsClarification") ??
          readString(record, "needs_clarification");
        const originalQuery = input?.request.query ?? "";
        return asked && isRealClarification(asked, originalQuery) ? asked : undefined;
      })(),
      rationale: readString(record, "rationale"),
      confidence,
      metadata: isRecord(record.metadata) ? record.metadata : undefined,
    },
  };
};

/**
 * Matches a tool name the planner wrote against the tools that actually exist.
 *
 * Registered names are namespaced — `http:logmira_tenant_records:daily_logs`,
 * `mcp:github:list_issues` — and a model asked to repeat one routinely writes
 * the last segment instead, or drops the transport prefix. Compared exactly,
 * that name matches nothing, and a task whose tools do not resolve is rejected
 * whole: the run then calls no tools at all, returns no sources, and reports
 * that the context pack was empty.
 *
 * It reached production. A declared HTTP connector was registered, visible and
 * undropped, while the planner in the same run happily called `docdex_search`
 * — a name short enough to reproduce exactly. The connector was never called
 * once.
 *
 * Only unambiguous matches are accepted. Two tools ending in the same segment
 * resolve to neither, because guessing between them would call the wrong
 * system, and that is worse than reporting the tool as unavailable.
 */
export const resolveToolNameAgainst = (
  candidate: string,
  available: readonly string[],
): string | undefined => {
  const wanted = candidate.trim();
  if (!wanted) return undefined;
  if (available.includes(wanted)) return wanted;

  const lower = wanted.toLowerCase();
  const caseless = available.filter((tool) => tool.toLowerCase() === lower);
  if (caseless.length === 1) return caseless[0];

  const lastSegment = (value: string): string => {
    const parts = value.split(":");
    return (parts[parts.length - 1] ?? value).toLowerCase();
  };
  const bySegment = available.filter((tool) => lastSegment(tool) === lastSegment(wanted));
  if (bySegment.length === 1) return bySegment[0];

  // `logmira_tenant_records:daily_logs` for `http:logmira_tenant_records:daily_logs`.
  const bySuffix = available.filter((tool) => tool.toLowerCase().endsWith(`:${lower}`));
  return bySuffix.length === 1 ? bySuffix[0] : undefined;
};

/**
 * Whether a tool name belongs to a connector into someone's account, as opposed
 * to a repository search or the public web. Namespaced transports are the
 * connectors: `mcp:github:list_issues`, `http:jira:search_issues`.
 */
const isOwnedSystemConnector = (tool: string): boolean =>
  tool.startsWith("mcp:") || tool.startsWith("http:");

const allowedToolNames = (compilation: GatewayPolicyCompilation): string[] =>
  [...compilation.effectiveAllowedTools].sort();

/**
 * Capability names the classifier selected for stage-2 tool expansion. Absent
 * or unparseable means "no narrowing", which expands everything - a wrong
 * selection must degrade to a bigger prompt, never to a blind planner.
 */
/**
 * A clarifying question must add something. A small model asked "set
 * needsClarification if the request is ambiguous" will sometimes echo the
 * question back, which stops the run and tells the user nothing — worse than
 * attempting an answer. Restatements are therefore discarded.
 */
const normalizeForCompare = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Pronouns that point at something the question never names.
 *
 * "it", "he", "they" with no antecedent are the genuine case for asking. First
 * person is excluded: "I have three apples" introduces its own subject.
 */
const DANGLING_REFERENT = /\b(?:it|its|he|him|his|she|her|hers|they|them|their)\b/i;

const CLARIFICATION_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "you",
  "your", "about", "which", "what", "who", "does", "did", "specific", "please",
  "question", "asking", "referring", "mean", "want", "like", "would", "should",
]);

const isRealClarification = (question: string, query: string): boolean => {
  const asked = normalizeForCompare(question);
  const original = normalizeForCompare(query);
  if (!asked) return false;
  if (asked === original) return false;
  // A near-restatement: nothing in it that was not already in the question.
  if (original.includes(asked) || asked.includes(original)) return false;
  const originalWords = new Set(original.split(" "));
  const novel = asked.split(" ").filter((word) => word.length > 2 && !originalWords.has(word));
  if (novel.length === 0) return false;

  // A clarification has to be anchored in the request. Asked to reason about a
  // stated word problem, the classifier replied "is the question about a
  // specific codebase or project?" — an axis of ambiguity it invented, which
  // stopped the run to learn nothing. Either the question names something the
  // request mentioned, or the request left a referent dangling.
  const sharesSubject = asked
    .split(" ")
    .some((word) => word.length > 3 && !CLARIFICATION_STOPWORDS.has(word) && originalWords.has(word));
  return sharesSubject || DANGLING_REFERENT.test(query);
};

const readCapabilities = (record: Record<string, unknown>): string[] | undefined => {
  const raw = record.capabilities ?? record.capability_groups ?? record.capabilityGroups;
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length > 0 ? values : undefined;
};

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
    ...renderTemporalContext(buildTemporalContext(input.request.query)),
    "Available capabilities:",
    renderCapabilityLines(tools, input.toolDescriptions),
    "Decide these booleans: needsPrivateData, needsFreshData, needsDocdex, needsAppTools, needsImageWorker.",
    // Left to itself a small classifier sets every boolean true, which sends a
    // request for a short poem through a repository search.
    "Set them all false when the request is something you can simply do or already know: writing code, prose, or examples on demand; arithmetic; definitions; general knowledge that does not change.",
    "Set needsDocdex true only when the answer depends on this specific codebase or its documents.",
    "Set needsFreshData true only when the answer depends on the current state of the world.",
    "Set needsPrivateData or needsAppTools true only when the answer depends on the user's own accounts, issues, messages, or repositories.",
    "If the request is genuinely ambiguous — an unidentifiable person, project, or scope — set needsClarification to the single question that would resolve it. Never guess an identity.",
    "List in `capabilities` only the capability names above that this query actually needs; the planner will then see the full tool schemas for just those.",
    // Asked who currently runs Microsoft, a run picked the GitHub capability
    // and called get_latest_release. The company name matched a connector; the
    // question had nothing to do with the user's account.
    "Choose capabilities by where the answer lives, not by which words the query shares with a tool. A product connector is right only when the answer is inside the user's own account or repositories; a public fact about a company or person is not.",
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
  // A connector reaches into the user's own account, so it is only worth
  // showing when the request is about their data. Left in view for every
  // question, the planner picked by surface resemblance — a question about a
  // company's chief executive went to a GitHub user search, and one about a
  // language's newest release went to `get_latest_release`. Withholding them
  // is a narrowing, not a denial: an explicitly allowed tool is still allowed,
  // this only stops it being suggested for work it cannot do.
  const tools = requestTouchesOwnData(input.request.query, classifier)
    ? allowedToolNames(policy)
    : allowedToolNames(policy).filter((tool) => !isOwnedSystemConnector(tool));
  // Stage 2 of two-level exposure: expand full schemas, but only for the
  // capabilities the classifier selected.
  const exposure = renderToolLines(tools, input.toolDescriptions, classifier.capabilities);
  const toolLines = exposure.text;
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
    ...renderTemporalContext(buildTemporalContext(input.request.query)),
    `Worker roles available: ${workerRoles}`,
    "Allowed tools (name, purpose, and argument shape). Use these names exactly:",
    toolLines,
    exposure.truncated
      ? `(Tool list truncated to ${exposure.expandedTools.length}; narrow the capabilities if the needed tool is absent.)`
      : "",
    // Asked about the user's own mailbox, the planner chose web research over
    // the mail connector that was sitting in the allowed list. Public search
    // cannot reach a private account, so that task could only fail.
    "Match each task's tools to where its answer lives. When the request says \"my\" or names the user's own account, mailbox, calendar, issues, or repositories, the connector for that system is the only tool that can answer it — a public web search cannot read private data.",
    "Output planner JSON with queryType, subquestions, workerTasks, expectedEvidenceCount, maxIterations, requiresFinalLargeModel, and metadata.",
  ].filter(Boolean).join("\n");
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

export const sanitizePlannerOutput = (
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
    const allowedList = [...allowed];
    const resolved = task.toolsAllowed.map((tool) => ({
      requested: tool,
      canonical: resolveToolNameAgainst(tool, allowedList),
    }));
    const filteredTools = [
      ...new Set(
        resolved
          .map((entry) => entry.canonical)
          .filter((tool): tool is string => Boolean(tool)),
      ),
    ];
    const repaired = resolved.filter(
      (entry) => entry.canonical && entry.canonical !== entry.requested,
    );
    if (repaired.length > 0) {
      warnings.push(
        `planner_task_tools_resolved:${task.id}:` +
          repaired.map((entry) => `${entry.requested}->${entry.canonical}`).join(","),
      );
    }
    const removed = resolved.filter((entry) => !entry.canonical).map((entry) => entry.requested);
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

    // A request the classifier could not disambiguate has nothing to plan.
    // Skipping the planner stage saves a model call and, more importantly,
    // avoids producing a plan built on a guessed identity.
    if (classifierResult.classifier.needsClarification?.trim()) {
      return {
        policyCompilation,
        classifier: classifierResult.classifier,
        planner: {
          queryType: classifierResult.classifier.queryType,
          subquestions: [],
          workerTasks: [],
        } as CodaliGatewayPlannerOutput,
        warnings: [...classifierResult.warnings, "planner_skipped:needs_clarification"],
        classifierRepairAttempts: classifierResult.repairAttempts,
        plannerRepairAttempts: 0,
        classifierRawContent: classifierResult.rawContent,
        plannerRawContent: "",
      };
    }

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
            `${stage} output could not be parsed or validated (${
              lastError instanceof Error ? lastError.message : String(lastError)
            }): ${summarizeRawStageContent(lastRaw)}`,
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
