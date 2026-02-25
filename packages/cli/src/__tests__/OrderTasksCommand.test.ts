import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { TaskOrderingService } from "@mcoda/core";
import { parseOrderTasksArgs, OrderTasksCommand } from "../commands/backlog/OrderTasksCommand.js";

const withTempHome = async <T>(fn: () => Promise<T>) => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-test-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    return await fn();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

const setupWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-order-"));
  const mcodaDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(mcodaDir, { recursive: true });
  const dbPath = PathHelper.getWorkspaceDbPath(dir);
  const connection = await Connection.open(dbPath);
  await WorkspaceMigrations.run(connection.db);
  const repo = new WorkspaceRepository(connection.db, connection);

  const project = await repo.createProjectIfMissing({ key: "CLI", name: "CLI" });
  const [epic] = await repo.insertEpics(
    [
      {
        projectId: project.id,
        key: "cli-01",
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
        key: "cli-01-us-01",
        title: "Story",
        description: "",
      },
    ],
    true,
  );
  const [t1, t2, t3] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "CLI-01-T01",
        title: "Root complete",
        description: "",
        status: "completed",
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "CLI-01-T02",
        title: "Next",
        description: "",
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "CLI-01-T03",
        title: "Blocked child",
        description: "",
        status: "not_started",
      },
    ],
    true,
  );
  await repo.insertTaskDependencies(
    [
      { taskId: t2.id, dependsOnTaskId: t1.id, relationType: "blocks" },
      { taskId: t3.id, dependsOnTaskId: t2.id, relationType: "blocks" },
    ],
    true,
  );

  return { dir, repo, project };
};

const cleanupWorkspace = async (dir: string, repo: WorkspaceRepository) => {
  try {
    await repo.close();
  } catch {
    /* ignore */
  }
  await fs.rm(dir, { recursive: true, force: true });
};

test("parseOrderTasksArgs respects defaults and flags", () => {
  const parsed = parseOrderTasksArgs([
    "--workspace-root",
    "/tmp/ws",
    "--project",
    "CLI",
    "--epic",
    "E1",
    "--story",
    "S1",
    "--status",
    "not_started,in_progress",
    "--agent",
    "codex",
    "--agent-stream",
    "false",
    "--infer-deps",
    "--apply",
    "--planning-context-policy",
    "require_any",
    "--stage-order",
    "foundation,backend,frontend,other",
    "--rate-agents",
    "--json",
  ]);
  assert.equal(parsed.workspaceRoot, path.resolve("/tmp/ws"));
  assert.equal(parsed.project, "CLI");
  assert.equal(parsed.epic, "E1");
  assert.equal(parsed.story, "S1");
  assert.deepEqual(parsed.status, ["not_started", "in_progress"]);
  assert.equal(parsed.agentName, "codex");
  assert.equal(parsed.agentStream, false);
  assert.equal(parsed.rateAgents, true);
  assert.equal(parsed.inferDeps, true);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.planningContextPolicy, "require_any");
  assert.deepEqual(parsed.stageOrder, ["foundation", "backend", "frontend", "other"]);
  assert.equal(parsed.json, true);
});

test("parseOrderTasksArgs defaults apply=true", () => {
  const parsed = parseOrderTasksArgs(["--project", "CLI"]);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.planningContextPolicy, "require_sds_or_openapi");
});

test("order-tasks requires --apply when infer-deps is set", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    const errors: string[] = [];
    const origError = console.error;
    const originalExitCode = process.exitCode;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    process.exitCode = undefined;
    try {
      await OrderTasksCommand.run([
        "--workspace-root",
        ctx.dir,
        "--project",
        ctx.project.key,
        "--infer-deps",
        "--apply=false",
      ]);
      assert.equal(process.exitCode, 1);
      assert.ok(errors.some((line) => line.includes("--apply")));
    } finally {
      console.error = origError;
      process.exitCode = originalExitCode;
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("order-tasks passes inference flags to core service", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    const logs: string[] = [];
    const origLog = console.log;
    const originalCreate = TaskOrderingService.create;
    let captured: any;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    (TaskOrderingService as any).create = async () => ({
      orderTasks: async (request: unknown) => {
        captured = request;
        return {
          project: { id: "proj", key: "CLI" },
          ordered: [],
          warnings: [],
        };
      },
      close: async () => {},
    });
    try {
      await OrderTasksCommand.run([
        "--workspace-root",
        ctx.dir,
        "--project",
        ctx.project.key,
        "--story",
        "cli-01-us-01",
        "--infer-deps",
        "--apply",
        "--stage-order",
        "foundation,backend",
        "--planning-context-policy",
        "best_effort",
        "--json",
      ]);
      assert.equal(captured?.inferDependencies, true);
      assert.equal(captured?.storyKey, "cli-01-us-01");
      assert.equal(captured?.apply, true);
      assert.equal(captured?.planningContextPolicy, "best_effort");
      assert.deepEqual(captured?.stageOrder, ["foundation", "backend"]);
    } finally {
      console.log = origLog;
      (TaskOrderingService as any).create = originalCreate;
      await cleanupWorkspace(ctx.dir, ctx.repo);
    }
  });
});

test("order-tasks command prints ordering and records telemetry", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const ctx = await setupWorkspace();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await OrderTasksCommand.run([
        "--workspace-root",
        ctx.dir,
        "--project",
        ctx.project.key,
        "--status",
        "not_started,completed",
        "--planning-context-policy",
        "best_effort",
      ]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    assert.ok(output.includes("CLI-01-T01"));
    assert.ok(output.includes("CLI-01-T02"));

    const commandRuns = await ctx.repo
      .getDb()
      .all<{ command_name: string }[]>("SELECT command_name FROM command_runs WHERE command_name = 'order-tasks'");
    assert.ok(commandRuns.length >= 1);

    await cleanupWorkspace(ctx.dir, ctx.repo);
  });
});
