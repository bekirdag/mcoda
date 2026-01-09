import test from "node:test";
import assert from "node:assert/strict";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { WorkspaceMigrations } from "../migrations/workspace/WorkspaceMigrations.js";

const openDb = async () =>
  open({
    filename: ":memory:",
    driver: sqlite3.Database,
  });

const listTables = async (db: any): Promise<Set<string>> => {
  const rows = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
};

test("WorkspaceMigrations creates core tables and indexes", async () => {
  const db = await openDb();
  try {
    await WorkspaceMigrations.run(db);
    const tables = await listTables(db);

    [
      "projects",
      "epics",
      "user_stories",
      "tasks",
      "task_dependencies",
      "jobs",
      "command_runs",
      "task_runs",
      "task_locks",
      "task_qa_runs",
      "task_logs",
      "task_revisions",
      "task_comments",
      "task_reviews",
      "token_usage",
    ].forEach((table) => assert.ok(tables.has(table), `missing table ${table}`));

    const taskColumns = (await db.all("PRAGMA table_info(tasks)")) as Array<{ name: string }>;
    assert.ok(taskColumns.some((col) => col.name === "openapi_version_at_creation"));

    const lockIndexes = (await db.all("PRAGMA index_list(task_locks)")) as Array<{ name: string }>;
    assert.ok(lockIndexes.some((idx) => idx.name === "idx_task_locks_expires_at"));
  } finally {
    await db.close();
  }
});
