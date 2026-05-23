import { defaultMcodaStageDefinitions } from "../defaultStages.js";
import {
  buildCloudAgentOptions,
  buildSelfHostedServerOptions,
  buildWorkerAgentOptions,
} from "../headless/catalog.js";
import { createProgrammaticMcodaRuntimeAdapter } from "./programmaticRuntime.js";
import type {
  McodaAgentCatalog,
  McodaAgentCatalogEntry,
  McodaAgentSetupServerOptions,
  McodaAgentSetupService,
  McodaAgentSetupSnapshot,
  McodaMswarmConnectionInput,
  McodaMswarmConnectionMetadata,
  McodaStageDefinition,
} from "../types.js";

const REMOTE_ATTEMPTS = 3;

export function createMcodaAgentSetupService(
  options: McodaAgentSetupServerOptions
): McodaAgentSetupService {
  const runtime = options.mcoda ?? createProgrammaticMcodaRuntimeAdapter();
  const stages = options.defaultStages ?? defaultMcodaStageDefinitions;
  const provider = options.provider ?? "mcoda_mswarm";

  const authorize = async (request: unknown): Promise<void> => {
    await options.authorize?.(request);
  };

  const capture = async <T>(
    errors: Record<string, string>,
    key: string,
    fn: () => Promise<T>,
    fallback: T,
    attempts = 1
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await sleep(150 * attempt);
        }
      }
    }
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    errors[key] = message;
    options.logger?.warn?.(`mcoda agent setup ${key} failed`, {
      error: message,
    });
    return fallback;
  };

  const captureRemote = async <T>(
    errors: Record<string, string>,
    key: string,
    fn: () => Promise<T>,
    fallback: T
  ): Promise<T> => {
    return capture(errors, key, fn, fallback, REMOTE_ATTEMPTS);
  };

  const buildSnapshot = async (
    extraErrors: Record<string, string> = {}
  ): Promise<McodaAgentSetupSnapshot> => {
    const settings = await options.settingsStore.load();
    const errors: Record<string, string> = { ...extraErrors };
    const [
      localAgents,
      cloudCatalogAgents,
      selfHostedCatalogAgents,
      workerCatalogAgents,
    ] =
      await Promise.all([
        capture(
          errors,
          "local_agents",
          () => runtime.listLocalAgents({ refreshHealth: true }),
          []
        ),
        captureRemote(
          errors,
          "cloud_agents",
          () => runtime.listCloudAgents(),
          []
        ),
        captureRemote(
          errors,
          "self_hosted_agents",
          () => runtime.listSelfHostedAgents({ includeUnreachable: true }),
          []
        ),
        captureRemote(
          errors,
          "worker_agents",
          () => runtime.listWorkerAgents(),
          []
        ),
      ]);
    const cloudAgents =
      errors.cloud_agents === undefined
        ? buildCloudAgentOptions(localAgents, cloudCatalogAgents)
        : [];
    const selfHostedServers =
      errors.self_hosted_agents === undefined
        ? buildSelfHostedServerOptions(localAgents, selfHostedCatalogAgents)
        : [];
    const workerAgents =
      errors.worker_agents === undefined
        ? buildWorkerAgentOptions(localAgents, workerCatalogAgents)
        : [];
    const catalog: McodaAgentCatalog = {
      localAgents,
      cloudAgents,
      selfHostedAgents: selfHostedCatalogAgents,
      workerAgents,
      selfHostedServers,
      errors,
      generatedAt: new Date().toISOString(),
    };
    return {
      provider,
      runtime: runtime.runtime,
      mswarmApiKeyConfigured: settings.mswarmApiKeyConfigured,
      mswarmApiKeyLast4: settings.mswarmApiKeyLast4,
      mswarmConfiguredAt: settings.mswarmConfiguredAt,
      mswarmConnection: settings.mswarmConnection ?? null,
      stages,
      assignments: {
        ...initialAssignments(stages),
        ...settings.assignments,
      },
      catalog,
      updatedAt: settings.updatedAt,
      fetchedAt: new Date().toISOString(),
    };
  };

  return {
    async fetchSnapshot(request) {
      await authorize(request);
      return buildSnapshot();
    },
    async configureMswarmApiKey(input, request) {
      await authorize(request);
      const apiKey = input.apiKey.trim();
      if (!apiKey) {
        throw new Error("mswarm api key is required");
      }
      const connection = await runtime.configureMswarmApiKey({
        ...input,
        apiKey,
      });
      const configuredAt = new Date().toISOString();
      await options.settingsStore.saveMswarmKeyMetadata({
        configured: true,
        last4: apiKey.slice(-4),
        configuredAt,
        connection: connection ?? fallbackMswarmConnection(input.connection),
        actor: input.actor,
        reasonCode: input.reasonCode,
      });
      const errors = await syncCatalogs();
      return buildSnapshot(errors);
    },
    async syncAgents(input = {}, request) {
      await authorize(request);
      const errors = await syncCatalogs();
      options.logger?.info?.("mcoda agent setup sync completed", {
        reasonCode: input.reasonCode,
        errors,
      });
      return buildSnapshot(errors);
    },
    async updateAssignments(input, request) {
      await authorize(request);
      const localAgents = await runtime.listLocalAgents({ refreshHealth: true });
      const nextAssignments = {
        ...initialAssignments(stages),
        ...input.assignments,
      };
      validateAssignments(nextAssignments, stages, localAgents);
      await options.settingsStore.saveAssignments({
        assignments: nextAssignments,
        actor: input.actor,
        reasonCode: input.reasonCode,
      });
      return buildSnapshot();
    },
    async testAgent(input, request) {
      await authorize(request);
      if (!runtime.testAgent) {
        throw new Error("The configured mcoda runtime adapter does not support agent tests");
      }
      return runtime.testAgent(input);
    },
  };

  async function syncCatalogs(): Promise<Record<string, string>> {
    const errors: Record<string, string> = {};
    await captureRemote(
      errors,
      "cloud_agent_sync",
      () => runtime.syncCloudAgents({ pruneMissing: true }),
      []
    );
    await captureRemote(
      errors,
      "self_hosted_agent_sync",
      () =>
        runtime.syncSelfHostedAgents({
          pruneMissing: true,
          includeUnreachable: true,
        }),
      []
    );
    await captureRemote(
      errors,
      "worker_agent_sync",
      () => runtime.syncWorkerAgents({ pruneMissing: true }),
      []
    );
    return errors;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initialAssignments(
  stages: McodaStageDefinition[]
): Record<string, string | null> {
  return Object.fromEntries(
    stages.map((stage) => [stage.stageKey, stage.defaultAgentSlug ?? null])
  );
}

function fallbackMswarmConnection(
  input: McodaMswarmConnectionInput | undefined
): McodaMswarmConnectionMetadata | null {
  if (!input) return null;
  const connection: McodaMswarmConnectionMetadata = {
    tenantId: normalizeString(input.tenantId),
    productSlug: normalizeString(input.productSlug),
    apiKeyId: normalizeString(input.apiKeyId),
    ownerUserId: normalizeString(input.ownerUserId),
    ownerKeycloakUserId: normalizeString(input.ownerKeycloakUserId),
    featureKey: normalizeString(input.featureKey),
    installationId: normalizeString(input.installationId),
    installationStatus: normalizeString(input.installationStatus),
    validationStatus: "unverified",
    validationErrors: [],
    validatedAt: null,
  };
  return [
    connection.tenantId,
    connection.productSlug,
    connection.apiKeyId,
    connection.ownerUserId,
    connection.ownerKeycloakUserId,
    connection.featureKey,
    connection.installationId,
    connection.installationStatus,
  ].some(Boolean)
    ? connection
    : null;
}

function normalizeString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateAssignments(
  assignments: Record<string, string | null>,
  stages: McodaStageDefinition[],
  localAgents: McodaAgentCatalogEntry[]
): void {
  const stageByKey = new Map(stages.map((stage) => [stage.stageKey, stage]));
  const validSlugs = new Set(localAgents.map((agent) => agent.slug));
  for (const [stageKey, slug] of Object.entries(assignments)) {
    const stage = stageByKey.get(stageKey);
    if (!stage) {
      throw new Error(`Unknown mcoda stage: ${stageKey}`);
    }
    if (!slug) {
      if (stage.nullable || stage.fallbackStageKey) continue;
      throw new Error(`Stage ${stageKey} requires an agent assignment`);
    }
    if (!validSlugs.has(slug)) {
      throw new Error(`Selected agent ${slug} is not present in the local registry`);
    }
  }
}
