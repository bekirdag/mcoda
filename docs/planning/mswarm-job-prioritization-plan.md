# mswarm Job Prioritization Plan

Date: 2026-07-07

## Goal

mswarm jobs are submitted by different products and tools, including OKACAM, Docdex local delegation, The Neural Ledger, BDYA, Codali, and legacy callers. The mswarm node must be able to squeeze higher-priority jobs into the queue so they finish sooner without breaking legacy job submissions.

Priority is a signed integer. Lower numbers are more important and dispatch earlier.

## Priority Mapping

| Source | Priority |
| --- | ---: |
| The Neural Ledger (TNL) | -3 |
| Docdex local delegation | -2 |
| OKACAM | -1 |
| Missing or legacy priority | 0 |
| BDYA | 3 |

The initial implementation must treat a missing priority as `0` for backward compatibility.

## Current State

The owner-local lifecycle queue lives in `packages/mswarm/src/server.ts` in `OwnerLocalGenericJobLifecycleScheduler`.

Current dispatch behavior:

1. Jobs are stored as lifecycle records with `state = "queued"`.
2. `dispatchQueued()` loops while generic job concurrency has capacity.
3. `nextDispatchableEntry()` sorts queued jobs by `created_at`, so the queue is FIFO.
4. Tenant reservation can block jobs from another tenant while one tenant has an active reservation.

The shared generic job request contract in `packages/shared/src/mswarm/GenericJobContract.ts` has no first-class scheduling or priority field. Unknown top-level request keys are rejected, while `metadata` is allowed and currently used for fields such as `tenant_id` and `retry`.

## Contract

Add a first-class `scheduling` block to `MswarmJobRequest`.

```ts
scheduling?: {
  priority?: number;
  deadline_at?: string;
  fairness_key?: string;
  reason_code?: string;
  preemptible?: boolean;
}
```

Rules:

1. `priority` must be an integer in a bounded range. The recommended initial range is `-100` to `100`.
2. Smaller priority values dispatch earlier.
3. Missing `scheduling.priority` is normalized to `0`.
4. `deadline_at`, `fairness_key`, `reason_code`, and `preemptible` are optional future-ready fields.
5. Scheduling must be top-level contract data, not arbitrary metadata, because it changes runtime behavior.

## Scheduler Behavior

Replace FIFO dispatch with priority-aware dispatch:

1. Sort queued jobs by effective priority ascending.
2. Break ties by `queued_at` or `created_at` ascending.
3. Keep legacy FIFO behavior for jobs with the same priority.
4. Record priority in lifecycle snapshots, ops summaries, and audit details.

The first implementation should not preempt a running job. Priority affects queued work only. Preemption should wait until jobs are checkpointable or explicitly `preemptible`.

## Fairness

Priority must not create permanent starvation.

Initial fairness controls:

1. Preserve tie-breaking by age.
2. Keep missing priority at `0`.
3. Expose queued priority values in ops so unfair queue behavior is visible.
4. Revisit tenant reservation after priority dispatch is live. The current reservation model can still block higher-priority jobs across tenants.

Future fairness controls:

1. Add aging boost for long-waiting low-priority jobs.
2. Add per-tenant or per-product weighted queues.
3. Add exclusive-resource reservations only for jobs that need the whole node or GPU.

## Authorization

Submitters may request a priority, but mswarm should eventually normalize effective priority server-side from trusted product or API-key policy.

Initial implementation:

1. Accept signed integer priority from the job payload.
2. Preserve it in lifecycle records and audits.
3. Keep deployment-specific submitter defaults in each product/tool integration.

Follow-up hardening:

1. Store requested versus effective priority.
2. Enforce max/min allowed priority per API key, tenant, product, or job type.
3. Include effective priority or a scheduling policy id in signed job tokens.
4. Audit any downgrade or rejection.

## Product Defaults

Each submitter should set `job.scheduling.priority` when constructing an mswarm job:

1. TNL: `-3`
2. Docdex local delegation: `-2`
3. OKACAM: `-1`
4. BDYA: `3`
5. Codali and any unknown legacy caller: omit priority or use `0`

## Implementation Order

1. Add this plan and progress tracking docs.
2. Add `MswarmJobScheduling` to the shared generic job contract.
3. Validate `scheduling.priority` and reject invalid scheduling fields.
4. Add scheduling fields to lifecycle records and ops job summaries.
5. Change `nextDispatchableEntry()` to sort by priority ascending, then queue time.
6. Add tests for priority ordering and legacy default priority.
7. Update SDK/CLI output where job summaries are displayed.
8. Update product integrations to set their default priorities.
9. Validate, publish packages, and deploy/restart nodes only after tests pass.

## Validation

Minimum validation before publishing/deploying:

1. Shared contract tests cover valid priority, invalid non-integer priority, and legacy missing priority.
2. mswarm runtime tests prove a newer priority `-2` job dispatches before an older priority `0` job.
3. Tests prove equal-priority jobs remain FIFO.
4. Ops summaries expose priority.
5. Existing generic job lifecycle tests still pass.
6. Dependent repos build after package updates.

## Deployment Notes

Publishing/deployment affects several surfaces:

1. `mcoda`, `mswarm`, `codali`, and related npm packages in this workspace.
2. Docdex local delegation defaults.
3. OKACAM mswarm job submission defaults.
4. TNL job submission defaults.
5. BDYA on the sukunahikona box under `~/apps/bdya`.
6. The sukunahikona mswarm node runtime must be updated/restarted so it accepts and obeys `scheduling.priority`.

Do not publish or deploy if validation fails or required credentials/remote access are unavailable.
