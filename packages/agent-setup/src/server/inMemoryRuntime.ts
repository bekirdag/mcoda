import {
  syncedCloudSlug,
  syncedSelfHostedSlug,
} from "../headless/catalog.js";
import type {
  McodaAgentCatalogEntry,
  McodaAgentListInput,
  McodaAgentSyncInput,
  McodaAgentTestResult,
  McodaRuntimeAdapter,
} from "../types.js";

export interface InMemoryMcodaRuntimeAdapterInput {
  cloudAgents?: McodaAgentCatalogEntry[];
  selfHostedAgents?: McodaAgentCatalogEntry[];
  localAgents?: McodaAgentCatalogEntry[];
}

export function createInMemoryMcodaRuntimeAdapter(
  input: InMemoryMcodaRuntimeAdapterInput = {}
): McodaRuntimeAdapter {
  let cloudAgents = input.cloudAgents?.map((agent) => ({ ...agent })) ?? [];
  let selfHostedAgents =
    input.selfHostedAgents?.map((agent) => ({ ...agent })) ?? [];
  let localAgents = input.localAgents?.map((agent) => ({ ...agent })) ?? [];
  let configuredApiKey = false;

  const syncRemote = (
    remoteAgents: McodaAgentCatalogEntry[],
    slugFor: (agent: McodaAgentCatalogEntry) => string,
    managedKind: "cloud" | "self_hosted"
  ): McodaAgentCatalogEntry[] => {
    const remoteLocalSlugs = new Set(remoteAgents.map(slugFor));
    localAgents = localAgents.filter((agent) => {
      if (agent.managedKind !== managedKind) return true;
      return remoteLocalSlugs.has(agent.slug);
    });
    for (const remote of remoteAgents) {
      const localSlug = slugFor(remote);
      const next: McodaAgentCatalogEntry = {
        ...remote,
        slug: localSlug,
        source: "local_registry",
        synced: true,
        managedKind,
        remoteSlug: remote.remoteSlug ?? remote.slug,
      };
      const index = localAgents.findIndex((agent) => agent.slug === localSlug);
      if (index >= 0) {
        localAgents[index] = next;
      } else {
        localAgents.push(next);
      }
    }
    return localAgents.filter((agent) => agent.managedKind === managedKind);
  };

  const filterProvider = (
    agents: McodaAgentCatalogEntry[],
    options: McodaAgentListInput | undefined
  ): McodaAgentCatalogEntry[] =>
    options?.provider
      ? agents.filter((agent) => agent.provider === options.provider)
      : agents;

  return {
    runtime: {
      mode: "programmatic",
      requiresMcodaCli: false,
    },
    async configureMswarmApiKey(input) {
      if (!input.apiKey.trim()) {
        throw new Error("mswarm api key is required");
      }
      configuredApiKey = true;
    },
    async listCloudAgents(options) {
      return filterProvider(cloudAgents, options).map((agent) => ({ ...agent }));
    },
    async syncCloudAgents(options?: McodaAgentSyncInput) {
      if (!configuredApiKey) {
        throw new Error("mswarm api key is required");
      }
      return syncRemote(filterProvider(cloudAgents, options), syncedCloudSlug, "cloud");
    },
    async listSelfHostedAgents(options) {
      return filterProvider(selfHostedAgents, options).map((agent) => ({
        ...agent,
      }));
    },
    async syncSelfHostedAgents(options?: McodaAgentSyncInput) {
      if (!configuredApiKey) {
        throw new Error("mswarm api key is required");
      }
      return syncRemote(
        filterProvider(selfHostedAgents, options),
        syncedSelfHostedSlug,
        "self_hosted"
      );
    },
    async listLocalAgents(options) {
      return filterProvider(localAgents, options).map((agent) => ({ ...agent }));
    },
    async testAgent(input): Promise<McodaAgentTestResult> {
      const agent = localAgents.find((candidate) => candidate.slug === input.slug);
      if (!agent) {
        return {
          slug: input.slug,
          ok: false,
          error: "agent not found",
        };
      }
      return {
        slug: input.slug,
        ok: true,
        output: `ok:${input.prompt ?? ""}`,
        model: agent.defaultModel ?? agent.model ?? undefined,
        adapter: agent.adapter ?? undefined,
      };
    },
  };
}
