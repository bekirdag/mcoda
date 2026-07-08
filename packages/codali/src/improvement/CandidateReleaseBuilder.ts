import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  type CodaliImprovementRelease,
  type CodaliImprovementReleaseLevel,
  type CodaliImprovementReleaseStatus,
  type CodaliImprovementScope,
} from "./ImprovementPolicy.js";
import type { DatasetExportManifestReaderResult } from "./DatasetExportManifestReader.js";
import {
  CODALI_PATCH_CANDIDATE_SCHEMA_VERSION,
  CODALI_PATCH_PROPOSAL_ARTIFACTS,
  buildCodaliPatchCandidateBundle,
  type CodaliPatchCandidateBundle,
  type CodaliPatchProposalArtifact,
} from "./PromptSchemaToolMetadataCandidateBuilder.js";

export const CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION =
  "codali.improvement.candidate_release.v1" as const;

export const CODALI_CANDIDATE_RELEASE_PLAN_SCHEMA_VERSION =
  "codali.improvement.release_plan.v1" as const;

export const DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS = [
  ".codali/improvement/",
] as const;

export const DEFAULT_CODALI_CANDIDATE_RELEASE_DIRECTORIES = [
  ".codali/improvement/candidates",
] as const;

export type CodaliCandidateReleaseGeneratedArtifactKind =
  | "candidate_release"
  | "package_version"
  | "release_manifest";

export type CodaliCandidateReleaseSemverBump = "patch" | "minor" | "major";

export type CodaliCandidateReleaseWriteStatus =
  | "dry_run"
  | "ready"
  | "written"
  | "blocked";

export interface CodaliCandidateReleaseCommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
  error?: string;
}

export type CodaliCandidateReleaseCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => CodaliCandidateReleaseCommandResult;

export interface CodaliCandidateReleaseDirtyEntry {
  status: string;
  path: string;
}

export interface CodaliCandidateReleaseGeneratedArtifact {
  artifactId: string;
  artifactKind: CodaliCandidateReleaseGeneratedArtifactKind;
  schemaVersion: typeof CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION;
  sourceExportIds: string[];
  sourceSchemaVersions: {
    candidateRelease: typeof CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION;
    patchCandidate: typeof CODALI_PATCH_CANDIDATE_SCHEMA_VERSION;
    storageManifest: string;
  };
  relativePath: string;
  contentHash: string;
  byteSize: number;
}

export interface CodaliCandidateReleaseWriteTarget {
  relativePath: string;
  content: string;
  artifact: CodaliCandidateReleaseGeneratedArtifact;
}

export interface CodaliCandidateReleaseWritePlan {
  status: CodaliCandidateReleaseWriteStatus;
  dryRun: boolean;
  repoRoot: string;
  approvedPaths: string[];
  targets: Array<{
    relativePath: string;
    approved: boolean;
    dirty: boolean;
    contentHash: string;
    byteSize: number;
  }>;
  blockedReasons: string[];
}

export interface CodaliCandidateReleaseWorkspace {
  workspaceId: string;
  branchName: string;
  branchPrefix: "codali/auto-improve";
  candidateDate: string;
  runId: string;
  discardable: true;
  dryRunOnly: boolean;
  defaultApprovedPaths: readonly string[];
  approvedPaths: string[];
  targetDirectory: string;
  patchOutput: string;
  discardInstructions: string[];
}

export interface CodaliCandidateReleaseDirtySummary {
  status: "clean" | "dirty" | "unavailable";
  dirtyFileCount: number;
  targetDirtyFiles: string[];
  unrelatedDirtyFileCount: number;
  unrelatedDirtyFilesSample: string[];
  warning?: string;
}

export interface CodaliCandidateReleasePlanGate {
  gateId: string;
  status: "passed" | "blocked" | "warning" | "skipped";
  reasons: string[];
}

export interface CodaliCandidateReleasePackageVersionTarget {
  packageName: string;
  relativePath: string;
  currentVersion: string;
  plannedVersion: string;
  privatePackage: boolean;
}

export interface CodaliCandidateReleaseChangelogNotes {
  sourceExportIds: string[];
  changedArtifactClasses: string[];
  evalDeltas: {
    status: "provided" | "not_provided";
    summary: string;
    metrics: Record<string, number>;
  };
  privacySummary: {
    status: "provided" | "not_provided";
    recordCount?: number;
    containsCustomerData?: boolean;
    containsSecrets?: boolean;
    exportAllowedCount?: number;
    trainingAllowedCount?: number;
    policyTags?: string[];
  };
  rollback: string[];
  notes: string[];
  rawCustomerDataIncluded: false;
}

export interface CodaliCandidateReleasePlan {
  schemaVersion: typeof CODALI_CANDIDATE_RELEASE_PLAN_SCHEMA_VERSION;
  dryRun: boolean;
  candidateId: string;
  releaseId: string;
  storageServiceReleaseId: string;
  semverBump: CodaliCandidateReleaseSemverBump;
  version: string;
  futureTag: string;
  branch: {
    name: string;
    discardable: true;
  };
  commit: {
    message: string;
    files: string[];
    rawCustomerDataIncluded: false;
  };
  tag: {
    name: string;
    message: string;
    matchesPackageVersions: boolean;
    rawCustomerDataIncluded: false;
  };
  gates: CodaliCandidateReleasePlanGate[];
  rollback: {
    commands: string[];
    packageVersions: CodaliCandidateReleasePackageVersionTarget[];
  };
  packageVersions: {
    currentVersion: string;
    plannedVersion: string;
    futureTag: string;
    matchesFutureTag: boolean;
    targets: CodaliCandidateReleasePackageVersionTarget[];
  };
  changelog: CodaliCandidateReleaseChangelogNotes;
}

export interface CodaliCandidateReleaseBuild {
  schemaVersion: typeof CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION;
  dryRun: boolean;
  release: CodaliImprovementRelease;
  releasePlan: CodaliCandidateReleasePlan;
  candidateWorkspace: CodaliCandidateReleaseWorkspace;
  writePlan: CodaliCandidateReleaseWritePlan;
  dirtyWorktree: CodaliCandidateReleaseDirtySummary;
  generatedArtifacts: CodaliCandidateReleaseGeneratedArtifact[];
  proposals: CodaliPatchCandidateBundle[];
  patchOutput: string;
  blockedReasons: string[];
}

export interface BuildCodaliCandidateReleaseInput {
  inspection: DatasetExportManifestReaderResult;
  artifacts?: readonly CodaliPatchProposalArtifact[];
  repoRoot?: string;
  scope?: CodaliImprovementScope;
  releaseLevel?: CodaliImprovementReleaseLevel;
  dryRun?: boolean;
  runId?: string;
  candidateDate?: string;
  candidateId?: string;
  candidatePath?: string;
  candidateDirectories?: readonly string[];
  outputPath?: string;
  approvedPaths?: readonly string[];
  now?: () => Date;
  dirtyEntries?: readonly CodaliCandidateReleaseDirtyEntry[];
  commandRunner?: CodaliCandidateReleaseCommandRunner;
}

export interface BuildCodaliCandidateReleasePlanInput {
  candidateId: string;
  candidatePath?: string;
  candidateDirectories?: readonly string[];
  repoRoot?: string;
  scope?: CodaliImprovementScope;
  releaseLevel?: CodaliImprovementReleaseLevel;
  dryRun?: boolean;
  runId?: string;
  candidateDate?: string;
  now?: () => Date;
  dirtyEntries?: readonly CodaliCandidateReleaseDirtyEntry[];
  commandRunner?: CodaliCandidateReleaseCommandRunner;
}

export class CodaliCandidateReleaseBuilderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CodaliCandidateReleaseBuilderError";
    this.code = code;
  }
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const hashJson = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const hashContent = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const stableId = (prefix: string, value: unknown): string =>
  `${prefix}-${hashJson(value).slice(0, 16)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const uniqueSortedStrings = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0))).sort();

const nestedRecord = (
  record: Record<string, unknown> | undefined,
  pathSegments: readonly string[],
): Record<string, unknown> | undefined => {
  let current: unknown = record;
  for (const segment of pathSegments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return isRecord(current) ? current : undefined;
};

const readJsonRecord = async (filePath: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_JSON_RECORD_REQUIRED",
      `Expected JSON object at ${filePath}.`,
    );
  }
  return parsed;
};

const formatJsonRecord = (record: Record<string, unknown>): string =>
  `${JSON.stringify(record, null, 2)}\n`;

const semverParts = (version: string): { major: number; minor: number; patch: number } => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_INVALID_VERSION",
      `Package version must be semver-compatible: ${version}`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

const bumpSemver = (
  version: string,
  bump: CodaliCandidateReleaseSemverBump,
): string => {
  const parts = semverParts(version);
  if (bump === "major") return `${parts.major + 1}.0.0`;
  if (bump === "minor") return `${parts.major}.${parts.minor + 1}.0`;
  return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
};

const artifactClassForProposal = (artifact: string): string => {
  if (artifact === "prompt") return "prompt_patch";
  if (artifact === "schema") return "schema_patch";
  if (artifact === "tool-metadata") return "tool_metadata_patch";
  if (artifact === "eval") return "eval_replay_fixture";
  if (artifact === "model-router") return "model_router";
  if (artifact === "docdex-retrieval") return "docdex_retrieval";
  return artifact.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
};

const semverBumpForArtifactClasses = (
  changedArtifactClasses: readonly string[],
): CodaliCandidateReleaseSemverBump => {
  if (changedArtifactClasses.some((item) => item.includes("breaking") || item === "major")) {
    return "major";
  }
  if (changedArtifactClasses.some((item) =>
    item === "schema_patch" ||
    item === "tool_metadata_patch" ||
    item.includes("contract"))) {
    return "minor";
  }
  return "patch";
};

interface PackageManifestRecord {
  packageName: string;
  relativePath: string;
  version: string;
  privatePackage: boolean;
  raw: Record<string, unknown>;
}

const packageManifestCandidates = async (repoRoot: string): Promise<string[]> => {
  const candidates = ["package.json"];
  const packagesRoot = path.join(repoRoot, "packages");
  try {
    const entries = await readdir(packagesRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        candidates.push(toPosixPath(path.join("packages", entry.name, "package.json")));
      }
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  return candidates;
};

const readPackageManifests = async (repoRoot: string): Promise<PackageManifestRecord[]> => {
  const manifests: PackageManifestRecord[] = [];
  for (const relativePath of await packageManifestCandidates(repoRoot)) {
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const raw = await readJsonRecord(absolutePath);
      const packageName = typeof raw.name === "string" ? raw.name : undefined;
      const version = typeof raw.version === "string" ? raw.version : undefined;
      if (!packageName || !version) continue;
      manifests.push({
        packageName,
        relativePath,
        version,
        privatePackage: raw.private === true,
        raw,
      });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return manifests.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};

const releasePleaseManifestTarget = async (input: {
  repoRoot: string;
  plannedVersion: string;
  sourceExportIds: string[];
  storageManifestVersion: string;
}): Promise<CodaliCandidateReleaseWriteTarget | undefined> => {
  const relativePath = ".release-please-manifest.json";
  const absolutePath = path.join(input.repoRoot, relativePath);
  try {
    const raw = await readJsonRecord(absolutePath);
    const updated = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        typeof value === "string" ? input.plannedVersion : value,
      ]),
    );
    const content = formatJsonRecord(updated);
    return {
      relativePath,
      content,
      artifact: generatedArtifactForContent({
        artifactKind: "release_manifest",
        relativePath,
        content,
        sourceExportIds: input.sourceExportIds,
        storageManifestVersion: input.storageManifestVersion,
      }),
    };
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
};

const generatedArtifactForContent = (input: {
  artifactKind: CodaliCandidateReleaseGeneratedArtifactKind;
  relativePath: string;
  content: string;
  sourceExportIds: string[];
  storageManifestVersion: string;
}): CodaliCandidateReleaseGeneratedArtifact => {
  const contentHash = hashContent(input.content);
  return {
    artifactId: `${input.artifactKind}-${contentHash.slice(0, 16)}`,
    artifactKind: input.artifactKind,
    schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
    sourceExportIds: input.sourceExportIds,
    sourceSchemaVersions: {
      candidateRelease: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
      patchCandidate: CODALI_PATCH_CANDIDATE_SCHEMA_VERSION,
      storageManifest: input.storageManifestVersion,
    },
    relativePath: input.relativePath,
    contentHash,
    byteSize: Buffer.byteLength(input.content, "utf8"),
  };
};

const packageVersionTargetsFor = async (input: {
  repoRoot: string;
  semverBump: CodaliCandidateReleaseSemverBump;
  sourceExportIds: string[];
  storageManifestVersion: string;
}): Promise<{
  currentVersion: string;
  plannedVersion: string;
  targets: CodaliCandidateReleasePackageVersionTarget[];
  writeTargets: CodaliCandidateReleaseWriteTarget[];
}> => {
  const manifests = await readPackageManifests(input.repoRoot);
  if (!manifests.length) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_PACKAGE_MANIFESTS_MISSING",
      "No package.json manifests with name and version were found.",
    );
  }
  const rootVersion = manifests.find((manifest) => manifest.relativePath === "package.json")?.version ??
    manifests[0]?.version;
  if (!rootVersion) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_ROOT_VERSION_MISSING",
      "Unable to determine the current workspace version.",
    );
  }
  const plannedVersion = bumpSemver(rootVersion, input.semverBump);
  const targets = manifests.map((manifest) => ({
    packageName: manifest.packageName,
    relativePath: manifest.relativePath,
    currentVersion: manifest.version,
    plannedVersion,
    privatePackage: manifest.privatePackage,
  }));
  const writeTargets = manifests.map((manifest) => {
    const content = formatJsonRecord({
      ...manifest.raw,
      version: plannedVersion,
    });
    return {
      relativePath: manifest.relativePath,
      content,
      artifact: generatedArtifactForContent({
        artifactKind: "package_version",
        relativePath: manifest.relativePath,
        content,
        sourceExportIds: input.sourceExportIds,
        storageManifestVersion: input.storageManifestVersion,
      }),
    };
  });
  const releasePleaseTarget = await releasePleaseManifestTarget({
    repoRoot: input.repoRoot,
    plannedVersion,
    sourceExportIds: input.sourceExportIds,
    storageManifestVersion: input.storageManifestVersion,
  });
  return {
    currentVersion: rootVersion,
    plannedVersion,
    targets,
    writeTargets: releasePleaseTarget
      ? [...writeTargets, releasePleaseTarget]
      : writeTargets,
  };
};

const sanitizeBranchSegment = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "run";
};

const dateFromInspection = (
  inspection: DatasetExportManifestReaderResult,
  fallback: () => Date,
): string => {
  const candidate = inspection.manifest.createdAt;
  const parsed = candidate ? new Date(candidate) : undefined;
  if (parsed && Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return fallback().toISOString().slice(0, 10);
};

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const normalizeRepoRelativePath = (
  repoRoot: string,
  candidatePath: string,
): string => {
  if (!candidatePath.trim()) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_EMPTY_PATH",
      "Candidate write path cannot be empty.",
    );
  }
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(repoRoot, candidatePath);
  const relative = toPosixPath(path.relative(repoRoot, resolved));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_PATH_OUTSIDE_REPO",
      `Candidate write path must stay inside the repo: ${candidatePath}`,
    );
  }
  if (relative === ".git" || relative.startsWith(".git/")) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_GIT_PATH_BLOCKED",
      "Candidate writer cannot target .git paths.",
    );
  }
  return relative;
};

const normalizeApprovedPath = (
  repoRoot: string,
  candidatePath: string,
): { path: string; directory: boolean } => {
  const directory = candidatePath.endsWith("/") || candidatePath.endsWith(path.sep);
  const relative = normalizeRepoRelativePath(repoRoot, candidatePath);
  return {
    path: directory && !relative.endsWith("/") ? `${relative}/` : relative,
    directory,
  };
};

const isApprovedRelativePath = (
  relativePath: string,
  approvedPaths: readonly { path: string; directory: boolean }[],
): boolean =>
  approvedPaths.some((approved) =>
    approved.directory
      ? relativePath.startsWith(approved.path)
      : relativePath === approved.path);

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

const isNotFoundError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );

const pathIsInsideOrEqual = (rootPath: string, candidatePath: string): boolean => {
  const relative = path.relative(rootPath, candidatePath);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const findExistingWritePath = async (absolutePath: string): Promise<string> => {
  let current = absolutePath;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
};

const assertWriteTargetsInsideRepo = async (input: {
  repoRoot: string;
  targets: readonly CodaliCandidateReleaseWriteTarget[];
}): Promise<void> => {
  const repoRealPath = await realpath(input.repoRoot);
  for (const target of input.targets) {
    const absolute = path.join(input.repoRoot, target.relativePath);
    const existingPath = await findExistingWritePath(absolute);
    const existingRealPath = await realpath(existingPath);
    if (!pathIsInsideOrEqual(repoRealPath, existingRealPath)) {
      throw new CodaliCandidateReleaseBuilderError(
        "CODALI_CANDIDATE_RELEASE_PATH_OUTSIDE_REPO",
        `Candidate write path must not resolve outside the repo: ${target.relativePath}`,
      );
    }
  }
};

const readDirtyEntries = (
  repoRoot: string,
  commandRunner: CodaliCandidateReleaseCommandRunner,
): { entries: CodaliCandidateReleaseDirtyEntry[]; warning?: string } => {
  const result = commandRunner("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (result.exitCode !== 0 || result.error) {
    return {
      entries: [],
      warning: result.error ?? result.stderr ?? "git status unavailable",
    };
  }
  return { entries: parseGitStatus(result.stdout) };
};

const dirtySummaryFor = (
  entries: readonly CodaliCandidateReleaseDirtyEntry[],
  targetPaths: readonly string[],
  warning?: string,
): CodaliCandidateReleaseDirtySummary => {
  if (warning) {
    return {
      status: "unavailable",
      dirtyFileCount: 0,
      targetDirtyFiles: [],
      unrelatedDirtyFileCount: 0,
      unrelatedDirtyFilesSample: [],
      warning,
    };
  }
  const targetSet = new Set(targetPaths);
  const dirtyPaths = Array.from(new Set(entries.map((entry) => entry.path))).sort();
  const targetDirtyFiles = dirtyPaths.filter((item) => targetSet.has(item));
  const unrelatedDirtyFiles = dirtyPaths.filter((item) => !targetSet.has(item));
  return {
    status: dirtyPaths.length ? "dirty" : "clean",
    dirtyFileCount: dirtyPaths.length,
    targetDirtyFiles,
    unrelatedDirtyFileCount: unrelatedDirtyFiles.length,
    unrelatedDirtyFilesSample: unrelatedDirtyFiles.slice(0, 20),
  };
};

const unifiedDiffForNewFile = (relativePath: string, content: string): string => {
  const lines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
};

const releaseStatusFor = (
  dryRun: boolean,
  blockedReasons: readonly string[],
): CodaliImprovementReleaseStatus => {
  if (blockedReasons.length > 0) return "blocked";
  return dryRun ? "planned" : "created";
};

const buildGeneratedArtifactPayload = (input: {
  inspection: DatasetExportManifestReaderResult;
  proposals: readonly CodaliPatchCandidateBundle[];
  workspaceId: string;
  branchName: string;
  candidateId: string;
  createdAt: string;
  sourceExportIds: string[];
  changedArtifactClasses: string[];
}) => ({
  schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
  artifactKind: "candidate_release",
  generatedBy: "codali improve build-release",
  generatedAt: input.createdAt,
  candidateId: input.candidateId,
  sourceExportIds: input.sourceExportIds,
  sourceSchemaVersions: {
    candidateRelease: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
    patchCandidate: CODALI_PATCH_CANDIDATE_SCHEMA_VERSION,
    storageManifest: input.inspection.manifest.schemaVersion,
  },
  workspace: {
    workspaceId: input.workspaceId,
    branchName: input.branchName,
    discardable: true,
  },
  sourceManifest: {
    exportId: input.inspection.exportId,
    manifestId: input.inspection.manifest.manifestId,
    manifestPath: input.inspection.manifestPath,
    exportKind: input.inspection.manifest.exportKind,
    checksum: input.inspection.manifest.checksum,
    recordCount: input.inspection.manifest.recordCount,
    privacySummary: privacySummaryFor(input.inspection.manifest.privacySummary),
  },
  changedArtifactClasses: input.changedArtifactClasses,
  proposals: input.proposals,
});

const privacySummaryFor = (
  value: unknown,
): CodaliCandidateReleaseChangelogNotes["privacySummary"] => {
  const record = isRecord(value) ? value : undefined;
  if (!record) return { status: "not_provided" };
  const output: CodaliCandidateReleaseChangelogNotes["privacySummary"] = {
    status: "provided",
  };
  if (typeof record.recordCount === "number") output.recordCount = record.recordCount;
  if (typeof record.containsCustomerData === "boolean") {
    output.containsCustomerData = record.containsCustomerData;
  }
  if (typeof record.containsSecrets === "boolean") output.containsSecrets = record.containsSecrets;
  if (typeof record.exportAllowedCount === "number") {
    output.exportAllowedCount = record.exportAllowedCount;
  }
  if (typeof record.trainingAllowedCount === "number") {
    output.trainingAllowedCount = record.trainingAllowedCount;
  }
  const policyTags = stringArray(record.policyTags);
  if (policyTags.length) output.policyTags = policyTags;
  return output;
};

const evalDeltasFor = (
  value: unknown,
): CodaliCandidateReleaseChangelogNotes["evalDeltas"] => {
  const record = isRecord(value) ? value : undefined;
  const evalDeltas = nestedRecord(record, ["evalDeltas"]) ??
    nestedRecord(record, ["metadata", "evalDeltas"]) ??
    nestedRecord(record, ["release", "metadata", "evalDeltas"]);
  if (!evalDeltas) {
    return {
      status: "not_provided",
      summary: "No eval delta evidence was attached to this release candidate.",
      metrics: {},
    };
  }
  const metrics = Object.fromEntries(
    Object.entries(evalDeltas)
      .filter(([, item]) => typeof item === "number" && Number.isFinite(item)),
  ) as Record<string, number>;
  return {
    status: Object.keys(metrics).length ? "provided" : "not_provided",
    summary: Object.keys(metrics).length
      ? "Eval delta metrics are present as numeric aggregate values."
      : "Eval delta evidence was present but did not include numeric aggregate metrics.",
    metrics,
  };
};

const changedArtifactClassesFor = (
  proposals: readonly { artifact: string }[],
): string[] => uniqueSortedStrings(proposals.map((proposal) =>
  artifactClassForProposal(proposal.artifact)));

const changedArtifactClassesFromRecord = (
  record: Record<string, unknown> | undefined,
): string[] => {
  const proposals = record?.proposals ??
    nestedRecord(record, ["release", "metadata"])?.proposalSummary ??
    nestedRecord(record, ["metadata"])?.proposalSummary;
  const artifacts: string[] = [];
  if (Array.isArray(proposals)) {
    for (const proposal of proposals) {
      if (isRecord(proposal) && typeof proposal.artifact === "string") {
        artifacts.push(artifactClassForProposal(proposal.artifact));
      }
    }
  }
  artifacts.push(...stringArray(record?.changedArtifactClasses));
  return uniqueSortedStrings(artifacts);
};

const sourceExportIdsFromRecord = (
  record: Record<string, unknown> | undefined,
): string[] => uniqueSortedStrings([
  ...stringArray(record?.sourceExportIds),
  ...stringArray(nestedRecord(record, ["metadata"])?.sourceExportIds),
  ...stringArray(nestedRecord(record, ["release", "metadata"])?.sourceExportIds),
  typeof nestedRecord(record, ["sourceManifest"])?.exportId === "string"
    ? nestedRecord(record, ["sourceManifest"])?.exportId as string
    : undefined,
  typeof nestedRecord(record, ["sourceManifest"])?.manifestId === "string"
    ? nestedRecord(record, ["sourceManifest"])?.manifestId as string
    : undefined,
]);

const privacySummaryFromRecord = (
  record: Record<string, unknown> | undefined,
): CodaliCandidateReleaseChangelogNotes["privacySummary"] => {
  const sourceManifest = nestedRecord(record, ["sourceManifest"]);
  const candidate = record?.privacySummary ??
    sourceManifest?.privacySummary ??
    nestedRecord(record, ["metadata"])?.privacySummary ??
    nestedRecord(record, ["release", "metadata"])?.privacySummary;
  return privacySummaryFor(candidate);
};

const buildReleasePlan = (input: {
  dryRun: boolean;
  candidateId: string;
  releaseId: string;
  branchName: string;
  sourceExportIds: string[];
  changedArtifactClasses: string[];
  semverBump: CodaliCandidateReleaseSemverBump;
  currentVersion: string;
  plannedVersion: string;
  packageVersionTargets: CodaliCandidateReleasePackageVersionTarget[];
  changedFiles: string[];
  writePlan: CodaliCandidateReleaseWritePlan;
  blockedReasons: string[];
  privacySummary: CodaliCandidateReleaseChangelogNotes["privacySummary"];
  evalDeltas: CodaliCandidateReleaseChangelogNotes["evalDeltas"];
}): CodaliCandidateReleasePlan => {
  const futureTag = `v${input.plannedVersion}`;
  const storageServiceReleaseId = stableId("storage-service-release", {
    candidateId: input.candidateId,
    releaseId: input.releaseId,
    futureTag,
    sourceExportIds: input.sourceExportIds,
  });
  const packageVersionsMatch = input.packageVersionTargets.every((target) =>
    target.plannedVersion === input.plannedVersion);
  const rollbackCommands = [
    `git tag -d ${futureTag}`,
    `git branch -D ${input.branchName}`,
    `git restore ${input.packageVersionTargets.map((target) => target.relativePath).join(" ")}`,
  ];
  const gates: CodaliCandidateReleasePlanGate[] = [
    {
      gateId: "package_versions_match_future_tag",
      status: packageVersionsMatch ? "passed" : "blocked",
      reasons: packageVersionsMatch ? [] : ["planned_package_version_mismatch"],
    },
    {
      gateId: "storage_service_release_id_present",
      status: storageServiceReleaseId ? "passed" : "blocked",
      reasons: storageServiceReleaseId ? [] : ["storage_service_release_id_missing"],
    },
    {
      gateId: "raw_customer_data_absent",
      status: "passed",
      reasons: [],
    },
    {
      gateId: "dry_run_no_file_changes",
      status: input.dryRun ? "passed" : "skipped",
      reasons: input.dryRun ? [] : ["non_dry_run_writes_guarded_by_write_plan"],
    },
    {
      gateId: "write_plan_clear",
      status: input.blockedReasons.length ? "blocked" : "passed",
      reasons: input.blockedReasons,
    },
  ];
  const changelog: CodaliCandidateReleaseChangelogNotes = {
    sourceExportIds: input.sourceExportIds,
    changedArtifactClasses: input.changedArtifactClasses,
    evalDeltas: input.evalDeltas,
    privacySummary: input.privacySummary,
    rollback: rollbackCommands,
    rawCustomerDataIncluded: false,
    notes: [
      `Release ${futureTag} is planned from candidate ${input.candidateId}.`,
      `Source export ids: ${input.sourceExportIds.length ? input.sourceExportIds.join(", ") : "not_provided"}.`,
      `Changed artifact classes: ${input.changedArtifactClasses.length ? input.changedArtifactClasses.join(", ") : "not_provided"}.`,
      `Eval deltas: ${input.evalDeltas.summary}`,
      input.privacySummary.status === "provided"
        ? `Privacy summary: records=${input.privacySummary.recordCount ?? "unknown"} customerData=${String(input.privacySummary.containsCustomerData ?? "unknown")} secrets=${String(input.privacySummary.containsSecrets ?? "unknown")}.`
        : "Privacy summary: not_provided.",
      `Rollback: delete ${futureTag}, delete branch ${input.branchName}, and restore planned package version files.`,
    ],
  };
  return {
    schemaVersion: CODALI_CANDIDATE_RELEASE_PLAN_SCHEMA_VERSION,
    dryRun: input.dryRun,
    candidateId: input.candidateId,
    releaseId: input.releaseId,
    storageServiceReleaseId,
    semverBump: input.semverBump,
    version: input.plannedVersion,
    futureTag,
    branch: {
      name: input.branchName,
      discardable: true,
    },
    commit: {
      message: `chore(release): plan ${futureTag}`,
      files: input.changedFiles,
      rawCustomerDataIncluded: false,
    },
    tag: {
      name: futureTag,
      message: `mcoda ${futureTag}`,
      matchesPackageVersions: packageVersionsMatch,
      rawCustomerDataIncluded: false,
    },
    gates,
    rollback: {
      commands: rollbackCommands,
      packageVersions: input.packageVersionTargets,
    },
    packageVersions: {
      currentVersion: input.currentVersion,
      plannedVersion: input.plannedVersion,
      futureTag,
      matchesFutureTag: packageVersionsMatch && futureTag === `v${input.plannedVersion}`,
      targets: input.packageVersionTargets,
    },
    changelog,
  };
};

const pathExists = async (candidatePath: string): Promise<boolean> => {
  try {
    await lstat(candidatePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
};

const candidateDirectPath = async (
  repoRoot: string,
  candidateId: string,
  explicitPath?: string,
): Promise<string | undefined> => {
  const value = explicitPath ?? candidateId;
  if (!value.trim()) return undefined;
  const resolved = value.startsWith("file://")
    ? fileURLToPath(value)
    : path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(repoRoot, value);
  return (await pathExists(resolved)) ? resolved : undefined;
};

const candidateRecordMatches = (
  candidateId: string,
  record: Record<string, unknown>,
): boolean => {
  if (record.candidateId === candidateId) return true;
  if (nestedRecord(record, ["release"])?.candidateId === candidateId) return true;
  if (nestedRecord(record, ["releasePlan"])?.candidateId === candidateId) return true;
  if (nestedRecord(record, ["metadata", "releasePlan"])?.candidateId === candidateId) return true;
  if (nestedRecord(record, ["workspace"])?.workspaceId === candidateId) return true;
  if (nestedRecord(record, ["sourceManifest"])?.manifestId === candidateId) return true;
  if (nestedRecord(record, ["sourceManifest"])?.exportId === candidateId) return true;
  return false;
};

const findCandidateReleaseRecord = async (input: {
  repoRoot: string;
  candidateId: string;
  candidatePath?: string;
  candidateDirectories?: readonly string[];
}): Promise<{ path: string; record: Record<string, unknown> } | undefined> => {
  const directPath = await candidateDirectPath(
    input.repoRoot,
    input.candidateId,
    input.candidatePath,
  );
  if (directPath) {
    return {
      path: directPath,
      record: await readJsonRecord(directPath),
    };
  }
  const directories = input.candidateDirectories?.length
    ? input.candidateDirectories
    : DEFAULT_CODALI_CANDIDATE_RELEASE_DIRECTORIES;
  let inspected = 0;
  for (const directory of directories) {
    const root = path.isAbsolute(directory)
      ? path.resolve(directory)
      : path.resolve(input.repoRoot, directory);
    if (!(await pathExists(root))) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;
      const entries = (await readdir(current, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        inspected += 1;
        if (inspected > 5_000) {
          throw new CodaliCandidateReleaseBuilderError(
            "CODALI_CANDIDATE_RELEASE_SEARCH_LIMIT",
            "Candidate release search inspected more than 5000 JSON files.",
          );
        }
        try {
          const record = await readJsonRecord(entryPath);
          if (candidateRecordMatches(input.candidateId, record)) {
            return { path: entryPath, record };
          }
        } catch {
          // Ignore unrelated JSON files in local object stores.
        }
      }
    }
  }
  return undefined;
};

const buildWritePlan = (input: {
  dryRun: boolean;
  repoRoot: string;
  approvedPaths: readonly string[];
  normalizedApprovedPaths: readonly { path: string; directory: boolean }[];
  targets: readonly CodaliCandidateReleaseWriteTarget[];
  dirtySummary: CodaliCandidateReleaseDirtySummary;
}): CodaliCandidateReleaseWritePlan => {
  const targetSummaries = input.targets.map((target) => ({
    relativePath: target.relativePath,
    approved: isApprovedRelativePath(target.relativePath, input.normalizedApprovedPaths),
    dirty: input.dirtySummary.targetDirtyFiles.includes(target.relativePath),
    contentHash: target.artifact.contentHash,
    byteSize: target.artifact.byteSize,
  }));
  const blockedReasons = Array.from(new Set([
    ...targetSummaries
      .filter((target) => !target.approved)
      .map(() => "target_path_not_approved"),
    ...targetSummaries
      .filter((target) => target.dirty)
      .map(() => "target_file_dirty"),
    !input.dryRun && input.dirtySummary.unrelatedDirtyFileCount > 0
      ? "unrelated_dirty_worktree"
      : undefined,
    !input.dryRun && input.dirtySummary.status === "unavailable"
      ? "git_status_unavailable"
      : undefined,
  ].filter((item): item is string => Boolean(item))));
  return {
    status: blockedReasons.length > 0
      ? "blocked"
      : input.dryRun
        ? "dry_run"
        : "ready",
    dryRun: input.dryRun,
    repoRoot: input.repoRoot,
    approvedPaths: [...input.approvedPaths],
    targets: targetSummaries,
    blockedReasons,
  };
};

const applyWritePlan = async (input: {
  repoRoot: string;
  branchName: string;
  targets: readonly CodaliCandidateReleaseWriteTarget[];
  commandRunner: CodaliCandidateReleaseCommandRunner;
}): Promise<string[]> => {
  await assertWriteTargetsInsideRepo({
    repoRoot: input.repoRoot,
    targets: input.targets,
  });
  const branch = input.commandRunner("git", ["switch", "-c", input.branchName], {
    cwd: input.repoRoot,
  });
  if (branch.exitCode !== 0 || branch.error) {
    throw new CodaliCandidateReleaseBuilderError(
      "CODALI_CANDIDATE_RELEASE_BRANCH_CREATE_FAILED",
      branch.error ?? branch.stderr ?? "git switch failed",
    );
  }
  const written: string[] = [];
  for (const target of input.targets) {
    const absolute = path.join(input.repoRoot, target.relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, target.content, "utf8");
    written.push(target.relativePath);
  }
  return written;
};

export const buildCodaliCandidateRelease = async (
  input: BuildCodaliCandidateReleaseInput,
): Promise<CodaliCandidateReleaseBuild> => {
  const dryRun = input.dryRun ?? true;
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const now = input.now ?? (() => new Date());
  const artifacts = input.artifacts?.length
    ? [...input.artifacts]
    : [...CODALI_PATCH_PROPOSAL_ARTIFACTS];
  const uniqueArtifacts = Array.from(new Set(artifacts)).sort();
  const candidateDate = sanitizeBranchSegment(
    input.candidateDate ?? dateFromInspection(input.inspection, now),
  );
  const runId = sanitizeBranchSegment(input.runId ?? stableId("run", {
    manifestId: input.inspection.manifest.manifestId,
    checksum: input.inspection.manifest.checksum,
    artifacts: uniqueArtifacts,
  }));
  const workspaceId = `${candidateDate}-${runId}`;
  const branchName = `codali/auto-improve/${workspaceId}`;
  const createdAt = input.inspection.manifest.createdAt ?? now().toISOString();
  const sourceExportIds = Array.from(new Set([
    input.inspection.exportId,
    input.inspection.manifest.manifestId,
  ].filter(Boolean))).sort();
  const proposals = uniqueArtifacts.map((artifact) =>
    buildCodaliPatchCandidateBundle({
      inspection: input.inspection,
      artifact,
    }));
  const changedArtifactClasses = changedArtifactClassesFor(proposals);
  const semverBump = semverBumpForArtifactClasses(changedArtifactClasses);
  const defaultTarget = `.codali/improvement/candidates/${workspaceId}/candidate-release.json`;
  const targetPath = normalizeRepoRelativePath(repoRoot, input.outputPath ?? defaultTarget);
  const candidateId = input.candidateId ?? stableId("candidate-release", {
    workspaceId,
    targetPath,
    sourceExportIds,
    changedArtifactClasses,
  });
  const packagePlan = await packageVersionTargetsFor({
    repoRoot,
    semverBump,
    sourceExportIds,
    storageManifestVersion: input.inspection.manifest.schemaVersion,
  });
  const approvedPaths = input.approvedPaths?.length
    ? [...input.approvedPaths]
    : [...DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS];
  const effectiveApprovedPaths = dryRun
    ? approvedPaths
    : uniqueSortedStrings([
        ...approvedPaths,
        ...packagePlan.writeTargets.map((target) => target.relativePath),
      ]);
  const normalizedApprovedPaths = effectiveApprovedPaths.map((approvedPath) =>
    normalizeApprovedPath(repoRoot, approvedPath));
  const artifactPayload = buildGeneratedArtifactPayload({
    inspection: input.inspection,
    proposals,
    workspaceId,
    branchName,
    candidateId,
    createdAt,
    sourceExportIds,
    changedArtifactClasses,
  });
  const artifactContent = `${JSON.stringify(artifactPayload, null, 2)}\n`;
  const contentHash = hashContent(artifactContent);
  const generatedArtifact: CodaliCandidateReleaseGeneratedArtifact = {
    artifactId: `candidate-release-artifact-${contentHash.slice(0, 16)}`,
    artifactKind: "candidate_release",
    schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
    sourceExportIds,
    sourceSchemaVersions: {
      candidateRelease: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
      patchCandidate: CODALI_PATCH_CANDIDATE_SCHEMA_VERSION,
      storageManifest: input.inspection.manifest.schemaVersion,
    },
    relativePath: targetPath,
    contentHash,
    byteSize: Buffer.byteLength(artifactContent, "utf8"),
  };
  const targets: CodaliCandidateReleaseWriteTarget[] = [{
    relativePath: targetPath,
    content: artifactContent,
    artifact: generatedArtifact,
  }];
  const writeTargets = dryRun
    ? targets
    : [...targets, ...packagePlan.writeTargets];
  const dirtyRead = input.dirtyEntries
    ? { entries: [...input.dirtyEntries] }
    : readDirtyEntries(repoRoot, input.commandRunner ?? defaultCommandRunner);
  const dirtySummary = dirtySummaryFor(
    dirtyRead.entries,
    writeTargets.map((target) => target.relativePath),
    dirtyRead.warning,
  );
  const writePlan = buildWritePlan({
    dryRun,
    repoRoot,
    approvedPaths: effectiveApprovedPaths,
    normalizedApprovedPaths,
    targets: writeTargets,
    dirtySummary,
  });
  const patchOutput = targets
    .map((target) => unifiedDiffForNewFile(target.relativePath, target.content))
    .join("\n");
  let effectiveWritePlan = writePlan;
  const commandRunner = input.commandRunner ?? defaultCommandRunner;
  if (!dryRun && writePlan.status === "ready") {
    const written = await applyWritePlan({
      repoRoot,
      branchName,
      targets: writeTargets,
      commandRunner,
    });
    effectiveWritePlan = {
      ...writePlan,
      status: "written",
      targets: writePlan.targets.map((target) => ({
        ...target,
        dirty: !written.includes(target.relativePath) && target.dirty,
      })),
    };
  }
  const blockedReasons = [...effectiveWritePlan.blockedReasons];
  const releaseStatus = releaseStatusFor(dryRun, blockedReasons);
  const allGeneratedArtifacts = [
    generatedArtifact,
    ...packagePlan.writeTargets.map((target) => target.artifact),
  ];
  const releaseId = stableId("release", {
    candidateId,
    branchName,
    releaseStatus,
    artifactIds: allGeneratedArtifacts.map((artifact) => artifact.artifactId),
  });
  const candidateWorkspace: CodaliCandidateReleaseWorkspace = {
    workspaceId,
    branchName,
    branchPrefix: "codali/auto-improve",
    candidateDate,
    runId,
    discardable: true,
    dryRunOnly: dryRun,
    defaultApprovedPaths: DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS,
    approvedPaths: effectiveApprovedPaths,
    targetDirectory: path.posix.dirname(targetPath),
    patchOutput,
    discardInstructions: [
      `git switch -`,
      `git branch -D ${branchName}`,
    ],
  };
  const releaseLevel = input.releaseLevel ?? 2;
  const scope = input.scope ?? {
    tenantHash: "local_tenant",
    productId: "local_product",
  };
  const releasePlan = buildReleasePlan({
    dryRun,
    candidateId,
    releaseId,
    branchName,
    sourceExportIds,
    changedArtifactClasses,
    semverBump,
    currentVersion: packagePlan.currentVersion,
    plannedVersion: packagePlan.plannedVersion,
    packageVersionTargets: packagePlan.targets,
    changedFiles: [
      targetPath,
      ...packagePlan.targets.map((target) => target.relativePath),
    ],
    writePlan: effectiveWritePlan,
    blockedReasons,
    privacySummary: privacySummaryFor(input.inspection.manifest.privacySummary),
    evalDeltas: evalDeltasFor(undefined),
  });
  const release: CodaliImprovementRelease = {
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    releaseId,
    candidateId,
    scope,
    releaseLevel,
    status: releaseStatus,
    artifactIds: allGeneratedArtifacts.map((artifact) => artifact.artifactId),
    createdAt,
    tagName: releasePlan.futureTag,
    packageName: "mcoda",
    version: releasePlan.version,
    ...(blockedReasons.length ? { blockedReasons } : {}),
    metadata: {
      schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
      source: "codali improve build-release",
      sourceExportIds,
      sourceSchemaVersions: generatedArtifact.sourceSchemaVersions,
      candidateWorkspace,
      writePlan: effectiveWritePlan,
      dirtyWorktree: dirtySummary,
      generatedArtifacts: allGeneratedArtifacts,
      patchOutput,
      releasePlan,
      proposalSummary: proposals.map((proposal) => ({
        artifact: proposal.artifact,
        schemaVersion: proposal.schemaVersion,
        sourceExportId: proposal.source.exportId,
        manifestId: proposal.source.manifestId,
        candidateIds: proposal.candidates.map((candidate) => candidate.candidateId),
        candidateStatuses: proposal.candidates.map((candidate) => candidate.status),
        blockedReasons: proposal.candidates.flatMap((candidate) => candidate.blockedReasons),
        operationCount: proposal.patchPlan.operations.length,
      })),
    },
  };

  return {
    schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
    dryRun,
    release,
    releasePlan,
    candidateWorkspace,
    writePlan: effectiveWritePlan,
    dirtyWorktree: dirtySummary,
    generatedArtifacts: allGeneratedArtifacts,
    proposals,
    patchOutput,
    blockedReasons,
  };
};

const releaseLevelFromRecord = (
  record: Record<string, unknown> | undefined,
  fallback: CodaliImprovementReleaseLevel,
): CodaliImprovementReleaseLevel => {
  const value = nestedRecord(record, ["release"])?.releaseLevel;
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4
    ? value
    : fallback;
};

const branchNameFromRecord = (input: {
  record?: Record<string, unknown>;
  candidateDate: string;
  runId: string;
}): string => {
  const workspaceBranch = nestedRecord(input.record, ["workspace"])?.branchName;
  const metadataBranch = nestedRecord(input.record, ["metadata", "candidateWorkspace"])?.branchName ??
    nestedRecord(input.record, ["release", "metadata", "candidateWorkspace"])?.branchName;
  if (typeof workspaceBranch === "string" && workspaceBranch.trim()) return workspaceBranch;
  if (typeof metadataBranch === "string" && metadataBranch.trim()) return metadataBranch;
  return `codali/auto-improve/${input.candidateDate}-${input.runId}`;
};

const storageManifestVersionFromRecord = (
  record: Record<string, unknown> | undefined,
): string => {
  const sourceSchemaVersions = nestedRecord(record, ["sourceSchemaVersions"]) ??
    nestedRecord(record, ["metadata", "sourceSchemaVersions"]) ??
    nestedRecord(record, ["release", "metadata", "sourceSchemaVersions"]);
  const sourceManifest = nestedRecord(record, ["sourceManifest"]);
  return typeof sourceSchemaVersions?.storageManifest === "string"
    ? sourceSchemaVersions.storageManifest
    : typeof sourceManifest?.schemaVersion === "string"
      ? sourceManifest.schemaVersion
      : "not_provided";
};

export const buildCodaliCandidateReleasePlan = async (
  input: BuildCodaliCandidateReleasePlanInput,
): Promise<CodaliCandidateReleaseBuild> => {
  const dryRun = input.dryRun ?? true;
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const now = input.now ?? (() => new Date());
  const found = await findCandidateReleaseRecord({
    repoRoot,
    candidateId: input.candidateId,
    candidatePath: input.candidatePath,
    candidateDirectories: input.candidateDirectories,
  });
  const record = found?.record;
  const candidateDate = sanitizeBranchSegment(
    input.candidateDate ?? now().toISOString().slice(0, 10),
  );
  const runId = sanitizeBranchSegment(input.runId ?? input.candidateId);
  const branchName = branchNameFromRecord({ record, candidateDate, runId });
  const sourceExportIds = sourceExportIdsFromRecord(record);
  const changedArtifactClasses = changedArtifactClassesFromRecord(record);
  const semverBump = semverBumpForArtifactClasses(changedArtifactClasses);
  const packagePlan = await packageVersionTargetsFor({
    repoRoot,
    semverBump,
    sourceExportIds,
    storageManifestVersion: storageManifestVersionFromRecord(record),
  });
  const writeTargets = dryRun || !found ? [] : packagePlan.writeTargets;
  const approvedPaths = dryRun
    ? [...DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS]
    : uniqueSortedStrings([
        ...DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS,
        ...packagePlan.writeTargets.map((target) => target.relativePath),
      ]);
  const normalizedApprovedPaths = approvedPaths.map((approvedPath) =>
    normalizeApprovedPath(repoRoot, approvedPath));
  const dirtyRead = input.dirtyEntries
    ? { entries: [...input.dirtyEntries] }
    : readDirtyEntries(repoRoot, input.commandRunner ?? defaultCommandRunner);
  const dirtySummary = dirtySummaryFor(
    dirtyRead.entries,
    writeTargets.map((target) => target.relativePath),
    dirtyRead.warning,
  );
  const writePlan = buildWritePlan({
    dryRun,
    repoRoot,
    approvedPaths,
    normalizedApprovedPaths,
    targets: writeTargets,
    dirtySummary,
  });
  const missingReasons = found ? [] : ["candidate_artifact_not_found"];
  let effectiveWritePlan: CodaliCandidateReleaseWritePlan = missingReasons.length
    ? {
        ...writePlan,
        status: "blocked",
        blockedReasons: [...writePlan.blockedReasons, ...missingReasons],
      }
    : writePlan;
  const commandRunner = input.commandRunner ?? defaultCommandRunner;
  if (!dryRun && effectiveWritePlan.status === "ready") {
    const written = await applyWritePlan({
      repoRoot,
      branchName,
      targets: writeTargets,
      commandRunner,
    });
    effectiveWritePlan = {
      ...effectiveWritePlan,
      status: "written",
      targets: effectiveWritePlan.targets.map((target) => ({
        ...target,
        dirty: !written.includes(target.relativePath) && target.dirty,
      })),
    };
  }
  const blockedReasons = [...effectiveWritePlan.blockedReasons];
  const releaseStatus = releaseStatusFor(dryRun, blockedReasons);
  const releaseId = stableId("release", {
    candidateId: input.candidateId,
    branchName,
    releaseStatus,
    sourceExportIds,
    plannedVersion: packagePlan.plannedVersion,
  });
  const relativeCandidatePath = found
    ? toPosixPath(path.relative(repoRoot, found.path))
    : undefined;
  const releasePlan = buildReleasePlan({
    dryRun,
    candidateId: input.candidateId,
    releaseId,
    branchName,
    sourceExportIds,
    changedArtifactClasses,
    semverBump,
    currentVersion: packagePlan.currentVersion,
    plannedVersion: packagePlan.plannedVersion,
    packageVersionTargets: packagePlan.targets,
    changedFiles: packagePlan.targets.map((target) => target.relativePath),
    writePlan: effectiveWritePlan,
    blockedReasons,
    privacySummary: privacySummaryFromRecord(record),
    evalDeltas: evalDeltasFor(record),
  });
  const candidateWorkspace: CodaliCandidateReleaseWorkspace = {
    workspaceId: `${candidateDate}-${runId}`,
    branchName,
    branchPrefix: "codali/auto-improve",
    candidateDate,
    runId,
    discardable: true,
    dryRunOnly: dryRun,
    defaultApprovedPaths: DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS,
    approvedPaths,
    targetDirectory: relativeCandidatePath
      ? path.posix.dirname(relativeCandidatePath)
      : DEFAULT_CODALI_CANDIDATE_RELEASE_DIRECTORIES[0],
    patchOutput: "",
    discardInstructions: [
      `git switch -`,
      `git branch -D ${branchName}`,
    ],
  };
  const releaseLevel = releaseLevelFromRecord(record, input.releaseLevel ?? 2);
  const scope = input.scope ?? {
    tenantHash: "local_tenant",
    productId: "local_product",
  };
  const generatedArtifacts = packagePlan.writeTargets.map((target) => target.artifact);
  const release: CodaliImprovementRelease = {
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    releaseId,
    candidateId: input.candidateId,
    scope,
    releaseLevel,
    status: releaseStatus,
    artifactIds: generatedArtifacts.map((artifact) => artifact.artifactId),
    createdAt: now().toISOString(),
    tagName: releasePlan.futureTag,
    packageName: "mcoda",
    version: releasePlan.version,
    ...(blockedReasons.length ? { blockedReasons } : {}),
    metadata: {
      schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
      source: "codali improve build-release --candidate",
      candidateSource: found ? "candidate_file" : "missing",
      ...(relativeCandidatePath ? { candidatePath: relativeCandidatePath } : {}),
      sourceExportIds,
      candidateWorkspace,
      writePlan: effectiveWritePlan,
      dirtyWorktree: dirtySummary,
      generatedArtifacts,
      releasePlan,
      changedArtifactClasses,
    },
  };
  return {
    schemaVersion: CODALI_CANDIDATE_RELEASE_SCHEMA_VERSION,
    dryRun,
    release,
    releasePlan,
    candidateWorkspace,
    writePlan: effectiveWritePlan,
    dirtyWorktree: dirtySummary,
    generatedArtifacts,
    proposals: [],
    patchOutput: "",
    blockedReasons,
  };
};
