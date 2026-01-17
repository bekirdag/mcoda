# Gateway Trio Agent Escalation + Comment Slug Workflow Tasks

Ordered by priority (highest first).

---

## task-comment-schema
**Title:** Add slug/status support to task comments  
**Priority:** P0  
**Description:**  
Add slug and status tracking to task comments so review/QA feedback can be addressed as repeatable sub-tasks. Update migrations and repository APIs to create, list, resolve, and reopen comments by slug. Ensure the default status is `open` and resolution uses `resolved_at/resolved_by`. Add a `(task_id, slug)` index for faster lookups.  
**Dependencies:** None  
**Files to touch:**  
- `packages/db/src/migrations/workspace/WorkspaceMigrations.ts`  
- `packages/db/src/repositories/workspace/WorkspaceRepository.ts`  
- `packages/db/src/__tests__/WorkspaceMigrations.test.ts`  
- `packages/db/src/__tests__/WorkspaceRepository.test.ts`  
**Tests to write:**  
- Unit: repository CRUD tests for `slug/status`, resolve, reopen  
- Component: None  
- Integration: migration test to confirm new columns/index exist  
- API: None  
**Acceptance criteria:**  
- `task_comments` includes `slug` and `status` columns with defaults  
- Repository can create/list/resolve/reopen comments by slug  
- Existing comment flows still work without slug input  
- Tests cover new fields and resolution behavior  

---

## task-comment-format
**Title:** Add TaskCommentFormatter + deterministic slug helper  
**Priority:** P0  
**Description:**  
Introduce a shared formatter that builds a consistent comment body and a slug generator that produces stable slugs from source/file/line/message. Use a short hash to keep slugs readable. Export helper utilities so work/review/QA can reuse them.  
**Dependencies:** task-comment-schema  
**Files to touch:**  
- `packages/core/src/services/tasks/TaskCommentFormatter.ts` (new)  
- `packages/core/src/services/tasks/__tests__/TaskCommentFormatter.test.ts` (new)  
**Tests to write:**  
- Unit: slug generation stability + formatter output  
- Component: None  
- Integration: None  
- API: None  
**Acceptance criteria:**  
- Formatter yields consistent body with slug/source/status/message  
- Slug helper is deterministic and collision-resistant for common inputs  

---

## work-comment-backlog
**Title:** Work-on-tasks reads unresolved comment backlog  
**Priority:** P0  
**Description:**  
Inject unresolved comment slugs into the work prompt so agents know what to fix. Load unresolved comments for `code-review` and `qa-tasks`, add a "Comment backlog" section with slug, message, suggested fix, and file/line.  
**Dependencies:** task-comment-schema, task-comment-format  
**Files to touch:**  
- `packages/core/src/services/execution/WorkOnTasksService.ts`  
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`  
**Tests to write:**  
- Unit: prompt includes unresolved comments in correct format  
- Component: None  
- Integration: None  
- API: None  
**Acceptance criteria:**  
- Work prompt includes unresolved slugs for the task  
- No duplicate comment entries when repeated runs happen  

---

## work-no-change-failure
**Title:** Fail work attempts that make no changes with unresolved comments  
**Priority:** P0  
**Description:**  
When a task has unresolved review/QA comments and the work agent produces no touched files, mark the attempt as failed/blocked with reason `no_changes`. Add a work comment noting the lack of progress and list the open slugs. This prevents endless "completed with no changes."  
**Dependencies:** task-comment-schema, work-comment-backlog  
**Files to touch:**  
- `packages/core/src/services/execution/WorkOnTasksService.ts`  
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`  
**Tests to write:**  
- Unit: no-change attempt with open comments yields `no_changes` failure  
- Component: None  
- Integration: None  
- API: None  
**Acceptance criteria:**  
- `no_changes` is recorded when unresolved comments exist and no files are touched  
- A work comment is created listing unresolved slugs  

---

## review-read-resolve-comments
**Title:** Code review reads comment slugs and resolves them  
**Priority:** P0  
**Description:**  
Extend code review prompt with unresolved comment slugs and require JSON output fields `resolvedSlugs` and `unresolvedSlugs`. Resolve matching slugs in DB, reopen previously resolved slugs when reintroduced, and write resolution comments with category `comment_resolution`. Ensure duplicate findings reuse slugs instead of creating new ones.  
**Dependencies:** task-comment-schema, task-comment-format  
**Files to touch:**  
- `packages/core/src/services/review/CodeReviewService.ts`  
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`  
**Tests to write:**  
- Unit: parsing `resolvedSlugs` and updating resolution state  
- Component: None  
- Integration: review flow creates resolution comments + avoids duplicates  
- API: None  
**Acceptance criteria:**  
- Review prompt includes unresolved comments  
- Review output can resolve/reopen slugs  
- Summary comment includes resolved/reopened/open counts  

---

## qa-read-resolve-comments
**Title:** QA reads comment slugs and resolves them  
**Priority:** P0  
**Description:**  
Include unresolved comment slugs in QA interpretation prompts and parse `resolvedSlugs`/`unresolvedSlugs` from QA JSON. Resolve or reopen slugs accordingly and add `comment_resolution` entries. Ensure QA issue comments use slugs so work can target them.  
**Dependencies:** task-comment-schema, task-comment-format  
**Files to touch:**  
- `packages/core/src/services/execution/QaTasksService.ts`  
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`  
**Tests to write:**  
- Unit: QA parsing resolves slugs and writes resolution comments  
- Component: None  
- Integration: QA issue comments carry slugs  
- API: None  
**Acceptance criteria:**  
- QA prompts include unresolved comment backlog  
- QA output can resolve/reopen slugs  
- QA issue comments include deterministic slugs  

---

## gateway-avoid-list
**Title:** Add avoidAgents support to gateway selection  
**Priority:** P1  
**Description:**  
Allow gateway selection to exclude specific agents (previous failures) while still respecting required capabilities and complexity gating. Add `avoidAgents` to `GatewayAgentRequest` and filter candidates accordingly.  
**Dependencies:** None  
**Files to touch:**  
- `packages/core/src/services/agents/GatewayAgentService.ts`  
- `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts`  
**Tests to write:**  
- Unit: avoid list filters candidates  
- Component: None  
- Integration: None  
- API: None  
**Acceptance criteria:**  
- Gateway selection never returns avoided agents  
- Selection still honors capability + complexity constraints  

---

## gateway-escalation-policy
**Title:** Escalate agent on repeated failure or no-change  
**Priority:** P1  
**Description:**  
In `GatewayTrioService`, track per-task failure reasons and failed agents. If the same agent fails due to `missing_patch`, `patch_failed`, `no_changes`, or `agent_timeout`, retry with a stronger agent by passing `avoidAgents` and a `force_stronger` hint. Persist failure history in gateway-trio state for resume safety.  
**Dependencies:** gateway-avoid-list, work-no-change-failure  
**Files to touch:**  
- `packages/core/src/services/execution/GatewayTrioService.ts`  
- `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`  
**Tests to write:**  
- Unit: escalation triggers after repeated failures  
- Component: None  
- Integration: gateway-trio retries with a different agent  
- API: None  
**Acceptance criteria:**  
- Gateway-trio switches agents after repeat failures for the same task  
- Failure history persists across resume  

---

## gateway-cli-flag
**Title:** Add `--escalate-on-no-change` CLI flag  
**Priority:** P1  
**Description:**  
Expose a CLI flag to control escalation on no-change failures. Default should be `true` to enable safer retries, but allow disabling for deterministic runs. Pass through to gateway-trio request.  
**Dependencies:** gateway-escalation-policy  
**Files to touch:**  
- `packages/cli/src/commands/work/GatewayTrioCommand.ts`  
- `packages/cli/src/__tests__/GatewayTrioCommand.test.ts`  
**Tests to write:**  
- Unit: CLI parses flag and passes to service  
- Component: None  
- Integration: None  
- API: None  
**Acceptance criteria:**  
- Flag is documented in command help and parsed correctly  
- GatewayTrioService receives the flag value  

---

## comment-summary-updates
**Title:** Extend review/QA summary comments with slug resolution counts  
**Priority:** P2  
**Description:**  
Enhance summary comments to include counts of resolved/reopened/open slugs. This makes progress visible and helps agents decide what is left.  
**Dependencies:** review-read-resolve-comments, qa-read-resolve-comments  
**Files to touch:**  
- `packages/core/src/services/review/CodeReviewService.ts`  
- `packages/core/src/services/execution/QaTasksService.ts`  
**Tests to write:**  
- Unit: summary comment includes resolution counts  
- Component: None  
- Integration: None  
- API: None  
**Acceptance criteria:**  
- Summary comments show resolution stats  
- No regression in existing summary formatting  

---

## test-suite-updates
**Title:** Update run-all tests script if new suites are added  
**Priority:** P2  
**Description:**  
If new test files require registration in `tests/all.js`, update the run-all script to include them. This task ensures run-all coverage stays complete as new tests are introduced.  
**Dependencies:** All prior tasks  
**Files to touch:**  
- `tests/all.js` (only if needed)  
**Tests to write:**  
- Unit: None  
- Component: None  
- Integration: None  
- API: None  
**Acceptance criteria:**  
- All new tests are included in `tests/all.js` when required  
- `node tests/all.js` runs cleanly after updates  
