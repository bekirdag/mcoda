import type {
  McodaAgentCatalogEntry,
  McodaAgentManagedKind,
  McodaAgentSource,
} from "../types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const booleanValue = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const stringArrayValue = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : undefined;

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

export function normalizeAgentCatalogEntry(
  raw: unknown,
  fallback: {
    source: McodaAgentSource;
    synced?: boolean;
    managedKind?: McodaAgentManagedKind;
  }
): McodaAgentCatalogEntry {
  const record = isRecord(raw) ? raw : {};
  const config = recordValue(record.config);
  const mswarmCloud = recordValue(config?.mswarmCloud);
  const mswarmSelfHosted = recordValue(config?.mswarmSelfHosted);
  const mswarmWorker = recordValue(config?.mswarmWorker);
  const sync =
    recordValue(record.sync) ??
    recordValue(mswarmSelfHosted?.sync) ??
    recordValue(mswarmWorker?.sync);
  const managedKind =
    fallback.managedKind ??
    (mswarmCloud
      ? "cloud"
      : mswarmSelfHosted
        ? "self_hosted"
        : mswarmWorker
          ? "worker"
          : null);
  const remoteSlug =
    stringValue(record.remoteSlug) ??
    stringValue(record.remote_slug) ??
    stringValue(mswarmCloud?.remoteSlug) ??
    stringValue(mswarmSelfHosted?.remoteSlug) ??
    stringValue(mswarmWorker?.remoteSlug);
  const slug =
    stringValue(record.slug) ??
    stringValue(record.agent_slug) ??
    stringValue(mswarmSelfHosted?.agentSlug) ??
    stringValue(mswarmWorker?.workerId) ??
    remoteSlug ??
    "agent";
  const defaultModel =
    stringValue(record.defaultModel) ??
    stringValue(record.default_model) ??
    stringValue(record.defaultModelId) ??
    stringValue(record.model_id) ??
    stringValue(mswarmCloud?.modelId) ??
    stringValue(mswarmSelfHosted?.modelId) ??
    stringValue(mswarmWorker?.modelId);
  const model =
    stringValue(record.model) ??
    stringValue(record.modelId) ??
    stringValue(record.model_id) ??
    defaultModel;
  const health = recordValue(record.health);
  const healthStatus =
    stringValue(record.healthStatus) ??
    stringValue(record.health_status) ??
    stringValue(health?.status) ??
    stringValue(record.status);
  const nodeId =
    stringValue(record.nodeId) ??
    stringValue(record.node_id) ??
    stringValue(mswarmSelfHosted?.nodeId) ??
    stringValue(sync?.node_id);
  const serverName =
    stringValue(record.serverName) ??
    stringValue(record.server_name) ??
    stringValue(mswarmSelfHosted?.serverName) ??
    stringValue(sync?.server_name);

  return {
    slug,
    source: fallback.source,
    synced: fallback.synced ?? fallback.source === "local_registry",
    remoteSlug,
    managedKind,
    nodeId,
    serverName,
    serverId:
      stringValue(record.serverId) ??
      stringValue(record.server_id) ??
      stringValue(sync?.server_id),
    serverLabel:
      stringValue(record.serverLabel) ??
      stringValue(record.server_label) ??
      serverName,
    displayName:
      stringValue(record.displayName) ??
      stringValue(record.display_name) ??
      stringValue(mswarmCloud?.displayName) ??
      stringValue(mswarmSelfHosted?.displayName) ??
      stringValue(mswarmWorker?.displayName),
    provider:
      stringValue(record.provider) ??
      stringValue(mswarmCloud?.provider) ??
      stringValue(mswarmSelfHosted?.provider) ??
      stringValue(mswarmWorker?.provider),
    adapter:
      stringValue(record.adapter) ??
      stringValue(mswarmSelfHosted?.adapter) ??
      (mswarmWorker ? "mswarm-worker" : null),
    model,
    defaultModel,
    healthStatus,
    supportsTools:
      booleanValue(record.supportsTools) ??
      booleanValue(record.supports_tools),
    rating: numberValue(record.rating),
    reasoningRating:
      numberValue(record.reasoningRating) ??
      numberValue(record.reasoning_rating),
    maxComplexity:
      numberValue(record.maxComplexity) ??
      numberValue(record.max_complexity),
    costPerMillion:
      numberValue(record.costPerMillion) ??
      numberValue(record.cost_per_million),
    contextWindow:
      numberValue(record.contextWindow) ??
      numberValue(record.context_window),
    maxOutputTokens:
      numberValue(record.maxOutputTokens) ??
      numberValue(record.max_output_tokens),
    bestUsage:
      stringValue(record.bestUsage) ??
      stringValue(record.best_usage),
    capabilities: stringArrayValue(record.capabilities),
    metadata: {
      raw,
    },
  };
}

export function normalizeAgentCatalogEntries(
  raw: unknown,
  fallback: {
    source: McodaAgentSource;
    synced?: boolean;
    managedKind?: McodaAgentManagedKind;
  }
): McodaAgentCatalogEntry[] {
  const values = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.agents)
      ? raw.agents
      : [];
  return values.map((item) => normalizeAgentCatalogEntry(item, fallback));
}
