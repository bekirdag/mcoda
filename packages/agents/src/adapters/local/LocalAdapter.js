export class LocalAdapter {
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
            latencyMs: 0,
            details: { adapter: "local-model", model: this.config.model },
        };
    }
    async invoke(request) {
        return {
            output: `local-stub:${request.input}`,
            adapter: this.config.adapter ?? "local-model",
            model: this.config.model,
            metadata: {
                mode: "local",
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "local-model",
                authMode: "local",
            },
        };
    }
    async *invokeStream(request) {
        yield {
            output: `local-stream:${request.input}`,
            adapter: this.config.adapter ?? "local-model",
            model: this.config.model,
            metadata: { mode: "local", streaming: true },
        };
    }
}
