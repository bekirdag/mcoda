export declare const cliHealthy: (throwOnError?: boolean) => {
    ok: boolean;
    details?: Record<string, unknown>;
};
export declare const runCodexExec: (prompt: string, model?: string, outputSchema?: Record<string, unknown>, timeoutMs?: number, reasoningEffort?: string) => Promise<{
    output: string;
    raw: string;
}>;
export declare function runCodexExecStream(prompt: string, model?: string, outputSchema?: Record<string, unknown>, timeoutMs?: number, reasoningEffort?: string): AsyncGenerator<{
    output: string;
    raw: string;
}, void, unknown>;
//# sourceMappingURL=CodexCliRunner.d.ts.map
