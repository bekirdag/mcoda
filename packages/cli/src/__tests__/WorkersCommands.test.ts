import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MswarmApi } from "@mcoda/core";
import { WorkersCommands } from "../commands/workers/WorkersCommands.js";

test("WorkersCommands list renders the operational worker catalog columns", { concurrency: false }, async () => {
  const originalCreate = MswarmApi.create;
  const originalLog = console.log;
  const logs: string[] = [];
  (MswarmApi as any).create = async () => ({
    async close() {},
    async listAllWorkers(options: unknown) {
      assert.deepEqual(options, { limit: undefined, includeDisabled: true });
      return [
        {
          slug: "worker_abc123",
          provider: "mswarm",
          default_model: "mswarm-worker:worker_abc123",
          supports_tools: true,
          capabilities: ["structured_output"],
          worker: {
            name: "Client intake",
            enabled: false,
            status: "disabled",
            docdex_enabled: true,
            selected_agent: { slug: "openrouter/qwen" },
            config_health: { status: "disabled" },
          },
        },
      ];
    },
  });
  console.log = (value?: unknown) => {
    logs.push(String(value));
  };
  try {
    await WorkersCommands.run(["list"]);
  } finally {
    (MswarmApi as any).create = originalCreate;
    console.log = originalLog;
  }
  assert.match(logs.join("\n"), /WORKER SLUG\s+NAME\s+ENABLED\s+STATUS\s+AGENT\s+DOCDEX\s+CONFIG/);
  assert.match(logs.join("\n"), /worker_abc123/);
  assert.match(logs.join("\n"), /openrouter\/qwen/);
});

test("WorkersCommands run accepts JSON payload files", { concurrency: false }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workers-cli-"));
  const payloadPath = path.join(tempDir, "payload.json");
  await fs.writeFile(payloadPath, JSON.stringify({ event: "sample", count: 2 }));
  const originalCreate = MswarmApi.create;
  const originalLog = console.log;
  const logs: string[] = [];
  let capturedPayload: unknown;
  (MswarmApi as any).create = async () => ({
    async close() {},
    async runWorker(slug: string, payload: unknown) {
      assert.equal(slug, "worker_abc123");
      capturedPayload = payload;
      return { result: { output: "ok" } };
    },
  });
  console.log = (value?: unknown) => {
    logs.push(String(value));
  };
  try {
    await WorkersCommands.run(["run", "worker_abc123", "--payload-file", payloadPath]);
  } finally {
    (MswarmApi as any).create = originalCreate;
    console.log = originalLog;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  assert.deepEqual(capturedPayload, { event: "sample", count: 2 });
  assert.deepEqual(logs, ["ok"]);
});
