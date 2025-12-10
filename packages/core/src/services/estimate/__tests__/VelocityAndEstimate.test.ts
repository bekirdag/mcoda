import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { test } from "node:test";
import { WorkspaceRepository } from "@mcoda/db";
import type { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";
import { VelocityService } from "../VelocityService.js";
import { EstimateService } from "../EstimateService.js";

const createWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-estimate-"));
  const repo = await WorkspaceRepository.create(dir);
  const workspace: WorkspaceResolution = {
    workspaceRoot: dir,
    workspaceId: dir,
    mcodaDir: path.join(dir, ".mcoda"),
    config: {
      velocity: {
        implementationSpPerHour: 10,
        reviewSpPerHour: 12,
        qaSpPerHour: 8,
        alpha: 0.5,
      },
    },
  };
  return { dir, repo, workspace };
};

test("VelocityService falls back to config when no history", async () => {
  const { repo, workspace, dir } = await createWorkspace();
  const velocityService = await VelocityService.create(workspace);
  const velocity = await velocityService.getEffectiveVelocity({ mode: "empirical" });
  assert.equal(velocity.source, "config");
  assert.equal(velocity.implementationSpPerHour, 10);
  assert.equal(velocity.reviewSpPerHour, 12);
  assert.equal(velocity.qaSpPerHour, 8);
  await velocityService.close();
  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("VelocityService computes empirical SP/hour per lane", async () => {
  const { repo, workspace, dir } = await createWorkspace();
  const project = await repo.createProjectIfMissing({ key: "PROJ" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "E1", title: "Epic 1", description: "desc" }],
    false,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "S1",
        title: "Story 1",
        description: "desc",
      },
    ],
    false,
  );
  const [taskA, taskB] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "T1",
        title: "Task 1",
        description: "desc",
        status: "not_started",
        storyPoints: 5,
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "T2",
        title: "Task 2",
        description: "desc",
        status: "in_progress",
        storyPoints: 3,
      },
    ],
    false,
  );

  const startedAt = new Date().toISOString();
  const completedAt = new Date(Date.parse(startedAt) + 3600 * 1000).toISOString();
  const commandRun = await repo.createCommandRun({
    workspaceId: workspace.workspaceId,
    commandName: "work-on-tasks",
    jobId: null,
    taskIds: [taskA.id, taskB.id],
    gitBranch: null,
    gitBaseBranch: null,
    startedAt,
    status: "running",
  });
  await repo.completeCommandRun(commandRun.id, { status: "succeeded", completedAt, durationSeconds: 3600 });
  await repo.createTaskRun({
    taskId: taskA.id,
    command: "work-on-tasks",
    status: "succeeded",
    commandRunId: commandRun.id,
    startedAt,
    finishedAt: completedAt,
  });
  await repo.createTaskRun({
    taskId: taskB.id,
    command: "work-on-tasks",
    status: "succeeded",
    commandRunId: commandRun.id,
    startedAt,
    finishedAt: completedAt,
  });

  const velocityService = await VelocityService.create(workspace);
  const velocity = await velocityService.getEffectiveVelocity({
    projectKey: project.key,
    mode: "empirical",
    windowTasks: 10,
  });
  assert.equal(Math.round((velocity.implementationSpPerHour ?? 0) * 100) / 100, 8);
  assert.equal(velocity.source, "empirical");
  await velocityService.close();
  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("EstimateService combines backlog totals and velocity", async () => {
  const { repo, workspace, dir } = await createWorkspace();
  const project = await repo.createProjectIfMissing({ key: "PROJ" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "E1", title: "Epic 1", description: "desc" }],
    false,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "S1",
        title: "Story 1",
        description: "desc",
      },
    ],
    false,
  );

  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "T1",
        title: "Task 1",
        description: "desc",
        status: "not_started",
        storyPoints: 10,
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "T2",
        title: "Task 2",
        description: "desc",
        status: "ready_to_review",
        storyPoints: 4,
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "T3",
        title: "Task 3",
        description: "desc",
        status: "ready_to_qa",
        storyPoints: 6,
      },
    ],
    false,
  );

  const estimateService = await EstimateService.create(workspace);
  const result = await estimateService.estimate({
    projectKey: project.key,
    mode: "config",
    spPerHourAll: 10,
  });

  assert.equal(result.backlogTotals.implementation.story_points, 10);
  assert.equal(result.backlogTotals.review.story_points, 4);
  assert.equal(result.backlogTotals.qa.story_points, 6);
  assert.equal(result.effectiveVelocity.source, "config");
  assert.equal(result.durationsHours.implementationHours, 1);
  assert.equal(result.durationsHours.reviewHours, 0.4);
  assert.equal(result.durationsHours.qaHours, 0.6);
  assert.ok(result.etas.completeEta);

  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
});
