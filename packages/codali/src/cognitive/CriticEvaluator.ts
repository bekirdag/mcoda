import type { ProviderMessage } from "../providers/ProviderTypes.js";
import type {
  GuardrailClassification,
  GuardrailReasonCode,
  Plan,
  CriticReport,
  CriticResult,
  VerificationReport,
} from "./Types.js";
import type { AgentRequest } from "../agents/AgentProtocol.js";
import type { ValidationRunner } from "./ValidationRunner.js";
import type { ContextManager } from "./ContextManager.js";
import type { RunLogger } from "../runtime/RunLogger.js";

export interface CriticEvaluatorOptions {
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
  logger?: RunLogger;
}

const GUARDRAIL_REASON_PATTERNS: Array<{ code: GuardrailReasonCode; pattern: RegExp }> = [
  {
    code: "scope_violation",
    pattern: /\b(scope_violation|patch_outside_allowed_scope|patch_outside_workspace)\b/i,
  },
  {
    code: "doc_edit_guard",
    pattern: /\b(doc_edit_guard|patch_read_only_path)\b/i,
  },
  {
    code: "destructive_operation_guard",
    pattern: /\b(destructive_operation_guard|destructive_operation_blocked)\b/i,
  },
  { code: "merge_conflict", pattern: /\bmerge_conflict\b/i },
];

const NON_RETRYABLE_GUARDRAIL_CODES = new Set<GuardrailReasonCode>([
  "scope_violation",
  "doc_edit_guard",
  "merge_conflict",
  "destructive_operation_guard",
]);

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.?\//, "");

const dedupe = (values: string[]): string[] => Array.from(new Set(values));

const matchesPathRule = (target: string, rules: string[]): boolean =>
  rules.some((entry) => target === entry || target.startsWith(`${entry}/`));

const detectGuardrailReasonCode = (reasons: string[]): GuardrailReasonCode | undefined => {
  for (const reason of reasons) {
    for (const candidate of GUARDRAIL_REASON_PATTERNS) {
      if (candidate.pattern.test(reason)) {
        return candidate.code;
      }
    }
  }
  return undefined;
};

const buildGuardrailClassification = (
  reasonCode?: GuardrailReasonCode,
): GuardrailClassification | undefined => {
  if (!reasonCode) return undefined;
  return {
    reason_code: reasonCode,
    disposition: NON_RETRYABLE_GUARDRAIL_CODES.has(reasonCode) ? "non_retryable" : "retryable",
  };
};

export class CriticEvaluator {
  private contextManager?: ContextManager;
  private laneId?: string;
  private model?: string;
  private logger?: RunLogger;

  constructor(private validator: ValidationRunner, options: CriticEvaluatorOptions = {}) {
    this.contextManager = options.contextManager;
    this.laneId = options.laneId;
    this.model = options.model;
    this.logger = options.logger;
  }

  async evaluate(
    plan: Plan,
    builderOutput: string,
    touchedFiles?: string[],
    options: {
      contextManager?: ContextManager;
      laneId?: string;
      model?: string;
      allowedPaths?: string[];
      readOnlyPaths?: string[];
      allowProtocolRequest?: boolean;
      logger?: RunLogger;
      verificationPolicyName?: string;
      minimumVerificationChecks?: number;
      enforceHighConfidence?: boolean;
    } = {},
  ): Promise<CriticResult> {
    if (options.contextManager) this.contextManager = options.contextManager;
    if (options.laneId) this.laneId = options.laneId;
    if (options.model) this.model = options.model;
    if (options.logger) this.logger = options.logger;
    const verificationPolicyName = options.verificationPolicyName;
    const minimumVerificationChecks = options.minimumVerificationChecks;
    const enforceHighConfidence = options.enforceHighConfidence;
    let verification: VerificationReport = {
      schema_version: 1,
      outcome: "unverified_with_reason",
      reason_codes: ["verification_not_executed"],
      policy: {
        policy_name: verificationPolicyName ?? "general",
        minimum_checks: Math.max(0, Math.floor(minimumVerificationChecks ?? 0)),
        enforce_high_confidence: enforceHighConfidence ?? false,
      },
      checks: [],
      totals: {
        configured: 0,
        runnable: 0,
        attempted: 0,
        passed: 0,
        failed: 0,
        unverified: 0,
      },
      touched_files: touchedFiles,
      language_signals: [],
    };
    const targetFiles = (plan.target_files ?? []).filter((file) => file !== "unknown");
    const normalizedTargetFiles = dedupe(targetFiles.map(normalizePath).filter(Boolean));
    if (this.logger?.writePhaseArtifact) {
      await this.logger.writePhaseArtifact("verify", "plan", {
        schema_version: 1,
        policy_name: verification.policy.policy_name,
        source: "pre_validation",
        touched_files: touchedFiles ?? [],
        plan_targets: normalizedTargetFiles,
        configured_steps: plan.verification ?? [],
      });
    }
    const buildAlignmentEvidence = (
      touched?: string[],
    ): NonNullable<CriticReport["alignment_evidence"]> => {
      const normalizedTouched = dedupe((touched ?? []).map(normalizePath).filter(Boolean));
      const matchedTargets = normalizedTargetFiles.filter((target) => normalizedTouched.includes(target));
      const unmatchedTargets = normalizedTargetFiles.filter((target) => !normalizedTouched.includes(target));
      const unrelatedTouched = normalizedTouched.filter((file) => !normalizedTargetFiles.includes(file));
      return {
        touched_files: normalizedTouched,
        plan_targets: normalizedTargetFiles,
        matched_targets: matchedTargets,
        unmatched_targets: unmatchedTargets,
        unrelated_touched_files: unrelatedTouched,
      };
    };
    const buildReport = (
      status: "PASS" | "FAIL",
      reasons: string[],
      touched?: string[],
      guardrail?: GuardrailClassification,
      alignmentEvidence?: CriticReport["alignment_evidence"],
      highConfidence?: boolean,
    ): CriticReport => ({
      status,
      reasons,
      suggested_fixes: reasons.map((reason) => `Address: ${reason}`),
      touched_files: touched,
      plan_targets: targetFiles.length ? targetFiles : undefined,
      alignment_evidence: alignmentEvidence,
      guardrail,
      high_confidence: highConfidence,
      verification,
    });

    const buildFailure = (
      reasons: string[],
      touched?: string[],
      failureOptions: { reasonCode?: GuardrailReasonCode; retryable?: boolean } = {},
    ): CriticResult => {
      const inferredReasonCode = failureOptions.reasonCode ?? detectGuardrailReasonCode(reasons);
      const guardrail = buildGuardrailClassification(inferredReasonCode);
      const retryable = guardrail
        ? guardrail.disposition === "retryable"
        : (failureOptions.retryable ?? true);
      return {
        status: "FAIL",
        reasons,
        retryable,
        guardrail,
        high_confidence: false,
        report: buildReport(
          "FAIL",
          reasons,
          touched,
          guardrail,
          buildAlignmentEvidence(touched),
          false,
        ),
      };
    };

    const emitSafetyTelemetry = async (result: CriticResult): Promise<void> => {
      if (!result.guardrail || !this.logger?.logSafetyEvent) return;
      await this.logger.logSafetyEvent({
        phase: "verify",
        category: "critic",
        code: result.guardrail.reason_code,
        disposition: result.guardrail.disposition,
        source: "critic_evaluator",
        message: result.reasons.join("; ") || "critic guardrail triggered",
        details: {
          reasons: result.reasons,
        },
      });
    };

    const finalizeFailure = async (
      reasons: string[],
      touched?: string[],
      failureOptions: { reasonCode?: GuardrailReasonCode; retryable?: boolean } = {},
    ): Promise<CriticResult> => {
      const result = buildFailure(reasons, touched, failureOptions);
      await emitSafetyTelemetry(result);
      await this.appendCriticResult(result);
      return result;
    };

    const buildRequest = (): AgentRequest => ({
      version: "v1",
      role: "critic",
      request_id: `critic-${Date.now()}`,
      needs: targetFiles.map((file) => ({ type: "file.read", path: file })),
      context: { summary: "Need target file contents to validate changes." },
    });

    if (!builderOutput.trim()) {
      return finalizeFailure(["builder output is empty"], touchedFiles);
    }

    const inferTouchedFiles = (output: string): string[] | undefined => {
      const trimmed = output.trim();
      if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
        return undefined;
      }
      try {
        const payload = JSON.parse(trimmed) as Record<string, unknown>;
        const patches = Array.isArray(payload.patches) ? payload.patches : [];
        if (patches.length > 0) {
          return patches
            .map((patch) => (patch as { file?: unknown }).file)
            .filter((file): file is string => typeof file === "string" && file.length > 0);
        }
        const files = Array.isArray(payload.files) ? payload.files : [];
        if (files.length > 0) {
          return files
            .map((entry) => (entry as { path?: unknown }).path)
            .filter((file): file is string => typeof file === "string" && file.length > 0);
        }
      } catch {
        return undefined;
      }
      return undefined;
    };

    let effectiveTouched = touchedFiles;
    if ((!effectiveTouched || effectiveTouched.length === 0) && targetFiles.length > 0) {
      const inferred = inferTouchedFiles(builderOutput);
      if (inferred && inferred.length > 0) {
        effectiveTouched = inferred;
      }
    }

    const allowedPaths = dedupe((options.allowedPaths ?? []).map(normalizePath).filter(Boolean));
    const readOnlyPaths = dedupe((options.readOnlyPaths ?? []).map(normalizePath).filter(Boolean));
    if (effectiveTouched && effectiveTouched.length > 0) {
      const normalizedTouched = effectiveTouched.map(normalizePath);
      const readOnlyHits = readOnlyPaths.length
        ? normalizedTouched.filter((file) => matchesPathRule(file, readOnlyPaths))
        : [];
      if (readOnlyHits.length) {
        return finalizeFailure(
          [`touched read-only paths: ${readOnlyHits.join(", ")}`],
          effectiveTouched,
          { reasonCode: "doc_edit_guard" },
        );
      }
      if (allowedPaths.length) {
        const invalid = normalizedTouched.filter((file) => !matchesPathRule(file, allowedPaths));
        if (invalid.length) {
          return finalizeFailure(
            [`touched files outside allowed paths: ${invalid.join(", ")}`],
            effectiveTouched,
            { reasonCode: "scope_violation" },
          );
        }
      }
    }

    if (targetFiles.length === 0) {
      const reasons = ["alignment_missing_plan_targets"];
      const result = await finalizeFailure(reasons, effectiveTouched, {
        reasonCode: "scope_violation",
        retryable: false,
      });
      const request = options.allowProtocolRequest ? buildRequest() : undefined;
      return { ...result, request };
    }

    if (!effectiveTouched || effectiveTouched.length === 0) {
      const reasons = [
        "alignment_missing_evidence_no_touched_files",
        "no files were touched for planned targets",
      ];
      const result = await finalizeFailure(reasons, effectiveTouched);
      const request = options.allowProtocolRequest ? buildRequest() : undefined;
      return { ...result, request };
    }

    if (targetFiles.length > 0) {
      const normalizedTouched = new Set(effectiveTouched.map(normalizePath));
      const normalizedTargets = targetFiles.map(normalizePath);
      const matched = normalizedTargets.some((target) => normalizedTouched.has(target));
      if (!matched) {
        const reasons = [
          "alignment_mismatch_plan_targets",
          `touched files do not match plan targets (touched: ${effectiveTouched.join(", ")})`,
        ];
        const result = await finalizeFailure(reasons, effectiveTouched, {
          reasonCode: "scope_violation",
        });
        const request = options.allowProtocolRequest ? buildRequest() : undefined;
        return { ...result, request };
      }
    }

    const validation = await this.validator.run(plan.verification ?? [], {
      policyName: verificationPolicyName,
      minimumChecks: minimumVerificationChecks,
      enforceHighConfidence,
      touchedFiles: effectiveTouched,
      onResolvedPlan: async (resolvedPlan) => {
        if (!this.logger?.writePhaseArtifact) return;
        await this.logger.writePhaseArtifact("verify", "plan", {
          ...resolvedPlan,
          plan_targets: normalizedTargetFiles,
        });
      },
    });
    verification = validation.report;
    if (verification.outcome === "verified_failed") {
      return finalizeFailure(validation.errors, effectiveTouched);
    }
    if (verification.outcome === "unverified_with_reason" && verification.policy.enforce_high_confidence) {
      const reasons = verification.reason_codes.map((code) => `verification_${code}`);
      return finalizeFailure(
        reasons.length > 0 ? reasons : ["verification_unverified_with_reason"],
        effectiveTouched,
        { retryable: false },
      );
    }

    const highConfidence = verification.outcome === "verified_passed";
    const result = {
      status: "PASS",
      reasons: [],
      retryable: false,
      high_confidence: highConfidence,
      verification,
      report: buildReport(
        "PASS",
        [],
        effectiveTouched,
        undefined,
        buildAlignmentEvidence(effectiveTouched),
        highConfidence,
      ),
    } as CriticResult;
    await this.appendCriticResult(result);
    return result;
  }

  private async appendCriticResult(result: CriticResult): Promise<void> {
    if (!this.contextManager || !this.laneId) return;
    const payload = result.report ?? {
      status: result.status,
      reasons: result.reasons,
      suggested_fixes: [],
    };
    const message: ProviderMessage = {
      role: "assistant",
      content: `CRITIC_RESULT v1\n${JSON.stringify(payload, null, 2)}`,
    };
    await this.contextManager.append(this.laneId, message, { role: "critic", model: this.model });
  }
}
