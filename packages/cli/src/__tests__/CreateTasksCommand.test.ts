import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseCreateTasksArgs, pickCreateTasksProjectKey } from "../commands/planning/CreateTasksCommand.js";

describe("create-tasks argument parsing", () => {
  it("defaults agent stream to true and captures inputs", () => {
    const parsed = parseCreateTasksArgs(["Feature", "More", "--quiet"]);
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.rateAgents, false);
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
      "--force",
      "--max-epics",
      "2",
      "--max-stories-per-epic",
      "3",
      "--max-tasks-per-story",
      "4",
      "--rate-agents",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
    assert.equal(parsed.agentName, "planner");
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.force, true);
    assert.equal(parsed.maxEpics, 2);
    assert.equal(parsed.maxStoriesPerEpic, 3);
    assert.equal(parsed.maxTasksPerStory, 4);
    assert.equal(parsed.rateAgents, true);
  });

  it("prefers configured project key over requested or derived", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: "B",
      configuredKey: "A",
      derivedKey: "C",
      existing: [{ key: "A", mtimeMs: 10 }],
    });
    assert.equal(result.projectKey, "A");
    assert.ok(result.warnings.some((message) => message.includes("configured project key")));
  });

  it("reuses existing project key when requested does not match", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: "new",
      configuredKey: undefined,
      derivedKey: "derived",
      existing: [
        { key: "old", mtimeMs: 5 },
        { key: "older", mtimeMs: 1 },
      ],
    });
    assert.equal(result.projectKey, "old");
    assert.ok(result.warnings.some((message) => message.includes("existing project key")));
  });
});
