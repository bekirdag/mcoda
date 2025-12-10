import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskSelectionService } from "../TaskSelectionService.js";

const setupWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-selection-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "proj" });
  const [epic] = await repo.insertEpics(
    [
      {
        projectId: project.id,
        key: "proj-epic",
        title: "Epic",
        description: "Epic desc",
        storyPointsTotal: null,
        priority: 1,
      },
    ],
    false,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "proj-epic-us-01",
        title: "Story",
        description: "Story desc",
        acceptanceCriteria: "ac1",
        storyPointsTotal: null,
        priority: 1,
      },
    ],
    false,
  );
  return { dir, workspace, repo, project, epic, story };
};

const cleanupWorkspace = async (dir: string, repo: WorkspaceRepository) => {
  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
};

test("selectTasks orders by dependencies and priority and skips dependency-blocked tasks", async () => {
  const ctx = await setupWorkspace();
  const { repo, story, project, dir, workspace } = ctx;

  const [readyReview] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t05",
        title: "Review Task",
        description: "",
        status: "ready_to_review",
      },
    ],
    false,
  );

  const tasks = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task A",
        description: "",
        priority: 1,
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "Task B",
        description: "",
        priority: 2,
        status: "in_progress",
      },
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t03",
        title: "Task C",
        description: "",
        priority: 5,
        storyPoints: 1,
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t04",
        title: "Blocked",
        description: "",
        status: "not_started",
      },
    ],
    false,
  );

  await repo.insertTaskDependencies(
    [
      { taskId: tasks[1].id, dependsOnTaskId: tasks[0].id, relationType: "blocks" },
      { taskId: tasks[3].id, dependsOnTaskId: readyReview.id, relationType: "blocks" },
    ],
    false,
  );

  const selection = new TaskSelectionService(workspace, repo);
  const plan = await selection.selectTasks({ projectKey: "proj" });
  assert.deepStrictEqual(plan.ordered.map((t) => t.task.key), ["proj-epic-us-01-t03", "proj-epic-us-01-t01"]);
  assert.equal(plan.blocked.length, 2);
  assert.ok(plan.blocked.some((b) => b.task.key === "proj-epic-us-01-t04"));
  assert.ok(plan.blocked.some((b) => b.task.key === "proj-epic-us-01-t02"));
  await cleanupWorkspace(dir, repo);
});

test("selectTasks surfaces cycles in dependencies", async () => {
  const ctx = await setupWorkspace();
  const { repo, story, project, dir, workspace } = ctx;

  const tasks = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t10",
        title: "Cycle A",
        description: "",
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t11",
        title: "Cycle B",
        description: "",
        status: "not_started",
      },
    ],
    false,
  );

  await repo.insertTaskDependencies(
    [
      { taskId: tasks[0].id, dependsOnTaskId: tasks[1].id, relationType: "blocks" },
      { taskId: tasks[1].id, dependsOnTaskId: tasks[0].id, relationType: "blocks" },
    ],
    false,
  );

  const selection = new TaskSelectionService(workspace, repo);
  const plan = await selection.selectTasks({
    projectKey: "proj",
    taskKeys: ["proj-epic-us-01-t10", "proj-epic-us-01-t11"],
  });
  assert.equal(plan.ordered.length, 2);
  assert.equal(plan.blocked.length, 0);
  assert.ok(plan.ordered.every((t) => t.blockedReason === "dependency_not_ready"));
  assert.ok(plan.warnings.some((w) => w.toLowerCase().includes("cycle")));
  await cleanupWorkspace(dir, repo);
});
