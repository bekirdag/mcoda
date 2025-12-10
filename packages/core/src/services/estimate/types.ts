import type {
  BacklogTotals,
  EffectiveVelocity,
  EstimateResult,
  EstimateDurations,
  EstimateEtas,
  VelocitySource,
} from "@mcoda/shared";
import type { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

export interface VelocityConfig {
  implementationSpPerHour: number;
  reviewSpPerHour: number;
  qaSpPerHour: number;
  alpha?: number;
}

export interface VelocityOptions {
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  assignee?: string;
  mode?: VelocitySource;
  windowTasks?: 10 | 20 | 50;
  spPerHourAll?: number;
  spPerHourReview?: number;
  spPerHourQa?: number;
}

export interface VelocityScopeIds {
  projectId?: string;
  epicId?: string;
  storyId?: string;
}

export interface EstimateOptions extends VelocityOptions {
  workspace: WorkspaceResolution;
}

export type { EstimateDurations, EstimateEtas };
export type { EffectiveVelocity, EstimateResult, VelocitySource };
