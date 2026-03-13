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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const removeWithRetries = async (target?: string): Promise<void> => {
  if (!target) return;
  const attempts = process.platform === "win32" ? 30 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (process.platform !== "win32") throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code) || attempt >= attempts - 1) {
        throw error;
      }
      await wait(100 * (attempt + 1));
    }
  }
};

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
    await fs.writeFile(
      path.join(workspaceDir, "package.json"),
      JSON.stringify(
        {
          name: "mcoda-refine-test-workspace",
          private: true,
          scripts: {
            "test:unit": "echo unit",
            "test:integration": "echo integration",
            "test:api": "echo api",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
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
    await removeWithRetries(workspaceDir);
    await removeWithRetries(tempHome);
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

  it("allows split children to depend on sibling references", { concurrency: false }, async () => {
    const plan: RefineTasksPlan = {
      strategy: "split",
      operations: [
        {
          op: "split_task",
          taskKey,
          children: [
            {
              title: "Child A",
              description: "first child",
              storyPoints: 2,
            },
            {
              title: "Child B",
              description: "second child",
              storyPoints: 2,
              dependsOn: ["Child A"],
            },
          ],
        },
      ],
    };
    const tmpPlan = path.join(workspaceDir, "plan-sibling-deps.json");
    await fs.writeFile(tmpPlan, JSON.stringify(plan, null, 2), "utf8");
    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "split",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });

    const childRows = await repo
      .getDb()
      .all<{ id: string; key: string; title: string }[]>(
        `SELECT id, key, title FROM tasks WHERE user_story_id = ? AND title IN ('Child A', 'Child B')`,
        storyId,
      );
    assert.equal(childRows.length, 2);
    const childA = childRows.find((row) => row.title === "Child A");
    const childB = childRows.find((row) => row.title === "Child B");
    assert.ok(childA);
    assert.ok(childB);
    assert.ok(result.createdTasks?.includes(childA!.key));
    assert.ok(result.createdTasks?.includes(childB!.key));

    const depRow = await repo.getDb().get<{ depends_on_task_id: string }>(
      `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?`,
      childB!.id,
    );
    assert.equal(depRow?.depends_on_task_id, childA!.id);
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

  it("keeps plan-in enrichments even when terminal status updates are ignored", { concurrency: false }, async () => {
    const plan: RefineTasksPlan = {
      strategy: "enrich",
      operations: [
        {
          op: "update_task",
          taskKey,
          updates: { title: "Refined task title", status: "completed" },
        },
      ],
    };
    const tmpPlan = path.join(workspaceDir, "plan-terminal-status.json");
    await fs.writeFile(tmpPlan, JSON.stringify(plan, null, 2), "utf8");

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "enrich",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });

    assert.equal(result.plan.operations.length, 1);
    assert.ok(result.updatedTasks?.includes(taskKey));
    assert.ok(result.plan.warnings?.some((w) => w.includes("Ignored terminal status completed")));

    const row = await repo.getDb().get<{ title: string; status: string }>(
      `SELECT title, status FROM tasks WHERE key = ?`,
      taskKey,
    );
    assert.equal(row?.title, "Refined task title");
    assert.equal(row?.status, "not_started");
  });

  it("keeps agent-generated operations that were previously rejected by validation", { concurrency: false }, async () => {
    const agent = {
      id: "agent-keep-invalid",
      slug: "agent-keep-invalid",
      adapter: "local-model",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (service as any).routingService = {
      resolveAgentForCommand: async () => ({ agent }),
    };
    (service as any).repo = {
      getAgentByName: async () => agent,
      getAgentCapabilities: async () => ["plan"],
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
    };
    (service as any).agentService = {
      invoke: async () => ({
        output: JSON.stringify({
          operations: [
            {
              op: "update_task",
              taskKey,
              updates: {
                title: "Agent-refined title",
                status: "completed",
              },
            },
          ],
        }),
      }),
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "enrich",
      agentStream: false,
      fromDb: true,
      apply: false,
      dryRun: true,
    });

    assert.equal(result.plan.operations.length, 1);
    const op = result.plan.operations[0] as any;
    assert.equal(op.op, "update_task");
    assert.equal(op.taskKey, taskKey);
    assert.equal(op.updates?.title, "Agent-refined title");
    assert.equal(op.updates?.status, "completed");
  });

  it("parses streamed final JSON even when earlier chunks contain progress narration", { concurrency: false }, async () => {
    const agent = {
      id: "agent-stream-json",
      slug: "agent-stream-json",
      adapter: "codex-cli",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (service as any).routingService = {
      resolveAgentForCommand: async () => ({ agent }),
    };
    (service as any).repo = {
      getAgentByName: async () => agent,
      getAgentCapabilities: async () => ["plan"],
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
    };
    (service as any).agentService = {
      invokeStream: async function* () {
        yield { output: "I am grounding the refinement in repo context first. " };
        yield {
          output: JSON.stringify({
            operations: [{ op: "update_estimate", taskKey, storyPoints: 8 }],
          }),
        };
      },
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "estimate",
      agentStream: true,
      fromDb: true,
      apply: false,
      dryRun: true,
    });

    assert.equal(result.plan.operations.length, 1);
    const op = result.plan.operations[0] as any;
    assert.equal(op.op, "update_estimate");
    assert.equal(op.taskKey, taskKey);
    assert.equal(op.storyPoints, 8);
  });

  it("retries with a strict non-stream invocation when streamed output is only narration", { concurrency: false }, async () => {
    const agent = {
      id: "agent-stream-retry-json",
      slug: "agent-stream-retry-json",
      adapter: "codex-cli",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let streamCalls = 0;
    let invokeCalls = 0;

    (service as any).routingService = {
      resolveAgentForCommand: async () => ({ agent }),
    };
    (service as any).repo = {
      getAgentByName: async () => agent,
      getAgentCapabilities: async () => ["plan"],
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
    };
    (service as any).agentService = {
      invokeStream: async function* () {
        streamCalls += 1;
        yield { output: "I'm checking context first." };
      },
      invoke: async () => {
        invokeCalls += 1;
        return {
          output: JSON.stringify({
            operations: [{ op: "update_estimate", taskKey, storyPoints: 5 }],
          }),
        };
      },
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "estimate",
      agentStream: true,
      fromDb: true,
      apply: false,
      dryRun: true,
    });

    assert.equal(streamCalls, 1);
    assert.equal(invokeCalls, 1);
    assert.equal(result.plan.operations.length, 1);
    const op = result.plan.operations[0] as any;
    assert.equal(op.op, "update_estimate");
    assert.equal(op.taskKey, taskKey);
    assert.equal(op.storyPoints, 5);
  });

  it("skips malformed split_task operations during apply instead of aborting", { concurrency: false }, async () => {
    const malformedPlan = {
      strategy: "split",
      operations: [
        {
          op: "split_task",
          taskKey,
          children: "not-an-array",
        },
      ],
    };
    const tmpPlan = path.join(workspaceDir, "plan-malformed-split.json");
    await fs.writeFile(tmpPlan, JSON.stringify(malformedPlan, null, 2), "utf8");

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "split",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });

    assert.equal(result.plan.operations.length, 1);
    assert.equal(result.createdTasks?.length ?? 0, 0);
    assert.ok(result.plan.warnings?.some((w) => w.includes("children array is required")));

    const rows = await repo
      .getDb()
      .all<{ key: string }[]>(`SELECT key FROM tasks WHERE user_story_id = ? ORDER BY key`, storyId);
    assert.deepEqual(rows.map((row) => row.key), [taskKey]);
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

  it("builds prompt context from task metadata, comments, and repo target candidates", async () => {
    const taskRow = await repo.getTaskByKey(taskKey);
    assert.ok(taskRow);
    await repo.updateTask(taskRow!.id, {
      metadata: {
        files: ["packages/core/src/services/execution/WorkOnTasksService.ts"],
        doc_links: ["docdex:docs/sds/project.md"],
        test_requirements: { unit: ["cover metadata selection"], integration: [], component: [], api: [] },
        tests: ["npm run test:unit"],
        stage: "backend",
        foundation: false,
      },
    });
    const artifactDir = path.join(workspace.mcodaDir, "tasks", "demo");
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, "build-plan.json"),
      JSON.stringify(
        {
          projectKey: "demo",
          buildMethod:
            "1. create file: packages/core/src/services/execution/WorkOnTasksService.ts\n2. update file: packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(artifactDir, "tasks.json"),
      JSON.stringify(
        [
          {
            localId: taskKey,
            epicLocalId: "demo-01",
            storyLocalId: "demo-01-us-01",
            title: "Initial task",
            description:
              "Implement packages/core/src/services/execution/WorkOnTasksService.ts and verify packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts.",
            files: [
              "packages/core/src/services/execution/WorkOnTasksService.ts",
              "packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts",
            ],
          },
        ],
        null,
        2,
      ),
      "utf8",
    );
    await repo.createTaskComment({
      taskId: taskRow!.id,
      sourceCommand: "code-review",
      authorType: "agent",
      category: "missing_context",
      status: "open",
      body: "Use packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts as the first verification surface.",
      createdAt: new Date().toISOString(),
    });
    (service as any).docdex = {
      search: async (request: any) => {
        if (request?.profile === "sds") {
          return [
            {
              id: "doc-sds",
              docType: "SDS",
              title: "project-sds.md",
              path: "docs/sds/project-sds.md",
              content: [
                "# SDS",
                "Implement packages/core/src/services/execution/WorkOnTasksService.ts.",
                "Verify with packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts.",
              ].join("\n"),
              segments: [
                {
                  content:
                    "Implement packages/core/src/services/execution/WorkOnTasksService.ts and validate packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts.",
                },
              ],
            },
          ];
        }
        if (request?.profile === "openapi") return [];
        if (request?.profile === "workspace-code") {
          return [
            {
              id: "code-1",
              docType: "CODE",
              title: "WorkOnTasksService.ts",
              path: "packages/core/src/services/execution/WorkOnTasksService.ts",
              content: "",
              segments: [],
            },
            {
              id: "code-2",
              docType: "CODE",
              title: "WorkOnTasksService.test.ts",
              path: "packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts",
              content: "",
              segments: [],
            },
          ];
        }
        return [];
      },
    };

    const refreshedTask = await repo.getTaskByKey(taskKey);
    const docContext = await (service as any).summarizeDocs("demo", "demo-01", "demo-01-us-01");
    const artifactContext = await (service as any).loadPlanningArtifactContext("demo", "demo-01", "demo-01-us-01");
    const historySummary = await (service as any).summarizeHistory([taskRow!.id]);
    const prompt = await (service as any).buildStoryPrompt(
      {
        epic: { id: epicId, key: "demo-01", title: "Demo Epic", description: "Epic" },
        story: {
          id: storyId,
          key: "demo-01-us-01",
          title: "Story",
          description: "Story",
          acceptance: ["Keep execution guidance concrete."],
        },
        tasks: [
          {
            ...refreshedTask!,
            storyKey: "demo-01-us-01",
            epicKey: "demo-01",
            dependencies: [],
          },
        ],
        docSummary: docContext.summary,
        historySummary,
        docLinks: docContext.docLinks,
        implementationTargets: Array.from(
          new Set([...docContext.implementationTargets, ...artifactContext.implementationTargets]),
        ),
        testTargets: Array.from(new Set([...docContext.testTargets, ...artifactContext.testTargets])),
        architectureRoots: artifactContext.architectureRoots,
        suggestedTestRequirements: docContext.suggestedTestRequirements,
      },
      "auto",
      docContext.summary,
    );

    assert.match(prompt, /Files: packages\/core\/src\/services\/execution\/WorkOnTasksService\.ts/);
    assert.match(prompt, /Architecture roots: packages/);
    assert.match(prompt, /Docs: docdex:docs\/sds\/project\.md/);
    assert.match(prompt, /Test requirements: unit=cover metadata selection/);
    assert.match(prompt, /Test commands: npm run test:unit/);
    assert.match(prompt, /COMMENT missing_context\/open/i);
    assert.match(prompt, /WorkOnTasksService\.test\.ts/);
    assert.match(prompt, /Implementation tasks should name concrete repo targets/i);
  });

  it("retries parseable but generic output with an execution-readiness critique", { concurrency: false }, async () => {
    const agent = {
      id: "agent-quality-retry",
      slug: "agent-quality-retry",
      adapter: "codex-cli",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let invokeCalls = 0;
    const prompts: string[] = [];
    (service as any).routingService = {
      resolveAgentForCommand: async () => ({ agent }),
    };
    (service as any).repo = {
      getAgentByName: async () => agent,
      getAgentCapabilities: async () => ["plan"],
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
    };
    (service as any).docdex = {
      search: async (request: any) => {
        if (request?.profile === "sds") {
          return [
            {
              id: "doc-sds",
              docType: "SDS",
              title: "project-sds.md",
              path: "docs/sds/project-sds.md",
              content: "Implement packages/core/src/services/execution/WorkOnTasksService.ts.",
              segments: [{ content: "Implement packages/core/src/services/execution/WorkOnTasksService.ts." }],
            },
          ];
        }
        if (request?.profile === "workspace-code") {
          return [
            {
              id: "code-1",
              docType: "CODE",
              title: "WorkOnTasksService.ts",
              path: "packages/core/src/services/execution/WorkOnTasksService.ts",
              content: "",
              segments: [],
            },
            {
              id: "code-2",
              docType: "CODE",
              title: "WorkOnTasksService.test.ts",
              path: "packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts",
              content: "",
              segments: [],
            },
          ];
        }
        return [];
      },
    };
    (service as any).agentService = {
      invoke: async (_agentId: string, request: any) => {
        prompts.push(request.input);
        invokeCalls += 1;
        if (invokeCalls === 1) {
          return {
            output: JSON.stringify({
              operations: [
                {
                  op: "update_task",
                  taskKey,
                  updates: {
                    title: "Map runtime scope",
                    description: "Analyze runtime scope and capture evidence for the execution flow.",
                    type: "feature",
                  },
                },
              ],
            }),
          };
        }
        return {
          output: JSON.stringify({
            operations: [
              {
                op: "update_task",
                taskKey,
                updates: {
                  title: "Update WorkOnTasks metadata selection",
                  description:
                    "Update packages/core/src/services/execution/WorkOnTasksService.ts and cover packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts.",
                  metadata: {
                    files: ["packages/core/src/services/execution/WorkOnTasksService.ts"],
                    test_requirements: { unit: ["cover metadata selection"], component: [], integration: [], api: [] },
                  },
                },
              },
            ],
          }),
        };
      },
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "auto",
      agentStream: false,
      fromDb: true,
      apply: false,
      dryRun: true,
    });

    assert.equal(invokeCalls, 2);
    assert.ok(result.plan.warnings?.some((warning) => warning.includes("Triggered critique retry")));
    assert.match(prompts[1] ?? "", /not execution-ready enough/i);
    const op = result.plan.operations[0] as any;
    assert.equal(op.updates?.metadata?.files?.[0], "packages/core/src/services/execution/WorkOnTasksService.ts");
  });

  it("retries when a feature refinement only targets documentation paths", { concurrency: false }, async () => {
    const agent = {
      id: "agent-docs-only-retry",
      slug: "agent-docs-only-retry",
      adapter: "codex-cli",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let invokeCalls = 0;
    const prompts: string[] = [];
    (service as any).routingService = {
      resolveAgentForCommand: async () => ({ agent }),
    };
    (service as any).repo = {
      getAgentByName: async () => agent,
      getAgentCapabilities: async () => ["plan"],
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
    };
    (service as any).docdex = {
      search: async (request: any) => {
        if (request?.profile === "sds") {
          return [
            {
              id: "doc-sds",
              docType: "SDS",
              title: "project-sds.md",
              path: "docs/sds/project-sds.md",
              content: "Implement packages/core/src/services/execution/WorkOnTasksService.ts.",
              segments: [{ content: "Implement packages/core/src/services/execution/WorkOnTasksService.ts." }],
            },
          ];
        }
        if (request?.profile === "workspace-code") {
          return [
            {
              id: "code-1",
              docType: "CODE",
              title: "WorkOnTasksService.ts",
              path: "packages/core/src/services/execution/WorkOnTasksService.ts",
              content: "",
              segments: [],
            },
          ];
        }
        return [];
      },
    };
    (service as any).agentService = {
      invoke: async (_agentId: string, request: any) => {
        prompts.push(request.input);
        invokeCalls += 1;
        if (invokeCalls === 1) {
          return {
            output: JSON.stringify({
              operations: [
                {
                  op: "update_task",
                  taskKey,
                  updates: {
                    title: "Document execution notes",
                    description: "Update docs/planning-notes.md with execution details for the flow.",
                    type: "feature",
                    metadata: {
                      files: ["docs/planning-notes.md"],
                    },
                  },
                },
              ],
            }),
          };
        }
        return {
          output: JSON.stringify({
            operations: [
              {
                op: "update_task",
                taskKey,
                updates: {
                  title: "Update execution flow",
                  description: "Update packages/core/src/services/execution/WorkOnTasksService.ts for the flow.",
                  type: "feature",
                  metadata: {
                    files: ["packages/core/src/services/execution/WorkOnTasksService.ts"],
                  },
                },
              },
            ],
          }),
        };
      },
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "auto",
      agentStream: false,
      fromDb: true,
      apply: false,
      dryRun: true,
    });

    assert.equal(invokeCalls, 2);
    assert.match(prompts[1] ?? "", /Only documentation-style paths were provided/i);
    const op = result.plan.operations[0] as any;
    assert.equal(op.updates?.metadata?.files?.[0], "packages/core/src/services/execution/WorkOnTasksService.ts");
  });

  it("retries when refinement drifts outside artifact-backed architecture roots", { concurrency: false }, async () => {
    const artifactDir = path.join(workspace.mcodaDir, "tasks", "demo");
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, "build-plan.json"),
      JSON.stringify(
        {
          projectKey: "demo",
          buildMethod: "1. create file: packages/core/src/services/execution/WorkOnTasksService.ts",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(artifactDir, "tasks.json"),
      JSON.stringify(
        [
          {
            localId: taskKey,
            epicLocalId: "demo-01",
            storyLocalId: "demo-01-us-01",
            title: "Initial task",
            description: "Update packages/core/src/services/execution/WorkOnTasksService.ts.",
            files: ["packages/core/src/services/execution/WorkOnTasksService.ts"],
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const agent = {
      id: "agent-root-drift-retry",
      slug: "agent-root-drift-retry",
      adapter: "codex-cli",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let invokeCalls = 0;
    const prompts: string[] = [];
    (service as any).routingService = {
      resolveAgentForCommand: async () => ({ agent }),
    };
    (service as any).repo = {
      getAgentByName: async () => agent,
      getAgentCapabilities: async () => ["plan"],
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
    };
    (service as any).docdex = {
      search: async () => [],
    };
    (service as any).agentService = {
      invoke: async (_agentId: string, request: any) => {
        prompts.push(request.input);
        invokeCalls += 1;
        if (invokeCalls === 1) {
          return {
            output: JSON.stringify({
              operations: [
                {
                  op: "update_task",
                  taskKey,
                  updates: {
                    title: "Update execution flow",
                    description: "Update core/execution/WorkOnTasksService.ts for the flow.",
                    type: "feature",
                    metadata: {
                      files: ["core/execution/WorkOnTasksService.ts"],
                    },
                  },
                },
              ],
            }),
          };
        }
        return {
          output: JSON.stringify({
            operations: [
              {
                op: "update_task",
                taskKey,
                updates: {
                  title: "Update execution flow",
                  description: "Update packages/core/src/services/execution/WorkOnTasksService.ts for the flow.",
                  type: "feature",
                  metadata: {
                    files: ["packages/core/src/services/execution/WorkOnTasksService.ts"],
                  },
                },
              },
            ],
          }),
        };
      },
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "auto",
      agentStream: false,
      fromDb: true,
      apply: false,
      dryRun: true,
    });

    assert.equal(invokeCalls, 2);
    assert.match(prompts[1] ?? "", /outside the established architecture roots/i);
    const op = result.plan.operations[0] as any;
    assert.equal(op.updates?.metadata?.files?.[0], "packages/core/src/services/execution/WorkOnTasksService.ts");
  });

  it("persists enriched execution metadata for update_task refinements", { concurrency: false }, async () => {
    const agent = {
      id: "agent-enrich-update",
      slug: "agent-enrich-update",
      adapter: "local-model",
      rating: 7,
      reasoningRating: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (service as any).routingService = {
      resolveAgentForCommand: async () => ({ agent }),
    };
    (service as any).repo = {
      getAgentByName: async () => agent,
      getAgentCapabilities: async () => ["plan"],
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
    };
    (service as any).docdex = {
      search: async (request: any) => {
        if (request?.profile === "sds") {
          return [
            {
              id: "doc-sds",
              docType: "SDS",
              title: "project-sds.md",
              path: "docs/sds/project-sds.md",
              content:
                "Implement packages/core/src/services/execution/WorkOnTasksService.ts and verify packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts.",
              segments: [
                {
                  content:
                    "Implement packages/core/src/services/execution/WorkOnTasksService.ts and verify packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts.",
                },
              ],
            },
          ];
        }
        if (request?.profile === "openapi") {
          return [
            {
              id: "doc-openapi",
              docType: "OPENAPI",
              title: "openapi.yaml",
              path: "docs/openapi/openapi.yaml",
              content: [
                "openapi: 3.1.0",
                "paths:",
                "  /users:",
                "    get:",
                "      x-mcoda-task-hints:",
                "        service: backend-api",
                "        capability: users-list",
                "        stage: backend",
                "        complexity: 5",
                "        depends_on_operations: []",
                "        test_requirements:",
                "          unit: [\"cover metadata selection\"]",
                "          api: [\"exercise users endpoint\"]",
              ].join("\n"),
              segments: [],
            },
          ];
        }
        if (request?.profile === "workspace-code") {
          return [
            {
              id: "code-1",
              docType: "CODE",
              title: "WorkOnTasksService.ts",
              path: "packages/core/src/services/execution/WorkOnTasksService.ts",
              content: "",
              segments: [],
            },
            {
              id: "code-2",
              docType: "CODE",
              title: "WorkOnTasksService.test.ts",
              path: "packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts",
              content: "",
              segments: [],
            },
          ];
        }
        return [];
      },
    };
    (service as any).agentService = {
      invoke: async () => ({
        output: JSON.stringify({
          operations: [
            {
              op: "update_task",
              taskKey,
              updates: {
                title: "Update WorkOnTasks metadata selection",
                description:
                  "Update WorkOnTasksService.ts for endpoint verification and cover WorkOnTasksService.test.ts in the same flow.",
                type: "feature",
              },
            },
          ],
        }),
      }),
    };

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      strategy: "auto",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });

    assert.ok(result.updatedTasks?.includes(taskKey));
    const updatedTask = await repo.getTaskByKey(taskKey);
    const metadata = (updatedTask?.metadata ?? {}) as Record<string, any>;
    const files = Array.isArray(metadata.files) ? metadata.files : [];
    const docLinks = Array.isArray(metadata.doc_links) ? metadata.doc_links : [];
    const tests = Array.isArray(metadata.tests) ? metadata.tests : [];
    assert.ok(files.includes("packages/core/src/services/execution/WorkOnTasksService.ts"));
    assert.ok(files.includes("packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts"));
    assert.ok(docLinks.includes("docdex:doc-sds"));
    assert.ok((metadata.test_requirements?.unit ?? []).length > 0);
    assert.ok(tests.some((command: string) => command.includes("test:unit") || command.includes("test:api")));
  });

  it("persists enriched execution metadata for split child tasks", { concurrency: false }, async () => {
    const plan: RefineTasksPlan = {
      strategy: "split",
      operations: [
        {
          op: "split_task",
          taskKey,
          children: [
            {
              title: "Add WorkOnTasks regression coverage",
              description:
                "Extend packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts to cover metadata selection.",
              storyPoints: 2,
              metadata: {
                files: ["packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts"],
                doc_links: ["docdex:doc-sds"],
                test_requirements: { unit: ["cover metadata selection"], component: [], integration: [], api: [] },
              },
            },
          ],
        },
      ],
    };
    const tmpPlan = path.join(workspaceDir, "plan-split-enriched-metadata.json");
    await fs.writeFile(tmpPlan, JSON.stringify(plan, null, 2), "utf8");

    const result = await service.refineTasks({
      workspace,
      projectKey: "demo",
      planInPath: tmpPlan,
      strategy: "split",
      agentStream: false,
      fromDb: true,
      apply: true,
      dryRun: false,
    });

    assert.equal(result.createdTasks?.length ?? 0, 1);
    const child = await repo.getTaskByKey(result.createdTasks![0]!);
    const metadata = (child?.metadata ?? {}) as Record<string, any>;
    const files = Array.isArray(metadata.files) ? metadata.files : [];
    const docLinks = Array.isArray(metadata.doc_links) ? metadata.doc_links : [];
    const tests = Array.isArray(metadata.tests) ? metadata.tests : [];
    assert.ok(files.includes("packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts"));
    assert.ok(docLinks.includes("docdex:doc-sds"));
    assert.ok((metadata.test_requirements?.unit ?? []).includes("cover metadata selection"));
    assert.ok(tests.some((command: string) => command.includes("test:unit")));
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
