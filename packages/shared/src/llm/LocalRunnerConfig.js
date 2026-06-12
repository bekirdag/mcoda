export const LOCAL_OPENAI_COMPATIBLE_ADAPTER = "openai-compatible-local";
export const VLLM_LOCAL_ADAPTER = "vllm-local";
export const LLAMA_CPP_LOCAL_ADAPTER = "llama-cpp-local";
export const LEGACY_LLAMACPP_LOCAL_ADAPTER = "llamacpp-local";
export const LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES = [
    LOCAL_OPENAI_COMPATIBLE_ADAPTER,
    VLLM_LOCAL_ADAPTER,
    LLAMA_CPP_LOCAL_ADAPTER,
    LEGACY_LLAMACPP_LOCAL_ADAPTER,
];
export const LOCAL_RUNNER_SECRET_HEADER_KEYS = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
];
export const LOCAL_RUNNER_RESERVED_EXTRA_BODY_KEYS = [
    "model",
    "messages",
    "stream",
    "tools",
    "tool_choice",
    "response_format",
    "max_tokens",
    "temperature",
];
const LOCAL_OPENAI_COMPATIBLE_ADAPTER_SET = new Set(LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES);
const SECRET_HEADER_SET = new Set(LOCAL_RUNNER_SECRET_HEADER_KEYS);
const RESERVED_EXTRA_BODY_KEY_SET = new Set(LOCAL_RUNNER_RESERVED_EXTRA_BODY_KEYS);
const RUNNER_KIND_ALIASES = {
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
const AUTH_MODE_ALIASES = {
    none: "none",
    bearer: "bearer",
    "dummy-bearer": "dummy-bearer",
    dummy_bearer: "dummy-bearer",
    dummybearer: "dummy-bearer",
    dummy: "dummy-bearer",
};
const RESPONSE_FORMAT_STRATEGY_ALIASES = {
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
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value) => {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};
const asBoolean = (value) => typeof value === "boolean" ? value : undefined;
const normalizeLookupKey = (value) => value.trim().toLowerCase();
const readString = (record, keys) => {
    for (const key of keys) {
        const value = asString(record[key]);
        if (value)
            return value;
    }
    return undefined;
};
const pushIssue = (issues, issue) => {
    issues.push(issue);
};
export function isLocalOpenAiCompatibleAdapter(adapter) {
    const normalized = asString(adapter);
    return normalized ? LOCAL_OPENAI_COMPATIBLE_ADAPTER_SET.has(normalizeLookupKey(normalized)) : false;
}
export function normalizeLocalOpenAiCompatibleAdapter(adapter) {
    return isLocalOpenAiCompatibleAdapter(adapter) ? LOCAL_OPENAI_COMPATIBLE_ADAPTER : undefined;
}
export function defaultLocalRunnerKindForAdapter(adapter) {
    const normalized = asString(adapter);
    if (!normalized)
        return undefined;
    const lookupKey = normalizeLookupKey(normalized);
    if (lookupKey === VLLM_LOCAL_ADAPTER)
        return "vllm";
    if (lookupKey === LLAMA_CPP_LOCAL_ADAPTER || lookupKey === LEGACY_LLAMACPP_LOCAL_ADAPTER) {
        return "llama-cpp";
    }
    return undefined;
}
export function normalizeLocalRunnerKind(value) {
    const normalized = asString(value);
    if (!normalized)
        return undefined;
    return RUNNER_KIND_ALIASES[normalizeLookupKey(normalized)];
}
export function normalizeLocalRunnerAuthMode(value) {
    const normalized = asString(value);
    if (!normalized)
        return undefined;
    return AUTH_MODE_ALIASES[normalizeLookupKey(normalized)];
}
export function normalizeLocalRunnerResponseFormatStrategy(value) {
    const normalized = asString(value);
    if (!normalized)
        return undefined;
    return RESPONSE_FORMAT_STRATEGY_ALIASES[normalizeLookupKey(normalized)];
}
export function isSecretLocalRunnerHeaderKey(key) {
    return SECRET_HEADER_SET.has(normalizeLookupKey(key));
}
export function isReservedLocalRunnerExtraBodyKey(key) {
    return RESERVED_EXTRA_BODY_KEY_SET.has(normalizeLookupKey(key));
}
const normalizeHeaders = (value, issues) => {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        pushIssue(issues, {
            code: "invalid_headers",
            path: "headers",
            message: "Local runner headers must be an object with string values.",
            value,
        });
        return undefined;
    }
    const headers = {};
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
const normalizeExtraBody = (value, issues) => {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        pushIssue(issues, {
            code: "invalid_extra_body",
            path: "extraBody",
            message: "Local runner extraBody must be an object.",
            value,
        });
        return undefined;
    }
    const extraBody = {};
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
const mergeConfigRecords = (input) => {
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
export function normalizeLocalOpenAiCompatibleRunnerConfig(input = {}) {
    const issues = [];
    const merged = mergeConfigRecords(input);
    const nestedAgent = isRecord(merged.agent) ? merged.agent : {};
    const originalAdapter = asString(input.adapter) ?? asString(merged.adapter) ?? asString(nestedAgent.adapter);
    const adapter = normalizeLocalOpenAiCompatibleAdapter(originalAdapter);
    const isLocalOpenAiCompatible = adapter !== undefined;
    const rawRunnerKind = merged.runnerKind;
    const normalizedRunnerKind = normalizeLocalRunnerKind(rawRunnerKind);
    const runnerKind = normalizedRunnerKind ??
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
    const authMode = normalizeLocalRunnerAuthMode(rawAuthMode) ?? (isLocalOpenAiCompatible ? "none" : undefined);
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
    if (rawResponseFormatStrategy !== undefined &&
        normalizeLocalRunnerResponseFormatStrategy(rawResponseFormatStrategy) === undefined) {
        pushIssue(issues, {
            code: "invalid_response_format_strategy",
            path: "responseFormatStrategy",
            message: "Unknown local runner response format strategy.",
            value: rawResponseFormatStrategy,
        });
    }
    const dummyBearerToken = readString(merged, ["dummyBearerToken", "dummyApiKey"]);
    const config = {
        baseUrl: readString(merged, ["baseUrl", "endpoint", "apiBaseUrl"]),
        endpoint: readString(merged, ["endpoint"]),
        apiBaseUrl: readString(merged, ["apiBaseUrl"]),
        runnerKind,
        authMode,
        dummyBearerToken: authMode === "dummy-bearer" ? dummyBearerToken ?? "local" : dummyBearerToken,
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
export function validateLocalOpenAiCompatibleRunnerConfig(config) {
    return normalizeLocalOpenAiCompatibleRunnerConfig({
        adapter: LOCAL_OPENAI_COMPATIBLE_ADAPTER,
        config,
    }).issues;
}
//# sourceMappingURL=LocalRunnerConfig.js.map