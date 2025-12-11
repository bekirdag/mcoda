import { AgentHealth } from "@mcoda/shared";
import { spawnSync } from "node:child_process";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";

const cliHealthy = (): { ok: boolean; details?: Record<string, unknown> } => {
  if (process.env.MCODA_SKIP_CLI_CHECKS === "1") {
    return { ok: true, details: { skipped: true } };
  }
  const result = spawnSync("gemini", ["--version"], { encoding: "utf8" });
  if (result.error) {
    return { ok: false, details: { reason: "missing_cli", error: result.error.message } };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      details: { reason: "cli_error", exitCode: result.status, stderr: result.stderr?.toString() },
    };
  }
  return { ok: true, details: { version: result.stdout?.toString().trim() } };
};

const assertCliHealthy = (): Record<string, unknown> | undefined => {
  const result = cliHealthy();
  if (!result.ok) {
    const error = new Error(`AUTH_ERROR: gemini CLI unavailable (${result.details?.reason ?? "unknown"})`);
    (error as any).details = result.details;
    throw error;
  }
  return result.details;
};

export class GeminiAdapter implements AgentAdapter {
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
      details: { adapter: "gemini-cli", ...result.details },
    };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const cliDetails = assertCliHealthy();
    const authMode = "cli";
    return {
      output: `gemini-stub:${request.input}`,
      adapter: this.config.adapter ?? "gemini-cli",
      model: this.config.model,
      metadata: {
        mode: authMode,
        capabilities: this.config.capabilities,
        adapterType: this.config.adapter ?? "gemini-cli",
        authMode,
        cli: cliDetails,
      },
    };
  }

  async *invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown> {
    const cliDetails = assertCliHealthy();
    yield {
      output: `gemini-stream:${request.input}`,
      adapter: this.config.adapter ?? "gemini-cli",
      model: this.config.model,
      metadata: {
        mode: "cli",
        streaming: true,
        cli: cliDetails,
      },
    };
  }
}
