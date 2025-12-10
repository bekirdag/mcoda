import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseRefineTasksArgs } from "../commands/planning/RefineTasksCommand.js";

describe("refine-tasks argument parsing", () => {
  it("defaults booleans correctly", () => {
    const parsed = parseRefineTasksArgs([]);
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.fromDb, true);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.json, false);
  });

  it("captures repeated tasks and statuses", () => {
    const parsed = parseRefineTasksArgs([
      "--task",
      "alpha",
      "--task=beta",
      "--status",
      "not_started,in_progress",
      "--status=blocked",
    ]);
    assert.deepEqual(parsed.taskKeys, ["alpha", "beta"]);
    assert.deepEqual(parsed.statusFilter, ["not_started", "in_progress", "blocked"]);
  });

  it("parses boolean flags from inline values", () => {
    const parsed = parseRefineTasksArgs(["--agent-stream=false", "--from-db", "false"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.fromDb, false);
  });

  it("captures workspace root, strategy, and numeric flags", () => {
    const root = path.resolve("/tmp/work");
    const parsed = parseRefineTasksArgs([
      "--workspace-root",
      root,
      "--project",
      "demo",
      "--strategy",
      "estimate",
      "--max-tasks",
      "5",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "demo");
    assert.equal(parsed.strategy, "estimate");
    assert.equal(parsed.maxTasks, 5);
  });
});
