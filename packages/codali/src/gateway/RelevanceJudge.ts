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

export const createRelevanceJudge = (
  options: RelevanceJudgeOptions,
): RelevanceJudge => async ({ query, results }) => {
  const titles = summarizeResultTitles(results);
  // Nothing to judge; the caller's presence check already decided.
  if (titles.length === 0) return true;

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
