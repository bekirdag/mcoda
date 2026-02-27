# Create-Tasks and Task-Sufficiency Remediation Plan

## Goal
Fix backlog quality regressions so `create-tasks` produces a direct, SDS-aligned implementation plan (plan -> epics -> stories -> tasks), and `task-sufficiency-audit` verifies/improves coverage without generating noisy or non-actionable tasks.

## Observed Issues (PiriAtlas Evidence)
- `task-sufficiency-audit` generated many generic tasks (`Cover SDS section`, `Materialize SDS folder entry`) under a single story.
- Non-implementation SDS headings were treated as implementation gaps (e.g., revision history/table of contents).
- Folder signal extraction accepted non-repo artifacts and glossary-like tokens, causing invalid remediation tasks.
- Epic/story/task descriptions included placeholder boilerplate and duplicated content, reducing actionability.

## Requirements to Enforce
- Planning flow is explicit and linear:
  1. Build plan from SDS context.
  2. Decide epics from that plan.
  3. Generate stories under each epic.
  4. Generate tasks under each story.
- Output must be concise and actionable; avoid placeholder/template filler.
- Sufficiency pass should target real implementation gaps and avoid polluting existing story scopes.

## Implementation Steps
1. **Create-tasks pipeline hardening**
- Add explicit build-plan checkpoint/artifact before epic generation.
- Keep generation order explicit (epics -> stories -> tasks) with plan context carried through all phases.
- Simplify description renderers to remove placeholder-only sections and duplicated template text.

2. **Task-sufficiency quality fixes**
- Add heading filters to skip non-implementation/admin headings.
- Add folder-path filters to keep only repository-relevant structure signals.
- Use dedicated sufficiency epic/story target instead of appending into first existing story.
- Group missing anchors into fewer actionable remediation tasks with concrete anchor bundles.

3. **Tests**
- Update/add tests for:
  - heading/folder filtering,
  - grouped remediation task generation,
  - dedicated sufficiency story targeting,
  - simplified direct description output.

4. **Validation**
- Run focused tests for create-tasks and sufficiency services.
- Run `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda`.

5. **Memory updates**
- Save workflow preference: always work on `main` branch for this repo.
- Save repo memory facts summarizing implemented behavior changes.

## Done Criteria
- `create-tasks` output is direct and structured with actionable epics/stories/tasks.
- `task-sufficiency-audit` no longer emits large volumes of generic/non-actionable tasks.
- Tests cover the new behavior and pass.
