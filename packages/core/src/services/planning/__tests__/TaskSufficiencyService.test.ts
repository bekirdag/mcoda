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
    const report = JSON.parse(reportRaw) as {
      projectKey: string;
      iterations: Array<{ unresolvedBundleCount?: number }>;
      unresolvedBundles?: unknown[];
    };
    assert.equal(report.projectKey, "proj");
    assert.ok(Array.isArray(report.iterations));
    assert.deepEqual(result.unresolvedBundles, []);
    assert.deepEqual(report.unresolvedBundles, []);

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

test("task-sufficiency-audit ignores managed mcoda preflight blocks in SDS sources", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "<!-- mcoda:sds-preflight:start -->",
      "## Open Questions (Resolved)",
      "- Resolved: No unresolved questions remain for this SDS file in this preflight run.",
      "## Resolved Decisions (mcoda preflight)",
      "- Planning rule: each resolved decision must map to implementation and QA verification work.",
      "## Folder Tree",
      "```text",
      ".",
      "└── apps/admin",
      "```",
      "<!-- mcoda:sds-preflight:end -->",
      "## Gatekeeper Runtime",
      "Folder tree:",
      "- packages/gatekeeper/src/worker.ts",
    ].join("\n"),
    "utf8",
  );
  await seedBacklog("proj", {
    taskTitle: "Document deployment plan",
    taskDescription: "Capture notes for future runtime work.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      dryRun: true,
      maxIterations: 1,
      maxTasksPerIteration: 4,
      minCoverageRatio: 0.99,
    });
    assert.ok(
      !result.remainingSectionHeadings.some((heading) => /open questions|resolved decisions|folder tree/i.test(heading)),
      `managed preflight headings leaked into sufficiency audit: ${JSON.stringify(result.remainingSectionHeadings)}`,
    );
    assert.ok(result.remainingSectionHeadings.some((heading) => /gatekeeper runtime/i.test(heading)));
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit ignores negated non-goal path mentions", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Gatekeeper Runtime",
      "No `apps/web`, `apps/admin`, or `services/api` subtree is part of the v1 target layout.",
      "Folder tree:",
      "- packages/gatekeeper/src/worker.ts",
    ].join("\n"),
    "utf8",
  );
  await seedBacklog("proj", {
    taskTitle: "Document gatekeeper notes",
    taskDescription: "Capture gatekeeper runtime notes only.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      dryRun: true,
      maxIterations: 1,
      maxTasksPerIteration: 4,
      minCoverageRatio: 0.99,
    });
    assert.ok(
      !result.remainingFolderEntries.some((entry) => /apps\/admin|apps\/web|services\/api/i.test(entry)),
      `negated non-goal paths leaked into sufficiency audit: ${JSON.stringify(result.remainingFolderEntries)}`,
    );
    assert.ok(result.remainingFolderEntries.some((entry) => /packages\/gatekeeper\/src\/worker\.ts/i.test(entry)));
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit ignores source-doc references when runtime tree paths exist", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "Source hierarchy:",
      "- docs/rfp.md",
      "- docs/pdr/ep.md",
      "## Contract Runtime",
      "Folder tree:",
      "contracts/",
      "├── src/",
      "│   └── ListingRegistry.sol",
      "└── script/",
      "    └── DeployContracts.s.sol",
    ].join("\n"),
    "utf8",
  );
  await seedBacklog("proj", {
    taskTitle: "Document runtime notes",
    taskDescription: "Capture contract runtime notes only.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      dryRun: true,
      maxIterations: 1,
      maxTasksPerIteration: 4,
      minCoverageRatio: 0.99,
    });
    assert.ok(
      !result.remainingFolderEntries.some((entry) => /docs\/rfp\.md|docs\/pdr\/ep\.md/i.test(entry)),
      `source-doc references leaked into folder coverage: ${JSON.stringify(result.remainingFolderEntries)}`,
    );
    assert.ok(result.remainingFolderEntries.some((entry) => /contracts\/src|contracts\/script/i.test(entry)));
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

test("task-sufficiency-audit prunes umbrella numbered headings when child sections exist", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## 3. Core Decisions",
      "## 3.1 Gatekeeper Runtime",
      "Folder tree:",
      "- packages/gatekeeper/src/worker.ts",
    ].join("\n"),
    "utf8",
  );
  await seedBacklog("proj", {
    taskTitle: "Document rollout notes",
    taskDescription: "Capture deployment planning notes only.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      dryRun: true,
      maxIterations: 1,
      maxTasksPerIteration: 4,
      minCoverageRatio: 0.99,
    });
    assert.ok(
      !result.remainingSectionHeadings.some((heading) => /core decisions/i.test(heading)),
      `umbrella parent heading should be pruned: ${JSON.stringify(result.remainingSectionHeadings)}`,
    );
    assert.ok(result.remainingSectionHeadings.some((heading) => /gatekeeper runtime/i.test(heading)));
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit avoids arbitrary implementation targets for broad section-only gaps", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## 7.2 System Resilience Envelope",
      "Folder tree:",
      "- docs/data-storage-architecture.md",
    ].join("\n"),
    "utf8",
  );
  const { projectId } = await seedBacklog("proj", {
    taskTitle: "Document release notes",
    taskDescription: "Capture release notes only.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      maxIterations: 1,
      maxTasksPerIteration: 6,
      minCoverageRatio: 0.99,
    });
    assert.equal(result.satisfied, false);
    assert.equal(result.totalTasksAdded, 0);
    assert.ok(
      result.remainingSectionHeadings.some((heading) => /system resilience envelope/i.test(heading)),
      `expected unresolved section heading, got ${JSON.stringify(result.remainingSectionHeadings)}`,
    );
    assert.ok(
      result.warnings.some((warning) => /no concrete implementation targets were inferred/i.test(warning)),
      `expected unresolved-target warning, got ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.unresolvedBundles.length > 0);
    assert.ok(
      result.unresolvedBundles.some(
        (bundle) =>
          bundle.kind === "section" &&
          bundle.values.some((value) => /system resilience envelope/i.test(value)),
      ),
      `expected unresolved section bundle, got ${JSON.stringify(result.unresolvedBundles)}`,
    );
    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as {
      unresolvedBundles?: Array<{ values?: string[] }>;
      iterations?: Array<{ unresolvedBundleCount?: number }>;
    };
    assert.ok(Array.isArray(report.unresolvedBundles));
    assert.ok(
      report.unresolvedBundles?.some((bundle) =>
        (bundle.values ?? []).some((value) => /system resilience envelope/i.test(value)),
      ),
      `expected unresolved bundle in report, got ${reportRaw}`,
    );
    assert.equal(result.iterations[0]?.unresolvedBundleCount, result.unresolvedBundles.length);
    assert.equal(report.iterations?.[0]?.unresolvedBundleCount, result.unresolvedBundles.length);

    const repo = await WorkspaceRepository.create(workspaceRoot);
    try {
      const rows = await repo.getDb().all<{ metadata_json?: string | null }[]>(
        `SELECT metadata_json FROM tasks WHERE project_id = ? ORDER BY key`,
        projectId,
      );
      const sufficiencyRows = rows
        .map((row) => (row.metadata_json ? JSON.parse(row.metadata_json) : {}))
        .filter((metadata) => metadata?.sufficiencyAudit?.source === "task-sufficiency-audit");
      assert.equal(sufficiencyRows.length, 0);
    } finally {
      await repo.close();
    }
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit leaves section-only gaps unresolved when only unrelated folder targets are actionable", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## 7.2 System Resilience Envelope",
      "Folder tree:",
      "- scripts/promote-standby.sh",
      "- docs/data-storage-architecture.md",
    ].join("\n"),
    "utf8",
  );
  const { projectId } = await seedBacklog("proj", {
    taskTitle: "Document release notes",
    taskDescription: "Capture release notes only.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      maxIterations: 1,
      maxTasksPerIteration: 6,
      minCoverageRatio: 0.99,
    });
    assert.equal(result.satisfied, false);
    assert.ok(
      result.remainingSectionHeadings.some((heading) => /system resilience envelope/i.test(heading)),
      `expected unresolved section heading, got ${JSON.stringify(result.remainingSectionHeadings)}`,
    );
    assert.ok(
      result.warnings.some((warning) => /no concrete implementation targets were inferred/i.test(warning)),
      `expected unresolved-target warning, got ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.unresolvedBundles.length > 0);
    assert.ok(
      result.unresolvedBundles.some(
        (bundle) =>
          bundle.kind === "section" &&
          bundle.values.some((value) => /system resilience envelope/i.test(value)),
      ),
      `expected unresolved section bundle, got ${JSON.stringify(result.unresolvedBundles)}`,
    );
    const repo = await WorkspaceRepository.create(workspaceRoot);
    try {
      const rows = await repo.getDb().all<
        { title: string; description: string; metadata_json?: string | null }[]
      >(`SELECT title, description, metadata_json FROM tasks WHERE project_id = ? ORDER BY key`, projectId);
      const sufficiencyRows = rows
        .map((row) => ({
          title: row.title,
          description: row.description,
          metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
        }))
        .filter((row) => row.metadata?.sufficiencyAudit?.source === "task-sufficiency-audit");
      const sectionRows = sufficiencyRows
        .filter((row) => row.metadata?.sufficiencyAudit?.kind !== "folder");

      assert.ok(
        sufficiencyRows.length > 0,
        "expected at least one actionable folder remediation task to be generated",
      );
      assert.equal(sectionRows.length, 0);
      assert.ok(
        sufficiencyRows.every((row) => (row.metadata?.sufficiencyAudit?.implementationTargets ?? []).length > 0),
        `all sufficiency tasks must have concrete targets: ${JSON.stringify(sufficiencyRows.map((row) => row.metadata))}`,
      );
      assert.ok(
        sufficiencyRows.every((row) => !/No direct file path was recovered/i.test(row.description)),
        `placeholder wording should be removed: ${JSON.stringify(sufficiencyRows.map((row) => row.description))}`,
      );
    } finally {
      await repo.close();
    }
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

test("task-sufficiency-audit turns mandatory verification and recovery sections into executable tasks", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Quality Gates",
      "## Verification Matrix",
      "## Rollback",
      "## Compromise Recovery",
      "## BSC RPC Providers",
      "## Sanctions Source",
      "```text",
      ".",
      "├── packages/gatekeeper/src/provider-registry.ts",
      "├── packages/gatekeeper/src/sanctions-source.ts",
      "├── packages/gatekeeper/src/runtime-policy.ts",
      "├── tests/acceptance/replay.spec.ts",
      "└── ops/scripts/rollback-gatekeeper.sh",
      "```",
    ].join("\n"),
    "utf8",
  );
  const { projectId } = await seedBacklog("proj", {
    taskTitle: "Capture planning notes",
    taskDescription: "Document future work without implementation detail.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      maxIterations: 2,
      maxTasksPerIteration: 12,
      minCoverageRatio: 0.99,
    });
    assert.ok(result.totalTasksAdded > 0);
    assert.ok(!result.remainingSectionHeadings.some((heading) => /quality gates/i.test(heading)));
    assert.ok(!result.remainingSectionHeadings.some((heading) => /verification matrix/i.test(heading)));
    assert.ok(!result.remainingSectionHeadings.some((heading) => /rollback/i.test(heading)));
    assert.ok(!result.remainingSectionHeadings.some((heading) => /compromise recovery/i.test(heading)));
    assert.ok(!result.remainingSectionHeadings.some((heading) => /bsc rpc providers/i.test(heading)));
    assert.ok(!result.remainingSectionHeadings.some((heading) => /sanctions source/i.test(heading)));

    const repo = await WorkspaceRepository.create(workspaceRoot);
    try {
      const rows = await repo.getDb().all<
        { title: string; description: string; metadata_json?: string | null }[]
      >(`SELECT title, description, metadata_json FROM tasks WHERE project_id = ? ORDER BY key`, projectId);
      const sufficiencyRows = rows
        .map((row) => {
          try {
            return {
              title: row.title,
              description: row.description,
              metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
            };
          } catch {
            return { title: row.title, description: row.description, metadata: {} };
          }
        })
        .filter((row) => row.metadata?.sufficiencyAudit?.source === "task-sufficiency-audit");

      const implementationTargets = sufficiencyRows.flatMap(
        (row) => row.metadata?.sufficiencyAudit?.implementationTargets ?? [],
      );
      assert.ok(implementationTargets.includes("packages/gatekeeper/src/provider-registry.ts"));
      assert.ok(implementationTargets.includes("packages/gatekeeper/src/sanctions-source.ts"));
      assert.ok(implementationTargets.includes("ops/scripts/rollback-gatekeeper.sh"));
      assert.ok(implementationTargets.includes("tests/acceptance/replay.spec.ts"));
      assert.ok(
        sufficiencyRows.every((row) => !/No direct file path was recovered/i.test(row.description)),
        `placeholder wording should be removed: ${JSON.stringify(sufficiencyRows.map((row) => row.description))}`,
      );
    } finally {
      await repo.close();
    }
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit turns EP-style box-tree gaps into targeted remediation tasks", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Deployment Waves",
      "## Gatekeeper Runtime",
      "## Oracle Registry",
      "```text",
      ".",
      "├── foundry.toml",
      "├── contracts/",
      "│   ├── script/",
      "│   │   ├── DeployContracts.s.sol",
      "│   │   └── ConfigurePolicies.s.sol",
      "│   └── src/",
      "│       └── IOraclePolicyRegistry.sol",
      "├── packages/",
      "│   ├── gatekeeper/",
      "│   │   ├── package.json",
      "│   │   └── src/",
      "│   │       └── worker.ts",
      "│   └── terminal-client/",
      "│       └── src/",
      "│           └── main.ts",
      "└── ops/",
      "    └── systemd/",
      "        └── gatekeeper.service",
      "```",
      "Wave 0 - contracts",
      "Wave 1 - gatekeeper",
      "Wave 2 - terminal client and ops",
    ].join("\n"),
    "utf8",
  );
  const { projectId } = await seedBacklog("proj", {
    taskTitle: "Document deployment plan",
    taskDescription: "Capture notes for future protocol deployment work.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      maxIterations: 2,
      maxTasksPerIteration: 12,
      minCoverageRatio: 0.99,
    });
    assert.ok(result.totalTasksAdded > 0);

    const repo = await WorkspaceRepository.create(workspaceRoot);
    try {
      const rows = await repo.getDb().all<
        { title: string; description: string; metadata_json?: string | null }[]
      >(`SELECT title, description, metadata_json FROM tasks WHERE project_id = ? ORDER BY key`, projectId);
      const sufficiencyRows = rows
        .map((row) => {
          try {
            return {
              title: row.title,
              description: row.description,
              metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
            };
          } catch {
            return { title: row.title, description: row.description, metadata: {} };
          }
        })
        .filter((row) => row.metadata?.sufficiencyAudit?.source === "task-sufficiency-audit");

      assert.ok(sufficiencyRows.length > 0);
      assert.ok(
        sufficiencyRows.every(
          (row) =>
            !row.title.includes("Implement SDS section") &&
            !row.title.includes("Implement SDS path") &&
            !row.title.includes("Implement SDS bundle"),
        ),
      );
      assert.ok(
        sufficiencyRows.every((row) => row.description.includes("## Concrete Implementation Targets")),
      );
      const implementationTargets = sufficiencyRows.flatMap(
        (row) => row.metadata?.sufficiencyAudit?.implementationTargets ?? [],
      );
      const gatekeeperSectionTargets = sufficiencyRows
        .filter(
          (row) =>
            row.metadata?.sufficiencyAudit?.kind !== "folder" &&
            (row.metadata?.sufficiencyAudit?.anchors ?? []).some((anchor: string) => /gatekeeper runtime/i.test(anchor)),
        )
        .flatMap((row) => row.metadata?.sufficiencyAudit?.implementationTargets ?? []);
      assert.ok(
        implementationTargets.some((target: string) => target === "contracts/script/DeployContracts.s.sol"),
        `expected contract script target, got ${JSON.stringify(implementationTargets)}`,
      );
      assert.ok(
        gatekeeperSectionTargets.some((target: string) => target === "packages/gatekeeper/src/worker.ts"),
        `expected gatekeeper target, got ${JSON.stringify(gatekeeperSectionTargets)}`,
      );
      assert.ok(
        !gatekeeperSectionTargets.includes("packages/gatekeeper/package.json"),
        `manifest target should not win over runtime files: ${JSON.stringify(gatekeeperSectionTargets)}`,
      );
      assert.ok(
        !gatekeeperSectionTargets.includes("ops/systemd/gatekeeper.service"),
        `service artifact target should not win over runtime files: ${JSON.stringify(gatekeeperSectionTargets)}`,
      );
      assert.ok(
        sufficiencyRows.some((row) => row.description.includes("contracts/script/DeployContracts.s.sol")),
      );
    } finally {
      await repo.close();
    }
  } finally {
    await service.close();
  }
});

test("task-sufficiency-audit keeps custom implementation roots actionable", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Ledger Runtime",
      "## Operator Console",
      "```text",
      ".",
      "├── engines/",
      "│   └── ledger/",
      "│       └── src/",
      "│           └── main.rs",
      "├── consoles/",
      "│   └── operator/",
      "│       └── app/",
      "│           └── main.py",
      "└── docs/",
      "    └── architecture.md",
      "```",
    ].join("\n"),
    "utf8",
  );
  const { projectId } = await seedBacklog("proj", {
    taskTitle: "Capture implementation notes",
    taskDescription: "Document future implementation work only.",
  });
  const service = await TaskSufficiencyService.create(workspace);
  try {
    const result = await service.runAudit({
      workspace,
      projectKey: "proj",
      maxIterations: 2,
      maxTasksPerIteration: 12,
      minCoverageRatio: 0.99,
    });
    assert.ok(result.totalTasksAdded > 0);

    const repo = await WorkspaceRepository.create(workspaceRoot);
    try {
      const rows = await repo.getDb().all<
        { title: string; description: string; metadata_json?: string | null }[]
      >(`SELECT title, description, metadata_json FROM tasks WHERE project_id = ? ORDER BY key`, projectId);
      const sufficiencyRows = rows
        .map((row) => {
          try {
            return {
              title: row.title,
              description: row.description,
              metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
            };
          } catch {
            return { title: row.title, description: row.description, metadata: {} };
          }
        })
        .filter((row) => row.metadata?.sufficiencyAudit?.source === "task-sufficiency-audit");

      const implementationTargets = sufficiencyRows.flatMap(
        (row) => row.metadata?.sufficiencyAudit?.implementationTargets ?? [],
      );
      assert.ok(implementationTargets.includes("engines/ledger/src/main.rs"));
      assert.ok(implementationTargets.includes("consoles/operator/app/main.py"));
      assert.ok(sufficiencyRows.some((row) => row.description.includes("engines/ledger/src/main.rs")));
      assert.ok(sufficiencyRows.some((row) => row.description.includes("consoles/operator/app/main.py")));
      assert.ok(sufficiencyRows.every((row) => !row.title.includes("docs/")));
    } finally {
      await repo.close();
    }
  } finally {
    await service.close();
  }
});
