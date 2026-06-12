export declare const claudeHealthy: (throwOnError?: boolean) => {
    ok: boolean;
    details?: Record<string, unknown>;
};
export declare const runClaudeExec: (prompt: string, model?: string) => {
    output: string;
    raw: string;
};
export declare function runClaudeExecStream(prompt: string, model?: string): AsyncGenerator<{
    output: string;
    raw: string;
}, void, unknown>;
//# sourceMappingURL=ClaudeCliRunner.d.ts.map