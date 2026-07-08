import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  CodaliContextPack,
  CodaliEvidenceItem,
  CodaliGatewayRequest,
  CodaliGatewayResult,
} from "../gateway/CodaliGatewayTypes.js";
import {
  redactCodaliGatewaySecrets,
  type CodaliGatewayRunTrace,
  type CodaliGatewayStoredArtifact,
  type CodaliGatewayStoredTask,
  type CodaliGatewayStoredToolCall,
} from "../gateway/CodaliGatewayStore.js";
import {
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  validateCodaliStorageDatasetRecord,
  type CodaliStorageDatasetKind,
  type CodaliStorageDatasetRecord,
  type CodaliStorageObjectPrivacyFlags,
  type CodaliStorageObjectRef,
  type CodaliStorageObjectRefKind,
  type CodaliStorageObjectRetentionClass,
  type CodaliStoragePrivacyMetadata,
} from "./CodaliStorageContracts.js";

export const GATEWAY_DATASET_SERVICE_SIGNATURE_VERSION = "codali.storage.hmac.v1";
export const DEFAULT_GATEWAY_DATASET_SERVICE_ENDPOINT = "/v1/gateway/batches";

export interface GatewayDatasetStorageScope {
  tenantId: string;
  productId: string;
  deploymentId: string;
  runId: string;
}

export type GatewayDatasetStoreWriteStatus = "stored" | "queued" | "skipped" | "failed";

export interface GatewayDatasetStoreWriteResult {
  accepted: boolean;
  status: GatewayDatasetStoreWriteStatus;
  recordCount: number;
  objectCount?: number;
  idempotencyKey?: string;
  batchId?: string;
  replayed?: boolean;
  fallbackUsed?: boolean;
  errors?: string[];
  metadata?: Record<string, unknown>;
}

export interface GatewayDatasetStoreCollectInput {
  scope: GatewayDatasetStorageScope;
  records: CodaliStorageDatasetRecord[];
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayDatasetStore {
  collect(input: GatewayDatasetStoreCollectInput): Promise<GatewayDatasetStoreWriteResult>;
}

export interface GatewayDatasetObjectPutInput {
  scope: GatewayDatasetStorageScope;
  payload: unknown;
  ownerType: string;
  ownerId: string;
  kind?: CodaliStorageObjectRefKind;
  mimeType?: string;
  retentionClass?: CodaliStorageObjectRetentionClass;
  privacyFlags?: Partial<CodaliStorageObjectPrivacyFlags>;
  metadata?: Record<string, unknown>;
}

export interface GatewayDatasetObjectStore {
  putObject(input: GatewayDatasetObjectPutInput): Promise<CodaliStorageObjectRef>;
  readObject?(ref: CodaliStorageObjectRef): Promise<unknown | undefined>;
}

export type GatewayDatasetGoldTargetKind = "accepted" | "corrected" | "reviewed";

export interface GatewayDatasetGoldTargetInput {
  id?: string;
  kind: GatewayDatasetGoldTargetKind;
  input?: unknown;
  target?: unknown;
  sourceRecordId?: string;
  sourceModelCallId?: string;
  failedAttemptRecordId?: string;
  failedAttemptModelCallId?: string;
  reviewerId?: string;
  reasons?: string[];
  score?: number;
  labels?: string[];
  metadata?: Record<string, unknown>;
}

export interface GatewayDatasetGatewayCollectionOptions {
  enabled?: boolean;
  objectStore?: GatewayDatasetObjectStore;
  fallbackStore?: GatewayDatasetStore;
  scope?: Partial<GatewayDatasetStorageScope>;
  privacy?: Partial<CodaliStoragePrivacyMetadata>;
  privacyFlags?: Partial<CodaliStorageObjectPrivacyFlags>;
  datasetKind?: CodaliStorageDatasetKind;
  idempotencyKey?: string;
  trace?: CodaliGatewayRunTrace;
  traceLoader?: () => Promise<CodaliGatewayRunTrace | undefined>;
  collectModelCalls?: boolean;
  collectSchemaFailures?: boolean;
  collectGoldTargets?: boolean;
  collectRagRetrievals?: boolean;
  collectToolDecisions?: boolean;
  collectEvidenceItems?: boolean;
  collectContextPacks?: boolean;
  collectFinalAnswers?: boolean;
  collectArtifacts?: boolean;
  collectPolicyEvents?: boolean;
  goldTargets?: GatewayDatasetGoldTargetInput[];
  metadata?: Record<string, unknown>;
  now?: () => Date;
  onError?: (error: unknown) => void;
  onResult?: (result: GatewayDatasetStoreWriteResult) => void;
}

export interface GatewayDatasetGatewayCollectionInput
  extends GatewayDatasetGatewayCollectionOptions {
  store: GatewayDatasetStore;
  request: CodaliGatewayRequest;
  result: CodaliGatewayResult;
}

export interface GatewayDatasetServiceClientOptions {
  baseUrl: string;
  serviceToken: string;
  hmacSecret?: string;
  endpointPath?: string;
  batchSize?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  fallbackStore?: GatewayDatasetStore;
  fetch?: GatewayDatasetFetch;
  now?: () => Date;
  nonceFactory?: () => string;
}

export interface GatewayDatasetFetchRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface GatewayDatasetFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type GatewayDatasetFetch = (
  url: string,
  request: GatewayDatasetFetchRequest,
) => Promise<GatewayDatasetFetchResponse>;

export interface LocalJsonlGatewayDatasetStoreOptions {
  directory: string;
  recordsFileName?: string;
  now?: () => Date;
}

export interface LocalJsonlGatewayDatasetObjectStoreOptions {
  directory: string;
  now?: () => Date;
}

export class GatewayDatasetStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GatewayDatasetStoreError";
    this.code = code;
  }
}

export class GatewayDatasetServiceClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(`${input.code}: ${input.message}`);
    this.name = "GatewayDatasetServiceClientError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const sanitizeGatewayDatasetPayload = <T>(value: T): T =>
  redactCodaliGatewaySecrets(value);

const sanitizeGatewayDatasetMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined;
  const sanitized = sanitizeGatewayDatasetPayload(metadata);
  return isRecord(sanitized) ? sanitized : undefined;
};

const normalizeCanonicalJson = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((item) => normalizeCanonicalJson(item));
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((output, key) => {
        output[key] = normalizeCanonicalJson(value[key]);
        return output;
      }, {});
  }
  return value;
};

export const canonicalizeGatewayDatasetJson = (value: unknown): string =>
  JSON.stringify(normalizeCanonicalJson(value));

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const hashGatewayDatasetRequestBody = (body: unknown): string =>
  sha256Hex(canonicalizeGatewayDatasetJson(body));

export const hashGatewayDatasetValue = (value: unknown): string =>
  `sha256:${hashGatewayDatasetRequestBody(value)}`;

const normalizeObjectPayloadBody = (payload: unknown, mimeType?: string): string => {
  if (typeof payload === "string" && mimeType === "application/x-ndjson") {
    return payload.endsWith("\n") ? payload : `${payload}\n`;
  }
  return `${canonicalizeGatewayDatasetJson(payload)}\n`;
};

const objectContentHash = (payload: unknown, mimeType?: string): string =>
  sha256Hex(normalizeObjectPayloadBody(payload, mimeType));

const objectByteSize = (payload: unknown, mimeType?: string): number =>
  Buffer.byteLength(normalizeObjectPayloadBody(payload, mimeType), "utf8");

const putGatewayDatasetObject = (
  objectStore: GatewayDatasetObjectStore,
  input: GatewayDatasetObjectPutInput,
): Promise<CodaliStorageObjectRef> =>
  objectStore.putObject({
    ...input,
    payload: sanitizeGatewayDatasetPayload(input.payload),
    metadata: sanitizeGatewayDatasetMetadata(input.metadata),
  });

export const createGatewayDatasetLocalOnlyPrivacy = (
  overrides: Partial<CodaliStoragePrivacyMetadata> = {},
): CodaliStoragePrivacyMetadata => {
  const { metadata, policyTags, ...rest } = overrides;
  return {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    classification: "internal",
    containsPersonalData: false,
    redactionStatus: "not_required",
    uploadAllowed: false,
    exportAllowed: false,
    trainingAllowed: false,
    policyTags: policyTags ?? ["local_only"],
    metadata: {
      collectionMode: "local_only",
      ...(metadata ?? {}),
    },
    ...rest,
  };
};

export const createGatewayDatasetLocalOnlyObjectPrivacyFlags = (
  overrides: Partial<CodaliStorageObjectPrivacyFlags> = {},
): CodaliStorageObjectPrivacyFlags => ({
  containsPersonalData: false,
  containsSecrets: false,
  containsTenantPrivateData: true,
  containsSourceCode: false,
  containsCustomerData: true,
  trainingAllowed: false,
  evalAllowed: true,
  replayAllowed: true,
  exportAllowed: false,
  ...overrides,
});

export const gatewayDatasetScopeFromGatewayResult = (
  request: CodaliGatewayRequest,
  result: CodaliGatewayResult,
  overrides: Partial<GatewayDatasetStorageScope> = {},
): GatewayDatasetStorageScope => ({
  tenantId: overrides.tenantId ?? request.tenant?.id ?? request.tenant?.slug ?? "local",
  productId: overrides.productId ?? request.product?.name ?? "codali",
  deploymentId:
    overrides.deploymentId ??
    request.product?.version ??
    request.product?.surface ??
    "local",
  runId: overrides.runId ?? result.runId,
});

export const buildGatewayDatasetIdempotencyKey = (
  scope: GatewayDatasetStorageScope,
  records: readonly CodaliStorageDatasetRecord[],
): string =>
  `gateway-dataset:${hashGatewayDatasetRequestBody({
    scope,
    records: records.map((record) => ({
      recordId: record.recordId,
      datasetKind: record.datasetKind,
      inputHash: record.inputRef.contentHash,
      outputHash: record.outputRef?.contentHash,
      evidenceHashes: record.evidenceRefs?.map((ref) => ref.contentHash) ?? [],
    })),
  })}`;

export const buildGatewayDatasetServiceSignatureHeaders = (input: {
  scope: GatewayDatasetStorageScope;
  body: unknown;
  hmacSecret: string;
  timestamp: string;
  nonce: string;
}): Record<string, string> => {
  const bodyHash = hashGatewayDatasetRequestBody(input.body);
  const canonicalPayload = [
    GATEWAY_DATASET_SERVICE_SIGNATURE_VERSION,
    input.scope.tenantId,
    input.scope.productId,
    input.scope.deploymentId,
    input.scope.runId,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
  const signature = createHmac("sha256", input.hmacSecret)
    .update(canonicalPayload)
    .digest("hex");
  return {
    "x-codali-storage-timestamp": input.timestamp,
    "x-codali-storage-nonce": input.nonce,
    "x-codali-storage-body-sha256": bodyHash,
    "x-codali-storage-signature": signature,
  };
};

const validateDatasetRecordOrThrow = (
  record: CodaliStorageDatasetRecord,
): CodaliStorageDatasetRecord => {
  const validation = validateCodaliStorageDatasetRecord(record);
  if (!validation.ok) {
    throw new GatewayDatasetStoreError(
      "GATEWAY_DATASET_RECORD_INVALID",
      validation.issues
        .map((issue) => `${issue.path}:${issue.code}:${issue.message}`)
        .join("; "),
    );
  }
  return validation.value;
};

const validateDatasetRecords = (
  records: readonly CodaliStorageDatasetRecord[],
): CodaliStorageDatasetRecord[] => records.map((record) => validateDatasetRecordOrThrow(record));

const buildObjectRef = (input: {
  scope: GatewayDatasetStorageScope;
  payload: unknown;
  ownerType: string;
  ownerId: string;
  refId: string;
  uri: string;
  kind?: CodaliStorageObjectRefKind;
  mimeType?: string;
  retentionClass?: CodaliStorageObjectRetentionClass;
  privacyFlags?: Partial<CodaliStorageObjectPrivacyFlags>;
  metadata?: Record<string, unknown>;
  now?: () => Date;
}): CodaliStorageObjectRef => {
  const mimeType = input.mimeType ?? "application/json";
  const bodyHash = objectContentHash(input.payload, mimeType);
  const tenantHash = hashGatewayDatasetValue(input.scope.tenantId);
  const ownerScope = {
    tenantHash,
    productId: input.scope.productId,
    deploymentId: input.scope.deploymentId,
    runId: input.scope.runId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
  };
  return {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    refId: input.refId,
    kind: input.kind ?? "payload",
    uri: input.uri,
    contentHash: `sha256:${bodyHash}`,
    byteSize: objectByteSize(input.payload, mimeType),
    mimeType,
    privacyFlags: createGatewayDatasetLocalOnlyObjectPrivacyFlags(input.privacyFlags),
    ownerScope,
    ownerScopeHash: hashGatewayDatasetValue(ownerScope),
    deletionGroupId: `gateway-dataset-${input.scope.runId}`,
    retentionClass: input.retentionClass ?? "dataset",
    mediaType: mimeType === "application/x-ndjson" ? "jsonl" : "json",
    sizeBytes: objectByteSize(input.payload, mimeType),
    sha256: bodyHash,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    metadata: input.metadata,
  };
};

export class InMemoryGatewayDatasetObjectStore implements GatewayDatasetObjectStore {
  private readonly objects = new Map<string, { ref: CodaliStorageObjectRef; payload: unknown }>();

  constructor(private readonly options: { now?: () => Date } = {}) {}

  async putObject(input: GatewayDatasetObjectPutInput): Promise<CodaliStorageObjectRef> {
    const refId = `${input.scope.runId}-${input.ownerType}-${randomUUID()}`;
    const ref = buildObjectRef({
      ...input,
      refId,
      uri: `memory://codali-dataset/objects/${refId}.json`,
      now: this.options.now,
    });
    this.objects.set(ref.refId, { ref, payload: cloneJson(input.payload) });
    return cloneJson(ref);
  }

  async readObject(ref: CodaliStorageObjectRef): Promise<unknown | undefined> {
    const object = this.objects.get(ref.refId);
    return object ? cloneJson(object.payload) : undefined;
  }

  listObjects(): CodaliStorageObjectRef[] {
    return Array.from(this.objects.values()).map((object) => cloneJson(object.ref));
  }
}

export const createInMemoryGatewayDatasetObjectStore = (
  options: { now?: () => Date } = {},
): InMemoryGatewayDatasetObjectStore => new InMemoryGatewayDatasetObjectStore(options);

export class InMemoryGatewayDatasetStore implements GatewayDatasetStore {
  private readonly records = new Map<string, CodaliStorageDatasetRecord>();
  private readonly batches: Array<{
    idempotencyKey?: string;
    scope: GatewayDatasetStorageScope;
    recordIds: string[];
    metadata?: Record<string, unknown>;
  }> = [];
  private readonly idempotency = new Map<string, GatewayDatasetStoreWriteResult>();

  async collect(input: GatewayDatasetStoreCollectInput): Promise<GatewayDatasetStoreWriteResult> {
    const records = validateDatasetRecords(input.records);
    if (records.length === 0) {
      return { accepted: true, status: "skipped", recordCount: 0 };
    }
    const idempotencyKey = input.idempotencyKey ?? buildGatewayDatasetIdempotencyKey(input.scope, records);
    const replay = this.idempotency.get(idempotencyKey);
    if (replay) {
      return { ...cloneJson(replay), replayed: true };
    }
    for (const record of records) {
      this.records.set(record.recordId, cloneJson(record));
    }
    const batchId = `memory-${hashGatewayDatasetRequestBody({
      idempotencyKey,
      recordIds: records.map((record) => record.recordId),
    })}`;
    this.batches.push({
      idempotencyKey,
      scope: cloneJson(input.scope),
      recordIds: records.map((record) => record.recordId),
      metadata: input.metadata ? cloneJson(input.metadata) : undefined,
    });
    const result: GatewayDatasetStoreWriteResult = {
      accepted: true,
      status: "stored",
      recordCount: records.length,
      idempotencyKey,
      batchId,
    };
    this.idempotency.set(idempotencyKey, cloneJson(result));
    return result;
  }

  listRecords(): CodaliStorageDatasetRecord[] {
    return Array.from(this.records.values()).map((record) => cloneJson(record));
  }

  readRecord(recordId: string): CodaliStorageDatasetRecord | undefined {
    const record = this.records.get(recordId);
    return record ? cloneJson(record) : undefined;
  }

  listBatches(): Array<{
    idempotencyKey?: string;
    scope: GatewayDatasetStorageScope;
    recordIds: string[];
    metadata?: Record<string, unknown>;
  }> {
    return cloneJson(this.batches);
  }
}

export const createInMemoryGatewayDatasetStore = (): InMemoryGatewayDatasetStore =>
  new InMemoryGatewayDatasetStore();

export class LocalJsonlGatewayDatasetObjectStore implements GatewayDatasetObjectStore {
  constructor(private readonly options: LocalJsonlGatewayDatasetObjectStoreOptions) {}

  async putObject(input: GatewayDatasetObjectPutInput): Promise<CodaliStorageObjectRef> {
    await mkdir(this.options.directory, { recursive: true });
    const refId = `${input.scope.runId}-${input.ownerType}-${randomUUID()}`;
    const filePath = path.join(this.options.directory, `${refId}.json`);
    await writeFile(
      filePath,
      normalizeObjectPayloadBody(input.payload, input.mimeType),
      "utf8",
    );
    return buildObjectRef({
      ...input,
      refId,
      uri: pathToFileURL(filePath).href,
      now: this.options.now,
    });
  }

  async readObject(ref: CodaliStorageObjectRef): Promise<unknown | undefined> {
    if (!ref.uri?.startsWith("file://")) return undefined;
    const raw = await readFile(fileURLToPath(ref.uri), "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}

export const createLocalJsonlGatewayDatasetObjectStore = (
  options: LocalJsonlGatewayDatasetObjectStoreOptions,
): LocalJsonlGatewayDatasetObjectStore => new LocalJsonlGatewayDatasetObjectStore(options);

export class LocalJsonlGatewayDatasetStore implements GatewayDatasetStore {
  private readonly idempotency = new Map<string, GatewayDatasetStoreWriteResult>();

  constructor(private readonly options: LocalJsonlGatewayDatasetStoreOptions) {}

  async collect(input: GatewayDatasetStoreCollectInput): Promise<GatewayDatasetStoreWriteResult> {
    const records = validateDatasetRecords(input.records);
    if (records.length === 0) {
      return { accepted: true, status: "skipped", recordCount: 0 };
    }
    const idempotencyKey = input.idempotencyKey ?? buildGatewayDatasetIdempotencyKey(input.scope, records);
    const replay = this.idempotency.get(idempotencyKey);
    if (replay) {
      return { ...cloneJson(replay), replayed: true };
    }
    await mkdir(this.options.directory, { recursive: true });
    const recordsPath = path.join(this.options.directory, this.options.recordsFileName ?? "records.jsonl");
    const body = {
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      collectedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      scope: input.scope,
      idempotencyKey,
      records,
      metadata: input.metadata,
    };
    await appendFile(recordsPath, `${JSON.stringify(body)}\n`, "utf8");
    const result: GatewayDatasetStoreWriteResult = {
      accepted: true,
      status: "stored",
      recordCount: records.length,
      idempotencyKey,
      batchId: `jsonl-${hashGatewayDatasetRequestBody(body)}`,
      metadata: {
        recordsPath,
      },
    };
    this.idempotency.set(idempotencyKey, cloneJson(result));
    return result;
  }
}

export const createLocalJsonlGatewayDatasetStore = (
  options: LocalJsonlGatewayDatasetStoreOptions,
): LocalJsonlGatewayDatasetStore => new LocalJsonlGatewayDatasetStore(options);

const chunkRecords = <T>(records: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < records.length; index += size) {
    chunks.push(records.slice(index, index + size));
  }
  return chunks;
};

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const endpointUrl = (baseUrl: string, endpointPath: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${endpointPath.replace(/^\/+/, "")}`;

const parseResponseBody = async (response: GatewayDatasetFetchResponse): Promise<unknown> => {
  const raw = await response.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class GatewayDatasetServiceClient implements GatewayDatasetStore {
  private readonly fetchImpl: GatewayDatasetFetch;

  constructor(private readonly options: GatewayDatasetServiceClientOptions) {
    const defaultFetch = globalThis.fetch?.bind(globalThis) as GatewayDatasetFetch | undefined;
    const fetchImpl = options.fetch ?? defaultFetch;
    if (!fetchImpl) {
      throw new GatewayDatasetServiceClientError({
        code: "GATEWAY_DATASET_FETCH_UNAVAILABLE",
        message: "No fetch implementation is available for GatewayDatasetServiceClient.",
      });
    }
    this.fetchImpl = fetchImpl;
  }

  async collect(input: GatewayDatasetStoreCollectInput): Promise<GatewayDatasetStoreWriteResult> {
    const records = validateDatasetRecords(input.records);
    if (records.length === 0) {
      return { accepted: true, status: "skipped", recordCount: 0 };
    }
    const idempotencyKey = input.idempotencyKey ?? buildGatewayDatasetIdempotencyKey(input.scope, records);
    const batchSize = positiveInteger(this.options.batchSize, 25);
    const batches = chunkRecords(records, batchSize);
    const responses: unknown[] = [];
    try {
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batchRecords = batches[batchIndex] ?? [];
        const batchIdempotencyKey =
          batches.length === 1 ? idempotencyKey : `${idempotencyKey}:${batchIndex + 1}`;
        responses.push(await this.writeBatch({
          scope: input.scope,
          records: batchRecords,
          idempotencyKey: batchIdempotencyKey,
          batchIndex,
          batchCount: batches.length,
          metadata: input.metadata,
        }));
      }
      return {
        accepted: true,
        status: "stored",
        recordCount: records.length,
        idempotencyKey,
        batchId: idempotencyKey,
        metadata: {
          batchCount: batches.length,
          responses,
        },
      };
    } catch (error) {
      if (this.options.fallbackStore) {
        const fallback = await this.options.fallbackStore.collect({
          ...input,
          records,
          idempotencyKey,
        });
        return {
          ...fallback,
          fallbackUsed: true,
          errors: [...(fallback.errors ?? []), errorMessage(error)],
        };
      }
      throw error;
    }
  }

  private async writeBatch(input: {
    scope: GatewayDatasetStorageScope;
    records: CodaliStorageDatasetRecord[];
    idempotencyKey: string;
    batchIndex: number;
    batchCount: number;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    const endpoint = endpointUrl(
      this.options.baseUrl,
      this.options.endpointPath ?? DEFAULT_GATEWAY_DATASET_SERVICE_ENDPOINT,
    );
    const maxRetries = Math.max(0, Math.floor(this.options.maxRetries ?? 2));
    const retryBaseMs = Math.max(0, Math.floor(this.options.retryBaseMs ?? 100));
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const body = {
        schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
        scope: input.scope,
        records: input.records,
        metadata: {
          ...(input.metadata ?? {}),
          batchIndex: input.batchIndex,
          batchCount: input.batchCount,
        },
      };
      const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
      const nonce = this.options.nonceFactory?.() ?? randomUUID();
      const bodyText = JSON.stringify(body);
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.options.serviceToken}`,
        "content-type": "application/json",
        "x-codali-storage-tenant": input.scope.tenantId,
        "x-codali-storage-product": input.scope.productId,
        "x-codali-storage-deployment": input.scope.deploymentId,
        "x-codali-storage-run": input.scope.runId,
        "x-codali-storage-idempotency-key": input.idempotencyKey,
        ...buildGatewayDatasetServiceSignatureHeaders({
          scope: input.scope,
          body,
          hmacSecret: this.options.hmacSecret ?? this.options.serviceToken,
          timestamp,
          nonce,
        }),
      };
      try {
        const response = await this.fetchWithTimeout(endpoint, {
          method: "POST",
          headers,
          body: bodyText,
        });
        const parsed = await parseResponseBody(response);
        if (response.ok) {
          return parsed;
        }
        const retryable = retryableStatus(response.status);
        lastError = new GatewayDatasetServiceClientError({
          code: "GATEWAY_DATASET_SERVICE_WRITE_FAILED",
          message: `Storage service returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
          status: response.status,
          retryable,
        });
        if (!retryable || attempt >= maxRetries) {
          throw lastError;
        }
      } catch (error) {
        const retryable =
          error instanceof GatewayDatasetServiceClientError ? error.retryable : true;
        lastError = error;
        if (!retryable || attempt >= maxRetries) {
          throw error;
        }
      }
      if (retryBaseMs > 0) {
        await sleep(retryBaseMs * (attempt + 1));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new GatewayDatasetServiceClientError({
          code: "GATEWAY_DATASET_SERVICE_WRITE_FAILED",
          message: "Storage service write failed without an error object.",
        });
  }

  private async fetchWithTimeout(
    url: string,
    request: GatewayDatasetFetchRequest,
  ): Promise<GatewayDatasetFetchResponse> {
    const timeoutMs = Math.max(0, Math.floor(this.options.timeoutMs ?? 5_000));
    if (timeoutMs <= 0) {
      return this.fetchImpl(url, request);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...request, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const createGatewayDatasetServiceClient = (
  options: GatewayDatasetServiceClientOptions,
): GatewayDatasetServiceClient => new GatewayDatasetServiceClient(options);

const confidenceScore = (confidence: CodaliGatewayResult["confidence"]): number => {
  if (confidence === "high") return 0.95;
  if (confidence === "medium") return 0.7;
  return 0.4;
};

const contextPackSummary = (
  contextPack: CodaliContextPack | undefined,
): Record<string, unknown> | undefined =>
  contextPack
    ? {
        contextPackId: contextPack.id,
        tokenEstimate: contextPack.tokenEstimate,
        decisionFactCount: contextPack.decisionFacts.length,
        contradictionCount: contextPack.contradictions.length,
        missingInformationCount: contextPack.missingInformation.length,
      }
    : undefined;

type GatewayDatasetTraceModelCall = {
  id: string;
  runId: string;
  taskId?: string;
  role: string;
  status: "success" | "failed" | "repaired" | "blocked" | "skipped";
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  agentSlug?: string;
  model?: string;
  provider?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
};

const safeDatasetIdPart = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || hashGatewayDatasetRequestBody(value).slice(0, 16);
};

const labelToken = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "");

const uniqueLabels = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const label = labelToken(value);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    output.push(label);
  }
  return output;
};

const uniqueStrings = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
};

const metadataNumber = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined => {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const metadataRecord = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  const value = metadata?.[key];
  return isRecord(value) ? value : undefined;
};

const modelCallRepairAttempts = (call: GatewayDatasetTraceModelCall): number =>
  metadataNumber(call.metadata, "repairAttempts")
  ?? metadataNumber(call.metadata, "repair_attempts")
  ?? 0;

const schemaFailureText = (value: unknown): boolean =>
  typeof value === "string" && /schema|json|parse|validation|invalid/i.test(value);

const isSchemaFailureModelCall = (call: GatewayDatasetTraceModelCall): boolean => {
  if (call.status === "repaired" || modelCallRepairAttempts(call) > 0) return true;
  if (schemaFailureText(call.errorCode) || schemaFailureText(call.errorMessage)) return true;
  return call.status === "failed" && schemaFailureText(JSON.stringify(call.metadata ?? {}));
};

const modelRecordId = (runId: string, call: GatewayDatasetTraceModelCall, index: number): string =>
  `dataset-${runId}-model-${safeDatasetIdPart(call.id || `${index + 1}-${call.role}`)}`;

const schemaFailureRecordId = (
  runId: string,
  call: GatewayDatasetTraceModelCall,
  index: number,
): string =>
  `dataset-${runId}-schema-failure-${safeDatasetIdPart(call.id || `${index + 1}-${call.role}`)}`;

const normalizeStoredModelCalls = (
  trace: CodaliGatewayRunTrace | undefined,
  result: CodaliGatewayResult,
): GatewayDatasetTraceModelCall[] => {
  if (trace?.modelCalls.length) {
    return trace.modelCalls.map((call, index) => ({
      ...call,
      id: call.id || `model-${index + 1}`,
      runId: call.runId || result.runId,
      status: call.status,
    }));
  }
  return result.trace.modelCalls.map((call, index) => ({
    id: `trace-model-${index + 1}`,
    runId: result.runId,
    role: call.role,
    status: call.status,
    latencyMs: call.latencyMs,
    agentSlug: call.agentSlug,
    model: call.model,
    provider: call.provider,
    errorCode: call.errorCode,
    metadata: {
      tier: call.tier,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
    },
  }));
};

const nextCorrectedModelCall = (
  call: GatewayDatasetTraceModelCall,
  index: number,
  calls: GatewayDatasetTraceModelCall[],
): GatewayDatasetTraceModelCall | undefined => {
  if (call.status === "repaired") return call;
  return calls.slice(index + 1).find((candidate) =>
    candidate.role === call.role
    && (candidate.status === "success" || candidate.status === "repaired"));
};

const modelCallScore = (call: GatewayDatasetTraceModelCall): number => {
  if (call.status === "success") return 0.55;
  if (call.status === "repaired") return 0.45;
  if (call.status === "failed") return 0.1;
  return 0;
};

const arrayOfStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

const normalizeGoldTarget = (value: unknown): GatewayDatasetGoldTargetInput | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "accepted" && kind !== "corrected" && kind !== "reviewed") return undefined;
  return {
    kind,
    id: typeof value.id === "string" ? value.id : undefined,
    input: value.input,
    target: value.target ?? value.output,
    sourceRecordId: typeof value.sourceRecordId === "string"
      ? value.sourceRecordId
      : typeof value.source_record_id === "string"
        ? value.source_record_id
        : undefined,
    sourceModelCallId: typeof value.sourceModelCallId === "string"
      ? value.sourceModelCallId
      : typeof value.source_model_call_id === "string"
        ? value.source_model_call_id
        : undefined,
    failedAttemptRecordId: typeof value.failedAttemptRecordId === "string"
      ? value.failedAttemptRecordId
      : typeof value.failed_attempt_record_id === "string"
        ? value.failed_attempt_record_id
        : undefined,
    failedAttemptModelCallId: typeof value.failedAttemptModelCallId === "string"
      ? value.failedAttemptModelCallId
      : typeof value.failed_attempt_model_call_id === "string"
        ? value.failed_attempt_model_call_id
        : undefined,
    reviewerId: typeof value.reviewerId === "string"
      ? value.reviewerId
      : typeof value.reviewer_id === "string"
        ? value.reviewer_id
        : undefined,
    reasons: arrayOfStrings(value.reasons),
    score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : undefined,
    labels: arrayOfStrings(value.labels),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};

const goldTargetsFromMetadata = (
  metadata: Record<string, unknown> | undefined,
): GatewayDatasetGoldTargetInput[] => {
  const raw = metadata?.goldTargets ?? metadata?.gold_targets;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const target = normalizeGoldTarget(item);
    return target ? [target] : [];
  });
};

const collectGatewayRunLabels = (result: CodaliGatewayResult): string[] =>
  uniqueLabels([
    "auto:gateway_run",
    `auto:status:${result.status}`,
    `auto:confidence:${result.confidence}`,
    result.finalModel?.tier ? `auto:final_tier:${result.finalModel.tier}` : undefined,
  ]);

const collectModelCallLabels = (call: GatewayDatasetTraceModelCall): string[] =>
  uniqueLabels([
    "auto:model_call",
    `auto:role:${call.role}`,
    `auto:status:${call.status}`,
    call.provider ? `auto:provider:${call.provider}` : undefined,
    call.model ? "auto:model_present" : undefined,
    modelCallRepairAttempts(call) > 0 ? "auto:repaired_after_schema_retry" : undefined,
  ]);

const collectSchemaFailureLabels = (call: GatewayDatasetTraceModelCall): string[] =>
  uniqueLabels([
    "auto:schema_failure",
    "auto:needs_review",
    `auto:role:${call.role}`,
    `auto:status:${call.status}`,
  ]);

const collectGoldTargetLabels = (target: GatewayDatasetGoldTargetInput): string[] =>
  uniqueLabels([
    "gold_target",
    `gold:${target.kind}`,
    ...(target.labels ?? []),
  ]);

type GatewayDatasetToolDecisionInput = {
  id: string;
  tool: string;
  taskId?: string;
  status: "success" | "failed" | "blocked" | "skipped";
  args?: unknown;
  result?: unknown;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  allowedTools?: string[];
  removedTools?: string[];
  reason?: string;
  source: "tool_call" | "blocked_attempt";
  metadata?: Record<string, unknown>;
};

type GatewayDatasetPolicyEventInput = {
  id: string;
  eventType: string;
  reason: string;
  tool?: string;
  taskId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
};

const toolNameTokens = (tool: string): string[] =>
  tool
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);

const hasToolToken = (tool: string, tokens: readonly string[]): boolean => {
  const normalized = tool.toLowerCase();
  const parts = toolNameTokens(tool);
  return tokens.some((token) =>
    parts.includes(token) ||
    normalized === token ||
    normalized.endsWith(`_${token}`));
};

const isDocdexTool = (tool: string): boolean => tool.toLowerCase().startsWith("docdex_");

const isShellTool = (tool: string): boolean =>
  hasToolToken(tool, ["bash", "cmd", "exec", "execute", "shell", "terminal"]);

const isDestructiveTool = (tool: string): boolean =>
  hasToolToken(tool, [
    "delete",
    "destroy",
    "drop",
    "purge",
    "remove",
    "reset",
    "rm",
    "truncate",
    "wipe",
  ]);

const isWriteTool = (tool: string): boolean =>
  isDestructiveTool(tool) ||
  hasToolToken(tool, [
    "add",
    "approve",
    "assign",
    "cancel",
    "commit",
    "create",
    "dispatch",
    "edit",
    "merge",
    "mutate",
    "post",
    "publish",
    "push",
    "send",
    "submit",
    "sync",
    "transition",
    "update",
    "upload",
    "write",
  ]);

const policyEventTypeForTool = (tool: string): string => {
  if (isShellTool(tool)) return "shell_block";
  if (isDestructiveTool(tool)) return "destructive_block";
  if (isWriteTool(tool)) return "write_block";
  return "denied_tool";
};

const readMetadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const readMetadataStringArray = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined => arrayOfStrings(metadata?.[key]);

const taskById = (
  trace: CodaliGatewayRunTrace | undefined,
  taskId: string | undefined,
): CodaliGatewayStoredTask | undefined =>
  taskId ? trace?.tasks.find((task) => task.id === taskId) : undefined;

const toolDecisionFromCall = (
  call: CodaliGatewayStoredToolCall,
  index: number,
  trace: CodaliGatewayRunTrace | undefined,
): GatewayDatasetToolDecisionInput => {
  const task = taskById(trace, call.taskId);
  return {
    id: call.id || `tool-call-${index + 1}`,
    tool: call.tool,
    taskId: call.taskId,
    status: call.status,
    args: call.args,
    result: call.result,
    latencyMs: call.latencyMs,
    errorCode: call.errorCode,
    errorMessage: call.errorMessage,
    allowedTools: readMetadataStringArray(task?.metadata, "allowedTools"),
    removedTools: readMetadataStringArray(task?.metadata, "removedTools"),
    reason: call.status === "blocked" ? call.errorCode ?? "blocked" : undefined,
    source: "tool_call",
    metadata: call.metadata,
  };
};

const blockedToolDecisionsFromTasks = (
  trace: CodaliGatewayRunTrace | undefined,
): GatewayDatasetToolDecisionInput[] => {
  const decisions: GatewayDatasetToolDecisionInput[] = [];
  for (const task of trace?.tasks ?? []) {
    const allowedTools = readMetadataStringArray(task.metadata, "allowedTools") ?? [];
    const removedTools = readMetadataStringArray(task.metadata, "removedTools") ?? [];
    const skippedReason = readMetadataString(task.metadata, "skippedReason");
    for (const tool of removedTools) {
      decisions.push({
        id: `${task.id}-removed-${tool}`,
        tool,
        taskId: task.id,
        status: "blocked",
        allowedTools,
        removedTools,
        reason: "removed_by_policy",
        source: "blocked_attempt",
        metadata: task.metadata,
      });
    }
    if (skippedReason && allowedTools.length > 0) {
      for (const tool of allowedTools) {
        decisions.push({
          id: `${task.id}-skipped-${tool}-${skippedReason}`,
          tool,
          taskId: task.id,
          status: "skipped",
          allowedTools,
          removedTools,
          reason: skippedReason,
          source: "blocked_attempt",
          metadata: task.metadata,
        });
      }
    }
  }
  return decisions;
};

const collectEvidenceItems = (
  trace: CodaliGatewayRunTrace | undefined,
  result: CodaliGatewayResult,
): CodaliEvidenceItem[] => {
  const byId = new Map<string, CodaliEvidenceItem>();
  for (const item of [...(trace?.evidence ?? []), ...result.evidence]) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
};

const collectContextPacks = (
  trace: CodaliGatewayRunTrace | undefined,
  result: CodaliGatewayResult,
): CodaliContextPack[] => {
  const byId = new Map<string, CodaliContextPack>();
  for (const pack of [trace?.contextPack, result.contextPack]) {
    if (pack) byId.set(pack.id, pack);
  }
  return [...byId.values()];
};

const extractReservedScopeKeys = (value: unknown, path = "$", matches: string[] = []): string[] => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => extractReservedScopeKeys(item, `${path}[${index}]`, matches));
    return matches;
  }
  if (!isRecord(value)) return matches;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/^(docdex|repo|repoId|repo_id|repoRoot|repo_root|tenant|tenantId|tenant_id)$/i.test(key)) {
      matches.push(childPath);
    }
    extractReservedScopeKeys(child, childPath, matches);
  }
  return matches;
};

const scopeOverrideEventType = (value: unknown): string => {
  const keys = extractReservedScopeKeys(value);
  if (keys.some((key) => /docdex|repo/i.test(key))) return "docdex_scope_override";
  if (keys.some((key) => /tenant/i.test(key))) return "tenant_scope_override";
  return "scope_override";
};

const collectPolicyEvents = (input: {
  request: CodaliGatewayRequest;
  result: CodaliGatewayResult;
  trace?: CodaliGatewayRunTrace;
}): GatewayDatasetPolicyEventInput[] => {
  const events: GatewayDatasetPolicyEventInput[] = [];
  const addEvent = (event: GatewayDatasetPolicyEventInput) => {
    const key = [
      event.eventType,
      event.tool ?? "",
      event.taskId ?? "",
      event.reason,
      event.errorCode ?? "",
    ].join("|");
    if (events.some((existing) => existing.id === event.id || [
      existing.eventType,
      existing.tool ?? "",
      existing.taskId ?? "",
      existing.reason,
      existing.errorCode ?? "",
    ].join("|") === key)) {
      return;
    }
    events.push(event);
  };

  for (const tool of input.request.policy.deniedTools ?? []) {
    addEvent({
      id: `policy-denied-${tool}`,
      eventType: "denied_tool",
      reason: "policy_denied_tool",
      tool,
    });
  }

  for (const tool of input.request.policy.allowedTools) {
    if (input.request.policy.allowShell === false && isShellTool(tool)) {
      addEvent({
        id: `policy-shell-${tool}`,
        eventType: "shell_block",
        reason: "shell_disabled",
        tool,
      });
    } else if (
      input.request.policy.allowDestructiveOperations === false &&
      isDestructiveTool(tool)
    ) {
      addEvent({
        id: `policy-destructive-${tool}`,
        eventType: "destructive_block",
        reason: "destructive_operations_disabled",
        tool,
      });
    } else if (input.request.policy.allowWrites === false && isWriteTool(tool)) {
      addEvent({
        id: `policy-write-${tool}`,
        eventType: "write_block",
        reason: "writes_disabled",
        tool,
      });
    }
  }

  for (const task of input.trace?.tasks ?? []) {
    const removedTools = readMetadataStringArray(task.metadata, "removedTools") ?? [];
    const skippedReason = readMetadataString(task.metadata, "skippedReason");
    for (const tool of removedTools) {
      addEvent({
        id: `task-${task.id}-removed-${tool}`,
        eventType: policyEventTypeForTool(tool),
        reason: "removed_from_worker_task",
        tool,
        taskId: task.id,
        metadata: task.metadata,
      });
    }
    if (skippedReason && /tool|budget|policy|scope|denied|blocked/i.test(skippedReason)) {
      addEvent({
        id: `task-${task.id}-skipped-${skippedReason}`,
        eventType: skippedReason.includes("budget") ? "tool_budget_block" : "tool_block",
        reason: skippedReason,
        taskId: task.id,
        status: task.status,
        metadata: task.metadata,
      });
    }
  }

  for (const call of input.trace?.toolCalls ?? []) {
    const errorCode = call.errorCode ?? "";
    const eventType = /SCOPE_OVERRIDE/i.test(errorCode)
      ? scopeOverrideEventType({ args: call.args, metadata: call.metadata })
      : /DENIED/i.test(errorCode)
        ? "denied_tool"
        : /NOT_APPROVED|NOT_ALLOWED|BLOCK/i.test(errorCode) || call.status === "blocked"
          ? policyEventTypeForTool(call.tool)
          : undefined;
    if (eventType) {
      addEvent({
        id: `tool-${call.id}-${eventType}`,
        eventType,
        reason: call.errorCode ?? call.status,
        tool: call.tool,
        taskId: call.taskId,
        status: call.status,
        errorCode: call.errorCode,
        errorMessage: call.errorMessage,
        metadata: call.metadata,
      });
    }
  }

  for (const warning of input.result.trace.warnings) {
    if (!/denied|blocked|removed|scope|write|shell|destructive/i.test(warning)) continue;
    addEvent({
      id: `warning-${hashGatewayDatasetRequestBody(warning).slice(0, 16)}`,
      eventType: /scope/i.test(warning) ? "scope_override" : "policy_warning",
      reason: warning,
      metadata: { source: "gateway_trace_warning" },
    });
  }

  return events;
};

const collectToolDecisionLabels = (decision: GatewayDatasetToolDecisionInput): string[] =>
  uniqueLabels([
    "auto:tool_decision",
    `auto:tool:${decision.tool}`,
    `auto:status:${decision.status}`,
    decision.source === "blocked_attempt" ? "auto:blocked_attempt" : undefined,
    decision.reason ? `auto:reason:${decision.reason}` : undefined,
  ]);

const collectRagRetrievalLabels = (call: CodaliGatewayStoredToolCall): string[] =>
  uniqueLabels([
    "auto:rag_retrieval",
    `auto:tool:${call.tool}`,
    `auto:status:${call.status}`,
  ]);

const collectEvidenceLabels = (item: CodaliEvidenceItem): string[] =>
  uniqueLabels([
    "auto:evidence_item",
    `auto:source:${item.sourceType}`,
    item.usedTool ? `auto:tool:${item.usedTool}` : undefined,
    item.freshness ? `auto:freshness:${item.freshness}` : undefined,
    item.tenantScoped ? "auto:tenant_scoped" : undefined,
  ]);

const collectContextPackLabels = (contextPack: CodaliContextPack): string[] =>
  uniqueLabels([
    "auto:context_pack",
    contextPack.contradictions.length > 0 ? "auto:has_contradictions" : undefined,
    contextPack.missingInformation.length > 0 ? "auto:missing_information" : undefined,
  ]);

const collectArtifactLabels = (artifact: CodaliGatewayStoredArtifact): string[] =>
  uniqueLabels([
    "auto:artifact",
    `auto:artifact_type:${artifact.type}`,
    /^image($|\/)|image/i.test(artifact.type) ? "auto:image_artifact" : undefined,
    artifact.uri || artifact.path ? "auto:object_ref_only" : undefined,
  ]);

const collectPolicyEventLabels = (event: GatewayDatasetPolicyEventInput): string[] =>
  uniqueLabels([
    "auto:policy_event",
    `auto:policy:${event.eventType}`,
    event.tool ? `auto:tool:${event.tool}` : undefined,
  ]);

const artifactMetadataRefOnly = (
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  const isRawArtifactPayloadKey = (key: string): boolean => {
    const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
    if (new Set([
      "base64",
      "binary",
      "blob",
      "body",
      "buffer",
      "bytes",
      "content",
      "data",
      "datauri",
      "dataurl",
      "imagedata",
      "payload",
      "raw",
    ]).has(normalized)) {
      return true;
    }
    return /^(?:image|base64|binary|blob|body|buffer|bytes|content|raw|file|payload|artifact|audio|video|media).*(?:base64|binary|blob|buffer|bytes|content|data|payload|raw)$/i
      .test(normalized);
  };
  const sanitizeArtifactValue = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sanitizeArtifactValue);
    if (!isRecord(entry)) return sanitizeGatewayDatasetPayload(entry);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(entry)) {
      output[key] = isRawArtifactPayloadKey(key)
        ? "[object-ref-only]"
        : sanitizeArtifactValue(child);
    }
    return output;
  };
  const sanitized = sanitizeArtifactValue(value);
  return isRecord(sanitized) ? sanitized : undefined;
};

type GatewayDatasetCollectorBuildInput = Omit<
  GatewayDatasetGatewayCollectionInput,
  "store" | "enabled" | "fallbackStore" | "onError" | "onResult"
>;

export class GatewayDatasetCollector {
  async buildCollectInput(
    input: GatewayDatasetCollectorBuildInput,
  ): Promise<GatewayDatasetStoreCollectInput> {
    const now = input.now ?? (() => new Date());
    const objectStore = input.objectStore ?? createInMemoryGatewayDatasetObjectStore({ now });
    const scope = gatewayDatasetScopeFromGatewayResult(input.request, input.result, input.scope);
    const trace = input.trace ?? (input.traceLoader ? await input.traceLoader() : undefined);
    const inputMetadata = sanitizeGatewayDatasetMetadata(input.metadata);
    const privacyMetadata = sanitizeGatewayDatasetMetadata(input.privacy?.metadata);
    const privacy = createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: true,
      ...input.privacy,
      metadata: {
        containsPersonalDataAssumption: "unknown_assumed_true",
        source: "codali_gateway",
        collector: "gateway_dataset_collector",
        ...(privacyMetadata ?? {}),
      },
    });
    const privacyFlags = createGatewayDatasetLocalOnlyObjectPrivacyFlags({
      containsPersonalData: true,
      ...(input.privacyFlags ?? {}),
    });

    const modelCalls = normalizeStoredModelCalls(trace, input.result);
    const modelRecordIds = new Map<string, string>();
    modelCalls.forEach((call, index) => {
      modelRecordIds.set(call.id, modelRecordId(input.result.runId, call, index));
    });

    const records: CodaliStorageDatasetRecord[] = [
      await this.buildRunRecord({
        input,
        objectStore,
        scope,
        privacy,
        privacyFlags,
        now,
        trace,
        modelCalls,
      }),
    ];

    if (input.collectFinalAnswers !== false) {
      records.push(await this.buildFinalAnswerRecord({
        input,
        objectStore,
        scope,
        privacy,
        privacyFlags,
        now,
      }));
    }

    if (input.collectRagRetrievals !== false) {
      const ragCalls = (trace?.toolCalls ?? []).filter((call) => isDocdexTool(call.tool));
      for (let index = 0; index < ragCalls.length; index += 1) {
        const call = ragCalls[index];
        if (!call) continue;
        records.push(await this.buildRagRetrievalRecord({
          call,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
        }));
      }
    }

    if (input.collectToolDecisions !== false) {
      const decisions = [
        ...(trace?.toolCalls ?? []).map((call, index) =>
          toolDecisionFromCall(call, index, trace)),
        ...blockedToolDecisionsFromTasks(trace),
      ];
      for (let index = 0; index < decisions.length; index += 1) {
        const decision = decisions[index];
        if (!decision) continue;
        records.push(await this.buildToolDecisionRecord({
          decision,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
        }));
      }
    }

    const evidenceItems = collectEvidenceItems(trace, input.result);
    if (input.collectEvidenceItems !== false) {
      for (let index = 0; index < evidenceItems.length; index += 1) {
        const evidenceItem = evidenceItems[index];
        if (!evidenceItem) continue;
        records.push(await this.buildEvidenceItemRecord({
          evidenceItem,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
        }));
      }
    }

    const contextPacks = collectContextPacks(trace, input.result);
    if (input.collectContextPacks !== false) {
      for (let index = 0; index < contextPacks.length; index += 1) {
        const contextPack = contextPacks[index];
        if (!contextPack) continue;
        records.push(await this.buildContextPackRecord({
          contextPack,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
        }));
      }
    }

    if (input.collectArtifacts !== false) {
      for (let index = 0; index < (trace?.artifacts.length ?? 0); index += 1) {
        const artifact = trace?.artifacts[index];
        if (!artifact) continue;
        records.push(await this.buildArtifactRecord({
          artifact,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
        }));
      }
    }

    const policyEvents = collectPolicyEvents({ request: input.request, result: input.result, trace });
    if (input.collectPolicyEvents !== false) {
      for (let index = 0; index < policyEvents.length; index += 1) {
        const event = policyEvents[index];
        if (!event) continue;
        records.push(await this.buildPolicyEventRecord({
          event,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
        }));
      }
    }

    if (input.collectModelCalls !== false) {
      for (let index = 0; index < modelCalls.length; index += 1) {
        const call = modelCalls[index];
        if (!call) continue;
        records.push(await this.buildModelCallRecord({
          call,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
          schemaFailureRecordId: isSchemaFailureModelCall(call)
            ? schemaFailureRecordId(input.result.runId, call, index)
            : undefined,
        }));
      }
    }

    if (input.collectSchemaFailures !== false) {
      for (let index = 0; index < modelCalls.length; index += 1) {
        const call = modelCalls[index];
        if (!call || !isSchemaFailureModelCall(call)) continue;
        const corrected = nextCorrectedModelCall(call, index, modelCalls);
        records.push(await this.buildSchemaFailureRecord({
          call,
          index,
          corrected,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
          failedAttemptRecordId: modelRecordIds.get(call.id),
          correctedRecordId: corrected ? modelRecordIds.get(corrected.id) : undefined,
        }));
      }
    }

    const goldTargets = [
      ...(input.goldTargets ?? []),
      ...goldTargetsFromMetadata(input.result.metadata),
    ];
    if (input.collectGoldTargets !== false) {
      for (let index = 0; index < goldTargets.length; index += 1) {
        const target = goldTargets[index];
        if (!target) continue;
        records.push(await this.buildGoldTargetRecord({
          target,
          index,
          input,
          objectStore,
          scope,
          privacy,
          privacyFlags,
          now,
          modelRecordIds,
        }));
      }
    }

    const validatedRecords = validateDatasetRecords(records);
    return {
      scope,
      records: validatedRecords,
      idempotencyKey:
        input.idempotencyKey ?? buildGatewayDatasetIdempotencyKey(scope, validatedRecords),
      metadata: {
        source: "codali_gateway",
        collectionMode: "gateway_trace_collector",
        gatewayRunId: input.result.runId,
        traceAvailable: Boolean(trace),
        recordCounts: {
          total: validatedRecords.length,
          modelCalls: input.collectModelCalls === false ? 0 : modelCalls.length,
          ragRetrievals: input.collectRagRetrievals === false
            ? 0
            : validatedRecords.filter((record) =>
              record.metadata?.exampleType === "rag_retrieval").length,
          toolDecisions: input.collectToolDecisions === false
            ? 0
            : validatedRecords.filter((record) =>
              record.metadata?.exampleType === "tool_decision").length,
          evidenceItems: input.collectEvidenceItems === false ? 0 : evidenceItems.length,
          contextPacks: input.collectContextPacks === false ? 0 : contextPacks.length,
          finalAnswers: input.collectFinalAnswers === false
            ? 0
            : validatedRecords.filter((record) =>
              record.metadata?.exampleType === "final_answer").length,
          artifacts: input.collectArtifacts === false
            ? 0
            : validatedRecords.filter((record) =>
              record.metadata?.exampleType === "artifact").length,
          policyEvents: input.collectPolicyEvents === false
            ? 0
            : validatedRecords.filter((record) =>
              record.metadata?.exampleType === "policy_event").length,
          schemaFailures: validatedRecords.filter((record) =>
            record.metadata?.exampleType === "schema_failure").length,
          goldTargets: validatedRecords.filter((record) =>
            record.metadata?.exampleType === "gold_target").length,
        },
        ...(inputMetadata ?? {}),
      },
    };
  }

  private async buildRunRecord(input: {
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
    trace?: CodaliGatewayRunTrace;
    modelCalls: GatewayDatasetTraceModelCall[];
  }): Promise<CodaliStorageDatasetRecord> {
    const recordId = `dataset-${input.input.result.runId}`;
    const run = input.trace?.run;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "dataset_record",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        requestId: input.input.request.id,
        query: input.input.request.query,
        mode: input.input.request.mode,
        conversationId: input.input.request.conversation?.id,
        traceRunId: run?.runId ?? input.input.result.runId,
        traceStatus: run?.status ?? input.input.result.status,
        taskCount: input.trace?.tasks.length ?? input.input.result.trace.iterations,
        modelCallCount: input.modelCalls.length,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "gateway_run_input" },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "dataset_record",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        status: input.input.result.status,
        answer: input.input.result.answer,
        confidence: input.input.result.confidence,
        sources: input.input.result.sources,
        warnings: input.input.result.trace.warnings,
        errors: input.input.result.trace.errors,
        finalModel: input.input.result.finalModel,
        telemetry: input.input.result.telemetry,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "gateway_run_output" },
    });
    const evidenceRefs = input.input.result.evidence.length > 0
      ? [
          await putGatewayDatasetObject(input.objectStore, {
            scope: input.scope,
            ownerType: "dataset_record",
            ownerId: recordId,
            kind: "evidence",
            payload: {
              evidence: input.input.result.evidence,
              contextPack: contextPackSummary(input.input.result.contextPack),
            },
            privacyFlags: input.privacyFlags,
            metadata: { part: "gateway_run_evidence" },
          }),
        ]
      : undefined;
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: input.input.datasetKind ?? "gateway_answer",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      evidenceRefs,
      quality: {
        score: confidenceScore(input.input.result.confidence),
        labels: collectGatewayRunLabels(input.input.result),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "gateway_run",
        gatewayStatus: input.input.result.status,
        finalModelTier: input.input.result.finalModel?.tier,
        finalModelAgentSlug: input.input.result.finalModel?.agentSlug,
        traceAvailable: Boolean(input.trace),
        modelCallCount: input.modelCalls.length,
        telemetry: input.input.result.telemetry,
        ...(sanitizeGatewayDatasetMetadata(input.input.metadata) ?? {}),
      },
    });
  }

  private async buildFinalAnswerRecord(input: {
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
  }): Promise<CodaliStorageDatasetRecord> {
    const recordId = `dataset-${input.input.result.runId}-final-answer`;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "final_answer_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        requestId: input.input.request.id,
        query: input.input.request.query,
        responsePolicy: input.input.request.response,
        contextPack: contextPackSummary(input.input.result.contextPack),
        sourceEvidenceIds: input.input.result.sources.map((source) => source.evidenceId),
        finalModel: input.input.result.finalModel,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "final_answer_input" },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "final_answer_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        status: input.input.result.status,
        answer: input.input.result.answer,
        confidence: input.input.result.confidence,
        sources: input.input.result.sources,
        warnings: input.input.result.trace.warnings,
        errors: input.input.result.trace.errors,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "final_answer_output" },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "gateway_answer",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      evidenceRefs: input.input.result.evidence.length > 0
        ? [
            await putGatewayDatasetObject(input.objectStore, {
              scope: input.scope,
              ownerType: "final_answer_example",
              ownerId: recordId,
              kind: "evidence",
              payload: { evidence: input.input.result.evidence },
              privacyFlags: input.privacyFlags,
              metadata: { part: "final_answer_evidence" },
            }),
          ]
        : undefined,
      quality: {
        score: confidenceScore(input.input.result.confidence),
        labels: uniqueLabels([
          "auto:final_answer",
          `auto:status:${input.input.result.status}`,
          `auto:confidence:${input.input.result.confidence}`,
        ]),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "final_answer",
        finalModelTier: input.input.result.finalModel?.tier,
        finalModelAgentSlug: input.input.result.finalModel?.agentSlug,
        sourceCount: input.input.result.sources.length,
      },
    });
  }

  private async buildRagRetrievalRecord(input: {
    call: CodaliGatewayStoredToolCall;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
  }): Promise<CodaliStorageDatasetRecord> {
    const recordId = `dataset-${input.input.result.runId}-rag-${safeDatasetIdPart(input.call.id || `${input.index + 1}-${input.call.tool}`)}`;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "rag_retrieval_event",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        toolCallId: input.call.id,
        taskId: input.call.taskId,
        tool: input.call.tool,
        args: input.call.args,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "rag_retrieval_input", toolCallId: input.call.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "rag_retrieval_event",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        toolCallId: input.call.id,
        status: input.call.status,
        result: input.call.result,
        errorCode: input.call.errorCode,
        errorMessage: input.call.errorMessage,
        latencyMs: input.call.latencyMs,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "rag_retrieval_output", toolCallId: input.call.id },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "tool_trace",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: input.call.status === "success" ? 0.6 : 0.1,
        labels: collectRagRetrievalLabels(input.call),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "rag_retrieval",
        toolCallId: input.call.id,
        taskId: input.call.taskId,
        tool: input.call.tool,
        status: input.call.status,
      },
    });
  }

  private async buildToolDecisionRecord(input: {
    decision: GatewayDatasetToolDecisionInput;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
  }): Promise<CodaliStorageDatasetRecord> {
    const recordId = `dataset-${input.input.result.runId}-tool-decision-${safeDatasetIdPart(input.decision.id || `${input.index + 1}-${input.decision.tool}`)}`;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "tool_decision_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        tool: input.decision.tool,
        taskId: input.decision.taskId,
        args: input.decision.args,
        allowedTools: input.decision.allowedTools,
        removedTools: input.decision.removedTools,
        source: input.decision.source,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "tool_decision_input", decisionId: input.decision.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "tool_decision_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        status: input.decision.status,
        result: input.decision.result,
        errorCode: input.decision.errorCode,
        errorMessage: input.decision.errorMessage,
        reason: input.decision.reason,
        latencyMs: input.decision.latencyMs,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "tool_decision_output", decisionId: input.decision.id },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "tool_trace",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: input.decision.status === "success" ? 0.55 : 0.05,
        labels: collectToolDecisionLabels(input.decision),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "tool_decision",
        decisionSource: input.decision.source,
        tool: input.decision.tool,
        taskId: input.decision.taskId,
        status: input.decision.status,
        reason: input.decision.reason,
        errorCode: input.decision.errorCode,
        ...(sanitizeGatewayDatasetMetadata(input.decision.metadata) ?? {}),
      },
    });
  }

  private async buildEvidenceItemRecord(input: {
    evidenceItem: CodaliEvidenceItem;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
  }): Promise<CodaliStorageDatasetRecord> {
    const evidenceId = safeDatasetIdPart(input.evidenceItem.id || `evidence-${input.index + 1}`);
    const recordId = `dataset-${input.input.result.runId}-evidence-${evidenceId}`;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "evidence_item_record",
      ownerId: recordId,
      kind: "evidence",
      payload: {
        evidenceId: input.evidenceItem.id,
        taskId: input.evidenceItem.taskId,
        stageId: input.evidenceItem.stageId,
        sourceType: input.evidenceItem.sourceType,
        sourceId: input.evidenceItem.sourceId,
        sourceUri: input.evidenceItem.sourceUri,
        sourceTitle: input.evidenceItem.sourceTitle,
        usedTool: input.evidenceItem.usedTool,
        tenantScoped: input.evidenceItem.tenantScoped,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "evidence_item_input", evidenceId: input.evidenceItem.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "evidence_item_record",
      ownerId: recordId,
      kind: "evidence",
      payload: {
        claim: input.evidenceItem.claim,
        summary: input.evidenceItem.summary,
        rawExcerpt: input.evidenceItem.rawExcerpt,
        rawPayloadRef: input.evidenceItem.rawPayloadRef,
        confidence: input.evidenceItem.confidence,
        relevance: input.evidenceItem.relevance,
        freshness: input.evidenceItem.freshness,
        metadata: input.evidenceItem.metadata,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "evidence_item_output", evidenceId: input.evidenceItem.id },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "evaluation",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: Math.max(0, Math.min(1, input.evidenceItem.confidence * input.evidenceItem.relevance)),
        labels: collectEvidenceLabels(input.evidenceItem),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "evidence_item",
        evidenceId: input.evidenceItem.id,
        sourceType: input.evidenceItem.sourceType,
        usedTool: input.evidenceItem.usedTool,
        tenantScoped: input.evidenceItem.tenantScoped,
      },
    });
  }

  private async buildContextPackRecord(input: {
    contextPack: CodaliContextPack;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
  }): Promise<CodaliStorageDatasetRecord> {
    const contextId = safeDatasetIdPart(input.contextPack.id || `context-${input.index + 1}`);
    const recordId = `dataset-${input.input.result.runId}-context-${contextId}`;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "context_pack_record",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        contextPackId: input.contextPack.id,
        originalQuery: input.contextPack.originalQuery,
        decisionFactIds: input.contextPack.decisionFacts.map((item) => item.id),
        selectedExcerpts: input.contextPack.selectedExcerpts,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "context_pack_input", contextPackId: input.contextPack.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "context_pack_record",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        tokenEstimate: input.contextPack.tokenEstimate,
        decisionFacts: input.contextPack.decisionFacts,
        contradictions: input.contextPack.contradictions,
        missingInformation: input.contextPack.missingInformation,
        toolSummary: input.contextPack.toolSummary,
        metadata: input.contextPack.metadata,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "context_pack_output", contextPackId: input.contextPack.id },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "evaluation",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: input.contextPack.missingInformation.length === 0 ? 0.65 : 0.35,
        labels: collectContextPackLabels(input.contextPack),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "context_pack",
        contextPackId: input.contextPack.id,
        tokenEstimate: input.contextPack.tokenEstimate,
        decisionFactCount: input.contextPack.decisionFacts.length,
        contradictionCount: input.contextPack.contradictions.length,
        missingInformationCount: input.contextPack.missingInformation.length,
      },
    });
  }

  private async buildArtifactRecord(input: {
    artifact: CodaliGatewayStoredArtifact;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
  }): Promise<CodaliStorageDatasetRecord> {
    const artifactId = safeDatasetIdPart(input.artifact.id || `artifact-${input.index + 1}`);
    const recordId = `dataset-${input.input.result.runId}-artifact-${artifactId}`;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "artifact_record",
      ownerId: recordId,
      kind: "artifact",
      payload: {
        artifactId: input.artifact.id,
        taskId: input.artifact.taskId,
        type: input.artifact.type,
        model: input.artifact.model,
        prompt: input.artifact.prompt,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "artifact_input", artifactId: input.artifact.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "artifact_record",
      ownerId: recordId,
      kind: "artifact",
      payload: {
        artifactId: input.artifact.id,
        type: input.artifact.type,
        uri: input.artifact.uri,
        path: input.artifact.path,
        createdAt: input.artifact.createdAt,
        metadata: artifactMetadataRefOnly(input.artifact.metadata),
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "artifact_ref", artifactId: input.artifact.id, objectRefOnly: true },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "tool_trace",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: input.artifact.uri || input.artifact.path ? 0.5 : 0.15,
        labels: collectArtifactLabels(input.artifact),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "artifact",
        artifactId: input.artifact.id,
        artifactType: input.artifact.type,
        taskId: input.artifact.taskId,
        objectRefOnly: true,
      },
    });
  }

  private async buildPolicyEventRecord(input: {
    event: GatewayDatasetPolicyEventInput;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
  }): Promise<CodaliStorageDatasetRecord> {
    const eventId = safeDatasetIdPart(input.event.id || `policy-${input.index + 1}`);
    const recordId = `dataset-${input.input.result.runId}-policy-${eventId}`;
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "policy_event_record",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        eventType: input.event.eventType,
        tool: input.event.tool,
        taskId: input.event.taskId,
        status: input.event.status,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "policy_event_input", policyEventId: input.event.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "policy_event_record",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        reason: input.event.reason,
        errorCode: input.event.errorCode,
        errorMessage: input.event.errorMessage,
        metadata: input.event.metadata,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "policy_event_output", policyEventId: input.event.id },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "tool_trace",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: 0,
        labels: collectPolicyEventLabels(input.event),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "policy_event",
        policyEventType: input.event.eventType,
        reason: input.event.reason,
        tool: input.event.tool,
        taskId: input.event.taskId,
        errorCode: input.event.errorCode,
      },
    });
  }

  private async buildModelCallRecord(input: {
    call: GatewayDatasetTraceModelCall;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
    schemaFailureRecordId?: string;
  }): Promise<CodaliStorageDatasetRecord> {
    const recordId = modelRecordId(input.input.result.runId, input.call, input.index);
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "model_stage_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        modelCallId: input.call.id,
        role: input.call.role,
        taskId: input.call.taskId,
        agentSlug: input.call.agentSlug,
        model: input.call.model,
        provider: input.call.provider,
        input: input.call.input,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "model_stage_input", modelCallId: input.call.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "model_stage_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        modelCallId: input.call.id,
        status: input.call.status,
        output: input.call.output,
        errorCode: input.call.errorCode,
        errorMessage: input.call.errorMessage,
        latencyMs: input.call.latencyMs,
        usage: metadataRecord(input.call.metadata, "usage"),
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "model_stage_output", modelCallId: input.call.id },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "model_call",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: modelCallScore(input.call),
        labels: collectModelCallLabels(input.call),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "model_stage",
        modelCallId: input.call.id,
        taskId: input.call.taskId,
        role: input.call.role,
        status: input.call.status,
        repairAttempts: modelCallRepairAttempts(input.call),
        schemaFailureRecordId: input.schemaFailureRecordId,
      },
    });
  }

  private async buildSchemaFailureRecord(input: {
    call: GatewayDatasetTraceModelCall;
    index: number;
    corrected?: GatewayDatasetTraceModelCall;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
    failedAttemptRecordId?: string;
    correctedRecordId?: string;
  }): Promise<CodaliStorageDatasetRecord> {
    const recordId = schemaFailureRecordId(input.input.result.runId, input.call, input.index);
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "schema_failure_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        modelCallId: input.call.id,
        role: input.call.role,
        taskId: input.call.taskId,
        failedInput: input.call.input,
        failedOutput: input.call.output,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "schema_failure_input", modelCallId: input.call.id },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "schema_failure_example",
      ownerId: recordId,
      kind: "dataset",
      payload: {
        status: input.call.status,
        errorCode: input.call.errorCode,
        errorMessage: input.call.errorMessage,
        repairAttempts: modelCallRepairAttempts(input.call),
        correctedByModelCallId: input.corrected?.id,
        correctedOutput: input.corrected?.output,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "schema_failure_output", modelCallId: input.call.id },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "evaluation",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: 0,
        labels: collectSchemaFailureLabels(input.call),
        reviewed: false,
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "schema_failure",
        failedAttemptModelCallId: input.call.id,
        failedAttemptRecordId: input.failedAttemptRecordId,
        correctedByModelCallId: input.corrected?.id,
        correctedByRecordId: input.correctedRecordId,
        correctedInSameCall: input.corrected?.id === input.call.id,
      },
    });
  }

  private async buildGoldTargetRecord(input: {
    target: GatewayDatasetGoldTargetInput;
    index: number;
    input: GatewayDatasetCollectorBuildInput;
    objectStore: GatewayDatasetObjectStore;
    scope: GatewayDatasetStorageScope;
    privacy: CodaliStoragePrivacyMetadata;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
    now: () => Date;
    modelRecordIds: Map<string, string>;
  }): Promise<CodaliStorageDatasetRecord> {
    const targetId = safeDatasetIdPart(input.target.id ?? `${input.target.kind}-${input.index + 1}`);
    const recordId = `dataset-${input.input.result.runId}-gold-${targetId}`;
    const sourceModelRecordId = input.target.sourceModelCallId
      ? input.modelRecordIds.get(input.target.sourceModelCallId)
      : undefined;
    const failedAttemptRecordId = input.target.failedAttemptRecordId
      ?? (input.target.failedAttemptModelCallId
        ? input.modelRecordIds.get(input.target.failedAttemptModelCallId)
        : undefined);
    const inputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "gold_target",
      ownerId: recordId,
      kind: "dataset",
      payload: input.target.input ?? {
        query: input.input.request.query,
        sourceRecordId: input.target.sourceRecordId ?? sourceModelRecordId ?? `dataset-${input.input.result.runId}`,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "gold_target_input", goldTargetKind: input.target.kind },
    });
    const outputRef = await putGatewayDatasetObject(input.objectStore, {
      scope: input.scope,
      ownerType: "gold_target",
      ownerId: recordId,
      kind: "dataset",
      payload: input.target.target ?? {
        answer: input.input.result.answer,
        status: input.input.result.status,
      },
      privacyFlags: input.privacyFlags,
      metadata: { part: "gold_target_output", goldTargetKind: input.target.kind },
    });
    return validateDatasetRecordOrThrow({
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      recordType: "dataset_record",
      recordId,
      datasetKind: "curated_example",
      createdAt: input.now().toISOString(),
      sourceGatewayRecordId: input.input.result.runId,
      inputRef,
      outputRef,
      quality: {
        score: input.target.score ?? (input.target.kind === "accepted" ? 0.85 : 0.95),
        labels: collectGoldTargetLabels(input.target),
        reviewed: input.target.kind === "reviewed",
      },
      privacy: input.privacy,
      metadata: {
        collectionMode: "gateway_trace_collector",
        exampleType: "gold_target",
        goldTargetKind: input.target.kind,
        sourceRecordId: input.target.sourceRecordId,
        sourceModelCallId: input.target.sourceModelCallId,
        sourceModelRecordId,
        failedAttemptModelCallId: input.target.failedAttemptModelCallId,
        failedAttemptRecordId,
        reviewerId: input.target.reviewerId,
        reasons: input.target.reasons,
        deletionGroupId: outputRef.deletionGroupId,
        linkedDeletionGroupIds: uniqueStrings([
          inputRef.deletionGroupId,
          outputRef.deletionGroupId,
        ]),
        ...(input.target.metadata ?? {}),
      },
    });
  }
}

export const createGatewayDatasetCollector = (): GatewayDatasetCollector =>
  new GatewayDatasetCollector();

export const buildGatewayDatasetCollectInputFromGatewayResult = async (
  input: Omit<GatewayDatasetGatewayCollectionInput, "store" | "enabled" | "fallbackStore" | "onError" | "onResult">,
): Promise<GatewayDatasetStoreCollectInput> => {
  return new GatewayDatasetCollector().buildCollectInput(input);
};

export const collectGatewayDatasetResult = async (
  input: GatewayDatasetGatewayCollectionInput,
): Promise<GatewayDatasetStoreWriteResult> => {
  if (input.enabled === false) {
    return { accepted: true, status: "skipped", recordCount: 0 };
  }
  const collectInput = await buildGatewayDatasetCollectInputFromGatewayResult(input);
  try {
    return await input.store.collect(collectInput);
  } catch (error) {
    if (!input.fallbackStore) throw error;
    const fallback = await input.fallbackStore.collect(collectInput);
    return {
      ...fallback,
      fallbackUsed: true,
      errors: [...(fallback.errors ?? []), errorMessage(error)],
    };
  }
};

export const collectGatewayDatasetResultNonBlocking = (
  input: GatewayDatasetGatewayCollectionInput,
): GatewayDatasetStoreWriteResult => {
  if (input.enabled === false) {
    return { accepted: true, status: "skipped", recordCount: 0 };
  }
  const queued: GatewayDatasetStoreWriteResult = {
    accepted: true,
    status: "queued",
    recordCount: 1,
    idempotencyKey: input.idempotencyKey,
  };
  const run = async () => {
    try {
      const result = await collectGatewayDatasetResult(input);
      input.onResult?.(result);
    } catch (error) {
      input.onError?.(error);
    }
  };
  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => {
      void run();
    });
  } else {
    setTimeout(() => {
      void run();
    }, 0);
  }
  return queued;
};
