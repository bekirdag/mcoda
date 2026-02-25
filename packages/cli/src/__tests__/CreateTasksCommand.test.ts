import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseCreateTasksArgs, pickCreateTasksProjectKey } from "../commands/planning/CreateTasksCommand.js";

describe("create-tasks argument parsing", () => {
  it("defaults agent stream to false and captures inputs", () => {
    const parsed = parseCreateTasksArgs(["Feature", "More", "--quiet"]);
    assert.equal(parsed.agentStream, false);
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

  it("parses qa override flags", () => {
    const parsed = parseCreateTasksArgs([
      "--qa-profile",
      "cli,chromium",
      "--qa-entry-url",
      "http://localhost:5173",
      "--qa-start-command",
      "npm run dev",
      "--qa-requires",
      "db,seed",
    ]);
    assert.deepEqual(parsed.qaProfiles, ["cli", "chromium"]);
    assert.equal(parsed.qaEntryUrl, "http://localhost:5173");
    assert.equal(parsed.qaStartCommand, "npm run dev");
    assert.deepEqual(parsed.qaRequires, ["db", "seed"]);
  });

  it("honors explicit requested project key over configured defaults", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: "B",
      configuredKey: "A",
      derivedKey: "C",
      existing: [{ key: "A", mtimeMs: 10 }],
    });
    assert.equal(result.projectKey, "B");
    assert.ok(result.warnings.some((message) => message.includes("overriding configured project key")));
  });

  it("uses explicit requested project key even when existing task plans differ", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: "new",
      configuredKey: undefined,
      derivedKey: "derived",
      existing: [
        { key: "old", mtimeMs: 5 },
        { key: "older", mtimeMs: 1 },
      ],
    });
    assert.equal(result.projectKey, "new");
    assert.ok(result.warnings.some((message) => message.includes("Using explicitly requested project key")));
  });

  it("falls back to configured project key when request is omitted", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: undefined,
      configuredKey: "cfg",
      derivedKey: "derived",
      existing: [{ key: "old", mtimeMs: 5 }],
    });
    assert.equal(result.projectKey, "cfg");
  });
});
