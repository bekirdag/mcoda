import { cliHealthy as codexCliHealthy, runCodexExec, runCodexExecStream } from "../codex/CodexCliRunner.js";
export class OpenAiCliAdapter {
    constructor(config) {
        this.config = config;
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        const started = Date.now();
        const result = codexCliHealthy();
        return {
            agentId: this.config.agent.id,
            status: result.ok ? "healthy" : "unreachable",
            lastCheckedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
            details: { adapter: "codex-cli", ...result.details },
        };
    }
    async invoke(request) {
        const cliDetails = codexCliHealthy(true);
        const result = await runCodexExec(request.input, this.config.model);
        return {
            output: result.output,
            adapter: this.config.adapter ?? "codex-cli",
            model: this.config.model,
            metadata: {
                mode: "cli",
                capabilities: this.config.capabilities,
                prompts: this.config.prompts,
                adapterType: this.config.adapter ?? "codex-cli",
                cli: cliDetails.details,
                raw: result.raw,
            },
        };
    }
    async *invokeStream(request) {
        const health = codexCliHealthy(true);
        const cliDetails = health.details;
        for await (const chunk of runCodexExecStream(request.input, this.config.model)) {
            yield {
                output: chunk.output,
                adapter: this.config.adapter ?? "codex-cli",
                model: this.config.model,
                metadata: {
                    mode: "cli",
                    capabilities: this.config.capabilities,
                    prompts: this.config.prompts,
                    adapterType: this.config.adapter ?? "codex-cli",
                    cli: cliDetails,
                    raw: chunk.raw,
                    streaming: true,
                },
            };
        }
    }
}
