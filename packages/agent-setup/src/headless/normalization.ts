import type {
  McodaAgentCatalogEntry,
  McodaAgentManagedKind,
  McodaAgentSource,
  McodaLocalRunnerCatalogMetadata,
  McodaSelfHostedClientIdentity,
  McodaSelfHostedLifecycleMetadata,
  McodaSelfHostedRelayMetadata,
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

const numberFromRecords = (
  records: Array<Record<string, unknown> | undefined>,
  keys: string[]
): number | null => {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = numberValue(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
};

const normalizeSelfHostedClientIdentity = (
  value: unknown
): McodaSelfHostedClientIdentity | null => {
  const direct = stringValue(value);
  if (direct) return { kind: "domain", value: direct };
  if (!isRecord(value)) return null;
  const identity =
    stringValue(value.value) ??
    stringValue(value.domain) ??
    stringValue(value.ip) ??
    stringValue(value.uuid) ??
    stringValue(value.id) ??
    stringValue(value.client);
  if (!identity) return null;
  const addedAt =
    stringValue(value.addedAt) ??
    stringValue(value.added_at);
  return {
    kind: stringValue(value.kind) ?? stringValue(value.type) ?? "domain",
    value: identity,
    addedAt,
    added_at: addedAt,
  };
};

const clientAllowlistFromRecords = (
  records: Array<Record<string, unknown> | undefined>,
  keys: string[]
): McodaSelfHostedClientIdentity[] | undefined => {
  const entries: McodaSelfHostedClientIdentity[] = [];
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const raw = record[key];
      const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
      for (const value of values) {
        const identity = normalizeSelfHostedClientIdentity(value);
        if (identity) entries.push(identity);
      }
      if (entries.length) break;
    }
    if (entries.length) break;
  }
  if (!entries.length) return undefined;
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind}:${entry.value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const loadBalanced =
    booleanValue(record.load_balanced) ??
    booleanValue(record.loadBalanced) ??
    booleanValue(mswarmSelfHosted?.loadBalanced) ??
    booleanValue(sync?.load_balanced) ??
    false;
  const routingMode =
    stringValue(record.routingMode) ??
    stringValue(record.routing_mode) ??
    stringValue(mswarmSelfHosted?.routingMode) ??
    (loadBalanced ? "auto" : null);
  const managedKind =
    fallback.managedKind === "self_hosted" && routingMode === "auto"
      ? "self_hosted_load_balanced"
      : fallback.managedKind ??
    (mswarmCloud
      ? "cloud"
      : mswarmSelfHosted
        ? routingMode === "auto"
          ? "self_hosted_load_balanced"
          : "self_hosted"
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
  const healthDetails = recordValue(health?.details);
  const healthStatus =
    stringValue(record.healthStatus) ??
    stringValue(record.health_status) ??
    stringValue(health?.status) ??
    stringValue(record.status);
  const healthReason = stringFromRecords(
    [record, health, healthDetails, mswarmSelfHosted, sync],
    ["healthReason", "health_reason", "reason", "lifecycle_health_reason"]
  );
  const nodeId =
    routingMode === "auto"
      ? null
      : stringValue(record.nodeId) ??
        stringValue(record.node_id) ??
        stringValue(mswarmSelfHosted?.nodeId) ??
        stringValue(sync?.node_id);
  const serverName =
    routingMode === "auto"
      ? null
      : stringValue(record.serverName) ??
        stringValue(record.server_name) ??
        stringValue(mswarmSelfHosted?.serverName) ??
        stringValue(sync?.server_name);
  const selfHostedLifecycle = normalizeSelfHostedLifecycleMetadata(
    record,
    mswarmSelfHosted,
    sync,
    health,
    healthDetails
  );
  const clientIdentity = stringFromRecords(
    [record, mswarmSelfHosted, sync],
    ["clientIdentity", "client_identity", "client"]
  );
  const clientAllowlist = clientAllowlistFromRecords(
    [record, mswarmSelfHosted, sync],
    ["clientAllowlist", "client_allowlist", "clients"]
  );
  const clientAllowlistCount =
    numberFromRecords(
      [record, mswarmSelfHosted, sync],
      ["clientAllowlistCount", "client_allowlist_count"]
    ) ?? clientAllowlist?.length ?? null;

  return {
    slug,
    source: fallback.source,
    synced: fallback.synced ?? fallback.source === "local_registry",
    remoteSlug,
    managedKind,
    routingMode: routingMode === "auto" ? "auto" : routingMode === "direct" ? "direct" : null,
    loadBalancedGroupId:
      stringValue(record.loadBalancedGroupId) ??
      stringValue(record.load_balanced_group_id) ??
      stringValue(mswarmSelfHosted?.loadBalancedGroupId) ??
      stringValue(sync?.group_id),
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
    healthReason: healthReason ?? selfHostedLifecycle?.reason ?? null,
    clientIdentity,
    clientAllowlist,
    clientAllowlistCount,
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
    selfHostedLifecycle,
    capabilities: stringArrayValue(record.capabilities),
    metadata: {
      raw,
    },
  };
}

function normalizeSelfHostedLifecycleMetadata(
  record: Record<string, unknown>,
  mswarmSelfHosted: Record<string, unknown> | undefined,
  sync: Record<string, unknown> | undefined,
  health: Record<string, unknown> | undefined,
  healthDetails: Record<string, unknown> | undefined
): McodaSelfHostedLifecycleMetadata | null {
  const lifecycle =
    recordValue(record.lifecycle) ??
    recordValue(mswarmSelfHosted?.lifecycle) ??
    recordValue(sync?.lifecycle);
  const relay = normalizeSelfHostedRelayMetadata(
    record,
    mswarmSelfHosted,
    sync,
    healthDetails
  );
  const reason = stringFromRecords(
    [record, health, healthDetails, mswarmSelfHosted, lifecycle, sync],
    ["healthReason", "health_reason", "reason", "lifecycle_health_reason"]
  );
  const missingRoute = stringFromRecords(
    [record, healthDetails, lifecycle, sync],
    ["missingRoute", "missing_route"]
  );
  const missingRoutes =
    stringArrayValue(record.missingRoutes) ??
    stringArrayValue(record.missing_routes) ??
    stringArrayValue(healthDetails?.missingRoutes) ??
    stringArrayValue(healthDetails?.missing_routes) ??
    stringArrayValue(lifecycle?.missingRoutes) ??
    stringArrayValue(lifecycle?.missing_routes) ??
    (missingRoute ? [missingRoute] : []);
  const compatible =
    booleanFromRecords(
      [record, healthDetails, mswarmSelfHosted, lifecycle, sync],
      ["lifecycleCompatible", "lifecycle_compatible", "compatible"]
    ) ?? (reason === "self_hosted_protocol_mismatch" ? false : null);
  const checkedAt = stringFromRecords(
    [record, health, healthDetails, lifecycle, sync],
    ["checkedAt", "checked_at", "lastCheckedAt", "last_checked_at"]
  );
  const runtimePackageVersion = stringFromRecords(
    [record, healthDetails, mswarmSelfHosted, sync],
    ["runtimePackageVersion", "runtime_package_version", "node_version"]
  );
  const hasLifecycle =
    Boolean(lifecycle) ||
    Boolean(relay) ||
    Boolean(reason) ||
    missingRoutes.length > 0 ||
    Boolean(runtimePackageVersion);
  if (!hasLifecycle) return null;
  return {
    compatible,
    reason,
    missingRoute: missingRoutes[0] ?? missingRoute ?? null,
    missingRoutes,
    checkedAt,
    runtimePackageVersion,
    relay,
  };
}

function normalizeSelfHostedRelayMetadata(
  record: Record<string, unknown>,
  mswarmSelfHosted: Record<string, unknown> | undefined,
  sync: Record<string, unknown> | undefined,
  healthDetails: Record<string, unknown> | undefined
): McodaSelfHostedRelayMetadata | null {
  const relay = recordValue(record.relay);
  const configRelay = recordValue(mswarmSelfHosted?.relay);
  const syncRelay = recordValue(sync?.relay);
  const records = [
    record,
    relay,
    mswarmSelfHosted,
    configRelay,
    sync,
    syncRelay,
    healthDetails,
  ];
  const value: McodaSelfHostedRelayMetadata = {
    gatewayBaseUrl: stringFromRecords(records, [
      "gatewayBaseUrl",
      "gateway_base_url",
    ]),
    jobsPollPath: stringFromRecords(records, ["jobsPollPath", "jobs_poll_path"]),
    jobsStartPathTemplate: stringFromRecords(records, [
      "jobsStartPathTemplate",
      "jobs_start_path_template",
    ]),
    jobsEventsPathTemplate: stringFromRecords(records, [
      "jobsEventsPathTemplate",
      "jobs_events_path_template",
    ]),
    jobsResultPathTemplate: stringFromRecords(records, [
      "jobsResultPathTemplate",
      "jobs_result_path_template",
    ]),
  };
  return Object.values(value).some(Boolean) ? value : null;
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
