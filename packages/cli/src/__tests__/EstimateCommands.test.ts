import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEstimateArgs } from "../commands/estimate/EstimateCommands.js";

describe("estimate argument parsing", () => {
  it("parses velocity window and aliases", () => {
    const parsed = parseEstimateArgs(["--velocity-window", "20", "--window", "10"]);
    // last one wins
    assert.equal(parsed.velocityWindow, 10);
  });

  it("parses sp-per-hour overrides", () => {
    const parsed = parseEstimateArgs([
      "--sp-per-hour",
      "12",
      "--sp-per-hour-review",
      "8",
      "--sp-per-hour-qa",
      "6",
    ]);
    assert.equal(parsed.spPerHour, 12);
    assert.equal(parsed.spPerHourReview, 8);
    assert.equal(parsed.spPerHourQa, 6);
  });

  it("captures quiet/no-color/no-telemetry flags", () => {
    const parsed = parseEstimateArgs(["--quiet", "--no-color", "--no-telemetry"]);
    assert.equal(parsed.quiet, true);
    assert.equal(parsed.noColor, true);
    assert.equal(parsed.noTelemetry, true);
  });

  it("parses workspace and scope filters", () => {
    const parsed = parseEstimateArgs([
      "--workspace",
      "/tmp/w",
      "--project",
      "PROJ",
      "--epic",
      "E1",
      "--story",
      "S1",
      "--assignee",
      "user",
    ]);
    assert.equal(parsed.workspaceRoot?.endsWith("/tmp/w"), true);
    assert.equal(parsed.project, "PROJ");
    assert.equal(parsed.epic, "E1");
    assert.equal(parsed.story, "S1");
    assert.equal(parsed.assignee, "user");
  });
});
