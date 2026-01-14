import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { TelemetryService } from "../TelemetryService.js";
import { JobService } from "../../jobs/JobService.js";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";

const workspaceFromRoot = (workspaceRoot: string): WorkspaceResolution => ({
  workspaceRoot,
  workspaceId: workspaceRoot,
  mcodaDir: path.join(workspaceRoot, ".mcoda"),
  id: workspaceRoot,
  legacyWorkspaceIds: [],
  workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
  globalDbPath: PathHelper.getGlobalDbPath(),
});

describe("TelemetryService", () => {
  let workspaceRoot: string;
  let connection: Connection;
  let repo: WorkspaceRepository;
  let workspace: WorkspaceResolution;
  let projectId: string;
  let job1: string;
  let job2: string;
  let cachedTokenStartedAt: string;
  let cachedTokenFinishedAt: string;
  let cachedTokenDurationMs: number;

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
    cachedTokenStartedAt = new Date(Date.now() - 5000).toISOString();
    cachedTokenFinishedAt = now;
    cachedTokenDurationMs = 5000;
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    await repo.recordTokenUsage({
      workspaceId: workspace.workspaceId,
      projectId,
      agentId: "agent-1",
      modelName: "gpt-4",
      jobId: job1,
      commandName: "work-on-tasks",
      action: "plan",
      invocationKind: "chat",
      provider: "openai",
      currency: "USD",
      tokensPrompt: 10,
      tokensCompletion: 5,
      tokensTotal: 15,
      tokensCached: 3,
      tokensCacheRead: 2,
      tokensCacheWrite: 1,
      costEstimate: 0.5,
      durationSeconds: 2,
      durationMs: cachedTokenDurationMs,
      startedAt: cachedTokenStartedAt,
      finishedAt: cachedTokenFinishedAt,
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
      assert.equal(row.tokens_cached, 3);
      assert.equal(row.tokens_cache_read, 2);
      assert.equal(row.tokens_cache_write, 1);
      assert.equal(row.duration_ms, cachedTokenDurationMs + 1000);
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

  it("maps cached token and timing fields in token usage rows", async () => {
    const service = await TelemetryService.create(workspace);
    try {
      const rows = await service.getTokenUsage({ jobId: job1 });
      const cachedRow = rows.find((row) => row.tokens_cached === 3);
      assert.ok(cachedRow);
      assert.equal(cachedRow?.tokens_cache_read, 2);
      assert.equal(cachedRow?.tokens_cache_write, 1);
      assert.equal(cachedRow?.duration_ms, cachedTokenDurationMs);
      assert.equal(cachedRow?.started_at, cachedTokenStartedAt);
      assert.equal(cachedRow?.finished_at, cachedTokenFinishedAt);
      assert.equal(cachedRow?.invocation_kind, "chat");
      assert.equal(cachedRow?.provider, "openai");
      assert.equal(cachedRow?.currency, "USD");
      assert.equal(cachedRow?.command_name, "work-on-tasks");
      assert.equal(cachedRow?.action, "plan");
    } finally {
      await service.close();
    }
  });

  it("persists cached token and timing fields", async () => {
    const row = await connection.db.get<any>(
      `SELECT command_name, action, invocation_kind, provider, currency, tokens_cached, tokens_cache_read, tokens_cache_write, duration_ms, started_at, finished_at
       FROM token_usage
       WHERE job_id = ? AND tokens_prompt = ?`,
      job1,
      10,
    );
    assert.equal(row.command_name, "work-on-tasks");
    assert.equal(row.action, "plan");
    assert.equal(row.invocation_kind, "chat");
    assert.equal(row.provider, "openai");
    assert.equal(row.currency, "USD");
    assert.equal(row.tokens_cached, 3);
    assert.equal(row.tokens_cache_read, 2);
    assert.equal(row.tokens_cache_write, 1);
    assert.equal(row.duration_ms, cachedTokenDurationMs);
    assert.equal(row.started_at, cachedTokenStartedAt);
    assert.equal(row.finished_at, cachedTokenFinishedAt);
  });

  it("records extended token usage via JobService and JSON log", async () => {
    const jobService = new JobService(workspace.workspaceRoot, repo);
    const startedAt = new Date(Date.now() - 2000).toISOString();
    const finishedAt = new Date().toISOString();
    const timestamp = new Date().toISOString();
    await jobService.recordTokenUsage({
      workspaceId: workspace.workspaceId,
      jobId: job1,
      agentId: "agent-3",
      modelName: "gpt-4o",
      commandName: "work-on-tasks",
      action: "patch",
      invocationKind: "chat",
      provider: "openai",
      currency: "USD",
      tokensPrompt: 4,
      tokensCompletion: 1,
      tokensTotal: 5,
      tokensCached: 2,
      tokensCacheRead: 1,
      tokensCacheWrite: 0,
      durationSeconds: 2,
      durationMs: 2000,
      startedAt,
      finishedAt,
      timestamp,
      metadata: { phase: "jobservice" },
    });

    const row = await connection.db.get<any>(
      `SELECT tokens_cached, tokens_cache_read, tokens_cache_write, duration_ms, started_at, finished_at
       FROM token_usage
       WHERE job_id = ? AND agent_id = ?`,
      job1,
      "agent-3",
    );
    assert.equal(row.tokens_cached, 2);
    assert.equal(row.tokens_cache_read, 1);
    assert.equal(row.tokens_cache_write, 0);
    assert.equal(row.duration_ms, 2000);
    assert.equal(row.started_at, startedAt);
    assert.equal(row.finished_at, finishedAt);

    const logPath = path.join(workspaceRoot, ".mcoda", "token_usage.json");
    const logged = JSON.parse(await fs.readFile(logPath, "utf8")) as Array<Record<string, unknown>>;
    const entry = logged.find((item) => item.jobId === job1 && item.agentId === "agent-3");
    assert.ok(entry);
    assert.equal(entry?.tokensCached, 2);
    assert.equal(entry?.durationMs, 2000);
    assert.equal(entry?.startedAt, startedAt);
    assert.equal(entry?.finishedAt, finishedAt);
    assert.equal(entry?.invocationKind, "chat");
    assert.equal(entry?.provider, "openai");
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
