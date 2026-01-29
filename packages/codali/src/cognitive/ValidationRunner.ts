import { spawnSync } from "node:child_process";
import type { DocdexClient } from "../docdex/DocdexClient.js";

export interface ValidationRunnerOptions {
  allowShell: boolean;
  shellAllowlist: string[];
  workspaceRoot: string;
  docdexClient?: DocdexClient;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

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

export class ValidationRunner {
  private options: ValidationRunnerOptions;

  constructor(options: ValidationRunnerOptions) {
    this.options = options;
  }

  async run(steps: string[]): Promise<ValidationResult> {
    const errors: string[] = [];
    for (const step of steps) {
      if (step.startsWith("docdex:hooks") || step.startsWith("hooks:")) {
        const files = parseHookFiles(step);
        if (!this.options.docdexClient) {
          errors.push(`docdex hooks unavailable for step: ${step}`);
          continue;
        }
        try {
          await this.options.docdexClient.hooksValidate(files);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      if (!this.options.allowShell) {
        errors.push(`shell validation disabled for step: ${step}`);
        continue;
      }

      const [command, ...args] = step.split(" ").filter(Boolean);
      if (!command) {
        errors.push("validation step is empty");
        continue;
      }
      if (!this.options.shellAllowlist.includes(command)) {
        errors.push(`command not allowlisted: ${command}`);
        continue;
      }
      const result = spawnSync(command, args, {
        cwd: this.options.workspaceRoot,
        encoding: "utf8",
      });
      if (result.error) {
        errors.push(result.error.message);
        continue;
      }
      if (result.status !== 0) {
        errors.push(result.stderr?.toString() || `command failed: ${command}`);
      }
    }

    return { ok: errors.length === 0, errors };
  }
}
