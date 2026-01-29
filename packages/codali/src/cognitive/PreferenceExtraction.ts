import type { ContextPreferenceDetected } from "./Types.js";

const uniquePreferences = (entries: ContextPreferenceDetected[]): ContextPreferenceDetected[] => {
  const seen = new Set<string>();
  const result: ContextPreferenceDetected[] = [];
  for (const entry of entries) {
    const key = `${entry.category}:${entry.content}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
};

const extractFromLine = (line: string): ContextPreferenceDetected[] => {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const matches: ContextPreferenceDetected[] = [];

  const preferMatch = trimmed.match(/^(?:preference|prefer)\s*:?\s*(.+)$/i);
  if (preferMatch?.[1]) {
    matches.push({ category: "preference", content: preferMatch[1].trim() });
  }

  const avoidMatch = trimmed.match(/^(?:avoid|do not use|don't use|never use)\s*:?\s*(.+)$/i);
  if (avoidMatch?.[1]) {
    matches.push({ category: "constraint", content: avoidMatch[1].trim() });
  }

  if (!avoidMatch) {
    const inlineAvoid = trimmed.match(/(?:do not use|don't use|avoid)\s+([^.;]+)/i);
    if (inlineAvoid?.[1]) {
      matches.push({ category: "constraint", content: inlineAvoid[1].trim() });
    }
  }

  return matches;
};

export const extractPreferences = (request: string): ContextPreferenceDetected[] => {
  if (!request.trim()) return [];
  const lines = request.split(/\r?\n/);
  const entries = lines.flatMap(extractFromLine).filter((entry) => entry.content.length > 0);
  return uniquePreferences(entries);
};
