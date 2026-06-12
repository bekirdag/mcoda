export declare const ollamaHealthy: (throwOnError?: boolean) => {
    ok: boolean;
    details?: Record<string, unknown>;
};
export declare const runOllamaExec: (prompt: string, model?: string) => {
    output: string;
    raw: string;
};
export declare function runOllamaExecStream(prompt: string, model?: string): AsyncGenerator<{
    output: string;
    raw: string;
}, void, unknown>;
//# sourceMappingURL=OllamaCliRunner.d.ts.map