# Gateway Trio Log Issues (logs/2.txt)

## Run Details
- Log: `/Users/bekirdag/Downloads/logs/2.txt`
- Job ID: `4dee8866-4525-43df-bdc6-650ee6d882c9`

## Issues
1) **Gateway-trio progress appears stuck for long periods.**
   - Evidence: repeated `gateway-trio job ... running 0/10` spam near the start of the log (lines ~290+), and `running 1/10` loops later (around line ~52220).
   - Impact: `--watch` looks idle even while work is happening, which makes it hard to monitor progress.

2) **Work-on-tasks output frequently violates the patch/FILE format.**
   - Evidence: narrative change summaries emitted instead of diffs (around line ~52240) and repeated `Patch apply failed (No patches applied; all segments failed or were skipped.)` at lines ~44867, ~47608, ~67245, ~91669, ~107490, ~204891, ~251183.
   - Impact: tasks fail with `missing_patch` or patch failures and do not apply changes.

3) **Code review returns non-JSON after retry, causing hard blocks.**
   - Evidence: many `decision: block` entries with `summary: Review agent returned non-JSON output after retry` (e.g., around lines ~161069, ~182022, ~188437, ~200605, ~252825).
   - Impact: tasks are blocked even when work completed, requiring manual reruns with stricter review models.

4) **Docdex daemon/ollama unavailable during QA and review.**
   - Evidence: `docdexd check failed (ollama unreachable; memory/profile/dag/symbols lock errors...)` (around lines ~212368, ~212769) and `Docdex daemon could not start due to a global lock path outside the sandbox` (around line ~52246).
   - Impact: docdex searches, AST/impact analysis, and memory lookups are skipped; QA/review reports are degraded.

5) **QA reports infra issues due to missing Argon2 and skipped auth tests.**
   - Evidence: QA summary notes SKIP for auth/login tests and missing Argon2 (around line ~370717).
   - Impact: login/logout cookie flags and JWT issuance are not validated by automated tests.

6) **Run-all test harness missing `MCODA_RUN_ALL_TESTS_COMPLETE` marker.**
   - Evidence: QA failure `Run-all tests did not emit the expected marker... tests/all.js has no marker output` (around lines ~53522 and ~54468).
   - Impact: QA marks infra_issue even when unit tests pass.

7) **Integration suite skipped due to missing env and dependencies.**
   - Evidence: `tests/all.js` run shows integration suite skipped for missing `TEST_DB_URL`/`TEST_REDIS_URL` and missing `pg`/`ioredis` modules (around line ~52243).
   - Impact: DB/Redis-related coverage is absent during QA.

8) **Functional/security gaps detected in the project code.**
   - Evidence: QA infra_issue details list:
     - Suggestions endpoint not protected by JWT middleware.
     - Time-gating middleware defined but not applied to voting/suggestions.
     - Cookie parser not registered, so `req.cookies` is undefined.
     - Auth/voting routes not mounted in the main Express app.
     (around lines ~53522 and ~54468).
   - Impact: protected routes may be accessible without auth, and auth cookies may never be read.

9) **OpenAPI contract drift + behavior mismatches.**
   - Evidence: code review changes_requested details:
     - `/api/*` routes mounted but OpenAPI expects root paths.
     - Login response lacks `{ token }` expected by spec.
     - Expired token does not clear cookie.
     - Votes tests not aligned with new auth/timeGate wiring.
     (around line ~190400).
   - Impact: spec consumers may break; tests and behavior are inconsistent.

10) **Gateway agent lists concrete file paths without docdex evidence.**
    - Evidence: gateway output for `web-01-us-02-t02` lists `server/src/...` file paths while `docdexNotes` explicitly state no code search results were provided.
    - Impact: handoff paths are likely guesses, leading to wasted work or patch failures.

11) **Doc context is polluted with internal QA/e2e issue docs.**
    - Evidence: `Doc context` includes `docs/e2e-test-issues.md` and `docs/e2e-test-solutions.md` for non-doc tasks (around lines ~637, ~639, ~10541).
    - Impact: agents may drift into editing QA docs instead of implementing task code.

12) **Playwright CLI is missing during QA, causing MODULE_NOT_FOUND errors.**
    - Evidence: `Cannot find module '.../docdex@0.2.22/node_modules/playwright/cli.js'` and `code: 'MODULE_NOT_FOUND'` (around lines ~19593, ~21157).
    - Impact: QA browser tests cannot run; tasks remain blocked or require manual follow-up.

13) **Playwright test discovery reports “No tests found.”**
    - Evidence: QA follow-up task for `web-02-us-01-t01` references resolving a “No tests found” error (around lines ~26623).
    - Impact: e2e coverage isn’t executed even when QA tries to run it.

14) **Review/QA comments lack file/line attribution (`[untracked]`).**
    - Evidence: many review entries show `[untracked] (location not specified)` (e.g., around lines ~368459, ~368465).
    - Impact: work-on-tasks cannot map findings to code locations, weakening the feedback loop.

15) **CLI emits BrokenPipeError when output is redirected to file.**
    - Evidence: `Exception ignored while flushing sys.stdout: BrokenPipeError: [Errno 32] Broken pipe` near the end of the log (around lines ~21207, ~27010).
    - Impact: noisy termination and potential loss of log output when piping/redirecting.

16) **Docdex calls fail with missing repo context.**
    - Evidence: repeated `missing_repo: You failed to specify which repo to query.` (lines ~113, ~464, ~6590, ~9071, ~9997, ~10368, ~369273).
    - Impact: docdex queries do not execute, leading to empty context in gateway/review/QA decisions.

17) **Conflicting merge‑conflict instructions in prompts.**
    - Evidence: work guidance says “resolve conflicts” (around lines ~505) while reviewer guidance says “stop and report; do not attempt to merge” (around lines ~585).
    - Impact: agents receive contradictory instructions and may take destructive actions.

18) **TypeScript/Vitest test suites are not executed by the current runner.**
    - Evidence: QA notes indicate TS/Vitest suites under `tests/api` and `server/tests` are not runnable with current deps and are skipped from coverage (around line ~18781).
    - Impact: critical auth/login/logout and protected‑route tests are not validated.

19) **Work agents assume file paths despite “verify target paths” instruction.**
    - Evidence: agent output explicitly says “I will assume the standard structure” and edits `server/src/...` without confirming actual paths (around line ~1330+), then patch application fails.
    - Impact: work steps target non‑existent files and repeatedly fail to apply patches.

20) **`tests/all.js` exits after `.js` suites and never runs TypeScript/Vitest suites.**
    - Evidence: `tests/all.js:47` note that the runner exits after `.js` suites and never invokes the package test script/TS runner; repeated `Error: No tests found` plus review feedback referencing this (around lines ~26947, ~27914, ~62443).
    - Impact: server/integration `.ts` suites are never discovered, so QA’s “No tests found” error persists.

21) **Root `npm test` script only runs Node’s JS test glob.**
    - Evidence: `package.json:6` note that root `npm test` runs `tests/**/*.test.js`, leaving `tests/integration` and `server/src/services/__tests__` `.ts` files unexecuted (around lines ~26956, ~27923, ~62452).
    - Impact: adding TS tests doesn’t improve coverage; QA still reports missing tests.

22) **Docdex setup guidance conflicts (`docdexd daemon` vs `docdexd serve`).**
    - Evidence: prompt guidance includes both `docdexd daemon` and `docdexd serve` commands (around lines ~490, ~525).
    - Impact: agents may follow inconsistent setup steps and fail to connect to docdex.

23) **Patch-repair loop repeats without enforcing FILE-only output.**
    - Evidence: multiple `Return FILE blocks only for these paths` prompts after patch failures (lines ~44868, ~47609, ~67246, ~91670, ~107491, ~163830, ~204892, ~251184).
    - Impact: patch failures recur and tasks loop without producing valid file-only outputs.

24) **Progress ticker output interleaves with prompt/agent content.**
    - Evidence: repeated `gateway-trio job ... running 4/10` lines appear in the middle of doc context and just before agent JSON output (around lines ~26613–26622).
    - Impact: console output becomes noisy and risks corrupting streamed agent output parsing.

25) **Code-writer prompt is duplicated in agent input.**
    - Evidence: `# Code Writing Agent Prompt` block appears twice in succession (around lines ~470–510).
    - Impact: inflated prompt size, higher token usage, and potential instruction conflicts.

26) **Review comments are generated but not reliably injected into later agent runs.**
    - Evidence: code-review entries report `open_slugs: 3/6/11` (e.g., lines ~22725, ~46411, ~52002) while subsequent agent outputs state “no task comments provided.”
    - Impact: work-on-tasks cannot address review/QA feedback, causing repeat failures.

27) **SDS content still contains placeholders (`TBD`) but is used as primary context.**
    - Evidence: doc context excerpt includes `- TBD` in the SDS (around line ~26580).
    - Impact: tasks rely on incomplete specs, leading to guesswork and inconsistent implementations.

28) **Docdex prompt still advertises MCP tools despite the daemon‑only requirement.**
    - Evidence: the injected guidance lists MCP tools (`docdex_search`, `docdex_web_research`, `docdex_open`) alongside daemon CLI instructions (around lines ~430–520).
    - Impact: agents may attempt MCP calls or mixed workflows that are unsupported in this setup.

29) **Doc type classification is inconsistent in doc context.**
    - Evidence: `Doc context` labels `docs/pdr/test-web-app.md` as `[SDS]` (near the beginning of the log).
    - Impact: agents may treat product design docs as system design specs, skewing decisions.

30) **Review feedback generates follow‑up tasks instead of structured comment slugs.**
    - Evidence: code-review entries show `followups: web-01-us-01-t31, web-01-us-01-t32` (around lines ~22725, ~60487).
    - Impact: backlog grows and review feedback is harder to reconcile with the original task.

31) **Agent output duplication in stream.**
    - Evidence: the same “Implemented transactional voting...” block appears twice in succession (around line ~52240).
    - Impact: unnecessary token usage and potential confusion when parsing outputs.

32) **Docdex index goes stale without auto‑reindex or fallback.**
    - Evidence: review notes `symbols_reindex_required` and multiple `stale_index` warnings; reviews proceed based on diff/spec only (around lines ~46418, ~47581).
    - Impact: docdex code intelligence is unavailable, so reviews and plans are less reliable.

33) **QA triggers implicit Playwright installs via `npx`.**
    - Evidence: repeated `npm warn exec The following package was not found and will be installed: playwright@1.57.0` (around lines ~22323, ~23171).
    - Impact: QA uses ad‑hoc installs, which is slow, non‑deterministic, and may fail in restricted environments.

34) **Missing runtime dependencies surfaced during review.**
    - Evidence: code-review notes `server/package.json` missing `pg` and `ioredis` while VotingService imports them (around lines ~52003, ~52579).
    - Impact: app fails at runtime unless dependencies are explicitly declared.

35) **Security defaults regress: JWT secret fallback and mock user auth.**
    - Evidence: review calls out `JWT_SECRET` fallback to `"supersecret"` and login relying on in‑memory mock users (around line ~258592).
    - Impact: violates secure‑by‑default requirements and breaks real user login flow.

36) **Tech‑stack mismatch introduced by task work.**
    - Evidence: review highlights PollStateManager introducing `pg` usage while the project uses Prisma elsewhere (around line ~211923).
    - Impact: inconsistent data access layers and higher maintenance risk.

37) **Gateway handoff drops the `filesLikelyTouched/filesToCreate` lists.**
    - Evidence: gateway JSON lists explicit files, but the “Gateway Handoff” section prints `Files Likely Touched (none)` and `Files To Create (none)` (around line ~600–700).
    - Impact: work agents lose concrete file guidance and fall back to guessing paths.

38) **Gateway‑agent JSON‑only instructions leak into code‑writer runs.**
    - Evidence: the code‑writer input includes “You are the gateway agent… Return JSON only with the following schema” before the Code Writing Agent prompt (around line ~60–200).
    - Impact: conflicting output contracts (JSON vs patch/FILE), leading to non‑patch outputs and patch failures.

39) **Task runs auto‑merge into `dev` during gateway‑trio.**
    - Evidence: multiple task summaries show `Merge→dev: merged` (e.g., lines ~6467, ~37180, ~56631).
    - Impact: unreviewed changes land on `dev`, increasing conflict risk and breaking the “no merges during automation” requirement.

40) **Project guidance is not injected at the start of agent prompts.**
    - Evidence: `Project Guidance (read first)` appears after the docdex and prompt blocks (around line ~560+), not at the top of the agent input.
    - Impact: guidance can be truncated/ignored and violates the “prepend guidance” requirement.

41) **Doc context includes unrelated or duplicate project docs.**
    - Evidence: `Docdex context` lists `docs/sds/tl.md` and `docs/pdr/tl.md`, and excerpts mention `.mcoda/docs/sds/test-web-app.md` alongside `docs/sds/test-web-app.md` (around line ~260–290).
    - Impact: mixed specs and duplicate context increase confusion and spec drift.

42) **Work agents explicitly “simulate” docdex results instead of using tools.**
    - Evidence: agent output states it “cannot actually run a local daemon docdexd” and will simulate results (around line ~840–920).
    - Impact: fabricated context and file paths, undermining accuracy and tool‑usage requirements.

43) **Gateway agent repeatedly fails JSON schema validation.**
    - Evidence: repeated system prompts “Your previous response was incomplete or invalid. Return JSON only with the exact schema.” (e.g., lines ~40280, ~48850, ~62106, ~166618).
    - Impact: extra retries/latency and inconsistent gateway handoffs.

44) **Gateway schema validator expects a `files` field not in the documented schema.**
    - Evidence: validation error lists missing fields including `files` while also demanding `filesLikelyTouched/filesToCreate` (around line ~40280).
    - Impact: schema mismatch causes unnecessary retries even when the agent follows the prompt.

45) **Pseudo‑tasks with `[RUN]` prefix fail immediately with 0 tokens.**
    - Evidence: `Start Task ID: [RUN] web-01/web-01-us-01-t01` ends `STATUS FAILED` with `Tokens used: 0` and no agent output (around lines ~40310–40370).
    - Impact: gateway‑trio tries to execute non‑task placeholders or mis‑parsed task IDs, wasting cycles and failing silently.

46) **Path assumptions differ between gateway output and actual code layout.**
    - Evidence: gateway lists `src/server/...` files in `filesLikelyTouched` (near the start of the log), while later doc/review context references `server/src/...` paths (e.g., auth controller snippets around line ~6747).
    - Impact: edits target wrong directories, contributing to patch failures.

47) **Run‑all tests command is hard‑coded to a local absolute Node path.**
    - Evidence: task context shows `Run-all tests command: /opt/homebrew/Cellar/node/25.2.1/bin/node tests/all.js` (around line ~650).
    - Impact: non‑portable instructions break on CI/Windows/other machines and can cause QA to fail unexpectedly.

48) **Review‑spawned tasks inherit unrelated story acceptance criteria.**
    - Evidence: task `web-01-us-01-t32` (OpenAPI examples) is created from a code‑review finding, but its acceptance criteria are for registration domain/admin/Argon2/redirect (around lines ~44830–44870).
    - Impact: tasks are mis‑scoped and require irrelevant behavior, confusing agents and slowing completion.

49) **Docdex returns “no matching documents” for explicit file targets.**
    - Evidence: for `openapi/mcoda.yaml` tasks, docdex reports `no matching documents found` even though the file path is specified in the task location (around lines ~42607–42636).
    - Impact: agents cannot retrieve the target file via docdex and proceed without file context, increasing patch failures.

50) **Gateway‑trio initially reports `running 0/0` before tasks are loaded.**
    - Evidence: log starts with `gateway-trio job ... running 0/0` then later shifts to `running 0/10` (line ~2 onward).
    - Impact: misleading progress reporting and harder monitoring in `--watch` mode.

51) **Doc context excerpts are corrupted/truncated.**
    - Evidence: docdex excerpt includes a dangling line `- \`.mcoda/docs/sds/test-web-app` without completion and cuts off mid‑paragraph (around lines ~252–280).
    - Impact: agents receive broken specs and may misinterpret requirements or assume missing files.

52) **Cross‑project file path contamination in tasks.**
    - Evidence: test‑web‑app task `web-01-us-01-t32` targets `openapi/mcoda.yaml` (around lines ~44830–44870), which is a mcoda repo path rather than a test‑web‑app artifact.
    - Impact: agents attempt to edit non‑existent or wrong‑repo files, causing patch failures and misdirected work.

53) **`docdex:` prefixed doc references are not resolved into actual file content.**
    - Evidence: task metadata lists `Related Documentation: docdex:docs/rfp.md, docdex:docs/sds/test-web-app.md` (around lines ~7047–7088), but these remain as raw tags in the task context.
    - Impact: agents cannot open referenced docs directly, reducing spec grounding and increasing guesswork.

54) **Non‑`[RUN]` tasks fail instantly with zero tokens.**
    - Evidence: task `web-01-us-02-t04` shows `STATUS FAILED` with `Tokens used: 0` (around lines ~144520–144535) and no agent output, despite being a normal task.
    - Impact: gateway‑trio marks tasks failed without any model attempt, wasting cycles and hiding provider/adapter failures.

55) **Completed tasks are re‑queued and later fail.**
    - Evidence: `web-01-us-02-t02` completes at line ~6456 but later fails at line ~51274; `web-01-us-02-t04` completes at line ~37169 and later fails at line ~52921.
    - Impact: task status is not stable across cycles, leading to redundant work and inconsistent reporting.

56) **Tasks can finish “COMPLETED_NO_CHANGES” after long runs.**
    - Evidence: `web-01-us-02-t03` ends as `COMPLETED_NO_CHANGES` after 46m (line ~187809) and `web-01-us-01-t14` after 12m (line ~269301).
    - Impact: gateway‑trio may treat tasks as done without code changes, masking incomplete work or stalled agents.

57) **Completed tasks are repeatedly re‑processed within the same run.**
    - Evidence: `web-02-us-02-t03` completes multiple times (lines ~121602, ~150982, ~177910, ~317559) and `web-01-us-02-t03` completes repeatedly (lines ~15267, ~155687, ~187809, ~209695, ~300019, ~348626).
    - Impact: status filtering/deduplication is broken, wasting cycles and inflating token usage.

58) **Gateway handoff fabricates code state without docdex evidence.**
    - Evidence: gateway output claims `VotingService.ts` already implements PG/Redis transaction logic, `VoteController.ts` calls it, and `schema.prisma` only defines User (around lines ~144520–144540), while docdex context contains only docs.
    - Impact: agents act on hallucinated repository state, leading to wrong edits and wasted iterations.

59) **Gateway prompt duplicates its own JSON schema/instructions.**
    - Evidence: the same “Return JSON only with the following schema” block appears twice within a single gateway input (lines ~137 and ~228).
    - Impact: bloated prompts, higher token usage, and increased risk of conflicting instruction parsing.

60) **SDS content contains meta “rewrite” notes and `.mcoda/docs` references.**
    - Evidence: doc excerpts repeatedly include lines like “`.mcoda/docs/sds/test-web-app.md` rewritten to match …” (e.g., lines ~267, ~6744, ~28596).
    - Impact: system design docs are polluted with internal tooling metadata, degrading spec quality and confusing agents.

61) **Agent prompts are duplicated within a single run.**
    - Evidence: “# Code Writing Agent Prompt” appears twice back‑to‑back in the same prompt block (lines ~480 and ~517), and the same pattern repeats across reviewer/QA prompts.
    - Impact: prompt bloat increases token usage and may cause conflicting instructions (different docdex guidance variants).

62) **Docdex guidance injects a JSON‑only output rule that conflicts with code‑writer/reviewer output contracts.**
    - Evidence: the docdex guidance block ends with “No prose, no analysis. Output JSON only.” immediately before the Code Writing Agent prompt (around lines ~120–140 and ~470).
    - Impact: agents may output JSON instead of patches or review text, causing `missing_patch`/invalid output failures.

63) **Doc context mislabels SDS content as OPENAPI.**
    - Evidence: `Docdex context` includes `- [OPENAPI] docs/sds/test-web-app.md` (around line ~10160).
    - Impact: agents may treat design narratives as API contracts, leading to incorrect assumptions and validation steps.

64) **Task plans still reference Jest even when the test runner has shifted.**
    - Evidence: gateway plan instructs `run npx jest --config server/jest.config.js` for poll state/time gate tests (around lines ~10203–10204).
    - Impact: inconsistent test commands cause failed or skipped validation and perpetuate “No tests found” issues.

65) **Route/entrypoint ambiguity causes inconsistent wiring.**
    - Evidence: tasks reference multiple overlapping files: `server/src/routes/votes.ts`, `server/src/routes/voteRoutes.ts`, and `server/src/routes/voting.ts`, plus both `server/src/app.ts` and `server/src/index.ts` as entrypoints (e.g., lines ~144520, ~40693).
    - Impact: agents wire middleware/routes to the wrong entrypoint or route file, leading to behavior drift and review churn.

66) **Review‑generated tasks lack sizing (SP 0).**
    - Evidence: several tasks show `SP 0` in status lines (e.g., `web-01-us-01-t32`, `web-01-us-01-t07`, `web-01-us-02-t15`).
    - Impact: task prioritization/complexity signals are missing, which can skew gateway agent selection and scheduling.

67) **Prompts still reference a local `.docdex/` directory.**
    - Evidence: code‑writer prompt says “Keep `.docdex/` out of VCS.” (around line ~490).
    - Impact: conflicts with the requirement to avoid creating `.docdex` in project workspaces.

68) **Inconsistent file naming/casing for poll/time‑gate components.**
    - Evidence: prompts reference `server/src/services/pollStateManager.ts`, `src/services/PollStateManager.ts`, `server/src/middleware/timeGate.ts`, `src/middleware/timeGating.ts`, and `server/src/middleware/pollWindow.ts` in different handoffs (around lines ~10203, ~18055, ~144520).
    - Impact: agents target different files or case‑mismatched paths, leading to edits on the wrong files or platform‑specific failures.

69) **Code-review jobs invoke the gateway-router planning agent before the reviewer runs.**
    - Evidence: under `Job: code-review`, the log shows `[agent-io] begin agent=gateway-router command=gateway-agent` followed by a gateway-style JSON plan output before the code-review prompt starts (around lines ~6720–6795).
    - Impact: extra model calls and latency, and potential confusion about which agent is responsible for review output.

70) **Docdex context misclassifies source files as SDS.**
    - Evidence: `Docdex context` lists `- [SDS] server/src/controllers/authController.ts` (around lines ~6735–6750).
    - Impact: agents may treat code files as design docs, leading to incorrect interpretation of context and review scope.

71) **Docdex setup guidance references conflicting daemon ports.**
    - Evidence: one block says `docdexd serve --port 46137` while another says `docdexd daemon --port 3210` in the same run (around lines ~490 and ~525).
    - Impact: agents may start or query the daemon on the wrong port, leading to `missing_repo`/no-context failures.

72) **Docdex context labels PDR docs as SDS.**
    - Evidence: `Docdex context` lists `- [SDS] docs/pdr/test-web-app.md` (around lines ~6739–6748).
    - Impact: agents may treat product requirements as system design, causing scope and contract drift.

73) **Gateway router planning output uses `discipline: qa` for code-review jobs.**
    - Evidence: under `Job: code-review`, the gateway router plan JSON sets `"discipline":"qa"` (around line ~6782).
    - Impact: if discipline is used for routing/scoring, review tasks may be misclassified or assigned to the wrong agent pool.

74) **Unexpected persona text is injected into the code-writer prompt.**
    - Evidence: lines like “Generate fast fixes and multiple draft options…” and “Energetic troubleshooter. Exploratory but disciplined, offers options clearly.” appear directly before `# Code Writing Agent Prompt` (around lines ~470–480).
    - Impact: prompt contamination can conflict with role-specific guidance and increase output variance or policy drift.

75) **Test runs fail due to missing Jest runtime dependencies.**
    - Evidence: repeated `Error: Cannot find module '@jest/globals'` after `No tests found` (around lines ~73399, ~82954, ~91652, ~97101).
    - Impact: any Jest-based suites will hard-fail in QA, compounding “No tests found” and masking real coverage gaps.
