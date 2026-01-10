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
        tokensPrompt: 0,
        tokensCompletion: 0,
        tokensTotal: 0,
        timestamp: new Date().toISOString(),
        metadata: { reason: "agent.test", healthStatus: health.status },
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
        const response = await this.agentService.invoke(agent.id, {
          input: trimmedPrompt,
          metadata: { command: "test-agent" },
        });
        await this.repo.recordTokenUsage({
          agentId: agent.id,
          commandRunId: run.id,
          modelName: agent.defaultModel,
          tokensPrompt: 0,
          tokensCompletion: 0,
          tokensTotal: 0,
          timestamp: new Date().toISOString(),
          metadata: { reason: "agent.test", healthStatus: health.status, adapter: response.adapter },
        });
        return { health, response, prompt: trimmedPrompt };
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
