# Benchmark log evidence for Codali issue audit

All ten event logs were parsed. This appendix records every failed/rejected tool receipt, grouped by project, tool and exact first error line. A failed receipt is not automatically a product bug. Native checks were not rerun; this is a read-only evidence audit.

| Project | Event lines | Tool receipts | Failed/rejected | Stall warnings |
|---|---:|---:|---:|---:|
| app-01-web-codali_candidate | 1486 | 104 | 25 | 0 |
| app-01-web-raw_tools | 192 | 50 | 8 | 0 |
| app-02-desktop-codali_candidate | 1621 | 112 | 52 | 0 |
| app-02-desktop-raw_tools | 116 | 35 | 7 | 0 |
| app-03-ios-codali_candidate | 1536 | 123 | 25 | 5 |
| app-03-ios-raw_tools | 231 | 59 | 23 | 0 |
| app-04-ios-game-codali_candidate | 1757 | 111 | 29 | 5 |
| app-04-ios-game-raw_tools | 185 | 47 | 7 | 0 |
| app-05-android-codali_candidate | 1075 | 73 | 23 | 0 |
| app-05-android-raw_tools | 161 | 43 | 8 | 0 |

## LOG-001: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `Claim a ready work task with work_claim before side effects, including read-only shell checks. Use work_status to inspect ready tasks; retain their existing contracts and implementation.`.

Receipts: [65](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:65).

## LOG-002: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: which`.

Receipts: [114](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:114).

## LOG-003: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: gcc`.

Receipts: [130](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:130).

## LOG-004: app-01-web-codali_candidate / work_refine
Count: 2. First error line: `Finish the current attempt or call work_release with its taskId and attemptId before replacing the plan`.

Receipts: [183](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:183), [692](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:692).

## LOG-005: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `Shell write path is outside the claimed task scope`.

Receipts: [246](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:246).

## LOG-006: app-01-web-codali_candidate / run_shell
Count: 3. First error line: `Create the scoped directory/file with write_file before shell execution`.

Receipts: [300](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:300), [316](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:316), [348](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:348).

## LOG-007: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `npm ERR! code EROFS`.

Receipts: [366](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:366).

## LOG-008: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `File changed or has not been read; read backend/node_modules/accepts/index.js before editing. Call prepare_edit with path "backend/node_modules/accepts/index.js" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [396](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:396).

## LOG-009: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `npm ERR! code ENOENT`.

Receipts: [414](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:414).

## LOG-010: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: test`.

Receipts: [469](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:469).

## LOG-011: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `sh: 1: cd: can't cd to /tmp/hd`.

Receipts: [525](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:525).

## LOG-012: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `IMPORT_ERR Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/wodo/.local/state/codali/evaluation-workspaces/run-yKXDcX/workspace/backend/backend/src/index.js' imported from /home/wodo/.local/state/codali/evaluation-workspaces/run-yKXDcX/workspace/backend/[eval]`.

Receipts: [561](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:561).

## LOG-013: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `ERR Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/wodo/.local/state/codali/evaluation-workspaces/run-yKXDcX/workspace/backend/src/index.js' imported from /home/wodo/.local/state/codali/evaluation-workspaces/run-yKXDcX/workspace/backend/[eval]`.

Receipts: [578](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:578).

## LOG-014: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `ls: cannot access 'backend/src': No such file or directory`.

Receipts: [596](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:596).

## LOG-015: app-01-web-codali_candidate / work_refine
Count: 1. First error line: `Uncovered requirement: R1. Link this existing ID in task.requirementIds rather than inventing a replacement. Put whole-request R1 on the final integration task.`.

Receipts: [722](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:722).

## LOG-016: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: find`.

Receipts: [827](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:827).

## LOG-017: app-01-web-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read backend/src/markdown.js before editing. Call prepare_edit with path "backend/src/markdown.js" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [1026](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:1026).

## LOG-018: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `ls: cannot access 'backend/tests': No such file or directory`.

Receipts: [1059](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:1059).

## LOG-019: app-01-web-codali_candidate / work_claim
Count: 1. First error line: `Inline scope is only available for the initial unscoped task; use work_release/work_plan for later changes. Current owner: taskId="T2", attemptId="ebe0ab6b-4043-4785-bc74-7c964bdca3ab". Continue and verify that attempt, or call work_release with these exact IDs and a note before claiming another task. A rejected review leaves this owner active; work_claim does not replace it.`.

Receipts: [1199](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:1199).

## LOG-020: app-01-web-codali_candidate / read_file
Count: 1. First error line: `ENOENT: no such file or directory, open '/home/wodo/.local/state/codali/evaluation-workspaces/run-yKXDcX/workspace/backend/src/migrate.js'`.

Receipts: [1230](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:1230).

## LOG-021: app-01-web-codali_candidate / list_files
Count: 1. First error line: `ENOENT: no such file or directory, scandir '/home/wodo/.local/state/codali/evaluation-workspaces/run-yKXDcX/workspace/backend/tests'`.

Receipts: [1266](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:1266).

## LOG-022: app-01-web-codali_candidate / run_shell
Count: 1. First error line: `Remaining budget is reserved for verification; checkpoint unfinished work or increase the effort budget`.

Receipts: [1477](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:1477).

## LOG-023: app-01-web-raw_tools / docdex_open
Count: 2. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [6](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:6), [8](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:8).

## LOG-024: app-01-web-raw_tools / docdex_search
Count: 1. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [14](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:14).

## LOG-025: app-01-web-raw_tools / run_shell
Count: 1. First error line: `npm ERR! code ENOENT`.

Receipts: [38](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:38).

## LOG-026: app-01-web-raw_tools / run_shell
Count: 1. First error line: `Command not allowed: mkdir`.

Receipts: [42](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:42).

## LOG-027: app-01-web-raw_tools / run_shell
Count: 1. First error line: `file:///home/wodo/.local/state/codali/evaluation-workspaces/run-K8fUQt/workspace/server/src/db.js:12`.

Receipts: [130](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:130).

## LOG-028: app-01-web-raw_tools / run_shell
Count: 1. First error line: `file:///home/wodo/.local/state/codali/evaluation-workspaces/run-K8fUQt/workspace/server/src/db.js:18`.

Receipts: [138](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:138).

## LOG-029: app-01-web-raw_tools / run_shell
Count: 1. First error line: `Destructive operation blocked by policy`.

Receipts: [158](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:158).

## LOG-030: app-02-desktop-codali_candidate / work_refine
Count: 1. First error line: `Cannot replace existing requirement R1; use a new criterion ID`.

Receipts: [75](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:75).

## LOG-031: app-02-desktop-codali_candidate / work_plan
Count: 3. First error line: `Finish the current attempt or call work_release with its taskId and attemptId before replacing the plan`.

Receipts: [163](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:163), [751](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:751), [1156](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1156).

## LOG-032: app-02-desktop-codali_candidate / write_file
Count: 11. First error line: `File is outside the claimed task scope`.

Receipts: [247](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:247), [687](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:687), [692](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:692), [697](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:697), [711](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:711), [716](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:716), [721](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:721), [779](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:779), [932](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:932), [1098](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1098), [1127](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1127).

## LOG-033: app-02-desktop-codali_candidate / stat_path
Count: 1. First error line: `ENOENT: no such file or directory, stat '/home/wodo/.local/state/codali/evaluation-workspaces/run-Jx27NZ/workspace/src/shared/ipc.ts'`.

Receipts: [270](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:270).

## LOG-034: app-02-desktop-codali_candidate / run_shell
Count: 12. First error line: `Shell write path is outside the claimed task scope`.

Receipts: [284](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:284), [494](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:494), [568](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:568), [582](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:582), [643](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:643), [657](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:657), [765](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:765), [904](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:904), [918](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:918), [978](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:978), [1007](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1007), [1021](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1021).

## LOG-035: app-02-desktop-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read .gitignore before editing. Call prepare_edit with path ".gitignore" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [352](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:352).

## LOG-036: app-02-desktop-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read package.json before editing. Call prepare_edit with path "package.json" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [392](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:392).

## LOG-037: app-02-desktop-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: find`.

Receipts: [423](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:423).

## LOG-038: app-02-desktop-codali_candidate / list_files
Count: 1. First error line: `ENOENT: no such file or directory, scandir '/home/wodo/.local/state/codali/evaluation-workspaces/run-Jx27NZ/workspace/src'`.

Receipts: [438](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:438).

## LOG-039: app-02-desktop-codali_candidate / stat_path
Count: 1. First error line: `ENOENT: no such file or directory, stat '/home/wodo/.local/state/codali/evaluation-workspaces/run-Jx27NZ/workspace/node_modules'`.

Receipts: [459](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:459).

## LOG-040: app-02-desktop-codali_candidate / work_release
Count: 1. First error line: `Cannot release a stale or inactive task attempt`.

Receipts: [509](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:509).

## LOG-041: app-02-desktop-codali_candidate / run_shell
Count: 9. First error line: `Create the scoped directory/file with write_file before shell execution`.

Receipts: [673](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:673), [1037](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1037), [1069](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1069), [1272](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1272), [1304](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1304), [1320](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1320), [1498](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1498), [1530](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1530), [1562](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1562).

## LOG-042: app-02-desktop-codali_candidate / run_shell
Count: 1. First error line: `npm ERR! code ENOENT`.

Receipts: [797](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:797).

## LOG-043: app-02-desktop-codali_candidate / write_file
Count: 1. First error line: `Claim a ready work task with work_claim before side effects, including read-only shell checks. Use work_status to inspect ready tasks; retain their existing contracts and implementation.`.

Receipts: [843](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:843).

## LOG-044: app-02-desktop-codali_candidate / work_claim
Count: 1. First error line: `Inline scope is only available for the initial unscoped task; use work_release/work_plan for later changes. No task is currently claimed. Inspect work_status and work_claim a ready task before verification.`.

Receipts: [875](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:875).

## LOG-045: app-02-desktop-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: mkdir`.

Receipts: [1053](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1053).

## LOG-046: app-02-desktop-codali_candidate / stat_path
Count: 1. First error line: `ENOENT: no such file or directory, stat '/home/wodo/.local/state/codali/evaluation-workspaces/run-Jx27NZ/workspace/.npm-cache'`.

Receipts: [1084](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1084).

## LOG-047: app-02-desktop-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read .npmrc before editing. Call prepare_edit with path ".npmrc" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [1141](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1141).

## LOG-048: app-02-desktop-codali_candidate / run_shell
Count: 2. First error line: `Destructive operation blocked by policy`.

Receipts: [1256](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1256), [1353](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1353).

## LOG-049: app-02-desktop-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: curl`.

Receipts: [1465](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:1465).

## LOG-050: app-02-desktop-raw_tools / docdex_open
Count: 2. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [6](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/receipts/events.jsonl:6), [8](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/receipts/events.jsonl:8).

## LOG-051: app-02-desktop-raw_tools / docdex_search
Count: 1. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [12](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/receipts/events.jsonl:12).

## LOG-052: app-02-desktop-raw_tools / run_shell
Count: 1. First error line: `Command not allowed: which`.

Receipts: [40](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/receipts/events.jsonl:40).

## LOG-053: app-02-desktop-raw_tools / run_shell
Count: 1. First error line: `Command not allowed: ldd`.

Receipts: [46](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/receipts/events.jsonl:46).

## LOG-054: app-02-desktop-raw_tools / run_shell
Count: 2. First error line: `bwrap: execvp rg: No such file or directory`.

Receipts: [52](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/receipts/events.jsonl:52), [54](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/receipts/events.jsonl:54).

## LOG-055: app-03-ios-codali_candidate / work_refine
Count: 1. First error line: `Cannot replace existing requirement R1; use a new criterion ID`.

Receipts: [98](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:98).

## LOG-056: app-03-ios-codali_candidate / run_shell
Count: 3. First error line: `Command not allowed: which`.

Receipts: [167](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:167), [1311](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1311), [1318](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1318).

## LOG-057: app-03-ios-codali_candidate / run_shell
Count: 3. First error line: `Command not allowed: swift`.

Receipts: [183](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:183), [730](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:730), [1334](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1334).

## LOG-058: app-03-ios-codali_candidate / run_shell
Count: 2. First error line: `Command not allowed: xcodegen`.

Receipts: [214](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:214), [1341](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1341).

## LOG-059: app-03-ios-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read TrailLedger/Models/Money.swift before editing. Call prepare_edit with path "TrailLedger/Models/Money.swift" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [260](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:260).

## LOG-060: app-03-ios-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read TrailLedger/Models/Expense.swift before editing. Call prepare_edit with path "TrailLedger/Models/Expense.swift" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [406](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:406).

## LOG-061: app-03-ios-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read TrailLedger/Models/ShareRecord.swift before editing. Call prepare_edit with path "TrailLedger/Models/ShareRecord.swift" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [478](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:478).

## LOG-062: app-03-ios-codali_candidate / read_file
Count: 1. First error line: `ENOENT: no such file or directory, open '/home/wodo/.local/state/codali/evaluation-workspaces/run-737aPg/workspace/TrailLedger/Models/ExchangeRateStore.swift'`.

Receipts: [620](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:620).

## LOG-063: app-03-ios-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: which swift swiftc xcodebuild 2>/dev/null; swift --version 2>/dev/null | head -3; echo "---swiftc---"; swiftc --version 2>/dev/null | head -3`.

Receipts: [693](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:693).

## LOG-064: app-03-ios-codali_candidate / run_shell
Count: 3. First error line: `Command not allowed: grep`.

Receipts: [746](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:746), [1160](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1160), [1425](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1425).

## LOG-065: app-03-ios-codali_candidate / read_file
Count: 1. First error line: `ENOENT: no such file or directory, open '/home/wodo/.local/state/codali/evaluation-workspaces/run-737aPg/workspace/TrailLedger/Models/CanonicalInput.swift'`.

Receipts: [1060](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1060).

## LOG-066: app-03-ios-codali_candidate / read_file
Count: 1. First error line: `ENOENT: no such file or directory, open '/home/wodo/.local/state/codali/evaluation-workspaces/run-737aPg/workspace/TrailLedger/Models/ImportIssues.swift'`.

Receipts: [1066](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1066).

## LOG-067: app-03-ios-codali_candidate / list_files
Count: 1. First error line: `ENOENT: no such file or directory, scandir '/home/wodo/.local/state/codali/evaluation-workspaces/run-737aPg/workspace/TrailLedgerUITests'`.

Receipts: [1166](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1166).

## LOG-068: app-03-ios-codali_candidate / run_shell
Count: 2. First error line: `bwrap: execvp rg: No such file or directory`.

Receipts: [1183](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1183), [1442](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1442).

## LOG-069: app-03-ios-codali_candidate / list_files
Count: 1. First error line: `ENOENT: no such file or directory, scandir '/home/wodo/.local/state/codali/evaluation-workspaces/run-737aPg/workspace/TrailLedger/Views'`.

Receipts: [1189](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1189).

## LOG-070: app-03-ios-codali_candidate / run_shell
Count: 1. First error line: `Destructive operation blocked by policy`.

Receipts: [1289](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1289).

## LOG-071: app-03-ios-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read TrailLedger/Services/ExpenseMath.swift before editing. Call prepare_edit with path "TrailLedger/Services/ExpenseMath.swift" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [1508](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1508).

## LOG-072: app-03-ios-raw_tools / docdex_open
Count: 2. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [6](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:6), [8](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:8).

## LOG-073: app-03-ios-raw_tools / docdex_search
Count: 1. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [12](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:12).

## LOG-074: app-03-ios-raw_tools / docdex_diary_read
Count: 1. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [28](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:28).

## LOG-075: app-03-ios-raw_tools / run_shell
Count: 1. First error line: `bash: line 1: cd: /tmp/swift: No such file or directory`.

Receipts: [52](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:52).

## LOG-076: app-03-ios-raw_tools / run_shell
Count: 1. First error line: `Process deadline exceeded`.

Receipts: [88](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:88).

## LOG-077: app-03-ios-raw_tools / run_shell
Count: 1. First error line: `mkdir: Read-only file system`.

Receipts: [96](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:96).

## LOG-078: app-03-ios-raw_tools / run_shell
Count: 1. First error line: `bash: line 1: cd: /tmp/proj: No such file or directory`.

Receipts: [100](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:100).

## LOG-079: app-03-ios-raw_tools / run_shell
Count: 1. First error line: `Missing required argument`.

Receipts: [104](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:104).

## LOG-080: app-03-ios-raw_tools / run_shell
Count: 12. First error line: `Destructive operation blocked by policy`.

Receipts: [108](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:108), [128](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:128), [140](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:140), [144](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:144), [148](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:148), [152](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:152), [156](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:156), [176](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:176), [184](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:184), [196](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:196), [204](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:204), [228](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:228).

## LOG-081: app-03-ios-raw_tools / run_shell
Count: 1. First error line: `bash: line 10: ./.build/debug/probe: No such file or directory`.

Receipts: [216](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:216).

## LOG-082: app-03-ios-raw_tools / run_shell
Count: 1. First error line: `bash: line 1: cd: /tmp/rnd: No such file or directory`.

Receipts: [220](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:220).

## LOG-083: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `swift: MISSING`.

Receipts: [132](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:132).

## LOG-084: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `head: cannot open '/etc/os-release' for reading: No such file or directory`.

Receipts: [283](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:283).

## LOG-085: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `sh: 1: cd: can't cd to /tmp/home/swift-dl`.

Receipts: [373](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:373).

## LOG-086: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `tar (child): /tmp/swift-dl/swift.tar.gz: Cannot open: No such file or directory`.

Receipts: [408](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:408).

## LOG-087: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: which`.

Receipts: [523](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:523).

## LOG-088: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `ls: cannot access '/etc/os-release': No such file or directory`.

Receipts: [598](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:598).

## LOG-089: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: mkdir`.

Receipts: [614](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:614).

## LOG-090: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `cat: /etc/os-release: No such file or directory`.

Receipts: [726](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:726).

## LOG-091: app-04-ios-game-codali_candidate / run_shell
Count: 2. First error line: `Destructive operation blocked by policy`.

Receipts: [852](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:852), [1053](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1053).

## LOG-092: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `sh: 1: cd: can't cd to /tmp/work/harvest`.

Receipts: [913](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:913).

## LOG-093: app-04-ios-game-codali_candidate / run_shell
Count: 2. First error line: `Shell cwd is not an accessible existing directory`.

Receipts: [964](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:964), [980](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:980).

## LOG-094: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `python3: can't open file '/home/wodo/.local/state/codali/evaluation-workspaces/run-f8Duyk/workspace/tools/vendor/harvest_dashboard.py': [Errno 2] No such file or directory`.

Receipts: [999](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:999).

## LOG-095: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `ls: cannot access 'tools': No such file or directory`.

Receipts: [1037](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1037).

## LOG-096: app-04-ios-game-codali_candidate / run_shell
Count: 3. First error line: `Create the scoped directory/file with write_file before shell execution`.

Receipts: [1069](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1069), [1101](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1101), [1149](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1149).

## LOG-097: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `python3: can't open file '/home/wodo/.local/state/codali/evaluation-workspaces/run-f8Duyk/workspace/tools_harvest/harvest_dashboard.py': [Errno 2] No such file or directory`.

Receipts: [1183](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1183).

## LOG-098: app-04-ios-game-codali_candidate / run_shell
Count: 2. First error line: `Command not allowed: find`.

Receipts: [1199](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1199), [1728](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1728).

## LOG-099: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `ls: cannot access 'tools_harvest': No such file or directory`.

Receipts: [1217](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1217).

## LOG-100: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: swift`.

Receipts: [1312](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1312).

## LOG-101: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `File changed or has not been read; read tools/vendor/harvest_dashboard.py before editing. Call prepare_edit with path "tools/vendor/harvest_dashboard.py" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [1343](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1343).

## LOG-102: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `== binutils ==`.

Receipts: [1528](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1528).

## LOG-103: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: curl`.

Receipts: [1640](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1640).

## LOG-104: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: wget`.

Receipts: [1695](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1695).

## LOG-105: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `  File "<string>", line 1`.

Receipts: [1712](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1712).

## LOG-106: app-04-ios-game-codali_candidate / run_shell
Count: 1. First error line: `Remaining budget is reserved for verification; checkpoint unfinished work or increase the effort budget`.

Receipts: [1748](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1748).

## LOG-107: app-04-ios-game-raw_tools / docdex_open
Count: 3. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [6](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/events.jsonl:6), [8](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/events.jsonl:8), [14](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/events.jsonl:14).

## LOG-108: app-04-ios-game-raw_tools / docdex_search
Count: 1. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [12](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/events.jsonl:12).

## LOG-109: app-04-ios-game-raw_tools / run_shell
Count: 1. First error line: `Command not allowed: which`.

Receipts: [38](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/events.jsonl:38).

## LOG-110: app-04-ios-game-raw_tools / run_shell
Count: 1. First error line: `ldd (Ubuntu GLIBC 2.43-2ubuntu2.4) 2.43`.

Receipts: [54](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/events.jsonl:54).

## LOG-111: app-04-ios-game-raw_tools / run_shell
Count: 1. First error line: `bash: line 1: cd: tools/compat: No such file or directory`.

Receipts: [98](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/events.jsonl:98).

## LOG-112: app-05-android-codali_candidate / run_shell
Count: 2. First error line: `Claim a ready work task with work_claim before side effects, including read-only shell checks. Use work_status to inspect ready tasks; retain their existing contracts and implementation.`.

Receipts: [80](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:80), [85](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:85).

## LOG-113: app-05-android-codali_candidate / run_shell
Count: 2. First error line: `Command not allowed: curl`.

Receipts: [143](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:143), [150](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:150).

## LOG-114: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: which`.

Receipts: [166](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:166).

## LOG-115: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: wget`.

Receipts: [190](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:190).

## LOG-116: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `Shell write path is outside the claimed task scope`.

Receipts: [257](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:257).

## LOG-117: app-05-android-codali_candidate / work_claim
Count: 1. First error line: `Inline scope is only available for the initial unscoped task; use work_release/work_plan for later changes. No task is currently claimed. Inspect work_status and work_claim a ready task before verification.`.

Receipts: [302](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:302).

## LOG-118: app-05-android-codali_candidate / run_shell
Count: 2. First error line: `Create the scoped directory/file with write_file before shell execution`.

Receipts: [350](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:350), [640](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:640).

## LOG-119: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `File changed or has not been read; read .gradle/dl/fetch.py before editing. Call prepare_edit with path ".gradle/dl/fetch.py" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [380](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:380).

## LOG-120: app-05-android-codali_candidate / run_shell
Count: 3. First error line: `Task preimages exceed the 64 MiB ledger or 8 MiB file limit; narrow the task scope`.

Receipts: [465](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:465), [578](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:578), [624](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:624).

## LOG-121: app-05-android-codali_candidate / run_shell
Count: 2. First error line: `Traceback (most recent call last):`.

Receipts: [483](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:483), [501](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:501).

## LOG-122: app-05-android-codali_candidate / write_file
Count: 1. First error line: `File is outside the claimed task scope`.

Receipts: [515](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:515).

## LOG-123: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `File changed or has not been read; read .gradle/unpack.py before editing. Call prepare_edit with path ".gradle/unpack.py" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [545](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:545).

## LOG-124: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `Shell cwd is not an accessible existing directory`.

Receipts: [704](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:704).

## LOG-125: app-05-android-codali_candidate / write_file
Count: 1. First error line: `File changed or has not been read; read gradle.properties before editing. Call prepare_edit with path "gradle.properties" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [946](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:946).

## LOG-126: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `File changed or has not been read; read build.gradle.kts before editing. Call prepare_edit with path "build.gradle.kts" to refresh the content and required analysis, then construct the edit from that response. For a large file, use read_file and the individual analysis tools.`.

Receipts: [1011](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:1011).

## LOG-127: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: sha256sum`.

Receipts: [1027](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:1027).

## LOG-128: app-05-android-codali_candidate / run_shell
Count: 1. First error line: `Command not allowed: free`.

Receipts: [1043](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:1043).

## LOG-129: app-05-android-raw_tools / docdex_open
Count: 2. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [6](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:6), [8](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:8).

## LOG-130: app-05-android-raw_tools / docdex_search
Count: 2. First error line: `Managed Docdex failed to start: {"error":{"code":"startup_config_invalid","hint":"Run 'docdexd help-all' for full usage.","message":"error: unexpected argument '--workspace-metadata' found\n\nUsage: docdexd serve --repo <REPO> --state-dir <STATE_DIR>\n\nFor more information, try '--help'.\n"}}`.

Receipts: [12](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:12), [44](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:44).

## LOG-131: app-05-android-raw_tools / run_shell
Count: 1. First error line: `Invalid argument type`.

Receipts: [38](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:38).

## LOG-132: app-05-android-raw_tools / run_shell
Count: 1. First error line: `bash: line 1: unzip: command not found`.

Receipts: [62](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:62).

## LOG-133: app-05-android-raw_tools / run_shell
Count: 2. First error line: `Traceback (most recent call last):`.

Receipts: [66](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:66), [70](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:70).

## Audit boundaries

Original logs, results, reviews and issue JSONs were fingerprinted; all remained unchanged. Original code/check evidence is linked from CODALI_ISSUES.md. No credentials/config files were copied.
