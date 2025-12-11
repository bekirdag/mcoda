import {
  Agent,
  RoutingDefaults,
  RoutingDefaultsUpdate,
  RoutingPreview,
} from "@mcoda/shared";

const pickBaseUrl = (): string => {
  const base = process.env.MCODA_ROUTING_API_URL ?? process.env.MCODA_API_BASE_URL;
  if (!base) {
    throw new Error("MCODA_API_BASE_URL (or MCODA_ROUTING_API_URL) is required for routing operations per SDS.");
  }
  return base;
};

const handleResponse = async <T>(resp: Response): Promise<T | undefined> => {
  if (resp.status === 404) return undefined;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Routing API request failed (${resp.status}): ${text}`);
  }
  if (resp.status === 204) return undefined;
  return (await resp.json()) as T;
};

export interface RoutingPreviewRequest {
  workspaceId: string;
  commandName: string;
  agentOverride?: string;
  taskType?: string;
  projectKey?: string;
  requiredCapabilities?: string[];
}

export class RoutingApiClient {
  constructor(private baseUrl: string = pickBaseUrl()) {}

  static create(): RoutingApiClient {
    return new RoutingApiClient();
  }

  private build(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }

  async getWorkspaceDefaults(workspaceId: string): Promise<RoutingDefaults | undefined> {
    const resp = await fetch(this.build(`/workspaces/${encodeURIComponent(workspaceId)}/defaults`), {
      headers: { accept: "application/json" },
    });
    return handleResponse<RoutingDefaults>(resp);
  }

  async updateWorkspaceDefaults(workspaceId: string, update: RoutingDefaultsUpdate): Promise<RoutingDefaults | undefined> {
    const resp = await fetch(this.build(`/workspaces/${encodeURIComponent(workspaceId)}/defaults`), {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    return handleResponse<RoutingDefaults>(resp);
  }

  async preview(request: RoutingPreviewRequest): Promise<RoutingPreview | undefined> {
    const resp = await fetch(this.build("/routing/preview"), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: request.workspaceId,
        commandName: request.commandName,
        agentOverride: request.agentOverride,
        taskType: request.taskType,
        projectKey: request.projectKey,
        requiredCapabilities: request.requiredCapabilities,
      }),
    });
    return handleResponse<RoutingPreview>(resp);
  }

  async listAgents(): Promise<Agent[] | undefined> {
    const resp = await fetch(this.build("/agents"), { headers: { accept: "application/json" } });
    return handleResponse<Agent[]>(resp);
  }

  async getAgent(idOrSlug: string): Promise<Agent | undefined> {
    const resp = await fetch(this.build(`/agents/${encodeURIComponent(idOrSlug)}`), {
      headers: { accept: "application/json" },
    });
    return handleResponse<Agent>(resp);
  }
}
