import type { ContextImpactSummary, ContextSelection } from "./Types.js";

type Hit = { path?: string; score?: number };

type ImpactMap = Map<string, ContextImpactSummary>;

export interface ContextSelectorOptions {
  maxFiles: number;
  focusCount?: number;
  minHitCount?: number;
}

export interface ContextSelectorInput {
  hits: Hit[];
  impact: ContextImpactSummary[];
  recentFiles?: string[];
  preferredFiles?: string[];
}

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const buildImpactMap = (impact: ContextImpactSummary[]): ImpactMap => {
  const map = new Map<string, ContextImpactSummary>();
  for (const entry of impact) {
    map.set(entry.file, entry);
  }
  return map;
};

export const selectContextFiles = (
  input: ContextSelectorInput,
  options: ContextSelectorOptions,
): ContextSelection => {
  const maxFiles = Math.max(1, options.maxFiles);
  const focusCount = Math.max(1, options.focusCount ?? 2);
  const preferred = unique(input.preferredFiles ?? []);
  const hitPaths = unique([
    ...preferred,
    ...input.hits
      .map((hit) => hit.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  ]);
  const minHitCount = Math.max(1, options.minHitCount ?? focusCount);
  const lowConfidence = hitPaths.length < minHitCount && preferred.length === 0;
  const focus = hitPaths.slice(0, Math.min(focusCount, maxFiles));

  const impactMap = buildImpactMap(input.impact);
  const peripheryCandidates: string[] = [];
  for (const focusFile of focus) {
    const impact = impactMap.get(focusFile);
    if (!impact) continue;
    peripheryCandidates.push(...impact.outbound, ...impact.inbound);
  }
  const periphery = unique(peripheryCandidates).filter((path) => !focus.includes(path));

  const combined: string[] = [...focus];
  for (const candidate of periphery) {
    if (combined.length >= maxFiles) break;
    combined.push(candidate);
  }
  if (combined.length < maxFiles) {
    for (const candidate of hitPaths) {
      if (combined.length >= maxFiles) break;
      if (!combined.includes(candidate)) combined.push(candidate);
    }
  }
  if (input.recentFiles && combined.length < maxFiles) {
    for (const candidate of input.recentFiles) {
      if (combined.length >= maxFiles) break;
      if (!combined.includes(candidate)) combined.push(candidate);
    }
  }

  return {
    focus,
    periphery: combined.filter((path) => !focus.includes(path)),
    all: combined,
    low_confidence: lowConfidence,
  };
};
