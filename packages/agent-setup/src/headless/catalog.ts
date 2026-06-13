import type {
  McodaAgentCatalogEntry,
  McodaSelfHostedServer,
} from "../types.js";

const CLOUD_PREFIX = "mswarm-cloud-";
const SELF_HOSTED_PREFIX = "mswarm-self-hosted-";
const WORKER_PREFIX = "mswarm-worker-";

const normalizeSlugPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const lower = (value: string | null | undefined): string =>
  value?.trim().toLowerCase() ?? "";

const truthyStrings = (values: Array<string | null | undefined>): string[] =>
  values.map((value) => value?.trim() ?? "").filter(Boolean);

export function isCloudAgent(agent: McodaAgentCatalogEntry): boolean {
  return (
    agent.source === "cloud_catalog" ||
    agent.managedKind === "cloud" ||
    agent.slug.startsWith(CLOUD_PREFIX)
  );
}

export function isSelfHostedAgent(agent: McodaAgentCatalogEntry): boolean {
  return (
    agent.source === "self_hosted_catalog" ||
    agent.managedKind === "self_hosted" ||
    agent.slug.startsWith(SELF_HOSTED_PREFIX) ||
    Boolean(agent.nodeId || agent.serverName || agent.serverId)
  );
}

export function isWorkerAgent(agent: McodaAgentCatalogEntry): boolean {
  return (
    agent.source === "worker_catalog" ||
    agent.managedKind === "worker" ||
    agent.slug.startsWith(WORKER_PREFIX)
  );
}

export function syncedCloudSlug(agent: McodaAgentCatalogEntry): string {
  if (agent.slug.startsWith(CLOUD_PREFIX)) return agent.slug;
  const remote = agent.remoteSlug ?? agent.slug;
  return `${CLOUD_PREFIX}${normalizeSlugPart(remote) || "agent"}`;
}

export function syncedSelfHostedSlug(agent: McodaAgentCatalogEntry): string {
  if (agent.slug.startsWith(SELF_HOSTED_PREFIX)) return agent.slug;
  const remote = agent.remoteSlug ?? agent.slug;
  return `${SELF_HOSTED_PREFIX}${normalizeSlugPart(remote) || "agent"}`;
}

export function syncedWorkerSlug(agent: McodaAgentCatalogEntry): string {
  if (agent.slug.startsWith(WORKER_PREFIX)) return agent.slug;
  const remote = (agent.remoteSlug ?? agent.slug).replace(/^worker_/i, "");
  return `${WORKER_PREFIX}${normalizeSlugPart(remote) || "agent"}`;
}

export function mergeCatalogEntries(
  local: McodaAgentCatalogEntry,
  catalog?: McodaAgentCatalogEntry
): McodaAgentCatalogEntry {
  if (!catalog) return local;
  return {
    ...catalog,
    ...local,
    displayName: local.displayName ?? catalog.displayName,
    provider: local.provider ?? catalog.provider,
    adapter: local.adapter ?? catalog.adapter,
    model: local.model ?? catalog.model,
    defaultModel: local.defaultModel ?? catalog.defaultModel,
    healthStatus: local.healthStatus ?? catalog.healthStatus,
    supportsTools: local.supportsTools ?? catalog.supportsTools,
    rating: local.rating ?? catalog.rating,
    reasoningRating: local.reasoningRating ?? catalog.reasoningRating,
    maxComplexity: local.maxComplexity ?? catalog.maxComplexity,
    costPerMillion: local.costPerMillion ?? catalog.costPerMillion,
    contextWindow: local.contextWindow ?? catalog.contextWindow,
    maxOutputTokens: local.maxOutputTokens ?? catalog.maxOutputTokens,
    bestUsage: local.bestUsage ?? catalog.bestUsage,
    capabilities: local.capabilities?.length
      ? local.capabilities
      : catalog.capabilities,
    metadata: {
      ...(catalog.metadata ?? {}),
      ...(local.metadata ?? {}),
    },
    source: local.source,
    synced: true,
  };
}

export function buildCloudAgentOptions(
  localAgents: McodaAgentCatalogEntry[],
  cloudCatalogAgents: McodaAgentCatalogEntry[]
): McodaAgentCatalogEntry[] {
  const catalogByLocalSlug = new Map(
    cloudCatalogAgents.map((agent) => [syncedCloudSlug(agent), agent])
  );
  const synced = localAgents
    .filter(isCloudAgent)
    .map((agent) => mergeCatalogEntries(agent, catalogByLocalSlug.get(agent.slug)));
  const localSlugs = new Set(synced.map((agent) => agent.slug));
  const unsynced = cloudCatalogAgents
    .filter((agent) => !localSlugs.has(syncedCloudSlug(agent)))
    .map((agent) => ({ ...agent, synced: false }));
  return sortAgents([...synced, ...unsynced]);
}

export function buildSelfHostedServerOptions(
  localAgents: McodaAgentCatalogEntry[],
  remoteAgents: McodaAgentCatalogEntry[]
): McodaSelfHostedServer[] {
  const remoteByLocalSlug = new Map(
    remoteAgents.map((agent) => [syncedSelfHostedSlug(agent), agent])
  );
  const combined = [
    ...localAgents
      .filter(isSelfHostedAgent)
      .map((agent) => mergeCatalogEntries(agent, remoteByLocalSlug.get(agent.slug))),
    ...remoteAgents
      .filter((agent) => !localAgents.some((local) => local.slug === syncedSelfHostedSlug(agent)))
      .map((agent) => ({ ...agent, synced: false })),
  ];

  const servers = new Map<string, McodaSelfHostedServer>();
  for (const agent of combined) {
    const server = resolveSelfHostedServer(agent);
    const existing = servers.get(server.id);
    if (existing) {
      existing.agents.push(agent);
      existing.agentCount = existing.agents.length;
      existing.status = mergeServerStatus(existing.status, server.status);
      continue;
    }
    servers.set(server.id, {
      ...server,
      agents: [agent],
      agentCount: 1,
    });
  }

  return Array.from(servers.values())
    .map((server) => ({
      ...server,
      agents: sortAgents(server.agents),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function buildWorkerAgentOptions(
  localAgents: McodaAgentCatalogEntry[],
  workerCatalogAgents: McodaAgentCatalogEntry[]
): McodaAgentCatalogEntry[] {
  const catalogByLocalSlug = new Map(
    workerCatalogAgents.map((agent) => [syncedWorkerSlug(agent), agent])
  );
  const synced = localAgents
    .filter(isWorkerAgent)
    .map((agent) => mergeCatalogEntries(agent, catalogByLocalSlug.get(agent.slug)));
  const localSlugs = new Set(synced.map((agent) => agent.slug));
  const unsynced = workerCatalogAgents
    .filter((agent) => !localSlugs.has(syncedWorkerSlug(agent)))
    .map((agent) => ({ ...agent, synced: false }));
  return sortAgents([...synced, ...unsynced]);
}

export function filterAgentOptions(
  agents: McodaAgentCatalogEntry[],
  query: string
): McodaAgentCatalogEntry[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return sortAgents(agents);
  return sortAgents(
    agents.filter((agent) => {
      const haystack = [
        agent.displayName,
        agent.slug,
        agent.remoteSlug,
        agent.model,
        agent.defaultModel,
        agent.provider,
        agent.adapter,
        agent.localRunner?.runnerKind,
        agent.localRunner?.baseUrl,
        agent.localRunner?.authMode,
        agent.localRunner?.responseFormatStrategy,
        agent.healthStatus,
        agent.bestUsage,
        agent.serverName,
        agent.serverLabel,
        agent.nodeId,
        ...(agent.capabilities ?? []),
      ]
        .map(lower)
        .join(" ");
      return terms.every((term) => haystack.includes(term));
    })
  );
}

export function resolveRunnableSelectionSlug(
  slug: string,
  localAgents: McodaAgentCatalogEntry[]
): string {
  const trimmed = slug.trim();
  if (!trimmed) return trimmed;
  if (localAgents.some((agent) => agent.slug === trimmed)) return trimmed;
  const candidate = localAgents.find((agent) => {
    if (agent.remoteSlug === trimmed) return true;
    if (isCloudAgent(agent) && agent.slug === syncedCloudSlug({ ...agent, slug: trimmed })) {
      return true;
    }
    if (
      isSelfHostedAgent(agent) &&
      agent.slug === syncedSelfHostedSlug({ ...agent, slug: trimmed })
    ) {
      return true;
    }
    if (isWorkerAgent(agent) && agent.slug === syncedWorkerSlug({ ...agent, slug: trimmed })) {
      return true;
    }
    return false;
  });
  return candidate?.slug ?? trimmed;
}

export function getVirtualAgentWindow<T>(
  items: T[],
  input: {
    scrollTop: number;
    rowHeight: number;
    viewportHeight: number;
    overscan?: number;
  }
): {
  startIndex: number;
  endIndex: number;
  items: T[];
  beforeHeight: number;
  afterHeight: number;
  totalHeight: number;
} {
  const rowHeight = Math.max(1, Math.trunc(input.rowHeight));
  const viewportHeight = Math.max(1, Math.trunc(input.viewportHeight));
  const overscan = Math.max(0, Math.trunc(input.overscan ?? 4));
  const totalHeight = items.length * rowHeight;
  const visibleStart = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const startIndex = Math.max(0, visibleStart - overscan);
  const endIndex = Math.min(items.length, visibleStart + visibleCount + overscan);
  return {
    startIndex,
    endIndex,
    items: items.slice(startIndex, endIndex),
    beforeHeight: startIndex * rowHeight,
    afterHeight: Math.max(0, totalHeight - endIndex * rowHeight),
    totalHeight,
  };
}

function resolveSelfHostedServer(
  agent: McodaAgentCatalogEntry
): Omit<McodaSelfHostedServer, "agentCount" | "agents"> {
  const nodeId = agent.nodeId?.trim() || undefined;
  const serverName = agent.serverName?.trim() || undefined;
  const serverId = agent.serverId?.trim() || undefined;
  if (nodeId || serverName || serverId) {
    const id = normalizeSlugPart(serverId ?? nodeId ?? serverName ?? "server");
    return {
      id,
      label: agent.serverLabel ?? serverName ?? nodeId ?? serverId ?? id,
      nodeId,
      serverName,
      status: agent.healthStatus,
      remoteSlugPrefix: undefined,
    };
  }

  const remote = agent.remoteSlug ?? agent.slug;
  const parts = truthyStrings(remote.split(/[-_:/.]+/));
  const prefixParts = parts.length >= 2 ? parts.slice(0, 2) : parts.slice(0, 1);
  const remoteSlugPrefix = prefixParts.join("-");
  const id = normalizeSlugPart(remoteSlugPrefix || remote || "server") || "server";
  return {
    id,
    label: remoteSlugPrefix || id,
    status: agent.healthStatus,
    remoteSlugPrefix: remoteSlugPrefix || null,
  };
}

function mergeServerStatus(
  current: string | null | undefined,
  next: string | null | undefined
): string | null | undefined {
  if (current === "healthy" || next === "healthy") return "healthy";
  if (current === "degraded" || next === "degraded") return "degraded";
  return current ?? next;
}

function sortAgents(agents: McodaAgentCatalogEntry[]): McodaAgentCatalogEntry[] {
  return [...agents].sort((left, right) => {
    const healthRank = healthScore(right.healthStatus) - healthScore(left.healthStatus);
    if (healthRank !== 0) return healthRank;
    const ratingRank = (right.rating ?? -1) - (left.rating ?? -1);
    if (ratingRank !== 0) return ratingRank;
    const leftName = left.displayName ?? left.slug;
    const rightName = right.displayName ?? right.slug;
    return leftName.localeCompare(rightName);
  });
}

function healthScore(value: string | null | undefined): number {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "healthy") return 3;
  if (normalized === "degraded" || normalized === "limited") return 2;
  if (normalized === "unreachable" || normalized === "offline") return 1;
  return 0;
}
