import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsApi } from "../../api/AgentsApi.js";
import { GlobalRepository } from "@mcoda/db";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-core-agent-api-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("AgentsApi.runAgent records command_runs and token_usage", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const api = await AgentsApi.create();
    try {
      await api.createAgent({ slug: "qa", adapter: "qa-cli", capabilities: ["chat"] });
      const result = await api.runAgent("qa", ["Summarize this task", "List risks"]);
      assert.equal(result.responses.length, 2);

      const repo = await GlobalRepository.create();
      const runs = await repo["db"].all("SELECT command_name FROM command_runs WHERE command_name = 'agent.run'");
      assert.ok(runs.length >= 1);
      const tokens = await repo["db"].all("SELECT id FROM token_usage WHERE command_run_id IS NOT NULL");
      assert.ok(tokens.length >= 2);
      await repo.close();
    } finally {
      await api.close();
    }
  });
});
