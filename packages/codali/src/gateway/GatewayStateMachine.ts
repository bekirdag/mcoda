import type {
  CodaliEvidenceItem,
  CodaliContextPackContradiction,
  CodaliGatewayPlannerOutput,
  CodaliGatewayRequest,
  CodaliGatewayVerifierIssue,
  CodaliGatewayVerifierOutput,
  CodaliGatewayWorkerTask,
} from "./CodaliGatewayTypes.js";
import {
  createInMemoryCodaliGatewayStore,
  type CodaliGatewayRunTrace,
  type CodaliGatewayStore,
  type CodaliGatewayStoredArtifact,
  type CodaliGatewayStoredModelStatus,
  type CodaliGatewayStoredToolStatus,
} from "./CodaliGatewayStore.js";
import {
  compileCodaliGatewayPolicy,
  type GatewayPolicyCompilation,
} from "./GatewayPolicyCompiler.js";
import { normalizeCodaliEvidence } from "./EvidenceNormalizer.js";
import { validateCodaliGatewayVerifierOutput } from "./CodaliGatewaySchemas.js";
import { CODALI_GATEWAY_SECURITY_PROMPT_HARDENING } from "./GatewaySecurityPolicy.js";

export type CodaliGatewayWorkerTaskStatus = "succeeded" | "failed" | "skipped";

export type CodaliGatewayWorkerExecutionStatus = "succeeded" | "failed" | "partial";

export interface CodaliGatewayWorkerToolCallRecord {
  tool: string;
  status: CodaliGatewayStoredToolStatus;
  latencyMs?: number;
  args?: unknown;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayWorkerModelCallRecord {
  role: string;
  status: CodaliGatewayStoredModelStatus;
  latencyMs?: number;
  agentSlug?: string;
  model?: string;
  provider?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayWorkerTaskRunInput {
  runId: string;
  task: CodaliGatewayWorkerTask;
  prompt: string;
  allowedTools: string[];
  remainingToolCalls: number;
  remainingModelCalls?: number;
  timeoutMs: number;
  request: CodaliGatewayRequest;
  policyCompilation: GatewayPolicyCompilation;
}

export interface CodaliGatewayWorkerTaskRunResult {
  status: "succeeded" | "failed";
  output?: unknown;
  evidence?: CodaliEvidenceItem[];
  toolCalls?: CodaliGatewayWorkerToolCallRecord[];
  modelCalls?: CodaliGatewayWorkerModelCallRecord[];
  artifacts?: Array<
    Omit<CodaliGatewayStoredArtifact, "id" | "runId" | "createdAt"> & {
      id?: string;
      runId?: string;
      createdAt?: string;
    }
  >;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayWorkerTaskRunner {
  run(input: CodaliGatewayWorkerTaskRunInput): Promise<CodaliGatewayWorkerTaskRunResult>;
}

export interface CodaliGatewayVerifierRunInput {
  runId: string;
  request: CodaliGatewayRequest;
  planner: CodaliGatewayPlannerOutput;
  iteration: number;
  evidence: CodaliEvidenceItem[];
  taskResults: CodaliGatewayWorkerTaskExecutionResult[];
  remainingToolCalls: number;
  policyCompilation: GatewayPolicyCompilation;
}

export interface CodaliGatewayVerifierRunner {
  verify(input: CodaliGatewayVerifierRunInput): Promise<unknown>;
}

export interface CodaliGatewayStateMachineInput {
  runId: string;
  request: CodaliGatewayRequest;
  planner: CodaliGatewayPlannerOutput;
  policyCompilation?: GatewayPolicyCompilation;
}

export interface CodaliGatewayStateMachineOptions {
  store?: CodaliGatewayStore;
  taskRunner: CodaliGatewayWorkerTaskRunner;
  verifierRunner?: CodaliGatewayVerifierRunner;
  maxParallelWorkers?: number;
  maxRuntimeMs?: number;
  perTaskTimeoutMs?: number;
  maxToolCalls?: number;
  maxModelCalls?: number;
  maxImageArtifacts?: number;
  now?: () => number;
}

export interface CodaliGatewayWorkerTaskExecutionResult {
  taskId: string;
  workerRole: string;
  status: CodaliGatewayWorkerTaskStatus;
  required: boolean;
  allowedTools: string[];
  removedTools: string[];
  durationMs: number;
  evidenceCount: number;
  toolCallCount: number;
  calledTools: string[];
  modelCallCount: number;
  output?: unknown;
  skippedReason?: string;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayWorkerExecutionResult {
  runId: string;
  status: CodaliGatewayWorkerExecutionStatus;
  taskResults: CodaliGatewayWorkerTaskExecutionResult[];
  verification?: CodaliGatewayVerificationLoopResult;
  warnings: string[];
  errors: string[];
  toolCallCount: number;
  calledTools: string[];
  modelCallCount: number;
  trace?: CodaliGatewayRunTrace;
}

export interface CodaliGatewayRejectedFollowUpTask {
  taskId?: string;
  reason: string;
  tools?: string[];
}

export interface CodaliGatewayVerificationIteration {
  iteration: number;
  output: CodaliGatewayVerifierOutput;
  acceptedFollowUpTaskIds: string[];
  rejectedFollowUpTasks: CodaliGatewayRejectedFollowUpTask[];
  stopReason?: string;
}

export interface CodaliGatewayVerificationLoopResult {
  passed: boolean;
  stopReason: string;
  iterations: CodaliGatewayVerificationIteration[];
  missingInformation: string[];
  contradictions: CodaliContextPackContradiction[];
  issues: CodaliGatewayVerifierIssue[];
  followUpTaskCount: number;
  rejectedFollowUpTasks: CodaliGatewayRejectedFollowUpTask[];
}

interface PreparedWorkerTask {
  task: CodaliGatewayWorkerTask;
  required: boolean;
  allowedTools: string[];
  removedTools: string[];
}

interface CodaliGatewayVerifierIterationRunResult {
  record?: CodaliGatewayVerificationIteration;
  acceptedFollowUpTasks: CodaliGatewayWorkerTask[];
  rejectedFollowUpTasks: CodaliGatewayRejectedFollowUpTask[];
  errorCode?: string;
  errorMessage?: string;
}

const DEFAULT_PER_TASK_TIMEOUT_MS = 30_000;

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;

const nonNegativeInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.floor(value)
    : fallback;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readBoolean = (metadata: Record<string, unknown> | undefined, key: string): boolean | undefined =>
  isRecord(metadata) && typeof metadata[key] === "boolean"
    ? metadata[key] as boolean
    : undefined;

const isRequiredWorkerTask = (task: CodaliGatewayWorkerTask): boolean => {
  if (readBoolean(task.metadata, "required") === false) return false;
  if (readBoolean(task.metadata, "optional") === true) return false;
  return true;
};

const uniqueInOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
};

const requestHasTenantScope = (request: CodaliGatewayRequest): boolean =>
  Boolean(request.tenant?.id || request.tenant?.slug || request.tenant?.realm);

const isImageArtifact = (
  artifact: Pick<CodaliGatewayStoredArtifact, "type" | "uri" | "path" | "metadata">,
): boolean => {
  const type = artifact.type.toLowerCase();
  if (type === "image" || type.startsWith("image/") || type.includes("image")) {
    return true;
  }
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : undefined;
  const mimeType = typeof metadata?.mimeType === "string"
    ? metadata.mimeType
    : typeof metadata?.mime_type === "string"
      ? metadata.mime_type
      : undefined;
  return Boolean(mimeType?.toLowerCase().startsWith("image/"));
};

export const buildCodaliGatewayWorkerPrompt = (input: {
  request: CodaliGatewayRequest;
  task: CodaliGatewayWorkerTask;
  allowedTools: string[];
  remainingToolCalls: number;
  remainingModelCalls: number;
}): string => [
  "You are a Codali gateway worker.",
  "Gather evidence only.",
  "Do not answer the user.",
  "Output JSON only.",
  CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.toolOutputBoundary,
  CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.policyImmutability,
  CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.tenantScope,
  "Return structured evidence, source references, tool telemetry, and any errors.",
  `User query: ${input.request.query}`,
  `Task id: ${input.task.id}`,
  `Worker role: ${input.task.workerRole}`,
  `Objective: ${input.task.objective}`,
  `Task query: ${input.task.query ?? input.request.query}`,
  `Output format: ${input.task.outputFormat}`,
  `Allowed tools: ${input.allowedTools.length > 0 ? input.allowedTools.join(", ") : "none"}`,
  `Remaining tool calls: ${input.remainingToolCalls}`,
  `Remaining model calls: ${input.remainingModelCalls}`,
  input.task.expectedSources?.length
    ? `Expected sources: ${input.task.expectedSources.join(", ")}`
    : "Expected sources: none specified",
  input.task.constraints?.length
    ? `Constraints: ${input.task.constraints.join("; ")}`
    : "Constraints: none specified",
].join("\n");

const timeoutError = (taskId: string, timeoutMs: number): Error => {
  const error = new Error(`GATEWAY_WORKER_TIMEOUT: ${taskId} exceeded ${timeoutMs}ms`);
  error.name = "CodaliGatewayWorkerTimeoutError";
  return error;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  taskId: string,
): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(timeoutError(taskId, timeoutMs)), timeoutMs);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
});

export class CodaliGatewayStateMachine {
  readonly store: CodaliGatewayStore;
  private readonly now: () => number;

  constructor(private readonly options: CodaliGatewayStateMachineOptions) {
    this.store = options.store ?? createInMemoryCodaliGatewayStore();
    this.now = options.now ?? (() => Date.now());
  }

  async execute(input: CodaliGatewayStateMachineInput): Promise<CodaliGatewayWorkerExecutionResult> {
    const policyCompilation =
      input.policyCompilation ?? compileCodaliGatewayPolicy({ request: input.request });
    if (!policyCompilation.ok) {
      throw new Error("GATEWAY_POLICY_COMPILE_FAILED: Cannot execute worker tasks.");
    }

    const maxParallelWorkers = positiveInteger(
      this.options.maxParallelWorkers,
      policyCompilation.jobBudgets.maxParallelStages ?? 1,
    );
    const maxRuntimeMs = positiveInteger(
      this.options.maxRuntimeMs,
      policyCompilation.security.limits.maxRuntimeMs,
    );
    const perTaskTimeoutMs = Math.min(
      positiveInteger(this.options.perTaskTimeoutMs, DEFAULT_PER_TASK_TIMEOUT_MS),
      maxRuntimeMs,
    );
    const maxToolCalls = nonNegativeInteger(
      this.options.maxToolCalls,
      policyCompilation.security.limits.maxToolCalls,
    );
    const maxModelCalls = nonNegativeInteger(
      this.options.maxModelCalls,
      policyCompilation.security.limits.maxModelCalls,
    );
    const maxEvidenceItems = nonNegativeInteger(
      undefined,
      policyCompilation.security.limits.maxEvidenceItems,
    );
    const maxImageArtifacts = nonNegativeInteger(
      this.options.maxImageArtifacts,
      policyCompilation.security.limits.maxImageArtifacts,
    );
    const maxVerificationIterations = nonNegativeInteger(
      input.request.policy.maxIterations,
      1,
    );
    const startedAtMs = this.now();
    const warnings: string[] = [];
    const errors: string[] = [];
    const taskResults: CodaliGatewayWorkerTaskExecutionResult[] = [];
    const preparedTasks = await this.prepareTasks(input, policyCompilation, warnings);
    const verificationIterations: CodaliGatewayVerificationIteration[] = [];
    const rejectedFollowUpTasks: CodaliGatewayRejectedFollowUpTask[] = [];
    const calledTools = new Set<string>();
    const initialTrace = await this.store.readRunTrace(input.runId);
    let toolCallCount = 0;
    let modelCallCount = initialTrace?.modelCalls.length ?? 0;
    let cursor = 0;
    let requiredFailure = false;
    let followUpTaskCount = 0;
    let verificationStopReason = this.options.verifierRunner
      ? "not_started"
      : "not_configured";

    await this.store.updateRun(input.runId, {
      status: "running",
      metadata: {
        phase: "worker_task_executor",
        workerTaskCount: preparedTasks.length,
        maxParallelWorkers,
        maxRuntimeMs,
        perTaskTimeoutMs,
        maxToolCalls,
        maxModelCalls,
        maxEvidenceItems,
        maxImageArtifacts,
        initialModelCallCount: modelCallCount,
        verifierEnabled: Boolean(this.options.verifierRunner),
        maxVerificationIterations,
      },
    });

    while (!requiredFailure) {
      while (cursor < preparedTasks.length && !requiredFailure) {
        const wave: PreparedWorkerTask[] = [];
        let waveToolTaskReservations = 0;
        let waveModelTaskReservations = 0;

        while (cursor < preparedTasks.length && wave.length < maxParallelWorkers) {
          const task = preparedTasks[cursor];
          cursor += 1;

          if (this.now() - startedAtMs >= maxRuntimeMs) {
            const result = await this.skipTask(
              input.runId,
              task,
              "max_runtime_exhausted",
            );
            taskResults.push(result);
            warnings.push(`worker_task_skipped:${task.task.id}:max_runtime_exhausted`);
            continue;
          }

          if (modelCallCount + waveModelTaskReservations >= maxModelCalls) {
            const result = await this.skipTask(
              input.runId,
              task,
              "model_budget_exhausted",
            );
            taskResults.push(result);
            warnings.push(`worker_task_skipped:${task.task.id}:model_budget_exhausted`);
            continue;
          }

          const needsToolBudget = task.allowedTools.length > 0;
          if (needsToolBudget && toolCallCount + waveToolTaskReservations >= maxToolCalls) {
            const result = await this.skipTask(
              input.runId,
              task,
              "tool_budget_exhausted",
            );
            taskResults.push(result);
            warnings.push(`worker_task_skipped:${task.task.id}:tool_budget_exhausted`);
            continue;
          }

          if (needsToolBudget) {
            waveToolTaskReservations += 1;
          }
          waveModelTaskReservations += 1;
          wave.push(task);
        }

        if (wave.length === 0) {
          continue;
        }

        const waveResults = await Promise.all(
          wave.map((task) =>
            this.runTask({
              input,
              policyCompilation,
              task,
              remainingToolCalls: Math.max(0, maxToolCalls - toolCallCount),
              remainingModelCalls: Math.max(
                0,
                maxModelCalls - modelCallCount,
              ),
              perTaskTimeoutMs,
            }),
          ),
        );

        for (const result of waveResults) {
          taskResults.push(result);
          toolCallCount += result.toolCallCount;
          modelCallCount += result.modelCallCount;
          for (const tool of result.calledTools) {
            if (result.toolCallCount > 0) {
              calledTools.add(tool);
            }
          }
          if (result.status === "failed") {
            const code = result.errorCode ?? "GATEWAY_WORKER_FAILED";
            const label = `${result.taskId}:${code}`;
            if (result.required) {
              errors.push(label);
              requiredFailure = true;
            } else {
              warnings.push(`optional_worker_failed:${label}`);
              errors.push(`optional:${label}`);
            }
          }
        }

        if (toolCallCount >= maxToolCalls) {
          while (cursor < preparedTasks.length) {
            const task = preparedTasks[cursor];
            cursor += 1;
            if (task.allowedTools.length === 0) {
              taskResults.push(await this.runTask({
                input,
                policyCompilation,
                task,
                remainingToolCalls: 0,
                remainingModelCalls: Math.max(0, maxModelCalls - modelCallCount),
                perTaskTimeoutMs,
              }));
              continue;
            }
            const result = await this.skipTask(
              input.runId,
              task,
              "tool_budget_exhausted",
            );
            taskResults.push(result);
            warnings.push(`worker_task_skipped:${task.task.id}:tool_budget_exhausted`);
          }
        }

        if (modelCallCount >= maxModelCalls) {
          while (cursor < preparedTasks.length) {
            const task = preparedTasks[cursor];
            cursor += 1;
            const result = await this.skipTask(
              input.runId,
              task,
              "model_budget_exhausted",
            );
            taskResults.push(result);
            warnings.push(`worker_task_skipped:${task.task.id}:model_budget_exhausted`);
          }
        }
      }

      if (requiredFailure || !this.options.verifierRunner) {
        break;
      }

      if (verificationIterations.length >= maxVerificationIterations) {
        verificationStopReason = "max_iterations_reached";
        warnings.push("verification_stop:max_iterations_reached");
        break;
      }

      if (modelCallCount >= maxModelCalls) {
        verificationStopReason = "model_budget_exhausted";
        warnings.push("verification_stop:model_budget_exhausted");
        break;
      }

      const verifierResult = await this.runVerifierIteration({
        input,
        planner: {
          ...input.planner,
          workerTasks: preparedTasks.map((task) => task.task),
        },
        policyCompilation,
        iteration: verificationIterations.length + 1,
        taskResults,
        preparedTasks,
        maxToolCalls,
        toolCallCount,
      });
      modelCallCount += 1;

      rejectedFollowUpTasks.push(...verifierResult.rejectedFollowUpTasks);
      for (const rejected of verifierResult.rejectedFollowUpTasks) {
        warnings.push(
          `verification_follow_up_rejected:${rejected.taskId ?? "unknown"}:${rejected.reason}`,
        );
      }

      if (verifierResult.errorCode) {
        verificationStopReason = "verifier_failed";
        const label = `${verifierResult.errorCode}:${verifierResult.errorMessage ?? "unknown"}`;
        warnings.push("verification_stop:verifier_failed");
        errors.push(label);
        break;
      }

      if (verifierResult.record) {
        verificationIterations.push(verifierResult.record);
      }

      if (verifierResult.record?.output.passed) {
        verificationStopReason = "verifier_passed";
        break;
      }

      if (verifierResult.acceptedFollowUpTasks.length === 0) {
        verificationStopReason = this.resolveVerificationStopReason(
          verifierResult.rejectedFollowUpTasks,
        );
        warnings.push(`verification_stop:${verificationStopReason}`);
        break;
      }

      const followUpInput: CodaliGatewayStateMachineInput = {
        ...input,
        planner: {
          ...input.planner,
          workerTasks: verifierResult.acceptedFollowUpTasks,
        },
      };
      const preparedFollowUps = await this.prepareTasks(
        followUpInput,
        policyCompilation,
        warnings,
      );
      preparedTasks.push(...preparedFollowUps);
      followUpTaskCount += preparedFollowUps.length;
      warnings.push(
        `verification_follow_up_accepted:${preparedFollowUps
          .map((task) => task.task.id)
          .join(",")}`,
      );
    }

    if (requiredFailure) {
      if (this.options.verifierRunner && verificationStopReason === "not_started") {
        verificationStopReason = "required_worker_failed";
      }
      while (cursor < preparedTasks.length) {
        const task = preparedTasks[cursor];
        cursor += 1;
        const result = await this.skipTask(
          input.runId,
          task,
          "required_worker_failed",
        );
        taskResults.push(result);
        warnings.push(`worker_task_skipped:${task.task.id}:required_worker_failed`);
      }
    }

    const verification = this.buildVerificationLoopResult({
      stopReason: verificationStopReason,
      iterations: verificationIterations,
      followUpTaskCount,
      rejectedFollowUpTasks,
    });
    const taskOrder = new Map(
      preparedTasks.map((task, index) => [task.task.id, index]),
    );
    const orderedTaskResults = [...taskResults].sort(
      (left, right) =>
        (taskOrder.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) -
        (taskOrder.get(right.taskId) ?? Number.MAX_SAFE_INTEGER),
    );
    const finalStatus = this.resolveStatus(orderedTaskResults, verification);
    await this.store.updateRun(input.runId, {
      status: finalStatus,
      warnings,
      errors,
      metadata: {
        phase: "worker_task_executor",
        workerTaskCount: preparedTasks.length,
        completedWorkerTaskCount: orderedTaskResults.filter((result) => result.status !== "skipped").length,
        toolCallCount,
        modelCallCount,
        calledTools: [...calledTools].sort(),
        verification,
      },
    });

    return {
      runId: input.runId,
      status: finalStatus,
      taskResults: orderedTaskResults,
      verification,
      warnings,
      errors,
      toolCallCount,
      calledTools: [...calledTools].sort(),
      modelCallCount,
      trace: await this.store.readRunTrace(input.runId),
    };
  }

  private async runVerifierIteration(args: {
    input: CodaliGatewayStateMachineInput;
    planner: CodaliGatewayPlannerOutput;
    policyCompilation: GatewayPolicyCompilation;
    iteration: number;
    taskResults: CodaliGatewayWorkerTaskExecutionResult[];
    preparedTasks: PreparedWorkerTask[];
    maxToolCalls: number;
    toolCallCount: number;
  }): Promise<CodaliGatewayVerifierIterationRunResult> {
    const startedAtMs = this.now();
    try {
      const trace = await this.store.readRunTrace(args.input.runId);
      const rawOutput = await this.options.verifierRunner?.verify({
        runId: args.input.runId,
        request: args.input.request,
        planner: args.planner,
        iteration: args.iteration,
        evidence: trace?.evidence ?? [],
        taskResults: args.taskResults,
        remainingToolCalls: Math.max(0, args.maxToolCalls - args.toolCallCount),
        policyCompilation: args.policyCompilation,
      });
      const validated = validateCodaliGatewayVerifierOutput(rawOutput);
      if (!validated.ok) {
        throw new Error(
          `GATEWAY_VERIFIER_OUTPUT_INVALID: ${validated.issues
            .map((issue) => `${issue.path}:${issue.message}`)
            .join("; ")}`,
        );
      }
      const followUps = this.filterVerifierFollowUpTasks({
        output: validated.value,
        preparedTasks: args.preparedTasks,
        policyCompilation: args.policyCompilation,
        maxToolCalls: args.maxToolCalls,
        toolCallCount: args.toolCallCount,
        allowImageWorker: args.input.request.policy.allowImageWorker === true,
      });
      const record: CodaliGatewayVerificationIteration = {
        iteration: args.iteration,
        output: validated.value,
        acceptedFollowUpTaskIds: followUps.accepted.map((task) => task.id),
        rejectedFollowUpTasks: followUps.rejected,
      };
      await this.store.appendModelCall({
        runId: args.input.runId,
        role: "verifier",
        status: "success",
        latencyMs: Math.max(0, this.now() - startedAtMs),
        input: {
          iteration: args.iteration,
          evidenceCount: trace?.evidence.length ?? 0,
          taskResultCount: args.taskResults.length,
          remainingToolCalls: Math.max(0, args.maxToolCalls - args.toolCallCount),
        },
        output: validated.value,
        metadata: {
          iteration: args.iteration,
          acceptedFollowUpTaskIds: record.acceptedFollowUpTaskIds,
          rejectedFollowUpTasks: followUps.rejected,
        },
      });
      return {
        record,
        acceptedFollowUpTasks: followUps.accepted,
        rejectedFollowUpTasks: followUps.rejected,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.store.appendModelCall({
        runId: args.input.runId,
        role: "verifier",
        status: "failed",
        latencyMs: Math.max(0, this.now() - startedAtMs),
        errorCode: "GATEWAY_VERIFIER_FAILED",
        errorMessage,
        metadata: {
          iteration: args.iteration,
        },
      });
      return {
        acceptedFollowUpTasks: [],
        rejectedFollowUpTasks: [],
        errorCode: "GATEWAY_VERIFIER_FAILED",
        errorMessage,
      };
    }
  }

  private filterVerifierFollowUpTasks(args: {
    output: CodaliGatewayVerifierOutput;
    preparedTasks: PreparedWorkerTask[];
    policyCompilation: GatewayPolicyCompilation;
    maxToolCalls: number;
    toolCallCount: number;
    allowImageWorker: boolean;
  }): {
    accepted: CodaliGatewayWorkerTask[];
    rejected: CodaliGatewayRejectedFollowUpTask[];
  } {
    const existingTaskIds = new Set(args.preparedTasks.map((task) => task.task.id));
    const effectiveAllowedTools = new Set(args.policyCompilation.effectiveAllowedTools);
    const accepted: CodaliGatewayWorkerTask[] = [];
    const rejected: CodaliGatewayRejectedFollowUpTask[] = [];

    for (const task of args.output.followUpTasks) {
      if (existingTaskIds.has(task.id)) {
        rejected.push({ taskId: task.id, reason: "duplicate_task_id" });
        continue;
      }
      if (
        task.workerRole === "image_worker" &&
        !args.allowImageWorker
      ) {
        rejected.push({ taskId: task.id, reason: "image_worker_disabled" });
        continue;
      }
      const blockedTools = task.toolsAllowed.filter((tool) => !effectiveAllowedTools.has(tool));
      if (blockedTools.length > 0) {
        rejected.push({
          taskId: task.id,
          reason: "required_tool_unavailable",
          tools: uniqueInOrder(blockedTools),
        });
        continue;
      }
      if (task.toolsAllowed.length > 0 && args.toolCallCount >= args.maxToolCalls) {
        rejected.push({
          taskId: task.id,
          reason: "tool_budget_exhausted",
          tools: uniqueInOrder(task.toolsAllowed),
        });
        continue;
      }
      existingTaskIds.add(task.id);
      accepted.push({
        ...task,
        toolsAllowed: uniqueInOrder(task.toolsAllowed),
        metadata: {
          ...(task.metadata ?? {}),
          verifierFollowUp: true,
        },
      });
    }

    return { accepted, rejected };
  }

  private resolveVerificationStopReason(
    rejected: CodaliGatewayRejectedFollowUpTask[],
  ): string {
    if (rejected.some((task) => task.reason === "tool_budget_exhausted")) {
      return "tool_budget_exhausted";
    }
    if (rejected.some((task) => task.reason === "required_tool_unavailable")) {
      return "required_tool_unavailable";
    }
    return "no_useful_followups";
  }

  private buildVerificationLoopResult(args: {
    stopReason: string;
    iterations: CodaliGatewayVerificationIteration[];
    followUpTaskCount: number;
    rejectedFollowUpTasks: CodaliGatewayRejectedFollowUpTask[];
  }): CodaliGatewayVerificationLoopResult | undefined {
    if (args.stopReason === "not_configured") {
      return undefined;
    }
    return {
      passed: args.iterations.at(-1)?.output.passed ?? false,
      stopReason: args.stopReason,
      iterations: args.iterations,
      missingInformation: uniqueInOrder(
        args.iterations.flatMap((iteration) => iteration.output.missingInformation),
      ),
      contradictions: args.iterations.flatMap((iteration) => iteration.output.contradictions),
      issues: args.iterations.flatMap((iteration) => iteration.output.issues),
      followUpTaskCount: args.followUpTaskCount,
      rejectedFollowUpTasks: args.rejectedFollowUpTasks,
    };
  }

  private async prepareTasks(
    input: CodaliGatewayStateMachineInput,
    policyCompilation: GatewayPolicyCompilation,
    warnings: string[],
  ): Promise<PreparedWorkerTask[]> {
    const effectiveAllowedTools = new Set(policyCompilation.effectiveAllowedTools);
    const prepared: PreparedWorkerTask[] = [];

    for (const task of input.planner.workerTasks) {
      const allowedTools = uniqueInOrder(
        task.toolsAllowed.filter((tool) => effectiveAllowedTools.has(tool)),
      );
      const removedTools = uniqueInOrder(
        task.toolsAllowed.filter((tool) => !effectiveAllowedTools.has(tool)),
      );
      if (removedTools.length > 0) {
        warnings.push(`worker_task_tools_removed:${task.id}:${removedTools.join(",")}`);
      }
      const required = isRequiredWorkerTask(task);
      const sanitizedTask = { ...task, toolsAllowed: allowedTools };
      await this.store.createTask({
        id: task.id,
        runId: input.runId,
        status: "pending",
        workerRole: task.workerRole,
        objective: task.objective,
        metadata: {
          ...(task.metadata ?? {}),
          required,
          allowedTools,
          removedTools,
        },
      });
      prepared.push({ task: sanitizedTask, required, allowedTools, removedTools });
    }

    return prepared;
  }

  private async runTask(args: {
    input: CodaliGatewayStateMachineInput;
    policyCompilation: GatewayPolicyCompilation;
    task: PreparedWorkerTask;
    remainingToolCalls: number;
    remainingModelCalls: number;
    perTaskTimeoutMs: number;
  }): Promise<CodaliGatewayWorkerTaskExecutionResult> {
    const startedAtMs = this.now();
    const prompt = buildCodaliGatewayWorkerPrompt({
      request: args.input.request,
      task: args.task.task,
      allowedTools: args.task.allowedTools,
      remainingToolCalls: args.remainingToolCalls,
      remainingModelCalls: args.remainingModelCalls,
    });

    await this.store.updateTask(args.input.runId, args.task.task.id, {
      status: "running",
      metadata: {
        ...(args.task.task.metadata ?? {}),
        required: args.task.required,
        allowedTools: args.task.allowedTools,
        removedTools: args.task.removedTools,
      },
    });

    try {
      const workerResult = await withTimeout(
        this.options.taskRunner.run({
          runId: args.input.runId,
          task: args.task.task,
          prompt,
          allowedTools: args.task.allowedTools,
          remainingToolCalls: args.remainingToolCalls,
          remainingModelCalls: args.remainingModelCalls,
          timeoutMs: args.perTaskTimeoutMs,
          request: args.input.request,
          policyCompilation: args.policyCompilation,
        }),
        args.perTaskTimeoutMs,
        args.task.task.id,
      );
      return await this.persistWorkerResult(args, workerResult, startedAtMs);
    } catch (error) {
      const errorCode =
        error instanceof Error && error.name === "CodaliGatewayWorkerTimeoutError"
          ? "GATEWAY_WORKER_TIMEOUT"
          : "GATEWAY_WORKER_FAILED";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: CodaliGatewayWorkerTaskExecutionResult = {
        taskId: args.task.task.id,
        workerRole: args.task.task.workerRole,
        status: "failed",
        required: args.task.required,
        allowedTools: args.task.allowedTools,
        removedTools: args.task.removedTools,
        durationMs: Math.max(0, this.now() - startedAtMs),
        evidenceCount: 0,
        toolCallCount: 0,
        calledTools: [],
        modelCallCount: 0,
        errorCode,
        errorMessage,
      };
      await this.store.updateTask(args.input.runId, args.task.task.id, {
        status: "failed",
        metadata: {
          ...(args.task.task.metadata ?? {}),
          required: args.task.required,
          allowedTools: args.task.allowedTools,
          errorCode,
          errorMessage,
        },
      });
      return result;
    }
  }

  private async persistWorkerResult(
    args: {
      input: CodaliGatewayStateMachineInput;
      policyCompilation: GatewayPolicyCompilation;
      task: PreparedWorkerTask;
      remainingToolCalls: number;
      remainingModelCalls: number;
      perTaskTimeoutMs: number;
    },
    workerResult: CodaliGatewayWorkerTaskRunResult,
    startedAtMs: number,
  ): Promise<CodaliGatewayWorkerTaskExecutionResult> {
    const allowed = new Set(args.task.allowedTools);
    const disallowedToolCalls = (workerResult.toolCalls ?? [])
      .filter((call) => !allowed.has(call.tool));
    const toolCalls = (workerResult.toolCalls ?? []).map((call) => {
      if (allowed.has(call.tool)) {
        return call;
      }
      return {
        ...call,
        status: "blocked" as const,
        errorCode: call.errorCode ?? "GATEWAY_TOOL_NOT_APPROVED",
        errorMessage: call.errorMessage ?? "Worker attempted a tool outside its approved set.",
      };
    });
    const toolBudgetExceeded = toolCalls.length > args.remainingToolCalls;
    const modelCallCount = Math.max(1, workerResult.modelCalls?.length ?? 0);
    const modelBudgetExceeded = modelCallCount > args.remainingModelCalls;
    const traceBeforePersistence = await this.store.readRunTrace(args.input.runId);
    const remainingEvidenceItems = Math.max(
      0,
      args.policyCompilation.security.limits.maxEvidenceItems -
        (traceBeforePersistence?.evidence.length ?? 0),
    );
    const remainingImageArtifactsInitial = Math.max(
      0,
      args.policyCompilation.security.limits.maxImageArtifacts -
        (traceBeforePersistence?.artifacts.filter(isImageArtifact).length ?? 0),
    );
    let remainingImageArtifacts = remainingImageArtifactsInitial;
    let blockedImageArtifactCount = 0;
    const tenantScoped = requestHasTenantScope(args.input.request);
    const normalizedEvidence = normalizeCodaliEvidence({
      runId: args.input.runId,
      taskId: args.task.task.id,
      originalQuery: args.input.request.query,
      evidence: workerResult.evidence,
      workerOutput: workerResult.output,
      toolCalls,
      requireTenantScope: tenantScoped,
      defaultTenantScoped: tenantScoped,
      maxEvidenceItems: remainingEvidenceItems,
    });
    const evidence = normalizedEvidence.evidence;
    if (evidence.length > 0) {
      await this.store.appendEvidence(args.input.runId, evidence);
    }
    for (const call of toolCalls) {
      await this.store.appendToolCall({
        runId: args.input.runId,
        taskId: args.task.task.id,
        tool: call.tool,
        status: call.status,
        latencyMs: call.latencyMs,
        args: call.args,
        result: call.result,
        errorCode: call.errorCode,
        errorMessage: call.errorMessage,
        metadata: call.metadata,
      });
    }
    for (const call of workerResult.modelCalls ?? []) {
      await this.store.appendModelCall({
        runId: args.input.runId,
        taskId: args.task.task.id,
        role: call.role,
        status: call.status,
        latencyMs: call.latencyMs,
        agentSlug: call.agentSlug,
        model: call.model,
        provider: call.provider,
        input: call.input,
        output: call.output,
        errorCode: call.errorCode,
        errorMessage: call.errorMessage,
        metadata: call.metadata,
      });
    }
    for (const artifact of workerResult.artifacts ?? []) {
      if (isImageArtifact(artifact) && remainingImageArtifacts <= 0) {
        blockedImageArtifactCount += 1;
        continue;
      }
      if (isImageArtifact(artifact)) {
        remainingImageArtifacts -= 1;
      }
      await this.store.saveArtifact({
        ...artifact,
        runId: args.input.runId,
        taskId: artifact.taskId ?? args.task.task.id,
      });
    }

    const imageArtifactBudgetExceeded = blockedImageArtifactCount > 0;
    const status =
      workerResult.status === "failed" ||
      disallowedToolCalls.length > 0 ||
      toolBudgetExceeded ||
      modelBudgetExceeded ||
      imageArtifactBudgetExceeded
        ? "failed"
        : "succeeded";
    const errorCode =
      disallowedToolCalls.length > 0
        ? "GATEWAY_TOOL_NOT_APPROVED"
        : toolBudgetExceeded
          ? "GATEWAY_TOOL_BUDGET_EXCEEDED"
          : modelBudgetExceeded
            ? "GATEWAY_MODEL_BUDGET_EXCEEDED"
            : imageArtifactBudgetExceeded
              ? "GATEWAY_IMAGE_ARTIFACT_BUDGET_EXCEEDED"
              : workerResult.errorCode;
    const errorMessage =
      disallowedToolCalls.length > 0
        ? `Worker attempted disallowed tools: ${disallowedToolCalls
          .map((call) => call.tool)
          .join(", ")}`
        : toolBudgetExceeded
          ? "Worker reported more tool calls than the remaining gateway budget."
          : modelBudgetExceeded
            ? "Worker reported more model calls than the remaining gateway budget."
            : imageArtifactBudgetExceeded
              ? "Worker produced more image artifacts than the remaining gateway budget."
              : workerResult.errorMessage;

    await this.store.updateTask(args.input.runId, args.task.task.id, {
      status,
      metadata: {
        ...(args.task.task.metadata ?? {}),
        required: args.task.required,
        allowedTools: args.task.allowedTools,
        removedTools: args.task.removedTools,
        errorCode,
        output: workerResult.output,
        workerMetadata: workerResult.metadata,
        evidenceNormalization: {
          warnings: normalizedEvidence.warnings,
          rejectedCount: normalizedEvidence.rejected.length,
          duplicateCount: normalizedEvidence.duplicateCount,
          remainingEvidenceItems,
        },
        budgetEnforcement: {
          remainingToolCalls: args.remainingToolCalls,
          remainingModelCalls: args.remainingModelCalls,
          modelCallCount,
          toolBudgetExceeded,
          modelBudgetExceeded,
          maxImageArtifacts: args.policyCompilation.security.limits.maxImageArtifacts,
          remainingImageArtifacts: remainingImageArtifactsInitial,
          blockedImageArtifactCount,
        },
      },
    });

    return {
      taskId: args.task.task.id,
      workerRole: args.task.task.workerRole,
      status,
      required: args.task.required,
      allowedTools: args.task.allowedTools,
      removedTools: args.task.removedTools,
      durationMs: Math.max(0, this.now() - startedAtMs),
      evidenceCount: evidence.length,
      toolCallCount: toolCalls.length,
      calledTools: uniqueInOrder(toolCalls.map((call) => call.tool)),
      modelCallCount,
      output: workerResult.output,
      errorCode,
      errorMessage,
      metadata: workerResult.metadata,
    };
  }

  private async skipTask(
    runId: string,
    task: PreparedWorkerTask,
    reason: string,
  ): Promise<CodaliGatewayWorkerTaskExecutionResult> {
    await this.store.updateTask(runId, task.task.id, {
      status: "skipped",
      metadata: {
        ...(task.task.metadata ?? {}),
        required: task.required,
        allowedTools: task.allowedTools,
        removedTools: task.removedTools,
        skippedReason: reason,
      },
    });
    return {
      taskId: task.task.id,
      workerRole: task.task.workerRole,
      status: "skipped",
      required: task.required,
      allowedTools: task.allowedTools,
      removedTools: task.removedTools,
      durationMs: 0,
      evidenceCount: 0,
      toolCallCount: 0,
      calledTools: [],
      modelCallCount: 0,
      skippedReason: reason,
    };
  }

  private resolveStatus(
    taskResults: CodaliGatewayWorkerTaskExecutionResult[],
    verification?: CodaliGatewayVerificationLoopResult,
  ): CodaliGatewayWorkerExecutionStatus {
    if (taskResults.some((result) => result.status === "failed" && result.required)) {
      return "failed";
    }
    if (verification && !verification.passed) {
      return "partial";
    }
    if (taskResults.some((result) => result.status === "failed" || result.status === "skipped")) {
      return "partial";
    }
    return "succeeded";
  }
}

export const createCodaliGatewayStateMachine = (
  options: CodaliGatewayStateMachineOptions,
): CodaliGatewayStateMachine => new CodaliGatewayStateMachine(options);
