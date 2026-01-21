import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseWorkOnTasksArgs } from "../commands/work/WorkOnTasksCommand.js";

describe("work-on-tasks argument parsing", () => {
  it("applies defaults for booleans and statuses", () => {
    const parsed = parseWorkOnTasksArgs([]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.noCommit, false);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.rateAgents, false);
    assert.deepEqual(parsed.statusFilter, ["not_started", "in_progress"]);
  });

  it("captures tasks and explicit statuses", () => {
    const parsed = parseWorkOnTasksArgs([
      "--task",
      "alpha",
      "--task=beta",
      "--status",
      "blocked,in_progress",
    ]);
    assert.deepEqual(parsed.taskKeys, ["alpha", "beta"]);
    assert.deepEqual(parsed.statusFilter, ["blocked", "in_progress"]);
  });

  it("parses numeric flags and agent stream overrides", () => {
    const parsed = parseWorkOnTasksArgs([
      "--agent-stream=false",
      "--limit",
      "5",
      "--parallel",
      "2",
      "--no-commit",
      "--dry-run",
      "--rate-agents",
    ]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.parallel, 2);
    assert.equal(parsed.noCommit, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.rateAgents, true);
  });

  it("captures auto-merge and auto-push overrides", () => {
    const parsed = parseWorkOnTasksArgs([
      "--no-auto-merge",
      "--auto-push=false",
    ]);
    assert.equal(parsed.autoMerge, false);
    assert.equal(parsed.autoPush, false);
  });

  it("accepts workspace alias flags", () => {
    const root = path.resolve("/tmp/demo");
    const parsed = parseWorkOnTasksArgs(["--workspace-root", root, "--project", "proj"]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
  });
});
