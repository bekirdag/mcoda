import { WorkspaceRepository, TaskRow } from "@mcoda/db";

const mergeMetadata = (existing: Record<string, unknown> | undefined, patch?: Record<string, unknown> | null) => {
  if (patch === undefined) return existing;
  if (patch === null) return null;
  return { ...(existing ?? {}), ...patch };
};

export class TaskStateService {
  constructor(private workspaceRepo: WorkspaceRepository) {}

  async transitionToInProgress(task: TaskRow): Promise<void> {
    if (task.status === "in_progress") return;
    await this.workspaceRepo.updateTask(task.id, { status: "in_progress" });
  }

  async markReadyToReview(task: TaskRow, metadataPatch?: Record<string, unknown>): Promise<void> {
    await this.workspaceRepo.updateTask(task.id, {
      status: "ready_to_review",
      metadata: mergeMetadata(task.metadata, metadataPatch ?? undefined) ?? undefined,
    });
  }

  async markReadyToQa(task: TaskRow, metadataPatch?: Record<string, unknown>): Promise<void> {
    await this.workspaceRepo.updateTask(task.id, {
      status: "ready_to_qa",
      metadata: mergeMetadata(task.metadata, metadataPatch ?? undefined) ?? undefined,
    });
  }

  async markCompleted(task: TaskRow, metadataPatch?: Record<string, unknown>): Promise<void> {
    await this.workspaceRepo.updateTask(task.id, {
      status: "completed",
      metadata: mergeMetadata(task.metadata, metadataPatch ?? undefined) ?? undefined,
    });
  }

  async returnToInProgress(task: TaskRow, metadataPatch?: Record<string, unknown>): Promise<void> {
    await this.workspaceRepo.updateTask(task.id, {
      status: "in_progress",
      metadata: mergeMetadata(task.metadata, metadataPatch ?? undefined) ?? undefined,
    });
  }

  async markBlocked(task: TaskRow, reason: string): Promise<void> {
    const metadata = mergeMetadata(task.metadata, { blocked_reason: reason }) ?? { blocked_reason: reason };
    await this.workspaceRepo.updateTask(task.id, {
      status: "blocked",
      metadata,
    });
  }

  async recordReviewMetadata(task: TaskRow, metadata: { decision: string; agentId?: string | null; modelName?: string | null; jobId?: string | null; reviewId?: string | null }) {
    const patch = mergeMetadata(task.metadata, {
      last_review_decision: metadata.decision,
      last_review_agent_id: metadata.agentId ?? null,
      last_review_model: metadata.modelName ?? null,
      last_review_job_id: metadata.jobId ?? null,
      last_review_id: metadata.reviewId ?? null,
      last_reviewed_at: new Date().toISOString(),
    });
    await this.workspaceRepo.updateTask(task.id, { metadata: patch ?? undefined });
  }
}
