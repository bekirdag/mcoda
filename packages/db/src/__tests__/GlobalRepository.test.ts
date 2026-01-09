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
    maxComplexity: 6,
    ratingSamples: 3,
    ratingLastScore: 8.4,
    ratingUpdatedAt: "2024-01-01T00:00:00.000Z",
    complexitySamples: 2,
    complexityUpdatedAt: "2024-01-02T00:00:00.000Z",
    capabilities: ["plan", "code_write"],
    models: [
      { agentId: "ignored", modelName: "gpt-4o", isDefault: true },
      { agentId: "ignored", modelName: "gpt-4.1-mini", isDefault: false },
    ],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  assert.equal(created.slug, "test-agent");

  const fetched = await repo.getAgentBySlug("test-agent");
  assert.ok(fetched);
  assert.equal(fetched?.defaultModel, "gpt-4o");
  assert.equal(fetched?.maxComplexity, 6);
  assert.equal(fetched?.ratingSamples, 3);
  assert.equal(fetched?.ratingLastScore, 8.4);
  assert.equal(fetched?.ratingUpdatedAt, "2024-01-01T00:00:00.000Z");
  assert.equal(fetched?.complexitySamples, 2);
  assert.equal(fetched?.complexityUpdatedAt, "2024-01-02T00:00:00.000Z");

  const capabilities = await repo.getAgentCapabilities(created.id);
  assert.deepEqual(capabilities.sort(), ["code_write", "plan"].sort());

  const prompts = await repo.getAgentPrompts(created.id);
  assert.equal(prompts?.jobPrompt, "job");

  const models = await repo.getAgentModels(created.id);
  assert.equal(models.length, 2);
  assert.equal(models[0]?.agentId, created.id);

  await repo.updateAgent(created.id, { defaultModel: "gpt-4.1-mini", maxComplexity: 7, ratingSamples: 4 });
  const updated = await repo.getAgentById(created.id);
  assert.equal(updated?.defaultModel, "gpt-4.1-mini");
  assert.equal(updated?.maxComplexity, 7);
  assert.equal(updated?.ratingSamples, 4);

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

test("records command runs and token usage", async () => {
  const created = await repo.createAgent({ slug: "telemetry-agent", adapter: "codex-cli" });
  const run = await repo.createCommandRun({
    commandName: "agent.test",
    startedAt: new Date().toISOString(),
    status: "running",
    payload: { agentId: created.id },
  });
  await repo.recordTokenUsage({
    agentId: created.id,
    commandRunId: run.id,
    modelName: "test-model",
    tokensPrompt: 0,
    tokensCompletion: 0,
    tokensTotal: 0,
    timestamp: new Date().toISOString(),
    metadata: { reason: "test" },
  });
  await repo.completeCommandRun(run.id, {
    status: "succeeded",
    completedAt: new Date().toISOString(),
  });

  const runs = await (repo as any).db.all("SELECT command_name FROM command_runs WHERE id = ?", run.id);
  assert.equal(runs.length, 1);
  const usage = await (repo as any).db.all("SELECT agent_id FROM token_usage WHERE command_run_id = ?", run.id);
  assert.equal(usage.length, 1);
});

test("stores agent run ratings", async () => {
  const created = await repo.createAgent({ slug: "rating-agent", adapter: "codex-cli" });
  const inserted = await repo.insertAgentRunRating({
    agentId: created.id,
    jobId: "job-1",
    commandRunId: "run-1",
    taskId: "task-1",
    taskKey: "proj-01-t01",
    commandName: "work-on-tasks",
    discipline: "backend",
    complexity: 7,
    qualityScore: 8.5,
    tokensTotal: 1200,
    durationSeconds: 45.5,
    iterations: 2,
    totalCost: 0.012,
    runScore: 7.9,
    ratingVersion: "v1",
    rawReview: { quality_score: 8.5 },
    createdAt: new Date().toISOString(),
  });
  assert.ok(inserted.id);

  const rows = await repo.listAgentRunRatings(created.id, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.agentId, created.id);
  assert.equal(rows[0]?.complexity, 7);
  assert.equal(rows[0]?.runScore, 7.9);
  assert.deepEqual(rows[0]?.rawReview, { quality_score: 8.5 });
});
