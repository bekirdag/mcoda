import {
  Agent,
  AgentAuthMetadata,
  AgentHealth,
  AgentPromptManifest,
  CreateAgentInput,
  UpdateAgentInput,
  CryptoHelper,
} from "@mcoda/shared";
import { GlobalRepository } from "@mcoda/db";
import { AgentService } from "@mcoda/agents";
import { RoutingService } from "../services/agents/RoutingService.js";

export interface AgentResponse extends Agent {
  capabilities: string[];
  prompts?: AgentPromptManifest;
  health?: AgentHealth;
  auth?: AgentAuthMetadata;
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

  async listAgents(): Promise<AgentResponse[]> {
    const agents = await this.repo.listAgents();
    const health = await this.repo.listAgentHealthSummary();
    const healthById = new Map(health.map((h) => [h.agentId, h]));
    const results: AgentResponse[] = [];
    for (const agent of agents) {
      const capabilities = await this.repo.getAgentCapabilities(agent.id);
      results.push({
        ...agent,
        capabilities,
        health: healthById.get(agent.id),
      });
    }
    return results;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentResponse> {
    const agent = await this.repo.createAgent(input);
    const capabilities = await this.repo.getAgentCapabilities(agent.id);
    return { ...agent, capabilities };
  }

  async getAgent(idOrSlug: string): Promise<AgentResponse> {
    const agent = await this.resolveAgent(idOrSlug);
    const [capabilities, prompts, health, auth] = await Promise.all([
      this.repo.getAgentCapabilities(agent.id),
      this.repo.getAgentPrompts(agent.id),
      this.repo.getAgentHealth(agent.id),
      this.repo.getAgentAuthMetadata(agent.id),
    ]);
    return { ...agent, capabilities, prompts, health, auth };
  }

  async updateAgent(idOrSlug: string, patch: UpdateAgentInput): Promise<AgentResponse> {
    const agent = await this.resolveAgent(idOrSlug);
    const updated = await this.repo.updateAgent(agent.id, patch);
    const capabilities = await this.repo.getAgentCapabilities(agent.id);
    return { ...(updated as Agent), capabilities };
  }

  async deleteAgent(idOrSlug: string, force = false): Promise<void> {
    const agent = await this.resolveAgent(idOrSlug);
    if (!force) {
      const refs = await this.repo.findWorkspaceReferences(agent.id);
      if (refs.length > 0) {
        const details = refs.map((r) => `${r.workspaceId}:${r.commandName}`).join(", ");
        throw new Error(
          `Agent is referenced by workspace defaults (${details}); re-run with --force to delete`,
        );
      }
    }
    await this.repo.deleteAgent(agent.id);
  }

  async setAgentAuth(idOrSlug: string, secret: string): Promise<AgentAuthMetadata> {
    const agent = await this.resolveAgent(idOrSlug);
    const encrypted = await CryptoHelper.encryptSecret(secret);
    await this.repo.setAgentAuth(agent.id, encrypted);
    return this.repo.getAgentAuthMetadata(agent.id);
  }

  async getAgentPrompts(idOrSlug: string): Promise<AgentPromptManifest | undefined> {
    const agent = await this.resolveAgent(idOrSlug);
    return this.repo.getAgentPrompts(agent.id);
  }

  async testAgent(idOrSlug: string): Promise<AgentHealth> {
    const agent = await this.resolveAgent(idOrSlug);
    return this.agentService.healthCheck(agent.id);
  }

  async setDefaultAgent(
    idOrSlug: string,
    workspaceId = "__GLOBAL__",
    commandName = "default",
  ): Promise<void> {
    const agent = await this.resolveAgent(idOrSlug);
    await this.routingService.updateWorkspaceDefaults(workspaceId, { set: { [commandName]: agent.slug } });
  }
}
