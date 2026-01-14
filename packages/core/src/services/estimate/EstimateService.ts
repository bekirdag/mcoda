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

  private computeDurations(totals: BacklogTotals, velocity: EffectiveVelocity): EstimateDurations {
    const safeDivide = (sp: number, spPerHour: number): number | null => {
      if (!sp || sp <= 0) return 0;
      if (!spPerHour || spPerHour <= 0) return null;
      return sp / spPerHour;
    };
    const implementationHours = safeDivide(totals.implementation.story_points, velocity.implementationSpPerHour);
    const reviewHours = safeDivide(totals.review.story_points, velocity.reviewSpPerHour);
    const qaHours = safeDivide(totals.qa.story_points, velocity.qaSpPerHour);
    const durationsList = [implementationHours, reviewHours, qaHours];
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

  private computeEtas(durations: EstimateDurations): EstimateEtas {
    const now = Date.now();
    const addHours = (hours: number | null | undefined): string | undefined => {
      if (hours === null || hours === undefined || hours < 0) return undefined;
      return new Date(now + hours * HOURS_IN_MS).toISOString();
    };
    const readyToReviewEta = durations.implementationHours !== null ? addHours(durations.implementationHours ?? undefined) : undefined;
    const readyToQaEta =
      durations.implementationHours !== null && durations.reviewHours !== null
        ? addHours(Math.max(durations.implementationHours ?? 0, durations.reviewHours ?? 0))
        : undefined;
    const completeEta = durations.totalHours !== null ? addHours(durations.totalHours ?? undefined) : undefined;
    return {
      readyToReviewEta,
      readyToQaEta,
      completeEta,
    };
  }

  async estimate(options: Omit<EstimateOptions, "workspace">): Promise<EstimateResult> {
    const backlogService = await BacklogService.create(this.workspace);
    let backlogTotals: BacklogTotals;
    try {
      const { summary } = await backlogService.getBacklog({
        projectKey: options.projectKey,
        epicKey: options.epicKey,
        storyKey: options.storyKey,
        assignee: options.assignee,
      });
      backlogTotals = summary.totals;
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

    const durationsHours = this.computeDurations(backlogTotals, effectiveVelocity);
    const etas = this.computeEtas(durationsHours);

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
    };
  }

  async close(): Promise<void> {
    // No long-lived resources to release yet, placeholder for symmetry with other services.
  }
}
