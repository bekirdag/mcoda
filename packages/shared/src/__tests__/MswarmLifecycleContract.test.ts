import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION,
  buildMswarmGenericJobAuditEvent,
  buildMswarmGenericJobEnvelopeDescriptor,
  isMswarmLifecycleStateTransitionAllowed,
  isMswarmTerminalLifecycleState,
  normalizeMswarmGenericJobIdempotencyKey,
  type MswarmGenericJobRecord,
} from "../mswarm/LifecycleContract.js";

const genericJob = {
  schema_version: "2026-06-14" as const,
  job_type: "tenant.test-echo" as const,
  args: { message: "hello" },
  policy: {
    trust_mode: "owner-local" as const,
    network: "none" as const,
    allow_raw_command: false as const,
  },
  limits: {
    timeout_sec: 1,
  },
};

describe("MswarmLifecycleContract", () => {
  it("defines explicit lifecycle terminal states and transitions", () => {
    assert.equal(isMswarmTerminalLifecycleState("succeeded"), true);
    assert.equal(isMswarmTerminalLifecycleState("running"), false);
    assert.equal(isMswarmLifecycleStateTransitionAllowed("queued", "scheduled"), true);
    assert.equal(isMswarmLifecycleStateTransitionAllowed("scheduled", "running"), true);
    assert.equal(isMswarmLifecycleStateTransitionAllowed("running", "retrying"), true);
    assert.equal(isMswarmLifecycleStateTransitionAllowed("retrying", "queued"), true);
    assert.equal(isMswarmLifecycleStateTransitionAllowed("succeeded", "running"), false);
    assert.equal(isMswarmLifecycleStateTransitionAllowed("cancelled", "queued"), false);
  });

  it("models a job record with retry, reservation, backpressure, result, and artifacts", () => {
    const record: MswarmGenericJobRecord = {
      schema_version: MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION,
      job_id: "job_1",
      request_id: "req_1",
      tenant_id: "owner-local",
      node_id: "shn_1",
      state: "queued",
      job: genericJob,
      idempotency_key: "idem_1",
      priority: 0,
      created_at: "2026-06-14T00:00:00.000Z",
      updated_at: "2026-06-14T00:00:00.000Z",
      queued_at: "2026-06-14T00:00:00.000Z",
      retry: {
        max_retries: 1,
        retry_count: 0,
        retryable_error_codes: ["timeout"],
      },
      reservation: {
        node_id: "shn_1",
        tenant_id: "owner-local",
        job_id: "job_1",
        request_id: "req_1",
        reserved_at: "2026-06-14T00:00:01.000Z",
        resources: {
          gpu_count: 1,
        },
      },
      backpressure: {
        reason: "node_at_capacity",
        message: "Node is at generic job concurrency limit.",
        retry_after_ms: 1000,
      },
      result: {
        job_id: "job_1",
        status: "queued",
      },
      artifacts: [
        {
          uri: "artifact://local/job_1/out.txt",
          scope: "output",
        },
      ],
    };

    assert.equal(record.schema_version, "2026-06-14");
    assert.equal(record.retry.max_retries, 1);
    assert.equal(record.reservation?.resources?.gpu_count, 1);
    assert.equal(record.backpressure?.reason, "node_at_capacity");
    assert.equal(record.artifacts?.[0]?.scope, "output");
  });

  it("builds signed envelope descriptors without storing raw token material", () => {
    const envelope = buildMswarmGenericJobEnvelopeDescriptor({
      jobId: "job_1",
      requestId: "req_1",
      nodeId: "shn_1",
      job: genericJob,
      issuedAt: "2026-06-14T00:00:00.000Z",
      expiresAt: "2026-06-14T00:05:00.000Z",
      tokenSha256: "a".repeat(64),
    });

    assert.equal(envelope.scope, "self_hosted.generic_job.invoke");
    assert.equal(envelope.job_type, "tenant.test-echo");
    assert.equal(envelope.job_schema_version, "2026-06-14");
    assert.equal(envelope.token_sha256, "a".repeat(64));
    assert.ok(!JSON.stringify(envelope).includes("Bearer"));
  });

  it("normalizes idempotency keys by tenant scope", () => {
    assert.equal(
      normalizeMswarmGenericJobIdempotencyKey({
        tenantId: "tenant_a",
        idempotencyKey: "same-request",
      }),
      "tenant_a:same-request"
    );
    assert.equal(
      normalizeMswarmGenericJobIdempotencyKey({
        tenantId: "tenant_b",
        idempotencyKey: "same-request",
      }),
      "tenant_b:same-request"
    );
  });

  it("builds audit events with stable schema and action names", () => {
    const audit = buildMswarmGenericJobAuditEvent({
      auditId: "audit_1",
      jobId: "job_1",
      requestId: "req_1",
      tenantId: "owner-local",
      nodeId: "shn_1",
      action: "job_scheduled",
      timestamp: "2026-06-14T00:00:00.000Z",
      details: {
        reason: "capability_match",
      },
    });

    assert.equal(audit.schema_version, MSWARM_JOB_LIFECYCLE_SCHEMA_VERSION);
    assert.equal(audit.action, "job_scheduled");
    assert.equal(audit.details?.reason, "capability_match");
  });
});
