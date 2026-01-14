import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsApi } from "../../api/AgentsApi.js";
import { GlobalRepository } from "@mcoda/db";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-core-agent-api-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("AgentsApi.runAgent records command_runs and token_usage", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const api = await AgentsApi.create();
    try {
      await api.createAgent({ slug: "qa", adapter: "qa-cli", capabilities: ["chat"] });
      const result = await api.runAgent("qa", ["Summarize this task", "List risks"]);
      assert.equal(result.responses.length, 2);

      const repo = await GlobalRepository.create();
      const runs = await repo["db"].all("SELECT command_name FROM command_runs WHERE command_name = 'agent.run'");
      assert.ok(runs.length >= 1);
      const tokens = await repo["db"].all("SELECT id FROM token_usage WHERE command_run_id IS NOT NULL");
      assert.ok(tokens.length >= 2);
      await repo.close();
    } finally {
      await api.close();
    }
  });
});

test("AgentsApi captures cached token usage from agent metadata", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    const agent = await repo.createAgent({ slug: "stub-agent", adapter: "local", defaultModel: "stub-model" });
    const metadata = {
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 5,
        prompt_tokens_details: {
          cached_tokens: 2,
          cache_read: 1,
          cache_write: 1,
        },
      },
      duration_ms: 1200,
      started_at: "2024-01-01T00:00:00.000Z",
      finished_at: "2024-01-01T00:00:01.200Z",
      invocationKind: "chat",
      provider: "stub-provider",
      currency: "USD",
    };
    const agentService = {
      resolveAgent: async () => agent,
      invoke: async () => ({
        output: "stub",
        adapter: "stub-adapter",
        model: "stub-model",
        metadata,
      }),
    } as any;
    const routingService = { resolveAgentForCommand: async () => ({ agent }) } as any;
    const api = new AgentsApi(repo, agentService, routingService);
    try {
      const result = await api.runAgent(agent.id, ["Hello"]);
      assert.equal(result.responses.length, 1);
      const usage = await repo["db"].get(
        `SELECT command_name, action, invocation_kind, provider, currency,
                tokens_prompt, tokens_completion, tokens_total,
                tokens_cached, tokens_cache_read, tokens_cache_write,
                duration_ms, started_at, finished_at
         FROM token_usage
         WHERE agent_id = ?`,
        agent.id,
      );
      assert.equal(usage.command_name, "agent.run");
      assert.equal(usage.action, "invoke");
      assert.equal(usage.invocation_kind, "chat");
      assert.equal(usage.provider, "stub-provider");
      assert.equal(usage.currency, "USD");
      assert.equal(usage.tokens_prompt, 2);
      assert.equal(usage.tokens_completion, 3);
      assert.equal(usage.tokens_total, 5);
      assert.equal(usage.tokens_cached, 2);
      assert.equal(usage.tokens_cache_read, 1);
      assert.equal(usage.tokens_cache_write, 1);
      assert.equal(usage.duration_ms, 1200);
      assert.equal(usage.started_at, "2024-01-01T00:00:00.000Z");
      assert.equal(usage.finished_at, "2024-01-01T00:00:01.200Z");
    } finally {
      await api.close();
    }
  });
});
