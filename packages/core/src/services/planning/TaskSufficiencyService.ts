import path from "node:path";
import { promises as fs } from "node:fs";
import { WorkspaceRepository, type ProjectRow, type TaskRow } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { createEpicKeyGenerator, createStoryKeyGenerator, createTaskKeyGenerator } from "./KeyHelpers.js";

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_MAX_TASKS_PER_ITERATION = 24;
const DEFAULT_MIN_COVERAGE_RATIO = 0.96;
const SDS_SCAN_MAX_FILES = 120;
const SDS_HEADING_LIMIT = 200;
const SDS_FOLDER_LIMIT = 240;
const GAP_BUNDLE_SIZE = 4;
const REPORT_FILE_NAME = "task-sufficiency-report.json";

const ignoredDirs = new Set([".git", "node_modules", "dist", "build", ".mcoda", ".docdex"]);
const sdsFilenamePattern = /(sds|software[-_ ]design|system[-_ ]design|design[-_ ]spec)/i;
const sdsContentPattern = /(software design specification|system design specification|^#\s*sds\b)/im;
const nonImplementationHeadingPattern =
  /\b(revision history|table of contents|purpose|scope|definitions?|abbreviations?|glossary|references?|appendix|document control|authors?)\b/i;
const likelyImplementationHeadingPattern =
  /\b(architecture|entity|entities|service|services|module|modules|component|components|pipeline|workflow|api|endpoint|schema|model|feature|store|database|ingestion|training|inference|ui|frontend|backend|ops|observability|security|deployment|solver|integration|testing|validation|contract|index|mapping|registry|cache|queue|event|job|task|migration|controller|router|policy)\b/i;
const repoRootSegments = new Set([
  "apps",
  "api",
  "backend",
  "config",
  "configs",
  "db",
  "deployment",
  "deployments",
  "docs",
  "frontend",
  "implementation",
  "infra",
  "internal",
  "packages",
  "scripts",
  "service",
  "services",
  "shared",
  "src",
  "test",
  "tests",
  "ui",
  "web",
]);
const headingNoiseTokens = new Set(["and", "for", "from", "into", "the", "with"]);

type CoverageSummary = {
  coverageRatio: number;
  totalSignals: number;
  missingSectionHeadings: string[];
  missingFolderEntries: string[];
};

type ProjectSnapshot = {
  project: ProjectRow;
  epicCount: number;
  storyCount: number;
  taskCount: number;
  corpus: string;
  existingAnchors: Set<string>;
  maxPriority: number;
};

type GapItem = {
  kind: "section" | "folder";
  value: string;
  normalizedAnchor: string;
  domain: string;
};

type GapBundle = {
  kind: "section" | "folder" | "mixed";
  domain: string;
  values: string[];
  normalizedAnchors: string[];
};

export interface TaskSufficiencyAuditRequest {
  workspace: WorkspaceResolution;
  projectKey: string;
  dryRun?: boolean;
  maxIterations?: number;
  maxTasksPerIteration?: number;
  minCoverageRatio?: number;
  sourceCommand?: string;
}

export interface TaskSufficiencyAuditIteration {
  iteration: number;
  coverageRatio: number;
  totalSignals: number;
  missingSectionCount: number;
  missingFolderCount: number;
  createdTaskKeys: string[];
}

export interface TaskSufficiencyAuditResult {
  jobId: string;
  commandRunId: string;
  projectKey: string;
  sourceCommand?: string;
  satisfied: boolean;
  dryRun: boolean;
  totalTasksAdded: number;
  totalTasksUpdated: number;
  maxIterations: number;
  minCoverageRatio: number;
  finalCoverageRatio: number;
  remainingSectionHeadings: string[];
  remainingFolderEntries: string[];
  remainingGaps: {
    sections: number;
    folders: number;
    total: number;
  };
  iterations: TaskSufficiencyAuditIteration[];
  reportPath: string;
  reportHistoryPath?: string;
  warnings: string[];
}

type TaskSufficiencyDeps = {
  workspaceRepo: WorkspaceRepository;
  jobService: JobService;
};

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/[^a-z0-9/\s.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeAnchor = (kind: "section" | "folder", value: string): string =>
  `${kind}:${normalizeText(value).replace(/\s+/g, " ").trim()}`;

const unique = (items: string[]): string[] => Array.from(new Set(items.filter(Boolean)));

const stripDecorators = (value: string): string =>
  value
    .replace(/[`*_]/g, " ")
    .replace(/^[\s>:\-[\]().]+/, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeHeadingCandidate = (value: string): string => {
  const cleaned = stripDecorators(value).replace(/^\d+(?:\.\d+)*\s+/, "").trim();
  return cleaned.length > 0 ? cleaned : stripDecorators(value);
};

const headingLooksImplementationRelevant = (heading: string): boolean => {
  const normalized = normalizeHeadingCandidate(heading).toLowerCase();
  if (!normalized || normalized.length < 3) return false;
  if (nonImplementationHeadingPattern.test(normalized)) return false;
  if (likelyImplementationHeadingPattern.test(normalized)) return true;
  const sectionMatch = heading.trim().match(/^(\d+)(?:\.\d+)*(?:\s+|$)/);
  if (sectionMatch) {
    const major = Number.parseInt(sectionMatch[1] ?? "", 10);
    if (Number.isFinite(major) && major >= 3) return true;
  }
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9.-]+/g, ""))
    .filter((token) => token.length >= 4 && !headingNoiseTokens.has(token));
  return tokens.length >= 2;
};

const normalizeFolderEntry = (entry: string): string | undefined => {
  const trimmed = stripDecorators(entry)
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, "");
  if (!trimmed.includes("/")) return undefined;
  if (trimmed.includes("...") || trimmed.includes("*")) return undefined;
  return trimmed;
};

const folderEntryLooksRepoRelevant = (entry: string): boolean => {
  const normalized = normalizeFolderEntry(entry);
  if (!normalized) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  const root = segments[0]!.toLowerCase();
  return repoRootSegments.has(root);
};

const deriveSectionDomain = (heading: string): string => {
  const normalized = normalizeHeadingCandidate(heading).toLowerCase();
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9.-]+/g, ""))
    .filter((token) => token.length >= 3 && !headingNoiseTokens.has(token));
  return tokens[0] ?? "coverage";
};

const deriveFolderDomain = (entry: string): string => {
  const normalized = normalizeFolderEntry(entry)?.toLowerCase();
  if (!normalized) return "structure";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "structure";
  return segments.length === 1 ? segments[0]! : `${segments[0]}-${segments[1]}`;
};

const extractMarkdownHeadings = (content: string, limit: number): string[] => {
  if (!content) return [];
  const matches = [...content.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm)];
  const headings: string[] = [];
  for (const match of matches) {
    const heading = match[1]?.replace(/#+$/, "").trim();
    if (!heading) continue;
    headings.push(heading);
    if (headings.length >= limit) break;
  }
  return unique(headings).slice(0, limit);
};

const extractFolderEntries = (content: string, limit: number): string[] => {
  if (!content) return [];
  const candidates: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matches = [...trimmed.matchAll(/[`'"]?([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+(?:\/[a-zA-Z0-9._-]+)*)[`'"]?/g)];
    for (const match of matches) {
      const raw = (match[1] ?? "").replace(/^\.?\//, "").replace(/\/+$/, "").trim();
      if (!raw || !raw.includes("/")) continue;
      candidates.push(raw);
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }
  return unique(candidates).slice(0, limit);
};

const headingCovered = (corpus: string, heading: string): boolean => {
  const normalized = normalizeText(heading);
  if (!normalized) return true;
  if (corpus.includes(normalized)) return true;
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .slice(0, 8);
  if (tokens.length === 0) return true;
  const hitCount = tokens.filter((token) => corpus.includes(token)).length;
  const minHits = Math.min(2, tokens.length);
  return hitCount >= minHits;
};

const folderEntryCovered = (corpus: string, entry: string): boolean => {
  const normalized = normalizeText(entry).replace(/\s+/g, "");
  if (!normalized) return true;
  if (corpus.includes(normalized)) return true;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const leaf = segments[segments.length - 1];
  const parent = segments.length > 1 ? segments[segments.length - 2] : undefined;
  if (leaf && corpus.includes(leaf)) {
    if (!parent) return true;
    return corpus.includes(parent);
  }
  return false;
};

const readJsonSafe = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class TaskSufficiencyService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly jobService: JobService;
  private readonly ownsWorkspaceRepo: boolean;
  private readonly ownsJobService: boolean;
  private readonly workspace: WorkspaceResolution;

  constructor(
    workspace: WorkspaceResolution,
    deps: TaskSufficiencyDeps,
    ownership: { ownsWorkspaceRepo?: boolean; ownsJobService?: boolean } = {},
  ) {
    this.workspace = workspace;
    this.workspaceRepo = deps.workspaceRepo;
    this.jobService = deps.jobService;
    this.ownsWorkspaceRepo = ownership.ownsWorkspaceRepo === true;
    this.ownsJobService = ownership.ownsJobService === true;
  }

  static async create(workspace: WorkspaceResolution): Promise<TaskSufficiencyService> {
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace);
    return new TaskSufficiencyService(
      workspace,
      { workspaceRepo, jobService },
      { ownsWorkspaceRepo: true, ownsJobService: true },
    );
  }

  async close(): Promise<void> {
    if (this.ownsWorkspaceRepo) {
      await this.workspaceRepo.close();
    }
    if (this.ownsJobService) {
      await this.jobService.close();
    }
  }

  private async discoverSdsPaths(workspaceRoot: string): Promise<string[]> {
    const directCandidates = [
      path.join(workspaceRoot, "docs", "sds.md"),
      path.join(workspaceRoot, "docs", "sds", "sds.md"),
      path.join(workspaceRoot, "docs", "software-design-specification.md"),
      path.join(workspaceRoot, "sds.md"),
    ];
    const found = new Set<string>();

    for (const candidate of directCandidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) found.add(path.resolve(candidate));
      } catch {
        // ignore missing direct candidate
      }
    }

    const roots = [path.join(workspaceRoot, "docs"), workspaceRoot];
    for (const root of roots) {
      const discovered = await this.walkSdsCandidates(root, root === workspaceRoot ? 3 : 5, SDS_SCAN_MAX_FILES);
      discovered.forEach((entry) => found.add(entry));
      if (found.size >= SDS_SCAN_MAX_FILES) break;
    }

    return Array.from(found).slice(0, SDS_SCAN_MAX_FILES);
  }

  private async walkSdsCandidates(root: string, maxDepth: number, cap: number): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (results.length >= cap || depth > maxDepth) return;
      let entries: Array<import("node:fs").Dirent> = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= cap) break;
        if (entry.isDirectory()) {
          if (ignoredDirs.has(entry.name)) continue;
          await walk(path.join(dir, entry.name), depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue;
        if (!sdsFilenamePattern.test(entry.name)) {
          try {
            const sample = await fs.readFile(filePath, "utf8");
            if (!sdsContentPattern.test(sample.slice(0, 30000))) continue;
          } catch {
            continue;
          }
        }
        results.push(path.resolve(filePath));
      }
    };
    await walk(root, 0);
    return results;
  }

  private async loadSdsSources(paths: string[]): Promise<Array<{ path: string; content: string }>> {
    const docs: Array<{ path: string; content: string }> = [];
    for (const filePath of paths) {
      try {
        const content = await fs.readFile(filePath, "utf8");
        if (!sdsContentPattern.test(content) && !sdsFilenamePattern.test(path.basename(filePath))) continue;
        docs.push({ path: filePath, content });
      } catch {
        // ignore unreadable source
      }
    }
    return docs;
  }

  private async loadProjectSnapshot(projectKey: string): Promise<ProjectSnapshot> {
    const project = await this.workspaceRepo.getProjectByKey(projectKey);
    if (!project) {
      throw new Error(
        `task-sufficiency-audit could not find project "${projectKey}". Run create-tasks first or pass a valid --project.`,
      );
    }
    const db = this.workspaceRepo.getDb();
    const [epics, stories, tasks, maxPriorityRow] = await Promise.all([
      db.all<any[]>(
        `SELECT id, key, title, description
         FROM epics
         WHERE project_id = ?
         ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key`,
        project.id,
      ),
      db.all<any[]>(
        `SELECT id, key, title, description, acceptance_criteria
         FROM user_stories
         WHERE project_id = ?
         ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key`,
        project.id,
      ),
      db.all<any[]>(
        `SELECT id, key, title, description, metadata_json
         FROM tasks
         WHERE project_id = ?
         ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key`,
        project.id,
      ),
      db.get<{ max_priority: number }>(
        `SELECT COALESCE(MAX(priority), 0) AS max_priority FROM tasks WHERE project_id = ?`,
        project.id,
      ),
    ]);

    const existingAnchors = new Set<string>();
    const corpusChunks: string[] = [];
    for (const epic of epics) {
      corpusChunks.push(`${epic.title ?? ""} ${epic.description ?? ""}`);
    }
    for (const story of stories) {
      corpusChunks.push(`${story.title ?? ""} ${story.description ?? ""} ${story.acceptance_criteria ?? ""}`);
    }
    for (const task of tasks) {
      corpusChunks.push(`${task.title ?? ""} ${task.description ?? ""}`);
      const metadata = readJsonSafe<Record<string, unknown> | null>(task.metadata_json, null);
      const sufficiencyAudit = metadata?.sufficiencyAudit as Record<string, unknown> | undefined;
      const rawAnchor = sufficiencyAudit?.anchor;
      if (typeof rawAnchor === "string" && rawAnchor.trim().length > 0) {
        existingAnchors.add(rawAnchor.trim());
      }
      const rawAnchors = sufficiencyAudit?.anchors;
      if (Array.isArray(rawAnchors)) {
        for (const anchor of rawAnchors) {
          if (typeof anchor !== "string" || anchor.trim().length === 0) continue;
          existingAnchors.add(anchor.trim());
        }
      }
    }

    return {
      project,
      epicCount: epics.length,
      storyCount: stories.length,
      taskCount: tasks.length,
      corpus: normalizeText(corpusChunks.join("\n")).replace(/\s+/g, " ").trim(),
      existingAnchors,
      maxPriority: Number(maxPriorityRow?.max_priority ?? 0),
    };
  }

  private evaluateCoverage(
    corpus: string,
    sectionHeadings: string[],
    folderEntries: string[],
    existingAnchors: Set<string>,
  ): CoverageSummary {
    const missingSectionHeadings = sectionHeadings.filter((heading) => {
      const anchor = normalizeAnchor("section", heading);
      if (existingAnchors.has(anchor)) return false;
      return !headingCovered(corpus, heading);
    });
    const missingFolderEntries = folderEntries.filter((entry) => {
      const anchor = normalizeAnchor("folder", entry);
      if (existingAnchors.has(anchor)) return false;
      return !folderEntryCovered(corpus, entry);
    });
    const totalSignals = sectionHeadings.length + folderEntries.length;
    const coveredSignals = totalSignals - missingSectionHeadings.length - missingFolderEntries.length;
    const coverageRatio = totalSignals === 0 ? 1 : coveredSignals / totalSignals;
    return {
      coverageRatio: Number(coverageRatio.toFixed(4)),
      totalSignals,
      missingSectionHeadings,
      missingFolderEntries,
    };
  }

  private buildGapItems(
    coverage: CoverageSummary,
    existingAnchors: Set<string>,
    limit: number,
  ): GapItem[] {
    const items: GapItem[] = [];
    for (const heading of coverage.missingSectionHeadings) {
      const normalizedAnchor = normalizeAnchor("section", heading);
      if (existingAnchors.has(normalizedAnchor)) continue;
      items.push({
        kind: "section",
        value: heading,
        normalizedAnchor,
        domain: deriveSectionDomain(heading),
      });
      if (items.length >= limit) return items;
    }
    for (const entry of coverage.missingFolderEntries) {
      const normalizedAnchor = normalizeAnchor("folder", entry);
      if (existingAnchors.has(normalizedAnchor)) continue;
      items.push({
        kind: "folder",
        value: entry,
        normalizedAnchor,
        domain: deriveFolderDomain(entry),
      });
      if (items.length >= limit) return items;
    }
    return items;
  }

  private bundleGapItems(gapItems: GapItem[], limit: number): GapBundle[] {
    const groups = new Map<string, GapItem[]>();
    const orderedKeys: string[] = [];
    for (const item of gapItems) {
      const key = `${item.domain}:${item.kind}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        orderedKeys.push(key);
      }
      groups.get(key)?.push(item);
    }

    const bundles: GapBundle[] = [];
    for (const key of orderedKeys) {
      const group = groups.get(key) ?? [];
      for (let index = 0; index < group.length; index += GAP_BUNDLE_SIZE) {
        if (bundles.length >= limit) return bundles;
        const chunk = group.slice(index, index + GAP_BUNDLE_SIZE);
        const kinds = new Set(chunk.map((item) => item.kind));
        bundles.push({
          kind: kinds.size > 1 ? "mixed" : chunk[0]?.kind ?? "section",
          domain: chunk[0]?.domain ?? "coverage",
          values: chunk.map((item) => item.value),
          normalizedAnchors: chunk.map((item) => item.normalizedAnchor),
        });
      }
    }
    return bundles;
  }

  private async ensureTargetStory(project: ProjectRow): Promise<{ epicId: string; epicKey: string; storyId: string; storyKey: string }> {
    const db = this.workspaceRepo.getDb();
    const existingStories = await db.all<
      {
        story_id: string;
        story_key: string;
        story_metadata_json?: string | null;
        epic_id: string;
        epic_key: string;
        epic_metadata_json?: string | null;
      }[]
    >(
      `SELECT
         us.id AS story_id,
         us.key AS story_key,
         us.metadata_json AS story_metadata_json,
         us.epic_id AS epic_id,
         e.key AS epic_key,
         e.metadata_json AS epic_metadata_json
       FROM user_stories us
       JOIN epics e ON e.id = us.epic_id
       WHERE us.project_id = ?
       ORDER BY COALESCE(us.priority, 2147483647), datetime(us.created_at), us.key`,
      project.id,
    );
    for (const row of existingStories) {
      const storyMetadata = readJsonSafe<Record<string, unknown> | null>(row.story_metadata_json, null) ?? {};
      const epicMetadata = readJsonSafe<Record<string, unknown> | null>(row.epic_metadata_json, null) ?? {};
      const storySource = typeof storyMetadata.source === "string" ? storyMetadata.source : undefined;
      const epicSource = typeof epicMetadata.source === "string" ? epicMetadata.source : undefined;
      if (storySource === "task-sufficiency-audit" || epicSource === "task-sufficiency-audit") {
        return {
          epicId: row.epic_id,
          epicKey: row.epic_key,
          storyId: row.story_id,
          storyKey: row.story_key,
        };
      }
    }

    let epicId = "";
    let epicKey = "";
    const existingEpic = await db.get<{ id: string; key: string; metadata_json?: string | null }>(
      `SELECT id, key, metadata_json
       FROM epics
       WHERE project_id = ?
       ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key`,
      project.id,
    );
    const existingEpicMetadata = readJsonSafe<Record<string, unknown> | null>(existingEpic?.metadata_json, null) ?? {};
    const existingEpicSource = typeof existingEpicMetadata.source === "string" ? existingEpicMetadata.source : undefined;
    if (existingEpic && existingEpicSource === "task-sufficiency-audit") {
      epicId = existingEpic.id;
      epicKey = existingEpic.key;
    } else {
      const epicKeyGen = createEpicKeyGenerator(project.key, await this.workspaceRepo.listEpicKeys(project.id));
      const insertedEpic = (
        await this.workspaceRepo.insertEpics([
          {
            projectId: project.id,
            key: epicKeyGen("ops"),
            title: "Backlog Sufficiency Alignment",
            description:
              "Tracks generated backlog patches required to align SDS coverage and implementation readiness.",
            storyPointsTotal: null,
            priority: null,
            metadata: {
              source: "task-sufficiency-audit",
            },
          },
        ])
      )[0];
      epicId = insertedEpic.id;
      epicKey = insertedEpic.key;
    }

    const storyKeyGen = createStoryKeyGenerator(epicKey, await this.workspaceRepo.listStoryKeys(epicId));
    const insertedStory = (
      await this.workspaceRepo.insertStories([
        {
          projectId: project.id,
          epicId,
          key: storyKeyGen(),
          title: "Close SDS Coverage Gaps",
          description:
            "Adds missing implementation tasks discovered by SDS-vs-backlog sufficiency auditing.",
          acceptanceCriteria:
            "- SDS gaps are represented as executable backlog tasks.\n- Coverage report reaches configured minimum threshold.",
          storyPointsTotal: null,
          priority: null,
          metadata: {
            source: "task-sufficiency-audit",
          },
        },
      ])
    )[0];

    return {
      epicId,
      epicKey,
      storyId: insertedStory.id,
      storyKey: insertedStory.key,
    };
  }

  private async insertGapTasks(params: {
    project: ProjectRow;
    storyId: string;
    storyKey: string;
    epicId: string;
    maxPriority: number;
    gapBundles: GapBundle[];
    iteration: number;
    jobId: string;
    commandRunId: string;
  }): Promise<TaskRow[]> {
    const existingTaskKeys = await this.workspaceRepo.listTaskKeys(params.storyId);
    const taskKeyGen = createTaskKeyGenerator(params.storyKey, existingTaskKeys);
    const now = new Date().toISOString();
    const taskInserts = params.gapBundles.map((bundle, index) => {
      const domainLabel = bundle.domain.replace(/[-_]+/g, " ").trim();
      const titlePrefix =
        bundle.kind === "section"
          ? "Close SDS section coverage"
          : bundle.kind === "folder"
            ? "Materialize SDS structure coverage"
            : "Close SDS coverage bundle";
      const title = `${titlePrefix}: ${domainLabel || "implementation scope"}`.slice(0, 180);
      const objective =
        bundle.kind === "folder"
          ? `Create or update implementation artifacts for ${bundle.values.length} SDS folder-tree requirement(s).`
          : `Implement missing functionality for ${bundle.values.length} SDS section requirement(s).`;
      const scopeLines = bundle.values.map((value) => `- ${value}`);
      const anchorLines = bundle.normalizedAnchors.map((anchor) => `- ${anchor}`);
      const description = [
        `## Objective`,
        objective,
        ``,
        `## Context`,
        `- Generated by task-sufficiency-audit iteration ${params.iteration}.`,
        `- Coverage domain: ${bundle.domain}`,
        ``,
        `## Anchor Scope`,
        ...scopeLines,
        ``,
        `## Anchor Keys`,
        ...anchorLines,
        ``,
        `## Implementation Plan`,
        `- Implement production code for this bundle before adding follow-up docs-only changes.`,
        `- Update module wiring/contracts touched by these anchors.`,
        `- Ensure each anchor has deterministic evidence (tests or checks).`,
        ``,
        `## Testing`,
        `- Add or update tests that validate each listed anchor scope.`,
        `- Keep regression suites green after applying this bundle.`,
        ``,
        `## Definition of Done`,
        `- All anchor scope items in this bundle are represented in implementation code.`,
        `- Validation evidence exists for every anchor key listed above.`,
      ].join("\n");

      return {
        projectId: params.project.id,
        epicId: params.epicId,
        userStoryId: params.storyId,
        key: taskKeyGen(),
        title,
        description,
        type: "feature",
        status: "not_started",
        storyPoints: Math.min(5, Math.max(2, bundle.normalizedAnchors.length)),
        priority: params.maxPriority + index + 1,
        metadata: {
          sufficiencyAudit: {
            source: "task-sufficiency-audit",
            kind: bundle.kind,
            domain: bundle.domain,
            values: bundle.values,
            anchor: bundle.normalizedAnchors[0],
            anchors: bundle.normalizedAnchors,
            iteration: params.iteration,
            generatedAt: now,
          },
        },
      };
    });

    const rows = await this.workspaceRepo.insertTasks(taskInserts);
    for (const row of rows) {
      await this.workspaceRepo.createTaskRun({
        taskId: row.id,
        command: "task-sufficiency-audit",
        status: "succeeded",
        jobId: params.jobId,
        commandRunId: params.commandRunId,
        startedAt: now,
        finishedAt: now,
        runContext: {
          key: row.key,
          source: "task-sufficiency-audit",
        },
      });
    }

    const db = this.workspaceRepo.getDb();
    const storyTotal = await db.get<{ total: number }>(
      `SELECT COALESCE(SUM(COALESCE(story_points, 0)), 0) AS total FROM tasks WHERE user_story_id = ?`,
      params.storyId,
    );
    const epicTotal = await db.get<{ total: number }>(
      `SELECT COALESCE(SUM(COALESCE(story_points, 0)), 0) AS total FROM tasks WHERE epic_id = ?`,
      params.epicId,
    );
    await this.workspaceRepo.updateStoryPointsTotal(params.storyId, Number(storyTotal?.total ?? 0));
    await this.workspaceRepo.updateEpicStoryPointsTotal(params.epicId, Number(epicTotal?.total ?? 0));
    return rows;
  }

  private async writeReportArtifacts(
    projectKey: string,
    report: Record<string, unknown>,
  ): Promise<{ reportPath: string; historyPath: string }> {
    const baseDir = path.join(this.workspace.mcodaDir, "tasks", projectKey);
    const historyDir = path.join(baseDir, "sufficiency-audit");
    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(historyDir, { recursive: true });

    const reportPath = path.join(baseDir, REPORT_FILE_NAME);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const historyPath = path.join(historyDir, `${stamp}.json`);
    const payload = JSON.stringify(report, null, 2);
    await fs.writeFile(reportPath, payload, "utf8");
    await fs.writeFile(historyPath, payload, "utf8");
    return { reportPath, historyPath };
  }

  async runAudit(request: TaskSufficiencyAuditRequest): Promise<TaskSufficiencyAuditResult> {
    const maxIterations = Math.max(1, request.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    const maxTasksPerIteration = Math.max(1, request.maxTasksPerIteration ?? DEFAULT_MAX_TASKS_PER_ITERATION);
    const minCoverageRatio = Math.min(1, Math.max(0, request.minCoverageRatio ?? DEFAULT_MIN_COVERAGE_RATIO));
    const dryRun = request.dryRun === true;
    const sourceCommand = request.sourceCommand?.trim() || undefined;

    await PathHelper.ensureDir(this.workspace.mcodaDir);

    const commandRun = await this.jobService.startCommandRun("task-sufficiency-audit", request.projectKey);
    const job = await this.jobService.startJob("task_sufficiency_audit", commandRun.id, request.projectKey, {
      commandName: "task-sufficiency-audit",
      payload: {
        projectKey: request.projectKey,
        sourceCommand,
        dryRun,
        maxIterations,
        maxTasksPerIteration,
        minCoverageRatio,
      },
    });

    try {
      const sdsPaths = await this.discoverSdsPaths(request.workspace.workspaceRoot);
      const sdsDocs = await this.loadSdsSources(sdsPaths);
      if (sdsDocs.length === 0) {
        throw new Error(
          "task-sufficiency-audit requires an SDS document but none was found. Add docs/sds.md (or a fuzzy-match SDS doc) and retry.",
        );
      }

      const warnings: string[] = [];
      const rawSectionHeadings = unique(
        sdsDocs.flatMap((doc) => extractMarkdownHeadings(doc.content, SDS_HEADING_LIMIT)),
      ).slice(0, SDS_HEADING_LIMIT);
      const rawFolderEntries = unique(
        sdsDocs.flatMap((doc) => extractFolderEntries(doc.content, SDS_FOLDER_LIMIT)),
      ).slice(0, SDS_FOLDER_LIMIT);
      const sectionHeadings = unique(
        rawSectionHeadings
          .map((heading) => normalizeHeadingCandidate(heading))
          .filter((heading) => headingLooksImplementationRelevant(heading)),
      ).slice(0, SDS_HEADING_LIMIT);
      const folderEntries = unique(
        rawFolderEntries
          .map((entry) => normalizeFolderEntry(entry))
          .filter((entry): entry is string => Boolean(entry))
          .filter((entry) => folderEntryLooksRepoRelevant(entry)),
      ).slice(0, SDS_FOLDER_LIMIT);
      const skippedHeadingSignals = Math.max(0, rawSectionHeadings.length - sectionHeadings.length);
      const skippedFolderSignals = Math.max(0, rawFolderEntries.length - folderEntries.length);
      if (skippedHeadingSignals > 0 || skippedFolderSignals > 0) {
        warnings.push(
          `Filtered non-actionable SDS signals (headings=${skippedHeadingSignals}, folders=${skippedFolderSignals}) before remediation.`,
        );
      }
      if (sectionHeadings.length === 0 && folderEntries.length === 0) {
        warnings.push(
          "No actionable implementation signals detected from SDS headings/folder tree after filtering; audit will report coverage only.",
        );
      }

      await this.jobService.writeCheckpoint(job.id, {
        stage: "sds_loaded",
        timestamp: new Date().toISOString(),
        details: {
          docCount: sdsDocs.length,
          headingSignals: sectionHeadings.length,
          folderSignals: folderEntries.length,
          rawHeadingSignals: rawSectionHeadings.length,
          rawFolderSignals: rawFolderEntries.length,
          filteredHeadingSignals: skippedHeadingSignals,
          filteredFolderSignals: skippedFolderSignals,
          docs: sdsDocs.map((doc) => path.relative(request.workspace.workspaceRoot, doc.path)),
        },
      });

      const iterations: TaskSufficiencyAuditIteration[] = [];
      let totalTasksAdded = 0;
      const totalTasksUpdated = 0;
      let satisfied = false;

      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const snapshot = await this.loadProjectSnapshot(request.projectKey);
        const coverage = this.evaluateCoverage(
          snapshot.corpus,
          sectionHeadings,
          folderEntries,
          snapshot.existingAnchors,
        );

        const shouldStop =
          coverage.coverageRatio >= minCoverageRatio ||
          (coverage.missingSectionHeadings.length === 0 && coverage.missingFolderEntries.length === 0);
        if (shouldStop) {
          satisfied = true;
          iterations.push({
            iteration,
            coverageRatio: coverage.coverageRatio,
            totalSignals: coverage.totalSignals,
            missingSectionCount: coverage.missingSectionHeadings.length,
            missingFolderCount: coverage.missingFolderEntries.length,
            createdTaskKeys: [],
          });
          await this.jobService.writeCheckpoint(job.id, {
            stage: "iteration",
            timestamp: new Date().toISOString(),
            details: {
              iteration,
              coverageRatio: coverage.coverageRatio,
              totalSignals: coverage.totalSignals,
              missingSectionCount: coverage.missingSectionHeadings.length,
              missingFolderCount: coverage.missingFolderEntries.length,
              action: "complete",
            },
          });
          break;
        }

        const gapItems = this.buildGapItems(coverage, snapshot.existingAnchors, maxTasksPerIteration * GAP_BUNDLE_SIZE);
        const gapBundles = this.bundleGapItems(gapItems, maxTasksPerIteration);
        if (gapBundles.length === 0) {
          warnings.push(
            `Iteration ${iteration}: unresolved SDS gaps remain but no insertable gap items were identified.`,
          );
          iterations.push({
            iteration,
            coverageRatio: coverage.coverageRatio,
            totalSignals: coverage.totalSignals,
            missingSectionCount: coverage.missingSectionHeadings.length,
            missingFolderCount: coverage.missingFolderEntries.length,
            createdTaskKeys: [],
          });
          break;
        }

        if (dryRun) {
          iterations.push({
            iteration,
            coverageRatio: coverage.coverageRatio,
            totalSignals: coverage.totalSignals,
            missingSectionCount: coverage.missingSectionHeadings.length,
            missingFolderCount: coverage.missingFolderEntries.length,
            createdTaskKeys: [],
          });
          await this.jobService.writeCheckpoint(job.id, {
            stage: "iteration",
            timestamp: new Date().toISOString(),
            details: {
              iteration,
              coverageRatio: coverage.coverageRatio,
              totalSignals: coverage.totalSignals,
              missingSectionCount: coverage.missingSectionHeadings.length,
              missingFolderCount: coverage.missingFolderEntries.length,
              action: "dry_run",
              proposedGapItems: gapBundles.map((bundle) => ({
                kind: bundle.kind,
                domain: bundle.domain,
                values: bundle.values,
              })),
            },
          });
          break;
        }

        const target = await this.ensureTargetStory(snapshot.project);
        const inserted = await this.insertGapTasks({
          project: snapshot.project,
          storyId: target.storyId,
          storyKey: target.storyKey,
          epicId: target.epicId,
          maxPriority: snapshot.maxPriority,
          gapBundles,
          iteration,
          jobId: job.id,
          commandRunId: commandRun.id,
        });
        const createdTaskKeys = inserted.map((task) => task.key);
        totalTasksAdded += createdTaskKeys.length;
        iterations.push({
          iteration,
          coverageRatio: coverage.coverageRatio,
          totalSignals: coverage.totalSignals,
          missingSectionCount: coverage.missingSectionHeadings.length,
          missingFolderCount: coverage.missingFolderEntries.length,
          createdTaskKeys,
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "iteration",
          timestamp: new Date().toISOString(),
          details: {
            iteration,
            coverageRatio: coverage.coverageRatio,
            totalSignals: coverage.totalSignals,
            missingSectionCount: coverage.missingSectionHeadings.length,
            missingFolderCount: coverage.missingFolderEntries.length,
            createdTaskKeys,
            addedCount: createdTaskKeys.length,
          },
        });
        await this.jobService.appendLog(
          job.id,
          `Iteration ${iteration}: added ${createdTaskKeys.length} remediation task(s) from ${gapBundles.length} gap bundle(s): ${createdTaskKeys.join(", ")}\n`,
        );
      }

      const finalSnapshot = await this.loadProjectSnapshot(request.projectKey);
      const finalCoverage = this.evaluateCoverage(
        finalSnapshot.corpus,
        sectionHeadings,
        folderEntries,
        finalSnapshot.existingAnchors,
      );
      if (
        finalCoverage.coverageRatio >= minCoverageRatio ||
        (finalCoverage.missingSectionHeadings.length === 0 && finalCoverage.missingFolderEntries.length === 0)
      ) {
        satisfied = true;
      }
      if (!satisfied) {
        warnings.push(
          `Sufficiency target not reached (coverage=${finalCoverage.coverageRatio}, threshold=${minCoverageRatio}) after ${iterations.length} iteration(s).`,
        );
      }

      const report = {
        projectKey: request.projectKey,
        sourceCommand,
        generatedAt: new Date().toISOString(),
        dryRun,
        maxIterations,
        maxTasksPerIteration,
        minCoverageRatio,
        satisfied,
        totalTasksAdded,
        totalTasksUpdated,
        docs: sdsDocs.map((doc) => ({
          path: path.relative(request.workspace.workspaceRoot, doc.path),
          headingSignals: extractMarkdownHeadings(doc.content, SDS_HEADING_LIMIT)
            .map((heading) => normalizeHeadingCandidate(heading))
            .filter((heading) => headingLooksImplementationRelevant(heading)).length,
          folderSignals: extractFolderEntries(doc.content, SDS_FOLDER_LIMIT)
            .map((entry) => normalizeFolderEntry(entry))
            .filter((entry): entry is string => Boolean(entry))
            .filter((entry) => folderEntryLooksRepoRelevant(entry)).length,
          rawHeadingSignals: extractMarkdownHeadings(doc.content, SDS_HEADING_LIMIT).length,
          rawFolderSignals: extractFolderEntries(doc.content, SDS_FOLDER_LIMIT).length,
        })),
        finalCoverage: {
          coverageRatio: finalCoverage.coverageRatio,
          totalSignals: finalCoverage.totalSignals,
          missingSectionHeadings: finalCoverage.missingSectionHeadings,
          missingFolderEntries: finalCoverage.missingFolderEntries,
        },
        iterations,
        warnings,
      };
      const { reportPath, historyPath } = await this.writeReportArtifacts(request.projectKey, report);
      await this.jobService.writeCheckpoint(job.id, {
        stage: "report_written",
        timestamp: new Date().toISOString(),
        details: {
          reportPath,
          historyPath,
          satisfied,
          totalTasksAdded,
          totalTasksUpdated,
          finalCoverageRatio: finalCoverage.coverageRatio,
        },
      });

      const result: TaskSufficiencyAuditResult = {
        jobId: job.id,
        commandRunId: commandRun.id,
        projectKey: request.projectKey,
        sourceCommand,
        satisfied,
        dryRun,
        totalTasksAdded,
        totalTasksUpdated,
        maxIterations,
        minCoverageRatio,
        finalCoverageRatio: finalCoverage.coverageRatio,
        remainingSectionHeadings: finalCoverage.missingSectionHeadings,
        remainingFolderEntries: finalCoverage.missingFolderEntries,
        remainingGaps: {
          sections: finalCoverage.missingSectionHeadings.length,
          folders: finalCoverage.missingFolderEntries.length,
          total: finalCoverage.missingSectionHeadings.length + finalCoverage.missingFolderEntries.length,
        },
        iterations,
        reportPath,
        reportHistoryPath: historyPath,
        warnings,
      };

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          projectKey: request.projectKey,
          satisfied,
          dryRun,
          totalTasksAdded,
          totalTasksUpdated,
          maxIterations,
          minCoverageRatio,
          finalCoverageRatio: finalCoverage.coverageRatio,
          remainingSectionCount: finalCoverage.missingSectionHeadings.length,
          remainingFolderCount: finalCoverage.missingFolderEntries.length,
          reportPath,
          reportHistoryPath: historyPath,
          warnings,
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobService.appendLog(job.id, `task-sufficiency-audit failed: ${message}\n`);
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      throw error;
    }
  }
}
