import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { BacklogService } from "../BacklogService.js";
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

describe("BacklogService", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-backlog-"));
    await fs.mkdir(path.join(workspaceRoot, ".mcoda"), { recursive: true });
    const dbPath = PathHelper.getWorkspaceDbPath(workspaceRoot);
    const connection = await Connection.open(dbPath);
    await WorkspaceMigrations.run(connection.db);
    const repo = new WorkspaceRepository(connection.db, connection);
    const project = await repo.createProjectIfMissing({ key: "WEB", name: "Web" });
    const [epic1, epic2] = await repo.insertEpics(
      [
        {
          projectId: project.id,
          key: "web-01",
          title: "Auth",
          description: "Authentication epic description that is intentionally long to test truncation handling.",
          priority: 1,
        },
        {
          projectId: project.id,
          key: "web-02",
          title: "Payments",
          description: "Payments epic",
          priority: 2,
        },
      ],
      true,
    );
    const [story1, story2, story3] = await repo.insertStories(
      [
        {
          projectId: project.id,
          epicId: epic1.id,
          key: "web-01-us-01",
          title: "Login flow",
          description: "Implement login",
          priority: 1,
        },
        {
          projectId: project.id,
          epicId: epic1.id,
          key: "web-01-us-02",
          title: "Session refresh",
          description: "Refresh tokens",
          priority: 2,
        },
        {
          projectId: project.id,
          epicId: epic2.id,
          key: "web-02-us-01",
          title: "Card payments",
          description: "Accept payments",
          priority: 1,
        },
      ],
      true,
    );
    const [task1, task2, task3, task4, task5, task6] = await repo.insertTasks(
      [
        {
          projectId: project.id,
          epicId: epic1.id,
          userStoryId: story1.id,
          key: "web-01-us-01-t01",
          title: "Scaffold login page",
          description: "Create login UI and basic form controls",
          status: "not_started",
          storyPoints: 3,
          priority: 1,
          assigneeHuman: "alice",
        },
        {
          projectId: project.id,
          epicId: epic1.id,
          userStoryId: story1.id,
          key: "web-01-us-01-t02",
          title: "Hook login API",
          description: "Wire up API",
          status: "blocked",
          storyPoints: 2,
          priority: 2,
          assigneeHuman: "bob",
        },
        {
          projectId: project.id,
          epicId: epic1.id,
          userStoryId: story2.id,
          key: "web-01-us-02-t01",
          title: "Add review gate",
          description: "Implement review checks",
          status: "ready_to_review",
          storyPoints: 5,
          priority: 1,
          assigneeHuman: "alice",
        },
        {
          projectId: project.id,
          epicId: epic2.id,
          userStoryId: story3.id,
          key: "web-02-us-01-t01",
          title: "QA plan",
          description: "QA scenario",
          status: "ready_to_qa",
          storyPoints: 1,
          priority: 3,
        },
        {
          projectId: project.id,
          epicId: epic2.id,
          userStoryId: story3.id,
          key: "web-02-us-01-t02",
          title: "Ship payments",
          description: "Deploy payments",
          status: "completed",
          storyPoints: 8,
          priority: 1,
        },
        {
          projectId: project.id,
          epicId: epic1.id,
          userStoryId: story1.id,
          key: "web-01-us-01-t03",
          title: "Handle errors",
          description: "Edge cases",
          status: "in_progress",
          storyPoints: null,
          priority: 3,
          assigneeHuman: "alice",
        },
      ],
      true,
    );
    await repo.insertTaskDependencies(
      [
        { taskId: task2.id, dependsOnTaskId: task1.id, relationType: "blocks" },
        { taskId: task3.id, dependsOnTaskId: task2.id, relationType: "blocks" },
        { taskId: task6.id, dependsOnTaskId: task2.id, relationType: "blocks" },
      ],
      true,
    );
    await repo.close();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("aggregates backlog buckets and orders dependencies per bucket", async () => {
    const workspace = workspaceFromRoot(workspaceRoot);
    const service = await BacklogService.create(workspace);
    const { summary, warnings } = await service.getBacklog({ projectKey: "WEB", orderByDependencies: true });

    assert.equal(warnings.length, 0);
    assert.equal(summary.scope.project_key, "WEB");
    assert.equal(summary.totals.implementation.tasks, 3);
    assert.equal(summary.totals.implementation.story_points, 5);
    assert.equal(summary.totals.review.tasks, 1);
    assert.equal(summary.totals.review.story_points, 5);
    assert.equal(summary.totals.qa.story_points, 1);
    assert.equal(summary.totals.done.story_points, 8);

    assert.deepEqual(
      summary.epics.map((e) => e.epic_key),
      ["web-01", "web-02"],
    );
    const storyStatuses = summary.epics.flatMap((e) => e.stories.map((s) => s.status));
    assert.deepEqual(storyStatuses.sort(), ["completed", "in_progress", "ready_to_review"].sort());

    const tasksByKey = new Map(summary.tasks.map((t) => [t.task_key, t]));
    assert.deepEqual(tasksByKey.get("web-01-us-01-t02")?.dependency_keys, ["web-01-us-01-t01"]);
    assert.deepEqual(tasksByKey.get("web-01-us-01-t03")?.dependency_keys, ["web-01-us-01-t02"]);

    const orderedKeys = summary.tasks.map((t) => t.task_key);
    assert.deepEqual(orderedKeys, [
      "web-01-us-01-t01",
      "web-02-us-01-t01",
      "web-01-us-01-t02",
      "web-01-us-02-t01",
      "web-01-us-01-t03",
      "web-02-us-01-t02",
    ]);

    await service.close();
  });

  it("filters by status when requested", async () => {
    const workspace = workspaceFromRoot(workspaceRoot);
    const service = await BacklogService.create(workspace);
    const { summary } = await service.getBacklog({ projectKey: "WEB", statuses: ["ready_to_review"] });

    assert.equal(summary.tasks.length, 1);
    assert.equal(summary.tasks[0]?.task_key, "web-01-us-02-t01");
    assert.equal(summary.totals.review.tasks, 1);
    assert.equal(summary.totals.implementation.tasks, 0);
    await service.close();
  });
});
