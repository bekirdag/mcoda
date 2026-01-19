# Feature Plan: Agent Rating + Dynamic Complexity Evaluation

Status: Draft
Owner: mcoda core
Scope: Global agent registry, gateway routing, agent job execution, telemetry

## 1) Goals
- Introduce a consistent, repeatable rating mechanism that scores agent performance per job and updates the agent's rating over time (target stability after ~50 runs).
- Add a dynamic max-complexity limit per agent so high ratings from low-complexity work do not misroute high-complexity jobs.
- Ensure low-performing agents still receive occasional evaluation chances (exploration), without harming critical jobs.
- Enable rating via an explicit CLI argument for any agent-related command.
- Use the default system agent to review delivered work and produce a quality score.

## 2) Current State (What Exists)
- `agents` table already includes `rating`, `reasoning_rating`, `best_usage`, `cost_per_million` in the global DB.
- Gateway routing uses `rating`, `reasoning_rating`, `best_usage`, and `cost_per_million` for selection, plus a per-task `complexity` (1-10) predicted by the gateway agent.
- Workspace DB tracks:
  - `jobs`, `command_runs`, `task_runs` (timing and status).
  - `task_logs`, `task_comments`, `task_reviews`, `task_qa_runs` (iteration evidence and outcomes).
  - `token_usage` per command/task/run with `tokens_total`, `duration_seconds`, and optional `cost_estimate`.
- Many commands already record token usage via `JobService.recordTokenUsage`.
- Retries exist in:
  - `work-on-tasks`: multiple attempts and test reruns.
  - `code-review`: one retry for invalid JSON.
  - `docs` and `create/refine/openapi`: some multi-pass actions.

## 3) Requirements Summary
- Add a rating mechanism per agent per job, enabled by CLI flag.
- Use default system agent to review output (quality scoring).
- Compute run score using:
  - Total token usage (all iterations, no averages).
  - Total duration (job runtime).
  - Number of iterations (retries).
  - Total cost (tokens * price per 1M).
- Rating must reward good performers and punish poor performers.
- Gateway must still explore low-rated agents periodically.
- Add `max_complexity` to agents and a dynamic evaluation algorithm to adjust it over time.
- Use existing review/QA outcomes to inform evaluations.

## 4) Data Model Changes

### 4.1 Global DB: extend `agents`
Add columns:
- `max_complexity INTEGER` (1-10, default 5)
- `rating_samples INTEGER` (total evaluation runs)
- `rating_last_score REAL`
- `rating_updated_at TEXT`
- `complexity_samples INTEGER` (count of complexity trials)
- `complexity_updated_at TEXT`

Keep existing `rating` and `reasoning_rating` as the canonical output.

### 4.2 Global DB: new table `agent_run_ratings`
Store per-job evaluations used to update the agent profile.

Columns (proposal):
- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `job_id TEXT` (workspace job id)
- `command_run_id TEXT`
- `task_id TEXT`
- `task_key TEXT`
- `command_name TEXT`
- `discipline TEXT`
- `complexity INTEGER`
- `quality_score REAL` (0-10 from reviewer)
- `tokens_total INTEGER`
- `duration_seconds REAL`
- `iterations INTEGER`
- `total_cost REAL`
- `run_score REAL`
- `rating_version TEXT`
- `raw_review_json TEXT`
- `created_at TEXT`

### 4.3 Optional: new table `agent_invocations`
Normalize agent attempts for accurate iteration counts.

Columns (proposal):
- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `command_run_id TEXT`
- `task_run_id TEXT`
- `task_id TEXT`
- `phase TEXT` (agent, agent_retry, review_retry, etc.)
- `attempt INTEGER`
- `duration_seconds REAL`
- `tokens_total INTEGER`
- `timestamp TEXT`

If we avoid a new table, we must extend token usage metadata to include `attempt` and `phase` consistently for every agent command.

## 5) Rating Inputs (How We Measure)

### 5.1 Quality (Reviewer Agent)
Invoke a system reviewer agent after the job completes (flag-gated). It receives:
- Task context + inputs (task description, acceptance criteria, related docs).
- Agent outputs (patches, review summaries, QA outcomes, docs).
- Existing reviews/QA results (task_reviews, task_qa_runs, task_comments).
- Test results and failure summaries from task logs.

The reviewer responds with JSON:
```
{
  "quality_score": 0-10,
  "reasoning": "...",
  "defects": ["missed tests", "incorrect logic", "spec mismatch"],
  "strengths": ["good structure", "passed QA", "clear tests"]
}
```

### 5.2 Tokens (Total, Not Averaged)
Sum `tokens_total` across all agent invocations for the job/task/command-run.

### 5.3 Duration (Total)
Use `command_runs.duration_seconds` or `jobs.completed_at - jobs.created_at`.

### 5.4 Iterations (Retries)
Derived from:
- `agent_invocations` (preferred).
- Otherwise: count token usage entries per agent per command run minus 1, and/or parse task logs (`attempt` field in details).

### 5.5 Total Cost
`total_cost = tokens_total * (agent.cost_per_million / 1_000_000)`.
If `cost_estimate` is already recorded, use it as a cross-check or fallback.

## 6) Scoring Formula

### 6.1 Normalization
We need a budget/baseline per command + complexity bucket (1-10). Start with config defaults and refine using empirical medians.

Suggested normalization:
- `cost_norm = min(1, total_cost / cost_budget)`
- `time_norm = min(1, duration_seconds / time_budget)`
- `iter_norm = min(1, max(0, iterations) / iter_budget)`

### 6.2 Run Score
Let `Q` be quality score normalized to 0-1 (Q = quality_score / 10).

```
score = 10 * clamp(
  (w_q * Q) 
  - (w_c * cost_norm)
  - (w_t * time_norm)
  - (w_i * iter_norm),
  0, 1
)
```

Default weights (tune later):
- `w_q = 1.0` (quality dominates; perfect runs can reach 10)
- `w_c = 0.15`
- `w_t = 0.10`
- `w_i = 0.20`

Penalty behavior:
- A poor quality score quickly sinks the run score.
- Extra retries penalize hard, but not to zero unless repeated failures.
- Cost/time penalties scale by budget to avoid punishing complex work unfairly.

### 6.3 Rating Update (Target ~50 runs)
Use exponential moving average:
```
rating_new = rating_old + alpha * (score - rating_old)
alpha = 2 / (N + 1)   # N=50 => alpha ~ 0.039
```
Store `rating_samples` and `rating_last_score`.

For architecture/planning disciplines, update `reasoning_rating` in parallel.

## 7) Dynamic Complexity Evaluation

### 7.1 Routing Constraint
Gateway filters agents by `max_complexity >= task_complexity`.
If none match, allow `max_complexity == task_complexity - 1` with warning.

### 7.2 Promotion/Demotion
After each rated run:
- Promote if:
  - `run_score >= promote_threshold` (e.g., 7.5/10)
  - `task_complexity >= max_complexity`
  - `quality_score >= 7`
- Demote if:
  - `run_score <= demote_threshold` (e.g., 4.0/10)
  - `task_complexity <= max_complexity`

Apply a cooldown (`complexity_updated_at`) to prevent oscillation.
Default cooldown: 24h between promotions/demotions.

### 7.3 Ongoing Exploration
Epsilon-greedy routing:
- `epsilon = 0.10` (10% exploration)
- Exploration modes:
  - Redemption: pick a low-rated agent for a low-complexity task.
  - Stretch: pick a good agent for `max_complexity + 1` tasks (cap at +1).

Always log exploration decisions for traceability.

## 8) Integration Points (Commands)

### 8.1 CLI Flags
Add `--rate-agents` to every agent-driven command:
- docs (pdr/sds/rfp/openapi)
- create-tasks, refine-tasks, order-tasks
- work-on-tasks
- gateway-agent, gateway-trio
- code-review
- qa-tasks

Optional additional flags:
- `--rating-agent <slug>` (override reviewer)
- `--rating-strict` (fail if reviewer unavailable)

### 8.2 Services
Create `AgentRatingService` (core) with:
- `rateCommandRun(commandRunId, options)` to:
  - assemble context (task summaries, code review, QA, logs, diffs).
  - invoke reviewer agent and parse JSON.
  - compute run score.
  - write to `agent_run_ratings`.
  - update `agents.rating`, `agents.reasoning_rating`, `agents.max_complexity`.

### 8.3 Reviewer Agent Selection
Use RoutingService with a dedicated command name:
- `agent-rating` command default.
- Fallback to global `default` agent if `agent-rating` is not set.
- This is the "system agent" for rating.

## 9) Using Existing Review/QA Signals
For work-on-tasks agents:
- Use code-review findings and QA results as input to the reviewer.
- If QA fails, the reviewer must downgrade quality_score.

For code-review agents:
- Use QA outcomes and test results (if code was fixed) to inform quality.

For QA agents:
- Use actual test results and task comments (pass/fail notes).

## 10) Telemetry and Auditability
- Write an evaluation summary into `<workspace-dir>/jobs/<jobId>/rating.json`.
- Link rating records to job and command_run ids.
- Add a CLI view: `mcoda agent ratings --agent <slug> --last 50`.

## 11) Migration Plan
- Global migration to add new columns + new tables.
- Backfill `max_complexity` to 5 for existing agents.
- Initialize `rating_samples` = 0 for all agents.

## 12) Test Plan
- Migration tests for new columns/tables.
- Unit tests for:
  - score calculation (penalties and caps).
  - complexity promotion/demotion logic.
  - epsilon-greedy selection.
- Integration tests:
  - work-on-tasks run with `--rate-agents` updates agent rating.
  - gateway respects max_complexity but still explores.

## 13) Documentation Updates
- `docs/usage.md`: explain `--rate-agents`, reviewer defaults, and exploration.
- `docs/sds/sds.md`: add rating engine + complexity evolution.
- CLI READMEs: describe the rating flag and what it does.
