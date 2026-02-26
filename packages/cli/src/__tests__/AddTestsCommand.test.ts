import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAddTestsArgs, pickAddTestsProjectKey } from "../commands/work/AddTestsCommand.js";

describe("add-tests argument parsing", () => {
  it("parses defaults", () => {
    const parsed = parseAddTestsArgs([]);
    assert.deepEqual(parsed.statusFilter, ["not_started", "in_progress", "changes_requested"]);
    assert.equal(parsed.noCommit, false);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.json, false);
  });

  it("parses task and status filters", () => {
    const parsed = parseAddTestsArgs([
      "--project",
      "proj",
      "--task",
      "a",
      "--task=b",
      "--status",
      "in_progress,changes_requested",
      "--limit",
      "3",
      "--base-branch",
      "main",
      "--json",
    ]);
    assert.equal(parsed.projectKey, "proj");
    assert.deepEqual(parsed.taskKeys, ["a", "b"]);
    assert.deepEqual(parsed.statusFilter, ["in_progress", "changes_requested"]);
    assert.equal(parsed.limit, 3);
    assert.equal(parsed.baseBranch, "main");
    assert.equal(parsed.json, true);
  });

  it("resolves project key fallback order", () => {
    const explicit = pickAddTestsProjectKey({
      requestedKey: "explicit",
      configuredKey: "configured",
      existing: [{ key: "first" }],
    });
    assert.equal(explicit.projectKey, "explicit");

    const configured = pickAddTestsProjectKey({
      requestedKey: undefined,
      configuredKey: "configured",
      existing: [{ key: "first" }],
    });
    assert.equal(configured.projectKey, "configured");

    const first = pickAddTestsProjectKey({
      requestedKey: undefined,
      configuredKey: undefined,
      existing: [{ key: "first" }],
    });
    assert.equal(first.projectKey, "first");
  });
});

