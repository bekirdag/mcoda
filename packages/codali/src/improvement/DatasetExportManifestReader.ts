import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateCodaliStorageExportManifest,
  type CodaliStorageExportKind,
  type CodaliStorageExportManifest,
  type CodaliStorageObjectRef,
  type CodaliStorageValidationIssue,
} from "../storage/CodaliStorageContracts.js";
import type { CodaliImprovementCandidateKind } from "./ImprovementPolicy.js";
import {
  curateDatasetExportForImprovement,
  type DatasetEligibilityGateReport,
} from "./DatasetEligibilityGate.js";

export const CODALI_IMPROVEMENT_MANIFEST_READER_SCHEMA_VERSION =
  "codali.improvement.manifest_reader.v1" as const;

export const CODALI_IMPROVEMENT_SUPPORTED_EXPORT_KINDS = [
  "eval-replay",
  "model-router",
  "prompt-regression",
  "query-expander-sft",
  "rag-reranker",
] as const satisfies readonly CodaliStorageExportKind[];

export type DatasetExportManifestReaderWarningCode =
  | "unsupported_export_kind";

export interface DatasetExportManifestReaderWarning {
  code: DatasetExportManifestReaderWarningCode;
  message: string;
  exportKind?: string;
}

export interface DatasetExportManifestReaderInput {
  exportId?: string;
  manifestPath?: string;
  directory?: string;
  supportedExportKinds?: readonly CodaliStorageExportKind[];
  allowedExampleArtifactTypes?: readonly string[];
  revokedDeletionGroupIds?: readonly string[];
}

export interface DatasetExportArtifactPayloadSummary {
  payloadKind: "json" | "jsonl" | "text";
  rowCount?: number;
  byteSize: number;
}

export interface DatasetExportVerifiedArtifact {
  ref: CodaliStorageObjectRef;
  path: string;
  contentHash: string;
  byteSize: number;
  payloadSummary: DatasetExportArtifactPayloadSummary;
}

export interface DatasetExportCandidateProvenance {
  schemaVersion: typeof CODALI_IMPROVEMENT_MANIFEST_READER_SCHEMA_VERSION;
  exportId: string;
  manifestId: string;
  manifestPath: string;
  exportKind: CodaliStorageExportKind;
  exportFormat: string;
  checksum: string;
  recordCount: number;
  sourceRecordIds: string[];
  sourceGatewayRecordIds: string[];
  sourceObjectHashes: string[];
  deletionGroupIds: string[];
  artifactRefs: Array<{
    refId: string;
    contentHash: string;
    byteSize: number;
    mimeType: string;
    uri?: string;
  }>;
  generatedBy?: string;
  primaryArtifactRefId: string;
  primaryArtifactContentHash: string;
}

export interface DatasetExportImprovementCandidate {
  candidateId: string;
  candidateKind: CodaliImprovementCandidateKind;
  status: "proposed";
  sourceExportIds: string[];
  sourceRecordIds: string[];
  artifactIds: string[];
  exampleCount: number;
  objectBytes: number;
  provenance: DatasetExportCandidateProvenance;
}

export interface DatasetExportManifestReaderResult {
  schemaVersion: typeof CODALI_IMPROVEMENT_MANIFEST_READER_SCHEMA_VERSION;
  exportId: string;
  manifestPath: string;
  manifest: CodaliStorageExportManifest;
  primaryArtifact?: DatasetExportVerifiedArtifact;
  primaryArtifactRows: unknown[];
  provenance: DatasetExportCandidateProvenance;
  candidates: DatasetExportImprovementCandidate[];
  warnings: DatasetExportManifestReaderWarning[];
  curationReport: DatasetEligibilityGateReport;
}

export class DatasetExportManifestReaderError extends Error {
  readonly code: string;
  readonly issues?: CodaliStorageValidationIssue[];

  constructor(
    code: string,
    message: string,
    issues?: CodaliStorageValidationIssue[],
  ) {
    super(`${code}: ${message}`);
    this.name = "DatasetExportManifestReaderError";
    this.code = code;
    this.issues = issues;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const sha256Hex = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

const contentHash = (input: string | Buffer): string => `sha256:${sha256Hex(input)}`;

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
};

const normalizePath = (value: string): string =>
  value.startsWith("file://") ? fileURLToPath(value) : path.resolve(value);

const defaultSearchDirectories = (): string[] => [
  path.resolve(".codali", "dataset", "exports", "objects"),
  path.resolve(".codali", "dataset", "exports"),
  path.resolve(".codali", "dataset"),
];

const readJsonFile = async (filePath: string): Promise<unknown> => {
  const raw = await readFile(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new DatasetExportManifestReaderError(
      "CODALI_DATASET_EXPORT_MANIFEST_JSON_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const maybeManifestId = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const manifestId = value.manifestId ?? value.manifest_id;
  return typeof manifestId === "string" && manifestId.trim()
    ? manifestId.trim()
    : undefined;
};

const findManifestByExportId = async (
  directory: string,
  exportId: string,
): Promise<string | undefined> => {
  const root = path.resolve(directory);
  if (!(await pathExists(root))) return undefined;
  const stack = [root];
  let inspected = 0;
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
        throw new DatasetExportManifestReaderError(
          "CODALI_DATASET_EXPORT_MANIFEST_SEARCH_LIMIT",
          `Manifest search inspected too many files under ${root}.`,
        );
      }
      try {
        const raw = await readFile(entryPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (maybeManifestId(parsed) === exportId) return entryPath;
      } catch {
        // Object payload files can be JSONL or plain text. Ignore non-manifest files.
      }
    }
  }
  return undefined;
};

const resolveManifestPath = async (
  input: DatasetExportManifestReaderInput,
): Promise<string> => {
  if (input.manifestPath) {
    const manifestPath = normalizePath(input.manifestPath);
    if (!(await pathExists(manifestPath))) {
      throw new DatasetExportManifestReaderError(
        "CODALI_DATASET_EXPORT_MANIFEST_NOT_FOUND",
        `Manifest file not found: ${manifestPath}.`,
      );
    }
    return manifestPath;
  }

  const exportId = input.exportId?.trim();
  if (!exportId) {
    throw new DatasetExportManifestReaderError(
      "CODALI_DATASET_EXPORT_ID_REQUIRED",
      "An export id or manifest path is required.",
    );
  }

  const directPath = normalizePath(exportId);
  if (await pathExists(directPath)) return directPath;

  const directories = [
    ...(input.directory ? [input.directory] : []),
    ...defaultSearchDirectories(),
  ];
  for (const directory of directories) {
    const directManifest = path.resolve(directory, `${exportId}.json`);
    if (await pathExists(directManifest)) return directManifest;
    const found = await findManifestByExportId(directory, exportId);
    if (found) return found;
  }

  throw new DatasetExportManifestReaderError(
    "CODALI_DATASET_EXPORT_MANIFEST_NOT_FOUND",
    `No export manifest found for export id ${exportId}.`,
  );
};

const validateManifest = async (
  manifestPath: string,
): Promise<CodaliStorageExportManifest> => {
  const parsed = await readJsonFile(manifestPath);
  const validation = validateCodaliStorageExportManifest(parsed);
  if (!validation.ok) {
    throw new DatasetExportManifestReaderError(
      "CODALI_DATASET_EXPORT_MANIFEST_INVALID",
      validation.issues.map((issue) => `${issue.path}:${issue.code}`).join("; "),
      validation.issues,
    );
  }
  return validation.value;
};

const objectRefPath = (ref: CodaliStorageObjectRef): string => {
  if (!ref.uri?.startsWith("file://")) {
    throw new DatasetExportManifestReaderError(
      "CODALI_DATASET_EXPORT_ARTIFACT_URI_UNSUPPORTED",
      `Artifact ${ref.refId} does not have a readable file:// URI.`,
    );
  }
  return fileURLToPath(ref.uri);
};

interface ParsedArtifactPayload {
  summary: DatasetExportArtifactPayloadSummary;
  rows: unknown[];
}

const parseArtifactPayload = (
  ref: CodaliStorageObjectRef,
  raw: Buffer,
): ParsedArtifactPayload => {
  const text = raw.toString("utf8");
  if (ref.mimeType === "application/x-ndjson" || ref.mediaType === "jsonl") {
    const lines = text.trimEnd().length ? text.trimEnd().split(/\r?\n/) : [];
    const rows = lines.map((line) => JSON.parse(line) as unknown);
    return {
      summary: {
        payloadKind: "jsonl",
        rowCount: rows.length,
        byteSize: raw.byteLength,
      },
      rows,
    };
  }

  if (ref.mimeType === "application/json" || ref.mediaType === "json") {
    const parsed = text.trim().length ? JSON.parse(text) as unknown : undefined;
    const rows = isRecord(parsed) && Array.isArray(parsed.records)
      ? parsed.records
      : [];
    return {
      summary: {
        payloadKind: "json",
        rowCount: rows.length || undefined,
        byteSize: raw.byteLength,
      },
      rows,
    };
  }

  return {
    summary: {
      payloadKind: "text",
      byteSize: raw.byteLength,
    },
    rows: [],
  };
};

interface VerifiedArtifactRead {
  artifact: DatasetExportVerifiedArtifact;
  rows: unknown[];
}

const verifyArtifact = async (
  ref: CodaliStorageObjectRef,
  expectedHash?: string,
): Promise<VerifiedArtifactRead> => {
  const filePath = objectRefPath(ref);
  const raw = await readFile(filePath);
  const actualHash = contentHash(raw);
  if (actualHash !== ref.contentHash || (expectedHash && actualHash !== expectedHash)) {
    throw new DatasetExportManifestReaderError(
      "CODALI_DATASET_EXPORT_ARTIFACT_CHECKSUM_MISMATCH",
      `Artifact ${ref.refId} checksum mismatch.`,
    );
  }
  if (ref.byteSize !== raw.byteLength) {
    throw new DatasetExportManifestReaderError(
      "CODALI_DATASET_EXPORT_ARTIFACT_SIZE_MISMATCH",
      `Artifact ${ref.refId} byte size mismatch.`,
    );
  }
  const parsed = parseArtifactPayload(ref, raw);
  return {
    artifact: {
      ref,
      path: filePath,
      contentHash: actualHash,
      byteSize: raw.byteLength,
      payloadSummary: parsed.summary,
    },
    rows: parsed.rows,
  };
};

const primaryArtifactRef = (
  manifest: CodaliStorageExportManifest,
): CodaliStorageObjectRef => {
  const matching = manifest.artifactRefs.find((ref) => ref.contentHash === manifest.checksum);
  if (!matching) {
    throw new DatasetExportManifestReaderError(
      "CODALI_DATASET_EXPORT_ARTIFACT_MISSING",
      "Export manifest checksum does not point at a manifest artifact.",
    );
  }
  return matching;
};

const uniqueStrings = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0))).sort();

const buildProvenance = (
  input: {
    exportId: string;
    manifestPath: string;
    manifest: CodaliStorageExportManifest;
    primaryArtifactRef: CodaliStorageObjectRef;
    primaryArtifactContentHash: string;
    acceptedRecordIds?: readonly string[];
    acceptedGatewayRecordIds?: readonly string[];
    acceptedDeletionGroupIds?: readonly string[];
  },
): DatasetExportCandidateProvenance => ({
  schemaVersion: CODALI_IMPROVEMENT_MANIFEST_READER_SCHEMA_VERSION,
  exportId: input.exportId,
  manifestId: input.manifest.manifestId,
  manifestPath: input.manifestPath,
  exportKind: input.manifest.exportKind,
  exportFormat: input.manifest.exportFormat,
  checksum: input.manifest.checksum,
  recordCount: input.manifest.recordCount,
  sourceRecordIds: uniqueStrings([
    ...(input.acceptedRecordIds ?? input.manifest.lineage.sourceRecordIds),
  ]),
  sourceGatewayRecordIds: uniqueStrings([
    ...(input.acceptedGatewayRecordIds ?? input.manifest.lineage.sourceGatewayRecordIds ?? []),
  ]),
  sourceObjectHashes: uniqueStrings(input.manifest.lineage.sourceObjectHashes),
  deletionGroupIds: uniqueStrings([
    ...(input.acceptedDeletionGroupIds ?? input.manifest.deletionGroupSnapshot.deletionGroupIds),
  ]),
  artifactRefs: input.manifest.artifactRefs.map((ref) => ({
    refId: ref.refId,
    contentHash: ref.contentHash,
    byteSize: ref.byteSize,
    mimeType: ref.mimeType,
    ...(ref.uri ? { uri: ref.uri } : {}),
  })),
  ...(input.manifest.generatedBy ? { generatedBy: input.manifest.generatedBy } : {}),
  primaryArtifactRefId: input.primaryArtifactRef.refId,
  primaryArtifactContentHash: input.primaryArtifactContentHash,
});

const candidateKindForExport = (
  exportKind: CodaliStorageExportKind,
): CodaliImprovementCandidateKind | undefined => {
  if (exportKind === "eval-replay") return "eval_replay";
  if (exportKind === "model-router") return "model_router";
  if (exportKind === "prompt-regression") return "prompt";
  return undefined;
};

const candidateIdForProvenance = (
  provenance: DatasetExportCandidateProvenance,
): string =>
  `candidate-${sha256Hex(JSON.stringify({
    exportId: provenance.exportId,
    checksum: provenance.checksum,
    sourceRecordIds: provenance.sourceRecordIds,
  })).slice(0, 16)}`;

const buildCandidates = (
  provenance: DatasetExportCandidateProvenance,
  curationReport: DatasetEligibilityGateReport,
): DatasetExportImprovementCandidate[] => {
  const candidateKind = candidateKindForExport(provenance.exportKind);
  if (
    !candidateKind ||
    !curationReport.artifactReadAllowed ||
    !curationReport.lineageValid ||
    curationReport.acceptedCount === 0
  ) {
    return [];
  }
  return [{
    candidateId: candidateIdForProvenance(provenance),
    candidateKind,
    status: "proposed",
    sourceExportIds: [provenance.manifestId],
    sourceRecordIds: provenance.sourceRecordIds,
    artifactIds: provenance.artifactRefs.map((ref) => ref.refId),
    exampleCount: curationReport.acceptedCount,
    objectBytes: provenance.artifactRefs.reduce((total, ref) => total + ref.byteSize, 0),
    provenance,
  }];
};

const unsupportedWarnings = (
  manifest: CodaliStorageExportManifest,
  supportedKinds: readonly CodaliStorageExportKind[],
): DatasetExportManifestReaderWarning[] =>
  supportedKinds.includes(manifest.exportKind)
    ? []
    : [{
        code: "unsupported_export_kind",
        exportKind: manifest.exportKind,
        message: `Export kind ${manifest.exportKind} is not supported for improvement candidate generation.`,
      }];

export class DatasetExportManifestReader {
  async inspect(
    input: DatasetExportManifestReaderInput,
  ): Promise<DatasetExportManifestReaderResult> {
    const manifestPath = await resolveManifestPath(input);
    const manifest = await validateManifest(manifestPath);
    const primaryRef = primaryArtifactRef(manifest);
    const exportId = input.exportId?.trim() || manifest.manifestId;
    const preflightReport = curateDatasetExportForImprovement({
      exportId,
      manifest,
      primaryArtifactRef: primaryRef,
      allowedArtifactTypes: input.allowedExampleArtifactTypes,
      revokedDeletionGroupIds: input.revokedDeletionGroupIds,
    });
    const verified = preflightReport.artifactReadAllowed
      ? await verifyArtifact(primaryRef, manifest.checksum)
      : undefined;
    const curationReport = verified
      ? curateDatasetExportForImprovement({
          exportId,
          manifest,
          primaryArtifactRef: primaryRef,
          rows: verified.rows,
          allowedArtifactTypes: input.allowedExampleArtifactTypes,
          revokedDeletionGroupIds: input.revokedDeletionGroupIds,
        })
      : preflightReport;
    const provenance = buildProvenance({
      exportId,
      manifestPath,
      manifest,
      primaryArtifactRef: primaryRef,
      primaryArtifactContentHash: verified?.artifact.contentHash ?? primaryRef.contentHash,
      acceptedRecordIds: curationReport.acceptedRecordIds,
      acceptedGatewayRecordIds: curationReport.accepted
        .map((example) => example.sourceGatewayRecordId)
        .filter((value): value is string => Boolean(value)),
      acceptedDeletionGroupIds: uniqueStrings(curationReport.accepted
        .flatMap((example) => example.deletionGroupIds)),
    });
    const supportedKinds = input.supportedExportKinds ??
      CODALI_IMPROVEMENT_SUPPORTED_EXPORT_KINDS;
    const warnings = unsupportedWarnings(manifest, supportedKinds);
    return {
      schemaVersion: CODALI_IMPROVEMENT_MANIFEST_READER_SCHEMA_VERSION,
      exportId,
      manifestPath,
      manifest,
      ...(verified ? { primaryArtifact: verified.artifact } : {}),
      primaryArtifactRows: verified?.rows ?? [],
      provenance,
      candidates: warnings.some((warning) => warning.code === "unsupported_export_kind")
        ? []
        : buildCandidates(provenance, curationReport),
      warnings,
      curationReport,
    };
  }
}

export const inspectDatasetExportManifestForImprovement = (
  input: DatasetExportManifestReaderInput,
): Promise<DatasetExportManifestReaderResult> =>
  new DatasetExportManifestReader().inspect(input);
