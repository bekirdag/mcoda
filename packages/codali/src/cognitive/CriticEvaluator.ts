import type { ProviderMessage } from "../providers/ProviderTypes.js";
import type { GuardrailClassification, Plan, CriticReport, CriticResult } from "./Types.js";
import type { AgentRequest } from "../agents/AgentProtocol.js";
import type { ValidationRunner } from "./ValidationRunner.js";
import type { ContextManager } from "./ContextManager.js";

export interface CriticEvaluatorOptions {
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
}

const GUARDRAIL_REASON_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "scope_violation", pattern: /\bscope_violation\b/i },
  { code: "doc_edit_guard", pattern: /\bdoc_edit_guard\b/i },
  { code: "merge_conflict", pattern: /\bmerge_conflict\b/i },
];

const NON_RETRYABLE_GUARDRAIL_CODES = new Set(["scope_violation", "doc_edit_guard", "merge_conflict"]);

const detectGuardrailReasonCode = (reasons: string[]): string | undefined => {
  for (const reason of reasons) {
    for (const candidate of GUARDRAIL_REASON_PATTERNS) {
      if (candidate.pattern.test(reason)) {
        return candidate.code;
      }
    }
  }
  return undefined;
};

const buildGuardrailClassification = (reasonCode?: string): GuardrailClassification | undefined => {
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

  constructor(private validator: ValidationRunner, options: CriticEvaluatorOptions = {}) {
    this.contextManager = options.contextManager;
    this.laneId = options.laneId;
    this.model = options.model;
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
    } = {},
  ): Promise<CriticResult> {
    if (options.contextManager) this.contextManager = options.contextManager;
    if (options.laneId) this.laneId = options.laneId;
    if (options.model) this.model = options.model;
    const targetFiles = (plan.target_files ?? []).filter((file) => file !== "unknown");
    const buildReport = (
      status: "PASS" | "FAIL",
      reasons: string[],
      touched?: string[],
      guardrail?: GuardrailClassification,
    ): CriticReport => ({
      status,
      reasons,
      suggested_fixes: reasons.map((reason) => `Address: ${reason}`),
      touched_files: touched,
      plan_targets: targetFiles.length ? targetFiles : undefined,
      guardrail,
    });

    const buildFailure = (
      reasons: string[],
      touched?: string[],
      options: { reasonCode?: string; retryable?: boolean } = {},
    ): CriticResult => {
      const inferredReasonCode = options.reasonCode ?? detectGuardrailReasonCode(reasons);
      const guardrail = buildGuardrailClassification(inferredReasonCode);
      const retryable = guardrail
        ? guardrail.disposition === "retryable"
        : (options.retryable ?? true);
      return {
        status: "FAIL",
        reasons,
        retryable,
        guardrail,
        report: buildReport("FAIL", reasons, touched, guardrail),
      };
    };

    const buildRequest = (): AgentRequest => ({
      version: "v1",
      role: "critic",
      request_id: `critic-${Date.now()}`,
      needs: targetFiles.map((file) => ({ type: "file.read", path: file })),
      context: { summary: "Need target file contents to validate changes." },
    });

    if (!builderOutput.trim()) {
      const reasons = ["builder output is empty"];
      return buildFailure(reasons, touchedFiles);
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

    const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.?\//, "");
    const allowedPaths = (options.allowedPaths ?? []).map(normalizePath).filter(Boolean);
    const readOnlyPaths = (options.readOnlyPaths ?? []).map(normalizePath).filter(Boolean);
    if (effectiveTouched && effectiveTouched.length > 0) {
      const normalizedTouched = effectiveTouched.map(normalizePath);
      const readOnlyHits = readOnlyPaths.length
        ? normalizedTouched.filter((file) =>
            readOnlyPaths.some((entry) => file === entry || file.startsWith(`${entry}/`)),
          )
        : [];
      if (readOnlyHits.length) {
        const reasons = [`touched read-only paths: ${readOnlyHits.join(", ")}`];
        return buildFailure(reasons, effectiveTouched, { reasonCode: "doc_edit_guard" });
      }
      if (allowedPaths.length) {
        const allowSet = new Set(allowedPaths);
        const invalid = normalizedTouched.filter((file) => !allowSet.has(file));
        if (invalid.length) {
          const reasons = [`touched files outside allowed paths: ${invalid.join(", ")}`];
          return buildFailure(reasons, effectiveTouched, { reasonCode: "scope_violation" });
        }
      }
    }

    if (effectiveTouched && targetFiles.length > 0) {
      if (effectiveTouched.length === 0) {
        const reasons = ["no files were touched for planned targets"];
        const request = options.allowProtocolRequest ? buildRequest() : undefined;
        return {
          ...buildFailure(reasons, effectiveTouched),
          request,
        };
      }
      const touched = new Set(effectiveTouched);
      const matched = targetFiles.some((target) => touched.has(target));
      if (!matched) {
        const reasons = [
          `touched files do not match plan targets (touched: ${effectiveTouched.join(", ")})`,
        ];
        const request = options.allowProtocolRequest ? buildRequest() : undefined;
        return {
          ...buildFailure(reasons, effectiveTouched, { reasonCode: "scope_violation" }),
          request,
        };
      }
    }

    const validation = await this.validator.run(plan.verification ?? []);
    if (!validation.ok) {
      const result = buildFailure(validation.errors, effectiveTouched);
      await this.appendCriticResult(result);
      return result;
    }

    const result = {
      status: "PASS",
      reasons: [],
      retryable: false,
      report: buildReport("PASS", [], effectiveTouched),
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
