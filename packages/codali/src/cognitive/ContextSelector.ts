import type {
  ContextImpactSummary,
  ContextSelection,
  ContextSelectionDroppedEntry,
  ContextSelectionEntry,
  ContextSelectionReasonSummary,
  RetrievalReasonCode,
} from "./Types.js";
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

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const STYLE_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
]);

const FRONTEND_SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

const FRONTEND_DIR_HINT_PATTERN = /(^|\/)(public|frontend|client|web|ui)(\/|$)/i;
const INFRA_PATH_PATTERN =
  /(^|\/)(\.github\/workflows|\.github\/actions|\.circleci|buildkite|jenkins|infra|deploy|ops|k8s|kubernetes|helm|terraform|ansible)(\/|$)/i;
const INFRA_FILE_PATTERN =
  /(dockerfile|docker-compose|compose\.ya?ml|makefile|\.gitlab-ci\.ya?ml)$/i;
const SECURITY_PATH_PATTERN =
  /(^|\/)(auth|security|permissions?|rbac|acl|policy|oauth|jwt|sso|crypto|secrets?)(\/|$|[._-])/i;
const PERFORMANCE_PATH_PATTERN =
  /(^|\/)(perf|performance|benchmark|profil(e|ing)|cache|rate[-_]?limit|throttle|batch|queue)(\/|$|[._-])/i;
const OBSERVABILITY_PATH_PATTERN =
  /(^|\/)(log|logger|metrics?|monitor|monitoring|trace|tracing|otel|sentry|datadog|prometheus|grafana|alert)(\/|$|[._-])/i;

const isFrontendFile = (value: string): boolean => {
  const normalized = value.toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = normalized.slice(dot);
  if (FRONTEND_EXTENSIONS.has(ext)) return true;
  return FRONTEND_SCRIPT_EXTENSIONS.has(ext) && FRONTEND_DIR_HINT_PATTERN.test(normalized);
};

const isHtmlPath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  return HTML_EXTENSIONS.has(normalized.slice(dot));
};

const isStylePath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  return STYLE_EXTENSIONS.has(normalized.slice(dot));
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

const isInfraPath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return INFRA_PATH_PATTERN.test(normalized) || INFRA_FILE_PATTERN.test(normalized);
};

const isSecurityPath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return SECURITY_PATH_PATTERN.test(normalized);
};

const isPerformancePath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return PERFORMANCE_PATH_PATTERN.test(normalized);
};

const isObservabilityPath = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return OBSERVABILITY_PATH_PATTERN.test(normalized);
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

const addReason = (
  reasonMap: Map<string, Set<RetrievalReasonCode>>,
  path: string,
  reason: RetrievalReasonCode,
): void => {
  const normalized = path.trim();
  if (!normalized) return;
  const existing = reasonMap.get(normalized);
  if (existing) {
    existing.add(reason);
    return;
  }
  reasonMap.set(normalized, new Set<RetrievalReasonCode>([reason]));
};

const buildReasonSummary = (
  entries: ContextSelectionEntry[],
): ContextSelectionReasonSummary[] => {
  const counts = new Map<RetrievalReasonCode, number>();
  for (const entry of entries) {
    for (const reason of entry.inclusion_reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([code, count]) => ({ code, count }));
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
  const testingIntent = input.intent?.intents.includes("testing") ?? false;
  const infraIntent = input.intent?.intents.includes("infra") ?? false;
  const securityIntent = input.intent?.intents.includes("security") ?? false;
  const performanceIntent = input.intent?.intents.includes("performance") ?? false;
  const observabilityIntent = input.intent?.intents.includes("observability") ?? false;
  const docTask = input.docTask ?? false;

  const ranked: RankedCandidate[] = hitPaths.map((path, index) => {
    let score = 0;
    if (preferred.has(path)) score += 500;
    score += hitScores.get(path) ?? 0;
    if (uiIntent && isFrontendFile(path)) score += 120;
    if (behaviorIntent && !isDocPath(path) && !isFrontendFile(path)) score += 30;
    if (dataIntent && !isDocPath(path) && !isFrontendFile(path)) score += 20;
    if (testingIntent && isTestPath(path)) score += 120;
    if (infraIntent && isInfraPath(path)) score += 120;
    if (securityIntent && isSecurityPath(path)) score += 80;
    if (performanceIntent && isPerformancePath(path)) score += 80;
    if (observabilityIntent && isObservabilityPath(path)) score += 80;
    if (contentIntent && isDocPath(path)) score += 20;
    if (!docTask && isDocPath(path)) score -= 80;
    if (!docTask && isTestPath(path) && !behaviorIntent && !dataIntent && !testingIntent) {
      score -= 30;
    }
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
  const reasonMap = new Map<string, Set<RetrievalReasonCode>>();
  const dropped: ContextSelectionDroppedEntry[] = [];
  const maxFiles = Math.max(1, options.maxFiles);
  const focusCount = Math.max(1, options.focusCount ?? 2);
  const uiIntent = input.intent?.intents.includes("ui") ?? false;
  const preferred = unique(input.preferredFiles ?? []);
  for (const path of preferred) addReason(reasonMap, path, "preferred_file");
  for (const path of input.recentFiles ?? []) addReason(reasonMap, path, "recent_file");
  const hitScores = new Map<string, number>();
  for (const hit of input.hits) {
    if (typeof hit.path !== "string" || hit.path.length === 0) continue;
    addReason(reasonMap, hit.path, "search_hit");
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
        addReason(reasonMap, nonDocCandidate, "fallback_inserted_candidate");
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
      addReason(reasonMap, frontendCandidate, "ui_scaffold");
    }
  }

  if (uiIntent && !input.docTask) {
    const pool = unique([
      ...hitPaths,
      ...(input.recentFiles ?? []),
      ...(input.preferredFiles ?? []),
    ]);
    const needsHtml = !focus.some((entry) => isHtmlPath(entry));
    const needsStyle = !focus.some((entry) => isStylePath(entry));
    const pickCandidate = (predicate: (value: string) => boolean): string | undefined =>
      pool.find((entry) => predicate(entry) && !focus.includes(entry));
    const injectFocusCandidate = (candidate?: string): void => {
      if (!candidate) return;
      if (focus.includes(candidate)) return;
      addReason(reasonMap, candidate, "ui_scaffold");
      if (focus.length < focusCount) {
        focus = unique([candidate, ...focus]).slice(0, Math.min(focusCount, maxFiles));
        return;
      }
      const replaceIndex = focus.findIndex(
        (entry) => isDocPath(entry) || isTestPath(entry),
      );
      const targetIndex = replaceIndex >= 0 ? replaceIndex : Math.max(0, focus.length - 1);
      focus = [...focus];
      focus[targetIndex] = candidate;
    };

    if (needsHtml || needsStyle) {
      if (focusCount <= 1) {
        injectFocusCandidate(pickCandidate(isHtmlPath) ?? pickCandidate(isStylePath));
      } else {
        if (needsHtml) injectFocusCandidate(pickCandidate(isHtmlPath));
        if (needsStyle) injectFocusCandidate(pickCandidate(isStylePath));
      }
    }
  }

  for (const entry of focus) {
    if (!reasonMap.has(entry)) addReason(reasonMap, entry, "fallback_inserted_candidate");
  }

  const impactMap = buildImpactMap(input.impact);
  const peripheryCandidates: string[] = [];
  for (const focusFile of focus) {
    const impact = impactMap.get(focusFile);
    if (!impact) continue;
    const neighbors = [...impact.outbound, ...impact.inbound];
    for (const neighbor of neighbors) {
      addReason(reasonMap, neighbor, "impact_neighbor");
    }
    peripheryCandidates.push(...neighbors);
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
      if (!combined.includes(candidate)) {
        combined.push(candidate);
        addReason(reasonMap, candidate, "fallback_inserted_candidate");
      }
    }
  }
  if (input.recentFiles && combined.length < maxFiles) {
    for (const candidate of input.recentFiles) {
      if (combined.length >= maxFiles) break;
      if (!combined.includes(candidate)) {
        combined.push(candidate);
        addReason(reasonMap, candidate, "recent_file");
      }
    }
  }

  if (uiIntent && !input.docTask) {
    const hasNonFrontendCodeCandidate = combined.some(
      (path) => !isFrontendFile(path) && !isDocPath(path) && !isTestPath(path),
    );
    if (!hasNonFrontendCodeCandidate) {
      const crossSurfaceCandidate = unique([
        ...hitPaths,
        ...(input.recentFiles ?? []),
        ...(input.preferredFiles ?? []),
      ]).find((path) => !isFrontendFile(path) && !isDocPath(path) && !isTestPath(path));
      if (crossSurfaceCandidate && !combined.includes(crossSurfaceCandidate)) {
        if (combined.length < maxFiles) {
          combined.push(crossSurfaceCandidate);
          addReason(reasonMap, crossSurfaceCandidate, "fallback_inserted_candidate");
        } else {
          const replaceIndex = [...combined]
            .reverse()
            .findIndex((entry) => isDocPath(entry) || isTestPath(entry));
          if (replaceIndex >= 0) {
            const targetIndex = combined.length - 1 - replaceIndex;
            const displaced = combined[targetIndex];
            if (displaced) {
              dropped.push({
                path: displaced,
                category: isDocPath(displaced) ? "doc_heavy_demotion" : "low_signal_candidate",
                reason_code: isDocPath(displaced) ? "doc_heavy_demotion" : "low_signal_candidate",
                detail: "replaced_for_cross_surface_coverage",
              });
            }
            combined[targetIndex] = crossSurfaceCandidate;
            addReason(reasonMap, crossSurfaceCandidate, "fallback_inserted_candidate");
          }
        }
      }
    }
  }

  if (!input.docTask) {
    const maxDocPeriphery = 1;
    const maxTestPeriphery = 1;
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
        if (docCount >= maxDocPeriphery) {
          dropped.push({
            path: candidate,
            category: "doc_heavy_demotion",
            reason_code: "doc_heavy_demotion",
            detail: "non_doc_task_doc_cap",
          });
          continue;
        }
        docCount += 1;
      }
      if (isTestPath(candidate)) {
        if (testCount >= maxTestPeriphery) {
          dropped.push({
            path: candidate,
            category: "test_doc_cap",
            reason_code: "test_doc_cap",
            detail: "non_doc_task_test_cap",
          });
          continue;
        }
        testCount += 1;
      }
      filtered.push(candidate);
      if (filtered.length >= maxFiles) break;
    }
    combined.splice(0, combined.length, ...filtered.slice(0, maxFiles));
  }

  for (const candidate of hitPaths) {
    if (!combined.includes(candidate)) {
      dropped.push({
        path: candidate,
        category: "low_signal_candidate",
        reason_code: "low_signal_candidate",
      });
    }
  }

  const entries: ContextSelectionEntry[] = combined.map((path) => {
    const inclusion_reasons = Array.from(reasonMap.get(path) ?? new Set<RetrievalReasonCode>());
    if (inclusion_reasons.length === 0) inclusion_reasons.push("fallback_inserted_candidate");
    return {
      path,
      role: focus.includes(path) ? "focus" : "periphery",
      inclusion_reasons,
    };
  });

  return {
    focus,
    periphery: combined.filter((path) => !focus.includes(path)),
    all: combined,
    low_confidence: lowConfidence,
    entries,
    dropped,
    reason_summary: buildReasonSummary(entries),
  };
};
