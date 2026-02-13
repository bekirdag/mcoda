# Workspace Storage Migration Plan

## Goals
- Move all workspace state from `<repo>/.mcoda` to `~/.mcoda/workspaces/<fingerprint>`.
- Use a deterministic workspace fingerprint derived from the workspace root path.
- Avoid writing any workspace artifacts into the repo (no `.mcoda` or `.gitignore` edits).
- Preserve existing workspace data by copying legacy `.mcoda` contents into the new location when present.

## Scope
- Path resolution in `@mcoda/shared` and workspace resolution/migration in `@mcoda/core`.
- All services that read/write workspace artifacts (jobs, prompts, docs, tasks, QA, review, etc.).
- Docdex local store path.
- CLI messaging and documentation describing workspace storage.
- Tests that assume repo-local `.mcoda` paths.

## Steps
1. Update `PathHelper` to compute a global workspace directory under `~/.mcoda/workspaces/<name>-<hash>` and route `getWorkspaceDir`/`getWorkspaceDbPath` to that location.
2. Update `WorkspaceResolver` to always use the global workspace dir, copy legacy `<repo>/.mcoda` data into it when present, and read legacy config/identity as fallback.
3. Replace direct `path.join(workspaceRoot, ".mcoda", ...)` usage with `workspace.mcodaDir` across core services and integrations. Remove `.gitignore` writes.
4. Adjust relative-path reporting for artifacts to be relative to `workspace.mcodaDir` (or absolute) to avoid odd `../../` paths.
5. Update CLI messaging and docs to point to `~/.mcoda/workspaces/<fingerprint>` instead of `<repo>/.mcoda`.
6. Update tests to use the new path helpers, set temp `HOME`/`USERPROFILE` where needed, and rewrite expectations for workspace paths.

## Risks & Mitigations
- **Legacy data loss**: copy legacy `.mcoda` content into the new global dir on first resolve.
- **Unexpected repo writes**: remove `.gitignore` updates and repo `.mcoda` writes from services.
- **Tests writing to real home**: ensure tests set temp `HOME` when relying on global paths.

## Validation
- Re-run unit tests for path helpers and workspace resolver.
- Smoke-test commands that create jobs, docs, and QA artifacts to confirm files land under `~/.mcoda/workspaces/<fingerprint>`.
- Verify docdex local store uses the new workspace path.
