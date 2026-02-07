import type { DeepInvestigationToolQuotaConfig } from "../config/Config.js";
import type { EvidenceGateMetrics } from "../cognitive/Types.js";

export type DeepInvestigationErrorCode =
  | "deep_investigation_docdex_unavailable"
  | "deep_investigation_quota_unmet"
  | "deep_investigation_budget_unmet"
  | "deep_investigation_evidence_unmet";

export type DeepInvestigationErrorDetails = Record<string, unknown>;

type DeepInvestigationErrorInput = {
  code: DeepInvestigationErrorCode;
  message: string;
  remediation: string[];
  details?: DeepInvestigationErrorDetails;
  name?: string;
};

export class DeepInvestigationError extends Error {
  readonly code: DeepInvestigationErrorCode;
  readonly remediation: string[];
  readonly details?: DeepInvestigationErrorDetails;

  constructor({ code, message, remediation, details, name }: DeepInvestigationErrorInput) {
    super(message);
    this.name = name ?? "DeepInvestigationError";
    this.code = code;
    this.remediation = remediation;
    this.details = details;
  }
}

export const createDeepInvestigationDocdexError = (
  missing: string[],
  remediation: string[],
): DeepInvestigationError => {
  const message = [
    "Deep investigation requires docdex health, stats, and file coverage.",
    `Missing: ${missing.join(", ")}`,
    `Remediation: ${remediation.join(" | ")}`,
  ].join(" ");
  return new DeepInvestigationError({
    code: "deep_investigation_docdex_unavailable",
    message,
    remediation,
    details: { missing },
    name: "DeepInvestigationDocdexError",
  });
};

export const createDeepInvestigationQuotaError = (input: {
  missing: string[];
  required: DeepInvestigationToolQuotaConfig;
  observed: DeepInvestigationToolQuotaConfig;
}): DeepInvestigationError => {
  const missingList = input.missing.join(", ");
  return new DeepInvestigationError({
    code: "deep_investigation_quota_unmet",
    message: `Deep investigation tool quota unmet. Missing categories: ${missingList}`,
    remediation: [
      "Increase deepInvestigation.toolQuota requirements.",
      "Ensure the research phase executes the required docdex tools.",
    ],
    details: {
      missing: input.missing,
      required: input.required,
      observed: input.observed,
    },
  });
};

export const createDeepInvestigationBudgetError = (input: {
  minCycles: number;
  minSeconds: number;
  maxCycles: number;
  cycles: number;
  elapsedMs: number;
}): DeepInvestigationError =>
  new DeepInvestigationError({
    code: "deep_investigation_budget_unmet",
    message:
      "Deep investigation budget unmet. Increase min cycles/time or reduce requirements.",
    remediation: [
      "Increase deepInvestigation.investigationBudget minCycles/minSeconds.",
      "Reduce research requirements if budget is intentionally smaller.",
    ],
    details: { ...input },
  });

export const createDeepInvestigationEvidenceError = (input: {
  missing: string[];
  required: EvidenceGateMetrics | Record<string, number>;
  observed: EvidenceGateMetrics | Record<string, number>;
  warnings: string[];
  gaps: string[];
}): DeepInvestigationError =>
  new DeepInvestigationError({
    code: "deep_investigation_evidence_unmet",
    message:
      "Deep investigation evidence gate unmet. Increase research depth or relax evidence thresholds.",
    remediation: [
      "Increase research depth or add more docdex tool coverage.",
      "Relax deepInvestigation.evidenceGate thresholds if necessary.",
    ],
    details: { ...input },
  });
