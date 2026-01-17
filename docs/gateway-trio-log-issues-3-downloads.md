# Gateway Trio Log Issues (Downloads/logs/3.txt)

## Run Details
- Log file: `/Users/bekirdag/Downloads/logs/3.txt`
- Job ID: `37020508-b64d-476c-a5f3-21c4db1b2361`
- Resume hint: `mcoda gateway-trio --resume 37020508-b64d-476c-a5f3-21c4db1b2361`

## Mcoda / Gateway-Trio Issues
1) **Docdex repo context missing in agent runs.**
   - Evidence: repeated `missing_repo: You failed to specify which repo to query.`
   - Impact: docdex searches fail; plans and reviews lack repo context.

2) **Docdex daemon unavailable during review/QA.**
   - Evidence: review summaries say `Docdexd search failed (daemon not running)` and `daemon bind blocked`.
   - Impact: review/QA rely on local files only and skip impact/AST checks.

3) **Review agent returns non-JSON after retry.**
   - Evidence: `decision: block ... Review agent returned non-JSON output after retry`.
   - Impact: tasks are blocked even when work may be correct.

4) **Patch application failed during work-on-tasks.**
   - Evidence: `Patch apply failed (No patches applied; all segments failed or were skipped.)`
   - Impact: work changes are not applied; task loops.

5) **Run-all tests command uses an absolute node path.**
   - Evidence: `Run-all tests command: /opt/homebrew/Cellar/node/25.2.1/bin/node tests/all.js`
   - Impact: non-portable; can fail on other machines or CI.

6) **Watch output looks idle despite work.**
   - Evidence: repeated `gateway-trio job ... running 0/3` then long repeats of `running 1/3`.
   - Impact: hard to monitor progress and detect stalling.

7) **Doc context includes non-spec docs as SDS.**
   - Evidence: `Docdex context: [SDS] docs/e2e-test-issues.md`
   - Impact: agents treat QA issue docs as system design specs, causing drift.

8) **Prompts still include MCP/docdexd serve guidance.**
   - Evidence: prompt blocks mention `docdex_search`/`docdex_open` and `docdexd serve`.
   - Impact: conflicts with the daemon-only docdex requirement.

## Docdex Environment Issues
1) **Playwright CLI missing under docdex.**
   - Evidence: `Error: Cannot find module ... docdex/node_modules/playwright/cli.js`
   - Impact: QA follow-ups referencing Playwright cannot run; infra issues persist.

2) **Daemon bind/ollama errors prevent docdex usage.**
   - Evidence: review summaries note daemon bind blocked and profile/memory/impact checks failing.
   - Impact: docdex context remains empty; review/QA degraded.

## Test App (test-web-app) Issues Surfaced by QA/Review
1) **Auth + route wiring gaps.**
   - Evidence: QA report says suggestions route lacks JWT middleware, time-gate not applied, cookie parser missing, auth/voting routes not mounted.
   - Impact: protected routes remain open or broken; acceptance criteria unmet.

2) **Missing coverage for auth/login/logout.**
   - Evidence: QA notes TS/Vitest suites in `tests/api` and `server/tests` are not runnable; no automated coverage for login/logout/cookies/time-gate.
   - Impact: key acceptance criteria not verified.

3) **Missing dependencies and architectural drift.**
   - Evidence: review mentions `pg` dependency introduced while project uses Prisma; code duplication between `.js` and `.ts` persists.
   - Impact: build/runtime risk and inconsistent data access patterns.

4) **OpenAPI contract and behavior mismatches.**
   - Evidence: review mentions OpenAPI mismatches and missing expired-token cookie clearing.
   - Impact: API consumers/tests break; inconsistent auth semantics.

5) **Run-all test marker missing in test app.**
   - Evidence: QA infra issue says `tests/all.js` missing `MCODA_RUN_ALL_TESTS_COMPLETE`.
   - Impact: QA flags infra_issue even when tests pass.
