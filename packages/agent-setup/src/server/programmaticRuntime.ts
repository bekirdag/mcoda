import {
  AgentsApi,
  MswarmApi,
  MswarmConfigStore,
  type AgentResponse,
  type ListMswarmCloudAgentsOptions,
  type ListMswarmSelfHostedAgentsOptions,
  type ListMswarmWorkerAgentsOptions,
} from "@mcoda/core";
import { normalizeAgentCatalogEntry } from "../headless/normalization.js";
import { isCloudAgent, isSelfHostedAgent, isWorkerAgent } from "../headless/catalog.js";
import type {
  McodaAgentCatalogEntry,
  McodaAgentListInput,
  McodaAgentSyncInput,
  McodaRuntimeAdapter,
} from "../types.js";

export interface ProgrammaticMcodaRuntimeAdapterInput {
  mswarm?: {
    baseUrl?: string;
    openAiBaseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
    agentSlugPrefix?: string;
    selfHostedAgentSlugPrefix?: string;
    workerAgentSlugPrefix?: string;
  };
  store?: MswarmConfigStore;
}

export function createProgrammaticMcodaRuntimeAdapter(
  input: ProgrammaticMcodaRuntimeAdapterInput = {}
): McodaRuntimeAdapter {
  const createMswarmApi = async () => {
    if (!input.store) return MswarmApi.create(input.mswarm ?? {});
    const stored = await input.store.readState();
    return MswarmApi.create({
      baseUrl: input.mswarm?.baseUrl ?? stored.baseUrl,
      openAiBaseUrl: input.mswarm?.openAiBaseUrl,
      apiKey: input.mswarm?.apiKey ?? stored.apiKey,
      timeoutMs: input.mswarm?.timeoutMs ?? stored.timeoutMs,
      agentSlugPrefix: input.mswarm?.agentSlugPrefix ?? stored.agentSlugPrefix,
      selfHostedAgentSlugPrefix: input.mswarm?.selfHostedAgentSlugPrefix,
      workerAgentSlugPrefix: input.mswarm?.workerAgentSlugPrefix,
    });
  };

  const withMswarmApi = async <T>(fn: (api: MswarmApi) => Promise<T>): Promise<T> => {
    const api = await createMswarmApi();
    try {
      return await fn(api);
    } finally {
      await api.close();
    }
  };

  const withAgentsApi = async <T>(fn: (api: AgentsApi) => Promise<T>): Promise<T> => {
    const api = await AgentsApi.create();
    try {
      return await fn(api);
    } finally {
      await api.close();
    }
  };

  const listLocal = async (
    options: McodaAgentListInput | undefined
  ): Promise<McodaAgentCatalogEntry[]> =>
    withAgentsApi(async (api) => {
      const agents = await api.listAgents({
        refreshHealth: options?.refreshHealth,
      });
      return agents.map(normalizeLocalAgent);
    });

  return {
    runtime: {
      mode: "programmatic",
      requiresMcodaCli: false,
    },
    async configureMswarmApiKey(request) {
      const store = input.store ?? new MswarmConfigStore();
      await store.saveApiKey(request.apiKey);
      await MswarmApi.refreshManagedAgentAuth(request.apiKey);
    },
    async listCloudAgents(options) {
      return withMswarmApi(async (api) => {
        const agents = await api.listCloudAgents(toCloudOptions(options));
        return agents.map((agent) =>
          normalizeAgentCatalogEntry(agent, {
            source: "cloud_catalog",
            synced: false,
            managedKind: "cloud",
          })
        );
      });
    },
    async syncCloudAgents(options) {
      await withMswarmApi((api) => api.syncCloudAgents(toCloudSyncOptions(options)));
      return (await listLocal(options)).filter(isCloudAgent);
    },
    async listSelfHostedAgents(options) {
      return withMswarmApi(async (api) => {
        const agents = await api.listSelfHostedAgents(toSelfHostedOptions(options));
        return agents.map((agent) =>
          normalizeAgentCatalogEntry(agent, {
            source: "self_hosted_catalog",
            synced: false,
            managedKind: "self_hosted",
          })
        );
      });
    },
    async syncSelfHostedAgents(options) {
      await withMswarmApi((api) =>
        api.syncSelfHostedAgents(toSelfHostedSyncOptions(options))
      );
      return (await listLocal(options)).filter(isSelfHostedAgent);
    },
    async listWorkerAgents(options) {
      return withMswarmApi(async (api) => {
        const agents = await api.listAllWorkers(toWorkerOptions(options));
        return agents.map((agent) =>
          normalizeAgentCatalogEntry(agent, {
            source: "worker_catalog",
            synced: false,
            managedKind: "worker",
          })
        );
      });
    },
    async syncWorkerAgents(options) {
      await withMswarmApi((api) => api.syncWorkers(toWorkerSyncOptions(options)));
      return (await listLocal(options)).filter(isWorkerAgent);
    },
    listLocalAgents: listLocal,
    async testAgent(input) {
      try {
        const result = await withAgentsApi((api) =>
          api.runAgent(
            input.slug,
            [input.prompt ?? "Hello from mcoda agent setup test."],
            {
              command: "mcoda-agent-setup-test",
              timeoutMs: input.timeoutMs,
            }
          )
        );
        const first = result.responses[0];
        return {
          slug: result.agent.slug,
          ok: true,
          output: first?.output,
          model: first?.model,
          adapter: first?.adapter,
          metadata: first?.metadata,
        };
      } catch (error) {
        return {
          slug: input.slug,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function normalizeLocalAgent(agent: AgentResponse): McodaAgentCatalogEntry {
  return normalizeAgentCatalogEntry(agent, {
    source: "local_registry",
    synced: true,
  });
}

function toCloudOptions(
  options: McodaAgentListInput | undefined
): ListMswarmCloudAgentsOptions {
  return {
    provider: options?.provider,
  };
}

function toCloudSyncOptions(
  options: McodaAgentSyncInput | undefined
): ListMswarmCloudAgentsOptions {
  return {
    provider: options?.provider,
    pruneMissing: options?.pruneMissing ?? true,
  };
}

function toSelfHostedOptions(
  options: McodaAgentListInput | undefined
): ListMswarmSelfHostedAgentsOptions {
  return {
    provider: options?.provider,
    includeUnreachable: options?.includeUnreachable ?? true,
  };
}

function toSelfHostedSyncOptions(
  options: McodaAgentSyncInput | undefined
): ListMswarmSelfHostedAgentsOptions {
  return {
    provider: options?.provider,
    includeUnreachable: options?.includeUnreachable ?? true,
    pruneMissing: options?.pruneMissing ?? true,
  };
}

function toWorkerOptions(
  options: McodaAgentListInput | undefined
): ListMswarmWorkerAgentsOptions {
  return {
    includeDisabled: options?.includeUnreachable ?? true,
  };
}

function toWorkerSyncOptions(
  options: McodaAgentSyncInput | undefined
): ListMswarmWorkerAgentsOptions {
  return {
    includeDisabled: options?.includeUnreachable ?? true,
    pruneMissing: options?.pruneMissing ?? true,
  };
}
