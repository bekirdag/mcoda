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
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String((input as any)?.url ?? "");
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = String(body?.messages?.[0]?.content ?? "");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { total_tokens: Math.max(content.length, 1) },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    throw new Error(`Unexpected fetch in AgentService.test: ${url}`);
  };
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

test("Claude CLI adapter works without stored secret", async () => {
  const originalBin = process.env.MCODA_CLAUDE_CLI_BIN;
  try {
    process.env.MCODA_CLAUDE_CLI_BIN = "/definitely/missing/claude";
    const agent = await repo.createAgent({
      slug: "claude-cli-agent",
      adapter: "claude-cli",
      capabilities: ["chat"],
      prompts: { jobPrompt: "job", characterPrompt: "character" },
    });
    const result = await service.invoke(agent.id, { input: "ping" });
    assert.equal(result.adapter, "claude-cli");
    assert.equal(result.metadata?.mode, "cli");
    assert.match(result.output, /claude-stub:/);
  } finally {
    if (originalBin === undefined) {
      delete process.env.MCODA_CLAUDE_CLI_BIN;
    } else {
      process.env.MCODA_CLAUDE_CLI_BIN = originalBin;
    }
  }
});

test("adapter override uses the requested adapter for invoke", async () => {
  const originalKey = process.env.CODALI_API_KEY;
  const agent = await repo.createAgent({
    slug: "override",
    adapter: "openai-api",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  try {
    process.env.CODALI_API_KEY = process.env.CODALI_API_KEY ?? "test-key";
    const result = await service.invoke(agent.id, { input: "ping", adapterType: "codali-cli" });
    assert.equal(result.adapter, "codali-cli");
    assert.equal(result.metadata?.mode, "cli");
    assert.match(result.output, /codali-stub/);
  } finally {
    if (originalKey === undefined) {
      delete process.env.CODALI_API_KEY;
    } else {
      process.env.CODALI_API_KEY = originalKey;
    }
  }
});

test("adapter override rejects unsupported adapter types", async () => {
  const agent = await repo.createAgent({
    slug: "override-bad",
    adapter: "openai-api",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  await assert.rejects(
    service.invoke(agent.id, { input: "ping", adapterType: "unknown-adapter" }),
    /Unsupported adapter type: unknown-adapter/,
  );
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
    defaultModel: "gpt-4o",
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
    defaultModel: "gpt-4o",
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
    config: { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", thinking: true, temperature: 0.1 },
  });
  const encrypted = await CryptoHelper.encryptSecret("secret");
  await repo.setAgentAuth(agent.id, encrypted);
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String((input as any)?.url ?? "");
    assert.match(url, /https:\/\/open\.bigmodel\.cn\/api\/coding\/paas\/v4\/chat\/completions/);
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer secret");
    const body = JSON.parse(String(init?.body ?? ""));
    assert.equal(body.model, "glm-4.7");
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.temperature, 0.1);
    assert.equal(body.stream, false);
    const content = String(body.messages?.[0]?.content ?? "");
    assert.ok(content.includes("ping"));
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

test("gateway handoff is not duplicated when header already present", async () => {
  const agent = await repo.createAgent({
    slug: "handoff-dedupe",
    adapter: "local-model",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const prevInline = process.env.MCODA_GATEWAY_HANDOFF;
  const prevPath = process.env.MCODA_GATEWAY_HANDOFF_PATH;
  process.env.MCODA_GATEWAY_HANDOFF = "Handoff detail to skip";
  delete process.env.MCODA_GATEWAY_HANDOFF_PATH;
  // @ts-expect-error override for test
  service.getAdapter = async () => ({
    invoke: async (request: any) => ({
      output: String(request.input ?? ""),
      adapter: "stub",
      model: "stub",
    }),
  });
  try {
    const input = "ping\n\n[Gateway handoff]\nAlready present";
    const result = await service.invoke(agent.id, { input, metadata: { command: "work-on-tasks" } });
    const output = String(result.output ?? "");
    const matches = output.match(/\[Gateway handoff\]/g) ?? [];
    assert.equal(matches.length, 1);
    assert.ok(output.includes("Already present"));
    assert.ok(!output.includes("Handoff detail to skip"));
  } finally {
    if (prevInline === undefined) {
      delete process.env.MCODA_GATEWAY_HANDOFF;
    } else {
      process.env.MCODA_GATEWAY_HANDOFF = prevInline;
    }
    if (prevPath === undefined) {
      delete process.env.MCODA_GATEWAY_HANDOFF_PATH;
    } else {
      process.env.MCODA_GATEWAY_HANDOFF_PATH = prevPath;
    }
  }
});

test("gateway handoff strips END OF FILE markers", async () => {
  const agent = await repo.createAgent({
    slug: "handoff-strip",
    adapter: "local-model",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const prevInline = process.env.MCODA_GATEWAY_HANDOFF;
  const prevPath = process.env.MCODA_GATEWAY_HANDOFF_PATH;
  process.env.MCODA_GATEWAY_HANDOFF = "Keep this\nEND OF FILE\nKeep that\n*** End of File\nFinal";
  delete process.env.MCODA_GATEWAY_HANDOFF_PATH;
  // @ts-expect-error override for test
  service.getAdapter = async () => ({
    invoke: async (request: any) => ({
      output: String(request.input ?? ""),
      adapter: "stub",
      model: "stub",
    }),
  });
  try {
    const result = await service.invoke(agent.id, { input: "ping", metadata: { command: "work-on-tasks" } });
    const output = String(result.output ?? "");
    assert.match(output, /\[Gateway handoff\]/);
    assert.ok(output.includes("Keep this"));
    assert.ok(output.includes("Keep that"));
    assert.ok(output.includes("Final"));
    assert.ok(!/END OF FILE/i.test(output));
    assert.ok(!/\*\*\* End of File/i.test(output));
  } finally {
    if (prevInline === undefined) {
      delete process.env.MCODA_GATEWAY_HANDOFF;
    } else {
      process.env.MCODA_GATEWAY_HANDOFF = prevInline;
    }
    if (prevPath === undefined) {
      delete process.env.MCODA_GATEWAY_HANDOFF_PATH;
    } else {
      process.env.MCODA_GATEWAY_HANDOFF_PATH = prevPath;
    }
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

test("ollama-remote marks health unreachable when model is missing", async () => {
  const agent = await repo.createAgent({
    slug: "remote-missing-model",
    adapter: "ollama-remote",
    defaultModel: "glm-4.7-flash",
    capabilities: ["plan"],
    config: { baseUrl: "http://localhost:11434" },
  });
  const previousFetch = global.fetch;
  global.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : String((input as any)?.url ?? "");
    if (url.includes("/api/generate")) {
      return new Response(`{\"error\":\"model 'glm-4.7-flash' not found\"}`, {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };
  try {
    await assert.rejects(() => service.invoke(agent.id, { input: "ping" }), /MODEL_NOT_FOUND/i);
    const health = await repo.getAgentHealth(agent.id);
    assert.equal(health?.status, "unreachable");
    assert.equal((health?.details as any)?.reason, "model_missing");
  } finally {
    global.fetch = previousFetch as any;
  }
});

test("invoke switches to an equivalent available agent when usage limit is reached", async () => {
  const primary = await repo.createAgent({
    slug: "limit-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "limit-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  const calls: string[] = [];
  // @ts-expect-error override for test
  service.getAdapter = async (agent: any) => ({
    invoke: async () => {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        throw new Error("AUTH_ERROR: usage_limit_reached; try again in 2 hours");
      }
      return { output: `ok:${agent.slug}`, adapter: "local-model", model: agent.defaultModel };
    },
  });
  const result = await service.invoke(primary.id, { input: "ping" });
  assert.equal(result.output, "ok:limit-backup");
  assert.deepEqual(calls, [primary.id, backup.id]);
  const limits = await repo.listAgentUsageLimits(primary.id);
  assert.ok(limits.some((entry) => entry.status === "exhausted"));
  assert.ok(limits.some((entry) => (entry.details as any)?.resetAtSource === "relative"));
});

test("invoke sleeps until reset and retries base agent when no equivalent is available", async () => {
  const primary = await repo.createAgent({
    slug: "sleep-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  let nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const sleeps: number[] = [];
  const clockService = new AgentService(repo, {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });
  let calls = 0;
  // @ts-expect-error override for test
  clockService.getAdapter = async () => ({
    invoke: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("AUTH_ERROR: rate limit reached, retry after 30 seconds");
      }
      return { output: "ok:after-sleep", adapter: "local-model", model: "gpt-5.2-codex" };
    },
  });
  const result = await clockService.invoke(primary.id, { input: "ping" });
  assert.equal(result.output, "ok:after-sleep");
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 30000);
});

test("invoke falls back to window-based reset when usage limit has no explicit reset timestamp", async () => {
  const primary = await repo.createAgent({
    slug: "fallback-reset-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  let nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const sleeps: number[] = [];
  const clockService = new AgentService(repo, {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });
  let calls = 0;
  // @ts-expect-error override for test
  clockService.getAdapter = async () => ({
    invoke: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("AUTH_ERROR: usage_limit_reached for current 5h window");
      }
      return { output: "ok:after-fallback-reset", adapter: "local-model", model: "gpt-5.2-codex" };
    },
  });
  const result = await clockService.invoke(primary.id, { input: "ping" });
  assert.equal(result.output, "ok:after-fallback-reset");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [
    60 * 60 * 1000,
    60 * 60 * 1000,
    60 * 60 * 1000,
    60 * 60 * 1000,
    60 * 60 * 1000,
  ]);
  const failoverEvents = ((result.metadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(failoverEvents.some((event) => event.type === "sleep_until_reset"));
  const limits = await repo.listAgentUsageLimits(primary.id);
  assert.equal(limits.length > 0, true);
  assert.ok(limits.every((entry) => entry.resetAt !== null));
  assert.ok(
    limits.every(
      (entry) => (entry.details as any)?.resetAtSource === "estimated_window_fallback",
    ),
  );
});

test("invoke does not failover on non-limit auth errors", async () => {
  const primary = await repo.createAgent({
    slug: "invalid-key-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  await repo.createAgent({
    slug: "invalid-key-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  let backupCalled = false;
  // @ts-expect-error override for test
  service.getAdapter = async (agent: any) => ({
    invoke: async () => {
      if (agent.id === primary.id) {
        throw new Error("AUTH_ERROR: invalid api key");
      }
      backupCalled = true;
      return { output: "should-not-run", adapter: "local-model", model: agent.defaultModel };
    },
  });
  await assert.rejects(() => service.invoke(primary.id, { input: "ping" }), /invalid api key/i);
  assert.equal(backupCalled, false);
  const limits = await repo.listAgentUsageLimits(primary.id);
  assert.equal(limits.length, 0);
});

test("invoke switches to equivalent available agent on technical failures", async () => {
  const primary = await repo.createAgent({
    slug: "tech-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "tech-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  const calls: string[] = [];
  // @ts-expect-error override for test
  service.getAdapter = async (agent: any) => ({
    invoke: async () => {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        throw new Error("503 service unavailable");
      }
      return { output: "ok:tech-backup", adapter: "local-model", model: backup.defaultModel };
    },
  });
  const result = await service.invoke(primary.id, { input: "ping" });
  assert.equal(result.output, "ok:tech-backup");
  assert.deepEqual(calls, [primary.id, backup.id]);
  const failoverEvents = ((result.metadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(
    failoverEvents.some(
      (event) =>
        event.type === "switch_agent" &&
        event.fromAgentId === primary.id &&
        event.toAgentId === backup.id &&
        event.reason === "technical_issue",
    ),
  );
});

test("invoke treats generic AUTH_ERROR failures as technical and switches to equivalent agent", async () => {
  const primary = await repo.createAgent({
    slug: "auth-generic-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "auth-generic-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  const calls: string[] = [];
  // @ts-expect-error override for test
  service.getAdapter = async (agent: any) => ({
    invoke: async () => {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        throw new Error("AUTH_ERROR: codex CLI failed (exit 1): no output");
      }
      return { output: "ok:auth-backup", adapter: "local-model", model: backup.defaultModel };
    },
  });
  const result = await service.invoke(primary.id, { input: "ping" });
  assert.equal(result.output, "ok:auth-backup");
  assert.deepEqual(calls, [primary.id, backup.id]);
  const failoverEvents = ((result.metadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(
    failoverEvents.some(
      (event) =>
        event.type === "switch_agent" &&
        event.fromAgentId === primary.id &&
        event.toAgentId === backup.id &&
        event.reason === "technical_issue",
    ),
  );
});

test("invoke waits for internet recovery when connectivity fails and all fallbacks are remote", async () => {
  const primary = await repo.createAgent({
    slug: "offline-primary",
    adapter: "codex-cli",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  await repo.createAgent({
    slug: "offline-remote-backup",
    adapter: "codex-cli",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  let nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const sleeps: number[] = [];
  let checks = 0;
  const clockService = new AgentService(repo, {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    checkInternetReachable: async () => {
      checks += 1;
      return checks >= 3;
    },
    connectivityPollIntervalMs: 1000,
  });
  let calls = 0;
  // @ts-expect-error override for test
  clockService.getAdapter = async () => ({
    invoke: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network unreachable");
      }
      return { output: "ok:after-internet", adapter: "codex-cli", model: "gpt-5.2-codex" };
    },
  });
  const result = await clockService.invoke(primary.id, { input: "ping" });
  assert.equal(result.output, "ok:after-internet");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(checks, 3);
  const failoverEvents = ((result.metadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(failoverEvents.some((event) => event.type === "wait_for_internet"));
});

test("invoke uses offline-capable fallback on connectivity failure before waiting for internet", async () => {
  const primary = await repo.createAgent({
    slug: "offline-switch-primary",
    adapter: "codex-cli",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "offline-switch-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  const sleeps: number[] = [];
  const fallbackService = new AgentService(repo, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    checkInternetReachable: async () => false,
    connectivityPollIntervalMs: 1000,
  });
  const calls: string[] = [];
  // @ts-expect-error override for test
  fallbackService.getAdapter = async (agent: any) => ({
    invoke: async () => {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        throw new Error("fetch failed: network down");
      }
      return { output: "ok:local-fallback", adapter: "local-model", model: backup.defaultModel };
    },
  });
  const result = await fallbackService.invoke(primary.id, { input: "ping" });
  assert.equal(result.output, "ok:local-fallback");
  assert.deepEqual(calls, [primary.id, backup.id]);
  assert.deepEqual(sleeps, []);
  const failoverEvents = ((result.metadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(
    failoverEvents.some(
      (event) =>
        event.type === "switch_agent" &&
        event.fromAgentId === primary.id &&
        event.toAgentId === backup.id &&
        event.reason === "connectivity_issue",
    ),
  );
  assert.ok(!failoverEvents.some((event) => event.type === "wait_for_internet"));
});

test("invokeStream switches to equivalent available agent on usage limit", async () => {
  const primary = await repo.createAgent({
    slug: "stream-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "stream-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  // @ts-expect-error override for test
  service.getAdapter = async (agent: any) => ({
    invokeStream: async function* () {
      if (agent.id === primary.id) {
        throw new Error("AUTH_ERROR: usage limit reached, retry after 10 minutes");
      }
      yield { output: "stream-ok", adapter: "local-model", model: backup.defaultModel };
    },
  });
  const chunks: string[] = [];
  let finalMetadata: Record<string, unknown> | undefined;
  const generator = await service.invokeStream(primary.id, { input: "ping" });
  for await (const chunk of generator) {
    chunks.push(chunk.output);
    finalMetadata = chunk.metadata;
  }
  assert.deepEqual(chunks, ["stream-ok"]);
  const failoverEvents = ((finalMetadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(failoverEvents.some((event) => event.type === "switch_agent"));
  assert.ok(
    failoverEvents.some(
      (event) =>
        event.type === "switch_agent" && event.fromAgentId === primary.id && event.toAgentId === backup.id,
    ),
  );
  const limits = await repo.listAgentUsageLimits(primary.id);
  assert.ok(limits.some((entry) => entry.status === "exhausted"));
});

test("invokeStream sleeps until reset and retries base agent when no equivalent is available", async () => {
  const primary = await repo.createAgent({
    slug: "stream-sleep-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  let nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const sleeps: number[] = [];
  const clockService = new AgentService(repo, {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });
  let calls = 0;
  // @ts-expect-error override for test
  clockService.getAdapter = async () => ({
    invokeStream: async function* () {
      calls += 1;
      if (calls === 1) {
        throw new Error("AUTH_ERROR: rate limit reached, retry after 30 seconds");
      }
      yield { output: "stream-after-sleep", adapter: "local-model", model: "gpt-5.2-codex" };
    },
  });

  const chunks: string[] = [];
  let finalMetadata: Record<string, unknown> | undefined;
  const generator = await clockService.invokeStream(primary.id, { input: "ping" });
  for await (const chunk of generator) {
    chunks.push(chunk.output);
    finalMetadata = chunk.metadata;
  }
  assert.deepEqual(chunks, ["stream-after-sleep"]);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [30000]);
  const failoverEvents = ((finalMetadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(failoverEvents.some((event) => event.type === "sleep_until_reset"));
});

test("invokeStream chunks long sleep windows while waiting for reset", async () => {
  const primary = await repo.createAgent({
    slug: "stream-long-sleep-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  let nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const sleeps: number[] = [];
  const clockService = new AgentService(repo, {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });
  let calls = 0;
  // @ts-expect-error override for test
  clockService.getAdapter = async () => ({
    invokeStream: async function* () {
      calls += 1;
      if (calls === 1) {
        throw new Error("AUTH_ERROR: usage limit reached, retry after 3 hours");
      }
      yield { output: "stream-after-long-sleep", adapter: "local-model", model: "gpt-5.2-codex" };
    },
  });

  const chunks: string[] = [];
  const generator = await clockService.invokeStream(primary.id, { input: "ping" });
  for await (const chunk of generator) {
    chunks.push(chunk.output);
  }
  assert.deepEqual(chunks, ["stream-after-long-sleep"]);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [60 * 60 * 1000, 60 * 60 * 1000, 60 * 60 * 1000]);
});

test("invokeStream metadata includes wait and switch failover events", async () => {
  const primary = await repo.createAgent({
    slug: "stream-events-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "stream-events-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  let nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const sleeps: number[] = [];
  const clockService = new AgentService(repo, {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });
  await repo.upsertAgentUsageLimit({
    agentId: backup.id,
    limitScope: "model",
    limitKey: "sonnet",
    windowType: "other",
    status: "exhausted",
    resetAt: new Date(nowMs + 30_000).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
    source: "test",
  });
  let primaryAttempts = 0;
  const calls: string[] = [];
  // @ts-expect-error override for test
  clockService.getAdapter = async (agent: any) => ({
    invokeStream: async function* () {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        primaryAttempts += 1;
        if (primaryAttempts === 1) {
          throw new Error("AUTH_ERROR: usage limit reached, retry after 30 seconds");
        }
        throw new Error("AUTH_ERROR: usage limit reached, retry after 10 minutes");
      }
      yield { output: "stream-after-wait-and-switch", adapter: "local-model", model: backup.defaultModel };
    },
  });

  const chunks: string[] = [];
  let finalMetadata: Record<string, unknown> | undefined;
  const generator = await clockService.invokeStream(primary.id, { input: "ping" });
  for await (const chunk of generator) {
    chunks.push(chunk.output);
    finalMetadata = chunk.metadata;
  }
  assert.deepEqual(chunks, ["stream-after-wait-and-switch"]);
  assert.deepEqual(calls, [primary.id, primary.id, backup.id]);
  assert.deepEqual(sleeps, [30000]);
  const failoverEvents = ((finalMetadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(
    failoverEvents.map((event) => event.type),
    ["sleep_until_reset", "switch_agent"],
  );
});

test("invokeStream continues with an equivalent agent after partial output hits usage limit", async () => {
  const primary = await repo.createAgent({
    slug: "stream-partial-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "stream-partial-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  const calls: string[] = [];
  // @ts-expect-error override for test
  service.getAdapter = async (agent: any) => ({
    invokeStream: async function* () {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        yield { output: "primary-first-chunk", adapter: "local-model", model: primary.defaultModel };
        throw new Error("AUTH_ERROR: usage limit reached, retry after 10 minutes");
      }
      yield { output: "backup-resume-chunk", adapter: "local-model", model: backup.defaultModel };
    },
  });

  const chunks: string[] = [];
  let finalMetadata: Record<string, unknown> | undefined;
  const generator = await service.invokeStream(primary.id, { input: "ping" });
  for await (const chunk of generator) {
    chunks.push(chunk.output);
    finalMetadata = chunk.metadata;
  }

  assert.deepEqual(calls, [primary.id, backup.id]);
  assert.deepEqual(chunks, ["primary-first-chunk", "backup-resume-chunk"]);
  const failoverEvents = ((finalMetadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(failoverEvents.some((event) => event.type === "stream_restart_after_limit"));
  assert.ok(failoverEvents.some((event) => event.type === "switch_agent"));
  const limits = await repo.listAgentUsageLimits(primary.id);
  assert.ok(limits.some((entry) => entry.status === "exhausted"));
});

test("invokeStream switches to equivalent available agent on technical failures", async () => {
  const primary = await repo.createAgent({
    slug: "stream-tech-primary",
    adapter: "local-model",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  const backup = await repo.createAgent({
    slug: "stream-tech-backup",
    adapter: "local-model",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  // @ts-expect-error override for test
  service.getAdapter = async (agent: any) => ({
    invokeStream: async function* () {
      if (agent.id === primary.id) {
        throw new Error("temporary unavailable 503");
      }
      yield { output: "stream-tech-ok", adapter: "local-model", model: backup.defaultModel };
    },
  });
  const chunks: string[] = [];
  let finalMetadata: Record<string, unknown> | undefined;
  const generator = await service.invokeStream(primary.id, { input: "ping" });
  for await (const chunk of generator) {
    chunks.push(chunk.output);
    finalMetadata = chunk.metadata;
  }
  assert.deepEqual(chunks, ["stream-tech-ok"]);
  const failoverEvents = ((finalMetadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(
    failoverEvents.some(
      (event) =>
        event.type === "switch_agent" &&
        event.fromAgentId === primary.id &&
        event.toAgentId === backup.id &&
        event.reason === "technical_issue",
    ),
  );
});

test("invokeStream waits for internet recovery when connectivity fails and all fallbacks are remote", async () => {
  const primary = await repo.createAgent({
    slug: "stream-offline-primary",
    adapter: "codex-cli",
    defaultModel: "gpt-5.2-codex",
    rating: 9,
    reasoningRating: 9,
    maxComplexity: 8,
    capabilities: ["chat", "code_write"],
  });
  await repo.createAgent({
    slug: "stream-offline-backup",
    adapter: "codex-cli",
    defaultModel: "sonnet",
    rating: 8,
    reasoningRating: 8,
    maxComplexity: 7,
    capabilities: ["chat", "code_write"],
  });
  let nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const sleeps: number[] = [];
  let checks = 0;
  const clockService = new AgentService(repo, {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    checkInternetReachable: async () => {
      checks += 1;
      return checks >= 3;
    },
    connectivityPollIntervalMs: 1000,
  });
  let calls = 0;
  // @ts-expect-error override for test
  clockService.getAdapter = async () => ({
    invokeStream: async function* () {
      calls += 1;
      if (calls === 1) {
        throw new Error("network unreachable");
      }
      yield { output: "stream-after-internet", adapter: "codex-cli", model: "gpt-5.2-codex" };
    },
  });

  const chunks: string[] = [];
  let finalMetadata: Record<string, unknown> | undefined;
  const generator = await clockService.invokeStream(primary.id, { input: "ping" });
  for await (const chunk of generator) {
    chunks.push(chunk.output);
    finalMetadata = chunk.metadata;
  }
  assert.deepEqual(chunks, ["stream-after-internet"]);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(checks, 3);
  const failoverEvents = ((finalMetadata as any)?.failoverEvents ?? []) as Array<Record<string, unknown>>;
  assert.ok(failoverEvents.some((event) => event.type === "wait_for_internet"));
});

test("agent io output lines stay atomic when streams overlap", async () => {
  const agent = await repo.createAgent({
    slug: "io-lines",
    adapter: "local-model",
    capabilities: ["chat"],
    prompts: { jobPrompt: "job", characterPrompt: "character" },
  });
  const originalWrite = process.stderr.write;
  const originalIo = process.env.MCODA_STREAM_IO;
  const originalPrompt = process.env.MCODA_STREAM_IO_PROMPT;
  process.env.MCODA_STREAM_IO = "1";
  process.env.MCODA_STREAM_IO_PROMPT = "0";
  const writes: string[] = [];
  process.stderr.write = ((chunk: any, cb?: any) => {
    const text = String(chunk);
    const mid = Math.max(1, Math.floor(text.length / 2));
    writes.push(text.slice(0, mid));
    setTimeout(() => {
      writes.push(text.slice(mid));
      if (typeof cb === "function") cb();
    }, 1);
    return true;
  }) as any;
  // @ts-expect-error override for test
  service.getAdapter = async () => ({
    invokeStream: async function* (request: any) {
      const label = String(request.input ?? "input");
      yield { output: `${label}-one\n`, adapter: "stub", model: "stub" };
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield { output: `${label}-two\n`, adapter: "stub", model: "stub" };
    },
    invoke: async () => ({ output: "", adapter: "stub", model: "stub" }),
  });
  const runStream = async (label: string) => {
    const generator = await service.invokeStream(agent.id, { input: label, metadata: { command: "work-on-tasks" } });
    for await (const _ of generator) {
      // consume
    }
  };
  try {
    await Promise.all([runStream("alpha"), runStream("beta")]);
    await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    process.stderr.write = originalWrite;
    if (originalIo === undefined) {
      delete process.env.MCODA_STREAM_IO;
    } else {
      process.env.MCODA_STREAM_IO = originalIo;
    }
    if (originalPrompt === undefined) {
      delete process.env.MCODA_STREAM_IO_PROMPT;
    } else {
      process.env.MCODA_STREAM_IO_PROMPT = originalPrompt;
    }
  }
  const output = writes.join("");
  const lines = output.split("\n").filter((line) => line.includes("[agent-io]"));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(line.startsWith("[agent-io]"));
    assert.equal(line.indexOf("[agent-io]", 1), -1);
  }
});
