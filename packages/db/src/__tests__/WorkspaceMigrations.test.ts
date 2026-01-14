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
      "task_status_events",
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
    const statusEventIndexes = (await db.all("PRAGMA index_list(task_status_events)")) as Array<{ name: string }>;
    assert.ok(statusEventIndexes.some((idx) => idx.name === "idx_task_status_events_task_id_timestamp"));

    const commentColumns = (await db.all("PRAGMA table_info(task_comments)")) as Array<{ name: string }>;
    assert.ok(commentColumns.some((col) => col.name === "slug"));
    assert.ok(commentColumns.some((col) => col.name === "status"));
    const commentIndexes = (await db.all("PRAGMA index_list(task_comments)")) as Array<{ name: string }>;
    assert.ok(commentIndexes.some((idx) => idx.name === "idx_task_comments_slug"));

    const tokenUsageColumns = (await db.all("PRAGMA table_info(token_usage)")) as Array<{ name: string }>;
    const tokenUsageNames = new Set(tokenUsageColumns.map((col) => col.name));
    [
      "command_name",
      "action",
      "invocation_kind",
      "provider",
      "currency",
      "tokens_cached",
      "tokens_cache_read",
      "tokens_cache_write",
      "duration_ms",
      "started_at",
      "finished_at",
    ].forEach((name) => assert.ok(tokenUsageNames.has(name), `missing token_usage column ${name}`));

    const jobColumns = (await db.all("PRAGMA table_info(jobs)")) as Array<{ name: string }>;
    const jobNames = new Set(jobColumns.map((col) => col.name));
    ["agent_id", "agent_ids_json"].forEach((name) => assert.ok(jobNames.has(name), `missing jobs column ${name}`));

    const commandRunColumns = (await db.all("PRAGMA table_info(command_runs)")) as Array<{ name: string }>;
    const commandRunNames = new Set(commandRunColumns.map((col) => col.name));
    ["agent_id"].forEach((name) => assert.ok(commandRunNames.has(name), `missing command_runs column ${name}`));
  } finally {
    await db.close();
  }
});
