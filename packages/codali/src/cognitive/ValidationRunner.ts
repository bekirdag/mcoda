import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DocdexClient } from "../docdex/DocdexClient.js";
import type {
  VerificationCheckResult,
  VerificationCheckType,
  VerificationOutcome,
  VerificationPolicySummary,
  VerificationReasonCode,
  VerificationReport,
} from "./Types.js";

export interface ValidationRunnerOptions {
  allowShell: boolean;
  shellAllowlist: string[];
  workspaceRoot: string;
  docdexClient?: DocdexClient;
  shellTimeoutMs?: number;
  defaultPolicyName?: string;
  defaultMinimumChecks?: number;
  defaultEnforceHighConfidence?: boolean;
}

export interface ValidationRunOptions {
  policyName?: string;
  minimumChecks?: number;
  enforceHighConfidence?: boolean;
  touchedFiles?: string[];
  onResolvedPlan?: (plan: VerificationResolvedPlan) => Promise<void> | void;
}

type ValidationTotals = VerificationReport["totals"];

export type VerificationCheckCategory =
  | "test"
  | "lint"
  | "build"
  | "hook"
  | "unknown";

export interface VerificationResolvedCheck {
  step: string;
  check_type: VerificationCheckType;
  category: VerificationCheckCategory;
  targeted: boolean;
  source: "explicit" | "derived";
  rationale: string;
}

export interface VerificationResolvedPlan {
  schema_version: 1;
  policy_name: string;
  source: "explicit" | "derived" | "mixed";
  touched_files: string[];
  language_signals: string[];
  project_signals: string[];
  checks: VerificationResolvedCheck[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  outcome: VerificationOutcome;
  reason_codes: VerificationReasonCode[];
  checks: VerificationCheckResult[];
  policy: VerificationPolicySummary;
  touched_files: string[];
  language_signals: string[];
  totals: ValidationTotals;
  report: VerificationReport;
}

const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

const parseHookFiles = (step: string): string[] => {
  const parts = step.split(":");
  if (parts.length < 2) return [];
  return parts
    .slice(1)
    .join(":")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const detectCheckType = (step: string): VerificationCheckType => {
  if (step.startsWith("docdex:hooks") || step.startsWith("hooks:")) return "docdex_hooks";
  if (!step.trim()) return "unknown";
  return "shell";
};

const detectTargetedStep = (step: string): boolean => {
  if (!step.trim()) return false;
  if (/\b(--filter|--grep|--testPathPattern|--findRelatedTests)\b/i.test(step)) return true;
  return /(^|\s)(?:\.{0,2}\/)?[\w./-]+\.[\w-]+(\s|$)/.test(step);
};

const checkTypeOrder = (value: VerificationCheckType): number => {
  if (value === "docdex_hooks") return 0;
  if (value === "shell") return 1;
  return 2;
};

const compactText = (value: string | undefined, maxLength = 240): string | undefined => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
};

const detectLanguageSignals = (touchedFiles: string[]): string[] => {
  const signals = new Set<string>();
  for (const file of touchedFiles) {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".ts" || ext === ".tsx") signals.add("typescript");
    else if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") signals.add("javascript");
    else if (ext === ".py") signals.add("python");
    else if (ext === ".go") signals.add("go");
    else if (ext === ".rs") signals.add("rust");
    else if (ext === ".java") signals.add("java");
    else if (ext === ".rb") signals.add("ruby");
    else if (ext === ".cs") signals.add("dotnet");
  }
  return [...signals].sort();
};

const detectProjectSignals = (workspaceRoot: string): string[] => {
  const has = (file: string): boolean => existsSync(path.join(workspaceRoot, file));
  const signals = new Set<string>();
  if (has(".git")) signals.add("git_repo");
  if (has("package.json")) signals.add("package_json");
  if (has("pnpm-lock.yaml") || has("pnpm-workspace.yaml")) signals.add("pnpm");
  if (has("yarn.lock")) signals.add("yarn");
  if (has("package-lock.json")) signals.add("npm_lock");
  if (has("pyproject.toml")) signals.add("pyproject");
  if (has("requirements.txt")) signals.add("requirements_txt");
  if (has("go.mod")) signals.add("go_mod");
  if (has("Cargo.toml")) signals.add("cargo_toml");
  if (has("pom.xml")) signals.add("maven");
  if (has("build.gradle") || has("build.gradle.kts")) signals.add("gradle");
  if (has(".pre-commit-config.yaml")) signals.add("pre_commit");
  return [...signals].sort();
};

const detectCategoryFromStep = (step: string): VerificationCheckCategory => {
  if (step.startsWith("docdex:hooks") || step.startsWith("hooks:")) return "hook";
  if (/\b(test|jest|vitest|pytest|go test|cargo test)\b/i.test(step)) return "test";
  if (/\b(lint|ruff|eslint)\b/i.test(step)) return "lint";
  if (/\b(build|tsc|webpack|vite build|cargo build|go build)\b/i.test(step)) return "build";
  return "unknown";
};

const normalizeExplicitChecks = (steps: string[]): VerificationResolvedCheck[] =>
  [...(Array.isArray(steps) ? steps : [])]
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index)
    .map((step) => ({
      step,
      check_type: detectCheckType(step),
      category: detectCategoryFromStep(step),
      targeted: detectTargetedStep(step),
      source: "explicit" as const,
      rationale: "plan_verification_step",
    }));

const chooseNodePackageManager = (projectSignals: string[]): "pnpm" | "yarn" | "npm" => {
  if (projectSignals.includes("pnpm")) return "pnpm";
  if (projectSignals.includes("yarn")) return "yarn";
  return "npm";
};

const deriveVerificationChecks = (input: {
  touchedFiles: string[];
  languageSignals: string[];
  projectSignals: string[];
  policyName: string;
  includeShellChecks: boolean;
}): VerificationResolvedCheck[] => {
  const checks: VerificationResolvedCheck[] = [];
  const touchedFiles = input.touchedFiles.slice(0, 12);
  const projectSignals = new Set(input.projectSignals);
  const canRunDocdexHooks = projectSignals.has("git_repo");
  if (touchedFiles.length > 0 && canRunDocdexHooks) {
    checks.push({
      step: `docdex:hooks:${touchedFiles.join(",")}`,
      check_type: "docdex_hooks",
      category: "hook",
      targeted: true,
      source: "derived",
      rationale: "touched_files_hook_validation",
    });
  }

  const languageSignals = new Set(input.languageSignals);
  const nodeTouched = input.touchedFiles
    .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file))
    .slice(0, 6);
  const pythonTouched = input.touchedFiles.filter((file) => /\.py$/i.test(file)).slice(0, 6);

  if (
    input.includeShellChecks
    && (
    languageSignals.has("typescript")
    || languageSignals.has("javascript")
    || projectSignals.has("package_json")
    )
  ) {
    const manager = chooseNodePackageManager(input.projectSignals);
    const testStep = manager === "pnpm"
      ? nodeTouched.length > 0
        ? `pnpm test -- --findRelatedTests ${nodeTouched.join(" ")}`
        : "pnpm test"
      : manager === "yarn"
        ? nodeTouched.length > 0
          ? `yarn test ${nodeTouched.join(" ")}`
          : "yarn test"
        : nodeTouched.length > 0
          ? `npm test -- ${nodeTouched.join(" ")}`
          : "npm test";
    checks.push({
      step: testStep,
      check_type: "shell",
      category: "test",
      targeted: nodeTouched.length > 0,
      source: "derived",
      rationale: "language_or_project_signal_node",
    });
    checks.push({
      step: manager === "pnpm" ? "pnpm lint" : manager === "yarn" ? "yarn lint" : "npm run lint",
      check_type: "shell",
      category: "lint",
      targeted: false,
      source: "derived",
      rationale: "language_or_project_signal_node",
    });
    checks.push({
      step: manager === "pnpm" ? "pnpm build" : manager === "yarn" ? "yarn build" : "npm run build",
      check_type: "shell",
      category: "build",
      targeted: false,
      source: "derived",
      rationale: "language_or_project_signal_node",
    });
  }

  if (input.includeShellChecks && (languageSignals.has("python") || projectSignals.has("pyproject"))) {
    checks.push({
      step: pythonTouched.length > 0 ? `pytest ${pythonTouched.join(" ")}` : "pytest",
      check_type: "shell",
      category: "test",
      targeted: pythonTouched.length > 0,
      source: "derived",
      rationale: "language_or_project_signal_python",
    });
    checks.push({
      step: pythonTouched.length > 0 ? `ruff check ${pythonTouched.join(" ")}` : "ruff check .",
      check_type: "shell",
      category: "lint",
      targeted: pythonTouched.length > 0,
      source: "derived",
      rationale: "language_or_project_signal_python",
    });
  }

  if (input.includeShellChecks && (languageSignals.has("go") || projectSignals.has("go_mod"))) {
    checks.push({
      step: "go test ./...",
      check_type: "shell",
      category: "test",
      targeted: false,
      source: "derived",
      rationale: "language_or_project_signal_go",
    });
    checks.push({
      step: "go build ./...",
      check_type: "shell",
      category: "build",
      targeted: false,
      source: "derived",
      rationale: "language_or_project_signal_go",
    });
  }

  if (input.includeShellChecks && (languageSignals.has("rust") || projectSignals.has("cargo_toml"))) {
    checks.push({
      step: "cargo test",
      check_type: "shell",
      category: "test",
      targeted: false,
      source: "derived",
      rationale: "language_or_project_signal_rust",
    });
    checks.push({
      step: "cargo build",
      check_type: "shell",
      category: "build",
      targeted: false,
      source: "derived",
      rationale: "language_or_project_signal_rust",
    });
  }

  if (
    checks.length === 0
    && input.policyName.toLowerCase().includes("test")
    && canRunDocdexHooks
  ) {
    checks.push({
      step: "docdex:hooks",
      check_type: "docdex_hooks",
      category: "hook",
      targeted: false,
      source: "derived",
      rationale: "policy_fallback_test_profile",
    });
  }

  return checks;
};

const mergeResolvedChecks = (
  explicitChecks: VerificationResolvedCheck[],
  derivedChecks: VerificationResolvedCheck[],
): VerificationResolvedCheck[] => {
  const merged = new Map<string, VerificationResolvedCheck>();
  for (const check of [...explicitChecks, ...derivedChecks]) {
    if (!merged.has(check.step)) {
      merged.set(check.step, check);
    }
  }
  return Array.from(merged.values());
};

export class ValidationRunner {
  private options: ValidationRunnerOptions;

  constructor(options: ValidationRunnerOptions) {
    this.options = options;
  }

  async run(steps: string[], runOptions: ValidationRunOptions = {}): Promise<ValidationResult> {
    const errors: string[] = [];
    const touchedFiles = (runOptions.touchedFiles ?? []).map((entry) => entry.trim()).filter(Boolean);
    const languageSignals = detectLanguageSignals(touchedFiles);
    const projectSignals = detectProjectSignals(this.options.workspaceRoot);
    const minimumChecks = Math.max(
      0,
      Math.floor(
        runOptions.minimumChecks
        ?? this.options.defaultMinimumChecks
        ?? 0,
      ),
    );
    const policy: VerificationPolicySummary = {
      policy_name: runOptions.policyName ?? this.options.defaultPolicyName ?? "general",
      minimum_checks: minimumChecks,
      enforce_high_confidence:
        runOptions.enforceHighConfidence
        ?? this.options.defaultEnforceHighConfidence
        ?? false,
    };
    const rawSteps = Array.isArray(steps) ? steps : [];
    const explicitChecks = normalizeExplicitChecks(rawSteps);
    const derivedChecks = deriveVerificationChecks({
      touchedFiles,
      languageSignals,
      projectSignals,
      policyName: policy.policy_name,
      includeShellChecks: explicitChecks.length === 0,
    });
    const mergedChecks = mergeResolvedChecks(explicitChecks, derivedChecks);
    const checks = mergedChecks
      .map((entry) => ({
        ...entry,
        check_type: detectCheckType(entry.step),
        targeted: detectTargetedStep(entry.step) || entry.targeted,
      }))
      .sort((left, right) =>
        Number(right.targeted) - Number(left.targeted)
        || checkTypeOrder(left.check_type) - checkTypeOrder(right.check_type)
        || left.step.localeCompare(right.step),
      );
    const resolvedPlan: VerificationResolvedPlan = {
      schema_version: 1,
      policy_name: policy.policy_name,
      source:
        explicitChecks.length > 0 && derivedChecks.length > 0
          ? "mixed"
          : explicitChecks.length > 0
            ? "explicit"
            : "derived",
      touched_files: touchedFiles,
      language_signals: languageSignals,
      project_signals: projectSignals,
      checks: checks.map((entry) => ({
        step: entry.step,
        check_type: entry.check_type,
        category: entry.category,
        targeted: entry.targeted,
        source: entry.source,
        rationale: entry.rationale,
      })),
    };
    if (runOptions.onResolvedPlan) {
      await runOptions.onResolvedPlan(resolvedPlan);
    }
    const checkResults: VerificationCheckResult[] = [];

    const pushResult = (entry: VerificationCheckResult): void => {
      checkResults.push(entry);
      if (entry.status === "failed") {
        errors.push(entry.message ?? entry.reason_code ?? entry.step);
      }
    };

    for (const check of checks) {
      const startedAt = Date.now();
      const step = check.step;
      if (!step) {
        pushResult({
          ...check,
          status: "unverified",
          reason_code: "verification_step_empty",
          message: "verification step is empty",
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }

      if (check.check_type === "docdex_hooks") {
        const files = parseHookFiles(step);
        if (!this.options.docdexClient) {
          pushResult({
            ...check,
            status: "unverified",
            reason_code: "verification_docdex_unavailable",
            message: `docdex hooks unavailable for step: ${step}`,
            duration_ms: Date.now() - startedAt,
          });
          continue;
        }
        try {
          await this.options.docdexClient.hooksValidate(files);
          pushResult({
            ...check,
            status: "passed",
            evidence: files.length > 0 ? `Validated hooks for ${files.length} file(s).` : "Validated hooks.",
            duration_ms: Date.now() - startedAt,
          });
        } catch (error) {
          pushResult({
            ...check,
            status: "failed",
            reason_code: "verification_hooks_failed",
            message: error instanceof Error ? error.message : String(error),
            duration_ms: Date.now() - startedAt,
          });
        }
        continue;
      }

      if (!this.options.allowShell) {
        pushResult({
          ...check,
          status: "unverified",
          reason_code: "verification_shell_disabled",
          message: `shell validation disabled for step: ${step}`,
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }

      const [command, ...args] = step.split(" ").filter(Boolean);
      if (!command) {
        pushResult({
          ...check,
          status: "unverified",
          reason_code: "verification_step_empty",
          message: "validation step is empty",
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }
      if (!this.options.shellAllowlist.includes(command)) {
        pushResult({
          ...check,
          status: "unverified",
          reason_code: "verification_command_not_allowlisted",
          message: `command not allowlisted: ${command}`,
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }
      const result = spawnSync(command, args, {
        cwd: this.options.workspaceRoot,
        encoding: "utf8",
        timeout: this.options.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      });
      if (result.error) {
        const errorMessage = result.error.message;
        const timeoutHit =
          result.error.name === "TimeoutError"
          || (result.error as { code?: string }).code === "ETIMEDOUT"
          || result.error.message.toLowerCase().includes("timed out");
        pushResult({
          ...check,
          status: "failed",
          reason_code: timeoutHit
            ? "verification_command_timeout"
            : "verification_tool_unavailable",
          message: errorMessage,
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }
      if (result.status === null && result.signal === "SIGTERM") {
        pushResult({
          ...check,
          status: "failed",
          reason_code: "verification_command_timeout",
          message: `command timed out: ${command}`,
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }
      if (result.status !== 0) {
        pushResult({
          ...check,
          status: "failed",
          reason_code: "verification_command_failed",
          message: result.stderr?.toString().trim() || `command failed: ${command}`,
          evidence: compactText(result.stdout?.toString()),
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }
      pushResult({
        ...check,
        status: "passed",
        evidence: compactText(result.stdout?.toString()) ?? `command succeeded: ${command}`,
        duration_ms: Date.now() - startedAt,
      });
    }

    const totals: ValidationTotals = {
      configured: checks.length,
      runnable: checkResults.filter((entry) => entry.status === "passed" || entry.status === "failed").length,
      attempted: checkResults.filter((entry) => entry.status === "passed" || entry.status === "failed").length,
      passed: checkResults.filter((entry) => entry.status === "passed").length,
      failed: checkResults.filter((entry) => entry.status === "failed").length,
      unverified: checkResults.filter((entry) => entry.status === "unverified").length,
    };

    const reasonCodes = new Set<VerificationReasonCode>();
    for (const entry of checkResults) {
      if (entry.reason_code) reasonCodes.add(entry.reason_code);
    }
    if (totals.configured === 0) {
      reasonCodes.add("verification_no_steps");
    }
    if (totals.runnable === 0 && totals.configured > 0) {
      reasonCodes.add("verification_no_runnable_checks");
    }
    if (totals.passed < policy.minimum_checks) {
      reasonCodes.add("verification_policy_minimum_unmet");
    }

    let outcome: VerificationOutcome;
    if (totals.failed > 0) {
      outcome = "verified_failed";
    } else if (totals.passed === 0 || totals.passed < policy.minimum_checks) {
      outcome = "unverified_with_reason";
    } else {
      outcome = "verified_passed";
    }
    const reason_codes = [...reasonCodes].sort();
    const report: VerificationReport = {
      schema_version: 1,
      outcome,
      reason_codes,
      policy,
      checks: checkResults,
      totals,
      touched_files: touchedFiles,
      language_signals: languageSignals,
      project_signals: projectSignals,
      resolved_checks_source: resolvedPlan.source,
    };

    return {
      ok: outcome !== "verified_failed",
      errors,
      outcome,
      reason_codes,
      checks: checkResults,
      policy,
      touched_files: touchedFiles,
      language_signals: languageSignals,
      totals,
      report,
    };
  }
}
