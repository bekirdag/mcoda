import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../../cli.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  createLocalJsonlGatewayDatasetObjectStore,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";
import { runCodaliDatasetExportJob } from "../../storage/DatasetExportJob.js";
import type { CodaliStorageDatasetRecord } from "../../storage/CodaliStorageContracts.js";
import { inspectDatasetExportManifestForImprovement } from "../DatasetExportManifestReader.js";
import {
  CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
  buildCodaliCandidateRelease,
} from "../CandidateReleaseBuilder.js";

const fixedNow = () => new Date("2026-07-08T12:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-29",
  productId: "product-neutral",
  deploymentId: "phase-29",
  runId: "dataset-export-phase-29",
});

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
  },
) =>
  objectStore.putObject({
    scope: scope(),
    ownerType: "dataset_record",
    ownerId: input.ownerId,
    kind: input.part === "evidence" ? "evidence" : "dataset",
    payload: input.payload,
    retentionClass: "dataset",
    privacyFlags: createGatewayDatasetLocalOnlyObjectPrivacyFlags({
      containsTenantPrivateData: false,
      containsCustomerData: false,
      exportAllowed: true,
      trainingAllowed: false,
      evalAllowed: true,
      replayAllowed: true,
    }),
    metadata: {
      part: input.part,
    },
  });

const buildRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  artifactType: string;
  failureClass: string;
  reasonCode: string;
  schemaHash?: string;
  toolContractHash?: string;
}): Promise<CodaliStorageDatasetRecord> => {
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    payload: { request: `request for ${input.recordId}` },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    payload: { previousResult: `failed result for ${input.recordId}` },
  });
  const evidenceRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "evidence",
    payload: {
      failureClass: input.failureClass,
      reasonCode: input.reasonCode,
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: "gateway_answer",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    evidenceRefs: [evidenceRef],
    quality: {
      score: 0.91,
      labels: ["human_reviewed", "accepted_correction"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed: false,
      policyTags: ["local_only"],
    }),
    metadata: {
      artifactType: input.artifactType,
      failureClasses: [input.failureClass],
      reasonCodes: [input.reasonCode],
      failureEvidence: [{
        failureClass: input.failureClass,
        reasonCode: input.reasonCode,
        source: "pre_change_eval",
      }],
      taskHash: `task-hash-${input.recordId}`,
      promptHash: `prompt-hash-${input.recordId}`,
      expectedTargetHash: input.schemaHash ?? `target-hash-${input.recordId}`,
      ...(input.schemaHash ? {
        schemaContract: {
          hash: input.schemaHash,
          version: "contract.v1",
        },
      } : {}),
      ...(input.toolContractHash ? {
        toolContractHash: input.toolContractHash,
        toolMetadata: {
          hash: input.toolContractHash,
          contractVersion: "tool.contract.v1",
        },
      } : {}),
    },
  };
};

const buildExportFixture = async (directory: string) => {
  await writeWorkspacePackageManifests(directory);
  const objectDirectory = path.join(directory, "objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const records = [
    await buildRecord({
      objectStore,
      recordId: "phase-29-prompt",
      artifactType: "prompt",
      failureClass: "missing_source_grounding",
      reasonCode: "answer_ignored_evidence",
    }),
    await buildRecord({
      objectStore,
      recordId: "phase-29-schema",
      artifactType: "schema",
      failureClass: "schema_required_field_missing",
      reasonCode: "schema_rejected_valid_payload",
      schemaHash: "schema-contract-hash-phase-29",
    }),
    await buildRecord({
      objectStore,
      recordId: "phase-29-tool-metadata",
      artifactType: "tool_metadata",
      failureClass: "tool_contract_argument_missing",
      reasonCode: "tool_contract_missing_required_argument",
      toolContractHash: "tool-contract-hash-phase-29",
    }),
  ];
  const result = await runCodaliDatasetExportJob({
    exportKind: "prompt-regression",
    records,
    objectStore,
    scope: scope(),
    generatedBy: "phase-29-candidate-release-builder-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  return {
    objectDirectory,
    manifest: result.manifest,
  };
};

const writeWorkspacePackageManifests = async (directory: string) => {
  await mkdir(path.join(directory, "packages", "codali"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name: "mcoda",
      version: "1.2.3",
      private: true,
      workspaces: ["packages/*"],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(directory, "packages", "codali", "package.json"),
    `${JSON.stringify({
      name: "@mcoda/codali",
      version: "1.2.3",
      type: "module",
    }, null, 2)}\n`,
    "utf8",
  );
};

const inspectFixture = async (fixture: Awaited<ReturnType<typeof buildExportFixture>>) =>
  inspectDatasetExportManifestForImprovement({
    exportId: fixture.manifest.manifestId,
    directory: fixture.objectDirectory,
    allowedExampleArtifactTypes: [
      "prompt",
      "prompt_regression",
      "schema",
      "tool_metadata",
      "tool_metadata_patch",
      "tool_contract",
    ],
  });

const captureLog = async (run: () => Promise<void>): Promise<string> => {
  const originalLog = console.log;
  let output = "";
  console.log = (value?: unknown) => {
    output += `${String(value ?? "")}\n`;
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return output;
};

test("CandidateReleaseBuilder creates reproducible dry-run workspace and patch output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-29-release-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await inspectFixture(fixture);
    const build = await buildCodaliCandidateRelease({
      inspection,
      repoRoot: directory,
      dryRun: true,
      runId: "phase-29-run",
      candidateDate: "2026-07-08",
      dirtyEntries: [],
    });
    const repeated = await buildCodaliCandidateRelease({
      inspection,
      repoRoot: directory,
      dryRun: true,
      runId: "phase-29-run",
      candidateDate: "2026-07-08",
      dirtyEntries: [],
    });

    assert.equal(build.schemaVersion, CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION);
    assert.equal(build.candidateWorkspace.branchName, "codali/auto-improve/2026-07-08-phase-29-run");
    assert.equal(build.candidateWorkspace.branchName, repeated.candidateWorkspace.branchName);
    assert.equal(build.generatedArtifacts[0]?.contentHash, repeated.generatedArtifacts[0]?.contentHash);
    assert.equal(build.writePlan.status, "dry_run");
    assert.equal(build.writePlan.targets[0]?.approved, true);
    assert.equal(build.release.status, "planned");
    assert.equal(build.generatedArtifacts[0]?.sourceExportIds.includes(fixture.manifest.manifestId), true);
    assert.equal(build.generatedArtifacts[0]?.sourceSchemaVersions.candidateRelease, CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION);
    assert.equal(build.release.tagName, build.releasePlan.futureTag);
    assert.equal(build.release.version, build.releasePlan.version);
    assert.equal(build.releasePlan.semverBump, "minor");
    assert.equal(build.releasePlan.version, "1.3.0");
    assert.equal(build.releasePlan.futureTag, "v1.3.0");
    assert.equal(build.releasePlan.packageVersions.matchesFutureTag, true);
    assert.deepEqual(
      build.releasePlan.packageVersions.targets.map((target) => [
        target.packageName,
        target.currentVersion,
        target.plannedVersion,
      ]),
      [
        ["mcoda", "1.2.3", "1.3.0"],
        ["@mcoda/codali", "1.2.3", "1.3.0"],
      ],
    );
    assert.equal(build.releasePlan.changelog.sourceExportIds.includes(fixture.manifest.manifestId), true);
    assert.equal(build.releasePlan.changelog.changedArtifactClasses.includes("schema_patch"), true);
    assert.equal(build.releasePlan.changelog.evalDeltas.status, "not_provided");
    assert.equal(build.releasePlan.changelog.privacySummary.status, "provided");
    assert.equal(build.releasePlan.changelog.privacySummary.containsCustomerData, false);
    assert.equal(build.releasePlan.changelog.rawCustomerDataIncluded, false);
    assert.equal(build.releasePlan.commit.rawCustomerDataIncluded, false);
    assert.equal(build.releasePlan.tag.rawCustomerDataIncluded, false);
    assert.equal(build.releasePlan.storageServiceReleaseId.startsWith("storage-service-release-"), true);
    assert.equal(build.releasePlan.gates.some((gate) => gate.gateId === "package_versions_match_future_tag" && gate.status === "passed"), true);
    assert.match(build.patchOutput, /^diff --git a\/\.codali\/improvement\/candidates\//u);
    assert.match(build.patchOutput, /^\+\s+"schemaVersion": "codali\.improvement\.candidate_release\.v1"/mu);
    assert.equal(build.patchOutput.includes("OKACAM") || build.patchOutput.includes("Suku"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CandidateReleaseBuilder refuses outside-repo and unapproved write targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-29-paths-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await inspectFixture(fixture);

    await assert.rejects(
      () => buildCodaliCandidateRelease({
        inspection,
        repoRoot: directory,
        outputPath: path.join(directory, "..", "outside.json"),
        dirtyEntries: [],
      }),
      /CODALI_CANDIDATE_RELEASE_PATH_OUTSIDE_REPO/u,
    );

    const blocked = await buildCodaliCandidateRelease({
      inspection,
      repoRoot: directory,
      outputPath: "docs/not-approved/candidate-release.json",
      approvedPaths: [".codali/improvement/"],
      dirtyEntries: [],
    });
    assert.equal(blocked.writePlan.status, "blocked");
    assert.equal(blocked.release.status, "blocked");
    assert.deepEqual(blocked.writePlan.blockedReasons, ["target_path_not_approved"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CandidateReleaseBuilder refuses dirty target files without blocking unrelated dry-run dirt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-29-dirty-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await inspectFixture(fixture);
    const targetPath = ".codali/improvement/candidates/dirty/candidate-release.json";

    const unrelatedDirty = await buildCodaliCandidateRelease({
      inspection,
      repoRoot: directory,
      outputPath: targetPath,
      dirtyEntries: [{ status: "M", path: "README.md" }],
    });
    assert.equal(unrelatedDirty.writePlan.status, "dry_run");
    assert.equal(unrelatedDirty.dirtyWorktree.unrelatedDirtyFileCount, 1);

    const targetDirty = await buildCodaliCandidateRelease({
      inspection,
      repoRoot: directory,
      outputPath: targetPath,
      dirtyEntries: [{ status: "M", path: targetPath }],
    });
    assert.equal(targetDirty.writePlan.status, "blocked");
    assert.equal(targetDirty.release.status, "blocked");
    assert.deepEqual(targetDirty.dirtyWorktree.targetDirtyFiles, [targetPath]);
    assert.deepEqual(targetDirty.writePlan.blockedReasons, ["target_file_dirty"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CandidateReleaseBuilder creates candidate branch and writes approved artifacts when enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-29-write-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await inspectFixture(fixture);
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    const build = await buildCodaliCandidateRelease({
      inspection,
      repoRoot: directory,
      dryRun: false,
      runId: "phase-29-write",
      candidateDate: "2026-07-08",
      dirtyEntries: [],
      commandRunner: (command, args, options) => {
        commands.push({ command, args, cwd: options.cwd });
        return { exitCode: 0, stdout: "" };
      },
    });

    assert.equal(build.writePlan.status, "written");
    assert.equal(build.release.status, "created");
    assert.deepEqual(commands, [{
      command: "git",
      args: ["switch", "-c", "codali/auto-improve/2026-07-08-phase-29-write"],
      cwd: directory,
    }]);
    const targetPath = build.generatedArtifacts[0]?.relativePath;
    assert.ok(targetPath);
    assert.equal(targetPath.startsWith(".codali/improvement/"), true);
    const written = JSON.parse(await readFile(path.join(directory, targetPath), "utf8")) as {
      schemaVersion?: string;
      sourceExportIds?: string[];
      sourceSchemaVersions?: {
        candidateRelease?: string;
        patchCandidate?: string;
        storageManifest?: string;
      };
    };
    assert.equal(written.schemaVersion, CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION);
    assert.equal(written.sourceExportIds?.includes(fixture.manifest.manifestId), true);
    assert.equal(written.sourceSchemaVersions?.candidateRelease, CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION);
    assert.equal(typeof written.sourceSchemaVersions?.patchCandidate, "string");
    assert.equal(typeof written.sourceSchemaVersions?.storageManifest, "string");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CandidateReleaseBuilder blocks non-dry-run unrelated dirt before branch creation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-29-non-dry-dirty-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await inspectFixture(fixture);
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    const build = await buildCodaliCandidateRelease({
      inspection,
      repoRoot: directory,
      dryRun: false,
      runId: "phase-29-blocked",
      candidateDate: "2026-07-08",
      dirtyEntries: [{ status: "M", path: "README.md" }],
      commandRunner: (command, args, options) => {
        commands.push({ command, args, cwd: options.cwd });
        return { exitCode: 0, stdout: "" };
      },
    });

    assert.equal(build.writePlan.status, "blocked");
    assert.equal(build.release.status, "blocked");
    assert.deepEqual(build.writePlan.blockedReasons, ["unrelated_dirty_worktree"]);
    assert.equal(commands.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CandidateReleaseBuilder refuses approved symlink escapes before branch creation", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-29-symlink-"));
  let outsideDirectory: string | undefined;
  try {
    outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "phase-29-outside-"));
    const fixture = await buildExportFixture(directory);
    const inspection = await inspectFixture(fixture);
    await mkdir(path.join(directory, ".codali", "improvement"), { recursive: true });
    await symlink(
      outsideDirectory,
      path.join(directory, ".codali", "improvement", "escape"),
    );
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    await assert.rejects(
      () => buildCodaliCandidateRelease({
        inspection,
        repoRoot: directory,
        dryRun: false,
        outputPath: ".codali/improvement/escape/candidate-release.json",
        dirtyEntries: [],
        commandRunner: (command, args, options) => {
          commands.push({ command, args, cwd: options.cwd });
          return { exitCode: 0, stdout: "" };
        },
      }),
      /CODALI_CANDIDATE_RELEASE_PATH_OUTSIDE_REPO/u,
    );
    assert.equal(commands.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (outsideDirectory) {
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  }
});

test("codali improve build-release emits dry-run release JSON with candidate patch metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-29-cli-"));
  try {
    const fixture = await buildExportFixture(directory);
    const output = await captureLog(() =>
      runCli([
        "improve",
        "build-release",
        "--export-id",
        fixture.manifest.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--repo-root",
        directory,
        "--dry-run",
        "--output",
        "json",
      ]));
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal(parsed.outputType, "improvement.release");
    assert.equal(parsed.status, "ok");
    const data = parsed.data as {
      status?: string;
      metadata?: {
        schemaVersion?: string;
        sourceExportIds?: string[];
        candidateWorkspace?: { branchName?: string; patchOutput?: string };
        writePlan?: { status?: string };
        generatedArtifacts?: Array<{ sourceExportIds?: string[]; schemaVersion?: string }>;
        releasePlan?: {
          version?: string;
          futureTag?: string;
          storageServiceReleaseId?: string;
          packageVersions?: {
            matchesFutureTag?: boolean;
            targets?: Array<{ plannedVersion?: string }>;
          };
          changelog?: {
            rawCustomerDataIncluded?: boolean;
            sourceExportIds?: string[];
            changedArtifactClasses?: string[];
          };
          commit?: { message?: string; rawCustomerDataIncluded?: boolean };
          tag?: { name?: string; matchesPackageVersions?: boolean; rawCustomerDataIncluded?: boolean };
          rollback?: { commands?: string[] };
        };
      };
    };
    assert.equal(data.status, "planned");
    assert.equal(data.metadata?.schemaVersion, CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION);
    assert.equal(data.metadata?.sourceExportIds?.includes(fixture.manifest.manifestId), true);
    assert.match(data.metadata?.candidateWorkspace?.branchName ?? "", /^codali\/auto-improve\/2026-07-08-run-/u);
    assert.match(data.metadata?.candidateWorkspace?.patchOutput ?? "", /diff --git/u);
    assert.equal(data.metadata?.writePlan?.status, "dry_run");
    assert.equal(data.metadata?.generatedArtifacts?.[0]?.schemaVersion, CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION);
    assert.equal(data.metadata?.releasePlan?.futureTag, `v${data.metadata?.releasePlan?.version}`);
    assert.equal(data.metadata?.releasePlan?.packageVersions?.matchesFutureTag, true);
    assert.equal(data.metadata?.releasePlan?.packageVersions?.targets?.every((target) =>
      target.plannedVersion === data.metadata?.releasePlan?.version), true);
    assert.equal(data.metadata?.releasePlan?.storageServiceReleaseId?.startsWith("storage-service-release-"), true);
    assert.equal(data.metadata?.releasePlan?.changelog?.sourceExportIds?.includes(fixture.manifest.manifestId), true);
    assert.equal(data.metadata?.releasePlan?.changelog?.changedArtifactClasses?.includes("schema_patch"), true);
    assert.equal(data.metadata?.releasePlan?.changelog?.rawCustomerDataIncluded, false);
    assert.equal(data.metadata?.releasePlan?.commit?.message?.includes("customer"), false);
    assert.equal(data.metadata?.releasePlan?.commit?.rawCustomerDataIncluded, false);
    assert.equal(data.metadata?.releasePlan?.tag?.name, data.metadata?.releasePlan?.futureTag);
    assert.equal(data.metadata?.releasePlan?.tag?.matchesPackageVersions, true);
    assert.equal(data.metadata?.releasePlan?.tag?.rawCustomerDataIncluded, false);
    assert.ok(data.metadata?.releasePlan?.rollback?.commands?.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codali improve build-release plans a candidate id dry-run without package file changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-31-cli-candidate-"));
  try {
    const fixture = await buildExportFixture(directory);
    const candidateDirectory = path.join(directory, ".codali", "improvement", "candidates", "phase-31");
    await mkdir(candidateDirectory, { recursive: true });
    const candidatePath = path.join(candidateDirectory, "candidate-release.json");
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
        candidateId: "candidate-phase-31",
        workspace: {
          workspaceId: "phase-31",
          branchName: "codali/auto-improve/phase-31",
        },
        sourceExportIds: [fixture.manifest.manifestId],
        sourceManifest: {
          exportId: fixture.manifest.manifestId,
          manifestId: fixture.manifest.manifestId,
          schemaVersion: fixture.manifest.schemaVersion,
          privacySummary: fixture.manifest.privacySummary,
        },
        proposals: [{ artifact: "prompt" }],
        evalDeltas: {
          passRateDelta: 0.12,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const rootPackagePath = path.join(directory, "package.json");
    const packageBefore = await readFile(rootPackagePath, "utf8");
    const output = await captureLog(() =>
      runCli([
        "improve",
        "build-release",
        "--candidate",
        "candidate-phase-31",
        "--candidate-path",
        candidatePath,
        "--repo-root",
        directory,
        "--dry-run",
        "--output",
        "json",
      ]));
    const packageAfter = await readFile(rootPackagePath, "utf8");
    assert.equal(packageAfter, packageBefore);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal(parsed.outputType, "improvement.release");
    assert.equal(parsed.status, "ok");
    const data = parsed.data as {
      candidateId?: string;
      tagName?: string;
      version?: string;
      metadata?: {
        candidateSource?: string;
        writePlan?: { status?: string; targets?: unknown[] };
        releasePlan?: {
          semverBump?: string;
          version?: string;
          futureTag?: string;
          storageServiceReleaseId?: string;
          branch?: { name?: string };
          commit?: { message?: string; rawCustomerDataIncluded?: boolean };
          tag?: { name?: string; matchesPackageVersions?: boolean; rawCustomerDataIncluded?: boolean };
          gates?: Array<{ gateId?: string; status?: string }>;
          rollback?: { commands?: string[] };
          packageVersions?: {
            matchesFutureTag?: boolean;
            targets?: Array<{ packageName?: string; plannedVersion?: string }>;
          };
          changelog?: {
            sourceExportIds?: string[];
            changedArtifactClasses?: string[];
            evalDeltas?: { status?: string; metrics?: Record<string, number> };
            privacySummary?: { status?: string; containsCustomerData?: boolean };
            rawCustomerDataIncluded?: boolean;
          };
        };
      };
    };
    const plan = data.metadata?.releasePlan;
    assert.equal(data.candidateId, "candidate-phase-31");
    assert.equal(data.metadata?.candidateSource, "candidate_file");
    assert.equal(data.metadata?.writePlan?.status, "dry_run");
    assert.deepEqual(data.metadata?.writePlan?.targets, []);
    assert.equal(plan?.semverBump, "patch");
    assert.equal(plan?.version, "1.2.4");
    assert.equal(plan?.futureTag, "v1.2.4");
    assert.equal(data.tagName, plan?.futureTag);
    assert.equal(data.version, plan?.version);
    assert.equal(plan?.branch?.name, "codali/auto-improve/phase-31");
    assert.equal(plan?.commit?.message, "chore(release): plan v1.2.4");
    assert.equal(plan?.commit?.rawCustomerDataIncluded, false);
    assert.equal(plan?.tag?.name, "v1.2.4");
    assert.equal(plan?.tag?.matchesPackageVersions, true);
    assert.equal(plan?.tag?.rawCustomerDataIncluded, false);
    assert.equal(plan?.storageServiceReleaseId?.startsWith("storage-service-release-"), true);
    assert.equal(plan?.packageVersions?.matchesFutureTag, true);
    assert.equal(plan?.packageVersions?.targets?.every((target) =>
      target.plannedVersion === plan.version), true);
    assert.equal(plan?.changelog?.sourceExportIds?.includes(fixture.manifest.manifestId), true);
    assert.deepEqual(plan?.changelog?.changedArtifactClasses, ["prompt_patch"]);
    assert.equal(plan?.changelog?.evalDeltas?.status, "provided");
    assert.equal(plan?.changelog?.evalDeltas?.metrics?.passRateDelta, 0.12);
    assert.equal(plan?.changelog?.privacySummary?.status, "provided");
    assert.equal(plan?.changelog?.privacySummary?.containsCustomerData, false);
    assert.equal(plan?.changelog?.rawCustomerDataIncluded, false);
    assert.equal(plan?.gates?.some((gate) =>
      gate.gateId === "raw_customer_data_absent" && gate.status === "passed"), true);
    assert.ok(plan?.rollback?.commands?.some((command) => command.includes("v1.2.4")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
