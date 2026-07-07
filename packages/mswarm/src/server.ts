#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION,
  assertMswarmSafeRelativePath,
  buildMswarmLocalArtifactUri,
  defaultMswarmArtifactAccessPolicy,
  defaultMswarmArtifactRetentionPolicy,
  buildMswarmGenericJobAuditEvent,
  buildMswarmGenericJobEnvelopeDescriptor,
  isMswarmLifecycleStateTransitionAllowed,
  isMswarmTerminalLifecycleState,
  normalizeMswarmGenericJobIdempotencyKey,
  type MswarmGenericJobBackpressureReason,
  type MswarmGenericJobAuditEvent,
  type MswarmGenericJobLifecycleSnapshot,
  type MswarmGenericJobLogRecord,
  type MswarmGenericJobRecord,
  type MswarmGenericJobReservation,
  type MswarmJobEvent,
  type MswarmJobResult
} from "@mcoda/shared";
import {
  verifySelfHostedCapabilityToken,
  verifySelfHostedGenericJobOpsToken,
  verifySelfHostedGenericJobToken,
  verifySelfHostedInvocationToken,
  type SelfHostedCapabilityTokenClaims,
  type SelfHostedGenericJobOpsTokenClaims,
  type SelfHostedGenericJobTokenClaims,
  type SelfHostedInvocationTokenClaims
} from "./invocation-token.js";
import {
  controlSelfHostedNodeService,
  installSelfHostedNodeService,
  addSelfHostedNodeClients,
  normalizeSelfHostedNodeClientAllowlist,
  readOwnerSetupConfig,
  readSelfHostedNodeState,
  readSelfHostedNodeConfig,
  removeSelfHostedNodeClients,
  resolveSelfHostedNodeServiceLayout,
  SelfHostedNodeRuntime,
  uninstallSelfHostedNodeService,
  writeSelfHostedNodeState,
  genericJobCapabilityMismatch,
  type SelfHostedGenericNodeJob,
  type SelfHostedNodeConfig,
  type SelfHostedNodeInvocationJob
} from "./runtime.js";

const SELF_HOSTED_NODE_PROCESS_TITLE = "mswarm-node";

type GenericJobSseEventLike = { type?: unknown; [key: string]: unknown };

interface ActiveGenericJob {
  controller: AbortController;
  claims: SelfHostedGenericJobTokenClaims;
}

function applySelfHostedNodeProcessTitle(): void {
  const title = process.env.MSWARM_SELF_HOSTED_PROCESS_TITLE?.trim() || SELF_HOSTED_NODE_PROCESS_TITLE;
  process.title = title;
}

function printUsage(): void {
  console.log(`Usage: mswarm <node|install|setup|start|doctor|once|daemon|serve|enroll|models|agents|status>

Commands:
  node install [clients] [options]  Bootstrap this machine and install a persistent background daemon
  node start               Start the installed background daemon
  node stop                Stop the installed background daemon
  node restart             Restart the installed background daemon
  node status              Show installed daemon/service status
  node health              Run node health checks
  node doctor              Run deep node diagnostics
  node logs [options]      Print daemon logs
  node add-client <clients>     Add allowed client domains, IPs, or UUIDs
  node remove-client <clients>  Remove allowed client domains, IPs, or UUIDs
  node uninstall           Remove the installed daemon, then mark the gateway node unreachable
  node run                 Run the node in the foreground

Compatibility aliases:
  install <API_KEY>        Legacy install flow with positional owner API key
  setup --api-key <KEY>   Bootstrap without installing a daemon
  start                   Foreground node run; node start controls the daemon
  doctor                  Alias for node doctor
  status                  Legacy one-shot heartbeat/status check

Environment:
  MSWARM_GATEWAY_BASE_URL                  Gateway base URL, defaults to http://127.0.0.1:8080
  MSWARM_SELF_HOSTED_NODE_ID               Node id from the owner registration response
  MSWARM_SELF_HOSTED_ENROLLMENT_TOKEN      One-time enrollment token
  MSWARM_SELF_HOSTED_RUNTIME_TOKEN         Optional runtime token override
  MSWARM_SELF_HOSTED_DISCOVERY_MODE        mcoda or ollama, defaults to mcoda
  MSWARM_SELF_HOSTED_MCODA_BIN             mcoda binary, defaults to mcoda
  MSWARM_SELF_HOSTED_MCODA_LIST_ARGS       Comma-separated args, defaults to agent,list,--json,--refresh-health
  MSWARM_SELF_HOSTED_OLLAMA_BASE_URL       Ollama base URL, defaults to http://127.0.0.1:11434
  MSWARM_SELF_HOSTED_NODE_STATE_PATH       Config/state file, defaults to ~/.mswarm/self-hosted-node/config.json
  MSWARM_SELF_HOSTED_NODE_KEY_PATH         Runtime token file, defaults to ~/.mswarm/self-hosted-node/node.key
  MSWARM_SELF_HOSTED_ARTIFACT_STORE_PATH   Local generic-job artifact store, defaults to ~/.mswarm/self-hosted-node/artifacts
  MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET  Shared direct-job signing secret
  MSWARM_SELF_HOSTED_MAX_CONCURRENT_JOBS        Overall advertised job capacity, defaults to 1
  MSWARM_SELF_HOSTED_MAX_CONCURRENT_LLM_JOBS    LLM/Codali capacity, defaults to overall capacity
  MSWARM_SELF_HOSTED_DRAIN_MODE                 Report zero free slots for maintenance
  MSWARM_SELF_HOSTED_LOAD_REPORTING_ENABLED     Add load-balancer telemetry, defaults to true
  MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY_ENABLED Opt in to coarse host pressure telemetry
  MSWARM_SELF_HOSTED_GENERIC_JOBS_ENABLED       Enable owner-local generic jobs, defaults to false
  MSWARM_SELF_HOSTED_GENERIC_JOB_TIMEOUT_MS     Generic job timeout, defaults to self-hosted job timeout
  MSWARM_SELF_HOSTED_GENERIC_JOB_MAX_CONCURRENCY  Generic job concurrency, defaults to 1
  MSWARM_SELF_HOSTED_CAPABILITY_PROBE_TIMEOUT_MS  Capability probe timeout, defaults to 2000
  MSWARM_SELF_HOSTED_LISTEN_HOST           Direct node bind host, defaults to 127.0.0.1
  MSWARM_SELF_HOSTED_LISTEN_PORT           Direct node bind port, defaults to 18083
  MSWARM_SELF_HOSTED_MODEL_ALLOWLIST       Comma-separated local agent slugs/model names to expose
  MSWARM_SELF_HOSTED_MODEL_BLOCKLIST       Comma-separated local agent slugs/model names to hide
  MSWARM_SELF_HOSTED_EXPOSURE_POLICY       all or none, defaults to all

Setup options:
  node install <CLIENTS>   Preferred setup flow; comma-separated client domains/IPs/UUIDs
  --api-key <KEY>           Owner mswarm API key; fallback MSWARM_API_KEY
  --api-key-stdin           Read owner API key from stdin for automation
  --clients <CLIENTS>       Comma-separated client domains, IPs, or UUIDs
  --gateway <URL>           Defaults to https://api.mswarm.org
  --server-name <NAME>      Defaults to os.hostname()
  --mode <outbound|direct>  Defaults to outbound
  --direct-url <URL>        Required only for direct mode
  --allow <SLUGS>           Comma-separated allowlist
  --block <SLUGS>           Comma-separated blocklist
  --expose-all              Expose all healthy non-embedding local agents (default)
  --no-expose-all           Expose only allowlisted local agents
  --max-concurrent-jobs <N> Overall advertised job capacity
  --max-concurrent-llm-jobs <N> LLM/Codali capacity
  --drain                   Register the node in drain mode
  --disable-load-reporting  Keep legacy heartbeat capacity shape only
  --enable-hardware-telemetry  Include coarse host pressure telemetry in heartbeats
  --enable-generic-jobs     Enable owner-local generic job endpoint for development
  --generic-job-timeout-ms <N>  Generic job timeout for owner-local development
  --generic-job-max-concurrency <N>  Generic job concurrency for owner-local development
  --artifact-store-path <PATH>  Local generic-job artifact store path
  --start                   Start foreground daemon after setup

Log options:
  --error                   Read daemon.err.log instead of daemon.log
  --lines <N>               Number of log lines to print, defaults to 200
`);
}

export function buildInstallSetupArgs(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (first && !first.startsWith("--")) {
    return ["--api-key", first, ...rest];
  }
  return argv;
}

export function buildNodeClientSetupArgs(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (!first || first.startsWith("--")) {
    return argv;
  }
  if (/^msw[_-]/i.test(first)) {
    throw new Error(
      "mswarm node install positional input is now a client allowlist; pass the owner API key with --api-key or --api-key-stdin, or use legacy mswarm install <API_KEY>."
    );
  }
  return ["--clients", first, ...rest];
}

export function normalizeMswarmCommand(argv: string[]): { namespace: "node" | null; command: string; args: string[] } {
  const command = argv[2] || "once";
  if (command === "node") {
    return { namespace: "node", command: argv[3] || "help", args: argv.slice(4) };
  }
  return { namespace: null, command, args: argv.slice(3) };
}

function hasApiKeyArg(argv: string[]): boolean {
  return argv.some(
    (entry, index) =>
      entry.startsWith("--api-key=") ||
      (entry === "--api-key" && typeof argv[index + 1] === "string")
  );
}

function headerText(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function extractAttachedMswarmApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  return (
    headerText(headers, "x-mswarm-attached-api-key") ??
    headerText(headers, "x-attached-mswarm-api-key")
  );
}

async function readApiKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function buildNodeInstallSetupArgs(argv: string[]): Promise<string[]> {
  const args = [...argv];
  const stdinIndex = args.indexOf("--api-key-stdin");
  if (stdinIndex >= 0) {
    args.splice(stdinIndex, 1);
    if (hasApiKeyArg(args)) {
      throw new Error("Use either --api-key or --api-key-stdin; not more than one");
    }
    const apiKey = await readApiKeyFromStdin();
    if (!apiKey) {
      throw new Error("No API key received on stdin");
    }
    return ["--api-key", apiKey, ...buildNodeClientSetupArgs(args)];
  }
  return buildNodeClientSetupArgs(args);
}

function parsePositiveLineCount(argv: string[], fallback: number): number {
  const index = argv.indexOf("--lines");
  if (index < 0) return fallback;
  const parsed = Number(argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function lastLines(content: string, count: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function extractBearerToken(headers: Record<string, string | string[] | undefined>): string {
  const authorization = headers.authorization;
  const raw = Array.isArray(authorization) ? authorization[0] : authorization || "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function assertJobMatchesClaims(job: SelfHostedNodeInvocationJob, claims: SelfHostedInvocationTokenClaims): void {
  if (job.node_id !== claims.node_id) {
    throw new Error("job node_id does not match invocation token");
  }
  if (job.job_id !== claims.job_id) {
    throw new Error("job_id does not match invocation token");
  }
  if (job.request_id !== claims.request_id) {
    throw new Error("request_id does not match invocation token");
  }
  if (job.openai_request?.model !== claims.model) {
    throw new Error("model does not match invocation token");
  }
}

function assertGenericJobMatchesClaims(job: SelfHostedGenericNodeJob, claims: SelfHostedGenericJobTokenClaims): void {
  if (job.node_id !== claims.node_id) {
    throw new Error("generic job node_id does not match invocation token");
  }
  if (job.job_id !== claims.job_id) {
    throw new Error("generic job_id does not match invocation token");
  }
  if (job.request_id !== claims.request_id) {
    throw new Error("generic request_id does not match invocation token");
  }
  if (job.job?.schema_version !== claims.schema_version) {
    throw new Error("generic schema_version does not match invocation token");
  }
  if (job.job?.job_type !== claims.job_type) {
    throw new Error("generic job_type does not match invocation token");
  }
}

function isOwnerLocalHost(value: string | null | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "127.0.0.1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  );
}

function isOwnerLocalGenericMode(config: SelfHostedNodeConfig): boolean {
  if (!config.genericJobsEnabled || !isOwnerLocalHost(config.listenHost)) {
    return false;
  }
  if (!config.directBaseUrl) {
    return true;
  }
  try {
    return isOwnerLocalHost(new URL(config.directBaseUrl).hostname);
  } catch {
    return false;
  }
}

function isOwnerLocalNodeApiMode(config: SelfHostedNodeConfig): boolean {
  if (!isOwnerLocalHost(config.listenHost)) {
    return false;
  }
  if (!config.directBaseUrl) {
    return true;
  }
  try {
    return isOwnerLocalHost(new URL(config.directBaseUrl).hostname);
  } catch {
    return false;
  }
}

function acceptsGenericEventStream(headers: Record<string, string | string[] | undefined>): boolean {
  const accept = headerText(headers, "accept") || "";
  return accept.split(",").some((entry) => entry.trim().toLowerCase().startsWith("text/event-stream"));
}

function writeSelfHostedSseChunk(raw: { write: (chunk: string) => unknown }, chunk: Record<string, unknown>): void {
  raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeSelfHostedSseDone(raw: { write: (chunk: string) => unknown }): void {
  raw.write("data: [DONE]\n\n");
}

function writeGenericJobSseEvent(raw: { write: (chunk: string) => unknown }, event: GenericJobSseEventLike): void {
  raw.write(`event: ${String(event.type || "message")}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function genericJobFailureStatusCode(result: { status: string; result: { error?: { code?: string } } }): number {
  const code = result.result.error?.code;
  return code === "validation_failed"
    ? 400
    : code === "timeout"
      ? 408
      : result.status === "cancelled"
        ? 409
        : 502;
}

const MAX_OWNER_LOCAL_ARTIFACT_UPLOAD_BYTES = 128 * 1024 * 1024;

interface GenericJobArtifactUploadBody {
  name?: unknown;
  path?: unknown;
  content_base64?: unknown;
  content_type?: unknown;
  sha256?: unknown;
  size_bytes?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function decodeArtifactUploadBody(body: unknown): {
  name: string;
  path: string;
  contentType?: string;
  sha256: string;
  bytes: Buffer;
} {
  const payload = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as GenericJobArtifactUploadBody;
  const artifactPath = assertMswarmSafeRelativePath(payload.path, "artifact_path");
  const rawBase64 = optionalString(payload.content_base64);
  if (!rawBase64) {
    throw new Error("content_base64_required");
  }
  const normalizedBase64 = rawBase64.replace(/\s/g, "");
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(normalizedBase64) || normalizedBase64.length % 4 === 1) {
    throw new Error("content_base64_invalid");
  }
  const bytes = Buffer.from(normalizedBase64, "base64");
  if (bytes.length > MAX_OWNER_LOCAL_ARTIFACT_UPLOAD_BYTES) {
    throw new Error("artifact_upload_size_limit_exceeded");
  }
  if (typeof payload.size_bytes === "number" && Number.isFinite(payload.size_bytes) && payload.size_bytes !== bytes.length) {
    throw new Error("artifact_upload_size_mismatch");
  }
  const sha256 = sha256Hex(bytes);
  const expectedSha = optionalString(payload.sha256);
  if (expectedSha && expectedSha !== sha256) {
    throw new Error("artifact_upload_checksum_mismatch");
  }
  return {
    name: optionalString(payload.name) || artifactPath.split("/").pop() || "artifact",
    path: artifactPath,
    contentType: optionalString(payload.content_type),
    sha256,
    bytes
  };
}

function artifactUploadRoot(config: SelfHostedNodeConfig, jobId: string): string {
  const safeJobId = assertMswarmSafeRelativePath(jobId.replace(/[^a-zA-Z0-9_.-]/g, "_"), "job_id");
  return resolve(config.artifactStorePath || ".", safeJobId);
}

function resolveArtifactUploadTarget(config: SelfHostedNodeConfig, jobId: string, relativePath: string): string {
  const root = artifactUploadRoot(config, jobId);
  const target = resolve(root, relativePath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new Error("artifact_path_escape_rejected");
  }
  return target;
}

async function assertNoArtifactSymlinkSegments(root: string, relativePath: string): Promise<void> {
  let cursor = root;
  const segments = relativePath.split("/").slice(0, -1);
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new Error("artifact_path_symlink_rejected");
      }
      if (!info.isDirectory()) {
        throw new Error("artifact_path_parent_not_directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

type GenericJobAuthResult =
  | {
      ok: true;
      token: string;
      claims: SelfHostedGenericJobTokenClaims;
    }
  | {
      ok: false;
      statusCode: number;
      payload: Record<string, unknown>;
    };

type GenericJobOpsAuthResult =
  | {
      ok: true;
      claims: SelfHostedGenericJobOpsTokenClaims;
    }
  | {
      ok: false;
      statusCode: number;
      payload: Record<string, unknown>;
    };

function verifyOwnerLocalGenericJobRequest(
  config: SelfHostedNodeConfig,
  headers: Record<string, string | string[] | undefined>
): GenericJobAuthResult {
  if (!config.genericJobsEnabled) {
    return {
      ok: false,
      statusCode: 404,
      payload: {
        error: "not_found",
        code: "feature_disabled",
        message: "Generic node jobs are disabled on this node"
      }
    };
  }
  if (!isOwnerLocalGenericMode(config)) {
    return {
      ok: false,
      statusCode: 403,
      payload: {
        error: "forbidden",
        code: "owner_local_required",
        message: "Generic node jobs are only available in owner-local direct mode"
      }
    };
  }
  if (!config.invocationSigningSecret) {
    return {
      ok: false,
      statusCode: 503,
      payload: {
        error: "service_unavailable",
        code: "missing_config",
        message: "MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for generic jobs"
      }
    };
  }
  const token = extractBearerToken(headers);
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      payload: {
        error: "unauthorized",
        code: "unauthorized",
        message: "Missing generic job token"
      }
    };
  }
  try {
    return {
      ok: true,
      token,
      claims: verifySelfHostedGenericJobToken({
        token,
        secret: config.invocationSigningSecret
      })
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 401,
      payload: {
        error: "unauthorized",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Invalid generic job token"
      }
    };
  }
}

function verifyOwnerLocalGenericJobOpsRequest(
  config: SelfHostedNodeConfig,
  headers: Record<string, string | string[] | undefined>
): GenericJobOpsAuthResult {
  if (!config.genericJobsEnabled) {
    return {
      ok: false,
      statusCode: 404,
      payload: {
        error: "not_found",
        code: "feature_disabled",
        message: "Generic node jobs are disabled on this node"
      }
    };
  }
  if (!isOwnerLocalGenericMode(config)) {
    return {
      ok: false,
      statusCode: 403,
      payload: {
        error: "forbidden",
        code: "owner_local_required",
        message: "Generic node operations are only available in owner-local direct mode"
      }
    };
  }
  if (!config.invocationSigningSecret) {
    return {
      ok: false,
      statusCode: 503,
      payload: {
        error: "service_unavailable",
        code: "missing_config",
        message: "MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for generic job operations"
      }
    };
  }
  const token = extractBearerToken(headers);
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      payload: {
        error: "unauthorized",
        code: "unauthorized",
        message: "Missing generic job ops token"
      }
    };
  }
  try {
    const claims = verifySelfHostedGenericJobOpsToken({
      token,
      secret: config.invocationSigningSecret
    });
    if (claims.node_id !== config.nodeId) {
      return {
        ok: false,
        statusCode: 400,
        payload: {
          error: "bad_request",
          code: "validation_failed",
          message: "generic job ops token does not match this node"
        }
      };
    }
    return { ok: true, claims };
  } catch (error) {
    return {
      ok: false,
      statusCode: 401,
      payload: {
        error: "unauthorized",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Invalid generic job ops token"
      }
    };
  }
}

function assertLifecycleJobIdMatchesClaims(
  jobId: string,
  config: SelfHostedNodeConfig,
  claims: SelfHostedGenericJobTokenClaims
): void {
  if (claims.node_id !== config.nodeId || claims.job_id !== jobId) {
    throw new Error("generic job token does not match this node or job");
  }
}

interface LifecycleJobEntry {
  record: MswarmGenericJobRecord;
  claims: SelfHostedGenericJobTokenClaims;
  tokenSha256: string;
  events: MswarmJobEvent[];
  logs: MswarmGenericJobLogRecord[];
  audit: MswarmGenericJobAuditEvent[];
  controller?: AbortController;
}

interface GenericJobOpsOptions {
  auditLimit: number;
  auditOffset: number;
}

interface GenericJobOpsJobSummary {
  job_id: string;
  request_id: string;
  tenant_id: string;
  node_id?: string;
  state: string;
  job_type: string;
  schema_version: string;
  priority: number;
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

interface GenericJobOpsSummary {
  schema_version: typeof MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION;
  generated_at: string;
  node: {
    node_id: string;
    listen_host: string;
    listen_port: number;
    owner_local: boolean;
    generic_jobs_enabled: boolean;
    artifact_store_configured: boolean;
    max_concurrent_jobs: number;
  };
  capabilities: Record<string, unknown>;
  queue: {
    jobs: GenericJobOpsJobSummary[];
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
    production_enforced: false;
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

function tenantIdForGenericJob(job: SelfHostedGenericNodeJob): string {
  const metadata = job.job.metadata;
  const tenantId = metadata && typeof metadata.tenant_id === "string" ? metadata.tenant_id.trim() : "";
  return tenantId || "owner-local";
}

function genericJobMaxConcurrency(config: SelfHostedNodeConfig): number {
  const configured = config.genericJobMaxConcurrency;
  return Number.isFinite(configured) && configured && configured > 0 ? Math.floor(configured) : 1;
}

function clampOpsQueryNumber(value: unknown, fallback: number, max: number): number {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(max, Math.floor(parsed));
}

function opsQueryOptions(query: unknown): GenericJobOpsOptions {
  const record = query && typeof query === "object" && !Array.isArray(query) ? query as Record<string, unknown> : {};
  return {
    auditLimit: clampOpsQueryNumber(record.audit_limit ?? record.auditLimit, 50, 250),
    auditOffset: clampOpsQueryNumber(record.audit_offset ?? record.auditOffset, 0, 10_000)
  };
}

function artifactBytes(record: MswarmGenericJobRecord): number {
  return (record.artifacts || []).reduce((total, artifact) => total + (artifact.size_bytes || 0), 0);
}

function logBytes(logs: MswarmGenericJobLogRecord[], stream?: MswarmGenericJobLogRecord["stream"]): number {
  return logs
    .filter((log) => !stream || log.stream === stream)
    .reduce((total, log) => total + Buffer.byteLength(log.message || "", "utf8"), 0);
}

function progressPercent(events: MswarmJobEvent[]): number | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "progress" || !event.data || typeof event.data !== "object") {
      continue;
    }
    const data = event.data as Record<string, unknown>;
    const value = data.progress_percent ?? data.percent ?? data.progress;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.min(100, value));
    }
  }
  return undefined;
}

function gpuSeconds(record: MswarmGenericJobRecord): number {
  if (!record.started_at || !record.finished_at) {
    return 0;
  }
  const started = Date.parse(record.started_at);
  const finished = Date.parse(record.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) {
    return 0;
  }
  const gpuCount = Math.max(1, Math.floor(record.reservation?.resources?.gpu_count || record.job.resources?.gpu?.count || 1));
  return Math.round(((finished - started) / 1000) * gpuCount * 1000) / 1000;
}

function tokenSha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function lifecycleRetryPolicy(job: SelfHostedGenericNodeJob): MswarmGenericJobRecord["retry"] {
  const retry = job.job.metadata?.retry;
  const retryRecord = retry && typeof retry === "object" && !Array.isArray(retry) ? retry as Record<string, unknown> : null;
  const maxRetries = typeof retryRecord?.max_retries === "number"
    ? Math.max(0, Math.min(3, Math.floor(retryRecord.max_retries)))
    : 0;
  return {
    max_retries: maxRetries,
    retry_count: 0,
    retryable_error_codes: ["timeout"]
  };
}

function genericJobPriority(job: SelfHostedGenericNodeJob): number {
  const priority = job.job.scheduling?.priority;
  return typeof priority === "number" && Number.isInteger(priority) ? priority : 0;
}

class OwnerLocalGenericJobLifecycleScheduler {
  private readonly jobs = new Map<string, LifecycleJobEntry>();
  private readonly idempotency = new Map<string, string>();
  private dispatching = false;

  constructor(
    private readonly runtime: SelfHostedNodeRuntime,
    private readonly config: SelfHostedNodeConfig
  ) {}

  private syncRuntimeQueueTelemetry(): void {
    this.runtime.updateLocalQueueTelemetry({ genericQueuedJobs: this.queuedEntries().length });
  }

  create(job: SelfHostedGenericNodeJob, claims: SelfHostedGenericJobTokenClaims, token: string): {
    snapshot: MswarmGenericJobLifecycleSnapshot;
    reused: boolean;
  } {
    const tenantId = tenantIdForGenericJob(job);
    const idempotencyKey = normalizeMswarmGenericJobIdempotencyKey({
      tenantId,
      idempotencyKey: job.job.idempotency_key,
      jobId: job.job_id,
      requestId: job.request_id
    });
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) {
      const existing = this.mustGetEntry(existingId);
      if (existing.record.job_id !== job.job_id || existing.record.request_id !== job.request_id) {
        throw new Error("idempotency_key_conflict");
      }
      this.audit(existing, "job_idempotent_reused", { idempotency_key: idempotencyKey });
      return { snapshot: this.snapshot(existing), reused: true };
    }
    if (this.jobs.has(job.job_id)) {
      throw new Error("job_id_conflict");
    }
    const now = new Date().toISOString();
    const entry: LifecycleJobEntry = {
      claims,
      tokenSha256: tokenSha256(token),
      events: [],
      logs: [],
      audit: [],
      record: {
        schema_version: MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION,
        job_id: job.job_id,
        request_id: job.request_id,
        tenant_id: tenantId,
        node_id: this.config.nodeId,
        state: "queued",
        job: job.job,
        idempotency_key: idempotencyKey,
        priority: genericJobPriority(job),
        ...(job.job.scheduling ? { scheduling: job.job.scheduling } : {}),
        created_at: now,
        updated_at: now,
        queued_at: now,
        retry: lifecycleRetryPolicy(job)
      }
    };
    this.jobs.set(job.job_id, entry);
    this.idempotency.set(idempotencyKey, job.job_id);
    this.audit(entry, "job_created", { idempotency_key: idempotencyKey, priority: entry.record.priority });
    this.audit(entry, "job_queued");
    this.syncRuntimeQueueTelemetry();
    queueMicrotask(() => {
      void this.dispatchQueued();
    });
    return { snapshot: this.snapshot(entry), reused: false };
  }

  get(jobId: string): MswarmGenericJobLifecycleSnapshot | null {
    const entry = this.jobs.get(jobId);
    return entry ? this.snapshot(entry) : null;
  }

  async ops(options: GenericJobOpsOptions): Promise<GenericJobOpsSummary> {
    const capabilities = await this.runtime.publicCapabilityProjection();
    const entries = Array.from(this.jobs.values());
    const totalsByState: Record<string, number> = {};
    for (const entry of entries) {
      totalsByState[entry.record.state] = (totalsByState[entry.record.state] || 0) + 1;
    }
    const activeJobs = this.activeEntries().length;
    const queuedJobs = this.queuedEntries().length;
    const terminalJobs = entries.filter((entry) => isMswarmTerminalLifecycleState(entry.record.state)).length;
    const stdoutBytes = entries.reduce((total, entry) => total + logBytes(entry.logs, "stdout"), 0);
    const stderrBytes = entries.reduce((total, entry) => total + logBytes(entry.logs, "stderr"), 0);
    const allAudit = entries
      .flatMap((entry) => entry.audit)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const jobs = entries
      .map((entry) => this.opsJobSummary(entry))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      schema_version: MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      node: {
        node_id: this.config.nodeId,
        listen_host: this.config.listenHost,
        listen_port: this.config.listenPort,
        owner_local: isOwnerLocalGenericMode(this.config),
        generic_jobs_enabled: this.config.genericJobsEnabled,
        artifact_store_configured: Boolean(this.config.artifactStorePath),
        max_concurrent_jobs: genericJobMaxConcurrency(this.config)
      },
      capabilities: capabilities as unknown as Record<string, unknown>,
      queue: {
        jobs,
        totals_by_state: totalsByState,
        active_jobs: activeJobs,
        queued_jobs: queuedJobs,
        terminal_jobs: terminalJobs
      },
      quota: {
        max_concurrent_jobs: genericJobMaxConcurrency(this.config),
        active_jobs: activeJobs,
        queued_jobs: queuedJobs,
        available_slots: Math.max(0, genericJobMaxConcurrency(this.config) - activeJobs),
        production_enforced: false,
        limits: {
          generic_job_timeout_ms: this.config.genericJobTimeoutMs,
          job_timeout_ms: this.config.jobTimeoutMs,
          request_timeout_ms: this.config.requestTimeoutMs,
          artifact_store_configured: Boolean(this.config.artifactStorePath)
        }
      },
      usage: {
        total_jobs: entries.length,
        active_jobs: activeJobs,
        terminal_jobs: terminalJobs,
        succeeded_jobs: totalsByState.succeeded || 0,
        failed_jobs: totalsByState.failed || 0,
        cancelled_jobs: totalsByState.cancelled || 0,
        blocked_jobs: totalsByState.blocked || 0,
        expired_jobs: totalsByState.expired || 0,
        gpu_seconds: Math.round(entries.reduce((total, entry) => total + gpuSeconds(entry.record), 0) * 1000) / 1000,
        artifact_count: entries.reduce((total, entry) => total + (entry.record.artifacts || []).length, 0),
        artifact_bytes: entries.reduce((total, entry) => total + artifactBytes(entry.record), 0),
        event_count: entries.reduce((total, entry) => total + entry.events.length, 0),
        audit_event_count: allAudit.length,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        log_bytes: stdoutBytes + stderrBytes
      },
      audit: {
        total: allAudit.length,
        offset: options.auditOffset,
        limit: options.auditLimit,
        events: allAudit.slice(options.auditOffset, options.auditOffset + options.auditLimit)
      }
    };
  }

  cancel(jobId: string, claims: SelfHostedGenericJobTokenClaims): MswarmGenericJobLifecycleSnapshot {
    const entry = this.mustGetEntry(jobId);
    if (
      entry.claims.request_id !== claims.request_id ||
      entry.claims.schema_version !== claims.schema_version ||
      entry.claims.job_type !== claims.job_type
    ) {
      throw new Error("generic cancellation token does not match the lifecycle job");
    }
    this.audit(entry, "job_cancel_requested");
    if (isMswarmTerminalLifecycleState(entry.record.state)) {
      return this.snapshot(entry);
    }
    if (entry.controller && !entry.controller.signal.aborted) {
      entry.controller.abort("cancelled");
      return this.snapshot(entry);
    }
    this.transition(entry, "cancelled", {
      finished_at: new Date().toISOString(),
      result: {
        job_id: entry.record.job_id,
        status: "cancelled",
        error: {
          code: "cancelled",
          message: "generic job cancelled before dispatch"
        }
      }
    });
    this.audit(entry, "job_cancelled");
    this.releaseReservation(entry);
    return this.snapshot(entry);
  }

  retry(jobId: string, claims: SelfHostedGenericJobTokenClaims): MswarmGenericJobLifecycleSnapshot {
    const entry = this.mustGetEntry(jobId);
    if (
      entry.claims.request_id !== claims.request_id ||
      entry.claims.schema_version !== claims.schema_version ||
      entry.claims.job_type !== claims.job_type
    ) {
      throw new Error("generic retry token does not match the lifecycle job");
    }
    if (!isMswarmTerminalLifecycleState(entry.record.state)) {
      throw new Error("job_retry_requires_terminal_state");
    }
    if (entry.record.state === "succeeded") {
      throw new Error("job_retry_not_allowed_for_succeeded_jobs");
    }
    this.releaseReservation(entry);
    const now = new Date().toISOString();
    const retryCount = entry.record.retry.retry_count + 1;
    entry.record = {
      ...entry.record,
      state: "queued",
      updated_at: now,
      queued_at: now,
      scheduled_at: undefined,
      started_at: undefined,
      finished_at: undefined,
      reservation: undefined,
      envelope: undefined,
      backpressure: undefined,
      result: undefined,
      artifacts: undefined,
      retry: {
        ...entry.record.retry,
        retry_count: retryCount,
        next_retry_at: now
      }
    };
    this.audit(entry, "job_retry_scheduled", { retry_count: retryCount, manual: true });
    queueMicrotask(() => {
      void this.dispatchQueued();
    });
    return this.snapshot(entry);
  }

  private async dispatchQueued(): Promise<void> {
    if (this.dispatching) {
      return;
    }
    this.dispatching = true;
    try {
      while (this.activeEntries().length < genericJobMaxConcurrency(this.config)) {
        const entry = this.nextDispatchableEntry();
        if (!entry) {
          return;
        }
        const activeTenant = this.activeTenantId();
        if (activeTenant && activeTenant !== entry.record.tenant_id) {
          this.setBackpressure(entry, "tenant_reserved", "Node is reserved for another tenant until active jobs finish.");
          return;
        }
        const capabilityOk = await this.recheckCapabilities(entry);
        if (!capabilityOk) {
          continue;
        }
        this.schedule(entry);
        void this.runScheduled(entry);
      }
      for (const entry of this.queuedEntries()) {
        this.setBackpressure(entry, "node_at_capacity", "Node is at generic job concurrency limit.", 1000);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private activeEntries(): LifecycleJobEntry[] {
    return Array.from(this.jobs.values()).filter((entry) => entry.record.state === "scheduled" || entry.record.state === "running");
  }

  private queuedEntries(): LifecycleJobEntry[] {
    return Array.from(this.jobs.values()).filter((entry) => entry.record.state === "queued" || entry.record.state === "retrying");
  }

  private nextDispatchableEntry(): LifecycleJobEntry | null {
    return this.queuedEntries().sort((a, b) => {
      const priorityDelta = a.record.priority - b.record.priority;
      if (priorityDelta !== 0) return priorityDelta;
      const queuedDelta = (a.record.queued_at || a.record.created_at).localeCompare(b.record.queued_at || b.record.created_at);
      if (queuedDelta !== 0) return queuedDelta;
      return a.record.created_at.localeCompare(b.record.created_at);
    })[0] || null;
  }

  private activeTenantId(): string | null {
    const active = this.activeEntries().find((entry) => entry.record.reservation && !entry.record.reservation.released_at);
    return active?.record.tenant_id || null;
  }

  private async recheckCapabilities(entry: LifecycleJobEntry): Promise<boolean> {
    const snapshot = await this.runtime.probeCapabilities();
    const capabilityMismatch = genericJobCapabilityMismatch(entry.record.job, snapshot);
    if (capabilityMismatch) {
      this.transition(entry, "blocked", {
        finished_at: new Date().toISOString(),
        backpressure: {
          reason: "no_capable_node",
          message: capabilityMismatch.message
        },
        result: {
          job_id: entry.record.job_id,
          status: "failed",
          error: {
            code: capabilityMismatch.code,
            message: capabilityMismatch.message,
            retryable: true
          }
        }
      });
      this.audit(entry, "job_blocked", { reason: capabilityMismatch.code });
      return false;
    }
    return true;
  }

  private schedule(entry: LifecycleJobEntry): void {
    const now = new Date().toISOString();
    const reservation: MswarmGenericJobReservation = {
      node_id: this.config.nodeId,
      tenant_id: entry.record.tenant_id,
      job_id: entry.record.job_id,
      request_id: entry.record.request_id,
      reserved_at: now,
      resources: {
        ...(entry.record.job.resources?.gpu?.count ? { gpu_count: entry.record.job.resources.gpu.count } : {}),
        ...(entry.record.job.resources?.cpu?.cores ? { cpu_cores: entry.record.job.resources.cpu.cores } : {}),
        ...(entry.record.job.resources?.memory_gb ? { memory_gb: entry.record.job.resources.memory_gb } : {}),
        ...(entry.record.job.resources?.disk_gb ? { disk_gb: entry.record.job.resources.disk_gb } : {})
      }
    };
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.transition(entry, "scheduled", {
      node_id: this.config.nodeId,
      scheduled_at: now,
      reservation,
      backpressure: undefined,
      envelope: buildMswarmGenericJobEnvelopeDescriptor({
        jobId: entry.record.job_id,
        requestId: entry.record.request_id,
        nodeId: this.config.nodeId,
        job: entry.record.job,
        issuedAt: now,
        expiresAt,
        tokenSha256: entry.tokenSha256
      })
    });
    this.audit(entry, "reservation_created", { resources: reservation.resources });
    this.audit(entry, "envelope_issued", { expires_at: expiresAt });
    this.audit(entry, "job_scheduled", { priority: entry.record.priority });
  }

  private async runScheduled(entry: LifecycleJobEntry): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    this.transition(entry, "running", {
      started_at: new Date().toISOString()
    });
    this.audit(entry, "job_started");
    const envelope: SelfHostedGenericNodeJob = {
      job_id: entry.record.job_id,
      request_id: entry.record.request_id,
      node_id: this.config.nodeId,
      job: entry.record.job
    };
    const result = await this.runtime.executeGenericJob(envelope, {
      signal: controller.signal,
      onEvent: async (event) => {
        this.recordEvent(entry, event);
      }
    });
    entry.controller = undefined;
    if (result.status === "failed" && this.shouldRetry(entry, result.result.error?.code)) {
      this.scheduleRetry(entry, result.result);
      await this.dispatchQueued();
      return;
    }
    const terminalState = result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
    this.transition(entry, terminalState, {
      finished_at: new Date().toISOString(),
      result: result.result,
      artifacts: result.result.artifacts || []
    });
    this.audit(entry, terminalState === "cancelled" ? "job_cancelled" : "job_completed", { status: terminalState });
    this.releaseReservation(entry);
    await this.dispatchQueued();
  }

  private shouldRetry(entry: LifecycleJobEntry, errorCode: string | undefined): boolean {
    if (!errorCode || entry.record.retry.retry_count >= entry.record.retry.max_retries) {
      return false;
    }
    const retryable = entry.record.retry.retryable_error_codes || [];
    return retryable.includes(errorCode);
  }

  private scheduleRetry(entry: LifecycleJobEntry, result: MswarmJobResult): void {
    const retryCount = entry.record.retry.retry_count + 1;
    const nextRetryAt = new Date().toISOString();
    this.transition(entry, "retrying", {
      finished_at: new Date().toISOString(),
      result,
      retry: {
        ...entry.record.retry,
        retry_count: retryCount,
        next_retry_at: nextRetryAt
      }
    });
    this.audit(entry, "job_retry_scheduled", { retry_count: retryCount, next_retry_at: nextRetryAt });
    this.releaseReservation(entry);
    this.transition(entry, "queued", {
      queued_at: nextRetryAt,
      scheduled_at: undefined,
      started_at: undefined,
      finished_at: undefined,
      reservation: undefined,
      envelope: undefined,
      backpressure: undefined
    });
  }

  private recordEvent(entry: LifecycleJobEntry, event: MswarmJobEvent): void {
    entry.events.push(event);
    if (event.type === "stdout" || event.type === "stderr") {
      entry.logs.push({
        job_id: event.job_id,
        sequence: event.sequence,
        timestamp: event.timestamp,
        stream: event.type,
        message: event.message || "",
        truncated: false
      });
    }
    this.audit(entry, "job_event_recorded", { type: event.type, sequence: event.sequence });
  }

  private releaseReservation(entry: LifecycleJobEntry): void {
    if (!entry.record.reservation || entry.record.reservation.released_at) {
      return;
    }
    entry.record.reservation = {
      ...entry.record.reservation,
      released_at: new Date().toISOString()
    };
    this.audit(entry, "reservation_released");
  }

  private setBackpressure(
    entry: LifecycleJobEntry,
    reason: MswarmGenericJobBackpressureReason,
    message: string,
    retryAfterMs?: number
  ): void {
    entry.record.backpressure = {
      reason,
      message,
      ...(retryAfterMs ? { retry_after_ms: retryAfterMs } : {})
    };
    entry.record.updated_at = new Date().toISOString();
  }

  private transition(entry: LifecycleJobEntry, state: MswarmGenericJobRecord["state"], patch: Partial<MswarmGenericJobRecord> = {}): void {
    if (!isMswarmLifecycleStateTransitionAllowed(entry.record.state, state)) {
      throw new Error(`invalid lifecycle transition from ${entry.record.state} to ${state}`);
    }
    entry.record = {
      ...entry.record,
      ...patch,
      state,
      updated_at: new Date().toISOString()
    };
    this.syncRuntimeQueueTelemetry();
  }

  private audit(
    entry: LifecycleJobEntry,
    action: MswarmGenericJobAuditEvent["action"],
    details?: Record<string, unknown>
  ): void {
    entry.audit.push(
      buildMswarmGenericJobAuditEvent({
        auditId: `audit_${randomUUID()}`,
        jobId: entry.record.job_id,
        requestId: entry.record.request_id,
        tenantId: entry.record.tenant_id,
        nodeId: this.config.nodeId,
        action,
        timestamp: new Date().toISOString(),
        details
      })
    );
  }

  private snapshot(entry: LifecycleJobEntry): MswarmGenericJobLifecycleSnapshot {
    return {
      job: entry.record,
      events: [...entry.events],
      logs: [...entry.logs],
      artifacts: [...(entry.record.artifacts || [])],
      audit: [...entry.audit]
    };
  }

  private opsJobSummary(entry: LifecycleJobEntry): GenericJobOpsJobSummary {
    const lastEvent = entry.events[entry.events.length - 1];
    return {
      job_id: entry.record.job_id,
      request_id: entry.record.request_id,
      tenant_id: entry.record.tenant_id,
      node_id: entry.record.node_id,
      state: entry.record.state,
      job_type: entry.record.job.job_type,
      schema_version: entry.record.job.schema_version,
      priority: entry.record.priority,
      created_at: entry.record.created_at,
      updated_at: entry.record.updated_at,
      queued_at: entry.record.queued_at,
      scheduled_at: entry.record.scheduled_at,
      started_at: entry.record.started_at,
      finished_at: entry.record.finished_at,
      retry_count: entry.record.retry.retry_count,
      max_retries: entry.record.retry.max_retries,
      progress_percent: progressPercent(entry.events),
      last_event_type: lastEvent?.type,
      last_event_message: lastEvent?.message,
      artifact_count: (entry.record.artifacts || []).length,
      artifact_bytes: artifactBytes(entry.record),
      log_bytes: logBytes(entry.logs)
    };
  }

  private mustGetEntry(jobId: string): LifecycleJobEntry {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      throw new Error("job_not_found");
    }
    return entry;
  }
}

export function buildSelfHostedNodeApp(runtime: SelfHostedNodeRuntime, config: SelfHostedNodeConfig) {
  const app = Fastify({ logger: false });
  const activeGenericJobs = new Map<string, ActiveGenericJob>();
  const lifecycle = new OwnerLocalGenericJobLifecycleScheduler(runtime, config);

  app.get("/healthz", async (_request, reply) => {
    reply.send({ service: "mswarm-self-hosted-node", status: "ok", node_id: config.nodeId });
  });

  app.get("/v1/swarm/self-hosted/node/capabilities", async (request, reply) => {
    if (!isOwnerLocalNodeApiMode(config)) {
      reply.status(403).send({
        error: "forbidden",
        code: "owner_local_required",
        message: "Node capabilities are only available in owner-local direct mode"
      });
      return;
    }
    if (!config.invocationSigningSecret) {
      reply.status(503).send({
        error: "service_unavailable",
        code: "missing_config",
        message: "MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for capability reads"
      });
      return;
    }
    const token = extractBearerToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: "Missing capability token"
      });
      return;
    }
    let claims: SelfHostedCapabilityTokenClaims;
    try {
      claims = verifySelfHostedCapabilityToken({
        token,
        secret: config.invocationSigningSecret
      });
    } catch (error) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Invalid capability token"
      });
      return;
    }
    if (claims.node_id !== config.nodeId) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: "capability token node_id does not match this node"
      });
      return;
    }
    reply.send(await runtime.publicCapabilityProjection());
  });

  app.post("/v1/swarm/self-hosted/node/jobs", async (request, reply) => {
    if (!config.invocationSigningSecret) {
      reply.status(503).send({
        error: "service_unavailable",
        code: "missing_config",
        message: "MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for direct jobs"
      });
      return;
    }
    const token = extractBearerToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: "Missing invocation token"
      });
      return;
    }
    let claims: SelfHostedInvocationTokenClaims;
    try {
      claims = verifySelfHostedInvocationToken({
        token,
        secret: config.invocationSigningSecret
      });
    } catch (error) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Invalid invocation token"
      });
      return;
    }
    const job = request.body as SelfHostedNodeInvocationJob;
    try {
      assertJobMatchesClaims(job, claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid invocation job"
      });
      return;
    }
    const attachedMswarmApiKey = extractAttachedMswarmApiKey(
      request.headers as Record<string, string | string[] | undefined>,
    );
    if (job.openai_request?.stream === true) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      const keepAlive = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(": keep-alive\n\n");
        }
      }, 15_000);
      try {
        const result = await runtime.executeJob(job, {
          onOpenAIChunk: async (chunk) => {
            writeSelfHostedSseChunk(reply.raw, chunk);
          },
          attachedMswarmApiKey,
        });
        if (result.status !== "success") {
          writeSelfHostedSseChunk(reply.raw, {
            object: "error",
            error: result.error ?? {
              code: "upstream_error",
              message: "Self-hosted job failed"
            }
          });
        }
        writeSelfHostedSseDone(reply.raw);
      } catch (error) {
        writeSelfHostedSseChunk(reply.raw, {
          object: "error",
          error: {
            code: "upstream_error",
            message: error instanceof Error ? error.message : String(error)
          }
        });
        writeSelfHostedSseDone(reply.raw);
      } finally {
        clearInterval(keepAlive);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
      return;
    }
    const result = await runtime.executeJob(job, { attachedMswarmApiKey });
    if (result.status !== "success") {
      reply.status(502).send(result);
      return;
    }
    reply.send(result);
  });

  app.post("/v1/swarm/self-hosted/node/generic-jobs", async (request, reply) => {
    if (!config.genericJobsEnabled) {
      reply.status(404).send({
        error: "not_found",
        code: "feature_disabled",
        message: "Generic node jobs are disabled on this node"
      });
      return;
    }
    if (!isOwnerLocalGenericMode(config)) {
      reply.status(403).send({
        error: "forbidden",
        code: "owner_local_required",
        message: "Generic node jobs are only available in owner-local direct mode"
      });
      return;
    }
    if (!config.invocationSigningSecret) {
      reply.status(503).send({
        error: "service_unavailable",
        code: "missing_config",
        message: "MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for generic jobs"
      });
      return;
    }
    const token = extractBearerToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: "Missing generic job token"
      });
      return;
    }
    let claims: SelfHostedGenericJobTokenClaims;
    try {
      claims = verifySelfHostedGenericJobToken({
        token,
        secret: config.invocationSigningSecret
      });
    } catch (error) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Invalid generic job token"
      });
      return;
    }
    const job = request.body as SelfHostedGenericNodeJob;
    try {
      assertGenericJobMatchesClaims(job, claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid generic job"
      });
      return;
    }
    const wantsEventStream = acceptsGenericEventStream(request.headers as Record<string, string | string[] | undefined>);
    if (activeGenericJobs.has(job.job_id)) {
      reply.status(409).send({
        error: "conflict",
        code: "job_already_running",
        message: "Generic job is already running on this node"
      });
      return;
    }
    const abortController = new AbortController();
    activeGenericJobs.set(job.job_id, { controller: abortController, claims });
    if (wantsEventStream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      const onClose = () => {
        if (!abortController.signal.aborted) {
          abortController.abort("cancelled");
        }
      };
      reply.raw.once("close", onClose);
      const keepAlive = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(": keep-alive\n\n");
        }
      }, 15_000);
      try {
        await runtime.executeGenericJob(job, {
          signal: abortController.signal,
          onEvent: async (event) => {
            writeGenericJobSseEvent(reply.raw, { ...event });
          }
        });
        writeSelfHostedSseDone(reply.raw);
      } catch (error) {
        writeGenericJobSseEvent(reply.raw, {
          job_id: job.job_id,
          type: "failed",
          sequence: 0,
          timestamp: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
          data: { code: "upstream_error" }
        });
        writeSelfHostedSseDone(reply.raw);
      } finally {
        clearInterval(keepAlive);
        reply.raw.removeListener("close", onClose);
        if (activeGenericJobs.get(job.job_id)?.controller === abortController) {
          activeGenericJobs.delete(job.job_id);
        }
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
      return;
    }

    const result = await runtime.executeGenericJob(job, { signal: abortController.signal }).finally(() => {
      if (activeGenericJobs.get(job.job_id)?.controller === abortController) {
        activeGenericJobs.delete(job.job_id);
      }
    });
    if (result.status === "succeeded") {
      reply.send(result);
      return;
    }
    reply.status(genericJobFailureStatusCode(result)).send(result);
  });

  app.post("/v1/swarm/self-hosted/node/generic-jobs/:job_id/cancel", async (request, reply) => {
    if (!config.genericJobsEnabled) {
      reply.status(404).send({
        error: "not_found",
        code: "feature_disabled",
        message: "Generic node jobs are disabled on this node"
      });
      return;
    }
    if (!isOwnerLocalGenericMode(config)) {
      reply.status(403).send({
        error: "forbidden",
        code: "owner_local_required",
        message: "Generic node jobs are only available in owner-local direct mode"
      });
      return;
    }
    if (!config.invocationSigningSecret) {
      reply.status(503).send({
        error: "service_unavailable",
        code: "missing_config",
        message: "MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for generic jobs"
      });
      return;
    }
    const token = extractBearerToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: "Missing generic job token"
      });
      return;
    }
    let claims: SelfHostedGenericJobTokenClaims;
    try {
      claims = verifySelfHostedGenericJobToken({
        token,
        secret: config.invocationSigningSecret
      });
    } catch (error) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Invalid generic job token"
      });
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    if (!jobId) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: "generic job_id is required"
      });
      return;
    }
    if (claims.node_id !== config.nodeId || claims.job_id !== jobId) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: "generic cancellation token does not match this node or job"
      });
      return;
    }
    const activeJob = activeGenericJobs.get(jobId);
    if (!activeJob) {
      reply.status(404).send({
        error: "not_found",
        code: "job_not_running",
        message: "Generic job is not running on this node"
      });
      return;
    }
    if (
      activeJob.claims.request_id !== claims.request_id ||
      activeJob.claims.schema_version !== claims.schema_version ||
      activeJob.claims.job_type !== claims.job_type
    ) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: "generic cancellation token does not match the active request"
      });
      return;
    }
    if (!activeJob.controller.signal.aborted) {
      activeJob.controller.abort("cancelled");
    }
    reply.status(202).send({
      job_id: jobId,
      request_id: activeJob.claims.request_id,
      status: "cancelling"
    });
  });

  app.post("/v1/swarm/self-hosted/node/generic-job-control/jobs", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const job = request.body as SelfHostedGenericNodeJob;
    try {
      assertGenericJobMatchesClaims(job, auth.claims);
      assertLifecycleJobIdMatchesClaims(job.job_id, config, auth.claims);
      const result = lifecycle.create(job, auth.claims, auth.token);
      reply.status(result.reused ? 200 : 202).send(result.snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid generic lifecycle job";
      reply.status(message.includes("conflict") ? 409 : 400).send({
        error: message.includes("conflict") ? "conflict" : "bad_request",
        code: message.includes("conflict") ? message : "validation_failed",
        message
      });
    }
  });

  app.post("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id/artifacts", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
      const upload = decodeArtifactUploadBody(request.body);
      const root = artifactUploadRoot(config, jobId);
      const target = resolveArtifactUploadTarget(config, jobId, upload.path);
      await mkdir(dirname(target), { recursive: true });
      await assertNoArtifactSymlinkSegments(root, upload.path);
      try {
        await lstat(target);
        throw new Error("artifact_upload_target_exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeFile(target, upload.bytes, { mode: 0o600 });
      reply.status(201).send({
        job_id: jobId,
        artifact: {
          id: `upload_${upload.sha256.slice(0, 16)}`,
          uri: buildMswarmLocalArtifactUri(jobId, upload.path),
          name: upload.name,
          content_type: upload.contentType,
          size_bytes: upload.bytes.length,
          sha256: upload.sha256,
          scope: "input",
          access: defaultMswarmArtifactAccessPolicy("owner-local"),
          retention: defaultMswarmArtifactRetentionPolicy()
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid generic lifecycle artifact upload";
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message
      });
    }
  });

  app.get("/v1/swarm/self-hosted/node/generic-job-control/ops", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobOpsRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    reply.send(await lifecycle.ops(opsQueryOptions(request.query)));
  });

  app.get("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid generic lifecycle job token"
      });
      return;
    }
    const snapshot = lifecycle.get(jobId);
    if (!snapshot) {
      reply.status(404).send({
        error: "not_found",
        code: "job_not_found",
        message: "Generic lifecycle job was not found"
      });
      return;
    }
    reply.send(snapshot);
  });

  app.get("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id/events", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid generic lifecycle job token"
      });
      return;
    }
    const snapshot = lifecycle.get(jobId);
    if (!snapshot) {
      reply.status(404).send({
        error: "not_found",
        code: "job_not_found",
        message: "Generic lifecycle job was not found"
      });
      return;
    }
    reply.send({ job_id: jobId, events: snapshot.events });
  });

  app.get("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id/logs", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid generic lifecycle job token"
      });
      return;
    }
    const snapshot = lifecycle.get(jobId);
    if (!snapshot) {
      reply.status(404).send({
        error: "not_found",
        code: "job_not_found",
        message: "Generic lifecycle job was not found"
      });
      return;
    }
    reply.send({ job_id: jobId, logs: snapshot.logs });
  });

  app.get("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id/artifacts", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid generic lifecycle job token"
      });
      return;
    }
    const snapshot = lifecycle.get(jobId);
    if (!snapshot) {
      reply.status(404).send({
        error: "not_found",
        code: "job_not_found",
        message: "Generic lifecycle job was not found"
      });
      return;
    }
    reply.send({ job_id: jobId, artifacts: snapshot.artifacts });
  });

  app.get("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id/audit", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid generic lifecycle job token"
      });
      return;
    }
    const snapshot = lifecycle.get(jobId);
    if (!snapshot) {
      reply.status(404).send({
        error: "not_found",
        code: "job_not_found",
        message: "Generic lifecycle job was not found"
      });
      return;
    }
    reply.send({ job_id: jobId, audit: snapshot.audit });
  });

  app.post("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id/cancel", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
      reply.status(202).send(lifecycle.cancel(jobId, auth.claims));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid generic lifecycle cancellation";
      reply.status(message === "job_not_found" ? 404 : 400).send({
        error: message === "job_not_found" ? "not_found" : "bad_request",
        code: message === "job_not_found" ? "job_not_found" : "validation_failed",
        message: message === "job_not_found" ? "Generic lifecycle job was not found" : message
      });
    }
  });

  app.post("/v1/swarm/self-hosted/node/generic-job-control/jobs/:job_id/retry", async (request, reply) => {
    const auth = verifyOwnerLocalGenericJobRequest(config, request.headers as Record<string, string | string[] | undefined>);
    if (!auth.ok) {
      reply.status(auth.statusCode).send(auth.payload);
      return;
    }
    const jobId = String((request.params as { job_id?: string }).job_id || "").trim();
    try {
      assertLifecycleJobIdMatchesClaims(jobId, config, auth.claims);
      reply.status(202).send(lifecycle.retry(jobId, auth.claims));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid generic lifecycle retry";
      reply.status(message === "job_not_found" ? 404 : 400).send({
        error: message === "job_not_found" ? "not_found" : "bad_request",
        code: message === "job_not_found" ? "job_not_found" : "validation_failed",
        message: message === "job_not_found" ? "Generic lifecycle job was not found" : message
      });
    }
  });

  return app;
}

export async function main(argv = process.argv): Promise<void> {
  const parsed = normalizeMswarmCommand(argv);
  const command = parsed.command;
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (parsed.namespace === "node") {
    await handleNodeCommand(command, parsed.args, argv);
    return;
  }
  if (command === "install") {
    await installNode(parsed.args, argv, { legacyPositionalApiKey: true });
    return;
  }
  if (command === "setup") {
    const setupConfig = await readOwnerSetupConfig(parsed.args);
    const result = await SelfHostedNodeRuntime.setup(setupConfig);
    console.log(`Registered ${result.serverName} as ${result.nodeId}`);
    console.log(`Discovered ${result.modelCount} local mcoda agents.`);
    console.log(
      result.status === "online"
        ? "Node is online. Keep it running with: mswarm node run"
        : "Node registered, but local discovery is degraded. Run: mswarm node doctor"
    );
    if (setupConfig.start) {
      await runNodeForeground();
    }
    return;
  }
  if (command === "doctor") {
    await runNodeDoctor();
    return;
  }
  if (command === "status") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.runOnce();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "once") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.runOnce();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "enroll") {
    const { config, runtime } = await loadNodeRuntime();
    const result = await runtime.ensureEnrolled();
    console.log(JSON.stringify({ enrolled: result.enrolled, state_path: config.statePath }, null, 2));
    return;
  }
  if (command === "models") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "agents") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify({ pushed: result.count, response: result.response }, null, 2));
    return;
  }
  if (command === "daemon" || command === "start") {
    await runNodeForeground(command === "daemon" ? "daemon" : "start");
    return;
  }
  if (command === "serve") {
    await runNodeServerOnly();
    return;
  }
  printUsage();
  throw new Error(`Unknown command: ${command}`);
}

async function installNode(
  args: string[],
  argv: string[],
  options: { legacyPositionalApiKey?: boolean } = {}
): Promise<void> {
  const commandPath = realpathSync(argv[1] || fileURLToPath(import.meta.url));
  const setupArgs = options.legacyPositionalApiKey
    ? buildInstallSetupArgs(args)
    : await buildNodeInstallSetupArgs(args);
  const setupConfig = await readOwnerSetupConfig(setupArgs);
  const result = await SelfHostedNodeRuntime.setup(setupConfig);
  const config = await readSelfHostedNodeConfig();
  const service = await installSelfHostedNodeService(config, {
    commandPath,
    nodePath: process.execPath
  });
  console.log(`Registered ${result.serverName} as ${result.nodeId}`);
  console.log(`Discovered ${result.modelCount} local mcoda agents.`);
  console.log(`Installed ${service.manager} service ${service.serviceName}`);
  console.log(`Service file: ${service.servicePath}`);
  console.log(`Logs: ${service.logPath}`);
  console.log("Node daemon is running in the background.");
}

async function loadNodeRuntime(): Promise<{ config: SelfHostedNodeConfig; runtime: SelfHostedNodeRuntime }> {
  const config = await readSelfHostedNodeConfig();
  const runtime = new SelfHostedNodeRuntime(config);
  return { config, runtime };
}

async function runNodeDoctor(): Promise<void> {
  const { runtime } = await loadNodeRuntime();
  const result = await runtime.doctor();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function runNodeStatus(): Promise<void> {
  const service = await controlSelfHostedNodeService("status");
  let node: Record<string, unknown>;
  try {
    const config = await readSelfHostedNodeConfig();
    node = {
      configured: true,
      node_id: config.nodeId,
      server_name: config.serverName,
      relay_mode: config.relayMode,
      gateway_base_url: config.gatewayBaseUrl,
      client_allowlist: config.clientAllowlist,
      state_path: config.statePath,
      runtime_token_path: config.runtimeTokenPath
    };
  } catch (error) {
    node = { configured: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log(JSON.stringify({ service, node }, null, 2));
}

async function runNodeLogs(args: string[]): Promise<void> {
  const layout = resolveSelfHostedNodeServiceLayout();
  const path = args.includes("--error") ? layout.errorLogPath : layout.logPath;
  const lines = parsePositiveLineCount(args, 200);
  const content = await readFile(path, "utf8");
  console.log(lastLines(content, lines));
}

async function runNodeClientMutation(args: string[], action: "add" | "remove"): Promise<void> {
  const noSync = args.includes("--no-sync");
  const rawClients = args
    .filter((entry) => !entry.startsWith("--"))
    .join(",");
  if (!rawClients) {
    throw new Error(`mswarm node ${action}-client requires at least one client identifier`);
  }
  const clients = normalizeSelfHostedNodeClientAllowlist(rawClients);
  if (clients.length === 0) {
    throw new Error(`mswarm node ${action}-client requires at least one client identifier`);
  }
  const config = await readSelfHostedNodeConfig();
  const currentState = await readSelfHostedNodeState(config.statePath);
  const currentClients = normalizeSelfHostedNodeClientAllowlist(
    currentState.client_allowlist || config.clientAllowlist
  );
  const nextClients =
    action === "add"
      ? addSelfHostedNodeClients(currentClients, clients)
      : removeSelfHostedNodeClients(currentClients, clients);
  await writeSelfHostedNodeState(config.statePath, {
    ...currentState,
    client_allowlist: nextClients,
    updated_at: new Date().toISOString()
  });

  let sync: Record<string, unknown> = { attempted: false };
  if (!noSync) {
    try {
      const nextConfig = await readSelfHostedNodeConfig();
      const result = await new SelfHostedNodeRuntime(nextConfig).runOnce();
      sync = {
        attempted: true,
        status: result.status,
        model_count: result.model_count
      };
    } catch (error) {
      sync = {
        attempted: true,
        error: error instanceof Error ? error.message : String(error)
      };
      process.exitCode = 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        action,
        clients,
        client_allowlist: nextClients,
        state_path: config.statePath,
        sync
      },
      null,
      2
    )
  );
}

async function runNodeUninstall(): Promise<void> {
  const layout = resolveSelfHostedNodeServiceLayout();
  let runtime: SelfHostedNodeRuntime | null = null;
  let configError: string | null = null;
  try {
    runtime = (await loadNodeRuntime()).runtime;
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  const result = await uninstallSelfHostedNodeService();
  let gatewayNotification: Awaited<ReturnType<SelfHostedNodeRuntime["notifyUninstall"]>>;
  if (!runtime) {
    gatewayNotification = {
      notified: false,
      error: configError || "missing node runtime config"
    };
  } else {
    gatewayNotification = await runtime.notifyUninstall({
      reason: "node_uninstall",
      source: "mswarm_node_uninstall",
      serviceManager: layout.manager
    });
  }
  console.log(JSON.stringify({ ...result, gateway_notification: gatewayNotification }, null, 2));
}

async function runNodeForeground(label = "run"): Promise<void> {
  applySelfHostedNodeProcessTitle();
  const { config, runtime } = await loadNodeRuntime();
  if (config.relayMode === "direct") {
    if (!config.invocationSigningSecret) {
      throw new Error("MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for direct start");
    }
    runtime.startDaemon();
    const app = buildSelfHostedNodeApp(runtime, config);
    await app.listen({ host: config.listenHost, port: config.listenPort });
    console.log(`mswarm self-hosted node serving direct jobs for ${config.nodeId} on ${config.listenHost}:${config.listenPort}`);
    return new Promise(() => undefined);
  }
  runtime.startDaemon();
  console.log(`mswarm self-hosted node ${label === "daemon" ? "daemon" : "foreground run"} active for ${config.nodeId}`);
  return new Promise(() => undefined);
}

async function runNodeServerOnly(): Promise<void> {
  applySelfHostedNodeProcessTitle();
  const { config, runtime } = await loadNodeRuntime();
  if (!config.invocationSigningSecret) {
    throw new Error("MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for serve");
  }
  runtime.startDaemon();
  const app = buildSelfHostedNodeApp(runtime, config);
  await app.listen({ host: config.listenHost, port: config.listenPort });
  console.log(`mswarm self-hosted node serving direct jobs for ${config.nodeId} on ${config.listenHost}:${config.listenPort}`);
  return new Promise(() => undefined);
}

async function handleNodeCommand(command: string, args: string[], argv: string[]): Promise<void> {
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "install") {
    await installNode(args, argv);
    return;
  }
  if (command === "start" || command === "stop" || command === "restart") {
    const result = await controlSelfHostedNodeService(command);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "status") {
    await runNodeStatus();
    return;
  }
  if (command === "health" || command === "doctor") {
    await runNodeDoctor();
    return;
  }
  if (command === "logs") {
    await runNodeLogs(args);
    return;
  }
  if (command === "add-client") {
    await runNodeClientMutation(args, "add");
    return;
  }
  if (command === "remove-client" || command === "remove-clint") {
    await runNodeClientMutation(args, "remove");
    return;
  }
  if (command === "uninstall") {
    await runNodeUninstall();
    return;
  }
  if (command === "run" || command === "daemon") {
    await runNodeForeground(command);
    return;
  }
  if (command === "serve") {
    await runNodeServerOnly();
    return;
  }
  if (command === "once") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.runOnce();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "enroll") {
    const { config, runtime } = await loadNodeRuntime();
    const result = await runtime.ensureEnrolled();
    console.log(JSON.stringify({ enrolled: result.enrolled, state_path: config.statePath }, null, 2));
    return;
  }
  if (command === "models") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "agents") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify({ pushed: result.count, response: result.response }, null, 2));
    return;
  }
  printUsage();
  throw new Error(`Unknown node command: ${command}`);
}

export function isSelfHostedNodeDirectRun(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (!argvEntry) {
    return false;
  }
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolve(argvEntry)) === realpathSync(modulePath);
  } catch {
    return resolve(argvEntry) === modulePath;
  }
}

const isDirectRun = isSelfHostedNodeDirectRun(process.argv[1], import.meta.url);

if (isDirectRun) {
  void main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
