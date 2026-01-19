import fs from "node:fs/promises";
import path from "node:path";
import { PathHelper } from "@mcoda/shared";

export type ProjectGuidance = {
  content: string;
  source: string;
};

const QA_DOC_PATTERN = /(^|[\\/])(qa|e2e)([-_/]|$)/i;
const MCODA_DOC_PATTERN = /(^|[\\/])\.mcoda([\\/]|$)/i;
const SDS_DOC_PATTERN = /(^|[\\/])docs[\\/]+sds([\\/]|$)/i;
const FRONTMATTER_BLOCK = /^---[\s\S]*?\n---/;

const guidanceCandidates = (workspaceRoot: string, mcodaDir?: string): string[] => {
  const resolvedMcodaDir = mcodaDir ?? PathHelper.getWorkspaceDir(workspaceRoot);
  return [
    path.join(resolvedMcodaDir, "docs", "project-guidance.md"),
    path.join(workspaceRoot, "docs", "project-guidance.md"),
  ];
};

export const isDocContextExcluded = (value: string | undefined, allowQaDocs = false): boolean => {
  if (!value) return false;
  const normalized = value.replace(/\\/g, "/");
  if (MCODA_DOC_PATTERN.test(normalized)) return true;
  if (!allowQaDocs && QA_DOC_PATTERN.test(normalized)) return true;
  return false;
};

const extractFrontmatter = (content: string): string | undefined => {
  if (!content) return undefined;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return undefined;
  const match = trimmed.match(FRONTMATTER_BLOCK);
  return match ? match[0] : undefined;
};

const hasSdsFrontmatter = (content?: string): boolean => {
  if (!content) return false;
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return false;
  if (/(doc_type|doctype|docType|type)\s*:\s*sds\b/i.test(frontmatter)) return true;
  if (/(tags?|categories)\s*:\s*\[?[^\n]*\bsds\b/i.test(frontmatter)) return true;
  if (/sds\s*:\s*true/i.test(frontmatter)) return true;
  return false;
};

export const normalizeDocType = (params: {
  docType?: string;
  path?: string;
  title?: string;
  content?: string;
}): { docType: string; downgraded: boolean; reason?: string } => {
  const raw = (params.docType ?? "DOC").trim();
  const normalizedType = raw ? raw.toUpperCase() : "DOC";
  if (normalizedType !== "SDS") {
    return { docType: normalizedType || "DOC", downgraded: false };
  }
  const pathValue = params.path ?? params.title ?? "";
  const normalizedPath = pathValue.replace(/\\/g, "/");
  const inSdsPath = SDS_DOC_PATTERN.test(normalizedPath);
  const frontmatter = hasSdsFrontmatter(params.content);
  if (inSdsPath || frontmatter) {
    return { docType: "SDS", downgraded: false };
  }
  const reason = [inSdsPath ? null : "path_not_sds", frontmatter ? null : "frontmatter_missing"].filter(Boolean).join("|");
  return { docType: "DOC", downgraded: true, reason: reason || "not_sds" };
};

export const loadProjectGuidance = async (
  workspaceRoot: string,
  mcodaDir?: string,
): Promise<ProjectGuidance | null> => {
  for (const candidate of guidanceCandidates(workspaceRoot, mcodaDir)) {
    try {
      const content = (await fs.readFile(candidate, "utf8")).trim();
      if (!content) continue;
      return { content, source: candidate };
    } catch {
      // ignore missing file
    }
  }
  console.warn(
    `[project-guidance] no project guidance found; searched: ${guidanceCandidates(workspaceRoot, mcodaDir).join(", ")}`,
  );
  return null;
};
