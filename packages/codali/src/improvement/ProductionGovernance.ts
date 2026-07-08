import {
  CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS,
  DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS,
  type CodaliImprovementPolicyAction,
  type CodaliImprovementReleaseLevel,
  type CodaliImprovementStorageMode,
} from "./ImprovementPolicy.js";

export const CODALI_PRODUCTION_GOVERNANCE_SCHEMA_VERSION =
  "codali.production_governance.v1" as const;

export const CODALI_PRODUCTION_GOVERNANCE_ENV_FLAGS = [
  "CODALI_DATASET_ENABLED",
  "CODALI_STORAGE_MODE",
  "CODALI_STORAGE_UPLOAD_ENABLED",
  "CODALI_IMPROVEMENT_ENABLED",
  "CODALI_IMPROVEMENT_AUTO_TAG",
  "CODALI_IMPROVEMENT_AUTO_PUBLISH",
  "CODALI_IMPROVEMENT_TRAINING_ENABLED",
  "CODALI_IMPROVEMENT_SHADOW_ONLY",
] as const;

export type CodaliProductionGovernanceEnvFlag =
  (typeof CODALI_PRODUCTION_GOVERNANCE_ENV_FLAGS)[number];

export type CodaliProductionGovernanceStorageMode =
  | "off"
  | CodaliImprovementStorageMode;

export type CodaliProductionGovernanceAction =
  | "dataset_export"
  | "service_gateway_write"
  | "improvement_analyze"
  | "improvement_eval_replay"
  | "candidate_branch"
  | "prerelease_canary"
  | "stable_publish"
  | "training";

export interface CodaliProductionGovernanceInput {
  env?: Record<string, string | undefined>;
  releaseLevel?: CodaliImprovementReleaseLevel;
  internalDeployment?: boolean;
  privacyGatesStable?: boolean;
  policyActive?: boolean;
  ciActive?: boolean;
  npmProvenanceActive?: boolean;
  storageAuditActive?: boolean;
  rollbackMonitorActive?: boolean;
  hardGatesActive?: boolean;
}

export interface CodaliProductionGovernanceEffectiveConfig {
  datasetEnabled: boolean;
  storageMode: CodaliProductionGovernanceStorageMode;
  storageUploadEnabled: boolean;
  improvementEnabled: boolean;
  trainingEnabled: boolean;
  autoTagEnabled: boolean;
  autoPublishEnabled: boolean;
  shadowOnly: boolean;
  releaseLevel: CodaliImprovementReleaseLevel;
  internalDeployment: boolean;
  privacyGatesStable: boolean;
  policyActive: boolean;
  ciActive: boolean;
  npmProvenanceActive: boolean;
  storageAuditActive: boolean;
  rollbackMonitorActive: boolean;
  hardGatesActive: boolean;
}

export interface CodaliProductionGovernanceEnvFlagState {
  name: CodaliProductionGovernanceEnvFlag;
  configured: boolean;
  configuredValue?: string;
  defaultValue: string;
  effectiveValue: string | boolean;
  disablesWhen: string;
  disableActive: boolean;
  effect: string;
}

export interface CodaliProductionGovernanceWarning {
  code: string;
  flag: string;
  value?: string;
  message: string;
}

export interface CodaliProductionGovernanceDecision {
  action: CodaliProductionGovernanceAction;
  allowed: boolean;
  reasons: string[];
  blockedBy: string[];
  requiredGates: string[];
}

export interface CodaliProductionRolloutStage {
  level: CodaliImprovementReleaseLevel;
  name: string;
  enabled: boolean;
  description: string;
  requiredGates: string[];
  allowedActions: CodaliImprovementPolicyAction[];
  blockedReasons: string[];
}

export interface CodaliProductionGovernanceState {
  schemaVersion: typeof CODALI_PRODUCTION_GOVERNANCE_SCHEMA_VERSION;
  effective: CodaliProductionGovernanceEffectiveConfig;
  emergencyDisableFlags: CodaliProductionGovernanceEnvFlagState[];
  stages: CodaliProductionRolloutStage[];
  warnings: CodaliProductionGovernanceWarning[];
}

export interface CodaliProductionGovernanceImprovementOverrides {
  dryRun?: boolean;
  storageMode?: CodaliImprovementStorageMode;
  exportEnabled?: boolean;
  trainingEnabled?: boolean;
  autoTagEnabled?: boolean;
  autoPublishEnabled?: boolean;
  blockedReasons: string[];
}

const BOOLEAN_TRUE = new Set(["1", "true", "yes", "on", "enabled"]);
const BOOLEAN_FALSE = new Set(["0", "false", "no", "off", "disabled"]);
const STORAGE_MODES = new Set<CodaliProductionGovernanceStorageMode>([
  "off",
  "local_only",
  "storage_service",
  "hybrid",
]);

const FLAG_EFFECTS: Record<CodaliProductionGovernanceEnvFlag, string> = {
  CODALI_DATASET_ENABLED: "Disables dataset collection and export when false.",
  CODALI_STORAGE_MODE:
    "Forces storage off, local_only, storage_service, or hybrid.",
  CODALI_STORAGE_UPLOAD_ENABLED:
    "Disables storage-service writes and release writebacks when false.",
  CODALI_IMPROVEMENT_ENABLED:
    "Disables auto-improvement commands when false.",
  CODALI_IMPROVEMENT_AUTO_TAG:
    "Disables automatic tag creation when false.",
  CODALI_IMPROVEMENT_AUTO_PUBLISH:
    "Disables stable auto-publish when false.",
  CODALI_IMPROVEMENT_TRAINING_ENABLED:
    "Disables training and fine-tune proposal actions when false.",
  CODALI_IMPROVEMENT_SHADOW_ONLY:
    "Forces improvement workflows into dry-run shadow mode when true.",
};

const hasConfiguredFlag = (
  env: Record<string, string | undefined>,
  flag: string,
): boolean => Object.prototype.hasOwnProperty.call(env, flag);

const normalizeFlagValue = (value: string): string =>
  value.trim().toLowerCase();

const readBooleanFlag = (
  env: Record<string, string | undefined>,
  flag: string,
  fallback: boolean,
  warnings: CodaliProductionGovernanceWarning[],
): boolean => {
  const raw = env[flag];
  if (raw === undefined) {
    return fallback;
  }
  const normalized = normalizeFlagValue(raw);
  if (BOOLEAN_TRUE.has(normalized)) {
    return true;
  }
  if (BOOLEAN_FALSE.has(normalized)) {
    return false;
  }
  warnings.push({
    code: "invalid_boolean_flag",
    flag,
    value: raw,
    message: `${flag} must be a boolean-like value; using ${String(fallback)}.`,
  });
  return fallback;
};

const readStorageModeFlag = (
  env: Record<string, string | undefined>,
  warnings: CodaliProductionGovernanceWarning[],
): CodaliProductionGovernanceStorageMode => {
  const raw = env.CODALI_STORAGE_MODE;
  if (raw === undefined) {
    return DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.storageMode;
  }
  const normalized = normalizeFlagValue(raw);
  if (STORAGE_MODES.has(normalized as CodaliProductionGovernanceStorageMode)) {
    return normalized as CodaliProductionGovernanceStorageMode;
  }
  warnings.push({
    code: "invalid_storage_mode",
    flag: "CODALI_STORAGE_MODE",
    value: raw,
    message:
      "CODALI_STORAGE_MODE must be off, local_only, storage_service, or hybrid; using local_only.",
  });
  return "local_only";
};

const readGateFlag = (
  input: CodaliProductionGovernanceInput,
  envFlag: string,
  explicit: boolean | undefined,
): boolean => {
  if (explicit !== undefined) {
    return explicit;
  }
  return readBooleanFlag(input.env ?? process.env, envFlag, false, []);
};

const flagState = (
  env: Record<string, string | undefined>,
  name: CodaliProductionGovernanceEnvFlag,
  defaultValue: string,
  effectiveValue: string | boolean,
  disablesWhen: string,
  disableActive: boolean,
): CodaliProductionGovernanceEnvFlagState => ({
  name,
  configured: hasConfiguredFlag(env, name),
  ...(env[name] === undefined ? {} : { configuredValue: env[name] }),
  defaultValue,
  effectiveValue,
  disablesWhen,
  disableActive,
  effect: FLAG_EFFECTS[name],
});

const unique = (values: string[]): string[] => Array.from(new Set(values));

const releaseLevelAtLeast = (
  actual: CodaliImprovementReleaseLevel,
  expected: CodaliImprovementReleaseLevel,
): boolean => actual >= expected;

export const resolveCodaliProductionGovernance = (
  input: CodaliProductionGovernanceInput = {},
): CodaliProductionGovernanceState => {
  const env = input.env ?? process.env;
  const warnings: CodaliProductionGovernanceWarning[] = [];
  const storageMode = readStorageModeFlag(env, warnings);
  const effective: CodaliProductionGovernanceEffectiveConfig = {
    datasetEnabled: readBooleanFlag(
      env,
      "CODALI_DATASET_ENABLED",
      true,
      warnings,
    ),
    storageMode,
    storageUploadEnabled: readBooleanFlag(
      env,
      "CODALI_STORAGE_UPLOAD_ENABLED",
      false,
      warnings,
    ),
    improvementEnabled: readBooleanFlag(
      env,
      "CODALI_IMPROVEMENT_ENABLED",
      true,
      warnings,
    ),
    trainingEnabled: readBooleanFlag(
      env,
      "CODALI_IMPROVEMENT_TRAINING_ENABLED",
      false,
      warnings,
    ),
    autoTagEnabled: readBooleanFlag(
      env,
      "CODALI_IMPROVEMENT_AUTO_TAG",
      false,
      warnings,
    ),
    autoPublishEnabled: readBooleanFlag(
      env,
      "CODALI_IMPROVEMENT_AUTO_PUBLISH",
      false,
      warnings,
    ),
    shadowOnly: readBooleanFlag(
      env,
      "CODALI_IMPROVEMENT_SHADOW_ONLY",
      false,
      warnings,
    ),
    releaseLevel:
      input.releaseLevel ?? DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.releaseLevel,
    internalDeployment: readGateFlag(
      input,
      "CODALI_IMPROVEMENT_INTERNAL_DEPLOYMENT",
      input.internalDeployment,
    ),
    privacyGatesStable: readGateFlag(
      input,
      "CODALI_PRIVACY_GATES_STABLE",
      input.privacyGatesStable,
    ),
    policyActive: readGateFlag(
      input,
      "CODALI_IMPROVEMENT_POLICY_ACTIVE",
      input.policyActive,
    ),
    ciActive: readGateFlag(input, "CODALI_IMPROVEMENT_CI_ACTIVE", input.ciActive),
    npmProvenanceActive: readGateFlag(
      input,
      "CODALI_IMPROVEMENT_NPM_PROVENANCE_ACTIVE",
      input.npmProvenanceActive,
    ),
    storageAuditActive: readGateFlag(
      input,
      "CODALI_IMPROVEMENT_STORAGE_AUDIT_ACTIVE",
      input.storageAuditActive,
    ),
    rollbackMonitorActive: readGateFlag(
      input,
      "CODALI_IMPROVEMENT_ROLLBACK_MONITOR_ACTIVE",
      input.rollbackMonitorActive,
    ),
    hardGatesActive: readGateFlag(
      input,
      "CODALI_IMPROVEMENT_HARD_GATES_ACTIVE",
      input.hardGatesActive,
    ),
  };
  const stateWithoutStages: Omit<CodaliProductionGovernanceState, "stages"> = {
    schemaVersion: CODALI_PRODUCTION_GOVERNANCE_SCHEMA_VERSION,
    effective,
    emergencyDisableFlags: [
      flagState(
        env,
        "CODALI_DATASET_ENABLED",
        "true",
        effective.datasetEnabled,
        "false",
        hasConfiguredFlag(env, "CODALI_DATASET_ENABLED") &&
          !effective.datasetEnabled,
      ),
      flagState(
        env,
        "CODALI_STORAGE_MODE",
        "local_only",
        effective.storageMode,
        "off",
        effective.storageMode === "off",
      ),
      flagState(
        env,
        "CODALI_STORAGE_UPLOAD_ENABLED",
        "false",
        effective.storageUploadEnabled,
        "false",
        hasConfiguredFlag(env, "CODALI_STORAGE_UPLOAD_ENABLED") &&
          !effective.storageUploadEnabled,
      ),
      flagState(
        env,
        "CODALI_IMPROVEMENT_ENABLED",
        "true",
        effective.improvementEnabled,
        "false",
        hasConfiguredFlag(env, "CODALI_IMPROVEMENT_ENABLED") &&
          !effective.improvementEnabled,
      ),
      flagState(
        env,
        "CODALI_IMPROVEMENT_AUTO_TAG",
        "false",
        effective.autoTagEnabled,
        "false",
        hasConfiguredFlag(env, "CODALI_IMPROVEMENT_AUTO_TAG") &&
          !effective.autoTagEnabled,
      ),
      flagState(
        env,
        "CODALI_IMPROVEMENT_AUTO_PUBLISH",
        "false",
        effective.autoPublishEnabled,
        "false",
        hasConfiguredFlag(env, "CODALI_IMPROVEMENT_AUTO_PUBLISH") &&
          !effective.autoPublishEnabled,
      ),
      flagState(
        env,
        "CODALI_IMPROVEMENT_TRAINING_ENABLED",
        "false",
        effective.trainingEnabled,
        "false",
        hasConfiguredFlag(env, "CODALI_IMPROVEMENT_TRAINING_ENABLED") &&
          !effective.trainingEnabled,
      ),
      flagState(
        env,
        "CODALI_IMPROVEMENT_SHADOW_ONLY",
        "false",
        effective.shadowOnly,
        "true",
        effective.shadowOnly,
      ),
    ],
    warnings,
  };
  const state: CodaliProductionGovernanceState = {
    ...stateWithoutStages,
    stages: buildCodaliProductionRolloutStages(stateWithoutStages),
  };
  return state;
};

export const evaluateCodaliProductionGovernanceAction = (
  governance: Pick<CodaliProductionGovernanceState, "effective">,
  action: CodaliProductionGovernanceAction,
): CodaliProductionGovernanceDecision => {
  const reasons: string[] = [];
  const blockedBy: string[] = [];
  const requiredGates: string[] = [];
  const effective = governance.effective;
  const block = (reason: string, gate?: string): void => {
    reasons.push(reason);
    if (gate) {
      blockedBy.push(gate);
      requiredGates.push(gate);
    }
  };

  if (
    action === "dataset_export" ||
    action === "service_gateway_write"
  ) {
    if (!effective.datasetEnabled) {
      block("dataset_disabled", "CODALI_DATASET_ENABLED");
    }
    if (effective.storageMode === "off") {
      block("storage_mode_off", "CODALI_STORAGE_MODE");
    }
  }

  if (action === "service_gateway_write") {
    if (
      effective.storageMode !== "storage_service" &&
      effective.storageMode !== "hybrid"
    ) {
      block("storage_service_not_enabled", "CODALI_STORAGE_MODE");
    }
    if (!effective.storageUploadEnabled) {
      block(
        "storage_upload_disabled",
        "CODALI_STORAGE_UPLOAD_ENABLED",
      );
    }
  }

  if (
    action === "improvement_analyze" ||
    action === "improvement_eval_replay" ||
    action === "candidate_branch" ||
    action === "prerelease_canary" ||
    action === "stable_publish" ||
    action === "training"
  ) {
    if (!effective.improvementEnabled) {
      block("improvement_disabled", "CODALI_IMPROVEMENT_ENABLED");
    }
  }

  if (action === "improvement_eval_replay") {
    if (!releaseLevelAtLeast(effective.releaseLevel, 1)) {
      block("release_level_below_1", "CODALI_IMPROVEMENT_RELEASE_LEVEL");
    }
  }

  if (action === "candidate_branch") {
    if (!releaseLevelAtLeast(effective.releaseLevel, 2)) {
      block("release_level_below_2", "CODALI_IMPROVEMENT_RELEASE_LEVEL");
    }
    if (!effective.privacyGatesStable) {
      block("privacy_gates_not_stable", "CODALI_PRIVACY_GATES_STABLE");
    }
  }

  if (action === "prerelease_canary") {
    if (!releaseLevelAtLeast(effective.releaseLevel, 3)) {
      block("release_level_below_3", "CODALI_IMPROVEMENT_RELEASE_LEVEL");
    }
    if (!effective.internalDeployment) {
      block(
        "internal_deployment_required",
        "CODALI_IMPROVEMENT_INTERNAL_DEPLOYMENT",
      );
    }
    if (effective.shadowOnly) {
      block("shadow_only_mode", "CODALI_IMPROVEMENT_SHADOW_ONLY");
    }
  }

  if (action === "stable_publish") {
    if (!releaseLevelAtLeast(effective.releaseLevel, 4)) {
      block("release_level_below_4", "CODALI_IMPROVEMENT_RELEASE_LEVEL");
    }
    if (!effective.autoTagEnabled) {
      block("auto_tag_disabled", "CODALI_IMPROVEMENT_AUTO_TAG");
    }
    if (!effective.autoPublishEnabled) {
      block("auto_publish_disabled", "CODALI_IMPROVEMENT_AUTO_PUBLISH");
    }
    if (!effective.policyActive) {
      block("policy_gate_inactive", "CODALI_IMPROVEMENT_POLICY_ACTIVE");
    }
    if (!effective.ciActive) {
      block("ci_gate_inactive", "CODALI_IMPROVEMENT_CI_ACTIVE");
    }
    if (!effective.npmProvenanceActive) {
      block(
        "npm_provenance_gate_inactive",
        "CODALI_IMPROVEMENT_NPM_PROVENANCE_ACTIVE",
      );
    }
    if (!effective.storageAuditActive) {
      block(
        "storage_audit_gate_inactive",
        "CODALI_IMPROVEMENT_STORAGE_AUDIT_ACTIVE",
      );
    }
    if (!effective.rollbackMonitorActive) {
      block(
        "rollback_monitor_gate_inactive",
        "CODALI_IMPROVEMENT_ROLLBACK_MONITOR_ACTIVE",
      );
    }
    if (!effective.hardGatesActive) {
      block(
        "hard_gates_inactive",
        "CODALI_IMPROVEMENT_HARD_GATES_ACTIVE",
      );
    }
    if (effective.shadowOnly) {
      block("shadow_only_mode", "CODALI_IMPROVEMENT_SHADOW_ONLY");
    }
  }

  if (action === "training") {
    if (!effective.trainingEnabled) {
      block(
        "training_disabled",
        "CODALI_IMPROVEMENT_TRAINING_ENABLED",
      );
    }
  }

  return {
    action,
    allowed: reasons.length === 0,
    reasons: unique(reasons),
    blockedBy: unique(blockedBy),
    requiredGates: unique(requiredGates),
  };
};

export const buildCodaliProductionRolloutStages = (
  governance: Pick<CodaliProductionGovernanceState, "effective">,
): CodaliProductionRolloutStage[] => {
  const stageDefinitions: Array<{
    level: CodaliImprovementReleaseLevel;
    action: CodaliProductionGovernanceAction;
    description: string;
  }> = [
    {
      level: 0,
      action: "improvement_analyze",
      description: "Local-only analysis and recommendation capture.",
    },
    {
      level: 1,
      action: "improvement_eval_replay",
      description: "Eval and replay improvements without release automation.",
    },
    {
      level: 2,
      action: "candidate_branch",
      description:
        "Candidate metadata branches after privacy gates are stable.",
    },
    {
      level: 3,
      action: "prerelease_canary",
      description: "Internal prerelease or canary automation only.",
    },
    {
      level: 4,
      action: "stable_publish",
      description:
        "Stable auto-publish only with policy, CI, provenance, audit, rollback, and hard gates.",
    },
  ];

  return stageDefinitions.map((stage) => {
    const contract = CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[stage.level];
    const decision = evaluateCodaliProductionGovernanceAction(
      governance,
      stage.action,
    );
    return {
      level: stage.level,
      name: contract.name,
      enabled: decision.allowed,
      description: stage.description,
      requiredGates: decision.requiredGates,
      allowedActions: [...contract.allowedActions],
      blockedReasons: decision.reasons,
    };
  });
};

export const getCodaliProductionGovernanceFlag = (
  governance: CodaliProductionGovernanceState,
  flag: CodaliProductionGovernanceEnvFlag,
): CodaliProductionGovernanceEnvFlagState | undefined =>
  governance.emergencyDisableFlags.find((entry) => entry.name === flag);

export const createCodaliProductionGovernanceImprovementOverrides = (
  governance: CodaliProductionGovernanceState,
): CodaliProductionGovernanceImprovementOverrides => {
  const overrides: CodaliProductionGovernanceImprovementOverrides = {
    blockedReasons: [],
  };
  const storageFlag = getCodaliProductionGovernanceFlag(
    governance,
    "CODALI_STORAGE_MODE",
  );
  if (storageFlag?.configured && governance.effective.storageMode !== "off") {
    overrides.storageMode =
      governance.effective.storageMode as CodaliImprovementStorageMode;
  }
  if (governance.effective.storageMode === "off") {
    overrides.storageMode = "local_only";
    overrides.dryRun = true;
    overrides.blockedReasons.push("storage_mode_off");
  }
  if (!governance.effective.storageUploadEnabled) {
    overrides.dryRun = true;
  }
  if (governance.effective.shadowOnly) {
    overrides.dryRun = true;
    overrides.autoTagEnabled = false;
    overrides.autoPublishEnabled = false;
  }

  const exportFlag = getCodaliProductionGovernanceFlag(
    governance,
    "CODALI_DATASET_ENABLED",
  );
  if (exportFlag?.configured) {
    overrides.exportEnabled = governance.effective.datasetEnabled;
  }

  const trainingFlag = getCodaliProductionGovernanceFlag(
    governance,
    "CODALI_IMPROVEMENT_TRAINING_ENABLED",
  );
  if (trainingFlag?.configured) {
    overrides.trainingEnabled = governance.effective.trainingEnabled;
  }

  const autoTagFlag = getCodaliProductionGovernanceFlag(
    governance,
    "CODALI_IMPROVEMENT_AUTO_TAG",
  );
  if (autoTagFlag?.configured) {
    overrides.autoTagEnabled = governance.effective.autoTagEnabled;
  }

  const autoPublishFlag = getCodaliProductionGovernanceFlag(
    governance,
    "CODALI_IMPROVEMENT_AUTO_PUBLISH",
  );
  if (autoPublishFlag?.configured) {
    overrides.autoPublishEnabled = governance.effective.autoPublishEnabled;
  }

  return overrides;
};
