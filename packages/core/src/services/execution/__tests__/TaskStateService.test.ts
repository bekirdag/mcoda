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

    const service = new TaskStateService(repo);
    await service.markReadyToReview(task, { review: true });

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_review");
    assert.equal((updated?.metadata as any)?.owner, "alex");
    assert.equal((updated?.metadata as any)?.review, true);

    await service.markBlocked(task, "needs_spec");
    const blocked = await repo.getTaskByKey(task.key);
    assert.equal(blocked?.status, "blocked");
    assert.equal((blocked?.metadata as any)?.blocked_reason, "needs_spec");
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
