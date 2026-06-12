import { claudeHealthy, runClaudeExec, runClaudeExecStream } from "./ClaudeCliRunner.js";
export class ClaudeAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        const started = Date.now();
        const health = claudeHealthy();
        return {
            agentId: this.config.agent.id,
            status: health.ok ? "healthy" : "unreachable",
            lastCheckedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
            details: { adapter: "claude-cli", ...(health.details ?? {}) },
        };
    }
    async invoke(request) {
        const cliDetails = claudeHealthy(true).details;
        const result = runClaudeExec(request.input, this.config.model);
        return {
            output: result.output,
            adapter: this.config.adapter ?? "claude-cli",
            model: this.config.model,
            metadata: {
                mode: "cli",
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "claude-cli",
                authMode: "cli",
                cli: cliDetails,
                raw: result.raw,
            },
        };
    }
    async *invokeStream(request) {
        const cliDetails = claudeHealthy(true).details;
        for await (const chunk of runClaudeExecStream(request.input, this.config.model)) {
            yield {
                output: chunk.output,
                adapter: this.config.adapter ?? "claude-cli",
                model: this.config.model,
                metadata: {
                    mode: "cli",
                    capabilities: this.config.capabilities,
                    adapterType: this.config.adapter ?? "claude-cli",
                    authMode: "cli",
                    cli: cliDetails,
                    raw: chunk.raw,
                    streaming: true,
                },
            };
        }
    }
}
