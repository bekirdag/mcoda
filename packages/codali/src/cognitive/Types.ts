import type { LocalContextConfig } from "../config/Config.js";
import type { IntentSignals } from "./IntentSignals.js";
import type { ProviderMessage } from "../providers/ProviderTypes.js";
import type { AgentRequest } from "../agents/AgentProtocol.js";

export type { LocalContextConfig };

export type ContextLaneRole = "librarian" | "architect" | "builder" | "critic" | "custom";

export interface LaneScope {
  jobId?: string;
  runId?: string;
  taskId?: string;
  taskKey?: string;
  role: ContextLaneRole;
  ephemeral?: boolean;
}

export interface ContextLane {
  id: string;
  role: ContextLaneRole;
  model?: string;
  messages: ProviderMessage[];
  tokenEstimate: number;
  updatedAt: number;
  persisted: boolean;
}

export interface ContextSnippet {
  doc_id?: string;
  path?: string;
  content: string;
  score?: number;
  snippet_origin?: string;
  snippet_truncated?: boolean;
  line_start?: number;
  line_end?: number;
  score_breakdown?: DocdexHitScoreBreakdown;
  provenance?: DocdexHitProvenance;
  retrieval_explanation?: DocdexRetrievalExplanation;
}

export interface DocdexHitScoreBreakdown {
  query_relevance?: number;
  structural_relevance?: number;
  recency_diff_relevance?: number;
  total?: number;
}

export interface DocdexHitProvenance {
  doc_id?: string;
  rel_path?: string;
  path?: string;
  line_start?: number;
  line_end?: number;
  anchor_kind?: string;
}

export interface DocdexRetrievalExplanation {
  summary?: string;
  signals?: string[];
}

export interface ContextSearchHit {
  doc_id?: string;
  path?: string;
  score?: number;
  snippet_origin?: string;
  snippet_truncated?: boolean;
  line_start?: number;
  line_end?: number;
  score_breakdown?: DocdexHitScoreBreakdown;
  provenance?: DocdexHitProvenance;
  retrieval_explanation?: DocdexRetrievalExplanation;
}

export interface ContextSymbolSummary {
  path: string;
  summary: string;
}

export interface ContextAstSummary {
  path: string;
  nodes: unknown[];
}

export interface ContextImpactSummary {
  file: string;
  inbound: string[];
  outbound: string[];
}

export interface ContextImpactDiagnostics {
  file: string;
  diagnostics: unknown;
}

export interface ContextSearchResult {
  query: string;
  hits: ContextSearchHit[];
}

export interface ContextProjectInfo {
  workspace_root?: string;
  readme_path?: string;
  readme_summary?: string;
  docs?: string[];
  manifests?: string[];
  file_types?: string[];
}

export type RetrievalDisposition = "resolved" | "degraded" | "unresolved";

export type RetrievalReasonCode =
  | "search_hit"
  | "preferred_file"
  | "recent_file"
  | "forced_focus"
  | "impact_neighbor"
  | "ui_scaffold"
  | "testing_candidate"
  | "infra_candidate"
  | "security_candidate"
  | "observability_candidate"
  | "performance_candidate"
  | "backend_candidate"
  | "code_candidate"
  | "fallback_inserted_candidate"
  | "doc_heavy_demotion"
  | "test_doc_cap"
  | "low_signal_candidate"
  | "budget_pruned"
  | "budget_trimmed"
  | "missing_content"
  | "tool_output_skipped";

export type RetrievalDroppedCategory =
  | "doc_heavy_demotion"
  | "test_doc_cap"
  | "budget_pruned"
  | "budget_trimmed"
  | "low_signal_candidate"
  | "missing_content"
  | "skipped_tool_output";

export interface ContextSelectionEntry {
  path: string;
  role: "focus" | "periphery";
  inclusion_reasons: RetrievalReasonCode[];
}

export interface ContextSelectionDroppedEntry {
  path?: string;
  category: RetrievalDroppedCategory;
  reason_code: RetrievalReasonCode;
  detail?: string;
}

export interface ContextSelectionReasonSummary {
  code: RetrievalReasonCode;
  count: number;
}

export interface ContextSelection {
  focus: string[];
  periphery: string[];
  all: string[];
  low_confidence: boolean;
  entries?: ContextSelectionEntry[];
  dropped?: ContextSelectionDroppedEntry[];
  reason_summary?: ContextSelectionReasonSummary[];
}

export type ContextFileRole = "focus" | "periphery";

export type ContextFileOrigin = "fs" | "docdex";

export interface ContextFileEntry {
  path: string;
  role: ContextFileRole;
  content: string;
  size: number;
  truncated: boolean;
  sliceStrategy: string;
  origin: ContextFileOrigin;
  token_estimate?: number;
  warnings?: string[];
  redactions?: number;
}

export interface ContextMemoryEntry {
  text: string;
  source: string;
}

export interface ContextPreferenceDetected {
  category: string;
  content: string;
  source?: string;
  scope?: "repo_memory" | "profile_memory";
  confidence_score?: number;
  confidence_band?: "low" | "medium" | "high";
  confidence_reasons?: string[];
}

export interface ContextProfileEntry {
  content: string;
  source: string;
}

export interface ContextIndexInfo {
  last_updated_epoch_ms: number;
  num_docs: number;
}

export interface ContextResearchToolUsage {
  search: number;
  open_or_snippet: number;
  symbols_or_ast: number;
  impact: number;
  tree: number;
  dag_export: number;
}

export interface ContextResearchEvidence {
  search_hits: number;
  snippet_count: number;
  symbol_files: number;
  ast_files: number;
  impact_files: number;
  impact_edges: number;
  repo_map: boolean;
  dag_summary: boolean;
  warnings?: string[];
  gaps?: string[];
}

export interface ContextResearchSummary {
  status: "skipped" | "completed";
  started_at_ms?: number;
  ended_at_ms?: number;
  duration_ms?: number;
  key_findings?: string[];
  tool_usage?: ContextResearchToolUsage;
  evidence?: ContextResearchEvidence;
  warnings?: string[];
  notes?: string[];
}

export type EvidenceGateStatus = "pass" | "fail";

export type EvidenceGateSignal =
  | "search_hits"
  | "open_or_snippet"
  | "symbols_or_ast"
  | "impact"
  | "warnings";

export interface EvidenceGateMetrics {
  search_hits: number;
  open_or_snippet: number;
  symbols_or_ast: number;
  impact: number;
  warnings: number;
}

export interface EvidenceGateAssessment {
  status: EvidenceGateStatus;
  score: number;
  threshold: number;
  missing: EvidenceGateSignal[];
  required: EvidenceGateMetrics;
  observed: EvidenceGateMetrics;
  warnings?: string[];
  gaps?: string[];
}

export interface ContextRequestDigest {
  summary: string;
  refined_query: string;
  confidence: "high" | "medium" | "low";
  signals: string[];
  candidate_files?: string[];
}

export interface RetrievalPreflightCheck {
  check: "docdex_health" | "docdex_initialize" | "docdex_stats" | "docdex_files";
  status: "ok" | "failed" | "skipped";
  detail?: string;
}

export type RetrievalExecutionDisposition = "executed" | "failed" | "skipped" | "unavailable";

export interface RetrievalToolExecution {
  tool: string;
  category:
    | "search"
    | "open_or_snippet"
    | "symbols_or_ast"
    | "impact"
    | "memory"
    | "profile"
    | "tree"
    | "dag_export"
    | "capability_probe";
  disposition: RetrievalExecutionDisposition;
  notes?: string;
  error?: string;
}

export type DocdexCapabilityStatus = "available" | "unavailable" | "unknown";

export interface DocdexCapabilityMap {
  score_breakdown: DocdexCapabilityStatus;
  rerank: DocdexCapabilityStatus;
  snippet_provenance: DocdexCapabilityStatus;
  retrieval_explanation: DocdexCapabilityStatus;
  batch_search: DocdexCapabilityStatus;
}

export interface DocdexCapabilitySnapshot {
  cached: boolean;
  source: "mcp_probe" | "fallback";
  probed_at_ms: number;
  capabilities: DocdexCapabilityMap;
  warnings?: string[];
}

export interface RetrievalReportV1 {
  schema_version: 1;
  mode: "normal" | "deep";
  created_at_ms: number;
  confidence: "high" | "medium" | "low";
  disposition: RetrievalDisposition;
  preflight: RetrievalPreflightCheck[];
  selection: {
    focus: string[];
    periphery: string[];
    all: string[];
    low_confidence: boolean;
    entries: ContextSelectionEntry[];
    reason_summary: ContextSelectionReasonSummary[];
  };
  dropped: ContextSelectionDroppedEntry[];
  truncated: Array<{ path: string; reason_code: RetrievalReasonCode; detail?: string }>;
  unresolved_gaps: string[];
  tool_execution: RetrievalToolExecution[];
  capabilities?: DocdexCapabilitySnapshot;
  warnings: string[];
}

export interface SerializedContext {
  mode: "bundle_text" | "json";
  audience?: "librarian" | "builder";
  content: string;
  token_estimate?: number;
  stats?: {
    focus_files: number;
    periphery_files: number;
    total_bytes: number;
  };
}

export interface ContextBundle {
  request: string;
  intent?: IntentSignals;
  query_signals?: {
    phrases: string[];
    file_tokens: string[];
    keywords: string[];
    keyword_phrases: string[];
  };
  request_digest?: ContextRequestDigest;
  queries: string[];
  search_results?: ContextSearchResult[];
  snippets: ContextSnippet[];
  symbols: ContextSymbolSummary[];
  ast: ContextAstSummary[];
  impact: ContextImpactSummary[];
  impact_diagnostics: ContextImpactDiagnostics[];
  dag_summary?: string;
  repo_map?: string;
  repo_map_raw?: string;
  project_info?: ContextProjectInfo;
  files?: ContextFileEntry[];
  serialized?: SerializedContext;
  selection?: ContextSelection;
  retrieval_disposition?: RetrievalDisposition;
  retrieval_report?: RetrievalReportV1;
  allow_write_paths?: string[];
  read_only_paths?: string[];
  redaction?: { count: number; ignored: string[] };
  memory: ContextMemoryEntry[];
  episodic_memory?: Array<{ intent: string; plan: string; diff: string }>;
  golden_examples?: Array<{ intent: string; patch: string }>;
  preferences_detected: ContextPreferenceDetected[];
  profile: ContextProfileEntry[];
  index: ContextIndexInfo;
  research?: ContextResearchSummary;
  warnings: string[];
  missing?: string[];
}

export interface ContextRequest {
  reason?: string;
  queries?: string[];
  files?: string[];
}

export interface Plan {
  steps: string[];
  target_files: string[];
  create_files?: string[];
  risk_assessment: string;
  verification: string[];
}

export type VerificationOutcome =
  | "verified_passed"
  | "verified_failed"
  | "unverified_with_reason";

export type VerificationReasonCode =
  | "verification_not_executed"
  | "verification_no_steps"
  | "verification_no_runnable_checks"
  | "verification_policy_minimum_unmet"
  | "verification_shell_disabled"
  | "verification_command_not_allowlisted"
  | "verification_command_failed"
  | "verification_command_timeout"
  | "verification_tool_unavailable"
  | "verification_step_empty"
  | "verification_docdex_unavailable"
  | "verification_hooks_failed";

export type VerificationCheckType = "shell" | "docdex_hooks" | "unknown";
export type VerificationCheckStatus = "passed" | "failed" | "unverified" | "skipped";

export interface VerificationPolicySummary {
  policy_name: string;
  minimum_checks: number;
  enforce_high_confidence: boolean;
}

export interface VerificationCheckResult {
  step: string;
  check_type: VerificationCheckType;
  status: VerificationCheckStatus;
  targeted: boolean;
  reason_code?: VerificationReasonCode;
  message?: string;
  evidence?: string;
  duration_ms?: number;
}

export interface VerificationReport {
  schema_version: 1;
  outcome: VerificationOutcome;
  reason_codes: VerificationReasonCode[];
  policy: VerificationPolicySummary;
  checks: VerificationCheckResult[];
  totals: {
    configured: number;
    runnable: number;
    attempted: number;
    passed: number;
    failed: number;
    unverified: number;
  };
  touched_files?: string[];
  language_signals?: string[];
  project_signals?: string[];
  resolved_checks_source?: "explicit" | "derived" | "mixed";
}

export const RUNTIME_PHASE_SEQUENCE = [
  "plan",
  "retrieve",
  "act",
  "verify",
  "answer",
] as const;

export type RuntimePhase = (typeof RUNTIME_PHASE_SEQUENCE)[number];

export interface RuntimePhaseTransitionErrorMetadata {
  code: "CODALI_INVALID_PHASE_TRANSITION";
  from_phase: RuntimePhase | "start";
  to_phase: RuntimePhase;
  requested_phase: string;
  allowed_next_phases: RuntimePhase[];
  phase_trace: RuntimePhase[];
}

export type RetryDisposition = "retry" | "terminate";

export type RetryReasonCode =
  | "critic_retryable_failure"
  | "critic_non_retryable_failure"
  | "builder_patch_apply_retry"
  | "builder_patch_apply_deterministic_no_repair"
  | "builder_context_refresh_retry"
  | "builder_context_refresh_terminated"
  | "architect_review_retry"
  | "architect_review_retry_exhausted"
  | "semantic_guard_retry"
  | "semantic_guard_retry_exhausted"
  | "phase_provider_fallback_retry";

export interface RetryDecision {
  phase: RuntimePhase;
  reason_code: RetryReasonCode;
  disposition: RetryDisposition;
  attempt: number;
  max_attempts: number;
  details?: string[];
}

export type PatchFailureClass =
  | "schema"
  | "scope"
  | "search_match"
  | "filesystem"
  | "rollback"
  | "guardrail";

export interface PatchFailureClassification {
  failure_class: PatchFailureClass;
  failure_code: string;
  remediation_key: string;
  retryable: boolean;
}

export type ContextRefreshTerminationReason =
  | "refresh_budget_exhausted"
  | "no_new_context"
  | "phase_timeout"
  | "evidence_gate_failed";

export interface PhaseArtifactError {
  class: string;
  message: string;
  code?: string;
}

export interface PhaseArtifactUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface PhaseArtifactV1 {
  schema_version: 1;
  phase: string;
  kind: "input" | "output" | "summary" | "error" | string;
  run_id?: string;
  started_at_ms?: number;
  ended_at_ms?: number;
  duration_ms?: number;
  warnings?: string[];
  usage?: PhaseArtifactUsage;
  error?: PhaseArtifactError;
  payload?: unknown;
}

export interface RunContractFingerprint {
  algorithm: "sha256";
  value: string;
}

export type GuardrailDisposition = "retryable" | "non_retryable";
export type GuardrailReasonCode =
  | "scope_violation"
  | "doc_edit_guard"
  | "merge_conflict"
  | "destructive_operation_guard";

export interface GuardrailClassification {
  disposition: GuardrailDisposition;
  reason_code: GuardrailReasonCode;
}

export interface CriticResult {
  status: "PASS" | "FAIL";
  reasons: string[];
  retryable: boolean;
  guardrail?: GuardrailClassification;
  high_confidence?: boolean;
  verification?: VerificationReport;
  report?: CriticReport;
  request?: AgentRequest;
}

export interface CriticReport {
  status: "PASS" | "FAIL";
  reasons: string[];
  suggested_fixes: string[];
  touched_files?: string[];
  plan_targets?: string[];
  alignment_evidence?: {
    touched_files: string[];
    plan_targets: string[];
    matched_targets: string[];
    unmatched_targets: string[];
    unrelated_touched_files: string[];
  };
  guardrail?: GuardrailClassification;
  high_confidence?: boolean;
  verification?: VerificationReport;
}

export interface PhaseUsage {
  phase: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}
