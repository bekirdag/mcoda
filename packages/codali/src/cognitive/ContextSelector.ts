import type { ContextImpactSummary, ContextSelection } from "./Types.js";
import type { IntentSignals } from "./IntentSignals.js";

type Hit = { path?: string; score?: number };

type ImpactMap = Map<string, ContextImpactSummary>;

const FRONTEND_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".jsx",
  ".tsx",
  ".vue",
  ".svelte",
]);

const isFrontendFile = (value: string): boolean => {
  const normalized = value.toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  return FRONTEND_EXTENSIONS.has(normalized.slice(dot));
};

const isDocPath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return (
    normalized.startsWith("docs/") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx") ||
    normalized.endsWith(".rst") ||
    normalized.endsWith(".txt")
  );
};

const isTestPath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("/tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("__tests__") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.js")
  );
};

export interface ContextSelectorOptions {
  maxFiles: number;
  focusCount?: number;
  minHitCount?: number;
}

export interface ContextSelectorInput {
  hits: Hit[];
  impact: ContextImpactSummary[];
  intent?: IntentSignals;
  docTask?: boolean;
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

type RankedCandidate = {
  path: string;
  score: number;
  index: number;
};

const rankCandidates = (
  hitPaths: string[],
  hitScores: Map<string, number>,
  preferred: Set<string>,
  input: ContextSelectorInput,
): string[] => {
  const uiIntent = input.intent?.intents.includes("ui") ?? false;
  const contentIntent = input.intent?.intents.includes("content") ?? false;
  const behaviorIntent = input.intent?.intents.includes("behavior") ?? false;
  const dataIntent = input.intent?.intents.includes("data") ?? false;
  const docTask = input.docTask ?? false;

  const ranked: RankedCandidate[] = hitPaths.map((path, index) => {
    let score = 0;
    if (preferred.has(path)) score += 500;
    score += hitScores.get(path) ?? 0;
    if (uiIntent && isFrontendFile(path)) score += 120;
    if (behaviorIntent && !isDocPath(path) && !isFrontendFile(path)) score += 30;
    if (dataIntent && !isDocPath(path) && !isFrontendFile(path)) score += 20;
    if (contentIntent && isDocPath(path)) score += 20;
    if (!docTask && isDocPath(path)) score -= 80;
    if (!docTask && isTestPath(path) && !behaviorIntent && !dataIntent) score -= 30;
    return { path, score, index };
  });

  ranked.sort((a, b) => {
    if (a.score === b.score) return a.index - b.index;
    return b.score - a.score;
  });
  return ranked.map((entry) => entry.path);
};

export const selectContextFiles = (
  input: ContextSelectorInput,
  options: ContextSelectorOptions,
): ContextSelection => {
  const maxFiles = Math.max(1, options.maxFiles);
  const focusCount = Math.max(1, options.focusCount ?? 2);
  const uiIntent = input.intent?.intents.includes("ui") ?? false;
  const behaviorIntent = input.intent?.intents.includes("behavior") ?? false;
  const dataIntent = input.intent?.intents.includes("data") ?? false;
  const uiOnlyIntent = uiIntent && !behaviorIntent && !dataIntent;
  const preferred = unique(input.preferredFiles ?? []);
  const hitScores = new Map<string, number>();
  for (const hit of input.hits) {
    if (typeof hit.path !== "string" || hit.path.length === 0) continue;
    if (typeof hit.score === "number" && Number.isFinite(hit.score)) {
      const existing = hitScores.get(hit.path);
      hitScores.set(hit.path, existing === undefined ? hit.score : Math.max(existing, hit.score));
    }
  }
  let hitPaths = unique([
    ...preferred,
    ...input.hits
      .map((hit) => hit.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  ]);
  hitPaths = rankCandidates(hitPaths, hitScores, new Set(preferred), input);
  const minHitCount = Math.max(1, options.minHitCount ?? focusCount);
  const lowConfidence = hitPaths.length < minHitCount && preferred.length === 0;
  let focus = hitPaths.slice(0, Math.min(focusCount, maxFiles));
  if (!input.docTask) {
    const hasNonDoc = focus.some((entry) => !isDocPath(entry));
    if (!hasNonDoc) {
      const nonDocCandidate = hitPaths.find((entry) => !isDocPath(entry));
      if (nonDocCandidate) {
        focus = unique([nonDocCandidate, ...focus]).slice(0, Math.min(focusCount, maxFiles));
      }
    }
  }
  if (uiIntent && !input.docTask && !focus.some((entry) => isFrontendFile(entry))) {
    const frontendCandidate = unique([
      ...hitPaths,
      ...(input.recentFiles ?? []),
      ...(input.preferredFiles ?? []),
    ]).find((entry) => isFrontendFile(entry));
    if (frontendCandidate) {
      focus = unique([frontendCandidate, ...focus]).slice(0, Math.min(focusCount, maxFiles));
    }
  }

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

  if (!input.docTask) {
    const maxDocPeriphery = uiOnlyIntent ? 0 : 1;
    const maxTestPeriphery = uiOnlyIntent ? 0 : 1;
    const filtered = [...focus];
    let docCount = 0;
    let testCount = 0;
    const rankedRemainder = combined
      .filter((path) => !focus.includes(path))
      .sort((a, b) => {
        const category = (value: string): number => {
          if (uiIntent) {
            if (isFrontendFile(value)) return 0;
            if (!isDocPath(value) && !isTestPath(value)) return 1;
            if (isTestPath(value)) return 2;
            if (isDocPath(value)) return 3;
          }
          return 0;
        };
        return category(a) - category(b);
      });
    for (const candidate of rankedRemainder) {
      if (isDocPath(candidate)) {
        if (docCount >= maxDocPeriphery) continue;
        docCount += 1;
      }
      if (isTestPath(candidate)) {
        if (testCount >= maxTestPeriphery) continue;
        testCount += 1;
      }
      filtered.push(candidate);
      if (filtered.length >= maxFiles) break;
    }
    combined.splice(0, combined.length, ...filtered.slice(0, maxFiles));
  }

  return {
    focus,
    periphery: combined.filter((path) => !focus.includes(path)),
    all: combined,
    low_confidence: lowConfidence,
  };
};
