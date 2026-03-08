import { afterEach, beforeEach, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreateTasksService, WorkspaceResolver } from "@mcoda/core";
import { PathHelper } from "@mcoda/shared";
import {
  CreateTasksCommand,
  createTasksUsage,
  parseCreateTasksArgs,
  pickCreateTasksProjectKey,
} from "../commands/planning/CreateTasksCommand.js";

let tempWorkspaceRoot = "";
let tempMcodaDir = "";
let originalResolveWorkspace: typeof WorkspaceResolver.resolveWorkspace;
let originalCreateTasksCreate: typeof CreateTasksService.create;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

beforeEach(() => {
  originalResolveWorkspace = WorkspaceResolver.resolveWorkspace;
  originalCreateTasksCreate = CreateTasksService.create;
  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
});

afterEach(async () => {
  (WorkspaceResolver as any).resolveWorkspace = originalResolveWorkspace;
  (CreateTasksService as any).create = originalCreateTasksCreate;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  if (tempWorkspaceRoot) {
    await fs.rm(tempWorkspaceRoot, { recursive: true, force: true });
  }
  tempWorkspaceRoot = "";
  tempMcodaDir = "";
});

describe("create-tasks argument parsing", () => {
  it("defaults agent stream to false and captures inputs", () => {
    const parsed = parseCreateTasksArgs(["Feature", "More", "--quiet"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.quiet, true);
    assert.deepEqual(parsed.inputs, ["Feature", "More"]);
  });

  it("parses numeric limits and agent options", () => {
    const root = path.resolve("/tmp/workspace");
    const parsed = parseCreateTasksArgs([
      "--workspace-root",
      root,
      "--project-key",
      "proj",
      "--agent",
      "planner",
      "--agent-stream",
      "false",
      "--force",
      "--max-epics",
      "2",
      "--max-stories-per-epic",
      "3",
      "--max-tasks-per-story",
      "4",
      "--rate-agents",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
    assert.equal(parsed.agentName, "planner");
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.force, true);
    assert.equal(parsed.maxEpics, 2);
    assert.equal(parsed.maxStoriesPerEpic, 3);
    assert.equal(parsed.maxTasksPerStory, 4);
    assert.equal(parsed.rateAgents, true);
  });

  it("parses qa override flags", () => {
    const parsed = parseCreateTasksArgs([
      "--qa-profile",
      "cli,chromium",
      "--qa-entry-url",
      "http://localhost:5173",
      "--qa-start-command",
      "npm run dev",
      "--qa-requires",
      "db,seed",
    ]);
    assert.deepEqual(parsed.qaProfiles, ["cli", "chromium"]);
    assert.equal(parsed.qaEntryUrl, "http://localhost:5173");
    assert.equal(parsed.qaStartCommand, "npm run dev");
    assert.deepEqual(parsed.qaRequires, ["db", "seed"]);
  });

  it("parses explicit SDS preflight writeback flags", () => {
    const parsed = parseCreateTasksArgs([
      "--sds-preflight-apply",
      "--sds-preflight-commit",
      "--sds-preflight-commit-message",
      "mcoda: finalize sds decisions",
    ]);
    assert.equal(parsed.sdsPreflightApplyToSds, true);
    assert.equal(parsed.sdsPreflightCommit, true);
    assert.equal(parsed.sdsPreflightCommitMessage, "mcoda: finalize sds decisions");
  });

  it("parses explicit false for SDS preflight apply and commit flags", () => {
    const parsed = parseCreateTasksArgs(["--sds-preflight-apply=false", "--sds-preflight-commit=false"]);
    assert.equal(parsed.sdsPreflightApplyToSds, false);
    assert.equal(parsed.sdsPreflightCommit, false);
  });

  it("rejects commit without explicit SDS apply", () => {
    assert.throws(
      () => parseCreateTasksArgs(["--sds-preflight-commit"]),
      /--sds-preflight-commit requires --sds-preflight-apply/i,
    );
  });

  it("rejects commit message without commit", () => {
    assert.throws(
      () => parseCreateTasksArgs(["--sds-preflight-apply", "--sds-preflight-commit-message", "msg"]),
      /--sds-preflight-commit-message requires --sds-preflight-commit/i,
    );
  });

  it("documents sidecar mode as the default create-tasks preflight behavior", () => {
    assert.match(createTasksUsage, /Default: SDS preflight runs in sidecar mode/i);
    assert.match(createTasksUsage, /--sds-preflight-apply/);
    assert.match(createTasksUsage, /--sds-preflight-commit only together with --sds-preflight-apply/i);
  });

  it("parses unknown epic service policy flag", () => {
    const parsed = parseCreateTasksArgs(["--unknown-epic-service-policy", "fail"]);
    assert.equal(parsed.unknownEpicServicePolicy, "fail");
  });

  it("parses unknown epic service policy with equals syntax", () => {
    const parsed = parseCreateTasksArgs(["--unknown-epic-service-policy=auto-remediate"]);
    assert.equal(parsed.unknownEpicServicePolicy, "auto-remediate");
  });

  it("rejects invalid unknown epic service policy flag values", () => {
    assert.throws(
      () => parseCreateTasksArgs(["--unknown-epic-service-policy", "invalid"]),
      /Invalid --unknown-epic-service-policy value/i,
    );
  });

  it("honors explicit requested project key over configured defaults", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: "B",
      configuredKey: "A",
      derivedKey: "C",
      existing: [{ key: "A", mtimeMs: 10 }],
    });
    assert.equal(result.projectKey, "B");
    assert.ok(result.warnings.some((message) => message.includes("overriding configured project key")));
  });

  it("uses explicit requested project key even when existing task plans differ", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: "new",
      configuredKey: undefined,
      derivedKey: "derived",
      existing: [
        { key: "old", mtimeMs: 5 },
        { key: "older", mtimeMs: 1 },
      ],
    });
    assert.equal(result.projectKey, "new");
    assert.ok(result.warnings.some((message) => message.includes("Using explicitly requested project key")));
  });

  it("falls back to configured project key when request is omitted", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: undefined,
      configuredKey: "cfg",
      derivedKey: "derived",
      existing: [{ key: "old", mtimeMs: 5 }],
    });
    assert.equal(result.projectKey, "cfg");
  });

  it("uses derived project key by default even when latest existing task plan differs", () => {
    const result = pickCreateTasksProjectKey({
      requestedKey: undefined,
      configuredKey: undefined,
      derivedKey: "derived",
      existing: [
        { key: "other", mtimeMs: 100 },
        { key: "older", mtimeMs: 10 },
      ],
    });
    assert.equal(result.projectKey, "derived");
    assert.ok(result.warnings.some((message) => message.includes("avoid accidental cross-project reuse")));
  });
});

test("create-tasks run forwards explicit SDS apply and commit options", async () => {
  tempWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-create-cli-"));
  tempMcodaDir = PathHelper.getWorkspaceDir(tempWorkspaceRoot);
  await fs.mkdir(tempMcodaDir, { recursive: true });

  let capturedOptions: Record<string, unknown> | undefined;
  const logs: string[] = [];

  (WorkspaceResolver as any).resolveWorkspace = async () => ({
    workspaceRoot: tempWorkspaceRoot,
    workspaceId: tempWorkspaceRoot,
    id: tempWorkspaceRoot,
    legacyWorkspaceIds: [],
    mcodaDir: tempMcodaDir,
    workspaceDbPath: PathHelper.getWorkspaceDbPath(tempWorkspaceRoot),
    globalDbPath: PathHelper.getGlobalDbPath(),
    config: {},
  });
  (CreateTasksService as any).create = async () => ({
    createTasks: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return {
        jobId: "job-1",
        commandRunId: "cmd-1",
        epics: [],
        stories: [],
        tasks: [],
        dependencies: [],
      };
    },
    close: async () => {},
  });
  console.log = ((value: unknown) => logs.push(String(value))) as typeof console.log;
  console.warn = (() => {}) as typeof console.warn;
  console.error = (() => {}) as typeof console.error;

  await CreateTasksCommand.run([
    "--workspace-root",
    tempWorkspaceRoot,
    "--project",
    "WEB",
    "--sds-preflight-apply",
    "--sds-preflight-commit",
    "--sds-preflight-commit-message",
    "mcoda: finalize sds decisions",
  ]);

  assert.equal(capturedOptions?.projectKey, "WEB");
  assert.equal(capturedOptions?.sdsPreflightApplyToSds, true);
  assert.equal(capturedOptions?.sdsPreflightCommit, true);
  assert.equal(capturedOptions?.sdsPreflightCommitMessage, "mcoda: finalize sds decisions");
  assert.ok(logs.some((entry) => entry.includes("Created 0 epics, 0 stories, 0 tasks, 0 dependencies.")));
});
