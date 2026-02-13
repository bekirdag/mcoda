import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { TestAgentCommand } from "../commands/agents/TestAgentCommand.js";
import { GlobalRepository } from "@mcoda/db";

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
