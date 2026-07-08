import type {
  CodaliAgentRolePolicy,
  CodaliAgentTierPolicy,
  CodaliContextPack,
  CodaliContextPackContradiction,
  CodaliContextPackExcerpt,
  CodaliContextPackToolSummary,
  CodaliEvidenceItem,
  CodaliGatewayFreshness,
  CodaliGatewayMessage,
  CodaliGatewayMode,
  CodaliGatewayPlannerOutput,
  CodaliGatewayPolicy,
  CodaliGatewayRequest,
  CodaliGatewayResponseFormat,
  CodaliGatewayResponsePolicy,
  CodaliGatewaySubquestion,
  CodaliGatewayValidationIssue,
  CodaliGatewayValidationResult,
  CodaliGatewayVerifierIssue,
  CodaliGatewayVerifierOutput,
  CodaliGatewayWorkerTask,
} from "./CodaliGatewayTypes.js";
import type {
  CodaliRuntimeAppToolContracts,
  CodaliRuntimeAppToolGatewayContract,
  CodaliRuntimeDocdexInput,
  CodaliRuntimeToolManifest,
} from "../runtime/CodaliRuntime.js";

const GATEWAY_MODES: readonly CodaliGatewayMode[] = [
  "fast",
  "balanced",
  "deep",
  "cheap",
  "image",
] as const;

const RESPONSE_FORMATS: readonly CodaliGatewayResponseFormat[] = [
  "text",
  "json",
  "json_schema",
] as const;

const FRESHNESS_VALUES: readonly CodaliGatewayFreshness[] = [
  "fresh",
  "recent",
  "stale",
  "unknown",
] as const;

const DEFAULT_POLICY_BUDGETS = {
  maxIterations: 3,
  maxRuntimeMs: 90_000,
  maxToolCalls: 20,
  maxModelCalls: 10,
  maxEvidenceItems: 80,
  maxImageArtifacts: 0,
  maxContextPackTokens: 20_000,
} as const;

type ValidationBag = {
  issues: CodaliGatewayValidationIssue[];
};

export const isCodaliGatewayValidationOk = <T>(
  result: CodaliGatewayValidationResult<T>,
): result is { ok: true; value: T; issues: [] } => result.ok;

export const validateCodaliGatewayRequest = (
  input: unknown,
): CodaliGatewayValidationResult<CodaliGatewayRequest> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) {
    return fail(bag);
  }

  const query = readRequiredNonEmptyString(record, ["query"], "$.query", bag);
  const policyValue = readAlias(record, ["policy"]);
  const policy = validateCodaliGatewayPolicy(policyValue);
  if (!policy.ok) {
    addNestedIssues(bag, "$.policy", policy.issues);
  }

  const mode = readOptionalEnum(
    record,
    ["mode"],
    GATEWAY_MODES,
    "$.mode",
    bag,
    "balanced",
  );
  const response = normalizeResponsePolicy(readAlias(record, ["response"]), bag);
  const agentPolicy = normalizeAgentTierPolicy(
    readAlias(record, ["agentPolicy", "agent_policy"]),
    bag,
  );

  if (!query || !policy.ok) {
    return fail(bag);
  }

  const request: CodaliGatewayRequest = {
    query,
    mode,
    policy: policy.value,
    response,
    agentPolicy,
  };

  copyOptionalString(record, request, "id", ["id"], "$.id", bag);
  const product = normalizeStringObject(
    readAlias(record, ["product"]),
    ["name", "version", "surface"],
    "$.product",
    bag,
  );
  if (product) {
    request.product = product;
  }
  const tenant = normalizeStringObject(
    readAlias(record, ["tenant"]),
    ["id", "slug", "realm"],
    "$.tenant",
    bag,
  );
  if (tenant) {
    request.tenant = tenant;
  }
  const requester = normalizeStringObject(
    readAlias(record, ["requester"]),
    ["id", "email", "role", "locale"],
    "$.requester",
    bag,
  );
  if (requester) {
    request.requester = requester;
  }
  const conversation = normalizeConversation(readAlias(record, ["conversation"]), bag);
  if (conversation) {
    request.conversation = conversation;
  }
  const docdex = readOptionalRecord(
    record,
    ["docdex"],
    "$.docdex",
    bag,
  ) as CodaliRuntimeDocdexInput | undefined;
  if (docdex) {
    request.docdex = docdex;
  }
  const tools = readOptionalRecord(
    record,
    ["tools", "tool_manifest", "toolManifest"],
    "$.tools",
    bag,
  ) as CodaliRuntimeToolManifest | undefined;
  if (tools) {
    request.tools = tools;
  }
  const metadata = readOptionalRecord(record, ["metadata"], "$.metadata", bag);
  if (metadata) {
    request.metadata = metadata;
  }

  return bag.issues.length > 0 ? fail(bag) : ok(request);
};

export const validateCodaliGatewayPolicy = (
  input: unknown,
): CodaliGatewayValidationResult<CodaliGatewayPolicy> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) {
    return fail(bag);
  }

  const allowedTools =
    readOptionalStringArray(
    record,
    ["allowedTools", "allowed_tools"],
    "$.allowedTools",
    bag,
    [],
    ) ?? [];
  const deniedTools = readOptionalStringArray(
    record,
    ["deniedTools", "denied_tools"],
    "$.deniedTools",
    bag,
    undefined,
  );
  const appVirtualTools = readOptionalStringArray(
    record,
    [
      "appVirtualTools",
      "app_virtual_tools",
    ],
    "$.appVirtualTools",
    bag,
    undefined,
  );

  requireFalse(record, ["allowWrites", "allow_writes"], "$.allowWrites", bag);
  requireFalse(record, ["allowShell", "allow_shell"], "$.allowShell", bag);
  requireFalse(
    record,
    ["allowDestructiveOperations", "allow_destructive_operations"],
    "$.allowDestructiveOperations",
    bag,
  );
  requireFalse(
    record,
    ["allowOutsideWorkspace", "allow_outside_workspace"],
    "$.allowOutsideWorkspace",
    bag,
  );

  const appToolContracts = readAppToolContracts(record, bag);
  const appToolGateway = readAppToolGateway(record, bag);

  const policy: CodaliGatewayPolicy = {
    allowedTools,
    deniedTools,
    appToolContracts,
    appVirtualTools,
    appToolGateway,
    maxIterations: readPositiveInteger(
      record,
      ["maxIterations", "max_iterations"],
      "$.maxIterations",
      bag,
      DEFAULT_POLICY_BUDGETS.maxIterations,
    ),
    maxRuntimeMs: readPositiveInteger(
      record,
      ["maxRuntimeMs", "max_runtime_ms"],
      "$.maxRuntimeMs",
      bag,
      DEFAULT_POLICY_BUDGETS.maxRuntimeMs,
    ),
    maxToolCalls: readPositiveInteger(
      record,
      ["maxToolCalls", "max_tool_calls"],
      "$.maxToolCalls",
      bag,
      DEFAULT_POLICY_BUDGETS.maxToolCalls,
    ),
    maxModelCalls: readPositiveInteger(
      record,
      ["maxModelCalls", "max_model_calls"],
      "$.maxModelCalls",
      bag,
      DEFAULT_POLICY_BUDGETS.maxModelCalls,
    ),
    maxEvidenceItems: readPositiveInteger(
      record,
      ["maxEvidenceItems", "max_evidence_items"],
      "$.maxEvidenceItems",
      bag,
      DEFAULT_POLICY_BUDGETS.maxEvidenceItems,
    ),
    maxImageArtifacts: readNonNegativeInteger(
      record,
      ["maxImageArtifacts", "max_image_artifacts"],
      "$.maxImageArtifacts",
      bag,
      DEFAULT_POLICY_BUDGETS.maxImageArtifacts,
    ),
    maxContextPackTokens: readPositiveInteger(
      record,
      ["maxContextPackTokens", "max_context_pack_tokens"],
      "$.maxContextPackTokens",
      bag,
      DEFAULT_POLICY_BUDGETS.maxContextPackTokens,
    ),
    allowWrites: false,
    allowShell: false,
    allowDestructiveOperations: false,
    allowOutsideWorkspace: false,
    requireFinalLargeModel:
      readOptionalBoolean(
      record,
      ["requireFinalLargeModel", "require_final_large_model"],
      "$.requireFinalLargeModel",
      bag,
      true,
      ) ?? true,
  };

  const allowDegradedFinalAnswer = readOptionalBoolean(
    record,
    ["allowDegradedFinalAnswer", "allow_degraded_final_answer"],
    "$.allowDegradedFinalAnswer",
    bag,
    undefined,
  );
  if (typeof allowDegradedFinalAnswer === "boolean") {
    policy.allowDegradedFinalAnswer = allowDegradedFinalAnswer;
  }
  const allowImageWorker = readOptionalBoolean(
    record,
    ["allowImageWorker", "allow_image_worker"],
    "$.allowImageWorker",
    bag,
    undefined,
  );
  if (typeof allowImageWorker === "boolean") {
    policy.allowImageWorker = allowImageWorker;
  }

  return bag.issues.length > 0 ? fail(bag) : ok(policy);
};

export const validateCodaliGatewayPlannerOutput = (
  input: unknown,
): CodaliGatewayValidationResult<CodaliGatewayPlannerOutput> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) {
    return fail(bag);
  }

  const queryType = readRequiredNonEmptyString(
    record,
    ["queryType", "query_type"],
    "$.queryType",
    bag,
  );
  const subquestions = normalizeSubquestions(
    readAlias(record, ["subquestions", "sub_questions"]),
    "$.subquestions",
    bag,
  );
  const workerTasks = normalizeWorkerTasks(
    readAlias(record, ["workerTasks", "worker_tasks"]),
    "$.workerTasks",
    bag,
  );

  if (!queryType) {
    return fail(bag);
  }

  const plannerOutput: CodaliGatewayPlannerOutput = {
    queryType,
    subquestions,
    workerTasks,
  };
  copyOptionalString(record, plannerOutput, "runId", ["runId", "run_id"], "$.runId", bag);
  copyOptionalString(record, plannerOutput, "summary", ["summary"], "$.summary", bag);
  copyOptionalPositiveInteger(
    record,
    plannerOutput,
    "expectedEvidenceCount",
    ["expectedEvidenceCount", "expected_evidence_count"],
    "$.expectedEvidenceCount",
    bag,
  );
  copyOptionalPositiveInteger(
    record,
    plannerOutput,
    "maxIterations",
    ["maxIterations", "max_iterations"],
    "$.maxIterations",
    bag,
  );
  const requiresFinalLargeModel = readOptionalBoolean(
    record,
    ["requiresFinalLargeModel", "requires_final_large_model"],
    "$.requiresFinalLargeModel",
    bag,
    undefined,
  );
  if (typeof requiresFinalLargeModel === "boolean") {
    plannerOutput.requiresFinalLargeModel = requiresFinalLargeModel;
  }
  const metadata = readOptionalRecord(record, ["metadata"], "$.metadata", bag);
  if (metadata) {
    plannerOutput.metadata = metadata;
  }

  return bag.issues.length > 0 ? fail(bag) : ok(plannerOutput);
};

export const validateCodaliGatewayWorkerTask = (
  input: unknown,
): CodaliGatewayValidationResult<CodaliGatewayWorkerTask> => {
  const bag: ValidationBag = { issues: [] };
  const task = normalizeWorkerTask(input, "$", bag);
  if (!task) {
    return fail(bag);
  }
  return bag.issues.length > 0 ? fail(bag) : ok(task);
};

export const validateCodaliEvidenceItem = (
  input: unknown,
): CodaliGatewayValidationResult<CodaliEvidenceItem> => {
  const bag: ValidationBag = { issues: [] };
  const evidence = normalizeEvidenceItem(input, "$", bag);
  if (!evidence) {
    return fail(bag);
  }
  return bag.issues.length > 0 ? fail(bag) : ok(evidence);
};

export const validateCodaliGatewayVerifierOutput = (
  input: unknown,
): CodaliGatewayValidationResult<CodaliGatewayVerifierOutput> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) {
    return fail(bag);
  }

  const passed = readRequiredBoolean(record, ["passed"], "$.passed", bag);
  const confidence = readUnitNumber(record, ["confidence"], "$.confidence", bag);
  const followUpTasks = normalizeWorkerTasks(
    readAlias(record, ["followUpTasks", "follow_up_tasks"]),
    "$.followUpTasks",
    bag,
    [],
  );

  if (typeof passed !== "boolean" || typeof confidence !== "number") {
    return fail(bag);
  }

  const verifierOutput: CodaliGatewayVerifierOutput = {
    passed,
    confidence,
    verifiedEvidenceIds:
      readOptionalStringArray(
      record,
      ["verifiedEvidenceIds", "verified_evidence_ids"],
      "$.verifiedEvidenceIds",
      bag,
      [],
      ) ?? [],
    rejectedEvidenceIds:
      readOptionalStringArray(
      record,
      ["rejectedEvidenceIds", "rejected_evidence_ids"],
      "$.rejectedEvidenceIds",
      bag,
      [],
      ) ?? [],
    issues: normalizeVerifierIssues(readAlias(record, ["issues"]), "$.issues", bag),
    contradictions: normalizeContradictions(
      readAlias(record, ["contradictions"]),
      "$.contradictions",
      bag,
    ),
    missingInformation:
      readOptionalStringArray(
      record,
      ["missingInformation", "missing_information"],
      "$.missingInformation",
      bag,
      [],
      ) ?? [],
    followUpTasks,
  };
  const metadata = readOptionalRecord(record, ["metadata"], "$.metadata", bag);
  if (metadata) {
    verifierOutput.metadata = metadata;
  }

  return bag.issues.length > 0 ? fail(bag) : ok(verifierOutput);
};

export const validateCodaliContextPack = (
  input: unknown,
): CodaliGatewayValidationResult<CodaliContextPack> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) {
    return fail(bag);
  }

  const id = readRequiredNonEmptyString(record, ["id"], "$.id", bag);
  const runId = readRequiredNonEmptyString(record, ["runId", "run_id"], "$.runId", bag);
  const originalQuery = readRequiredNonEmptyString(
    record,
    ["originalQuery", "original_query"],
    "$.originalQuery",
    bag,
  );
  const tokenEstimate = readNonNegativeInteger(
    record,
    ["tokenEstimate", "token_estimate"],
    "$.tokenEstimate",
    bag,
    0,
  );

  if (!id || !runId || !originalQuery) {
    return fail(bag);
  }

  const contextPack: CodaliContextPack = {
    id,
    runId,
    originalQuery,
    decisionFacts: normalizeEvidenceItems(
      readAlias(record, ["decisionFacts", "decision_facts"]),
      "$.decisionFacts",
      bag,
    ),
    contradictions: normalizeContradictions(
      readAlias(record, ["contradictions"]),
      "$.contradictions",
      bag,
    ),
    missingInformation:
      readOptionalStringArray(
      record,
      ["missingInformation", "missing_information"],
      "$.missingInformation",
      bag,
      [],
      ) ?? [],
    selectedExcerpts: normalizeSelectedExcerpts(
      readAlias(record, ["selectedExcerpts", "selected_excerpts"]),
      "$.selectedExcerpts",
      bag,
    ),
    toolSummary: normalizeToolSummary(
      readAlias(record, ["toolSummary", "tool_summary"],
      ),
      "$.toolSummary",
      bag,
    ),
    tokenEstimate,
  };
  const metadata = readOptionalRecord(record, ["metadata"], "$.metadata", bag);
  if (metadata) {
    contextPack.metadata = metadata;
  }

  return bag.issues.length > 0 ? fail(bag) : ok(contextPack);
};

export const validateGatewayRequest = validateCodaliGatewayRequest;
export const validateGatewayPolicy = validateCodaliGatewayPolicy;
export const validateGatewayPlannerOutput = validateCodaliGatewayPlannerOutput;
export const validateGatewayWorkerTask = validateCodaliGatewayWorkerTask;
export const validateGatewayEvidenceItem = validateCodaliEvidenceItem;
export const validateGatewayVerifierOutput = validateCodaliGatewayVerifierOutput;
export const validateGatewayContextPack = validateCodaliContextPack;

const ok = <T>(value: T): CodaliGatewayValidationResult<T> => ({
  ok: true,
  value,
  issues: [],
});

const fail = <T>(bag: ValidationBag): CodaliGatewayValidationResult<T> => ({
  ok: false,
  issues: bag.issues,
});

const addIssue = (
  bag: ValidationBag,
  path: string,
  code: string,
  message: string,
  value?: unknown,
): void => {
  bag.issues.push({ path, code, message, value });
};

const addNestedIssues = (
  bag: ValidationBag,
  prefix: string,
  issues: CodaliGatewayValidationIssue[],
): void => {
  for (const issue of issues) {
    const suffix = issue.path === "$" ? "" : issue.path.slice(1);
    bag.issues.push({ ...issue, path: `${prefix}${suffix}` });
  }
};

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const requireRecord = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): Record<string, unknown> | undefined => {
  if (!isRecord(input)) {
    addIssue(bag, path, "expected_object", "Expected an object.", input);
    return undefined;
  }
  return input;
};

const readAlias = (record: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
};

const hasAlias = (record: Record<string, unknown>, keys: string[]): boolean =>
  keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));

const readRequiredNonEmptyString = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
): string | undefined => {
  const value = readAlias(record, keys);
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(bag, path, "expected_non_empty_string", "Expected a non-empty string.", value);
    return undefined;
  }
  return value.trim();
};

const readOptionalString = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
): string | undefined => {
  const value = readAlias(record, keys);
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string") {
    addIssue(bag, path, "expected_string", "Expected a string.", value);
    return undefined;
  }
  return value;
};

const readRequiredBoolean = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
): boolean | undefined => {
  const value = readAlias(record, keys);
  if (typeof value !== "boolean") {
    addIssue(bag, path, "expected_boolean", "Expected a boolean.", value);
    return undefined;
  }
  return value;
};

const readOptionalBoolean = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
  fallback: boolean | undefined,
): boolean | undefined => {
  const value = readAlias(record, keys);
  if (typeof value === "undefined") {
    return fallback;
  }
  if (typeof value !== "boolean") {
    addIssue(bag, path, "expected_boolean", "Expected a boolean.", value);
    return fallback;
  }
  return value;
};

const readPositiveInteger = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
  fallback: number,
): number => {
  const value = readAlias(record, keys);
  if (typeof value === "undefined") {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    addIssue(
      bag,
      path,
      "expected_positive_integer",
      "Expected a positive integer.",
      value,
    );
    return fallback;
  }
  return value;
};

const readNonNegativeInteger = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
  fallback: number,
): number => {
  const value = readAlias(record, keys);
  if (typeof value === "undefined") {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    addIssue(
      bag,
      path,
      "expected_non_negative_integer",
      "Expected a non-negative integer.",
      value,
    );
    return fallback;
  }
  return value;
};

const readUnitNumber = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
): number | undefined => {
  const value = readAlias(record, keys);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    addIssue(bag, path, "expected_unit_number", "Expected a number between 0 and 1.", value);
    return undefined;
  }
  return value;
};

const readOptionalEnum = <T extends string>(
  record: Record<string, unknown>,
  keys: string[],
  values: readonly T[],
  path: string,
  bag: ValidationBag,
  fallback: T,
): T => {
  const value = readAlias(record, keys);
  if (typeof value === "undefined") {
    return fallback;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    addIssue(bag, path, "expected_enum", `Expected one of: ${values.join(", ")}.`, value);
    return fallback;
  }
  return value as T;
};

const readOptionalStringArray = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
  fallback: string[] | undefined,
): string[] | undefined => {
  const value = readAlias(record, keys);
  if (typeof value === "undefined") {
    return fallback;
  }
  if (!Array.isArray(value)) {
    addIssue(bag, path, "expected_string_array", "Expected an array of strings.", value);
    return fallback;
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim().length === 0) {
      addIssue(
        bag,
        `${path}[${index}]`,
        "expected_non_empty_string",
        "Expected a non-empty string.",
        item,
      );
      continue;
    }
    strings.push(item.trim());
  }
  return strings;
};

const readOptionalRecord = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
): Record<string, unknown> | undefined => {
  const value = readAlias(record, keys);
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!isRecord(value)) {
    addIssue(bag, path, "expected_object", "Expected an object.", value);
    return undefined;
  }
  return value;
};

const requireFalse = (
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  bag: ValidationBag,
): void => {
  if (!hasAlias(record, keys)) {
    return;
  }
  const value = readAlias(record, keys);
  if (value !== false) {
    addIssue(
      bag,
      path,
      "read_only_policy_required",
      "Initial Codali gateway policies must keep this permission false.",
      value,
    );
  }
};

const copyOptionalString = <T extends object, K extends keyof T>(
  record: Record<string, unknown>,
  target: T,
  targetKey: K,
  keys: string[],
  path: string,
  bag: ValidationBag,
): void => {
  const value = readOptionalString(record, keys, path, bag);
  if (typeof value === "string") {
    target[targetKey] = value as T[K];
  }
};

const copyOptionalPositiveInteger = <
  T extends object,
  K extends keyof T,
>(
  record: Record<string, unknown>,
  target: T,
  targetKey: K,
  keys: string[],
  path: string,
  bag: ValidationBag,
): void => {
  if (!hasAlias(record, keys)) {
    return;
  }
  target[targetKey] = readPositiveInteger(record, keys, path, bag, 1) as T[K];
};

const normalizeStringObject = (
  input: unknown,
  keys: string[],
  path: string,
  bag: ValidationBag,
): Record<string, string> | undefined => {
  if (typeof input === "undefined") {
    return undefined;
  }
  const record = requireRecord(input, path, bag);
  if (!record) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const key of keys) {
    const value = readOptionalString(record, [key], `${path}.${key}`, bag);
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
};

const normalizeConversation = (
  input: unknown,
  bag: ValidationBag,
): CodaliGatewayRequest["conversation"] | undefined => {
  if (typeof input === "undefined") {
    return undefined;
  }
  const record = requireRecord(input, "$.conversation", bag);
  if (!record) {
    return undefined;
  }
  const conversation: CodaliGatewayRequest["conversation"] = {};
  copyOptionalString(record, conversation, "id", ["id"], "$.conversation.id", bag);
  const messagesValue = readAlias(record, ["messages"]);
  if (typeof messagesValue !== "undefined") {
    if (!Array.isArray(messagesValue)) {
      addIssue(
        bag,
        "$.conversation.messages",
        "expected_message_array",
        "Expected an array of messages.",
        messagesValue,
      );
    } else {
      const messages: CodaliGatewayMessage[] = [];
      for (let index = 0; index < messagesValue.length; index += 1) {
        const message = normalizeConversationMessage(
          messagesValue[index],
          `$.conversation.messages[${index}]`,
          bag,
        );
        if (message) {
          messages.push(message);
        }
      }
      conversation.messages = messages;
    }
  }
  return conversation;
};

const normalizeConversationMessage = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliGatewayMessage | undefined => {
  const record = requireRecord(input, path, bag);
  if (!record) {
    return undefined;
  }
  const role = readAlias(record, ["role"]);
  if (role !== "system" && role !== "user" && role !== "assistant") {
    addIssue(
      bag,
      `${path}.role`,
      "expected_message_role",
      "Expected message role system, user, or assistant.",
      role,
    );
    return undefined;
  }
  const content = readRequiredNonEmptyString(record, ["content"], `${path}.content`, bag);
  if (!content) {
    return undefined;
  }
  return { role, content };
};

const normalizeResponsePolicy = (
  input: unknown,
  bag: ValidationBag,
): CodaliGatewayResponsePolicy => {
  if (typeof input === "undefined") {
    return { format: "text", finalAnswerRequired: true };
  }
  const record = requireRecord(input, "$.response", bag);
  if (!record) {
    return { format: "text", finalAnswerRequired: true };
  }
  const response: CodaliGatewayResponsePolicy = {
    format: readOptionalEnum(
      record,
      ["format"],
      RESPONSE_FORMATS,
      "$.response.format",
      bag,
      "text",
    ),
    finalAnswerRequired: readOptionalBoolean(
      record,
      ["finalAnswerRequired", "final_answer_required"],
      "$.response.finalAnswerRequired",
      bag,
      true,
    ),
  };
  const schema = readOptionalRecord(record, ["schema"], "$.response.schema", bag);
  if (schema) {
    response.schema = schema;
  }
  return response;
};

const normalizeAgentTierPolicy = (
  input: unknown,
  bag: ValidationBag,
): CodaliAgentTierPolicy => {
  if (typeof input === "undefined") {
    return { resolver: "mcoda_inventory" };
  }
  const record = requireRecord(input, "$.agentPolicy", bag);
  if (!record) {
    return { resolver: "mcoda_inventory" };
  }
  const resolver = readAlias(record, ["resolver"]);
  if (typeof resolver !== "undefined" && resolver !== "mcoda_inventory") {
    addIssue(
      bag,
      "$.agentPolicy.resolver",
      "unsupported_resolver",
      "Only mcoda_inventory is supported.",
      resolver,
    );
  }
  const policy: CodaliAgentTierPolicy = {
    resolver: "mcoda_inventory",
    allowCloudFallback: readOptionalBoolean(
      record,
      ["allowCloudFallback", "allow_cloud_fallback"],
      "$.agentPolicy.allowCloudFallback",
      bag,
      undefined,
    ),
  };
  const rolesValue = readAlias(record, ["roles"]);
  if (typeof rolesValue !== "undefined") {
    const rolesRecord = requireRecord(rolesValue, "$.agentPolicy.roles", bag);
    if (rolesRecord) {
      const roles: Record<string, CodaliAgentRolePolicy> = {};
      for (const [role, value] of Object.entries(rolesRecord)) {
        const rolePolicy = normalizeAgentRolePolicy(
          value,
          `$.agentPolicy.roles.${role}`,
          bag,
        );
        if (rolePolicy) {
          roles[role] = rolePolicy;
        }
      }
      policy.roles = roles;
    }
  }
  return policy;
};

const normalizeAgentRolePolicy = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliAgentRolePolicy | undefined => {
  const record = requireRecord(input, path, bag);
  if (!record) {
    return undefined;
  }
  const tier = readAlias(record, ["tier"]);
  if (tier !== "small" && tier !== "medium" && tier !== "large" && tier !== "image") {
    addIssue(
      bag,
      `${path}.tier`,
      "expected_model_tier",
      "Expected tier small, medium, large, or image.",
      tier,
    );
    return undefined;
  }
  const rolePolicy: CodaliAgentRolePolicy = { tier };
  const capabilities = readOptionalStringArray(
    record,
    ["capabilities"],
    `${path}.capabilities`,
    bag,
    undefined,
  );
  if (capabilities) {
    rolePolicy.capabilities = capabilities;
  }
  const preferredRunnerKinds = readOptionalStringArray(
    record,
    ["preferredRunnerKinds", "preferred_runner_kinds"],
    `${path}.preferredRunnerKinds`,
    bag,
    undefined,
  );
  if (preferredRunnerKinds) {
    rolePolicy.preferredRunnerKinds = preferredRunnerKinds;
  }
  copyOptionalRoleBoolean(record, rolePolicy, "requiresTools", path, bag);
  copyOptionalRoleBoolean(record, rolePolicy, "requiresJsonSchema", path, bag);
  copyOptionalRolePositiveInteger(record, rolePolicy, "maxLatencyMs", path, bag);
  copyOptionalRolePositiveInteger(record, rolePolicy, "minContextWindow", path, bag);
  return rolePolicy;
};

const copyOptionalRoleBoolean = (
  record: Record<string, unknown>,
  target: CodaliAgentRolePolicy,
  key: "requiresTools" | "requiresJsonSchema",
  path: string,
  bag: ValidationBag,
): void => {
  const snakeKey = key === "requiresTools" ? "requires_tools" : "requires_json_schema";
  const value = readOptionalBoolean(record, [key, snakeKey], `${path}.${key}`, bag, undefined);
  if (typeof value === "boolean") {
    target[key] = value;
  }
};

const copyOptionalRolePositiveInteger = (
  record: Record<string, unknown>,
  target: CodaliAgentRolePolicy,
  key: "maxLatencyMs" | "minContextWindow",
  path: string,
  bag: ValidationBag,
): void => {
  const snakeKey = key === "maxLatencyMs" ? "max_latency_ms" : "min_context_window";
  if (!hasAlias(record, [key, snakeKey])) {
    return;
  }
  target[key] = readPositiveInteger(record, [key, snakeKey], `${path}.${key}`, bag, 1);
};

const readAppToolContracts = (
  record: Record<string, unknown>,
  bag: ValidationBag,
): CodaliRuntimeAppToolContracts | undefined => {
  const value = readAlias(record, [
    "appToolContracts",
    "app_tool_contracts",
  ]);
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    addIssue(
      bag,
      "$.appToolContracts",
      "expected_tool_contracts",
      "Expected an object map or array of tool contracts.",
      value,
    );
    return undefined;
  }
  validateAppToolContractsReadOnly(value, bag);
  return value as CodaliRuntimeAppToolContracts;
};

const readAppToolGateway = (
  record: Record<string, unknown>,
  bag: ValidationBag,
): CodaliRuntimeAppToolGatewayContract | undefined => {
  const value = readAlias(record, ["appToolGateway", "app_tool_gateway"]);
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!isRecord(value)) {
    addIssue(
      bag,
      "$.appToolGateway",
      "expected_tool_gateway",
      "Expected a gateway contract object.",
      value,
    );
    return undefined;
  }
  const readOnly = readAlias(value, ["readOnly", "read_only"]);
  if (readOnly === false) {
    addIssue(
      bag,
      "$.appToolGateway.readOnly",
      "read_only_gateway_required",
      "App tool gateway dispatch is read-only in this gateway phase.",
      readOnly,
    );
  }
  return value as CodaliRuntimeAppToolGatewayContract;
};

const validateAppToolContractsReadOnly = (
  value: Record<string, unknown> | unknown[],
  bag: ValidationBag,
): void => {
  const contractEntries = Array.isArray(value)
    ? value.map((contractValue, index) => [String(index), contractValue] as const)
    : Object.entries(value);
  for (const [key, contractValue] of contractEntries) {
    if (!isRecord(contractValue)) {
      continue;
    }
    const readOnly = readAlias(contractValue, ["readOnly", "read_only"]);
    if (readOnly === false) {
      addIssue(
        bag,
        `$.appToolContracts[${key}].readOnly`,
        "read_only_tool_contract_required",
        "Runtime app tool contracts must be read-only in this gateway phase.",
        readOnly,
      );
    }
  }
};

const normalizeSubquestions = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliGatewaySubquestion[] => {
  if (typeof input === "undefined") {
    return [];
  }
  if (!Array.isArray(input)) {
    addIssue(bag, path, "expected_subquestion_array", "Expected an array.", input);
    return [];
  }
  const subquestions: CodaliGatewaySubquestion[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const record = requireRecord(input[index], `${path}[${index}]`, bag);
    if (!record) {
      continue;
    }
    const id = readRequiredNonEmptyString(record, ["id"], `${path}[${index}].id`, bag);
    const question = readRequiredNonEmptyString(
      record,
      ["question"],
      `${path}[${index}].question`,
      bag,
    );
    if (!id || !question) {
      continue;
    }
    const subquestion: CodaliGatewaySubquestion = { id, question };
    copyOptionalString(
      record,
      subquestion,
      "rationale",
      ["rationale"],
      `${path}[${index}].rationale`,
      bag,
    );
    copyOptionalPositiveInteger(
      record,
      subquestion,
      "priority",
      ["priority"],
      `${path}[${index}].priority`,
      bag,
    );
    subquestions.push(subquestion);
  }
  return subquestions;
};

const normalizeWorkerTasks = (
  input: unknown,
  path: string,
  bag: ValidationBag,
  fallback: CodaliGatewayWorkerTask[] = [],
): CodaliGatewayWorkerTask[] => {
  if (typeof input === "undefined") {
    return fallback;
  }
  if (!Array.isArray(input)) {
    addIssue(bag, path, "expected_worker_task_array", "Expected an array.", input);
    return fallback;
  }
  const tasks: CodaliGatewayWorkerTask[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const task = normalizeWorkerTask(input[index], `${path}[${index}]`, bag);
    if (task) {
      tasks.push(task);
    }
  }
  return tasks;
};

const normalizeWorkerTask = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliGatewayWorkerTask | undefined => {
  const record = requireRecord(input, path, bag);
  if (!record) {
    return undefined;
  }
  const id = readRequiredNonEmptyString(record, ["id"], `${path}.id`, bag);
  const workerRole = readRequiredNonEmptyString(
    record,
    ["workerRole", "worker_role"],
    `${path}.workerRole`,
    bag,
  );
  const objective = readRequiredNonEmptyString(record, ["objective"], `${path}.objective`, bag);
  const outputFormat = readRequiredNonEmptyString(
    record,
    ["outputFormat", "output_format"],
    `${path}.outputFormat`,
    bag,
  );
  if (!id || !workerRole || !objective || !outputFormat) {
    return undefined;
  }
  const task: CodaliGatewayWorkerTask = {
    id,
    workerRole,
    objective,
    toolsAllowed: readOptionalStringArray(
      record,
      ["toolsAllowed", "tools_allowed"],
      `${path}.toolsAllowed`,
      bag,
      [],
    ) ?? [],
    outputFormat,
  };
  copyOptionalString(record, task, "query", ["query"], `${path}.query`, bag);
  const expectedSources = readOptionalStringArray(
    record,
    ["expectedSources", "expected_sources"],
    `${path}.expectedSources`,
    bag,
    undefined,
  );
  if (expectedSources) {
    task.expectedSources = expectedSources;
  }
  const constraints = readOptionalStringArray(
    record,
    ["constraints"],
    `${path}.constraints`,
    bag,
    undefined,
  );
  if (constraints) {
    task.constraints = constraints;
  }
  copyOptionalPositiveInteger(record, task, "priority", ["priority"], `${path}.priority`, bag);
  const metadata = readOptionalRecord(record, ["metadata"], `${path}.metadata`, bag);
  if (metadata) {
    task.metadata = metadata;
  }
  return task;
};

const normalizeEvidenceItems = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliEvidenceItem[] => {
  if (typeof input === "undefined") {
    return [];
  }
  if (!Array.isArray(input)) {
    addIssue(bag, path, "expected_evidence_array", "Expected an array.", input);
    return [];
  }
  const evidence: CodaliEvidenceItem[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = normalizeEvidenceItem(input[index], `${path}[${index}]`, bag);
    if (item) {
      evidence.push(item);
    }
  }
  return evidence;
};

const normalizeEvidenceItem = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliEvidenceItem | undefined => {
  const record = requireRecord(input, path, bag);
  if (!record) {
    return undefined;
  }
  const id = readRequiredNonEmptyString(record, ["id"], `${path}.id`, bag);
  const runId = readRequiredNonEmptyString(record, ["runId", "run_id"], `${path}.runId`, bag);
  const claim = readRequiredNonEmptyString(record, ["claim"], `${path}.claim`, bag);
  const sourceType = readRequiredNonEmptyString(
    record,
    ["sourceType", "source_type"],
    `${path}.sourceType`,
    bag,
  );
  const confidence = readUnitNumber(record, ["confidence"], `${path}.confidence`, bag);
  const relevance = readUnitNumber(record, ["relevance"], `${path}.relevance`, bag);
  const tenantScoped = readRequiredBoolean(
    record,
    ["tenantScoped", "tenant_scoped"],
    `${path}.tenantScoped`,
    bag,
  );
  if (
    !id ||
    !runId ||
    !claim ||
    !sourceType ||
    typeof confidence !== "number" ||
    typeof relevance !== "number" ||
    typeof tenantScoped !== "boolean"
  ) {
    return undefined;
  }
  const item: CodaliEvidenceItem = {
    id,
    runId,
    claim,
    sourceType,
    confidence,
    relevance,
    tenantScoped,
  };
  copyOptionalString(record, item, "taskId", ["taskId", "task_id"], `${path}.taskId`, bag);
  copyOptionalString(record, item, "stageId", ["stageId", "stage_id"], `${path}.stageId`, bag);
  copyOptionalString(record, item, "summary", ["summary"], `${path}.summary`, bag);
  copyOptionalString(
    record,
    item,
    "sourceId",
    ["sourceId", "source_id"],
    `${path}.sourceId`,
    bag,
  );
  copyOptionalString(
    record,
    item,
    "sourceUri",
    ["sourceUri", "source_uri"],
    `${path}.sourceUri`,
    bag,
  );
  copyOptionalString(
    record,
    item,
    "sourceTitle",
    ["sourceTitle", "source_title"],
    `${path}.sourceTitle`,
    bag,
  );
  copyOptionalString(
    record,
    item,
    "sourceTimestamp",
    ["sourceTimestamp", "source_timestamp"],
    `${path}.sourceTimestamp`,
    bag,
  );
  copyOptionalString(
    record,
    item,
    "rawExcerpt",
    ["rawExcerpt", "raw_excerpt"],
    `${path}.rawExcerpt`,
    bag,
  );
  copyOptionalString(
    record,
    item,
    "rawPayloadRef",
    ["rawPayloadRef", "raw_payload_ref"],
    `${path}.rawPayloadRef`,
    bag,
  );
  const freshness = readAlias(record, ["freshness"]);
  if (typeof freshness !== "undefined") {
    if (typeof freshness === "string" && FRESHNESS_VALUES.includes(freshness as CodaliGatewayFreshness)) {
      item.freshness = freshness as CodaliGatewayFreshness;
    } else {
      addIssue(
        bag,
        `${path}.freshness`,
        "expected_freshness",
        `Expected one of: ${FRESHNESS_VALUES.join(", ")}.`,
        freshness,
      );
    }
  }
  copyOptionalString(
    record,
    item,
    "usedTool",
    ["usedTool", "used_tool"],
    `${path}.usedTool`,
    bag,
  );
  const metadata = readOptionalRecord(record, ["metadata"], `${path}.metadata`, bag);
  if (metadata) {
    item.metadata = metadata;
  }
  return item;
};

const normalizeVerifierIssues = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliGatewayVerifierIssue[] => {
  if (typeof input === "undefined") {
    return [];
  }
  if (!Array.isArray(input)) {
    addIssue(bag, path, "expected_issue_array", "Expected an array.", input);
    return [];
  }
  const issues: CodaliGatewayVerifierIssue[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const record = requireRecord(input[index], `${path}[${index}]`, bag);
    if (!record) {
      continue;
    }
    const code = readRequiredNonEmptyString(record, ["code"], `${path}[${index}].code`, bag);
    const message = readRequiredNonEmptyString(
      record,
      ["message"],
      `${path}[${index}].message`,
      bag,
    );
    if (!code || !message) {
      continue;
    }
    const issue: CodaliGatewayVerifierIssue = { code, message };
    const severity = readAlias(record, ["severity"]);
    if (severity === "info" || severity === "warning" || severity === "error") {
      issue.severity = severity;
    } else if (typeof severity !== "undefined") {
      addIssue(
        bag,
        `${path}[${index}].severity`,
        "expected_severity",
        "Expected severity info, warning, or error.",
        severity,
      );
    }
    const evidenceIds = readOptionalStringArray(
      record,
      ["evidenceIds", "evidence_ids"],
      `${path}[${index}].evidenceIds`,
      bag,
      undefined,
    );
    if (evidenceIds) {
      issue.evidenceIds = evidenceIds;
    }
    issues.push(issue);
  }
  return issues;
};

const normalizeContradictions = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliContextPackContradiction[] => {
  if (typeof input === "undefined") {
    return [];
  }
  if (!Array.isArray(input)) {
    addIssue(bag, path, "expected_contradiction_array", "Expected an array.", input);
    return [];
  }
  const contradictions: CodaliContextPackContradiction[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const record = requireRecord(input[index], `${path}[${index}]`, bag);
    if (!record) {
      continue;
    }
    const summary = readRequiredNonEmptyString(
      record,
      ["summary"],
      `${path}[${index}].summary`,
      bag,
    );
    if (!summary) {
      continue;
    }
    contradictions.push({
      summary,
      evidenceIds: readOptionalStringArray(
        record,
        ["evidenceIds", "evidence_ids"],
        `${path}[${index}].evidenceIds`,
        bag,
        [],
      ) ?? [],
    });
  }
  return contradictions;
};

const normalizeSelectedExcerpts = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliContextPackExcerpt[] => {
  if (typeof input === "undefined") {
    return [];
  }
  if (!Array.isArray(input)) {
    addIssue(bag, path, "expected_excerpt_array", "Expected an array.", input);
    return [];
  }
  const excerpts: CodaliContextPackExcerpt[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const record = requireRecord(input[index], `${path}[${index}]`, bag);
    if (!record) {
      continue;
    }
    const evidenceId = readRequiredNonEmptyString(
      record,
      ["evidenceId", "evidence_id"],
      `${path}[${index}].evidenceId`,
      bag,
    );
    const text = readRequiredNonEmptyString(record, ["text"], `${path}[${index}].text`, bag);
    if (evidenceId && text) {
      excerpts.push({ evidenceId, text });
    }
  }
  return excerpts;
};

const normalizeToolSummary = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliContextPackToolSummary[] => {
  if (typeof input === "undefined") {
    return [];
  }
  if (!Array.isArray(input)) {
    addIssue(bag, path, "expected_tool_summary_array", "Expected an array.", input);
    return [];
  }
  const summary: CodaliContextPackToolSummary[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const record = requireRecord(input[index], `${path}[${index}]`, bag);
    if (!record) {
      continue;
    }
    const tool = readRequiredNonEmptyString(record, ["tool"], `${path}[${index}].tool`, bag);
    const calls = readNonNegativeInteger(record, ["calls"], `${path}[${index}].calls`, bag, 0);
    const statusesRecord = readOptionalRecord(
      record,
      ["statuses"],
      `${path}[${index}].statuses`,
      bag,
    );
    if (!tool) {
      continue;
    }
    const statuses: Record<string, number> = {};
    if (statusesRecord) {
      for (const [status, count] of Object.entries(statusesRecord)) {
        if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
          statuses[status] = count;
        } else {
          addIssue(
            bag,
            `${path}[${index}].statuses.${status}`,
            "expected_non_negative_integer",
            "Expected a non-negative integer status count.",
            count,
          );
        }
      }
    }
    summary.push({ tool, calls, statuses });
  }
  return summary;
};
