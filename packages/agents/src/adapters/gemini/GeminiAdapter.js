import { geminiHealthy, runGeminiExec, runGeminiExecStream } from "./GeminiCliRunner.js";
export class GeminiAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        const started = Date.now();
        const result = geminiHealthy();
        return {
            agentId: this.config.agent.id,
            status: result.ok ? "healthy" : "unreachable",
            lastCheckedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
            details: { adapter: "gemini-cli", ...result.details },
        };
    }
    async invoke(request) {
        const details = geminiHealthy(true).details;
        const result = runGeminiExec(request.input, this.config.model);
        return {
            output: result.output,
            adapter: this.config.adapter ?? "gemini-cli",
            model: this.config.model,
            metadata: {
                mode: "cli",
                capabilities: this.config.capabilities,
                adapterType: this.config.adapter ?? "gemini-cli",
                authMode: "cli",
                cli: details,
                raw: result.raw,
            },
        };
    }
    async *invokeStream(request) {
        const details = geminiHealthy(true).details;
        for await (const chunk of runGeminiExecStream(request.input, this.config.model)) {
            yield {
                output: chunk.output,
                adapter: this.config.adapter ?? "gemini-cli",
                model: this.config.model,
                metadata: {
                    mode: "cli",
                    streaming: true,
                    cli: details,
                    raw: chunk.raw,
                },
            };
        }
    }
}
