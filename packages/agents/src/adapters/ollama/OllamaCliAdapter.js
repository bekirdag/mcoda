import { ollamaHealthy, runOllamaExec, runOllamaExecStream } from "./OllamaCliRunner.js";
export class OllamaCliAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        const started = Date.now();
        const health = ollamaHealthy();
        const status = health.ok ? "healthy" : "unreachable";
        return {
            agentId: this.config.agent.id,
            status,
            lastCheckedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
            details: { adapter: "ollama-cli", ...(health.details ?? {}) },
        };
    }
    async invoke(request) {
        const result = runOllamaExec(request.input, this.config.model);
        return {
            output: result.output,
            adapter: this.config.adapter ?? "ollama-cli",
            model: this.config.model,
            metadata: {
                mode: "cli",
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "ollama-cli",
                authMode: "cli",
                raw: result.raw,
            },
        };
    }
    async *invokeStream(request) {
        for await (const chunk of runOllamaExecStream(request.input, this.config.model)) {
            yield {
                output: chunk.output,
                adapter: this.config.adapter ?? "ollama-cli",
                model: this.config.model,
                metadata: {
                    mode: "cli",
                    capabilities: this.config.capabilities,
                    adapterType: this.config.adapter ?? "ollama-cli",
                    authMode: "cli",
                    raw: chunk.raw,
                    streaming: true,
                },
            };
        }
    }
}
