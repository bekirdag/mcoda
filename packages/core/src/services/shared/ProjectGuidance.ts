import fs from "node:fs/promises";
import path from "node:path";

export type ProjectGuidance = {
  content: string;
  source: string;
};

const QA_DOC_PATTERN = /(^|[\\/])(qa|e2e)([-_/]|$)/i;
const MCODA_DOC_PATTERN = /(^|[\\/])\.mcoda([\\/]|$)/i;

const guidanceCandidates = (workspaceRoot: string): string[] => [
  path.join(workspaceRoot, ".mcoda", "docs", "project-guidance.md"),
  path.join(workspaceRoot, "docs", "project-guidance.md"),
];

export const isDocContextExcluded = (value: string | undefined, allowQaDocs = false): boolean => {
  if (!value) return false;
  const normalized = value.replace(/\\/g, "/");
  if (MCODA_DOC_PATTERN.test(normalized)) return true;
  if (!allowQaDocs && QA_DOC_PATTERN.test(normalized)) return true;
  return false;
};

export const loadProjectGuidance = async (workspaceRoot: string): Promise<ProjectGuidance | null> => {
  for (const candidate of guidanceCandidates(workspaceRoot)) {
    try {
      const content = (await fs.readFile(candidate, "utf8")).trim();
      if (!content) continue;
      return { content, source: candidate };
    } catch {
      // ignore missing file
    }
  }
  console.warn(`[project-guidance] no project guidance found; searched: ${guidanceCandidates(workspaceRoot).join(", ")}`);
  return null;
};
