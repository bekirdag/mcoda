import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";

export class QaAdapter implements AgentAdapter {
  constructor(private config: AdapterConfig) {}

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities;
  }

  async healthCheck(): Promise<AgentHealth> {
    return {
      agentId: this.config.agent.id,
      status: "healthy",
      lastCheckedAt: new Date().toISOString(),
      details: { adapter: "qa-cli" },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
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

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
    yield {
      output: `qa-stream:${request.input}`,
      adapter: this.config.adapter ?? "qa-cli",
      model: this.config.model,
      metadata: { mode: "cli", streaming: true },
    };
  }
}
