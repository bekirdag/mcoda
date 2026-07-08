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
- `v0.1.91` release run `28971684508` completed successfully. All package matrix jobs passed, including Windows, and the `publish-npm` job completed.
- npm registry verification shows `mcoda`, `@mcoda/codali`, `@mcoda/mswarm`, `@mcoda/core`, and `@mcoda/shared` at `0.1.91`.
- The suku/sukunahikona self-hosted mswarm node now runs global packages `mcoda@0.1.91`, `@mcoda/mswarm@0.1.91`, and `@mcoda/codali@0.1.91`.
- The suku self-hosted node wrapper now advertises `MSWARM_SELF_HOSTED_NODE_VERSION=0.1.91`, `mswarm-self-hosted-node.service` was restarted and is active, and the public catalog reports suku agents with `node_version: "0.1.91"`.
- A live OpenAI-compatible suku self-hosted request with `scheduling.priority: -2` returned `OK_PRIORITY_SMOKE_0_1_91`.

## Missing

- None remaining for the audited release/deploy scope.
- Previously missing release automation is now complete manually: commits were pushed, tag `v0.1.91` was repointed after release blockers were fixed, GitHub Actions published the npm packages, and suku was upgraded from `0.1.90` to `0.1.91`.
- Fixed gap: the first `v0.1.91` GitHub Actions release run failed before npm publishing because the committed phase 0 storage-service baseline still described the service as a non-Git directory. The baseline and test now match the Git-backed storage-service repo.
- Fixed gap: the second `v0.1.91` release run reached the package test stage but failed before npm publishing because final cross-phase and phase 1 tests assumed the sibling `codali-storage-service` checkout existed in CI. The tests now validate live storage-service files when the sibling checkout exists and committed baseline/release evidence when it does not.
- Fixed gap: the third `v0.1.91` release run passed all non-Windows package jobs but failed in the Windows package test because a phase 1 plan-parsing assertion did not normalize CRLF line endings before matching validation blocks. The test now normalizes `\r\n` to `\n` before parsing the markdown plan.

## Misaligned

- The phrase "37 phases" is slightly misaligned with the implementation: the source plan has 36 numbered phases plus final review. The runner's 109 tasks are 36 phases times 3 tasks plus one final review.
- The queue state says the final review is still running even though later local validation evidence shows the cross-phase checks completed. The queue state should not be treated as release truth after the stale runner was killed.
- The standalone mswarm full test suite is not green on current clean origin/main due pre-existing fixture/environment expectations outside the Codali package publish path. Focused priority and self-hosted relay tests pass, and production health checks are green.
- OKACAM and standalone mswarm production servers do not consume `@mcoda/*` npm packages directly. The suku mswarm node is the server that must be updated to consume the new published `@mcoda/mswarm`/`@mcoda/codali` packages.
- suku `daemon.err.log` contains older transient gateway 502 poll entries, but the file timestamp predates the `0.1.91` restart and did not change after the successful priority smoke.

## Release Actions

- Done: bumped release-guarded mcoda package versions to `0.1.91`.
- Done: committed and pushed the storage-service baseline, CI fallback, and Windows CRLF test fixes, then repointed and reran tag `v0.1.91`.
- Done: verified GitHub Actions published the release package set; direct registry checks confirmed the core audited packages at `0.1.91`.
- Done: updated suku global packages to the published `0.1.91` versions, restarted `mswarm-self-hosted-node.service`, and ran a live priority smoke check.
- Done: committed, pushed, and deployed OKACAM tenant AI chat changes; verified production health after deployment.
- Done: initialized and pushed `codali-storage-service` to `https://github.com/bekirdag/codali-storage-service.git`.
