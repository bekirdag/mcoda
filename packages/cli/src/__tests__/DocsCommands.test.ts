import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DocsService, WorkspaceResolver } from "@mcoda/core";
import {
  DocsCommands,
  parsePdrArgs,
  parseSdsArgs,
  parseSdsSuggestionsArgs,
} from "../commands/docs/DocsCommands.js";

describe("docs pdr argument parsing", () => {
  it("defaults agentStream to false", () => {
    const parsed = parsePdrArgs(["--rfp-path", "/tmp/rfp.md"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.iterate, false);
    assert.equal(parsed.quality, "build-ready");
    assert.equal(parsed.buildReady, true);
    assert.equal(parsed.resolveOpenQuestions, true);
    assert.equal(parsed.noPlaceholders, true);
    assert.equal(parsed.noMaybes, true);
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
    assert.equal(parsed.quality, "build-ready");
    assert.equal(parsed.buildReady, true);
    assert.equal(parsed.resolveOpenQuestions, true);
    assert.equal(parsed.noPlaceholders, true);
    assert.equal(parsed.noMaybes, true);
    assert.equal(parsed.crossAlign, true);
  });

  it("parses no-telemetry for sds", () => {
    const parsed = parseSdsArgs(["--project", "SDS", "--no-telemetry"]);
    assert.equal(parsed.noTelemetry, true);
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

  it("parses sds suggestions defaults", () => {
    const parsed = parseSdsSuggestionsArgs(["--project", "SDS"]);
    assert.equal(parsed.projectKey, "SDS");
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.maxIterations, 100);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.json, false);
  });

  it("parses sds suggestions advanced flags", () => {
    const root = path.resolve("/tmp/my-workspace");
    const sdsPath = path.resolve("/tmp/my-workspace/docs/sds/sds.md");
    const parsed = parseSdsSuggestionsArgs([
      "--workspace-root",
      root,
      "--project",
      "SDS",
      "--sds-path",
      sdsPath,
      "--review-agent",
      "gemini",
      "--fix-agent",
      "claude",
      "--agent-stream",
      "true",
      "--rate-agents",
      "--max-iterations",
      "9",
      "--json",
      "--dry-run",
      "--quiet",
      "--debug",
      "--no-color",
      "--no-telemetry",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "SDS");
    assert.equal(parsed.sdsPath, sdsPath);
    assert.equal(parsed.reviewAgentName, "gemini");
    assert.equal(parsed.fixAgentName, "claude");
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.rateAgents, true);
    assert.equal(parsed.maxIterations, 9);
    assert.equal(parsed.json, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.quiet, true);
    assert.equal(parsed.debug, true);
    assert.equal(parsed.noColor, true);
    assert.equal(parsed.noTelemetry, true);
  });

  it("clamps sds suggestions max iterations to hard limits", () => {
    const low = parseSdsSuggestionsArgs(["--max-iterations", "-10"]);
    const high = parseSdsSuggestionsArgs(["--max-iterations", "999"]);
    assert.equal(low.maxIterations, 1);
    assert.equal(high.maxIterations, 100);
  });

  it("keeps relative --sds-path for workspace-root based resolution", () => {
    const parsed = parseSdsSuggestionsArgs(["--sds-path", "docs/sds/sds.md"]);
    assert.equal(parsed.sdsPath, "docs/sds/sds.md");
  });

  it("dispatches docs sds suggestions flow in json mode", async () => {
    const originalResolve = WorkspaceResolver.resolveWorkspace;
    const originalCreate = DocsService.create;
    const logs: string[] = [];
    const originalLog = console.log;
    const workspace = {
      workspaceRoot: "/tmp/ws",
      workspaceId: "ws",
      mcodaDir: "/tmp/ws/.mcoda",
      id: "ws",
      legacyWorkspaceIds: [],
      workspaceDbPath: "/tmp/ws/.mcoda/workspace.db",
      globalDbPath: "/tmp/global.db",
    };
    (WorkspaceResolver as any).resolveWorkspace = async () => workspace;
    (DocsService as any).create = async () => ({
      generateSdsSuggestions: async () => ({
        jobId: "job-1",
        commandRunId: "run-1",
        sdsPath: "/tmp/ws/docs/sds/sds.md",
        suggestionsDir: "/tmp/ws/docs/suggestions",
        suggestionFiles: ["/tmp/ws/docs/suggestions/sds_suggestions1.md"],
        reviewerAgentId: "a",
        fixerAgentId: "b",
        iterations: 2,
        finalStatus: "pass",
        warnings: [],
      }),
      close: async () => {},
    });
    // @ts-ignore override
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
    try {
      await DocsCommands.run(["sds", "suggestions", "--project", "ABC", "--json"]);
      const payload = JSON.parse(logs.join("\n"));
      assert.equal(payload.jobId, "job-1");
      assert.equal(payload.finalStatus, "pass");
      assert.equal(payload.iterations, 2);
    } finally {
      (WorkspaceResolver as any).resolveWorkspace = originalResolve;
      (DocsService as any).create = originalCreate;
      // @ts-ignore restore
      console.log = originalLog;
    }
  });
});
