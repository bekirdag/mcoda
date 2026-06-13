import type {
  McodaAgentCatalogEntry,
  McodaAgentManagedKind,
  McodaAgentSource,
  McodaLocalRunnerCatalogMetadata,
} from "../types.js";

const LOCAL_OPENAI_COMPATIBLE_ADAPTERS = new Set([
  "openai-compatible-local",
  "vllm-local",
  "llama-cpp-local",
  "llamacpp-local",
]);

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

const lookupKey = (value: string): string => value.trim().toLowerCase();

const stringFromRecords = (
  records: Array<Record<string, unknown> | undefined>,
  keys: string[]
): string | null => {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return null;
};

const booleanFromRecords = (
  records: Array<Record<string, unknown> | undefined>,
  keys: string[]
): boolean | null => {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = booleanValue(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
};

const defaultRunnerKindForAdapter = (adapter: string | null): string | null => {
  const normalized = adapter ? lookupKey(adapter) : "";
  if (normalized === "vllm-local") return "vllm";
  if (normalized === "llama-cpp-local" || normalized === "llamacpp-local") {
    return "llama-cpp";
  }
  return null;
};

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
  const localRunner = recordValue(config?.localRunner);
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
  const adapter =
    stringValue(record.adapter) ??
    stringValue(mswarmSelfHosted?.adapter) ??
    (mswarmWorker ? "mswarm-worker" : null);
  const localRunnerMetadata = normalizeLocalRunnerMetadata(
    record,
    config,
    localRunner,
    adapter
  );
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
    adapter,
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
    localRunner: localRunnerMetadata,
    capabilities: stringArrayValue(record.capabilities),
    metadata: {
      raw,
    },
  };
}

function normalizeLocalRunnerMetadata(
  record: Record<string, unknown>,
  config: Record<string, unknown> | undefined,
  localRunner: Record<string, unknown> | undefined,
  adapter: string | null
): McodaLocalRunnerCatalogMetadata | null {
  const adapterIsLocal = adapter
    ? LOCAL_OPENAI_COMPATIBLE_ADAPTERS.has(lookupKey(adapter))
    : false;
  const records = [localRunner, config, adapterIsLocal ? record : undefined];
  const baseUrl = stringFromRecords(records, ["baseUrl", "endpoint", "apiBaseUrl"]);
  const runnerKind =
    stringFromRecords(records, ["runnerKind"]) ?? defaultRunnerKindForAdapter(adapter);
  const authMode = stringFromRecords(records, ["authMode"]);
  const responseFormatStrategy = stringFromRecords(records, [
    "responseFormatStrategy",
  ]);
  const healthPath = stringFromRecords(records, ["healthPath"]);
  const modelsPath = stringFromRecords(records, ["modelsPath"]);
  const requireModelInRequest = booleanFromRecords(records, [
    "requireModelInRequest",
  ]);
  const supportsStreaming = booleanFromRecords(records, ["supportsStreaming"]);
  const supportsTools = booleanFromRecords(records, ["supportsTools"]);
  const supportsJsonSchema = booleanFromRecords(records, ["supportsJsonSchema"]);
  const supportsGbnf = booleanFromRecords(records, ["supportsGbnf"]);

  if (
    !localRunner &&
    !adapterIsLocal &&
    !runnerKind &&
    !authMode &&
    !responseFormatStrategy &&
    !healthPath &&
    !modelsPath
  ) {
    return null;
  }

  return {
    baseUrl,
    runnerKind,
    authMode,
    responseFormatStrategy,
    healthPath,
    modelsPath,
    requireModelInRequest,
    supportsStreaming,
    supportsTools,
    supportsJsonSchema,
    supportsGbnf,
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
