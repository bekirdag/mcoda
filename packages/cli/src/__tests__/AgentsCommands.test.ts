import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { GlobalRepository } from "@mcoda/db";
import { WorkspaceResolver } from "@mcoda/core";

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
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-cli-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("agent add/list surfaces health from agent_health", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "codex", "--adapter", "codex-cli", "--capability", "chat"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("codex");
    assert.ok(agent);
    await repo.setAgentHealth({
      agentId: agent.id,
      status: "healthy",
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 5,
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["list"]));
    const output = logs.join("\n");
    assert.match(output, /codex/);
    assert.match(output, /healthy/);
  });
});

test("agent delete blocks when referenced unless --force is set", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "api-agent", "--adapter", "openai-api"]);
    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("api-agent");
    assert.ok(agent);
    await repo.setWorkspaceDefault("ws-cli", "work-on-tasks", agent.id);
    await repo.close();

    await assert.rejects(() => AgentsCommands.run(["delete", "api-agent"]), /routing defaults/i);

    await AgentsCommands.run(["delete", "api-agent", "--force"]);
    const verify = await GlobalRepository.create();
    const missing = await verify.getAgentBySlug("api-agent");
    assert.equal(missing, undefined);
    await verify.close();
  });
});

test("agent auth set stores encrypted secret and auth-status reports configured", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "secure", "--adapter", "openai-api"]);
    await AgentsCommands.run(["auth", "set", "secure", "--api-key", "top-secret"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("secure");
    assert.ok(agent);
    const secret = await repo.getAgentAuthSecret(agent.id);
    assert.ok(secret);
    assert.notEqual(secret.encryptedSecret, "top-secret");
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["auth-status", "secure"]));
    const output = logs.join("\n");
    assert.match(output, /configured/i);
    assert.match(output, /secure/);
  });
});

test("agent set-default resolves workspace via WorkspaceResolver", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "codex", "--adapter", "codex-cli", "--capability", "chat"]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-ws-"));
    await AgentsCommands.run(["set-default", "codex", "--workspace", workspaceRoot]);

    const workspace = await WorkspaceResolver.resolveWorkspace({ explicitWorkspace: workspaceRoot });
    const repo = await GlobalRepository.create();
    const defaults = await repo.getWorkspaceDefaults(workspace.workspaceId);
    const agent = await repo.getAgentBySlug("codex");
    await repo.close();
    const mapping = defaults.find((d) => d.commandName === "default");
    assert.ok(mapping);
    assert.ok(agent);
    assert.equal(mapping.agentId, agent.id);
  });
});
