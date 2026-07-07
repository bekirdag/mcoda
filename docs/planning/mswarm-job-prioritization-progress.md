# mswarm Job Prioritization Progress

Date: 2026-07-07

## Status

- Plan doc: created.
- Repo/profile memory: recorded requested priority mapping.
- Implementation: completed across mcoda, mswarm, Docdex, TNL, OKACAM, and BDYA source surfaces.
- Validation: targeted contract/runtime/product tests are passing for completed surfaces.
- Publish/deploy: completed where required. `mcoda`, `@mcoda/mswarm`, `@mcoda/codali`, and `docdex` are published at the priority-capable versions; mswarm production and the suku self-hosted node are running priority-capable code.

## Priority Mapping

Lower number dispatches earlier.

| Source | Priority |
| --- | ---: |
| TNL | -3 |
| Docdex local delegation | -2 |
| OKACAM | -1 |
| Legacy/default | 0 |
| BDYA | 3 |

## Evidence

- `git status --short` showed existing uncommitted changes in `packages/codali/src/*`, `packages/mswarm/src/runtime.ts`, and mswarm/codali tests before this work started. These are treated as pre-existing user/workspace changes and must not be reverted.
- Docdex profile and repo memory were loaded before implementation planning.
- Docdex impact graph returned no inbound/outbound edges for `packages/shared/src/mswarm/GenericJobContract.ts` and `packages/mswarm/src/server.ts`; this appears incomplete for a TypeScript workspace, so local search and targeted tests remain required.

## Work Log

### 2026-07-07

- Created prioritization plan and progress documents.
- Implemented mcoda generic job scheduling contract:
  - `packages/shared/src/mswarm/GenericJobContract.ts` accepts top-level `scheduling`.
  - `packages/shared/src/mswarm/LifecycleContract.ts` records effective `priority`.
  - `packages/mswarm/src/server.ts` dispatches lower numeric priority before older default-priority jobs and exposes priority in ops/audit summaries.
  - SDK/CLI/agent setup surfaces display priority.
- Prepared mcoda release v0.1.90 from a clean worktree to avoid unrelated dirty Codali changes in the original workspace.
- Clean mcoda validation evidence:
  - `pnpm --filter @mcoda/shared test` passed.
  - `pnpm --filter @mcoda/mswarm test` passed after hardening the new priority test to wait for the legacy job to finish.
  - `pnpm -r run build` passed.
  - `pnpm --filter @mcoda/core test`, `pnpm --filter @mcoda/agent-setup test`, and `pnpm --filter mcoda test` passed.
  - Broad `node tests/all.js` reached a known environment-sensitive Docdex integration health check: local `docdex` on `127.0.0.1:28491` did not become healthy within 5s. The same Docdex integration had passed earlier in the clean tree; the priority-specific and affected package gates are green.
- Implemented mswarm platform relay scheduling:
  - `packages/core/src/self-hosted-nodes.ts` persists normalized scheduling and claims lower numeric priorities first.
  - `services/openai-proxy/src/server.ts` accepts top-level or metadata scheduling for self-hosted jobs and includes scheduling in relay fingerprinting.
  - `services/gateway/src/server.ts` serializes scheduling/default priority for owner-visible relay jobs.
- Implemented OKACAM priority `-1` in both the OKACAM app repo and the mswarm OKACAM module producers:
  - `/Users/bekirdag/Documents/apps/okacam/server/src/services/tenant-ai-chat-service.ts`
  - `/Users/bekirdag/Documents/apps/mswarm/packages/core/src/codali-module-runtime.ts`
  - `/Users/bekirdag/Documents/apps/mswarm/packages/okacam-reviewer-core/src/gateway-client.ts`
- Implemented TNL priority `-3` for Ledger AI and story image mswarm calls in `/Users/bekirdag/Documents/apps/theneuralledger/server/index.ts`.
- Implemented Docdex local delegation priority `-2` for mswarm-backed mcoda agents in `/Users/bekirdag/Documents/apps/docdex/src/llm/delegation.rs`.
- Implemented BDYA priority `3` on sukunahikona in `/home/wodo/apps/bdya/apps/svc-mcoda-gateway/src/main.ts` for node-bound self-hosted OpenAI requests. Local OpenAI-compatible backends intentionally skip the `scheduling` field.

## Validation Log

- `pnpm --filter @mcoda/shared test` passed.
- `pnpm --filter @mcoda/mswarm test` passed.
- `pnpm --filter @mcoda/core test` passed.
- `pnpm --filter @mcoda/agent-setup test` passed.
- `pnpm --filter @mcoda/core run build` passed.
- `pnpm --filter mcoda test` passed after rebuilding core.
- `/Users/bekirdag/Documents/apps/mswarm`: `npm test -- tests/unit/codali-module-runtime.test.ts` passed.
- `/Users/bekirdag/Documents/apps/mswarm`: `npm test -- tests/unit/okacam-reviewer-gateway-client.test.ts` passed.
- `/Users/bekirdag/Documents/apps/mswarm`: `npm test -- tests/api/gateway-self-hosted-nodes.test.ts` passed.
- `/Users/bekirdag/Documents/apps/mswarm`: `npm test -- tests/openai-proxy.test.ts` passed.
- `/Users/bekirdag/Documents/apps/okacam`: `npm test -- tests/tenant-ai-chat-service.test.ts` passed.
- `/Users/bekirdag/Documents/apps/theneuralledger`: `npm run test:ledger-ai-chat-intelligence` passed.
- `/Users/bekirdag/Documents/apps/theneuralledger`: `npm run test:story-image-config` passed.
- `/Users/bekirdag/Documents/apps/docdex`: `cargo test merge_config_extra_body_preserves_config_and_overrides_extra_body_fields` passed.
- `/Users/bekirdag/Documents/apps/docdex`: `cargo test docdex_local_delegation_marks_mswarm_agents_with_negative_priority` passed.
- `sukunahikona:/home/wodo/apps/bdya`: `./node_modules/.bin/tsx infra/ops/validate_news_digest_logic.ts` passed.
- `sukunahikona:/home/wodo/apps/bdya`: `./node_modules/.bin/tsc --pretty false --noEmit -p tsconfig.base.json` passed.
- `sukunahikona`: `systemctl --user restart svc-mcoda-gateway.service` completed, and `/healthz` returned `status: ok`.

## Fresh Re-Audit

Date: 2026-07-07

- Completed: `origin/main` contains the numeric priority contract, `scheduling.priority` validation, default legacy priority `0`, lifecycle priority snapshots, and lower-number-first dispatch tests.
- Completed: published npm versions are `mcoda@0.1.90`, `@mcoda/mswarm@0.1.90`, `@mcoda/codali@0.1.90`, and `docdex@0.2.80`.
- Completed: standalone mswarm production is on `d766418`, `mswarm-gateway` is healthy, and `NODE_OPTIONS=--max-old-space-size=4096`.
- Completed: `POST https://api.mswarm.org/v1/swarm/self-hosted/node/jobs/poll` with a dummy node id returns application `401` with `Missing self-hosted node runtime token`, confirming the relay route is live rather than Cloudflare 502ing.
- Completed: public health checks returned healthy responses from `https://api.mswarm.org/healthz`, `https://api.docdex.org/healthz`, `https://okacam.org/healthz`, and `https://theneuralledger.com/healthz`.
- Completed: suku self-hosted node is active, uses `@mcoda/mswarm@0.1.90`, has `MSWARM_SELF_HOSTED_REQUEST_TIMEOUT_MS=90000`, and its recent journal window has no abort/timeout/error lines.
- Completed: BDYA on suku is active at `143abd0` with default priority `3`, scheduling payload construction, node-bound scheduling gating, and validation checks for the priority default.
- Misaligned and aligned: this progress document previously said publish/deploy had not started. The statement is now corrected to match the released and deployed state.
- Caveat: `/Users/bekirdag/Documents/apps/mcoda` still has unrelated dirty local changes and is behind `origin/main`; release verification used the clean `/private/tmp/mcoda-priority-release` worktree instead.
- Caveat: `sukunahikona:/home/wodo/apps/bdya` still has an unrelated dirty docs/planning file. The priority source and deployed service are aligned.

## Blockers

- None for the priority rollout.
