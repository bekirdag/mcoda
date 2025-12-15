import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { RefineTasksService } from "../RefineTasksService.js";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { WorkspaceRepository } from "@mcoda/db";
import type { RefineTasksPlan } from "@mcoda/shared";

describe("RefineTasksService", () => {
  let workspaceDir: string;
  let repo: WorkspaceRepository;
  let planPath: string;
  let taskKey: string;
  let workspace: Awaited<ReturnType<typeof WorkspaceResolver.resolveWorkspace>>;
  let service: RefineTasksService;
  let storyId: string;
  let epicId: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-refine-"));
    workspace = await WorkspaceResolver.resolveWorkspace({ cwd: workspaceDir, explicitWorkspace: workspaceDir });
    service = await RefineTasksService.create(workspace);
    repo = (service as any).workspaceRepo as WorkspaceRepository;

    const project = await repo.createProjectIfMissing({ key: "demo", name: "demo" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "demo-01", title: "Demo Epic", description: "Epic" },
    ]);
    epicId = epic.id;
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "demo-01-us-01", title: "Story", description: "Story" },
    ]);
    storyId = story.id;
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "demo-01-us-01-t01",
        title: "Initial task",
        description: "desc",
        status: "not_started",
      },
    ]);
    taskKey = task.key;

    const plan: RefineTasksPlan = {
      strategy: "estimate",
      operations: [{ op: "update_estimate", taskKey, storyPoints: 5 }],
      warnings: [],
    };
    planPath = path.join(workspaceDir, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

  });

  afterEach(async () => {
    await service?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("applies plan-in operations without invoking an agent", async () => {
    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: planPath,
      strategy: "estimate",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });

    assert.equal(result.applied, true);
    assert.ok(result.updatedTasks?.includes(taskKey));

    const row = await repo.getDb().get<{ story_points: number }>(`SELECT story_points FROM tasks WHERE key = ?`, taskKey);
    assert.equal(row?.story_points, 5);
  });

  it("updates rollups on estimate changes", async () => {
    const plan: RefineTasksPlan = {
      strategy: "estimate",
      operations: [{ op: "update_estimate", taskKey, storyPoints: 3 }],
    };
    const tmpPlan = path.join(workspaceDir, "plan-rollup.json");
    await fs.writeFile(tmpPlan, JSON.stringify(plan, null, 2), "utf8");
    await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "estimate",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });
    const storyRow = await repo.getDb().get<{ total: number }>(
      `SELECT story_points_total as total FROM user_stories WHERE id = ?`,
      storyId,
    );
    const epicRow = await repo.getDb().get<{ total: number }>(
      `SELECT story_points_total as total FROM epics WHERE id = ?`,
      epicId,
    );
    assert.equal(storyRow?.total, 3);
    assert.equal(epicRow?.total, 3);
  });

  it("skips operations outside status filter", async () => {
    // Mark original task as blocked and create another eligible task to keep selection non-empty.
    await repo.getDb().run(`UPDATE tasks SET status = 'blocked' WHERE key = ?`, taskKey);
    const [eligible] = await repo.insertTasks([
      {
        projectId: (await repo.getProjectByKey("demo"))!.id,
        epicId,
        userStoryId: storyId,
        key: "demo-01-us-01-t02",
        title: "Eligible task",
        description: "desc",
        status: "not_started",
      },
    ]);

    const plan: RefineTasksPlan = {
      strategy: "estimate",
      operations: [{ op: "update_estimate", taskKey, storyPoints: 8 }],
    };
    const tmpPlan = path.join(workspaceDir, "plan-status.json");
    await fs.writeFile(tmpPlan, JSON.stringify(plan, null, 2), "utf8");
    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "estimate",
      agentStream: false,
      fromDb: true,
      statusFilter: ["not_started"],
    });
    assert.equal(result.updatedTasks?.length ?? 0, 0);
    assert.ok(result.plan.warnings?.some((w) => w.includes("not in selection")));
    const row = await repo.getDb().get<{ story_points: number | null }>(
      `SELECT story_points FROM tasks WHERE key = ?`,
      taskKey,
    );
    assert.equal(row?.story_points ?? null, null);
    // Eligible task should still exist untouched.
    const okRow = await repo.getDb().get<{ key: string }>(`SELECT key FROM tasks WHERE id = ?`, eligible.id);
    assert.equal(okRow?.key, eligible.key);
  });

  it("rejects plan-in operations targeting unknown tasks", async () => {
    const plan: RefineTasksPlan = {
      strategy: "estimate",
      operations: [{ op: "update_estimate", taskKey: "does-not-exist", storyPoints: 2 }],
    };
    const tmpPlan = path.join(workspaceDir, "plan-bad.json");
    await fs.writeFile(tmpPlan, JSON.stringify(plan, null, 2), "utf8");
    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "estimate",
      agentStream: false,
      fromDb: true,
    });
    assert.equal(result.updatedTasks?.length ?? 0, 0);
    assert.ok(result.plan.warnings?.some((w) => w.includes("not in selection")));
  });
});
