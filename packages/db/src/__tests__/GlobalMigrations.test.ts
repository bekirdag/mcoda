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
      "openai_compatible",
      "context_window",
      "max_output_tokens",
      "supports_tools",
      "rating",
      "reasoning_rating",
      "best_usage",
      "cost_per_million",
      "max_complexity",
      "rating_samples",
      "rating_last_score",
      "rating_updated_at",
      "complexity_samples",
      "complexity_updated_at",
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
      "SELECT rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, complexity_samples FROM agents WHERE slug = 'gateway-router'",
    )) as {
      rating: number;
      reasoning_rating: number;
      best_usage: string;
      cost_per_million: number;
      max_complexity: number;
      rating_samples: number;
      complexity_samples: number;
    };
    assert.ok(row);
    assert.equal(row.rating, 10);
    assert.equal(row.reasoning_rating, 10);
    assert.equal(row.best_usage, "orchestration");
    assert.equal(row.cost_per_million, 14);
    assert.equal(row.max_complexity, 5);
    assert.equal(row.rating_samples, 0);
    assert.equal(row.complexity_samples, 0);
  } finally {
    await db.close();
  }
});

test("GlobalMigrations backfills GLM pricing for current z.ai models", async () => {
  const db = await openDb();
  try {
    await GlobalMigrations.run(db);
    await db.run(
      "INSERT INTO agents (id, slug, adapter, default_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["agent-glm-5", "glm-5", "zhipu-api", "glm-5", "now", "now"],
    );
    await db.run(
      "INSERT INTO agents (id, slug, adapter, default_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["agent-glm-47", "glm-worker", "zhipu-api", "glm-4.7", "now", "now"],
    );

    await GlobalMigrations.run(db);

    const rows = (await db.all(
      "SELECT slug, cost_per_million FROM agents WHERE slug IN ('glm-5', 'glm-worker') ORDER BY slug",
    )) as Array<{ slug: string; cost_per_million: number }>;

    assert.deepEqual(rows, [
      { slug: "glm-5", cost_per_million: 3.2 },
      { slug: "glm-worker", cost_per_million: 2.2 },
    ]);
  } finally {
    await db.close();
  }
});

test("GlobalMigrations ensures gateway-router capabilities", async () => {
  const db = await openDb();
  try {
    await GlobalMigrations.run(db);
    await db.run(
      "INSERT INTO agents (id, slug, adapter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["agent-1", "gateway-router", "local-model", "now", "now"],
    );

    await GlobalMigrations.run(db);

    const rows = (await db.all(
      "SELECT capability FROM agent_capabilities WHERE agent_id = ? ORDER BY capability",
      "agent-1",
    )) as Array<{ capability: string }>;
    const caps = rows.map((row) => row.capability);
    assert.ok(caps.includes("plan"));
    assert.ok(caps.includes("docdex_query"));
  } finally {
    await db.close();
  }
});

test("GlobalMigrations creates agent_usage_limits table with required columns", async () => {
  const db = await openDb();
  try {
    await GlobalMigrations.run(db);
    const columns = await columnNames(db, "agent_usage_limits");
    [
      "id",
      "agent_id",
      "limit_scope",
      "limit_key",
      "window_type",
      "status",
      "reset_at",
      "observed_at",
      "source",
      "details_json",
      "created_at",
      "updated_at",
    ].forEach((col) => assert.ok(columns.includes(col), `missing column ${col}`));
    const indexes = (await db.all("PRAGMA index_list(agent_usage_limits)")) as Array<{ name: string }>;
    assert.ok(
      indexes.some((entry) => entry.name === "idx_agent_usage_limits_agent_id"),
      "missing idx_agent_usage_limits_agent_id",
    );
  } finally {
    await db.close();
  }
});
