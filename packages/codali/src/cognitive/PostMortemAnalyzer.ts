import { readFile } from "node:fs/promises";
import type { Provider } from "../providers/ProviderTypes.js";
import { RunLogReader } from "../runtime/RunLogReader.js";
import {
  scoreLearningConfidence,
  type LearningEvidenceReference,
  type LearningRuleProposal,
} from "./LearningGovernance.js";

export interface PostMortemAnalysisResult {
  runId: string;
  status: "rule_extracted" | "no_change";
  message: string;
  rule?: string;
  rules: LearningRuleProposal[];
  evidence: LearningEvidenceReference[];
}

const normalizeRuleText = (value: string): string =>
  value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

const inferRuleCategory = (rule: string): "preference" | "constraint" => {
  const normalized = rule.trim().toLowerCase();
  if (
    normalized.startsWith("prefer")
    || normalized.startsWith("use ")
    || normalized.startsWith("always use")
  ) {
    return "preference";
  }
  if (
    normalized.startsWith("avoid")
    || normalized.startsWith("do not ")
    || normalized.startsWith("don't ")
    || normalized.startsWith("never ")
    || normalized.includes("do not ")
    || normalized.includes("don't ")
    || normalized.includes("avoid ")
  ) {
    return "constraint";
  }
  return "constraint";
};

const inferExplicitDirective = (rule: string): boolean =>
  /^(prefer|avoid|do not|don't|never|must|always)\b/i.test(rule.trim());

export class PostMortemAnalyzer {
  constructor(
    private provider: Provider,
    private workspaceRoot: string,
  ) {}

  async analyze(filePath: string): Promise<PostMortemAnalysisResult> {
    const reader = new RunLogReader(this.workspaceRoot);
    const runId = await reader.findLastRunForFile(filePath);
    if (!runId) {
      throw new Error(`No recent Codali run found for ${filePath}`);
    }

    const patchContent = await reader.getRunArtifact(runId, "builder-patch");
    if (!patchContent) {
      throw new Error(`Could not find builder patch for run ${runId}`);
    }

    let currentContent = "";
    try {
      currentContent = await readFile(filePath, "utf8");
    } catch {
      throw new Error(`Could not read current file ${filePath}`);
    }

    const intent = await reader.getRunIntent(runId);
    const evidence: LearningEvidenceReference[] = [
      { kind: "run", ref: runId, note: "post_mortem_comparison" },
      { kind: "file", ref: filePath },
      { kind: "artifact", ref: `phase/builder-patch:${runId}` },
    ];
    if (intent?.trim()) {
      evidence.push({ kind: "request", ref: intent.trim() });
    }

    const prompt = `
ROLE: Post-Mortem Analyst
TASK: Compare the "CODALI PATCH" (what the agent attempted) against "CURRENT FILE" (user-adjusted result).
GOAL: Extract one concise, durable coding rule that prevents this mismatch in future runs.

RUN ID:
${runId}

CODALI PATCH ARTIFACT:
${patchContent}

CURRENT FILE CONTENT:
${currentContent}

INSTRUCTIONS:
1. Determine whether the user materially changed/reverted the proposed patch.
2. If yes, return one concise rule string.
3. If no meaningful difference exists, return exactly: NO_CHANGE

OUTPUT FORMAT:
Return ONLY a single line rule string or NO_CHANGE.
`;

    const response = await this.provider.generate({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });

    const rawRule = response.message.content?.trim() ?? "";
    if (!rawRule || rawRule.toUpperCase() === "NO_CHANGE") {
      return {
        runId,
        status: "no_change",
        message: "No meaningful user deviation detected; no rule persisted.",
        rules: [],
        evidence,
      };
    }

    const rule = normalizeRuleText(rawRule);
    if (!rule) {
      return {
        runId,
        status: "no_change",
        message: "Analyzer did not produce a valid rule.",
        rules: [],
        evidence,
      };
    }

    const category = inferRuleCategory(rule);
    const explicit = inferExplicitDirective(rule);
    const confidence = scoreLearningConfidence({
      source: "post_mortem_inferred_rule",
      content: rule,
      explicit,
      evidence_count: evidence.length,
      has_revert_signal: true,
    });

    return {
      runId,
      status: "rule_extracted",
      message: "Extracted post-mortem learning rule.",
      rule,
      evidence,
      rules: [
        {
          category,
          content: rule,
          source: "post_mortem_inferred_rule",
          scope: "profile_memory",
          confidence_score: confidence.score,
          confidence_band: confidence.band,
          confidence_reasons: confidence.reasons,
          evidence,
          explicit_confirmation: false,
        },
      ],
    };
  }
}
