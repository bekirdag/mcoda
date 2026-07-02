import type {
  CodaliRuntimeAppToolContracts,
  CodaliRuntimeAppToolGatewayContract,
  CodaliRuntimeDocdexInput,
  CodaliRuntimeToolManifest,
} from "../runtime/CodaliRuntime.js";

export type CodaliGatewayMode = "fast" | "balanced" | "deep" | "cheap" | "image";

export type CodaliGatewayStatus =
  | "succeeded"
  | "failed"
  | "partial"
  | "needs_clarification";

export type CodaliGatewayConfidence = "high" | "medium" | "low";

export type CodaliGatewayModelTier = "small" | "medium" | "large" | "image";

export type CodaliGatewayMessageRole = "system" | "user" | "assistant";

export type CodaliGatewayResponseFormat = "text" | "json" | "json_schema";

export type CodaliGatewayFreshness = "fresh" | "recent" | "stale" | "unknown";

export type CodaliGatewayToolRiskCategory =
  | "read_only"
  | "write_with_approval"
  | "destructive_blocked";

export type CodaliGatewayApprovalStatus =
  | "not_required"
  | "required"
  | "approved"
  | "denied"
  | "expired"
  | "missing";

export interface CodaliGatewayMessage {
  role: CodaliGatewayMessageRole;
  content: string;
}

export interface CodaliGatewayRequest {
  id?: string;
  query: string;
  mode?: CodaliGatewayMode;
  product?: {
    name?: string;
    version?: string;
    surface?: string;
  };
  tenant?: {
    id?: string;
    slug?: string;
    realm?: string;
  };
  requester?: {
    id?: string;
    email?: string;
    role?: string;
    locale?: string;
  };
  conversation?: {
    id?: string;
    messages?: CodaliGatewayMessage[];
  };
  docdex?: CodaliRuntimeDocdexInput;
  tools?: CodaliRuntimeToolManifest;
  policy: CodaliGatewayPolicy;
  agentPolicy?: CodaliAgentTierPolicy;
  response?: CodaliGatewayResponsePolicy;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayPolicy {
  allowedTools: string[];
  deniedTools?: string[];
  appToolContracts?: CodaliRuntimeAppToolContracts;
  appVirtualTools?: string[];
  appToolGateway?: CodaliRuntimeAppToolGatewayContract;
  maxIterations: number;
  maxRuntimeMs: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxEvidenceItems: number;
  maxImageArtifacts?: number;
  maxContextPackTokens: number;
  allowWrites: false;
  allowShell: false;
  allowDestructiveOperations: false;
  allowOutsideWorkspace: false;
  requireFinalLargeModel: boolean;
  allowDegradedFinalAnswer?: boolean;
  allowImageWorker?: boolean;
}

export interface CodaliGatewayApprovalRequirement {
  required: boolean;
  reason: string;
  approverRoles?: string[];
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayApprovalRecord {
  approvalId: string;
  status: CodaliGatewayApprovalStatus;
  tool?: string;
  riskCategory?: CodaliGatewayToolRiskCategory;
  requesterId?: string;
  approverId?: string;
  approvedAt?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayTenantLimitProfile {
  tenantId?: string;
  tenantSlug?: string;
  maxRuntimeMs?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxEvidenceItems?: number;
  maxImageArtifacts?: number;
}

export interface CodaliGatewayEffectiveLimitProfile {
  maxRuntimeMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxEvidenceItems: number;
  maxImageArtifacts: number;
  tenantScoped: boolean;
  limitSource: "policy" | "tenant" | "minimum";
}

export interface CodaliGatewaySecurityIssue {
  code: string;
  message: string;
  tool?: string;
  severity: "warning" | "error";
  details?: Record<string, unknown>;
}

export interface CodaliGatewayToolRisk {
  tool: string;
  riskCategory: CodaliGatewayToolRiskCategory;
  approval: CodaliGatewayApprovalRequirement;
  blocked: boolean;
  reasons: string[];
}

export interface CodaliGatewayPromptHardening {
  toolOutputBoundary: string;
  policyImmutability: string;
  tenantScope: string;
  finalEvidenceScope: string;
}

export interface CodaliGatewaySecurityReview {
  ok: boolean;
  limits: CodaliGatewayEffectiveLimitProfile;
  toolRisks: CodaliGatewayToolRisk[];
  approvals: CodaliGatewayApprovalRecord[];
  warnings: CodaliGatewaySecurityIssue[];
  errors: CodaliGatewaySecurityIssue[];
  promptHardening: CodaliGatewayPromptHardening;
}

export interface CodaliAgentRolePolicy {
  tier: CodaliGatewayModelTier;
  capabilities?: string[];
  requiresTools?: boolean;
  requiresJsonSchema?: boolean;
  maxLatencyMs?: number;
  minContextWindow?: number;
  preferredRunnerKinds?: string[];
}

export interface CodaliAgentTierPolicy {
  resolver: "mcoda_inventory";
  allowCloudFallback?: boolean;
  roles?: Record<string, CodaliAgentRolePolicy>;
}

export interface CodaliGatewayResponsePolicy {
  format?: CodaliGatewayResponseFormat;
  schema?: Record<string, unknown>;
  finalAnswerRequired?: boolean;
}

export interface CodaliEvidenceItem {
  id: string;
  runId: string;
  taskId?: string;
  stageId?: string;
  claim: string;
  summary?: string;
  sourceType: string;
  sourceId?: string;
  sourceUri?: string;
  sourceTitle?: string;
  sourceTimestamp?: string;
  rawExcerpt?: string;
  rawPayloadRef?: string;
  confidence: number;
  relevance: number;
  freshness?: CodaliGatewayFreshness;
  usedTool?: string;
  tenantScoped: boolean;
  metadata?: Record<string, unknown>;
}

export interface CodaliContextPackContradiction {
  summary: string;
  evidenceIds: string[];
}

export interface CodaliContextPackExcerpt {
  evidenceId: string;
  text: string;
}

export interface CodaliContextPackToolSummary {
  tool: string;
  calls: number;
  statuses: Record<string, number>;
}

export interface CodaliContextPack {
  id: string;
  runId: string;
  originalQuery: string;
  decisionFacts: CodaliEvidenceItem[];
  contradictions: CodaliContextPackContradiction[];
  missingInformation: string[];
  selectedExcerpts: CodaliContextPackExcerpt[];
  toolSummary: CodaliContextPackToolSummary[];
  tokenEstimate: number;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewaySource {
  evidenceId: string;
  title?: string;
  uri?: string;
  sourceType: string;
}

export interface CodaliGatewayFinalModel {
  agentSlug?: string;
  tier: "large";
  model?: string;
}

export interface CodaliGatewayResult {
  runId: string;
  status: CodaliGatewayStatus;
  answer: string;
  sources: CodaliGatewaySource[];
  confidence: CodaliGatewayConfidence;
  evidence: CodaliEvidenceItem[];
  contextPack?: CodaliContextPack;
  finalModel?: CodaliGatewayFinalModel;
  trace: CodaliGatewayTrace;
  telemetry: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewaySubquestion {
  id: string;
  question: string;
  rationale?: string;
  priority?: number;
}

export interface CodaliGatewayClassifierOutput {
  queryType: string;
  needsPrivateData: boolean;
  needsFreshData: boolean;
  needsDocdex: boolean;
  needsAppTools: boolean;
  needsImageWorker: boolean;
  directAnswerCandidate?: string;
  rationale?: string;
  confidence?: CodaliGatewayConfidence;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayWorkerTask {
  id: string;
  workerRole: string;
  objective: string;
  query?: string;
  toolsAllowed: string[];
  outputFormat: string;
  expectedSources?: string[];
  constraints?: string[];
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayPlannerOutput {
  runId?: string;
  queryType: string;
  summary?: string;
  subquestions: CodaliGatewaySubquestion[];
  workerTasks: CodaliGatewayWorkerTask[];
  expectedEvidenceCount?: number;
  maxIterations?: number;
  requiresFinalLargeModel?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayVerifierIssue {
  code: string;
  message: string;
  severity?: "info" | "warning" | "error";
  evidenceIds?: string[];
}

export interface CodaliGatewayVerifierOutput {
  passed: boolean;
  confidence: number;
  verifiedEvidenceIds: string[];
  rejectedEvidenceIds: string[];
  issues: CodaliGatewayVerifierIssue[];
  contradictions: CodaliContextPackContradiction[];
  missingInformation: string[];
  followUpTasks: CodaliGatewayWorkerTask[];
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayTraceEvent {
  timestamp?: string;
  kind: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayTraceToolCall {
  tool: string;
  status: "success" | "failed" | "blocked" | "skipped";
  latencyMs?: number;
  taskId?: string;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayTraceModelCall {
  role: string;
  tier?: CodaliGatewayModelTier;
  agentSlug?: string;
  provider?: string;
  model?: string;
  status: "success" | "failed" | "blocked" | "skipped";
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  errorCode?: string;
}

export interface CodaliGatewayTrace {
  runId: string;
  mode: CodaliGatewayMode;
  status: CodaliGatewayStatus;
  iterations: number;
  toolCallCount: number;
  modelCallCount: number;
  consideredTools: string[];
  calledTools: string[];
  warnings: string[];
  errors: string[];
  toolCalls: CodaliGatewayTraceToolCall[];
  modelCalls: CodaliGatewayTraceModelCall[];
  events: CodaliGatewayTraceEvent[];
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayValidationIssue {
  path: string;
  code: string;
  message: string;
  value?: unknown;
}

export type CodaliGatewayValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: CodaliGatewayValidationIssue[] };
