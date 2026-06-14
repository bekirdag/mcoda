export const MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION = "2026-06-14";
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
];
export const MSWARM_GENERIC_JOB_TERMINAL_LIFECYCLE_STATES = [
    "succeeded",
    "failed",
    "cancelled",
    "expired",
    "blocked",
];
const TERMINAL_LIFECYCLE_STATE_SET = new Set(MSWARM_GENERIC_JOB_TERMINAL_LIFECYCLE_STATES);
const ALLOWED_LIFECYCLE_TRANSITIONS = {
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
export function isMswarmTerminalLifecycleState(state) {
    return TERMINAL_LIFECYCLE_STATE_SET.has(state);
}
export function isMswarmLifecycleStateTransitionAllowed(from, to) {
    return from === to || ALLOWED_LIFECYCLE_TRANSITIONS[from].includes(to);
}
export function buildMswarmGenericJobEnvelopeDescriptor(input) {
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
export function buildMswarmGenericJobAuditEvent(input) {
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
export function normalizeMswarmGenericJobIdempotencyKey(input) {
    const key = input.idempotencyKey || input.jobId || input.requestId || "";
    return `${input.tenantId}:${key}`.trim();
}
