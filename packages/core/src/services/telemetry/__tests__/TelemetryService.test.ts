import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { TelemetryService } from "../TelemetryService.js";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";

const workspaceFromRoot = (workspaceRoot: string): WorkspaceResolution => ({
  workspaceRoot,
  workspaceId: workspaceRoot,
  mcodaDir: path.join(workspaceRoot, ".mcoda"),
});

describe("TelemetryService", () => {
  let workspaceRoot: string;
  let connection: Connection;
  let repo: WorkspaceRepository;
  let workspace: WorkspaceResolution;
  let projectId: string;
  let job1: string;
  let job2: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-telemetry-"));
    await fs.mkdir(path.join(workspaceRoot, ".mcoda"), { recursive: true });
    const dbPath = PathHelper.getWorkspaceDbPath(workspaceRoot);
    connection = await Connection.open(dbPath);
    await WorkspaceMigrations.run(connection.db);
    repo = new WorkspaceRepository(connection.db, connection);
    const project = await repo.createProjectIfMissing({ key: "PROJ", name: "Project" });
    projectId = project.id;
    workspace = workspaceFromRoot(workspaceRoot);
    const jobRow1 = await repo.createJob({ workspaceId: workspace.workspaceId, type: "work-on-tasks", state: "running", commandName: "work-on-tasks" });
    const jobRow2 = await repo.createJob({ workspaceId: workspace.workspaceId, type: "docs", state: "running", commandName: "docs-pdr-generate" });
    job1 = jobRow1.id;
    job2 = jobRow2.id;

    const now = new Date().toISOString();
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    await repo.recordTokenUsage({
      workspaceId: workspace.workspaceId,
      projectId,
      agentId: "agent-1",
      modelName: "gpt-4",
      jobId: job1,
      tokensPrompt: 10,
      tokensCompletion: 5,
      tokensTotal: 15,
      costEstimate: 0.5,
      durationSeconds: 2,
      timestamp: now,
      metadata: { commandName: "work-on-tasks", action: "plan" },
    });
    await repo.recordTokenUsage({
      workspaceId: workspace.workspaceId,
      projectId,
      agentId: "agent-1",
      modelName: "gpt-4",
      jobId: job1,
      tokensPrompt: 6,
      tokensCompletion: 4,
      tokensTotal: 10,
      costEstimate: 0.25,
      durationSeconds: 1,
      timestamp: recent,
      metadata: { commandName: "work-on-tasks", action: "draft" },
    });
    await repo.recordTokenUsage({
      workspaceId: workspace.workspaceId,
      projectId,
      agentId: "agent-2",
      modelName: "gpt-3",
      jobId: job2,
      tokensPrompt: 3,
      tokensCompletion: 2,
      tokensTotal: 5,
      costEstimate: null,
      durationSeconds: 0.5,
      timestamp: old,
      metadata: { commandName: "docs-pdr-generate", action: "context" },
    });
  });

  afterEach(async () => {
    await repo.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("aggregates token usage with default grouping and window", async () => {
    const service = await TelemetryService.create(workspace);
    try {
      const summary = await service.getSummary();
      assert.equal(summary.length, 1);
      const row = summary[0];
      assert.equal(row.calls, 2);
      assert.equal(row.tokens_total, 25);
      assert.equal(row.tokens_prompt, 16);
      assert.equal(row.tokens_completion, 9);
      assert.equal(row.cost_estimate, 0.75);
      assert.equal(row.command_name, "work-on-tasks");
      assert.equal(row.agent_id, "agent-1");
      assert.equal(row.project_id, projectId);
    } finally {
      await service.close();
    }
  });

  it("supports grouping by day", async () => {
    const service = await TelemetryService.create(workspace);
    try {
      const summary = await service.getSummary({ groupBy: ["day"] });
      assert.equal(summary.length, 1);
      assert.ok(summary[0].day);
      assert.equal(summary[0].calls, 2);
    } finally {
      await service.close();
    }
  });

  it("filters raw token usage by job id and since", async () => {
    const service = await TelemetryService.create(workspace);
    try {
      const rows = await service.getTokenUsage({ jobId: job1 });
      assert.equal(rows.length, 2);
      assert.equal(rows[0].job_id, job1);
      const oldRows = await service.getTokenUsage({ jobId: job2, since: "7d" });
      assert.equal(oldRows.length, 0);
    } finally {
      await service.close();
    }
  });

  it("manages telemetry config opt-out and opt-in", async () => {
    const service = await TelemetryService.create(workspace, { allowMissingTelemetry: true });
    try {
      const initial = await service.getConfig();
      assert.equal(initial.optOut, false);
      assert.equal(initial.strict, false);
      const optedOut = await service.optOut(true);
      assert.equal(optedOut.optOut, true);
      assert.equal(optedOut.strict, true);
      assert.equal(optedOut.localRecording, false);
      const optedIn = await service.optIn();
      assert.equal(optedIn.optOut, false);
      assert.equal(optedIn.strict, false);
      assert.equal(optedIn.localRecording, true);
    } finally {
      await service.close();
    }
  });
});
