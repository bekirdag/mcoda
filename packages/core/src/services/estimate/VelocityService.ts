import fs from "node:fs/promises";
import path from "node:path";
import { Connection, type Database } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import type { EffectiveVelocity, VelocityConfig, VelocityOptions, VelocityScopeIds } from "./types.js";

const DEFAULT_SP_PER_HOUR = 15;
const DEFAULT_ALPHA = 0.5;

export class VelocityService {
  private constructor(
    private workspace: WorkspaceResolution,
    private db: Database,
    private connection: Connection,
    private globalVelocity?: VelocityConfig,
  ) {}

  static async create(workspace: WorkspaceResolution): Promise<VelocityService> {
    const dbPath = PathHelper.getWorkspaceDbPath(workspace.workspaceRoot);
    const connection = await Connection.open(dbPath);
    const globalVelocity = await VelocityService.readGlobalVelocityConfig();
    return new VelocityService(workspace, connection.db, connection, globalVelocity);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  private static async readGlobalVelocityConfig(): Promise<VelocityConfig | undefined> {
    const configPath = path.join(PathHelper.getGlobalMcodaDir(), "config.json");
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as { velocity?: Partial<VelocityConfig> };
      if (!parsed.velocity) return undefined;
      return {
        implementationSpPerHour: parsed.velocity.implementationSpPerHour ?? DEFAULT_SP_PER_HOUR,
        reviewSpPerHour: parsed.velocity.reviewSpPerHour ?? DEFAULT_SP_PER_HOUR,
        qaSpPerHour: parsed.velocity.qaSpPerHour ?? DEFAULT_SP_PER_HOUR,
        alpha: parsed.velocity.alpha ?? DEFAULT_ALPHA,
      };
    } catch {
      return undefined;
    }
  }

  private resolveConfig(options: VelocityOptions): VelocityConfig {
    const base: VelocityConfig = {
      implementationSpPerHour: DEFAULT_SP_PER_HOUR,
      reviewSpPerHour: DEFAULT_SP_PER_HOUR,
      qaSpPerHour: DEFAULT_SP_PER_HOUR,
      alpha: DEFAULT_ALPHA,
    };
    // Global config first
    if (this.globalVelocity) {
      base.implementationSpPerHour = this.globalVelocity.implementationSpPerHour ?? base.implementationSpPerHour;
      base.reviewSpPerHour = this.globalVelocity.reviewSpPerHour ?? base.reviewSpPerHour;
      base.qaSpPerHour = this.globalVelocity.qaSpPerHour ?? base.qaSpPerHour;
      base.alpha = this.globalVelocity.alpha ?? base.alpha;
    }
    // Workspace config overrides global
    if (this.workspace.config?.velocity) {
      base.implementationSpPerHour =
        this.workspace.config.velocity.implementationSpPerHour ?? base.implementationSpPerHour;
      base.reviewSpPerHour = this.workspace.config.velocity.reviewSpPerHour ?? base.reviewSpPerHour;
      base.qaSpPerHour = this.workspace.config.velocity.qaSpPerHour ?? base.qaSpPerHour;
      base.alpha = this.workspace.config.velocity.alpha ?? base.alpha;
    }
    if (options.spPerHourAll !== undefined) {
      base.implementationSpPerHour = options.spPerHourAll;
      base.reviewSpPerHour = options.spPerHourAll;
      base.qaSpPerHour = options.spPerHourAll;
    }
    if (options.spPerHourImplementation !== undefined) {
      base.implementationSpPerHour = options.spPerHourImplementation;
    }
    if (options.spPerHourReview !== undefined) {
      base.reviewSpPerHour = options.spPerHourReview;
    }
    if (options.spPerHourQa !== undefined) {
      base.qaSpPerHour = options.spPerHourQa;
    }
    return base;
  }

  private async resolveScopeIds(options: VelocityOptions): Promise<VelocityScopeIds> {
    const scope: VelocityScopeIds = {};
    if (options.projectKey) {
      const row = await this.db.get<{ id: string } | undefined>(`SELECT id FROM projects WHERE key = ?`, options.projectKey);
      if (!row) {
        throw new Error(`Unknown project key: ${options.projectKey}`);
      }
      scope.projectId = row.id;
    }
    if (options.epicKey) {
      const row = await this.db.get<{ id: string } | undefined>(
        `SELECT id FROM epics WHERE key = ? ${scope.projectId ? "AND project_id = ?" : ""}`,
        scope.projectId ? [options.epicKey, scope.projectId] : [options.epicKey],
      );
      if (!row) {
        throw new Error(`Unknown epic key: ${options.epicKey}`);
      }
      scope.epicId = row.id;
    }
    if (options.storyKey) {
      const row = await this.db.get<{ id: string } | undefined>(
        `SELECT id FROM user_stories WHERE key = ? ${scope.epicId ? "AND epic_id = ?" : ""}`,
        scope.epicId ? [options.storyKey, scope.epicId] : [options.storyKey],
      );
      if (!row) {
        throw new Error(`Unknown user story key: ${options.storyKey}`);
      }
      scope.storyId = row.id;
    }
    return scope;
  }

  private buildTaskFilters(scope: VelocityScopeIds, assignee?: string): { clause: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    if (scope.projectId) {
      clauses.push("t.project_id = ?");
      params.push(scope.projectId);
    }
    if (scope.epicId) {
      clauses.push("t.epic_id = ?");
      params.push(scope.epicId);
    }
    if (scope.storyId) {
      clauses.push("t.user_story_id = ?");
      params.push(scope.storyId);
    }
    if (assignee) {
      clauses.push("LOWER(t.assignee_human) = LOWER(?)");
      params.push(assignee);
    }
    if (clauses.length === 0) return { clause: "", params: [] };
    return { clause: `AND ${clauses.join(" AND ")}`, params };
  }

  private async computeLaneVelocity(
    commandName: string,
    scope: VelocityScopeIds,
    assignee: string | undefined,
    windowTasks: number,
  ): Promise<{ spPerHour?: number; samples: number }> {
    const runs = await this.db.all<
      { id: string; started_at?: string | null; completed_at?: string | null; duration_seconds?: number | null }[]
    >(
      `
      SELECT id, started_at, completed_at, duration_seconds
      FROM command_runs
      WHERE command_name = ?
        AND status IN ('success','succeeded')
      ORDER BY COALESCE(completed_at, started_at) DESC
    `,
      commandName,
    );

    let totalSp = 0;
    let totalDurationSeconds = 0;
    let samples = 0;
    const filters = this.buildTaskFilters(scope, assignee);

    for (const run of runs) {
      const aggregation = await this.db.get<{ sp: number | null; tasks: number }>(
        `
        SELECT
          SUM(COALESCE(t.story_points, 0)) as sp,
          COUNT(*) as tasks
        FROM task_runs tr
        INNER JOIN tasks t ON t.id = tr.task_id
        WHERE tr.command_run_id = ?
        ${filters.clause}
      `,
        run.id,
        ...filters.params,
      );

      const taskCount = aggregation?.tasks ?? 0;
      const sp = aggregation?.sp ?? 0;
      if (taskCount === 0) {
        continue;
      }
      const durationSeconds =
        typeof run.duration_seconds === "number" && Number.isFinite(run.duration_seconds)
          ? run.duration_seconds
          : this.deriveDurationSeconds(run.started_at, run.completed_at);
      if (!durationSeconds || durationSeconds <= 0) {
        continue;
      }
      totalSp += sp;
      totalDurationSeconds += durationSeconds;
      samples += taskCount;
      if (samples >= windowTasks) break;
    }

    if (samples === 0 || totalDurationSeconds <= 0 || totalSp <= 0) {
      return { samples: 0 };
    }

    return {
      spPerHour: totalSp / (totalDurationSeconds / 3600),
      samples,
    };
  }

  private deriveDurationSeconds(started?: string | null, completed?: string | null): number | undefined {
    if (!started || !completed) return undefined;
    const startMs = Date.parse(started);
    const endMs = Date.parse(completed);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return undefined;
    return (endMs - startMs) / 1000;
  }

  async getEffectiveVelocity(options: VelocityOptions = {}): Promise<EffectiveVelocity> {
    const mode = options.mode ?? "config";
    const windowTasks = options.windowTasks ?? 10;
    const config = this.resolveConfig(options);
    const defaultSamples = { implementation: 0, review: 0, qa: 0 };

    if (mode === "config") {
      return {
        implementationSpPerHour: config.implementationSpPerHour,
        reviewSpPerHour: config.reviewSpPerHour,
        qaSpPerHour: config.qaSpPerHour,
        source: "config",
        requestedMode: mode,
        windowTasks,
        samples: defaultSamples,
      };
    }

    const scope = await this.resolveScopeIds(options);
    const implementation = await this.computeLaneVelocity("work-on-tasks", scope, options.assignee, windowTasks);
    const review = await this.computeLaneVelocity("code-review", scope, options.assignee, windowTasks);
    const qa = await this.computeLaneVelocity("qa-tasks", scope, options.assignee, windowTasks);

    const alpha = config.alpha ?? DEFAULT_ALPHA;

    const resolveLane = (empirical?: number): number => {
      if (empirical === undefined || empirical <= 0) return config.implementationSpPerHour;
      if (mode === "empirical") return empirical;
      return alpha * empirical + (1 - alpha) * config.implementationSpPerHour;
    };
    const resolveReviewLane = (empirical?: number): number => {
      if (empirical === undefined || empirical <= 0) return config.reviewSpPerHour;
      if (mode === "empirical") return empirical;
      return alpha * empirical + (1 - alpha) * config.reviewSpPerHour;
    };
    const resolveQaLane = (empirical?: number): number => {
      if (empirical === undefined || empirical <= 0) return config.qaSpPerHour;
      if (mode === "empirical") return empirical;
      return alpha * empirical + (1 - alpha) * config.qaSpPerHour;
    };

    const implementationSpPerHour = resolveLane(implementation.spPerHour);
    const reviewSpPerHour = resolveReviewLane(review.spPerHour);
    const qaSpPerHour = resolveQaLane(qa.spPerHour);
    const samples = {
      implementation: implementation.samples,
      review: review.samples,
      qa: qa.samples,
    };

    const usedEmpirical =
      (implementation.spPerHour && implementation.spPerHour > 0) ||
      (review.spPerHour && review.spPerHour > 0) ||
      (qa.spPerHour && qa.spPerHour > 0);

    return {
      implementationSpPerHour,
      reviewSpPerHour,
      qaSpPerHour,
      source: usedEmpirical ? mode : "config",
      requestedMode: mode,
      windowTasks,
      samples,
    };
  }
}
