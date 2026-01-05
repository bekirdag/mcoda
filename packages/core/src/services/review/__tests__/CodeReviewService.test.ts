import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { JobService } from "../../jobs/JobService.js";
import { CodeReviewService } from "../CodeReviewService.js";

test("CodeReviewService records approvals and updates status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => ({ output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" }),
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

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
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "approve");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
