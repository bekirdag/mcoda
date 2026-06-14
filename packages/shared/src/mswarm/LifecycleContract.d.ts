import type { MswarmArtifactRef, MswarmGenericJobValidationIssue, MswarmJobEvent, MswarmJobRequest, MswarmJobResult, MswarmJobType } from "./GenericJobContract.js";
export declare const MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION: "2026-06-14";
export declare const MSWARM_GENERIC_JOB_LIFECYCLE_STATES: readonly ["queued", "scheduled", "running", "retrying", "succeeded", "failed", "cancelled", "expired", "blocked"];
export type MswarmGenericJobLifecycleState = (typeof MSWARM_GENERIC_JOB_LIFECYCLE_STATES)[number];
export declare const MSWARM_GENERIC_JOB_TERMINAL_LIFECYCLE_STATES: readonly ["succeeded", "failed", "cancelled", "expired", "blocked"];
export type MswarmGenericJobTerminalLifecycleState = (typeof MSWARM_GENERIC_JOB_TERMINAL_LIFECYCLE_STATES)[number];
export type MswarmGenericJobBackpressureReason = "no_capable_node" | "node_at_capacity" | "tenant_reserved" | "policy_recheck_failed" | "capability_recheck_failed";
export type MswarmGenericJobAuditAction = "job_created" | "job_idempotent_reused" | "job_queued" | "job_scheduled" | "job_started" | "job_event_recorded" | "job_completed" | "job_cancel_requested" | "job_cancelled" | "job_retry_scheduled" | "job_blocked" | "reservation_created" | "reservation_released" | "envelope_issued";
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
export declare function isMswarmTerminalLifecycleState(state: MswarmGenericJobLifecycleState): state is MswarmGenericJobTerminalLifecycleState;
export declare function isMswarmLifecycleStateTransitionAllowed(from: MswarmGenericJobLifecycleState, to: MswarmGenericJobLifecycleState): boolean;
export declare function buildMswarmGenericJobEnvelopeDescriptor(input: {
    jobId: string;
    requestId: string;
    nodeId: string;
    job: MswarmJobRequest;
    issuedAt: string;
    expiresAt: string;
    tokenSha256?: string;
}): MswarmGenericJobEnvelopeDescriptor;
export declare function buildMswarmGenericJobAuditEvent(input: {
    auditId: string;
    jobId: string;
    requestId?: string;
    tenantId?: string;
    nodeId?: string;
    action: MswarmGenericJobAuditAction;
    timestamp: string;
    details?: Record<string, unknown>;
}): MswarmGenericJobAuditEvent;
export declare function normalizeMswarmGenericJobIdempotencyKey(input: {
    tenantId: string;
    idempotencyKey?: string;
    jobId?: string;
    requestId?: string;
}): string;
//# sourceMappingURL=LifecycleContract.d.ts.map