import {
  AgentsApi,
  MswarmApi,
  MswarmConfigStore,
  type AgentResponse,
  type ListMswarmCloudAgentsOptions,
  type ListMswarmSelfHostedAgentsOptions,
  type ListMswarmWorkerAgentsOptions,
  type MswarmApiOptions,
  type MswarmRuntimeIdentity,
} from "@mcoda/core";
import { normalizeAgentCatalogEntry } from "../headless/normalization.js";
import { isCloudAgent, isSelfHostedAgent, isWorkerAgent } from "../headless/catalog.js";
import type {
  McodaAgentCatalogEntry,
  McodaAgentListInput,
  McodaAgentSyncInput,
  McodaMswarmConnectionInput,
  McodaMswarmConnectionMetadata,
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
    clientIdentity?: string;
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
      clientIdentity: input.mswarm?.clientIdentity,
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
      const connection = await resolveMswarmConnectionMetadata(
        request.apiKey,
        request.connection,
        input.mswarm
      );
      await store.saveApiKey(request.apiKey);
      await MswarmApi.refreshManagedAgentAuth(request.apiKey);
      return connection;
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
            managedKind: agent.load_balanced
              ? "self_hosted_load_balanced"
              : "self_hosted",
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

async function resolveMswarmConnectionMetadata(
  apiKey: string,
  input: McodaMswarmConnectionInput | undefined,
  options: MswarmApiOptions | undefined
): Promise<McodaMswarmConnectionMetadata | undefined> {
  const base = normalizeConnectionInput(input);
  const validationMode = input?.validationMode ?? "auto";
  if (validationMode === "skip") {
    return base ? withValidation(base, "unverified", [], null) : undefined;
  }

  try {
    const api = await MswarmApi.create({ ...(options ?? {}), apiKey });
    try {
      const identity = await api.getRuntimeIdentity();
      const connection = mergeRuntimeIdentity(base, identity);
      const errors = validateConnection(base, identity);
      if (errors.length) {
        const message = errors.join("; ");
        throw new Error(`mswarm connection mismatch: ${message}`);
      }
      return withValidation(
        connection,
        "verified",
        [],
        new Date().toISOString()
      );
    } finally {
      await api.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (validationMode === "required" || message.startsWith("mswarm connection mismatch:")) {
      throw new Error(`mswarm connection validation failed: ${message}`);
    }
    return base
      ? withValidation(base, "unverified", [message], null)
      : undefined;
  }
}

function normalizeConnectionInput(
  input: McodaMswarmConnectionInput | undefined
): Omit<
  McodaMswarmConnectionMetadata,
  "validationStatus" | "validationErrors" | "validatedAt"
> | null {
  if (!input) return null;
  const connection = {
    tenantId: normalizeString(input.tenantId),
    productSlug: normalizeString(input.productSlug),
    apiKeyId: normalizeString(input.apiKeyId),
    ownerUserId: normalizeString(input.ownerUserId),
    ownerKeycloakUserId: normalizeString(input.ownerKeycloakUserId),
    featureKey: normalizeString(input.featureKey),
    installationId: normalizeString(input.installationId),
    installationStatus: normalizeString(input.installationStatus),
  };
  return Object.values(connection).some((entry) => entry !== null)
    ? connection
    : null;
}

function mergeRuntimeIdentity(
  base: ReturnType<typeof normalizeConnectionInput>,
  identity: MswarmRuntimeIdentity
): Omit<
  McodaMswarmConnectionMetadata,
  "validationStatus" | "validationErrors" | "validatedAt"
> {
  return {
    tenantId: base?.tenantId ?? identity.tenantId,
    productSlug: base?.productSlug ?? identity.productSlug,
    apiKeyId: base?.apiKeyId ?? identity.apiKeyId,
    ownerUserId: base?.ownerUserId ?? null,
    ownerKeycloakUserId: base?.ownerKeycloakUserId ?? null,
    featureKey: base?.featureKey ?? null,
    installationId: base?.installationId ?? null,
    installationStatus: base?.installationStatus ?? null,
  };
}

function validateConnection(
  expected: ReturnType<typeof normalizeConnectionInput>,
  actual: MswarmRuntimeIdentity
): string[] {
  if (!expected) return [];
  const errors: string[] = [];
  addMismatch(errors, "tenantId", expected.tenantId, actual.tenantId);
  addMismatch(errors, "productSlug", expected.productSlug, actual.productSlug);
  addMismatch(errors, "apiKeyId", expected.apiKeyId, actual.apiKeyId);
  return errors;
}

function addMismatch(
  errors: string[],
  field: string,
  expected: string | null,
  actual: string | null
): void {
  if (expected && expected !== actual) {
    errors.push(
      `${field} expected ${expected} but mswarm returned ${actual ?? "null"}`
    );
  }
}

function withValidation(
  connection: Omit<
    McodaMswarmConnectionMetadata,
    "validationStatus" | "validationErrors" | "validatedAt"
  >,
  validationStatus: McodaMswarmConnectionMetadata["validationStatus"],
  validationErrors: string[],
  validatedAt: string | null
): McodaMswarmConnectionMetadata {
  return {
    ...connection,
    validationStatus,
    validationErrors,
    validatedAt,
  };
}

function normalizeString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
    includeLoadBalanced: options?.includeLoadBalanced ?? true,
    clientIdentity: options?.clientIdentity,
  };
}

function toSelfHostedSyncOptions(
  options: McodaAgentSyncInput | undefined
): ListMswarmSelfHostedAgentsOptions {
  return {
    provider: options?.provider,
    includeUnreachable: options?.includeUnreachable ?? true,
    includeLoadBalanced: options?.includeLoadBalanced ?? true,
    pruneMissing: options?.pruneMissing ?? true,
    clientIdentity: options?.clientIdentity,
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
