import test from "node:test";
import assert from "node:assert/strict";
import type { CodaliGatewayPolicy, CodaliGatewayRequest } from "../CodaliGatewayTypes.js";
import { validateCodaliGatewayPolicy } from "../CodaliGatewaySchemas.js";
import { compileCodaliGatewayPolicy } from "../GatewayPolicyCompiler.js";
import {
  classifyCodaliGatewayToolRisk,
  resolveCodaliGatewaySecurityPolicy,
} from "../GatewaySecurityPolicy.js";

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
  maxImageArtifacts: 0,
  maxContextPackTokens: 12_000,
  allowWrites: false,
  allowShell: false,
  allowDestructiveOperations: false,
  allowOutsideWorkspace: false,
  requireFinalLargeModel: true,
  ...overrides,
});

const request = (
  policy: CodaliGatewayPolicy,
  overrides: Partial<CodaliGatewayRequest> = {},
): CodaliGatewayRequest => ({
  id: "security-policy-run",
  query: "Review tenant policy",
  mode: "balanced",
  tenant: { id: "tenant-1", slug: "tenant-one" },
  policy,
  ...overrides,
});

test("resolves effective per-run and per-tenant gateway limits", () => {
  const review = resolveCodaliGatewaySecurityPolicy({
    request: request(
      basePolicy({
        maxRuntimeMs: 90_000,
        maxModelCalls: 8,
        maxToolCalls: 6,
        maxEvidenceItems: 12,
        maxImageArtifacts: 3,
        allowImageWorker: true,
      }),
      {
        metadata: {
          gatewaySecurity: {
            tenantLimits: {
              maxRuntimeMs: 45_000,
              maxModelCalls: 3,
              maxToolCalls: 2,
              maxEvidenceItems: 6,
              maxImageArtifacts: 1,
            },
          },
        },
      },
    ),
    effectiveAllowedTools: ["docdex_search"],
  });

  assert.equal(review.ok, true);
  assert.deepEqual(review.limits, {
    maxRuntimeMs: 45_000,
    maxModelCalls: 3,
    maxToolCalls: 2,
    maxEvidenceItems: 6,
    maxImageArtifacts: 1,
    tenantScoped: true,
    limitSource: "tenant",
  });
  assert.equal(review.toolRisks[0]?.riskCategory, "read_only");
  assert.equal(review.toolRisks[0]?.approval.required, false);
});

test("classifies write and destructive tools without enabling approvals by default", () => {
  assert.equal(classifyCodaliGatewayToolRisk("docdex_search"), "read_only");
  assert.equal(classifyCodaliGatewayToolRisk("github_issue_create"), "write_with_approval");
  assert.equal(classifyCodaliGatewayToolRisk("delete_repo"), "destructive_blocked");

  const review = resolveCodaliGatewaySecurityPolicy({
    request: request(
      basePolicy({
        allowedTools: ["docdex_search", "github_issue_create", "delete_repo"],
      }),
      {
        metadata: {
          gatewaySecurity: {
            approvals: [
              {
                approvalId: "approval-1",
                status: "approved",
                tool: "github_issue_create",
                riskCategory: "write_with_approval",
              },
            ],
          },
        },
      },
    ),
    effectiveAllowedTools: ["docdex_search", "github_issue_create", "delete_repo"],
  });

  assert.equal(review.ok, false);
  assert.ok(
    review.errors.some((error) => error.tool === "github_issue_create"),
  );
  assert.ok(review.errors.some((error) => error.tool === "delete_repo"));
  assert.equal(
    review.toolRisks.find((tool) => tool.tool === "github_issue_create")?.blocked,
    true,
  );
});

test("compiler rejects risky declared actual tools before runtime exposure", () => {
  const result = compileCodaliGatewayPolicy({
    policy: basePolicy({ allowedTools: ["shell"] }),
    tools: { actualTools: [{ name: "shell" }] },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.toolCapabilities.find((tool) => tool.name === "shell")?.riskCategory,
    "destructive_blocked",
  );
  assert.ok(
    result.errors.some((error) => error.code === "GATEWAY_TOOL_RISK_BLOCKED"),
  );
});

test("policy validation accepts zero image artifact budget", () => {
  const validation = validateCodaliGatewayPolicy({
    allowedTools: [],
    max_image_artifacts: 0,
    allowWrites: false,
    allowShell: false,
    allowDestructiveOperations: false,
    allowOutsideWorkspace: false,
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.ok ? validation.value.maxImageArtifacts : undefined, 0);
});
