export class GeminiAdapter {
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
            details: { adapter: "gemini-cli" },
        };
    }
    async invoke(request) {
        const authMode = this.config.apiKey ? "api" : "cli";
        return {
            output: `gemini-stub:${request.input}`,
            adapter: this.config.adapter ?? "gemini-cli",
            model: this.config.model,
            metadata: {
                mode: authMode,
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "gemini-cli",
                authMode,
            },
        };
    }
    async *invokeStream(request) {
        yield {
            output: `gemini-stream:${request.input}`,
            adapter: this.config.adapter ?? "gemini-cli",
            model: this.config.model,
            metadata: {
                mode: this.config.apiKey ? "api" : "cli",
                streaming: true,
            },
        };
    }
}
