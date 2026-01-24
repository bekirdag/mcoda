import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseRefineTasksArgs } from "../commands/planning/RefineTasksCommand.js";

describe("refine-tasks argument parsing", () => {
  it("defaults booleans correctly", () => {
    const parsed = parseRefineTasksArgs([]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.fromDb, true);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.apply, false);
    assert.equal(parsed.resume, false);
    assert.equal(parsed.runAll, false);
    assert.equal(parsed.json, false);
    assert.equal(parsed.rateAgents, false);
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
    assert.deepEqual(parsed.statusFilter, ["not_started", "in_progress"]);
  });

  it("parses boolean flags from inline values", () => {
    const parsed = parseRefineTasksArgs(["--agent-stream=false", "--from-db", "false", "--rate-agents"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.fromDb, false);
    assert.equal(parsed.rateAgents, true);
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

  it("parses apply/resume/run-all controls", () => {
    const parsed = parseRefineTasksArgs(["--apply", "--resume", "--run-all", "--batch-size", "50", "--max-batches", "3"]);
    assert.equal(parsed.apply, true);
    assert.equal(parsed.resume, true);
    assert.equal(parsed.runAll, true);
    assert.equal(parsed.batchSize, 50);
    assert.equal(parsed.maxBatches, 3);
  });
});
