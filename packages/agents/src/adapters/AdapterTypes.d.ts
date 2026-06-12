import type { Agent, AgentAuthMetadata, AgentHealth, AgentPromptManifest, LocalOpenAiCompatibleRunnerConfig, LocalRunnerAuthMode, LocalRunnerKind, LocalRunnerResponseFormatStrategy } from "@mcoda/shared";
export interface AdapterConfig {
    agent: Agent;
    capabilities: string[];
    model?: string;
    apiKey?: string;
    provider?: string;
    baseUrl?: string;
    docdexBaseUrl?: string;
    docdexRepoId?: string;
    docdexRepoRoot?: string;
    docdex?: DocdexRuntimeContext;
    prompts?: AgentPromptManifest;
    authMetadata?: AgentAuthMetadata;
    adapter?: string;
    localRunner?: LocalOpenAiCompatibleRunnerConfig;
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
export interface DocdexRuntimeContext {
    enabled?: boolean;
    baseUrl?: string;
    repoId?: string;
    repoRoot?: string;
    dagSessionId?: string;
    required?: boolean;
    allowedOperations?: string[];
    credentialSource?: "attached_mswarm_api_key" | string;
    capabilities?: Record<string, boolean | undefined>;
    initialize?: boolean;
    allowWeb?: boolean;
    allowMemoryWrite?: boolean;
    allowProfileWrite?: boolean;
    allowIndexRebuild?: boolean;
}
export interface AgentAdapter {
    getCapabilities(): Promise<string[]>;
    healthCheck(): Promise<AgentHealth>;
    invoke?(request: InvocationRequest): Promise<InvocationResult>;
    invokeStream?(_input: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown>;
}
export interface InvocationRequest {
    input: string;
    adapterType?: string;
    authMode?: "api" | "cli" | "local" | "none";
    metadata?: Record<string, unknown>;
}
export interface InvocationResult {
    output: string;
    adapter: string;
    model?: string;
    metadata?: Record<string, unknown>;
}
//# sourceMappingURL=AdapterTypes.d.ts.map