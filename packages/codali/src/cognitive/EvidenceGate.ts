import type { DeepInvestigationEvidenceConfig } from "../config/Config.js";
import type {
  ContextResearchEvidence,
  ContextResearchToolUsage,
  EvidenceGateAssessment,
  EvidenceGateMetrics,
  EvidenceGateSignal,
} from "./Types.js";

const toNumber = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return 0;
  return value ?? 0;
};

const uniqueStrings = (values: string[]): string[] => {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
};

const buildRequiredMetrics = (
  config: DeepInvestigationEvidenceConfig,
): EvidenceGateMetrics => {
  return {
    search_hits: Math.max(0, Math.floor(toNumber(config.minSearchHits))),
    open_or_snippet: Math.max(
      0,
      Math.floor(toNumber(config.minOpenOrSnippet)),
    ),
    symbols_or_ast: Math.max(
      0,
      Math.floor(toNumber(config.minSymbolsOrAst)),
    ),
    impact: Math.max(0, Math.floor(toNumber(config.minImpact))),
    warnings: Math.max(0, Math.floor(toNumber(config.maxWarnings))),
  };
};

const buildObservedMetrics = (
  evidence?: ContextResearchEvidence,
  toolUsage?: ContextResearchToolUsage,
  warnings?: string[],
): { metrics: EvidenceGateMetrics; warningList: string[]; gaps?: string[] } => {
  const warningList = uniqueStrings([
    ...(evidence?.warnings ?? []),
    ...(warnings ?? []),
  ]);
  const searchHits = toNumber(evidence?.search_hits);
  const snippetCount = toNumber(evidence?.snippet_count);
  const symbolFiles = toNumber(evidence?.symbol_files);
  const astFiles = toNumber(evidence?.ast_files);
  const impactFiles = toNumber(evidence?.impact_files);
  const impactEdges = toNumber(evidence?.impact_edges);
  const toolOpenOrSnippet = toNumber(toolUsage?.open_or_snippet);
  const toolSymbolsOrAst = toNumber(toolUsage?.symbols_or_ast);
  const toolImpact = toNumber(toolUsage?.impact);

  const metrics: EvidenceGateMetrics = {
    search_hits: searchHits,
    open_or_snippet: Math.max(snippetCount, toolOpenOrSnippet),
    symbols_or_ast: Math.max(symbolFiles + astFiles, toolSymbolsOrAst),
    impact: Math.max(impactFiles, impactEdges, toolImpact),
    warnings: warningList.length,
  };

  return { metrics, warningList, gaps: evidence?.gaps };
};

const buildMissingSignals = (
  observed: EvidenceGateMetrics,
  required: EvidenceGateMetrics,
): EvidenceGateSignal[] => {
  const missing: EvidenceGateSignal[] = [];
  if (observed.search_hits < required.search_hits) missing.push("search_hits");
  if (observed.open_or_snippet < required.open_or_snippet) {
    missing.push("open_or_snippet");
  }
  if (observed.symbols_or_ast < required.symbols_or_ast) {
    missing.push("symbols_or_ast");
  }
  if (observed.impact < required.impact) missing.push("impact");
  if (observed.warnings > required.warnings) missing.push("warnings");
  return missing;
};

export const evaluateEvidenceGate = ({
  config,
  evidence,
  toolUsage,
  warnings,
}: {
  config: DeepInvestigationEvidenceConfig;
  evidence?: ContextResearchEvidence;
  toolUsage?: ContextResearchToolUsage;
  warnings?: string[];
}): EvidenceGateAssessment => {
  const required = buildRequiredMetrics(config);
  const { metrics: observed, warningList, gaps } = buildObservedMetrics(
    evidence,
    toolUsage,
    warnings,
  );
  const missing = buildMissingSignals(observed, required);
  const totalSignals = 5;
  const score = (totalSignals - missing.length) / totalSignals;
  const threshold = 1;
  const status: EvidenceGateAssessment["status"] =
    missing.length === 0 ? "pass" : "fail";

  return {
    status,
    score,
    threshold,
    missing,
    required,
    observed,
    warnings: warningList.length ? warningList : undefined,
    gaps,
  };
};
