import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildCodaliCandidateReleasePlan,
  type CodaliCandidateReleaseBuild,
  type CodaliCandidateReleaseCommandResult,
  type CodaliCandidateReleaseCommandRunner,
  type CodaliCandidateReleaseDirtyEntry,
} from "./CandidateReleaseBuilder.js";
import {
  buildCodaliImprovementEvalScorecard,
  type CodaliImprovementEvalRunnerResult,
} from "./ImprovementEvalRunner.js";
import {
  CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  createCodaliImprovementPolicy,
  evaluateCodaliImprovementPolicy,
  type CodaliImprovementOutcome,
  type CodaliImprovementPolicy,
  type CodaliImprovementReleaseLevel,
  type CodaliImprovementScope,
} from "./ImprovementPolicy.js";
import {
  StorageServiceImprovementClient,
  type StorageServiceImprovementWriteResult,
} from "./StorageServiceImprovementClient.js";
import type { GatewayDatasetStorageScope } from "../storage/GatewayDatasetStore.js";

export const CODALI_PUBLISH_ORCHESTRATOR_SCHEMA_VERSION =
  "codali.improvement.publish.v1" as const;

export const CODALI_PUBLISH_RELEASE_WORKFLOW_FILE =
  ".github/workflows/release.yml" as const;

export const DEFAULT_CODALI_PUBLISH_NPM_REGISTRY =
  "https://registry.npmjs.org/" as const;

export type CodaliPublishMode = "branch_only" | "auto_tag";

export type CodaliPublishStatus =
  | "planned"
  | "blocked"
  | "tagged"
  | "workflow_queued"
  | "workflow_succeeded"
  | "workflow_failed"
  | "published_verified"
  | "failed";

export type CodaliPublishWorkflowStatus =
  | "not_requested"
  | "queued"
  | "in_progress"
  | "completed"
  | "unknown";

export type CodaliPublishWorkflowConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "unknown";

export type CodaliPublishNpmVersionStatus =
  | "planned"
  | "verified"
  | "mismatch"
  | "unavailable";

export interface CodaliPublishWorkflowRunStatus {
  workflowFile: typeof CODALI_PUBLISH_RELEASE_WORKFLOW_FILE;
  source: "planned" | "ingested" | "gh_cli";
  runId?: string;
  status: CodaliPublishWorkflowStatus;
  conclusion?: CodaliPublishWorkflowConclusion;
  headSha?: string;
  url?: string;
  error?: string;
}

export interface CodaliPublishNpmVersion {
  packageName: string;
  expectedVersion: string;
  registry: string;
  observedVersion?: string;
  status: CodaliPublishNpmVersionStatus;
  command: string[];
  error?: string;
}

export interface CodaliPublishCommitGuard {
  required: boolean;
  status: "clean" | "dirty" | "unavailable" | "skipped";
  commitSha?: string;
  dirtyFileCount: number;
  dirtyFilesSample: string[];
  reasons: string[];
}

export interface CodaliPublishCommandStep {
  command: string;
  args: string[];
  executed: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface CodaliPublishPublisher {
  type: "github_actions_release_workflow";
  workflowFile: typeof CODALI_PUBLISH_RELEASE_WORKFLOW_FILE;
  localNpmPublishAllowed: false;
  note: string;
}

export interface CodaliPublishResult {
  schemaVersion: typeof CODALI_PUBLISH_ORCHESTRATOR_SCHEMA_VERSION;
  dryRun: boolean;
  mode: CodaliPublishMode;
  status: CodaliPublishStatus;
  candidateId: string;
  releaseBuild: CodaliCandidateReleaseBuild;
  scorecard?: CodaliImprovementEvalRunnerResult;
  policy: CodaliImprovementPolicy;
  policyDecisions: {
    autoTag: ReturnType<typeof evaluateCodaliImprovementPolicy>;
    publishStable: ReturnType<typeof evaluateCodaliImprovementPolicy>;
  };
  publisher: CodaliPublishPublisher;
  commitGuard: CodaliPublishCommitGuard;
  workflowRun: CodaliPublishWorkflowRunStatus;
  npmVersions: CodaliPublishNpmVersion[];
  commands: CodaliPublishCommandStep[];
  blockedReasons: string[];
  outcome: CodaliImprovementOutcome;
}

export interface RunCodaliPublishOrchestratorInput {
  candidateId: string;
  candidatePath?: string;
  candidateDirectories?: readonly string[];
  repoRoot?: string;
  mode?: CodaliPublishMode;
  dryRun?: boolean;
  releaseLevel?: CodaliImprovementReleaseLevel;
  scope?: CodaliImprovementScope;
  policy?: CodaliImprovementPolicy;
  autoTagEnabled?: boolean;
  autoPublishEnabled?: boolean;
  runId?: string;
  candidateDate?: string;
  commitSha?: string;
  dirtyEntries?: readonly CodaliCandidateReleaseDirtyEntry[];
  scorecard?: CodaliImprovementEvalRunnerResult;
  workflowRun?: Partial<CodaliPublishWorkflowRunStatus>;
  pollActions?: boolean;
  verifyNpm?: boolean;
  npmRegistry?: string;
  npmPackages?: readonly string[];
  npmVersions?: readonly { packageName: string; version: string }[];
  now?: () => Date;
  commandRunner?: CodaliCandidateReleaseCommandRunner;
}

export interface WriteCodaliPublishToStorageInput {
  result: CodaliPublishResult;
  scope: GatewayDatasetStorageScope;
  client: StorageServiceImprovementClient;
}

const defaultCommandRunner: CodaliCandidateReleaseCommandRunner = (
  command,
  args,
  options,
) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
  });
  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error) : undefined,
  };
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const stableId = (prefix: string, value: unknown): string =>
  `${prefix}-${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16)}`;

const uniqueStrings = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0))).sort();

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const normalizeCandidateDirectories = (
  repoRoot: string,
  directories: readonly string[] | undefined,
): string[] | undefined =>
  directories?.map((directory) =>
    path.isAbsolute(directory) ? directory : path.resolve(repoRoot, directory));

const parseGitStatus = (stdout: string): CodaliCandidateReleaseDirtyEntry[] =>
  stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renamedPath = rawPath.includes(" -> ")
        ? rawPath.slice(rawPath.lastIndexOf(" -> ") + 4)
        : rawPath;
      return {
        status,
        path: toPosixPath(renamedPath.replace(/^"|"$/g, "")),
      };
    });

const commandStep = (
  command: string,
  args: string[],
  executed: boolean,
  result?: CodaliCandidateReleaseCommandResult,
): CodaliPublishCommandStep => ({
  command,
  args,
  executed,
  ...(result
    ? {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      }
    : {}),
});

const readCommitGuard = (input: {
  repoRoot: string;
  required: boolean;
  commitSha?: string;
  dirtyEntries?: readonly CodaliCandidateReleaseDirtyEntry[];
  commandRunner: CodaliCandidateReleaseCommandRunner;
}): CodaliPublishCommitGuard => {
  if (!input.required) {
    return {
      required: false,
      status: "skipped",
      commitSha: input.commitSha,
      dirtyFileCount: 0,
      dirtyFilesSample: [],
      reasons: [],
    };
  }
  const commitSha = input.commitSha ?? (() => {
    const result = input.commandRunner("git", ["rev-parse", "HEAD"], {
      cwd: input.repoRoot,
    });
    return result.exitCode === 0 && !result.error
      ? result.stdout.trim()
      : undefined;
  })();
  const entries = input.dirtyEntries
    ? [...input.dirtyEntries]
    : (() => {
        const result = input.commandRunner("git", ["status", "--porcelain"], {
          cwd: input.repoRoot,
        });
        if (result.exitCode !== 0 || result.error) return undefined;
        return parseGitStatus(result.stdout);
      })();
  if (!commitSha || !entries) {
    return {
      required: true,
      status: "unavailable",
      commitSha,
      dirtyFileCount: 0,
      dirtyFilesSample: [],
      reasons: [!commitSha ? "candidate_commit_sha_unavailable" : "candidate_git_status_unavailable"],
    };
  }
  const dirtyFiles = uniqueStrings(entries.map((entry) => entry.path));
  return {
    required: true,
    status: dirtyFiles.length ? "dirty" : "clean",
    commitSha,
    dirtyFileCount: dirtyFiles.length,
    dirtyFilesSample: dirtyFiles.slice(0, 20),
    reasons: dirtyFiles.length ? ["candidate_commit_not_clean"] : [],
  };
};

const createPublishPolicy = (input: {
  releaseLevel: CodaliImprovementReleaseLevel;
  scope: CodaliImprovementScope;
  autoTagEnabled: boolean;
  autoPublishEnabled: boolean;
}): CodaliImprovementPolicy =>
  createCodaliImprovementPolicy({
    policyId: `publish-policy-level-${input.releaseLevel}`,
    releaseLevel: input.releaseLevel,
    scope: input.scope,
    allowedArtifactTypes:
      input.releaseLevel >= 4
        ? ["stable_npm_release", "release_notes", "scorecard", "prerelease_tag"]
        : input.releaseLevel >= 3
          ? ["prerelease_tag", "release_notes", "scorecard"]
          : ["scorecard", "release_notes"],
    maxExamples: 0,
    maxObjectBytes: 1,
    storageMode: "local_only",
    exportEnabled: false,
    trainingEnabled: false,
    autoTagEnabled: input.autoTagEnabled,
    autoPublishEnabled: input.autoPublishEnabled,
    metadata: {
      source: "codali improve publish",
      schemaVersion: CODALI_PUBLISH_ORCHESTRATOR_SCHEMA_VERSION,
    },
  });

const releaseScopeFor = (
  releaseBuild: CodaliCandidateReleaseBuild,
  fallback?: CodaliImprovementScope,
): CodaliImprovementScope => fallback ?? releaseBuild.release.scope;

const releaseLevelFor = (
  releaseBuild: CodaliCandidateReleaseBuild,
  fallback?: CodaliImprovementReleaseLevel,
): CodaliImprovementReleaseLevel => fallback ?? releaseBuild.release.releaseLevel;

const publisher = (): CodaliPublishPublisher => ({
  type: "github_actions_release_workflow",
  workflowFile: CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
  localNpmPublishAllowed: false,
  note: "npm publish remains delegated to the existing GitHub Actions release workflow.",
});

const plannedWorkflowRun = (): CodaliPublishWorkflowRunStatus => ({
  workflowFile: CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
  source: "planned",
  status: "not_requested",
});

const normalizeWorkflowRun = (
  input: Partial<CodaliPublishWorkflowRunStatus> | undefined,
): CodaliPublishWorkflowRunStatus | undefined => {
  if (!input) return undefined;
  return {
    workflowFile: CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
    source: "ingested",
    status: input.status ?? "unknown",
    conclusion: input.conclusion,
    runId: input.runId,
    headSha: input.headSha,
    url: input.url,
    error: input.error,
  };
};

const parseGhRunList = (
  payload: string,
  commitSha: string | undefined,
): CodaliPublishWorkflowRunStatus | undefined => {
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) return undefined;
  const runs = parsed.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const matched = commitSha
    ? runs.find((run) => run.headSha === commitSha) ?? runs[0]
    : runs[0];
  if (!matched) return undefined;
  return {
    workflowFile: CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
    source: "gh_cli",
    runId: typeof matched.databaseId === "number"
      ? String(matched.databaseId)
      : typeof matched.runId === "string"
        ? matched.runId
        : undefined,
    status: matched.status === "queued" ||
      matched.status === "in_progress" ||
      matched.status === "completed"
        ? matched.status
        : "unknown",
    conclusion: typeof matched.conclusion === "string"
      ? matched.conclusion as CodaliPublishWorkflowConclusion
      : undefined,
    headSha: typeof matched.headSha === "string" ? matched.headSha : undefined,
    url: typeof matched.url === "string" ? matched.url : undefined,
  };
};

const resolveWorkflowRun = (input: {
  dryRun: boolean;
  pollActions: boolean;
  repoRoot: string;
  commitSha?: string;
  workflowRun?: Partial<CodaliPublishWorkflowRunStatus>;
  commandRunner: CodaliCandidateReleaseCommandRunner;
  commands: CodaliPublishCommandStep[];
}): CodaliPublishWorkflowRunStatus => {
  const ingested = normalizeWorkflowRun(input.workflowRun);
  if (ingested) return ingested;
  const args = [
    "run",
    "list",
    "--workflow",
    CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
    "--json",
    "databaseId,status,conclusion,headSha,url,event,displayTitle",
    "--limit",
    "20",
  ];
  if (input.dryRun || !input.pollActions) {
    input.commands.push(commandStep("gh", args, false));
    return plannedWorkflowRun();
  }
  const result = input.commandRunner("gh", args, { cwd: input.repoRoot });
  input.commands.push(commandStep("gh", args, true, result));
  if (result.exitCode !== 0 || result.error) {
    return {
      workflowFile: CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
      source: "gh_cli",
      status: "unknown",
      error: result.error ?? result.stderr ?? "gh run list failed",
    };
  }
  try {
    return parseGhRunList(result.stdout, input.commitSha) ?? {
      workflowFile: CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
      source: "gh_cli",
      status: "unknown",
      error: "release workflow run not found",
    };
  } catch (error) {
    return {
      workflowFile: CODALI_PUBLISH_RELEASE_WORKFLOW_FILE,
      source: "gh_cli",
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const packageNamesFor = (
  releaseBuild: CodaliCandidateReleaseBuild,
  explicitPackageNames: readonly string[] | undefined,
): string[] =>
  explicitPackageNames?.length
    ? uniqueStrings([...explicitPackageNames])
    : uniqueStrings(
        releaseBuild.releasePlan.packageVersions.targets
          .filter((target) => !target.privatePackage)
          .map((target) => target.packageName),
      );

const resolveNpmVersions = (input: {
  dryRun: boolean;
  verifyNpm: boolean;
  repoRoot: string;
  packageNames: readonly string[];
  expectedVersion: string;
  registry: string;
  ingestedVersions?: readonly { packageName: string; version: string }[];
  commandRunner: CodaliCandidateReleaseCommandRunner;
  commands: CodaliPublishCommandStep[];
}): CodaliPublishNpmVersion[] => {
  const ingested = new Map(
    input.ingestedVersions?.map((item) => [item.packageName, item.version]) ?? [],
  );
  return input.packageNames.map((packageName) => {
    const args = ["view", packageName, "version", "--registry", input.registry];
    const ingestedVersion = ingested.get(packageName);
    if (ingestedVersion !== undefined) {
      return {
        packageName,
        expectedVersion: input.expectedVersion,
        registry: input.registry,
        observedVersion: ingestedVersion,
        status: ingestedVersion === input.expectedVersion ? "verified" : "mismatch",
        command: ["npm", ...args],
      };
    }
    if (input.dryRun || !input.verifyNpm) {
      input.commands.push(commandStep("npm", args, false));
      return {
        packageName,
        expectedVersion: input.expectedVersion,
        registry: input.registry,
        status: "planned",
        command: ["npm", ...args],
      };
    }
    const result = input.commandRunner("npm", args, { cwd: input.repoRoot });
    input.commands.push(commandStep("npm", args, true, result));
    if (result.exitCode !== 0 || result.error) {
      return {
        packageName,
        expectedVersion: input.expectedVersion,
        registry: input.registry,
        status: "unavailable",
        command: ["npm", ...args],
        error: result.error ?? result.stderr ?? "npm view failed",
      };
    }
    const observedVersion = result.stdout.trim();
    return {
      packageName,
      expectedVersion: input.expectedVersion,
      registry: input.registry,
      observedVersion,
      status: observedVersion === input.expectedVersion ? "verified" : "mismatch",
      command: ["npm", ...args],
    };
  });
};

const blockedReasonsFor = (input: {
  mode: CodaliPublishMode;
  releaseBuild: CodaliCandidateReleaseBuild;
  scorecard?: CodaliImprovementEvalRunnerResult;
  commitGuard: CodaliPublishCommitGuard;
  autoTagAllowed: boolean;
  publishStableAllowed: boolean;
}): string[] => uniqueStrings([
  ...input.releaseBuild.blockedReasons,
  input.mode === "auto_tag" && !input.autoTagAllowed ? "auto_tag_policy_blocked" : undefined,
  input.mode === "auto_tag" && !input.publishStableAllowed
    ? "stable_publish_policy_blocked"
    : undefined,
  input.mode === "auto_tag" && input.scorecard && !input.scorecard.releaseApproval.tagAllowed
    ? "scorecard_tag_blocked"
    : undefined,
  input.mode === "auto_tag" && input.scorecard && !input.scorecard.releaseApproval.publishAllowed
    ? "scorecard_publish_blocked"
    : undefined,
  input.mode === "auto_tag" && !input.scorecard ? "scorecard_required_for_auto_tag" : undefined,
  input.mode === "auto_tag" && input.commitGuard.status === "dirty"
    ? "candidate_commit_not_clean"
    : undefined,
  input.mode === "auto_tag" && input.commitGuard.status === "unavailable"
    ? "candidate_commit_guard_unavailable"
    : undefined,
  ...input.commitGuard.reasons,
]);

const runAutoTag = (input: {
  dryRun: boolean;
  repoRoot: string;
  tagName: string;
  tagMessage: string;
  commitSha?: string;
  blockedReasons: readonly string[];
  commandRunner: CodaliCandidateReleaseCommandRunner;
  commands: CodaliPublishCommandStep[];
}): string[] => {
  if (input.blockedReasons.length > 0 || !input.commitSha) {
    input.commands.push(commandStep("git", ["tag", "-a", input.tagName, input.commitSha ?? "HEAD", "-m", input.tagMessage], false));
    input.commands.push(commandStep("git", ["push", "origin", input.tagName], false));
    return [];
  }
  const tagArgs = ["tag", "-a", input.tagName, input.commitSha, "-m", input.tagMessage];
  const pushArgs = ["push", "origin", input.tagName];
  if (input.dryRun) {
    input.commands.push(commandStep("git", tagArgs, false));
    input.commands.push(commandStep("git", pushArgs, false));
    return [];
  }
  const tagResult = input.commandRunner("git", tagArgs, { cwd: input.repoRoot });
  input.commands.push(commandStep("git", tagArgs, true, tagResult));
  if (tagResult.exitCode !== 0 || tagResult.error) {
    return ["tag_create_failed"];
  }
  const pushResult = input.commandRunner("git", pushArgs, { cwd: input.repoRoot });
  input.commands.push(commandStep("git", pushArgs, true, pushResult));
  return pushResult.exitCode === 0 && !pushResult.error
    ? []
    : ["tag_push_failed"];
};

const statusFor = (input: {
  mode: CodaliPublishMode;
  dryRun: boolean;
  blockedReasons: readonly string[];
  tagErrors: readonly string[];
  workflowRun: CodaliPublishWorkflowRunStatus;
  npmVersions: readonly CodaliPublishNpmVersion[];
}): CodaliPublishStatus => {
  if (input.blockedReasons.length > 0) return "blocked";
  if (input.tagErrors.length > 0) return "failed";
  if (
    input.workflowRun.status === "completed" &&
    input.workflowRun.conclusion !== undefined &&
    input.workflowRun.conclusion !== "success"
  ) {
    return "workflow_failed";
  }
  if (input.npmVersions.some((item) => item.status === "mismatch" || item.status === "unavailable")) {
    return "workflow_failed";
  }
  if (input.workflowRun.status === "completed" && input.workflowRun.conclusion === "success") {
    return input.npmVersions.length > 0 && input.npmVersions.every((item) => item.status === "verified")
      ? "published_verified"
      : "workflow_succeeded";
  }
  if (input.workflowRun.status === "queued" || input.workflowRun.status === "in_progress") {
    return "workflow_queued";
  }
  if (input.mode === "auto_tag" && !input.dryRun) return "tagged";
  return "planned";
};

const outcomeStatusFor = (status: CodaliPublishStatus): CodaliImprovementOutcome["status"] => {
  if (status === "blocked") return "blocked";
  if (status === "failed" || status === "workflow_failed") return "failed";
  if (status === "published_verified") return "succeeded";
  return "succeeded";
};

export const runCodaliPublishOrchestrator = async (
  input: RunCodaliPublishOrchestratorInput,
): Promise<CodaliPublishResult> => {
  const dryRun = input.dryRun ?? true;
  const mode = input.mode ?? "branch_only";
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const commandRunner = input.commandRunner ?? defaultCommandRunner;
  const now = input.now ?? (() => new Date());
  const candidateDirectories = normalizeCandidateDirectories(repoRoot, input.candidateDirectories);
  const releaseBuild = await buildCodaliCandidateReleasePlan({
    candidateId: input.candidateId,
    candidatePath: input.candidatePath,
    candidateDirectories,
    repoRoot,
    scope: input.scope,
    releaseLevel: input.releaseLevel,
    dryRun: true,
    runId: input.runId,
    candidateDate: input.candidateDate,
    dirtyEntries: input.dirtyEntries,
    commandRunner,
  });
  const scope = releaseScopeFor(releaseBuild, input.scope);
  const releaseLevel = releaseLevelFor(releaseBuild, input.releaseLevel);
  const policy = input.policy ?? createPublishPolicy({
    releaseLevel,
    scope,
    autoTagEnabled: input.autoTagEnabled ?? false,
    autoPublishEnabled: input.autoPublishEnabled ?? false,
  });
  const policyDecisions = {
    autoTag: evaluateCodaliImprovementPolicy(policy, {
      action: "auto_tag",
      releaseLevel,
      scope,
      artifactType: "prerelease_tag",
    }),
    publishStable: evaluateCodaliImprovementPolicy(policy, {
      action: "publish_stable",
      releaseLevel,
      scope,
      artifactType: "stable_npm_release",
    }),
  };
  const scorecard = mode === "auto_tag"
    ? input.scorecard ?? await buildCodaliImprovementEvalScorecard({
        candidateId: input.candidateId,
        candidatePath: input.candidatePath,
        candidateDirectories,
        approvedPaths: releaseBuild.candidateWorkspace.approvedPaths,
        now,
      })
    : input.scorecard;
  const commitGuard = readCommitGuard({
    repoRoot,
    required: mode === "auto_tag",
    commitSha: input.commitSha,
    dirtyEntries: input.dirtyEntries,
    commandRunner,
  });
  const commands: CodaliPublishCommandStep[] = [];
  const initialBlockedReasons = blockedReasonsFor({
    mode,
    releaseBuild,
    scorecard,
    commitGuard,
    autoTagAllowed: policyDecisions.autoTag.allowed,
    publishStableAllowed: policyDecisions.publishStable.allowed,
  });
  const tagErrors = mode === "auto_tag"
    ? runAutoTag({
        dryRun,
        repoRoot,
        tagName: releaseBuild.releasePlan.futureTag,
        tagMessage: releaseBuild.releasePlan.tag.message,
        commitSha: commitGuard.commitSha,
        blockedReasons: initialBlockedReasons,
        commandRunner,
        commands,
      })
    : [];
  const workflowRun = resolveWorkflowRun({
    dryRun,
    pollActions: input.pollActions ?? false,
    repoRoot,
    commitSha: commitGuard.commitSha,
    workflowRun: input.workflowRun,
    commandRunner,
    commands,
  });
  const packageNames = packageNamesFor(releaseBuild, input.npmPackages);
  const npmVersions = resolveNpmVersions({
    dryRun,
    verifyNpm: input.verifyNpm ?? (workflowRun.status === "completed" && workflowRun.conclusion === "success"),
    repoRoot,
    packageNames,
    expectedVersion: releaseBuild.releasePlan.version,
    registry: input.npmRegistry ?? DEFAULT_CODALI_PUBLISH_NPM_REGISTRY,
    ingestedVersions: input.npmVersions,
    commandRunner,
    commands,
  });
  const blockedReasons = uniqueStrings([...initialBlockedReasons, ...tagErrors]);
  const status = statusFor({
    mode,
    dryRun,
    blockedReasons,
    tagErrors,
    workflowRun,
    npmVersions,
  });
  const outcome: CodaliImprovementOutcome = {
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    outcomeId: stableId("publish-outcome", {
      candidateId: input.candidateId,
      mode,
      status,
      tagName: releaseBuild.releasePlan.futureTag,
      commitSha: commitGuard.commitSha,
      workflowRunId: workflowRun.runId,
      npmVersions,
    }),
    releaseId: releaseBuild.release.releaseId,
    scope,
    status: outcomeStatusFor(status),
    published: status === "published_verified",
    tagged: status === "tagged" || status === "workflow_queued" ||
      status === "workflow_succeeded" || status === "published_verified",
    trainingUsed: false,
    exportUsed: false,
    createdAt: now().toISOString(),
    ...(blockedReasons.length ? { reasons: blockedReasons } : {}),
    metadata: {
      schemaVersion: CODALI_PUBLISH_ORCHESTRATOR_SCHEMA_VERSION,
      dryRun,
      mode,
      status,
      releaseWorkflow: publisher(),
      branchName: releaseBuild.candidateWorkspace.branchName,
      tagName: releaseBuild.releasePlan.futureTag,
      commitSha: commitGuard.commitSha,
      workflowRunId: workflowRun.runId,
      workflowRun,
      npmVersions,
      commitGuard,
      policyDecisions,
      scorecardStatus: scorecard?.scorecard.status,
      releaseApproval: scorecard?.releaseApproval,
      commands,
      blockedReasons,
    },
  };
  return {
    schemaVersion: CODALI_PUBLISH_ORCHESTRATOR_SCHEMA_VERSION,
    dryRun,
    mode,
    status,
    candidateId: input.candidateId,
    releaseBuild,
    scorecard,
    policy,
    policyDecisions,
    publisher: publisher(),
    commitGuard,
    workflowRun,
    npmVersions,
    commands,
    blockedReasons,
    outcome,
  };
};

export const writeCodaliPublishToStorageService = async (
  input: WriteCodaliPublishToStorageInput,
): Promise<Array<StorageServiceImprovementWriteResult<unknown>>> => {
  const metadata = input.result.outcome.metadata ?? {};
  const runWrite = await input.client.recordRun({
    scope: input.scope,
    idempotencyKey: `improvement-publish:${input.result.candidateId}:${input.result.releaseBuild.releasePlan.futureTag}`,
    body: {
      improvement_run_id: input.scope.runId,
      run_kind: "release_publish",
      status: input.result.outcome.status === "blocked"
        ? "blocked"
        : input.result.outcome.status === "failed"
          ? "failed"
          : "completed",
      source_export_id: input.result.candidateId,
      metadata: {
        ...metadata,
        tagName: input.result.releaseBuild.releasePlan.futureTag,
        commitSha: input.result.commitGuard.commitSha,
        workflowRunId: input.result.workflowRun.runId,
        npmVersions: input.result.npmVersions,
        status: input.result.status,
      },
    },
  });
  const candidateWrite = await input.client.recordCandidate({
    scope: input.scope,
    idempotencyKey: `improvement-publish-candidate:${input.result.candidateId}:${input.result.releaseBuild.releasePlan.futureTag}`,
    body: {
      candidate_id: input.result.candidateId,
      improvement_run_id: input.scope.runId,
      source_export_id: input.result.candidateId,
      source_record_ids: [],
      candidate_kind: "release",
      candidate_ref: input.result.releaseBuild.releasePlan.futureTag,
      status: input.result.outcome.published
        ? "released"
        : input.result.outcome.status === "blocked"
          ? "blocked"
          : "accepted",
      metadata: {
        ...metadata,
        releaseId: input.result.releaseBuild.release.releaseId,
        tagName: input.result.releaseBuild.releasePlan.futureTag,
        commitSha: input.result.commitGuard.commitSha,
        workflowRunId: input.result.workflowRun.runId,
        npmVersions: input.result.npmVersions,
        status: input.result.status,
      },
    },
  });
  return [runWrite, candidateWrite];
};
