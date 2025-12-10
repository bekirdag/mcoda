import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { parseTaskShowArgs, TaskShowCommands } from "../commands/backlog/TaskShowCommands.js";

describe("task show arg parsing", () => {
  it("parses positional task key with options", () => {
    const parsed = parseTaskShowArgs([
      "show",
      "web-01-us-01-t01",
      "--project",
      "WEB",
      "--include-logs",
      "--include-history",
      "--format",
      "json",
    ]);
    assert.equal(parsed.taskKey, "web-01-us-01-t01");
    assert.equal(parsed.project, "WEB");
    assert.equal(parsed.includeLogs, true);
    assert.equal(parsed.includeHistory, true);
    assert.equal(parsed.format, "json");
  });

  it("parses task-detail alias", () => {
    const parsed = parseTaskShowArgs(["--project", "WEB", "--task", "web-01-us-01-t01"]);
    assert.equal(parsed.taskKey, "web-01-us-01-t01");
    assert.equal(parsed.project, "WEB");
    assert.equal(parsed.format, "table");
  });
});

describe("task show rendering", () => {
  let workspaceRoot: string;
  let taskKey: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-task-"));
    await fs.mkdir(path.join(workspaceRoot, ".mcoda"), { recursive: true });
    const dbPath = PathHelper.getWorkspaceDbPath(workspaceRoot);
    const connection = await Connection.open(dbPath);
    await WorkspaceMigrations.run(connection.db);
    const repo = new WorkspaceRepository(connection.db, connection);

    const project = await repo.createProjectIfMissing({ key: "WEB", name: "Web" });
    const [epic] = await repo.insertEpics(
      [
        {
          projectId: project.id,
          key: "web-01",
          title: "Auth",
          description: "Authentication work",
        },
      ],
      true,
    );
    const [story] = await repo.insertStories(
      [
        {
          projectId: project.id,
          epicId: epic.id,
          key: "web-01-us-01",
          title: "Login",
          description: "Login feature",
        },
      ],
      true,
    );
    const [task] = await repo.insertTasks(
      [
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "web-01-us-01-t01",
          title: "Implement login",
          description: "Implement UI and API wiring",
          status: "in_progress",
          storyPoints: 5,
          priority: 1,
          vcsBranch: "mcoda/task/web-01-us-01-t01",
        },
      ],
      true,
    );
    taskKey = task.key;

    const now = new Date().toISOString();
    await repo.createTaskComment({
      taskId: task.id,
      sourceCommand: "work-on-tasks",
      authorType: "agent",
      body: "Initial work started.",
      createdAt: now,
    });

    await repo.close();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("prints key fields in table mode", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await TaskShowCommands.run(["--workspace-root", workspaceRoot, taskKey]);
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    assert.ok(output.includes(taskKey));
    assert.ok(output.includes("Implement login"));
    assert.ok(output.includes("SP: 5"));
    assert.ok(output.includes("Project: WEB"));
    assert.ok(output.includes("Epic: web-01"));
    assert.ok(output.includes("Story: web-01-us-01"));
    assert.ok(output.includes("Branch: mcoda/task/web-01-us-01-t01"));
    assert.ok(output.includes("Initial work started."));
  });
});
