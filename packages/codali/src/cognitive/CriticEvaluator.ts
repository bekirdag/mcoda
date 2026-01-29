import type { ProviderMessage } from "../providers/ProviderTypes.js";
import type { Plan, CriticResult } from "./Types.js";
import type { ValidationRunner } from "./ValidationRunner.js";
import type { ContextManager } from "./ContextManager.js";

export interface CriticEvaluatorOptions {
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
}

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
    options: { contextManager?: ContextManager; laneId?: string; model?: string } = {},
  ): Promise<CriticResult> {
    if (options.contextManager) this.contextManager = options.contextManager;
    if (options.laneId) this.laneId = options.laneId;
    if (options.model) this.model = options.model;
    if (!builderOutput.trim()) {
      return { status: "FAIL", reasons: ["builder output is empty"], retryable: true };
    }

    const targetFiles = (plan.target_files ?? []).filter((file) => file !== "unknown");

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

    if (effectiveTouched && targetFiles.length > 0) {
      if (effectiveTouched.length === 0) {
        return {
          status: "FAIL",
          reasons: ["no files were touched for planned targets"],
          retryable: true,
        };
      }
      const touched = new Set(effectiveTouched);
      const matched = targetFiles.some((target) => touched.has(target));
      if (!matched) {
        return {
          status: "FAIL",
          reasons: [
            `touched files do not match plan targets (touched: ${effectiveTouched.join(", ")})`,
          ],
          retryable: true,
        };
      }
    }

    const validation = await this.validator.run(plan.verification ?? []);
    if (!validation.ok) {
      const result = { status: "FAIL", reasons: validation.errors, retryable: true } as CriticResult;
      await this.appendCriticResult(result);
      return result;
    }

    const result = { status: "PASS", reasons: [], retryable: false } as CriticResult;
    await this.appendCriticResult(result);
    return result;
  }

  private async appendCriticResult(result: CriticResult): Promise<void> {
    if (!this.contextManager || !this.laneId) return;
    const reasons = result.reasons.length ? ` Reasons: ${result.reasons.join("; ")}` : "";
    const message: ProviderMessage = {
      role: "assistant",
      content: `Critic result: ${result.status}.${reasons}`.trim(),
    };
    await this.contextManager.append(this.laneId, message, { role: "critic", model: this.model });
  }
}
