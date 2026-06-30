import { createHmac, randomUUID } from 'node:crypto';
import { GlobalRepository } from '@mcoda/db';
import {
  CryptoHelper,
  type Agent,
  type AgentHealth,
  type AgentHealthStatus,
  type AgentModel,
  type CreateAgentInput,
  type MswarmArtifactRef,
  type MswarmGenericJobAuditEvent,
  type MswarmGenericJobLifecycleSnapshot,
  type MswarmGenericJobLogRecord,
  type MswarmJobEvent,
  type MswarmJobRequest,
  type MswarmJobType,
  type UpdateAgentInput,
} from '@mcoda/shared';
import { MswarmConfigStore } from './MswarmConfigStore.js';

export type { MswarmGenericJobLifecycleSnapshot } from '@mcoda/shared';

export type MswarmSelfHostedNodeClientIdentityKind =
  | 'domain'
  | 'ip'
  | 'uuid'
  | string;

export interface MswarmSelfHostedNodeClientIdentity {
  kind: MswarmSelfHostedNodeClientIdentityKind;
  value: string;
  added_at?: string;
  addedAt?: string;
}

export interface MswarmCloudAgent {
  slug: string;
  provider: string;
  default_model: string;
  cost_per_million?: number;
  rating?: number;
  reasoning_rating?: number;
  max_complexity?: number;
  capabilities: string[];
  health_status?: string;
  health_reason?: string;
  context_window?: number;
  max_output_tokens?: number;
  supports_tools: boolean;
  best_usage?: string;
  model_id?: string;
  display_name?: string;
  description?: string;
  supports_reasoning?: boolean;
  pricing_snapshot_id?: string;
  pricing_version?: string;
  rating_samples?: number;
  rating_last_score?: number;
  rating_updated_at?: string;
  complexity_samples?: number;
  complexity_updated_at?: string;
  sync?: Record<string, unknown>;
}

export interface MswarmSelfHostedAgent extends MswarmCloudAgent {
  agent_slug?: string;
  remote_slug?: string;
  adapter?: string;
  source_agent_id?: string;
  source_agent_slug?: string;
  load_balanced?: boolean;
  load_balanced_group_id?: string;
  selector_fingerprint?: string;
  member_count?: number;
  candidate_node_ids?: string[];
  canonical_agent_slug?: string;
  canonical_model_id?: string;
  execution_class?: string;
  policy_class?: string;
  context_tier?: string;
  client_identity?: string;
  client_allowlist?: MswarmSelfHostedNodeClientIdentity[];
  client_allowlist_count?: number;
  runtime_package_version?: string;
  gateway_base_url?: string;
  jobs_poll_path?: string;
  jobs_start_path_template?: string;
  jobs_events_path_template?: string;
  jobs_result_path_template?: string;
  relay?: {
    gateway_base_url?: string;
    jobs_poll_path?: string;
    jobs_start_path_template?: string;
    jobs_events_path_template?: string;
    jobs_result_path_template?: string;
  };
}

export interface MswarmWorkerAgent extends MswarmCloudAgent {
  id?: string;
  remote_slug?: string;
  updated_at?: string;
  adapter?: string;
  source?: string;
  worker?: {
    installation_id?: string;
    status?: string;
    enabled?: boolean;
    name?: string;
    api_run_url?: string;
    docdex_enabled?: boolean;
    selected_agent?: Record<string, unknown> | null;
    config_health?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface MswarmCloudAgentDetail extends MswarmCloudAgent {
  pricing?: Record<string, unknown>;
  supported_parameters?: string[];
  status?: string;
  moderation_status?: string;
  mcoda_shape?: Record<string, unknown>;
}

export interface MswarmSelfHostedAgentDetail
  extends MswarmSelfHostedAgent,
    Omit<MswarmCloudAgentDetail, keyof MswarmCloudAgent> {}

export interface MswarmWorkerAgentDetail
  extends MswarmWorkerAgent,
    Omit<MswarmCloudAgentDetail, keyof MswarmCloudAgent> {}

export interface ListMswarmCloudAgentsOptions {
  provider?: string;
  limit?: number;
  maxCostPerMillion?: number;
  minContextWindow?: number;
  minReasoningRating?: number;
  sortByCatalogRating?: boolean;
  pruneMissing?: boolean;
}

export interface ListMswarmSelfHostedAgentsOptions
  extends ListMswarmCloudAgentsOptions {
  includeUnreachable?: boolean;
  includeLoadBalanced?: boolean;
  clientIdentity?: string;
}

export interface GetMswarmSelfHostedAgentOptions {
  includeLoadBalanced?: boolean;
  clientIdentity?: string;
}

export interface ListMswarmWorkerAgentsOptions
  extends ListMswarmCloudAgentsOptions {
  includeDisabled?: boolean;
  cursor?: string;
  updatedAfter?: string;
}

export interface MswarmWorkerCatalogPage {
  workers: MswarmWorkerAgent[];
  next_cursor: string | null;
  generated_at?: string;
  total?: number;
}

export interface MswarmApiOptions {
  baseUrl?: string;
  openAiBaseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  agentSlugPrefix?: string;
  selfHostedAgentSlugPrefix?: string;
  workerAgentSlugPrefix?: string;
  clientIdentity?: string;
}

export interface MswarmConsentResponse {
  consent_token: string;
  expires_in_seconds?: number;
  consent_types?: string[];
  issued_at_ms?: number;
  client_id?: string;
  client_type?: string;
  tenant_id?: string;
  upload_signing_secret?: string;
}

export interface RegisterFreeMcodaClientOptions {
  clientId?: string;
  policyVersion?: string;
  productVersion: string;
}

export interface RequestMswarmDataDeletionInput {
  consentToken: string;
  product: string;
  clientId?: string;
  clientType?: string;
  reason?: string;
}

export interface MswarmDataDeletionResponse {
  accepted: boolean;
  request_id: number;
  product: string;
  client_id?: string;
  client_type?: string;
  tenant_id?: string;
  status: string;
  requested_at?: string;
}

interface ResolvedMswarmApiOptions {
  baseUrl: string;
  openAiBaseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  agentSlugPrefix: string;
  selfHostedAgentSlugPrefix: string;
  workerAgentSlugPrefix: string;
  clientIdentity?: string;
}

export interface ManagedMswarmCloudConfig {
  managed: true;
  remoteSlug: string;
  provider: string;
  modelId?: string;
  displayName?: string;
  description?: string;
  supportsReasoning?: boolean;
  pricingSnapshotId?: string;
  pricingVersion?: string;
  catalogBaseUrl: string;
  openAiBaseUrl: string;
  sync?: Record<string, unknown>;
  syncedAt: string;
}

export interface ManagedMswarmAgentConfig extends Record<string, unknown> {
  baseUrl: string;
  apiBaseUrl: string;
  mswarmCloud: ManagedMswarmCloudConfig;
}

export interface ManagedMswarmSelfHostedConfig {
  managed: true;
  remoteSlug: string;
  agentSlug: string;
  provider: string;
  routingMode?: 'direct' | 'auto';
  loadBalanced?: boolean;
  loadBalancedGroupId?: string;
  selectorFingerprint?: string;
  memberCount?: number;
  adapter?: string;
  sourceAgentSlug?: string;
  nodeId?: string;
  serverName?: string;
  modelId?: string;
  displayName?: string;
  description?: string;
  supportsReasoning?: boolean;
  healthReason?: string;
  clientIdentity?: string;
  clientAllowlist?: MswarmSelfHostedNodeClientIdentity[];
  clientAllowlistCount?: number;
  runtimePackageVersion?: string;
  relay?: {
    gatewayBaseUrl?: string;
    jobsPollPath?: string;
    jobsStartPathTemplate?: string;
    jobsEventsPathTemplate?: string;
    jobsResultPathTemplate?: string;
  };
  lifecycle?: {
    compatible: boolean;
    reason?: string;
    missingRoutes?: string[];
    checkedAt: string;
  };
  catalogBaseUrl: string;
  openAiBaseUrl: string;
  sync?: Record<string, unknown>;
  syncedAt: string;
}

export interface ManagedMswarmSelfHostedAgentConfig
  extends Record<string, unknown> {
  baseUrl: string;
  apiBaseUrl: string;
  mswarmSelfHosted: ManagedMswarmSelfHostedConfig;
}

export interface ManagedMswarmWorkerConfig {
  managed: true;
  remoteSlug: string;
  workerId: string;
  provider: string;
  modelId?: string;
  displayName?: string;
  description?: string;
  catalogBaseUrl: string;
  apiRunUrl?: string;
  worker?: Record<string, unknown>;
  sync?: Record<string, unknown>;
  syncedAt: string;
}

export interface ManagedMswarmWorkerAgentConfig
  extends Record<string, unknown> {
  baseUrl: string;
  apiBaseUrl: string;
  mswarmWorker: ManagedMswarmWorkerConfig;
}

export interface MswarmSyncRecord {
  remoteSlug: string;
  localSlug: string;
  action: 'created' | 'updated' | 'deleted';
  provider: string;
  defaultModel: string;
  pricingVersion?: string;
  routingMode?: 'direct' | 'auto';
  loadBalanced?: boolean;
  clientIdentity?: string;
}

export interface MswarmSyncSummary {
  created: number;
  updated: number;
  deleted: number;
  agents: MswarmSyncRecord[];
}

export interface MswarmManagedAuthRefreshSummary {
  updated: number;
  agents: string[];
}

export interface MswarmRuntimeUsageBudget {
  key: string;
  meter_id?: string | null;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  reset_at?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

export interface MswarmRuntimeUsageLimits {
  product_slug: string | null;
  tenant_id: string | null;
  api_key_id: string | null;
  subscription_id: string | null;
  budgets: MswarmRuntimeUsageBudget[];
  as_of: string | null;
}

export interface MswarmRuntimeIdentity {
  tenantId: string | null;
  productSlug: string | null;
  apiKeyId: string | null;
  subscriptionId: string | null;
  asOf: string | null;
  usageLimits: MswarmRuntimeUsageLimits;
}

export interface MswarmGenericNodeJobEnvelope {
  job_id: string;
  request_id: string;
  node_id: string;
  job: MswarmJobRequest;
}

export interface MswarmNodeAuthOptions {
  nodeBaseUrl?: string;
  token?: string;
  signingSecret?: string;
  tokenTtlSeconds?: number;
}

export interface MswarmCapabilityRequestOptions extends MswarmNodeAuthOptions {
  nodeId?: string;
}

export interface MswarmGenericJobOpsRequestOptions extends MswarmNodeAuthOptions {
  nodeId?: string;
  auditLimit?: number;
  auditOffset?: number;
}

export interface MswarmGenericJobReference extends MswarmNodeAuthOptions {
  jobId: string;
  nodeId?: string;
  requestId?: string;
  schemaVersion?: string;
  jobType?: MswarmJobType | string;
}

export interface MswarmGenericJobArtifactUploadInput
  extends MswarmGenericJobReference {
  name?: string;
  path: string;
  contentBase64: string;
  contentType?: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface MswarmGenericJobArtifactUploadResult {
  job_id: string;
  artifact: MswarmArtifactRef;
}

export interface MswarmGenericJobEventsResult {
  job_id: string;
  events: MswarmJobEvent[];
}

export interface MswarmGenericJobLogsResult {
  job_id: string;
  logs: MswarmGenericJobLogRecord[];
}

export interface MswarmGenericJobArtifactsResult {
  job_id: string;
  artifacts: MswarmArtifactRef[];
}

export interface MswarmGenericJobOpsJobSummary {
  job_id: string;
  request_id: string;
  tenant_id: string;
  node_id?: string;
  state: string;
  job_type: string;
  schema_version: string;
  created_at: string;
  updated_at: string;
  queued_at?: string;
  scheduled_at?: string;
  started_at?: string;
  finished_at?: string;
  retry_count: number;
  max_retries: number;
  progress_percent?: number;
  last_event_type?: string;
  last_event_message?: string;
  artifact_count: number;
  artifact_bytes: number;
  log_bytes: number;
}

export interface MswarmGenericJobOpsSummary {
  schema_version: string;
  generated_at: string;
  node: {
    node_id: string;
    listen_host?: string;
    listen_port?: number;
    owner_local: boolean;
    generic_jobs_enabled: boolean;
    artifact_store_configured: boolean;
    max_concurrent_jobs: number;
  };
  capabilities: Record<string, unknown>;
  queue: {
    jobs: MswarmGenericJobOpsJobSummary[];
    totals_by_state: Record<string, number>;
    active_jobs: number;
    queued_jobs: number;
    terminal_jobs: number;
  };
  quota: {
    max_concurrent_jobs: number;
    active_jobs: number;
    queued_jobs: number;
    available_slots: number;
    production_enforced: boolean;
    limits: Record<string, unknown>;
  };
  usage: {
    total_jobs: number;
    active_jobs: number;
    terminal_jobs: number;
    succeeded_jobs: number;
    failed_jobs: number;
    cancelled_jobs: number;
    blocked_jobs: number;
    expired_jobs: number;
    gpu_seconds: number;
    artifact_count: number;
    artifact_bytes: number;
    event_count: number;
    audit_event_count: number;
    stdout_bytes: number;
    stderr_bytes: number;
    log_bytes: number;
  };
  audit: {
    total: number;
    offset: number;
    limit: number;
    events: MswarmGenericJobAuditEvent[];
  };
}

export interface MswarmGenericJobTokenInput {
  signingSecret: string;
  nodeId: string;
  jobId: string;
  requestId: string;
  schemaVersion: string;
  jobType: MswarmJobType | string;
  deadlineAt?: string;
  ttlSeconds?: number;
  allowedRunnerIds?: string[];
  capabilityNames?: string[];
  policyId?: string;
  policyVersion?: string;
  capabilityLeaseId?: string;
  capabilitySnapshotId?: string;
}

export interface MswarmCapabilityTokenInput {
  signingSecret: string;
  nodeId: string;
  deadlineAt?: string;
  ttlSeconds?: number;
  nonce?: string;
}

export type MswarmGenericJobOpsTokenInput = MswarmCapabilityTokenInput;

interface ListMswarmCloudAgentsResponse {
  agents?: unknown;
}

interface ListMswarmWorkersResponse extends ListMswarmCloudAgentsResponse {
  workers?: unknown;
  next_cursor?: unknown;
  generated_at?: unknown;
  total?: unknown;
}

const DEFAULT_BASE_URL = 'https://api.mswarm.org/';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_SLUG_PREFIX = 'mswarm-cloud';
const DEFAULT_SELF_HOSTED_AGENT_SLUG_PREFIX = 'mswarm-self-hosted';
const DEFAULT_WORKER_AGENT_SLUG_PREFIX = 'mswarm-worker';
const DEFAULT_LOCAL_NODE_BASE_URL = 'http://127.0.0.1:18488/';
const DEFAULT_NODE_TOKEN_TTL_SECONDS = 3_600;
export const MSWARM_CONSENT_POLICY_VERSION = '2026-03-18';
export const MCODA_FREE_CLIENT_TYPE = 'free_mcoda_client';
const MCODA_PRODUCT_SLUG = 'mcoda';
const MCODA_CONSENT_TYPES = ['anonymous', 'non_anonymous'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resolveString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const resolveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const resolveBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const resolveTimestamp = (value: unknown): string | undefined => {
  const candidate = resolveString(value);
  if (!candidate) return undefined;
  return Number.isNaN(Date.parse(candidate)) ? undefined : candidate;
};

const resolveStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0
  );
};

const resolveSelfHostedClientIdentity = (
  value: unknown
): MswarmSelfHostedNodeClientIdentity | undefined => {
  const direct = resolveString(value)?.trim();
  if (direct) {
    return { kind: 'domain', value: direct };
  }
  if (!isRecord(value)) return undefined;
  const kind =
    resolveString(value.kind)?.trim() ??
    resolveString(value.type)?.trim() ??
    'domain';
  const identity =
    resolveString(value.value)?.trim() ??
    resolveString(value.domain)?.trim() ??
    resolveString(value.ip)?.trim() ??
    resolveString(value.uuid)?.trim() ??
    resolveString(value.id)?.trim() ??
    resolveString(value.client)?.trim();
  if (!identity) return undefined;
  const addedAt =
    resolveString(value.added_at)?.trim() ??
    resolveString(value.addedAt)?.trim();
  return {
    kind,
    value: identity,
    added_at: addedAt,
    addedAt,
  };
};

const resolveSelfHostedClientAllowlist = (
  value: unknown
): MswarmSelfHostedNodeClientIdentity[] | undefined => {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const identities = entries
    .map(resolveSelfHostedClientIdentity)
    .filter((entry): entry is MswarmSelfHostedNodeClientIdentity => Boolean(entry));
  if (identities.length === 0) return undefined;
  const seen = new Set<string>();
  return identities.filter((entry) => {
    const key = `${entry.kind}:${entry.value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const resolveClientIdentity = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const resolved = resolveString(value)?.trim();
    if (resolved) return resolved;
  }
  return undefined;
};

const resolveNullableString = (value: unknown): string | null =>
  resolveString(value) ?? null;

const normalizeBaseUrl = (value: string | undefined, label: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  return parsed.toString();
};

const normalizePositiveInt = (
  value: number | undefined,
  label: string,
  fallback: number
): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.trunc(value);
};

const normalizeOptionalPositiveInt = (
  value: number | undefined,
  label: string
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.trunc(value);
};

const normalizeOptionalNonNegativeNumber = (
  value: number | undefined,
  label: string
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
};

const base64UrlEncode = (value: Buffer): string =>
  value
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const signHmacSha256 = (input: string, secret: string): string =>
  base64UrlEncode(createHmac('sha256', secret).update(input).digest());

const signJwtLikePayload = (
  payload: Record<string, unknown>,
  signingSecret: string
): string => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(
    Buffer.from(JSON.stringify(header), 'utf8')
  );
  const encodedPayload = base64UrlEncode(
    Buffer.from(JSON.stringify(payload), 'utf8')
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${signHmacSha256(signingInput, signingSecret)}`;
};

const normalizeTokenTtlSeconds = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_NODE_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('tokenTtlSeconds must be a positive integer');
  }
  return Math.trunc(value);
};

const tokenTimeFields = (
  deadlineAt: string | undefined,
  ttlSeconds: number | undefined
): { deadline_at: string; iat: number; exp: number } => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = normalizeTokenTtlSeconds(ttlSeconds);
  const exp = nowSeconds + ttl;
  return {
    deadline_at: deadlineAt ?? new Date(exp * 1000).toISOString(),
    iat: nowSeconds,
    exp,
  };
};

export function signMswarmGenericJobToken(
  input: MswarmGenericJobTokenInput
): string {
  const secret = resolveString(input.signingSecret);
  if (!secret) throw new Error('signingSecret is required');
  const payload = {
    node_id: requireText(input.nodeId, 'nodeId'),
    job_id: requireText(input.jobId, 'jobId'),
    request_id: requireText(input.requestId, 'requestId'),
    schema_version: requireText(input.schemaVersion, 'schemaVersion'),
    job_type: requireText(input.jobType, 'jobType'),
    scope: 'self_hosted.generic_job.invoke',
    allowed_runner_ids: input.allowedRunnerIds?.length
      ? input.allowedRunnerIds
      : undefined,
    capability_names: input.capabilityNames?.length
      ? input.capabilityNames
      : undefined,
    policy_id: input.policyId,
    policy_version: input.policyVersion,
    capability_lease_id: input.capabilityLeaseId,
    capability_snapshot_id: input.capabilitySnapshotId,
    ...tokenTimeFields(input.deadlineAt, input.ttlSeconds),
  };
  return signJwtLikePayload(payload, secret);
}

export function signMswarmCapabilityToken(
  input: MswarmCapabilityTokenInput
): string {
  const secret = resolveString(input.signingSecret);
  if (!secret) throw new Error('signingSecret is required');
  const payload = {
    node_id: requireText(input.nodeId, 'nodeId'),
    scope: 'self_hosted.capabilities.read',
    nonce: input.nonce ?? randomUUID(),
    ...tokenTimeFields(input.deadlineAt, input.ttlSeconds),
  };
  return signJwtLikePayload(payload, secret);
}

export function signMswarmGenericJobOpsToken(
  input: MswarmGenericJobOpsTokenInput
): string {
  const secret = resolveString(input.signingSecret);
  if (!secret) throw new Error('signingSecret is required');
  const payload = {
    node_id: requireText(input.nodeId, 'nodeId'),
    scope: 'self_hosted.generic_job.ops.read',
    nonce: input.nonce ?? randomUUID(),
    ...tokenTimeFields(input.deadlineAt, input.ttlSeconds),
  };
  return signJwtLikePayload(payload, secret);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

const resolveOptions = async (
  options: MswarmApiOptions = {}
): Promise<ResolvedMswarmApiOptions> => {
  const envTimeoutRaw = process.env.MCODA_MSWARM_TIMEOUT_MS;
  const envTimeout = envTimeoutRaw
    ? Number.parseInt(envTimeoutRaw, 10)
    : undefined;
  const directBaseUrl = options.baseUrl ?? process.env.MCODA_MSWARM_BASE_URL;
  const directOpenAiBaseUrl =
    options.openAiBaseUrl ?? process.env.MCODA_MSWARM_OPENAI_BASE_URL;
  const directApiKey = options.apiKey ?? process.env.MCODA_MSWARM_API_KEY;
  const directTimeout = options.timeoutMs ?? envTimeout;
  const directAgentSlugPrefix =
    options.agentSlugPrefix ?? process.env.MCODA_MSWARM_AGENT_SLUG_PREFIX;
  const directSelfHostedAgentSlugPrefix =
    options.selfHostedAgentSlugPrefix ??
    process.env.MCODA_MSWARM_SELF_HOSTED_AGENT_SLUG_PREFIX;
  const directWorkerAgentSlugPrefix =
    options.workerAgentSlugPrefix ??
    process.env.MCODA_MSWARM_WORKER_AGENT_SLUG_PREFIX;
  const directClientIdentity =
    options.clientIdentity ??
    process.env.MCODA_MSWARM_CLIENT_IDENTITY ??
    process.env.MSWARM_CLIENT_IDENTITY;
  const needsStoredFallback =
    directBaseUrl === undefined ||
    directApiKey === undefined ||
    directTimeout === undefined ||
    directAgentSlugPrefix === undefined ||
    directSelfHostedAgentSlugPrefix === undefined ||
    directWorkerAgentSlugPrefix === undefined;
  const stored = needsStoredFallback
    ? await new MswarmConfigStore().readState()
    : {};
  return {
    baseUrl: normalizeBaseUrl(
      directBaseUrl ?? stored.baseUrl ?? DEFAULT_BASE_URL,
      'MCODA_MSWARM_BASE_URL'
    ),
    openAiBaseUrl: directOpenAiBaseUrl
      ? normalizeBaseUrl(directOpenAiBaseUrl, 'MCODA_MSWARM_OPENAI_BASE_URL')
      : undefined,
    apiKey: resolveString(directApiKey ?? stored.apiKey),
    timeoutMs: normalizePositiveInt(
      directTimeout ?? stored.timeoutMs,
      'MCODA_MSWARM_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS
    ),
    agentSlugPrefix:
      resolveString(directAgentSlugPrefix ?? stored.agentSlugPrefix) ??
      DEFAULT_AGENT_SLUG_PREFIX,
    selfHostedAgentSlugPrefix:
      resolveString(directSelfHostedAgentSlugPrefix) ??
      DEFAULT_SELF_HOSTED_AGENT_SLUG_PREFIX,
    workerAgentSlugPrefix:
      resolveString(directWorkerAgentSlugPrefix) ??
      DEFAULT_WORKER_AGENT_SLUG_PREFIX,
    clientIdentity: resolveClientIdentity(directClientIdentity),
  };
};

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.filter((value) => value.trim().length > 0)));

const resolveFromRecordOrShape = <T>(
  record: Record<string, unknown>,
  keys: string[],
  parser: (value: unknown) => T | undefined
): T | undefined => {
  const sources = [
    record,
    isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  ].filter(isRecord);
  for (const source of sources) {
    for (const key of keys) {
      const resolved = parser(source[key]);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

const resolveStringArrayFromRecordOrShape = (
  record: Record<string, unknown>,
  keys: string[]
): string[] => {
  const sources = [
    record,
    isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  ].filter(isRecord);
  const values = sources.flatMap((source) =>
    keys.flatMap((key) => resolveStringArray(source[key]))
  );
  return uniqueStrings(values);
};

const toRuntimeUsageBudget = (value: unknown): MswarmRuntimeUsageBudget => {
  const record = isRecord(value) ? value : {};
  const budget: MswarmRuntimeUsageBudget = {
    ...record,
    key: resolveString(record.key) ?? resolveString(record.meter_id) ?? 'unknown',
    meter_id: resolveNullableString(record.meter_id),
    limit: resolveNumber(record.limit) ?? null,
    used: resolveNumber(record.used) ?? null,
    remaining: resolveNumber(record.remaining) ?? null,
    reset_at: resolveNullableString(record.reset_at),
    source: resolveNullableString(record.source),
  };
  return budget;
};

const toRuntimeUsageLimits = (value: unknown): MswarmRuntimeUsageLimits => {
  const record = isRecord(value) ? value : {};
  return {
    product_slug: resolveNullableString(record.product_slug ?? record.productSlug),
    tenant_id: resolveNullableString(record.tenant_id ?? record.tenantId),
    api_key_id: resolveNullableString(record.api_key_id ?? record.apiKeyId),
    subscription_id: resolveNullableString(
      record.subscription_id ?? record.subscriptionId
    ),
    budgets: Array.isArray(record.budgets)
      ? record.budgets.map(toRuntimeUsageBudget)
      : [],
    as_of: resolveNullableString(record.as_of ?? record.asOf),
  };
};

const hasCapabilityFragment = (
  capabilities: string[],
  fragments: string[]
): boolean =>
  capabilities.some((capability) =>
    fragments.some((fragment) => capability.includes(fragment))
  );

const inferCloudBestUsage = (
  agent: Pick<MswarmCloudAgent, 'capabilities' | 'default_model'>
): string => {
  const capabilities = agent.capabilities.map((capability) =>
    capability.trim().toLowerCase()
  );
  const model = agent.default_model.trim().toLowerCase();
  if (hasCapabilityFragment(capabilities, ['code_review', 'review']))
    return 'code_review';
  if (hasCapabilityFragment(capabilities, ['qa', 'test'])) return 'qa_testing';
  if (hasCapabilityFragment(capabilities, ['research', 'search', 'discover']))
    return 'deep_research';
  if (
    hasCapabilityFragment(capabilities, [
      'code_write',
      'coding',
      'tool_runner',
      'iterative_coding',
      'structured_output',
    ]) ||
    model.includes('codex')
  ) {
    return 'code_write';
  }
  if (hasCapabilityFragment(capabilities, ['architect', 'plan']))
    return 'system_architecture';
  if (hasCapabilityFragment(capabilities, ['doc'])) return 'doc_generation';
  return 'general';
};

const DEFAULT_CONTEXT_WINDOW = 8_192;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_MAX_COMPLEXITY = 5;

const toSyncedAgentInput = (
  existing: Agent | undefined,
  agent: MswarmCloudAgent,
  localSlug: string,
  config: Record<string, unknown>,
  syncedAt: string
): CreateAgentInput => {
  const rating = existing?.rating ?? agent.rating;
  const reasoningRating =
    existing?.reasoningRating ?? agent.reasoning_rating ?? rating;
  const maxComplexity =
    existing?.maxComplexity ?? agent.max_complexity ?? DEFAULT_MAX_COMPLEXITY;
  const ratingSamples = existing?.ratingSamples ?? agent.rating_samples ?? 0;
  const ratingLastScore =
    existing?.ratingLastScore ?? agent.rating_last_score ?? rating;
  const ratingUpdatedAt =
    existing?.ratingUpdatedAt ?? agent.rating_updated_at ?? syncedAt;
  const complexitySamples =
    existing?.complexitySamples ?? agent.complexity_samples ?? 0;
  const complexityUpdatedAt =
    existing?.complexityUpdatedAt ?? agent.complexity_updated_at ?? syncedAt;

  return {
    slug: localSlug,
    adapter: 'openai-api',
    defaultModel: agent.default_model,
    openaiCompatible: true,
    contextWindow:
      agent.context_window ?? existing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      agent.max_output_tokens ??
      existing?.maxOutputTokens ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    supportsTools: agent.supports_tools,
    rating,
    reasoningRating,
    bestUsage:
      agent.best_usage ?? existing?.bestUsage ?? inferCloudBestUsage(agent),
    costPerMillion: agent.cost_per_million ?? existing?.costPerMillion,
    maxComplexity,
    ratingSamples,
    ratingLastScore,
    ratingUpdatedAt,
    complexitySamples,
    complexityUpdatedAt,
    config,
    capabilities: uniqueStrings(agent.capabilities),
  };
};

const toManagedLocalSlug = (prefix: string, remoteSlug: string): string => {
  const normalized = remoteSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix}-${normalized || 'agent'}`;
};

const toManagedWorkerLocalSlug = (
  prefix: string,
  agent: MswarmWorkerAgent
): string => {
  const base =
    agent.slug.startsWith('worker_') ? agent.slug.slice('worker_'.length) : agent.slug;
  return toManagedLocalSlug(prefix, base);
};

const isLoadBalancedSelfHostedAgent = (
  agent: MswarmSelfHostedAgent
): boolean => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  return (
    agent.load_balanced === true ||
    resolveBoolean(sync.load_balanced) === true ||
    resolveString(sync.group_id) !== undefined ||
    resolveString(agent.load_balanced_group_id) !== undefined
  );
};

const selfHostedRoutingMode = (
  agent: MswarmSelfHostedAgent
): 'direct' | 'auto' =>
  isLoadBalancedSelfHostedAgent(agent) ? 'auto' : 'direct';

const toManagedSelfHostedLocalSlug = (
  prefix: string,
  agent: MswarmSelfHostedAgent
): string => {
  const routePrefix =
    selfHostedRoutingMode(agent) === 'auto' ? `${prefix}-auto` : prefix;
  return toManagedLocalSlug(routePrefix, agent.remote_slug ?? agent.slug);
};

const selfHostedLoadBalancedGroupId = (
  agent: MswarmSelfHostedAgent
): string | undefined => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  return (
    agent.load_balanced_group_id ??
    resolveString(sync.group_id) ??
    (isLoadBalancedSelfHostedAgent(agent) ? resolveString(sync.node_id) : undefined)
  );
};

const SELF_HOSTED_PROTOCOL_MISMATCH_CODE = 'self_hosted_protocol_mismatch';
const SELF_HOSTED_DEFAULT_GATEWAY_JOBS_POLL_PATH =
  '/v1/swarm/self-hosted/node/jobs/poll';
const SELF_HOSTED_REQUIRED_LIFECYCLE_ENDPOINTS = [
  {
    field: 'jobsStartPathTemplate',
    endpoint: 'POST /v1/swarm/self-hosted/node/jobs/:jobId/start',
  },
  {
    field: 'jobsEventsPathTemplate',
    endpoint: 'POST /v1/swarm/self-hosted/node/jobs/:jobId/events',
  },
  {
    field: 'jobsResultPathTemplate',
    endpoint: 'POST /v1/swarm/self-hosted/node/jobs/:jobId/result',
  },
] as const;

type SelfHostedRelayMetadata = NonNullable<ManagedMswarmSelfHostedConfig['relay']>;

const selfHostedRelayMetadata = (
  agent: MswarmSelfHostedAgent
): SelfHostedRelayMetadata => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  const relay = isRecord(agent.relay) ? agent.relay : {};
  const syncRelay = isRecord(sync.relay) ? sync.relay : {};
  return {
    gatewayBaseUrl:
      agent.gateway_base_url ??
      resolveString(relay.gateway_base_url) ??
      resolveString(syncRelay.gateway_base_url) ??
      resolveString(sync.gateway_base_url),
    jobsPollPath:
      agent.jobs_poll_path ??
      resolveString(relay.jobs_poll_path) ??
      resolveString(syncRelay.jobs_poll_path) ??
      resolveString(sync.jobs_poll_path) ??
      SELF_HOSTED_DEFAULT_GATEWAY_JOBS_POLL_PATH,
    jobsStartPathTemplate:
      agent.jobs_start_path_template ??
      resolveString(relay.jobs_start_path_template) ??
      resolveString(syncRelay.jobs_start_path_template) ??
      resolveString(sync.jobs_start_path_template),
    jobsEventsPathTemplate:
      agent.jobs_events_path_template ??
      resolveString(relay.jobs_events_path_template) ??
      resolveString(syncRelay.jobs_events_path_template) ??
      resolveString(sync.jobs_events_path_template),
    jobsResultPathTemplate:
      agent.jobs_result_path_template ??
      resolveString(relay.jobs_result_path_template) ??
      resolveString(syncRelay.jobs_result_path_template) ??
      resolveString(sync.jobs_result_path_template),
  };
};

const selfHostedRuntimePackageVersion = (
  agent: MswarmSelfHostedAgent
): string | undefined => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  return (
    agent.runtime_package_version ??
    resolveString(sync.runtime_package_version) ??
    resolveString(sync.node_version)
  );
};

const selfHostedClientIdentity = (
  agent: MswarmSelfHostedAgent
): string | undefined => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  return resolveClientIdentity(
    agent.client_identity,
    sync.client_identity,
    sync.clientIdentity,
    sync.client
  );
};

const selfHostedClientAllowlist = (
  agent: MswarmSelfHostedAgent
): MswarmSelfHostedNodeClientIdentity[] | undefined => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  return (
    resolveSelfHostedClientAllowlist(agent.client_allowlist) ??
    resolveSelfHostedClientAllowlist(sync.client_allowlist) ??
    resolveSelfHostedClientAllowlist(sync.clientAllowlist) ??
    resolveSelfHostedClientAllowlist(sync.clients)
  );
};

const selfHostedClientAllowlistCount = (
  agent: MswarmSelfHostedAgent
): number | undefined => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  return (
    resolveNumber(agent.client_allowlist_count) ??
    resolveNumber(sync.client_allowlist_count) ??
    resolveNumber(sync.clientAllowlistCount) ??
    selfHostedClientAllowlist(agent)?.length
  );
};

const selfHostedHealthReason = (
  agent: MswarmSelfHostedAgent
): string | undefined => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  return (
    agent.health_reason ??
    resolveString(sync.health_reason) ??
    resolveString(sync.lifecycle_health_reason) ??
    resolveString(sync.reason)
  );
};

const selfHostedLifecycleSmokeCheck = (
  agent: MswarmSelfHostedAgent,
  checkedAt: string
): NonNullable<ManagedMswarmSelfHostedConfig['lifecycle']> & {
  relay: SelfHostedRelayMetadata;
  status?: AgentHealthStatus;
} => {
  const relay = selfHostedRelayMetadata(agent);
  const missingRoutes = SELF_HOSTED_REQUIRED_LIFECYCLE_ENDPOINTS
    .filter(({ field }) => !relay[field])
    .map(({ endpoint }) => endpoint);
  const remoteReason = selfHostedHealthReason(agent);
  const remoteMismatch = remoteReason === SELF_HOSTED_PROTOCOL_MISMATCH_CODE;
  const compatible = missingRoutes.length === 0 && !remoteMismatch;
  return {
    compatible,
    reason: compatible ? undefined : SELF_HOSTED_PROTOCOL_MISMATCH_CODE,
    missingRoutes,
    checkedAt,
    relay,
    status: compatible ? toHealthStatus(agent.health_status) : 'degraded',
  };
};

const sanitizeLoadBalancedSelfHostedSync = (
  agent: MswarmSelfHostedAgent
): Record<string, unknown> | undefined => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  const sanitized: Record<string, unknown> = {
    source: resolveString(sync.source) ?? 'self_hosted',
    remote_slug: agent.remote_slug ?? agent.slug,
    relay_mode: resolveString(sync.relay_mode) ?? 'outbound',
    load_balanced: true,
  };
  const groupId = selfHostedLoadBalancedGroupId(agent);
  const memberCount =
    agent.member_count ?? resolveNumber(sync.member_count);
  const selectorFingerprint =
    agent.selector_fingerprint ?? resolveString(sync.selector_fingerprint);
  if (groupId) sanitized.group_id = groupId;
  if (memberCount !== undefined) sanitized.member_count = memberCount;
  if (selectorFingerprint) sanitized.selector_fingerprint = selectorFingerprint;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

const selfHostedConfigRoutingMode = (
  config: ManagedMswarmSelfHostedAgentConfig
): 'direct' | 'auto' =>
  config.mswarmSelfHosted.routingMode === 'auto' ||
  config.mswarmSelfHosted.loadBalanced === true
    ? 'auto'
    : 'direct';

const toHealthStatus = (
  value: string | undefined
): AgentHealthStatus | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'healthy') return 'healthy';
  if (
    normalized === 'degraded' ||
    normalized === 'unknown' ||
    normalized === 'limited' ||
    normalized === 'stale' ||
    normalized === 'misconfigured'
  )
    return 'degraded';
  if (
    normalized === 'unreachable' ||
    normalized === 'offline' ||
    normalized === 'disabled'
  )
    return 'unreachable';
  return undefined;
};

const isSyncManagedHealth = (health: AgentHealth | undefined): boolean =>
  isRecord(health?.details) &&
  (health.details.source === 'mswarm' ||
    health.details.source === 'mswarm_catalog' ||
    health.details.source === 'mswarm_self_hosted' ||
    health.details.source === 'mswarm_worker');

const isAuthMissingManagedHealth = (
  health: AgentHealth | undefined
): boolean => {
  if (!isRecord(health?.details)) return false;
  const reason = resolveString(health.details.reason);
  const error = resolveString(health.details.error) ?? '';
  return (
    reason === 'missing_api_key' ||
    /AUTH_REQUIRED/i.test(error) ||
    /missing the synced API key/i.test(error)
  );
};

const shouldReplaceManagedHealth = (
  health: AgentHealth | undefined
): boolean =>
  !health || isSyncManagedHealth(health) || isAuthMissingManagedHealth(health);

const isManagedMswarmCloudConfig = (
  config: unknown
): config is ManagedMswarmAgentConfig => {
  if (!isRecord(config)) return false;
  if (!isRecord(config.mswarmCloud)) return false;
  return config.mswarmCloud.managed === true;
};

const isManagedMswarmSelfHostedConfig = (
  config: unknown
): config is ManagedMswarmSelfHostedAgentConfig => {
  if (!isRecord(config)) return false;
  if (!isRecord(config.mswarmSelfHosted)) return false;
  return config.mswarmSelfHosted.managed === true;
};

const isManagedMswarmWorkerConfig = (
  config: unknown
): config is ManagedMswarmWorkerAgentConfig => {
  if (!isRecord(config)) return false;
  if (!isRecord(config.mswarmWorker)) return false;
  return config.mswarmWorker.managed === true;
};

const isManagedMswarmConfig = (
  config: unknown
): config is
  | ManagedMswarmAgentConfig
  | ManagedMswarmSelfHostedAgentConfig
  | ManagedMswarmWorkerAgentConfig =>
  isManagedMswarmCloudConfig(config) ||
  isManagedMswarmSelfHostedConfig(config) ||
  isManagedMswarmWorkerConfig(config);

const toManagedConfig = (
  existingConfig: Record<string, unknown> | undefined,
  catalogBaseUrl: string,
  openAiBaseUrl: string,
  agent: MswarmCloudAgent,
  syncedAt: string
): ManagedMswarmAgentConfig => {
  const nextConfig: ManagedMswarmAgentConfig = {
    ...(existingConfig ?? {}),
    baseUrl: openAiBaseUrl,
    apiBaseUrl: openAiBaseUrl,
    mswarmCloud: {
      managed: true,
      remoteSlug: agent.slug,
      provider: agent.provider,
      modelId: agent.model_id,
      displayName: agent.display_name,
      description: agent.description,
      supportsReasoning: agent.supports_reasoning,
      pricingSnapshotId: agent.pricing_snapshot_id,
      pricingVersion: agent.pricing_version,
      catalogBaseUrl,
      openAiBaseUrl,
      sync: isRecord(agent.sync) ? agent.sync : undefined,
      syncedAt,
    },
  };
  return nextConfig;
};

const toManagedSelfHostedConfig = (
  existingConfig: Record<string, unknown> | undefined,
  catalogBaseUrl: string,
  openAiBaseUrl: string,
  agent: MswarmSelfHostedAgent,
  syncedAt: string,
  clientIdentity?: string
): ManagedMswarmSelfHostedAgentConfig => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  const routingMode = selfHostedRoutingMode(agent);
  const loadBalanced = routingMode === 'auto';
  const lifecycle = selfHostedLifecycleSmokeCheck(agent, syncedAt);
  const missingRoutes = lifecycle.missingRoutes ?? [];
  const sanitizedSync = loadBalanced
    ? sanitizeLoadBalancedSelfHostedSync(agent)
    : Object.keys(sync).length > 0
      ? sync
      : undefined;
  const nextConfig: ManagedMswarmSelfHostedAgentConfig = {
    ...(existingConfig ?? {}),
    baseUrl: openAiBaseUrl,
    apiBaseUrl: openAiBaseUrl,
    mswarmSelfHosted: {
      managed: true,
      remoteSlug: agent.remote_slug ?? agent.slug,
      agentSlug: agent.agent_slug ?? agent.slug,
      provider: agent.provider,
      routingMode,
      loadBalanced,
      loadBalancedGroupId: selfHostedLoadBalancedGroupId(agent),
      selectorFingerprint: agent.selector_fingerprint,
      memberCount: agent.member_count,
      adapter: agent.adapter,
      sourceAgentSlug: agent.source_agent_slug,
      nodeId: loadBalanced ? undefined : resolveString(sync.node_id),
      serverName: loadBalanced ? undefined : resolveString(sync.server_name),
      modelId: agent.model_id,
      displayName: agent.display_name,
      description: agent.description,
      supportsReasoning: agent.supports_reasoning,
      healthReason: lifecycle.reason ?? selfHostedHealthReason(agent),
      clientIdentity: resolveClientIdentity(
        clientIdentity,
        selfHostedClientIdentity(agent)
      ),
      clientAllowlist: selfHostedClientAllowlist(agent),
      clientAllowlistCount: selfHostedClientAllowlistCount(agent),
      runtimePackageVersion: selfHostedRuntimePackageVersion(agent),
      relay: lifecycle.relay,
      lifecycle: {
        compatible: lifecycle.compatible,
        reason: lifecycle.reason,
        missingRoutes: missingRoutes.length
          ? missingRoutes
          : undefined,
        checkedAt: lifecycle.checkedAt,
      },
      catalogBaseUrl,
      openAiBaseUrl,
      sync: sanitizedSync,
      syncedAt,
    },
  };
  return nextConfig;
};

const toManagedWorkerConfig = (
  existingConfig: Record<string, unknown> | undefined,
  catalogBaseUrl: string,
  agent: MswarmWorkerAgent,
  syncedAt: string
): ManagedMswarmWorkerAgentConfig => {
  const sync = isRecord(agent.sync) ? agent.sync : {};
  const worker = isRecord(agent.worker) ? agent.worker : {};
  const workerId = agent.id ?? agent.slug;
  const apiRunUrl = resolveString(worker.api_run_url);
  const nextConfig: ManagedMswarmWorkerAgentConfig = {
    ...(existingConfig ?? {}),
    baseUrl: catalogBaseUrl,
    apiBaseUrl: catalogBaseUrl,
    mswarmWorker: {
      managed: true,
      remoteSlug: agent.remote_slug ?? agent.slug,
      workerId,
      provider: agent.provider,
      modelId: agent.model_id,
      displayName: agent.display_name,
      description: agent.description,
      catalogBaseUrl,
      apiRunUrl,
      worker: Object.keys(worker).length > 0 ? worker : undefined,
      sync: Object.keys(sync).length > 0 ? sync : undefined,
      syncedAt,
    },
  };
  return nextConfig;
};

const toManagedSyncRecord = (
  config: ManagedMswarmAgentConfig,
  localSlug: string,
  defaultModel: string,
  action: MswarmSyncRecord['action']
): MswarmSyncRecord => ({
  remoteSlug: config.mswarmCloud.remoteSlug,
  localSlug,
  action,
  provider: config.mswarmCloud.provider,
  defaultModel,
  pricingVersion: config.mswarmCloud.pricingVersion,
});

const toManagedSelfHostedSyncRecord = (
  config: ManagedMswarmSelfHostedAgentConfig,
  localSlug: string,
  defaultModel: string,
  action: MswarmSyncRecord['action']
): MswarmSyncRecord => ({
  remoteSlug: config.mswarmSelfHosted.remoteSlug,
  localSlug,
  action,
  provider: config.mswarmSelfHosted.provider,
  defaultModel,
  routingMode: selfHostedConfigRoutingMode(config),
  loadBalanced: selfHostedConfigRoutingMode(config) === 'auto',
  clientIdentity: config.mswarmSelfHosted.clientIdentity,
});

const toManagedWorkerSyncRecord = (
  config: ManagedMswarmWorkerAgentConfig,
  localSlug: string,
  defaultModel: string,
  action: MswarmSyncRecord['action']
): MswarmSyncRecord => ({
  remoteSlug: config.mswarmWorker.remoteSlug,
  localSlug,
  action,
  provider: config.mswarmWorker.provider,
  defaultModel,
});

const toCloudAgent = (value: unknown): MswarmCloudAgent => {
  if (!isRecord(value)) {
    throw new Error('mswarm returned an invalid cloud-agent payload');
  }
  const slug = resolveFromRecordOrShape(value, ['slug'], resolveString);
  const provider = resolveFromRecordOrShape(value, ['provider'], resolveString);
  const defaultModel = resolveFromRecordOrShape(
    value,
    ['default_model', 'defaultModel'],
    resolveString
  );
  const supportsTools = resolveFromRecordOrShape(
    value,
    ['supports_tools', 'supportsTools'],
    resolveBoolean
  );
  if (!slug || !provider || !defaultModel || supportsTools === undefined) {
    throw new Error('mswarm cloud-agent payload is missing required fields');
  }
  return {
    slug,
    provider,
    default_model: defaultModel,
    cost_per_million: resolveFromRecordOrShape(
      value,
      ['cost_per_million', 'costPerMillion'],
      resolveNumber
    ),
    rating: resolveFromRecordOrShape(value, ['rating'], resolveNumber),
    reasoning_rating: resolveFromRecordOrShape(
      value,
      ['reasoning_rating', 'reasoningRating'],
      resolveNumber
    ),
    max_complexity: resolveFromRecordOrShape(
      value,
      ['max_complexity', 'maxComplexity'],
      resolveNumber
    ),
    capabilities: resolveStringArrayFromRecordOrShape(value, ['capabilities']),
    health_status: resolveFromRecordOrShape(
      value,
      ['health_status', 'healthStatus'],
      resolveString
    ),
    health_reason: resolveFromRecordOrShape(
      value,
      ['health_reason', 'healthReason'],
      resolveString
    ),
    context_window: resolveFromRecordOrShape(
      value,
      ['context_window', 'contextWindow'],
      resolveNumber
    ),
    max_output_tokens: resolveFromRecordOrShape(
      value,
      ['max_output_tokens', 'maxOutputTokens'],
      resolveNumber
    ),
    supports_tools: supportsTools,
    best_usage: resolveFromRecordOrShape(
      value,
      ['best_usage', 'bestUsage'],
      resolveString
    ),
    model_id: resolveFromRecordOrShape(
      value,
      ['model_id', 'modelId'],
      resolveString
    ),
    display_name: resolveFromRecordOrShape(
      value,
      ['display_name', 'displayName'],
      resolveString
    ),
    description: resolveFromRecordOrShape(
      value,
      ['description'],
      resolveString
    ),
    supports_reasoning: resolveFromRecordOrShape(
      value,
      ['supports_reasoning', 'supportsReasoning'],
      resolveBoolean
    ),
    pricing_snapshot_id: resolveFromRecordOrShape(
      value,
      ['pricing_snapshot_id', 'pricingSnapshotId'],
      resolveString
    ),
    pricing_version: resolveFromRecordOrShape(
      value,
      ['pricing_version', 'pricingVersion'],
      resolveString
    ),
    rating_samples: resolveFromRecordOrShape(
      value,
      ['rating_samples', 'ratingSamples'],
      resolveNumber
    ),
    rating_last_score: resolveFromRecordOrShape(
      value,
      ['rating_last_score', 'ratingLastScore'],
      resolveNumber
    ),
    rating_updated_at: resolveFromRecordOrShape(
      value,
      ['rating_updated_at', 'ratingUpdatedAt'],
      resolveTimestamp
    ),
    complexity_samples: resolveFromRecordOrShape(
      value,
      ['complexity_samples', 'complexitySamples'],
      resolveNumber
    ),
    complexity_updated_at: resolveFromRecordOrShape(
      value,
      ['complexity_updated_at', 'complexityUpdatedAt'],
      resolveTimestamp
    ),
    sync: isRecord(value.sync) ? value.sync : undefined,
  };
};

const toCloudAgentDetail = (value: unknown): MswarmCloudAgentDetail => {
  const agent = toCloudAgent(value);
  const record = isRecord(value) ? value : {};
  return {
    ...agent,
    pricing: isRecord(record.pricing) ? record.pricing : undefined,
    supported_parameters: resolveStringArray(record.supported_parameters),
    status: resolveString(record.status),
    moderation_status: resolveString(record.moderation_status),
    mcoda_shape: isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  };
};

const toSelfHostedAgent = (value: unknown): MswarmSelfHostedAgent => {
  const agent = toCloudAgent(value);
  const record = isRecord(value) ? value : {};
  return {
    ...agent,
    agent_slug: resolveString(record.agent_slug),
    remote_slug: resolveString(record.remote_slug),
    adapter: resolveString(record.adapter),
    source_agent_id: resolveString(record.source_agent_id),
    source_agent_slug: resolveString(record.source_agent_slug),
    load_balanced: resolveFromRecordOrShape(
      record,
      ['load_balanced', 'loadBalanced'],
      resolveBoolean
    ),
    load_balanced_group_id: resolveFromRecordOrShape(
      record,
      ['load_balanced_group_id', 'loadBalancedGroupId'],
      resolveString
    ),
    selector_fingerprint: resolveFromRecordOrShape(
      record,
      ['selector_fingerprint', 'selectorFingerprint'],
      resolveString
    ),
    member_count: resolveFromRecordOrShape(
      record,
      ['member_count', 'memberCount'],
      resolveNumber
    ),
    candidate_node_ids: resolveStringArrayFromRecordOrShape(record, [
      'candidate_node_ids',
      'candidateNodeIds',
    ]),
    canonical_agent_slug: resolveFromRecordOrShape(
      record,
      ['canonical_agent_slug', 'canonicalAgentSlug'],
      resolveString
    ),
    canonical_model_id: resolveFromRecordOrShape(
      record,
      ['canonical_model_id', 'canonicalModelId'],
      resolveString
    ),
    execution_class: resolveFromRecordOrShape(
      record,
      ['execution_class', 'executionClass'],
      resolveString
    ),
    policy_class: resolveFromRecordOrShape(
      record,
      ['policy_class', 'policyClass'],
      resolveString
    ),
    context_tier: resolveFromRecordOrShape(
      record,
      ['context_tier', 'contextTier'],
      resolveString
    ),
    client_identity: resolveFromRecordOrShape(
      record,
      ['client_identity', 'clientIdentity', 'client'],
      resolveString
    ),
    client_allowlist: resolveFromRecordOrShape(
      record,
      ['client_allowlist', 'clientAllowlist', 'clients'],
      resolveSelfHostedClientAllowlist
    ),
    client_allowlist_count: resolveFromRecordOrShape(
      record,
      ['client_allowlist_count', 'clientAllowlistCount'],
      resolveNumber
    ),
    runtime_package_version: resolveFromRecordOrShape(
      record,
      ['runtime_package_version', 'runtimePackageVersion'],
      resolveString
    ),
    gateway_base_url: resolveFromRecordOrShape(
      record,
      ['gateway_base_url', 'gatewayBaseUrl'],
      resolveString
    ),
    jobs_poll_path: resolveFromRecordOrShape(
      record,
      ['jobs_poll_path', 'jobsPollPath'],
      resolveString
    ),
    jobs_start_path_template: resolveFromRecordOrShape(
      record,
      ['jobs_start_path_template', 'jobsStartPathTemplate'],
      resolveString
    ),
    jobs_events_path_template: resolveFromRecordOrShape(
      record,
      ['jobs_events_path_template', 'jobsEventsPathTemplate'],
      resolveString
    ),
    jobs_result_path_template: resolveFromRecordOrShape(
      record,
      ['jobs_result_path_template', 'jobsResultPathTemplate'],
      resolveString
    ),
    relay: isRecord(record.relay)
      ? {
          gateway_base_url: resolveString(record.relay.gateway_base_url),
          jobs_poll_path: resolveString(record.relay.jobs_poll_path),
          jobs_start_path_template: resolveString(record.relay.jobs_start_path_template),
          jobs_events_path_template: resolveString(record.relay.jobs_events_path_template),
          jobs_result_path_template: resolveString(record.relay.jobs_result_path_template),
        }
      : undefined,
  };
};

const toSelfHostedAgentDetail = (
  value: unknown
): MswarmSelfHostedAgentDetail => {
  const agent = toSelfHostedAgent(value);
  const record = isRecord(value) ? value : {};
  return {
    ...agent,
    pricing: isRecord(record.pricing) ? record.pricing : undefined,
    supported_parameters: resolveStringArray(record.supported_parameters),
    status: resolveString(record.status),
    moderation_status: resolveString(record.moderation_status),
    mcoda_shape: isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  };
};

const toWorkerAgent = (value: unknown): MswarmWorkerAgent => {
  const agent = toCloudAgent(value);
  const record = isRecord(value) ? value : {};
  return {
    ...agent,
    id: resolveString(record.id),
    remote_slug: resolveString(record.remote_slug),
    updated_at: resolveTimestamp(record.updated_at),
    adapter: resolveString(record.adapter),
    source: resolveString(record.source),
    worker: isRecord(record.worker) ? record.worker : undefined,
  };
};

const toWorkerAgentDetail = (value: unknown): MswarmWorkerAgentDetail => {
  const agent = toWorkerAgent(value);
  const record = isRecord(value) ? value : {};
  return {
    ...agent,
    pricing: isRecord(record.pricing) ? record.pricing : undefined,
    supported_parameters: resolveStringArray(record.supported_parameters),
    status: resolveString(record.status),
    moderation_status: resolveString(record.moderation_status),
    mcoda_shape: isRecord(record.mcoda_shape) ? record.mcoda_shape : undefined,
  };
};

const hasAdvancedCloudAgentSelection = (
  options: ListMswarmCloudAgentsOptions
): boolean =>
  options.maxCostPerMillion !== undefined ||
  options.minContextWindow !== undefined ||
  options.minReasoningRating !== undefined ||
  options.sortByCatalogRating === true;

const sortCloudAgentsByCatalogRating = <T extends MswarmCloudAgent>(
  agents: T[]
): T[] =>
  [...agents].sort((left, right) => {
    const ratingDelta =
      (right.rating ?? Number.NEGATIVE_INFINITY) -
      (left.rating ?? Number.NEGATIVE_INFINITY);
    if (ratingDelta !== 0) return ratingDelta;
    return left.slug.localeCompare(right.slug);
  });

const applyCloudAgentListOptions = <T extends MswarmCloudAgent>(
  agents: T[],
  options: ListMswarmCloudAgentsOptions
): T[] => {
  const maxCostPerMillion = normalizeOptionalNonNegativeNumber(
    options.maxCostPerMillion,
    'maxCostPerMillion'
  );
  const minContextWindow = normalizeOptionalPositiveInt(
    options.minContextWindow,
    'minContextWindow'
  );
  const minReasoningRating = normalizeOptionalNonNegativeNumber(
    options.minReasoningRating,
    'minReasoningRating'
  );
  const limit = normalizeOptionalPositiveInt(options.limit, 'limit');

  let next = [...agents];
  if (maxCostPerMillion !== undefined) {
    next = next.filter(
      (agent) =>
        agent.cost_per_million !== undefined &&
        agent.cost_per_million <= maxCostPerMillion
    );
  }
  if (minContextWindow !== undefined) {
    next = next.filter(
      (agent) =>
        agent.context_window !== undefined &&
        agent.context_window >= minContextWindow
    );
  }
  if (minReasoningRating !== undefined) {
    next = next.filter(
      (agent) =>
        agent.reasoning_rating !== undefined &&
        agent.reasoning_rating >= minReasoningRating
    );
  }
  if (options.sortByCatalogRating) {
    next = sortCloudAgentsByCatalogRating(next);
  }
  if (limit !== undefined) {
    next = next.slice(0, limit);
  }
  return next;
};

const toAgentModels = (
  agentId: string,
  entry: MswarmCloudAgent
): AgentModel[] => [
  {
    agentId,
    modelName: entry.default_model,
    isDefault: true,
    config: {
      provider: entry.provider,
      remoteSlug: entry.slug,
      modelId: entry.model_id,
      pricingVersion: entry.pricing_version,
    },
  },
];

export class MswarmApi {
  readonly baseUrl: string;
  readonly agentSlugPrefix: string;
  readonly selfHostedAgentSlugPrefix: string;
  readonly workerAgentSlugPrefix: string;

  constructor(
    private readonly repo: GlobalRepository,
    private readonly options: ResolvedMswarmApiOptions
  ) {
    this.baseUrl = options.baseUrl;
    this.agentSlugPrefix = options.agentSlugPrefix;
    this.selfHostedAgentSlugPrefix = options.selfHostedAgentSlugPrefix;
    this.workerAgentSlugPrefix = options.workerAgentSlugPrefix;
  }

  static async create(options: MswarmApiOptions = {}): Promise<MswarmApi> {
    const repo = await GlobalRepository.create();
    return new MswarmApi(repo, await resolveOptions(options));
  }

  static async refreshManagedAgentAuth(
    apiKey: string
  ): Promise<MswarmManagedAuthRefreshSummary> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error('mswarm api key is required');
    }
    const repo = await GlobalRepository.create();
    try {
      const encryptedApiKey = await CryptoHelper.encryptSecret(trimmed);
      const agents = await repo.listAgents();
      const managedAgents = agents.filter((agent) =>
        isManagedMswarmConfig(agent.config)
      );
      for (const agent of managedAgents) {
        await repo.setAgentAuth(agent.id, encryptedApiKey);
      }
      return {
        updated: managedAgents.length,
        agents: managedAgents.map((agent) => agent.slug),
      };
    } finally {
      await repo.close();
    }
  }

  async close(): Promise<void> {
    await this.repo.close();
  }

  async refreshManagedAgentAuth(): Promise<MswarmManagedAuthRefreshSummary> {
    return MswarmApi.refreshManagedAgentAuth(this.requireApiKey());
  }

  async getRuntimeUsageLimits(): Promise<MswarmRuntimeUsageLimits> {
    const payload = await this.requestJson<unknown>(
      '/v1/swarm/runtime/usage-limits'
    );
    return toRuntimeUsageLimits(payload);
  }

  async getRuntimeIdentity(): Promise<MswarmRuntimeIdentity> {
    const usageLimits = await this.getRuntimeUsageLimits();
    return {
      tenantId: usageLimits.tenant_id,
      productSlug: usageLimits.product_slug,
      apiKeyId: usageLimits.api_key_id,
      subscriptionId: usageLimits.subscription_id,
      asOf: usageLimits.as_of,
      usageLimits,
    };
  }

  private nodeBaseUrl(input?: MswarmNodeAuthOptions): string {
    return normalizeBaseUrl(
      input?.nodeBaseUrl ??
        process.env.MCODA_MSWARM_NODE_BASE_URL ??
        DEFAULT_LOCAL_NODE_BASE_URL,
      'MCODA_MSWARM_NODE_BASE_URL'
    );
  }

  private genericJobToken(input: MswarmGenericJobReference): string {
    const token = resolveString(input.token ?? process.env.MCODA_MSWARM_NODE_TOKEN);
    if (token) return token;
    const signingSecret = resolveString(
      input.signingSecret ??
        process.env.MCODA_MSWARM_NODE_SIGNING_SECRET ??
        process.env.MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET
    );
    if (!signingSecret) {
      throw new Error(
        'A generic job token or owner-local signing secret is required'
      );
    }
    return signMswarmGenericJobToken({
      signingSecret,
      nodeId: requireText(input.nodeId, 'nodeId'),
      jobId: input.jobId,
      requestId: requireText(input.requestId, 'requestId'),
      schemaVersion: requireText(input.schemaVersion, 'schemaVersion'),
      jobType: requireText(input.jobType, 'jobType'),
      ttlSeconds: input.tokenTtlSeconds,
    });
  }

  private capabilityToken(input: MswarmCapabilityRequestOptions = {}): string {
    const token = resolveString(input.token ?? process.env.MCODA_MSWARM_NODE_TOKEN);
    if (token) return token;
    const signingSecret = resolveString(
      input.signingSecret ??
        process.env.MCODA_MSWARM_NODE_SIGNING_SECRET ??
        process.env.MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET
    );
    if (!signingSecret) {
      throw new Error(
        'A capability token or owner-local signing secret is required'
      );
    }
    const nodeId = requireText(
      input.nodeId ??
        process.env.MCODA_MSWARM_NODE_ID ??
        process.env.MSWARM_SELF_HOSTED_NODE_ID,
      'nodeId'
    );
    return signMswarmCapabilityToken({
      signingSecret,
      nodeId,
      ttlSeconds: input.tokenTtlSeconds,
    });
  }

  private genericJobOpsToken(input: MswarmGenericJobOpsRequestOptions = {}): string {
    const token = resolveString(input.token ?? process.env.MCODA_MSWARM_NODE_OPS_TOKEN);
    if (token) return token;
    const signingSecret = resolveString(
      input.signingSecret ??
        process.env.MCODA_MSWARM_NODE_SIGNING_SECRET ??
        process.env.MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET
    );
    if (!signingSecret) {
      throw new Error(
        'A generic job ops token or owner-local signing secret is required'
      );
    }
    const nodeId = requireText(
      input.nodeId ??
        process.env.MCODA_MSWARM_NODE_ID ??
        process.env.MSWARM_SELF_HOSTED_NODE_ID,
      'nodeId'
    );
    return signMswarmGenericJobOpsToken({
      signingSecret,
      nodeId,
      ttlSeconds: input.tokenTtlSeconds,
    });
  }

  private referenceFromJob(
    job: MswarmGenericNodeJobEnvelope,
    options: MswarmNodeAuthOptions = {}
  ): MswarmGenericJobReference {
    return {
      ...options,
      jobId: job.job_id,
      nodeId: job.node_id,
      requestId: job.request_id,
      schemaVersion: job.job.schema_version,
      jobType: job.job.job_type,
    };
  }

  async listGpuCapabilities(
    options: MswarmCapabilityRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      '/v1/swarm/self-hosted/node/capabilities',
      undefined,
      {
        baseUrl: this.nodeBaseUrl(options),
        headers: {
          authorization: `Bearer ${this.capabilityToken(options)}`,
        },
      }
    );
  }

  async getGenericJobOps(
    options: MswarmGenericJobOpsRequestOptions = {}
  ): Promise<MswarmGenericJobOpsSummary> {
    return this.requestJson<MswarmGenericJobOpsSummary>(
      '/v1/swarm/self-hosted/node/generic-job-control/ops',
      {
        audit_limit: options.auditLimit,
        audit_offset: options.auditOffset,
      },
      {
        baseUrl: this.nodeBaseUrl(options),
        headers: {
          authorization: `Bearer ${this.genericJobOpsToken(options)}`,
        },
      }
    );
  }

  async uploadGenericJobArtifact(
    input: MswarmGenericJobArtifactUploadInput
  ): Promise<MswarmGenericJobArtifactUploadResult> {
    const token = this.genericJobToken(input);
    return this.requestJson<MswarmGenericJobArtifactUploadResult>(
      `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(input.jobId)}/artifacts`,
      undefined,
      {
        method: 'POST',
        baseUrl: this.nodeBaseUrl(input),
        headers: {
          authorization: `Bearer ${token}`,
        },
        body: {
          name: input.name,
          path: input.path,
          content_base64: input.contentBase64,
          content_type: input.contentType,
          sha256: input.sha256,
          size_bytes: input.sizeBytes,
        },
      }
    );
  }

  async runGenericJob(
    job: MswarmGenericNodeJobEnvelope,
    options: MswarmNodeAuthOptions = {}
  ): Promise<MswarmGenericJobLifecycleSnapshot> {
    const reference = this.referenceFromJob(job, options);
    return this.requestJson<MswarmGenericJobLifecycleSnapshot>(
      '/v1/swarm/self-hosted/node/generic-job-control/jobs',
      undefined,
      {
        method: 'POST',
        baseUrl: this.nodeBaseUrl(options),
        headers: {
          authorization: `Bearer ${this.genericJobToken(reference)}`,
        },
        body: job,
      }
    );
  }

  async getGenericJob(
    input: MswarmGenericJobReference
  ): Promise<MswarmGenericJobLifecycleSnapshot> {
    return this.requestJson<MswarmGenericJobLifecycleSnapshot>(
      `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(input.jobId)}`,
      undefined,
      {
        baseUrl: this.nodeBaseUrl(input),
        headers: {
          authorization: `Bearer ${this.genericJobToken(input)}`,
        },
      }
    );
  }

  async getGenericJobEvents(
    input: MswarmGenericJobReference
  ): Promise<MswarmGenericJobEventsResult> {
    return this.requestJson<MswarmGenericJobEventsResult>(
      `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(input.jobId)}/events`,
      undefined,
      {
        baseUrl: this.nodeBaseUrl(input),
        headers: {
          authorization: `Bearer ${this.genericJobToken(input)}`,
        },
      }
    );
  }

  async getGenericJobLogs(
    input: MswarmGenericJobReference
  ): Promise<MswarmGenericJobLogsResult> {
    return this.requestJson<MswarmGenericJobLogsResult>(
      `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(input.jobId)}/logs`,
      undefined,
      {
        baseUrl: this.nodeBaseUrl(input),
        headers: {
          authorization: `Bearer ${this.genericJobToken(input)}`,
        },
      }
    );
  }

  async getGenericJobArtifacts(
    input: MswarmGenericJobReference
  ): Promise<MswarmGenericJobArtifactsResult> {
    return this.requestJson<MswarmGenericJobArtifactsResult>(
      `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(input.jobId)}/artifacts`,
      undefined,
      {
        baseUrl: this.nodeBaseUrl(input),
        headers: {
          authorization: `Bearer ${this.genericJobToken(input)}`,
        },
      }
    );
  }

  async cancelGenericJob(
    input: MswarmGenericJobReference
  ): Promise<MswarmGenericJobLifecycleSnapshot> {
    return this.requestJson<MswarmGenericJobLifecycleSnapshot>(
      `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(input.jobId)}/cancel`,
      undefined,
      {
        method: 'POST',
        baseUrl: this.nodeBaseUrl(input),
        headers: {
          authorization: `Bearer ${this.genericJobToken(input)}`,
        },
      }
    );
  }

  async retryGenericJob(
    input: MswarmGenericJobReference
  ): Promise<MswarmGenericJobLifecycleSnapshot> {
    return this.requestJson<MswarmGenericJobLifecycleSnapshot>(
      `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(input.jobId)}/retry`,
      undefined,
      {
        method: 'POST',
        baseUrl: this.nodeBaseUrl(input),
        headers: {
          authorization: `Bearer ${this.genericJobToken(input)}`,
        },
      }
    );
  }

  private requireApiKey(): string {
    if (!this.options.apiKey) {
      throw new Error('MCODA_MSWARM_API_KEY is required');
    }
    return this.options.apiKey;
  }

  private async requestJson<T>(
    pathname: string,
    query?: Record<string, string | number | undefined>,
    init?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      baseUrl?: string;
      clientIdentity?: string;
    }
  ): Promise<T> {
    const url = new URL(pathname, init?.baseUrl ?? this.options.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs
    );
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(init?.headers ?? {}),
      };
      if (this.options.apiKey) {
        headers['x-api-key'] = this.options.apiKey;
      }
      const clientIdentity = resolveClientIdentity(init?.clientIdentity);
      if (clientIdentity) {
        headers['x-mswarm-client-identity'] = clientIdentity;
        headers['x-mswarm-client'] = clientIdentity;
      }
      let body: string | undefined;
      if (init?.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.body);
      }
      const response = await fetch(url.toString(), {
        method: init?.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `mswarm request failed (${response.status}): ${body || response.statusText}`
        );
      }
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new Error(
          `mswarm response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `mswarm request timed out after ${this.options.timeoutMs}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listCloudAgents(
    options: ListMswarmCloudAgentsOptions = {}
  ): Promise<MswarmCloudAgent[]> {
    const remoteLimit = hasAdvancedCloudAgentSelection(options)
      ? undefined
      : options.limit;
    const payload = await this.requestJson<ListMswarmCloudAgentsResponse>(
      '/v1/swarm/cloud/agents',
      {
        shape: 'mcoda',
        provider: options.provider,
        limit: remoteLimit,
      }
    );
    const agents = Array.isArray(payload.agents) ? payload.agents : [];
    return applyCloudAgentListOptions(agents.map(toCloudAgent), options);
  }

  async getCloudAgent(slug: string): Promise<MswarmCloudAgentDetail> {
    if (!slug.trim()) {
      throw new Error('Cloud-agent slug is required');
    }
    const payload = await this.requestJson<unknown>(
      `/v1/swarm/cloud/agents/${encodeURIComponent(slug)}`
    );
    return toCloudAgentDetail(payload);
  }

  async listSelfHostedAgents(
    options: ListMswarmSelfHostedAgentsOptions = {}
  ): Promise<MswarmSelfHostedAgent[]> {
    const remoteLimit = hasAdvancedCloudAgentSelection(options)
      ? undefined
      : options.limit;
    const clientIdentity = resolveClientIdentity(
      options.clientIdentity,
      this.options.clientIdentity
    );
    const payload = await this.requestJson<ListMswarmCloudAgentsResponse>(
      '/v1/swarm/self-hosted/agents',
      {
        shape: 'mcoda',
        provider: options.provider,
        limit: remoteLimit,
        include_unreachable: options.includeUnreachable ? 'true' : undefined,
        include_load_balanced: options.includeLoadBalanced ? 'true' : undefined,
        client_identity: clientIdentity,
      },
      {
        clientIdentity,
      }
    );
    let agents = (Array.isArray(payload.agents) ? payload.agents : []).map(
      toSelfHostedAgent
    );
    if (options.provider) {
      agents = agents.filter((agent) => agent.provider === options.provider);
    }
    return applyCloudAgentListOptions(agents, options);
  }

  async getSelfHostedAgent(
    slug: string,
    options: GetMswarmSelfHostedAgentOptions = {}
  ): Promise<MswarmSelfHostedAgentDetail> {
    if (!slug.trim()) {
      throw new Error('Self-hosted agent slug is required');
    }
    const clientIdentity = resolveClientIdentity(
      options.clientIdentity,
      this.options.clientIdentity
    );
    const payload = await this.requestJson<unknown>(
      `/v1/swarm/self-hosted/agents/${encodeURIComponent(slug)}`,
      {
        include_load_balanced: options.includeLoadBalanced ? 'true' : undefined,
        client_identity: clientIdentity,
      },
      {
        clientIdentity,
      }
    );
    return toSelfHostedAgentDetail(payload);
  }

  private async listWorkerAgentPage(
    options: ListMswarmWorkerAgentsOptions = {}
  ): Promise<MswarmWorkerCatalogPage> {
    const query: Record<string, string | number | undefined> = {
      shape: 'mcoda',
      limit: options.limit,
      cursor: options.cursor,
      updated_after: options.updatedAfter,
    };
    if (options.includeDisabled !== undefined) {
      query.include_disabled = options.includeDisabled ? 'true' : 'false';
    }
    const payload = await this.requestJson<ListMswarmWorkersResponse>(
      '/v1/swarm/workers',
      query
    );
    const values = Array.isArray(payload.agents)
      ? payload.agents
      : Array.isArray(payload.workers)
        ? payload.workers
        : [];
    return {
      workers: values.map(toWorkerAgent),
      next_cursor: resolveString(payload.next_cursor) ?? null,
      generated_at: resolveTimestamp(payload.generated_at),
      total: resolveNumber(payload.total),
    };
  }

  async listAllWorkers(
    options: ListMswarmWorkerAgentsOptions = {}
  ): Promise<MswarmWorkerAgent[]> {
    const requestedLimit = normalizeOptionalPositiveInt(options.limit, 'limit');
    const pageLimit =
      requestedLimit !== undefined ? Math.min(requestedLimit, 250) : 250;
    const collected: MswarmWorkerAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listWorkerAgentPage({
        ...options,
        limit: pageLimit,
        cursor,
      });
      collected.push(...page.workers);
      cursor = page.next_cursor ?? undefined;
      if (requestedLimit !== undefined && collected.length >= requestedLimit) {
        return applyCloudAgentListOptions(collected.slice(0, requestedLimit), options);
      }
    } while (cursor);
    return applyCloudAgentListOptions(collected, options);
  }

  async listWorkers(
    options: ListMswarmWorkerAgentsOptions = {}
  ): Promise<MswarmWorkerCatalogPage> {
    const page = await this.listWorkerAgentPage(options);
    let agents = page.workers;
    if (options.provider) {
      agents = agents.filter((agent) => agent.provider === options.provider);
    }
    return {
      ...page,
      workers: applyCloudAgentListOptions(agents, options),
    };
  }

  async getWorker(slug: string): Promise<MswarmWorkerAgentDetail> {
    if (!slug.trim()) {
      throw new Error('Worker slug is required');
    }
    const payload = await this.requestJson<unknown>(
      `/v1/swarm/workers/${encodeURIComponent(slug)}`
    );
    return toWorkerAgentDetail(payload);
  }

  async runWorker(
    slug: string,
    payload: unknown,
    options: { idempotencyKey?: string } = {}
  ): Promise<Record<string, unknown>> {
    if (!slug.trim()) {
      throw new Error('Worker slug is required');
    }
    return this.requestJson<Record<string, unknown>>(
      `/v1/swarm/workers/${encodeURIComponent(slug)}/run`,
      undefined,
      {
        method: 'POST',
        body: payload ?? {},
        headers: options.idempotencyKey
          ? { 'idempotency-key': options.idempotencyKey }
          : undefined,
      }
    );
  }

  async syncCloudAgents(
    options: ListMswarmCloudAgentsOptions = {}
  ): Promise<MswarmSyncSummary> {
    if (
      options.pruneMissing &&
      (options.limit !== undefined || hasAdvancedCloudAgentSelection(options))
    ) {
      throw new Error(
        'pruneMissing cannot be combined with limit or advanced cloud-agent filters'
      );
    }
    const agents = await this.listCloudAgents(options);
    const openAiBaseUrl =
      this.options.openAiBaseUrl ??
      new URL('/v1/swarm/openai/', this.options.baseUrl).toString();
    const syncedAt = new Date().toISOString();
    const encryptedApiKey = await CryptoHelper.encryptSecret(
      this.requireApiKey()
    );
    const records: MswarmSyncRecord[] = [];

    for (const agent of agents) {
      const localSlug = toManagedLocalSlug(
        this.options.agentSlugPrefix,
        agent.slug
      );
      const existing = await this.repo.getAgentBySlug(localSlug);
      if (
        existing &&
        (!isManagedMswarmCloudConfig(existing.config) ||
          existing.config.mswarmCloud.remoteSlug !== agent.slug)
      ) {
        throw new Error(`Refusing to overwrite non-mswarm agent ${localSlug}`);
      }

      const existingConfig =
        existing && isRecord(existing.config)
          ? (existing.config as Record<string, unknown>)
          : undefined;
      const nextConfig = toManagedConfig(
        existingConfig,
        this.options.baseUrl,
        openAiBaseUrl,
        agent,
        syncedAt
      );
      const createInput = toSyncedAgentInput(
        existing,
        agent,
        localSlug,
        nextConfig,
        syncedAt
      );
      const { slug: _ignoredSlug, ...updateInput } = createInput;
      const stored = existing
        ? await this.repo.updateAgent(
            existing.id,
            updateInput as UpdateAgentInput
          )
        : await this.repo.createAgent(createInput);
      if (!stored) {
        throw new Error(`Failed to persist synced agent ${localSlug}`);
      }

      await this.repo.setAgentModels(
        stored.id,
        toAgentModels(stored.id, agent)
      );
      await this.repo.setAgentAuth(stored.id, encryptedApiKey);
      const existingHealth = existing
        ? await this.repo.getAgentHealth(existing.id)
        : undefined;
      const mappedHealth = toHealthStatus(agent.health_status);
      if (mappedHealth && shouldReplaceManagedHealth(existingHealth)) {
        const health: AgentHealth = {
          agentId: stored.id,
          status: mappedHealth,
          lastCheckedAt: syncedAt,
          details: {
            source: 'mswarm',
            remoteSlug: agent.slug,
            remoteHealthStatus: agent.health_status,
          },
        };
        await this.repo.setAgentHealth(health);
      }

      records.push(
        toManagedSyncRecord(
          nextConfig,
          localSlug,
          agent.default_model,
          existing ? 'updated' : 'created'
        )
      );
    }

    if (options.pruneMissing) {
      const remoteSlugs = new Set(agents.map((agent) => agent.slug));
      const localAgents = await this.repo.listAgents();
      for (const localAgent of localAgents) {
        const managedConfig = isManagedMswarmCloudConfig(localAgent.config)
          ? localAgent.config
          : undefined;
        if (!managedConfig) continue;
        if (
          options.provider &&
          managedConfig.mswarmCloud.provider !== options.provider
        ) {
          continue;
        }
        if (remoteSlugs.has(managedConfig.mswarmCloud.remoteSlug)) continue;
        await this.repo.deleteAgent(localAgent.id);
        records.push(
          toManagedSyncRecord(
            managedConfig,
            localAgent.slug,
            localAgent.defaultModel ?? managedConfig.mswarmCloud.modelId ?? '-',
            'deleted'
          )
        );
      }
    }

    return {
      created: records.filter((record) => record.action === 'created').length,
      updated: records.filter((record) => record.action === 'updated').length,
      deleted: records.filter((record) => record.action === 'deleted').length,
      agents: records,
    };
  }

  async syncSelfHostedAgents(
    options: ListMswarmSelfHostedAgentsOptions = {}
  ): Promise<MswarmSyncSummary> {
    if (
      options.pruneMissing &&
      (options.limit !== undefined || hasAdvancedCloudAgentSelection(options))
    ) {
      throw new Error(
        'pruneMissing cannot be combined with limit or advanced self-hosted agent filters'
      );
    }
    const clientIdentity = resolveClientIdentity(
      options.clientIdentity,
      this.options.clientIdentity
    );
    const agents = await this.listSelfHostedAgents({
      ...options,
      clientIdentity,
    });
    const openAiBaseUrl =
      this.options.openAiBaseUrl ??
      new URL('/v1/swarm/self-hosted/openai/', this.options.baseUrl).toString();
    const syncedAt = new Date().toISOString();
    const encryptedApiKey = await CryptoHelper.encryptSecret(
      this.requireApiKey()
    );
    const records: MswarmSyncRecord[] = [];

    for (const agent of agents) {
      const localSlug = toManagedSelfHostedLocalSlug(
        this.options.selfHostedAgentSlugPrefix,
        agent
      );
      const existing = await this.repo.getAgentBySlug(localSlug);
      const remoteSlug = agent.remote_slug ?? agent.slug;
      if (
        existing &&
        (!isManagedMswarmSelfHostedConfig(existing.config) ||
          existing.config.mswarmSelfHosted.remoteSlug !== remoteSlug)
      ) {
        throw new Error(`Refusing to overwrite non-mswarm agent ${localSlug}`);
      }

      const existingConfig =
        existing && isRecord(existing.config)
          ? (existing.config as Record<string, unknown>)
          : undefined;
      const nextConfig = toManagedSelfHostedConfig(
        existingConfig,
        this.options.baseUrl,
        openAiBaseUrl,
        agent,
        syncedAt,
        clientIdentity
      );
      const createInput = toSyncedAgentInput(
        existing,
        agent,
        localSlug,
        nextConfig,
        syncedAt
      );
      const { slug: _ignoredSlug, ...updateInput } = createInput;
      const stored = existing
        ? await this.repo.updateAgent(
            existing.id,
            updateInput as UpdateAgentInput
          )
        : await this.repo.createAgent(createInput);
      if (!stored) {
        throw new Error(`Failed to persist synced agent ${localSlug}`);
      }

      await this.repo.setAgentModels(
        stored.id,
        toAgentModels(stored.id, agent)
      );
      await this.repo.setAgentAuth(stored.id, encryptedApiKey);
      const existingHealth = existing
        ? await this.repo.getAgentHealth(existing.id)
        : undefined;
      const lifecycle = selfHostedLifecycleSmokeCheck(agent, syncedAt);
      const missingRoutes = lifecycle.missingRoutes ?? [];
      const mappedHealth = lifecycle.status ?? toHealthStatus(agent.health_status);
      if (mappedHealth && shouldReplaceManagedHealth(existingHealth)) {
        const health: AgentHealth = {
          agentId: stored.id,
          status: mappedHealth,
          lastCheckedAt: syncedAt,
          details: {
            source: 'mswarm_self_hosted',
            remoteSlug,
            agentSlug: agent.agent_slug ?? agent.slug,
            provider: agent.provider,
            remoteHealthStatus: agent.health_status,
            remoteHealthReason: selfHostedHealthReason(agent),
            health_reason: lifecycle.reason ?? selfHostedHealthReason(agent),
            reason: lifecycle.reason ?? selfHostedHealthReason(agent),
            lifecycleCompatible: lifecycle.compatible,
            missingRoute: missingRoutes[0],
            missingRoutes,
            gatewayBaseUrl: lifecycle.relay.gatewayBaseUrl ?? this.options.baseUrl,
            jobsPollPath: lifecycle.relay.jobsPollPath,
            jobsStartPathTemplate: lifecycle.relay.jobsStartPathTemplate,
            jobsEventsPathTemplate: lifecycle.relay.jobsEventsPathTemplate,
            jobsResultPathTemplate: lifecycle.relay.jobsResultPathTemplate,
            runtimePackageVersion:
              selfHostedRuntimePackageVersion(agent) ?? 'unknown',
          },
        };
        await this.repo.setAgentHealth(health);
      }

      records.push(
        toManagedSelfHostedSyncRecord(
          nextConfig,
          localSlug,
          agent.default_model,
          existing ? 'updated' : 'created'
        )
      );
    }

    if (options.pruneMissing) {
      const remoteSlugs = new Set(
        agents.map((agent) => agent.remote_slug ?? agent.slug)
      );
      const includeLoadBalanced = options.includeLoadBalanced === true;
      const localAgents = await this.repo.listAgents();
      for (const localAgent of localAgents) {
        const managedConfig = isManagedMswarmSelfHostedConfig(localAgent.config)
          ? localAgent.config
          : undefined;
        if (!managedConfig) continue;
        if (
          selfHostedConfigRoutingMode(managedConfig) === 'auto' &&
          !includeLoadBalanced
        ) {
          continue;
        }
        if (
          options.provider &&
          managedConfig.mswarmSelfHosted.provider !== options.provider
        ) {
          continue;
        }
        if (remoteSlugs.has(managedConfig.mswarmSelfHosted.remoteSlug)) continue;
        await this.repo.deleteAgent(localAgent.id);
        records.push(
          toManagedSelfHostedSyncRecord(
            managedConfig,
            localAgent.slug,
            localAgent.defaultModel ??
              managedConfig.mswarmSelfHosted.modelId ??
              '-',
            'deleted'
          )
        );
      }
    }

    return {
      created: records.filter((record) => record.action === 'created').length,
      updated: records.filter((record) => record.action === 'updated').length,
      deleted: records.filter((record) => record.action === 'deleted').length,
      agents: records,
    };
  }

  async syncWorkers(
    options: ListMswarmWorkerAgentsOptions = {}
  ): Promise<MswarmSyncSummary> {
    if (
      options.pruneMissing &&
      (options.limit !== undefined ||
        options.cursor !== undefined ||
        options.updatedAfter !== undefined ||
        options.includeDisabled === false ||
        hasAdvancedCloudAgentSelection(options))
    ) {
      throw new Error(
        'pruneMissing cannot be combined with partial worker catalog filters'
      );
    }
    const agents = await this.listAllWorkers(options);
    const syncedAt = new Date().toISOString();
    const encryptedApiKey = await CryptoHelper.encryptSecret(
      this.requireApiKey()
    );
    const records: MswarmSyncRecord[] = [];

    for (const agent of agents) {
      const localSlug = toManagedWorkerLocalSlug(
        this.options.workerAgentSlugPrefix,
        agent
      );
      const existing = await this.repo.getAgentBySlug(localSlug);
      const remoteSlug = agent.remote_slug ?? agent.slug;
      if (
        existing &&
        (!isManagedMswarmWorkerConfig(existing.config) ||
          existing.config.mswarmWorker.remoteSlug !== remoteSlug)
      ) {
        throw new Error(`Refusing to overwrite non-mswarm agent ${localSlug}`);
      }

      const existingConfig =
        existing && isRecord(existing.config)
          ? (existing.config as Record<string, unknown>)
          : undefined;
      const nextConfig = toManagedWorkerConfig(
        existingConfig,
        this.options.baseUrl,
        agent,
        syncedAt
      );
      const createInput = {
        ...toSyncedAgentInput(existing, agent, localSlug, nextConfig, syncedAt),
        adapter: 'mswarm-worker',
        openaiCompatible: false,
      };
      const { slug: _ignoredSlug, ...updateInput } = createInput;
      const stored = existing
        ? await this.repo.updateAgent(
            existing.id,
            updateInput as UpdateAgentInput
          )
        : await this.repo.createAgent(createInput);
      if (!stored) {
        throw new Error(`Failed to persist synced worker ${localSlug}`);
      }

      await this.repo.setAgentModels(stored.id, toAgentModels(stored.id, agent));
      await this.repo.setAgentAuth(stored.id, encryptedApiKey);
      const existingHealth = existing
        ? await this.repo.getAgentHealth(existing.id)
        : undefined;
      const mappedHealth = toHealthStatus(agent.health_status);
      if (mappedHealth && shouldReplaceManagedHealth(existingHealth)) {
        const health: AgentHealth = {
          agentId: stored.id,
          status: mappedHealth,
          lastCheckedAt: syncedAt,
          details: {
            source: 'mswarm_worker',
            remoteSlug,
            workerId: agent.id ?? agent.slug,
            remoteHealthStatus: agent.health_status,
          },
        };
        await this.repo.setAgentHealth(health);
      }

      records.push(
        toManagedWorkerSyncRecord(
          nextConfig,
          localSlug,
          agent.default_model,
          existing ? 'updated' : 'created'
        )
      );
    }

    if (options.pruneMissing) {
      const remoteSlugs = new Set(agents.map((agent) => agent.remote_slug ?? agent.slug));
      const localAgents = await this.repo.listAgents();
      for (const localAgent of localAgents) {
        const managedConfig = isManagedMswarmWorkerConfig(localAgent.config)
          ? localAgent.config
          : undefined;
        if (!managedConfig) continue;
        if (
          options.provider &&
          managedConfig.mswarmWorker.provider !== options.provider
        ) {
          continue;
        }
        if (remoteSlugs.has(managedConfig.mswarmWorker.remoteSlug)) continue;
        await this.repo.deleteAgent(localAgent.id);
        records.push(
          toManagedWorkerSyncRecord(
            managedConfig,
            localAgent.slug,
            localAgent.defaultModel ?? managedConfig.mswarmWorker.modelId ?? '-',
            'deleted'
          )
        );
      }
    }

    return {
      created: records.filter((record) => record.action === 'created').length,
      updated: records.filter((record) => record.action === 'updated').length,
      deleted: records.filter((record) => record.action === 'deleted').length,
      agents: records,
    };
  }

  async issuePaidConsent(
    policyVersion = MSWARM_CONSENT_POLICY_VERSION
  ): Promise<MswarmConsentResponse> {
    const apiKey = this.requireApiKey();
    return this.requestJson<MswarmConsentResponse>(
      '/v1/swarm/consent/issue',
      undefined,
      {
        method: 'POST',
        body: {
          consent_types: [...MCODA_CONSENT_TYPES],
          policy_version: policyVersion,
          timestamp_ms: Date.now(),
          proof: {
            type: 'api_key',
            value: apiKey,
          },
        },
      }
    );
  }

  async registerFreeMcodaClient(
    options: RegisterFreeMcodaClientOptions
  ): Promise<MswarmConsentResponse> {
    return this.requestJson<MswarmConsentResponse>(
      '/v1/swarm/mcoda/free-client/register',
      undefined,
      {
        method: 'POST',
        body: {
          client_id: options.clientId,
          product: MCODA_PRODUCT_SLUG,
          product_version: options.productVersion,
          policy_version:
            options.policyVersion ?? MSWARM_CONSENT_POLICY_VERSION,
          timestamp_ms: Date.now(),
          consent_types: [...MCODA_CONSENT_TYPES],
        },
      }
    );
  }

  async revokeConsent(
    consentToken: string,
    reason?: string
  ): Promise<{ revoked: boolean; revoked_at_ms?: number }> {
    return this.requestJson<{ revoked: boolean; revoked_at_ms?: number }>(
      '/v1/swarm/consent/revoke',
      undefined,
      {
        method: 'POST',
        body: {
          consent_token: consentToken,
          reason,
        },
      }
    );
  }

  async requestDataDeletion(
    input: RequestMswarmDataDeletionInput
  ): Promise<MswarmDataDeletionResponse> {
    return this.requestJson<MswarmDataDeletionResponse>(
      '/v1/swarm/data/deletion-request',
      undefined,
      {
        method: 'POST',
        body: {
          consent_token: input.consentToken,
          product: input.product,
          client_id: input.clientId,
          client_type: input.clientType,
          reason: input.reason,
        },
      }
    );
  }
}
