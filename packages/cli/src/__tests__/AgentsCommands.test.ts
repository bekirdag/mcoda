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

test("agent --help prints usage", { concurrency: false }, async () => {
  const logs = await captureLogs(() => AgentsCommands.run(["--help"]));
  const output = logs.join("\n");
  assert.match(output, /Usage: mcoda agent/);

  const logsSub = await captureLogs(() => AgentsCommands.run(["list", "--help"]));
  const outputSub = logsSub.join("\n");
  assert.match(outputSub, /Usage: mcoda agent/);
});

test("agent add/list surfaces health from agent_health", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const slug = "codex-super-long-agent-name";
    await AgentsCommands.run([
      "add",
      slug,
      "--adapter",
      "codex-cli",
      "--capability",
      "chat",
      "--max-complexity",
      "8",
      "--openai-compatible",
      "true",
      "--context-window",
      "16384",
      "--max-output-tokens",
      "2048",
      "--supports-tools",
      "true",
    ]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug(slug);
    assert.ok(agent);
    assert.equal(agent.openaiCompatible, true);
    assert.equal(agent.contextWindow, 16384);
    assert.equal(agent.maxOutputTokens, 2048);
    assert.equal(agent.supportsTools, true);
    await repo.setAgentHealth({
      agentId: agent.id,
      status: "healthy",
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 5,
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["list"]));
    const output = logs.join("\n");
    assert.match(output, new RegExp(slug));
    assert.match(output, /healthy/);
    assert.match(output, /MAX CPLX/);
    const row = output.split("\n").find((line) => line.includes(slug));
    assert.ok(row);
    const cells = row.split("│").map((cell) => cell.trim()).filter(Boolean);
    assert.equal(cells[5], "8");
  });
});

test("agent list supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "json-agent", "--adapter", "codex-cli", "--capability", "chat"]);
    const logs = await captureLogs(() => AgentsCommands.run(["list", "--json"]));
    const parsed = JSON.parse(logs.join("\n"));
    assert.ok(Array.isArray(parsed));
    const agent = parsed.find((entry: any) => entry.slug === "json-agent");
    assert.ok(agent);
    assert.equal(agent.adapter, "codex-cli");
    assert.ok(agent.auth);
    assert.equal(agent.auth.configured, false);
  });
});

test("agent details supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "detail-agent",
      "--adapter",
      "codex-cli",
      "--capability",
      "chat",
      "--max-complexity",
      "7",
    ]);
    const logs = await captureLogs(() => AgentsCommands.run(["details", "detail-agent", "--json"]));
    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.slug, "detail-agent");
    assert.equal(parsed.maxComplexity, 7);
    assert.ok(Array.isArray(parsed.capabilities));
  });
});

test("agent details renders command prompts in text output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "detail-prompts", "--adapter", "codex-cli", "--capability", "chat"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("detail-prompts");
    assert.ok(agent);
    await repo.setAgentPrompts(agent.id, {
      commandPrompts: {
        "code-review": "Follow checklist",
        "qa-tasks": "QA prompt",
      },
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["details", "detail-prompts"]));
    const output = logs.join("\n");
    assert.match(output, /Command prompts\s*: code-review=Follow checklist; qa-tasks=QA prompt/);
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

test("agent add stores config for ollama-remote", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "suku-ollama",
      "--adapter",
      "ollama-remote",
      "--model",
      "gpt-oss:20b",
      "--config-base-url",
      "http://192.168.1.115:11434",
      "--capability",
      "plan",
    ]);
    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("suku-ollama");
    assert.ok(agent);
    assert.equal((agent.config as any)?.baseUrl, "http://192.168.1.115:11434");
    await repo.close();
  });
});

test("agent ratings lists recent run scores", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "rated-agent", "--adapter", "codex-cli"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("rated-agent");
    assert.ok(agent);
    await repo.insertAgentRunRating({
      agentId: agent.id,
      commandName: "work-on-tasks",
      taskKey: "proj-epic-us-01-t01",
      runScore: 8.4,
      qualityScore: 8.8,
      tokensTotal: 1200,
      durationSeconds: 45,
      iterations: 2,
      totalCost: 0.02,
      createdAt: new Date().toISOString(),
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["ratings", "--agent", "rated-agent"]));
    const output = logs.join("\n");
    assert.match(output, /work-on-tasks/);
    assert.match(output, /proj-epic-us-01-t01/);
  });
});
