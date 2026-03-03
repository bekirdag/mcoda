import { promises as fs } from "node:fs";
import path from "node:path";
import type { PatchAction } from "./BuilderOutputParser.js";

export interface PatchApplyResult {
  touched: string[];
}

export type PatchPolicyReasonCode =
  | "patch_outside_workspace"
  | "patch_outside_allowed_scope"
  | "patch_read_only_path"
  | "destructive_operation_blocked"
  | "writes_disabled_by_profile";

export interface PatchPolicyErrorMetadata {
  reason_code: PatchPolicyReasonCode;
  file: string;
  normalized_file: string;
  action: PatchAction["action"];
  allowed_paths?: string[];
  read_only_paths?: string[];
  policy?: string;
}

export class PatchPolicyError extends Error {
  readonly metadata: PatchPolicyErrorMetadata;

  constructor(message: string, metadata: PatchPolicyErrorMetadata) {
    super(message);
    this.name = "PatchPolicyError";
    this.metadata = metadata;
  }
}

export interface PatchApplyPolicy {
  allowWritePaths?: string[];
  readOnlyPaths?: string[];
  allowDestructiveOperations?: boolean;
  allowWrites?: boolean;
}

export interface PatchApplierOptions {
  workspaceRoot: string;
  validateFile?: (filePath: string) => Promise<void> | void;
  policy?: PatchApplyPolicy;
}

export interface PatchRollbackEntry {
  file: string;
  normalizedFile: string;
  resolved: string;
  existed: boolean;
  content?: string;
}

export interface PatchRollbackPlan {
  entries: PatchRollbackEntry[];
}

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+/g, "/");

const dedupePaths = (values: string[]): string[] => Array.from(new Set(values.map(normalizePath)));

const pathMatches = (candidates: string[], target: string): boolean =>
  candidates.some((entry) => target === entry || target.startsWith(`${entry}/`));

const resolvePath = (workspaceRoot: string, targetPath: string): { resolved: string; normalized: string } => {
  const normalizedTarget = normalizePath(targetPath);
  const resolved = path.resolve(workspaceRoot, normalizedTarget);
  const relative = normalizePath(path.relative(workspaceRoot, resolved));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside workspace root");
  }
  return { resolved, normalized: normalizedTarget };
};

const buildWhitespaceCollapsed = (input: string): { compact: string; map: number[] } => {
  let compact = "";
  const map: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (/\s/.test(char)) {
      continue;
    }
    compact += char;
    map.push(index);
  }
  return { compact, map };
};

const replaceOnce = (content: string, search: string, replace: string): string => {
  const occurrences = content.split(search).length - 1;
  if (occurrences === 1) {
    return content.replace(search, replace);
  }
  if (occurrences > 1) {
    throw new Error("Ambiguous search block. Provide more context.");
  }

  const compactSearch = search.replace(/\s+/g, "");
  if (!compactSearch) {
    throw new Error("Search block not found in file.");
  }

  const collapsed = buildWhitespaceCollapsed(content);
  const firstIndex = collapsed.compact.indexOf(compactSearch);
  if (firstIndex < 0) {
    throw new Error("Search block not found in file.");
  }
  if (collapsed.compact.indexOf(compactSearch, firstIndex + 1) >= 0) {
    throw new Error("Ambiguous search block. Provide more context.");
  }

  const start = collapsed.map[firstIndex];
  const end = collapsed.map[firstIndex + compactSearch.length - 1] + 1;
  return `${content.slice(0, start)}${replace}${content.slice(end)}`;
};

const toMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isNotFoundError = (error: unknown): boolean => {
  const message = toMessage(error);
  return message.includes("no such file") || message.includes("ENOENT");
};

export class PatchApplier {
  constructor(private options: PatchApplierOptions) {}

  private resolvePolicy(override?: PatchApplyPolicy): Required<PatchApplyPolicy> {
    const merged: PatchApplyPolicy = {
      ...(this.options.policy ?? {}),
      ...(override ?? {}),
    };
    return {
      allowWritePaths: dedupePaths((merged.allowWritePaths ?? []).filter(Boolean)),
      readOnlyPaths: dedupePaths((merged.readOnlyPaths ?? []).filter(Boolean)),
      allowDestructiveOperations: merged.allowDestructiveOperations === true,
      allowWrites: merged.allowWrites !== false,
    };
  }

  private resolvePatchTarget(
    patch: PatchAction,
    policyOverride?: PatchApplyPolicy,
  ): { resolved: string; normalized: string; policy: Required<PatchApplyPolicy> } {
    const policy = this.resolvePolicy(policyOverride);
    let target: { resolved: string; normalized: string };
    try {
      target = resolvePath(this.options.workspaceRoot, patch.file);
    } catch (error) {
      throw new PatchPolicyError("Path is outside workspace root", {
        reason_code: "patch_outside_workspace",
        file: patch.file,
        normalized_file: normalizePath(patch.file),
        action: patch.action,
      });
    }
    if (!policy.allowWrites) {
      throw new PatchPolicyError("Write actions are disabled for the active workflow profile", {
        reason_code: "writes_disabled_by_profile",
        file: patch.file,
        normalized_file: target.normalized,
        action: patch.action,
        policy: "allowWrites",
      });
    }
    if (pathMatches(policy.readOnlyPaths, target.normalized)) {
      throw new PatchPolicyError(`Patch target is read-only: ${patch.file}`, {
        reason_code: "patch_read_only_path",
        file: patch.file,
        normalized_file: target.normalized,
        action: patch.action,
        read_only_paths: policy.readOnlyPaths,
      });
    }
    if (policy.allowWritePaths.length > 0 && !pathMatches(policy.allowWritePaths, target.normalized)) {
      throw new PatchPolicyError(`Patch target is outside allowed scope: ${patch.file}`, {
        reason_code: "patch_outside_allowed_scope",
        file: patch.file,
        normalized_file: target.normalized,
        action: patch.action,
        allowed_paths: policy.allowWritePaths,
      });
    }
    if (patch.action === "delete" && !policy.allowDestructiveOperations) {
      throw new PatchPolicyError("Delete action blocked by destructive-operation policy", {
        reason_code: "destructive_operation_blocked",
        file: patch.file,
        normalized_file: target.normalized,
        action: patch.action,
        policy: "allowDestructiveOperations",
      });
    }
    return { resolved: target.resolved, normalized: target.normalized, policy };
  }

  async createRollback(
    patches: PatchAction[],
    policyOverride?: PatchApplyPolicy,
  ): Promise<PatchRollbackPlan> {
    const entries: PatchRollbackEntry[] = [];
    for (const patch of patches) {
      const target = this.resolvePatchTarget(patch, policyOverride);
      try {
        const content = await fs.readFile(target.resolved, "utf8");
        entries.push({
          file: patch.file,
          normalizedFile: target.normalized,
          resolved: target.resolved,
          existed: true,
          content,
        });
      } catch (error) {
        if (isNotFoundError(error)) {
          entries.push({
            file: patch.file,
            normalizedFile: target.normalized,
            resolved: target.resolved,
            existed: false,
          });
        } else {
          throw error;
        }
      }
    }
    return { entries };
  }

  async rollback(plan: PatchRollbackPlan): Promise<void> {
    for (const entry of plan.entries) {
      if (entry.existed) {
        await fs.mkdir(path.dirname(entry.resolved), { recursive: true });
        await fs.writeFile(entry.resolved, entry.content ?? "", "utf8");
      } else {
        await fs.rm(entry.resolved, { force: true });
      }
    }
  }

  async apply(patches: PatchAction[], policyOverride?: PatchApplyPolicy): Promise<PatchApplyResult> {
    const touched: string[] = [];
    for (const patch of patches) {
      const target = this.resolvePatchTarget(patch, policyOverride);
      if (patch.action === "create") {
        await fs.mkdir(path.dirname(target.resolved), { recursive: true });
        await fs.writeFile(target.resolved, patch.content, "utf8");
        touched.push(patch.file);
        if (this.options.validateFile) await this.options.validateFile(target.resolved);
        continue;
      }
      if (patch.action === "delete") {
        await fs.rm(target.resolved, { force: true });
        touched.push(patch.file);
        continue;
      }
      const content = await fs.readFile(target.resolved, "utf8");
      const updated = replaceOnce(content, patch.search_block, patch.replace_block);
      await fs.writeFile(target.resolved, updated, "utf8");
      touched.push(patch.file);
      if (this.options.validateFile) await this.options.validateFile(target.resolved);
    }
    return { touched };
  }
}
