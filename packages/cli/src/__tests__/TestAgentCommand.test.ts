import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { TestAgentCommand } from "../commands/agents/TestAgentCommand.js";
import { GlobalRepository } from "@mcoda/db";
import { MswarmApi } from "@mcoda/core";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-test-agent-"));
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  process.env.HOME = tempHome;
  process.env.MCODA_SKIP_CLI_CHECKS = "1";
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

const withStubServer = async (
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
    await once(server, "close");
  }
};

test("mcoda test-agent records health, command_runs, and token_usage", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "qa", "--adapter", "qa-cli", "--capability", "chat"]);
    await TestAgentCommand.run(["qa"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("qa");
    assert.ok(agent);
    const health = await repo.getAgentHealth(agent.id);
    assert.equal(health?.status, "healthy");
    const runs = await repo["db"].all("SELECT command_name FROM command_runs WHERE command_name = 'agent.test'");
    assert.ok(runs.length >= 1);
    const tokens = await repo["db"].all("SELECT agent_id FROM token_usage WHERE command_run_id IS NOT NULL");
    assert.ok(tokens.length >= 1);
    await repo.close();
  });
});

test("mcoda test-agent works with a synced managed mswarm cloud agent", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/v1/swarm/cloud/agents") {
        res.writeHead(404);
        res.end();
        return;
      }
      assert.equal(req.headers["x-api-key"], "cloud-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "openai/gpt-4.1-mini",
              provider: "openrouter",
              default_model: "openai/gpt-4.1-mini",
              cost_per_million: 0.9,
              rating: 8.2,
              reasoning_rating: 8.5,
              max_complexity: 8,
              capabilities: ["chat", "code_write"],
              health_status: "healthy",
              context_window: 128000,
              supports_tools: true,
              model_id: "openai/gpt-4.1-mini",
              display_name: "GPT-4.1 mini",
              description: "Fast cloud model",
              supports_reasoning: true,
              pricing_snapshot_id: "snap-1",
              pricing_version: "2026-03-17",
            },
          ],
        }),
      );
    }, async (catalogBaseUrl) => {
      await withStubServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        assert.equal(url.pathname, "/v1/swarm/openai/chat/completions");
        assert.equal(req.headers.authorization, "Bearer cloud-key");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "cloud-ack" } }],
            usage: { total_tokens: 6 },
          }),
        );
      }, async (proxyBaseUrl) => {
        const api = await MswarmApi.create({
          baseUrl: catalogBaseUrl,
          openAiBaseUrl: new URL("/v1/swarm/openai/", proxyBaseUrl).toString(),
          apiKey: "cloud-key",
        });
        try {
          await api.syncCloudAgents();
        } finally {
          await api.close();
        }

        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
          logs.push(args.join(" "));
        };
        try {
          await TestAgentCommand.run(["mswarm-cloud-openai-gpt-4-1-mini", "--json"]);
        } finally {
          console.log = originalLog;
        }

        const parsed = JSON.parse(logs.join("\n"));
        assert.equal(parsed.health.status, "healthy");
        assert.equal(parsed.response.adapter, "openai-api");
        assert.equal(parsed.response.output, "cloud-ack");
      });
    });
  });
});

test("mcoda test-agent validates missing prompt value", async () => {
  await assert.rejects(() => TestAgentCommand.run(["qa", "--prompt"]), {
    message: "test-agent: missing value for --prompt",
  });
});

test("mcoda test-agent emits JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "json-test-agent", "--adapter", "qa-cli", "--capability", "chat"]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await TestAgentCommand.run(["json-test-agent", "--json"]);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(logs.join("\n"));
    assert.ok(parsed.health);
    assert.ok(parsed.prompt);
    assert.ok(parsed.response);
    assert.equal(typeof parsed.response.output, "string");
  });
});
