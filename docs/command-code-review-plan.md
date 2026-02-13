# Command Code Review Plan

Goal: review each command area listed in `docs/command-code-review-list.md`, capture findings, and write a dedicated review report under `docs/` for every area.

## Review artifacts
- Create one report per area: `docs/reviews/<area>-review.md` (example: `docs/reviews/agents-review.md`).
- Each report must contain:
  - **Scope**: commands + primary code files reviewed.
  - **Findings list**: issues, risks, or inconsistencies with file references.
  - **Suggestions list**: improvements or refactors.
  - **Enhancements list**: optional improvements or UX upgrades.
  - **Test gaps**: missing/weak tests and suggested additions.
  - **Notes**: any assumptions or constraints.

## Review workflow
1. **Load scope**: use `docs/command-code-review-list.md` to map the commands, primary code, and test files for the current area.
2. **Read code**: inspect CLI command handlers first, then the supporting core service(s), then DB repo helpers if used.
3. **Validate contract**:
   - CLI args/usage string match behavior.
   - JSON output flags behave consistently and include all required fields.
   - Error handling is consistent and actionable.
4. **Cross-check tests**:
   - Verify tests cover the main command paths and JSON output.
   - Note missing edge cases or failure modes.
5. **Record findings**:
   - Capture issues/suggestions/enhancements in the report file.
   - Use one-line bullets with file references.
6. **Repeat per area**:
   - Agents, Routing, Planning, Backlog, Estimation, Execution, Jobs/Telemetry, Docs/OpenAPI, Updates/Workspace.

## Sequencing
1. Agents and routing (shared surfaces for many workflows).
2. Planning + backlog + estimate (planning stack).
3. Execution workflows (work/review/QA).
4. Jobs + telemetry.
5. Docs/OpenAPI.
6. Updates/workspace setup.

## Completion criteria
- Every area listed in `docs/command-code-review-list.md` has a corresponding review report under `docs/reviews/`.
- Each report has populated sections for findings, suggestions, enhancements, and test gaps.
- File references are included for every finding.
