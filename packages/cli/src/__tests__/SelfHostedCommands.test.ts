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
  assert.match(output, /--client-identity <ID>/);
  assert.match(output, /MCODA_MSWARM_CLIENT_IDENTITY/);
  assert.match(output, /mswarm node install <CLIENTS>/);
});

test("self-hosted agent list supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      assert.equal(req.headers["x-api-key"], "self-hosted-key");
      assert.equal(req.headers["x-mswarm-client-identity"], "heka");
      assert.equal(req.headers["x-mswarm-client"], "heka");
      assert.equal(url.pathname, "/v1/swarm/self-hosted/agents");
      assert.equal(url.searchParams.get("shape"), "mcoda");
      assert.equal(url.searchParams.get("include_load_balanced"), "true");
      assert.equal(url.searchParams.get("client_identity"), "heka");
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
              load_balanced: true,
              load_balanced_group_id: "lb_group_123",
              client_identity: "heka",
              client_allowlist: [{ kind: "domain", value: "heka" }],
              client_allowlist_count: 1,
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
          "--include-load-balanced",
          "--client-identity",
          "heka",
        ]),
      );
      const parsed = JSON.parse(logs.join("\n"));
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed[0]?.slug, "mcoda-lab-claude-sonnet");
      assert.equal(parsed[0]?.adapter, "claude-cli");
      assert.equal(parsed[0]?.load_balanced, true);
      assert.equal(parsed[0]?.load_balanced_group_id, "lb_group_123");
      assert.equal(parsed[0]?.client_identity, "heka");
      assert.equal(parsed[0]?.client_allowlist_count, 1);
    });
  });
});

test("self-hosted agent sync JSON identifies auto-routed entries", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      assert.equal(req.headers["x-api-key"], "self-hosted-key");
      assert.equal(req.headers["x-mswarm-client-identity"], "heka");
      assert.equal(url.pathname, "/v1/swarm/self-hosted/agents");
      assert.equal(url.searchParams.get("include_load_balanced"), "true");
      assert.equal(url.searchParams.get("client_identity"), "heka");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "mcoda-auto-claude-sonnet",
              remote_slug: "mcoda/load-balanced/claude-sonnet",
              provider: "mcoda",
              adapter: "claude-cli",
              default_model: "mcoda-auto-claude-sonnet",
              capabilities: ["chat", "code_write"],
              supports_tools: true,
              load_balanced: true,
              load_balanced_group_id: "lb_group_123",
              client_identity: "heka",
              sync: {
                source: "self_hosted",
                load_balanced: true,
                group_id: "lb_group_123",
              },
            },
          ],
        }),
      );
    }, async (baseUrl) => {
      const logs = await captureLogs(() =>
        SelfHostedCommands.run([
          "agent",
          "sync",
          "--json",
          "--base-url",
          baseUrl,
          "--api-key",
          "self-hosted-key",
          "--include-load-balanced",
          "--client-identity",
          "heka",
        ]),
      );
      const parsed = JSON.parse(logs.join("\n"));
      assert.equal(parsed.created, 1);
      assert.equal(
        parsed.agents[0]?.localSlug,
        "mswarm-self-hosted-auto-mcoda-load-balanced-claude-sonnet",
      );
      assert.equal(parsed.agents[0]?.routingMode, "auto");
      assert.equal(parsed.agents[0]?.loadBalanced, true);
      assert.equal(parsed.agents[0]?.clientIdentity, "heka");
    });
  });
});
