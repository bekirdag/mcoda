import { strict as assert } from "node:assert";
import { test, beforeEach, afterEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Connection } from "../sqlite/connection.js";
import { GlobalMigrations } from "../migrations/global/GlobalMigrations.js";
import { GlobalRepository } from "../repositories/global/GlobalRepository.js";

let repo: GlobalRepository;
let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `mcoda-agent-${Date.now()}-${Math.random()}.db`);
  const conn = await Connection.open(dbPath);
  await GlobalMigrations.run(conn.db);
  repo = new GlobalRepository(conn.db, conn);
});

afterEach(async () => {
  await repo.close();
  await fs.promises.unlink(dbPath).catch(() => {});
});

test("creates, updates, and deletes an agent with capabilities and prompts", async () => {
  const created = await repo.createAgent({
    slug: "test-agent",
    adapter: "openai-api",
    defaultModel: "gpt-4o",
    capabilities: ["plan", "code_write"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  assert.equal(created.slug, "test-agent");

  const fetched = await repo.getAgentBySlug("test-agent");
  assert.ok(fetched);
  assert.equal(fetched?.defaultModel, "gpt-4o");

  const capabilities = await repo.getAgentCapabilities(created.id);
  assert.deepEqual(capabilities.sort(), ["code_write", "plan"].sort());

  const prompts = await repo.getAgentPrompts(created.id);
  assert.equal(prompts?.jobPrompt, "job");

  await repo.updateAgent(created.id, { defaultModel: "gpt-4.1-mini" });
  const updated = await repo.getAgentById(created.id);
  assert.equal(updated?.defaultModel, "gpt-4.1-mini");

  await repo.deleteAgent(created.id);
  const afterDelete = await repo.getAgentById(created.id);
  assert.equal(afterDelete, undefined);
});

test("stores auth metadata and health records", async () => {
  const created = await repo.createAgent({
    slug: "auth-agent",
    adapter: "openai-api",
  });
  await repo.setAgentAuth(created.id, "encrypted-secret");
  const auth = await repo.getAgentAuthMetadata(created.id);
  assert.equal(auth.configured, true);

  const health = {
    agentId: created.id,
    status: "healthy" as const,
    lastCheckedAt: new Date().toISOString(),
    latencyMs: 5,
  };
  await repo.setAgentHealth(health);
  const storedHealth = await repo.getAgentHealth(created.id);
  assert.equal(storedHealth?.status, "healthy");
});
