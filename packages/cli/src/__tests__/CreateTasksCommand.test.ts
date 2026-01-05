import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseCreateTasksArgs } from "../commands/planning/CreateTasksCommand.js";

describe("create-tasks argument parsing", () => {
  it("defaults agent stream to true and captures inputs", () => {
    const parsed = parseCreateTasksArgs(["Feature", "More", "--quiet"]);
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.quiet, true);
    assert.deepEqual(parsed.inputs, ["Feature", "More"]);
  });

  it("parses numeric limits and agent options", () => {
    const root = path.resolve("/tmp/workspace");
    const parsed = parseCreateTasksArgs([
      "--workspace-root",
      root,
      "--project-key",
      "proj",
      "--agent",
      "planner",
      "--agent-stream",
      "false",
      "--max-epics",
      "2",
      "--max-stories-per-epic",
      "3",
      "--max-tasks-per-story",
      "4",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
    assert.equal(parsed.agentName, "planner");
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.maxEpics, 2);
    assert.equal(parsed.maxStoriesPerEpic, 3);
    assert.equal(parsed.maxTasksPerStory, 4);
  });
});
