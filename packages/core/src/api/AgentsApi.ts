import {
  Agent,
  AgentAuthMetadata,
  AgentHealth,
  AgentPromptManifest,
  CreateAgentInput,
  UpdateAgentInput,
  CryptoHelper,
} from "@mcoda/shared";
import { AgentRunRatingRow, GlobalCommandRun, GlobalRepository } from "@mcoda/db";
import { AgentService, InvocationResult } from "@mcoda/agents";
import { RoutingService } from "../services/agents/RoutingService.js";

export interface AgentResponse extends Agent {
  capabilities: string[];
  prompts?: AgentPromptManifest;
  health?: AgentHealth;
  auth?: AgentAuthMetadata;
  models?: Agent["models"];
}

export class AgentsApi {
  constructor(private repo: GlobalRepository, private agentService: AgentService, private routingService: RoutingService) {}

  static async create(): Promise<AgentsApi> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const routingService = await RoutingService.create();
    return new AgentsApi(repo, agentService, routingService);
  }

  async close(): Promise<void> {
    await this.repo.close();
    if ((this.routingService as any)?.close) {
      await (this.routingService as any).close();
    }
  }

  private async resolveAgent(idOrSlug: string): Promise<Agent> {
    return this.agentService.resolveAgent(idOrSlug);
  }

  private async withCommandRun<T>(
    commandName: string,
    payload: Record<string, unknown> | undefined,
    fn: (run: GlobalCommandRun) => Promise<T>,
  ): Promise<T> {
    const run = await this.repo.createCommandRun({
      commandName,
      startedAt: new Date().toISOString(),
      status: "running",
      payload,
    });
    try {
      const result = await fn(run);
      await this.repo.completeCommandRun(run.id, {
        status: "succeeded",
        completedAt: new Date().toISOString(),
        exitCode: 0,
        result: payload ? { payload, output: result } : { output: result },
      });
      return result;
    } catch (error) {
      await this.repo.completeCommandRun(run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        exitCode: 1,
        errorSummary: (error as Error).message,
      });
      throw error;
    }
  }

  async listAgents(): Promise<AgentResponse[]> {
    const agents = await this.repo.listAgents();
    const health = await this.repo.listAgentHealthSummary();
    const healthById = new Map(health.map((h) => [h.agentId, h]));
    const results: AgentResponse[] = [];
    for (const agent of agents) {
      const [capabilities, models] = await Promise.all([
        this.repo.getAgentCapabilities(agent.id),
        this.repo.getAgentModels(agent.id),
      ]);
      results.push({
        ...agent,
        capabilities,
        models,
        health: healthById.get(agent.id),
      });
    }
    return results;
  }

  async listAgentRunRatings(idOrSlug: string, limit = 50): Promise<AgentRunRatingRow[]> {
    const agent = await this.resolveAgent(idOrSlug);
    return this.repo.listAgentRunRatings(agent.id, limit);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentResponse> {
    return this.withCommandRun("agent.add", { slug: input.slug, adapter: input.adapter }, async () => {
      const agent = await this.repo.createAgent(input);
      const [capabilities, models] = await Promise.all([
        this.repo.getAgentCapabilities(agent.id),
        this.repo.getAgentModels(agent.id),
      ]);
      return { ...agent, capabilities, models };
    });
  }

  async getAgent(idOrSlug: string): Promise<AgentResponse> {
    const agent = await this.resolveAgent(idOrSlug);
    const [capabilities, prompts, health, auth, models] = await Promise.all([
      this.repo.getAgentCapabilities(agent.id),
      this.repo.getAgentPrompts(agent.id),
      this.repo.getAgentHealth(agent.id),
      this.repo.getAgentAuthMetadata(agent.id),
      this.repo.getAgentModels(agent.id),
    ]);
    return { ...agent, capabilities, prompts, health, auth, models };
  }

  async updateAgent(idOrSlug: string, patch: UpdateAgentInput): Promise<AgentResponse> {
    const agent = await this.resolveAgent(idOrSlug);
    return this.withCommandRun("agent.update", { id: agent.id, patch }, async () => {
      const updated = await this.repo.updateAgent(agent.id, patch);
      const [capabilities, models] = await Promise.all([
        this.repo.getAgentCapabilities(agent.id),
        this.repo.getAgentModels(agent.id),
      ]);
      return { ...(updated as Agent), capabilities, models };
    });
  }

  async deleteAgent(idOrSlug: string, force = false): Promise<void> {
    const agent = await this.resolveAgent(idOrSlug);
    if (!force) {
      const refs = await this.repo.findWorkspaceReferences(agent.id);
      if (refs.length > 0) {
        const details = refs
          .map((r) => `${r.workspaceId === "__GLOBAL__" ? "global" : r.workspaceId}:${r.commandName}`)
          .join(", ");
        throw new Error(
          `Agent is referenced by routing defaults (${details}); re-run with --force to delete`,
        );
      }
    }
    await this.withCommandRun("agent.delete", { id: agent.id, slug: agent.slug }, async () => {
      await this.repo.deleteAgent(agent.id);
    });
  }

  async setAgentAuth(idOrSlug: string, secret: string): Promise<AgentAuthMetadata> {
    const agent = await this.resolveAgent(idOrSlug);
    return this.withCommandRun("agent.auth.set", { id: agent.id }, async () => {
      const encrypted = await CryptoHelper.encryptSecret(secret);
      await this.repo.setAgentAuth(agent.id, encrypted);
      return this.repo.getAgentAuthMetadata(agent.id);
    });
  }

  async getAgentPrompts(idOrSlug: string): Promise<AgentPromptManifest | undefined> {
    const agent = await this.resolveAgent(idOrSlug);
    return this.repo.getAgentPrompts(agent.id);
  }

  async testAgent(idOrSlug: string): Promise<AgentHealth> {
    const agent = await this.resolveAgent(idOrSlug);
    return this.withCommandRun("agent.test", { id: agent.id, slug: agent.slug }, async (run) => {
      const health = await this.agentService.healthCheck(agent.id);
      await this.repo.recordTokenUsage({
        agentId: agent.id,
        commandRunId: run.id,
        modelName: agent.defaultModel,
        commandName: "agent.test",
        action: "health_check",
        tokensPrompt: 0,
        tokensCompletion: 0,
        tokensTotal: 0,
        timestamp: new Date().toISOString(),
        metadata: { reason: "agent.test", healthStatus: health.status, phase: "health_check", attempt: 1 },
      });
      return health;
    });
  }

  async probeAgent(
    idOrSlug: string,
    prompt = "Hello from mcoda test-agent. Please reply with a short acknowledgement.",
  ): Promise<{ health: AgentHealth; response: InvocationResult; prompt: string }> {
    const agent = await this.resolveAgent(idOrSlug);
    const trimmedPrompt = prompt.trim() || "Hello from mcoda test-agent. Please reply with a short acknowledgement.";
    return this.withCommandRun(
      "agent.test",
      { id: agent.id, slug: agent.slug, prompt: trimmedPrompt },
      async (run) => {
        const health = await this.agentService.healthCheck(agent.id);
        const startedAtMs = Date.now();
        const startedAt = new Date(startedAtMs).toISOString();
        const response = await this.agentService.invoke(agent.id, {
          input: trimmedPrompt,
          metadata: { command: "test-agent" },
        });
        const finishedAtMs = Date.now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        const durationMs = finishedAtMs - startedAtMs;
        const durationSeconds = durationMs / 1000;
        const usage = this.extractTokenUsage(response.metadata as Record<string, unknown> | undefined);
        const telemetry = this.extractTelemetryInfo(response.metadata as Record<string, unknown> | undefined);
        const resolvedDurationMs = usage.durationMs ?? durationMs;
        const resolvedDurationSeconds = resolvedDurationMs !== undefined ? resolvedDurationMs / 1000 : durationSeconds;
        const resolvedStartedAt = usage.startedAt ?? startedAt;
        const resolvedFinishedAt = usage.finishedAt ?? finishedAt;
        await this.repo.recordTokenUsage({
          agentId: agent.id,
          commandRunId: run.id,
          modelName: agent.defaultModel,
          commandName: "agent.test",
          action: "probe",
          invocationKind: telemetry.invocationKind,
          provider: telemetry.provider,
          currency: telemetry.currency,
          tokensPrompt: usage.tokensPrompt ?? 0,
          tokensCompletion: usage.tokensCompletion ?? 0,
          tokensTotal: usage.tokensTotal ?? 0,
          tokensCached: usage.tokensCached,
          tokensCacheRead: usage.tokensCacheRead,
          tokensCacheWrite: usage.tokensCacheWrite,
          durationSeconds: resolvedDurationSeconds,
          durationMs: resolvedDurationMs,
          startedAt: resolvedStartedAt,
          finishedAt: resolvedFinishedAt,
          timestamp: resolvedFinishedAt ?? new Date().toISOString(),
          metadata: {
            reason: "agent.test",
            healthStatus: health.status,
            adapter: response.adapter,
            phase: "probe",
            attempt: 1,
          },
        });
        return { health, response, prompt: trimmedPrompt };
      },
    );
  }

  private extractTokenUsage(metadata?: Record<string, unknown>): {
    tokensPrompt?: number;
    tokensCompletion?: number;
    tokensTotal?: number;
    tokensCached?: number;
    tokensCacheRead?: number;
    tokensCacheWrite?: number;
    durationMs?: number;
    startedAt?: string;
    finishedAt?: string;
  } {
    if (!metadata || typeof metadata !== "object") return {};
    const usage = typeof metadata.usage === "object" && metadata.usage ? (metadata.usage as Record<string, unknown>) : undefined;
    const promptDetails =
      typeof usage?.prompt_tokens_details === "object" && usage?.prompt_tokens_details
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    const cacheDetails = typeof usage?.cache === "object" && usage?.cache ? (usage.cache as Record<string, unknown>) : undefined;
    const toNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const toTimestamp = (value: unknown): string | undefined => {
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
      return undefined;
    };
    const tokensPrompt =
      toNumber(metadata.tokensPrompt) ??
      toNumber(metadata.tokens_prompt) ??
      toNumber(usage?.prompt_tokens) ??
      toNumber(usage?.promptTokens) ??
      toNumber(usage?.prompt_tokens);
    const tokensCompletion =
      toNumber(metadata.tokensCompletion) ??
      toNumber(metadata.tokens_completion) ??
      toNumber(usage?.completion_tokens) ??
      toNumber(usage?.completionTokens) ??
      toNumber(usage?.completion_tokens);
    let tokensTotal =
      toNumber(metadata.tokensTotal) ??
      toNumber(metadata.tokens_total) ??
      toNumber(usage?.total_tokens) ??
      toNumber(usage?.totalTokens) ??
      toNumber(usage?.total_tokens);
    if (tokensTotal === undefined && tokensPrompt !== undefined && tokensCompletion !== undefined) {
      tokensTotal = tokensPrompt + tokensCompletion;
    }
    const tokensCached =
      toNumber(metadata.tokensCached) ??
      toNumber(metadata.tokens_cached) ??
      toNumber(metadata.cachedTokens) ??
      toNumber(metadata.cached_tokens) ??
      toNumber(usage?.cached_tokens) ??
      toNumber(usage?.cachedTokens) ??
      toNumber(promptDetails?.cached_tokens) ??
      toNumber(promptDetails?.cachedTokens) ??
      toNumber(cacheDetails?.cached_tokens) ??
      toNumber(cacheDetails?.cachedTokens);
    const tokensCacheRead =
      toNumber(metadata.tokensCacheRead) ??
      toNumber(metadata.tokens_cache_read) ??
      toNumber(metadata.cacheRead) ??
      toNumber(metadata.cache_read) ??
      toNumber(usage?.tokens_cache_read) ??
      toNumber(usage?.cache_read) ??
      toNumber(usage?.cacheRead) ??
      toNumber(promptDetails?.cache_read) ??
      toNumber(promptDetails?.cacheRead) ??
      toNumber(cacheDetails?.cache_read) ??
      toNumber(cacheDetails?.cacheRead);
    const tokensCacheWrite =
      toNumber(metadata.tokensCacheWrite) ??
      toNumber(metadata.tokens_cache_write) ??
      toNumber(metadata.cacheWrite) ??
      toNumber(metadata.cache_write) ??
      toNumber(usage?.tokens_cache_write) ??
      toNumber(usage?.cache_write) ??
      toNumber(usage?.cacheWrite) ??
      toNumber(promptDetails?.cache_write) ??
      toNumber(promptDetails?.cacheWrite) ??
      toNumber(cacheDetails?.cache_write) ??
      toNumber(cacheDetails?.cacheWrite);
    const durationSeconds =
      toNumber(metadata.durationSeconds) ??
      toNumber(metadata.duration_seconds);
    const durationMs =
      toNumber(metadata.durationMs) ??
      toNumber(metadata.duration_ms) ??
      toNumber(metadata.elapsed_ms) ??
      toNumber(metadata.latency_ms) ??
      toNumber(metadata.latencyMs) ??
      toNumber(usage?.duration_ms) ??
      (durationSeconds !== undefined ? durationSeconds * 1000 : undefined);
    const startedAt =
      toTimestamp(metadata.startedAt) ??
      toTimestamp(metadata.started_at) ??
      toTimestamp(metadata.startTime) ??
      toTimestamp(metadata.start_time);
    const finishedAt =
      toTimestamp(metadata.finishedAt) ??
      toTimestamp(metadata.finished_at) ??
      toTimestamp(metadata.endTime) ??
      toTimestamp(metadata.end_time) ??
      toTimestamp(metadata.completed_at);
    return { tokensPrompt, tokensCompletion, tokensTotal, tokensCached, tokensCacheRead, tokensCacheWrite, durationMs, startedAt, finishedAt };
  }

  private extractTelemetryInfo(metadata?: Record<string, unknown>): {
    invocationKind?: string;
    provider?: string;
    currency?: string;
  } {
    if (!metadata || typeof metadata !== "object") return {};
    const toString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value : undefined;
    return {
      invocationKind: toString(metadata.invocationKind) ?? toString(metadata.invocation_kind),
      provider: toString(metadata.provider) ?? toString(metadata.vendor),
      currency: toString(metadata.currency),
    };
  }

  async runAgent(
    idOrSlug: string,
    prompts: string[],
    metadata?: Record<string, unknown>,
  ): Promise<{ agent: Pick<Agent, "id" | "slug">; prompts: string[]; responses: InvocationResult[] }> {
    const agent = await this.resolveAgent(idOrSlug);
    const cleaned = prompts.map((prompt) => prompt.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      throw new Error("No prompts provided.");
    }
    return this.withCommandRun(
      "agent.run",
      { id: agent.id, slug: agent.slug, promptCount: cleaned.length },
      async (run) => {
        const responses: InvocationResult[] = [];
        for (let index = 0; index < cleaned.length; index += 1) {
          const input = cleaned[index];
          const startedAtMs = Date.now();
          const startedAt = new Date(startedAtMs).toISOString();
          const response = await this.agentService.invoke(agent.id, {
            input,
            metadata: {
              command: "agent-run",
              promptIndex: index,
              ...metadata,
            },
          });
          const finishedAtMs = Date.now();
          const finishedAt = new Date(finishedAtMs).toISOString();
          const durationMs = finishedAtMs - startedAtMs;
          const durationSeconds = durationMs / 1000;
          const usage = this.extractTokenUsage(response.metadata as Record<string, unknown> | undefined);
          const telemetry = this.extractTelemetryInfo(response.metadata as Record<string, unknown> | undefined);
          const resolvedDurationMs = usage.durationMs ?? durationMs;
          const resolvedDurationSeconds = resolvedDurationMs !== undefined ? resolvedDurationMs / 1000 : durationSeconds;
          const resolvedStartedAt = usage.startedAt ?? startedAt;
          const resolvedFinishedAt = usage.finishedAt ?? finishedAt;
          await this.repo.recordTokenUsage({
            agentId: agent.id,
            commandRunId: run.id,
            modelName: response.model ?? agent.defaultModel,
            commandName: "agent.run",
            action: "invoke",
            invocationKind: telemetry.invocationKind,
            provider: telemetry.provider,
            currency: telemetry.currency,
            tokensPrompt: usage.tokensPrompt,
            tokensCompletion: usage.tokensCompletion,
            tokensTotal: usage.tokensTotal,
            tokensCached: usage.tokensCached,
            tokensCacheRead: usage.tokensCacheRead,
            tokensCacheWrite: usage.tokensCacheWrite,
            durationSeconds: resolvedDurationSeconds,
            durationMs: resolvedDurationMs,
            startedAt: resolvedStartedAt,
            finishedAt: resolvedFinishedAt,
            timestamp: resolvedFinishedAt ?? new Date().toISOString(),
            metadata: {
              reason: "agent.run",
              adapter: response.adapter,
              promptIndex: index,
              phase: "agent_run",
              attempt: 1,
            },
          });
          responses.push(response);
        }
        return { agent: { id: agent.id, slug: agent.slug }, prompts: cleaned, responses };
      },
    );
  }

  async setDefaultAgent(
    idOrSlug: string,
    workspaceId = "__GLOBAL__",
    commandName = "default",
  ): Promise<void> {
    const agent = await this.resolveAgent(idOrSlug);
    await this.withCommandRun("agent.set-default", { workspaceId, commandName, agent: agent.slug }, async () => {
      await this.routingService.updateWorkspaceDefaults(workspaceId, { set: { [commandName]: agent.slug } });
    });
  }
}
