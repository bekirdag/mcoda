import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "../repositories/workspace/WorkspaceRepository.js";

test("WorkspaceRepository createProjectIfMissing is idempotent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-db-"));
  const repo = await WorkspaceRepository.create(dir);
  try {
    const first = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const second = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    assert.equal(first.id, second.id);
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("WorkspaceRepository getProjectById returns matching row", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-db-"));
  const repo = await WorkspaceRepository.create(dir);
  try {
    const created = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const fetched = await repo.getProjectById(created.id);
    assert.ok(fetched);
    assert.equal(fetched?.id, created.id);
    assert.equal(fetched?.key, created.key);
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("WorkspaceRepository tryAcquireTaskLock overrides stale locks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-db-"));
  const repo = await WorkspaceRepository.create(dir);
  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      {
        projectId: project.id,
        key: "epic-1",
        title: "Epic",
        description: "",
      },
    ]);
    const [story] = await repo.insertStories([
      {
        projectId: project.id,
        epicId: epic.id,
        key: "story-1",
        title: "Story",
        description: "",
      },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "task-1",
        title: "Task",
        description: "",
        status: "in_progress",
      },
    ]);
    const firstRun = await repo.createTaskRun({
      taskId: task.id,
      command: "work-on-tasks",
      jobId: null,
      commandRunId: null,
      agentId: null,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const firstLock = await repo.tryAcquireTaskLock(task.id, firstRun.id, null, 3600);
    assert.equal(firstLock.acquired, true);

    await repo.updateTaskRun(firstRun.id, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
    });

    const secondRun = await repo.createTaskRun({
      taskId: task.id,
      command: "work-on-tasks",
      jobId: null,
      commandRunId: null,
      agentId: null,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const secondLock = await repo.tryAcquireTaskLock(task.id, secondRun.id, null, 3600);
    assert.equal(secondLock.acquired, true);
    assert.equal(secondLock.lock?.taskRunId, secondRun.id);
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("WorkspaceRepository resolves and reopens task comments by slug", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-db-"));
  const repo = await WorkspaceRepository.create(dir);
  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      {
        projectId: project.id,
        key: "epic-1",
        title: "Epic",
        description: "",
      },
    ]);
    const [story] = await repo.insertStories([
      {
        projectId: project.id,
        epicId: epic.id,
        key: "story-1",
        title: "Story",
        description: "",
      },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "task-1",
        title: "Task",
        description: "",
        status: "not_started",
      },
    ]);
    const now = new Date().toISOString();
    await repo.createTaskComment({
      taskId: task.id,
      sourceCommand: "code-review",
      authorType: "agent",
      body: "Review finding",
      createdAt: now,
      slug: "review-url-200",
      status: "open",
    });

    const listed = await repo.listTaskComments(task.id, { slug: "review-url-200" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].slug, "review-url-200");
    assert.equal(listed[0].status, "open");

    await repo.resolveTaskComment({
      taskId: task.id,
      slug: "review-url-200",
      resolvedAt: now,
      resolvedBy: "agent-1",
    });

    const unresolved = await repo.listTaskComments(task.id, { resolved: false });
    assert.equal(unresolved.length, 0);
    const resolved = await repo.listTaskComments(task.id, { resolved: true });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].status, "resolved");

    await repo.reopenTaskComment({ taskId: task.id, slug: "review-url-200" });
    const reopened = await repo.listTaskComments(task.id, { resolved: false, slug: "review-url-200" });
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].status, "open");
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
