import { randomUUID } from "node:crypto";
import type {
  CodaliContextPack,
  CodaliEvidenceItem,
  CodaliGatewayRequest,
  CodaliGatewayTraceEvent,
} from "./CodaliGatewayTypes.js";
import {
  redactCodaliGatewaySecrets,
  type CodaliGatewayRunTrace,
  type CodaliGatewayStore,
  type CodaliGatewayStoredArtifact,
  type CodaliGatewayStoredModelCall,
  type CodaliGatewayStoredTask,
  type CodaliGatewayStoredToolCall,
} from "./CodaliGatewayStore.js";

export const CODALI_GATEWAY_TRACE_SCHEMA_VERSION = 1 as const;
export const CODALI_GATEWAY_REPLAY_FIXTURE_SCHEMA_VERSION = 1 as const;

export const CODALI_GATEWAY_TRACE_EVENT_NAMES = {
  RUN_CREATED: "codali.gateway.run.created",
  RUN_STATUS: "codali.gateway.run.status",
  TASK_STATUS: "codali.gateway.task.status",
  TOOL_CALL: "codali.gateway.tool.call",
  MODEL_CALL: "codali.gateway.model.call",
  EVIDENCE_RECORDED: "codali.gateway.evidence.recorded",
  CONTEXT_PACK_BUILT: "codali.gateway.context_pack.built",
  ARTIFACT_CREATED: "codali.gateway.artifact.created",
  FINAL_SYNTHESIS: "codali.gateway.final_synthesis",
} as const;

export interface CodaliGatewayDebugSummary {
  runId: string;
  status: string;
  mode?: string;
  product?: string;
  tenantId?: string;
  tenantSlug?: string;
  conversationId?: string;
  taskCount: number;
  evidenceCount: number;
  toolCallCount: number;
  modelCallCount: number;
  artifactCount: number;
  sourceCount: number;
  calledTools: string[];
  failedTools: string[];
  modelRoles: string[];
  finalModel?: {
    role: string;
    agentSlug?: string;
    model?: string;
    provider?: string;
    status: string;
  };
  warnings: string[];
  errors: string[];
}

export interface CodaliGatewayTraceReadResult {
  schemaVersion: typeof CODALI_GATEWAY_TRACE_SCHEMA_VERSION;
  runId: string;
  status: string;
  run: CodaliGatewayRunTrace["run"];
  tasks: CodaliGatewayStoredTask[];
  evidence: CodaliEvidenceItem[];
  toolCalls: CodaliGatewayStoredToolCall[];
  modelCalls: CodaliGatewayStoredModelCall[];
  contextPack?: CodaliContextPack;
  artifacts: CodaliGatewayStoredArtifact[];
  finalAnswer?: string;
  debugSummary: CodaliGatewayDebugSummary;
  events: CodaliGatewayTraceEvent[];
}

export interface CodaliGatewayTraceReadInput {
  store: CodaliGatewayStore;
  runId: string;
}

export interface CodaliGatewayReplayFixtureToolCall {
  id: string;
  taskId?: string;
  tool: string;
  status: string;
  args?: unknown;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
}

export interface CodaliGatewayReplayFixtureModelCall {
  id: string;
  taskId?: string;
  role: string;
  status: string;
  agentSlug?: string;
  model?: string;
  provider?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
}

export interface CodaliGatewayReplayFixture {
  schemaVersion: typeof CODALI_GATEWAY_REPLAY_FIXTURE_SCHEMA_VERSION;
  fixtureId: string;
  runId: string;
  exportedAt: string;
  request?: CodaliGatewayRequest | Record<string, unknown>;
  planner: {
    classifierOutput?: unknown;
    plannerOutput?: unknown;
  };
  contextPack?: CodaliContextPack;
  evidence: CodaliEvidenceItem[];
  toolFixtures: CodaliGatewayReplayFixtureToolCall[];
  modelFixtures: CodaliGatewayReplayFixtureModelCall[];
  finalAnswer?: string;
  debugSummary: CodaliGatewayDebugSummary;
  events: CodaliGatewayTraceEvent[];
}

export interface CodaliGatewayReplayFixtureOptions {
  fixtureId?: string;
  includeModelInputs?: boolean;
  includeModelOutputs?: boolean;
  includeToolResults?: boolean;
}

export interface CodaliGatewayReplayFixtureInput {
  store: CodaliGatewayStore;
  runId: string;
  options?: CodaliGatewayReplayFixtureOptions;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneRedacted = <T>(value: T): T =>
  redactCodaliGatewaySecrets(value) as T;

const uniqueInOrder = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
};

const metadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const requestMode = (
  request: CodaliGatewayRunTrace["run"]["request"],
  metadata: Record<string, unknown> | undefined,
): string | undefined => {
  if (isRecord(request) && typeof request.mode === "string") {
    return request.mode;
  }
  return metadataString(metadata, "mode");
};

const requestProduct = (
  request: CodaliGatewayRunTrace["run"]["request"],
  metadata: Record<string, unknown> | undefined,
): string | undefined => {
  if (isRecord(request) && isRecord(request.product)) {
    const productName = request.product.name;
    if (typeof productName === "string" && productName.length > 0) {
      return productName;
    }
  }
  return metadataString(metadata, "product");
};

const requestTenantValue = (
  request: CodaliGatewayRunTrace["run"]["request"],
  key: "id" | "slug",
): string | undefined => {
  if (!isRecord(request) || !isRecord(request.tenant)) {
    return undefined;
  }
  const value = request.tenant[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const requestConversationId = (
  request: CodaliGatewayRunTrace["run"]["request"],
): string | undefined => {
  if (!isRecord(request) || !isRecord(request.conversation)) {
    return undefined;
  }
  const value = request.conversation.id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const collectSourceIds = (contextPack: CodaliContextPack | undefined): string[] => {
  if (!contextPack) {
    return [];
  }
  return uniqueInOrder([
    ...contextPack.decisionFacts.map((fact) => fact.sourceId),
    ...contextPack.decisionFacts.map((fact) => fact.sourceUri),
    ...contextPack.selectedExcerpts.map((excerpt) => excerpt.evidenceId),
  ]);
};

const finalModelCall = (
  modelCalls: CodaliGatewayStoredModelCall[],
): CodaliGatewayStoredModelCall | undefined =>
  [...modelCalls]
    .reverse()
    .find((call) => call.role === "final_synthesizer")
  ?? [...modelCalls].reverse().find((call) => call.role === "final");

const finalAnswerFromTrace = (
  modelCalls: CodaliGatewayStoredModelCall[],
): string | undefined => {
  const call = finalModelCall(modelCalls);
  return typeof call?.output === "string" ? call.output : undefined;
};

const event = (
  kind: string,
  message: string,
  metadata: Record<string, unknown>,
  timestamp?: string,
): CodaliGatewayTraceEvent => ({
  kind,
  timestamp: timestamp ?? new Date(0).toISOString(),
  message,
  metadata: cloneRedacted(metadata),
});

export const summarizeCodaliGatewayTrace = (
  trace: CodaliGatewayRunTrace,
): CodaliGatewayDebugSummary => {
  const metadata = trace.run.metadata;
  const finalCall = finalModelCall(trace.modelCalls);
  return {
    runId: trace.run.runId,
    status: trace.run.status,
    mode: requestMode(trace.run.request, metadata),
    product: requestProduct(trace.run.request, metadata),
    tenantId: requestTenantValue(trace.run.request, "id"),
    tenantSlug: requestTenantValue(trace.run.request, "slug"),
    conversationId: requestConversationId(trace.run.request),
    taskCount: trace.tasks.length,
    evidenceCount: trace.evidence.length,
    toolCallCount: trace.toolCalls.length,
    modelCallCount: trace.modelCalls.length,
    artifactCount: trace.artifacts.length,
    sourceCount: collectSourceIds(trace.contextPack).length,
    calledTools: uniqueInOrder(trace.toolCalls.map((call) => call.tool)),
    failedTools: uniqueInOrder(
      trace.toolCalls
        .filter((call) => call.status !== "success")
        .map((call) => call.tool),
    ),
    modelRoles: uniqueInOrder(trace.modelCalls.map((call) => call.role)),
    finalModel: finalCall
      ? {
          role: finalCall.role,
          agentSlug: finalCall.agentSlug,
          model: finalCall.model,
          provider: finalCall.provider,
          status: finalCall.status,
        }
      : undefined,
    warnings: [...trace.run.warnings],
    errors: [...trace.run.errors],
  };
};

export const buildCodaliGatewayTraceEvents = (
  trace: CodaliGatewayRunTrace | undefined,
): CodaliGatewayTraceEvent[] => {
  if (!trace) {
    return [];
  }
  const events: CodaliGatewayTraceEvent[] = [
    event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.RUN_CREATED,
      "Gateway run created",
      { runId: trace.run.runId, status: trace.run.status },
      trace.run.createdAt,
    ),
    event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.RUN_STATUS,
      "Gateway run status updated",
      { runId: trace.run.runId, status: trace.run.status },
      trace.run.updatedAt,
    ),
  ];

  for (const task of trace.tasks) {
    events.push(event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.TASK_STATUS,
      "Gateway task status updated",
      {
        runId: trace.run.runId,
        taskId: task.id,
        status: task.status,
        workerRole: task.workerRole,
      },
      task.updatedAt,
    ));
  }

  if (trace.evidence.length > 0) {
    events.push(event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.EVIDENCE_RECORDED,
      "Gateway evidence recorded",
      {
        runId: trace.run.runId,
        evidenceCount: trace.evidence.length,
        evidenceIds: trace.evidence.map((item) => item.id),
      },
      trace.run.updatedAt,
    ));
  }

  for (const call of trace.toolCalls) {
    events.push(event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.TOOL_CALL,
      "Gateway tool call recorded",
      {
        runId: trace.run.runId,
        toolCallId: call.id,
        taskId: call.taskId,
        tool: call.tool,
        status: call.status,
        latencyMs: call.latencyMs,
        errorCode: call.errorCode,
      },
      call.endedAt ?? call.startedAt,
    ));
  }

  for (const call of trace.modelCalls) {
    events.push(event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.MODEL_CALL,
      "Gateway model call recorded",
      {
        runId: trace.run.runId,
        modelCallId: call.id,
        taskId: call.taskId,
        role: call.role,
        status: call.status,
        agentSlug: call.agentSlug,
        model: call.model,
        provider: call.provider,
        latencyMs: call.latencyMs,
        errorCode: call.errorCode,
      },
      call.endedAt ?? call.startedAt,
    ));
  }

  if (trace.contextPack) {
    events.push(event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.CONTEXT_PACK_BUILT,
      "Gateway context pack built",
      {
        runId: trace.run.runId,
        contextPackId: trace.contextPack.id,
        evidenceCount: trace.contextPack.decisionFacts.length,
        tokenEstimate: trace.contextPack.tokenEstimate,
        sourceCount: collectSourceIds(trace.contextPack).length,
      },
      trace.run.updatedAt,
    ));
  }

  for (const artifact of trace.artifacts) {
    events.push(event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.ARTIFACT_CREATED,
      "Gateway artifact created",
      {
        runId: trace.run.runId,
        artifactId: artifact.id,
        taskId: artifact.taskId,
        type: artifact.type,
        uri: artifact.uri,
        path: artifact.path,
        model: artifact.model,
      },
      artifact.createdAt,
    ));
  }

  const finalCall = finalModelCall(trace.modelCalls);
  if (finalCall || isRecord(trace.run.metadata?.finalSynthesis)) {
    events.push(event(
      CODALI_GATEWAY_TRACE_EVENT_NAMES.FINAL_SYNTHESIS,
      "Gateway final synthesis recorded",
      {
        runId: trace.run.runId,
        modelCallId: finalCall?.id,
        status: finalCall?.status ?? trace.run.status,
        finalSynthesis: trace.run.metadata?.finalSynthesis,
      },
      finalCall?.endedAt ?? trace.run.updatedAt,
    ));
  }

  return events;
};

export const readCodaliGatewayTrace = async ({
  store,
  runId,
}: CodaliGatewayTraceReadInput): Promise<CodaliGatewayTraceReadResult | undefined> => {
  const trace = await store.readRunTrace(runId);
  if (!trace) {
    return undefined;
  }

  const redacted = cloneRedacted(trace);
  const debugSummary = summarizeCodaliGatewayTrace(redacted);
  return {
    schemaVersion: CODALI_GATEWAY_TRACE_SCHEMA_VERSION,
    runId,
    status: redacted.run.status,
    run: redacted.run,
    tasks: redacted.tasks,
    evidence: redacted.evidence,
    toolCalls: redacted.toolCalls,
    modelCalls: redacted.modelCalls,
    contextPack: redacted.contextPack,
    artifacts: redacted.artifacts,
    finalAnswer: finalAnswerFromTrace(redacted.modelCalls),
    debugSummary,
    events: buildCodaliGatewayTraceEvents(redacted),
  };
};

export const exportCodaliGatewayReplayFixture = async ({
  store,
  runId,
  options = {},
}: CodaliGatewayReplayFixtureInput): Promise<CodaliGatewayReplayFixture | undefined> => {
  const trace = await readCodaliGatewayTrace({ store, runId });
  if (!trace) {
    return undefined;
  }

  const classifierCall = trace.modelCalls.find((call) => call.role === "classifier");
  const plannerCall = trace.modelCalls.find((call) => call.role === "planner");
  const includeModelOutputs = options.includeModelOutputs === true;

  return cloneRedacted({
    schemaVersion: CODALI_GATEWAY_REPLAY_FIXTURE_SCHEMA_VERSION,
    fixtureId: options.fixtureId ?? `gateway-replay-${randomUUID()}`,
    runId: trace.runId,
    exportedAt: new Date().toISOString(),
    request: trace.run.request,
    planner: {
      classifierOutput: includeModelOutputs ? classifierCall?.output : undefined,
      plannerOutput: includeModelOutputs ? plannerCall?.output : undefined,
    },
    contextPack: trace.contextPack,
    evidence: trace.evidence,
    toolFixtures: trace.toolCalls.map((call) => ({
      id: call.id,
      taskId: call.taskId,
      tool: call.tool,
      status: call.status,
      args: call.args,
      result: options.includeToolResults === false ? undefined : call.result,
      errorCode: call.errorCode,
      errorMessage: call.errorMessage,
      latencyMs: call.latencyMs,
    })),
    modelFixtures: trace.modelCalls.map((call) => ({
      id: call.id,
      taskId: call.taskId,
      role: call.role,
      status: call.status,
      agentSlug: call.agentSlug,
      model: call.model,
      provider: call.provider,
      input: options.includeModelInputs === true ? call.input : undefined,
      output: includeModelOutputs ? call.output : undefined,
      errorCode: call.errorCode,
      errorMessage: call.errorMessage,
      latencyMs: call.latencyMs,
    })),
    finalAnswer: includeModelOutputs ? trace.finalAnswer : undefined,
    debugSummary: trace.debugSummary,
    events: trace.events,
  });
};
