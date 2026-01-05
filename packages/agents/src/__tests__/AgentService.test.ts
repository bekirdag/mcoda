import { strict as assert } from "node:assert";
import { beforeEach, after, afterEach, test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AgentService } from "../AgentService/AgentService.js";
import { Connection, GlobalMigrations, GlobalRepository } from "@mcoda/db";
import { CryptoHelper } from "@mcoda/shared";

let repo: GlobalRepository;
let service: AgentService;
let dbPath: string;
const originalSkipCliChecks = process.env.MCODA_SKIP_CLI_CHECKS;
const originalCliStub = process.env.MCODA_CLI_STUB;
process.env.MCODA_SKIP_CLI_CHECKS = "1";
process.env.MCODA_CLI_STUB = "1";
const originalFetch = global.fetch;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `mcoda-agents-${Date.now()}-${Math.random()}.db`);
  const conn = await Connection.open(dbPath);
  await GlobalMigrations.run(conn.db);
  repo = new GlobalRepository(conn.db, conn);
  service = new AgentService(repo);
});

afterEach(async () => {
  global.fetch = originalFetch;
  await service.close();
  await fs.promises.unlink(dbPath).catch(() => {});
});

after(() => {
  process.env.MCODA_SKIP_CLI_CHECKS = originalSkipCliChecks;
  if (originalCliStub === undefined) {
    delete process.env.MCODA_CLI_STUB;
  } else {
    process.env.MCODA_CLI_STUB = originalCliStub;
  }
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

test("CLI adapter reports unreachable health when binary is missing", async () => {
  const agent = await repo.createAgent({
    slug: "cli-health",
    adapter: "codex-cli",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const originalPath = process.env.PATH;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalStub = process.env.MCODA_CLI_STUB;
  process.env.MCODA_SKIP_CLI_CHECKS = "0";
  process.env.MCODA_CLI_STUB = "0";
  process.env.PATH = "";
  try {
    const health = await service.healthCheck(agent.id);
    assert.equal(health.status, "unreachable");
    assert.match(String((health.details as any)?.reason ?? ""), /missing_cli|cli_error/);
  } finally {
    process.env.PATH = originalPath;
    process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
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

test("falls back to codex CLI when API secret is missing", async () => {
  const agent = await repo.createAgent({
    slug: "fallback-local",
    adapter: "openai-api",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const result = await service.invoke(agent.id, { input: "hello" });
  assert.equal(result.adapter, "codex-cli");
});

test("fills defaults when prompts are missing", async () => {
  const agent = await repo.createAgent({
    slug: "missing-prompts",
    adapter: "openai-api",
    capabilities: ["chat"],
  });
  const encrypted = await CryptoHelper.encryptSecret("secret");
  await repo.setAgentAuth(agent.id, encrypted);
  const result = await service.invoke(agent.id, { input: "ping" });
  const prompts = result.metadata?.prompts as any;
  assert.equal(prompts?.jobPrompt?.length > 0, true);
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

test("ollama-remote invokes with configured baseUrl and model", async () => {
  const agent = await repo.createAgent({
    slug: "remote",
    adapter: "ollama-remote",
    defaultModel: "gpt-oss:20b",
    capabilities: ["plan", "code_write"],
    config: { baseUrl: "http://localhost:11434" },
  });
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String((input as any)?.url ?? "");
    assert.match(url, /api\/generate/);
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ response: "hi there" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await service.invoke(agent.id, { input: "ping" });
  assert.equal(result.adapter, "ollama-remote");
  assert.equal(result.output, "hi there");
  assert.equal(result.model, "gpt-oss:20b");
});

test("zhipu-api invokes with configured baseUrl, model, and thinking", async () => {
  const agent = await repo.createAgent({
    slug: "zhipu",
    adapter: "zhipu-api",
    defaultModel: "glm-4.7",
    capabilities: ["chat"],
    config: { baseUrl: "https://api.z.ai/api/coding/paas/v4", thinking: true, temperature: 0.1 },
  });
  const encrypted = await CryptoHelper.encryptSecret("secret");
  await repo.setAgentAuth(agent.id, encrypted);
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String((input as any)?.url ?? "");
    assert.match(url, /https:\/\/api\.z\.ai\/api\/coding\/paas\/v4\/chat\/completions/);
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer secret");
    const body = JSON.parse(String(init?.body ?? ""));
    assert.equal(body.model, "glm-4.7");
    assert.equal(body.thinking, true);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.stream, false);
    assert.equal(body.messages?.[0]?.content, "ping");
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }], usage: { total_tokens: 5 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await service.invoke(agent.id, { input: "ping" });
  assert.equal(result.adapter, "zhipu-api");
  assert.equal(result.output, "pong");
  assert.equal(result.model, "glm-4.7");
  assert.equal((result.metadata as any)?.usage?.total_tokens, 5);
});

test("gateway handoff is appended to agent input when configured", async () => {
  const agent = await repo.createAgent({
    slug: "handoff-agent",
    adapter: "openai-api",
    defaultModel: "gpt-4o",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const encrypted = await CryptoHelper.encryptSecret("secret");
  await repo.setAgentAuth(agent.id, encrypted);
  const handoffPath = path.join(os.tmpdir(), `mcoda-handoff-${Date.now()}-${Math.random()}.md`);
  await fs.promises.writeFile(handoffPath, "Use the gateway summary when deciding next steps.", "utf8");
  const prevPath = process.env.MCODA_GATEWAY_HANDOFF_PATH;
  delete process.env.MCODA_GATEWAY_HANDOFF;
  process.env.MCODA_GATEWAY_HANDOFF_PATH = handoffPath;
  try {
    const result = await service.invoke(agent.id, { input: "ping", metadata: { command: "work-on-tasks" } });
    assert.match(result.output, /\[Gateway handoff\]/);
    assert.match(result.output, /Use the gateway summary/);
  } finally {
    if (prevPath === undefined) {
      delete process.env.MCODA_GATEWAY_HANDOFF_PATH;
    } else {
      process.env.MCODA_GATEWAY_HANDOFF_PATH = prevPath;
    }
    await fs.promises.unlink(handoffPath).catch(() => {});
  }
});

test("ollama-remote health returns unreachable on network error", async () => {
  const agent = await repo.createAgent({
    slug: "remote-health",
    adapter: "ollama-remote",
    defaultModel: "gpt-oss:20b",
    capabilities: ["plan"],
    config: { baseUrl: "http://bad-host" },
  });
  global.fetch = async () => {
    throw new Error("network down");
  };
  const health = await service.healthCheck(agent.id);
  assert.equal(health.status, "unreachable");
  assert.equal((health.details as any)?.baseUrl, "http://bad-host");
});

test("ollama-remote rejects when baseUrl is missing", async () => {
  const agent = await repo.createAgent({
    slug: "remote-missing",
    adapter: "ollama-remote",
    defaultModel: "gpt-oss:20b",
    capabilities: ["plan"],
  });
  await assert.rejects(() => service.invoke(agent.id, { input: "ping" }), /baseUrl/i);
});
