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
  const originalSds = [
    "# Software Design Specification",
    "## Open Questions",
    "- Should we start as modular monolith or split services early?",
    "## Folder Tree",
    "- services/api/src/index.ts",
    "- apps/web/src/main.tsx",
  ].join("\n");
  await fs.writeFile(
    sdsPath,
    originalSds,
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
    assert.equal(result.appliedToSds, false);
    assert.deepEqual(result.appliedSdsPaths, []);
    assert.ok(result.sourceSdsPaths.length >= 1);
    assert.ok(result.reportPath.endsWith(path.join("tasks", "proj", "sds-preflight-report.json")));
    assert.ok(result.openQuestionsPath.endsWith(path.join("tasks", "proj", "sds-open-questions-answers.md")));
    assert.ok(result.gapAddendumPath.endsWith(path.join("tasks", "proj", "sds-gap-remediation-addendum.md")));
    const qaDoc = await fs.readFile(result.openQuestionsPath, "utf8");
    const addendumDoc = await fs.readFile(result.gapAddendumPath, "utf8");
    const currentSds = await fs.readFile(sdsPath, "utf8");
    assert.ok(qaDoc.includes("Question:"));
    assert.ok(qaDoc.includes("Answer:"));
    assert.ok(qaDoc.toLowerCase().includes("modular monolith"));
    assert.ok(qaDoc.includes("services/api"));
    assert.ok(addendumDoc.includes("SDS Gap Remediation Addendum"));
    assert.equal(currentSds, originalSds);
    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as { projectKey: string; questionCount: number; issueCount: number };
    assert.equal(report.projectKey, "proj");
    assert.ok(report.questionCount >= 1);
    assert.ok(report.issueCount >= 1);
  } finally {
    await service.close();
  }
});

test("sds-preflight warns when commit is requested without apply mode", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  const originalSds = [
    "# Software Design Specification",
    "## Open Questions",
    "- Should we include confidence propagation in API responses?",
    "## Folder Tree",
    "- services/api/src/index.ts",
  ].join("\n");
  await fs.writeFile(sdsPath, originalSds, "utf8");

  const service = await SdsPreflightService.create(workspace);
  try {
    const result = await service.runPreflight({
      workspace,
      projectKey: "proj",
      sdsPaths: [sdsPath],
      writeArtifacts: false,
      commitAppliedChanges: true,
    });
    assert.equal(result.appliedToSds, false);
    assert.deepEqual(result.appliedSdsPaths, []);
    assert.ok(
      result.warnings.some((warning) => /commit was requested without applyToSds/i.test(warning)),
      `expected commit-without-apply warning, got ${JSON.stringify(result.warnings)}`,
    );
    const currentSds = await fs.readFile(sdsPath, "utf8");
    assert.equal(currentSds, originalSds);
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
    assert.ok(updated.includes("## Planning Decisions (mcoda preflight)"));
    assert.ok(updated.includes("Decision Summary (mcoda preflight)"));
    assert.ok(updated.includes("## Folder Tree"));
    assert.ok(updated.includes("```text"));
    assert.ok(updated.includes("## Technology Stack"));
    assert.ok(updated.includes("## Policy and Cache Consent"));
    assert.ok(updated.includes("## Operations and Deployment"));
    assert.ok(updated.includes("## External Integrations and Adapter Contracts"));
    assert.ok(updated.includes("services/scoring/src/pipeline.ts"));
    assert.ok(updated.includes("# implementation surfaces"));
    assert.ok(updated.includes("mcoda:sds-preflight:start"));
    assert.ok(updated.includes("Resolved:"));
  } finally {
    await service.close();
  }
});

test("sds-preflight uses stack-agnostic fallback folder tree examples", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Open Questions",
      "- Which repository surfaces should be created first?",
      "## Architecture Overview",
      "Describe the target repository without assuming a framework-specific layout.",
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
    const updated = await fs.readFile(sdsPath, "utf8");
    assert.ok(updated.includes("docs/architecture/"));
    assert.ok(updated.includes("modules/core/"));
    assert.ok(updated.includes("interfaces/public/"));
    assert.ok(updated.includes("data/migrations/"));
    assert.ok(updated.includes("tools/release/"));
    assert.ok(!updated.includes("apps/web/"));
    assert.ok(!updated.includes("services/api/"));
    assert.ok(!updated.includes("packages/shared/"));
    assert.ok(!updated.includes("contracts/  # on-chain contracts and deploy scripts"));
  } finally {
    await service.close();
  }
});

test("sds-preflight does not invent a chosen stack baseline when the source is silent", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Open Questions",
      "- Which runtime and persistence layers should this project choose?",
      "## Architecture Overview",
      "The project structure is still being decided.",
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
    const updated = await fs.readFile(sdsPath, "utf8");
    assert.ok(updated.includes("## Technology Stack"));
    assert.ok(updated.includes("Source docs do not yet make the technology stack explicit."));
    assert.ok(updated.includes("Preflight must not invent a chosen stack baseline when the source is silent."));
    assert.ok(!updated.includes("Chosen stack baseline:"));
  } finally {
    await service.close();
  }
});

test("sds-preflight sidecar artifacts stay stack- and repo-shape agnostic when the source is silent", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Open Questions",
      "- Which repository surfaces and runtime stack should this project use?",
      "## Architecture Overview",
      "The project shape and runtime technologies are still undecided.",
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
    const qaDoc = await fs.readFile(result.openQuestionsPath, "utf8");
    const addendumDoc = await fs.readFile(result.gapAddendumPath, "utf8");
    const combined = `${qaDoc}\n${addendumDoc}`;
    assert.ok(combined.includes("technology stack"));
    assert.ok(!combined.includes("Chosen stack baseline:"));
    assert.ok(!combined.includes("apps/web/"));
    assert.ok(!combined.includes("services/api/"));
    assert.ok(!combined.includes("packages/shared/"));
    assert.ok(!combined.includes("contracts/  # on-chain contracts and deploy scripts"));
  } finally {
    await service.close();
  }
});

test("sds-preflight summarizes observed technologies without presenting them as generated defaults", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Technology Stack",
      "Chosen stack: Go runtime, PostgreSQL persistence, and Docker packaging.",
      "## Deployment",
      "Operators deploy Docker images and run Go services against PostgreSQL.",
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
    const updated = await fs.readFile(sdsPath, "utf8");
    assert.ok(updated.includes("Observed source-backed technology signals: Go, PostgreSQL, Docker."));
    assert.ok(updated.includes("do not invent default stack choices during preflight"));
    assert.ok(!updated.includes("Chosen stack baseline: Go"));
  } finally {
    await service.close();
  }
});

test("sds-preflight does not reclassify weak architecture docs from managed preflight blocks", async () => {
  const sdsDir = path.join(workspaceRoot, "docs", "sds");
  await fs.mkdir(sdsDir, { recursive: true });
  const sdsPath = path.join(sdsDir, "ep.md");
  const architecturePath = path.join(workspaceRoot, "docs", "data_storage_architecture.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Architecture Overview",
      "## Folder Tree",
      "- services/api/src/index.ts",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    architecturePath,
    [
      "# Data Storage Architecture",
      "<!-- mcoda:sds-preflight:start -->",
      "## Planning Decisions (mcoda preflight)",
      "- Decision 1: Explicit implementation decision recorded in managed preflight output.",
      "## Folder Tree",
      "- data/migrations",
      "## Technology Stack",
      "- Chosen stack baseline: Go.",
      "## Decision Summary (mcoda preflight)",
      "- Decision baseline: preflight converts planning ambiguities into explicit implementation guidance.",
      "<!-- mcoda:sds-preflight:end -->",
      "## Purpose",
      "This remains an architecture note, not the canonical SDS.",
    ].join("\n"),
    "utf8",
  );

  const service = await SdsPreflightService.create(workspace);
  try {
    const result = await service.runPreflight({
      workspace,
      projectKey: "proj",
      inputPaths: ["docs"],
      writeArtifacts: false,
    });
    assert.deepEqual(result.sourceSdsPaths, [sdsPath]);
  } finally {
    await service.close();
  }
});

test("sds-preflight keeps explicit SDS scope and stays clean on rerun", async () => {
  const sdsDir = path.join(workspaceRoot, "docs", "sds");
  const pdrDir = path.join(workspaceRoot, "docs", "pdr");
  await fs.mkdir(sdsDir, { recursive: true });
  await fs.mkdir(pdrDir, { recursive: true });
  const sdsPath = path.join(sdsDir, "ep.md");
  const pdrPath = path.join(pdrDir, "ep.md");
  const architecturePath = path.join(workspaceRoot, "docs", "data_storage_architecture.md");

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
  const originalPdr = [
    "# Product Design Review: EP",
    "## Repository Layout",
    "│   └── sds/                   # software design specifications",
  ].join("\n");
  await fs.writeFile(pdrPath, originalPdr, "utf8");
  const originalArchitecture = [
    "# Data Storage Architecture",
    "Purpose: explain pin and delete flows.",
  ].join("\n");
  await fs.writeFile(architecturePath, originalArchitecture, "utf8");

  const service = await SdsPreflightService.create(workspace);
  try {
    const applied = await service.runPreflight({
      workspace,
      projectKey: "proj",
      sdsPaths: [sdsPath],
      writeArtifacts: false,
      applyToSds: true,
    });
    assert.deepEqual(applied.sourceSdsPaths, [sdsPath]);
    assert.deepEqual(applied.appliedSdsPaths, [sdsPath]);
    assert.equal(await fs.readFile(pdrPath, "utf8"), originalPdr);
    assert.equal(await fs.readFile(architecturePath, "utf8"), originalArchitecture);

    const rerun = await service.runPreflight({
      workspace,
      projectKey: "proj",
      sdsPaths: [sdsPath],
      writeArtifacts: false,
    });
    assert.deepEqual(rerun.sourceSdsPaths, [sdsPath]);
    assert.equal(rerun.requiredQuestionCount, 0);
    assert.ok(rerun.issues.every((issue) => issue.gateId !== "gate-open-questions"));
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
