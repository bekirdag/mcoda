import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseQaTasksArgs } from "../commands/planning/QaTasksCommand.js";

describe("qa-tasks argument parsing", () => {
  it("defaults to auto mode, ready_to_qa status, and streaming off", () => {
    const parsed = parseQaTasksArgs([]);
    assert.equal(parsed.mode, "auto");
    assert.deepEqual(parsed.statusFilter, ["ready_to_qa"]);
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.createFollowupTasks, "auto");
    assert.equal(parsed.rateAgents, false);
    assert.deepEqual(parsed.cleanIgnorePaths, []);
  });

  it("parses manual flags, statuses, and overrides", () => {
    const parsed = parseQaTasksArgs([
      "--mode",
      "manual",
      "--result",
      "fail",
      "--status",
      "ready_to_qa,in_progress",
      "--limit",
      "3",
      "--agent-stream",
      "false",
      "--profile",
      "ui",
      "--level",
      "integration",
      "--test-command",
      "npm test",
      "--create-followup-tasks",
      "none",
      "--rate-agents",
      "--allow-dirty",
      "true",
      "--notes",
      "needs fix",
      "--evidence-url",
      "https://ci.example",
      "--clean-ignore",
      "logs/,repo_meta.json",
    ]);
    assert.equal(parsed.mode, "manual");
    assert.equal(parsed.result, "fail");
    assert.deepEqual(parsed.statusFilter, ["ready_to_qa"]);
    assert.equal(parsed.limit, 3);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.profileName, "ui");
    assert.equal(parsed.level, "integration");
    assert.equal(parsed.testCommand, "npm test");
    assert.equal(parsed.createFollowupTasks, "none");
    assert.equal(parsed.rateAgents, true);
    assert.equal(parsed.allowDirty, true);
    assert.equal(parsed.notes, "needs fix");
    assert.equal(parsed.evidenceUrl, "https://ci.example");
    assert.deepEqual(parsed.cleanIgnorePaths, ["logs/", "repo_meta.json"]);
  });

  it("captures task selection and workspace metadata", () => {
    const root = path.resolve("/tmp/demo-workspace");
    const parsed = parseQaTasksArgs(["--workspace-root", root, "--project", "proj", "--task", "T1", "--task", "T2"]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
    assert.deepEqual(parsed.taskKeys, ["T1", "T2"]);
  });
});
