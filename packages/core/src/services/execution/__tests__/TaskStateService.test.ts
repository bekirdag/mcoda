import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskStateService } from "../TaskStateService.js";

test("TaskStateService merges metadata and updates status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-taskstate-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "not_started",
        metadata: { owner: "alex" },
      },
    ]);

    const job = await repo.createJob({
      workspaceId: workspace.workspaceId,
      type: "work",
      state: "running",
      commandName: "work-on-tasks",
    });
    const taskRun = await repo.createTaskRun({
      taskId: task.id,
      command: "work-on-tasks",
      jobId: job.id,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const statusContext = {
      commandName: "work-on-tasks",
      jobId: job.id,
      taskRunId: taskRun.id,
      agentId: "agent-1",
      metadata: { lane: "work" },
    };

    const service = new TaskStateService(repo);
    await service.markReadyToReview(task, { review: true }, statusContext);

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_code_review");
    assert.equal((updated?.metadata as any)?.owner, "alex");
    assert.equal((updated?.metadata as any)?.review, true);

    await service.markFailed(task, "tests_failed", statusContext);
    const failed = await repo.getTaskByKey(task.key);
    assert.equal(failed?.status, "failed");
    assert.equal((failed?.metadata as any)?.failed_reason, "tests_failed");

    await service.transitionToInProgress(task, statusContext);
    await service.markNotStarted(task, { qa_reset: true }, statusContext);
    const reset = await repo.getTaskByKey(task.key);
    assert.equal(reset?.status, "not_started");
    assert.equal((reset?.metadata as any)?.qa_reset, true);

    const db = repo.getDb();
    const events = await db.all<{
      from_status: string | null;
      to_status: string;
      command_name: string | null;
      job_id: string | null;
      task_run_id: string | null;
      agent_id: string | null;
      metadata_json: string | null;
    }[]>(
      "SELECT from_status, to_status, command_name, job_id, task_run_id, agent_id, metadata_json FROM task_status_events WHERE task_id = ? ORDER BY timestamp",
      task.id,
    );
    assert.equal(events.length, 4);
    assert.equal(events[0]?.from_status, "not_started");
    assert.equal(events[0]?.to_status, "ready_to_code_review");
    assert.equal(events[0]?.command_name, "work-on-tasks");
    assert.equal(events[0]?.job_id, job.id);
    assert.equal(events[0]?.task_run_id, taskRun.id);
    assert.equal(events[0]?.agent_id, "agent-1");
    const firstMeta = events[0]?.metadata_json ? JSON.parse(events[0].metadata_json) : {};
    assert.equal(firstMeta.lane, "work");
    assert.equal(events[1]?.from_status, "ready_to_code_review");
    assert.equal(events[1]?.to_status, "failed");
    const secondMeta = events[1]?.metadata_json ? JSON.parse(events[1].metadata_json) : {};
    assert.equal(secondMeta.lane, "work");
    assert.equal(secondMeta.failed_reason, "tests_failed");
    assert.equal(events[2]?.from_status, "failed");
    assert.equal(events[2]?.to_status, "in_progress");
    const thirdMeta = events[2]?.metadata_json ? JSON.parse(events[2].metadata_json) : {};
    assert.equal(thirdMeta.lane, "work");
    assert.equal(events[3]?.from_status, "in_progress");
    assert.equal(events[3]?.to_status, "not_started");
    const fourthMeta = events[3]?.metadata_json ? JSON.parse(events[3].metadata_json) : {};
    assert.equal(fourthMeta.lane, "work");
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
