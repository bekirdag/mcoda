import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../workspace/WorkspaceManager.js";
import { TasksApi } from "../TasksApi.js";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-tasks-api-home-"));
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

test("TasksApi.refineTasks wires plan-in requests", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-tasks-api-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
    try {
      const project = await repo.createProjectIfMissing({ key: "demo", name: "demo" });
      const [epic] = await repo.insertEpics([
        { projectId: project.id, key: "demo-01", title: "Epic", description: "", priority: 1 },
      ]);
      const [story] = await repo.insertStories([
        { projectId: project.id, epicId: epic.id, key: "demo-01-us-01", title: "Story", description: "" },
      ]);
      const [task] = await repo.insertTasks([
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "demo-01-us-01-t01",
          title: "Task",
          description: "",
          status: "not_started",
        },
      ]);

      const plan = {
        strategy: "estimate",
        operations: [{ op: "update_estimate", taskKey: task.key, storyPoints: 5 }],
      };
      const planPath = path.join(dir, "plan.json");
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

      const result = await TasksApi.refineTasks({
        workspaceRoot: dir,
        projectKey: "demo",
        planInPath: planPath,
        strategy: "estimate",
        dryRun: true,
      } as any);

      assert.equal(result.plan.operations.length, 1);
      assert.equal(result.plan.operations[0]?.op, "update_estimate");
    } finally {
      await repo.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
