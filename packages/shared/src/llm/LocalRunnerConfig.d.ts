export declare const LOCAL_OPENAI_COMPATIBLE_ADAPTER: "openai-compatible-local";
export declare const VLLM_LOCAL_ADAPTER: "vllm-local";
export declare const LLAMA_CPP_LOCAL_ADAPTER: "llama-cpp-local";
export declare const LEGACY_LLAMACPP_LOCAL_ADAPTER: "llamacpp-local";
export declare const LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES: readonly ["openai-compatible-local", "vllm-local", "llama-cpp-local", "llamacpp-local"];
export type LocalOpenAiCompatibleAdapter = (typeof LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES)[number];
export type LocalRunnerKind = "vllm" | "llama-cpp" | "llama-cpp-python" | "lm-studio" | "localai" | "sglang" | "tgi" | "custom";
export type LocalRunnerAuthMode = "none" | "bearer" | "dummy-bearer";
export type LocalRunnerResponseFormatStrategy = "openai" | "json-object" | "json-schema" | "gbnf" | "prompt-only" | "none";
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
export type LocalRunnerConfigIssueCode = "invalid_auth_mode" | "invalid_runner_kind" | "invalid_response_format_strategy" | "invalid_headers" | "invalid_header_value" | "secret_header" | "invalid_extra_body" | "reserved_extra_body_key";
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
export declare const LOCAL_RUNNER_SECRET_HEADER_KEYS: readonly ["authorization", "proxy-authorization", "x-api-key", "api-key"];
export declare const LOCAL_RUNNER_RESERVED_EXTRA_BODY_KEYS: readonly ["model", "messages", "stream", "tools", "tool_choice", "response_format", "max_tokens", "temperature"];
export declare function isLocalOpenAiCompatibleAdapter(adapter: unknown): boolean;
export declare function normalizeLocalOpenAiCompatibleAdapter(adapter: unknown): typeof LOCAL_OPENAI_COMPATIBLE_ADAPTER | undefined;
export declare function defaultLocalRunnerKindForAdapter(adapter: unknown): LocalRunnerKind | undefined;
export declare function normalizeLocalRunnerKind(value: unknown): LocalRunnerKind | undefined;
export declare function normalizeLocalRunnerAuthMode(value: unknown): LocalRunnerAuthMode | undefined;
export declare function normalizeLocalRunnerResponseFormatStrategy(value: unknown): LocalRunnerResponseFormatStrategy | undefined;
export declare function isSecretLocalRunnerHeaderKey(key: string): boolean;
export declare function isReservedLocalRunnerExtraBodyKey(key: string): boolean;
export declare function normalizeLocalOpenAiCompatibleRunnerConfig(input?: LocalRunnerNormalizationInput): NormalizedLocalOpenAiCompatibleRunnerConfig;
export declare function validateLocalOpenAiCompatibleRunnerConfig(config: LocalOpenAiCompatibleRunnerConfig): LocalRunnerConfigIssue[];
//# sourceMappingURL=LocalRunnerConfig.d.ts.map