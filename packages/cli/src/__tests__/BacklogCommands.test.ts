import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { BacklogCommands, parseBacklogArgs } from "../commands/backlog/BacklogCommands.js";

const captureLogs = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
};

describe("backlog argument parsing", () => {
  it("parses workspace root, status filters, and order dependencies", () => {
    const root = path.resolve("/tmp/mcoda");
    const parsed = parseBacklogArgs([
      "--workspace-root",
      root,
      "--status",
      "ready_to_code_review,blocked",
      "--order",
      "dependencies",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.deepEqual(parsed.statuses, ["ready_to_code_review"]);
    assert.equal(parsed.orderDependencies, true);
  });

  it("supports inline flags and output toggles", () => {
    const parsed = parseBacklogArgs([
      "--project=proj",
      "--epic=epic",
      "--story=story",
      "--assignee=alex",
      "--status=not_started",
      "--json",
      "--verbose",
    ]);
    assert.equal(parsed.project, "proj");
    assert.equal(parsed.epic, "epic");
    assert.equal(parsed.story, "story");
    assert.equal(parsed.assignee, "alex");
    assert.deepEqual(parsed.statuses, ["not_started"]);
    assert.equal(parsed.json, true);
    assert.equal(parsed.verbose, true);
  });

  it("parses view and limit flags", () => {
    const parsed = parseBacklogArgs(["--view", "tasks", "--limit", "5", "--top", "3"]);
    assert.equal(parsed.view, "tasks");
    assert.equal(parsed.limit, 3);
  });

  it("defaults view to tasks when omitted", () => {
    const parsed = parseBacklogArgs([]);
    assert.equal(parsed.view, "tasks");
  });

  it("recognizes status all and include flags", () => {
    const parsed = parseBacklogArgs(["--status", "all", "--include-done", "--include-cancelled"]);
    assert.equal(parsed.statusAll, true);
    assert.equal(parsed.includeDone, true);
    assert.equal(parsed.includeCancelled, true);
    assert.equal(parsed.statuses, undefined);
  });
});

describe("backlog output rendering", () => {
  let workspaceRoot: string;
  let tempHome: string | undefined;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-backlog-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-backlog-"));
    await fs.mkdir(PathHelper.getWorkspaceDir(workspaceRoot), { recursive: true });
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
          priority: 1,
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
          priority: 1,
        },
      ],
      true,
    );
    await repo.insertTasks(
      [
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "web-01-us-01-t01",
          title: "Task A",
          description: "First task",
          status: "not_started",
          storyPoints: 2,
          priority: 1,
        },
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "web-01-us-01-t02",
          title: "Task B",
          description: "Second task",
          status: "not_started",
          storyPoints: 1,
          priority: 2,
        },
      ],
      true,
    );

    await repo.close();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
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

  it("prints scope header and respects view/limit", async () => {
    const logs = await captureLogs(() =>
      BacklogCommands.run([
        "--workspace-root",
        workspaceRoot,
        "--project",
        "WEB",
        "--view",
        "tasks",
        "--limit",
        "1",
      ]),
    );
    const output = logs.join("\n");
    assert.ok(output.includes("Scope:"));
    assert.ok(output.includes("view=tasks"));
    assert.ok(output.includes("web-01-us-01-t01"));
    assert.ok(!output.includes("web-01-us-01-t02"));
    assert.ok(output.includes("╭"));
    assert.ok(output.includes("╰"));
    assert.ok(!output.includes("Epics:"));
    assert.ok(!output.includes("Stories:"));
    assert.ok(!output.includes("Summary (tasks / SP):"));
  });

  it("defaults to tasks view when --view is omitted", async () => {
    const logs = await captureLogs(() =>
      BacklogCommands.run(["--workspace-root", workspaceRoot, "--project", "WEB"]),
    );
    const output = logs.join("\n");
    assert.ok(output.includes("Scope:"));
    assert.ok(output.includes("view=tasks"));
    assert.ok(output.includes("Tasks:"));
    assert.ok(!output.includes("Epics:"));
    assert.ok(!output.includes("Stories:"));
    assert.ok(!output.includes("Summary (tasks / SP):"));
  });

  it("renders task titles and hides descriptions unless verbose", async () => {
    const logs = await captureLogs(() =>
      BacklogCommands.run([
        "--workspace-root",
        workspaceRoot,
        "--project",
        "WEB",
        "--view",
        "tasks",
      ]),
    );
    const output = logs.join("\n");
    assert.ok(output.includes("TITLE"));
    assert.ok(!output.includes("DESC"));
    assert.ok(!output.includes("First task"));
  });

  it("includes task descriptions when verbose", async () => {
    const logs = await captureLogs(() =>
      BacklogCommands.run([
        "--workspace-root",
        workspaceRoot,
        "--project",
        "WEB",
        "--view",
        "tasks",
        "--verbose",
      ]),
    );
    const output = logs.join("\n");
    assert.ok(output.includes("DESC"));
    assert.ok(output.includes("First task"));
  });

  it("emits JSON output with warnings and metadata", async () => {
    const logs = await captureLogs(() =>
      BacklogCommands.run([
        "--workspace-root",
        workspaceRoot,
        "--project",
        "WEB",
        "--json",
      ]),
    );
    const parsed = JSON.parse(logs.join("\n"));
    assert.ok(parsed.summary);
    assert.ok(Array.isArray(parsed.warnings));
    assert.ok(parsed.meta);
    assert.ok(parsed.meta.ordering);
    assert.equal(typeof parsed.meta.ordering.reason, "string");
  });
});
