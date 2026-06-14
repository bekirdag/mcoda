# mswarm Owner-Local GPU Job Operations Runbook

Date: 2026-06-14

This runbook covers the owner-local generic GPU job plane added for `mswarm`
nodes. It is for trusted operators running local/self-hosted GPU nodes; it is
not a production billing or public multi-tenant control-plane procedure.

## Scope

- Inspect local GPU node inventory and generic job queue state.
- Read operational usage counters, quota/concurrency state, and audit events.
- Cancel active jobs and retry terminal non-succeeded jobs.
- Troubleshoot owner-local Blender/CUDA/package job execution without exposing
  signing secrets to browsers or untrusted tenants.

## Safety Model

- Ops reads use the `self_hosted.generic_job.ops.read` scope.
- Job mutations use the existing `self_hosted.generic_job.invoke` job-scoped
  token and must include the matching `job_id`, `request_id`, `schema_version`,
  `job_type`, and `node_id`.
- Local usage counters are operational accounting only. Do not treat
  `usage.gpu_seconds`, artifact bytes, log bytes, or audit counts as
  billing-grade data until a production control plane owns durable persistence,
  reconciliation, tenant ownership, and invoices.
- The Laravel and Node setup UIs must call trusted backend routes. Do not put
  `MCODA_GPU_JOB_SIGNING_SECRET`, prebuilt generic job tokens, or ops tokens in
  browser code.

## Required Node Configuration

Set these on the owner-local self-hosted node:

```bash
MSWARM_SELF_HOSTED_NODE_ID=shn_local
MSWARM_SELF_HOSTED_GENERIC_JOBS_ENABLED=1
MSWARM_SELF_HOSTED_OWNER_LOCAL_GENERIC_JOBS=1
MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET=...
MSWARM_SELF_HOSTED_GENERIC_JOB_ARTIFACT_STORE=/path/to/artifacts
```

Optional limits:

```bash
MSWARM_SELF_HOSTED_GENERIC_JOB_MAX_CONCURRENCY=1
MSWARM_SELF_HOSTED_GENERIC_JOB_TIMEOUT_MS=300000
```

## Read Operations

HTTP endpoint:

```text
GET /v1/swarm/self-hosted/node/generic-job-control/ops?audit_limit=25&audit_offset=0
Authorization: Bearer <ops-token>
```

The response includes:

- `node`: node id, owner-local status, generic job enablement, artifact-store
  status, and max concurrency.
- `capabilities`: public node capability projection, including job types and
  GPU/software availability tiers.
- `queue`: job rows, totals by state, active/queued/terminal counts.
- `quota`: local concurrency availability and operational limits.
- `usage`: local counters such as total jobs, terminal counts, GPU seconds,
  artifact bytes, and log bytes.
- `audit`: paginated lifecycle audit events.

CLI:

```bash
mcoda gpu ops \
  --node-base-url http://127.0.0.1:18488 \
  --node-id shn_local \
  --signing-secret "$MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET" \
  --audit-limit 25
```

Use `--json` for machine-readable output.

Node SDK:

```ts
const client = await createMcodaGpuJobClient({
  nodeBaseUrl: "http://127.0.0.1:18488",
  nodeId: "shn_local",
  signingSecret: process.env.MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET,
});

const ops = await client.ops({ auditLimit: 25, auditOffset: 0 });
```

Laravel:

```php
$ops = app(\Mcoda\LaravelAgentSetup\Contracts\GpuJobClient::class)->ops([
    'auditLimit' => 25,
    'auditOffset' => 0,
]);
```

Configure:

```dotenv
MCODA_GPU_JOB_NODE_BASE_URL=http://127.0.0.1:18488
MCODA_GPU_JOB_NODE_ID=shn_local
MCODA_GPU_JOB_SIGNING_SECRET=...
# Optional prebuilt read-only token:
MCODA_GPU_JOB_OPS_TOKEN=...
```

## Mutations

Cancel active/non-terminal jobs:

```bash
mcoda job cancel \
  --node-base-url http://127.0.0.1:18488 \
  --node-id shn_local \
  --signing-secret "$MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET" \
  --job-id job-123 \
  --request-id req-123 \
  --schema-version 2026-06-14 \
  --job-type cuda.run
```

Retry terminal non-succeeded jobs:

```bash
mcoda job retry \
  --node-base-url http://127.0.0.1:18488 \
  --node-id shn_local \
  --signing-secret "$MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET" \
  --job-id job-123 \
  --request-id req-123 \
  --schema-version 2026-06-14 \
  --job-type cuda.run
```

Retry clears the previous result/envelope/artifact links for that lifecycle
record, increments `retry_count`, and re-enters the local queue. It does not
retry succeeded jobs.

## UI Surfaces

The `@mcoda/agent-setup/react` page accepts optional GPU ops props:

```tsx
<McodaAgentSetupPage
  client={setupClient}
  gpuJobOps={ops}
  onGpuJobOpsRefresh={refreshOps}
  onGpuJobViewDetails={(job) => gpuClient.status({
    jobId: job.job_id,
    requestId: job.request_id,
    schemaVersion: job.schema_version,
    jobType: job.job_type,
  })}
  onGpuJobViewLogs={(job) => gpuClient.logs({
    jobId: job.job_id,
    requestId: job.request_id,
    schemaVersion: job.schema_version,
    jobType: job.job_type,
  })}
  onGpuJobViewArtifacts={(job) => gpuClient.artifacts({
    jobId: job.job_id,
    requestId: job.request_id,
    schemaVersion: job.schema_version,
    jobType: job.job_type,
  })}
  onGpuJobRetry={(job) => gpuClient.retry({
    jobId: job.job_id,
    requestId: job.request_id,
    schemaVersion: job.schema_version,
    jobType: job.job_type,
  })}
  onGpuJobCancel={(job) => gpuClient.cancel({
    jobId: job.job_id,
    requestId: job.request_id,
    schemaVersion: job.schema_version,
    jobType: job.job_type,
  })}
/>
```

The Laravel Blade setup page includes an owner-local GPU jobs panel backed by
Laravel routes:

- `GET /mcoda-agent-setup/api/gpu-jobs/ops`
- `GET /mcoda-agent-setup/api/gpu-jobs/{job}`
- `GET /mcoda-agent-setup/api/gpu-jobs/{job}/logs`
- `GET /mcoda-agent-setup/api/gpu-jobs/{job}/events`
- `GET /mcoda-agent-setup/api/gpu-jobs/{job}/artifacts`
- `POST /mcoda-agent-setup/api/gpu-jobs/{job}/cancel`
- `POST /mcoda-agent-setup/api/gpu-jobs/{job}/retry`

Protect these routes with the same admin middleware as the setup UI.

## Troubleshooting

- `401 missing_authorization`: the request has no bearer token.
- `401 invalid_generic_job_ops_token`: use an ops token for reads; generic job
  invoke tokens are rejected by the ops endpoint.
- `403 node_mismatch`: the token `node_id` does not match the node process.
- `generic_jobs_disabled`: enable generic jobs and owner-local generic mode.
- `artifact_store_not_configured`: configure the artifact store before using
  artifact upload or jobs that produce artifacts.
- `job_not_found`: the lifecycle scheduler only knows jobs submitted to this
  local process; restart clears in-memory lifecycle state in the current MVP.
- `job_retry_not_allowed`: only terminal non-succeeded jobs can be retried.
- `unsupported_job_type` or `no_capable_node`: inspect `mcoda gpu ops --json`
  and verify Blender, Docker NVIDIA, CUDA, and runner catalog availability.

## Operational Checks

Before declaring a node ready:

```bash
mcoda gpu list --node-base-url http://127.0.0.1:18488 --node-id shn_local --signing-secret "$MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET"
mcoda gpu ops --node-base-url http://127.0.0.1:18488 --node-id shn_local --signing-secret "$MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET" --json
```

Confirm:

- `node.generic_jobs_enabled` is true.
- `queue.active_jobs` is within `quota.max_concurrent_jobs`.
- `quota.production_enforced` is false, so counters are not billing-grade.
- `capabilities.job_types` includes the intended workload type.
- Audit events do not contain bearer tokens or signing secrets.
