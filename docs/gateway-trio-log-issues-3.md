# Gateway Trio Log Issues (Run 3)

## Run Summary
- Command: `node packages/cli/dist/bin/McodaEntrypoint.js gateway-trio --workspace-root /Users/bekirdag/Documents/apps/test-web-app --project test-web-app --status not_started,in_progress --limit 10 --qa-allow-dirty true`
- Log capture: `logs/gateway-trio-run-3.txt`
- Resume hint in log: `mcoda gateway-trio --resume c898f625-5ea7-45ad-bb1a-2cea8f6770a4`
- Run did not complete within 10 minutes (command timed out in the harness).

## Mcoda Issues
- Docdex repo path in gateway output points to the mcoda workspace, not the target workspace.
  - Evidence: gateway plan/docdex notes reference `--repo /Users/bekirdag/Documents/apps/mcoda` instead of `/Users/bekirdag/Documents/apps/test-web-app`.
  - Impact: agents search the wrong repo and miss code/doc context, leading to follow-up failures and docdex errors.
  - Fix idea: ensure docdex repo passed to gateway/agent prompts uses the resolved workspace root (and/or repo id) from the command flags, not `process.cwd()`.
- Gateway agent schema mismatch on initial plan response.
  - Evidence: `Missing fields: summary, reasoningSummary, currentState, todo, understanding, plan, filesLikelyTouched, filesToCreate.`
  - Impact: extra retry loop and possible agent confusion; longer task cycles.
  - Fix idea: tighten schema enforcement earlier (reject and repair with a stricter JSON-only model), or add a preflight “schema check” before accepting the response.
- Review agent returned non-JSON output after retry.
  - Evidence: `Review agent returned non-JSON output after retry; block review and re-run with a stricter JSON-only model.`
  - Impact: review flow blocks tasks even when work might be correct.
  - Fix idea: force stricter JSON-only model on review retries, and/or add a second repair pass before blocking.
- Docdex CLI usage missing repo context in agent execution.
  - Evidence: repeated `missing_repo: You failed to specify which repo to query.`
  - Impact: docdex search fails, which cascades into weak planning/testing guidance.
  - Fix idea: inject `DOCDEX_REPO` (or `DOCDEX_HTTP_BASE_URL` + repo id) into agent env, and explicitly include `--repo <workspaceRoot>` in all docdex CLI examples.

## Docdex Issues (requires docdex repo fixes)
- Docdex daemon startup/ollama unavailable on the test host.
  - Evidence: `docdexd check reported ollama unreachable; docdexd chat/index/impact-diagnostics failed with connection errors to http://127.0.0.1:3210/3211; /tmp/docdexd-test-web-app.log shows startup_state_invalid/startup_daemon_locked.`
  - Impact: docdex search/impact/memory commands fail; QA and review lose doc-based validation.
  - Fix idea: resolve daemon lock/startup state, confirm ollama reachable, and retry docdexd with a clean state dir.

## Project/Test-App Issues (test-web-app)
- Missing Argon2 dependency causes auth-related tests to skip.
  - Evidence: QA notes show SKIP for login/cookie tests due to missing Argon2.
  - Impact: QA marks infra_issue; auth acceptance criteria remain unverified.
  - Fix idea: install/configure Argon2 (or adjust tests to avoid skip) in the test app.
- Test runner does not execute TS supertest tests.
  - Evidence: QA report flags “TS supertest tests are not run by the current test runner.”
  - Impact: API/integration coverage is incomplete despite “all tests passed” output.
  - Fix idea: ensure tests are compiled or run via a TS-compatible runner, and update the test command to include them.

## Comparison vs `docs/gateway-trio-log-issues-2.md`
- Still present: review non-JSON outputs (Issue #3), docdex daemon unavailable (Issue #4), missing Argon2/skipped auth tests (Issue #5), missing repo in docdex calls (Issue #16).
- Newly observed or clarified: docdex repo path in prompts points to the mcoda workspace instead of the target workspace (new).
- Not observed in this run: patch/FILE failures, auto-merge to dev, prompt duplication, watch progress spam (may require a full `--watch` run to confirm).
