export class QaAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        return {
            agentId: this.config.agent.id,
            status: "healthy",
            lastCheckedAt: new Date().toISOString(),
            details: { adapter: "qa-cli" },
        };
    }
    async invoke(request) {
        return {
            output: `qa-stub:${request.input}`,
            adapter: this.config.adapter ?? "qa-cli",
            model: this.config.model,
            metadata: {
                mode: "cli",
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "qa-cli",
                authMode: "cli",
            },
        };
    }
    async *invokeStream(request) {
        yield {
            output: `qa-stream:${request.input}`,
            adapter: this.config.adapter ?? "qa-cli",
            model: this.config.model,
            metadata: { mode: "cli", streaming: true },
        };
    }
}
