import type { ToolDefinition } from "./ToolTypes.js";

const stop = new Set("a an and are as at be by can do for from how i in is it me of on or please that the this to use what with you your".split(" "));
const terms = (value: string): string[] => (value.normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(term => term.length > 1 && !stop.has(term)).map(term => term.length > 5 ? term.replace(/(?:ing|ed|s)$/, "") : term);

/** Generic lexical retrieval over tool metadata, not a request-type router. */
export const retrieveTools = (query: string, tools: readonly ToolDefinition[], limit = 3): Array<{ tool: ToolDefinition; score: number }> => {
  const wanted = [...new Set(terms(query))];
  if (!wanted.length) return [];
  const documents = tools.map(tool => {
    const counts = new Map<string, number>();
    for (const word of terms(`${tool.name.replace(/_/g, " ")} ${tool.name.replace(/_/g, " ")} ${tool.description} ${Object.keys(tool.inputSchema?.properties ?? {}).join(" ")}`)) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { tool, counts, length: [...counts.values()].reduce((a, b) => a + b, 0) };
  });
  const average = documents.reduce((n, doc) => n + doc.length, 0) / Math.max(1, documents.length);
  const frequencies = new Map(wanted.map(term => [term, documents.filter(doc => doc.counts.has(term)).length]));
  return documents.map(doc => ({ tool: doc.tool, score: wanted.reduce((score, term) => {
    const tf = doc.counts.get(term) ?? 0; if (!tf) return score;
    const df = frequencies.get(term)!;
    const idf = Math.log(1 + (documents.length - df + .5) / (df + .5));
    return score + idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * doc.length / Math.max(1, average)));
  }, 0) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, Math.max(0, Math.min(8, limit)));
};
