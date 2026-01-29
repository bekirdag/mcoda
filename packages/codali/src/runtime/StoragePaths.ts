import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const normalizePathCase = (value: string): string => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

export const getGlobalMcodaDir = (): string => {
  const envHome = process.env.HOME ?? process.env.USERPROFILE;
  const homeDir = envHome && envHome.trim().length > 0 ? envHome : os.homedir();
  return path.join(homeDir, ".mcoda");
};

export const getGlobalWorkspaceDir = (workspaceRoot: string): string => {
  const normalizedRoot = normalizePathCase(path.resolve(workspaceRoot));
  const hash = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 12);
  const rawName = path.basename(normalizedRoot) || "workspace";
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 32) || "workspace";
  return path.join(getGlobalMcodaDir(), "workspaces", `${safeName}-${hash}`);
};
