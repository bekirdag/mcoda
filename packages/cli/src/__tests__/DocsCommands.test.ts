import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parsePdrArgs, parseSdsArgs } from "../commands/docs/DocsCommands.js";

describe("docs pdr argument parsing", () => {
  it("defaults agentStream to false", () => {
    const parsed = parsePdrArgs(["--rfp-path", "/tmp/rfp.md"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.iterate, false);
    assert.equal(parsed.quality, undefined);
    assert.equal(parsed.buildReady, false);
    assert.equal(parsed.resolveOpenQuestions, false);
    assert.equal(parsed.noPlaceholders, false);
    assert.equal(parsed.noMaybes, false);
    assert.equal(parsed.crossAlign, true);
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

  it("parses iterative flags for pdr", () => {
    const parsed = parsePdrArgs([
      "--rfp-path",
      "/tmp/rfp.md",
      "--iterate",
      "--quality",
      "build-ready",
      "--resolve-open-questions",
      "--no-placeholders",
      "--no-maybes",
      "--cross-align",
    ]);
    assert.equal(parsed.iterate, true);
    assert.equal(parsed.quality, "build-ready");
    assert.equal(parsed.buildReady, true);
    assert.equal(parsed.resolveOpenQuestions, true);
    assert.equal(parsed.noPlaceholders, true);
    assert.equal(parsed.noMaybes, true);
    assert.equal(parsed.crossAlign, true);
  });

  it("parses agent overrides for pdr and sds", () => {
    const pdr = parsePdrArgs(["--rfp-path", "/tmp/rfp.md", "--agent", "docgen-agent"]);
    assert.equal(pdr.agentName, "docgen-agent");

    const sds = parseSdsArgs(["--project", "SDS", "--agent", "docgen-agent"]);
    assert.equal(sds.agentName, "docgen-agent");
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

  it("defaults sds agentStream to false", () => {
    const parsed = parseSdsArgs(["--project", "SDS"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.iterate, false);
    assert.equal(parsed.quality, undefined);
    assert.equal(parsed.buildReady, false);
    assert.equal(parsed.resolveOpenQuestions, false);
    assert.equal(parsed.noPlaceholders, false);
    assert.equal(parsed.noMaybes, false);
    assert.equal(parsed.crossAlign, true);
  });

  it("parses iterative flags for sds", () => {
    const parsed = parseSdsArgs([
      "--project",
      "SDS",
      "--iterate",
      "--quality=build-ready",
      "--resolve-open-questions",
      "--no-placeholders",
      "--no-maybes",
      "--cross-align",
    ]);
    assert.equal(parsed.iterate, true);
    assert.equal(parsed.quality, "build-ready");
    assert.equal(parsed.buildReady, true);
    assert.equal(parsed.resolveOpenQuestions, true);
    assert.equal(parsed.noPlaceholders, true);
    assert.equal(parsed.noMaybes, true);
    assert.equal(parsed.crossAlign, true);
  });
});
