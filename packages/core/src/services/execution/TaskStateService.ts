import { WorkspaceRepository, TaskRow } from "@mcoda/db";
import { READY_TO_CODE_REVIEW } from "@mcoda/shared";

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

  async markNotStarted(
    task: TaskRow,
    metadataPatch?: Record<string, unknown>,
    context?: TaskStatusEventContext,
  ): Promise<void> {
    const fromStatus = task.status;
    const mergedMetadata = mergeMetadata(task.metadata, metadataPatch ?? undefined);
    await this.workspaceRepo.updateTask(task.id, {
      status: "not_started",
      metadata: mergedMetadata ?? undefined,
    });
    await this.recordStatusEvent(task, fromStatus, "not_started", context);
    task.status = "not_started";
    task.metadata = mergedMetadata ?? undefined;
  }

  async markReadyToReview(
    task: TaskRow,
    metadataPatch?: Record<string, unknown>,
    context?: TaskStatusEventContext,
  ): Promise<void> {
    const fromStatus = task.status;
    const mergedMetadata = mergeMetadata(task.metadata, metadataPatch ?? undefined);
    await this.workspaceRepo.updateTask(task.id, {
      status: READY_TO_CODE_REVIEW,
      metadata: mergedMetadata ?? undefined,
    });
    await this.recordStatusEvent(task, fromStatus, READY_TO_CODE_REVIEW, context);
    task.status = READY_TO_CODE_REVIEW;
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
    const mergedMetadata = mergeMetadata(task.metadata, {
      ...(metadataPatch ?? {}),
      last_completed_at: new Date().toISOString(),
      ...(metadataPatch?.revert_event_pending === undefined ? { revert_event_pending: false } : {}),
    });
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

  async markChangesRequested(task: TaskRow, metadataPatch?: Record<string, unknown>, context?: TaskStatusEventContext): Promise<void> {
    const fromStatus = task.status;
    const isRevert = fromStatus === "completed";
    const baseMetadata = (task.metadata as Record<string, unknown> | undefined) ?? {};
    const currentRevertCount =
      typeof baseMetadata.revert_event_count === "number" && Number.isFinite(baseMetadata.revert_event_count)
        ? baseMetadata.revert_event_count
        : 0;
    const reasonFromPatch = typeof metadataPatch?.revert_reason === "string" ? metadataPatch.revert_reason : undefined;
    const reasonFromContext =
      typeof context?.metadata?.revert_reason === "string"
        ? String(context.metadata.revert_reason)
        : typeof context?.metadata?.reason === "string"
          ? String(context.metadata.reason)
          : undefined;
    const revertReason = reasonFromPatch ?? reasonFromContext;
    const revertEvent =
      isRevert
        ? {
            from_status: fromStatus,
            to_status: "changes_requested",
            timestamp: context?.timestamp ?? new Date().toISOString(),
            reason: revertReason ?? "changes requested after completion",
          }
        : undefined;
    const mergedMetadata = mergeMetadata(task.metadata, {
      ...(metadataPatch ?? {}),
      ...(isRevert
        ? {
            revert_event_pending: true,
            revert_event_count: currentRevertCount + 1,
            last_revert_event: revertEvent,
          }
        : {}),
    });
    await this.workspaceRepo.updateTask(task.id, {
      status: "changes_requested",
      metadata: mergedMetadata ?? undefined,
    });
    const eventContext =
      isRevert
        ? {
            ...(context ?? {}),
            metadata: mergeMetadata(context?.metadata ?? undefined, {
              revert_event: true,
              revert_reason: revertReason ?? "changes requested after completion",
            }),
          }
        : context;
    await this.recordStatusEvent(task, fromStatus, "changes_requested", eventContext);
    task.status = "changes_requested";
    task.metadata = mergedMetadata ?? undefined;
  }

  async markFailed(task: TaskRow, reason: string, context?: TaskStatusEventContext): Promise<void> {
    const fromStatus = task.status;
    const metadata = mergeMetadata(task.metadata as Record<string, unknown> | undefined, { failed_reason: reason }) ?? {
      failed_reason: reason,
    };
    await this.workspaceRepo.updateTask(task.id, {
      status: "failed",
      metadata,
    });
    const eventMetadata =
      mergeMetadata(context?.metadata ?? undefined, { failed_reason: reason }) ?? { failed_reason: reason };
    const eventContext = context ? { ...context, metadata: eventMetadata } : { metadata: eventMetadata };
    await this.recordStatusEvent(task, fromStatus, "failed", eventContext);
    task.status = "failed";
    task.metadata = metadata;
  }

  async recordReviewMetadata(
    task: TaskRow,
    metadata: {
      decision: string;
      agentId?: string | null;
      modelName?: string | null;
      jobId?: string | null;
      reviewId?: string | null;
      diffEmpty?: boolean;
      changedPaths?: string[];
    },
  ) {
    const patch = mergeMetadata(task.metadata, {
      last_review_decision: metadata.decision,
      last_review_agent_id: metadata.agentId ?? null,
      last_review_model: metadata.modelName ?? null,
      last_review_job_id: metadata.jobId ?? null,
      last_review_id: metadata.reviewId ?? null,
      last_reviewed_at: new Date().toISOString(),
      ...(metadata.diffEmpty !== undefined ? { last_review_diff_empty: metadata.diffEmpty } : {}),
      ...(Array.isArray(metadata.changedPaths) && metadata.changedPaths.length
        ? { last_review_changed_paths: metadata.changedPaths }
        : {}),
    });
    await this.workspaceRepo.updateTask(task.id, { metadata: patch ?? undefined });
  }
}
