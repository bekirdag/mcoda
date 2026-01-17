# Gateway Trio Agent Escalation + Comment Slug Workflow Plan

## Goal
Add two capabilities:
1) Gateway-trio auto-escalates to a stronger agent when a task keeps failing due to no changes or low capability.
2) Work, code-review, and QA share a consistent, slugged comment workflow so agents can understand, track, and resolve review/QA feedback across iterations.

## Non-Goals
- No new UI. Only CLI behavior + stored comments.
- No change to existing task status semantics beyond comment resolution bookkeeping.
- No change to task schema beyond comment metadata (slug/status).

---

## 1) Comment Slug + Resolution System

### 1.1 Schema changes
Update `task_comments` schema in `packages/db/src/migrations/workspace/WorkspaceMigrations.ts`:
- Add `slug TEXT`
- Add `status TEXT` (default `open`)
- Add index on `(task_id, slug)`

Keep existing `resolved_at` / `resolved_by` for resolution timestamps.

### 1.2 Repository API
Extend `WorkspaceRepository`:
- `createTaskComment` accepts `slug` and `status` (default `open`)
- `listTaskComments` returns `slug`, `status`
- `resolveTaskComment({ taskId, slug, resolvedBy, resolvedAt })`
- `reopenTaskComment({ taskId, slug })`
- Optional `upsertTaskComment` to update/merge by slug instead of duplicating.

### 1.3 Comment format
Create `TaskCommentFormatter` helper in `packages/core/src/services/tasks/TaskCommentFormatter.ts`.
All commands use it for consistent body formatting.

Example body:
```
[mcoda-comment]
slug: review-url-validator-200
status: open
source: code-review
message: validateUrl returns response.ok (any 2xx), but acceptance criteria require HTTP 200 only.
suggestedFix: return response.status === 200
```

### 1.4 Slug generation
Add a deterministic slug helper:
- Input: `{ source, file, line, message }`
- Output: `slugify(source + "-" + file + "-" + line + "-" + shortHash(message))`
- Use a stable short hash (e.g., SHA1 hex 8).
This prevents duplicate comments for the same finding.

---

## 2) Work-on-tasks reads unresolved comments

### 2.1 Prompt injection
In `packages/core/src/services/execution/WorkOnTasksService.ts`:
- Fetch unresolved comments for the task (source `code-review` + `qa-tasks`).
- Inject "Comment backlog" section in the task prompt:
  - `slug`, `message`, `suggestedFix`, `file:line`

### 2.2 No-change detection
If unresolved comments exist and `touched.length === 0`:
- Mark task attempt as failed/blocked with reason `no_changes`.
- Add a work comment indicating no changes were produced for active slugs.
This prevents "completed with no changes" from slipping through.

### 2.3 Optional resolution hints
Allow (but do not require) the work agent to include a small JSON block like:
```
{ "resolvedSlugs": ["review-url-validator-200"] }
```
If detected, record a `comment_resolution` entry but do not auto-resolve without review/QA confirmation.

---

## 3) Code review reads + resolves comments

### 3.1 Review prompt
In `packages/core/src/services/review/CodeReviewService.ts`:
- Include unresolved comment slugs in the prompt.
- Extend required JSON contract with:
  - `resolvedSlugs: string[]`
  - `unresolvedSlugs: string[]`

### 3.2 Resolution handling
After parsing review JSON:
- Mark `resolvedSlugs` as resolved (`resolved_at`, `resolved_by`).
- Add a `comment_resolution` comment for each resolved slug.
- If a previously resolved slug is reported again, reopen it.

### 3.3 Duplicate handling
If a new finding maps to an existing slug:
- Update or reopen existing comment instead of creating a duplicate.
- Write a small "reopened" note when applicable.

### 3.4 Summary comment
Extend review summary to include:
- `resolved_slugs: N`
- `reopened_slugs: N`
- `open_slugs: N`

---

## 4) QA reads + resolves comments

### 4.1 QA prompt
In `packages/core/src/services/execution/QaTasksService.ts`:
- Include unresolved comment slugs + text in the QA interpretation prompt.
- Ask for JSON output fields:
  - `resolvedSlugs`
  - `unresolvedSlugs`

### 4.2 Resolution handling
Same as code-review:
- Resolve slugs based on QA output.
- Add `comment_resolution` comments.

### 4.3 QA issue slugs
When QA raises issues, generate slugged comments so work can target them.

---

## 5) Gateway-trio agent escalation

### 5.1 Failure classification
Standardize failure reasons in work results:
- `missing_patch`
- `patch_failed`
- `no_changes`
- `agent_timeout`
- `tests_failed`

### 5.2 Escalation policy
If the same agent fails a task for any of:
- `missing_patch`
- `patch_failed`
- `no_changes`
- `agent_timeout`
then pick a stronger agent on the next attempt.

### 5.3 Stronger agent definition
Prefer agents with:
- Higher `rating`, or
- Higher `max_complexity`, or
- Higher usage fit for required capabilities.

### 5.4 Implementation details
- Extend `GatewayAgentRequest` with `avoidAgents: string[]`.
- `GatewayTrioService` tracks per-task `failedAgents` and `failureReasons` in state.
- Pass `avoidAgents` to gateway selection when escalation is required.
- Add `force_stronger` hint to gateway prompt for these retries.

### 5.5 CLI control
Add an optional CLI flag:
- `--escalate-on-no-change` (default `true`)

---

## 6) Testing

### 6.1 DB + repository
- Migration tests for new comment columns.
- Repository tests for create/list/resolve/reopen by slug.

### 6.2 Work-on-tasks
- Prompt includes unresolved comments.
- `no_changes` causes failure when comments exist.

### 6.3 Code-review
- Parses `resolvedSlugs` and updates comment resolution.
- Avoids duplicate comments for existing slugs.

### 6.4 QA
- Reads unresolved comments.
- Resolves slugs based on QA output.

### 6.5 Gateway-trio
- Escalates agent after repeated failures for the same task.
- Avoid list is honored.

---

## 7) Rollout steps
1) Apply DB migration and repository changes.
2) Add formatter + slug helper.
3) Inject comments into work/review/qa prompts.
4) Add resolve/reopen flows in review/QA.
5) Add gateway-trio escalation logic.
6) Add/refresh tests and update run-all tests script.
