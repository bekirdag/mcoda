import type { AgentEvent, AgentStatusPhase } from "../providers/ProviderTypes.js";
import type { ContextBundle, Plan, CriticResult, LaneScope } from "./Types.js";
import { ContextAssembler } from "./ContextAssembler.js";
import { ArchitectPlanner, type ArchitectPlanResult } from "./ArchitectPlanner.js";
import {
  BuilderRunner,
  type BuilderRunResult,
  PatchApplyError,
  type PatchApplyFailure,
} from "./BuilderRunner.js";
import { CriticEvaluator } from "./CriticEvaluator.js";
import { MemoryWriteback } from "./MemoryWriteback.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import type { ContextManager } from "./ContextManager.js";
import { buildLaneId } from "./ContextManager.js";
import { serializeContext } from "./ContextSerializer.js";
import type { AgentRequest, CodaliResponse } from "../agents/AgentProtocol.js";

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
  onEvent?: (event: AgentEvent) => void;
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
    const logPhaseArtifact = async (
      phase: string,
      kind: string,
      payload: unknown,
    ): Promise<string | undefined> => {
      if (!this.options.logger) return undefined;
      const path = await this.options.logger.writePhaseArtifact(phase, kind, payload);
      await this.options.logger.log(`phase_${kind}`, { phase, path });
      return path;
    };
    const buildSerializedContext = (bundle: ContextBundle) =>
      bundle.serialized?.mode === "bundle_text"
        ? bundle.serialized
        : serializeContext(bundle, { mode: "bundle_text" });
    const formatCodaliResponse = (response: CodaliResponse): string =>
      ["CODALI_RESPONSE v1", JSON.stringify(response, null, 2)].join("\n");
    const appendArchitectHistory = async (content: string): Promise<void> => {
      if (!this.options.contextManager || !architectLaneId) return;
      await this.options.contextManager.append(
        architectLaneId,
        { role: "system", content },
        { role: "architect" },
      );
    };
    const appendCriticHistory = async (content: string): Promise<void> => {
      if (!this.options.contextManager || !criticLaneId) return;
      await this.options.contextManager.append(
        criticLaneId,
        { role: "system", content },
        { role: "critic" },
      );
    };
    const buildApplyFailureResponse = (failure: PatchApplyFailure): CodaliResponse => ({
      version: "v1",
      request_id: `apply-failure-${Date.now()}`,
      results: [
        {
          type: "patch.apply_failure",
          error: failure.error,
          patches: failure.patches.map((patch) => patch.file),
          rollback: failure.rollback,
        },
      ],
      meta: {
        warnings: ["patch_apply_failed"],
      },
    });
    const buildCriticResponse = (critic: CriticResult): CodaliResponse => ({
      version: "v1",
      request_id: `critic-${Date.now()}`,
      results: [
        {
          type: "critic.result",
          status: critic.report?.status ?? critic.status,
          reasons: critic.report?.reasons ?? critic.reasons,
          suggested_fixes: critic.report?.suggested_fixes ?? [],
          touched_files: critic.report?.touched_files,
          plan_targets: critic.report?.plan_targets,
        },
      ],
      meta: {
        warnings: critic.status === "FAIL" ? ["critic_failed"] : undefined,
      },
    });

    let context: ContextBundle;
    if (this.options.initialContext) {
      await logPhaseArtifact("librarian", "input", { request });
      context = this.options.initialContext;
      await logPhaseArtifact("librarian", "output", context);
      if (this.options.logger) {
        await this.options.logger.log("phase_start", { phase: "librarian" });
        await this.options.logger.log("phase_end", { phase: "librarian", duration_ms: 0 });
      }
      this.emitStatus("thinking", "librarian: using preflight context");
    } else {
      await logPhaseArtifact("librarian", "input", { request });
      context = await this.runPhase("librarian", () => this.options.contextAssembler.assemble(request));
      await logPhaseArtifact("librarian", "output", context);
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
    const runArchitectPass = async (
      pass: number,
      planHint?: string,
    ): Promise<ArchitectPlanResult> => {
      const planner = this.options.architectPlanner as unknown as {
        planWithRequest?: (context: ContextBundle, opts: Record<string, unknown>) => Promise<ArchitectPlanResult>;
        plan: (context: ContextBundle, opts: Record<string, unknown>) => Promise<Plan>;
      };
      await logPhaseArtifact("architect", "input", {
        pass,
        request,
        context: buildSerializedContext(context),
        plan_hint: planHint ?? null,
      });
      if (planner.planWithRequest) {
        return this.runPhase("architect", () =>
          planner.planWithRequest!(context, {
            contextManager: this.options.contextManager,
            laneId: architectLaneId,
            planHint,
          }),
        );
      }
      const plan = await this.runPhase("architect", () =>
        planner.plan(context, {
          contextManager: this.options.contextManager,
          laneId: architectLaneId,
          planHint,
        }),
      );
      return { plan, raw: "", warnings: [] };
    };

    let plan: Plan;
    if (useFastPath) {
      plan = buildFastPlan(context);
      await logPhaseArtifact("architect", "output", plan);
    } else {
      let pass = 1;
      let lastPlan: ArchitectPlanResult | undefined;
      const maxPasses = 3;
      const reflectionHint =
        "REFINE the previous plan. Re-check constraints and write policy. Output the full DSL plan.";
      while (pass <= maxPasses) {
        const planHint = pass === 1 ? undefined : reflectionHint;
        const result = await runArchitectPass(pass, planHint);
        if (result.request) {
          const response = await this.options.contextAssembler.fulfillAgentRequest(result.request);
          const responseText = formatCodaliResponse(response);
          if (this.options.logger) {
            await this.options.logger.log("architect_request_fulfilled", {
              request_id: result.request.request_id,
              results: response.results.length,
              warnings: response.meta?.warnings ?? [],
            });
          }
          await appendArchitectHistory(responseText);
          await logPhaseArtifact("architect", "output", {
            request_id: result.request.request_id,
            response,
          });
          continue;
        }
        lastPlan = result;
        if (this.options.logger) {
          await this.options.logger.log("architect_output", {
            steps: result.plan.steps.length,
            target_files: result.plan.target_files.length,
            pass,
            warnings: result.warnings,
          });
        }
        await logPhaseArtifact("architect", "output", result.plan);
        pass += 1;
      }
      if (!lastPlan) {
        throw new Error("Architect failed to produce a plan");
      }
      plan = lastPlan.plan;
      if (this.options.logger) {
        const planPath = await this.options.logger.writePhaseArtifact("architect", "plan", plan);
        await this.options.logger.log("plan_json", { phase: "architect", path: planPath });
      }
      await logLaneSummary("architect", architectLaneId);
    }

    let attempts = 0;
    let builderResult: BuilderRunResult | undefined;
    let criticResult: CriticResult | undefined;
    let refreshes = 0;
    const maxContextRefreshes = this.options.maxContextRefreshes ?? 0;
    let builderNote: string | undefined;

    while (attempts <= this.options.maxRetries) {
      attempts += 1;
      const note = builderNote;
      builderNote = undefined;
      const touchedBefore = this.options.getTouchedFiles?.() ?? [];
      const builderContext = buildSerializedContext(context);
      const builderInputPath = await logPhaseArtifact("builder", "input", {
        plan,
        context: builderContext,
      });
      if (this.options.logger) {
        await this.options.logger.log("builder_input", {
          plan_targets: plan.target_files.length,
          context_bytes: builderContext.content.length,
          path: builderInputPath ?? null,
        });
      }
      let built: BuilderRunResult;
      try {
        built = await this.runPhase("builder", () =>
          this.options.builderRunner.run(plan, context, {
            contextManager: this.options.contextManager,
            laneId: builderLaneId,
            note,
          }),
        );
      } catch (error) {
        if (error instanceof PatchApplyError) {
          const failure = error.details;
          builderResult = {
            finalMessage: { role: "assistant", content: failure.rawOutput },
            messages: [],
            toolCallsExecuted: 0,
          };
          const failurePath = await logPhaseArtifact("builder", "apply_failure", failure);
          if (this.options.logger) {
            await this.options.logger.log("builder_apply_failed", {
              error: failure.error,
              source: failure.source,
              rollback: failure.rollback,
              path: failurePath ?? null,
            });
          }
          await appendArchitectHistory(formatCodaliResponse(buildApplyFailureResponse(failure)));
          if (attempts <= this.options.maxRetries) {
            builderNote = `Patch apply failed: ${failure.error}. Rollback ok=${failure.rollback.ok}. Fix the patch output and avoid disallowed paths.`;
            continue;
          }
          criticResult = {
            status: "FAIL",
            reasons: [`patch_apply_failed: ${failure.error}`],
            retryable: false,
            report: {
              status: "FAIL",
              reasons: [`patch_apply_failed: ${failure.error}`],
              suggested_fixes: ["Provide a corrected patch that applies cleanly."],
            },
          };
          break;
        }
        throw error;
      }
      builderResult = built;
      await logPhaseArtifact("builder", "output", {
        finalMessage: built.finalMessage,
        contextRequest: built.contextRequest ?? null,
        usage: built.usage ?? null,
      });
      if (this.options.logger) {
        await this.options.logger.log("builder_output", {
          length: built.finalMessage.content.length,
          context_request: Boolean(built.contextRequest),
        });
      }
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
          await logPhaseArtifact("librarian", "input", {
            request,
            additional_queries: contextRequest.queries ?? [],
            preferred_files: contextRequest.files ?? [],
          });
          context = await this.runPhase("librarian", () =>
            this.options.contextAssembler.assemble(request, {
              additionalQueries: contextRequest.queries,
              preferredFiles: contextRequest.files,
              recentFiles: contextRequest.files,
            }),
          );
          await logPhaseArtifact("librarian", "output", context);
          await logPhaseArtifact("architect", "input", {
            request,
            context: buildSerializedContext(context),
          });
          plan = useFastPath
            ? buildFastPlan(context)
            : await this.runPhase("architect", () =>
                this.options.architectPlanner.plan(context, {
                  contextManager: this.options.contextManager,
                  laneId: architectLaneId,
                }),
              );
          if (this.options.logger) {
            const planPath = await this.options.logger.writePhaseArtifact("architect", "plan", plan);
            await this.options.logger.log("architect_output", {
              steps: plan.steps.length,
              target_files: plan.target_files.length,
            });
            await this.options.logger.log("plan_json", { phase: "architect", path: planPath });
          }
          await logPhaseArtifact("architect", "output", plan);
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

      const reviewer = this.options.architectPlanner as unknown as {
        reviewBuilderOutput?: (
          plan: Plan,
          builderOutput: string,
          context: ContextBundle,
          options?: Record<string, unknown>,
        ) => Promise<{ status: "PASS" | "RETRY"; feedback: string[] }>;
      };
      if (reviewer.reviewBuilderOutput) {
        await logPhaseArtifact("architect_review", "input", {
          plan,
          builder_output: built.finalMessage.content,
        });
        const review = await this.runPhase("architect_review", () =>
          reviewer.reviewBuilderOutput!(plan, built.finalMessage.content, context, {
            contextManager: this.options.contextManager,
            laneId: architectLaneId,
          }),
        );
        await logPhaseArtifact("architect_review", "output", review);
        if (this.options.logger) {
          await this.options.logger.log("architect_review", {
            status: review.status,
            feedback: review.feedback,
          });
        }
        if (review.status === "RETRY") {
          if (attempts <= this.options.maxRetries) {
            builderNote =
              review.feedback.length > 0
                ? `Architect review requested fixes: ${review.feedback.join("; ")}`
                : "Architect review requested changes. Provide a corrected output.";
            continue;
          }
          criticResult = {
            status: "FAIL",
            reasons: ["architect_review_failed", ...review.feedback],
            retryable: false,
          };
          break;
        }
      }
      const touchedAfter = this.options.getTouchedFiles?.() ?? touchedBefore;
      const touchedBeforeSet = new Set(touchedBefore);
      const touchedDelta = touchedAfter.filter((file) => !touchedBeforeSet.has(file));
      const touchedFiles = touchedDelta.length ? touchedDelta : undefined;
      await logPhaseArtifact("critic", "input", {
        plan,
        builder_output: built.finalMessage.content,
        touched_files: touchedFiles ?? [],
      });
      let criticRefreshes = 0;
      while (true) {
        criticResult = await this.runPhase("critic", () =>
          this.options.criticEvaluator.evaluate(plan, built.finalMessage.content, touchedFiles, {
            contextManager: this.options.contextManager,
            laneId: criticLaneId,
            allowedPaths: context.allow_write_paths ?? [],
            readOnlyPaths: context.read_only_paths ?? [],
            allowProtocolRequest: true,
          }),
        );
        if (criticResult.request && criticRefreshes < maxContextRefreshes) {
          const response = await this.options.contextAssembler.fulfillAgentRequest(
            criticResult.request,
          );
          await appendCriticHistory(formatCodaliResponse(response));
          if (this.options.logger) {
            await this.options.logger.log("critic_request_fulfilled", {
              request_id: criticResult.request.request_id,
              results: response.results.length,
              warnings: response.meta?.warnings ?? [],
            });
          }
          criticRefreshes += 1;
          continue;
        }
        break;
      }
      await logPhaseArtifact("critic", "output", criticResult);
      if (this.options.logger) {
        await this.options.logger.log("critic_output", { status: criticResult.status });
      }
      this.emitStatus("done", `critic result: ${criticResult.status}`);
      await logLaneSummary("critic", criticLaneId);
      if (criticResult.status === "PASS") break;
      await appendArchitectHistory(formatCodaliResponse(buildCriticResponse(criticResult)));
      if (criticResult.retryable && attempts <= this.options.maxRetries) {
        builderNote = criticResult.reasons.length
          ? `Critic failed: ${criticResult.reasons.join("; ")}`
          : "Critic failed. Provide a corrected output.";
        continue;
      }
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
    this.emitStatus(this.phaseStatus(phase), `${phase}: start`);
    if (this.options.logger) {
      await this.options.logger.log("phase_start", { phase });
    }
    try {
      const result = await fn();
      if (this.options.logger) {
        await this.options.logger.log("phase_end", { phase, duration_ms: Date.now() - startedAt });
      }
      this.emitStatus("done", `${phase}: done`);
      return result;
    } catch (error) {
      if (this.options.logger) {
        await this.options.logger.log("phase_end", {
          phase,
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.emitStatus("done", `${phase}: failed`);
      throw error;
    }
  }

  private emitStatus(phase: AgentStatusPhase, message?: string): void {
    this.options.onEvent?.({ type: "status", phase, message });
  }

  private phaseStatus(phase: string): AgentStatusPhase {
    if (phase === "builder") return "executing";
    if (phase === "critic") return "thinking";
    if (phase === "librarian" || phase === "architect") return "thinking";
    return "thinking";
  }
}
