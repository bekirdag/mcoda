# Codali Unified Data, Storage, And Auto-Improvement Build Plan

## Goal

Build one production-ready Codali improvement system by merging these source plans:

- `docs/planning/codali-agentic-orchestration-gateway-data-collection-build-guide.md`
- `/Users/bekirdag/Documents/apps/codali-storage-service/docs/planning/codali-storage-service-build-guide.md`
- `docs/planning/codali-auto-improvement-release-build-guide.md`

The merged product is an agentic orchestration gateway quality loop:

```text
Codali/mswarm runtime
  -> gateway traces, model calls, tool calls, Docdex retrieval, evidence, context packs, artifacts
  -> dataset-grade collector and privacy gate
  -> codali-storage-service operational and dataset stores
  -> explicit exports, replay fixtures, labels, feedback, model comparisons
  -> improvement candidates for prompts, schemas, tools, retrieval, routing, evals, and worker fine-tunes
  -> scorecards, security gates, release planning, CI/CD publish, canary monitoring
  -> release outcomes written back to storage
```

This guide supersedes the three split guides for implementation ordering. The split guides remain useful as detail references, but this document is the unified build order and conflict-resolution source.

## Conflict And Misalignment Audit

### 1. Codali Local Store Versus Storage Service Source Of Truth

Misalignment:

- The data-collection guide starts with a pluggable `GatewayDatasetStore` in `@mcoda/codali`, including in-memory and JSONL/reference-file implementations.
- The storage-service guide says `codali-storage-service` is the durable operational and dataset source of truth.

Resolution:

- Keep Codali's local `GatewayDatasetStore` as a port and developer/test adapter.
- In production, Codali writes to `codali-storage-service`; the service is the durable source of truth.
- In-memory and JSONL stores are for unit tests, local dry-runs, offline fixtures, and fallback diagnostics only.
- Storage-service exports and manifests are the only allowed input to auto-improvement release candidates.

### 2. Missing Improvement Endpoints In Storage Service Plan

Misalignment:

- The auto-improvement guide needs `/v1/improvement/*` read/write APIs.
- The storage-service guide defines gateway, dataset, admin, upload, and export APIs but not improvement-run APIs.

Resolution:

- Add product-neutral improvement endpoints to `codali-storage-service`.
- Store improvement tables inside the existing `codali_dataset` schema, not a new third schema, to preserve the storage plan's two-schema model.
- Add tables:
  - `improvement_runs`
  - `improvement_candidates`
  - `improvement_eval_runs`
  - `improvement_releases`
  - `improvement_release_outcomes`
  - `improvement_audit_events`

### 3. Collection Defaults Versus Upload Defaults

Misalignment:

- The data-collection guide says collect minimal analytics-safe run summaries by default.
- The storage-service guide says default mode is `local_only` and upload disabled.

Resolution:

- Default collection is local-only and non-blocking.
- Default collection may store minimal run summaries, rejection counters, policy events, and security counters.
- Model inputs, outputs, tool payloads, context packs, artifacts, and training-eligible records are collected only when dataset policy allows.
- Remote upload is disabled unless `CODALI_STORAGE_UPLOAD_ENABLED=true` and every row is redacted, eligible, scoped, and audited.

### 4. Auto-Build Versus Auto-Publish

Misalignment:

- The auto-improvement guide says the system automatically improves and can publish releases.
- The data and storage guides are conservative about production rollout and release gates.

Resolution:

- Auto-build means automatic candidate generation and scoring.
- Default release mode is `branch_only`.
- Auto-tag and stable npm publish are allowed only after hard gates pass and deployment policy explicitly enables:
  - `CODALI_IMPROVEMENT_AUTO_TAG=true`
  - `CODALI_IMPROVEMENT_AUTO_PUBLISH=true`
- Npm publish must reuse the existing mcoda tag-triggered GitHub Actions workflow. Do not add a second npm publishing path.

### 5. Fine-Tuning Scope

Alignment:

- All plans agree that final-answer data can be collected, but the final synthesizer must not be fine-tuned first.

Resolution:

- First fine-tune or adapter targets are:
  1. extractor
  2. tool router or tool worker
  3. planner
  4. verifier
  5. Docdex query expander
  6. JSON repair model
  7. context refiner
- Final user-visible OKACAM answers continue to use the configured final or large model when available.

### 6. Product-Specific Language

Misalignment:

- The source plans mention OKACAM because it is the first client.

Resolution:

- Core Codali, mswarm, storage, export, and improvement contracts are product-neutral.
- OKACAM-specific notes are adapter requirements, not core logic.
- No hardcoded OKACAM, Suku, integration, model, tenant, or tool names are allowed.

### 7. Node Runtime Version

Misalignment:

- The storage-service guide targets a Node 24-compatible TypeScript service.
- The mcoda repo currently uses Node >=20 and GitHub Actions Node 20.

Resolution:

- Build `codali-storage-service` as Node >=20 compatible first, matching the current mcoda release workflow.
- Keep the service Node 24-compatible where practical, but do not require Node 24 until CI and deployment have been upgraded.

### 8. Future CLI Validation Commands

Misalignment:

- Some validation matrices reference future commands such as `codali dataset export` and `codali improve eval`.

Resolution:

- Treat future commands as phase acceptance targets.
- Before a command exists, validate with unit tests and dry-run fixtures.
- After a command is implemented, add it to the release gate for every subsequent phase.

## Unified Source Of Truth

1. Runtime truth: Codali/mswarm gateway traces and response metadata.
2. Operational truth: `codali-storage-service` tables under `codali_gateway`.
3. Dataset eligibility truth: `codali-storage-service` tables under `codali_dataset`.
4. Object truth: storage-service object refs for large prompts, outputs, tools, context packs, artifacts, images, replay fixtures, and exports.
5. Improvement truth: `codali_dataset.improvement_*` records in storage service.
6. Release truth: mcoda git commit, `v*` tag, GitHub Actions release workflow, npm registry verification, and storage-service release outcome.

## Non-Negotiable Invariants

1. Never persist secrets, raw credentials, bearer tokens, cookies, private keys, or unredacted tenant identifiers.
2. Never let model or tool output set tenant scope, repo scope, export policy, training eligibility, or object storage paths.
3. Use tenant-scoped hashes or scoped ids before dataset export.
4. Large payloads are object refs, not inline rows.
5. Upload is disabled by default.
6. Workers never upload dataset records directly.
7. Training exports require `training_allowed=true`.
8. External export/upload requires `export_allowed=true`.
9. Tenant/private/source-code records default to tenant-scoped local eval/replay only.
10. Deletion groups must delete database rows and object refs and invalidate future exports/candidates.
11. Feedback from one OKACAM employee chat is not tenant-wide visible unless a future explicit admin/audit feature is built.
12. Do not force tool use or product access behind invalid data-collection consent. Maximize collection only inside legal, tenant, product, and user policy.
13. Codali core remains product-neutral.
14. Model and agent selection comes from mcoda inventory and runtime capability data, not hardcoded identifiers.
15. Dataset collection must never block the gateway answer path.
16. Auto-improvement candidates must be reproducible from export ids, policy, code version, and model inventory snapshot.

## Unified Module Layout

### mcoda Repo

```text
packages/codali/src/storage/
  CodaliDatasetPrivacyEngine.ts
  CodaliFeedbackReviewIngestion.ts
  CodaliStorageContracts.ts
  DatasetExportJob.ts
  DatasetReviewQueue.ts
  GatewayDatasetStore.ts
  __tests__/

packages/codali/src/improvement/
  CandidateReleaseBuilder.ts
  DatasetEligibilityGate.ts
  DatasetExportManifestReader.ts
  DocdexRetrievalCandidateBuilder.ts
  EvalReplayCandidateBuilder.ts
  FineTuneJobPlanner.ts
  ImprovementEvalRunner.ts
  ImprovementPolicy.ts
  ModelRouterCandidateBuilder.ts
  OperatorInspector.ts
  ProductionGovernance.ts
  PromptSchemaToolMetadataCandidateBuilder.ts
  PublishOrchestrator.ts
  ReleaseOutcomeReporter.ts
  StorageServiceImprovementClient.ts
  __tests__/

packages/codali/src/cli/
  DatasetCommand.ts
  FeedbackCommand.ts
  ImprovementCommand.ts

packages/codali/src/dataset-cli.ts
```

### codali-storage-service Repo

```text
src/
  config/
  auth/
  contracts/
  db/
  object-store/
  gateway/
  dataset/
  improvement/
  admin/
  observability/
  server.ts
tests/
docs/
docker-compose.yml
Dockerfile
```

## Unified API Surface

### Storage Service Gateway APIs

```text
POST /v1/gateway/runs
PATCH /v1/gateway/runs/{runId}
POST /v1/gateway/runs/{runId}/tasks
PATCH /v1/gateway/runs/{runId}/tasks/{taskId}
POST /v1/gateway/runs/{runId}/evidence
POST /v1/gateway/runs/{runId}/tool-calls
POST /v1/gateway/runs/{runId}/model-calls
POST /v1/gateway/runs/{runId}/context-pack
POST /v1/gateway/runs/{runId}/artifacts
POST /v1/gateway/runs/{runId}/events
GET  /v1/gateway/runs/{runId}/trace
POST /v1/gateway/batches
```

### Storage Service Dataset APIs

```text
POST /v1/dataset/collect/{runId}
GET  /v1/dataset/examples
GET  /v1/dataset/examples/{exampleId}
POST /v1/dataset/feedback
POST /v1/dataset/reviews
POST /v1/dataset/labels
POST /v1/dataset/exports
GET  /v1/dataset/exports/{exportId}
GET  /v1/dataset/exports/{exportId}/download
POST /v1/dataset/batches
```

### Storage Service Improvement APIs

```text
POST  /v1/improvement/runs
PATCH /v1/improvement/runs/{runId}
POST  /v1/improvement/candidates
GET   /v1/improvement/candidates/{candidateId}
POST  /v1/improvement/eval-runs
POST  /v1/improvement/releases
GET   /v1/improvement/releases/{releaseId}
POST  /v1/improvement/release-outcomes
GET   /v1/improvement/releases/{releaseId}/lineage
GET   /v1/improvement/lineage/{releaseId}
GET   /v1/improvement/products/{productId}/quality-summary
```

### Admin APIs

```text
GET  /v1/admin/stats
POST /v1/admin/retention/prune
POST /v1/admin/deletion/run/{runId}
POST /v1/admin/deletion/conversation/{conversationHash}
POST /v1/admin/deletion/tenant/{tenantHash}
GET  /v1/admin/upload-outbox
POST /v1/admin/upload-outbox/drain
GET  /v1/admin/audit-log
```

## Unified Build Phases

Each phase should fit one focused LLM implementation session. Do not jump to a later phase until its prerequisites are implemented or explicitly stubbed with tests.

### Phase 0: Baseline Audit And Repo Readiness

Target repos:

- `/Users/bekirdag/Documents/apps/mcoda`
- `/Users/bekirdag/Documents/apps/codali-storage-service`

Build:

1. Audit current Codali gateway traces, replay, eval suite, live harness, mswarm transport, config, and release workflow.
2. Audit storage-service repo state, package manager, git state, Docker readiness, and existing docs.
3. Create machine-readable baseline reports for implemented, missing, and planned surfaces.
4. Verify current release workflow uses tag-triggered GitHub Actions and package-version matching.

Acceptance:

- Both repos have baseline reports.
- Missing endpoints and commands are listed.
- Current release path is documented.

Validation:

```text
git status --short
pnpm --filter @mcoda/codali run build
pnpm --filter @mcoda/codali test
node tests/all.js
```

### Phase 1: Shared Contracts And Schema Versioning

Target repos:

- mcoda
- codali-storage-service

Build:

1. Define shared TypeScript contracts for gateway records, dataset records, privacy metadata, object refs, export manifests, feedback, review, and improvement records.
2. Add JSON Schema or Zod validators.
3. Add schema version constants.
4. Decide whether contracts are copied, generated, or published from a shared package.
5. Support snake_case external payloads and camelCase internal structures where existing mcoda style requires it.

Acceptance:

- Both repos validate the same contract fixtures.
- Contracts are product-neutral.
- Backward-compatible schema versioning is explicit.

Validation:

```text
pnpm --filter @mcoda/codali run build
pnpm --filter @mcoda/codali test
cd /Users/bekirdag/Documents/apps/codali-storage-service && pnpm run build && pnpm test
```

### Phase 2: Storage Service Scaffold

Target repo:

- codali-storage-service

Build:

1. Create TypeScript/Fastify service skeleton.
2. Add `/healthz`, `/readyz`, and `/version`.
3. Add config loader for storage mode, Postgres, object storage, auth, upload, retention, and improvement features.
4. Add Dockerfile and local docker-compose for Postgres and MinIO.
5. Use Node >=20 compatibility first.

Acceptance:

- Service starts locally.
- Health and readiness endpoints work.
- Config defaults to `local_only` and upload disabled.

Validation:

```text
pnpm run build
pnpm test
docker compose up -d
curl http://127.0.0.1:<port>/healthz
```

### Phase 3: Auth, Tenant Scope, Idempotency, And Audit

Target repo:

- codali-storage-service

Build:

1. Add service-token auth for Codali/mswarm writers.
2. Add admin auth for retention, deletion, exports, and improvement release records.
3. Add HMAC or JWT signatures with tenant/product/deployment/run/timestamp/nonce/body hash.
4. Add nonce replay protection and idempotency keys.
5. Add tenant/product/deployment scope resolver.
6. Add audit event writer.

Acceptance:

- Unsigned, stale, replayed, or cross-tenant requests are rejected.
- Idempotent batches do not duplicate rows.
- Admin endpoints require stronger auth.

Validation:

```text
pnpm test -- auth scope idempotency audit
pnpm run build
```

### Phase 4: Database Migrations And Object References

Target repo:

- codali-storage-service

Build:

1. Add migration runner.
2. Create `codali_gateway` tables.
3. Create `codali_dataset` tables, including `improvement_*` tables.
4. Add object store interface.
5. Add filesystem and S3-compatible adapters.
6. Store content hash, byte size, MIME type, privacy flags, owner scope, deletion group, and retention class with every object ref.

Acceptance:

- Migrations create all operational, dataset, object, export, upload, retention, audit, and improvement tables.
- Object keys are server-generated.
- Object deletion is covered by deletion groups.

Validation:

```text
pnpm test -- migrations object-store
pnpm run test:integration
```

### Phase 5: Operational Gateway Store APIs

Target repo:

- codali-storage-service

Build:

1. Implement gateway run create/update.
2. Implement task create/update.
3. Implement evidence, tool-call, model-call, context-pack, artifact, and event append APIs.
4. Implement trace read by run id.
5. Store large fields as object refs.
6. Add batch ingest.

Acceptance:

- A full synthetic Codali gateway trace can be ingested and read back.
- Tenant scope is enforced on every read/write.
- Large payloads are object refs.

Validation:

```text
pnpm test -- gateway
```

### Phase 6: Dataset Privacy, Redaction, And Eligibility Engine

Target repos:

- codali-storage-service
- mcoda

Build:

1. Implement secret detection and redaction.
2. Hash tenant, requester, conversation, repo, source, reviewer, and deletion-group identifiers with tenant-scoped salts.
3. Generate privacy metadata for every dataset row.
4. Enforce `training_allowed`, `eval_allowed`, `replay_allowed`, `export_allowed`, and retention class.
5. Reject durable persistence for `retention_class=do_not_store`.
6. Add policy override flow requiring admin audit.

Acceptance:

- Records with secrets cannot be training/export eligible.
- Export and training flags are enforced before object payload reads.
- Identifier hashing is stable inside tenant scope and isolated across tenants.

Validation:

```text
pnpm test -- privacy redaction eligibility
pnpm --filter @mcoda/codali test -- GatewayDatasetPrivacy
```

### Phase 7: Codali Dataset Store Ports And Service Client

Target repo:

- mcoda

Build:

1. Add `GatewayDatasetStore` and `GatewayDatasetObjectStore` ports.
2. Add in-memory adapter for tests.
3. Add local JSONL/reference adapter for offline dry-runs.
4. Add `GatewayDatasetServiceClient` for codali-storage-service writes.
5. Add batching, retry, idempotency, signing, and non-blocking fallback.

Acceptance:

- Codali can collect dataset records without external services in tests.
- Production mode writes to storage service.
- Storage failures do not block gateway answers.

Validation:

```text
pnpm --filter @mcoda/codali run build
pnpm --filter @mcoda/codali test -- GatewayDatasetStore
```

### Phase 8: Codali Run, Model, Schema, And Gold-Target Collection

Target repo:

- mcoda

Build:

1. Add collector boundary over existing gateway traces.
2. Build run-level dataset records.
3. Convert model calls into model-stage examples.
4. Create schema failure records.
5. Add gold targets for accepted, corrected, and reviewed outputs.
6. Add conservative auto labels.

Acceptance:

- Every model call can become a typed dataset example when policy allows.
- Failed attempts and corrected targets are linked.
- Gold targets are deletion-group linked.

Validation:

```text
pnpm --filter @mcoda/codali test -- GatewayDatasetCollector
pnpm --filter @mcoda/codali run build
```

### Phase 9: Docdex/RAG, Tool, Evidence, Context, Final Answer, And Artifact Collection

Target repo:

- mcoda

Build:

1. Convert Docdex calls into RAG retrieval events.
2. Convert tool calls and blocked attempts into tool-decision examples.
3. Convert evidence items and context packs into labeled records.
4. Convert final answers into final-answer dataset records.
5. Convert image and binary artifacts into artifact records with object refs only.
6. Add policy events for denied tools, write/shell/destructive blocks, tenant override attempts, and Docdex scope override attempts.

Acceptance:

- RAG, tool, evidence, context, answer, and artifact records are captured without leaking secrets.
- App-tool signed request secrets are never stored.
- Image/binary data is object-ref only.

Validation:

```text
pnpm --filter @mcoda/codali test -- GatewayDatasetRag GatewayDatasetTool GatewayDatasetEvidence GatewayDatasetAnswer
node packages/codali/dist/cli.js eval --gateway-smoke --output json
```

### Phase 10: Storage-Service Dataset Collector

Target repo:

- codali-storage-service

Build:

1. Implement `POST /v1/dataset/collect/{runId}`.
2. Read operational traces and derive dataset records.
3. Store run, model, schema, RAG, tool, evidence, context, final-answer, artifact, and policy records.
4. Store labels and quality signals.
5. Keep collector idempotent.

Acceptance:

- A stored operational trace can generate dataset rows.
- Repeated collection is idempotent.
- Eligibility failures are recorded with reasons.

Validation:

```text
pnpm test -- dataset-collector
```

### Phase 11: Feedback And Human Review APIs

Target repos:

- codali-storage-service
- mcoda

Build:

1. Add product-neutral feedback ingestion.
2. Add human review ingestion.
3. Link feedback and reviews to run id, deletion group, product scope, requester scope, and candidate records.
4. Promote gold/silver/reject targets from reviews.
5. Add Codali/mswarm metadata needed for products to submit feedback later.
6. Add OKACAM per-employee scoping guard as adapter guidance.

Acceptance:

- Feedback from one employee chat cannot become tenant-wide visible by default.
- Review labels can improve datasets without exposing raw trace data.
- Products can store enough metadata to submit future feedback.

Validation:

```text
pnpm test -- feedback review
node --test packages/mswarm/dist/__tests__/codali-executor.test.js packages/mswarm/dist/__tests__/runtime.test.js
```

### Phase 12: Dataset Export Jobs And Manifest Format

Target repo:

- codali-storage-service

Build:

1. Add export kinds:
   - `eval-replay`
   - `prompt-regression`
   - `extractor-sft`
   - `tool-router-sft`
   - `planner-sft`
   - `verifier-sft`
   - `query-expander-sft`
   - `repair-sft`
   - `context-refiner-sft`
   - `rag-reranker`
   - `model-router`
2. Add dry-run count and exclusion reasons.
3. Write JSONL and replay fixtures to object storage.
4. Create export manifests with checksums, privacy summaries, lineage, and deletion-group snapshot.
5. Block export when eligibility fails.

Acceptance:

- Export is explicit and auditable.
- Manifests are sufficient for reproducible candidate generation.
- `training_allowed=false` rows never enter SFT exports.

Validation:

```text
pnpm test -- dataset-export
pnpm --filter @mcoda/codali exec codali dataset export --dry-run smoke
pnpm --filter @mcoda/codali exec codali dataset export JSONL smoke
```

### Phase 13: Upload Outbox And Optional Central Collection

Target repo:

- codali-storage-service

Build:

1. Add `upload_outbox`.
2. Add retry/backoff and signed upload batches.
3. Enforce upload disabled by default.
4. Upload only redacted, eligible, export-allowed records.
5. Add admin drain endpoint.

Acceptance:

- No data leaves local service unless upload mode and policy allow it.
- Failed uploads are retried without duplication.
- Upload attempts are audited.

Validation:

```text
pnpm test -- upload-outbox
```

### Phase 14: Retention, Deletion, And Data Governance

Target repo:

- codali-storage-service

Build:

1. Add deletion group ids everywhere.
2. Add retention policies by class.
3. Add dry-run and apply prune.
4. Add deletion by run id, conversation hash, and tenant hash.
5. Delete object refs with rows.
6. Invalidate exports and improvement candidates that depend on deleted records.

Acceptance:

- Deletion covers rows, object refs, exports, and improvement lineage.
- Future exports exclude deleted records.
- All deletion is audited.

Validation:

```text
pnpm test -- retention deletion
```

### Phase 15: Storage-Service Observability, Operations, And Backups

Target repo:

- codali-storage-service

Build:

1. Add structured logs and request ids.
2. Add metrics for ingest, collect, export, upload, deletion, object store, auth, and improvement.
3. Add `/metrics` when Prometheus is enabled.
4. Add readiness checks for DB and object storage.
5. Add backup and restore runbooks.
6. Add private-network deployment guidance.

Acceptance:

- Operators can inspect health, readiness, and metrics.
- Backup and restore procedures are tested.
- Service is deployable without public exposure.

Validation:

```text
pnpm run test:integration
docker compose up -d
curl http://127.0.0.1:<port>/readyz
```

### Phase 16: Codali Dataset CLI, Sampler, And Review Queue

Target repo:

- mcoda

Build:

1. Add `codali dataset inspect`.
2. Add `codali dataset review-queue`.
3. Add `codali dataset label`.
4. Add `codali dataset promote-target`.
5. Add `codali dataset export --dry-run`.
6. Add deterministic sampling by seed, tenant/product scope, failure cluster, integration, confidence, and business value.

Acceptance:

- Dataset collection can be inspected without a dashboard.
- Review queue is deterministic and tenant scoped.
- Export dry-run reports counts and exclusion reasons.

Validation:

```text
pnpm --filter @mcoda/codali run build
pnpm --filter @mcoda/codali exec codali dataset export --kind planner-sft --dry-run
```

### Phase 17: mswarm And Product Metadata Integration

Target repos:

- mcoda
- codali-storage-service

Build:

1. Add dataset metadata to `codali_gateway` responses.
2. Keep existing OpenAI-compatible metadata stable.
3. Add product-facing metadata:
   - run id
   - trace id
   - context pack id
   - dataset collection status
   - privacy flags
   - record counts
   - feedback token or ref
   - called tools
   - model tiers
   - warnings/errors
   - latency
4. Add product-neutral feedback submission contract.
5. Add OKACAM adapter notes without core OKACAM-specific logic.

Acceptance:

- Products can submit feedback later using assistant-message metadata.
- OKACAM can keep chat and feedback scoped per employee/user.
- Metadata does not leak private dataset ids across tenants.

Validation:

```text
node --test packages/mswarm/dist/__tests__/codali-executor.test.js packages/mswarm/dist/__tests__/runtime.test.js
```

### Phase 18: Dataset-Backed Eval And Replay Integration

Target repo:

- mcoda

Build:

1. Convert selected dataset examples into eval cases.
2. Build replay fixture importer.
3. Add eval suites for classifier, planner, tool router, RAG retrieval, evidence extractor, verifier, context pack, final answer, schema repair, and policy events.
4. Track prompt and schema versions in eval reports.
5. Add regression gates.

Acceptance:

- Dataset-backed evals run deterministically.
- Regressions block release candidates.
- Eval reports include lineage.

Validation:

```text
node packages/codali/dist/cli.js eval --gateway-smoke --output json
pnpm --filter @mcoda/codali test -- GatewayDatasetEval
```

### Phase 19: Shadow Model Comparison And Suku Metrics

Target repos:

- mcoda
- codali-storage-service

Build:

1. Add optional shadow comparison policy.
2. Resolve comparison candidates from mcoda inventory and runtime capabilities.
3. Record model comparison records.
4. Record local inference metrics when available.
5. Use Suku models and image-generating model for validation when inventory is healthy.
6. Treat missing or degraded Suku inventory as an environment warning with exact reason, not a hidden pass.

Acceptance:

- Shadow comparisons are policy-gated.
- Metrics include quality, latency, cost, token use, queue, throughput, and failure status where available.
- No model names are hardcoded in routing logic.

Validation:

```text
mcoda agent list --json --refresh-health
node packages/codali/dist/cli.js eval --gateway-live-smoke --live-timeout-ms 180000 --output json
```

### Phase 20: Storage-Service Improvement APIs

Target repo:

- codali-storage-service

Build:

1. Implement `/v1/improvement/runs`.
2. Implement `/v1/improvement/candidates`.
3. Implement `/v1/improvement/eval-runs`.
4. Implement `/v1/improvement/releases`.
5. Implement `/v1/improvement/release-outcomes`.
6. Implement lineage reads by release id.
7. Add audit events for every improvement decision.

Acceptance:

- Improvement records are tenant/product scoped.
- Candidate and release lineage can be traced to export ids.
- Blocked candidates and failed releases retain reasons.

Validation:

```text
pnpm test -- improvement
pnpm run openapi:check
```

### Phase 21: Codali Improvement Contracts And Policy

Target repo:

- mcoda

Build:

1. Add improvement run, candidate, artifact, gate, scorecard, release, and outcome types.
2. Add policy for release levels, allowed artifact types, tenant/product scope, max examples, max object bytes, storage mode, training, auto-tag, and auto-publish.
3. Add strict runtime validators.
4. Add CLI JSON output contracts.

Acceptance:

- Policy blocks training, export, auto-tagging, and publish when disabled.
- Release levels are explicit:
  - level 0: analysis only
  - level 1: eval/replay additions
  - level 2: prompt/schema/tool metadata branch
  - level 3: prerelease/canary tag
  - level 4: stable npm release

Validation:

```text
pnpm --filter @mcoda/codali test -- ImprovementPolicy
pnpm --filter @mcoda/codali run build
```

### Phase 22: Improvement Storage Client And Manifest Reader

Target repo:

- mcoda

Build:

1. Add storage-service improvement client.
2. Add export manifest reader.
3. Verify checksums before object payload use.
4. Normalize manifest lineage into candidate provenance.
5. Add dry-run mode.

Acceptance:

- Invalid manifests fail before candidate generation.
- Client rejects missing auth and scope mismatch.
- Unsupported export kinds are warnings, not silent ignores.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve inspect --export-id <fixture-export> --dry-run --output json
pnpm --filter @mcoda/codali test -- StorageServiceImprovementClient DatasetExportManifestReader
```

### Phase 23: Improvement Eligibility And Curation Gate

Target repo:

- mcoda

Build:

1. Enforce privacy metadata before object payload reads.
2. Deduplicate by run id, deletion group, task hash, prompt hash, tool contract hash, and expected target hash.
3. Filter examples by artifact type.
4. Prefer human-reviewed, accepted-correction, high-confidence, and strong negative examples.
5. Produce accepted/rejected/warning curation report.

Acceptance:

- Disallowed rows cannot enter candidate builders.
- Every rejection has a machine-readable reason.
- Deletion-group revocation invalidates lineage.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve inspect --export-id <fixture-export> --dry-run --output json
pnpm --filter @mcoda/codali test -- DatasetEligibilityGate
```

### Phase 24: Eval And Replay Candidate Builder

Target repo:

- mcoda

Build:

1. Build eval fixtures from curated examples.
2. Build replay fixtures from storage-service exports.
3. Include expected shape, accepted evidence, rejected evidence, and failure labels.
4. Keep fixture ids stable.

Acceptance:

- Eval/replay candidate generation is deterministic.
- Fixture generation does not modify runtime prompts or code.
- Large fixture bodies remain object refs where appropriate.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve propose --artifact eval --export-id <fixture-export> --dry-run --output json
node packages/codali/dist/cli.js eval --gateway-smoke --output json
```

### Phase 25: Prompt, Schema, And Tool Metadata Candidate Builders

Target repo:

- mcoda

Build:

1. Add prompt candidate builder.
2. Add schema candidate builder.
3. Add tool metadata candidate builder.
4. Build from failure evidence, not keyword hardcoding.
5. Require candidate source examples and failure classes.
6. Preserve backward compatibility or include migrations.

Acceptance:

- Patch plans are deterministic.
- Tool metadata remains product-neutral and contract-driven.
- Prompt candidates include evals that would have failed before the change.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve propose --artifact prompt --export-id <fixture-export> --dry-run --output json
pnpm --filter @mcoda/codali exec codali improve propose --artifact schema --export-id <fixture-export> --dry-run --output json
pnpm --filter @mcoda/codali exec codali improve propose --artifact tool-metadata --export-id <fixture-export> --dry-run --output json
```

### Phase 26: Docdex Retrieval Improvement Pipeline

Target repos:

- mcoda
- codali-storage-service

Build:

1. Build query-expander eval examples.
2. Build rerank labels from accepted and rejected evidence.
3. Build freshness, duplicate-detection, and source-selection regression cases.
4. Keep private repo/source examples tenant scoped unless export policy permits broader use.
5. Integrate with Docdex eval commands.

Acceptance:

- Retrieval candidates improve recall/precision/freshness scorecards without leaking tenant data.
- Query-expander data follows fine-tuning priority.
- Candidate patches do not hardcode product-specific tool names.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve propose --artifact docdex-retrieval --export-id <fixture-export> --dry-run --output json
docdexd hook pre-commit --repo /Users/bekirdag/Documents/apps/mcoda
```

### Phase 27: Worker Fine-Tune Job Planner

Target repo:

- mcoda

Build:

1. Generate SFT or preference job specs for worker roles.
2. Reject final-synthesizer fine-tuning by default.
3. Resolve model/provider targets dynamically from mcoda inventory and Suku health data.
4. Include dataset lineage, privacy summary, eval plan, cost estimate, and rollback plan.
5. Do not submit provider jobs automatically until provider-specific runners are approved.

Acceptance:

- No `training_allowed=false` rows enter fine-tune manifests.
- Job specs are reproducible from export ids and policy.
- Fine-tune candidates cannot bypass scorecards.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve propose --artifact fine-tune --role extractor --export-id <fixture-export> --dry-run --output json
mcoda agent list --json --refresh-health
```

### Phase 28: Model Router Optimizer

Target repos:

- mcoda
- codali-storage-service

Build:

1. Consume model comparison and inference metrics.
2. Build routing candidates balancing quality, tool accuracy, schema success, latency, cost, availability, confidence, and fallback rate.
3. Preserve final/large model for user-visible final synthesis when available.
4. Prefer local Suku models for extraction, repair, and constrained worker roles only when scorecards justify it.
5. Require shadow evidence before production router changes.

Acceptance:

- Router candidates are data-backed and reversible.
- No model names are hardcoded.
- Optimizer can return no-change when evidence is insufficient.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve propose --artifact model-router --export-id <fixture-export> --dry-run --output json
node packages/codali/dist/cli.js eval --gateway-live-smoke --live-timeout-ms 180000 --output json
```

### Phase 29: Candidate Workspace And Patch Writer

Target repo:

- mcoda

Build:

1. Create isolated candidate branches named `codali/auto-improve/<date>-<run-id>`.
2. Add dry-run patch output.
3. Allow writes only to approved files/directories.
4. Refuse unrelated dirty-file modification.
5. Mark generated artifacts with source export ids and schema versions.

Acceptance:

- Candidate generation is reproducible and discardable.
- Patch writer refuses paths outside repo and approved directories.
- Dirty worktree handling never reverts user changes.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve build-release --export-id <fixture-export> --dry-run --output json
git status --short
git diff --check
```

### Phase 30: Scorecards, Security Gates, And Release Approval

Target repos:

- mcoda
- codali-storage-service

Build:

1. Add improvement eval runner.
2. Add release scorecards.
3. Run deterministic tests, replay fixtures, privacy checks, and policy checks.
4. Add gates for privacy metadata, deletion groups, tenant scope, object checksums, tool policy, no shell/write/destructive tools, no cross-tenant replay, lineage validity, and approved file paths.
5. Persist scorecards and blocked reasons to storage service.

Acceptance:

- Every gate has pass/fail/skipped/warning status.
- Skips require exact reasons.
- Failed hard gates block tag and publish.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve eval --candidate <candidate-id> --output json
pnpm --filter @mcoda/codali run build
pnpm --filter @mcoda/codali test
node packages/codali/dist/cli.js eval --gateway-smoke --output json
git diff --check
docdexd hook pre-commit --repo /Users/bekirdag/Documents/apps/mcoda
```

### Phase 31: Release Candidate Planner

Target repo:

- mcoda

Build:

1. Determine semver bump.
2. Update package versions consistently across mcoda workspaces.
3. Generate changelog notes with source export ids, changed artifact classes, eval deltas, privacy summary, and rollback.
4. Create commit and tag plan.
5. Avoid raw customer data in changelog or commit messages.

Acceptance:

- Release plan includes version, branch, commit, tag, gates, rollback, and storage-service release id.
- Package versions match the future `v*` tag.
- Planner supports dry-run without file changes.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve build-release --candidate <candidate-id> --dry-run --output json
pnpm run release:publish:npm:dry-run
```

### Phase 32: CI/CD Publish Integration

Target repo:

- mcoda

Build:

1. Add auto-release orchestrator.
2. Support `branch_only` and `auto_tag`.
3. Reuse `.github/workflows/release.yml`.
4. Require clean candidate commit before tag push.
5. Poll or ingest GitHub Actions release status.
6. Store tag, commit sha, workflow run id, npm versions, and status in storage service.

Acceptance:

- Existing GitHub Actions release workflow remains the only npm publisher.
- Auto-tag is impossible unless policy enables it and scorecards pass.
- Published versions are verified with `npm view`.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve publish --candidate <candidate-id> --mode branch_only --dry-run --output json
pnpm run release:publish:npm:dry-run
npm view @mcoda/codali version --registry https://registry.npmjs.org/
```

### Phase 33: Canary, Shadow Rollout, Rollback, And Runtime Flags

Target repos:

- mcoda
- codali-storage-service

Build:

1. Add release outcome reporter.
2. Add runtime flags for prompt package, router policy, retrieval policy, schema, and fine-tune adapter versions.
3. Run shadow traffic for eligible requests.
4. Define rollback triggers for schema failures, lower accepted-answer rate, verifier contradictions, tool failures, latency/cost increase, and privacy/security warnings.
5. Store rollout and rollback events.

Acceptance:

- Every release has monitor window and thresholds.
- Rollback can disable runtime packages without unpublishing npm.
- Post-release outcomes feed the next improvement cycle.

Validation:

```text
pnpm --filter @mcoda/codali exec codali improve monitor --release <release-id> --output json
```

### Phase 34: Inspectors, Dashboards, And Operator Workflows

Target repos:

- mcoda
- codali-storage-service

Build:

1. Add CLI inspection for runs, datasets, candidates, blocked candidates, scorecards, releases, and rollbacks.
2. Add storage-service query endpoints for release lineage and product quality summaries.
3. Add dashboard-ready JSON.
4. Keep CLI and API stable before building web dashboard.

Acceptance:

- Any release can be traced to exports and eval gates.
- Any blocked candidate shows exact reasons.
- Audit logs contain no secrets or unredacted customer data.

Validation:

```text
pnpm --filter @mcoda/codali exec codali dataset inspect --run-id <run-id> --output json
pnpm --filter @mcoda/codali exec codali improve inspect --release <release-id> --output json
```

### Phase 35: Production Rollout And Governance

Target repos:

- mcoda
- codali-storage-service

Build:

1. Roll out storage in `local_only` mode first.
2. Enable service-local gateway writes.
3. Enable dataset exports.
4. Enable level 0 and 1 auto-improvement.
5. Enable level 2 candidate branches after privacy gates are stable.
6. Enable level 3 prerelease/canary only for internal deployments.
7. Enable level 4 stable auto-publish only when policy, CI, npm provenance, storage audit, rollback monitor, and hard gates are all active.
8. Document emergency disable flags:
   - `CODALI_DATASET_ENABLED=false`
   - `CODALI_STORAGE_MODE=off`
   - `CODALI_STORAGE_UPLOAD_ENABLED=false`
   - `CODALI_IMPROVEMENT_ENABLED=false`
   - `CODALI_IMPROVEMENT_AUTO_TAG=false`
   - `CODALI_IMPROVEMENT_AUTO_PUBLISH=false`
   - `CODALI_IMPROVEMENT_TRAINING_ENABLED=false`
   - `CODALI_IMPROVEMENT_SHADOW_ONLY=true`

Acceptance:

- Production starts with local-only storage and no upload.
- Candidate branches include scorecards and provenance.
- Stable publish uses existing tag-triggered workflow.
- Storage service contains release outcomes and monitor results.
- Rollback and disable flags are tested.

Validation:

```text
pnpm --filter @mcoda/codali run build
pnpm --filter @mcoda/codali test
node tests/all.js
cd /Users/bekirdag/Documents/apps/codali-storage-service && pnpm run build && pnpm test && pnpm run test:integration
pnpm --filter @mcoda/codali exec codali dataset export --kind planner-sft --dry-run
pnpm --filter @mcoda/codali exec codali improve eval --candidate <candidate-id> --output json
pnpm run release:publish:npm:dry-run
```

## MVP Cut

The first usable end-to-end release should include:

1. Storage-service scaffold, auth, scope, idempotency, DB migrations, object refs, operational ingest, trace read, privacy engine, dataset collector, feedback API, JSONL export dry-run, retention/delete, local compose tests.
2. Codali dataset contracts, privacy/redaction, local adapters, storage-service client, collector for run/model/tool/RAG/evidence/context/final/policy records, dataset CLI dry-run, mswarm response metadata.
3. Improvement contracts, export manifest reader, eligibility gate, eval/replay fixture builder, scorecard runner, branch-only release planner, release outcome writeback.

Do not include in MVP:

- central upload by default;
- raw automatic training-data upload;
- final synthesizer fine-tuning;
- public dashboard before CLI/API workflows;
- product-specific OKACAM core logic;
- auto-tag or stable auto-publish.

## Production Gate Matrix

Storage service:

```text
pnpm run build
pnpm test
pnpm run test:integration
pnpm run lint
pnpm run openapi:check
docker compose up -d
curl http://127.0.0.1:<port>/healthz
pnpm test -- gateway
pnpm test -- dataset-collector
pnpm test -- upload-outbox
pnpm test -- retention deletion
pnpm test -- auth scope idempotency audit
```

mcoda/Codali:

```text
pnpm --filter @mcoda/codali run build
pnpm --filter @mcoda/codali test
node packages/codali/dist/cli.js eval --gateway-smoke --output json
node --test packages/mswarm/dist/__tests__/codali-executor.test.js packages/mswarm/dist/__tests__/runtime.test.js
pnpm --filter @mcoda/codali exec codali dataset export --kind planner-sft --dry-run
pnpm --filter @mcoda/codali exec codali improve eval --candidate <candidate-id> --output json
git diff --check
docdexd hook pre-commit --repo /Users/bekirdag/Documents/apps/mcoda
pnpm run release:publish:npm:dry-run
```

Live model/router changes:

```text
mcoda agent list --json --refresh-health
node packages/codali/dist/cli.js eval --gateway-live-smoke --live-timeout-ms 180000 --output json
```

Post-publish:

```text
npm view @mcoda/codali version --registry https://registry.npmjs.org/
npm view mswarm version --registry https://registry.npmjs.org/
pnpm --filter @mcoda/codali exec codali improve monitor --release <release-id> --output json
```
