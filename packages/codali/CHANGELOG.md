# Changelog

## Unreleased

## 0.1.135-codali.43

- Shell safety: a command that changes a protected file now fails only that
  call, with the files named and how to prepare them; it no longer ends the
  session. Build output (`dist/`, `out/`, `coverage/`, generated files) inside
  a declared write path stays writable unless Git tracks it, declared output
  directories can be removed or renamed, and renaming a directory that holds
  protected source is refused. New files a command leaves next to its write
  path are moved to a quarantine directory outside the workspace (never
  deleted) and the error says how to restore them. Unreconciled conflicts are
  listed in the completion report.
- Numeric answers: a new `run_code` tool runs Python or JavaScript in the
  sandbox and returns stdout, stderr and the exit code; its successful output
  counts as executed evidence. Before a short numeric answer is delivered, each
  value is checked against this turn's executed results; unsupported or
  contradicted values get one reconcile turn. A computational request answered
  with nothing executed is sent back once to compute. The equation review now
  decides value by value from evidence and cannot replace a code-backed value
  or add unbacked precision. `calculate` accepts bracketed result lists,
  `pi()`, `math.*`, `round(x, n)` (Python rounding), `erf`/`normcdf`, labels in
  any order and up to 1000 statements, and refuses thousands separators such
  as `1,000`. Every `run_code` wait is bounded.
- Answer audits: research and design audits return targeted find/replace
  edits instead of rewriting the answer. An edit must match exactly once and
  never inside a link or code span. A research rewrite that is cut off or
  shrinks sharply is rejected. Figures the calculator confirmed are protected
  and re-checked after the audit; figure expressions carry units (including
  k/M/bn scales), conflicting statements are reported, stated targets are
  checked, and an explicit length limit in the request is respected.
- Model requests: a streaming request is judged by silence, so a live long
  generation is never cut; a gateway 504 keeps its token reservation.
- App builds: completion review runs in portions of at most eight checks, each
  approval citing receipt output or source text that shares content with the
  check; checks the time budget cannot cover are reported as unreviewed. The
  journey driver can reload the page and records console errors and failed
  requests (with an `allow` list); every role needs a reload-then-act step,
  form controls must be labelled, actions the requirements call "unavailable
  and explained" must show the reason, and durations stated in delivery
  documents must match a source setting. Delivery documents are written early.
- Tools: mixed gateway/native tool-call forms are unwrapped when unambiguous
  and rejections state the real problem. `verify_tests` accepts common test
  file names, reports zero executed tests as a failure, and carries the
  session's latest module into a test-only run (never shadowing the standard
  library). `start_work` is hidden when the session cannot change files.
- Browser: script-rendered pages are read after they render, collapsed
  sections behind a visible toggle are expanded and marked (capped), and an
  empty main region falls back to the page body. A findings-table row marked
  "not found" or "unconfirmed" counts as an open research point.

## 0.1.135-codali.42

- Interrupted research can resume from saved source passages and its draft
  with `/continue` or `codali resume`. Pending operations that may have
  changed workspace files still require reconciliation.
- A model outage can be retried for up to six hours, subject to the remaining
  turn time. Set `CODALI_MODEL_OUTAGE_WAIT_MS` to change the allowance.
  Retry delays respect the server's requested wait and leave time to deliver
  saved work. Optional working-style lookups return promptly when Docdex is offline.

- Model requests: every request now has a time allowance (ten minutes, or four
  times the slowest answered request, bounded by what the request could need,
  and doubled each time the same request stalls). A request that does not
  return is abandoned and retried on the outage path. A 12-hour build had
  finished its work and then waited 158 minutes on one review request.
- Research never ends with nothing: a research turn writes one full draft
  after 55% of its time. The points that draft leaves open ("could not be
  verified", "no official source was found") steer the remaining research, and
  the draft is what is delivered if the final answer cannot be written in
  time or the model service is down. A final draft that still admits open
  points is sent back to research while at least four minutes remain. When no
  draft exists, the pages read are listed with one excerpt of at most 25 words
  each, marked as evidence and not an answer. Sign-in, quota and request
  errors are reported as before.
- Web sources: `browser_open` reads PDF documents as text (downloaded with one
  plain GET, extracted offline in the sandbox, up to 96 MB). A page whose site
  refuses the automated browser (HTTP/2 or connection errors, timeouts,
  downloads) is read with one plain GET and its static HTML converted to
  text; the result says so. Name-resolution and certificate errors are not
  worked around.
- Context: the working context uses more of the model's window (output reserve
  15%, at least 16k tokens, at most 30%) and is trimmed in steps (from 90% of
  the input room down to 60%) instead of on almost every request.
- Calculations: `calculate` accepts named steps (`a = 2*3; b = a+4; b/2`), up
  to 64 statements or named formulas, later formulas that use earlier labels,
  inverse and hyperbolic functions, log2, cbrt, hypot, trunc and sign, and
  integers beyond 2^53 as rounded values with a warning. A name that replaces
  `e` or `pi` produces a warning. It remains a numeric grammar: no code runs.
- Calculations: the equation review of a short quantitative answer can no
  longer replace most of an answer that was worked out with calculation
  tools: a review that adds nulls, or changes two or more values and over half
  of them, is rejected. A single corrected value is still accepted.
- Tests: `verify_tests` with the python runner runs pytest-style tests (plain
  `test_` functions and `Test` classes, `pytest.raises`, `pytest.approx`,
  `pytest.mark.parametrize`) on the standard library. Fixtures, async tests
  and generator tests fail with a message that names them.
- Shell: `run_shell` takes `timeoutSeconds` (default 120, up to 900) for a full
  test suite, a build or a browser journey. A host can set a default
  (`shellTimeoutMs`) and a separate maximum (`shellMaxTimeoutMs`).
- Sandbox: the availability probe is retried with more time when it only ran
  out of time on a busy host, instead of reporting that user namespaces are
  unavailable.
- Completion check: review pages are 24,000 characters (were 8,000); a page
  requested again beside a new one is skipped instead of ending the review. A
  test run inside `bash -c` counts as validation when its steps are joined
  only by `&&` and nothing is expanded (`cd app && npm test 2>&1 | tail -40`);
  lines that can hide the exit status are refused.
- Tool calls: a lookup sent in the same batch as `start_work` or
  `final_answer` now runs; only the transition waits and is told to come alone.
- Answers: when the request explicitly asks for exactly one fenced code block
  and no prose, text around the single block is dropped and the block is kept
  unchanged. The runtime's own failed-test note is placed inside the block as
  a comment in its language.
- Web apps: the `webapp-testing` skill ships `journey-driver.mjs`, a
  dependency-free headless-Chrome driver (launch on a free port, goto, click,
  type, waits that report what the page shows, screenshot, startServer), with
  a recipe for running server, browser and steps in one shell call.
- Model routes: a route that served this process and then drops out of the
  catalog (for example while a node restarts) is now a temporary outage that
  the session waits out, instead of a final "no eligible route" error.
- Working style: Codali follows the user's working style (how they ask for
  work to be done, communicate and judge quality) from the local Docdex
  personal-preferences store through `docdex_working_style`. It is loaded once
  per session, ranks below the request, workspace instructions and repository
  facts, and never widens permissions. Codali keeps only short style lines in
  style categories at the lowest sensitivity, and drops personal context,
  contact details, secret-like values and links even if Docdex returns them.
  It is on by default and adds nothing when Docdex or the tool is unavailable.
  Turn it off with `docdex.workingStyle: false`, `CODALI_WORKING_STYLE=0` or
  the `workingStyle: false` session option. Benchmark sessions always turn it
  off.

## 0.1.135-codali.41

- Output: a request that explicitly asks for only JSON ("return only JSON",
  "respond with JSON only") now always gets bare JSON; a ```json fence around
  the answer is removed even when the extracted output contract said text.
- Research: the final evidence audit is shown the source passages behind each
  quote and specific figure in the draft first (budget 48,000 characters, up
  from 24,000), so verbatim, sourced claims are no longer relabelled as
  unverified because their passage was left out.
- Long answers: high and max effort allow 65,536 output tokens (was 8,192), so
  the consistency audit of a long design is no longer cut off and discarded.
- Long answers: derived figures in a long answer are listed as arithmetic
  expressions and evaluated by the calculator; the consistency audit gets the
  mismatches to correct, instead of rereading its own arithmetic.
- App builds: browser journeys must check the server state after each action
  (including logout), treat unexpected 4xx/5xx responses and console errors as
  failures, check that table rows match their headers and that every role
  action has a control; delivery notes may claim only checks that passed.
- Code answers: when the final code differs from the code of the session's
  last verify_tests run, the runtime runs the final code against that run's
  tests itself; if they fail, the model gets one repair round with the
  failures, or, without time for one, the answer states that the tests failed.
- Deadlines: the final answer call is bounded to half of the remaining window
  when a retry fits, so one stalled request no longer loses a finished
  investigation at the deadline.

## 0.1.135-codali.40

- Routing: a session that can neither write to the workspace nor run commands
  (no writing permission profile and no approver) no longer switches into
  execute mode; the model is told to deliver the answer directly. Four
  answer-only code requests had gone there and returned no code.
- Deadlines: when another model call cannot finish before the deadline, a
  finished code answer is delivered instead of being sent back for a
  code-drift repair or a test run; one such repair at 27 of 30 minutes had
  cost a complete answer.
- Research: web search and page tools now tell the model, within the 140
  characters it sees, to search first with one short query per sub-question
  and to open only URLs from results or page links; the browser's own "search
  first" advice was being cut off. A search-engine results page opened in the
  browser runs as a web search instead (cycle 4: 108 searches against the raw
  arm's 353, and 72 search-engine pages opened, often captchas or 403s).
- mcoda no longer asks for telemetry consent or registers with mswarm at
  install or first use, and collects no usage data (see the cli changelog).

## 0.1.135-codali.39

- Calculations: an answer whose every number came from a passing
  verify_javascript run is no longer rewritten by the tool-less equation
  review; one replaced a verified simulation with a wrong hand trace.
- Time: an answer keeps back time sized from its slowest model call (2.5x plus
  a minute, at least a tenth and at most half of the timeout) instead of a
  quarter of the timeout, which left 45-minute research turns idle for their
  last eight minutes.

## 0.1.135-codali.38

- Model outages: a turn waits out an outage for up to 30 minutes (the retry
  ladder, then a retry a minute), bounded by half the time it has left; the
  four-minute ladder alone lost a three-hour build to a nine-minute relay
  outage. Requests allowed more than 300 s no longer fail at 300 s without
  response headers (the platform fetch's default).
- Deadlines: continuation and answer audits start only when they can finish
  before the deadline and are stopped in time; if one fails or is stopped the
  finished draft is delivered. A research audit that got no reply had cost a
  complete answer.
- Research: web search is declared whenever page tools are, so a turn that
  opens pages can find them instead of guessing URLs and opening search-engine
  pages. The prompt states today's date from the host clock; one answer had
  dated itself months earlier and called the real dates suspect.
- Calculator: comb/C/nCr, perm/P/nPr and factorial.

## 0.1.135-codali.37 and earlier

- Sandbox: a relocated Python (a CI tool cache or a copied installation, whose
  binary records the library directory it was built for) finds its interpreter
  library; the loader path points only at libraries already mounted from the
  same installation. An interpreter alias is recreated as a link, not mounted
  as a copy. A tool runtime's virtual environment brings its own interpreter
  into the sandbox even when that interpreter is not on the current PATH.
- Long builds: history compaction saves each old step once and pages its
  index, instead of saving the whole earlier history again on every model
  call (452 MB of one 537 MB session log); appending a transcript event no
  longer re-reads the transcript, and transcripts are read record by record.
  A seven-hour build ended with "Invalid string length".
- The system prompt budget reserves a share of the window for output, not the
  whole output ceiling, and the active work contract is kept whole with the
  latest check output shortened first. A two-hour build ended with "exceed the
  context reservation" after one skill was applied.
- A host deadline (`deadlineAt`) reaches execution turns: work winds down
  shortly before it and ends with a status report instead of an empty answer.
- A temporary model-service outage is waited out after dispatch as well as
  before it (about four minutes), not retried for three seconds.
- Answers: a rewrite that is cut off, empty, a tool call, an echo of the audit
  input or far longer than its draft never replaces the draft, in every audit.
  An answer that stops at a server output cap is continued. The equation
  review no longer rewrites long designs; the consistency audit keeps concrete
  values, commits to labelled defaults instead of open items and rechecks
  derived figures. Answers do not mention drafts, audits or tool names.
- Research: page tools are declared whenever web search is, a printed call to a
  real but undeclared tool declares it, and printed calls no longer end an
  investigation that still has time. Links that appear in nothing retrieved are
  labelled; the audit cites only retrieved links and quotes only copied text.
- Docdex: a repository the daemon unmounted while idle is mounted again and
  the request resent, instead of failing every structural lookup.
- New-app builds: the request's input files are included whole when the window
  has room; the "no plan needed" shortcut is not shown when a plan is required;
  an over-long work brief is shortened, not refused; a declared output
  directory is created for shell checks; awk and other /etc/alternatives
  commands work in the sandbox; the failure diagnosis has room to finish.
- Specialists: one file per call with a clear message on failure. The mSwarm
  node no longer drops a local model call after 300 seconds without response
  headers.
- Token limits: a model alias resolves to a route that meets the configured
  context and output limits before one that advertises less (a capped pool cut
  answers at 8,192 tokens while 40,960 were requested); a request asks only
  for what its route advertises, and a reply that used its whole allowance is
  treated as possibly cut and continued. Fixed 2,048-token ceilings on direct
  answers, answer reviews and format repairs are gone, review evidence is
  sized with the shared output reserve, and the failure diagnosis and task
  review have room to finish.

- Windows: a file the session just wrote or read is recognised on the next
  edit; the record was keyed with backslashes and never matched, so every
  revision demanded a fresh read.
- Wait out a temporary model-service outage before the first dispatch (up to
  about four minutes) instead of ending the turn after one second.
- Shell scratch ($TMPDIR) persists between calls in a session; grep is allowed.
- New-app builds: a specialist can write a new file for the lead (targetPath,
  then write_file with draftId, or with corrected content); this is guidance,
  a large file typed directly is accepted. Files created in the running task
  skip structural analysis on revision; rm is allowed when the shell is
  confined to the claimed write paths.
- Reserve output for history sizing the same way as provider compression, so a
  large output ceiling no longer leaves a few thousand tokens of history and
  each file read evicts the last. Re-reading an evicted result is no longer a
  stall; a 5x backstop still ends a read loop.
- Consistency audit for long reasoned answers. Research audit prefers vendor
  release notes over stale aggregators, checks unexecuted code and fills every
  requested section. Turkish grounding rules.
- Pin playwright/playwright-core 1.64.1 workspace-wide; a fresh resolution
  pulled 1.65.0 through browser-use and broke the browser worker types.
- Windows: non-Git workspace inventories use POSIX-relative keys, so nested
  writes inside a claimed directory are no longer reported as out-of-scope
  changes; session state validation waits out files another process is deleting.
- Tests that need the isolated executor skip where it is unavailable, and the
  screenshot escape test no longer depends on /etc/hosts.

- Size retained execution history by the configured lead context rather than a
  fixed message count; resolve localhost in offline Linux tool sandboxes.
- Preserve original task inputs and recoverable execution history across trimming,
  compaction and resume; provide a truthful stopped-run handoff in the TUI.
- Select compatible model pools across shared aliases, refresh temporary health
  failures once, and send inference to the validated pool. Record its resolved ID.
- Detect repeated unchanged reads despite unrelated file discovery. Use the
  configured repair binding for bounded, metered diagnosis of repeated failures.
- Return actionable task-scope recovery instructions. Keep unprepared source
  read-only during broad shell setup while allowing scoped data/build outputs.
- Add isolated syntax-only feedback after JavaScript writes, private persistent
  package caches, exact calendar/text helpers and lossless JSON presentation repair.
- Preserve large file preimages and permit safe in-scope dependency hard links;
  protect original requirements from direct and shell writes.
- Explain per-call shell scratch lifetime and available commands on rejection.
  Include inspected implementation sources in recovery diagnoses.
- Bound shared Docdex diagnostic subprocesses so failed health discovery can return.
- Retain failed app-build diagnostics separately from later assisted continuations.
  These changes do not establish superiority over raw Qwen or complete-app readiness.

- Unify dispatch/tool/output contracts and validate final replies across modes.
  Add one budgeted, tool-free presentation repair, preserve execution evidence,
  and share the versioned dispatcher prompt with live evaluations. Legacy router
  prompts now supply semantic policy without replacing the response schema.
- Guide word-bound repairs toward an interior target while retaining exact user
  limits and the single-repair budget; keep failed drafts when validation fails.
- Add a structured, history-aware tool-scope decision and withhold optional
  calculation when the dispatcher does not explicitly allow tools. Preserve
  host restrictions and record scope conflicts. Fix local skill discovery when
  a workspace path resolves through platform aliases or symlinks.
- Record the separate 32-question regression and its prompt-template erratum;
  it does not demonstrate better intelligence than raw Qwen.

- Add native Docdex repository/web investigation, bounded browser snapshots,
  server time, progressive local skills with a bundled planning workflow, and
  readable TUI tables with narrow-screen layouts.
- Preserve user constraints through automatic context compression; keep archived
  content recoverable after resume/fork. Reserve final-answer capacity when
  Docdex performs nested inference, and retain plan-writing tools under budget pressure.
- Label web summaries and unvisited discovery links separately from fetched
  evidence. Preserve failed benchmark attempts; the original and R1 studies did
  not establish the required quality improvement over raw Qwen.

- Honor `interaction.answerBinding` for read-only inspections as well as explanations.

- Prepare codali.17 with history-aware interaction dispatch before repository
  execution. Greetings and questions no longer create coding tasks or reviewer
  loops; configured small-model prompts prepare bounded stronger-model requests.
- Record private redacted request/model-response/final-outcome audit events,
  preserve cumulative usage with bounded turn budgets, and remove transport
  metadata from repeated model context. Conversation metadata v2 prevents older
  clients from reinterpreting these sessions as coding jobs; v1 work sessions
  remain readable.
- Add mouse-wheel scrollback that stays anchored during streaming, readable tool
  activity and errors, and dedicated help/usage views. Preserve keyboard access,
  approval controls and terminal restoration.

- Retry transient Windows state-file replacement conflicts without deleting the
  previous state or suppressing permanent errors. Retain file durability checks.
- Resolve native macOS Git within the selected developer installation so sandboxed
  repository inspection works without launching the Xcode wrapper.

## 0.1.135-codali.3 - 2026-10-26

- Allow bounded Git diff/status inspection within the final validation budget;
  keep edits blocked and require actual test evidence before verifying code.
- Disable terminal echo before displaying the API-key prompt, preventing fast
  input from being echoed. Verify masked entry, backspace, cancellation, key
  rotation, logout, credential-cache refresh and bounded piped input.

- Tagged candidate; publication was cancelled after Windows CI exposed a
  transient state-file replacement failure addressed above.

## 0.1.135-codali.2 - 2026-10-26

- Keep core tool definitions available across task handoffs, while requiring a
  fresh task claim before execution. Record advertised tools for diagnosis.
- Explain stale verification with affected tasks and changed inputs so agents
  can revalidate existing work without replacing the plan.
- Preserve Windows workspace identity across short-path aliases and repair
  interrupted transcript tails. Retain mandatory file flushes on every platform.
- Resolve macOS Python native library dependencies within the shell sandbox,
  including Homebrew SSL libraries, without mounting broad installation roots.
- Internal validation prerelease for the `next` channel. Quality evaluation,
  consumer rollout and the 24-hour canary remain open promotion gates.

## 0.1.135-codali.1 - 2026-10-26

- Internal terminal CLI prerelease with mSwarm authentication, configuration-driven
  model roles and effort, durable goals and tasks, scoped permissions, asynchronous
  shell execution, session recovery, and interactive or JSONL operation.
- Add managed Docdex with verified runtime artifacts, pinned embedding identity,
  public embedding transport, memory persistence, and success/failure usage receipts.
- Add durable image, audio, and video jobs with artifact checksums and recovery.
- Preserve native Strata reasoning metadata and shared orchestration budgets;
  correct false worker-substitution diagnostics for embedded consumers.
- This tagged candidate was not published: platform qualification exposed
  macOS runtime and Windows persistence issues addressed in codali.2.

## 0.1.134 - 2026-10-25

- Forward final synthesis schemas and preserve OpenAI tool-call history.
- Merge prompt-only format constraints into the initial system message.
- Surface JSON error envelopes after HTTP 200 keepalives with bounded,
  credential-redacted diagnostics.
- Bound combined local worker tool results by UTF-8 bytes while preserving
  their audit records and truncation notices.

## Earlier changes

- Report the run's grounding mode on `CodaliResult`. An `open` run answers from
  the model and deliberately carries no sources, which a host could not tell
  apart from a search that found nothing: okacam's chat suppresses any answer
  that cites nothing, so it was refusing to return code it had been asked to
  write.
- Report every tool call the run made on `CodaliResult.toolCalls` - name,
  outcome and latency, without the model-generated arguments. Hosts previously
  had no way to record whether a question retrieved anything.
- Retrieve before asking a clarifying question, when there is something to
  retrieve. A tenant-scoped run holding the product's own connectors now plans
  and gathers evidence, and the classifier's question is put to the synthesizer
  with the evidence in front of it. A run with nothing but the code index still
  stops and asks. Measured cause: five of fifteen queries on okacam's
  2026-08-26 production smoke returned a question, having called no tool, for
  data other queries retrieved minutes later.
- Pin `@mcoda/db` and `@mcoda/shared` to concrete versions in the published
  manifest. 0.1.128 shipped `workspace:*` ranges, which npm rejects outside a
  workspace, so no consumer could install it; a published version cannot be
  replaced in place, so 0.1.129 is the fix.
- Initial public packaging for @mcoda/codali.
