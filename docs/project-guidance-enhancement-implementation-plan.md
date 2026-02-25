# Project Guidance Enhancement Implementation Plan

## Objective
Align `project-guidance` behavior with the full mcoda workflow:

1. guidance must exist from first run,
2. guidance should be project-aware,
3. guidance should be SDS-aligned by default,
4. work/review/qa commands should consume consistent guidance,
5. guidance quality/staleness must be observable.

## Scope
- Command: `mcoda project-guidance`
- Workspace bootstrap: `mcoda set-workspace`
- Runtime consumers: `work-on-tasks`, `code-review`, `qa-tasks`
- Shared service: `packages/core/src/services/shared/ProjectGuidance.ts`
- Docs/metadata alignment

## Design Decisions
- Keep guidance persistence in workspace state (`~/.mcoda/workspaces/.../docs/...`).
- Add project-scoped guidance path support:
  - workspace-global: `<workspace>/docs/project-guidance.md`
  - project-scoped: `<workspace>/docs/projects/<project-slug>/project-guidance.md`
- Use SDS as first-class source when generating guidance:
  - discover SDS with deterministic + fuzzy matching,
  - generate guidance content seeded from SDS sections,
  - embed SDS hash metadata for staleness detection.
- Preserve backward compatibility:
  - existing command usage still works,
  - existing global guidance fallback is maintained.

## Workstreams

### WS1: Shared Guidance Service Hardening
- Extend `ProjectGuidance` and ensure/load result shapes with warnings/staleness metadata.
- Add project key support to resolve/load/ensure functions.
- Add SDS discovery and SDS-derived guidance rendering.
- Add frontmatter metadata (`mcoda_guidance`, `project_key`, `sds_source`, `sds_sha256`, `generated_at`).
- Add stale SDS detection and managed-file auto-refresh path.
- Add guidance quality validation (required sections + placeholder detection).

### WS2: Command Surface Enhancement
- Extend `project-guidance` CLI parsing with `--project`.
- Add project key resolution strategy:
  - explicit `--project`,
  - workspace configured key,
  - first project in workspace DB,
  - fallback to global guidance when no project exists.
- Include richer JSON output: `projectKey`, `source`, `sdsSource`, `warnings`.

### WS3: First-Run Bootstrap Alignment
- `set-workspace`: ensure guidance exists immediately after workspace bootstrap.
- Keep bootstrap non-blocking (warn on failure, do not abort workspace setup).

### WS4: Runtime Command Alignment
- `work-on-tasks`: ensure/load project-aware guidance and log warnings.
- `code-review`: ensure guidance before loading and propagate warning diagnostics.
- `qa-tasks`: ensure guidance at run start + project-aware load in agent prompt paths.

### WS5: Documentation and Metadata
- Update `docs/usage.md` and `README.md` for project guidance defaults and command usage.
- Update command metadata aliases/capability fallback entries.

### WS6: Validation and Regression Coverage
- Expand shared guidance tests for:
  - project-scoped path generation,
  - SDS-seeded guidance generation,
  - stale detection and managed auto-refresh.
- Expand CLI tests for:
  - `--project` parsing,
  - project-scoped command output.
- Run targeted suites and broader package tests.

## Risks and Mitigations
- Risk: SDS fuzzy match picks wrong file.
  - Mitigation: deterministic candidate priority + scoring + SDS-content signals.
- Risk: custom guidance gets overwritten unexpectedly.
  - Mitigation: auto-refresh only for managed files marked `mcoda_guidance: true`.
- Risk: runtime performance regression from repeated guidance resolution.
  - Mitigation: staleness checks rely on frontmatter source path/hash; avoid broad scans on load.

## Exit Criteria
- Guidance is created automatically on workspace setup.
- Guidance can be generated per project without breaking existing global behavior.
- Runtime commands consume project-aware guidance consistently.
- SDS changes can be detected and refresh managed guidance content.
- Tests validate core behavior and pass.
