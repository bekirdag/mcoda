import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskOrderingService, parseDependencyInferenceOutput } from "../TaskOrderingService.js";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-order-home-"));
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

const setupWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-order-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const dbPath = workspace.workspaceDbPath;
  const connection = await Connection.open(dbPath);
  await WorkspaceMigrations.run(connection.db);
  const repo = new WorkspaceRepository(connection.db, connection);

  const project = await repo.createProjectIfMissing({ key: "PROJ", name: "Proj" });
  const [epic] = await repo.insertEpics(
    [
      {
        projectId: project.id,
        key: "proj-01",
        title: "Epic",
        description: "",
      },
    ],
    true,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "proj-01-us-01",
        title: "Story",
        description: "",
      },
    ],
    true,
  );

  return { dir, workspace, repo, project, epic, story };
};

const cleanupWorkspace = async (dir: string, repo: WorkspaceRepository) => {
  try {
    await repo.close();
  } catch {
    /* ignore */
  }
  await fs.rm(dir, { recursive: true, force: true });
};

test("parses inferred dependencies output and ignores invalid entries", () => {
  const warnings: string[] = [];
  const output = JSON.stringify({
    dependencies: [
      { task_key: "T1", depends_on: ["T2", "T2", "T1", "UNKNOWN"] },
      { task_key: "UNKNOWN", depends_on: ["T1"] },
      { task_key: "T2", depends_on: ["T1", 123] },
      { task_key: "T1", depends_on: ["T2"] },
      { task_key: "T2", depends_on: [] },
      { task_key: "T3" },
    ],
  });

  const result = parseDependencyInferenceOutput(output, new Set(["T1", "T2"]), warnings);
  assert.deepEqual(result, [
    { taskKey: "T1", dependsOnKeys: ["T2"] },
    { taskKey: "T2", dependsOnKeys: ["T1"] },
  ]);
  assert.ok(warnings.some((warning) => warning.includes("invalid task keys")));
  assert.ok(warnings.some((warning) => warning.includes("invalid dependency keys")));
  assert.ok(warnings.some((warning) => warning.includes("self-dependencies")));
});

test("parses inferred dependencies output from fenced json and array payloads", () => {
  const warnings: string[] = [];
  const fenced = [
    "Here is the result:",
    "```json",
    JSON.stringify({ dependencies: [{ task_key: "T1", depends_on: ["T2"] }] }, null, 2),
    "```",
  ].join("\n");
  const result = parseDependencyInferenceOutput(fenced, new Set(["T1", "T2"]), warnings);
  assert.deepEqual(result, [{ taskKey: "T1", dependsOnKeys: ["T2"] }]);
  assert.ok(!warnings.some((warning) => warning.includes("could not be parsed")));

  const warningsArray: string[] = [];
  const arrayOutput = JSON.stringify([{ task_key: "T2", depends_on: ["T1"] }]);
  const arrayResult = parseDependencyInferenceOutput(arrayOutput, new Set(["T1", "T2"]), warningsArray);
  assert.deepEqual(arrayResult, [{ taskKey: "T2", dependsOnKeys: ["T1"] }]);
  assert.ok(!warningsArray.some((warning) => warning.includes("could not be parsed")));
});

test("applyAgentRanking accepts string array ordering", () => {
  const service = Object.create(TaskOrderingService.prototype) as TaskOrderingService;
  const ordered = [
    { id: "1", key: "T1" },
    { id: "2", key: "T2" },
  ] as any;
  const warnings: string[] = [];
  const ranking = (service as any).applyAgentRanking(ordered, JSON.stringify(["T2", "T1"]), warnings) as
    | Map<string, number>
    | undefined;
  assert.ok(ranking);
  assert.equal(ranking?.get("2"), 0);
  assert.equal(ranking?.get("1"), 1);
  assert.equal(warnings.length, 0);
});

test("orders tasks by dependency impact and normalizes priorities", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [t1, t2, t3, t4] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Root task",
            description: "",
            status: "not_started",
            storyPoints: 3,
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Second",
            description: "",
            status: "not_started",
            storyPoints: 1,
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T03",
            title: "Third",
            description: "",
            status: "not_started",
            storyPoints: 2,
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T04",
            title: "Fourth",
            description: "",
            status: "not_started",
            storyPoints: 5,
          },
        ],
        true,
      );
      await ctx.repo.insertTaskDependencies(
        [
          { taskId: t2.id, dependsOnTaskId: t1.id, relationType: "blocks" },
          { taskId: t3.id, dependsOnTaskId: t1.id, relationType: "blocks" },
          { taskId: t4.id, dependsOnTaskId: t3.id, relationType: "blocks" },
        ],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        const result = await service.orderTasks({
          projectKey: ctx.project.key,
        });
        assert.equal(result.ordered.length, 4);
        assert.deepEqual(
          result.ordered.map((t) => t.taskKey),
          ["PROJ-01-US-01-T01", "PROJ-01-US-01-T03", "PROJ-01-US-01-T02", "PROJ-01-US-01-T04"],
        );
        const priorities = await Promise.all(
          [t1, t2, t3, t4].map((task) => ctx.repo.getTaskByKey(task.key)),
        );
        assert.deepEqual(
          priorities.map((t) => t?.priority),
          [1, 3, 2, 4],
        );
        const epicRow = await ctx.repo.getDb().get<{ priority: number }>(
          "SELECT priority FROM epics WHERE id = ?",
          ctx.epic.id,
        );
        const storyRow = await ctx.repo.getDb().get<{ priority: number }>(
          "SELECT priority FROM user_stories WHERE id = ?",
          ctx.story.id,
        );
        assert.equal(epicRow?.priority, 1);
        assert.equal(storyRow?.priority, 1);
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("orders tasks with dependencies and still assigns priorities", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [t1, t2, t3] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Root done",
            description: "",
            status: "completed",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Unblocked",
            description: "",
            status: "not_started",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T03",
            title: "Blocked child",
            description: "",
            status: "not_started",
          },
        ],
        true,
      );
      await ctx.repo.insertTaskDependencies(
        [
          { taskId: t2.id, dependsOnTaskId: t1.id, relationType: "blocks" },
          { taskId: t3.id, dependsOnTaskId: t2.id, relationType: "blocks" },
        ],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        const result = await service.orderTasks({
          projectKey: ctx.project.key,
          statusFilter: ["not_started", "completed"],
        });
        assert.equal(result.ordered.length, 3);
        const priorities = await Promise.all(
          [t1, t2, t3].map((task) => ctx.repo.getTaskByKey(task.key)),
        );
        assert.deepEqual(
          priorities.map((t) => t?.priority),
          [1, 2, 3],
        );
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("uses stage ordering as a tie-breaker when priorities match", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Initialize project scaffold",
            description: "",
            status: "not_started",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Implement API endpoint",
            description: "",
            status: "not_started",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T03",
            title: "Render UI list",
            description: "",
            status: "not_started",
          },
        ],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        const result = await service.orderTasks({ projectKey: ctx.project.key });
        assert.deepEqual(
          result.ordered.map((t) => t.taskKey),
          ["PROJ-01-US-01-T01", "PROJ-01-US-01-T02", "PROJ-01-US-01-T03"],
        );
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("warns on tasks with open missing_context comments", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [t1, t2] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Initialize project scaffold",
            description: "",
            status: "not_started",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Render UI list",
            description: "",
            status: "not_started",
          },
        ],
        true,
      );
      await ctx.repo.createTaskComment({
        taskId: t2.id,
        sourceCommand: "gateway-trio",
        authorType: "agent",
        category: "missing_context",
        body: "Missing context details",
        createdAt: new Date().toISOString(),
      });

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        const result = await service.orderTasks({ projectKey: ctx.project.key });
        assert.equal(result.ordered.length, 2);
        assert.ok(result.warnings.some((warning) => warning.includes("missing_context")));
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("injects inferred foundation dependencies for non-foundation tasks", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [foundation, nonFoundation] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Setup project scaffold",
            description: "",
            status: "not_started",
            type: "chore",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Implement API endpoint",
            description: "",
            status: "not_started",
          },
        ],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        const result = await service.orderTasks({ projectKey: ctx.project.key });
        assert.deepEqual(
          result.ordered.map((t) => t.taskKey),
          ["PROJ-01-US-01-T01", "PROJ-01-US-01-T02"],
        );
        const deps = await ctx.repo.getTaskDependencies([foundation.id, nonFoundation.id]);
        const nonFoundationDeps = deps.filter((dep) => dep.taskId === nonFoundation.id);
        const foundationDeps = deps.filter((dep) => dep.taskId === foundation.id);
        assert.equal(foundationDeps.length, 0);
        assert.equal(nonFoundationDeps.length, 1);
        assert.equal(nonFoundationDeps[0].dependsOnTaskId, foundation.id);
        assert.equal(nonFoundationDeps[0].relationType, "inferred_foundation");
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("skips inferred foundation dependencies that introduce cycles", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [foundation, nonFoundation] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Initialize project scaffold",
            description: "",
            status: "not_started",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Implement API endpoint",
            description: "",
            status: "not_started",
          },
        ],
        true,
      );
      await ctx.repo.insertTaskDependencies(
        [{ taskId: foundation.id, dependsOnTaskId: nonFoundation.id, relationType: "blocks" }],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        const result = await service.orderTasks({ projectKey: ctx.project.key });
        assert.ok(result.warnings.some((warning) => warning.includes("Skipped")));
        const deps = await ctx.repo.getTaskDependencies([foundation.id, nonFoundation.id]);
        const nonFoundationDeps = deps.filter((dep) => dep.taskId === nonFoundation.id);
        assert.equal(nonFoundationDeps.length, 0);
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("applies inferred agent dependencies and reorders tasks", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [t1, t2] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Implement feature A",
            description: "",
            status: "not_started",
            storyPoints: 5,
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Implement feature B",
            description: "",
            status: "not_started",
            storyPoints: 1,
          },
        ],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        (service as any).buildDocContext = async () => undefined;
        (service as any).resolveAgent = async () => ({
          id: "agent-1",
          slug: "agent-1",
          adapter: "local",
          defaultModel: "stub",
        });
        (service as any).inferDependenciesWithAgent = async () => [
          { taskKey: t2.key, dependsOnKeys: [t1.key] },
        ];
        const result = await service.orderTasks({
          projectKey: ctx.project.key,
          inferDependencies: true,
        });
        assert.deepEqual(
          result.ordered.map((task) => task.taskKey),
          ["PROJ-01-US-01-T01", "PROJ-01-US-01-T02"],
        );
        const deps = await ctx.repo.getTaskDependencies([t1.id, t2.id]);
        const inferred = deps.find((dep) => dep.taskId === t2.id);
        assert.ok(inferred);
        assert.equal(inferred?.dependsOnTaskId, t1.id);
        assert.equal(inferred?.relationType, "inferred_agent");
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("skips inferred agent dependencies that introduce cycles", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [t1, t2] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Implement feature A",
            description: "",
            status: "not_started",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Implement feature B",
            description: "",
            status: "not_started",
          },
        ],
        true,
      );
      await ctx.repo.insertTaskDependencies(
        [{ taskId: t1.id, dependsOnTaskId: t2.id, relationType: "blocks" }],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        (service as any).buildDocContext = async () => undefined;
        (service as any).resolveAgent = async () => ({
          id: "agent-1",
          slug: "agent-1",
          adapter: "local",
          defaultModel: "stub",
        });
        (service as any).inferDependenciesWithAgent = async () => [
          { taskKey: t2.key, dependsOnKeys: [t1.key] },
        ];
        const result = await service.orderTasks({
          projectKey: ctx.project.key,
          inferDependencies: true,
        });
        assert.ok(result.warnings.some((warning) => warning.includes("Skipped")));
        const deps = await ctx.repo.getTaskDependencies([t1.id, t2.id]);
        const t2Deps = deps.filter((dep) => dep.taskId === t2.id);
        assert.equal(t2Deps.length, 0);
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("handles dependency cycles gracefully", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    try {
      const [t1, t2] = await ctx.repo.insertTasks(
        [
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T01",
            title: "Cycle A",
            description: "",
            status: "not_started",
          },
          {
            projectId: ctx.project.id,
            epicId: ctx.epic.id,
            userStoryId: ctx.story.id,
            key: "PROJ-01-US-01-T02",
            title: "Cycle B",
            description: "",
            status: "not_started",
          },
        ],
        true,
      );
      await ctx.repo.insertTaskDependencies(
        [
          { taskId: t1.id, dependsOnTaskId: t2.id, relationType: "blocks" },
          { taskId: t2.id, dependsOnTaskId: t1.id, relationType: "blocks" },
        ],
        true,
      );

      const service = await TaskOrderingService.create(ctx.workspace, { recordTelemetry: false });
      try {
        const result = await service.orderTasks({
          projectKey: ctx.project.key,
        });
        assert.equal(result.ordered.length, 2);
        assert.ok(result.warnings.length > 0);
        const priorities = await Promise.all(
          [t1, t2].map((task) => ctx.repo.getTaskByKey(task.key)),
        );
        const sortedPriorities = priorities
          .map((t) => t?.priority ?? 0)
          .sort((a, b) => a - b);
        assert.deepEqual(sortedPriorities, [1, 2]);
      } finally {
        await service.close();
      }
    } finally {
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});
