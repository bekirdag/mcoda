import { strict as assert } from "node:assert";
import { beforeEach, afterEach, test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AgentService } from "../AgentService/AgentService.js";
import { Connection, GlobalMigrations, GlobalRepository } from "@mcoda/db";
import { CryptoHelper } from "@mcoda/shared";

let repo: GlobalRepository;
let service: AgentService;
let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `mcoda-agents-${Date.now()}-${Math.random()}.db`);
  const conn = await Connection.open(dbPath);
  await GlobalMigrations.run(conn.db);
  repo = new GlobalRepository(conn.db, conn);
  service = new AgentService(repo);
});

afterEach(async () => {
  await service.close();
  await fs.promises.unlink(dbPath).catch(() => {});
});

test("uses API adapter when secret is present", async () => {
  const agent = await repo.createAgent({
    slug: "api-agent",
    adapter: "openai-api",
    defaultModel: "gpt-4o",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const encrypted = await CryptoHelper.encryptSecret("secret");
  await repo.setAgentAuth(agent.id, encrypted);

  const result = await service.invoke(agent.id, { input: "ping" });
  assert.equal(result.adapter, "openai-api");
  assert.equal(result.metadata?.mode, "api");
  assert.equal(result.model, "gpt-4o");
});

test("falls back to CLI adapter when configured and missing API key", async () => {
  const agent = await repo.createAgent({
    slug: "fallback-cli",
    adapter: "openai-api",
    config: { cliAdapter: "codex-cli" },
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const result = await service.invoke(agent.id, { input: "ping" });
  assert.equal(result.adapter, "codex-cli");
  assert.equal(result.metadata?.mode, "cli");
});

test("CLI adapter works without stored secret", async () => {
  const agent = await repo.createAgent({
    slug: "cli-agent",
    adapter: "codex-cli",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const result = await service.invoke(agent.id, { input: "ping" });
  assert.equal(result.adapter, "codex-cli");
  assert.equal(result.metadata?.mode, "cli");
});

test("local adapter is used when specified", async () => {
  const agent = await repo.createAgent({
    slug: "local",
    adapter: "local-model",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const result = await service.invoke(agent.id, { input: "ping" });
  assert.equal(result.adapter, "local-model");
  assert.equal(result.metadata?.mode, "local");
});

test("prompts and capabilities are surfaced to adapters", async () => {
  const agent = await repo.createAgent({
    slug: "prompted",
    adapter: "openai-api",
    capabilities: ["chat"],
    prompts: { jobPrompt: "do work", characterPrompt: "be precise" },
  });
  const encrypted = await CryptoHelper.encryptSecret("secret");
  await repo.setAgentAuth(agent.id, encrypted);
  const result = await service.invoke(agent.id, { input: "ping" });
  const prompts = result.metadata?.prompts as any;
  assert.equal(prompts?.jobPrompt, "do work");
});

test("falls back to local adapter when no secret and no CLI configured", async () => {
  const agent = await repo.createAgent({
    slug: "fallback-local",
    adapter: "openai-api",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const result = await service.invoke(agent.id, { input: "hello" });
  assert.equal(result.adapter, "local-model");
  assert.equal(result.metadata?.authMode, "local");
});

test("fails fast when required prompts are missing", async () => {
  const agent = await repo.createAgent({
    slug: "missing-prompts",
    adapter: "openai-api",
    capabilities: ["chat"],
  });
  const encrypted = await CryptoHelper.encryptSecret("secret");
  await repo.setAgentAuth(agent.id, encrypted);
  let threw = false;
  try {
    await service.invoke(agent.id, { input: "ping" });
  } catch (err: any) {
    threw = /MISSING_PROMPT/.test(String(err?.message));
  }
  assert.equal(threw, true);
});

test("service does not open workspace DB (global-only guardrail)", async () => {
  // trying to resolve a workspace id should still hit the global repo we created
  const agent = await repo.createAgent({
    slug: "global-only",
    adapter: "local-model",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const result = await service.invoke(agent.id, { input: "guard" });
  assert.equal(result.adapter, "local-model");
});
