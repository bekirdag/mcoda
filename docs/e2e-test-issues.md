# E2E Issues (<PROJECT_NAME>)

## Summary
End-to-end run across docs → tasks → migrate/refine → gateway-trio on `<WORKSPACE_ROOT>` exposed the issues below. Each item lists status and whether a fix was applied in mcoda.

## Issues

1) Global CLI install points to `mcoda-local` stub
- Symptom: `mcoda --version` fails with `MCODA_COMMANDS` error; `mcoda` in PATH is a stub.
- Root cause: global install created `mcoda-local` wrapper; PATH includes it before repo-built CLI.
- Status: open (workaround: use `<MCODA_BIN_DIR>` from `pnpm bin -g`).

2) PDR/SDS generation stalls without fast mode
- Symptom: `mcoda docs pdr generate` and `mcoda docs sds generate` time out without `--fast`.
- Root cause: enrichment/tidy/iterative passes are long running for small projects.
- Status: fixed (added `--fast` for PDR/SDS).

3) PDR/SDS invent endpoints when no OpenAPI provided
- Symptom: Interfaces sections include fabricated endpoints.
- Root cause: agent output not sanitized when OpenAPI missing; `replaceSection` regex only replaced heading, leaving old content.
- Status: fixed (sanitizer + regex fix).

4) `create-tasks` ignores docs when no inputs provided
- Symptom: `create-tasks` reported “no docs provided,” produced irrelevant epics/stories.
- Root cause: `prepareDocs` only uses explicit inputs; no default doc discovery.
- Status: fixed (default scan of `.mcoda/docs`, `docs`, `openapi`; filter meta/first-draft).

5) `create-tasks` fails on non‑JSON agent output
- Symptom: agent output wrapped in `<think>` or duplicated JSON caused parse failure.
- Root cause: fragile JSON extraction.
- Status: fixed (robust extraction + test).

6) `create-tasks` accepts invalid `area`, `type`, `relatedDocs`
- Symptom: invalid `area` values and non-docdex related docs persisted.
- Root cause: no normalization/validation in parse.
- Status: fixed (normalize area/type, filter docdex handles).

7) `refine-tasks` parsing too strict / invalid output ignored
- Symptom: refine produced 0 operations even when output contained JSON arrays or fenced JSON.
- Root cause: parser expected a strict `{operations: []}` object; no repair/ retry.
- Status: improved (robust JSON extraction + retry prompt + warnings). Still outputs 0 ops with certain models.

8) Gateway agent override ignored when missing required capabilities
- Symptom: `--gateway-agent gateway-router` ignored, codex picked → 429 rate limit.
- Root cause: override rejected if agent lacks required caps (`plan`, `docdex_query`).
- Status: fixed (explicit override now accepted with warning if agent is reachable).

9) Gateway-trio cannot override work/review/qa agent
- Symptom: work step still chose codex agents (429) even when gateway agent overridden.
- Root cause: no CLI flags to override chosen work/review/qa agents.
- Status: fixed (added `--work-agent`, `--review-agent`, `--qa-agent`).

10) `work-on-tasks` fails when tests required but no test command
- Symptom: tasks blocked with `tests_not_configured` when test requirements exist.
- Root cause: test command fallback does not consider run-all script.
- Status: fixed (run-all tests script used as fallback test command).

11) Gateway-trio still fails in docs-only repo
- Symptom: blocked tasks and missing patch output even after overrides; some models refuse to emit patches.
- Root cause: code-writer models not complying with patch format; repo lacks actual app code scaffolding.
- Status: open (needs model/format guardrails and/or scaffolding strategy).

12) Missing project guidance doc
- Symptom: work-on-tasks logs “no project guidance found.”
- Root cause: no `docs/project-guidance.md` in test repo.
- Status: open (should be generated before task runs per requirements).
