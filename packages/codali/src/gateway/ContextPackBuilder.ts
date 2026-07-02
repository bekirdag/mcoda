import type {
  CodaliContextPack,
  CodaliContextPackContradiction,
  CodaliContextPackExcerpt,
  CodaliContextPackToolSummary,
  CodaliEvidenceItem,
  CodaliGatewayRequest,
} from "./CodaliGatewayTypes.js";
import type {
  CodaliGatewayRunTrace,
  CodaliGatewayStore,
  CodaliGatewayStoredToolCall,
} from "./CodaliGatewayStore.js";
import type { CodaliGatewayVerificationLoopResult } from "./GatewayStateMachine.js";

export interface CodaliContextPackBuilderInput {
  runId: string;
  originalQuery?: string;
  request?: CodaliGatewayRequest;
  trace?: CodaliGatewayRunTrace;
  evidence?: CodaliEvidenceItem[];
  toolCalls?: CodaliGatewayStoredToolCall[];
  verification?: CodaliGatewayVerificationLoopResult;
  maxContextPackTokens?: number;
  maxDecisionFacts?: number;
  maxExcerptChars?: number;
}

export interface CodaliContextPackBuildResult {
  contextPack: CodaliContextPack;
  selectedEvidenceIds: string[];
  droppedEvidenceIds: string[];
  warnings: string[];
}

export interface CodaliContextPackBuilderOptions {
  store: CodaliGatewayStore;
  maxDecisionFacts?: number;
  maxExcerptChars?: number;
}

export interface CodaliContextPackBuildAndPersistInput {
  runId: string;
  request?: CodaliGatewayRequest;
  verification?: CodaliGatewayVerificationLoopResult;
  maxContextPackTokens?: number;
  maxDecisionFacts?: number;
  maxExcerptChars?: number;
}

const DEFAULT_MAX_DECISION_FACTS = 24;
const DEFAULT_MAX_EXCERPT_CHARS = 1_200;
const DEFAULT_MAX_CONTEXT_PACK_TOKENS = 12_000;

const FRESHNESS_SCORE: Record<string, number> = {
  fresh: 1,
  recent: 0.75,
  unknown: 0.4,
  stale: 0.1,
};

const SOURCE_QUALITY: Record<string, number> = {
  app_tool: 0.9,
  docdex: 1,
  file: 0.75,
  github: 0.9,
  jira: 0.9,
  microsoft: 0.9,
  model_observation: 0.2,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;

const clampUnit = (value: number | undefined): number =>
  Number.isFinite(value) && value !== undefined
    ? Math.max(0, Math.min(1, value))
    : 0;

const uniqueInOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
};

const estimateTokens = (value: unknown): number => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(1, Math.ceil(text.length / 4));
};

export const estimateCodaliContextPackTokens = (pack: CodaliContextPack): number =>
  estimateTokens({
    originalQuery: pack.originalQuery,
    decisionFacts: pack.decisionFacts.map((evidence) => ({
      id: evidence.id,
      claim: evidence.claim,
      summary: evidence.summary,
      sourceType: evidence.sourceType,
      sourceId: evidence.sourceId,
      sourceUri: evidence.sourceUri,
      sourceTitle: evidence.sourceTitle,
      confidence: evidence.confidence,
      relevance: evidence.relevance,
      freshness: evidence.freshness,
      usedTool: evidence.usedTool,
    })),
    contradictions: pack.contradictions,
    missingInformation: pack.missingInformation,
    selectedExcerpts: pack.selectedExcerpts,
    toolSummary: pack.toolSummary,
  });

const normalizeClaimFingerprint = (claim: string): string =>
  claim
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const sourceQualityScore = (evidence: CodaliEvidenceItem): number => {
  const sourceType = evidence.sourceType.toLowerCase();
  const direct = SOURCE_QUALITY[sourceType];
  const base = direct ?? (sourceType.includes("docdex") ? 1 : 0.55);
  const provenanceBoost = evidence.sourceId || evidence.sourceUri ? 0.05 : 0;
  return Math.min(1, base + provenanceBoost);
};

const evidenceRankScore = (evidence: CodaliEvidenceItem): number => {
  const relevance = clampUnit(evidence.relevance);
  const confidence = clampUnit(evidence.confidence);
  const freshness = FRESHNESS_SCORE[evidence.freshness ?? "unknown"] ?? FRESHNESS_SCORE.unknown;
  const sourceQuality = sourceQualityScore(evidence);
  return (
    relevance * 0.42 +
    confidence * 0.34 +
    freshness * 0.1 +
    sourceQuality * 0.14
  );
};

const compareEvidence = (
  left: CodaliEvidenceItem,
  right: CodaliEvidenceItem,
): number => {
  const scoreDiff = evidenceRankScore(right) - evidenceRankScore(left);
  if (scoreDiff !== 0) return scoreDiff;
  const confidenceDiff = clampUnit(right.confidence) - clampUnit(left.confidence);
  if (confidenceDiff !== 0) return confidenceDiff;
  const relevanceDiff = clampUnit(right.relevance) - clampUnit(left.relevance);
  if (relevanceDiff !== 0) return relevanceDiff;
  return left.id.localeCompare(right.id);
};

const cloneEvidenceForContext = (
  evidence: CodaliEvidenceItem,
  mergedEvidenceIds: string[] = [],
): CodaliEvidenceItem => {
  const { rawExcerpt: _rawExcerpt, rawPayloadRef: _rawPayloadRef, ...rest } = evidence;
  return {
    ...rest,
    metadata: {
      ...(evidence.metadata ?? {}),
      contextRankScore: Number(evidenceRankScore(evidence).toFixed(6)),
      ...(mergedEvidenceIds.length > 0 ? { mergedEvidenceIds } : {}),
    },
  };
};

const selectExcerptText = (
  evidence: CodaliEvidenceItem,
  maxExcerptChars: number,
): string => {
  const raw =
    evidence.sourceType === "model_observation"
      ? evidence.summary ?? evidence.claim
      : evidence.rawExcerpt ?? evidence.summary ?? evidence.claim;
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxExcerptChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxExcerptChars - 15)).trimEnd() + " [truncated]";
};

const dedupeAndRankEvidence = (evidence: CodaliEvidenceItem[]): {
  ranked: CodaliEvidenceItem[];
  duplicateIdsByWinner: Map<string, string[]>;
  droppedDuplicateIds: string[];
} => {
  const groups = new Map<string, CodaliEvidenceItem[]>();
  for (const item of evidence) {
    const fingerprint = normalizeClaimFingerprint(item.claim);
    const key = fingerprint || item.id;
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }

  const ranked: CodaliEvidenceItem[] = [];
  const duplicateIdsByWinner = new Map<string, string[]>();
  const droppedDuplicateIds: string[] = [];

  for (const group of groups.values()) {
    const sorted = [...group].sort(compareEvidence);
    const winner = sorted[0];
    if (!winner) continue;
    const duplicateIds = sorted.slice(1).map((item) => item.id);
    if (duplicateIds.length > 0) {
      duplicateIdsByWinner.set(winner.id, duplicateIds);
      droppedDuplicateIds.push(...duplicateIds);
    }
    ranked.push(winner);
  }

  return {
    ranked: ranked.sort(compareEvidence),
    duplicateIdsByWinner,
    droppedDuplicateIds,
  };
};

const summarizeTools = (
  calls: CodaliGatewayStoredToolCall[],
): CodaliContextPackToolSummary[] => {
  const byTool = new Map<string, Record<string, number>>();
  for (const call of calls) {
    const statuses = byTool.get(call.tool) ?? {};
    statuses[call.status] = (statuses[call.status] ?? 0) + 1;
    byTool.set(call.tool, statuses);
  }
  return [...byTool.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tool, statuses]) => ({
      tool,
      calls: Object.values(statuses).reduce((sum, value) => sum + value, 0),
      statuses,
    }));
};

const readRequestFromTrace = (
  trace: CodaliGatewayRunTrace | undefined,
): CodaliGatewayRequest | undefined => {
  const request = trace?.run.request;
  if (!isRecord(request) || typeof request.query !== "string") {
    return undefined;
  }
  return request as unknown as CodaliGatewayRequest;
};

const readVerificationFromTrace = (
  trace: CodaliGatewayRunTrace | undefined,
): CodaliGatewayVerificationLoopResult | undefined => {
  const metadata = trace?.run.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.verification)) {
    return undefined;
  }
  return metadata.verification as unknown as CodaliGatewayVerificationLoopResult;
};

const normalizeContradictions = (
  contradictions: CodaliContextPackContradiction[],
): CodaliContextPackContradiction[] => {
  const seen = new Set<string>();
  const output: CodaliContextPackContradiction[] = [];
  for (const contradiction of contradictions) {
    const summary = contradiction.summary.trim();
    if (!summary) continue;
    const evidenceIds = uniqueInOrder(contradiction.evidenceIds ?? []);
    const key = `${summary}:${evidenceIds.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ summary, evidenceIds });
  }
  return output;
};

export const buildCodaliContextPack = (
  input: CodaliContextPackBuilderInput,
): CodaliContextPackBuildResult => {
  const traceRequest = readRequestFromTrace(input.trace);
  const request = input.request ?? traceRequest;
  const verification = input.verification ?? readVerificationFromTrace(input.trace);
  const maxContextPackTokens = positiveInteger(
    input.maxContextPackTokens ?? request?.policy?.maxContextPackTokens,
    DEFAULT_MAX_CONTEXT_PACK_TOKENS,
  );
  const maxDecisionFacts = positiveInteger(
    input.maxDecisionFacts ?? request?.policy?.maxEvidenceItems,
    DEFAULT_MAX_DECISION_FACTS,
  );
  const maxExcerptChars = positiveInteger(input.maxExcerptChars, DEFAULT_MAX_EXCERPT_CHARS);
  const evidence = input.evidence ?? input.trace?.evidence ?? [];
  const toolCalls = input.toolCalls ?? input.trace?.toolCalls ?? [];
  const originalQuery =
    input.originalQuery ??
    request?.query ??
    (typeof input.trace?.run.request === "object" &&
    input.trace?.run.request &&
    "query" in input.trace.run.request &&
    typeof input.trace.run.request.query === "string"
      ? input.trace.run.request.query
      : "");

  const warnings: string[] = [];
  const { ranked, duplicateIdsByWinner, droppedDuplicateIds } = dedupeAndRankEvidence(evidence);
  const missingInformation = uniqueInOrder(verification?.missingInformation ?? []);
  const contradictions = normalizeContradictions(verification?.contradictions ?? []);
  const toolSummary = summarizeTools(toolCalls);
  const decisionFacts: CodaliEvidenceItem[] = [];
  const selectedExcerpts: CodaliContextPackExcerpt[] = [];
  const selectedEvidenceIds: string[] = [];
  const droppedEvidenceIds = new Set<string>(droppedDuplicateIds);

  let contextPack: CodaliContextPack = {
    id: `context-pack-${input.runId}`,
    runId: input.runId,
    originalQuery,
    decisionFacts,
    contradictions,
    missingInformation,
    selectedExcerpts,
    toolSummary,
    tokenEstimate: 1,
    metadata: {
      maxContextPackTokens,
      sourceEvidenceCount: evidence.length,
      deduplicatedEvidenceCount: ranked.length,
      duplicateEvidenceIds: droppedDuplicateIds,
    },
  };
  let tokenEstimate = estimateCodaliContextPackTokens(contextPack);

  for (const evidenceItem of ranked) {
    if (decisionFacts.length >= maxDecisionFacts) {
      droppedEvidenceIds.add(evidenceItem.id);
      continue;
    }
    const fact = cloneEvidenceForContext(
      evidenceItem,
      duplicateIdsByWinner.get(evidenceItem.id) ?? [],
    );
    const excerptText = selectExcerptText(evidenceItem, maxExcerptChars);
    const excerpt: CodaliContextPackExcerpt = {
      evidenceId: evidenceItem.id,
      text: excerptText,
    };
    const candidatePack: CodaliContextPack = {
      ...contextPack,
      decisionFacts: [...decisionFacts, fact],
      selectedExcerpts: [...selectedExcerpts, excerpt],
      tokenEstimate,
    };
    const candidateEstimate = estimateCodaliContextPackTokens(candidatePack);
    if (candidateEstimate > maxContextPackTokens && decisionFacts.length > 0) {
      droppedEvidenceIds.add(evidenceItem.id);
      warnings.push(`context_pack_budget_dropped:${evidenceItem.id}`);
      continue;
    }
    decisionFacts.push(fact);
    selectedExcerpts.push(excerpt);
    selectedEvidenceIds.push(evidenceItem.id);
    tokenEstimate = Math.min(candidateEstimate, maxContextPackTokens);
    contextPack = {
      ...candidatePack,
      tokenEstimate,
    };
  }

  for (const evidenceItem of ranked) {
    if (!selectedEvidenceIds.includes(evidenceItem.id)) {
      droppedEvidenceIds.add(evidenceItem.id);
    }
  }

  contextPack = {
    ...contextPack,
    decisionFacts,
    selectedExcerpts,
    tokenEstimate: Math.min(estimateCodaliContextPackTokens(contextPack), maxContextPackTokens),
    metadata: {
      ...(contextPack.metadata ?? {}),
      selectedEvidenceIds,
      droppedEvidenceIds: [...droppedEvidenceIds].sort(),
      warningCount: warnings.length,
    },
  };

  return {
    contextPack,
    selectedEvidenceIds,
    droppedEvidenceIds: [...droppedEvidenceIds].sort(),
    warnings,
  };
};

export class CodaliContextPackBuilder {
  constructor(private readonly options: CodaliContextPackBuilderOptions) {}

  async buildAndPersist(
    input: CodaliContextPackBuildAndPersistInput,
  ): Promise<CodaliContextPackBuildResult> {
    const trace = await this.options.store.readRunTrace(input.runId);
    if (!trace) {
      throw new Error(`GATEWAY_RUN_NOT_FOUND: ${input.runId}`);
    }
    const result = buildCodaliContextPack({
      runId: input.runId,
      request: input.request,
      trace,
      verification: input.verification,
      maxContextPackTokens: input.maxContextPackTokens,
      maxDecisionFacts: input.maxDecisionFacts ?? this.options.maxDecisionFacts,
      maxExcerptChars: input.maxExcerptChars ?? this.options.maxExcerptChars,
    });
    const saved = await this.options.store.saveContextPack(input.runId, result.contextPack);
    return {
      ...result,
      contextPack: saved,
    };
  }
}

export const createCodaliContextPackBuilder = (
  options: CodaliContextPackBuilderOptions,
): CodaliContextPackBuilder => new CodaliContextPackBuilder(options);
