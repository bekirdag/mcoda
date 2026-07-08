import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseImprovementArgs } from "../../cli/ImprovementCommand.js";
import { runCli } from "../../cli.js";
import type {
  GatewayDatasetFetch,
  GatewayDatasetFetchRequest,
  GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";
import type { CodaliImprovementEvalRunnerResult } from "../ImprovementEvalRunner.js";
import { StorageServiceImprovementClient } from "../StorageServiceImprovementClient.js";
import {
  CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
  runCodaliPublishOrchestrator,
  writeCodaliPublishToStorageService,
} from "../PublishOrchestrator.js";

const fixedNow = () => new Date("2026-07-08T12:00:00.000Z");

const storageScope: GatewayDatasetStorageScope = {
  tenantId: "tenant-phase-32",
  productId: "product-neutral",
  deploymentId: "phase-32",
  runId: "improvement-publish-phase-32",
};

const response = (input: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}) => ({
  ok: input.ok ?? true,
  status: input.status ?? 201,
  statusText: input.statusText,
  text: async () => input.body === undefined ? "" : JSON.stringify(input.body),
});

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

const writeCandidate = async (
  directory: string,
  candidateId = "phase-32-candidate",
): Promise<string> => {
  const candidateDirectory = path.join(directory, ".codali", "improvement", "candidates");
  await mkdir(candidateDirectory, { recursive: true });
  const candidatePath = path.join(candidateDirectory, `${candidateId}.json`);
  await writeFile(
    candidatePath,
    `${JSON.stringify({
      candidateId,
      sourceExportIds: ["dataset-export-phase-32"],
      changedArtifactClasses: ["prompt_patch"],
      sourceSchemaVersions: {
        candidateRelease: "codali.improvement.candidate_release.v1",
        patchCandidate: "codali.improvement.patch_candidate.v1",
        storageManifest: "codali.storage.v1",
      },
      workspace: {
        workspaceId: "phase-32-validation",
        branchName: "codali/auto-improve/phase-32-validation",
        discardable: true,
      },
      release: {
        candidateId,
        releaseLevel: 4,
      },
      privacySummary: {
        recordCount: 1,
        containsCustomerData: false,
        containsSecrets: false,
        exportAllowedCount: 1,
        trainingAllowedCount: 0,
        policyTags: ["local_only"],
      },
      evalDeltas: {
        passRateDelta: 0.12,
      },
      deterministicTests: [{ name: "unit", status: "passed" }],
      replayChecks: [{ name: "replay", status: "passed" }],
      privacyChecks: [{ name: "privacy", status: "passed" }],
      policyChecks: [{ name: "policy", status: "passed" }],
      toolPolicy: {
        allowedTools: ["retrieval.read", "evidence.view"],
        deniedTools: ["shell.exec", "filesystem.write"],
        destructiveToolsAllowed: false,
      },
      changedFilePaths: [".codali/improvement/candidates/phase-32-candidate.json"],
      approvedPaths: [".codali/improvement/"],
    }, null, 2)}\n`,
    "utf8",
  );
  return candidatePath;
};

const buildFixture = async (candidateId = "phase-32-candidate") => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-32-publish-"));
  await writeWorkspacePackageManifests(directory);
  const candidatePath = await writeCandidate(directory, candidateId);
  return { directory, candidateId, candidatePath };
};

const passingScorecard = (
  candidateId: string,
): CodaliImprovementEvalRunnerResult => ({
  schemaVersion: "codali.improvement.eval_runner.v1",
  candidateId,
  candidateSource: "provided",
  scorecard: {
    schemaVersion: "codali.improvement.v1",
    scorecardId: `scorecard-${candidateId}`,
    candidateId,
    status: "passed",
    gates: [],
    scores: {},
    createdAt: fixedNow().toISOString(),
  },
  gates: [],
  releaseApproval: {
    candidateId,
    releaseLevel: 4,
    tagAllowed: true,
    publishAllowed: true,
    failedHardGateIds: [],
    skippedHardGateIds: [],
    warningGateIds: [],
    blockedReasons: [],
    warningReasons: [],
    requiresManualReview: false,
  },
  blockedReasons: [],
  warnings: [],
  storagePayload: {
    releaseScope: {
      tenantHash: "tenant-phase-32",
      productId: "product-neutral",
      deploymentId: "phase-32",
    },
  },
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

test("PublishOrchestrator plans branch-only dry-run through the release workflow only", async () => {
  const fixture = await buildFixture("phase-32-branch-only");
  try {
    const result = await runCodaliPublishOrchestrator({
      candidateId: fixture.candidateId,
      candidatePath: fixture.candidatePath,
      repoRoot: fixture.directory,
      mode: "branch_only",
      dryRun: true,
      releaseLevel: 4,
      dirtyEntries: [],
      now: fixedNow,
    });

    assert.equal(result.status, "planned");
    assert.equal(result.publisher.type, "github_actions_release_workflow");
    assert.equal(result.publisher.workflowFile, CODALI_PUBLISH_RELEASE_WORKFLOW_FILE);
    assert.equal(result.publisher.localNpmPublishAllowed, false);
    assert.equal(result.commitGuard.required, false);
    assert.equal(result.commitGuard.status, "skipped");
    assert.equal(result.workflowRun.status, "not_requested");
    assert.equal(result.npmVersions.length, 1);
    assert.equal(result.npmVersions[0]?.packageName, "@mcoda/codali");
    assert.equal(result.npmVersions[0]?.expectedVersion, "1.2.4");
    assert.equal(result.npmVersions[0]?.status, "planned");
    assert.equal(result.commands.every((step) => step.executed === false), true);
    assert.equal(result.commands.some((step) => step.command === "npm" && step.args[0] === "publish"), false);
    assert.equal(result.commands.some((step) => step.command === "git" && step.args[0] === "tag"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PublishOrchestrator blocks auto-tag unless policy gates allow it", async () => {
  const fixture = await buildFixture("phase-32-policy-blocked");
  try {
    const result = await runCodaliPublishOrchestrator({
      candidateId: fixture.candidateId,
      candidatePath: fixture.candidatePath,
      repoRoot: fixture.directory,
      mode: "auto_tag",
      dryRun: false,
      releaseLevel: 4,
      autoTagEnabled: false,
      autoPublishEnabled: false,
      commitSha: "1234567890abcdef1234567890abcdef12345678",
      dirtyEntries: [],
      scorecard: passingScorecard(fixture.candidateId),
      now: fixedNow,
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(result.commitGuard.reasons, []);
    assert.equal(result.commitGuard.status, "clean");
    assert.ok(result.blockedReasons.includes("auto_tag_policy_blocked"));
    assert.ok(result.blockedReasons.includes("stable_publish_policy_blocked"));
    assert.equal(result.blockedReasons.includes("scorecard_tag_blocked"), false);
    assert.equal(result.blockedReasons.includes("candidate_commit_not_clean"), false);
    const tagStep = result.commands.find((step) => step.command === "git" && step.args[0] === "tag");
    const pushStep = result.commands.find((step) => step.command === "git" && step.args[0] === "push");
    assert.equal(tagStep?.executed, false);
    assert.equal(pushStep?.executed, false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PublishOrchestrator plans auto-tag dry-run only after policy, scorecard, and commit guard pass", async () => {
  const fixture = await buildFixture("phase-32-auto-tag-dry-run");
  try {
    const result = await runCodaliPublishOrchestrator({
      candidateId: fixture.candidateId,
      candidatePath: fixture.candidatePath,
      repoRoot: fixture.directory,
      mode: "auto_tag",
      dryRun: true,
      releaseLevel: 4,
      autoTagEnabled: true,
      autoPublishEnabled: true,
      commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      dirtyEntries: [],
      scorecard: passingScorecard(fixture.candidateId),
      now: fixedNow,
    });

    assert.equal(result.status, "planned");
    assert.equal(result.commitGuard.required, true);
    assert.equal(result.commitGuard.status, "clean");
    assert.equal(result.policyDecisions.autoTag.allowed, true);
    assert.equal(result.policyDecisions.publishStable.allowed, true);
    assert.deepEqual(result.blockedReasons, []);
    const tagStep = result.commands.find((step) => step.command === "git" && step.args[0] === "tag");
    const pushStep = result.commands.find((step) => step.command === "git" && step.args[0] === "push");
    assert.equal(tagStep?.executed, false);
    assert.equal(pushStep?.executed, false);
    assert.equal(tagStep?.args.includes("fedcba9876543210fedcba9876543210fedcba98"), true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PublishOrchestrator blocks auto-tag when the candidate commit is dirty", async () => {
  const fixture = await buildFixture("phase-32-dirty-commit");
  try {
    const result = await runCodaliPublishOrchestrator({
      candidateId: fixture.candidateId,
      candidatePath: fixture.candidatePath,
      repoRoot: fixture.directory,
      mode: "auto_tag",
      dryRun: false,
      releaseLevel: 4,
      autoTagEnabled: true,
      autoPublishEnabled: true,
      commitSha: "00112233445566778899aabbccddeeff00112233",
      dirtyEntries: [{ status: "M", path: "packages/codali/src/index.ts" }],
      scorecard: passingScorecard(fixture.candidateId),
      now: fixedNow,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.commitGuard.required, true);
    assert.equal(result.commitGuard.status, "dirty");
    assert.equal(result.commitGuard.dirtyFileCount, 1);
    assert.ok(result.blockedReasons.includes("candidate_commit_not_clean"));
    const tagStep = result.commands.find((step) => step.command === "git" && step.args[0] === "tag");
    const pushStep = result.commands.find((step) => step.command === "git" && step.args[0] === "push");
    assert.equal(tagStep?.executed, false);
    assert.equal(pushStep?.executed, false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PublishOrchestrator accepts workflow/npm status ingestion and stores release metadata", async () => {
  const fixture = await buildFixture("phase-32-published");
  try {
    const result = await runCodaliPublishOrchestrator({
      candidateId: fixture.candidateId,
      candidatePath: fixture.candidatePath,
      repoRoot: fixture.directory,
      mode: "branch_only",
      dryRun: false,
      releaseLevel: 4,
      commitSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      dirtyEntries: [],
      workflowRun: {
        runId: "987654321",
        status: "completed",
        conclusion: "success",
        headSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        url: "https://github.example/actions/runs/987654321",
      },
      npmPackages: ["@mcoda/codali"],
      npmVersions: [{ packageName: "@mcoda/codali", version: "1.2.4" }],
      now: fixedNow,
    });
    assert.equal(result.status, "published_verified");
    assert.equal(result.workflowRun.runId, "987654321");
    assert.equal(result.npmVersions[0]?.status, "verified");

    const requests: Array<{ url: string; request: GatewayDatasetFetchRequest }> = [];
    const fetchImpl: GatewayDatasetFetch = async (url, request) => {
      requests.push({ url, request });
      return response({
        body: {
          accepted: true,
          record: { id: requests.length },
          scope: storageScope,
        },
      });
    };
    const client = new StorageServiceImprovementClient({
      baseUrl: "http://storage.local",
      serviceToken: "service-token",
      fetch: fetchImpl,
      now: fixedNow,
      nonceFactory: () => "phase-32-nonce",
    });

    const writes = await writeCodaliPublishToStorageService({
      result,
      scope: storageScope,
      client,
    });

    assert.equal(writes.length, 2);
    assert.equal(requests.length, 2);
    const bodies = requests.map((entry) => JSON.parse(String(entry.request.body)) as Record<string, unknown>);
    const runMetadata = bodies[0]?.metadata as Record<string, unknown>;
    const candidateMetadata = bodies[1]?.metadata as Record<string, unknown>;
    assert.equal(runMetadata?.tagName, "v1.2.4");
    assert.equal(runMetadata?.commitSha, "abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    assert.equal(runMetadata?.workflowRunId, "987654321");
    assert.equal(runMetadata?.status, "published_verified");
    assert.equal(candidateMetadata?.tagName, "v1.2.4");
    assert.equal(candidateMetadata?.commitSha, "abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    assert.equal(candidateMetadata?.workflowRunId, "987654321");
    assert.equal(candidateMetadata?.status, "published_verified");
    assert.ok(Array.isArray(runMetadata?.npmVersions));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PublishOrchestrator verifies npm view after successful workflow by default", async () => {
  const fixture = await buildFixture("phase-32-npm-view-default");
  try {
    const commands: Array<{ command: string; args: string[] }> = [];
    const result = await runCodaliPublishOrchestrator({
      candidateId: fixture.candidateId,
      candidatePath: fixture.candidatePath,
      repoRoot: fixture.directory,
      mode: "branch_only",
      dryRun: false,
      releaseLevel: 4,
      commitSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      dirtyEntries: [],
      workflowRun: {
        runId: "987654321",
        status: "completed",
        conclusion: "success",
        headSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      },
      npmPackages: ["@mcoda/codali"],
      commandRunner: (command, args) => {
        commands.push({ command, args });
        if (
          command === "npm" &&
          args.join(" ") === "view @mcoda/codali version --registry https://registry.npmjs.org/"
        ) {
          return { exitCode: 0, stdout: "1.2.4\n", stderr: "" };
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr: `unexpected command ${command} ${args.join(" ")}`,
        };
      },
      now: fixedNow,
    });

    assert.equal(result.status, "published_verified");
    assert.equal(result.npmVersions[0]?.status, "verified");
    assert.equal(commands.some((step) => step.command === "npm" && step.args[0] === "view"), true);
    assert.equal(
      result.commands.some((step) => step.command === "npm" && step.args[0] === "view" && step.executed),
      true,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PublishOrchestrator marks completed non-success workflow conclusions as failed", async () => {
  const fixture = await buildFixture("phase-32-workflow-cancelled");
  try {
    const result = await runCodaliPublishOrchestrator({
      candidateId: fixture.candidateId,
      candidatePath: fixture.candidatePath,
      repoRoot: fixture.directory,
      mode: "branch_only",
      dryRun: false,
      releaseLevel: 4,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      dirtyEntries: [],
      workflowRun: {
        runId: "123456789",
        status: "completed",
        conclusion: "cancelled",
        headSha: "0123456789abcdef0123456789abcdef01234567",
      },
      npmPackages: ["@mcoda/codali"],
      npmVersions: [{ packageName: "@mcoda/codali", version: "1.2.4" }],
      now: fixedNow,
    });

    assert.equal(result.status, "workflow_failed");
    assert.equal(result.outcome.status, "failed");
    assert.equal(result.workflowRun.conclusion, "cancelled");
    assert.equal(result.npmVersions[0]?.status, "verified");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("codali improve publish leaves npm verification on orchestrator default unless overridden", () => {
  const defaultParsed = parseImprovementArgs([
    "publish",
    "--candidate",
    "phase-32-cli-default",
    "--workflow-status",
    "completed",
    "--workflow-conclusion",
    "success",
  ]);
  const forcedParsed = parseImprovementArgs([
    "publish",
    "--candidate",
    "phase-32-cli-default",
    "--verify-npm",
  ]);
  const disabledParsed = parseImprovementArgs([
    "publish",
    "--candidate",
    "phase-32-cli-default",
    "--no-npm-verify",
  ]);

  assert.equal(defaultParsed.verifyNpm, undefined);
  assert.equal(forcedParsed.verifyNpm, true);
  assert.equal(disabledParsed.verifyNpm, false);
});

test("codali improve publish emits dry-run JSON outcome", async () => {
  const fixture = await buildFixture("phase-32-cli");
  try {
    const output = await captureLog(() =>
      runCli([
        "improve",
        "publish",
        "--candidate",
        fixture.candidateId,
        "--candidate-path",
        fixture.candidatePath,
        "--repo-root",
        fixture.directory,
        "--mode",
        "branch_only",
        "--dry-run",
        "--output",
        "json",
      ]));
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal(parsed.outputType, "improvement.outcome");
    assert.equal(parsed.status, "ok");
    const data = parsed.data as Record<string, unknown>;
    assert.equal(data.published, false);
    assert.equal(data.tagged, false);
    const metadata = data.metadata as Record<string, unknown>;
    assert.equal(metadata.status, "planned");
    assert.equal(metadata.tagName, "v1.2.4");
    const releaseWorkflow = metadata.releaseWorkflow as Record<string, unknown>;
    assert.equal(releaseWorkflow.localNpmPublishAllowed, false);
    assert.equal(releaseWorkflow.workflowFile, CODALI_PUBLISH_RELEASE_WORKFLOW_FILE);
    const commands = metadata.commands as Array<Record<string, unknown>>;
    assert.equal(commands.every((step) => step.executed === false), true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
