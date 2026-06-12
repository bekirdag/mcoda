import type { LocalOpenAiCompatibleRunnerConfig, LocalRunnerAuthMode, LocalRunnerKind, LocalRunnerResponseFormatStrategy } from "@mcoda/shared";
export interface CodaliCliOptions {
    workspaceRoot: string;
    project?: string;
    command?: string;
    commandRunId?: string;
    jobId?: string;
    runId?: string;
    taskId?: string;
    taskKey?: string;
    agentId?: string;
    agentSlug?: string;
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
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
    docdexBaseUrl?: string;
    docdexRepoId?: string;
    docdexRepoRoot?: string;
    env?: Record<string, string>;
}
export declare const cliHealthy: (throwOnError?: boolean) => {
    ok: boolean;
    details?: Record<string, unknown>;
};
export declare const buildArgs: (options: CodaliCliOptions) => string[];
export declare const buildEnv: (options: CodaliCliOptions) => NodeJS.ProcessEnv;
export declare function runCodaliStream(input: string, options: CodaliCliOptions): AsyncGenerator<{
    output: string;
    meta?: Record<string, unknown>;
}>;
export declare const runCodaliExec: (input: string, options: CodaliCliOptions) => {
    output: string;
    raw: string;
    meta?: Record<string, unknown>;
};
//# sourceMappingURL=CodaliCliRunner.d.ts.map