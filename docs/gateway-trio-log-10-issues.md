# Gateway Trio Log 10 Issues

Source: ~/Downloads/logs/10.txt

- Output contract enforcement failure: code-writer responses include prose, fenced code blocks, and placeholders even when the contract requires patch-only output; MCODA still attempts to apply them.
- Streaming output contamination: patch payloads are interleaved with `[agent-io] output` markers and duplicated tokens, indicating MCODA is capturing raw stream output without sanitizing before patch application.
- Patch application failure without recovery: repeated `Patch apply failed (No patches applied; all segments failed or were skipped.)` events occur, and MCODA keeps retrying without enforcing a clean FILE/patch-only response.
- File name corruption from diff metadata: files are created with literal suffixes like “(new file)”, showing patch metadata leaking into filenames during apply.
- Markdown fences and placeholders committed to source: files contain literal ``` fences and placeholder fragments (e.g., “... existing code ...”), showing MCODA applied markdown-formatted output verbatim instead of rejecting or sanitizing it.
- Task loop control failure: after a work task fails, gateway-trio moves on to another lane’s duplicate task instead of retrying the same task with a better agent as required by the workflow.
- Agent eligibility failure loop: the gateway repeatedly logs `No eligible agents available for this job` for the same task without backoff, alternate agent selection, or aborting the run.
- Duplicate task proliferation: identical “initialize project” tasks exist across bck/ops/web lanes and are processed independently, multiplying failures and conflicting edits rather than being merged or deduped.
- Docdex enforcement gap: agent outputs show “Not executed; would run” for required docdex calls, and MCODA does not block or re-prompt when mandatory repo-context retrieval is skipped.
- Log integrity issue: the file ends during a gateway task start (missing END block), suggesting logging/truncation problems during long retry storms.
- Limit enforcement gap: the run executes far more than the requested `--limit 2` tasks after failures/retries, so the limit is not honored across cycles.
- Commit-on-failure behavior: task branches still record commits in the git summary even when tests fail, so invalid changes are being committed instead of being discarded.
- Test command mismatch handling: MCODA invokes required `npm test` even when the script is missing, leading to immediate failures without preflight checks or auto-wiring of the test script.
- Patch apply gating failure: MCODA runs tests even when no patches applied, creating noisy failures instead of stopping or retrying with clean output.
- No rollback/sanitation after failed applies: corrupted outputs persist in the workspace and contaminate subsequent tasks, rather than being reverted or isolated.
- Retry policy drift: per-task retry counts are exhausted but the same tasks reappear via lane duplicates, effectively bypassing retry limits.
- Auto-commit of dirty workspace: `checkoutBaseBranch` commits any pre-existing changes without prompt, so unrelated or malformed edits get committed before the task even starts.
- File-block placeholder leakage: placeholder filters only apply to patches, not FILE blocks, so “... existing code ...” or similar placeholder content can be written verbatim.
- FILE block parsing is too permissive: it accepts `FILE:` lines without fenced blocks and captures the rest of the output as file content, allowing narrative text to be written to disk.
- Single-file fallback applies any code fence: when patch apply fails and one file is inferred, the fallback uses the first fenced snippet (any language) as full file content, even if it’s just an example or partial.
- Path normalization doesn’t strip trailing metadata: file paths extracted from diff headers or FILE lines can include extra tokens (e.g., “(new file)”), producing unintended filenames.
- Agent escalation can dead-end: failed attempts add the only available agent to the avoid list, causing “No eligible agents” instead of falling back to the same agent or aborting cleanly.
- Test command discovery is naive: it infers `npm test` based on package manager presence without verifying a `test` script exists, causing predictable failures.
- Failed-task reopen is too aggressive: any task marked `failed` is reopened each cycle unless max iterations is reached, regardless of failure reason (e.g., patch_failed or agent selection errors), leading to repeat loops.
- Tests are executed unconditionally for every non-dry-run task: `shouldRunTests` does not depend on `hasTestRequirements`, so tasks without tests still fail when `tests/all.js` is missing.
- Auto-generated `tests/all.js` uses ESM `import` in a `.js` file without ensuring module type, which will break in default CommonJS projects.
- Patch fallback can’t overwrite existing files by default: when patch apply fails and FILE blocks target existing files, `allowFileOverwrite` is false, so the fallback is silently skipped and the task keeps failing.
- Fallback response isn’t validated: when the system requests FILE blocks after patch failure, it still accepts patches/prose and retries, so the “FILE-only” recovery path is unenforced.
- Default CLI enables stream I/O (`MCODA_STREAM_IO=1`) unless `--quiet/--json` is passed; this mixes agent trace output into logs and creates a high risk of contamination for downstream patch parsing.
