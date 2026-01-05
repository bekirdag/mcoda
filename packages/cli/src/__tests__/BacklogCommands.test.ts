import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseBacklogArgs } from "../commands/backlog/BacklogCommands.js";

describe("backlog argument parsing", () => {
  it("parses workspace root, status filters, and order dependencies", () => {
    const root = path.resolve("/tmp/mcoda");
    const parsed = parseBacklogArgs([
      "--workspace-root",
      root,
      "--status",
      "ready_to_review,blocked",
      "--order",
      "dependencies",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.deepEqual(parsed.statuses, ["ready_to_review", "blocked"]);
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
});
