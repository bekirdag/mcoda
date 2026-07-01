# Codali Multi-Stage Job Runtime Progress

Plan: `docs/planning/codali-multistage-job-runtime-plan.md`
Date: 2026-07-01
Status: Releasable mcoda/Codali runtime scope implemented and validated for `0.1.88`; CI tag publish path prepared; downstream OKACAM/suku rollout remains

## Checklist

- [x] Load OKACAM AI-chat profile preferences.
- [x] Inspect mcoda repo structure.
- [x] Inspect existing Codali runtime, mswarm Codali executor, local runner support, and publish script.
- [x] Attempt initial suku non-interactive mcoda agent listing.
- [x] Record suku PATH validation blocker.
- [x] Create reusable mcoda/Codali multi-stage job runtime plan.
- [x] Add first implementation slice for runtime-provided read-only tool contracts.
- [x] Implement contracts in `packages/codali`.
- [x] Register runtime-provided dynamic virtual tools in the active Codali run.
- [x] Enforce allowed/denied/read-only/tenant-scope guards for dynamic tool contracts.
- [x] Return dynamic tool telemetry through Codali and mswarm metadata.
- [x] Add focused Codali/mswarm tests for OKACAM-compatible and generic app contracts.
- [x] Add request-provided Codali job-stage role key selection and mswarm role pass-through.
- [ ] Add persisted mcoda agent catalog role metadata, role selection helpers, and CLI/SDK role assignment.
- [ ] Validate suku small llama.cpp agents for router/planner/verifier roles.
- [x] Implement `runCodaliJob`.
- [x] Extend mswarm Codali executor with `codali_job`.
- [ ] Integrate OKACAM AI chat behind a feature flag.
- [ ] Publish updated mcoda/Codali packages through the `v0.1.88` CI/CD tag route.
- [ ] Update OKACAM dependencies and deploy.

## Findings

- `packages/codali/src/runtime/CodaliRuntime.ts` already exposes the lower-level runtime needed for model/tool execution.
- `packages/codali/src/subagents/SubagentOrchestrator.ts` already supports bounded parallel subagent work.
- `packages/codali/src/agents/PhaseAgentSelector.ts` already selects agents by Codali pipeline phase; this can be extended or paralleled for job-stage roles.
- `packages/mswarm/src/codali-executor.ts` already maps mswarm jobs to Codali runtime input and passes session/subagent options.
- `packages/shared/src/llm/LocalRunnerConfig.ts` already supports llama.cpp/OpenAI-compatible local runner metadata.
- `scripts/publish-npm-packages.js` publishes `@mcoda/codali` only when `MCODA_PUBLISH_CODALI=1`.
- Suku SSH works, but `mcoda` was not found in the non-interactive PATH used by SSH. The printed PATH was `/home/wodo/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`.
- Runtime dynamic-tool work should start in `packages/codali/src/runtime/CodaliRuntime.ts`: the runtime already filters registered `ToolDefinition`s through `policy.allowedTools`, `policy.deniedTools`, write/shell guards, and Docdex capability gates.
- Current read-only Docdex backing tools already exist in `packages/codali/src/tools/docdex/DocdexTools.ts`: `docdex_search`, `docdex_batch_search`, `docdex_open`, `docdex_files`, `docdex_tree`, and `docdex_stats`.
- mswarm must forward generic `policy.app_tool_contracts` and OKACAM compatibility fields alongside `docdex.tool_manifest`; today `packages/mswarm/src/runtime.ts` and `packages/mswarm/src/codali-executor.ts` only map the existing Docdex/policy fields.
- Docdex impact graphs for `packages/codali/src/runtime/CodaliRuntime.ts`, `packages/mswarm/src/codali-executor.ts`, and nearby tests returned no edges. Treat that as incomplete graph coverage and validate with focused tests plus local search.
- `packages/codali/src/runtime/CodaliRuntime.ts` now registers dynamic read-only contract tools for the active run, executes current contracts through allowed Docdex backing tools, rejects scope override args such as repo/tenant/base URL/credential fields, and records dynamic telemetry.
- `packages/mswarm/src/codali-executor.ts` and `packages/mswarm/src/runtime.ts` now pass through `docdex.tool_manifest`, generic `policy.app_tool_contracts`, `policy.app_virtual_tools`, `policy.app_tool_gateway`, plus OKACAM compatibility fields.
- `packages/codali/src/index.ts` exports the runtime tool-contract and telemetry types from `@mcoda/codali`.
- Direct `app_tool_gateway` contracts are recognized only when a read-only endpoint is configured; signature-required contracts are skipped unless a signature is supplied in the gateway contract.
- `packages/codali/src/runtime/CodaliJobRuntime.ts` now exports `runCodaliJob`, a product-neutral stage DAG wrapper around `runCodaliTask` with per-stage runtime policy, aggregate tool-call budget enforcement, evidence normalization, verifier repair support, and job telemetry.
- `packages/codali/src/runtime/CodaliJobRuntime.ts` now resolves request-provided stage agents/providers by exact stage id, stage `role`, stage `kind`, then default policy/runtime fallback.
- `packages/mswarm/src/codali-executor.ts` now calls `runCodaliJob` only when a `codaliJob` payload is present; the existing single-agent `runCodaliTask` path remains the default.
- `packages/mswarm/src/runtime.ts` now accepts snake_case `codali_job` payloads, preserves stage `role` separately from `kind`, normalizes stages/budgets into the Codali job contract, forwards job progress events, and stores job/stage telemetry on OpenAI response metadata.
- `.github/workflows/release.yml` and `.github/workflows/release-dry-run.yml` both set `MCODA_PUBLISH_CODALI=1`; the active publish path is commit/tag/push, not local npm auth.
- The full plan is not complete across downstream phases: persisted mcoda role catalog support, suku small-agent validation, OKACAM feature-flag integration, OKACAM dependency/deploy, and the broader Wodo/Heka evaluation harness remain after the `0.1.88` mcoda package release.

## Validation Evidence

- `docdex_search` on mcoda found current Codali runtime and mswarm Codali executor sources.
- `docdex_tree` confirmed mcoda package layout and `docs/planning` location.
- `ssh -o BatchMode=yes -o ConnectTimeout=10 suku 'mcoda agent list --json --refresh-health'` failed with `zsh:1: command not found: mcoda`.
- Follow-up suku PATH probe found no `mcoda` executable in common non-interactive paths.
- `docdex_symbols`, `docdex_ast`, and `docdex_impact_graph` were used on the Codali runtime and mswarm executor/test files before implementation.
- `docdex_local_completion` was attempted for a small helper-design delegation and timed out; implementation proceeds with primary-agent validation.
- `docdex_impact_graph` after implementation still returned empty edge sets for the changed source files; `docdex_impact_diagnostics` returned no diagnostics for Codali runtime or mswarm executor.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/runtime/__tests__/CodaliRuntime.test.ts` passed after building `@mcoda/codali`; the harness reported 600 package tests and 14 targeted runtime tests passing.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/codali-executor.test.ts` passed after building shared/Codali/mswarm; the harness reported 110 self-hosted runtime tests and 8 executor tests passing.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/runtime.test.ts` passed; the harness reported 102 focused self-hosted runtime tests passing.
- `git diff --check` passed.
- `docdex_index` ingested the touched tracked source/test files; `docs/planning/*` files were excluded by ignore pattern.
- `docdex_local_completion` generated a focused test-case sketch for the job runtime; the implemented tests cover DAG execution, budget exhaustion, optional failures, and cycle validation.
- `docdex_index` ingested `packages/codali/src/runtime/CodaliJobRuntime.ts` and the new/changed Codali/mswarm tests after the job-runtime slice.
- `docdex_impact_graph` after the job-runtime slice still returned empty edge sets for the new/changed source and test files; validation relies on symbols, focused tests, and package builds.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/runtime/__tests__/CodaliJobRuntime.test.ts` passed after building `@mcoda/codali`; the harness reported 604 package tests and 4 focused job-runtime tests passing.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/codali-executor.test.ts` passed after building shared/Codali/mswarm; the harness reported 112 self-hosted runtime tests and 9 focused executor tests passing.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/runtime.test.ts` passed; the harness reported 103 focused self-hosted runtime tests passing.
- `npm view` confirmed `0.1.88` was not already published for the packages handled by `scripts/publish-npm-packages.js`.
- Package manifests were bumped to `0.1.88` for the workspace packages and private root manifest.
- `git diff --check` passed after the version bump.
- `npm whoami` failed with `E401 Unauthorized`, and no `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or `npm_config__authToken` environment variable was present.
- `MCODA_PUBLISH_CODALI=1 pnpm run release:publish:npm:dry-run` passed for the publish set, including `@mcoda/codali@0.1.88` and `@mcoda/mswarm@0.1.88`; real local publish is blocked by npm auth, but the user-approved CI/CD tag route is available.
- Audit after user clarified tag-based publishing: `.github/workflows/release.yml` already sets `MCODA_PUBLISH_CODALI=1`, so local npm auth is not a release blocker for the CI/CD path.
- Added stage role pass-through/selection alignment: Codali stages now support `role`, mswarm preserves `role` separately from `kind`, and role-key agent/provider selection is covered in focused tests.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/runtime/__tests__/CodaliJobRuntime.test.ts` passed after the role patch; the harness reported 604 package tests and 4 focused job-runtime tests passing.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/runtime.test.ts` initially failed on a TypeScript build error because absent stage role normalized as `null`; fixed to normalize absent role as `undefined`.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/runtime.test.ts` passed after the fix; the harness reported 112 package tests and 103 focused self-hosted runtime tests passing.
- `git diff --check` passed after the role patch and documentation alignment.
- `MCODA_PUBLISH_CODALI=1 MCODA_PUBLISH_AGENT_SETUP=1 pnpm run release:publish:npm:dry-run` passed, matching the release workflow's Codali and agent-setup publish flags.

## Next Step

Commit the `0.1.88` release, tag `v0.1.88`, and push the branch/tag so CI/CD publishes npm packages. After publish, continue with persisted mcoda catalog role metadata, suku small-agent validation, OKACAM feature-flag integration, and downstream OKACAM dependency/deploy work.
