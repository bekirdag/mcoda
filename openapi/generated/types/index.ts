export interface BacklogLaneTotals {
  tasks: number;
  story_points: number;
}

export interface BacklogTotals {
  implementation: BacklogLaneTotals;
  review: BacklogLaneTotals;
  qa: BacklogLaneTotals;
  done: BacklogLaneTotals;
}

export interface BacklogScope {
  project?: string;
  epic?: string;
  story?: string;
  assignee?: string;
}

export interface BacklogSummary {
  scope: BacklogScope;
  totals: BacklogTotals;
}

export type VelocitySource = "config" | "empirical" | "mixed";

export interface EffectiveVelocity {
  implementationSpPerHour: number;
  reviewSpPerHour: number;
  qaSpPerHour: number;
  source: VelocitySource;
  windowTasks?: 10 | 20 | 50;
  samples?: {
    implementation?: number;
    review?: number;
    qa?: number;
  };
}

export interface EstimateDurations {
  implementationHours: number | null;
  reviewHours: number | null;
  qaHours: number | null;
  totalHours: number | null;
}

export interface EstimateEtas {
  readyToReviewEta?: string;
  readyToQaEta?: string;
  completeEta?: string;
}

export interface EstimateResult {
  scope: BacklogScope & { workspaceId: string };
  backlogTotals: BacklogTotals;
  effectiveVelocity: EffectiveVelocity;
  durationsHours: EstimateDurations;
  etas: EstimateEtas;
}

export interface WorkOnTasksRequest {
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys?: string[];
  statusFilter?: string[];
  limit?: number;
  parallel?: number;
  noCommit?: boolean;
  dryRun?: boolean;
  agent?: string;
  agentStream?: boolean;
}

export interface WorkOnTasksResult {
  jobId: string;
  commandRunId: string;
  processed?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  blocked?: string[];
  warnings?: string[];
}

export interface TaskComment {
  id: string;
  taskId: string;
  taskRunId?: string | null;
  jobId?: string | null;
  sourceCommand: string;
  authorType: "agent" | "human";
  authorAgentId?: string | null;
  category?: string | null;
  file?: string | null;
  line?: number | null;
  pathHint?: string | null;
  body: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
}

export interface TaskReview {
  id: string;
  taskId: string;
  jobId?: string | null;
  agentId?: string | null;
  modelName?: string | null;
  decision: "approve" | "changes_requested" | "block" | "info_only";
  summary?: string | null;
  findingsJson?: Record<string, unknown>[];
  testRecommendationsJson?: string[];
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  createdBy?: string | null;
}
