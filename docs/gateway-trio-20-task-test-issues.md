# Gateway Trio 20-Task Test Issues (<PROJECT_KEY>)

## Run Details
- Workspace: `<WORKSPACE_ROOT>`
- Command (2nd run): `mcoda gateway-trio --project <PROJECT_KEY> --qa-allow-dirty true --agent-stream false --task <20 not_started tasks>`
- Job ID: `<JOB_ID_RUN_2>`
- State file: `<WORKSPACE_ROOT>/.mcoda/jobs/<JOB_ID_RUN_2>/gateway-trio/state.json`

## Issues Observed
1. **First attempt skipped all tasks due to newline-packed `--task` argument.**
   - What I did: built the `--task` list via shell substitution.
   - What happened: gateway-trio treated the entire newline-separated list as a single task key and logged “Task not found…” for every task; no tasks were attempted.
   - Why: `--task` values were passed as one string with embedded newlines; gateway-trio doesn’t validate or split multi-line task strings.
   - Evidence: `<WORKSPACE_ROOT>/.mcoda/jobs/<JOB_ID_TASK_LIST>/manifest.json` shows `payload.tasks` as one long newline-delimited string.

2. **Gateway-trio run left in `running` state after CLI timeout (no local resume/watch).**
   - What I did: ran gateway-trio for 20 tasks and let it run ~30 minutes.
   - What happened: CLI timed out, but the gateway-trio job and a work sub-job stayed `running`.
   - Why: no local “job watch/resume” without API, and no automatic cancellation on CLI termination.
   - Evidence:
     - Gateway trio: `<WORKSPACE_ROOT>/.mcoda/jobs/<JOB_ID_RUN_2>/manifest.json` (status `running`)
     - Work sub-job: `<WORKSPACE_ROOT>/.mcoda/jobs/<JOB_ID_WORK_SUB>/manifest.json` (status `running`)

3. **Stale task locks remain from previous runs and block retries.**
   - What I did: checked the lock table after the timeout.
   - What happened: locks persisted for tasks from older runs (e.g., `<TASK_KEY>`) and the current run (`<TASK_KEY>`).
   - Why: no automatic cleanup when a CLI run exits early or a job stops without clean termination.
   - Evidence: `task_locks` entries for `<TASK_KEY>` and `<TASK_KEY>` (expires in the future).

4. **Multiple tasks blocked by `missing_patch` (agent output without valid diffs).**
   - What I did: inspected gateway-trio state.
   - What happened: work step failed with `missing_patch` for multiple tasks, blocking them.
   - Why: work agents returned plans or prose without valid `patch`/`FILE` outputs.
   - Evidence (from state.json failureHistory):
     - `<TASK_KEY>` (agent `codellama-34b`)
     - `<TASK_KEY>` (agent `codellama-34b`)
     - `<TASK_KEY>` (agent `codellama-34b`)
     - `<TASK_KEY>` (agent `deepseek-coder-33b`)

5. **Work step failures: `no_changes` / `patch_failed` blocked several tasks.**
   - What I did: inspected `gateway-trio/state.json` and task statuses.
   - What happened: tasks moved to `blocked` with `no_changes` or `patch_failed`.
   - Why: agents either produced no file changes or invalid patches.
   - Evidence:
     - `no_changes`: `<TASK_KEY>`, `<TASK_KEY>`, `<TASK_KEY>`
     - `patch_failed`: `<TASK_KEY>`, `<TASK_KEY>`

6. **Tests failed during work step and immediately blocked a task.**
   - What I did: checked `gateway-trio/state.json`.
   - What happened: `<TASK_KEY>` failed with `tests_failed` and was set to `blocked`.
   - Why: test command(s) failed during the work step; no automatic retry or fallback agent was attempted within the same cycle.

7. **Code review returned `changes_requested` but did not loop back before the run stalled.**
   - What I did: reviewed state after ~30 minutes.
   - What happened: `<TASK_KEY>` and `<TASK_KEY>` got `changes_requested` and stayed `in_progress` with no follow-up work attempt.
   - Why: gateway-trio continued into other tasks and then stalled on a long-running work sub-job, so review fixes were never attempted.

8. **Long-running work sub-job blocks the rest of the queue.**
   - What I did: inspected `manifest.json` and state for the current running work job.
   - What happened: `<TASK_KEY>` work job stayed `running`, preventing the remaining tasks from being attempted.
   - Why: gateway-trio waits on the active work sub-job, with no preemption/timeout enforcement at the gateway level.

## Notes
- Task statuses after this run (sample):
  - `<TASK_KEY_A>`, `<TASK_KEY_B>`: `in_progress` (review changes requested)
  - `<TASK_KEY_C>`, `<TASK_KEY_D>`, `<TASK_KEY_E>`: `blocked` (missing_patch/no_changes/patch_failed)
  - `<TASK_KEY_F>`: `in_progress` (work job still running)

## Run 3 (gateway-trio rerun after rating visibility + optional caps)
- Workspace: `<WORKSPACE_ROOT>`
- Command: `mcoda gateway-trio --workspace-root <WORKSPACE_ROOT> --project <PROJECT_KEY> --status not_started --limit 20 --max-iterations 10 --max-cycles 10 --qa-allow-dirty true --rate-agents --watch`
- Job ID: `<JOB_ID_RUN_3>`
- State file: `<WORKSPACE_ROOT>/.mcoda/jobs/<JOB_ID_RUN_3>/gateway-trio/state.json`
- Resume: `mcoda gateway-trio --resume <JOB_ID_RUN_3>`

### Issues Observed
1. **CLI watch run timed out at 300s, leaving job running (0/20).**
   - What I did: ran gateway-trio with `--watch` and a 5‑minute shell timeout.
   - What happened: the CLI timed out while the job stayed `running`.
   - Why: long-running agent work exceeded the local command timeout.
   - Evidence: job still marked `running` in state file; resume command printed.

2. **Work step returned `missing_patch` for a QA follow-up task.**
   - Task: `<TASK_KEY>`
   - What happened: work agent output lacked valid patch/FILE blocks.
   - Impact: task remained `pending` with `missing_patch` in failure history.
   - Evidence: state shows failure history with `missing_patch` and a rating entry for the work step.

3. **Dependency-blocked tasks were selected and skipped.**
   - Tasks: `<TASK_KEY>`, `<TASK_KEY>`, `<TASK_KEY>`, `<TASK_KEY>`
   - What happened: tasks were marked `skipped` with `dependency_blocked`.
   - Impact: selection included tasks that could not be attempted in this cycle.
   - Evidence: state file marks these tasks as `skipped` with `dependency_blocked`.

4. **A long-running work step stalled the queue.**
   - Task: `<TASK_KEY>`
   - What happened: work step started and remained in progress during the timeout window.
   - Impact: job stayed at `running 0/20` and did not advance other tasks.
   - Evidence: state shows `attempts: 1`, `lastStep: work`, no completion recorded.
