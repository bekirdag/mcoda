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

  async markBlocked(task: TaskRow, reason: string): Promise<void> {
    const metadata = mergeMetadata(task.metadata, { blocked_reason: reason }) ?? { blocked_reason: reason };
    await this.workspaceRepo.updateTask(task.id, {
      status: "blocked",
      metadata,
    });
  }
}
