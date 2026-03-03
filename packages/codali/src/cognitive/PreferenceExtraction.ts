import type { ContextPreferenceDetected } from "./Types.js";
import { scoreLearningConfidence } from "./LearningGovernance.js";

interface PreferenceCandidate {
  category: "preference" | "constraint";
  content: string;
  source: string;
  explicit: boolean;
}

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

const toDetectedPreference = (candidate: PreferenceCandidate): ContextPreferenceDetected => {
  const confidence = scoreLearningConfidence({
    source: candidate.source,
    content: candidate.content,
    explicit: candidate.explicit,
    evidence_count: 1,
    has_revert_signal: false,
  });
  return {
    category: candidate.category,
    content: candidate.content,
    source: candidate.source,
    scope: "profile_memory",
    confidence_score: confidence.score,
    confidence_band: confidence.band,
    confidence_reasons: confidence.reasons,
  };
};

const extractFromLine = (line: string): ContextPreferenceDetected[] => {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const matches: PreferenceCandidate[] = [];

  const preferMatch = trimmed.match(/^(?:preference|prefer)\s*:?\s*(.+)$/i);
  if (preferMatch?.[1]) {
    matches.push({
      category: "preference",
      content: preferMatch[1].trim(),
      source: "request_directive_explicit_preference",
      explicit: true,
    });
  }

  const mustUseMatch = trimmed.match(/^(?:always use|must use)\s*:?\s*(.+)$/i);
  if (mustUseMatch?.[1]) {
    matches.push({
      category: "constraint",
      content: mustUseMatch[1].trim(),
      source: "request_directive_explicit_constraint",
      explicit: true,
    });
  }

  const avoidMatch = trimmed.match(/^(?:avoid|do not use|don't use|never use)\s*:?\s*(.+)$/i);
  if (avoidMatch?.[1]) {
    matches.push({
      category: "constraint",
      content: avoidMatch[1].trim(),
      source: "request_directive_explicit_constraint",
      explicit: true,
    });
  }

  if (!avoidMatch) {
    const inlineAvoid = trimmed.match(/(?:do not use|don't use|avoid)\s+([^.;]+)/i);
    if (inlineAvoid?.[1]) {
      matches.push({
        category: "constraint",
        content: inlineAvoid[1].trim(),
        source: "request_directive_inline_constraint",
        explicit: false,
      });
    }
  }

  return matches
    .filter((entry) => entry.content.length > 0)
    .map((entry) => toDetectedPreference(entry));
};

export const extractPreferences = (request: string): ContextPreferenceDetected[] => {
  if (!request.trim()) return [];
  const lines = request.split(/\r?\n/);
  const entries = lines.flatMap(extractFromLine).filter((entry) => entry.content.length > 0);
  return uniquePreferences(entries);
};
