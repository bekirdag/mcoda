# Changelog

## Unreleased

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
