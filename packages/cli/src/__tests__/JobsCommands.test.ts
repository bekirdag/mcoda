import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { parseJobArgs } from "../commands/jobs/JobsCommands.js";

describe("job CLI parsing", () => {
  it("parses list filters and json flag", () => {
    const parsed = parseJobArgs(["list", "--project", "PROJ", "--status", "running", "--type", "work", "--since", "1h", "--limit", "5", "--json"]);
    assert.equal(parsed.subcommand, "list");
    assert.equal(parsed.project, "PROJ");
    assert.equal(parsed.status, "running");
    assert.equal(parsed.type, "work");
    assert.equal(parsed.since, "1h");
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.json, true);
  });

  it("accepts positional job id for status/logs/watch", () => {
    const parsed = parseJobArgs(["status", "job-123"]);
    assert.equal(parsed.subcommand, "status");
    assert.equal(parsed.jobId, "job-123");
  });

  it("parses watch interval and no-logs with workspace root", () => {
    const root = path.resolve("/tmp/demo");
    const parsed = parseJobArgs(["watch", "job-5", "--interval", "2", "--no-logs", "--workspace-root", root]);
    assert.equal(parsed.subcommand, "watch");
    assert.equal(parsed.jobId, "job-5");
    assert.equal(parsed.intervalSeconds, 2);
    assert.equal(parsed.noLogs, true);
    assert.equal(parsed.workspaceRoot, root);
  });

  it("captures resume agent flag", () => {
    const parsed = parseJobArgs(["resume", "job-9", "--agent", "codex"]);
    assert.equal(parsed.subcommand, "resume");
    assert.equal(parsed.jobId, "job-9");
    assert.equal(parsed.agent, "codex");
  });

  it("parses logs follow and since", () => {
    const parsed = parseJobArgs(["logs", "job-10", "--since", "2025-01-01T00:00:00Z", "--follow"]);
    assert.equal(parsed.subcommand, "logs");
    assert.equal(parsed.jobId, "job-10");
    assert.equal(parsed.since, "2025-01-01T00:00:00Z");
    assert.equal(parsed.follow, true);
  });
});

