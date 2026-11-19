const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonempty = (value: unknown): boolean => value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);

/** Keep semantic memory, not transport IDs, storage paths or empty trace counters. */
export const preparedMemory = (results: PromiseSettledResult<unknown>[]): string => results.flatMap((result, index) => {
  const lane = ["profile", "repository", "index", "continuity"][index] ?? `lane-${index}`;
  if (result.status === "rejected") return [`${lane}: unavailable (${String(result.reason).slice(0, 240)})`];
  const value = record(result.value);
  if (value.disabled) return [`${lane}: ${String(value.disabled).slice(0, 240)}`];
  if (index === 2) return []; // Identity was checked by the host; state paths are not task facts.
  let facts: unknown;
  if (index === 0) facts = Array.isArray(value.preferences) ? value.preferences.map(item => {
    const preference = record(item); return { category: preference.category, content: preference.content };
  }) : undefined;
  else if (index === 1) facts = Array.isArray(value.results) ? value.results.map(item => {
    const fact = record(item); return { content: fact.content, source: fact.source ?? fact.path };
  }) : undefined;
  else facts = Object.fromEntries(["text", "working_memory", "episodic_summaries", "knowledge_facts", "knowledge_edges", "transcript_snippets"].filter(key => nonempty(value[key])).map(key => [key, value[key]]));
  if (!nonempty(facts) || typeof facts === "object" && !Array.isArray(facts) && !Object.keys(facts as object).length) return [];
  const text = JSON.stringify(facts);
  return [`${lane}: ${text.length <= 2500 ? text : text.slice(0, 2450) + " … [additional memory omitted]"}`];
}).join("\n") || "No relevant saved memory.";
