import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseOpenapiArgs } from "../commands/openapi/OpenapiCommands.js";

describe("openapi-from-docs argument parsing", () => {
  it("defaults agentStream to false", () => {
    const parsed = parseOpenapiArgs([]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, false);
  });

  it("parses agentStream false", () => {
    const parsed = parseOpenapiArgs(["--agent-stream", "false", "--rate-agents"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, true);
  });

  it("parses agentStream with inline value", () => {
    const parsed = parseOpenapiArgs(["--agent-stream=false"]);
    assert.equal(parsed.agentStream, false);
  });

  it("captures workspace root when provided", () => {
    const root = path.resolve("/tmp/my-workspace");
    const parsed = parseOpenapiArgs(["--workspace-root", root]);
    assert.equal(parsed.workspaceRoot, root);
  });

  it("captures force, dry-run, and validate-only flags", () => {
    const parsed = parseOpenapiArgs(["--force", "--dry-run", "--validate-only"]);
    assert.equal(parsed.force, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.validateOnly, true);
  });
});
