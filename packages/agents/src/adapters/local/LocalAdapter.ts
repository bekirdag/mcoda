import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";

export class LocalAdapter implements AgentAdapter {
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
      details: { adapter: "local-model", model: this.config.model },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
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

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
    yield {
      output: `local-stream:${request.input}`,
      adapter: this.config.adapter ?? "local-model",
      model: this.config.model,
      metadata: { mode: "local", streaming: true },
    };
  }
}
