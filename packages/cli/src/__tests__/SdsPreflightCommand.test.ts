import { describe, it } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SdsPreflightService, WorkspaceResolver } from "@mcoda/core";
import { PathHelper } from "@mcoda/shared";
import { parseSdsPreflightArgs, SdsPreflightCommand } from "../commands/planning/SdsPreflightCommand.js";

describe("sds-preflight argument parsing", () => {
  it("parses root/project/json/quiet and repeated sds paths", () => {
    const root = path.resolve("/tmp/workspace");
    const parsed = parseSdsPreflightArgs([
      "--workspace-root",
      root,
      "--project",
      "proj",
      "--sds",
      "docs/sds.md",
      "--sds",
      "docs/sds.md",
      "--json",
      "--quiet",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
    assert.equal(parsed.json, true);
    assert.equal(parsed.quiet, true);
    assert.equal(parsed.sdsPaths.length, 1);
    assert.equal(parsed.apply, false);
    assert.equal(parsed.commitAppliedChanges, false);
  });

  it("enables apply automatically when commit is requested", () => {
    const parsed = parseSdsPreflightArgs(["--commit", "--commit-message", "msg"]);
    assert.equal(parsed.apply, true);
    assert.equal(parsed.commitAppliedChanges, true);
    assert.equal(parsed.commitMessage, "msg");
  });
});

test("sds-preflight run resolves configured project key and emits JSON output", { concurrency: false }, async () => {
  const originalResolveWorkspace = WorkspaceResolver.resolveWorkspace;
  const originalCreate = SdsPreflightService.create;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-preflight-"));
  const mcodaDir = PathHelper.getWorkspaceDir(workspaceRoot);
  await fs.mkdir(mcodaDir, { recursive: true });

  const logs: string[] = [];
  let capturedProjectKey: string | undefined;
  let capturedSdsPaths: string[] = [];
  let capturedApply: boolean | undefined;
  let capturedCommit: boolean | undefined;

  (WorkspaceResolver as any).resolveWorkspace = async () => ({
    workspaceRoot,
    workspaceId: workspaceRoot,
    id: workspaceRoot,
    legacyWorkspaceIds: [],
    mcodaDir,
    workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
    globalDbPath: PathHelper.getGlobalDbPath(),
    config: { projectKey: "CFG" },
  });
  (SdsPreflightService as any).create = async () => ({
    runPreflight: async (request: {
      projectKey: string;
      sdsPaths?: string[];
      applyToSds?: boolean;
      commitAppliedChanges?: boolean;
    }) => {
      capturedProjectKey = request.projectKey;
      capturedSdsPaths = request.sdsPaths ?? [];
      capturedApply = request.applyToSds;
      capturedCommit = request.commitAppliedChanges;
      return {
        projectKey: request.projectKey,
        generatedAt: new Date().toISOString(),
        readyForPlanning: true,
        qualityStatus: "pass",
        sourceSdsPaths: request.sdsPaths ?? [],
        reportPath: path.join(mcodaDir, "tasks", request.projectKey, "sds-preflight-report.json"),
        openQuestionsPath: path.join(mcodaDir, "tasks", request.projectKey, "sds-open-questions-answers.md"),
        gapAddendumPath: path.join(mcodaDir, "tasks", request.projectKey, "sds-gap-remediation-addendum.md"),
        generatedDocPaths: [],
        questionCount: 0,
        requiredQuestionCount: 0,
        issueCount: 0,
        blockingIssueCount: 0,
        appliedToSds: Boolean(request.applyToSds),
        appliedSdsPaths: [],
        commitHash: undefined,
        issues: [],
        questions: [],
        warnings: [],
      };
    },
    close: async () => {},
  });
  console.log = ((value: unknown) => logs.push(String(value))) as typeof console.log;
  console.warn = (() => {}) as typeof console.warn;
  console.error = (() => {}) as typeof console.error;

  try {
    await SdsPreflightCommand.run([
      "--workspace-root",
      workspaceRoot,
      "--json",
      "--sds",
      path.join(workspaceRoot, "docs", "sds.md"),
    ]);
    assert.equal(capturedProjectKey, "CFG");
    assert.equal(capturedSdsPaths.length, 1);
    assert.equal(capturedApply, false);
    assert.equal(capturedCommit, false);
    assert.ok(logs.length >= 1);
    const payload = JSON.parse(logs[logs.length - 1] ?? "{}") as { projectKey?: string; readyForPlanning?: boolean };
    assert.equal(payload.projectKey, "CFG");
    assert.equal(payload.readyForPlanning, true);
  } finally {
    (WorkspaceResolver as any).resolveWorkspace = originalResolveWorkspace;
    (SdsPreflightService as any).create = originalCreate;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
