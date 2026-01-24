import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { test } from "node:test";
import { WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import type { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";
import { VelocityService } from "../VelocityService.js";
import { EstimateService } from "../EstimateService.js";

const withTempHome = async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-estimate-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    return await fn(tempHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalProfile;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

const createWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-estimate-"));
  const repo = await WorkspaceRepository.create(dir);
  const workspace: WorkspaceResolution = {
    workspaceRoot: dir,
    workspaceId: dir,
    mcodaDir: PathHelper.getWorkspaceDir(dir),
    id: dir,
    legacyWorkspaceIds: [],
    workspaceDbPath: PathHelper.getWorkspaceDbPath(dir),
    globalDbPath: PathHelper.getGlobalDbPath(),
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
  await withTempHome(async () => {
    const { repo, workspace, dir } = await createWorkspace();
    const velocityService = await VelocityService.create(workspace);
    const velocity = await velocityService.getEffectiveVelocity({ mode: "empirical" });
    assert.equal(velocity.source, "config");
    assert.equal(velocity.requestedMode, "empirical");
    assert.equal(velocity.implementationSpPerHour, 10);
    assert.equal(velocity.reviewSpPerHour, 12);
    assert.equal(velocity.qaSpPerHour, 8);
    assert.equal(velocity.windowTasks, 10);
    assert.deepEqual(velocity.samples, { implementation: 0, review: 0, qa: 0 });
    await velocityService.close();
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

test("VelocityService honors implementation override", async () => {
  await withTempHome(async () => {
    const { repo, workspace, dir } = await createWorkspace();
    const velocityService = await VelocityService.create(workspace);
    const velocity = await velocityService.getEffectiveVelocity({ mode: "config", spPerHourImplementation: 22 });
    assert.equal(velocity.implementationSpPerHour, 22);
    assert.equal(velocity.reviewSpPerHour, 12);
    assert.equal(velocity.qaSpPerHour, 8);
    assert.equal(velocity.source, "config");
    assert.equal(velocity.requestedMode, "config");
    assert.equal(velocity.windowTasks, 10);
    assert.deepEqual(velocity.samples, { implementation: 0, review: 0, qa: 0 });
    await velocityService.close();
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
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
  assert.equal(Math.round((velocity.implementationSpPerHour ?? 0) * 100) / 100, 4);
  assert.equal(velocity.source, "empirical");
  assert.equal(velocity.requestedMode, "empirical");
  assert.equal(velocity.windowTasks, 10);
  assert.deepEqual(velocity.samples, { implementation: 2, review: 0, qa: 0 });
  await velocityService.close();
  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("VelocityService backfills status events from task runs when missing", async () => {
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
  const [task] = await repo.insertTasks(
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
    ],
    false,
  );

  const base = Date.now() - 6 * 60 * 60 * 1000;
  const implStart = new Date(base).toISOString();
  const implEnd = new Date(base + 60 * 60 * 1000).toISOString();
  const reviewStart = new Date(base + 2 * 60 * 60 * 1000).toISOString();
  const reviewEnd = new Date(base + 3 * 60 * 60 * 1000).toISOString();
  const qaStart = new Date(base + 4 * 60 * 60 * 1000).toISOString();
  const qaEnd = new Date(base + 4.5 * 60 * 60 * 1000).toISOString();

  await repo.createTaskRun({
    taskId: task.id,
    command: "work-on-tasks",
    status: "succeeded",
    startedAt: implStart,
    finishedAt: implEnd,
  });
  await repo.createTaskRun({
    taskId: task.id,
    command: "code-review",
    status: "succeeded",
    startedAt: reviewStart,
    finishedAt: reviewEnd,
  });
  await repo.createTaskRun({
    taskId: task.id,
    command: "qa-tasks",
    status: "succeeded",
    startedAt: qaStart,
    finishedAt: qaEnd,
  });

  const velocityService = await VelocityService.create(workspace);
  const velocity = await velocityService.getEffectiveVelocity({
    projectKey: project.key,
    mode: "empirical",
    windowTasks: 10,
  });

  const rows = await repo
    .getDb()
    .all<{ to_status: string; metadata_json: string | null }[]>("SELECT to_status, metadata_json FROM task_status_events");
  assert.equal(rows.length, 6);
  assert.ok(
    rows.some((row) => {
      if (!row.metadata_json) return false;
      try {
        const parsed = JSON.parse(row.metadata_json) as { backfilled?: boolean };
        return parsed.backfilled === true;
      } catch {
        return false;
      }
    }),
  );
  assert.deepEqual(velocity.samples, { implementation: 1, review: 1, qa: 1 });

  await velocityService.close();
  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("VelocityService uses status events for lane durations", async () => {
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
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "T1",
        title: "Task 1",
        description: "desc",
        status: "not_started",
        storyPoints: 6,
      },
    ],
    false,
  );

  const base = Date.now() - 4 * 60 * 60 * 1000;
  const t0 = new Date(base).toISOString();
  const t1 = new Date(base + 2 * 60 * 60 * 1000).toISOString();
  const t2 = new Date(base + 3 * 60 * 60 * 1000).toISOString();
  const t3 = new Date(base + 3.5 * 60 * 60 * 1000).toISOString();

  await repo.recordTaskStatusEvent({ taskId: task.id, fromStatus: "not_started", toStatus: "in_progress", timestamp: t0 });
  await repo.recordTaskStatusEvent({ taskId: task.id, fromStatus: "in_progress", toStatus: "ready_to_code_review", timestamp: t1 });
  await repo.recordTaskStatusEvent({ taskId: task.id, fromStatus: "ready_to_code_review", toStatus: "ready_to_qa", timestamp: t2 });
  await repo.recordTaskStatusEvent({ taskId: task.id, fromStatus: "ready_to_qa", toStatus: "completed", timestamp: t3 });

  const velocityService = await VelocityService.create(workspace);
  const velocity = await velocityService.getEffectiveVelocity({
    projectKey: project.key,
    mode: "empirical",
    windowTasks: 10,
  });

  assert.equal(Math.round((velocity.implementationSpPerHour ?? 0) * 100) / 100, 3);
  assert.equal(Math.round((velocity.reviewSpPerHour ?? 0) * 100) / 100, 6);
  assert.equal(Math.round((velocity.qaSpPerHour ?? 0) * 100) / 100, 12);
  assert.deepEqual(velocity.samples, { implementation: 1, review: 1, qa: 1 });

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
        status: "ready_to_code_review",
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
  assert.equal(result.durationsHours.totalHours, 2);
  assert.ok(result.etas.completeEta);
  assert.ok(result.etas.readyToReviewEta);
  assert.ok(result.etas.readyToQaEta);
  const readyReview = Date.parse(result.etas.readyToReviewEta ?? "");
  const readyQa = Date.parse(result.etas.readyToQaEta ?? "");
  const complete = Date.parse(result.etas.completeEta ?? "");
  assert.ok(Number.isFinite(readyReview));
  assert.ok(Number.isFinite(readyQa));
  assert.ok(Number.isFinite(complete));
  assert.ok(readyReview < readyQa);
  assert.ok(readyQa < complete);

  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("EstimateService accounts for elapsed in-progress time", async () => {
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
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "T1",
        title: "Task 1",
        description: "desc",
        status: "in_progress",
        storyPoints: 6,
      },
    ],
    false,
  );

  const startedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await repo.recordTaskStatusEvent({
    taskId: task.id,
    fromStatus: "not_started",
    toStatus: "in_progress",
    timestamp: startedAt,
  });

  const estimateService = await EstimateService.create(workspace);
  const result = await estimateService.estimate({
    projectKey: project.key,
    mode: "config",
    spPerHourAll: 6,
  });

  const implementationHours = result.durationsHours.implementationHours ?? null;
  assert.ok(implementationHours !== null);
  assert.ok(implementationHours < 1);
  assert.ok(implementationHours > 0);
  assert.ok(Math.abs(implementationHours - 0.5) < 0.3);
  assert.ok(result.etas.readyToReviewEta);

  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
});
