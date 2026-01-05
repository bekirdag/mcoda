import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMigrateTasksArgs } from "../commands/planning/MigrateTasksCommand.js";

describe("migrate-tasks argument parsing", () => {
  it("captures refine plans and flags", () => {
    const parsed = parseMigrateTasksArgs([
      "--workspace-root",
      "/tmp/ws",
      "--project-key",
      "proj",
      "--plan-dir",
      "./plans",
      "--refine-plan",
      "a.json",
      "--refine-plan",
      "b.json",
      "--refine-plans-dir",
      "./refines",
      "--force",
      "--quiet",
    ]);
    assert.equal(parsed.workspaceRoot, "/tmp/ws");
    assert.equal(parsed.projectKey, "proj");
    assert.equal(parsed.planDir, "./plans");
    assert.deepEqual(parsed.refinePlans, ["a.json", "b.json"]);
    assert.equal(parsed.refinePlansDir, "./refines");
    assert.equal(parsed.force, true);
    assert.equal(parsed.quiet, true);
  });

  it("flags help when requested", () => {
    const parsed = parseMigrateTasksArgs(["--help"]);
    assert.equal(parsed.help, true);
  });
});
