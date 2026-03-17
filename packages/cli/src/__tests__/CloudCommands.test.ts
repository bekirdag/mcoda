import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GlobalRepository } from "@mcoda/db";
import { CloudCommands } from "../commands/cloud/CloudCommands.js";

const captureLogs = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cloud-cli-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
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

test("cloud --help prints usage", { concurrency: false }, async () => {
  const logs = await captureLogs(() => CloudCommands.run(["--help"]));
  assert.match(logs.join("\n"), /Usage: mcoda cloud agent/);
});

test("cloud agent list supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      assert.equal(req.headers["x-api-key"], "cloud-key");
      assert.equal(url.pathname, "/v1/swarm/cloud/agents");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "openai/gpt-4.1-mini",
              provider: "openrouter",
              default_model: "openai/gpt-4.1-mini",
              capabilities: ["code_write"],
              supports_tools: true,
              pricing_version: "2026-03-17",
            },
          ],
        }),
      );
    }, async (baseUrl) => {
      const logs = await captureLogs(() =>
        CloudCommands.run([
          "agent",
          "list",
          "--json",
          "--base-url",
          baseUrl,
          "--api-key",
          "cloud-key",
        ]),
      );
      const parsed = JSON.parse(logs.join("\n"));
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed[0]?.slug, "openai/gpt-4.1-mini");
      assert.equal(parsed[0]?.supports_tools, true);
    });
  });
});

test("cloud agent sync writes managed agents into the local registry", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/v1/swarm/cloud/agents") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "openai/gpt-4.1-mini",
              provider: "openrouter",
              default_model: "openai/gpt-4.1-mini",
              capabilities: ["plan", "code_write"],
              supports_tools: true,
              rating: 8.4,
              reasoning_rating: 8.6,
              max_complexity: 8,
              cost_per_million: 1.1,
              health_status: "healthy",
              context_window: 128000,
              pricing_version: "2026-03-17",
            },
          ],
        }),
      );
    }, async (baseUrl) => {
      const logs = await captureLogs(() =>
        CloudCommands.run([
          "agent",
          "sync",
          "--json",
          "--base-url",
          baseUrl,
          "--api-key",
          "cloud-key",
        ]),
      );
      const parsed = JSON.parse(logs.join("\n"));
      assert.equal(parsed.created, 1);
      assert.equal(parsed.agents[0]?.localSlug, "mswarm-cloud-openai-gpt-4-1-mini");

      const repo = await GlobalRepository.create();
      try {
        const agent = await repo.getAgentBySlug("mswarm-cloud-openai-gpt-4-1-mini");
        assert.ok(agent);
        assert.equal(agent.adapter, "openai-api");
        assert.equal((agent.config as any)?.mswarmCloud?.managed, true);
      } finally {
        await repo.close();
      }
    });
  });
});
