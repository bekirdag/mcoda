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
        status: "ready_to_code_review",
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
  assert.deepStrictEqual(plan.ordered.map((t) => t.task.key), ["proj-epic-us-01-t01", "proj-epic-us-01-t03"]);
  assert.ok(plan.warnings.some((warning) => warning.includes("dependencies not ready")));
  await cleanupWorkspace(dir, repo);
});

test("selectTasks warns by default and keeps tasks with open missing_context comments", async () => {
  const ctx = await setupWorkspace();
  const { repo, story, project, dir, workspace } = ctx;

  const [t1, t2] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t20",
        title: "Setup project scaffold",
        description: "",
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t21",
        title: "Implement API route",
        description: "",
        status: "not_started",
      },
    ],
    false,
  );

  await repo.createTaskComment({
    taskId: t2.id,
    sourceCommand: "gateway-trio",
    authorType: "agent",
    category: "missing_context",
    body: "Missing API shape details.",
    createdAt: new Date().toISOString(),
  });

  const selection = new TaskSelectionService(workspace, repo);
  const plan = await selection.selectTasks({ projectKey: "proj" });
  assert.deepStrictEqual(plan.ordered.map((t) => t.task.key).sort(), ["proj-epic-us-01-t20", "proj-epic-us-01-t21"].sort());
  assert.ok(plan.warnings.some((warning) => warning.includes("missing_context")));
  await cleanupWorkspace(dir, repo);
});

test("selectTasks blocks tasks with open missing_context comments when policy is block", async () => {
  const ctx = await setupWorkspace();
  const { repo, story, project, dir, workspace } = ctx;

  const [t1, t2] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t22",
        title: "Setup project scaffold",
        description: "",
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t23",
        title: "Implement API route",
        description: "",
        status: "not_started",
      },
    ],
    false,
  );

  await repo.createTaskComment({
    taskId: t2.id,
    sourceCommand: "gateway-trio",
    authorType: "agent",
    category: "missing_context",
    body: "Missing API shape details.",
    createdAt: new Date().toISOString(),
  });

  const selection = new TaskSelectionService(workspace, repo);
  const plan = await selection.selectTasks({ projectKey: "proj", missingContextPolicy: "block" });
  assert.deepStrictEqual(plan.ordered.map((t) => t.task.key), [t1.key]);
  assert.ok(plan.warnings.some((warning) => warning.includes("open missing_context comments")));
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
  assert.equal(plan.ordered.length, 0);
  assert.ok(plan.warnings.some((warning) => warning.includes("dependencies not ready")));
  await cleanupWorkspace(dir, repo);
});

test("selectTasks ignores blocked in status filters", async () => {
  const ctx = await setupWorkspace();
  const { repo, story, project, dir, workspace } = ctx;

  const tasks = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t30",
        title: "Prereq",
        description: "",
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: story.epicId,
        userStoryId: story.id,
        key: "proj-epic-us-01-t31",
        title: "Dependent",
        description: "",
        status: "blocked",
      },
    ],
    false,
  );

  await repo.insertTaskDependencies(
    [{ taskId: tasks[1].id, dependsOnTaskId: tasks[0].id, relationType: "blocks" }],
    false,
  );

  const selection = new TaskSelectionService(workspace, repo);
  const plan = await selection.selectTasks({
    projectKey: "proj",
    statusFilter: ["not_started", "blocked"],
  });
  assert.deepStrictEqual(plan.ordered.map((t) => t.task.key), ["proj-epic-us-01-t30"]);
  assert.ok(plan.warnings.some((warning) => warning.includes("Status 'blocked' is no longer supported")));
  await cleanupWorkspace(dir, repo);
});
