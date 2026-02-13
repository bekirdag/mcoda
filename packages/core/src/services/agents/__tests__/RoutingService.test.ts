import test from "node:test";
import assert from "node:assert/strict";
import { Agent, RoutingPreview, PathHelper } from "@mcoda/shared";
import { RoutingService } from "../RoutingService.js";

class StubAgentService {
  agents = new Map<string, Agent>();
  capabilities = new Map<string, string[]>();

  register(agent: Agent) {
    this.agents.set(agent.id, agent);
    this.agents.set(agent.slug, agent);
  }

  async resolveAgent(idOrSlug: string): Promise<Agent> {
    const agent = this.agents.get(idOrSlug);
    if (!agent) {
      throw new Error(`Agent ${idOrSlug} not found`);
    }
    return agent;
  }

  async getCapabilities(agentId: string): Promise<string[]> {
    return this.capabilities.get(agentId) ?? [];
  }
}

class StubRoutingApi {
  defaults = new Map<string, Map<string, string>>();
  previews: RoutingPreview[] = [];
  agents = new Map<string, Agent>();
  health = new Map<string, any>();

  constructor(private capabilityLookup: (agentId: string) => Promise<string[]>) {}

  async getWorkspaceDefaults(workspaceId: string) {
    const map = this.defaults.get(workspaceId);
    if (!map) return [];
    return Array.from(map.entries()).map(([commandName, agentId]) => ({
      workspaceId,
      commandName,
      agentId,
      updatedAt: "now",
    }));
  }

  async updateWorkspaceDefaults(workspaceId: string, defaults: any) {
    const map = new Map<string, string>();
    if (Array.isArray(defaults)) {
      defaults.forEach((d) => {
        if (d.agentId) map.set(d.commandName, d.agentId);
      });
    } else if (defaults?.set) {
      Object.entries(defaults.set as Record<string, string>).forEach(([commandName, agentId]) => {
        map.set(commandName, agentId);
      });
    }
    this.defaults.set(workspaceId, map);
    return defaults;
  }

  async listAgents(): Promise<Agent[]> {
    return Array.from(this.agents.values()).map((a) => ({
      ...a,
      capabilities: a.capabilities,
      health: this.health.get(a.id),
    }));
  }

  async getAgent(idOrSlug: string): Promise<Agent | undefined> {
    const agent = this.agents.get(idOrSlug);
    return agent ? { ...agent, health: this.health.get(agent.id) } : undefined;
  }

  async preview(request: any) {
    const map = this.defaults.get(request.workspaceId) ?? new Map<string, string>();
    const global = this.defaults.get("__GLOBAL__") ?? new Map<string, string>();
    const agentId = request.agentOverride ?? map.get(request.commandName) ?? global.get(request.commandName);
    if (!agentId) throw new Error(`No routing defaults or overrides found for command ${request.commandName}`);
    const provenance = request.agentOverride
      ? "override"
      : map.has(request.commandName)
        ? "workspace_default"
        : "global_default";
    const capabilities = await this.capabilityLookup(agentId);
    const missingCapabilities = (request.requiredCapabilities ?? []).filter((cap: string) => !capabilities.includes(cap));
    const stored = await this.getAgent(agentId);
    const candidate = {
      agent: (stored ?? { id: agentId, slug: agentId, adapter: "local-model", createdAt: "t", updatedAt: "t" }) as Agent,
      agentId,
      agentSlug: agentId,
      source: provenance as any,
      capabilities,
      missingCapabilities: missingCapabilities.length ? missingCapabilities : undefined,
    };
    const preview: RoutingPreview = {
      workspaceId: request.workspaceId,
      commandName: request.commandName,
      resolvedAgent: candidate.agent,
      provenance,
      requiredCapabilities: request.requiredCapabilities,
      candidates: [candidate],
    };
    this.previews.push(preview);
    return preview;
  }
}

const workspace = {
  workspaceId: "ws-1",
  id: "ws-1",
  workspaceRoot: "/tmp/ws-1",
  workspaceDbPath: PathHelper.getWorkspaceDbPath("/tmp/ws-1"),
  globalDbPath: PathHelper.getGlobalDbPath(),
  mcodaDir: PathHelper.getWorkspaceDir("/tmp/ws-1"),
  legacyWorkspaceIds: [],
};

const agent = (id: string, slug: string): Agent => ({
  id,
  slug,
  adapter: "local-model",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

test("resolves override before workspace and global defaults", async () => {
  const agents = new StubAgentService();
  const routingApi = new StubRoutingApi((id) => agents.getCapabilities(id));
  routingApi.agents.set("a-global", agent("a-global", "global"));
  routingApi.agents.set("a-workspace", agent("a-workspace", "workspace"));
  routingApi.agents.set("a-override", agent("a-override", "override"));
  agents.register(agent("a-global", "global"));
  agents.register(agent("a-workspace", "workspace"));
  agents.register(agent("a-override", "override"));
  routingApi.defaults.set("__GLOBAL__", new Map([["work-on-tasks", "a-global"]]));
  routingApi.defaults.set(workspace.workspaceId, new Map([["work-on-tasks", "a-workspace"]]));
  agents.capabilities.set("a-global", ["code_write"]);
  agents.capabilities.set("a-workspace", ["code_write"]);
  agents.capabilities.set("a-override", ["code_write"]);
  const service = new RoutingService({ routingApi: routingApi as any, agentService: agents as any });

  const resolved = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "work-on-tasks",
  });
  assert.equal(resolved.agentId, "a-workspace");
  assert.equal(resolved.source, "workspace_default");

  const override = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "work-on-tasks",
    overrideAgentSlug: "override",
  });
  assert.equal(override.agentId, "a-override");
  assert.equal(override.source, "override");
});

test("falls back when workspace default lacks required capabilities", async () => {
  const agents = new StubAgentService();
  const routingApi = new StubRoutingApi((id) => agents.getCapabilities(id));
  routingApi.agents.set("a-global", agent("a-global", "global"));
  routingApi.agents.set("a-workspace", agent("a-workspace", "workspace"));
  agents.register(agent("a-global", "global"));
  agents.register(agent("a-workspace", "workspace"));
  agents.capabilities.set("a-global", ["code_write"]);
  agents.capabilities.set("a-workspace", []);
  routingApi.defaults.set("__GLOBAL__", new Map([["work-on-tasks", "a-global"]]));
  routingApi.defaults.set(workspace.workspaceId, new Map([["work-on-tasks", "a-workspace"]]));

  const service = new RoutingService({ routingApi: routingApi as any, agentService: agents as any });
  const resolved = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "work-on-tasks",
  });

  assert.equal(resolved.agentId, "a-global");
  assert.equal(resolved.source, "global_default");
});

test("honors extra required capabilities when resolving docgen agents", async () => {
  const agents = new StubAgentService();
  const routingApi = new StubRoutingApi((id) => agents.getCapabilities(id));
  routingApi.agents.set("a-global", agent("a-global", "global"));
  routingApi.agents.set("a-workspace", agent("a-workspace", "workspace"));
  agents.register(agent("a-global", "global"));
  agents.register(agent("a-workspace", "workspace"));
  routingApi.defaults.set("__GLOBAL__", new Map([["pdr", "a-global"]]));
  routingApi.defaults.set(workspace.workspaceId, new Map([["pdr", "a-workspace"]]));
  agents.capabilities.set("a-global", ["doc_generation", "docdex_query"]);
  agents.capabilities.set("a-workspace", ["docdex_query"]);

  const service = new RoutingService({ routingApi: routingApi as any, agentService: agents as any });
  const resolved = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "pdr",
    requiredCapabilities: ["doc_generation"],
  });

  assert.equal(resolved.agentId, "a-global");
  assert.equal(resolved.source, "global_default");
  assert.ok(resolved.requiredCapabilities.includes("doc_generation"));
});

test("skips unhealthy or incapable agents and falls back", async () => {
  const agents = new StubAgentService();
  const routingApi = new StubRoutingApi((id) => agents.getCapabilities(id));
  routingApi.agents.set("a1", agent("a1", "agent1"));
  routingApi.agents.set("a2", agent("a2", "agent2"));
  agents.register(agent("a1", "agent1"));
  agents.register(agent("a2", "agent2"));
  routingApi.health.set("a2", { agentId: "a2", status: "unreachable", lastCheckedAt: "t" } as any);
  routingApi.health.set("a1", { agentId: "a1", status: "healthy", lastCheckedAt: "t" } as any);
  routingApi.defaults.set("__GLOBAL__", new Map([["code-review", "a2"], ["default", "a1"]]));
  agents.capabilities.set("a2", ["code_review"]);
  agents.capabilities.set("a1", ["code_review"]);
  const service = new RoutingService({ routingApi: routingApi as any, agentService: agents as any });

  const resolved = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "code-review",
  });
  assert.equal(resolved.agentId, "a1");
  assert.equal(resolved.source, "global_default");
  assert.equal(resolved.healthStatus, "healthy");
});

test("falls back when override lacks required capabilities", async () => {
  const agents = new StubAgentService();
  const routingApi = new StubRoutingApi((id) => agents.getCapabilities(id));
  routingApi.agents.set("a-global", agent("a-global", "global"));
  routingApi.agents.set("a-override", agent("a-override", "override"));
  agents.register(agent("a-global", "global"));
  agents.register(agent("a-override", "override"));
  routingApi.defaults.set("__GLOBAL__", new Map([["work-on-tasks", "a-global"]]));
  agents.capabilities.set("a-global", ["code_write"]);
  agents.capabilities.set("a-override", []);
  const service = new RoutingService({ routingApi: routingApi as any, agentService: agents as any });

  const resolved = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "work-on-tasks",
    overrideAgentSlug: "override",
  });
  assert.equal(resolved.agentId, "a-global");
  assert.equal(resolved.source, "global_default");
});

test("throws when no defaults are configured", async () => {
  const agents = new StubAgentService();
  const routingApi = new StubRoutingApi((id) => agents.getCapabilities(id));
  routingApi.agents.set("a1", agent("a1", "agent1"));
  agents.register(agent("a1", "agent1"));
  agents.capabilities.set("a1", ["plan"]);
  // ensure QA/docdex profiles are optional and validated upstream
  const service = new RoutingService({ routingApi: routingApi as any, agentService: agents as any });
  await assert.rejects(
    () =>
      service.resolveAgentForCommand({
        workspace: workspace as any,
        commandName: "create-tasks",
      }),
    /No routing defaults/,
  );
});

test("updateWorkspaceDefaults validates capabilities and profiles", async () => {
  const agents = new StubAgentService();
  const routingApi = new StubRoutingApi((id) => agents.getCapabilities(id));
  routingApi.agents.set("codex", agent("codex", "codex"));
  agents.register(agent("codex", "codex"));
  agents.capabilities.set("codex", ["plan", "docdex_query"]);
  const service = new RoutingService({ routingApi: routingApi as any, agentService: agents as any });

  await assert.rejects(
    () => service.updateWorkspaceDefaults("ws", { set: { "work-on-tasks": "codex" } }),
    /missing required capabilities/i,
  );

  await service.updateWorkspaceDefaults("ws", { set: { "create-tasks": "codex" }, qaProfile: "integration" });
});

test("uses API agent capabilities when present", async () => {
  const routingApi = new StubRoutingApi(async () => []);
  const apiAgent = agent("api-agent", "api-agent");
  apiAgent.capabilities = ["code_write"];
  routingApi.agents.set(apiAgent.id, apiAgent);
  routingApi.defaults.set("__GLOBAL__", new Map([["work-on-tasks", apiAgent.id]]));
  const service = new RoutingService({ routingApi: routingApi as any });

  const resolved = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "work-on-tasks",
  });
  assert.equal(resolved.agentId, apiAgent.id);
  assert.deepEqual(resolved.capabilities, ["code_write"]);
});

test("accepts ollama-remote agents in routing", async () => {
  const routingApi = new StubRoutingApi(async (id) => (id === "ollama" ? ["plan", "code_write"] : []));
  const remoteAgent = { ...agent("ollama", "ollama"), adapter: "ollama-remote", capabilities: ["plan", "code_write"] };
  routingApi.agents.set(remoteAgent.id, remoteAgent);
  routingApi.defaults.set("__GLOBAL__", new Map([["create-tasks", remoteAgent.id]]));
  const service = new RoutingService({ routingApi: routingApi as any });

  const resolved = await service.resolveAgentForCommand({
    workspace: workspace as any,
    commandName: "create-tasks",
  });
  assert.equal(resolved.agentId, remoteAgent.id);
  assert.equal(resolved.agent.adapter, "ollama-remote");
});
