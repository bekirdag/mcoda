import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { RefineTasksService } from "../RefineTasksService.js";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { WorkspaceRepository } from "@mcoda/db";
import { JobService } from "../../jobs/JobService.js";
import type { RefineTasksPlan } from "@mcoda/shared";

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

describe("RefineTasksService", () => {
  let workspaceDir: string;
  let repo: WorkspaceRepository;
  let planPath: string;
  let taskKey: string;
  let workspace: Awaited<ReturnType<typeof WorkspaceResolver.resolveWorkspace>>;
  let service: RefineTasksService;
  let storyId: string;
  let epicId: string;
  let tempHome: string | undefined;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-refine-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
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
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalProfile;
  });

  it("applies plan-in operations without invoking an agent", { concurrency: false }, async () => {
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

    const row = await repo.getDb().get<{ story_points: number; priority: number | null }>(
      `SELECT story_points, priority FROM tasks WHERE key = ?`,
      taskKey,
    );
    assert.equal(row?.story_points, 5);
    assert.equal(row?.priority, 1);
  });

  it("recomputes stage metadata when title changes", { concurrency: false }, async () => {
    const taskRow = await repo.getTaskByKey(taskKey);
    assert.ok(taskRow);
    await repo.updateTask(taskRow!.id, { metadata: { stage: "frontend", foundation: false } });

    const plan: RefineTasksPlan = {
      strategy: "auto",
      operations: [
        {
          op: "update_task",
          taskKey,
          updates: { title: "Implement API endpoint" },
        },
      ],
    };
    const tmpPlan = path.join(workspaceDir, "plan-stage.json");
    await fs.writeFile(tmpPlan, JSON.stringify(plan, null, 2), "utf8");
    await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "auto",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });

    const row = await repo.getDb().get<{ metadata_json: string }>(`SELECT metadata_json FROM tasks WHERE key = ?`, taskKey);
    const metadata = row?.metadata_json ? JSON.parse(row.metadata_json) : {};
    assert.equal(metadata.stage, "backend");
    assert.equal(metadata.foundation, false);
  });

  it("keeps stage metadata when only estimates change", { concurrency: false }, async () => {
    const taskRow = await repo.getTaskByKey(taskKey);
    assert.ok(taskRow);
    await repo.updateTask(taskRow!.id, { metadata: { stage: "frontend", foundation: false } });

    const plan: RefineTasksPlan = {
      strategy: "estimate",
      operations: [{ op: "update_estimate", taskKey, storyPoints: 8 }],
    };
    const tmpPlan = path.join(workspaceDir, "plan-estimate.json");
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

    const row = await repo.getDb().get<{ metadata_json: string }>(`SELECT metadata_json FROM tasks WHERE key = ?`, taskKey);
    const metadata = row?.metadata_json ? JSON.parse(row.metadata_json) : {};
    assert.equal(metadata.stage, "frontend");
    assert.equal(metadata.foundation, false);
  });

  it("updates rollups on estimate changes", { concurrency: false }, async () => {
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

  it("skips operations outside status filter", { concurrency: false }, async () => {
    // Mark original task as failed and create another eligible task to keep selection non-empty.
    await repo.getDb().run(`UPDATE tasks SET status = 'failed' WHERE key = ?`, taskKey);
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

  it("falls back to an available agent when routing defaults are missing", { concurrency: false }, async () => {
    const fallbackAgent = {
      id: "agent-fallback",
      slug: "agent-fallback",
      adapter: "local-model",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (service as any).routingService = {
      resolveAgentForCommand: async () => {
        throw new Error("No routing defaults found for command refine-tasks");
      },
    };
    (service as any).repo = {
      listAgents: async () => [fallbackAgent],
      listAgentHealthSummary: async () => [{ agentId: fallbackAgent.id, status: "healthy" }],
      getAgentCapabilities: async () => ["plan"],
    };
    (service as any).agentService = {
      invoke: async () => ({
        output: JSON.stringify({
          operations: [{ op: "update_estimate", taskKey, storyPoints: 3 }],
        }),
      }),
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "estimate",
      agentStream: false,
      fromDb: true,
      apply: false,
      dryRun: true,
    });

    assert.ok(result.plan.operations.length >= 1);
  });

  it("rejects plan-in operations targeting unknown tasks", { concurrency: false }, async () => {
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

  it("appends OPENAPI_HINTS summary when OpenAPI docs include x-mcoda-task-hints", async () => {
    (service as any).docdex = {
      search: async (request: any) => {
        if (request?.profile === "sds") return [];
        if (request?.profile === "openapi") {
          return [
            {
              id: "openapi-1",
              docType: "OPENAPI",
              title: "openapi.yaml",
              path: "docs/openapi/openapi.yaml",
              content: [
                "openapi: 3.1.0",
                "info:",
                "  title: Demo API",
                "  version: 1.0.0",
                "paths:",
                "  /users:",
                "    get:",
                "      operationId: listUsers",
                "      x-mcoda-task-hints:",
                "        service: backend-api",
                "        capability: users-list",
                "        stage: backend",
                "        complexity: 5",
                "        depends_on_operations: []",
                "        test_requirements:",
                "          unit: [\"validate query builder\"]",
                "          component: []",
                "          integration: [\"exercise users endpoint\"]",
                "          api: [\"validate users schema\"]",
                "      responses:",
                "        '200':",
                "          description: ok",
              ].join("\n"),
              segments: [],
            },
          ];
        }
        return [];
      },
    };
    const result = await (service as any).summarizeDocs("demo", "demo-01", "demo-01-us-01");
    assert.ok(result.summary.includes("[OPENAPI_HINTS]"));
    assert.ok(result.summary.includes("GET /users"));
    assert.ok(result.summary.includes("backend-api"));
  });

  it("invokes agent rating when enabled", { concurrency: false }, async () => {
    await service.close();
    repo = await WorkspaceRepository.create(workspaceDir);
    const ratingService = new StubRatingService();
    const agentOutput = JSON.stringify({
      operations: [{ op: "update_estimate", taskKey, storyPoints: 2 }],
    });
    const agentService = {
      invoke: async () => ({ output: agentOutput }),
    } as any;
    const routingService = {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any;
    const docdex = { search: async () => [] } as any;
    const jobService = new JobService(workspace, repo);
    service = new RefineTasksService(workspace, {
      docdex,
      jobService,
      agentService,
      repo: { close: async () => {} } as any,
      workspaceRepo: repo,
      routingService,
      ratingService: ratingService as any,
    });

    await service.refineTasks({
      workspace,
      projectKey: "demo",
      agentStream: false,
      rateAgents: true,
    });

    assert.equal(ratingService.calls.length, 1);
    assert.equal(ratingService.calls[0]?.commandName, "refine-tasks");
    assert.equal(ratingService.calls[0]?.agentId, "agent-1");
  });
});
