import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Connection } from "../sqlite/connection.js";
import { GlobalMigrations } from "../migrations/global/GlobalMigrations.js";
import { WorkspaceMigrations } from "../migrations/workspace/WorkspaceMigrations.js";

const AGENT_TABLES = [
  "agents",
  "agent_auth",
  "agent_capabilities",
  "agent_prompts",
  "agent_health",
  "agent_models",
  "workspace_defaults",
];

const collectTables = async (db: any): Promise<Set<string>> => {
  const rows = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) as Array<{
    name?: string;
  }>;
  return new Set(rows.map((r) => (r.name ?? "").toString()));
};

const readOpenapiTables = async (): Promise<Set<string>> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const openapiPath = path.resolve(here, "../../../../openapi/mcoda.yaml");
  const content = await fs.readFile(openapiPath, "utf8");
  const matches = [...content.matchAll(/x-mcoda-db-table:\s*([A-Za-z0-9_]+)/g)];
  return new Set(matches.map((m) => m[1]));
};

const withTempDb = async (fn: (dbPath: string) => Promise<void>): Promise<void> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-schema-"));
  try {
    const dbPath = path.join(dir, "mcoda.db");
    await fn(dbPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

test("agent-related x-mcoda-db-table entries exist in global DB and not in workspace DB", async () => {
  const tablesFromOpenapi = await readOpenapiTables();
  for (const table of AGENT_TABLES) {
    assert.ok(
      tablesFromOpenapi.has(table),
      `OpenAPI x-mcoda-db-table is missing expected table ${table}`,
    );
  }

  await withTempDb(async (dbPath) => {
    const globalConn = await Connection.open(dbPath);
    await GlobalMigrations.run(globalConn.db);
    const globalTables = await collectTables(globalConn.db);
    await globalConn.close();

    AGENT_TABLES.forEach((table) => {
      assert.ok(globalTables.has(table), `Global DB missing table ${table}`);
    });
  });

  await withTempDb(async (dbPath) => {
    const workspaceConn = await Connection.open(dbPath);
    await WorkspaceMigrations.run(workspaceConn.db);
    const workspaceTables = await collectTables(workspaceConn.db);
    await workspaceConn.close();

    AGENT_TABLES.forEach((table) => {
      assert.equal(
        workspaceTables.has(table),
        false,
        `Workspace DB should not contain agent table ${table}`,
      );
    });
  });
});
