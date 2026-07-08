import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  validateCodaliImprovementRelease,
  validateCodaliImprovementScorecard,
  type CodaliImprovementGate,
  type CodaliImprovementGateType,
  type CodaliImprovementRelease,
  type CodaliImprovementReleaseLevel,
  type CodaliImprovementScope,
  type CodaliImprovementScorecard,
  type CodaliImprovementScorecardStatus,
} from "./ImprovementPolicy.js";
import { DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS } from "./CandidateReleaseBuilder.js";
import {
  validateCodaliStorageExportManifest,
  type CodaliStorageExportManifest,
  type CodaliStorageObjectRef,
} from "../storage/CodaliStorageContracts.js";

export const CODALI_IMPROVEMENT_EVAL_RUNNER_SCHEMA_VERSION =
  "codali.improvement.eval_runner.v1" as const;

export const CODALI_IMPROVEMENT_EVAL_GATE_IDS = [
  "deterministic_tests",
  "replay_fixtures",
  "privacy_metadata",
  "deletion_groups",
  "tenant_scope",
  "object_checksums",
  "tool_policy",
  "no_shell_write_destructive_tools",
  "no_cross_tenant_replay",
  "lineage_validity",
  "approved_file_paths",
] as const;

export type CodaliImprovementEvalGateId =
  (typeof CODALI_IMPROVEMENT_EVAL_GATE_IDS)[number];

export type CodaliImprovementEvalGateStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "warning";

export type CodaliImprovementEvalGateSeverity = "hard" | "soft";

export interface CodaliImprovementEvalGateResult {
  gateId: CodaliImprovementEvalGateId;
  gateType: CodaliImprovementGateType;
  severity: CodaliImprovementEvalGateSeverity;
  status: CodaliImprovementEvalGateStatus;
  passed: boolean;
  score: number;
  reasons: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementReleaseApproval {
  candidateId: string;
  releaseLevel: CodaliImprovementReleaseLevel;
  tagAllowed: boolean;
  publishAllowed: boolean;
  failedHardGateIds: CodaliImprovementEvalGateId[];
  skippedHardGateIds: CodaliImprovementEvalGateId[];
  warningGateIds: CodaliImprovementEvalGateId[];
  blockedReasons: string[];
  warningReasons: string[];
  requiresManualReview: boolean;
}

export interface CodaliImprovementEvalRunnerResult {
  schemaVersion: typeof CODALI_IMPROVEMENT_EVAL_RUNNER_SCHEMA_VERSION;
  candidateId: string;
  candidateSource: "provided" | "candidate_file" | "export_manifest" | "missing";
  candidatePath?: string;
  scorecard: CodaliImprovementScorecard;
  gates: CodaliImprovementEvalGateResult[];
  releaseApproval: CodaliImprovementReleaseApproval;
  blockedReasons: string[];
  warnings: string[];
  storagePayload: Record<string, unknown>;
}

export interface BuildCodaliImprovementEvalScorecardInput {
  candidateId: string;
  candidate?: unknown;
  candidatePath?: string;
  candidateDirectories?: readonly string[];
  approvedPaths?: readonly string[];
  now?: () => Date;
}

interface CandidateEvidence {
  candidateId: string;
  source: CodaliImprovementEvalRunnerResult["candidateSource"];
  path?: string;
  raw?: Record<string, unknown>;
  release?: CodaliImprovementRelease;
  manifest?: CodaliStorageExportManifest;
  changedFilePaths: string[];
  approvedPaths: string[];
  deterministicChecks: CheckEvidence[];
  privacyChecks: CheckEvidence[];
  policyChecks: CheckEvidence[];
  replayChecks: CheckEvidence[];
  allowedTools?: string[];
  deniedTools?: string[];
  destructiveToolsAllowed?: boolean;
}

interface CheckEvidence {
  name: string;
  status: "passed" | "failed" | "skipped" | "warning";
  reason?: string;
}

const DEFAULT_CANDIDATE_DIRECTORIES = [
  path.resolve(".codali", "improvement", "candidates"),
  path.resolve(".codali", "dataset", "exports", "objects"),
  path.resolve(".codali", "dataset", "exports"),
] as const;

const RISKY_TOOL_PATTERN = /(^|[_:/.-])(shell|exec|write|delete|remove|rm|destructive)([_:/.-]|$)/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256Hex = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

const hashId = (prefix: string, value: unknown): string =>
  `${prefix}-${sha256Hex(stableJson(value)).slice(0, 16)}`;

const uniqueStrings = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0))).sort();

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
};

const readJsonFile = async (filePath: string): Promise<unknown> => {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
};

const candidateIdForManifest = (manifest: CodaliStorageExportManifest): string =>
  hashId("candidate", {
    exportId: manifest.manifestId,
    checksum: manifest.checksum,
    sourceRecordIds: uniqueStrings(manifest.lineage.sourceRecordIds),
  });

const validateManifest = (input: unknown): CodaliStorageExportManifest | undefined => {
  const result = validateCodaliStorageExportManifest(input);
  return result.ok ? result.value : undefined;
};

const validateRelease = (input: unknown): CodaliImprovementRelease | undefined => {
  const result = validateCodaliImprovementRelease(input);
  return result.ok ? result.value : undefined;
};

const directCandidatePath = async (candidateId: string, explicitPath?: string): Promise<string | undefined> => {
  const value = explicitPath ?? candidateId;
  if (!value.trim()) return undefined;
  const resolved = value.startsWith("file://")
    ? fileURLToPath(value)
    : path.resolve(value);
  return (await pathExists(resolved)) ? resolved : undefined;
};

const findCandidateFile = async (
  candidateId: string,
  directories: readonly string[],
): Promise<{ path: string; candidate: unknown } | undefined> => {
  let inspected = 0;
  for (const directory of directories) {
    const root = path.resolve(directory);
    if (!(await pathExists(root))) continue;
    const stack = [root];
    while (stack.length > 0) {
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
          throw new Error("CODALI_IMPROVEMENT_EVAL_CANDIDATE_SEARCH_LIMIT");
        }
        try {
          const parsed = await readJsonFile(entryPath);
          if (candidateMatches(candidateId, parsed)) {
            return { path: entryPath, candidate: parsed };
          }
        } catch {
          // Ignore non-candidate JSON payloads under object stores.
        }
      }
    }
  }
  return undefined;
};

const candidateMatches = (candidateId: string, value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.candidateId === candidateId || value.candidate_id === candidateId) return true;
  if (isRecord(value.release) && value.release.candidateId === candidateId) return true;
  const manifest = validateManifest(value) ?? validateManifest(value.manifest);
  if (manifest) {
    return manifest.manifestId === candidateId || candidateIdForManifest(manifest) === candidateId;
  }
  return false;
};

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;

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

const collectStringsUnderKeys = (
  value: unknown,
  keyPattern: RegExp,
  output: string[] = [],
): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectStringsUnderKeys(item, keyPattern, output);
    return output;
  }
  if (!isRecord(value)) return output;
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      if (typeof item === "string") output.push(item);
      if (Array.isArray(item)) {
        output.push(...item.filter((entry): entry is string => typeof entry === "string"));
      }
    }
    collectStringsUnderKeys(item, keyPattern, output);
  }
  return output;
};

const collectChangedFilePaths = (record: Record<string, unknown> | undefined): string[] => {
  const paths = [
    ...collectStringsUnderKeys(record, /^(relativePath|path|filePath|targetPath)$/u),
    ...(stringArray(record?.changedFilePaths) ?? []),
    ...(stringArray(record?.approvedFilePaths) ?? []),
  ];
  const metadata = nestedRecord(record, ["release", "metadata"]) ?? nestedRecord(record, ["metadata"]);
  const writePlanTargets = nestedRecord(metadata, ["writePlan"])?.targets;
  if (Array.isArray(writePlanTargets)) {
    for (const target of writePlanTargets) {
      if (isRecord(target) && typeof target.relativePath === "string") {
        paths.push(target.relativePath);
      }
    }
  }
  const generatedArtifacts = record?.generatedArtifacts ??
    metadata?.generatedArtifacts ??
    nestedRecord(record, ["release", "metadata"])?.generatedArtifacts;
  if (Array.isArray(generatedArtifacts)) {
    for (const artifact of generatedArtifacts) {
      if (isRecord(artifact) && typeof artifact.relativePath === "string") {
        paths.push(artifact.relativePath);
      }
    }
  }
  return uniqueStrings(paths)
    .filter((item) => !item.startsWith("file://"))
    .filter((item) => item !== "." && !item.endsWith(".jsonl"));
};

const collectApprovedPaths = (
  record: Record<string, unknown> | undefined,
  inputApprovedPaths?: readonly string[],
): string[] => {
  const metadata = nestedRecord(record, ["release", "metadata"]) ?? nestedRecord(record, ["metadata"]);
  const writePlan = nestedRecord(metadata, ["writePlan"]);
  const workspace = nestedRecord(metadata, ["candidateWorkspace"]);
  return uniqueStrings([
    ...(inputApprovedPaths ?? []),
    ...(stringArray(record?.approvedPaths) ?? []),
    ...(stringArray(writePlan?.approvedPaths) ?? []),
    ...(stringArray(workspace?.approvedPaths) ?? []),
    ...DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS,
  ]);
};

const collectChecks = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): CheckEvidence[] => {
  const checks: CheckEvidence[] = [];
  for (const key of keys) {
    const value = record?.[key] ?? nestedRecord(record, ["validation"])?.[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isRecord(item)) continue;
      const status = typeof item.status === "string" ? item.status : undefined;
      if (
        status !== "passed" &&
        status !== "failed" &&
        status !== "skipped" &&
        status !== "warning"
      ) {
        continue;
      }
      checks.push({
        name: typeof item.name === "string" ? item.name : key,
        status,
        reason: typeof item.reason === "string" ? item.reason : undefined,
      });
    }
  }
  return checks;
};

const normalizeCandidateEvidence = async (
  input: BuildCodaliImprovementEvalScorecardInput,
): Promise<CandidateEvidence> => {
  if (input.candidate) {
    return candidateEvidenceFromRecord(input.candidateId, input.candidate, "provided", undefined, input.approvedPaths);
  }
  const directPath = await directCandidatePath(input.candidateId, input.candidatePath);
  if (directPath) {
    const parsed = await readJsonFile(directPath);
    return candidateEvidenceFromRecord(input.candidateId, parsed, "candidate_file", directPath, input.approvedPaths);
  }
  const found = await findCandidateFile(
    input.candidateId,
    input.candidateDirectories?.length
      ? input.candidateDirectories
      : DEFAULT_CANDIDATE_DIRECTORIES,
  );
  if (found) {
    const source = validateManifest(found.candidate) ? "export_manifest" : "candidate_file";
    return candidateEvidenceFromRecord(input.candidateId, found.candidate, source, found.path, input.approvedPaths);
  }
  return {
    candidateId: input.candidateId,
    source: "missing",
    changedFilePaths: [],
    approvedPaths: collectApprovedPaths(undefined, input.approvedPaths),
    deterministicChecks: [],
    privacyChecks: [],
    policyChecks: [],
    replayChecks: [],
  };
};

const candidateEvidenceFromRecord = (
  candidateId: string,
  value: unknown,
  source: CandidateEvidence["source"],
  filePath: string | undefined,
  inputApprovedPaths?: readonly string[],
): CandidateEvidence => {
  const record = isRecord(value) ? value : undefined;
  const manifest = validateManifest(value) ??
    validateManifest(record?.manifest) ??
    validateManifest(record?.sourceManifest);
  const release = validateRelease(value) ?? validateRelease(record?.release);
  const toolPolicy = isRecord(record?.toolPolicy)
    ? record.toolPolicy
    : nestedRecord(record, ["policy"]) ?? nestedRecord(record, ["metadata", "toolPolicy"]);
  const allowedTools = uniqueStrings([
    ...(stringArray(toolPolicy?.allowedTools) ?? []),
    ...(stringArray(toolPolicy?.allowed_tools) ?? []),
    ...collectStringsUnderKeys(record, /^(allowedTools|allowed_tools|runtimeTools|runtime_tools)$/u),
  ]);
  const deniedTools = uniqueStrings([
    ...(stringArray(toolPolicy?.deniedTools) ?? []),
    ...(stringArray(toolPolicy?.denied_tools) ?? []),
  ]);
  const destructiveToolsAllowed =
    toolPolicy?.destructiveToolsAllowed === true ||
    toolPolicy?.allowDestructiveTools === true ||
    toolPolicy?.allow_destructive_tools === true;

  return {
    candidateId: release?.candidateId ?? (record?.candidateId as string | undefined) ?? candidateId,
    source,
    path: filePath,
    raw: record,
    release,
    manifest,
    changedFilePaths: collectChangedFilePaths(record),
    approvedPaths: collectApprovedPaths(record, inputApprovedPaths),
    deterministicChecks: collectChecks(record, ["deterministicTests", "deterministic_tests", "tests"]),
    privacyChecks: collectChecks(record, ["privacyChecks", "privacy_checks"]),
    policyChecks: collectChecks(record, ["policyChecks", "policy_checks"]),
    replayChecks: collectChecks(record, ["replayChecks", "replay_checks", "replayFixtures", "replay_fixtures"]),
    allowedTools,
    deniedTools,
    destructiveToolsAllowed,
  };
};

const gate = (
  gateId: CodaliImprovementEvalGateId,
  gateType: CodaliImprovementGateType,
  severity: CodaliImprovementEvalGateSeverity,
  status: CodaliImprovementEvalGateStatus,
  reasons: string[],
  metadata?: Record<string, unknown>,
): CodaliImprovementEvalGateResult => ({
  gateId,
  gateType,
  severity,
  status,
  passed: status === "passed" || status === "warning",
  score: status === "passed" ? 1 : status === "warning" ? 0.5 : 0,
  reasons,
  ...(metadata ? { metadata } : {}),
});

const evaluateCheckGate = (
  gateId: CodaliImprovementEvalGateId,
  gateType: CodaliImprovementGateType,
  checks: readonly CheckEvidence[],
  missingReason: string,
): CodaliImprovementEvalGateResult => {
  if (checks.length === 0) return gate(gateId, gateType, "hard", "skipped", [missingReason]);
  const failed = checks.filter((check) => check.status === "failed");
  if (failed.length) {
    return gate(gateId, gateType, "hard", "failed", failed.map((check) => check.reason ?? `${check.name}_failed`), {
      checks,
    });
  }
  const skipped = checks.filter((check) => check.status === "skipped");
  if (skipped.length) {
    return gate(gateId, gateType, "hard", "skipped", skipped.map((check) => check.reason ?? `${check.name}_skipped`), {
      checks,
    });
  }
  const warnings = checks.filter((check) => check.status === "warning");
  if (warnings.length) {
    return gate(gateId, gateType, "hard", "warning", warnings.map((check) => check.reason ?? `${check.name}_warning`), {
      checks,
    });
  }
  return gate(gateId, gateType, "hard", "passed", [], { checks });
};

const allManifestRefs = (manifest: CodaliStorageExportManifest | undefined): CodaliStorageObjectRef[] => {
  if (!manifest) return [];
  return [
    ...manifest.artifactRefs,
    ...manifest.records.flatMap((record) => record.objectRef ? [record.objectRef] : []),
  ];
};

const ownerScopeKey = (ref: CodaliStorageObjectRef): string =>
  `${ref.ownerScope.tenantHash}:${ref.ownerScope.productId}:${ref.ownerScope.deploymentId ?? ""}`;

const evaluatePrivacyMetadataGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  const summary = evidence.manifest?.privacySummary;
  if (!summary) return gate("privacy_metadata", "privacy", "hard", "skipped", ["privacy_metadata_not_available"]);
  const missing = [
    typeof summary.recordCount === "number" ? undefined : "privacy_record_count_missing",
    typeof summary.containsSecrets === "boolean" ? undefined : "privacy_secret_flag_missing",
    typeof summary.containsCustomerData === "boolean" ? undefined : "privacy_customer_data_flag_missing",
    typeof summary.exportAllowedCount === "number" ? undefined : "privacy_export_count_missing",
  ].filter((item): item is string => Boolean(item));
  if (missing.length) return gate("privacy_metadata", "privacy", "hard", "failed", missing);
  if (summary.containsSecrets) return gate("privacy_metadata", "privacy", "hard", "failed", ["privacy_summary_contains_secrets"]);
  return gate("privacy_metadata", "privacy", "hard", "passed", [], {
    recordCount: summary.recordCount,
    exportAllowedCount: summary.exportAllowedCount,
    trainingAllowedCount: summary.trainingAllowedCount,
  });
};

const evaluateDeletionGroupsGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  const snapshot = evidence.manifest?.deletionGroupSnapshot;
  if (!snapshot) return gate("deletion_groups", "privacy", "hard", "skipped", ["deletion_group_snapshot_not_available"]);
  const missingRecordIds = (evidence.manifest?.lineage.sourceRecordIds ?? [])
    .filter((recordId) => !(snapshot.byRecordId[recordId]?.length));
  if (!snapshot.deletionGroupIds.length || missingRecordIds.length) {
    return gate("deletion_groups", "privacy", "hard", "failed", [
      ...(!snapshot.deletionGroupIds.length ? ["deletion_group_ids_empty"] : []),
      ...missingRecordIds.map((recordId) => `deletion_group_missing_for_record:${recordId}`),
    ]);
  }
  return gate("deletion_groups", "privacy", "hard", "passed", [], {
    deletionGroupCount: snapshot.deletionGroupIds.length,
  });
};

const evaluateTenantScopeGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  const refs = allManifestRefs(evidence.manifest);
  if (!refs.length) return gate("tenant_scope", "privacy", "hard", "skipped", ["tenant_scope_refs_not_available"]);
  const scopeKeys = uniqueStrings(refs.map(ownerScopeKey));
  const releaseScope = evidence.release?.scope;
  const releaseMismatch = releaseScope
    ? refs.some((ref) =>
        ref.ownerScope.tenantHash !== releaseScope.tenantHash ||
        ref.ownerScope.productId !== releaseScope.productId)
    : false;
  if (scopeKeys.length !== 1 || releaseMismatch) {
    return gate("tenant_scope", "privacy", "hard", "failed", [
      ...(scopeKeys.length !== 1 ? ["multiple_tenant_scopes_detected"] : []),
      ...(releaseMismatch ? ["release_scope_mismatches_manifest_scope"] : []),
    ], { scopeKeys });
  }
  return gate("tenant_scope", "privacy", "hard", "passed", [], { scopeKey: scopeKeys[0] });
};

const verifyFileRef = async (ref: CodaliStorageObjectRef): Promise<string | undefined> => {
  if (!ref.uri?.startsWith("file://")) return undefined;
  const filePath = fileURLToPath(ref.uri);
  const raw = await readFile(filePath);
  const actualHash = `sha256:${sha256Hex(raw)}`;
  if (actualHash !== ref.contentHash) return `object_checksum_mismatch:${ref.refId}`;
  if (raw.byteLength !== ref.byteSize) return `object_size_mismatch:${ref.refId}`;
  return undefined;
};

const evaluateObjectChecksumsGate = async (evidence: CandidateEvidence): Promise<CodaliImprovementEvalGateResult> => {
  const refs = allManifestRefs(evidence.manifest);
  if (!evidence.manifest || !refs.length) {
    return gate("object_checksums", "privacy", "hard", "skipped", ["object_refs_not_available"]);
  }
  const reasons: string[] = [];
  const checksumRef = evidence.manifest.artifactRefs.find((ref) => ref.contentHash === evidence.manifest?.checksum);
  if (!checksumRef) reasons.push("manifest_checksum_artifact_missing");
  for (const ref of refs) {
    if (!ref.contentHash.startsWith("sha256:")) reasons.push(`object_hash_not_sha256:${ref.refId}`);
    if (!Number.isInteger(ref.byteSize) || ref.byteSize <= 0) reasons.push(`object_byte_size_invalid:${ref.refId}`);
    try {
      const fileReason = await verifyFileRef(ref);
      if (fileReason) reasons.push(fileReason);
    } catch {
      reasons.push(`object_file_unreadable:${ref.refId}`);
    }
  }
  return reasons.length
    ? gate("object_checksums", "privacy", "hard", "failed", uniqueStrings(reasons))
    : gate("object_checksums", "privacy", "hard", "passed", [], { objectRefCount: refs.length });
};

const evaluateToolPolicyGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  if (!evidence.allowedTools?.length && !evidence.deniedTools?.length && evidence.destructiveToolsAllowed === undefined) {
    return gate("tool_policy", "policy", "hard", "warning", ["explicit_tool_policy_not_present"]);
  }
  if (evidence.destructiveToolsAllowed) {
    return gate("tool_policy", "policy", "hard", "failed", ["destructive_tools_allowed_by_policy"]);
  }
  return gate("tool_policy", "policy", "hard", "passed", [], {
    allowedTools: evidence.allowedTools,
    deniedTools: evidence.deniedTools,
  });
};

const evaluateNoRiskyToolsGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  const tools = uniqueStrings([...(evidence.allowedTools ?? [])]);
  if (!tools.length) {
    return gate("no_shell_write_destructive_tools", "policy", "hard", "skipped", ["no_runtime_tool_list_present"]);
  }
  const riskyTools = tools.filter((toolName) => RISKY_TOOL_PATTERN.test(toolName));
  return riskyTools.length
    ? gate("no_shell_write_destructive_tools", "policy", "hard", "failed", riskyTools.map((toolName) => `risky_tool_allowed:${toolName}`))
    : gate("no_shell_write_destructive_tools", "policy", "hard", "passed", [], { allowedTools: tools });
};

const evaluateNoCrossTenantReplayGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  const replayRefs = evidence.manifest?.artifactRefs
    .filter((ref) => isRecord(ref.metadata) && ref.metadata.artifactType === "replay_fixture") ?? [];
  if (!replayRefs.length && !evidence.replayChecks.length) {
    return gate("no_cross_tenant_replay", "replay", "hard", "skipped", ["replay_fixture_not_available"]);
  }
  const replayScopeKeys = uniqueStrings(replayRefs.map(ownerScopeKey));
  if (replayScopeKeys.length > 1) {
    return gate("no_cross_tenant_replay", "replay", "hard", "failed", ["cross_tenant_replay_scope_detected"], {
      replayScopeKeys,
    });
  }
  return gate("no_cross_tenant_replay", "replay", "hard", "passed", [], {
    replayFixtureCount: replayRefs.length || evidence.replayChecks.length,
  });
};

const evaluateLineageGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  const lineage = evidence.manifest?.lineage;
  if (!lineage) return gate("lineage_validity", "release", "hard", "skipped", ["lineage_not_available"]);
  const reasons = [
    !lineage.sourceRecordIds.length ? "lineage_source_records_empty" : undefined,
    !lineage.sourceObjectHashes.length ? "lineage_source_object_hashes_empty" : undefined,
    evidence.manifest && lineage.sourceRecordIds.length !== evidence.manifest.recordCount
      ? "lineage_record_count_mismatch"
      : undefined,
  ].filter((item): item is string => Boolean(item));
  return reasons.length
    ? gate("lineage_validity", "release", "hard", "failed", reasons)
    : gate("lineage_validity", "release", "hard", "passed", [], {
        sourceRecordCount: lineage.sourceRecordIds.length,
        sourceObjectHashCount: lineage.sourceObjectHashes.length,
      });
};

const normalizeRelativePath = (value: string): string =>
  value.split(path.sep).join("/").replace(/^\.\//u, "");

const isApprovedPath = (relativePath: string, approvedPaths: readonly string[]): boolean => {
  const normalized = normalizeRelativePath(relativePath);
  return approvedPaths.some((approvedPath) => {
    const approved = normalizeRelativePath(approvedPath);
    return approved.endsWith("/")
      ? normalized.startsWith(approved)
      : normalized === approved;
  });
};

const evaluateApprovedFilePathsGate = (evidence: CandidateEvidence): CodaliImprovementEvalGateResult => {
  if (!evidence.changedFilePaths.length) {
    return gate("approved_file_paths", "release", "hard", "skipped", ["candidate_write_targets_not_available"]);
  }
  const unapproved = evidence.changedFilePaths
    .filter((targetPath) => !isApprovedPath(targetPath, evidence.approvedPaths));
  return unapproved.length
    ? gate("approved_file_paths", "release", "hard", "failed", unapproved.map((targetPath) => `target_path_not_approved:${targetPath}`), {
        approvedPaths: evidence.approvedPaths,
      })
    : gate("approved_file_paths", "release", "hard", "passed", [], {
        approvedPaths: evidence.approvedPaths,
        changedFilePaths: evidence.changedFilePaths,
      });
};

const toContractGate = (
  candidateId: string,
  createdAt: string,
  result: CodaliImprovementEvalGateResult,
): CodaliImprovementGate => ({
  schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  gateId: `gate-${result.gateId}`,
  candidateId,
  gateType: result.gateType,
  status: result.status,
  required: result.severity === "hard",
  passed: result.passed,
  createdAt,
  score: result.score,
  ...(result.reasons.length ? { reasons: result.reasons } : {}),
  metadata: {
    schemaVersion: CODALI_IMPROVEMENT_EVAL_RUNNER_SCHEMA_VERSION,
    gateId: result.gateId,
    severity: result.severity,
    status: result.status,
    ...(result.metadata ?? {}),
  },
});

const scorecardStatusFor = (
  gates: readonly CodaliImprovementEvalGateResult[],
): CodaliImprovementScorecardStatus => {
  if (gates.some((item) => item.severity === "hard" && (item.status === "failed" || item.status === "skipped"))) {
    return "blocked";
  }
  if (gates.some((item) => item.status === "failed")) return "failed";
  if (gates.some((item) => item.status === "warning" || item.status === "skipped")) return "degraded";
  return "passed";
};

const releaseLevelFor = (release: CodaliImprovementRelease | undefined): CodaliImprovementReleaseLevel =>
  release?.releaseLevel ?? 0;

const releaseScopeFor = (release: CodaliImprovementRelease | undefined): CodaliImprovementScope => ({
  tenantHash: release?.scope.tenantHash ?? "local_tenant",
  productId: release?.scope.productId ?? "local_product",
  ...(release?.scope.deploymentId ? { deploymentId: release.scope.deploymentId } : {}),
});

const buildReleaseApproval = (
  candidateId: string,
  release: CodaliImprovementRelease | undefined,
  gates: readonly CodaliImprovementEvalGateResult[],
): CodaliImprovementReleaseApproval => {
  const failedHard = gates.filter((item) => item.severity === "hard" && item.status === "failed");
  const skippedHard = gates.filter((item) => item.severity === "hard" && item.status === "skipped");
  const warningGates = gates.filter((item) => item.status === "warning");
  const releaseLevel = releaseLevelFor(release);
  const hardBlocked = [...failedHard, ...skippedHard];
  const blockedReasons = uniqueStrings(hardBlocked.flatMap((item) =>
    item.reasons.length
      ? item.reasons.map((reason) => `${item.gateId}:${reason}`)
      : [`${item.gateId}:${item.status}`]));
  const warningReasons = uniqueStrings(warningGates.flatMap((item) =>
    item.reasons.length
      ? item.reasons.map((reason) => `${item.gateId}:${reason}`)
      : [`${item.gateId}:warning`]));
  const releasable = hardBlocked.length === 0 && warningGates.length === 0;
  return {
    candidateId,
    releaseLevel,
    tagAllowed: releasable && releaseLevel >= 3,
    publishAllowed: releasable && releaseLevel >= 4,
    failedHardGateIds: failedHard.map((item) => item.gateId),
    skippedHardGateIds: skippedHard.map((item) => item.gateId),
    warningGateIds: warningGates.map((item) => item.gateId),
    blockedReasons,
    warningReasons,
    requiresManualReview: skippedHard.length > 0 || warningGates.length > 0,
  };
};

export const buildCodaliImprovementEvalScorecard = async (
  input: BuildCodaliImprovementEvalScorecardInput,
): Promise<CodaliImprovementEvalRunnerResult> => {
  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const evidence = await normalizeCandidateEvidence(input);
  const gates: CodaliImprovementEvalGateResult[] = [
    evaluateCheckGate(
      "deterministic_tests",
      "eval",
      evidence.deterministicChecks,
      "deterministic_test_results_not_available",
    ),
    evaluateCheckGate(
      "replay_fixtures",
      "replay",
      evidence.replayChecks.length
        ? evidence.replayChecks
        : evidence.manifest?.artifactRefs.some((ref) => isRecord(ref.metadata) && ref.metadata.artifactType === "replay_fixture")
          ? [{ name: "replay_fixture_present", status: "passed" }]
          : [],
      "replay_fixture_results_not_available",
    ),
    evaluatePrivacyMetadataGate(evidence),
    evaluateDeletionGroupsGate(evidence),
    evaluateTenantScopeGate(evidence),
    await evaluateObjectChecksumsGate(evidence),
    evaluateToolPolicyGate(evidence),
    evaluateNoRiskyToolsGate(evidence),
    evaluateNoCrossTenantReplayGate(evidence),
    evaluateLineageGate(evidence),
    evaluateApprovedFilePathsGate(evidence),
  ];
  const releaseApproval = buildReleaseApproval(evidence.candidateId, evidence.release, gates);
  const scores = Object.fromEntries(gates.map((item) => [item.gateId, item.score]));
  const scorecard: CodaliImprovementScorecard = {
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    scorecardId: hashId("scorecard", {
      candidateId: evidence.candidateId,
      gates: gates.map((item) => [item.gateId, item.status, item.reasons]),
    }),
    candidateId: evidence.candidateId,
    status: scorecardStatusFor(gates),
    gates: gates.map((item) => toContractGate(evidence.candidateId, createdAt, item)),
    scores,
    createdAt,
    summary: releaseApproval.blockedReasons.length
      ? "Release approval is blocked by hard gate evidence."
      : releaseApproval.warningReasons.length
        ? "Release approval requires manual review for warnings."
        : "All evaluated release gates passed.",
    metadata: {
      schemaVersion: CODALI_IMPROVEMENT_EVAL_RUNNER_SCHEMA_VERSION,
      candidateSource: evidence.source,
      ...(evidence.path ? { candidatePath: evidence.path } : {}),
      releaseApproval,
      manifestId: evidence.manifest?.manifestId,
      releaseId: evidence.release?.releaseId,
      approvedPaths: evidence.approvedPaths,
      changedFilePaths: evidence.changedFilePaths,
    },
  };
  const validation = validateCodaliImprovementScorecard(scorecard);
  if (!validation.ok) {
    throw new Error(
      `CODALI_IMPROVEMENT_EVAL_SCORECARD_INVALID: ${validation.issues
        .map((issue) => `${issue.path}:${issue.code}`)
        .join("; ")}`,
    );
  }
  const storagePayload = {
    schemaVersion: CODALI_IMPROVEMENT_EVAL_RUNNER_SCHEMA_VERSION,
    scorecard,
    releaseApproval,
    blockedReasons: releaseApproval.blockedReasons,
    warnings: releaseApproval.warningReasons,
    releaseScope: releaseScopeFor(evidence.release),
  };
  return {
    schemaVersion: CODALI_IMPROVEMENT_EVAL_RUNNER_SCHEMA_VERSION,
    candidateId: evidence.candidateId,
    candidateSource: evidence.source,
    ...(evidence.path ? { candidatePath: evidence.path } : {}),
    scorecard: validation.value,
    gates,
    releaseApproval,
    blockedReasons: releaseApproval.blockedReasons,
    warnings: releaseApproval.warningReasons,
    storagePayload,
  };
};
