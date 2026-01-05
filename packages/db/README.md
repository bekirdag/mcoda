# @mcoda/db

SQLite-backed storage for mcoda global and workspace state.

## Install
- Requires Node.js >= 20.
- Install: `npm i @mcoda/db`

## What it provides
- Connection helpers for global/workspace databases.
- Migrations for global agent registry and workspace task data.
- Repositories for common queries (GlobalRepository, WorkspaceRepository).

## Example
```ts
import { Connection, WorkspaceMigrations } from "@mcoda/db";

const conn = await Connection.openWorkspace();
await WorkspaceMigrations.run(conn.db);
await conn.close();
```

## Notes
- Uses sqlite3 native bindings.
- Primarily used by the mcoda CLI; APIs may evolve.

## License
MIT - see `LICENSE`.
