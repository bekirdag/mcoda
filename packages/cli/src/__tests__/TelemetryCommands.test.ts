import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTelemetryArgs, parseTokensArgs } from "../commands/telemetry/TelemetryCommands.js";

describe("telemetry CLI parsing", () => {
  it("parses tokens args with explicit group-by and format", () => {
    const parsed = parseTokensArgs([
      "--project",
      "PROJ",
      "--agent",
      "agent-1",
      "--group-by",
      "project,day,model",
      "--format",
      "json",
    ]);
    assert.equal(parsed.project, "PROJ");
    assert.equal(parsed.agent, "agent-1");
    assert.deepEqual(parsed.groupBy, ["project", "day", "model"]);
    assert.equal(parsed.format, "json");
  });

  it("defaults tokens args when omitted", () => {
    const parsed = parseTokensArgs([]);
    assert.deepEqual(parsed.groupBy, ["project", "command", "agent"]);
    assert.equal(parsed.format, "table");
  });

  it("parses telemetry opt-out strict flag", () => {
    const parsed = parseTelemetryArgs(["opt-out", "--strict", "--format", "json"]);
    assert.equal(parsed.subcommand, "opt-out");
    assert.equal(parsed.strict, true);
    assert.equal(parsed.format, "json");
  });
});
