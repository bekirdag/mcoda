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
