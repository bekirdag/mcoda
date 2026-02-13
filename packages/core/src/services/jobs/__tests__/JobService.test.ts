import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Connection } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { JobService } from "../JobService.js";

const withTempHome = async (fn: () => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-job-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    await fn();
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
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("JobService writes command runs, jobs, and checkpoints in JSON mode", async () => {
  await withTempHome(async () => {
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

      const manifestPath = path.join(PathHelper.getWorkspaceDir(dir), "jobs", job.id, "manifest.json");
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
});

test("JobService records agent attribution for jobs and command runs", async () => {
  await withTempHome(async () => {
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
});

test("JobService reads job manifest data", async () => {
  await withTempHome(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-jobservice-"));
    const previous = process.env.MCODA_DISABLE_DB;
    process.env.MCODA_DISABLE_DB = "1";
    try {
      const service = new JobService(dir);
      const commandRun = await service.startCommandRun("openapi-from-docs", "proj");
      const job = await service.startJob("openapi_change", commandRun.id, "proj", {
        commandName: "openapi-from-docs",
        payload: { resumeSupported: true },
      });
      const manifest = await service.readManifest(job.id);
      assert.equal((manifest as any)?.job_id ?? (manifest as any)?.id, job.id);
      assert.equal((manifest as any)?.type ?? (manifest as any)?.job_type, "openapi_change");
      assert.equal((manifest as any)?.payload?.resumeSupported, true);
    } finally {
      if (previous === undefined) {
        delete process.env.MCODA_DISABLE_DB;
      } else {
        process.env.MCODA_DISABLE_DB = previous;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("JobService records iteration progress in manifest and checkpoints", async () => {
  await withTempHome(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-jobservice-"));
    const previous = process.env.MCODA_DISABLE_DB;
    process.env.MCODA_DISABLE_DB = "1";
    try {
      const service = new JobService(dir);
      const commandRun = await service.startCommandRun("docs-generate", "proj");
      const job = await service.startJob("docs_generate", commandRun.id, "proj", {
        commandName: "docs-generate",
        totalItems: 3,
        processedItems: 0,
      });

      await service.recordIterationProgress(job.id, {
        current: 1,
        max: 3,
        phase: "review",
        details: { note: "phase" },
      });

      const manifest = await service.readManifest(job.id);
      assert.equal((manifest as any)?.lastCheckpoint, "iteration_1_review");
      assert.deepEqual((manifest as any)?.payload?.iteration, {
        current: 1,
        max: 3,
        phase: "review",
      });
      assert.equal((manifest as any)?.payload?.iterationDetails?.note, "phase");
      assert.equal((manifest as any)?.payload?.docgen_stage, "iteration_1_review");
      assert.equal((manifest as any)?.payload?.docgen_iteration_current, 1);
      assert.equal((manifest as any)?.payload?.docgen_iteration_max, 3);
      assert.equal((manifest as any)?.payload?.docgen_iteration_phase, "review");
      assert.equal((manifest as any)?.payload?.docgen_status_message, "Review iteration 1/3");

      const checkpoints = await service.readCheckpoints(job.id);
      assert.ok(checkpoints.some((ckpt) => ckpt.stage === "iteration_1_review"));
      await service.close();
    } finally {
      if (previous === undefined) {
        delete process.env.MCODA_DISABLE_DB;
      } else {
        process.env.MCODA_DISABLE_DB = previous;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
