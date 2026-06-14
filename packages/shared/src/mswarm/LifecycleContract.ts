import type {
  MswarmArtifactRef,
  MswarmGenericJobValidationIssue,
  MswarmJobEvent,
  MswarmJobRequest,
  MswarmJobResult,
  MswarmJobType,
} from "./GenericJobContract.js";

export const MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION = "2026-06-14" as const;

export const MSWARM_GENERIC_JOB_LIFECYCLE_STATES = [
  "queued",
  "scheduled",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "blocked",
] as const;

export type MswarmGenericJobLifecycleState = (typeof MSWARM_GENERIC_JOB_LIFECYCLE_STATES)[number];

export const MSWARM_GENERIC_JOB_TERMINAL_LIFECYCLE_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "blocked",
] as const satisfies readonly MswarmGenericJobLifecycleState[];

export type MswarmGenericJobTerminalLifecycleState =
  (typeof MSWARM_GENERIC_JOB_TERMINAL_LIFECYCLE_STATES)[number];

export type MswarmGenericJobBackpressureReason =
  | "no_capable_node"
  | "node_at_capacity"
  | "tenant_reserved"
  | "policy_recheck_failed"
  | "capability_recheck_failed";

export type MswarmGenericJobAuditAction =
  | "job_created"
  | "job_idempotent_reused"
  | "job_queued"
  | "job_scheduled"
  | "job_started"
  | "job_event_recorded"
  | "job_completed"
  | "job_cancel_requested"
  | "job_cancelled"
  | "job_retry_scheduled"
  | "job_blocked"
  | "reservation_created"
  | "reservation_released"
  | "envelope_issued";

export interface MswarmGenericJobRetryPolicy {
  max_retries: number;
  retry_count: number;
  retryable_error_codes?: string[];
  next_retry_at?: string;
}

export interface MswarmGenericJobBackpressure {
  reason: MswarmGenericJobBackpressureReason;
  message: string;
  retry_after_ms?: number;
}

export interface MswarmGenericJobReservation {
  node_id: string;
  tenant_id: string;
  job_id: string;
  request_id: string;
  reserved_at: string;
  released_at?: string;
  resources?: {
    gpu_count?: number;
    cpu_cores?: number;
    memory_gb?: number;
    disk_gb?: number;
  };
}

export interface MswarmGenericJobEnvelopeDescriptor {
  schema_version: typeof MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION;
  job_id: string;
  request_id: string;
  node_id: string;
  job_type: MswarmJobType;
  job_schema_version: MswarmJobRequest["schema_version"];
  scope: "self_hosted.generic_job.invoke";
  issued_at: string;
  expires_at: string;
  token_sha256?: string;
}

export interface MswarmGenericJobRecord {
  schema_version: typeof MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION;
  job_id: string;
  request_id: string;
  tenant_id: string;
  node_id?: string;
  state: MswarmGenericJobLifecycleState;
  job: MswarmJobRequest;
  idempotency_key?: string;
  created_at: string;
  updated_at: string;
  queued_at?: string;
  scheduled_at?: string;
  started_at?: string;
  finished_at?: string;
  retry: MswarmGenericJobRetryPolicy;
  reservation?: MswarmGenericJobReservation;
  backpressure?: MswarmGenericJobBackpressure;
  envelope?: MswarmGenericJobEnvelopeDescriptor;
  validation_issues?: MswarmGenericJobValidationIssue[];
  result?: MswarmJobResult;
  artifacts?: MswarmArtifactRef[];
}

export interface MswarmGenericJobLogRecord {
  job_id: string;
  sequence: number;
  timestamp: string;
  stream: "stdout" | "stderr";
  message: string;
  truncated?: boolean;
}

export interface MswarmGenericJobAuditEvent {
  schema_version: typeof MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION;
  audit_id: string;
  job_id: string;
  request_id?: string;
  tenant_id?: string;
  node_id?: string;
  action: MswarmGenericJobAuditAction;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface MswarmGenericJobLifecycleSnapshot {
  job: MswarmGenericJobRecord;
  events: MswarmJobEvent[];
  logs: MswarmGenericJobLogRecord[];
  artifacts: MswarmArtifactRef[];
  audit: MswarmGenericJobAuditEvent[];
}

const TERMINAL_LIFECYCLE_STATE_SET = new Set<string>(MSWARM_GENERIC_JOB_TERMINAL_LIFECYCLE_STATES);

const ALLOWED_LIFECYCLE_TRANSITIONS: Record<MswarmGenericJobLifecycleState, readonly MswarmGenericJobLifecycleState[]> = {
  queued: ["scheduled", "cancelled", "expired", "blocked"],
  scheduled: ["running", "queued", "cancelled", "expired", "blocked"],
  running: ["succeeded", "failed", "cancelled", "retrying", "expired"],
  retrying: ["queued", "cancelled", "expired", "blocked"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
  blocked: [],
};

export function isMswarmTerminalLifecycleState(
  state: MswarmGenericJobLifecycleState
): state is MswarmGenericJobTerminalLifecycleState {
  return TERMINAL_LIFECYCLE_STATE_SET.has(state);
}

export function isMswarmLifecycleStateTransitionAllowed(
  from: MswarmGenericJobLifecycleState,
  to: MswarmGenericJobLifecycleState
): boolean {
  return from === to || ALLOWED_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function buildMswarmGenericJobEnvelopeDescriptor(input: {
  jobId: string;
  requestId: string;
  nodeId: string;
  job: MswarmJobRequest;
  issuedAt: string;
  expiresAt: string;
  tokenSha256?: string;
}): MswarmGenericJobEnvelopeDescriptor {
  return {
    schema_version: MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION,
    job_id: input.jobId,
    request_id: input.requestId,
    node_id: input.nodeId,
    job_type: input.job.job_type,
    job_schema_version: input.job.schema_version,
    scope: "self_hosted.generic_job.invoke",
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    ...(input.tokenSha256 ? { token_sha256: input.tokenSha256 } : {}),
  };
}

export function buildMswarmGenericJobAuditEvent(input: {
  auditId: string;
  jobId: string;
  requestId?: string;
  tenantId?: string;
  nodeId?: string;
  action: MswarmGenericJobAuditAction;
  timestamp: string;
  details?: Record<string, unknown>;
}): MswarmGenericJobAuditEvent {
  return {
    schema_version: MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION,
    audit_id: input.auditId,
    job_id: input.jobId,
    ...(input.requestId ? { request_id: input.requestId } : {}),
    ...(input.tenantId ? { tenant_id: input.tenantId } : {}),
    ...(input.nodeId ? { node_id: input.nodeId } : {}),
    action: input.action,
    timestamp: input.timestamp,
    ...(input.details ? { details: input.details } : {}),
  };
}

export function normalizeMswarmGenericJobIdempotencyKey(input: {
  tenantId: string;
  idempotencyKey?: string;
  jobId?: string;
  requestId?: string;
}): string {
  const key = input.idempotencyKey || input.jobId || input.requestId || "";
  return `${input.tenantId}:${key}`.trim();
}
