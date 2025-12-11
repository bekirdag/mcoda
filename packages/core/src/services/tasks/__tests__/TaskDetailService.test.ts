import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { TaskDetailService } from "../TaskDetailService.js";
import type { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";

const workspaceFromRoot = (workspaceRoot: string): WorkspaceResolution => ({
  workspaceRoot,
  workspaceId: workspaceRoot,
  mcodaDir: path.join(workspaceRoot, ".mcoda"),
  id: workspaceRoot,
  legacyWorkspaceIds: [],
  workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
  globalDbPath: PathHelper.getGlobalDbPath(),
});

describe("TaskDetailService", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-task-detail-"));
    await fs.mkdir(path.join(workspaceRoot, ".mcoda"), { recursive: true });
    const dbPath = PathHelper.getWorkspaceDbPath(workspaceRoot);
    const connection = await Connection.open(dbPath);
    await WorkspaceMigrations.run(connection.db);
    const repo = new WorkspaceRepository(connection.db, connection);

    const project = await repo.createProjectIfMissing({ key: "WEB", name: "Web" });
    const [epic] = await repo.insertEpics(
      [
        {
          projectId: project.id,
          key: "web-01",
          title: "Auth",
          description: "Authentication work",
          priority: 1,
        },
      ],
      true,
    );
    const [story] = await repo.insertStories(
      [
        {
          projectId: project.id,
          epicId: epic.id,
          key: "web-01-us-01",
          title: "Login",
          description: "Login feature",
          priority: 1,
        },
      ],
      true,
    );
    const [upstream, target, downstream] = await repo.insertTasks(
      [
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "web-01-us-01-t00",
          title: "Design flow",
          description: "Design login flow",
          status: "not_started",
          storyPoints: 2,
          priority: 2,
        },
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "web-01-us-01-t01",
          title: "Implement login",
          description: "Implement UI and API wiring",
          status: "in_progress",
          storyPoints: 5,
          priority: 1,
          assigneeHuman: "alice",
          vcsBranch: "mcoda/task/web-01-us-01-t01",
          vcsBaseBranch: "mcoda-dev",
          vcsLastCommitSha: "abcdef123456",
        },
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "web-01-us-01-t02",
          title: "Wire analytics",
          description: "Add tracking",
          status: "blocked",
          storyPoints: 3,
          priority: 3,
        },
      ],
      true,
    );

    await repo.insertTaskDependencies(
      [
        { taskId: target.id, dependsOnTaskId: upstream.id, relationType: "blocks" },
        { taskId: downstream.id, dependsOnTaskId: target.id, relationType: "blocks" },
      ],
      true,
    );

    const now = new Date().toISOString();
    const run = await repo.createTaskRun({
      taskId: target.id,
      command: "work-on-tasks",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      gitBranch: "mcoda/task/web-01-us-01-t01",
      gitBaseBranch: "mcoda-dev",
      gitCommitSha: "abcdef123456",
    });
    await repo.insertTaskLog({
      taskRunId: run.id,
      sequence: 0,
      timestamp: now,
      level: "info",
      source: "work-on-tasks",
      message: "Completed login implementation",
      details: { summary: "done" },
    });

    await repo.createTaskComment({
      taskId: target.id,
      sourceCommand: "work-on-tasks",
      authorType: "agent",
      authorAgentId: "agent-1",
      category: "note",
      body: "Remember to add forgot password later.",
      createdAt: now,
    });

    await repo.insertTaskRevision({
      taskId: target.id,
      jobId: "job-1",
      commandRunId: "cmd-1",
      snapshotBefore: { status: "not_started", story_points: 3 },
      snapshotAfter: { status: "in_progress", story_points: 5 },
      createdAt: now,
    });

    await repo.close();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("aggregates task detail with dependencies, comments, logs, and history", async () => {
    const workspace = workspaceFromRoot(workspaceRoot);
    const service = await TaskDetailService.create(workspace);
    const detail = await service.getTaskDetail({
      taskKey: "web-01-us-01-t01",
      includeLogs: true,
      includeHistory: true,
    });
    await service.close();

    assert.equal(detail.task.project.key, "WEB");
    assert.equal(detail.task.epic.key, "web-01");
    assert.equal(detail.task.story.key, "web-01-us-01");
    assert.equal(detail.task.vcsBranch, "mcoda/task/web-01-us-01-t01");
    assert.equal(detail.dependencies.upstream[0]?.key, "web-01-us-01-t00");
    assert.equal(detail.dependencies.downstream[0]?.key, "web-01-us-01-t02");
    assert.equal(detail.comments.length, 1);
    assert.ok(detail.logs && detail.logs.length === 1);
    assert.equal(detail.logs?.[0]?.command, "work-on-tasks");
    assert.equal(detail.history?.[0]?.statusBefore, "not_started");
    assert.equal(detail.history?.[0]?.statusAfter, "in_progress");
  });
});
