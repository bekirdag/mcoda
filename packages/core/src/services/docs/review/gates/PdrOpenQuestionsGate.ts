import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { loadGlossary } from "../Glossary.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface PdrOpenQuestionsGateInput {
  artifacts: DocgenArtifactInventory;
  enabled: boolean;
}

const GENERIC_QUESTION_PATTERNS = [
  /what is the timeline/i,
  /who are the stakeholders/i,
  /what are the risks/i,
  /what is the scope/i,
  /what are the requirements/i,
  /how will we measure success/i,
  /what is the budget/i,
  /what are the next steps/i,
];

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  record: DocArtifactRecord;
  line: number;
  excerpt: string;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-pdr-open-questions-quality",
  severity: "medium",
  category: "open_questions",
  artifact: "pdr",
  message: input.message,
  remediation: input.remediation,
  location: {
    kind: "line_range",
    path: input.record.path,
    lineStart: input.line,
    lineEnd: input.line,
    excerpt: input.excerpt,
  },
  metadata: input.metadata,
});

const extractOpenQuestionLines = (lines: string[]): { text: string; line: number }[] => {
  const results: { text: string; line: number }[] = [];
  let inFence = false;
  let inSection = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const title = heading[1]?.trim() ?? "";
      if (/open questions?|open issues?|unresolved questions?/i.test(title)) {
        inSection = true;
      } else if (inSection) {
        inSection = false;
      }
      continue;
    }

    if (!inSection) continue;
    const question = trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
    if (!question) continue;
    results.push({ text: question, line: i + 1 });
  }
  return results;
};

const containsDomainTerm = (text: string, domainTerms: string[]): boolean => {
  const lower = text.toLowerCase();
  return domainTerms.some((term) => term && lower.includes(term));
};

export const runPdrOpenQuestionsGate = async (
  input: PdrOpenQuestionsGateInput,
): Promise<ReviewGateResult> => {
  if (!input.enabled) {
    return {
      gateId: "gate-pdr-open-questions-quality",
      gateName: "PDR Open Questions Quality",
      status: "skipped",
      issues: [],
      notes: ["Open question quality gate disabled."],
    };
  }

  const pdr = input.artifacts.pdr;
  if (!pdr) {
    return {
      gateId: "gate-pdr-open-questions-quality",
      gateName: "PDR Open Questions Quality",
      status: "skipped",
      issues: [],
      notes: ["No PDR artifact available for open question quality checks."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  const glossary = loadGlossary();
  const domainTerms = glossary.entries
    .flatMap((entry) => [entry.term, ...(entry.aliases ?? [])])
    .map((term) => term.toLowerCase());

  try {
    const content = await fs.readFile(pdr.path, "utf8");
    const lines = content.split(/\r?\n/);
    const questions = extractOpenQuestionLines(lines);

    for (const question of questions) {
      const isGeneric = GENERIC_QUESTION_PATTERNS.some((pattern) => pattern.test(question.text));
      if (!isGeneric) continue;
      if (containsDomainTerm(question.text, domainTerms)) continue;
      issues.push(
        buildIssue({
          id: `gate-pdr-open-questions-quality-${question.line}`,
          message: `Generic open question lacks project-specific context: ${question.text}`,
          remediation: "Replace with a question tied to the project domain (use glossary terms).",
          record: pdr,
          line: question.line,
          excerpt: question.text,
          metadata: { issueType: "generic_question" },
        }),
      );
    }
  } catch (error) {
    notes.push(`Unable to read PDR ${pdr.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-pdr-open-questions-quality",
    gateName: "PDR Open Questions Quality",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
