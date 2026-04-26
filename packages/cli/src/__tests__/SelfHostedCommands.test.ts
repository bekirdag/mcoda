import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SelfHostedCommands } from "../commands/self-hosted/SelfHostedCommands.js";

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

const withTempHome = async (fn: () => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-self-hosted-cli-"));
  process.env.HOME = tempHome;
  try {
    await fn();
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

test("self-hosted --help prints usage", { concurrency: false }, async () => {
  const logs = await captureLogs(() => SelfHostedCommands.run(["--help"]));
  const output = logs.join("\n");
  assert.match(output, /Usage: mcoda self-hosted agent/);
  assert.match(output, /npm install -g @mcoda\/mswarm/);
  assert.match(output, /mswarm setup --api-key <KEY>/);
});

test("self-hosted agent list supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      assert.equal(req.headers["x-api-key"], "self-hosted-key");
      assert.equal(url.pathname, "/v1/swarm/self-hosted/agents");
      assert.equal(url.searchParams.get("shape"), "mcoda");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "mcoda-lab-claude-sonnet",
              remote_slug: "mcoda/lab/claude-sonnet",
              provider: "mcoda",
              adapter: "claude-cli",
              default_model: "mcoda-lab-claude-sonnet",
              capabilities: ["chat", "code_write"],
              supports_tools: true,
            },
          ],
        }),
      );
    }, async (baseUrl) => {
      const logs = await captureLogs(() =>
        SelfHostedCommands.run([
          "agent",
          "list",
          "--json",
          "--base-url",
          baseUrl,
          "--api-key",
          "self-hosted-key",
        ]),
      );
      const parsed = JSON.parse(logs.join("\n"));
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed[0]?.slug, "mcoda-lab-claude-sonnet");
      assert.equal(parsed[0]?.adapter, "claude-cli");
    });
  });
});
