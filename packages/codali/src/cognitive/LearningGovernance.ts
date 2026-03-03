import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type LearningRuleLifecycleState = "candidate" | "enforced";
export type LearningRuleConfidenceBand = "low" | "medium" | "high";
export type LearningRuleScope = "repo_memory" | "profile_memory";
export type LearningGovernanceStatus = "accepted" | "deferred" | "rejected";

export interface LearningEvidenceReference {
  kind: "run" | "artifact" | "file" | "request" | "post_mortem" | "other";
  ref: string;
  note?: string;
}

export interface LearningRuleProposal {
  category: string;
  content: string;
  source?: string;
  scope?: LearningRuleScope;
  agent_id?: string;
  lifecycle_state?: LearningRuleLifecycleState;
  confidence_score?: number;
  confidence_band?: LearningRuleConfidenceBand;
  confidence_reasons?: string[];
  evidence?: LearningEvidenceReference[];
  explicit_confirmation?: boolean;
}

export interface LearningGovernancePolicy {
  persistence_min_confidence: number;
  enforcement_min_confidence: number;
  require_confirmation_for_low_confidence: boolean;
  auto_enforce_high_confidence: boolean;
}

export const DEFAULT_LEARNING_GOVERNANCE_POLICY: LearningGovernancePolicy = {
  persistence_min_confidence: 0.45,
  enforcement_min_confidence: 0.85,
  require_confirmation_for_low_confidence: true,
  auto_enforce_high_confidence: true,
};

export interface LearningConfidenceInput {
  source: string;
  content: string;
  explicit: boolean;
  evidence_count: number;
  has_revert_signal: boolean;
}

export interface LearningConfidenceScore {
  score: number;
  band: LearningRuleConfidenceBand;
  reasons: string[];
}

export interface GovernedLearningRule {
  schema_version: 1;
  id: string;
  dedupe_key: string;
  category: string;
  content: string;
  normalized_content: string;
  source: string;
  scope: LearningRuleScope;
  lifecycle_state: LearningRuleLifecycleState;
  confidence_score: number;
  confidence_band: LearningRuleConfidenceBand;
  confidence_reasons: string[];
  evidence: LearningEvidenceReference[];
  explicit_confirmation: boolean;
  created_at: string;
  updated_at: string;
  agent_id?: string;
  supersedes?: string[];
}

export interface LearningRuleDecision {
  status: LearningGovernanceStatus;
  code: string;
  message: string;
  rule: GovernedLearningRule;
}

export interface LearningRuleLedgerRecord extends GovernedLearningRule {
  superseded_by?: string;
  superseded_at?: string;
}

export interface LearningRuleLedger {
  schema_version: 1;
  rules: LearningRuleLedgerRecord[];
}

export interface LedgerMergeResult {
  action: "inserted" | "suppressed" | "superseded";
  rule: LearningRuleLedgerRecord;
  superseded?: LearningRuleLedgerRecord;
}

export interface LedgerPromotionResult {
  action: "promoted" | "not_found" | "already_enforced";
  promoted?: LearningRuleLedgerRecord;
  previous?: LearningRuleLedgerRecord;
}

export class LearningGovernanceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LearningGovernanceError";
    this.code = code;
  }
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizeWhitespace = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, " ");

export const normalizeLearningCategory = (value: string): string => {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    throw new LearningGovernanceError(
      "invalid_category",
      "Learning rule category is required.",
    );
  }
  if (normalized === "prefer" || normalized === "preference") return "preference";
  if (normalized === "constraint" || normalized === "rule" || normalized === "avoid") {
    return "constraint";
  }
  if (normalized === "lesson" || normalized === "failure_lesson") return "lesson";
  return normalized;
};

export const normalizeLearningText = (value: string): string => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    throw new LearningGovernanceError(
      "invalid_content",
      "Learning rule content is required.",
    );
  }
  return normalized;
};

const canonicalizeLearningText = (value: string): string =>
  normalizeLearningText(value)
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[.,;:!?]+$/g, "");

const normalizeLearningEvidence = (
  evidence: LearningEvidenceReference[] | undefined,
): LearningEvidenceReference[] => {
  if (!Array.isArray(evidence) || evidence.length === 0) return [];
  const map = new Map<string, LearningEvidenceReference>();
  for (const entry of evidence) {
    if (!entry || typeof entry !== "object") continue;
    const kind = normalizeWhitespace(String(entry.kind ?? "")).toLowerCase();
    const ref = normalizeWhitespace(String(entry.ref ?? ""));
    const note = entry.note ? normalizeWhitespace(String(entry.note)) : undefined;
    if (!kind || !ref) continue;
    const safeKind = (
      ["run", "artifact", "file", "request", "post_mortem"].includes(kind) ? kind : "other"
    ) as LearningEvidenceReference["kind"];
    const key = `${safeKind}::${ref}::${note ?? ""}`.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { kind: safeKind, ref, note });
    }
  }
  return Array.from(map.values()).sort((left, right) => {
    const leftKey = `${left.kind}:${left.ref}:${left.note ?? ""}`;
    const rightKey = `${right.kind}:${right.ref}:${right.note ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
};

const resolveScope = (
  category: string,
  scope?: LearningRuleScope,
): LearningRuleScope => {
  if (scope === "repo_memory" || scope === "profile_memory") return scope;
  if (category === "preference" || category === "constraint") return "profile_memory";
  return "repo_memory";
};

const resolveBand = (score: number): LearningRuleConfidenceBand => {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
};

export const scoreLearningConfidence = (
  input: LearningConfidenceInput,
): LearningConfidenceScore => {
  let score = 0.2;
  const reasons: string[] = [];
  if (input.explicit) {
    score += 0.4;
    reasons.push("explicit_directive");
  } else {
    reasons.push("inferred_directive");
  }
  if (input.source.includes("post_mortem")) {
    score += 0.2;
    reasons.push("post_mortem_source");
  } else if (input.source.includes("request")) {
    score += 0.15;
    reasons.push("request_source");
  }
  if (input.has_revert_signal) {
    score += 0.15;
    reasons.push("revert_signal");
  }
  if (input.evidence_count > 0) {
    const evidenceBoost = Math.min(0.2, input.evidence_count * 0.05);
    score += evidenceBoost;
    reasons.push(`evidence_count:${input.evidence_count}`);
  } else {
    reasons.push("no_evidence");
  }
  if (/(?:maybe|might|perhaps|probably|could)\b/i.test(input.content)) {
    score -= 0.2;
    reasons.push("ambiguous_language");
  }
  if (input.content.trim().length < 10) {
    score -= 0.1;
    reasons.push("short_rule_text");
  }
  const normalizedScore = clamp01(score);
  return {
    score: normalizedScore,
    band: resolveBand(normalizedScore),
    reasons,
  };
};

const createRuleId = (dedupeKey: string, now: string, lifecycle: LearningRuleLifecycleState): string =>
  `${dedupeKey}::${lifecycle}::${new Date(now).getTime()}`;

export const buildLearningDedupeKey = (
  scope: LearningRuleScope,
  category: string,
  content: string,
): string => `${scope}::${category}::${canonicalizeLearningText(content)}`;

export const governLearningRule = (
  proposal: LearningRuleProposal,
  policy: LearningGovernancePolicy = DEFAULT_LEARNING_GOVERNANCE_POLICY,
  now = new Date().toISOString(),
): LearningRuleDecision => {
  const category = normalizeLearningCategory(proposal.category);
  const content = normalizeLearningText(proposal.content);
  const source = normalizeWhitespace(proposal.source ?? "unknown_source").toLowerCase();
  const scope = resolveScope(category, proposal.scope);
  const evidence = normalizeLearningEvidence(proposal.evidence);
  const dedupeKey = buildLearningDedupeKey(scope, category, content);
  const confidence = Number.isFinite(proposal.confidence_score)
    ? clamp01(Number(proposal.confidence_score))
    : scoreLearningConfidence({
      source,
      content,
      explicit: source.includes("explicit"),
      evidence_count: evidence.length,
      has_revert_signal: source.includes("post_mortem"),
    }).score;
  const confidenceBand = proposal.confidence_band ?? resolveBand(confidence);
  const confidenceReasons = proposal.confidence_reasons?.length
    ? proposal.confidence_reasons.map((entry) => normalizeWhitespace(entry)).filter(Boolean)
    : scoreLearningConfidence({
      source,
      content,
      explicit: source.includes("explicit"),
      evidence_count: evidence.length,
      has_revert_signal: source.includes("post_mortem"),
    }).reasons;

  let lifecycleState: LearningRuleLifecycleState = "candidate";
  const explicitConfirmation = Boolean(proposal.explicit_confirmation);
  if (explicitConfirmation) {
    lifecycleState = "enforced";
  } else if (
    policy.auto_enforce_high_confidence &&
    confidence >= policy.enforcement_min_confidence &&
    (!policy.require_confirmation_for_low_confidence || confidenceBand !== "low")
  ) {
    lifecycleState = "enforced";
  }

  const rule: GovernedLearningRule = {
    schema_version: 1,
    id: createRuleId(dedupeKey, now, lifecycleState),
    dedupe_key: dedupeKey,
    category,
    content,
    normalized_content: canonicalizeLearningText(content),
    source,
    scope,
    lifecycle_state: lifecycleState,
    confidence_score: confidence,
    confidence_band: confidenceBand,
    confidence_reasons: confidenceReasons,
    evidence,
    explicit_confirmation: explicitConfirmation,
    created_at: now,
    updated_at: now,
    agent_id: proposal.agent_id,
  };

  if (confidence < policy.persistence_min_confidence) {
    return {
      status: "deferred",
      code: "confidence_below_persistence_threshold",
      message: "Rule confidence is below persistence threshold.",
      rule,
    };
  }

  return {
    status: "accepted",
    code: lifecycleState === "enforced" ? "accepted_enforced" : "accepted_candidate",
    message:
      lifecycleState === "enforced"
        ? "Rule accepted as enforced."
        : "Rule accepted as candidate.",
    rule,
  };
};

export const createEmptyLearningRuleLedger = (): LearningRuleLedger => ({
  schema_version: 1,
  rules: [],
});

const toLedgerRecord = (rule: GovernedLearningRule): LearningRuleLedgerRecord => ({ ...rule });

const isActive = (entry: LearningRuleLedgerRecord): boolean => !entry.superseded_by;

export const mergeLearningRuleIntoLedger = (
  ledger: LearningRuleLedger,
  rule: GovernedLearningRule,
): LedgerMergeResult => {
  const existing = ledger.rules.find((entry) => isActive(entry) && entry.dedupe_key === rule.dedupe_key);
  if (!existing) {
    const inserted = toLedgerRecord(rule);
    ledger.rules.push(inserted);
    return { action: "inserted", rule: inserted };
  }

  const shouldPromote =
    existing.lifecycle_state !== "enforced" && rule.lifecycle_state === "enforced";
  const confidenceDelta = rule.confidence_score - existing.confidence_score;
  const shouldReplaceByConfidence =
    existing.lifecycle_state === rule.lifecycle_state &&
    (confidenceDelta > 0.05 || rule.normalized_content !== existing.normalized_content);

  if (!shouldPromote && !shouldReplaceByConfidence) {
    return { action: "suppressed", rule: existing };
  }

  const supersededAt = rule.updated_at;
  existing.superseded_by = rule.id;
  existing.superseded_at = supersededAt;
  const inserted = toLedgerRecord({
    ...rule,
    supersedes: [...(rule.supersedes ?? []), existing.id],
  });
  ledger.rules.push(inserted);
  return { action: "superseded", rule: inserted, superseded: existing };
};

export const promoteLearningRuleCandidate = (
  ledger: LearningRuleLedger,
  dedupeKey: string,
  policy: LearningGovernancePolicy = DEFAULT_LEARNING_GOVERNANCE_POLICY,
  now = new Date().toISOString(),
): LedgerPromotionResult => {
  const active = ledger.rules.find((entry) => isActive(entry) && entry.dedupe_key === dedupeKey);
  if (!active) return { action: "not_found" };
  if (active.lifecycle_state === "enforced") {
    return { action: "already_enforced", previous: active };
  }

  const promoted: LearningRuleLedgerRecord = {
    ...active,
    id: createRuleId(active.dedupe_key, now, "enforced"),
    lifecycle_state: "enforced",
    confidence_score: Math.max(active.confidence_score, policy.enforcement_min_confidence),
    confidence_band: resolveBand(
      Math.max(active.confidence_score, policy.enforcement_min_confidence),
    ),
    explicit_confirmation: true,
    updated_at: now,
    supersedes: [...(active.supersedes ?? []), active.id],
  };
  active.superseded_by = promoted.id;
  active.superseded_at = now;
  ledger.rules.push(promoted);
  return { action: "promoted", promoted, previous: active };
};

export const readLearningRuleLedger = async (filePath: string): Promise<LearningRuleLedger> => {
  try {
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) return createEmptyLearningRuleLedger();
    const parsed = JSON.parse(content) as Partial<LearningRuleLedger>;
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.rules)) {
      return createEmptyLearningRuleLedger();
    }
    return {
      schema_version: 1,
      rules: parsed.rules.filter((entry): entry is LearningRuleLedgerRecord =>
        Boolean(entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"),
      ),
    };
  } catch {
    return createEmptyLearningRuleLedger();
  }
};

export const writeLearningRuleLedger = async (
  filePath: string,
  ledger: LearningRuleLedger,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
};
