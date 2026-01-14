import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

  private async insertStatusEvent(entry: {
    taskId: string;
    fromStatus?: string | null;
    toStatus: string;
    timestamp: string;
    commandName?: string | null;
    jobId?: string | null;
    taskRunId?: string | null;
    agentId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, timestamp, command_name, job_id, task_run_id, agent_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      entry.taskId,
      entry.fromStatus ?? null,
      entry.toStatus,
      entry.timestamp,
      entry.commandName ?? null,
      entry.jobId ?? null,
      entry.taskRunId ?? null,
      entry.agentId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }

  private async maybeBackfillStatusEvents(
    commandName: string,
    transition: { startStatus: string; endStatus: string },
    scope: VelocityScopeIds,
    assignee: string | undefined,
    windowTasks: number,
  ): Promise<void> {
    const { startStatus, endStatus } = transition;
    try {
      const filters = this.buildTaskFilters(scope, assignee);
      const existingRow = await this.db.get<{ count: number } | undefined>(
        `
        SELECT COUNT(1) as count
        FROM task_status_events e
        INNER JOIN tasks t ON t.id = e.task_id
        WHERE e.from_status = ?
          AND e.to_status = ?
          ${filters.clause}
      `,
        startStatus,
        endStatus,
        ...filters.params,
      );
      const existingCount = existingRow?.count ?? 0;
      if (existingCount >= windowTasks) return;

      const limit = Math.max(windowTasks * 3, windowTasks);
      const runs = await this.db.all<
        {
          id: string;
          task_id: string;
          job_id: string | null;
          agent_id: string | null;
          started_at: string | null;
          finished_at: string | null;
        }[]
      >(
        `
        SELECT tr.id, tr.task_id, tr.job_id, tr.agent_id, tr.started_at, tr.finished_at
        FROM task_runs tr
        INNER JOIN tasks t ON t.id = tr.task_id
        WHERE tr.command = ?
          AND tr.status IN ('success','succeeded')
          AND tr.started_at IS NOT NULL
          AND tr.finished_at IS NOT NULL
          ${filters.clause}
        ORDER BY datetime(tr.finished_at) DESC
        LIMIT ?
      `,
        commandName,
        ...filters.params,
        limit,
      );

      let inserted = 0;
      for (const run of runs) {
        if (existingCount + inserted >= windowTasks) break;
        const startedAt = run.started_at;
        const finishedAt = run.finished_at;
        if (!startedAt || !finishedAt) continue;

        const startExists = await this.db.get<{ id: string } | undefined>(
          `SELECT id FROM task_status_events WHERE task_id = ? AND to_status = ? AND timestamp = ? LIMIT 1`,
          run.task_id,
          startStatus,
          startedAt,
        );
        if (!startExists) {
          await this.insertStatusEvent({
            taskId: run.task_id,
            fromStatus: null,
            toStatus: startStatus,
            timestamp: startedAt,
            commandName,
            jobId: run.job_id ?? null,
            taskRunId: run.id,
            agentId: run.agent_id ?? null,
            metadata: {
              backfilled: true,
              source: "task_runs",
              phase: "start",
              transition: `${startStatus}->${endStatus}`,
            },
          });
        }

        const endExists = await this.db.get<{ id: string } | undefined>(
          `SELECT id FROM task_status_events WHERE task_id = ? AND from_status = ? AND to_status = ? AND timestamp = ? LIMIT 1`,
          run.task_id,
          startStatus,
          endStatus,
          finishedAt,
        );
        if (!endExists) {
          await this.insertStatusEvent({
            taskId: run.task_id,
            fromStatus: startStatus,
            toStatus: endStatus,
            timestamp: finishedAt,
            commandName,
            jobId: run.job_id ?? null,
            taskRunId: run.id,
            agentId: run.agent_id ?? null,
            metadata: {
              backfilled: true,
              source: "task_runs",
              phase: "end",
              transition: `${startStatus}->${endStatus}`,
            },
          });
          inserted += 1;
        }
      }
    } catch {
      // ignore backfill errors
    }
  }

  private async computeLaneVelocityFromTaskRuns(
    commandName: string,
    scope: VelocityScopeIds,
    assignee: string | undefined,
    windowTasks: number,
  ): Promise<{ spPerHour?: number; samples: number }> {
    const filters = this.buildTaskFilters(scope, assignee);
    const runs = await this.db.all<
      { story_points: number | null; started_at?: string | null; finished_at?: string | null }[]
    >(
      `
      SELECT
        COALESCE(tr.story_points_at_run, t.story_points, 0) as story_points,
        tr.started_at,
        tr.finished_at
      FROM task_runs tr
      INNER JOIN tasks t ON t.id = tr.task_id
      WHERE tr.command = ?
        AND tr.status IN ('success','succeeded')
        ${filters.clause}
      ORDER BY COALESCE(tr.finished_at, tr.started_at) DESC
    `,
      commandName,
      ...filters.params,
    );

    let totalSp = 0;
    let totalDurationSeconds = 0;
    let samples = 0;

    for (const run of runs) {
      if (samples >= windowTasks) break;
      const durationSeconds = this.deriveDurationSeconds(run.started_at, run.finished_at);
      if (!durationSeconds || durationSeconds <= 0) {
        continue;
      }
      totalSp += run.story_points ?? 0;
      totalDurationSeconds += durationSeconds;
      samples += 1;
    }

    if (samples === 0 || totalDurationSeconds <= 0 || totalSp <= 0) {
      return { samples: 0 };
    }

    return {
      spPerHour: totalSp / (totalDurationSeconds / 3600),
      samples,
    };
  }

  private async computeLaneVelocityFromStatusEvents(
    startStatus: string,
    endStatus: string,
    scope: VelocityScopeIds,
    assignee: string | undefined,
    windowTasks: number,
  ): Promise<{ spPerHour?: number; samples: number }> {
    const filters = this.buildTaskFilters(scope, assignee);
    let rows: { task_id: string; story_points?: number | null; start_ts?: string | null; end_ts?: string | null }[] = [];
    try {
      rows = await this.db.all<
        { task_id: string; story_points?: number | null; start_ts?: string | null; end_ts?: string | null }[]
      >(
        `
        SELECT
          t.id as task_id,
          t.story_points as story_points,
          end_event.timestamp as end_ts,
          (
            SELECT e2.timestamp
            FROM task_status_events e2
            WHERE e2.task_id = end_event.task_id
              AND e2.to_status = ?
              AND datetime(e2.timestamp) <= datetime(end_event.timestamp)
            ORDER BY datetime(e2.timestamp) DESC
            LIMIT 1
          ) as start_ts
        FROM task_status_events end_event
        INNER JOIN tasks t ON t.id = end_event.task_id
        WHERE end_event.from_status = ?
          AND end_event.to_status = ?
          ${filters.clause}
        ORDER BY datetime(end_event.timestamp) DESC
      `,
        startStatus,
        startStatus,
        endStatus,
        ...filters.params,
      );
    } catch {
      return { samples: 0 };
    }

    let totalSp = 0;
    let totalDurationSeconds = 0;
    let samples = 0;

    for (const row of rows) {
      if (samples >= windowTasks) break;
      const durationSeconds = this.deriveDurationSeconds(row.start_ts ?? undefined, row.end_ts ?? undefined);
      if (!durationSeconds || durationSeconds <= 0) {
        continue;
      }
      totalSp += row.story_points ?? 0;
      totalDurationSeconds += durationSeconds;
      samples += 1;
    }

    if (samples === 0 || totalDurationSeconds <= 0 || totalSp <= 0) {
      return { samples: 0 };
    }

    return {
      spPerHour: totalSp / (totalDurationSeconds / 3600),
      samples,
    };
  }

  private async computeLaneVelocity(
    commandName: string,
    transition: { startStatus: string; endStatus: string },
    scope: VelocityScopeIds,
    assignee: string | undefined,
    windowTasks: number,
  ): Promise<{ spPerHour?: number; samples: number }> {
    await this.maybeBackfillStatusEvents(commandName, transition, scope, assignee, windowTasks);
    const statusSamples = await this.computeLaneVelocityFromStatusEvents(
      transition.startStatus,
      transition.endStatus,
      scope,
      assignee,
      windowTasks,
    );
    if (statusSamples.samples > 0) {
      return statusSamples;
    }
    return this.computeLaneVelocityFromTaskRuns(commandName, scope, assignee, windowTasks);
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
    const implementation = await this.computeLaneVelocity(
      "work-on-tasks",
      { startStatus: "in_progress", endStatus: "ready_to_review" },
      scope,
      options.assignee,
      windowTasks,
    );
    const review = await this.computeLaneVelocity(
      "code-review",
      { startStatus: "ready_to_review", endStatus: "ready_to_qa" },
      scope,
      options.assignee,
      windowTasks,
    );
    const qa = await this.computeLaneVelocity(
      "qa-tasks",
      { startStatus: "ready_to_qa", endStatus: "completed" },
      scope,
      options.assignee,
      windowTasks,
    );

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
