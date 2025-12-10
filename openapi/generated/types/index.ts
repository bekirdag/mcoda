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
