import { Connection } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { BacklogService } from "../backlog/BacklogService.js";
import type { BacklogTotals } from "../backlog/BacklogService.js";
import { VelocityService } from "./VelocityService.js";
import type { EstimateDurations, EstimateEtas, EstimateOptions, EstimateResult } from "./types.js";
import type { EffectiveVelocity } from "./types.js";
import type { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

const HOURS_IN_MS = 3600 * 1000;

export class EstimateService {
  private constructor(private workspace: WorkspaceResolution) {}

  static async create(workspace: WorkspaceResolution): Promise<EstimateService> {
    return new EstimateService(workspace);
  }

  private safeDivide(sp: number, spPerHour: number): number | null {
    if (!sp || sp <= 0) return 0;
    if (!spPerHour || spPerHour <= 0) return null;
    return sp / spPerHour;
  }

  private async computeElapsedLaneHours(taskIds: string[], status: string): Promise<number> {
    if (taskIds.length === 0) return 0;
    const dbPath = PathHelper.getWorkspaceDbPath(this.workspace.workspaceRoot);
    let connection: Connection | undefined;
    try {
      connection = await Connection.open(dbPath);
      const placeholders = taskIds.map(() => "?").join(", ");
      const rows = await connection.db.all<{ task_id: string; started_at: string | null }[]>(
        `SELECT task_id, MAX(timestamp) as started_at
         FROM task_status_events
         WHERE to_status = ?
           AND task_id IN (${placeholders})
         GROUP BY task_id`,
        status,
        ...taskIds,
      );
      const now = Date.now();
      let totalMs = 0;
      for (const row of rows) {
        if (!row.started_at) continue;
        const startMs = Date.parse(row.started_at);
        if (!Number.isNaN(startMs) && startMs <= now) {
          totalMs += now - startMs;
        }
      }
      return totalMs / HOURS_IN_MS;
    } catch {
      return 0;
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  private computeDurations(
    totals: BacklogTotals,
    velocity: EffectiveVelocity,
    elapsedImplementationHours: number,
  ): EstimateDurations {
    const implementationRaw = this.safeDivide(totals.implementation.story_points, velocity.implementationSpPerHour);
    const implementationHours =
      implementationRaw === null ? null : Math.max((implementationRaw ?? 0) - elapsedImplementationHours, 0);
    const reviewHours = this.safeDivide(totals.review.story_points, velocity.reviewSpPerHour);
    const qaHours = this.safeDivide(totals.qa.story_points, velocity.qaSpPerHour);
    const reviewPipelineHours = this.safeDivide(
      totals.implementation.story_points + totals.review.story_points,
      velocity.reviewSpPerHour,
    );
    const qaPipelineHours = this.safeDivide(
      totals.implementation.story_points + totals.review.story_points + totals.qa.story_points,
      velocity.qaSpPerHour,
    );
    const durationsList = [implementationHours, reviewPipelineHours, qaPipelineHours];
    const hasNull = durationsList.some((value) => value === null);
    const numeric = durationsList.filter((value) => value !== null) as number[];
    const totalHours = hasNull || numeric.length === 0 ? null : Math.max(...numeric);
    return {
      implementationHours,
      reviewHours,
      qaHours,
      totalHours,
    };
  }

  private computeEtas(totals: BacklogTotals, velocity: EffectiveVelocity, durations: EstimateDurations): EstimateEtas {
    const now = Date.now();
    const addHours = (hours: number | null | undefined): string | undefined => {
      if (hours === null || hours === undefined || hours < 0) return undefined;
      return new Date(now + hours * HOURS_IN_MS).toISOString();
    };
    const reviewPipelineHours = this.safeDivide(
      totals.implementation.story_points + totals.review.story_points,
      velocity.reviewSpPerHour,
    );
    const qaPipelineHours = this.safeDivide(
      totals.implementation.story_points + totals.review.story_points + totals.qa.story_points,
      velocity.qaSpPerHour,
    );
    const readyToReviewEta =
      durations.implementationHours !== null ? addHours(durations.implementationHours ?? undefined) : undefined;
    const readyToQaEta =
      durations.implementationHours !== null && reviewPipelineHours !== null
        ? addHours(Math.max(durations.implementationHours ?? 0, reviewPipelineHours ?? 0))
        : undefined;
    const completeEta =
      durations.implementationHours !== null && reviewPipelineHours !== null && qaPipelineHours !== null
        ? addHours(Math.max(durations.implementationHours ?? 0, reviewPipelineHours ?? 0, qaPipelineHours ?? 0))
        : undefined;
    return {
      readyToReviewEta,
      readyToQaEta,
      completeEta,
    };
  }

  private buildStatusCounts(backlogTasks: { task_id: string; status: string }[]): EstimateResult["statusCounts"] {
    const counts = {
      total: backlogTasks.length,
      readyToCodeReview: 0,
      failed: 0,
      inProgress: 0,
      readyToQa: 0,
      completed: 0,
    };
    for (const task of backlogTasks) {
      const status = task.status.trim().toLowerCase();
      if (status === "ready_to_code_review") counts.readyToCodeReview += 1;
      if (status === "failed") counts.failed += 1;
      if (status === "in_progress") counts.inProgress += 1;
      if (status === "ready_to_qa") counts.readyToQa += 1;
      if (status === "completed") counts.completed += 1;
    }
    return counts;
  }

  private buildCompletion(statusCounts: EstimateResult["statusCounts"]): EstimateResult["completion"] {
    const ratio = (done: number, total: number): number => {
      if (!total || total <= 0) return 0;
      return Math.max(0, Math.min(100, (done / total) * 100));
    };
    const workDone = statusCounts.readyToCodeReview + statusCounts.readyToQa + statusCounts.completed;
    const qaDone = statusCounts.readyToQa + statusCounts.completed;
    return {
      workOnTasks: {
        done: workDone,
        total: statusCounts.total,
        percent: ratio(workDone, statusCounts.total),
      },
      readyToQa: {
        done: qaDone,
        total: statusCounts.total,
        percent: ratio(qaDone, statusCounts.total),
      },
      done: {
        done: statusCounts.completed,
        total: statusCounts.total,
        percent: ratio(statusCounts.completed, statusCounts.total),
      },
    };
  }

  async estimate(options: Omit<EstimateOptions, "workspace">): Promise<EstimateResult> {
    const backlogService = await BacklogService.create(this.workspace);
    let backlogTotals: BacklogTotals;
    let backlogTasks: { task_id: string; status: string }[] = [];
    try {
      const { summary } = await backlogService.getBacklog({
        projectKey: options.projectKey,
        epicKey: options.epicKey,
        storyKey: options.storyKey,
        assignee: options.assignee,
      });
      backlogTotals = summary.totals;
      backlogTasks = summary.tasks.map((task) => ({ task_id: task.task_id, status: task.status }));
    } finally {
      await backlogService.close();
    }

    const velocityService = await VelocityService.create(this.workspace);
    let effectiveVelocity: EffectiveVelocity;
    try {
      effectiveVelocity = await velocityService.getEffectiveVelocity({
        projectKey: options.projectKey,
        epicKey: options.epicKey,
        storyKey: options.storyKey,
        assignee: options.assignee,
        mode: options.mode,
        windowTasks: options.windowTasks,
        spPerHourAll: options.spPerHourAll,
        spPerHourImplementation: options.spPerHourImplementation,
        spPerHourReview: options.spPerHourReview,
        spPerHourQa: options.spPerHourQa,
      });
    } finally {
      await velocityService.close();
    }

    const inProgressTaskIds = backlogTasks.filter((task) => task.status === "in_progress").map((task) => task.task_id);
    const elapsedImplementationHours = await this.computeElapsedLaneHours(inProgressTaskIds, "in_progress");
    const durationsHours = this.computeDurations(backlogTotals, effectiveVelocity, elapsedImplementationHours);
    const etas = this.computeEtas(backlogTotals, effectiveVelocity, durationsHours);
    const statusCounts = this.buildStatusCounts(backlogTasks);
    const completion = this.buildCompletion(statusCounts);

    return {
      scope: {
        workspaceId: this.workspace.workspaceId,
        project: options.projectKey,
        epic: options.epicKey,
        story: options.storyKey,
        assignee: options.assignee,
      },
      backlogTotals,
      effectiveVelocity,
      durationsHours,
      etas,
      statusCounts,
      completion,
    };
  }

  async close(): Promise<void> {
    // No long-lived resources to release yet, placeholder for symmetry with other services.
  }
}
