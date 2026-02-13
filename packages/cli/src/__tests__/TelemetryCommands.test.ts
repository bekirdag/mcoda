import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTelemetryArgs, parseTokensArgs, renderTokensTable } from "../commands/telemetry/TelemetryCommands.js";

const captureConsole = (fn: () => void): string => {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return output.join("\n");
};

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

  it("renders cached tokens and duration columns in table output", () => {
    const output = captureConsole(() =>
      renderTokensTable(
        [
          {
            workspace_id: "ws-1",
            command_name: "work-on-tasks",
            calls: 1,
            tokens_prompt: 10,
            tokens_completion: 5,
            tokens_total: 15,
            tokens_cached: 4,
            tokens_cache_read: 2,
            tokens_cache_write: 1,
            duration_ms: 1200,
            cost_estimate: 0.1,
          },
        ],
        ["command"],
      ),
    );
    const header = output.split("\n")[0] ?? "";
    assert.match(header, /TOKENS_CACHED/);
    assert.match(header, /DURATION_MS/);
    assert.match(output, /1200/);
  });
});
