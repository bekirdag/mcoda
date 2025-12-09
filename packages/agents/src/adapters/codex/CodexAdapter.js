export class CodexAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        // CLI-based adapter can operate without stored secrets.
        return {
            agentId: this.config.agent.id,
            status: "healthy",
            lastCheckedAt: new Date().toISOString(),
            latencyMs: 0,
            details: { adapter: "codex-cli" },
        };
    }
    async invoke(request) {
        const authMode = this.config.apiKey ? "api" : "cli";
        return {
            output: `codex-stub:${request.input}`,
            adapter: this.config.adapter ?? "codex-cli",
            model: this.config.model,
            metadata: {
                mode: authMode,
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "codex-cli",
                authMode,
            },
        };
    }
    async *invokeStream(request) {
        yield {
            output: `codex-stream:${request.input}`,
            adapter: this.config.adapter ?? "codex-cli",
            model: this.config.model,
            metadata: {
                mode: this.config.apiKey ? "api" : "cli",
                streaming: true,
            },
        };
    }
}
