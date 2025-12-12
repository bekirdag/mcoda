import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
import { geminiHealthy, runGeminiExec, runGeminiExecStream } from "./GeminiCliRunner.js";

export class GeminiAdapter implements AgentAdapter {
  constructor(private config: AdapterConfig) {}

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities;
  }

  async healthCheck(): Promise<AgentHealth> {
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

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
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

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
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
