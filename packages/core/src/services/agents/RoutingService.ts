import { AgentService } from "@mcoda/agents";
import { Agent, AgentHealth, RoutingDefaults, RoutingDefaultsUpdate, RoutingPreview, RoutingProvenance } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { RoutingApi, RoutingPreviewRequest } from "../../api/RoutingApi.js";

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

const COMMAND_ALIASES: Record<string, string[]> = {
  "create-tasks": ["create_tasks", "create tasks"],
  "refine-tasks": ["refine_tasks", "refine tasks"],
  "work-on-tasks": ["work_on_tasks", "work on tasks"],
  "code-review": ["code_review", "code review"],
  "qa-tasks": ["qa_tasks", "qa tasks"],
  "order-tasks": ["tasks:order", "order_tasks", "tasks order"],
  pdr: ["docs:pdr:generate", "docs-pdr-generate", "pdr-generate", "docs-pdr"],
  sds: ["docs:sds:generate", "docs-sds-generate", "sds-generate", "docs-sds"],
  "openapi-from-docs": ["openapi", "openapi_from_docs", "openapi-from-docs"],
  default: ["__default__", "agent:set-default"],
};

const REQUIRED_CAPABILITIES: Record<string, string[]> = {
  "create-tasks": ["plan"],
  "refine-tasks": ["plan"],
  "work-on-tasks": ["code_write"],
  "code-review": ["code_review"],
  "qa-tasks": ["qa_interpretation"],
  pdr: ["docdex_query"],
  sds: ["docdex_query"],
  "openapi-from-docs": ["docdex_query"],
  "order-tasks": ["plan"],
};

const normalize = (value: string): string => value.trim().toLowerCase();

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

export class RoutingService {
  constructor(private deps: { routingApi: RoutingApi; agentService: AgentService }) {}

  static async create(): Promise<RoutingService> {
    const routingApi = await RoutingApi.create();
    const agentService = await AgentService.create();
    return new RoutingService({ routingApi, agentService });
  }

  async close(): Promise<void> {
    if ((this.deps.routingApi as any)?.close) {
      await (this.deps.routingApi as any).close();
    }
    if ((this.deps.agentService as any)?.close) {
      await (this.deps.agentService as any).close();
    }
  }

  private normalizeCommandName(commandName: string): string {
    const normalized = normalize(commandName);
    for (const [canonical, aliases] of Object.entries(COMMAND_ALIASES)) {
      if (normalize(canonical) === normalized) return canonical;
      if (aliases.some((alias) => normalize(alias) === normalized)) return canonical;
    }
    return normalized;
  }

  private requiredCapabilities(commandName: string, taskType?: string): string[] {
    const normalized = this.normalizeCommandName(commandName);
    const required = [...(REQUIRED_CAPABILITIES[normalized] ?? [])];
    if (taskType) {
      const lower = taskType.toLowerCase();
      if (lower.includes("qa")) {
        required.push("qa_interpretation");
      }
    }
    return unique(required);
  }

  normalizeCommand(commandName: string): string {
    return this.normalizeCommandName(commandName);
  }

  async getWorkspaceDefaults(workspaceId: string): Promise<RoutingDefaults> {
    return this.deps.routingApi.getWorkspaceDefaults(workspaceId);
  }

  async getAgentSummary(agentId: string): Promise<Agent | undefined> {
    try {
      return await this.deps.agentService.resolveAgent(agentId);
    } catch {
      return undefined;
    }
  }

  private async resolveAgentCapabilities(agentId: string): Promise<string[]> {
    if ((this.deps.agentService as any)?.getCapabilities) {
      const caps = await (this.deps.agentService as any).getCapabilities(agentId);
      return Array.isArray(caps) ? caps : [];
    }
    return [];
  }

  async updateWorkspaceDefaults(workspaceId: string, update: RoutingDefaultsUpdate): Promise<RoutingDefaults> {
    const normalizedSet: Record<string, string> = {};
    const setEntries = Object.entries(update.set ?? {});
    for (const [commandName, agentSlug] of setEntries) {
      const normalizedCommand = this.normalizeCommandName(commandName);
      const agent = await this.deps.agentService.resolveAgent(agentSlug);
      const capabilities = await this.resolveAgentCapabilities(agent.id);
      const required = this.requiredCapabilities(normalizedCommand);
      const missing = required.filter((cap) => !capabilities.includes(cap));
      if (missing.length > 0) {
        throw new Error(
          `Agent ${agent.slug} missing required capabilities for ${normalizedCommand}: ${missing.join(", ")}`,
        );
      }
      normalizedSet[normalizedCommand] = agent.slug ?? agent.id;
    }

    const normalizedReset = (update.reset ?? []).map((command) => this.normalizeCommandName(command));
    const updated = await this.deps.routingApi.updateWorkspaceDefaults(workspaceId, {
      ...update,
      set: Object.keys(normalizedSet).length ? normalizedSet : undefined,
      reset: normalizedReset.length ? normalizedReset : undefined,
    });
    return updated ?? [];
  }

  private buildPreviewRequest(params: ResolveAgentParams): RoutingPreviewRequest {
    const commandName = this.normalizeCommandName(params.commandName);
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
    const normalizedCommand = this.normalizeCommandName(params.commandName);
    const requiredCaps = this.requiredCapabilities(normalizedCommand, params.taskType);

    // Validate override locally before preview call.
    if (params.overrideAgentSlug) {
      const override = await this.deps.agentService.resolveAgent(params.overrideAgentSlug);
      const caps = await this.resolveAgentCapabilities(override.id);
      const missing = requiredCaps.filter((cap) => !caps.includes(cap));
      if (missing.length > 0 && caps.length > 0) {
        throw new Error(
          `Override agent ${params.overrideAgentSlug} is missing required capabilities for ${normalizedCommand}: ${missing.join(", ")}`,
        );
      }
    }

    const preview = await this.deps.routingApi.routingPreview(this.buildPreviewRequest(params));
    if (!preview.resolvedAgent) {
      throw new Error(`Routing preview did not return a resolved agent for ${normalizedCommand}`);
    }

    const agentIdentifier = preview.resolvedAgent.slug ?? preview.resolvedAgent.id;
    const resolvedAgent = await this.deps.agentService.resolveAgent(agentIdentifier ?? preview.resolvedAgent.id);
    const previewCandidate = preview.candidates?.find((c) => c.agentId === resolvedAgent.id);
    const capabilities =
      previewCandidate?.capabilities ??
      preview.resolvedAgent.capabilities ??
      (await this.resolveAgentCapabilities(resolvedAgent.id)) ??
      [];

    const missing = requiredCaps.filter((cap) => !capabilities.includes(cap));
    if (missing.length > 0) {
      throw new Error(
        `Resolved agent ${resolvedAgent.slug} is missing required capabilities for ${normalizedCommand}: ${missing.join(", ")}`,
      );
    }

    const healthStatus =
      previewCandidate?.health?.status ?? preview.resolvedAgent.health?.status ?? ("unknown" as const);

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
