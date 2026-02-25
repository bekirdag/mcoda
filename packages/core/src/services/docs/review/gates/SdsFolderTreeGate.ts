import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SdsFolderTreeGateInput {
  artifacts: DocgenArtifactInventory;
}

const FOLDER_TREE_HEADING = /folder tree|directory structure|repository structure|target structure/i;
const TREE_ENTRY_MINIMUM = 8;

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const extractSection = (
  lines: string[],
  headingMatch: RegExp,
): { content: string[]; line: number } | undefined => {
  let inFence = false;
  let capture = false;
  let startLine = 0;
  const collected: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      if (capture) collected.push(trimmed);
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading && !inFence) {
      const title = heading[1]?.trim() ?? "";
      if (headingMatch.test(title)) {
        capture = true;
        startLine = i + 1;
        continue;
      }
      if (capture) break;
    }
    if (capture) collected.push(line);
  }
  if (!capture) return undefined;
  return { content: collected, line: startLine };
};

const extractTreeBlock = (content: string): string | undefined => {
  const match = content.match(/```(?:text)?\s*([\s\S]*?)```/i);
  if (!match) return undefined;
  return match[1]?.trim();
};

const countTreeEntries = (treeBlock: string): number => {
  return treeBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line === ".") return true;
      if (/^[├└│]/.test(line)) return true;
      if (/[A-Za-z0-9_.-]+\/?(\s+[#-].*)?$/.test(line)) return true;
      return false;
    }).length;
};

const hasResponsibilityHints = (treeBlock: string): boolean =>
  /#|responsibilit|owner|module|service|tests?|scripts?/i.test(treeBlock);

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  record: DocArtifactRecord;
  line?: number;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-sds-folder-tree",
  severity: "high",
  category: "completeness",
  artifact: "sds",
  message: input.message,
  remediation: input.remediation,
  location: {
    kind: "line_range",
    path: input.record.path,
    lineStart: input.line ?? 1,
    lineEnd: input.line ?? 1,
    excerpt: input.message,
  },
  metadata: input.metadata,
});

export const runSdsFolderTreeGate = async (
  input: SdsFolderTreeGateInput,
): Promise<ReviewGateResult> => {
  const sds = input.artifacts.sds;
  if (!sds) {
    return {
      gateId: "gate-sds-folder-tree",
      gateName: "SDS Folder Tree",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for folder tree validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(sds.path, "utf8");
    const lines = content.split(/\r?\n/);
    const section = extractSection(lines, FOLDER_TREE_HEADING);
    if (!section) {
      issues.push(
        buildIssue({
          id: "gate-sds-folder-tree-missing-section",
          message: "SDS is missing a target folder tree section.",
          remediation:
            "Add a dedicated folder tree section with an expanded repository tree and responsibilities.",
          record: sds,
          metadata: { issueType: "missing_folder_tree_section" },
        }),
      );
    } else {
      const sectionText = section.content.join("\n").trim();
      const treeBlock = extractTreeBlock(sectionText);
      if (!treeBlock) {
        issues.push(
          buildIssue({
            id: "gate-sds-folder-tree-missing-fence",
            message: "Folder tree section does not include a fenced text tree block.",
            remediation:
              "Add a fenced block (```text ... ```) that describes the target repository tree.",
            record: sds,
            line: section.line,
            metadata: { issueType: "missing_fenced_tree" },
          }),
        );
      } else {
        const entryCount = countTreeEntries(treeBlock);
        if (entryCount < TREE_ENTRY_MINIMUM) {
          issues.push(
            buildIssue({
              id: "gate-sds-folder-tree-sparse-tree",
              message: `Folder tree block is too sparse (${entryCount} entries).`,
              remediation:
                "Expand the tree to include major docs/source/contracts/db/deploy/tests/scripts paths.",
              record: sds,
              line: section.line,
              metadata: { issueType: "sparse_tree", entryCount, minimum: TREE_ENTRY_MINIMUM },
            }),
          );
        }
        if (!hasResponsibilityHints(treeBlock)) {
          issues.push(
            buildIssue({
              id: "gate-sds-folder-tree-missing-responsibilities",
              message: "Folder tree block is missing responsibility hints for listed paths.",
              remediation:
                "Annotate key paths with short purpose/ownership comments to make the structure actionable.",
              record: sds,
              line: section.line,
              metadata: { issueType: "missing_tree_responsibilities" },
            }),
          );
        }
      }
    }
  } catch (error) {
    notes.push(`Unable to read SDS ${sds.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-sds-folder-tree",
    gateName: "SDS Folder Tree",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
