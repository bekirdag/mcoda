import { createHash } from "node:crypto";
import type {
  CodaliStorageDatasetKind,
  CodaliStorageObjectPrivacyFlags,
  CodaliStorageObjectRef,
} from "../storage/CodaliStorageContracts.js";
import type {
  DatasetEligibilityGateAcceptedExample,
  DatasetEligibilityGateRejectedExample,
} from "./DatasetEligibilityGate.js";
import type { DatasetExportManifestReaderResult } from "./DatasetExportManifestReader.js";

export const CODALI_PATCH_CANDIDATE_SCHEMA_VERSION =
  "codali.improvement.patch_candidate.v1" as const;

export const CODALI_PATCH_PROPOSAL_ARTIFACTS = [
  "prompt",
  "schema",
  "tool-metadata",
] as const;

export type CodaliPatchProposalArtifact =
  (typeof CODALI_PATCH_PROPOSAL_ARTIFACTS)[number];

export type CodaliPatchCandidateKind = "prompt" | "schema" | "tool_metadata";

export type CodaliPatchOperationType =
  | "add_prompt_failure_guardrail"
  | "tighten_schema_contract"
  | "update_tool_metadata_contract";

export interface CodaliPatchObjectRefSummary {
  refId: string;
  kind: string;
  contentHash: string;
  byteSize: number;
  mimeType: string;
  deletionGroupId: string;
  privacyFlags: CodaliStorageObjectPrivacyFlags;
  uri?: string;
  mediaType?: string;
  metadataKeys: string[];
}

export interface CodaliPatchSourceExample {
  recordId: string;
  sourceGatewayRecordId?: string;
  datasetKind?: CodaliStorageDatasetKind;
  artifactTypes: string[];
  failureClasses: string[];
  failureReasonCodes: string[];
  preferenceSignals: string[];
  priorityScore: number;
  lineageKey: {
    runIds: string[];
    deletionGroupIds: string[];
    promptHash?: string;
    schemaHash?: string;
    toolContractHash?: string;
    expectedTargetHash?: string;
  };
  objectRefs: {
    inputRef?: CodaliPatchObjectRefSummary;
    outputRef?: CodaliPatchObjectRefSummary;
    evidenceRefs: CodaliPatchObjectRefSummary[];
  };
  metadataShape: {
    keys: string[];
    failureEvidenceKeys: string[];
    contractKeys: string[];
  };
}

export interface CodaliPatchFailureEvidence {
  source: "source_example" | "curation_rejection";
  recordId?: string;
  targetType?: DatasetEligibilityGateRejectedExample["targetType"];
  failureClasses: string[];
  reasonCodes: string[];
  paths: string[];
}

export interface CodaliPatchPlanOperation {
  operationId: string;
  operationType: CodaliPatchOperationType;
  productNeutral: true;
  contractDriven: true;
  sourceRecordIds: string[];
  failureClasses: string[];
  requiredEvidence: Array<"source_examples" | "failure_classes">;
  writesRuntimeCode: false;
  target: {
    artifact: CodaliPatchProposalArtifact;
    candidateKind: CodaliPatchCandidateKind;
    promptHashes: string[];
    schemaHashes: string[];
    toolContractHashes: string[];
    expectedTargetHashes: string[];
  };
}

export interface CodaliPatchPlan {
  planId: string;
  artifact: CodaliPatchProposalArtifact;
  candidateKind: CodaliPatchCandidateKind;
  deterministic: true;
  patchArtifactType: "prompt_patch" | "schema_patch" | "tool_metadata_patch";
  sourceExampleCount: number;
  failureClasses: string[];
  operations: CodaliPatchPlanOperation[];
  blockedReasons: string[];
}

export interface CodaliPromptRegressionEvalCandidate {
  suiteId: string;
  sourceExportId: string;
  wouldFailBeforeChange: true;
  cases: Array<{
    caseId: string;
    sourceRecordId: string;
    failureClasses: string[];
    preChangeExpectedStatus: "fail";
    postChangeExpectedStatus: "pass";
    assertions: string[];
    objectRefs: CodaliPatchSourceExample["objectRefs"];
  }>;
}

export interface CodaliPatchImprovementCandidateSummary {
  candidateId: string;
  candidateKind: CodaliPatchCandidateKind;
  status: "proposed" | "blocked";
  patchPlanId: string;
  sourceExportIds: string[];
  sourceRecordIds: string[];
  artifactIds: string[];
  exampleCount: number;
  objectBytes: number;
  failureClasses: string[];
  blockedReasons: string[];
}

export interface CodaliPatchCandidateBundle {
  schemaVersion: typeof CODALI_PATCH_CANDIDATE_SCHEMA_VERSION;
  artifact: CodaliPatchProposalArtifact;
  source: {
    exportId: string;
    manifestId: string;
    manifestPath: string;
    exportKind: string;
    checksum: string;
    recordCount: number;
    primaryArtifactRef: CodaliPatchObjectRefSummary;
  };
  generationPolicy: {
    deterministic: true;
    modifiesRuntimePrompts: false;
    modifiesRuntimeCode: false;
    bodyPolicy: "object_refs_only";
    failureEvidenceRequired: true;
    sourceExamplesRequired: true;
  };
  expectedShape: {
    schemaVersion: typeof CODALI_PATCH_CANDIDATE_SCHEMA_VERSION;
    artifact: CodaliPatchProposalArtifact;
    requiredFields: string[];
    sourceExampleRequiredFields: string[];
    patchPlanRequiredFields: string[];
  };
  sourceExamples: CodaliPatchSourceExample[];
  failureEvidence: CodaliPatchFailureEvidence[];
  failureClasses: string[];
  patchPlan: CodaliPatchPlan;
  promptEval?: CodaliPromptRegressionEvalCandidate;
  candidates: CodaliPatchImprovementCandidateSummary[];
}

export interface BuildCodaliPatchCandidateBundleInput {
  inspection: DatasetExportManifestReaderResult;
  artifact: CodaliPatchProposalArtifact;
}

interface ArtifactContract {
  artifact: CodaliPatchProposalArtifact;
  candidateKind: CodaliPatchCandidateKind;
  patchArtifactType: CodaliPatchPlan["patchArtifactType"];
  operationType: CodaliPatchOperationType;
  sourceArtifactTypes: string[];
  requiresToolContractHash?: boolean;
}

const ARTIFACT_CONTRACTS: Record<CodaliPatchProposalArtifact, ArtifactContract> = {
  prompt: {
    artifact: "prompt",
    candidateKind: "prompt",
    patchArtifactType: "prompt_patch",
    operationType: "add_prompt_failure_guardrail",
    sourceArtifactTypes: ["prompt", "prompt_patch", "prompt_regression"],
  },
  schema: {
    artifact: "schema",
    candidateKind: "schema",
    patchArtifactType: "schema_patch",
    operationType: "tighten_schema_contract",
    sourceArtifactTypes: ["schema", "schema_patch"],
  },
  "tool-metadata": {
    artifact: "tool-metadata",
    candidateKind: "tool_metadata",
    patchArtifactType: "tool_metadata_patch",
    operationType: "update_tool_metadata_contract",
    sourceArtifactTypes: ["tool_metadata", "tool_metadata_patch", "tool_contract"],
    requiresToolContractHash: true,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};

const sha256Hex = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const stableId = (prefix: string, value: unknown): string =>
  `${prefix}-${sha256Hex(value).slice(0, 16)}`;

const normalizeToken = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s-]+/g, "_");

const uniqueSorted = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))))
    .sort();

const normalizedUniqueSorted = (values: Array<string | undefined>): string[] =>
  uniqueSorted(values.map((value) => value ? normalizeToken(value) : undefined));

const readString = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const stringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
};

const objectList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const metadataForRow = (row: Record<string, unknown> | undefined): Record<string, unknown> =>
  isRecord(row?.metadata) ? row.metadata : {};

const objectRefFromValue = (value: unknown): CodaliStorageObjectRef | undefined =>
  isRecord(value) &&
  typeof value.refId === "string" &&
  typeof value.contentHash === "string" &&
  typeof value.byteSize === "number" &&
  typeof value.mimeType === "string" &&
  typeof value.deletionGroupId === "string" &&
  isRecord(value.privacyFlags)
    ? value as unknown as CodaliStorageObjectRef
    : undefined;

const refsForRow = (row: Record<string, unknown> | undefined): {
  inputRef?: CodaliStorageObjectRef;
  outputRef?: CodaliStorageObjectRef;
  evidenceRefs: CodaliStorageObjectRef[];
} => {
  const evidenceRefs = Array.isArray(row?.evidenceRefs)
    ? row.evidenceRefs.map(objectRefFromValue)
      .filter((ref): ref is CodaliStorageObjectRef => Boolean(ref))
    : [];
  return {
    inputRef: objectRefFromValue(row?.inputRef),
    outputRef: objectRefFromValue(row?.outputRef),
    evidenceRefs,
  };
};

const summarizeObjectRef = (ref: CodaliStorageObjectRef): CodaliPatchObjectRefSummary => ({
  refId: ref.refId,
  kind: ref.kind,
  contentHash: ref.contentHash,
  byteSize: ref.byteSize,
  mimeType: ref.mimeType,
  deletionGroupId: ref.deletionGroupId,
  privacyFlags: ref.privacyFlags,
  ...(ref.uri ? { uri: ref.uri } : {}),
  ...(ref.mediaType ? { mediaType: ref.mediaType } : {}),
  metadataKeys: isRecord(ref.metadata) ? Object.keys(ref.metadata).sort() : [],
});

const recordIdForRow = (row: unknown): string | undefined =>
  isRecord(row) ? readString(row, ["recordId", "record_id"]) : undefined;

const rowsByRecordId = (
  rows: readonly unknown[],
): Map<string, Record<string, unknown>> => {
  const output = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const recordId = recordIdForRow(row);
    if (recordId) output.set(recordId, row);
  }
  return output;
};

const nestedHash = (
  metadata: Record<string, unknown>,
  directKeys: readonly string[],
  nestedKeys: readonly string[],
): string | undefined => {
  const direct = readString(metadata, directKeys);
  if (direct) return direct;
  for (const key of nestedKeys) {
    const nested = metadata[key];
    if (!isRecord(nested)) continue;
    const hash = readString(nested, ["hash", "contentHash", "content_hash"]);
    if (hash) return hash;
  }
  return undefined;
};

const failureEvidenceRecords = (metadata: Record<string, unknown>): Record<string, unknown>[] => [
  ...objectList(metadata.failureEvidence),
  ...objectList(metadata.failure_evidence),
  ...objectList(metadata.failures),
  ...objectList(metadata.evalFailures),
  ...objectList(metadata.eval_failures),
];

const failureClassesForRow = (
  row: Record<string, unknown> | undefined,
): string[] => {
  const metadata = metadataForRow(row);
  const structured = failureEvidenceRecords(metadata);
  return normalizedUniqueSorted([
    ...stringList(metadata.failureClass),
    ...stringList(metadata.failure_class),
    ...stringList(metadata.failureClasses),
    ...stringList(metadata.failure_classes),
    ...structured.flatMap((entry) => [
      ...stringList(entry.failureClass),
      ...stringList(entry.failure_class),
      ...stringList(entry.failureClasses),
      ...stringList(entry.failure_classes),
      readString(entry, ["class", "category"]),
    ]),
  ]);
};

const failureReasonCodesForRow = (
  row: Record<string, unknown> | undefined,
): string[] => {
  const metadata = metadataForRow(row);
  const structured = failureEvidenceRecords(metadata);
  return normalizedUniqueSorted([
    ...stringList(metadata.reasonCode),
    ...stringList(metadata.reason_code),
    ...stringList(metadata.reasonCodes),
    ...stringList(metadata.reason_codes),
    ...stringList(metadata.failureReasonCodes),
    ...stringList(metadata.failure_reason_codes),
    ...structured.flatMap((entry) => [
      ...stringList(entry.reasonCode),
      ...stringList(entry.reason_code),
      ...stringList(entry.reasonCodes),
      ...stringList(entry.reason_codes),
      readString(entry, ["code"]),
    ]),
  ]);
};

const sourceExampleForAccepted = (
  item: DatasetEligibilityGateAcceptedExample,
  row: Record<string, unknown> | undefined,
): CodaliPatchSourceExample => {
  const refs = refsForRow(row);
  const metadata = metadataForRow(row);
  const schemaHash = nestedHash(
    metadata,
    ["schemaHash", "schema_hash", "schemaContractHash", "schema_contract_hash"],
    ["schema", "schemaMetadata", "schema_metadata", "schemaContract", "schema_contract"],
  ) ?? item.lineageKey.expectedTargetHash;
  const toolContractHash = item.lineageKey.toolContractHash ?? nestedHash(
    metadata,
    ["toolContractHash", "tool_contract_hash"],
    ["toolContract", "tool_contract", "toolMetadata", "tool_metadata"],
  );
  return {
    recordId: item.recordId,
    ...(item.sourceGatewayRecordId ? { sourceGatewayRecordId: item.sourceGatewayRecordId } : {}),
    ...(readString(row, ["datasetKind", "dataset_kind"])
      ? { datasetKind: readString(row, ["datasetKind", "dataset_kind"]) as CodaliStorageDatasetKind }
      : {}),
    artifactTypes: item.artifactTypes.map(normalizeToken).sort(),
    failureClasses: failureClassesForRow(row),
    failureReasonCodes: failureReasonCodesForRow(row),
    preferenceSignals: [...item.preferenceSignals].sort(),
    priorityScore: item.priorityScore,
    lineageKey: {
      runIds: item.lineageKey.runIds,
      deletionGroupIds: item.lineageKey.deletionGroupIds,
      ...(item.lineageKey.promptHash ? { promptHash: item.lineageKey.promptHash } : {}),
      ...(schemaHash ? { schemaHash } : {}),
      ...(toolContractHash ? { toolContractHash } : {}),
      ...(item.lineageKey.expectedTargetHash
        ? { expectedTargetHash: item.lineageKey.expectedTargetHash }
        : {}),
    },
    objectRefs: {
      ...(refs.inputRef ? { inputRef: summarizeObjectRef(refs.inputRef) } : {}),
      ...(refs.outputRef ? { outputRef: summarizeObjectRef(refs.outputRef) } : {}),
      evidenceRefs: refs.evidenceRefs.map(summarizeObjectRef),
    },
    metadataShape: {
      keys: Object.keys(metadata).sort(),
      failureEvidenceKeys: failureEvidenceRecords(metadata)
        .flatMap((entry) => Object.keys(entry))
        .sort(),
      contractKeys: Object.keys(metadata)
        .filter((key) => key.toLowerCase().includes("contract") || key.toLowerCase().includes("schema"))
        .sort(),
    },
  };
};

const explicitArtifactTypesForRow = (
  row: Record<string, unknown> | undefined,
): string[] => {
  const metadata = metadataForRow(row);
  const refs = refsForRow(row);
  return normalizedUniqueSorted([
    readString(metadata, [
      "artifactType",
      "artifact_type",
      "exampleType",
      "example_type",
    ]),
    ...[
      refs.inputRef,
      refs.outputRef,
      ...refs.evidenceRefs,
    ].map((ref) => readString(isRecord(ref?.metadata) ? ref.metadata : undefined, [
      "artifactType",
      "artifact_type",
    ])),
  ]);
};

const sourceExamplesForArtifact = (
  inspection: DatasetExportManifestReaderResult,
  artifact: CodaliPatchProposalArtifact,
): CodaliPatchSourceExample[] => {
  const rowMap = rowsByRecordId(inspection.primaryArtifactRows);
  const contract = ARTIFACT_CONTRACTS[artifact];
  const sourceTypes = new Set(contract.sourceArtifactTypes.map(normalizeToken));
  return inspection.curationReport.accepted
    .filter((item) => {
      const row = rowMap.get(item.recordId);
      const explicitTypes = explicitArtifactTypesForRow(row);
      const filterTypes = explicitTypes.length > 0
        ? explicitTypes
        : item.artifactTypes.map(normalizeToken);
      return filterTypes.some((type) => sourceTypes.has(type));
    })
    .map((item) => sourceExampleForAccepted(item, rowMap.get(item.recordId)))
    .sort((left, right) =>
      right.priorityScore - left.priorityScore || left.recordId.localeCompare(right.recordId));
};

const failureEvidenceForRejected = (
  rejected: readonly DatasetEligibilityGateRejectedExample[],
): CodaliPatchFailureEvidence[] =>
  rejected.map((item) => ({
    source: "curation_rejection",
    ...(item.recordId ? { recordId: item.recordId } : {}),
    targetType: item.targetType,
    failureClasses: normalizedUniqueSorted(item.reasons.map((reason) => reason.code)),
    reasonCodes: normalizedUniqueSorted(item.reasons.map((reason) => reason.code)),
    paths: uniqueSorted(item.reasons.map((reason) => reason.path)),
  }));

const failureEvidenceForSourceExamples = (
  sourceExamples: readonly CodaliPatchSourceExample[],
): CodaliPatchFailureEvidence[] =>
  sourceExamples.map((example) => ({
    source: "source_example",
    recordId: example.recordId,
    failureClasses: example.failureClasses,
    reasonCodes: example.failureReasonCodes,
    paths: [],
  }));

const objectBytesForSourceExamples = (
  sourceExamples: readonly CodaliPatchSourceExample[],
): number => {
  const refs = new Map<string, CodaliPatchObjectRefSummary>();
  for (const example of sourceExamples) {
    for (const ref of [
      example.objectRefs.inputRef,
      example.objectRefs.outputRef,
      ...example.objectRefs.evidenceRefs,
    ]) {
      if (ref) refs.set(`${ref.refId}:${ref.contentHash}`, ref);
    }
  }
  return Array.from(refs.values()).reduce((total, ref) => total + ref.byteSize, 0);
};

const targetHashesForExamples = (
  sourceExamples: readonly CodaliPatchSourceExample[],
): CodaliPatchPlanOperation["target"] => ({
  artifact: "prompt",
  candidateKind: "prompt",
  promptHashes: uniqueSorted(sourceExamples.map((example) => example.lineageKey.promptHash)),
  schemaHashes: uniqueSorted(sourceExamples.map((example) => example.lineageKey.schemaHash)),
  toolContractHashes: uniqueSorted(sourceExamples.map((example) => example.lineageKey.toolContractHash)),
  expectedTargetHashes: uniqueSorted(sourceExamples.map((example) => example.lineageKey.expectedTargetHash)),
});

const blockedReasonsFor = (
  contract: ArtifactContract,
  sourceExamples: readonly CodaliPatchSourceExample[],
  sourceFailureClasses: readonly string[],
  inspection: DatasetExportManifestReaderResult,
): string[] => uniqueSorted([
  sourceExamples.length === 0 ? "source_examples_required" : undefined,
  sourceFailureClasses.length === 0 ? "failure_classes_required" : undefined,
  !inspection.curationReport.artifactReadAllowed ? "artifact_payload_read_blocked" : undefined,
  !inspection.curationReport.lineageValid ? "lineage_invalid" : undefined,
  contract.requiresToolContractHash &&
    sourceExamples.every((example) => !example.lineageKey.toolContractHash)
    ? "tool_contract_hash_required"
    : undefined,
]);

const patchPlanFor = (
  input: {
    artifact: CodaliPatchProposalArtifact;
    sourceExamples: readonly CodaliPatchSourceExample[];
    sourceFailureClasses: readonly string[];
    blockedReasons: readonly string[];
    inspection: DatasetExportManifestReaderResult;
  },
): CodaliPatchPlan => {
  const contract = ARTIFACT_CONTRACTS[input.artifact];
  const target = {
    ...targetHashesForExamples(input.sourceExamples),
    artifact: input.artifact,
    candidateKind: contract.candidateKind,
  };
  const planId = stableId("patch-plan", {
    artifact: input.artifact,
    manifestId: input.inspection.manifest.manifestId,
    checksum: input.inspection.manifest.checksum,
    sourceRecordIds: input.sourceExamples.map((example) => example.recordId),
    failureClasses: input.sourceFailureClasses,
    target,
  });
  const operationId = stableId("patch-op", {
    planId,
    operationType: contract.operationType,
    sourceRecordIds: input.sourceExamples.map((example) => example.recordId),
    failureClasses: input.sourceFailureClasses,
    target,
  });
  const operations = input.sourceExamples.length > 0 && input.sourceFailureClasses.length > 0
    ? [{
        operationId,
        operationType: contract.operationType,
        productNeutral: true as const,
        contractDriven: true as const,
        sourceRecordIds: input.sourceExamples.map((example) => example.recordId),
        failureClasses: [...input.sourceFailureClasses],
        requiredEvidence: ["source_examples", "failure_classes"] as Array<
          "source_examples" | "failure_classes"
        >,
        writesRuntimeCode: false as const,
        target,
      }]
    : [];
  return {
    planId,
    artifact: input.artifact,
    candidateKind: contract.candidateKind,
    deterministic: true,
    patchArtifactType: contract.patchArtifactType,
    sourceExampleCount: input.sourceExamples.length,
    failureClasses: [...input.sourceFailureClasses],
    operations,
    blockedReasons: [...input.blockedReasons],
  };
};

const promptEvalFor = (
  input: {
    sourceExamples: readonly CodaliPatchSourceExample[];
    sourceFailureClasses: readonly string[];
    inspection: DatasetExportManifestReaderResult;
  },
): CodaliPromptRegressionEvalCandidate | undefined => {
  if (input.sourceExamples.length === 0 || input.sourceFailureClasses.length === 0) {
    return undefined;
  }
  const suiteId = stableId("prompt-eval-suite", {
    manifestId: input.inspection.manifest.manifestId,
    sourceRecordIds: input.sourceExamples.map((example) => example.recordId),
    failureClasses: input.sourceFailureClasses,
  });
  return {
    suiteId,
    sourceExportId: input.inspection.manifest.manifestId,
    wouldFailBeforeChange: true,
    cases: input.sourceExamples.map((example) => ({
      caseId: stableId("prompt-eval-case", {
        suiteId,
        recordId: example.recordId,
        failureClasses: example.failureClasses,
        inputHash: example.objectRefs.inputRef?.contentHash,
        outputHash: example.objectRefs.outputRef?.contentHash,
      }),
      sourceRecordId: example.recordId,
      failureClasses: example.failureClasses,
      preChangeExpectedStatus: "fail" as const,
      postChangeExpectedStatus: "pass" as const,
      assertions: [
        "uses_source_evidence",
        "covers_recorded_failure_class",
        "preserves_product_neutral_contract",
      ],
      objectRefs: example.objectRefs,
    })),
  };
};

const expectedShape = (
  artifact: CodaliPatchProposalArtifact,
): CodaliPatchCandidateBundle["expectedShape"] => ({
  schemaVersion: CODALI_PATCH_CANDIDATE_SCHEMA_VERSION,
  artifact,
  requiredFields: [
    "sourceExamples",
    "failureEvidence",
    "failureClasses",
    "patchPlan",
    "candidates",
  ],
  sourceExampleRequiredFields: [
    "recordId",
    "artifactTypes",
    "failureClasses",
    "lineageKey",
    "objectRefs",
  ],
  patchPlanRequiredFields: [
    "planId",
    "artifact",
    "deterministic",
    "failureClasses",
    "operations",
  ],
});

const primaryArtifactRefForInspection = (
  inspection: DatasetExportManifestReaderResult,
): CodaliStorageObjectRef => {
  const ref = inspection.primaryArtifact?.ref ?? inspection.manifest.artifactRefs[0];
  if (!ref) {
    throw new Error("CODALI_PATCH_PRIMARY_ARTIFACT_MISSING");
  }
  return ref;
};

export const buildCodaliPatchCandidateBundle = (
  input: BuildCodaliPatchCandidateBundleInput,
): CodaliPatchCandidateBundle => {
  const contract = ARTIFACT_CONTRACTS[input.artifact];
  const inspection = input.inspection;
  const sourceExamples = sourceExamplesForArtifact(inspection, input.artifact);
  const sourceFailureClasses = normalizedUniqueSorted(sourceExamples
    .flatMap((example) => example.failureClasses));
  const rejectedFailureEvidence = failureEvidenceForRejected(inspection.curationReport.rejected);
  const failureEvidence = [
    ...failureEvidenceForSourceExamples(sourceExamples),
    ...rejectedFailureEvidence,
  ];
  const failureClasses = normalizedUniqueSorted([
    ...sourceFailureClasses,
    ...rejectedFailureEvidence.flatMap((item) => item.failureClasses),
  ]);
  const blockedReasons = blockedReasonsFor(
    contract,
    sourceExamples,
    sourceFailureClasses,
    inspection,
  );
  const patchPlan = patchPlanFor({
    artifact: input.artifact,
    sourceExamples,
    sourceFailureClasses,
    blockedReasons,
    inspection,
  });
  const candidateId = stableId("candidate", {
    artifact: input.artifact,
    manifestId: inspection.manifest.manifestId,
    checksum: inspection.manifest.checksum,
    patchPlanId: patchPlan.planId,
    sourceRecordIds: sourceExamples.map((example) => example.recordId),
    failureClasses: sourceFailureClasses,
  });
  const promptEval = input.artifact === "prompt"
    ? promptEvalFor({ sourceExamples, sourceFailureClasses, inspection })
    : undefined;
  const candidateStatus: CodaliPatchImprovementCandidateSummary["status"] =
    blockedReasons.length === 0 ? "proposed" : "blocked";

  return {
    schemaVersion: CODALI_PATCH_CANDIDATE_SCHEMA_VERSION,
    artifact: input.artifact,
    source: {
      exportId: inspection.exportId,
      manifestId: inspection.manifest.manifestId,
      manifestPath: inspection.manifestPath,
      exportKind: inspection.manifest.exportKind,
      checksum: inspection.manifest.checksum,
      recordCount: inspection.manifest.recordCount,
      primaryArtifactRef: summarizeObjectRef(primaryArtifactRefForInspection(inspection)),
    },
    generationPolicy: {
      deterministic: true,
      modifiesRuntimePrompts: false,
      modifiesRuntimeCode: false,
      bodyPolicy: "object_refs_only",
      failureEvidenceRequired: true,
      sourceExamplesRequired: true,
    },
    expectedShape: expectedShape(input.artifact),
    sourceExamples,
    failureEvidence,
    failureClasses,
    patchPlan,
    ...(promptEval ? { promptEval } : {}),
    candidates: [{
      candidateId,
      candidateKind: contract.candidateKind,
      status: candidateStatus,
      patchPlanId: patchPlan.planId,
      sourceExportIds: [inspection.manifest.manifestId],
      sourceRecordIds: sourceExamples.map((example) => example.recordId),
      artifactIds: inspection.manifest.artifactRefs.map((ref) => ref.refId),
      exampleCount: sourceExamples.length,
      objectBytes: objectBytesForSourceExamples(sourceExamples),
      failureClasses: sourceFailureClasses,
      blockedReasons,
    }],
  };
};
