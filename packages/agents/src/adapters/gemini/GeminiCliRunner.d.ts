export declare const geminiHealthy: (throwOnError?: boolean) => {
    ok: boolean;
    details?: Record<string, unknown>;
};
export declare const runGeminiExec: (prompt: string, model?: string) => {
    output: string;
    raw: string;
};
export declare function runGeminiExecStream(prompt: string, model?: string): AsyncGenerator<{
    output: string;
    raw: string;
}, void, unknown>;
//# sourceMappingURL=GeminiCliRunner.d.ts.map