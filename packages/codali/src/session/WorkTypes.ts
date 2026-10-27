import type { ProjectTaskAttachment } from "@mcoda/shared";

export type WorkTaskStatus = "planned" | "ready" | "running" | "review_pending" | "verified" | "blocked" | "cancelled" | "superseded";

export interface Requirement {
  id: string;
  description: string;
  required: boolean;
}

export interface WorkTask {
  id: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  allowedPaths: string[];
  status: WorkTaskStatus;
  evidenceIds: string[];
  attemptId?: string;
  goalRevision?: number;
  leaseExpiresAt?: string;
  blocker?: string;
  phaseId?: string;
  planRevision?: number;
}

export interface WorkPhase {
  id: string;
  title: string;
  dependsOn: string[];
  exitRequirementIds: string[];
}

export interface PlanRevision {
  revision: number;
  goalRevision: number;
  at: string;
  reason: string;
  tasks: WorkTask[];
  phases: WorkPhase[];
}

export interface DecisionRecord {
  id: string;
  title: string;
  rationale: string;
  alternatives: string[];
  paths: string[];
  supersedes?: string;
}

export interface EvidenceReceipt {
  id: string;
  taskId: string;
  criterionIds: string[];
  kind: "tool" | "review" | "human";
  ok: boolean;
  summary: string;
  invocationId?: string;
  inputHashes: Record<string, string>;
  at: string;
  /** A fresh whole-goal assessment, with prior task proofs retained for audit. */
  integrationReview?: {
    id: string;
    goalRevision: number;
    planRevision: number;
    criterionIds: string[];
    priorEvidenceIds: string[];
  };
}

export interface WorkCheckpoint {
  id: string;
  at: string;
  goalRevision: number;
  note: string;
  activeTaskId?: string;
  uncertainInvocationIds: string[];
}

export interface GoalAmendment {
  revision: number;
  at: string;
  reason: string;
  previousObjective: string;
}

export interface WorkState {
  projectTask?: ProjectTaskAttachment;
  schemaVersion: 1;
  revision: number;
  goalRevision: number;
  goalId: string;
  originalObjective: string;
  objective: string;
  requirements: Requirement[];
  constraints: string[];
  nonGoals: string[];
  tasks: WorkTask[];
  /** Optional on older v1 records; absence means the initial flat plan. */
  phases?: WorkPhase[];
  planRevision?: number;
  planHistory?: PlanRevision[];
  decisions: DecisionRecord[];
  evidence: EvidenceReceipt[];
  checkpoints: WorkCheckpoint[];
  amendments: GoalAmendment[];
  createdAt: string;
  updatedAt: string;
  status: "active" | "blocked" | "cancelled" | "completed";
}
