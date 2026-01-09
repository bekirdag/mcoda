import test from "node:test";
import assert from "node:assert/strict";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { GlobalMigrations } from "../migrations/global/GlobalMigrations.js";

const openDb = async () =>
  open({
    filename: ":memory:",
    driver: sqlite3.Database,
  });

const columnNames = async (db: any, table: string): Promise<string[]> => {
  const rows = (await db.all(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
  return rows.map((row) => row.name);
};

test("GlobalMigrations recreates legacy schema and adds columns", async () => {
  const db = await openDb();
  try {
    await db.exec("CREATE TABLE agents (name TEXT, provider TEXT);");
    await GlobalMigrations.run(db);

    const columns = await columnNames(db, "agents");
    [
      "id",
      "slug",
      "adapter",
      "rating",
      "reasoning_rating",
      "best_usage",
      "cost_per_million",
    ].forEach((col) => assert.ok(columns.includes(col), `missing column ${col}`));
  } finally {
    await db.close();
  }
});

test("GlobalMigrations backfills ratings for known agents", async () => {
  const db = await openDb();
  try {
    await GlobalMigrations.run(db);
    await db.run(
      "INSERT INTO agents (id, slug, adapter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["agent-1", "gateway-router", "local-model", "now", "now"],
    );

    await GlobalMigrations.run(db);

    const row = (await db.get(
      "SELECT rating, reasoning_rating, best_usage, cost_per_million FROM agents WHERE slug = 'gateway-router'",
    )) as { rating: number; reasoning_rating: number; best_usage: string; cost_per_million: number };
    assert.ok(row);
    assert.equal(row.rating, 10);
    assert.equal(row.reasoning_rating, 10);
    assert.equal(row.best_usage, "orchestration");
    assert.equal(row.cost_per_million, 14);
  } finally {
    await db.close();
  }
});
