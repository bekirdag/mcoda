import type { Provider, ProviderMessage } from "../providers/ProviderTypes.js";
import type { RunLogger } from "../runtime/RunLogger.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "a",
  "an",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "by",
  "from",
  "is",
  "are",
  "be",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "add",
  "adds",
  "added",
  "adding",
  "change",
  "changes",
  "changed",
  "changing",
  "update",
  "updates",
  "updated",
  "updating",
  "modify",
  "modifies",
  "modified",
  "modifying",
  "make",
  "makes",
  "making",
  "create",
  "creates",
  "created",
  "creating",
  "only",
  "just",
  "please",
  "visible",
  "show",
  "shows",
  "showing",
  "display",
  "displayed",
  "touch",
  "edit",
  "edits",
  "editing",
  "fix",
  "fixes",
  "fixed",
  "fixing",
  "ensure",
  "set",
  "sets",
  "setting",
  "new",
  "develop",
  "develops",
  "developed",
  "developing",
  "engineer",
  "engineering",
  "implement",
  "implements",
  "implemented",
  "implementing",
  "build",
  "builds",
  "building",
  "built",
]);

const FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".rs",
  ".py",
  ".go",
  ".java",
  ".cs",
];

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const QUERY_EXPANDER_PROMPT = [
  "You generate concise search queries for code and docs lookup.",
  "Return JSON only. Allowed formats:",
  '1) {"queries":["q1","q2"]}',
  '2) ["q1","q2"]',
  "Max 3 queries, short phrases, no commentary.",
].join("\n");

const extractQuotedPhrases = (input: string): string[] => {
  const phrases: string[] = [];
  const regexes = [/`([^`]+)`/g, /"([^"]+)"/g, /'([^']+)'/g];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      const phrase = match[1]?.trim();
      if (phrase) phrases.push(phrase);
    }
  }
  return phrases;
};

const extractFileTokens = (input: string): string[] => {
  const tokens = input.split(/\s+/).map((token) => token.replace(/[(),.;:]+$/g, ""));
  return tokens.filter((token) => FILE_EXTENSIONS.some((ext) => token.includes(ext)));
};

const extractKeywords = (input: string): string[] => {
  return input
    .split(/\s+/)
    .map((token) => token.toLowerCase().replace(/[^a-z0-9/_-]/g, ""))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
};

const buildKeywordFallbackQueries = (request: string, keywords: string[], maxQueries: number): string[] => {
  const keyTerms = unique(keywords.filter((token) => token.length >= 4));
  const longPhrase = keyTerms.slice(0, 4).join(" ");
  const corePhrase = keyTerms.slice(0, 2).join(" ");
  const fallback = unique([
    request,
    longPhrase,
    corePhrase,
    ...keyTerms,
    ...keywords,
  ]);
  return fallback.slice(0, Math.max(1, maxQueries));
};

export const extractQueries = (input: string, maxQueries = 3): string[] => {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const phrases = extractQuotedPhrases(trimmed);
  const fileTokens = extractFileTokens(trimmed);
  const keywords = extractKeywords(trimmed);

  const hasAnchors = phrases.length > 0 || fileTokens.length > 0;
  if (!hasAnchors) {
    return buildKeywordFallbackQueries(trimmed, keywords, maxQueries);
  }

  const combined = unique([...phrases, ...fileTokens, ...keywords]);
  const limited = combined.slice(0, Math.max(1, maxQueries));
  if (!limited.includes(trimmed) && limited.length < maxQueries) {
    limited.push(trimmed);
  }
  return limited;
};

const parseExpandedQueries = (payload: unknown): string[] => {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.map((entry) => String(entry)).filter(Boolean);
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const queries = record.queries;
    if (Array.isArray(queries)) {
      return queries.map((entry) => String(entry)).filter(Boolean);
    }
  }
  return [];
};

const buildQueryMessage = (
  request: string,
  baseQueries: string[],
  maxQueries: number,
  fileHints?: string[],
): ProviderMessage => ({
  role: "user",
  content: JSON.stringify(
    {
      request,
      base_queries: baseQueries,
      max_queries: maxQueries,
      file_hints: fileHints ?? [],
    },
    null,
    2,
  ),
});

export const expandQueriesWithProvider = async (
  provider: Provider,
  request: string,
  baseQueries: string[],
  maxQueries = 3,
  temperature?: number,
  fileHints?: string[],
  logger?: RunLogger,
): Promise<string[]> => {
  const messages: ProviderMessage[] = [
    { role: "system", content: QUERY_EXPANDER_PROMPT },
    buildQueryMessage(request, baseQueries, maxQueries, fileHints),
  ];
  if (logger) {
    await logger.log("provider_request", {
      provider: provider.name,
      messages,
      responseFormat: { type: "json" },
      temperature,
    });
  }
  const response = await provider.generate({
    messages,
    responseFormat: { type: "json" },
    temperature,
  });
  const content = response.message.content?.trim() ?? "";
  if (!content) return baseQueries;
  try {
    const parsed = JSON.parse(content);
    const expanded = parseExpandedQueries(parsed);
    const merged = unique([...baseQueries, ...expanded]);
    return merged.slice(0, Math.max(1, maxQueries));
  } catch {
    return baseQueries;
  }
};
