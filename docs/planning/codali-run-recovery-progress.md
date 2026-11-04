# Progress

Published .29 before this work. Latest local user session found:6ee973fe-c60d-40a6-85b1-ac8574270723 in ~/apps/test, ending2026-11-04 11:43UTC with HTTP200 invalid_response after787231ms,24modelcalls,22toolcalls,413325estimated/reserved turn tokens. Several Docdex reads returned internal error; repeated context_read/read_file; write_file had no patch support despite recovery instruction. Asked user whether pasted intelligence tables identify another run.

Scope: Codali behavior, not implementation of GameHub or intelligence endpoints.

Implemented exact-match write_file search patches (unique nonempty match, literal replacement, existing permission/read/write scopes retained); recent-context retention before older history compaction; readable bounded sanitized TUI excerpts, search counts and empty results; actionable opaque Docdex read failures; output-limit/stream diagnostics and safe model_failure events. Delegation receipt31b4edf4-76f9-48aa-9a3a-9ff512fe1818 via qwen-latest-flash-next used for patch drafting; corrected suggested String.replace to literal slicing to protect dollar tokens. Docdex graph returned empty edges, so reviewed import/call sites directly.

Validation: build passed;145 focused regressions passed; real TUI PTY script passed. Full Codali suite and isolated live large-file/small-patch experiment running.
