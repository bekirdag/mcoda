import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { EstimateCommands, parseEstimateArgs } from "../commands/estimate/EstimateCommands.js";

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

describe("estimate argument parsing", () => {
  it("parses velocity window and aliases", () => {
    const parsed = parseEstimateArgs(["--velocity-window", "20", "--window", "10"]);
    // last one wins
    assert.equal(parsed.velocityWindow, 10);
  });

  it("parses sp-per-hour overrides", () => {
    const parsed = parseEstimateArgs([
      "--sp-per-hour",
      "12",
      "--sp-per-hour-implementation",
      "9",
      "--sp-per-hour-review",
      "8",
      "--sp-per-hour-qa",
      "6",
    ]);
    assert.equal(parsed.spPerHour, 12);
    assert.equal(parsed.spPerHourImplementation, 9);
    assert.equal(parsed.spPerHourReview, 8);
    assert.equal(parsed.spPerHourQa, 6);
  });

  it("captures quiet/no-color/no-telemetry flags", () => {
    const parsed = parseEstimateArgs(["--quiet", "--no-color", "--no-telemetry"]);
    assert.equal(parsed.quiet, true);
    assert.equal(parsed.noColor, true);
    assert.equal(parsed.noTelemetry, true);
  });

  it("parses workspace and scope filters", () => {
    const expectedRoot = path.resolve("/tmp/w");
    const parsed = parseEstimateArgs([
      "--workspace",
      "/tmp/w",
      "--project",
      "PROJ",
      "--epic",
      "E1",
      "--story",
      "S1",
      "--assignee",
      "user",
    ]);
    assert.equal(parsed.workspaceRoot, expectedRoot);
    assert.equal(parsed.project, "PROJ");
    assert.equal(parsed.epic, "E1");
    assert.equal(parsed.story, "S1");
    assert.equal(parsed.assignee, "user");
  });
});

describe("estimate output rendering", () => {
  let workspaceRoot: string;
  let tempHome: string | undefined;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-estimate-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-estimate-"));
    await fs.mkdir(PathHelper.getWorkspaceDir(workspaceRoot), { recursive: true });
    const dbPath = PathHelper.getWorkspaceDbPath(workspaceRoot);
    const connection = await Connection.open(dbPath);
    await WorkspaceMigrations.run(connection.db);
    const repo = new WorkspaceRepository(connection.db, connection);

    const project = await repo.createProjectIfMissing({ key: "PROJ", name: "Project" });
    const [epic] = await repo.insertEpics(
      [
        {
          projectId: project.id,
          key: "proj-01",
          title: "Epic",
          description: "Epic description",
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
          key: "proj-01-us-01",
          title: "Story",
          description: "Story description",
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
          key: "proj-01-us-01-t01",
          title: "Impl task",
          description: "Implementation work",
          status: "not_started",
          storyPoints: 10,
        },
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "proj-01-us-01-t02",
          title: "Review task",
          description: "Review work",
          status: "ready_to_code_review",
          storyPoints: 4,
        },
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "proj-01-us-01-t03",
          title: "QA task",
          description: "QA work",
          status: "ready_to_qa",
          storyPoints: 6,
        },
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: "proj-01-us-01-t04",
          title: "Done task",
          description: "Done work",
          status: "completed",
          storyPoints: 3,
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

  it("prints DONE/TOTAL lines and assumptions", async () => {
    const logs = await captureLogs(() =>
      EstimateCommands.run([
        "--workspace-root",
        workspaceRoot,
        "--project",
        "PROJ",
        "--sp-per-hour",
        "10",
      ]),
    );
    const output = logs.join("\n");
    assert.ok(output.includes("Done"));
    assert.ok(output.includes("Total"));
    assert.ok(output.includes("Velocity samples (window 10): impl=0, review=0, qa=0"));
    assert.ok(output.includes("Assumptions: lane work runs in parallel; total hours uses the longest lane."));
  });

  it("notes when empirical mode falls back to config", async () => {
    const logs = await captureLogs(() =>
      EstimateCommands.run([
        "--workspace-root",
        workspaceRoot,
        "--project",
        "PROJ",
        "--sp-per-hour",
        "10",
        "--velocity-mode",
        "empirical",
      ]),
    );
    const output = logs.join("\n");
    assert.ok(output.includes("Velocity source: config (requested empirical; no empirical samples, using config)"));
  });

  it("prints local and relative ETA values", async () => {
    const fixedNow = Date.parse("2024-01-01T00:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const logs = await captureLogs(() =>
        EstimateCommands.run([
          "--workspace-root",
          workspaceRoot,
          "--project",
          "PROJ",
          "--sp-per-hour",
          "10",
        ]),
      );
      const output = logs.join("\n");
      assert.ok(output.includes("2024-01-01T01:00:00.000Z"));
      assert.match(output, /local \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      assert.ok(output.includes("+1h"));
    } finally {
      Date.now = originalNow;
    }
  });

  it("emits JSON output when requested", async () => {
    const logs = await captureLogs(() =>
      EstimateCommands.run([
        "--workspace-root",
        workspaceRoot,
        "--project",
        "PROJ",
        "--sp-per-hour",
        "10",
        "--json",
      ]),
    );
    const parsed = JSON.parse(logs.join("\n"));
    assert.ok(parsed.backlogTotals);
    assert.ok(parsed.durationsHours);
    assert.ok(parsed.etas);
  });
});
