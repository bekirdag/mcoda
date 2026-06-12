export const LOCAL_OPENAI_COMPATIBLE_ADAPTER = "openai-compatible-local" as const;
export const VLLM_LOCAL_ADAPTER = "vllm-local" as const;
export const LLAMA_CPP_LOCAL_ADAPTER = "llama-cpp-local" as const;
export const LEGACY_LLAMACPP_LOCAL_ADAPTER = "llamacpp-local" as const;

export const LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES = [
  LOCAL_OPENAI_COMPATIBLE_ADAPTER,
  VLLM_LOCAL_ADAPTER,
  LLAMA_CPP_LOCAL_ADAPTER,
  LEGACY_LLAMACPP_LOCAL_ADAPTER,
] as const;

export type LocalOpenAiCompatibleAdapter = (typeof LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES)[number];

export type LocalRunnerKind =
  | "vllm"
  | "llama-cpp"
  | "llama-cpp-python"
  | "lm-studio"
  | "localai"
  | "sglang"
  | "tgi"
  | "custom";

export type LocalRunnerAuthMode = "none" | "bearer" | "dummy-bearer";

export type LocalRunnerResponseFormatStrategy =
  | "openai"
  | "json-object"
  | "json-schema"
  | "gbnf"
  | "prompt-only"
  | "none";

export type ResponseFormatStrategy = LocalRunnerResponseFormatStrategy;

export interface LocalOpenAiCompatibleRunnerConfig {
  baseUrl?: string;
  endpoint?: string;
  apiBaseUrl?: string;
  runnerKind?: LocalRunnerKind;
  authMode?: LocalRunnerAuthMode;
  dummyBearerToken?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  responseFormatStrategy?: LocalRunnerResponseFormatStrategy;
  healthPath?: string;
  modelsPath?: string;
  requireModelInRequest?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsGbnf?: boolean;
}

export type LocalRunnerConfigIssueCode =
  | "invalid_auth_mode"
  | "invalid_runner_kind"
  | "invalid_response_format_strategy"
  | "invalid_headers"
  | "invalid_header_value"
  | "secret_header"
  | "invalid_extra_body"
  | "reserved_extra_body_key";

export interface LocalRunnerConfigIssue {
  code: LocalRunnerConfigIssueCode;
  path: string;
  message: string;
  value?: unknown;
}

export interface LocalRunnerNormalizationInput {
  adapter?: unknown;
  config?: unknown;
  agentConfig?: unknown;
  defaultRunnerKind?: unknown;
}

export interface NormalizedLocalOpenAiCompatibleRunnerConfig {
  adapter?: typeof LOCAL_OPENAI_COMPATIBLE_ADAPTER;
  originalAdapter?: string;
  isLocalOpenAiCompatible: boolean;
  config: LocalOpenAiCompatibleRunnerConfig;
  issues: LocalRunnerConfigIssue[];
}

export const LOCAL_RUNNER_SECRET_HEADER_KEYS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
] as const;

export const LOCAL_RUNNER_RESERVED_EXTRA_BODY_KEYS = [
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "response_format",
  "max_tokens",
  "temperature",
] as const;

const LOCAL_OPENAI_COMPATIBLE_ADAPTER_SET = new Set<string>(LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES);
const SECRET_HEADER_SET = new Set<string>(LOCAL_RUNNER_SECRET_HEADER_KEYS);
const RESERVED_EXTRA_BODY_KEY_SET = new Set<string>(LOCAL_RUNNER_RESERVED_EXTRA_BODY_KEYS);

const RUNNER_KIND_ALIASES: Record<string, LocalRunnerKind> = {
  vllm: "vllm",
  "llama-cpp": "llama-cpp",
  "llama.cpp": "llama-cpp",
  llamacpp: "llama-cpp",
  "llama_cpp": "llama-cpp",
  "llama-cpp-python": "llama-cpp-python",
  "llama.cpp-python": "llama-cpp-python",
  llamacpppython: "llama-cpp-python",
  "llama_cpp_python": "llama-cpp-python",
  "lm-studio": "lm-studio",
  lmstudio: "lm-studio",
  "lm_studio": "lm-studio",
  localai: "localai",
  "local-ai": "localai",
  local_ai: "localai",
  sglang: "sglang",
  tgi: "tgi",
  "text-generation-inference": "tgi",
  text_generation_inference: "tgi",
  custom: "custom",
};

const AUTH_MODE_ALIASES: Record<string, LocalRunnerAuthMode> = {
  none: "none",
  bearer: "bearer",
  "dummy-bearer": "dummy-bearer",
  dummy_bearer: "dummy-bearer",
  dummybearer: "dummy-bearer",
  dummy: "dummy-bearer",
};

const RESPONSE_FORMAT_STRATEGY_ALIASES: Record<string, LocalRunnerResponseFormatStrategy> = {
  openai: "openai",
  "json-object": "json-object",
  json_object: "json-object",
  jsonobject: "json-object",
  "json-schema": "json-schema",
  json_schema: "json-schema",
  jsonschema: "json-schema",
  gbnf: "gbnf",
  "prompt-only": "prompt-only",
  prompt_only: "prompt-only",
  promptonly: "prompt-only",
  none: "none",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const normalizeLookupKey = (value: string): string => value.trim().toLowerCase();

const readString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return undefined;
};

const pushIssue = (
  issues: LocalRunnerConfigIssue[],
  issue: LocalRunnerConfigIssue,
): void => {
  issues.push(issue);
};

export function isLocalOpenAiCompatibleAdapter(adapter: unknown): boolean {
  const normalized = asString(adapter);
  return normalized ? LOCAL_OPENAI_COMPATIBLE_ADAPTER_SET.has(normalizeLookupKey(normalized)) : false;
}

export function normalizeLocalOpenAiCompatibleAdapter(
  adapter: unknown,
): typeof LOCAL_OPENAI_COMPATIBLE_ADAPTER | undefined {
  return isLocalOpenAiCompatibleAdapter(adapter) ? LOCAL_OPENAI_COMPATIBLE_ADAPTER : undefined;
}

export function defaultLocalRunnerKindForAdapter(adapter: unknown): LocalRunnerKind | undefined {
  const normalized = asString(adapter);
  if (!normalized) return undefined;
  const lookupKey = normalizeLookupKey(normalized);
  if (lookupKey === VLLM_LOCAL_ADAPTER) return "vllm";
  if (lookupKey === LLAMA_CPP_LOCAL_ADAPTER || lookupKey === LEGACY_LLAMACPP_LOCAL_ADAPTER) {
    return "llama-cpp";
  }
  return undefined;
}

export function normalizeLocalRunnerKind(value: unknown): LocalRunnerKind | undefined {
  const normalized = asString(value);
  if (!normalized) return undefined;
  return RUNNER_KIND_ALIASES[normalizeLookupKey(normalized)];
}

export function normalizeLocalRunnerAuthMode(value: unknown): LocalRunnerAuthMode | undefined {
  const normalized = asString(value);
  if (!normalized) return undefined;
  return AUTH_MODE_ALIASES[normalizeLookupKey(normalized)];
}

export function normalizeLocalRunnerResponseFormatStrategy(
  value: unknown,
): LocalRunnerResponseFormatStrategy | undefined {
  const normalized = asString(value);
  if (!normalized) return undefined;
  return RESPONSE_FORMAT_STRATEGY_ALIASES[normalizeLookupKey(normalized)];
}

export function isSecretLocalRunnerHeaderKey(key: string): boolean {
  return SECRET_HEADER_SET.has(normalizeLookupKey(key));
}

export function isReservedLocalRunnerExtraBodyKey(key: string): boolean {
  return RESERVED_EXTRA_BODY_KEY_SET.has(normalizeLookupKey(key));
}

const normalizeHeaders = (
  value: unknown,
  issues: LocalRunnerConfigIssue[],
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_headers",
      path: "headers",
      message: "Local runner headers must be an object with string values.",
      value,
    });
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    const stringValue = asString(headerValue);
    if (!stringValue) {
      pushIssue(issues, {
        code: "invalid_header_value",
        path: `headers.${key}`,
        message: "Local runner header values must be non-empty strings.",
        value: headerValue,
      });
      continue;
    }
    if (isSecretLocalRunnerHeaderKey(key)) {
      pushIssue(issues, {
        code: "secret_header",
        path: `headers.${key}`,
        message: "Secret-bearing headers must not be stored in local runner config.",
        value: key,
      });
      continue;
    }
    headers[key] = stringValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const normalizeExtraBody = (
  value: unknown,
  issues: LocalRunnerConfigIssue[],
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_extra_body",
      path: "extraBody",
      message: "Local runner extraBody must be an object.",
      value,
    });
    return undefined;
  }
  const extraBody: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (isReservedLocalRunnerExtraBodyKey(key)) {
      pushIssue(issues, {
        code: "reserved_extra_body_key",
        path: `extraBody.${key}`,
        message: "extraBody must not override core OpenAI-compatible request fields.",
        value: key,
      });
      continue;
    }
    extraBody[key] = entryValue;
  }
  return Object.keys(extraBody).length > 0 ? extraBody : undefined;
};

const mergeConfigRecords = (input: LocalRunnerNormalizationInput): Record<string, unknown> => {
  const topLevelConfig = isRecord(input.config) ? input.config : {};
  const nestedAgent = isRecord(topLevelConfig.agent) ? topLevelConfig.agent : {};
  const nestedAgentConfig = isRecord(nestedAgent.config) ? nestedAgent.config : {};
  const explicitAgentConfig = isRecord(input.agentConfig) ? input.agentConfig : {};
  const localRunnerConfig = isRecord(topLevelConfig.localRunner) ? topLevelConfig.localRunner : {};
  return {
    ...nestedAgentConfig,
    ...explicitAgentConfig,
    ...localRunnerConfig,
    ...topLevelConfig,
  };
};

export function normalizeLocalOpenAiCompatibleRunnerConfig(
  input: LocalRunnerNormalizationInput = {},
): NormalizedLocalOpenAiCompatibleRunnerConfig {
  const issues: LocalRunnerConfigIssue[] = [];
  const merged = mergeConfigRecords(input);
  const nestedAgent = isRecord(merged.agent) ? merged.agent : {};
  const originalAdapter = asString(input.adapter) ?? asString(merged.adapter) ?? asString(nestedAgent.adapter);
  const adapter = normalizeLocalOpenAiCompatibleAdapter(originalAdapter);
  const isLocalOpenAiCompatible = adapter !== undefined;

  const rawRunnerKind = merged.runnerKind;
  const normalizedRunnerKind = normalizeLocalRunnerKind(rawRunnerKind);
  const runnerKind =
    normalizedRunnerKind ??
    normalizeLocalRunnerKind(input.defaultRunnerKind) ??
    defaultLocalRunnerKindForAdapter(originalAdapter);
  if (rawRunnerKind !== undefined && normalizedRunnerKind === undefined) {
    pushIssue(issues, {
      code: "invalid_runner_kind",
      path: "runnerKind",
      message: "Unknown local runner kind.",
      value: rawRunnerKind,
    });
  }

  const rawAuthMode = merged.authMode;
  const authMode =
    normalizeLocalRunnerAuthMode(rawAuthMode) ?? (isLocalOpenAiCompatible ? "none" : undefined);
  if (rawAuthMode !== undefined && normalizeLocalRunnerAuthMode(rawAuthMode) === undefined) {
    pushIssue(issues, {
      code: "invalid_auth_mode",
      path: "authMode",
      message: "Unknown local runner auth mode.",
      value: rawAuthMode,
    });
  }

  const rawResponseFormatStrategy = merged.responseFormatStrategy;
  const responseFormatStrategy = normalizeLocalRunnerResponseFormatStrategy(rawResponseFormatStrategy);
  if (
    rawResponseFormatStrategy !== undefined &&
    normalizeLocalRunnerResponseFormatStrategy(rawResponseFormatStrategy) === undefined
  ) {
    pushIssue(issues, {
      code: "invalid_response_format_strategy",
      path: "responseFormatStrategy",
      message: "Unknown local runner response format strategy.",
      value: rawResponseFormatStrategy,
    });
  }

  const dummyBearerToken = readString(merged, ["dummyBearerToken", "dummyApiKey"]);
  const config: LocalOpenAiCompatibleRunnerConfig = {
    baseUrl: readString(merged, ["baseUrl", "endpoint", "apiBaseUrl"]),
    endpoint: readString(merged, ["endpoint"]),
    apiBaseUrl: readString(merged, ["apiBaseUrl"]),
    runnerKind,
    authMode,
    dummyBearerToken:
      authMode === "dummy-bearer" ? dummyBearerToken ?? "local" : dummyBearerToken,
    headers: normalizeHeaders(merged.headers, issues),
    extraBody: normalizeExtraBody(merged.extraBody, issues),
    responseFormatStrategy,
    healthPath: readString(merged, ["healthPath"]),
    modelsPath: readString(merged, ["modelsPath"]),
    requireModelInRequest: asBoolean(merged.requireModelInRequest),
    supportsStreaming: asBoolean(merged.supportsStreaming),
    supportsTools: asBoolean(merged.supportsTools),
    supportsJsonSchema: asBoolean(merged.supportsJsonSchema),
    supportsGbnf: asBoolean(merged.supportsGbnf),
  };

  return {
    adapter,
    originalAdapter,
    isLocalOpenAiCompatible,
    config,
    issues,
  };
}

export function validateLocalOpenAiCompatibleRunnerConfig(
  config: LocalOpenAiCompatibleRunnerConfig,
): LocalRunnerConfigIssue[] {
  return normalizeLocalOpenAiCompatibleRunnerConfig({
    adapter: LOCAL_OPENAI_COMPATIBLE_ADAPTER,
    config,
  }).issues;
}
