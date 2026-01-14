import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Connection } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { JobService } from "../JobService.js";

test("JobService writes command runs, jobs, and checkpoints in JSON mode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-jobservice-"));
  const previous = process.env.MCODA_DISABLE_DB;
  process.env.MCODA_DISABLE_DB = "1";
  try {
    const service = new JobService(dir);
    const commandRun = await service.startCommandRun("work-on-tasks", "proj", { taskIds: ["t1"] });
    assert.ok(commandRun.id);

    const job = await service.startJob("work", commandRun.id, "proj", {
      commandName: "work-on-tasks",
      totalItems: 2,
      processedItems: 0,
    });
    assert.ok(job.id);

    await service.updateJobStatus(job.id, "running", { processedItems: 1, lastCheckpoint: "halfway" });
    await service.writeCheckpoint(job.id, { stage: "halfway", timestamp: new Date().toISOString() });

    const checkpoints = await service.readCheckpoints(job.id);
    assert.equal(checkpoints.length, 1);

    const manifestPath = path.join(dir, ".mcoda", "jobs", job.id, "manifest.json");
    const manifestExists = await fs
      .stat(manifestPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(manifestExists, true);
  } finally {
    if (previous === undefined) {
      delete process.env.MCODA_DISABLE_DB;
    } else {
      process.env.MCODA_DISABLE_DB = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("JobService records agent attribution for jobs and command runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-jobservice-"));
  try {
    const service = new JobService(dir);
    const commandRun = await service.startCommandRun("work-on-tasks", "proj");
    const job = await service.startJob("work", commandRun.id, "proj", {
      commandName: "work-on-tasks",
    });
    await service.recordTokenUsage({
      workspaceId: job.workspaceId,
      jobId: job.id,
      commandRunId: commandRun.id,
      agentId: "agent-1",
      tokensPrompt: 1,
      tokensCompletion: 1,
      tokensTotal: 2,
      timestamp: new Date().toISOString(),
    });
    await service.close();

    const connection = await Connection.open(PathHelper.getWorkspaceDbPath(dir));
    try {
      const jobRow = await connection.db.get("SELECT agent_id, agent_ids_json FROM jobs WHERE id = ?", job.id);
      assert.equal(jobRow?.agent_id, "agent-1");
      assert.deepEqual(JSON.parse(jobRow?.agent_ids_json ?? "[]"), ["agent-1"]);
      const runRow = await connection.db.get("SELECT agent_id FROM command_runs WHERE id = ?", commandRun.id);
      assert.equal(runRow?.agent_id, "agent-1");
    } finally {
      await connection.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
