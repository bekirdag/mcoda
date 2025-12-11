import {
  Agent,
  AgentHealth,
  RoutingDefaults,
  RoutingDefaultsUpdate,
  RoutingPreview,
  RoutingProvenance,
  canonicalizeCommandName,
  getKnownDocdexScopes,
  getKnownQaProfiles,
  getCommandRequiredCapabilities,
} from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { RoutingApiClient, RoutingPreviewRequest } from "./generated/RoutingApiClient.js";

export interface ResolveAgentParams {
  workspace: WorkspaceResolution;
  commandName: string;
  taskType?: string;
  overrideAgentSlug?: string;
  projectKey?: string;
}

export interface ResolvedAgent {
  agent: Agent;
  agentId: string;
  agentSlug: string;
  model?: string;
  capabilities: string[];
  healthStatus: AgentHealth["status"] | "unknown";
  source: RoutingProvenance;
  routingPreview: RoutingPreview;
  qaProfile?: string;
  docdexScope?: string;
  requiredCapabilities: string[];
}

export class RoutingService {
  constructor(
    private deps: {
      routingApi: RoutingApiClient;
      agentService?: { resolveAgent(idOrSlug: string): Promise<Agent>; getCapabilities?(agentId: string): Promise<string[]>; close?(): Promise<void> };
    },
  ) {}

  static async create(): Promise<RoutingService> {
    const routingApi = RoutingApiClient.create();
    return new RoutingService({ routingApi });
  }

  async close(): Promise<void> {
    if ((this.deps.agentService as any)?.close) {
      await (this.deps.agentService as any).close();
    }
  }

  private requiredCapabilities(commandName: string, taskType?: string): string[] {
    const normalized = this.normalizeCommand(commandName);
    const required = [...getCommandRequiredCapabilities(normalized)];
    if (taskType) {
      const lower = taskType.toLowerCase();
      if (lower.includes("qa")) {
        required.push("qa_interpretation");
      }
    }
    return Array.from(new Set(required));
  }

  normalizeCommand(commandName: string): string {
    return canonicalizeCommandName(commandName);
  }

  private async fetchAgent(idOrSlug: string): Promise<Agent> {
    const apiAgent =
      (await this.deps.routingApi.getAgent(idOrSlug)) ??
      (await this.deps.routingApi.listAgents())?.find((a) => a.id === idOrSlug || a.slug === idOrSlug);
    if (apiAgent) return apiAgent;
    if (this.deps.agentService) {
      return this.deps.agentService.resolveAgent(idOrSlug);
    }
    throw new Error(`Agent ${idOrSlug} not found via routing API`);
  }

  private async fetchCapabilities(agent: Agent): Promise<string[]> {
    const caps = agent.capabilities ?? [];
    if (caps.length) return caps;
    if (this.deps.agentService?.getCapabilities) {
      return this.deps.agentService.getCapabilities(agent.id);
    }
    return [];
  }

  private normalizeProfile(value?: string): string | undefined {
    return value ? value.trim().toLowerCase().replace(/[_\s]+/g, "-") : undefined;
  }

  async getWorkspaceDefaults(workspace: WorkspaceResolution | string): Promise<RoutingDefaults> {
    const workspaceId = typeof workspace === "string" ? workspace : workspace.workspaceId;
    if (typeof workspace !== "string") {
      await this.migrateLegacyDefaults(workspace);
    }
    return (await this.deps.routingApi.getWorkspaceDefaults(workspaceId)) ?? [];
  }

  private async migrateLegacyDefaults(workspace: WorkspaceResolution): Promise<void> {
    const legacyIds = workspace.legacyWorkspaceIds ?? [];
    if (!legacyIds.length) return;
    const current = (await this.deps.routingApi.getWorkspaceDefaults(workspace.workspaceId)) ?? [];
    if (current.length > 0) return;
    for (const legacyId of legacyIds) {
      const legacy = await this.deps.routingApi.getWorkspaceDefaults(legacyId);
      if (legacy && legacy.length) {
        const set: Record<string, string> = {};
        for (const entry of legacy) {
          const agent = await this.fetchAgent(entry.agentId);
          set[this.normalizeCommand(entry.commandName)] = agent.slug ?? agent.id;
        }
        await this.updateWorkspaceDefaults(workspace.workspaceId, { set });
        break;
      }
    }
  }

  async getAgentSummary(agentId: string): Promise<Agent | undefined> {
    try {
      return await this.fetchAgent(agentId);
    } catch {
      return undefined;
    }
  }

  async updateWorkspaceDefaults(workspaceId: string, update: RoutingDefaultsUpdate): Promise<RoutingDefaults> {
    const qaProfiles = getKnownQaProfiles().map((p) => this.normalizeProfile(p)).filter(Boolean);
    const docdexScopes = getKnownDocdexScopes().map((p) => this.normalizeProfile(p)).filter(Boolean);
    const normalizedQa = this.normalizeProfile(update.qaProfile);
    const normalizedDocdex = this.normalizeProfile(update.docdexScope);
    if (normalizedQa && qaProfiles.length && !qaProfiles.includes(normalizedQa)) {
      throw new Error(`Unknown QA profile ${update.qaProfile}; allowed values: ${qaProfiles.join(", ")}`);
    }
    if (normalizedDocdex && docdexScopes.length && !docdexScopes.includes(normalizedDocdex)) {
      throw new Error(`Unknown docdex scope ${update.docdexScope}; allowed values: ${docdexScopes.join(", ")}`);
    }

    const normalizedSet: Record<string, string> = {};
    const setEntries = Object.entries(update.set ?? {});
    for (const [commandName, agentSlug] of setEntries) {
      const normalizedCommand = this.normalizeCommand(commandName);
      const agent = await this.fetchAgent(agentSlug);
      const capabilities = await this.fetchCapabilities(agent);
      const required = this.requiredCapabilities(normalizedCommand);
      const missing = required.filter((cap) => !capabilities.includes(cap));
      if (missing.length) {
        throw new Error(
          `Agent ${agentSlug} is missing required capabilities for ${normalizedCommand}: ${missing.join(", ")}`,
        );
      }
      normalizedSet[normalizedCommand] = agent.slug ?? agent.id;
    }

    const normalizedReset = (update.reset ?? []).map((command) => this.normalizeCommand(command));
    const updated = await this.deps.routingApi.updateWorkspaceDefaults(workspaceId, {
      ...update,
      qaProfile: normalizedQa ?? update.qaProfile,
      docdexScope: normalizedDocdex ?? update.docdexScope,
      set: Object.keys(normalizedSet).length ? normalizedSet : undefined,
      reset: normalizedReset.length ? normalizedReset : undefined,
    });
    return updated ?? [];
  }

  private buildPreviewRequest(params: ResolveAgentParams): RoutingPreviewRequest {
    const commandName = this.normalizeCommand(params.commandName);
    return {
      workspaceId: params.workspace.workspaceId,
      commandName,
      agentOverride: params.overrideAgentSlug,
      taskType: params.taskType,
      projectKey: params.projectKey,
      requiredCapabilities: this.requiredCapabilities(commandName, params.taskType),
    };
  }

  async resolveAgentForCommand(params: ResolveAgentParams): Promise<ResolvedAgent> {
    await this.migrateLegacyDefaults(params.workspace);
    const normalizedCommand = this.normalizeCommand(params.commandName);
    const requiredCaps = this.requiredCapabilities(normalizedCommand, params.taskType);

    const preview = await this.deps.routingApi.preview(this.buildPreviewRequest(params));
    if (!preview || !preview.resolvedAgent) {
      throw new Error(`Routing preview did not return a resolved agent for ${normalizedCommand}`);
    }

    const resolvedAgent = preview.resolvedAgent;
    const previewCandidate =
      preview.candidates?.find((c) => c.agentId === resolvedAgent.id || c.agentSlug === resolvedAgent.slug) ??
      undefined;
    const capabilities =
      previewCandidate?.capabilities ?? preview.resolvedAgent.capabilities ?? preview.requiredCapabilities ?? [];

    const missing = requiredCaps.filter((cap) => !capabilities.includes(cap));
    if (missing.length > 0) {
      throw new Error(
        `Resolved agent ${resolvedAgent.slug} is missing required capabilities for ${normalizedCommand}: ${missing.join(", ")}`,
      );
    }

    const healthStatus = previewCandidate?.health?.status ?? preview.resolvedAgent.health?.status ?? "unknown";

    return {
      agent: resolvedAgent,
      agentId: resolvedAgent.id,
      agentSlug: resolvedAgent.slug,
      model: resolvedAgent.defaultModel,
      capabilities,
      healthStatus,
      source: preview.provenance ?? (params.overrideAgentSlug ? "override" : "workspace_default"),
      routingPreview: preview,
      qaProfile: preview.qaProfile,
      docdexScope: preview.docdexScope,
      requiredCapabilities: requiredCaps,
    };
  }
}
