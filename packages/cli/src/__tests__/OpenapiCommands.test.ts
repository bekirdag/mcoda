import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { OpenApiJobError } from "@mcoda/core";
import { formatOpenapiErrorOutput, parseOpenapiArgs } from "../commands/openapi/OpenapiCommands.js";

describe("openapi-from-docs argument parsing", () => {
  it("defaults agentStream to false", () => {
    const parsed = parseOpenapiArgs([]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.validateOnly, false);
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

  it("captures project when provided", () => {
    const parsed = parseOpenapiArgs(["--project", "demo"]);
    assert.equal(parsed.project, "demo");
  });

  it("captures force, dry-run, and validate-only flags", () => {
    const parsed = parseOpenapiArgs(["--force", "--dry-run", "--validate-only"]);
    assert.equal(parsed.force, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.validateOnly, true);
  });
});

describe("openapi-from-docs error output", () => {
  it("formats timeout errors with resume hint", () => {
    const error = new OpenApiJobError("timeout", "OpenAPI job job-1 timed out after 1s.", "job-1");
    const output = formatOpenapiErrorOutput(error);
    assert.ok(output.some((line) => line.includes("ERROR:")));
    assert.ok(output.some((line) => line.includes("MCODA_OPENAPI_TIMEOUT_SECONDS")));
    assert.ok(output.some((line) => line.includes("mcoda job resume job-1")));
  });

  it("formats cancelled errors with resume hint", () => {
    const error = new OpenApiJobError("cancelled", "OpenAPI job job-2 was cancelled.", "job-2");
    const output = formatOpenapiErrorOutput(error);
    assert.ok(output.some((line) => line.includes("ERROR:")));
    assert.ok(output.some((line) => line.includes("cancellation")));
    assert.ok(output.some((line) => line.includes("mcoda job resume job-2")));
  });
});
