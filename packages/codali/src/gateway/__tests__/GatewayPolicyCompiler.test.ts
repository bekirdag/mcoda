import test from "node:test";
import assert from "node:assert/strict";
import { compileCodaliGatewayPolicy } from "../GatewayPolicyCompiler.js";
import type { CodaliGatewayPolicy } from "../CodaliGatewayTypes.js";

const basePolicy = (
  overrides: Partial<CodaliGatewayPolicy> = {},
): CodaliGatewayPolicy => ({
  allowedTools: ["docdex_search"],
  deniedTools: [],
  maxIterations: 3,
  maxRuntimeMs: 60_000,
  maxToolCalls: 8,
  maxModelCalls: 5,
  maxEvidenceItems: 20,
  maxContextPackTokens: 12_000,
  allowWrites: false,
  allowShell: false,
  allowDestructiveOperations: false,
  allowOutsideWorkspace: false,
  requireFinalLargeModel: true,
  ...overrides,
});

test("compiles a read-only gateway policy into runtime policy and job budgets", () => {
  const result = compileCodaliGatewayPolicy({
    policy: basePolicy({
      allowedTools: ["docdex_search", "tenant_policy_search", "github_search"],
      deniedTools: ["github_search"],
      appVirtualTools: ["tenant_policy_search", "github_search"],
      appToolContracts: {
        tenant_policy_search: {
          readOnly: true,
          callSchema: { type: "object", properties: { query: { type: "string" } } },
          backingTools: ["docdex_search"],
        },
        github_search: {
          readOnly: true,
          callSchema: { type: "object" },
          backingTools: ["docdex_search"],
        },
      },
      maxToolCalls: 4,
      maxModelCalls: 3,
    }),
    docdex: {
      enabled: true,
      required: true,
      repoId: "repo-1",
      allowedOperations: ["search"],
    },
    tools: {
      actualTools: [{ name: "docdex_search" }],
      virtualTools: [{ name: "tenant_policy_search" }, { name: "github_search" }],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.effectiveAllowedTools, [
    "docdex_search",
    "tenant_policy_search",
  ]);
  assert.deepEqual(result.effectiveDeniedTools, ["github_search"]);
  assert.deepEqual(result.runtimePolicy.appVirtualTools, ["tenant_policy_search"]);
  assert.equal(result.runtimePolicy.allowWrites, false);
  assert.equal(result.runtimePolicy.allowShell, false);
  assert.equal(result.runtimePolicy.maxToolCalls, 4);
  assert.equal(result.jobBudgets.maxParallelStages, 3);
  assert.ok(result.skippedTools.some((tool) => tool.name === "github_search"));
});

test("fails with a stable error when required Docdex context is missing", () => {
  const result = compileCodaliGatewayPolicy({
    policy: basePolicy({ allowedTools: ["docdex_search"] }),
    tools: { actualTools: [{ name: "docdex_search" }] },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.code === "GATEWAY_DOCDEX_REQUIRED"),
  );
});

test("blocks Docdex operations not present in allowedOperations", () => {
  const result = compileCodaliGatewayPolicy({
    policy: basePolicy({ allowedTools: ["docdex_search"] }),
    docdex: {
      enabled: true,
      required: true,
      repoId: "repo-1",
      allowedOperations: ["open"],
    },
    tools: { actualTools: [{ name: "docdex_search" }] },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.code === "GATEWAY_DOCDEX_OPERATION_BLOCKED",
    ),
  );
});

test("requires immutable encrypted Docdex runtime context for attached-key jobs", () => {
  const missing = compileCodaliGatewayPolicy({
    policy: basePolicy({ allowedTools: ["docdex_search"] }),
    docdex: {
      enabled: true,
      required: true,
      credentialSource: "attached_mswarm_api_key",
      repoRoot: "/tmp/local-fallback-must-not-be-used",
      allowedOperations: ["search"],
    },
    tools: { actualTools: [{ name: "docdex_search" }] },
  });

  assert.equal(missing.ok, false);
  const immutableError = missing.errors.find(
    (error) => error.code === "GATEWAY_DOCDEX_IMMUTABLE_CONTEXT_REQUIRED",
  );
  assert.notEqual(immutableError, undefined);
  assert.deepEqual(immutableError?.details?.missing, [
    "baseUrl",
    "repoId",
    "capabilities",
    "apiKey",
  ]);

  const complete = compileCodaliGatewayPolicy({
    policy: basePolicy({ allowedTools: ["docdex_search"] }),
    docdex: {
      enabled: true,
      required: true,
      baseUrl: "https://docdex.example.test",
      repoId: "tenant-repo-1",
      apiKey: "attached-key",
      credentialSource: "attached_mswarm_api_key",
      allowedOperations: ["search"],
      capabilities: { search: true },
    },
    tools: { actualTools: [{ name: "docdex_search" }] },
  });

  assert.equal(complete.ok, true);
  assert.deepEqual(complete.toolCompilation.requiredDocdexOperations, ["search"]);
});

test("removes disabled, unsafe, undeclared, and tenant-overriding app tools", () => {
  const result = compileCodaliGatewayPolicy({
    policy: basePolicy({
      allowedTools: [
        "docdex_search",
        "tenant_policy_search",
        "disabled_tool",
        "write_tool",
        "override_tool",
        "missing_backing_tool",
        "undeclared_tool",
        "shell",
      ],
      appVirtualTools: [
        "tenant_policy_search",
        "disabled_tool",
        "write_tool",
        "override_tool",
        "missing_backing_tool",
      ],
      appToolContracts: {
        tenant_policy_search: {
          readOnly: true,
          callSchema: { type: "object", properties: { query: { type: "string" } } },
          backingTools: ["docdex_search"],
        },
        disabled_tool: {
          enabled: false,
          readOnly: true,
          backingTools: ["docdex_search"],
        },
        write_tool: {
          readOnly: true,
          backingTools: ["shell"],
        },
        override_tool: {
          readOnly: true,
          callSchema: {
            type: "object",
            properties: {
              repo_id: { type: "string" },
              tenantId: { type: "string" },
            },
          },
          backingTools: ["docdex_search"],
        },
        missing_backing_tool: {
          readOnly: true,
          callSchema: { type: "object" },
        },
      },
    }),
    docdex: {
      enabled: true,
      required: true,
      repoId: "repo-1",
      allowedOperations: ["search"],
    },
    tools: {
      actualTools: [{ name: "docdex_search" }],
      virtualTools: [
        { name: "tenant_policy_search" },
        { name: "disabled_tool" },
        { name: "write_tool" },
        { name: "override_tool" },
        { name: "missing_backing_tool" },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.effectiveAllowedTools, [
    "docdex_search",
    "tenant_policy_search",
  ]);
  assert.deepEqual(Object.keys(result.runtimePolicy.appToolContracts ?? {}), [
    "tenant_policy_search",
  ]);
  const reasons = new Set(result.skippedTools.map((tool) => tool.reason));
  assert.ok(reasons.has("disabled"));
  assert.ok(reasons.has("unsafe_backing_tools"));
  assert.ok(reasons.has("reserved_call_schema_properties"));
  assert.ok(reasons.has("missing_backing_tools"));
  assert.ok(reasons.has("not_declared"));
});

test("requires signed explicit read-only direct app tool gateways", () => {
  const unsigned = compileCodaliGatewayPolicy({
    policy: basePolicy({
      allowedTools: ["crm_lookup"],
      appVirtualTools: ["crm_lookup"],
      appToolGateway: {
        endpoint: "https://app.example.test/tools",
        readOnly: true,
      },
      appToolContracts: {
        crm_lookup: {
          readOnly: true,
          executionMode: "app_tool_gateway",
          callSchema: { type: "object" },
        },
      },
    }),
    tools: { virtualTools: [{ name: "crm_lookup" }] },
  });

  assert.equal(unsigned.ok, true);
  assert.deepEqual(unsigned.effectiveAllowedTools, []);
  assert.ok(
    unsigned.skippedTools.some(
      (tool) => tool.name === "crm_lookup" && tool.reason === "gateway_signature_required",
    ),
  );

  const readOnlyMissing = compileCodaliGatewayPolicy({
    policy: basePolicy({
      allowedTools: ["crm_lookup"],
      appVirtualTools: ["crm_lookup"],
      appToolGateway: {
        endpoint: "https://app.example.test/tools",
        signatureSecret: "shared-secret",
      },
      appToolContracts: {
        crm_lookup: {
          readOnly: true,
          executionMode: "app_tool_gateway",
          callSchema: { type: "object" },
        },
      },
    }),
    tools: { virtualTools: [{ name: "crm_lookup" }] },
  });

  assert.deepEqual(readOnlyMissing.effectiveAllowedTools, []);
  assert.ok(
    readOnlyMissing.skippedTools.some(
      (tool) => tool.name === "crm_lookup" && tool.reason === "gateway_not_read_only",
    ),
  );

  const signed = compileCodaliGatewayPolicy({
    policy: basePolicy({
      allowedTools: ["crm_lookup"],
      appVirtualTools: ["crm_lookup"],
      appToolGateway: {
        endpoint: "https://app.example.test/tools",
        readOnly: true,
        signatureSecret: "shared-secret",
      },
      appToolContracts: {
        crm_lookup: {
          readOnly: true,
          executionMode: "app_tool_gateway",
          callSchema: { type: "object" },
        },
      },
    }),
    tools: { virtualTools: [{ name: "crm_lookup" }] },
  });

  assert.equal(signed.ok, true);
  assert.deepEqual(signed.effectiveAllowedTools, ["crm_lookup"]);
  assert.deepEqual(Object.keys(signed.runtimePolicy.appToolContracts ?? {}), [
    "crm_lookup",
  ]);
  assert.equal(
    signed.toolCapabilities.find((tool) => tool.name === "crm_lookup")?.kind,
    "app_gateway",
  );
});

test("always forces runtime write, shell, destructive, and outside-workspace guards off", () => {
  const unsafePolicy = {
    ...basePolicy({ allowedTools: ["docdex_search"] }),
    allowWrites: true,
    allowShell: true,
    allowDestructiveOperations: true,
    allowOutsideWorkspace: true,
  } as unknown as CodaliGatewayPolicy;

  const result = compileCodaliGatewayPolicy({
    policy: unsafePolicy,
    docdex: { enabled: true, required: true, repoId: "repo-1" },
    tools: { actualTools: [{ name: "docdex_search" }] },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.code === "GATEWAY_READ_ONLY_POLICY_REQUIRED",
    ),
  );
  assert.equal(result.runtimePolicy.allowWrites, false);
  assert.equal(result.runtimePolicy.allowShell, false);
  assert.equal(result.runtimePolicy.allowDestructiveOperations, false);
  assert.equal(result.runtimePolicy.allowOutsideWorkspace, false);
});
