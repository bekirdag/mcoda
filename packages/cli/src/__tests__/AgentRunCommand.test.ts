import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { AgentRunCommand } from "../commands/agents/AgentRunCommand.js";
import { GlobalRepository } from "@mcoda/db";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalHomeDrive = process.env.HOMEDRIVE;
  const originalHomePath = process.env.HOMEPATH;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-run-"));
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  process.env.HOME = tempHome;
  if (process.platform === "win32") {
    const parsed = path.parse(tempHome);
    process.env.USERPROFILE = tempHome;
    process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
    process.env.HOMEPATH = tempHome.slice(parsed.root.length - 1);
  }
  process.env.MCODA_SKIP_CLI_CHECKS = "1";
  try {
    await fn(tempHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalHomeDrive === undefined) {
      delete process.env.HOMEDRIVE;
    } else {
      process.env.HOMEDRIVE = originalHomeDrive;
    }
    if (originalHomePath === undefined) {
      delete process.env.HOMEPATH;
    } else {
      process.env.HOMEPATH = originalHomePath;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("mcoda agent-run records command_runs and token_usage", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "qa", "--adapter", "qa-cli", "--capability", "chat"]);
    await AgentRunCommand.run(["qa", "--prompt", "Summarize this task", "--prompt", "List risks"]);

    const repo = await GlobalRepository.create();
    const runs = await repo["db"].all("SELECT command_name FROM command_runs WHERE command_name = 'agent.run'");
    assert.ok(runs.length >= 1);
    const tokens = await repo["db"].all("SELECT agent_id FROM token_usage WHERE command_run_id IS NOT NULL");
    assert.ok(tokens.length >= 1);
    await repo.close();
  });
});
