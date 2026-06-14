import { cliHealthy, runCodexExec, runCodexExecStream } from "./CodexCliRunner.js";
const extractOutputSchema = (request) => {
    const candidate = request.metadata?.outputSchema;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return undefined;
    }
    return candidate;
};
const extractTimeoutMs = (request) => {
    const candidate = request.metadata?.timeoutMs;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
        return undefined;
    }
    return Math.floor(candidate);
};
const extractReasoningEffort = (config) => {
    const candidate = config.reasoningEffort;
    if (typeof candidate !== "string")
        return undefined;
    const trimmed = candidate.trim();
    return trimmed ? trimmed : undefined;
};
export class CodexAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        const started = Date.now();
        const result = cliHealthy();
        return {
            agentId: this.config.agent.id,
            status: result.ok ? "healthy" : "unreachable",
            lastCheckedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
            details: { adapter: "codex-cli", ...result.details },
        };
    }
    async invoke(request) {
        const health = cliHealthy(true);
        const cliDetails = health.details;
        const result = await runCodexExec(request.input, this.config.model, extractOutputSchema(request), extractTimeoutMs(request), extractReasoningEffort(this.config));
        return {
            output: result.output,
            adapter: this.config.adapter ?? "codex-cli",
            model: this.config.model,
            metadata: {
                mode: "cli",
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "codex-cli",
                authMode: "cli",
                cli: cliDetails,
                raw: result.raw,
            },
        };
    }
    async *invokeStream(request) {
        const health = cliHealthy(true);
        const cliDetails = health.details;
        for await (const chunk of runCodexExecStream(request.input, this.config.model, extractOutputSchema(request), extractTimeoutMs(request), extractReasoningEffort(this.config))) {
            yield {
                output: chunk.output,
                adapter: this.config.adapter ?? "codex-cli",
                model: this.config.model,
                metadata: {
                    mode: "cli",
                    capabilities: this.config.capabilities,
                    adapterType: this.config.adapter ?? "codex-cli",
                    authMode: "cli",
                    cli: cliDetails,
                    raw: chunk.raw,
                    streaming: true,
                },
            };
        }
    }
}
