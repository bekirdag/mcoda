import type { ContextBundle, Plan, CriticResult, LaneScope } from "./Types.js";
import { ContextAssembler } from "./ContextAssembler.js";
import { ArchitectPlanner } from "./ArchitectPlanner.js";
import { BuilderRunner, type BuilderRunResult } from "./BuilderRunner.js";
import { CriticEvaluator } from "./CriticEvaluator.js";
import { MemoryWriteback } from "./MemoryWriteback.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import type { ContextManager } from "./ContextManager.js";
import { buildLaneId } from "./ContextManager.js";

export interface SmartPipelineOptions {
  contextAssembler: ContextAssembler;
  architectPlanner: ArchitectPlanner;
  builderRunner: BuilderRunner;
  criticEvaluator: CriticEvaluator;
  memoryWriteback: MemoryWriteback;
  maxRetries: number;
  maxContextRefreshes?: number;
  initialContext?: ContextBundle;
  fastPath?: (request: string) => boolean;
  getTouchedFiles?: () => string[];
  logger?: RunLogger;
  contextManager?: ContextManager;
  laneScope?: Omit<LaneScope, "role" | "ephemeral">;
}

export interface SmartPipelineResult {
  context: ContextBundle;
  plan: Plan;
  builderResult: BuilderRunResult;
  criticResult: CriticResult;
  attempts: number;
}

const buildFastPlan = (context: ContextBundle): Plan => {
  const targetFiles = context.snippets
    .map((snippet) => snippet.path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  return {
    steps: ["Implement the requested change."],
    target_files: targetFiles.length ? targetFiles : ["unknown"],
    risk_assessment: "low",
    verification: [],
  };
};

export class SmartPipeline {
  private options: SmartPipelineOptions;

  constructor(options: SmartPipelineOptions) {
    this.options = options;
  }

  async run(request: string): Promise<SmartPipelineResult> {
    const laneScope = this.options.laneScope ?? {};
    const architectLaneId = this.options.contextManager
      ? buildLaneId({ ...laneScope, role: "architect" })
      : undefined;
    const builderLaneId = this.options.contextManager
      ? buildLaneId({ ...laneScope, role: "builder" })
      : undefined;
    const criticLaneId = this.options.contextManager
      ? buildLaneId({ ...laneScope, role: "critic" })
      : undefined;
    const logLaneSummary = async (role: "architect" | "builder" | "critic", laneId?: string) => {
      if (!this.options.contextManager || !this.options.logger || !laneId) return;
      const lane = await this.options.contextManager.getLane({ ...laneScope, role });
      await this.options.logger.log("context_lane_summary", {
        role,
        laneId: lane.id,
        messageCount: lane.messages.length,
        tokenEstimate: lane.tokenEstimate,
      });
    };

    let context: ContextBundle;
    if (this.options.initialContext) {
      context = this.options.initialContext;
      if (this.options.logger) {
        await this.options.logger.log("phase_start", { phase: "librarian" });
        await this.options.logger.log("phase_end", { phase: "librarian", duration_ms: 0 });
      }
    } else {
      context = await this.runPhase("librarian", () => this.options.contextAssembler.assemble(request));
    }
    if (this.options.logger) {
      const files = context.files ?? [];
      const focusCount = files.filter((file) => file.role === "focus").length;
      const peripheryCount = files.filter((file) => file.role === "periphery").length;
      await this.options.logger.log("context_summary", {
        focusCount,
        peripheryCount,
        serializedMode: context.serialized?.mode ?? null,
        serializedBytes: context.serialized?.content.length ?? 0,
        warnings: context.warnings.length,
        redactionCount: context.redaction?.count ?? 0,
        ignoredFiles: context.redaction?.ignored ?? [],
      });
    }
    const useFastPath = this.options.fastPath?.(request) ?? false;
    let plan = useFastPath
      ? buildFastPlan(context)
      : await this.runPhase("architect", () =>
          this.options.architectPlanner.plan(context, {
            contextManager: this.options.contextManager,
            laneId: architectLaneId,
          }),
        );
    await logLaneSummary("architect", architectLaneId);

    let attempts = 0;
    let builderResult: BuilderRunResult | undefined;
    let criticResult: CriticResult | undefined;
    let refreshes = 0;
    const maxContextRefreshes = this.options.maxContextRefreshes ?? 0;

    while (attempts <= this.options.maxRetries) {
      attempts += 1;
      const touchedBefore = this.options.getTouchedFiles?.() ?? [];
      const built = await this.runPhase("builder", () =>
        this.options.builderRunner.run(plan, context, {
          contextManager: this.options.contextManager,
          laneId: builderLaneId,
        }),
      );
      builderResult = built;
      await logLaneSummary("builder", builderLaneId);
      if (built.contextRequest) {
        const contextRequest = built.contextRequest;
        if (refreshes < maxContextRefreshes) {
          refreshes += 1;
          attempts -= 1;
          if (this.options.logger) {
            await this.options.logger.log("context_refresh", {
              refresh: refreshes,
              queries: contextRequest.queries ?? [],
              files: contextRequest.files ?? [],
            });
          }
          context = await this.runPhase("librarian", () =>
            this.options.contextAssembler.assemble(request, {
              additionalQueries: contextRequest.queries,
              preferredFiles: contextRequest.files,
              recentFiles: contextRequest.files,
            }),
          );
          plan = useFastPath
            ? buildFastPlan(context)
            : await this.runPhase("architect", () =>
                this.options.architectPlanner.plan(context, {
                  contextManager: this.options.contextManager,
                  laneId: architectLaneId,
                }),
              );
          continue;
        }
        criticResult = {
          status: "FAIL",
          reasons: ["context request limit reached"],
          retryable: false,
        };
        break;
      }
      if (built.usage) {
        await this.options.logger?.log("phase_usage", { phase: "builder", usage: built.usage });
      }
      const touchedAfter = this.options.getTouchedFiles?.() ?? touchedBefore;
      const touchedBeforeSet = new Set(touchedBefore);
      const touchedDelta = touchedAfter.filter((file) => !touchedBeforeSet.has(file));
      const touchedFiles = touchedDelta.length ? touchedDelta : undefined;
      criticResult = await this.runPhase("critic", () =>
        this.options.criticEvaluator.evaluate(plan, built.finalMessage.content, touchedFiles, {
          contextManager: this.options.contextManager,
          laneId: criticLaneId,
        }),
      );
      await logLaneSummary("critic", criticLaneId);
      if (criticResult.status === "PASS") break;
      if (!criticResult.retryable) break;
    }

    if (!builderResult || !criticResult) {
      throw new Error("SmartPipeline failed to produce results");
    }

    const preferences = context.preferences_detected ?? [];
    if (criticResult.status === "FAIL") {
      await this.options.memoryWriteback.persist({
        failures: attempts,
        maxRetries: this.options.maxRetries,
        lesson: criticResult.reasons.join("; "),
        preferences: preferences.length ? preferences : undefined,
      });
    } else if (preferences.length) {
      await this.options.memoryWriteback.persist({
        failures: 0,
        maxRetries: this.options.maxRetries,
        lesson: "",
        preferences,
      });
    }

    return { context, plan, builderResult, criticResult, attempts };
  }

  private async runPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    if (this.options.logger) {
      await this.options.logger.log("phase_start", { phase });
    }
    try {
      const result = await fn();
      if (this.options.logger) {
        await this.options.logger.log("phase_end", { phase, duration_ms: Date.now() - startedAt });
      }
      return result;
    } catch (error) {
      if (this.options.logger) {
        await this.options.logger.log("phase_end", {
          phase,
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }
}
