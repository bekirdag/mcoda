# Codali Unified Release Audit - 2026-07-08

## Scope

This audit follows the completed `scripts/automate_codali_unified_plan.py` run for the unified Codali gateway data, storage, and auto-improvement plan. It compares the automation output against the release goal: working Codali dataset/refining/learning-from-logs flows, committed repos, published npm packages, and deployed servers using the published builds.

## Completed

- The unified plan contains 36 numbered phases, phase 0 through phase 35, plus one final cross-phase review task. The user-facing "37 phases" expectation maps to that 36-plus-final-review structure.
- The automation queue completed 108 of 109 tasks. The remaining task was the final cross-phase review, which was left in `running` state by the queue, but later deterministic validation evidence in the progress doc records final cross-phase review attempts through attempt 37.
- `@mcoda/codali` builds with the dataset export CLI, gateway dataset eval, storage clients, improvement pipeline, release approval, and governance modules.
- `@mcoda/mswarm` builds with Codali gateway payload preservation for dataset, feedback, product metadata, runtime context, and self-hosted relay handling.
- `codali-storage-service` builds and its OpenAPI, integration, and improvement test slices pass locally.
- `codali-storage-service` is now a Git worktree pushed to `https://github.com/bekirdag/codali-storage-service.git` on `main`.
- Codali dataset/export/improvement validation passed locally:
  - `pnpm --filter @mcoda/codali run build`
  - `pnpm --filter @mcoda/mswarm run build`
  - `node --test tests/unit/codali-unified-final-cross-phase.test.js`
  - `pnpm --filter @mcoda/codali test -- dataset-export`
  - `node packages/codali/dist/dataset-cli.js export --dry-run smoke --output json`
  - `node packages/codali/dist/cli.js improve eval --candidate final-cross-phase-validation --output json`
- `codali-storage-service` validation passed locally:
  - `pnpm run build`
  - `pnpm run openapi:check`
  - `pnpm run test:integration`
  - `pnpm test -- improvement`
- OKACAM tenant AI chat follow-up context work builds and passes the targeted tenant AI chat test suite locally.
- OKACAM tenant AI chat follow-up context work is committed as `8fcab59`, pushed to `sealunit/okacam`, deployed by the `okacam-deploy` workflow, and production `/srv/okacam` is on that commit with a clean working tree and healthy `/healthz`.
- The standalone `/Users/bekirdag/Documents/apps/mswarm` repo is clean and synced to origin/main. Its production host is already on commit `a8795cc` with healthy gateway, OpenAI proxy, and admin API health checks.
- Focused standalone mswarm self-hosted relay tests pass, including the lower-numeric-priority queue claim test.
- The mcoda CI-equivalent command `node tests/all.js` passes locally after aligning the storage-service baseline with the new Git-backed storage-service repo.

## Missing

- The automation queue did not publish npm packages, create release tags, push commits, or deploy production services. The script explicitly avoids those operations unless configured with `--git-sync`, and the run did not perform release operations.
- The first `v0.1.91` GitHub Actions release run failed before npm publishing because the committed phase 0 storage-service baseline still described the service as a non-Git directory. The baseline and test are now aligned with the Git-backed storage-service repo; the release tag must be repointed and the release workflow rerun.
- npm still reports `mcoda`, `@mcoda/codali`, and `@mcoda/mswarm` at `0.1.90` until the corrected `v0.1.91` release succeeds.
- The suku/sukunahikona self-hosted mswarm node currently runs global packages `mcoda@0.1.90`, `@mcoda/mswarm@0.1.90`, and `@mcoda/codali@0.1.90`. It must be updated after `0.1.91` is published.

## Misaligned

- The phrase "37 phases" is slightly misaligned with the implementation: the source plan has 36 numbered phases plus final review. The runner's 109 tasks are 36 phases times 3 tasks plus one final review.
- The queue state says the final review is still running even though later local validation evidence shows the cross-phase checks completed. The queue state should not be treated as release truth after the stale runner was killed.
- The standalone mswarm full test suite is not green on current clean origin/main due pre-existing fixture/environment expectations outside the Codali package publish path. Focused priority and self-hosted relay tests pass, and production health checks are green.
- OKACAM and standalone mswarm production servers do not consume `@mcoda/*` npm packages directly. The suku mswarm node is the server that must be updated to consume the new published `@mcoda/mswarm`/`@mcoda/codali` packages.

## Release Actions

- Bump release-guarded mcoda package versions to `0.1.91`.
- Commit and push the storage-service baseline fix, then repoint and rerun tag `v0.1.91`.
- Verify GitHub Actions publishes `mcoda`, `@mcoda/shared`, `@mcoda/db`, `@mcoda/agents`, `@mcoda/generators`, `@mcoda/integrations`, `@mcoda/core`, `@mcoda/agent-setup`, `@mcoda/codali`, and `@mcoda/mswarm`.
- Update suku global packages to the published `0.1.91` versions, restart `mswarm-self-hosted-node.service`, and run a priority/Codali smoke check.
- Commit, push, and deploy OKACAM tenant AI chat changes; verify production health after deployment.
- Initialize and push `codali-storage-service` to a GitHub remote or document the remote blocker if repository creation fails.
