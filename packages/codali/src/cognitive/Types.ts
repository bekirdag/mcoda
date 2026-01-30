import type { LocalContextConfig } from "../config/Config.js";
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

export interface ContextSelection {
  focus: string[];
  periphery: string[];
  all: string[];
  low_confidence: boolean;
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
}

export interface ContextProfileEntry {
  content: string;
  source: string;
}

export interface ContextIndexInfo {
  last_updated_epoch_ms: number;
  num_docs: number;
}

export interface SerializedContext {
  mode: "bundle_text" | "json";
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
  queries: string[];
  snippets: ContextSnippet[];
  symbols: ContextSymbolSummary[];
  ast: ContextAstSummary[];
  impact: ContextImpactSummary[];
  impact_diagnostics: ContextImpactDiagnostics[];
  repo_map?: string;
  files?: ContextFileEntry[];
  serialized?: SerializedContext;
  selection?: ContextSelection;
  allow_write_paths?: string[];
  read_only_paths?: string[];
  redaction?: { count: number; ignored: string[] };
  memory: ContextMemoryEntry[];
  preferences_detected: ContextPreferenceDetected[];
  profile: ContextProfileEntry[];
  index: ContextIndexInfo;
  warnings: string[];
}

export interface ContextRequest {
  reason?: string;
  queries?: string[];
  files?: string[];
}

export interface Plan {
  steps: string[];
  target_files: string[];
  risk_assessment: string;
  verification: string[];
}

export interface CriticResult {
  status: "PASS" | "FAIL";
  reasons: string[];
  retryable: boolean;
  report?: CriticReport;
  request?: AgentRequest;
}

export interface CriticReport {
  status: "PASS" | "FAIL";
  reasons: string[];
  suggested_fixes: string[];
  touched_files?: string[];
  plan_targets?: string[];
}

export interface PhaseUsage {
  phase: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}
