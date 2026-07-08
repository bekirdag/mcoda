import { createHash } from "node:crypto";
import {
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  type CodaliStorageDatasetKind,
  type CodaliStorageExportKind,
  type CodaliStorageObjectRef,
} from "../storage/CodaliStorageContracts.js";
import { CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION } from "../storage/DatasetExportJob.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  type GatewayDatasetObjectStore,
} from "../storage/GatewayDatasetStore.js";
import type {
  CodaliGatewayEvalCase,
  CodaliGatewayEvalCaseExpectations,
  CodaliGatewayEvalDatasetMetadata,
  CodaliGatewayEvalTaskType,
} from "./GatewayEvalSuite.js";

export const CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION = 1 as const;

export type CodaliGatewayDatasetEvalStage =
  | "classifier"
  | "planner"
  | "tool_router"
  | "rag_retrieval"
  | "evidence_extractor"
  | "verifier"
  | "context_pack"
  | "final_answer"
  | "schema_repair"
  | "policy_event";

export const CODALI_GATEWAY_DATASET_EVAL_STAGES: CodaliGatewayDatasetEvalStage[] = [
  "classifier",
  "planner",
  "tool_router",
  "rag_retrieval",
  "evidence_extractor",
  "verifier",
  "context_pack",
  "final_answer",
  "schema_repair",
  "policy_event",
];

export const CODALI_GATEWAY_DATASET_EVAL_PROMPT_VERSIONS: Record<
  CodaliGatewayDatasetEvalStage,
  string
> = {
  classifier: "codali.gateway.dataset.classifier.prompt.v1",
  planner: "codali.gateway.dataset.planner.prompt.v1",
  tool_router: "codali.gateway.dataset.tool-router.prompt.v1",
  rag_retrieval: "codali.gateway.dataset.rag-retrieval.prompt.v1",
  evidence_extractor: "codali.gateway.dataset.evidence-extractor.prompt.v1",
  verifier: "codali.gateway.dataset.verifier.prompt.v1",
  context_pack: "codali.gateway.dataset.context-pack.prompt.v1",
  final_answer: "codali.gateway.dataset.final-answer.prompt.v1",
  schema_repair: "codali.gateway.dataset.schema-repair.prompt.v1",
  policy_event: "codali.gateway.dataset.policy-event.prompt.v1",
};

export interface CodaliGatewayDatasetReplayFixtureRecord {
  recordId: string;
  datasetKind: CodaliStorageDatasetKind;
  sourceGatewayRecordId?: string;
  inputRef: CodaliStorageObjectRef;
  outputRef?: CodaliStorageObjectRef;
  evidenceRefs?: CodaliStorageObjectRef[];
  quality?: {
    score?: number;
    labels?: string[];
    reviewed?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayDatasetReplayFixture {
  schemaVersion: typeof CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION;
  exportKind: CodaliStorageExportKind;
  generatedAt: string;
  records: CodaliGatewayDatasetReplayFixtureRecord[];
}

export interface CodaliGatewayDatasetEvalSkippedRecord {
  recordId: string;
  stage?: CodaliGatewayDatasetEvalStage;
  reason: string;
}

export interface CodaliGatewayDatasetEvalImportLineage {
  schemaVersion: typeof CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION;
  source: "dataset_replay_fixture";
  fixtureId?: string;
  fixtureSchemaVersion: typeof CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION;
  exportKind: CodaliStorageExportKind;
  generatedAt: string;
  importedAt: string;
  selectedRecordCount: number;
  skippedRecordCount: number;
  sourceRecordIds: string[];
  sourceGatewayRecordIds: string[];
  sourceObjectHashes: string[];
  stageCounts: Record<CodaliGatewayDatasetEvalStage, number>;
  skippedRecords: CodaliGatewayDatasetEvalSkippedRecord[];
}

export interface CodaliGatewayDatasetEvalImportResult {
  cases: CodaliGatewayEvalCase[];
  lineage: CodaliGatewayDatasetEvalImportLineage;
}

export interface CodaliGatewayDatasetReplayFixtureImportOptions {
  fixture: unknown;
  fixtureId?: string;
  objectStore?: GatewayDatasetObjectStore;
  stages?: CodaliGatewayDatasetEvalStage[];
  limitPerStage?: number;
  now?: () => Date;
}

export class CodaliGatewayDatasetEvalImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CodaliGatewayDatasetEvalImportError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const metadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const safeIdPart = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "record";

const uniqueInOrder = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
};

const emptyStageCounts = (): Record<CodaliGatewayDatasetEvalStage, number> =>
  CODALI_GATEWAY_DATASET_EVAL_STAGES.reduce<Record<CodaliGatewayDatasetEvalStage, number>>(
    (output, stage) => {
      output[stage] = 0;
      return output;
    },
    {} as Record<CodaliGatewayDatasetEvalStage, number>,
  );

const stageFromMetadata = (
  metadata: Record<string, unknown> | undefined,
): CodaliGatewayDatasetEvalStage | undefined => {
  const explicitStage = metadataString(metadata, "evalStage")
    ?? metadataString(metadata, "eval_stage")
    ?? metadataString(metadata, "gatewayEvalStage")
    ?? metadataString(metadata, "gateway_eval_stage");
  if (
    explicitStage
    && CODALI_GATEWAY_DATASET_EVAL_STAGES.includes(explicitStage as CodaliGatewayDatasetEvalStage)
  ) {
    return explicitStage as CodaliGatewayDatasetEvalStage;
  }

  const exampleType = metadataString(metadata, "exampleType")
    ?? metadataString(metadata, "example_type");
  if (exampleType === "tool_decision") return "tool_router";
  if (exampleType === "rag_retrieval") return "rag_retrieval";
  if (exampleType === "evidence_item") return "evidence_extractor";
  if (exampleType === "context_pack") return "context_pack";
  if (exampleType === "final_answer" || exampleType === "gold_target") return "final_answer";
  if (exampleType === "schema_failure") return "schema_repair";
  if (exampleType === "policy_event") return "policy_event";
  if (exampleType !== "model_stage") return undefined;

  const role = metadataString(metadata, "role") ?? "";
  if (role.includes("classifier")) return "classifier";
  if (role.includes("planner")) return "planner";
  if (role.includes("verifier")) return "verifier";
  if (role.includes("final")) return "final_answer";
  if (metadata?.schemaFailureRecordId || metadata?.repairAttempts) return "schema_repair";
  return undefined;
};

const stageForRecord = (
  record: CodaliGatewayDatasetReplayFixtureRecord,
): CodaliGatewayDatasetEvalStage | undefined => {
  const stage = stageFromMetadata(record.metadata);
  if (stage) return stage;
  if (record.datasetKind === "tool_trace") return "tool_router";
  if (record.datasetKind === "gateway_answer") return "final_answer";
  if (record.datasetKind === "evaluation") return "evidence_extractor";
  if (record.datasetKind === "model_call") return "planner";
  return undefined;
};

const refsForRecord = (
  record: CodaliGatewayDatasetReplayFixtureRecord,
): CodaliStorageObjectRef[] => [
  record.inputRef,
  ...(record.outputRef ? [record.outputRef] : []),
  ...(record.evidenceRefs ?? []),
];

const refsAllowEvalReplay = (
  record: CodaliGatewayDatasetReplayFixtureRecord,
): boolean =>
  refsForRecord(record).every((ref) =>
    ref.privacyFlags.evalAllowed && ref.privacyFlags.replayAllowed);

const taskTypeForStage = (
  stage: CodaliGatewayDatasetEvalStage,
): CodaliGatewayEvalTaskType => {
  if (stage === "tool_router") return "product_tool_question";
  if (stage === "policy_event") return "disabled_integration_question";
  if (
    stage === "rag_retrieval"
    || stage === "evidence_extractor"
    || stage === "context_pack"
    || stage === "planner"
    || stage === "verifier"
  ) {
    return "code_repo_question";
  }
  return "generic_question";
};

const sourceTypeForRecord = (
  record: CodaliGatewayDatasetReplayFixtureRecord,
): string => metadataString(record.metadata, "sourceType")
  ?? metadataString(record.metadata, "source_type")
  ?? "docdex";

const toolForRecord = (
  record: CodaliGatewayDatasetReplayFixtureRecord,
  fallback: string,
): string => metadataString(record.metadata, "tool") ?? fallback;

const expectationsForStage = (
  stage: CodaliGatewayDatasetEvalStage,
  record: CodaliGatewayDatasetReplayFixtureRecord,
): CodaliGatewayEvalCaseExpectations => {
  const base = {
    requiresFinalLargeModel: true,
    maxLatencyMs: 8_000,
    maxTokens: 2_400,
    maxModelCalls: 5,
    maxCostUsd: 0.35,
  };
  if (stage === "tool_router") {
    const tool = toolForRecord(record, "app_tool_gateway");
    return {
      ...base,
      allowedTools: [tool],
      requiredTools: [tool],
      requiredSourceTypes: ["app_tool_gateway"],
      requiresEvidence: true,
      maxToolCalls: 2,
    };
  }
  if (stage === "rag_retrieval") {
    return {
      ...base,
      allowedTools: ["docdex_search"],
      requiredTools: ["docdex_search"],
      requiredSourceTypes: ["docdex"],
      requiresEvidence: true,
      maxToolCalls: 3,
    };
  }
  if (stage === "evidence_extractor" || stage === "context_pack") {
    return {
      ...base,
      allowedTools: ["docdex_search"],
      requiredTools: ["docdex_search"],
      requiredSourceTypes: [sourceTypeForRecord(record)],
      requiresEvidence: true,
      maxToolCalls: 3,
    };
  }
  if (stage === "verifier") {
    return {
      ...base,
      allowedTools: ["docdex_search"],
      requiredTools: ["docdex_search"],
      requiredSourceTypes: [sourceTypeForRecord(record)],
      requiresEvidence: true,
      maxToolCalls: 2,
    };
  }
  if (stage === "policy_event") {
    return {
      ...base,
      allowedTools: [],
      deniedTools: [toolForRecord(record, "write_file")],
      maxToolCalls: 0,
    };
  }
  return {
    ...base,
    allowedTools: [],
    maxToolCalls: 0,
  };
};

const summarizePayload = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  for (const key of ["prompt", "query", "tool", "role", "eventType", "event_type"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return `${key}: ${value.trim().slice(0, 160)}`;
    }
  }
  return undefined;
};

const readObjectPayload = async (
  objectStore: GatewayDatasetObjectStore | undefined,
  ref: CodaliStorageObjectRef,
): Promise<unknown | undefined> => {
  if (!objectStore?.readObject) return undefined;
  return objectStore.readObject(ref);
};

const caseForRecord = async (
  input: {
    record: CodaliGatewayDatasetReplayFixtureRecord;
    stage: CodaliGatewayDatasetEvalStage;
    fixture: CodaliGatewayDatasetReplayFixture;
    fixtureId?: string;
    objectStore?: GatewayDatasetObjectStore;
  },
): Promise<CodaliGatewayEvalCase> => {
  const payload = await readObjectPayload(input.objectStore, input.record.inputRef);
  const payloadSummary = summarizePayload(payload);
  const prompt = [
    `Replay dataset-backed ${input.stage} example ${input.record.recordId}.`,
    payloadSummary ? `Input ${payloadSummary}.` : "Use the imported object references as replay inputs.",
  ].join(" ");
  const promptVersion = CODALI_GATEWAY_DATASET_EVAL_PROMPT_VERSIONS[input.stage];
  const sourceObjectHashes = refsForRecord(input.record).map((ref) => ref.contentHash);
  const dataset: CodaliGatewayEvalDatasetMetadata = {
    source: "dataset_replay_fixture",
    stage: input.stage,
    sourceRecordId: input.record.recordId,
    sourceGatewayRecordId: input.record.sourceGatewayRecordId,
    datasetKind: input.record.datasetKind,
    promptVersion,
    schemaVersions: {
      gatewayEval: 1,
      datasetEval: CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION,
      storageContract: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      datasetReplayFixture: CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION,
      datasetRecord: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    },
    sourceObjectHashes,
    replayFixtureId: input.fixtureId,
    exportKind: input.fixture.exportKind,
    generatedAt: input.fixture.generatedAt,
  };
  return {
    id: `dataset-${input.stage}-${safeIdPart(input.record.recordId)}`,
    type: taskTypeForStage(input.stage),
    prompt,
    expectations: expectationsForStage(input.stage, input.record),
    dataset,
  };
};

const parseFixtureRecord = (
  value: unknown,
  index: number,
): CodaliGatewayDatasetReplayFixtureRecord => {
  if (!isRecord(value)) {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_RECORD_INVALID",
      `Replay fixture record ${index + 1} is not an object.`,
    );
  }
  if (typeof value.recordId !== "string" || value.recordId.length === 0) {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_RECORD_ID_MISSING",
      `Replay fixture record ${index + 1} is missing recordId.`,
    );
  }
  if (typeof value.datasetKind !== "string") {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_KIND_MISSING",
      `Replay fixture record ${value.recordId} is missing datasetKind.`,
    );
  }
  if (!isRecord(value.inputRef)) {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_INPUT_REF_MISSING",
      `Replay fixture record ${value.recordId} is missing inputRef.`,
    );
  }
  return {
    recordId: value.recordId,
    datasetKind: value.datasetKind as CodaliStorageDatasetKind,
    sourceGatewayRecordId: typeof value.sourceGatewayRecordId === "string"
      ? value.sourceGatewayRecordId
      : undefined,
    inputRef: value.inputRef as unknown as CodaliStorageObjectRef,
    outputRef: isRecord(value.outputRef)
      ? value.outputRef as unknown as CodaliStorageObjectRef
      : undefined,
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.filter(isRecord).map((ref) => ref as unknown as CodaliStorageObjectRef)
      : undefined,
    quality: isRecord(value.quality) ? value.quality : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};

export const parseCodaliGatewayDatasetReplayFixture = (
  fixture: unknown,
): CodaliGatewayDatasetReplayFixture => {
  if (!isRecord(fixture)) {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_FIXTURE_INVALID",
      "Replay fixture must be a JSON object.",
    );
  }
  if (fixture.schemaVersion !== CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION) {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_FIXTURE_SCHEMA_UNSUPPORTED",
      `Unsupported replay fixture schemaVersion: ${String(fixture.schemaVersion)}.`,
    );
  }
  if (typeof fixture.exportKind !== "string") {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_EXPORT_KIND_MISSING",
      "Replay fixture is missing exportKind.",
    );
  }
  if (typeof fixture.generatedAt !== "string") {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_GENERATED_AT_MISSING",
      "Replay fixture is missing generatedAt.",
    );
  }
  if (!Array.isArray(fixture.records)) {
    throw new CodaliGatewayDatasetEvalImportError(
      "CODALI_GATEWAY_DATASET_EVAL_RECORDS_MISSING",
      "Replay fixture is missing records.",
    );
  }
  return {
    schemaVersion: CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION,
    exportKind: fixture.exportKind as CodaliStorageExportKind,
    generatedAt: fixture.generatedAt,
    records: fixture.records.map(parseFixtureRecord),
  };
};

export const importCodaliGatewayDatasetReplayFixture = async (
  options: CodaliGatewayDatasetReplayFixtureImportOptions,
): Promise<CodaliGatewayDatasetEvalImportResult> => {
  const fixture = parseCodaliGatewayDatasetReplayFixture(options.fixture);
  const now = options.now ?? (() => new Date());
  const limitPerStage = options.limitPerStage ?? 1;
  const stages = options.stages ?? CODALI_GATEWAY_DATASET_EVAL_STAGES;
  const stageSet = new Set(stages);
  const stageCounts = emptyStageCounts();
  const skippedRecords: CodaliGatewayDatasetEvalSkippedRecord[] = [];
  const cases: CodaliGatewayEvalCase[] = [];

  for (const record of fixture.records) {
    const stage = stageForRecord(record);
    if (!stage || !stageSet.has(stage)) {
      skippedRecords.push({ recordId: record.recordId, reason: "stage_not_selected" });
      continue;
    }
    if (!refsAllowEvalReplay(record)) {
      skippedRecords.push({ recordId: record.recordId, stage, reason: "eval_or_replay_not_allowed" });
      continue;
    }
    if (stageCounts[stage] >= limitPerStage) {
      skippedRecords.push({ recordId: record.recordId, stage, reason: "stage_limit_reached" });
      continue;
    }
    cases.push(await caseForRecord({
      record,
      stage,
      fixture,
      fixtureId: options.fixtureId,
      objectStore: options.objectStore,
    }));
    stageCounts[stage] += 1;
  }

  const sourceRecordIds = cases.map((evalCase) => evalCase.dataset?.sourceRecordId);
  const sourceGatewayRecordIds = cases.map((evalCase) => evalCase.dataset?.sourceGatewayRecordId);
  const sourceObjectHashes = cases.flatMap((evalCase) => evalCase.dataset?.sourceObjectHashes ?? []);
  return {
    cases,
    lineage: {
      schemaVersion: CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION,
      source: "dataset_replay_fixture",
      fixtureId: options.fixtureId,
      fixtureSchemaVersion: CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION,
      exportKind: fixture.exportKind,
      generatedAt: fixture.generatedAt,
      importedAt: now().toISOString(),
      selectedRecordCount: cases.length,
      skippedRecordCount: skippedRecords.length,
      sourceRecordIds: uniqueInOrder(sourceRecordIds),
      sourceGatewayRecordIds: uniqueInOrder(sourceGatewayRecordIds),
      sourceObjectHashes: uniqueInOrder(sourceObjectHashes),
      stageCounts,
      skippedRecords,
    },
  };
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const defaultObjectRef = (
  stage: CodaliGatewayDatasetEvalStage,
  recordId: string,
  part: string,
): CodaliStorageObjectRef => {
  const hash = sha256(`${stage}:${recordId}:${part}`);
  return {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    refId: `ref-${safeIdPart(recordId)}-${part}`,
    kind: part === "evidence" ? "evidence" : "dataset",
    contentHash: `sha256:${hash}`,
    byteSize: 128,
    mimeType: "application/json",
    privacyFlags: createGatewayDatasetLocalOnlyObjectPrivacyFlags({
      containsPersonalData: false,
      containsTenantPrivateData: false,
      containsCustomerData: false,
      exportAllowed: true,
      evalAllowed: true,
      replayAllowed: true,
      trainingAllowed: false,
    }),
    ownerScope: {
      tenantHash: "tenant-local-hash",
      productId: "product-neutral",
      deploymentId: "local",
      runId: "gateway-dataset-eval",
      ownerType: "dataset_record",
      ownerId: recordId,
    },
    deletionGroupId: `dg-${safeIdPart(recordId)}`,
    retentionClass: "dataset",
    metadata: { part },
  };
};

const defaultFixtureRecord = (
  stage: CodaliGatewayDatasetEvalStage,
  input: {
    datasetKind: CodaliStorageDatasetKind;
    exampleType: string;
    role?: string;
    tool?: string;
    sourceType?: string;
  },
): CodaliGatewayDatasetReplayFixtureRecord => {
  const recordId = `default-${stage}`;
  return {
    recordId,
    datasetKind: input.datasetKind,
    sourceGatewayRecordId: "default-gateway-run",
    inputRef: defaultObjectRef(stage, recordId, "input"),
    outputRef: defaultObjectRef(stage, recordId, "output"),
    evidenceRefs: input.sourceType ? [defaultObjectRef(stage, recordId, "evidence")] : undefined,
    quality: {
      score: 0.9,
      labels: [`eval:${stage}`, "reviewed:auto"],
      reviewed: true,
    },
    metadata: {
      evalStage: stage,
      exampleType: input.exampleType,
      role: input.role,
      tool: input.tool,
      sourceType: input.sourceType,
      collectionMode: "gateway_dataset_eval_default",
    },
  };
};

export const createDefaultCodaliGatewayDatasetReplayFixture =
  (): CodaliGatewayDatasetReplayFixture => ({
    schemaVersion: CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION,
    exportKind: "eval-replay",
    generatedAt: new Date(0).toISOString(),
    records: [
      defaultFixtureRecord("classifier", {
        datasetKind: "model_call",
        exampleType: "model_stage",
        role: "classifier",
      }),
      defaultFixtureRecord("planner", {
        datasetKind: "model_call",
        exampleType: "model_stage",
        role: "planner",
      }),
      defaultFixtureRecord("tool_router", {
        datasetKind: "tool_trace",
        exampleType: "tool_decision",
        tool: "app_tool_gateway",
      }),
      defaultFixtureRecord("rag_retrieval", {
        datasetKind: "tool_trace",
        exampleType: "rag_retrieval",
        tool: "docdex_search",
        sourceType: "docdex",
      }),
      defaultFixtureRecord("evidence_extractor", {
        datasetKind: "evaluation",
        exampleType: "evidence_item",
        sourceType: "docdex",
      }),
      defaultFixtureRecord("verifier", {
        datasetKind: "model_call",
        exampleType: "model_stage",
        role: "verifier",
        sourceType: "docdex",
      }),
      defaultFixtureRecord("context_pack", {
        datasetKind: "evaluation",
        exampleType: "context_pack",
        sourceType: "docdex",
      }),
      defaultFixtureRecord("final_answer", {
        datasetKind: "gateway_answer",
        exampleType: "final_answer",
      }),
      defaultFixtureRecord("schema_repair", {
        datasetKind: "evaluation",
        exampleType: "schema_failure",
        role: "planner",
      }),
      defaultFixtureRecord("policy_event", {
        datasetKind: "tool_trace",
        exampleType: "policy_event",
        tool: "write_file",
      }),
    ],
  });

export const createDefaultCodaliGatewayDatasetEvalImport = async (): Promise<
  CodaliGatewayDatasetEvalImportResult
> =>
  importCodaliGatewayDatasetReplayFixture({
    fixture: createDefaultCodaliGatewayDatasetReplayFixture(),
    fixtureId: "codali-gateway-dataset-default-eval-replay",
    now: () => new Date(0),
  });
