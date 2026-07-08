import { randomUUID } from "node:crypto";
import {
  buildGatewayDatasetServiceSignatureHeaders,
  type GatewayDatasetFetch,
  type GatewayDatasetFetchRequest,
  type GatewayDatasetFetchResponse,
  type GatewayDatasetStorageScope,
} from "../storage/GatewayDatasetStore.js";

export const STORAGE_SERVICE_IMPROVEMENT_CLIENT_SCHEMA_VERSION =
  "codali.improvement.storage_client.v1" as const;

export const DEFAULT_STORAGE_SERVICE_IMPROVEMENT_RUNS_ENDPOINT =
  "/v1/improvement/runs" as const;

export const DEFAULT_STORAGE_SERVICE_IMPROVEMENT_CANDIDATES_ENDPOINT =
  "/v1/improvement/candidates" as const;

export const DEFAULT_STORAGE_SERVICE_IMPROVEMENT_RELEASE_LINEAGE_ENDPOINT =
  "/v1/improvement/releases" as const;

export const DEFAULT_STORAGE_SERVICE_IMPROVEMENT_PRODUCT_QUALITY_SUMMARY_ENDPOINT =
  "/v1/improvement/products" as const;

export interface StorageServiceImprovementClientOptions {
  baseUrl: string;
  serviceToken: string;
  hmacSecret?: string;
  runEndpointPath?: string;
  candidateEndpointPath?: string;
  releaseLineageEndpointPath?: string;
  productQualitySummaryEndpointPath?: string;
  timeoutMs?: number;
  fetch?: GatewayDatasetFetch;
  now?: () => Date;
  nonceFactory?: () => string;
}

export interface StorageServiceImprovementWriteInput {
  scope: GatewayDatasetStorageScope;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface StorageServiceImprovementWriteResult<TRecord = unknown> {
  accepted: boolean;
  status: number;
  response: unknown;
  record?: TRecord;
  scope: GatewayDatasetStorageScope;
}

export interface StorageServiceImprovementReleaseLineageInput {
  scope: GatewayDatasetStorageScope;
  releaseId: string;
}

export interface StorageServiceImprovementProductQualitySummaryInput {
  scope: GatewayDatasetStorageScope;
  productId?: string;
}

export interface StorageServiceImprovementQueryResult<TRecord = unknown> {
  accepted: boolean;
  status: number;
  response: unknown;
  record?: TRecord;
  scope: GatewayDatasetStorageScope;
}

export class StorageServiceImprovementClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(input: { code: string; message: string; status?: number }) {
    super(`${input.code}: ${input.message}`);
    this.name = "StorageServiceImprovementClientError";
    this.code = input.code;
    this.status = input.status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const endpointUrl = (baseUrl: string, endpointPath: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${endpointPath.replace(/^\/+/, "")}`;

const appendEndpointPath = (
  endpointPath: string,
  ...parts: readonly string[]
): string => [
  endpointPath.replace(/\/+$/, ""),
  ...parts.map((part) => encodeURIComponent(part)).filter(Boolean),
].join("/");

const readScopeValue = (
  record: Record<string, unknown>,
  camelKey: keyof GatewayDatasetStorageScope,
  snakeKey: string,
): string | undefined => {
  const camel = record[camelKey];
  if (typeof camel === "string" && camel.trim()) return camel.trim();
  const snake = record[snakeKey];
  return typeof snake === "string" && snake.trim() ? snake.trim() : undefined;
};

const readScope = (value: unknown): Partial<GatewayDatasetStorageScope> | undefined => {
  if (!isRecord(value)) return undefined;
  const scope = {
    tenantId: readScopeValue(value, "tenantId", "tenant_id"),
    productId: readScopeValue(value, "productId", "product_id"),
    deploymentId: readScopeValue(value, "deploymentId", "deployment_id"),
    runId: readScopeValue(value, "runId", "run_id"),
  };
  return Object.values(scope).some(Boolean) ? scope : undefined;
};

const assertFullScope = (
  scope: Partial<GatewayDatasetStorageScope> | undefined,
  code: string,
): GatewayDatasetStorageScope => {
  if (!scope?.tenantId || !scope.productId || !scope.deploymentId || !scope.runId) {
    throw new StorageServiceImprovementClientError({
      code,
      message: "Storage-service improvement responses must include tenant/product/deployment/run scope.",
    });
  }
  return {
    tenantId: scope.tenantId,
    productId: scope.productId,
    deploymentId: scope.deploymentId,
    runId: scope.runId,
  };
};

const assertScopeMatch = (
  expected: GatewayDatasetStorageScope,
  actual: Partial<GatewayDatasetStorageScope> | undefined,
  code: string,
): void => {
  if (!actual) return;
  const mismatches = (["tenantId", "productId", "deploymentId", "runId"] as const)
    .filter((key) => actual[key] !== undefined && actual[key] !== expected[key]);
  if (mismatches.length > 0) {
    throw new StorageServiceImprovementClientError({
      code,
      message: `Storage-service improvement scope mismatch: ${mismatches.join(", ")}.`,
    });
  }
};

const parseResponseBody = async (
  response: GatewayDatasetFetchResponse,
): Promise<unknown> => {
  const raw = await response.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const responseRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const maybeRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
};

const assertRequiredString = (
  value: string | undefined,
  code: string,
  label: string,
): string => {
  if (!value?.trim()) {
    throw new StorageServiceImprovementClientError({
      code,
      message: `${label} is required for StorageServiceImprovementClient.`,
    });
  }
  return value.trim();
};

export class StorageServiceImprovementClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: GatewayDatasetFetch;

  constructor(private readonly options: StorageServiceImprovementClientOptions) {
    this.baseUrl = assertRequiredString(
      options.baseUrl,
      "CODALI_IMPROVEMENT_STORAGE_CONFIG_MISSING",
      "baseUrl",
    );
    this.serviceToken = assertRequiredString(
      options.serviceToken,
      "CODALI_IMPROVEMENT_STORAGE_AUTH_MISSING",
      "serviceToken",
    );
    const defaultFetch = globalThis.fetch?.bind(globalThis) as GatewayDatasetFetch | undefined;
    const fetchImpl = options.fetch ?? defaultFetch;
    if (!fetchImpl) {
      throw new StorageServiceImprovementClientError({
        code: "CODALI_IMPROVEMENT_STORAGE_FETCH_UNAVAILABLE",
        message: "No fetch implementation is available.",
      });
    }
    this.fetchImpl = fetchImpl;
  }

  async recordRun<TRecord = unknown>(
    input: StorageServiceImprovementWriteInput,
  ): Promise<StorageServiceImprovementWriteResult<TRecord>> {
    return this.write<TRecord>({
      endpointPath:
        this.options.runEndpointPath ?? DEFAULT_STORAGE_SERVICE_IMPROVEMENT_RUNS_ENDPOINT,
      recordKeys: ["run", "record"],
      ...input,
    });
  }

  async recordCandidate<TRecord = unknown>(
    input: StorageServiceImprovementWriteInput,
  ): Promise<StorageServiceImprovementWriteResult<TRecord>> {
    return this.write<TRecord>({
      endpointPath:
        this.options.candidateEndpointPath ??
        DEFAULT_STORAGE_SERVICE_IMPROVEMENT_CANDIDATES_ENDPOINT,
      recordKeys: ["candidate", "record"],
      ...input,
    });
  }

  async getReleaseLineage<TRecord = unknown>(
    input: StorageServiceImprovementReleaseLineageInput,
  ): Promise<StorageServiceImprovementQueryResult<TRecord>> {
    const releaseId = assertRequiredString(
      input.releaseId,
      "CODALI_IMPROVEMENT_STORAGE_RELEASE_ID_MISSING",
      "releaseId",
    );
    return this.read<TRecord>({
      endpointPath: appendEndpointPath(
        this.options.releaseLineageEndpointPath ??
          DEFAULT_STORAGE_SERVICE_IMPROVEMENT_RELEASE_LINEAGE_ENDPOINT,
        releaseId,
        "lineage",
      ),
      recordKeys: ["lineage", "releaseLineage", "data", "record"],
      scope: input.scope,
    });
  }

  async getProductQualitySummary<TRecord = unknown>(
    input: StorageServiceImprovementProductQualitySummaryInput,
  ): Promise<StorageServiceImprovementQueryResult<TRecord>> {
    const productId = assertRequiredString(
      input.productId ?? input.scope.productId,
      "CODALI_IMPROVEMENT_STORAGE_PRODUCT_ID_MISSING",
      "productId",
    );
    return this.read<TRecord>({
      endpointPath: appendEndpointPath(
        this.options.productQualitySummaryEndpointPath ??
          DEFAULT_STORAGE_SERVICE_IMPROVEMENT_PRODUCT_QUALITY_SUMMARY_ENDPOINT,
        productId,
        "quality-summary",
      ),
      recordKeys: ["qualitySummary", "productQualitySummary", "summary", "data", "record"],
      scope: input.scope,
    });
  }

  private async write<TRecord>(input: StorageServiceImprovementWriteInput & {
    endpointPath: string;
    recordKeys: readonly string[];
  }): Promise<StorageServiceImprovementWriteResult<TRecord>> {
    assertScopeMatch(
      input.scope,
      readScope(input.body.scope),
      "CODALI_IMPROVEMENT_STORAGE_REQUEST_SCOPE_MISMATCH",
    );
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
    const nonce = this.options.nonceFactory?.() ?? randomUUID();
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.serviceToken}`,
      "content-type": "application/json",
      "x-codali-storage-tenant": input.scope.tenantId,
      "x-codali-storage-product": input.scope.productId,
      "x-codali-storage-deployment": input.scope.deploymentId,
      "x-codali-storage-run": input.scope.runId,
      ...(input.idempotencyKey
        ? { "x-codali-storage-idempotency-key": input.idempotencyKey }
        : {}),
      ...buildGatewayDatasetServiceSignatureHeaders({
        scope: input.scope,
        body: input.body,
        hmacSecret: this.options.hmacSecret ?? this.serviceToken,
        timestamp,
        nonce,
      }),
    };
    const response = await this.fetchWithTimeout(endpointUrl(this.baseUrl, input.endpointPath), {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
    });
    const parsed = await parseResponseBody(response);
    if (!response.ok) {
      throw new StorageServiceImprovementClientError({
        code: "CODALI_IMPROVEMENT_STORAGE_REQUEST_FAILED",
        message: `Storage service returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
        status: response.status,
      });
    }
    const parsedRecord = responseRecord(parsed);
    const responseScope = assertFullScope(
      readScope(parsedRecord.scope),
      "CODALI_IMPROVEMENT_STORAGE_RESPONSE_SCOPE_MISSING",
    );
    assertScopeMatch(
      input.scope,
      responseScope,
      "CODALI_IMPROVEMENT_STORAGE_SCOPE_MISMATCH",
    );
    return {
      accepted: parsedRecord.accepted === true,
      status: response.status,
      response: parsed,
      record: maybeRecord(parsedRecord, input.recordKeys) as TRecord | undefined,
      scope: responseScope,
    };
  }

  private async read<TRecord>(input: {
    endpointPath: string;
    recordKeys: readonly string[];
    scope: GatewayDatasetStorageScope;
  }): Promise<StorageServiceImprovementQueryResult<TRecord>> {
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
    const nonce = this.options.nonceFactory?.() ?? randomUUID();
    const body: Record<string, unknown> = {};
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.serviceToken}`,
      "content-type": "application/json",
      "x-codali-storage-tenant": input.scope.tenantId,
      "x-codali-storage-product": input.scope.productId,
      "x-codali-storage-deployment": input.scope.deploymentId,
      "x-codali-storage-run": input.scope.runId,
      ...buildGatewayDatasetServiceSignatureHeaders({
        scope: input.scope,
        body,
        hmacSecret: this.options.hmacSecret ?? this.serviceToken,
        timestamp,
        nonce,
      }),
    };
    const response = await this.fetchWithTimeout(endpointUrl(this.baseUrl, input.endpointPath), {
      method: "GET",
      headers,
    });
    const parsed = await parseResponseBody(response);
    if (!response.ok) {
      throw new StorageServiceImprovementClientError({
        code: "CODALI_IMPROVEMENT_STORAGE_REQUEST_FAILED",
        message: `Storage service returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
        status: response.status,
      });
    }
    const parsedRecord = responseRecord(parsed);
    const responseScope = assertFullScope(
      readScope(parsedRecord.scope),
      "CODALI_IMPROVEMENT_STORAGE_RESPONSE_SCOPE_MISSING",
    );
    assertScopeMatch(
      input.scope,
      responseScope,
      "CODALI_IMPROVEMENT_STORAGE_SCOPE_MISMATCH",
    );
    return {
      accepted: parsedRecord.accepted === undefined ? true : parsedRecord.accepted === true,
      status: response.status,
      response: parsed,
      record: maybeRecord(parsedRecord, input.recordKeys) as TRecord | undefined,
      scope: responseScope,
    };
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

export const createStorageServiceImprovementClient = (
  options: StorageServiceImprovementClientOptions,
): StorageServiceImprovementClient => new StorageServiceImprovementClient(options);
