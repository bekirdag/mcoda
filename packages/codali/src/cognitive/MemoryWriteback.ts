import path from "node:path";
import type { LearningConfig } from "../config/Config.js";
import type { DocdexClient } from "../docdex/DocdexClient.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import {
  DEFAULT_LEARNING_GOVERNANCE_POLICY,
  governLearningRule,
  mergeLearningRuleIntoLedger,
  promoteLearningRuleCandidate,
  readLearningRuleLedger,
  writeLearningRuleLedger,
  type LearningEvidenceReference,
  type LearningRuleProposal,
  type LearningRuleScope,
} from "./LearningGovernance.js";

export interface PreferenceWriteback {
  category: string;
  content: string;
  agentId?: string;
  source?: string;
  scope?: LearningRuleScope;
  confidence_score?: number;
  confidence_band?: "low" | "medium" | "high";
  confidence_reasons?: string[];
  evidence?: LearningEvidenceReference[];
  explicit_confirmation?: boolean;
}

export interface RulePromotionRequest {
  dedupe_key: string;
  agentId?: string;
}

export interface MemoryWritebackInput {
  failures: number;
  maxRetries: number;
  lesson: string;
  preferences?: PreferenceWriteback[];
  rules?: LearningRuleProposal[];
  promotions?: RulePromotionRequest[];
}

export interface MemoryWritebackOptions {
  agentId?: string;
  workspaceRoot?: string;
  learning?: Partial<LearningConfig>;
  logger?: RunLogger;
}

export interface LearningWriteOutcome {
  status: "accepted" | "deferred" | "suppressed" | "rejected" | "promoted";
  code: string;
  message: string;
  rule_id?: string;
  dedupe_key?: string;
  scope?: LearningRuleScope;
  lifecycle_state?: "candidate" | "enforced";
  confidence_score?: number;
  confidence_band?: "low" | "medium" | "high";
  target?: "repo_memory" | "profile_memory";
}

export interface MemoryWritebackResult {
  outcomes: LearningWriteOutcome[];
  ledgerPath: string;
}

const isUnsupportedDocdexMethod = (error: unknown): boolean => {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("unknown method") || normalized.includes("method not found");
};

const resolveLedgerPath = (workspaceRoot: string, candidateStoreFile: string): string => {
  if (path.isAbsolute(candidateStoreFile)) return candidateStoreFile;
  return path.resolve(workspaceRoot, candidateStoreFile);
};

const mapLearningPolicy = (learning?: Partial<LearningConfig>) => ({
  persistence_min_confidence:
    learning?.persistence_min_confidence
    ?? DEFAULT_LEARNING_GOVERNANCE_POLICY.persistence_min_confidence,
  enforcement_min_confidence:
    learning?.enforcement_min_confidence
    ?? DEFAULT_LEARNING_GOVERNANCE_POLICY.enforcement_min_confidence,
  require_confirmation_for_low_confidence:
    learning?.require_confirmation_for_low_confidence
    ?? DEFAULT_LEARNING_GOVERNANCE_POLICY.require_confirmation_for_low_confidence,
  auto_enforce_high_confidence:
    learning?.auto_enforce_high_confidence
    ?? DEFAULT_LEARNING_GOVERNANCE_POLICY.auto_enforce_high_confidence,
});

export class MemoryWriteback {
  private agentId: string;

  private workspaceRoot: string;

  private ledgerPath: string;

  private logger?: RunLogger;

  private policy: ReturnType<typeof mapLearningPolicy>;

  constructor(private client: DocdexClient, options: MemoryWritebackOptions = {}) {
    this.agentId = options.agentId ?? "default";
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    const candidateStoreFile = options.learning?.candidate_store_file ?? "logs/codali/learning-rules.json";
    this.ledgerPath = resolveLedgerPath(this.workspaceRoot, candidateStoreFile);
    this.policy = mapLearningPolicy(options.learning);
    this.logger = options.logger;
  }

  private async logOutcome(outcome: LearningWriteOutcome): Promise<void> {
    if (!this.logger) return;
    await this.logger.log("learning_write_decision", { ...outcome });
  }

  private toLegacyProposals(input: MemoryWritebackInput): LearningRuleProposal[] {
    const rules: LearningRuleProposal[] = [];
    if (input.failures >= input.maxRetries && input.lesson.trim()) {
      const overshoot = Math.max(0, input.failures - input.maxRetries);
      const confidence = Math.min(0.95, 0.55 + overshoot * 0.05);
      rules.push({
        category: "lesson",
        content: input.lesson.trim(),
        source: "smart_pipeline_failure_threshold",
        scope: "repo_memory",
        confidence_score: confidence,
        evidence: [{ kind: "run", ref: `failures=${input.failures};maxRetries=${input.maxRetries}` }],
      });
    }
    for (const preference of input.preferences ?? []) {
      rules.push({
        category: preference.category,
        content: preference.content,
        source: preference.source ?? "request_directive",
        scope: preference.scope,
        agent_id: preference.agentId,
        confidence_score: preference.confidence_score,
        confidence_band: preference.confidence_band,
        confidence_reasons: preference.confidence_reasons,
        evidence: preference.evidence,
        explicit_confirmation: preference.explicit_confirmation,
      });
    }
    return rules;
  }

  private async persistRuleToDocdex(rule: {
    scope: LearningRuleScope;
    category: string;
    content: string;
    lifecycle_state: "candidate" | "enforced";
    confidence_score: number;
    confidence_band: "low" | "medium" | "high";
    confidence_reasons: string[];
    evidence: LearningEvidenceReference[];
    dedupe_key: string;
    id: string;
    source: string;
    supersedes?: string[];
    agent_id?: string;
  }): Promise<void> {
    const metadata = {
      schema_version: 1,
      rule_id: rule.id,
      dedupe_key: rule.dedupe_key,
      lifecycle_state: rule.lifecycle_state,
      confidence_score: rule.confidence_score,
      confidence_band: rule.confidence_band,
      confidence_reasons: rule.confidence_reasons,
      source: rule.source,
      evidence: rule.evidence,
      supersedes: rule.supersedes,
    };
    if (rule.scope === "repo_memory") {
      try {
        await this.client.memorySave(rule.content, metadata);
      } catch (error) {
        if (!isUnsupportedDocdexMethod(error)) throw error;
        await this.client.memorySave(rule.content);
      }
      return;
    }

    const agentId = rule.agent_id ?? this.agentId;
    try {
      await this.client.savePreference(agentId, rule.category, rule.content, metadata);
    } catch (error) {
      if (!isUnsupportedDocdexMethod(error)) throw error;
      try {
        await this.client.savePreference(agentId, rule.category, rule.content);
      } catch (fallbackError) {
        if (!isUnsupportedDocdexMethod(fallbackError)) throw fallbackError;
        await this.client.memorySave(`[profile:${rule.category}] ${rule.content}`);
      }
    }
  }

  async persist(input: MemoryWritebackInput): Promise<MemoryWritebackResult> {
    const outcomes: LearningWriteOutcome[] = [];
    const proposals = [...(input.rules ?? []), ...this.toLegacyProposals(input)];
    const promotions = input.promotions ?? [];
    let ledgerChanged = false;
    const ledger = await readLearningRuleLedger(this.ledgerPath);

    for (const proposal of proposals) {
      try {
        const decision = governLearningRule(proposal, this.policy);
        const baseOutcome: LearningWriteOutcome = {
          status: decision.status,
          code: decision.code,
          message: decision.message,
          rule_id: decision.rule.id,
          dedupe_key: decision.rule.dedupe_key,
          scope: decision.rule.scope,
          lifecycle_state: decision.rule.lifecycle_state,
          confidence_score: decision.rule.confidence_score,
          confidence_band: decision.rule.confidence_band,
          target: decision.rule.scope,
        };
        if (decision.status !== "accepted") {
          outcomes.push(baseOutcome);
          await this.logOutcome(baseOutcome);
          continue;
        }

        const mergeResult = mergeLearningRuleIntoLedger(ledger, decision.rule);
        if (mergeResult.action === "suppressed") {
          const suppressed: LearningWriteOutcome = {
            ...baseOutcome,
            status: "suppressed",
            code: "dedupe_suppressed",
            message: "Duplicate or weaker learning rule was suppressed.",
            rule_id: mergeResult.rule.id,
            lifecycle_state: mergeResult.rule.lifecycle_state,
            confidence_score: mergeResult.rule.confidence_score,
            confidence_band: mergeResult.rule.confidence_band,
          };
          outcomes.push(suppressed);
          await this.logOutcome(suppressed);
          continue;
        }

        ledgerChanged = true;
        try {
          await this.persistRuleToDocdex(mergeResult.rule);
          const accepted: LearningWriteOutcome = {
            ...baseOutcome,
            status: "accepted",
            code:
              mergeResult.action === "superseded"
                ? "accepted_superseded_previous"
                : baseOutcome.code,
            message:
              mergeResult.action === "superseded"
                ? "Rule accepted and superseded previous rule."
                : baseOutcome.message,
            rule_id: mergeResult.rule.id,
            lifecycle_state: mergeResult.rule.lifecycle_state,
            confidence_score: mergeResult.rule.confidence_score,
            confidence_band: mergeResult.rule.confidence_band,
          };
          outcomes.push(accepted);
          await this.logOutcome(accepted);
        } catch (error) {
          const rejected: LearningWriteOutcome = {
            ...baseOutcome,
            status: "rejected",
            code: "docdex_write_failed",
            message: error instanceof Error ? error.message : String(error),
            rule_id: mergeResult.rule.id,
          };
          outcomes.push(rejected);
          await this.logOutcome(rejected);
        }
      } catch (error) {
        const rejected: LearningWriteOutcome = {
          status: "rejected",
          code: "governance_error",
          message: error instanceof Error ? error.message : String(error),
        };
        outcomes.push(rejected);
        await this.logOutcome(rejected);
      }
    }

    for (const promotion of promotions) {
      try {
        const result = promoteLearningRuleCandidate(ledger, promotion.dedupe_key, this.policy);
        if (result.action === "not_found") {
          const outcome: LearningWriteOutcome = {
            status: "rejected",
            code: "candidate_not_found",
            message: `No candidate rule found for ${promotion.dedupe_key}.`,
            dedupe_key: promotion.dedupe_key,
          };
          outcomes.push(outcome);
          await this.logOutcome(outcome);
          continue;
        }
        if (result.action === "already_enforced") {
          const outcome: LearningWriteOutcome = {
            status: "suppressed",
            code: "candidate_already_enforced",
            message: "Candidate is already enforced.",
            dedupe_key: promotion.dedupe_key,
            rule_id: result.previous?.id,
            lifecycle_state: result.previous?.lifecycle_state,
            scope: result.previous?.scope,
            target: result.previous?.scope,
          };
          outcomes.push(outcome);
          await this.logOutcome(outcome);
          continue;
        }

        ledgerChanged = true;
        if (!result.promoted) {
          const outcome: LearningWriteOutcome = {
            status: "rejected",
            code: "promotion_failed",
            message: "Candidate promotion failed.",
            dedupe_key: promotion.dedupe_key,
          };
          outcomes.push(outcome);
          await this.logOutcome(outcome);
          continue;
        }
        try {
          await this.persistRuleToDocdex({
            ...result.promoted,
            agent_id: promotion.agentId ?? result.promoted.agent_id,
          });
          const outcome: LearningWriteOutcome = {
            status: "promoted",
            code: "candidate_promoted",
            message: "Candidate promoted to enforced.",
            dedupe_key: result.promoted.dedupe_key,
            rule_id: result.promoted.id,
            scope: result.promoted.scope,
            lifecycle_state: result.promoted.lifecycle_state,
            confidence_score: result.promoted.confidence_score,
            confidence_band: result.promoted.confidence_band,
            target: result.promoted.scope,
          };
          outcomes.push(outcome);
          await this.logOutcome(outcome);
        } catch (error) {
          const outcome: LearningWriteOutcome = {
            status: "rejected",
            code: "promotion_write_failed",
            message: error instanceof Error ? error.message : String(error),
            dedupe_key: result.promoted.dedupe_key,
            rule_id: result.promoted.id,
          };
          outcomes.push(outcome);
          await this.logOutcome(outcome);
        }
      } catch (error) {
        const outcome: LearningWriteOutcome = {
          status: "rejected",
          code: "promotion_error",
          message: error instanceof Error ? error.message : String(error),
          dedupe_key: promotion.dedupe_key,
        };
        outcomes.push(outcome);
        await this.logOutcome(outcome);
      }
    }

    if (ledgerChanged) {
      await writeLearningRuleLedger(this.ledgerPath, ledger);
    }

    return {
      outcomes,
      ledgerPath: this.ledgerPath,
    };
  }
}
