import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
import { cliHealthy, runCodexExec, runCodexExecStream } from "./CodexCliRunner.js";

const extractOutputSchema = (request: InvocationRequest): Record<string, unknown> | undefined => {
  const candidate = request.metadata?.outputSchema;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  return candidate as Record<string, unknown>;
};

const extractTimeoutMs = (request: InvocationRequest): number | undefined => {
  const candidate = request.metadata?.timeoutMs;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    return undefined;
  }
  return Math.floor(candidate);
};

export class CodexAdapter implements AgentAdapter {
  constructor(private config: AdapterConfig) {}

  async getCapabilities(): Promise<string[]> {
    return this.config.capabilities;
  }

  async healthCheck(): Promise<AgentHealth> {
    const started = Date.now();
    const result = cliHealthy();
    return {
      agentId: this.config.agent.id,
      status: result.ok ? "healthy" : "unreachable",
      lastCheckedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      details: { adapter: "codex-cli", ...result.details },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const health = cliHealthy(true);
    const cliDetails = health.details;
    const result = await runCodexExec(
      request.input,
      this.config.model,
      extractOutputSchema(request),
      extractTimeoutMs(request),
    );
    return {
      output: result.output,
      adapter: this.config.adapter ?? "codex-cli",
      model: this.config.model,
      metadata: {
        mode: "cli",
        capabilities: this.config.capabilities,
        adapterType: this.config.adapter ?? "codex-cli",
        authMode: "cli",
        cli: cliDetails,
        raw: result.raw,
      },
    };
  }

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
    const health = cliHealthy(true);
    const cliDetails = health.details;
    for await (const chunk of runCodexExecStream(
      request.input,
      this.config.model,
      extractOutputSchema(request),
      extractTimeoutMs(request),
    )) {
      yield {
        output: chunk.output,
        adapter: this.config.adapter ?? "codex-cli",
        model: this.config.model,
        metadata: {
          mode: "cli",
          capabilities: this.config.capabilities,
          adapterType: this.config.adapter ?? "codex-cli",
          authMode: "cli",
          cli: cliDetails,
          raw: chunk.raw,
          streaming: true,
        },
      };
    }
  }
}
