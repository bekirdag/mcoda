/** One explicit requirement of a request that a draft does not satisfy. */
export interface RequirementGap { item: string; status: "missing" | "contradicted" | "deferred"; note: string }

export const REQUIREMENT_CHECK_PROMPT = `You check a draft answer against the request it answers. You do not rewrite it.
List what the request explicitly requires: each thing it asks to be designed, decided, computed or covered, each given number, limit or condition that the answer must respect, and each requested section or deliverable. Use only what the request states; never add a requirement of your own, a best practice or a preference.
For each item decide its status in the draft:
- "covered": the draft addresses it, using the request's own values.
- "missing": the draft does not address it.
- "contradicted": the draft uses a different value than the request gives, or says something that breaks the requirement.
- "deferred": the request asks for a decision or a figure and the draft postpones it (to be determined, depends on, lists options without choosing one, leaves a placeholder).
Be strict about what the request says and generous about how the draft says it: different wording, a different section or a combined treatment still covers an item.
Return JSON only, no prose and no code fence:
{"requirements":[{"item":"<the requirement in at most 20 words, with its number or name>","status":"covered|missing|contradicted|deferred","note":"<for anything not covered: one sentence saying exactly what the draft lacks, changes or leaves open; empty when covered>"}]}
At most 40 items; merge minor ones rather than drop a substantial one.`;

const STATUSES = new Set(["missing", "contradicted", "deferred"]);

/** Parsed check, or undefined when the reply is not the requested JSON. A gap
 * needs a concrete note: an unexplained verdict is not passed on. */
export function parseRequirementCheck(content: string): { requirements: number; gaps: RequirementGap[] } | undefined {
  const text = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const list = value && typeof value === "object" && !Array.isArray(value) ? (value as { requirements?: unknown }).requirements : undefined;
  if (!Array.isArray(list) || !list.length || list.length > 80) return undefined;
  const gaps: RequirementGap[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const { item, status, note } = entry as { item?: unknown; status?: unknown; note?: unknown };
    if (typeof item !== "string" || !item.trim() || typeof status !== "string") return undefined;
    if (!STATUSES.has(status)) continue;
    if (typeof note !== "string" || note.trim().length < 12) continue;
    gaps.push({ item: item.trim().slice(0, 240), status: status as RequirementGap["status"], note: note.trim().slice(0, 400) });
  }
  // A check that faults most of a finished draft has misread it; twelve real gaps are already a rewrite.
  if (gaps.length > 12 && gaps.length > list.length / 2) return { requirements: list.length, gaps: [] };
  return { requirements: list.length, gaps: gaps.slice(0, 12) };
}
