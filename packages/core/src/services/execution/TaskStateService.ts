import { WorkspaceRepository, TaskRow } from "@mcoda/db";

const mergeMetadata = (existing: Record<string, unknown> | undefined, patch?: Record<string, unknown> | null) => {
  if (patch === undefined) return existing;
  if (patch === null) return null;
  return { ...(existing ?? {}), ...patch };
};

export type TaskStatusEventContext = {
  commandName?: string | null;
  jobId?: string | null;
  taskRunId?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown> | null;
  timestamp?: string | null;
};

export class TaskStateService {
  constructor(private workspaceRepo: WorkspaceRepository) {}

  private async recordStatusEvent(
    task: TaskRow,
    fromStatus: string | undefined,
    toStatus: string,
    context?: TaskStatusEventContext,
  ): Promise<void> {
    if (fromStatus === toStatus) return;
    await this.workspaceRepo.recordTaskStatusEvent({
      taskId: task.id,
      fromStatus: fromStatus ?? null,
      toStatus,
      timestamp: context?.timestamp ?? new Date().toISOString(),
      commandName: context?.commandName ?? null,
      jobId: context?.jobId ?? null,
      taskRunId: context?.taskRunId ?? null,
      agentId: context?.agentId ?? null,
      metadata: context?.metadata ?? undefined,
    });
  }

  async transitionToInProgress(task: TaskRow, context?: TaskStatusEventContext): Promise<void> {
    if (task.status === "in_progress") return;
    const fromStatus = task.status;
    await this.workspaceRepo.updateTask(task.id, { status: "in_progress" });
    await this.recordStatusEvent(task, fromStatus, "in_progress", context);
    task.status = "in_progress";
  }

  async markReadyToReview(task: TaskRow, metadataPatch?: Record<string, unknown>, context?: TaskStatusEventContext): Promise<void> {
    const fromStatus = task.status;
    const mergedMetadata = mergeMetadata(task.metadata, metadataPatch ?? undefined);
    await this.workspaceRepo.updateTask(task.id, {
      status: "ready_to_review",
      metadata: mergedMetadata ?? undefined,
    });
    await this.recordStatusEvent(task, fromStatus, "ready_to_review", context);
    task.status = "ready_to_review";
    task.metadata = mergedMetadata ?? undefined;
  }

  async markReadyToQa(task: TaskRow, metadataPatch?: Record<string, unknown>, context?: TaskStatusEventContext): Promise<void> {
    const fromStatus = task.status;
    const mergedMetadata = mergeMetadata(task.metadata, metadataPatch ?? undefined);
    await this.workspaceRepo.updateTask(task.id, {
      status: "ready_to_qa",
      metadata: mergedMetadata ?? undefined,
    });
    await this.recordStatusEvent(task, fromStatus, "ready_to_qa", context);
    task.status = "ready_to_qa";
    task.metadata = mergedMetadata ?? undefined;
  }

  async markCompleted(task: TaskRow, metadataPatch?: Record<string, unknown>, context?: TaskStatusEventContext): Promise<void> {
    const fromStatus = task.status;
    const mergedMetadata = mergeMetadata(task.metadata, metadataPatch ?? undefined);
    await this.workspaceRepo.updateTask(task.id, {
      status: "completed",
      metadata: mergedMetadata ?? undefined,
    });
    await this.recordStatusEvent(task, fromStatus, "completed", context);
    task.status = "completed";
    task.metadata = mergedMetadata ?? undefined;
  }

  async returnToInProgress(task: TaskRow, metadataPatch?: Record<string, unknown>, context?: TaskStatusEventContext): Promise<void> {
    const fromStatus = task.status;
    const mergedMetadata = mergeMetadata(task.metadata, metadataPatch ?? undefined);
    await this.workspaceRepo.updateTask(task.id, {
      status: "in_progress",
      metadata: mergedMetadata ?? undefined,
    });
    await this.recordStatusEvent(task, fromStatus, "in_progress", context);
    task.status = "in_progress";
    task.metadata = mergedMetadata ?? undefined;
  }

  async markBlocked(task: TaskRow, reason: string, context?: TaskStatusEventContext): Promise<void> {
    const fromStatus = task.status;
    const metadata = mergeMetadata(task.metadata, { blocked_reason: reason }) ?? { blocked_reason: reason };
    await this.workspaceRepo.updateTask(task.id, {
      status: "blocked",
      metadata,
    });
    const eventMetadata =
      mergeMetadata(context?.metadata ?? undefined, { blocked_reason: reason }) ?? { blocked_reason: reason };
    const eventContext = context ? { ...context, metadata: eventMetadata } : { metadata: eventMetadata };
    await this.recordStatusEvent(task, fromStatus, "blocked", eventContext);
    task.status = "blocked";
    task.metadata = metadata;
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
