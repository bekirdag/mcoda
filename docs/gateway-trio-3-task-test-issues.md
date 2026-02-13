# Gateway Trio 3-Task Test Issues (<PROJECT_KEY>)

## Test Run
- Command: `mcoda gateway-trio --project <PROJECT_KEY> --task <TASK_KEY> --task <TASK_KEY> --task <TASK_KEY> --qa-allow-dirty true --agent-stream false`
- Workspace: `<WORKSPACE_ROOT>`
- Start time: 2026-01-11 22:55 local

## Observed Issues
1. **Gateway-trio hung on first work step (no progress within 120s).**
   - Work agent selected: `codellama:34b` (ollama).
   - CLI timed out while the job remained `running`.
   - Evidence: `<WORKSPACE_ROOT>/.mcoda/jobs/<JOB_ID_TRIO>/manifest.json` (gateway-trio) and `<WORKSPACE_ROOT>/.mcoda/jobs/<JOB_ID_WORK>/manifest.json` (work-on-tasks).

2. **CLI termination leaves local jobs in a `running` state with active task locks.**
   - The gateway-trio job and its work-on-tasks sub-job keep `state: running` after the CLI timeout.
   - This can block subsequent runs from acquiring locks for the same tasks until TTL expiry.

3. **No early CLI feedback or job ID printed for resume.**
   - When the work agent stalls, the CLI provides no job ID hint for `mcoda job resume` (and job commands require API).

## Suggested Fixes / Mitigations
1. **Prefer faster agents for work steps (or add latency-aware routing).**
   - Add a latency/throughput score and penalize slow agents for gateway selection.
   - Introduce a `max_latency_ms` constraint when choosing `work` agents.

2. **Lower or enforce `maxAgentSeconds` by default for CLI runs.**
   - Default to a shorter timeout for CLI-driven work steps (e.g., 120–300s).
   - Surface timeout progress in CLI output and mark the step as failed when exceeded.

3. **Emit gateway-trio job ID at start and persist a local resume hint.**
   - Print the job ID at the top of the CLI output, and write a local `last_job.json` in `.mcoda/`.
   - Allow `mcoda job resume` to work without API when a local job manifest is available.

4. **Auto-clean stale locks when CLI terminates early.**
   - On CLI exit, write a terminal checkpoint and mark the job `cancelled` if no heartbeat updates occur.
   - Provide a `mcoda job cancel --local` path to release task locks without API.
