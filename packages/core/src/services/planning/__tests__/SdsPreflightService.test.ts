import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";
import { SdsPreflightService } from "../SdsPreflightService.js";

let workspaceRoot = "";
let workspace: WorkspaceResolution;
let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-preflight-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-preflight-"));
  workspace = {
    workspaceRoot,
    workspaceId: workspaceRoot,
    mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
    id: workspaceRoot,
    legacyWorkspaceIds: [],
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

test("sds-preflight generates report, Q&A, and gap addendum artifacts", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Open Questions",
      "- Should we start as modular monolith or split services early?",
      "## Folder Tree",
      "- services/api/src/index.ts",
      "- apps/web/src/main.tsx",
    ].join("\n"),
    "utf8",
  );

  const service = await SdsPreflightService.create(workspace);
  try {
    const result = await service.runPreflight({
      workspace,
      projectKey: "proj",
      sdsPaths: [sdsPath],
      writeArtifacts: true,
    });
    assert.equal(result.projectKey, "proj");
    assert.ok(result.sourceSdsPaths.length >= 1);
    assert.ok(result.reportPath.endsWith(path.join("tasks", "proj", "sds-preflight-report.json")));
    assert.ok(result.openQuestionsPath.endsWith(path.join("tasks", "proj", "sds-open-questions-answers.md")));
    assert.ok(result.gapAddendumPath.endsWith(path.join("tasks", "proj", "sds-gap-remediation-addendum.md")));
    const qaDoc = await fs.readFile(result.openQuestionsPath, "utf8");
    const addendumDoc = await fs.readFile(result.gapAddendumPath, "utf8");
    assert.ok(qaDoc.includes("Question:"));
    assert.ok(qaDoc.includes("Answer:"));
    assert.ok(qaDoc.toLowerCase().includes("modular monolith"));
    assert.ok(qaDoc.includes("services/api"));
    assert.ok(addendumDoc.includes("SDS Gap Remediation Addendum"));
    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as { projectKey: string; questionCount: number; issueCount: number };
    assert.equal(report.projectKey, "proj");
    assert.ok(report.questionCount >= 1);
    assert.ok(report.issueCount >= 1);
  } finally {
    await service.close();
  }
});

test("sds-preflight apply mode writes resolved decisions back to SDS", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Open Questions",
      "- Should we include confidence propagation in API responses?",
      "## Folder Tree",
      "- services/api/src/index.ts",
      "- services/scoring/src/pipeline.ts",
    ].join("\n"),
    "utf8",
  );

  const service = await SdsPreflightService.create(workspace);
  try {
    const result = await service.runPreflight({
      workspace,
      projectKey: "proj",
      sdsPaths: [sdsPath],
      writeArtifacts: false,
      applyToSds: true,
    });
    assert.equal(result.appliedToSds, true);
    assert.ok(result.appliedSdsPaths.includes(sdsPath));
    const updated = await fs.readFile(sdsPath, "utf8");
    assert.ok(updated.includes("# Software Design Specification\n\n<!-- mcoda:sds-preflight:start -->"));
    assert.ok(updated.includes("## Open Questions (Resolved)"));
    assert.ok(updated.includes("Resolved Decisions (mcoda preflight)"));
    assert.ok(updated.includes("## Folder Tree"));
    assert.ok(updated.includes("```text"));
    assert.ok(updated.includes("## Technology Stack"));
    assert.ok(updated.includes("## Policy and Cache Consent"));
    assert.ok(updated.includes("## Operations and Deployment"));
    assert.ok(updated.includes("## External Integrations and Adapter Contracts"));
    assert.ok(updated.includes("services/scoring/src/pipeline.ts"));
    assert.ok(updated.includes("mcoda:sds-preflight:start"));
    assert.ok(updated.includes("Resolved:"));
  } finally {
    await service.close();
  }
});

test("sds-preflight errors when no SDS source is discoverable", async () => {
  const service = await SdsPreflightService.create(workspace);
  try {
    await assert.rejects(
      () =>
        service.runPreflight({
          workspace,
          projectKey: "proj",
          sdsPaths: [],
          writeArtifacts: false,
        }),
      /requires an SDS document/i,
    );
  } finally {
    await service.close();
  }
});

test("sds-preflight marks planning as blocked when SDS gate execution fails", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Architecture",
      "- services/api/src/index.ts",
    ].join("\n"),
    "utf8",
  );

  const service = await SdsPreflightService.create(workspace);
  const originalGetGateRunners = (service as unknown as { getGateRunners: () => unknown }).getGateRunners;
  (service as unknown as { getGateRunners: () => unknown }).getGateRunners = () => [
    async () => {
      throw new Error("synthetic gate failure");
    },
  ];

  try {
    const result = await service.runPreflight({
      workspace,
      projectKey: "proj",
      sdsPaths: [sdsPath],
      writeArtifacts: false,
    });
    assert.equal(result.readyForPlanning, false);
    assert.equal(result.qualityStatus, "fail");
    assert.ok(result.blockingIssueCount >= 1);
    assert.ok(result.warnings.some((warning) => warning.includes("synthetic gate failure")));
  } finally {
    (service as unknown as { getGateRunners: () => unknown }).getGateRunners = originalGetGateRunners;
    await service.close();
  }
});
