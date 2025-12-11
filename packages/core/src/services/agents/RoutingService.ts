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
import { AgentService } from "@mcoda/agents";
import { GlobalRepository } from "@mcoda/db";
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
      routingApi?: RoutingApiClient;
      agentService?: { resolveAgent(idOrSlug: string): Promise<Agent>; getCapabilities?(agentId: string): Promise<string[]>; close?(): Promise<void> };
      globalRepo?: GlobalRepository;
    },
  ) {}

  static async create(): Promise<RoutingService> {
    let routingApi: RoutingApiClient | undefined;
    try {
      routingApi = RoutingApiClient.create();
    } catch {
      routingApi = undefined;
    }
    const globalRepo = await GlobalRepository.create();
    const agentService = new AgentService(globalRepo);
    return new RoutingService({ routingApi, globalRepo, agentService });
  }

  async close(): Promise<void> {
    if ((this.deps.agentService as any)?.close) {
      await (this.deps.agentService as any).close();
    }
    if (!(this.deps.agentService as any)?.close && (this.deps.globalRepo as any)?.close) {
      await (this.deps.globalRepo as any).close();
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
      (await this.deps.routingApi?.getAgent(idOrSlug)) ??
      (await this.deps.routingApi?.listAgents())?.find((a) => a.id === idOrSlug || a.slug === idOrSlug);
    if (apiAgent) return apiAgent;
    if (this.deps.agentService) {
      return this.deps.agentService.resolveAgent(idOrSlug);
    }
    if (this.deps.globalRepo) {
      const byId = await this.deps.globalRepo.getAgentById(idOrSlug);
      if (byId) return byId;
      const bySlug = await this.deps.globalRepo.getAgentBySlug(idOrSlug);
      if (bySlug) return bySlug;
    }
    throw new Error(`Agent ${idOrSlug} not found via routing API`);
  }

  private async fetchCapabilities(agent: Agent): Promise<string[]> {
    const caps = agent.capabilities ?? [];
    if (caps.length) return caps;
    if (this.deps.agentService?.getCapabilities) {
      return this.deps.agentService.getCapabilities(agent.id);
    }
    if (this.deps.globalRepo) {
      return this.deps.globalRepo.getAgentCapabilities(agent.id);
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
    if (this.deps.routingApi) {
      return (await this.deps.routingApi.getWorkspaceDefaults(workspaceId)) ?? [];
    }
    if (this.deps.globalRepo) {
      return this.deps.globalRepo.getWorkspaceDefaults(workspaceId);
    }
    return [];
  }

  private async migrateLegacyDefaults(workspace: WorkspaceResolution): Promise<void> {
    if (!this.deps.routingApi) return;
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
    if (this.deps.routingApi) {
      const updated = await this.deps.routingApi.updateWorkspaceDefaults(workspaceId, {
        ...update,
        qaProfile: normalizedQa ?? update.qaProfile,
        docdexScope: normalizedDocdex ?? update.docdexScope,
        set: Object.keys(normalizedSet).length ? normalizedSet : undefined,
        reset: normalizedReset.length ? normalizedReset : undefined,
      });
      return updated ?? [];
    }

    if (!this.deps.globalRepo) {
      throw new Error("Routing defaults are unavailable without a routing API or global repository");
    }

    for (const [commandName, agentSlug] of Object.entries(normalizedSet)) {
      const agent = await this.fetchAgent(agentSlug);
      await this.deps.globalRepo.setWorkspaceDefault(workspaceId, commandName, agent.id, {
        qaProfile: normalizedQa ?? update.qaProfile,
        docdexScope: normalizedDocdex ?? update.docdexScope,
      });
    }
    for (const commandName of normalizedReset) {
      await this.deps.globalRepo.removeWorkspaceDefault(workspaceId, commandName);
    }
    return this.deps.globalRepo.getWorkspaceDefaults(workspaceId);
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

    const fillHealth = async (agentId: string, current?: AgentHealth): Promise<AgentHealth | undefined> => {
      if (current && current.status) return current;
      const apiAgent = await this.deps.routingApi?.getAgent(agentId);
      if (apiAgent?.health) return apiAgent.health as AgentHealth;
      if (this.deps.globalRepo) {
        return this.deps.globalRepo.getAgentHealth(agentId);
      }
      return current;
    };

    const fallbackFromDefaults = async (): Promise<ResolvedAgent | null> => {
      const workspaceDefaults = (await this.deps.routingApi?.getWorkspaceDefaults(params.workspace.workspaceId)) ?? [];
      const globalDefaults = (await this.deps.routingApi?.getWorkspaceDefaults("__GLOBAL__")) ?? [];
      const findDefault = (defaults: RoutingDefaults, command: string) =>
        defaults.find((d) => this.normalizeCommand(d.commandName) === command);
      const candidates = [
        findDefault(workspaceDefaults, normalizedCommand),
        findDefault(globalDefaults, normalizedCommand),
        findDefault(workspaceDefaults, "default"),
        findDefault(globalDefaults, "default"),
      ].filter(Boolean) as RoutingDefaults;

      let chosen:
        | { agentId: string; source: RoutingProvenance; qaProfile?: string; docdexScope?: string }
        | undefined;
      let capabilities: string[] = [];
      let agent: Agent | undefined;
      for (const candidate of candidates) {
        const source =
          candidate.workspaceId === "__GLOBAL__"
            ? ("global_default" as RoutingProvenance)
            : ("workspace_default" as RoutingProvenance);
        const resolvedAgent = await this.fetchAgent(candidate.agentId);
        const caps = await this.fetchCapabilities(resolvedAgent);
        const missingFallback = requiredCaps.filter((cap) => !caps.includes(cap));
        if (missingFallback.length === 0) {
          chosen = { agentId: resolvedAgent.id, source, qaProfile: candidate.qaProfile, docdexScope: candidate.docdexScope };
          capabilities = caps;
          agent = resolvedAgent;
          const health = await fillHealth(resolvedAgent.id);
          if (health?.status === "unreachable") {
            continue;
          }
          break;
        }
      }
      if (!chosen || !agent) return null;
      const health = await fillHealth(agent.id);
      const preview: RoutingPreview = {
        workspaceId: params.workspace.workspaceId,
        commandName: normalizedCommand,
        resolvedAgent: { ...agent, capabilities, health },
        provenance: chosen.source,
        requiredCapabilities: requiredCaps,
        candidates: [
          {
            agent: { ...agent, capabilities, health },
            agentId: agent.id,
            agentSlug: agent.slug,
            source: chosen.source,
            capabilities,
            health,
          },
        ],
      };
      return {
        agent,
        agentId: agent.id,
        agentSlug: agent.slug,
        model: agent.defaultModel,
        capabilities,
        healthStatus: health?.status ?? "unknown",
        source: chosen.source,
        routingPreview: preview,
        requiredCapabilities: requiredCaps,
        qaProfile: chosen.qaProfile,
        docdexScope: chosen.docdexScope,
      };
    };

    if (this.deps.routingApi) {
      const preview = await this.deps.routingApi.preview(this.buildPreviewRequest(params));
      if (!preview || !preview.resolvedAgent) {
        throw new Error(`Routing preview did not return a resolved agent for ${normalizedCommand}`);
      }

      const resolvedAgent = preview.resolvedAgent;
      const previewCandidate =
        preview.candidates?.find((c) => c.agentId === resolvedAgent.id || c.agentSlug === resolvedAgent.slug) ??
        undefined;
      let capabilities =
        previewCandidate?.capabilities ?? preview.resolvedAgent.capabilities ?? preview.requiredCapabilities ?? [];
      if (!capabilities.length) {
        capabilities = await this.fetchCapabilities(resolvedAgent);
      }

      const missing = requiredCaps.filter((cap) => !capabilities.includes(cap));
      if (missing.length > 0) {
        if (params.overrideAgentSlug) {
          // try fetching full capabilities when override was provided as slug
          const overrideAgent = await this.fetchAgent(params.overrideAgentSlug);
          const overrideCaps = await this.fetchCapabilities(overrideAgent);
          const overrideMissing = requiredCaps.filter((cap) => !overrideCaps.includes(cap));
          if (overrideMissing.length === 0) {
            const health = await fillHealth(overrideAgent.id, previewCandidate?.health as AgentHealth | undefined);
            return {
              agent: overrideAgent,
              agentId: overrideAgent.id,
              agentSlug: overrideAgent.slug,
              model: overrideAgent.defaultModel,
              capabilities: overrideCaps,
              healthStatus: health?.status ?? "unknown",
              source: "override",
              routingPreview: preview,
              requiredCapabilities: requiredCaps,
            };
          }
        }
        const fallback = await fallbackFromDefaults();
        if (fallback) {
          return fallback;
        }
        throw new Error(
          `Resolved agent ${resolvedAgent.slug} is missing required capabilities for ${normalizedCommand}: ${missing.join(", ")}`,
        );
      }

      const health = (previewCandidate?.health as AgentHealth | undefined) ?? preview.resolvedAgent.health;
      const finalHealth = await fillHealth(resolvedAgent.id, health);
      const healthStatus = finalHealth?.status ?? health?.status ?? "unknown";

      if (healthStatus === "unreachable") {
        const fallback = await fallbackFromDefaults();
        if (fallback) return fallback;
        throw new Error(`Resolved agent ${resolvedAgent.slug} is unreachable`);
      }

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

    if (!this.deps.globalRepo) {
      throw new Error("Routing is unavailable without a routing API or global repository");
    }

    const workspaceDefaults = await this.deps.globalRepo.getWorkspaceDefaults(params.workspace.workspaceId);
    const globalDefaults = await this.deps.globalRepo.getWorkspaceDefaults("__GLOBAL__");

    const findDefault = (defaults: RoutingDefaults, command: string) =>
      defaults.find((d) => this.normalizeCommand(d.commandName) === command);
    const commandDefault = findDefault(workspaceDefaults, normalizedCommand) ?? findDefault(globalDefaults, normalizedCommand);
    const genericDefault = findDefault(workspaceDefaults, "default") ?? findDefault(globalDefaults, "default");

    const selected: { agentId: string; source: RoutingProvenance; qaProfile?: string; docdexScope?: string } | undefined =
      params.overrideAgentSlug != null
        ? { agentId: params.overrideAgentSlug, source: "override" as RoutingProvenance }
        : commandDefault
          ? { agentId: commandDefault.agentId, source: commandDefault.workspaceId === "__GLOBAL__" ? "global_default" : "workspace_default", qaProfile: commandDefault.qaProfile, docdexScope: commandDefault.docdexScope }
          : genericDefault
            ? {
                agentId: genericDefault.agentId,
                source: genericDefault.workspaceId === "__GLOBAL__" ? "global_default" : "workspace_default",
                qaProfile: genericDefault.qaProfile,
                docdexScope: genericDefault.docdexScope,
              }
            : undefined;

    if (!selected) {
      throw new Error(`No routing defaults found for command ${normalizedCommand}`);
    }

    const agent = await this.fetchAgent(selected.agentId);
    const capabilities = await this.fetchCapabilities(agent);
    const missing = requiredCaps.filter((cap) => !capabilities.includes(cap));
    if (missing.length) {
      throw new Error(
        `Resolved agent ${agent.slug} is missing required capabilities for ${normalizedCommand}: ${missing.join(", ")}`,
      );
    }

    const health = await this.deps.globalRepo.getAgentHealth(agent.id);
    const preview: RoutingPreview = {
      workspaceId: params.workspace.workspaceId,
      commandName: normalizedCommand,
      resolvedAgent: { ...agent, capabilities, health },
      provenance: selected.source,
      requiredCapabilities: requiredCaps,
      qaProfile: selected.qaProfile,
      docdexScope: selected.docdexScope,
      candidates: [
        {
          agent: { ...agent, capabilities, health },
          agentId: agent.id,
          agentSlug: agent.slug,
          source: selected.source,
          capabilities,
          health,
        },
      ],
    };

    return {
      agent,
      agentId: agent.id,
      agentSlug: agent.slug,
      model: agent.defaultModel,
      capabilities,
      healthStatus: health?.status ?? "unknown",
      source: selected.source,
      routingPreview: preview,
      qaProfile: selected.qaProfile,
      docdexScope: selected.docdexScope,
      requiredCapabilities: requiredCaps,
    };
  }
}
