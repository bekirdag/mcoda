import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parsePdrArgs, parseSdsArgs } from "../commands/docs/DocsCommands.js";

describe("docs pdr argument parsing", () => {
  it("defaults agentStream to true", () => {
    const parsed = parsePdrArgs(["--rfp-path", "/tmp/rfp.md"]);
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.rateAgents, false);
  });

  it("parses agentStream false", () => {
    const parsed = parsePdrArgs(["--rfp-path", "/tmp/rfp.md", "--agent-stream", "false", "--rate-agents"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, true);
  });

  it("captures workspace root when provided", () => {
    const root = path.resolve("/tmp/my-workspace");
    const parsed = parsePdrArgs(["--rfp-path", "docs/rfp.md", "--workspace-root", root]);
    assert.equal(parsed.workspaceRoot, root);
  });

  it("parses json and dry-run flags", () => {
    const parsed = parsePdrArgs(["--rfp-path", "/tmp/rfp.md", "--json", "--dry-run"]);
    assert.equal(parsed.json, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.debug, false);
  });

  it("parses fast mode for pdr", () => {
    const parsed = parsePdrArgs(["--rfp-path", "/tmp/rfp.md", "--fast"]);
    assert.equal(parsed.fast, true);
  });

  it("parses sds defaults and flags", () => {
    const parsed = parseSdsArgs([
      "--project",
      "SDS",
      "--agent-stream",
      "false",
      "--force",
      "--resume",
      "job-1",
      "--rate-agents",
    ]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.force, true);
    assert.equal(parsed.resumeJobId, "job-1");
    assert.equal(parsed.rateAgents, true);
  });

  it("parses fast mode for sds", () => {
    const parsed = parseSdsArgs(["--project", "SDS", "--fast"]);
    assert.equal(parsed.fast, true);
  });

  it("defaults sds agentStream to true", () => {
    const parsed = parseSdsArgs(["--project", "SDS"]);
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.rateAgents, false);
  });
});
