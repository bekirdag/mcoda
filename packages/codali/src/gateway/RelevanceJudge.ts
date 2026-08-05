import type { Provider } from "../providers/ProviderTypes.js";
import type { RelevanceJudge } from "../tools/docdex/DocdexTools.js";

/**
 * Decides whether local search results actually answer the question.
 *
 * The alternative approaches are both worse:
 *
 * - **Score thresholds** do not discriminate. Measured against this repository,
 *   "GDP of France 2025" scores 29.07 while "gateway planner class" scores
 *   14.35 — the irrelevant query scores higher, because a test fixture contains
 *   the phrase. Any threshold would be arbitrary and frequently wrong.
 * - **Keyword rules** ("if the query mentions GDP or news, go to the web") are
 *   precisely the hardcoding this project rules out: they work for the examples
 *   someone thought of and fail on the next question.
 *
 * A model reading the titles is generic and costs one short call. It is asked
 * for a single token so a small local model can answer it quickly.
 */

const MAX_TITLES = 8;
const MAX_TITLE_CHARS = 90;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Reduces a result payload to a short list of titles. The judge needs to know
 * *what* was found, not the contents — sending snippets would cost more than
 * the web call being avoided.
 */
export const summarizeResultTitles = (results: unknown): string[] => {
  if (!isRecord(results)) return [];
  const hits = ["hits", "results", "matches"]
    .map((key) => results[key])
    .find((value): value is unknown[] => Array.isArray(value) && value.length > 0);
  if (!hits) return [];

  const titles: string[] = [];
  for (const hit of hits.slice(0, MAX_TITLES)) {
    if (!isRecord(hit)) continue;
    const title =
      (typeof hit.rel_path === "string" && hit.rel_path) ||
      (typeof hit.relPath === "string" && hit.relPath) ||
      (typeof hit.path === "string" && hit.path) ||
      (typeof hit.title === "string" && hit.title) ||
      (typeof hit.url === "string" && hit.url) ||
      (typeof hit.doc_id === "string" && hit.doc_id) ||
      "";
    if (title) titles.push(String(title).slice(0, MAX_TITLE_CHARS));
  }
  return titles;
};

export interface RelevanceJudgeOptions {
  provider: Provider;
  maxTokens?: number;
}

/**
 * Words too common to signal relevance on their own.
 *
 * Not a keyword rule about any subject — just the connectives that appear in
 * every question and would otherwise match any file path.
 */
const STOPWORDS = new Set([
  "what", "which", "where", "when", "does", "did", "the", "and", "for", "with",
  "from", "that", "this", "how", "why", "who", "are", "was", "were", "its",
  "class", "file", "code", "show", "list", "find", "tell", "give", "about",
  "purpose", "exists", "existence", "summary", "summarize", "explain",
]);

/**
 * Splits text into comparable words, breaking CamelCase as well as punctuation.
 *
 * A symbol name is one word to a human and several to a path. Asked "which file
 * defines CodaliGatewayPlannerError", the question yields the single term
 * `codaligatewayplannererror`, while `gateway/GatewayPlanner.ts` flattens to
 * `gateway gatewayplanner ts` — no overlap, so the correct file was discarded.
 * Splitting both sides on case boundaries puts `gateway` and `planner` on each
 * side, and the match succeeds.
 */
const wordsIn = (value: string): string[] =>
  value
    // Insert a break between a lowercase/digit and a following uppercase, so
    // `GatewayPlanner` becomes `Gateway Planner` before the lowercase pass.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // And between an acronym and a following word: `HTTPClient` -> `HTTP Client`.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether any result title shares a distinctive word with the question.
 *
 * A cheap pre-check that exists because the judge was answering obvious cases
 * wrongly and expensively: asked whether `LocalGatewayTaskRunner.ts` could
 * answer "what does LocalGatewayTaskRunner do", a small model said no, which
 * forced a 45-second web search for a local class. Lexical overlap settles
 * that case without a model call, leaving the judge for genuinely ambiguous
 * results — which is where it earns its keep.
 */
export const titlesShareTermsWithQuery = (
  query: string,
  titles: readonly string[],
): boolean => {
  const terms = wordsIn(query).filter(
    (word) => word.length > 3 && !STOPWORDS.has(word),
  );
  if (terms.length === 0) return false;

  // Whole words only. Splitting both sides the same way already lets a symbol
  // in the question meet the same symbol in a path, so a substring pass would
  // add nothing but false matches ("string" hitting `StringUtils.ts`).
  const haystack = ` ${wordsIn(titles.join(" ")).join(" ")} `;
  return terms.some((term) => haystack.includes(` ${term} `));
};

export const createRelevanceJudge = (
  options: RelevanceJudgeOptions,
): RelevanceJudge => async ({ query, results }) => {
  const titles = summarizeResultTitles(results);
  // Nothing to judge; the caller's presence check already decided.
  if (titles.length === 0) return true;

  // An obvious match needs no model call, and no chance of getting it wrong.
  if (titlesShareTermsWithQuery(query, titles)) return true;

  const response = await options.provider.generate({
    messages: [
      {
        role: "system",
        content: [
          "You decide whether local search results are relevant to a question.",
          "You are shown only the titles or file paths that were found.",
          "Answer with exactly one word: YES if these look like they could answer the question, NO if they are about something else.",
          "A repository file that merely happens to mention a word from the question is NO.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Question: ${query}`,
          "",
          "Results found locally:",
          ...titles.map((title) => `- ${title}`),
          "",
          "Could these answer the question? Reply YES or NO.",
        ].join("\n"),
      },
    ],
    toolChoice: "none",
    maxTokens: options.maxTokens ?? 5,
    temperature: 0,
  });

  const verdict = response.message.content.trim().toUpperCase();
  // Default to keeping the local result when the answer is unreadable: a
  // needless web call is a worse failure than a slightly weak local hit.
  if (verdict.startsWith("NO")) return false;
  return true;
};
