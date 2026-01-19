# @mcoda/core

Core services that power the mcoda CLI (docs, planning, jobs, telemetry, openapi).

## Install
- Requires Node.js >= 20.
- Install: `npm i @mcoda/core`

## What it provides
- WorkspaceResolver for discovering/initializing workspace data under `~/.mcoda/workspaces/<fingerprint>`.
- Service layer for docs, planning, execution, review, telemetry, and system updates.
- API wrappers (AgentsApi, TasksApi, QaTasksApi) used by the CLI.

## Example
```ts
import { WorkspaceResolver, JobService } from "@mcoda/core";

const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: process.cwd() });
const jobs = new JobService(workspace);
// Use jobs to record command runs, token usage, and job state.
```

## Notes
- Most services expect a resolved workspace and read/write state under `~/.mcoda/workspaces/<fingerprint>`.
- Primarily used by the mcoda CLI; APIs may evolve.

## License
MIT - see `LICENSE`.
