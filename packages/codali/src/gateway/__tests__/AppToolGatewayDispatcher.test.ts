import test from "node:test";
import assert from "node:assert/strict";
import {
  AppToolGatewayDispatchError,
  CODALI_APP_TOOL_GATEWAY_VERSION,
  dispatchAppToolGateway,
  redactAppToolGatewayPayload,
  verifyAppToolGatewayRequestSignature,
  type CodaliAppToolGatewaySignedRequest,
} from "../AppToolGatewayDispatcher.js";
import { normalizeCodaliEvidence } from "../EvidenceNormalizer.js";
import type {
  CodaliRuntimeAppToolContract,
  CodaliRuntimeAppToolGatewayContract,
} from "../../runtime/CodaliRuntime.js";

const baseContract = (): CodaliRuntimeAppToolContract => ({
  name: "crm_lookup",
  readOnly: true,
  executionMode: "app_tool_gateway",
  callSchema: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
    },
  },
  resultContract: "tenant CRM facts",
  resultSources: ["smartclick"],
  sourcePaths: ["tenant/crm"],
  sourceTypes: ["smartclick_crm"],
});

const baseGateway = (): CodaliRuntimeAppToolGatewayContract => ({
  endpoint: "https://app.example.test/tools",
  readOnly: true,
  signatureSecret: "shared-secret",
});

const jsonResponse = (
  payload: unknown,
  status = 200,
  ok = status < 400,
): Response =>
  ({
    ok,
    status,
    text: async () => JSON.stringify(payload),
  }) as Response;

const textResponse = (
  body: string,
  status = 200,
  ok = status < 400,
): Response =>
  ({
    ok,
    status,
    text: async () => body,
  }) as Response;

const expectGatewayError = (
  code: string,
): ((error: unknown) => boolean) => (error: unknown): boolean =>
  error instanceof AppToolGatewayDispatchError && error.code === code;

test("dispatcher signs read-only gateway requests and normalizes product evidence", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  let capturedBody: CodaliAppToolGatewaySignedRequest | undefined;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    capturedBody = JSON.parse(String(init?.body)) as CodaliAppToolGatewaySignedRequest;
    return jsonResponse({
      facts: [
        {
          claim: "SmartClick CRM is enabled for the tenant.",
          source: {
            id: "crm-tenant-1",
            url: "https://smartclick.example.test/tenant/1",
            title: "SmartClick tenant profile",
            timestamp: "2026-07-02T07:00:00.000Z",
          },
          confidence: 0.91,
        },
      ],
    });
  }) as typeof fetch;

  const result = await dispatchAppToolGateway({
    runId: "run-1",
    sessionId: "session-1",
    requestId: "request-1",
    tenantScope: { tenant_id: "tenant-1", docdex_repo_id: "repo-1" },
    requesterScope: {
      request_id: "request-1",
      owner_user_id: "user-1",
      api_key_id: "api-key-1",
      agent_slug: "codali-agent",
    },
    toolName: "crm_lookup",
    args: { query: "status", limit: 2 },
    contract: baseContract(),
    gateway: baseGateway(),
    allowedTools: ["crm_lookup"],
    deniedTools: [],
    now: () => new Date("2026-07-02T07:00:00.000Z"),
    nonce: () => "nonce-1",
    fetchImpl,
  });

  assert.equal(capturedUrl, "https://app.example.test/tools");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedBody?.version, CODALI_APP_TOOL_GATEWAY_VERSION);
  assert.equal(capturedBody?.read_only, true);
  assert.equal(capturedBody?.run_id, "run-1");
  assert.equal(capturedBody?.session_id, "session-1");
  assert.equal(capturedBody?.tenant_scope?.tenant_id, "tenant-1");
  assert.equal(capturedBody?.requester_scope?.api_key_id, "api-key-1");
  assert.deepEqual(capturedBody?.validated_args, { query: "status", limit: 2 });
  assert.equal(capturedBody?.result_contract, "tenant CRM facts");
  assert.ok(capturedBody?.signature.startsWith("sha256="));
  assert.equal(
    (capturedInit?.headers as Record<string, string>)["x-codali-app-tool-signature"],
    capturedBody?.signature,
  );
  assert.equal(
    verifyAppToolGatewayRequestSignature(capturedBody, "shared-secret"),
    true,
  );
  assert.equal(
    verifyAppToolGatewayRequestSignature(
      { ...capturedBody, validated_args: { query: "tampered" } },
      "shared-secret",
    ),
    false,
  );
  assert.deepEqual(
    (result.redactedRequest as Record<string, unknown>).signature,
    "[redacted]",
  );
  assert.equal(result.evidencePayload.sourceType, "app_tool");
  assert.equal(result.evidencePayload.tenantScoped, true);
  assert.equal(result.evidencePayload.tool, "crm_lookup");
  assert.ok(Array.isArray(result.evidencePayload.facts));

  const normalized = normalizeCodaliEvidence({
    runId: "run-1",
    taskId: "task-1",
    defaultTenantScoped: true,
    toolCalls: [
      {
        tool: "crm_lookup",
        status: "success",
        result: result.evidencePayload,
      },
    ],
  });

  assert.equal(normalized.evidence.length, 1);
  assert.equal(normalized.evidence[0]?.sourceType, "app_tool");
  assert.equal(normalized.evidence[0]?.sourceId, "crm-tenant-1");
  assert.equal(
    normalized.evidence[0]?.claim,
    "SmartClick CRM is enabled for the tenant.",
  );
});

test("dispatcher rejects missing explicit read-only flags", async () => {
  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: { query: "status" },
      contract: { ...baseContract(), readOnly: undefined },
      gateway: baseGateway(),
      fetchImpl: async () => jsonResponse({}),
    }),
    expectGatewayError("GATEWAY_CONTRACT_NOT_READ_ONLY"),
  );

  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: { query: "status" },
      contract: baseContract(),
      gateway: { ...baseGateway(), readOnly: undefined },
      fetchImpl: async () => jsonResponse({}),
    }),
    expectGatewayError("GATEWAY_CONTRACT_NOT_READ_ONLY"),
  );
});

test("dispatcher rejects unsigned gateway dispatch", async () => {
  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: { query: "status" },
      contract: baseContract(),
      gateway: { endpoint: "https://app.example.test/tools", readOnly: true },
      fetchImpl: async () => jsonResponse({}),
    }),
    expectGatewayError("GATEWAY_SIGNATURE_REQUIRED"),
  );
});

test("dispatcher blocks scope override args and schema violations", async () => {
  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: { query: "status", tenant_id: "other-tenant" },
      contract: baseContract(),
      gateway: baseGateway(),
      fetchImpl: async () => jsonResponse({}),
    }),
    expectGatewayError("GATEWAY_SCOPE_OVERRIDE_BLOCKED"),
  );

  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: {},
      contract: baseContract(),
      gateway: baseGateway(),
      fetchImpl: async () => jsonResponse({}),
    }),
    expectGatewayError("GATEWAY_INVALID_ARGS"),
  );
});

test("dispatcher enforces allowed and denied tool policy", async () => {
  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: { query: "status" },
      contract: baseContract(),
      gateway: baseGateway(),
      allowedTools: ["other_tool"],
      fetchImpl: async () => jsonResponse({}),
    }),
    expectGatewayError("GATEWAY_TOOL_NOT_ALLOWED"),
  );

  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: { query: "status" },
      contract: baseContract(),
      gateway: baseGateway(),
      deniedTools: ["crm_lookup"],
      fetchImpl: async () => jsonResponse({}),
    }),
    expectGatewayError("GATEWAY_TOOL_DENIED"),
  );
});

test("dispatcher rejects malformed JSON responses and redacts diagnostics", async () => {
  await assert.rejects(
    dispatchAppToolGateway({
      runId: "run-1",
      toolName: "crm_lookup",
      args: { query: "status" },
      contract: baseContract(),
      gateway: baseGateway(),
      fetchImpl: async () => textResponse("{not json"),
    }),
    expectGatewayError("GATEWAY_RESPONSE_MALFORMED"),
  );

  assert.deepEqual(
    redactAppToolGatewayPayload({
      signature: "secret",
      nested: { apiKey: "key", visible: "ok" },
    }),
    {
      signature: "[redacted]",
      nested: { apiKey: "[redacted]", visible: "ok" },
    },
  );
});
