export class OpenAiAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        if (!this.config.apiKey) {
            return {
                agentId: this.config.agent.id,
                status: "unreachable",
                lastCheckedAt: new Date().toISOString(),
                details: { reason: "missing_api_key" },
            };
        }
        return {
            agentId: this.config.agent.id,
            status: "healthy",
            lastCheckedAt: new Date().toISOString(),
            latencyMs: 0,
            details: { adapter: "openai-api", model: this.config.model },
        };
    }
    async invoke(request) {
        const authMode = this.config.apiKey ? "api" : "none";
        return {
            output: `openai-stub:${request.input}`,
            adapter: this.config.adapter ?? "openai-api",
            model: this.config.model,
            metadata: {
                mode: authMode,
                capabilities: this.config.capabilities,
                prompts: this.config.prompts,
                authMode,
                adapterType: this.config.adapter ?? "openai-api",
            },
        };
    }
    async *invokeStream(request) {
        yield {
            output: `openai-stream:${request.input}`,
            adapter: this.config.adapter ?? "openai-api",
            model: this.config.model,
            metadata: {
                mode: this.config.apiKey ? "api" : "none",
                streaming: true,
            },
        };
    }
}
