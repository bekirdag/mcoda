import fs from "node:fs/promises";
import path from "node:path";

export type ProjectGuidance = {
  content: string;
  source: string;
};

const guidanceCandidates = (workspaceRoot: string): string[] => [
  path.join(workspaceRoot, ".mcoda", "docs", "project-guidance.md"),
  path.join(workspaceRoot, "docs", "project-guidance.md"),
];

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
