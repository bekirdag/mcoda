# Progress

Published .29 before this work. Latest local user session found:6ee973fe-c60d-40a6-85b1-ac8574270723 in ~/apps/test, ending2026-11-04 11:43UTC with HTTP200 invalid_response after787231ms,24modelcalls,22toolcalls,413325estimated/reserved turn tokens. Several Docdex reads returned internal error; repeated context_read/read_file; write_file had no patch support despite recovery instruction. Asked user whether pasted intelligence tables identify another run.

Scope: Codali behavior, not implementation of GameHub or intelligence endpoints.

Implemented exact-match write_file search patches (unique nonempty match, literal replacement, existing permission/read/write scopes retained); recent-context retention before older history compaction; readable bounded sanitized TUI excerpts, search counts and empty results; actionable opaque Docdex read failures; output-limit/stream diagnostics and safe model_failure events. Delegation receipt31b4edf4-76f9-48aa-9a3a-9ff512fe1818 via qwen-latest-flash-next used for patch drafting; corrected suggested String.replace to literal slicing to protect dollar tokens. Docdex graph returned empty edges, so reviewed import/call sites directly.

Validation: build passed;145 focused regressions passed; real TUI PTY script passed. Full Codali suite and isolated live large-file/small-patch experiment running.

## Final validation, 2026-11-04

Implementation commit: f607c4d. Codali and mswarm builds passed. Full Codali suite: 1,990 passed, six platform skips, zero failures (1,996 total); focused regressions: 145 passed. Source and installed-preview PTY suites each passed 16 flows. Docdex pre-commit hook and whitespace checks passed.

Live interactive Qwen session 01d546a5-dea9-4ffe-b45a-56aad626c721 completed with accepted work_verify and work_complete receipts. It used an exact-match patch to fix twice in a 180-export fixture, preserved all other source bytes, and passed three node:test cases. This proves patch execution and verified completion, not acceptable efficiency: 436,926 ms, 22 model calls, 21 tool calls, and 171,957 reported turn tokens (accounting includes estimates/reservations; not confirmed provider billing). Broader intelligence and 1.5x efficiency targets remain unproven. Verification recognition and repeated planning/read overhead remain tuning work.

Earlier experiment harnesses used bounded headless/JSON mode or wrote a capture log inside the guarded workspace. Those attempts are not attributed to product regressions; the successful run used actual interactive mode and an external capture file. Evidence is retained under ~/.local/state/codali-run-recovery-evidence/interactive-isolated.log and the session transcript. Test process exited after completion.

Private installed preview: ~/.local/state/codali-run-recovery-preview/install/node_modules/@mcoda/codali; codali-preview now launches it using the existing preview configuration. It carries version .29 plus f607c4d fixes and is distinct from the published npm .29 artifact. The global released installation and npm tags are unchanged. Previous preview launcher retained at ~/.local/state/codali-run-recovery-preview/codali-preview.before.

The supplied intelligence tables contain no failure trace. The diagnosed local user session is identified above; implementing those endpoint/content/source plans was not inferred from the request to fix Codali.

## Exit feedback follow-up

User reported plain prompt with effort medium and bare exit sent to the lead model. Current ~/.local/bin/codali-preview explicitly selects effort low, so the reported launcher resolution is not established. Added exact case-insensitive bare exit/quit aliases in both interactive input handlers; multiline text and longer instructions remain prompts. Mandatory Docdex delegation receipt bb790995-c573-43fc-aae8-9800f7892770 used qwen-latest-flash-next; tightened draft trimming to horizontal whitespace only. Impact graph had no edges; symbols and direct handlers reviewed.

Build passed. Four real PTY cases passed against source and again against the exact installed launcher: TUI exit, TUI mixed-case quit, plain exit, plain quit; each exited zero with no model invocation, with TUI screen restoration. Installed TerminalCommand.js updated atomically, previous file retained as TerminalCommand.js.before-exit-fix. npm artifact unchanged. Full-path launch bypasses stale aliases/functions/command hashing; no unrelated suspended user process was terminated.

## Command names for local testing

User explicitly paused all new npm publishing. Raijin bare codali now launches the patched preview TUI; codali-cli exposes the same installed CLI for other commands. Previous global codali symlink preserved at ~/.local/state/codali-run-recovery-preview/codali.before-tui-launcher. Package bin metadata adds codali-cli alongside codali for eventual release; README documents both. Four PTY startup/exit cases passed through the exact codali launcher; codali-cli version and configuration validation passed. No npm publish or version change performed. Delegation receipt 29f8c2f1-3dc4-4696-84cf-d7ca648e830c reviewed the minimal bin alias.

## Human-readable discovery snippets

User reported raw tools_discover JSON in collapsed cards. TerminalPresentation now names the activity “Finding available tools”, summarizes complete discovery listings with a count and three bounded descriptions, and labels partial listings without inventing a count. tools_enable explains that schemas were prepared and permissions still apply. Generic malformed JSON is kept out of collapsed snippets; expanded details retain raw results. Delegation receipt b8fba7e6-b688-4b7a-8246-f2f1c612fee2 provided wording guidance. Docdex graph/symbol data was empty; inspected consumers and result producers directly.

Build and all 12 TerminalTui tests passed, including actual card events for complete and truncated discovery output. Installed formatter checks passed for complete, empty, truncated and enable results. Local installed TerminalPresentation.js updated atomically with backup; npm untouched.
Installed 16-flow real PTY regression also passed after the snippet update. Docdex pre-commit and whitespace checks passed.

## Suspended workspace owner

Lock c853645e-ef09-40f7-868f-e21fe0e9ee54 belonged to PID 1866463, an old planning-client-20261027af process stopped in ~/apps/test. Verified process identity, directory, stopped state and lock PID before terminating only that process; its transcript recorded no tool execution. Existing dead-owner acquisition/release recovered the lock without deleting session state or weakening writer exclusion.

TerminalCommand now registers and removes SIGTSTP with the same handler as SIGINT, so plain-terminal/external Ctrl+Z does not suspend an owner indefinitely. WorkspaceLock identifies Linux stopped owners and provides process/session details plus fg/stop/retry instructions; genuine live owners remain protected. Delegation receipt 12b96548-1d73-48a0-aae9-aa5afc310b10 reviewed the signal change; Docdex impact data was empty, direct caller inspection used.

Build and nine workspace-lock/artifact tests passed, including a real stopped child that cannot be evicted and recovery after its confirmed exit. Source PTY checks sent actual SIGTSTP to both TUI/plain clients and verified zero exit and screen restoration. Installed updated TerminalCommand.js and WorkspaceLock.js atomically with backups. npm publishing remains paused.
Installed SIGTSTP checks and the full 16-flow real PTY suite passed. Confirmed blocking PID no longer exists and ~/apps/test lock is absent. Docdex pre-commit and whitespace checks passed.

## Docdex recovery and continued execution

User explicitly authorized Codali to attempt Docdex recovery and continue without it if recovery fails. The startup LockBusy came from orphaned managed child PID1871447 (PPID1, private Codali runtime, exact ~/apps/test repo). Verified those properties before stopping only that orphan with SIGTERM; no index lock files or indexes were deleted.

ManagedDocdex now retries LockBusy once using a new instance and temporary repository index under its launch directory, keeping the original index/writer untouched. The recovery instance is owned and closed by its parent. Repeated failure does not recurse; cancellation propagates. SessionController catches managed startup and index-readiness failures, closes its owned process, unregisters unavailable Docdex tools, and gives the model and TUI an honest degraded-mode notice. prepare_edit can read source without claiming structural analysis; permissions, task claims, read-before-write and verification checks remain enforced. No paid/external daemon fallback is substituted.

Dependency/symbol inspection used Docdex; impact edges were empty. Delegation receipt 8f699a49-125d-4dec-aaad-b8e36df4f057 reviewed lifecycle/fallback boundaries. Build and 168 focused tests passed. A real Docdex integration test held one live index writer, started a competing managed instance, verified recovered symbols and continued original-writer access, then verified memory/embedding behavior; passed, not skipped. Fixture tests cover successful and failed bounded retry and startup/index fallback with actual controlled file preparation/patches, including rejected writes without prior reads.

Installed updated ManagedDocdex.js, SessionController.js and TerminalTui.js atomically with backups. Full regression and installed PTY validation running. npm publication remains explicitly paused.
Final validation: full suite 2,003 tests, 1,997 passed, six platform skips, zero failures; installed 16-flow PTY passed. Real Docdex collision integration separately passed with the configured private binary (not skipped). Confirmed orphan PID gone. Docdex pre-commit and whitespace checks passed.
