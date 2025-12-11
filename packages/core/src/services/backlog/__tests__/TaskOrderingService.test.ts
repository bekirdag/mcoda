import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskOrderingService } from "../TaskOrderingService.js";

const setupWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-order-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const dbPath = path.join(dir, ".mcoda", "mcoda.db");
  const connection = await Connection.open(dbPath);
  await WorkspaceMigrations.run(connection.db);
  const repo = new WorkspaceRepository(connection.db, connection);

  const project = await repo.createProjectIfMissing({ key: "PROJ", name: "Proj" });
  const [epic] = await repo.insertEpics(
    [
      {
        projectId: project.id,
        key: "proj-01",
        title: "Epic",
        description: "",
      },
    ],
    true,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "proj-01-us-01",
        title: "Story",
        description: "",
      },
    ],
    true,
  );

  return { dir, workspace, repo, project, epic, story };
};

const cleanupWorkspace = async (dir: string, repo: WorkspaceRepository) => {
  try {
    await repo.close();
  } catch {
    /* ignore */
  }
  await fs.rm(dir, { recursive: true, force: true });
};

test("orders tasks by dependency impact and normalizes priorities", async () => {
  const ctx = await setupWorkspace();
  try {
    const [t1, t2, t3, t4] = await ctx.repo.insertTasks(
      [
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T01",
          title: "Root task",
          description: "",
          status: "not_started",
          storyPoints: 3,
        },
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T02",
          title: "Second",
          description: "",
          status: "not_started",
          storyPoints: 1,
        },
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T03",
          title: "Third",
          description: "",
          status: "not_started",
          storyPoints: 2,
        },
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T04",
          title: "Fourth",
          description: "",
          status: "not_started",
          storyPoints: 5,
        },
      ],
      true,
    );
    await ctx.repo.insertTaskDependencies(
      [
        { taskId: t2.id, dependsOnTaskId: t1.id, relationType: "blocks" },
        { taskId: t3.id, dependsOnTaskId: t1.id, relationType: "blocks" },
        { taskId: t4.id, dependsOnTaskId: t3.id, relationType: "blocks" },
      ],
      true,
    );

    const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
    try {
      const result = await service.orderTasks({
        projectKey: ctx.project.key,
        includeBlocked: true,
      });
      assert.equal(result.ordered.length, 4);
      assert.deepEqual(
        result.ordered.map((t) => t.taskKey),
        ["PROJ-01-US-01-T01", "PROJ-01-US-01-T03", "PROJ-01-US-01-T02", "PROJ-01-US-01-T04"],
      );
      const priorities = await Promise.all(
        [t1, t2, t3, t4].map((task) => ctx.repo.getTaskByKey(task.key)),
      );
      assert.deepEqual(
        priorities.map((t) => t?.priority),
        [1, 3, 2, 4],
      );
      const epicRow = await ctx.repo.getDb().get<{ priority: number }>("SELECT priority FROM epics WHERE id = ?", ctx.epic.id);
      const storyRow = await ctx.repo.getDb().get<{ priority: number }>(
        "SELECT priority FROM user_stories WHERE id = ?",
        ctx.story.id,
      );
      assert.equal(epicRow?.priority, 1);
      assert.equal(storyRow?.priority, 1);
    } finally {
      await service.close();
    }
  } finally {
    await cleanupWorkspace(ctx.dir, ctx.repo);
  }
});

test("excludes blocked tasks when includeBlocked is false and still assigns priorities", async () => {
  const ctx = await setupWorkspace();
  try {
    const [t1, t2, t3] = await ctx.repo.insertTasks(
      [
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T01",
          title: "Root done",
          description: "",
          status: "completed",
        },
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T02",
          title: "Unblocked",
          description: "",
          status: "not_started",
        },
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T03",
          title: "Blocked child",
          description: "",
          status: "not_started",
        },
      ],
      true,
    );
    await ctx.repo.insertTaskDependencies(
      [
        { taskId: t2.id, dependsOnTaskId: t1.id, relationType: "blocks" },
        { taskId: t3.id, dependsOnTaskId: t2.id, relationType: "blocks" },
      ],
      true,
    );

    const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
    try {
      const result = await service.orderTasks({
        projectKey: ctx.project.key,
        includeBlocked: false,
        statusFilter: ["not_started", "completed"],
      });
      assert.equal(result.ordered.length, 2);
      assert.equal(result.blocked.length, 1);
      assert.ok(result.blocked[0].taskKey.endsWith("T03"));
      const priorities = await Promise.all(
        [t1, t2, t3].map((task) => ctx.repo.getTaskByKey(task.key)),
      );
      assert.deepEqual(
        priorities.map((t) => t?.priority),
        [1, 2, 3],
      );
    } finally {
      await service.close();
    }
  } finally {
    await cleanupWorkspace(ctx.dir, ctx.repo);
  }
});

test("handles dependency cycles gracefully", async () => {
  const ctx = await setupWorkspace();
  try {
    const [t1, t2] = await ctx.repo.insertTasks(
      [
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T01",
          title: "Cycle A",
          description: "",
          status: "not_started",
        },
        {
          projectId: ctx.project.id,
          epicId: ctx.epic.id,
          userStoryId: ctx.story.id,
          key: "PROJ-01-US-01-T02",
          title: "Cycle B",
          description: "",
          status: "not_started",
        },
      ],
      true,
    );
    await ctx.repo.insertTaskDependencies(
      [
        { taskId: t1.id, dependsOnTaskId: t2.id, relationType: "blocks" },
        { taskId: t2.id, dependsOnTaskId: t1.id, relationType: "blocks" },
      ],
      true,
    );

    const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
    try {
      const result = await service.orderTasks({
        projectKey: ctx.project.key,
        includeBlocked: true,
      });
      assert.equal(result.ordered.length, 2);
      assert.ok(result.warnings.length > 0);
      const priorities = await Promise.all(
        [t1, t2].map((task) => ctx.repo.getTaskByKey(task.key)),
      );
      const sortedPriorities = priorities
        .map((t) => t?.priority ?? 0)
        .sort((a, b) => a - b);
      assert.deepEqual(sortedPriorities, [1, 2]);
    } finally {
      await service.close();
    }
  } finally {
    await cleanupWorkspace(ctx.dir, ctx.repo);
  }
});
