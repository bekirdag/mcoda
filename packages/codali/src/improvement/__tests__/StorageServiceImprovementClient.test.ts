import assert from "node:assert/strict";
import test from "node:test";
import type {
  GatewayDatasetFetch,
  GatewayDatasetFetchRequest,
  GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";
import {
  StorageServiceImprovementClient,
  StorageServiceImprovementClientError,
} from "../StorageServiceImprovementClient.js";

const scope: GatewayDatasetStorageScope = {
  tenantId: "tenant-phase-22",
  productId: "product-neutral",
  deploymentId: "phase-22",
  runId: "improvement-run-phase-22",
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

test("StorageServiceImprovementClient rejects missing auth", () => {
  assert.throws(
    () => new StorageServiceImprovementClient({
      baseUrl: "http://storage.local",
      serviceToken: "",
      fetch: async () => response({}),
    }),
    (error) => {
      assert.ok(error instanceof StorageServiceImprovementClientError);
      assert.equal(error.code, "CODALI_IMPROVEMENT_STORAGE_AUTH_MISSING");
      return true;
    },
  );
});

test("StorageServiceImprovementClient signs candidate writes with auth and scope headers", async () => {
  const requests: Array<{ url: string; request: GatewayDatasetFetchRequest }> = [];
  const fetchImpl: GatewayDatasetFetch = async (url, request) => {
    requests.push({ url, request });
    return response({
      body: {
        accepted: true,
        candidate: {
          candidateId: "candidate-1",
        },
        scope,
      },
    });
  };
  const client = new StorageServiceImprovementClient({
    baseUrl: "http://storage.local/",
    serviceToken: "service-token",
    fetch: fetchImpl,
    now: () => new Date("2026-07-07T12:00:00.000Z"),
    nonceFactory: () => "nonce-1",
  });

  const result = await client.recordCandidate({
    scope,
    idempotencyKey: "candidate-idempotency",
    body: {
      candidate_id: "candidate-1",
      source_export_id: "export-1",
      source_record_ids: ["record-1"],
      candidate_kind: "prompt",
      candidate_ref: "file://candidate.jsonl",
      status: "proposed",
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.scope.tenantId, scope.tenantId);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request?.url, "http://storage.local/v1/improvement/candidates");
  assert.equal(request?.request.method, "POST");
  assert.equal(request?.request.headers.authorization, "Bearer service-token");
  assert.equal(request?.request.headers["x-codali-storage-tenant"], scope.tenantId);
  assert.equal(request?.request.headers["x-codali-storage-product"], scope.productId);
  assert.equal(
    request?.request.headers["x-codali-storage-deployment"],
    scope.deploymentId,
  );
  assert.equal(request?.request.headers["x-codali-storage-run"], scope.runId);
  assert.equal(
    request?.request.headers["x-codali-storage-idempotency-key"],
    "candidate-idempotency",
  );
  assert.equal(request?.request.headers["x-codali-storage-timestamp"], "2026-07-07T12:00:00.000Z");
  assert.equal(request?.request.headers["x-codali-storage-nonce"], "nonce-1");
  assert.ok(request?.request.headers["x-codali-storage-body-sha256"]);
  assert.ok(request?.request.headers["x-codali-storage-signature"]);
});

test("StorageServiceImprovementClient reads release lineage and product quality summaries", async () => {
  const requests: Array<{ url: string; request: GatewayDatasetFetchRequest }> = [];
  const fetchImpl: GatewayDatasetFetch = async (url, request) => {
    requests.push({ url, request });
    if (url.endsWith("/v1/improvement/releases/release-1/lineage")) {
      return response({
        status: 200,
        body: {
          accepted: true,
          lineage: {
            releaseId: "release-1",
            traceableToExports: true,
            traceableToEvalGates: true,
          },
          scope,
        },
      });
    }
    return response({
      status: 200,
      body: {
        accepted: true,
        qualitySummary: {
          productId: scope.productId,
          releaseCount: 1,
          blockedCandidateCount: 0,
        },
        scope,
      },
    });
  };
  const client = new StorageServiceImprovementClient({
    baseUrl: "http://storage.local/",
    serviceToken: "service-token",
    fetch: fetchImpl,
    now: () => new Date("2026-07-07T12:00:00.000Z"),
    nonceFactory: () => "nonce-1",
  });

  const lineage = await client.getReleaseLineage<{
    releaseId: string;
    traceableToExports: boolean;
    traceableToEvalGates: boolean;
  }>({
    scope,
    releaseId: "release-1",
  });
  const quality = await client.getProductQualitySummary<{
    productId: string;
    releaseCount: number;
    blockedCandidateCount: number;
  }>({
    scope,
  });

  assert.equal(lineage.accepted, true);
  assert.equal(lineage.record?.releaseId, "release-1");
  assert.equal(lineage.record?.traceableToExports, true);
  assert.equal(lineage.record?.traceableToEvalGates, true);
  assert.equal(quality.accepted, true);
  assert.equal(quality.record?.productId, scope.productId);
  assert.equal(quality.record?.releaseCount, 1);
  assert.equal(requests.length, 2);

  assert.equal(
    requests[0]?.url,
    "http://storage.local/v1/improvement/releases/release-1/lineage",
  );
  assert.equal(requests[0]?.request.method, "GET");
  assert.equal(requests[0]?.request.body, undefined);
  assert.equal(requests[0]?.request.headers.authorization, "Bearer service-token");
  assert.equal(requests[0]?.request.headers["x-codali-storage-tenant"], scope.tenantId);
  assert.equal(requests[0]?.request.headers["x-codali-storage-product"], scope.productId);
  assert.ok(requests[0]?.request.headers["x-codali-storage-body-sha256"]);
  assert.ok(requests[0]?.request.headers["x-codali-storage-signature"]);

  assert.equal(
    requests[1]?.url,
    "http://storage.local/v1/improvement/products/product-neutral/quality-summary",
  );
  assert.equal(requests[1]?.request.method, "GET");
  assert.equal(requests[1]?.request.body, undefined);
  assert.equal(requests[1]?.request.headers["x-codali-storage-run"], scope.runId);
});

test("StorageServiceImprovementClient rejects request scope mismatch before fetch", async () => {
  let called = false;
  const client = new StorageServiceImprovementClient({
    baseUrl: "http://storage.local",
    serviceToken: "service-token",
    fetch: async () => {
      called = true;
      return response({});
    },
  });

  await assert.rejects(
    () => client.recordRun({
      scope,
      body: {
        scope: {
          tenantId: "other-tenant",
        },
        improvement_run_id: "run-1",
        status: "completed",
      },
    }),
    (error) => {
      assert.ok(error instanceof StorageServiceImprovementClientError);
      assert.equal(error.code, "CODALI_IMPROVEMENT_STORAGE_REQUEST_SCOPE_MISMATCH");
      return true;
    },
  );
  assert.equal(called, false);
});

test("StorageServiceImprovementClient rejects response scope mismatch", async () => {
  const client = new StorageServiceImprovementClient({
    baseUrl: "http://storage.local",
    serviceToken: "service-token",
    fetch: async () => response({
      body: {
        accepted: true,
        run: {
          improvementRunId: "run-1",
        },
        scope: {
          ...scope,
          productId: "other-product",
        },
      },
    }),
  });

  await assert.rejects(
    () => client.recordRun({
      scope,
      body: {
        improvement_run_id: "run-1",
        status: "completed",
        source_export_id: "export-1",
      },
    }),
    (error) => {
      assert.ok(error instanceof StorageServiceImprovementClientError);
      assert.equal(error.code, "CODALI_IMPROVEMENT_STORAGE_SCOPE_MISMATCH");
      return true;
    },
  );
});
