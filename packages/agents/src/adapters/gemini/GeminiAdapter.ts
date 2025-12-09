import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";

export class GeminiAdapter implements AgentAdapter {
  constructor(private config: AdapterConfig) {}

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities;
  }

  async healthCheck(): Promise<AgentHealth> {
    return {
      agentId: this.config.agent.id,
      status: "healthy",
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 0,
      details: { adapter: "gemini-cli" },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
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

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
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
