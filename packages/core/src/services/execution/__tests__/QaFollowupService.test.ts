import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { QaFollowupService } from "../QaFollowupService.js";

test("QaFollowupService creates follow-up tasks and dependencies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-followup-"));
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
        status: "ready_to_qa",
      },
    ]);

    const service = new QaFollowupService(repo, workspace.workspaceRoot);
    const result = await service.createFollowupTask(task, {
      title: "Fix QA issue",
      description: "Observed failure",
      evidenceUrl: "https://example.test/run/1",
    });

    assert.ok(result.task.id);
    assert.equal(result.task.title, "Fix QA issue");

    const deps = await repo.getDb().all<{ task_id: string; depends_on_task_id: string }[]>(
      "SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id = ?",
      task.id,
    );
    assert.equal(deps.length, 1);
    assert.equal(deps[0]?.depends_on_task_id, result.task.id);

    const followup = await repo.getTaskByKey(result.task.key);
    assert.equal(followup?.status, "not_started");
    assert.equal(followup?.type, "bug");
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
