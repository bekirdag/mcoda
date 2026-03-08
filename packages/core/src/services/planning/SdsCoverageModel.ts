import {
  collectSdsImplementationSignals,
  normalizeFolderEntry,
  normalizeHeadingCandidate,
} from "./SdsStructureSignals.js";

const coverageStopTokens = new Set([
  "about",
  "across",
  "after",
  "before",
  "between",
  "from",
  "into",
  "over",
  "under",
  "using",
  "with",
  "without",
  "onto",
  "the",
  "and",
  "for",
  "of",
  "to",
]);

const unique = (items: string[]): string[] => Array.from(new Set(items.filter(Boolean)));

export interface SdsCoverageSignalSet {
  rawSectionHeadings: string[];
  rawFolderEntries: string[];
  sectionHeadings: string[];
  folderEntries: string[];
  skippedHeadingSignals: number;
  skippedFolderSignals: number;
}

export interface SdsCoverageSummary {
  coverageRatio: number;
  totalSignals: number;
  missingSectionHeadings: string[];
  missingFolderEntries: string[];
}

export const normalizeCoverageText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/[^a-z0-9/\s.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeCoverageAnchor = (kind: "section" | "folder", value: string): string =>
  `${kind}:${normalizeCoverageText(value).replace(/\s+/g, " ").trim()}`;

const tokenizeCoverageSignal = (value: string): string[] =>
  unique(
    value
      .split(/\s+/)
      .map((token) => token.replace(/[^a-z0-9._-]+/g, ""))
      .filter((token) => token.length >= 3 && !coverageStopTokens.has(token)),
  );

const buildBigrams = (tokens: string[]): string[] => {
  const bigrams: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (!left || !right) continue;
    bigrams.push(`${left} ${right}`);
  }
  return unique(bigrams);
};

const headingCovered = (corpus: string, heading: string): boolean => {
  const normalized = normalizeCoverageText(normalizeHeadingCandidate(heading));
  if (!normalized) return true;
  if (corpus.includes(normalized)) return true;

  const tokens = tokenizeCoverageSignal(normalized).slice(0, 10);
  if (tokens.length === 0) return true;

  const hitCount = tokens.filter((token) => corpus.includes(token)).length;
  const requiredHits =
    tokens.length <= 2
      ? tokens.length
      : tokens.length <= 4
        ? 2
        : Math.min(4, Math.ceil(tokens.length * 0.6));
  if (hitCount < requiredHits) return false;

  if (tokens.length >= 3) {
    const longestToken = tokens.reduce((longest, token) => (token.length > longest.length ? token : longest), "");
    if (longestToken.length >= 6 && !corpus.includes(longestToken)) return false;
  }

  const bigrams = buildBigrams(tokens);
  if (tokens.length >= 3 && bigrams.length > 0 && !bigrams.some((bigram) => corpus.includes(bigram))) {
    return false;
  }

  return true;
};

const folderEntryCovered = (corpus: string, entry: string): boolean => {
  const normalizedEntry = normalizeFolderEntry(entry)?.toLowerCase().replace(/\/+/g, "/");
  if (!normalizedEntry) return true;

  const corpusTight = corpus.replace(/\s+/g, "");
  if (corpusTight.includes(normalizedEntry.replace(/\s+/g, ""))) return true;

  const segments = normalizedEntry
    .split("/")
    .map((segment) => segment.trim().replace(/[^a-z0-9._-]+/g, ""))
    .filter(Boolean);
  if (segments.length === 0) return true;

  const tailSegments = unique(segments.slice(Math.max(0, segments.length - 3)));
  const hitCount = tailSegments.filter((segment) => corpus.includes(segment)).length;
  const requiredHits = tailSegments.length <= 1 ? 1 : Math.min(2, tailSegments.length);
  if (hitCount < requiredHits) return false;

  if (tailSegments.length >= 2) {
    const hasStrongTokenMatch = tailSegments.some((segment) => segment.length >= 5 && corpus.includes(segment));
    if (!hasStrongTokenMatch) return false;
  }

  return true;
};

export const collectSdsCoverageSignalsFromDocs = (
  docs: Array<{ content?: string | null }>,
  options: { headingLimit: number; folderLimit: number },
): SdsCoverageSignalSet => {
  const docSignals = docs.map((doc) =>
    collectSdsImplementationSignals(doc.content ?? "", {
      headingLimit: options.headingLimit,
      folderLimit: options.folderLimit,
    }),
  );
  const rawSectionHeadings = unique(docSignals.flatMap((signals) => signals.rawSectionHeadings));
  const rawFolderEntries = unique(docSignals.flatMap((signals) => signals.rawFolderEntries));
  const sectionHeadings = unique(docSignals.flatMap((signals) => signals.sectionHeadings)).slice(0, options.headingLimit);
  const folderEntries = unique(docSignals.flatMap((signals) => signals.folderEntries)).slice(0, options.folderLimit);
  return {
    rawSectionHeadings,
    rawFolderEntries,
    sectionHeadings,
    folderEntries,
    skippedHeadingSignals: Math.max(0, rawSectionHeadings.length - sectionHeadings.length),
    skippedFolderSignals: Math.max(0, rawFolderEntries.length - folderEntries.length),
  };
};

export const evaluateSdsCoverage = (
  corpus: string,
  signals: { sectionHeadings: string[]; folderEntries: string[] },
  existingAnchors: Set<string> = new Set(),
): SdsCoverageSummary => {
  const missingSectionHeadings = signals.sectionHeadings.filter((heading) => {
    const anchor = normalizeCoverageAnchor("section", heading);
    if (existingAnchors.has(anchor)) return false;
    return !headingCovered(corpus, heading);
  });
  const missingFolderEntries = signals.folderEntries.filter((entry) => {
    const anchor = normalizeCoverageAnchor("folder", entry);
    if (existingAnchors.has(anchor)) return false;
    return !folderEntryCovered(corpus, entry);
  });
  const totalSignals = signals.sectionHeadings.length + signals.folderEntries.length;
  const coveredSignals = totalSignals - missingSectionHeadings.length - missingFolderEntries.length;
  const coverageRatio = totalSignals === 0 ? 1 : coveredSignals / totalSignals;
  return {
    coverageRatio: Number(coverageRatio.toFixed(4)),
    totalSignals,
    missingSectionHeadings,
    missingFolderEntries,
  };
};
