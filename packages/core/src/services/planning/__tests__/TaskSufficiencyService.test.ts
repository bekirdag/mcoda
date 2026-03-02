import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";
import { TaskSufficiencyService } from "../TaskSufficiencyService.js";

let workspaceRoot = "";
let workspace: WorkspaceResolution;
let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;

const seedBacklog = async (
  projectKey: string,
  options: { taskTitle?: string; taskDescription?: string } = {},
): Promise<{ projectId: string; initialStoryId: string }> => {
  const repo = await WorkspaceRepository.create(workspaceRoot);
  try {
    const project = await repo.createProjectIfMissing({
      key: projectKey,
      name: projectKey,
      description: `Project ${projectKey}`,
    });
    const [epic] = await repo.insertEpics([
      {
        projectId: project.id,
        key: `${projectKey}-01`,
        title: "Foundation",
        description: "Initial implementation foundation.",
        priority: 1,
      },
    ]);
    const [story] = await repo.insertStories([
      {
        projectId: project.id,
        epicId: epic.id,
        key: `${epic.key}-us-01`,
        title: "Initial story",
        description: "Initial story description",
        acceptanceCriteria: "- baseline behavior",
        priority: 1,
      },
    ]);
    await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: `${story.key}-t01`,
        title: options.taskTitle ?? "Implement Historical Dataset Ingestion pipeline",
        description:
          options.taskDescription ??
          "Build ingestion components for historical dataset processing under services/ingestion/src/index.ts.",
        type: "feature",
        status: "not_started",
        storyPoints: 3,
        priority: 1,
      },
    ]);
    await repo.updateStoryPointsTotal(story.id, 3);
    await repo.updateEpicStoryPointsTotal(epic.id, 3);
    return { projectId: project.id, initialStoryId: story.id };
  } finally {
    await repo.close();
  }
};

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-task-suff-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-task-suff-"));
  workspace = {
    workspaceRoot,
    workspaceId: workspaceRoot,
    id: workspaceRoot,
    legacyWorkspaceIds: [],
    mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
    workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
    globalDbPath: PathHelper.getGlobalDbPath(),
  };
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
});

afterEach(async () => {
  if (workspaceRoot) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalProfile;
  }
});

test("task-sufficiency-audit adds focused backlog tasks for uncovered SDS signals and writes report", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Revision History",
      "## Table of Contents",
      "## 1.1 Purpose",
      "## Historical Dataset Ingestion",
      "## Realtime Explorer Playback",
      "Folder tree:",
      "- services/ingestion/src/index.ts",
      "- apps/explorer/src/main.tsx",
      "- mnt/githubActions/piriatlas/object-store/runs/...",
      "- BCE/CE",
    ].join("\n"),
    "utf8",
  );
  const { projectId, initialStoryId } = await seedBacklog("proj");
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      maxIterations: 4,
      maxTasksPerIteration: 10,
      minCoverageRatio: 0.99,
    });

    assert.equal(result.projectKey, "proj");
    assert.ok(result.totalTasksAdded > 0);
    assert.equal(result.totalTasksUpdated, 0);
    assert.ok(result.finalCoverageRatio >= 0);
    assert.equal(
      result.remainingGaps.total,
      result.remainingSectionHeadings.length + result.remainingFolderEntries.length,
    );
    assert.ok(result.reportPath.endsWith(path.join("tasks", "proj", "task-sufficiency-report.json")));
    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as { projectKey: string; iterations: unknown[] };
    assert.equal(report.projectKey, "proj");
    assert.ok(Array.isArray(report.iterations));

    const repo = await WorkspaceRepository.create(workspaceRoot);
    try {
      const rows = await repo.getDb().all<any[]>(
        `SELECT key, title, user_story_id, metadata_json FROM tasks WHERE project_id = ? ORDER BY key`,
        projectId,
      );
      const sufficiencyRows = rows.filter((row) => {
        try {
          const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
          return metadata?.sufficiencyAudit?.source === "task-sufficiency-audit";
        } catch {
          return false;
        }
      });
      assert.ok(sufficiencyRows.length > 0);
      assert.ok(
        sufficiencyRows.every((row) => row.user_story_id !== initialStoryId),
        "sufficiency tasks should not mutate the existing product story",
      );
      assert.ok(
        sufficiencyRows.every(
          (row) =>
            typeof row.title === "string" &&
            !row.title.includes("Cover SDS section") &&
            !row.title.includes("Materialize SDS folder entry"),
        ),
        "sufficiency tasks should use focused remediation titles",
      );
      assert.ok(
        sufficiencyRows.every((row) => !String(row.title).toLowerCase().includes("revision history")),
        "non-implementation headings must be filtered out",
      );
    } finally {
      await repo.close();
    }
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit dry-run does not mutate backlog", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Historical Dataset Ingestion",
      "## Operational Governance Controls",
      "Folder tree:",
      "- services/ingestion/src/index.ts",
      "- ops/governance/src/policy.ts",
    ].join("\n"),
    "utf8",
  );
  const { projectId } = await seedBacklog("proj");
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const beforeRepo = await WorkspaceRepository.create(workspaceRoot);
    const beforeCount = await beforeRepo.getDb().get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?`,
      projectId,
    );
    await beforeRepo.close();

    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      dryRun: true,
      maxIterations: 3,
      maxTasksPerIteration: 8,
      minCoverageRatio: 0.99,
    });
    assert.equal(result.totalTasksAdded, 0);
    assert.equal(result.totalTasksUpdated, 0);
    assert.equal(result.dryRun, true);

    const afterRepo = await WorkspaceRepository.create(workspaceRoot);
    const afterCount = await afterRepo.getDb().get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?`,
      projectId,
    );
    await afterRepo.close();
    assert.equal(afterCount?.c, beforeCount?.c);
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit defaults minCoverageRatio to full coverage", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## 9.3 Uncertainty Visualisation",
      "Folder tree:",
      "- services/ingestion/src/index.ts",
    ].join("\n"),
    "utf8",
  );
  await seedBacklog("proj");
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      dryRun: true,
      maxIterations: 1,
      maxTasksPerIteration: 2,
    });
    assert.equal(result.minCoverageRatio, 1);
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit fails when no actionable SDS signals can be extracted", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Revision History",
      "## Table of Contents",
      "## Glossary",
      "## References",
    ].join("\n"),
    "utf8",
  );
  await seedBacklog("proj");
  const service = await TaskSufficiencyService.create(workspace);
  try {
    await assert.rejects(
      () =>
        service.runAudit({
          workspace,
          projectKey: "proj",
          dryRun: true,
          maxIterations: 1,
          maxTasksPerIteration: 2,
        }),
      /could not derive actionable SDS implementation signals/i,
    );
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit does not over-credit long headings from sparse token overlap", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Confidence Propagation Across Counterfactual Branches",
      "Folder tree:",
      "- services/inference/src/counterfactual/propagation.ts",
    ].join("\n"),
    "utf8",
  );
  await seedBacklog("proj", {
    taskTitle: "Implement confidence branch checks",
    taskDescription: "Track confidence values across branch runs.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      dryRun: true,
      maxIterations: 1,
      maxTasksPerIteration: 2,
    });
    assert.equal(result.satisfied, false);
    assert.ok(
      result.remainingSectionHeadings.some((heading) =>
        heading.toLowerCase().includes("confidence propagation across counterfactual branches"),
      ),
    );
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit bundles related gap anchors into a single remediation task", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Data Ingestion Validation Controls",
      "## Data Ingestion Retry Strategy",
      "## Data Ingestion Backfill Window",
      "Folder tree:",
      "- services/ingestion/src/pipeline.ts",
    ].join("\n"),
    "utf8",
  );
  const { projectId } = await seedBacklog("proj");
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      maxIterations: 1,
      maxTasksPerIteration: 10,
      minCoverageRatio: 0.99,
    });
    assert.ok(result.totalTasksAdded > 0);
    const repo = await WorkspaceRepository.create(workspaceRoot);
    try {
      const rows = await repo.getDb().all<{ metadata_json?: string | null }[]>(
        `SELECT metadata_json FROM tasks WHERE project_id = ?`,
        projectId,
      );
      const bundled = rows
        .map((row) => {
          try {
            return row.metadata_json ? JSON.parse(row.metadata_json) : null;
          } catch {
            return null;
          }
        })
        .filter((metadata) => metadata?.sufficiencyAudit?.source === "task-sufficiency-audit")
        .filter((metadata) => Array.isArray(metadata?.sufficiencyAudit?.anchors))
        .filter((metadata) => metadata.sufficiencyAudit.anchors.length > 1);
      assert.ok(bundled.length >= 1, "expected at least one bundled remediation task");
    } finally {
      await repo.close();
    }
  } finally {
    await service.close();
  }
});
