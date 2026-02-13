import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";

export interface OpenQuestionsGateInput {
  artifacts: DocgenArtifactInventory;
}

interface ExtractedQuestion {
  text: string;
  normalized: string;
  required: boolean;
  target: string;
  record: DocArtifactRecord;
  lineNumber: number;
  heading?: string;
}

const OPTIONAL_HINTS = [
  "optional",
  "nice to have",
  "future",
  "later",
  "explore",
  "could",
  "might",
  "maybe",
];
const REQUIRED_HINTS = [
  "must",
  "required",
  "need to decide",
  "decision",
  "blocker",
  "blocking",
  "critical",
  "tbd",
  "to be determined",
];

const IMPLICIT_PATTERNS = [
  /\?$/,
  /\bshould we\b/i,
  /\bneeds? decision\b/i,
  /\bdecide (whether|if|on)\b/i,
  /\bto be determined\b/i,
  /\btbd\b/i,
  /\bopen question\b/i,
];

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const isExampleHeading = (heading: string): boolean => /example|sample/i.test(heading);

const isOpenQuestionsHeading = (heading: string): boolean =>
  /open (questions?|issues?|items?)|unresolved questions?/i.test(heading);

const RESOLVED_HINTS = [/^\s*resolved[:\]]/i, /^\s*decision:/i, /\[resolved\]/i];

const isResolvedLine = (line: string): boolean =>
  RESOLVED_HINTS.some((pattern) => pattern.test(line.trim()));

const normalizeQuestion = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const classifyRequired = (text: string, inOpenSection: boolean): boolean => {
  const lower = text.toLowerCase();
  if (lower.includes("[optional]")) return false;
  if (lower.includes("[required]")) return true;
  if (OPTIONAL_HINTS.some((hint) => lower.includes(hint))) return false;
  if (REQUIRED_HINTS.some((hint) => lower.includes(hint))) return true;
  return inOpenSection;
};

const resolveTarget = (text: string, record: DocArtifactRecord): string => {
  const lower = text.toLowerCase();
  if (/(openapi|endpoint|api|route)/i.test(lower)) return "openapi";
  if (/(schema|database|sql|table)/i.test(lower)) return "sql";
  if (/(deploy|deployment|k8s|kubernetes|docker|infra)/i.test(lower)) return "deployment";
  return record.kind;
};

const buildIssue = (question: ExtractedQuestion): ReviewIssue => {
  const severity: ReviewSeverity = question.required ? "high" : "low";
  const message = question.required
    ? `Open question requires resolution: ${question.text}`
    : `Optional exploration: ${question.text}`;
  const remediation = question.required
    ? `Resolve this decision in ${question.target}.`
    : `Consider addressing this question in ${question.target}.`;
  return {
    id: `gate-open-questions-${question.record.kind}-${question.lineNumber}`,
    gateId: "gate-open-questions",
    severity,
    category: "open_questions",
    artifact: question.record.kind,
    message,
    remediation,
    location: {
      kind: "line_range",
      path: question.record.path,
      lineStart: question.lineNumber,
      lineEnd: question.lineNumber,
      excerpt: question.text,
    },
    metadata: {
      question: question.text,
      normalized: question.normalized,
      required: question.required,
      target: question.target,
      heading: question.heading,
    },
  };
};

const cleanQuestionText = (line: string): string => {
  const trimmed = line.trim();
  const withoutBullet = trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
  return withoutBullet.trim();
};

const isImplicitQuestion = (line: string): boolean =>
  IMPLICIT_PATTERNS.some((pattern) => pattern.test(line.trim()));

const extractQuestions = async (
  record: DocArtifactRecord,
): Promise<{ questions: ExtractedQuestion[]; notes: string[] }> => {
  const notes: string[] = [];
  try {
    const content = await fs.readFile(record.path, "utf8");
    const lines = content.split(/\r?\n/);
    const questions: ExtractedQuestion[] = [];
    let inFence = false;
    let allowSection = false;
    let inOpenSection = false;
    let currentHeading: string | undefined;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        continue;
      }

      const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/);
      if (headingMatch) {
        currentHeading = headingMatch[1]?.trim() || undefined;
        allowSection = currentHeading ? isExampleHeading(currentHeading) : false;
        inOpenSection = currentHeading ? isOpenQuestionsHeading(currentHeading) : false;
        continue;
      }

      if (inFence || allowSection) continue;
      if (isResolvedLine(trimmed)) continue;

      const explicitQuestion = inOpenSection;
      const implicitQuestion = !inOpenSection && isImplicitQuestion(trimmed);
      if (!explicitQuestion && !implicitQuestion) continue;

      const questionText = cleanQuestionText(trimmed);
      if (!questionText) continue;

      const normalized = normalizeQuestion(questionText);
      if (!normalized) continue;

      questions.push({
        text: questionText,
        normalized,
        required: classifyRequired(questionText, inOpenSection),
        target: resolveTarget(questionText, record),
        record,
        lineNumber: i + 1,
        heading: currentHeading,
      });
    }

    return { questions, notes };
  } catch (error) {
    notes.push(`Unable to scan ${record.path}: ${(error as Error).message ?? String(error)}`);
    return { questions: [], notes };
  }
};

export const runOpenQuestionsGate = async (
  input: OpenQuestionsGateInput,
): Promise<ReviewGateResult> => {
  const records = [input.artifacts.pdr, input.artifacts.sds].filter(
    (record): record is DocArtifactRecord => Boolean(record),
  );
  if (records.length === 0) {
    return {
      gateId: "gate-open-questions",
      gateName: "Open Questions Extraction",
      status: "skipped",
      issues: [],
      notes: ["No PDR/SDS artifacts available for open question extraction."],
    };
  }

  const notes: string[] = [];
  const extracted: ExtractedQuestion[] = [];
  for (const record of records) {
    const result = await extractQuestions(record);
    extracted.push(...result.questions);
    notes.push(...result.notes);
  }

  const seen = new Set<string>();
  const unique: ExtractedQuestion[] = [];
  for (const question of extracted) {
    if (seen.has(question.normalized)) continue;
    seen.add(question.normalized);
    unique.push(question);
  }

  const issues = unique.map(buildIssue);
  const requiredCount = unique.filter((q) => q.required).length;
  const optionalCount = unique.length - requiredCount;
  const status = requiredCount > 0 ? "fail" : optionalCount > 0 ? "warn" : "pass";

  return {
    gateId: "gate-open-questions",
    gateName: "Open Questions Extraction",
    status,
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: {
      questionCount: unique.length,
      requiredCount,
      optionalCount,
    },
  };
};
