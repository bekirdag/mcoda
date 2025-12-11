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
    await AgentsCommands.run(["add", "codex", "--adapter", "codex-cli", "--capability", "chat"]);
    await TestAgentCommand.run(["codex"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("codex");
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
