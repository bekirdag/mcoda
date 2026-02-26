import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskSufficiencyService, WorkspaceResolver } from "@mcoda/core";
import { PathHelper } from "@mcoda/shared";
import {
  TaskSufficiencyAuditCommand,
  parseTaskSufficiencyAuditArgs,
  pickTaskSufficiencyProjectKey,
} from "../commands/planning/TaskSufficiencyAuditCommand.js";

describe("task-sufficiency-audit argument parsing", () => {
  it("parses explicit flags", () => {
    const root = path.resolve("/tmp/workspace");
    const parsed = parseTaskSufficiencyAuditArgs([
      "--workspace-root",
      root,
      "--project",
      "proj",
      "--max-iterations",
      "6",
      "--max-tasks-per-iteration",
      "12",
      "--min-coverage-ratio",
      "0.9",
      "--dry-run",
      "--json",
    ]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
    assert.equal(parsed.maxIterations, 6);
    assert.equal(parsed.maxTasksPerIteration, 12);
    assert.equal(parsed.minCoverageRatio, 0.9);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.json, true);
  });

  it("accepts max-new-tasks alias", () => {
    const parsed = parseTaskSufficiencyAuditArgs(["--max-new-tasks", "14"]);
    assert.equal(parsed.maxTasksPerIteration, 14);
  });

  it("resolves project key from request first", () => {
    const result = pickTaskSufficiencyProjectKey({
      requestedKey: "requested",
      configuredKey: "configured",
      existing: [{ key: "existing", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    assert.equal(result.projectKey, "requested");
    assert.ok(result.warnings.some((warning) => warning.includes("overriding configured project key")));
  });

  it("falls back to configured project key", () => {
    const result = pickTaskSufficiencyProjectKey({
      requestedKey: undefined,
      configuredKey: "configured",
      existing: [{ key: "existing", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    assert.equal(result.projectKey, "configured");
  });

  it("falls back to first workspace project when request/config are absent", () => {
    const result = pickTaskSufficiencyProjectKey({
      requestedKey: undefined,
      configuredKey: undefined,
      existing: [{ key: "first", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    assert.equal(result.projectKey, "first");
    assert.ok(result.warnings.some((warning) => warning.includes("defaulting to first workspace project")));
  });
});

const withTempHome = async <T>(fn: () => Promise<T>) => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-test-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    return await fn();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("task-sufficiency-audit run resolves configured project key and emits JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-cli-suff-"));
    const mcodaDir = PathHelper.getWorkspaceDir(workspaceRoot);
    await fs.mkdir(mcodaDir, { recursive: true });
    await fs.writeFile(path.join(mcodaDir, "config.json"), JSON.stringify({ projectKey: "CFG" }, null, 2), "utf8");

    const originalResolveWorkspace = WorkspaceResolver.resolveWorkspace;
    const originalCreate = TaskSufficiencyService.create;
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const logs: string[] = [];
    let capturedProjectKey: string | undefined;

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
    (TaskSufficiencyService as any).create = async () => ({
      runAudit: async (request: { projectKey: string }) => {
        capturedProjectKey = request.projectKey;
        return {
          jobId: "job-1",
          commandRunId: "cmd-1",
          projectKey: request.projectKey,
          sourceCommand: undefined,
          satisfied: true,
          dryRun: false,
          totalTasksAdded: 0,
          totalTasksUpdated: 0,
          maxIterations: 5,
          minCoverageRatio: 0.96,
          finalCoverageRatio: 1,
          remainingSectionHeadings: [],
          remainingFolderEntries: [],
          remainingGaps: {
            sections: 0,
            folders: 0,
            total: 0,
          },
          iterations: [],
          reportPath: path.join(mcodaDir, "tasks", request.projectKey, "task-sufficiency-report.json"),
          reportHistoryPath: path.join(mcodaDir, "tasks", request.projectKey, "sufficiency-audit", "snap.json"),
          warnings: [],
        };
      },
      close: async () => {},
    });
    console.log = ((value: unknown) => logs.push(String(value))) as typeof console.log;
    console.warn = (() => {}) as typeof console.warn;
    console.error = (() => {}) as typeof console.error;

    try {
      await TaskSufficiencyAuditCommand.run(["--workspace-root", workspaceRoot, "--json"]);
      assert.equal(capturedProjectKey, "CFG");
      assert.ok(logs.length >= 1);
      const payload = JSON.parse(logs[logs.length - 1] ?? "{}") as { projectKey?: string; satisfied?: boolean };
      assert.equal(payload.projectKey, "CFG");
      assert.equal(payload.satisfied, true);
    } finally {
      (WorkspaceResolver as any).resolveWorkspace = originalResolveWorkspace;
      (TaskSufficiencyService as any).create = originalCreate;
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
