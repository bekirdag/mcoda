import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../workspace/WorkspaceManager.js";
import { QaTasksApi } from "../QaTasksApi.js";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-api-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("QaTasksApi.runQa supports manual dry-run", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-api-"));
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
      await repo.insertTasks([
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "proj-epic-us-01-t01",
          title: "Task QA",
          description: "",
          status: "ready_to_qa",
          storyPoints: 1,
        },
      ]);

      const result = await QaTasksApi.runQa({
        workspaceRoot: dir,
        projectKey: "proj",
        mode: "manual",
        result: "pass",
        createFollowupTasks: "none",
        dryRun: false,
        agentStream: false,
      });

      assert.equal(result.results.length, 1);
      assert.equal(result.results[0]?.outcome, "pass");
    } finally {
      await repo.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
