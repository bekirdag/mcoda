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
const REPORT_FILE_NAME = "task-sufficiency-report.json";

const ignoredDirs = new Set([".git", "node_modules", "dist", "build", ".mcoda", ".docdex"]);
const sdsFilenamePattern = /(sds|software[-_ ]design|system[-_ ]design|design[-_ ]spec)/i;
const sdsContentPattern = /(software design specification|system design specification|^#\s*sds\b)/im;

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
      const rawAnchor = (metadata?.sufficiencyAudit as Record<string, unknown> | undefined)?.anchor;
      if (typeof rawAnchor === "string" && rawAnchor.trim().length > 0) {
        existingAnchors.add(rawAnchor.trim());
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
      items.push({ kind: "section", value: heading, normalizedAnchor });
      if (items.length >= limit) return items;
    }
    for (const entry of coverage.missingFolderEntries) {
      const normalizedAnchor = normalizeAnchor("folder", entry);
      if (existingAnchors.has(normalizedAnchor)) continue;
      items.push({ kind: "folder", value: entry, normalizedAnchor });
      if (items.length >= limit) return items;
    }
    return items;
  }

  private async ensureTargetStory(project: ProjectRow): Promise<{ epicId: string; epicKey: string; storyId: string; storyKey: string }> {
    const db = this.workspaceRepo.getDb();
    const existingStory = await db.get<{
      story_id: string;
      story_key: string;
      epic_id: string;
      epic_key: string;
    }>(
      `SELECT us.id AS story_id, us.key AS story_key, us.epic_id AS epic_id, e.key AS epic_key
       FROM user_stories us
       JOIN epics e ON e.id = us.epic_id
       WHERE us.project_id = ?
       ORDER BY COALESCE(us.priority, 2147483647), datetime(us.created_at), us.key
       LIMIT 1`,
      project.id,
    );
    if (existingStory) {
      return {
        epicId: existingStory.epic_id,
        epicKey: existingStory.epic_key,
        storyId: existingStory.story_id,
        storyKey: existingStory.story_key,
      };
    }

    let epicId = "";
    let epicKey = "";
    const existingEpic = await db.get<{ id: string; key: string }>(
      `SELECT id, key
       FROM epics
       WHERE project_id = ?
       ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key
       LIMIT 1`,
      project.id,
    );
    if (existingEpic) {
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
    gapItems: GapItem[];
    iteration: number;
    jobId: string;
    commandRunId: string;
  }): Promise<TaskRow[]> {
    const existingTaskKeys = await this.workspaceRepo.listTaskKeys(params.storyId);
    const taskKeyGen = createTaskKeyGenerator(params.storyKey, existingTaskKeys);
    const now = new Date().toISOString();
    const taskInserts = params.gapItems.map((gap, index) => {
      const titlePrefix = gap.kind === "section" ? "Cover SDS section" : "Materialize SDS folder entry";
      const title = `${titlePrefix}: ${gap.value}`.slice(0, 180);
      const objective =
        gap.kind === "section"
          ? `Implement or update product code to satisfy the SDS section \"${gap.value}\".`
          : `Create/update codebase artifacts required by SDS folder-tree entry \"${gap.value}\".`;
      const description = [
        `## Objective`,
        objective,
        ``,
        `## Context`,
        `- Generated by task-sufficiency-audit iteration ${params.iteration}.`,
        `- Anchor: ${gap.normalizedAnchor}`,
        ``,
        `## Implementation Plan`,
        `- Inspect SDS and current implementation for this anchor.`,
        `- Add or update production code and wiring to satisfy the requirement.`,
        `- Update impacted docs/contracts if the implementation surface changes.`,
        ``,
        `## Testing`,
        `- Add or update unit/component/integration tests for this anchor.`,
        `- Ensure existing regression suites remain green.`,
        ``,
        `## Definition of Done`,
        `- Anchor requirement is fully represented in code.`,
        `- Tests covering this scope pass.`,
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
        storyPoints: 1,
        priority: params.maxPriority + index + 1,
        metadata: {
          sufficiencyAudit: {
            source: "task-sufficiency-audit",
            kind: gap.kind,
            value: gap.value,
            anchor: gap.normalizedAnchor,
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

      const sectionHeadings = unique(
        sdsDocs.flatMap((doc) => extractMarkdownHeadings(doc.content, SDS_HEADING_LIMIT)),
      ).slice(0, SDS_HEADING_LIMIT);
      const folderEntries = unique(
        sdsDocs.flatMap((doc) => extractFolderEntries(doc.content, SDS_FOLDER_LIMIT)),
      ).slice(0, SDS_FOLDER_LIMIT);

      await this.jobService.writeCheckpoint(job.id, {
        stage: "sds_loaded",
        timestamp: new Date().toISOString(),
        details: {
          docCount: sdsDocs.length,
          headingSignals: sectionHeadings.length,
          folderSignals: folderEntries.length,
          docs: sdsDocs.map((doc) => path.relative(request.workspace.workspaceRoot, doc.path)),
        },
      });

      const warnings: string[] = [];
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

        const gapItems = this.buildGapItems(coverage, snapshot.existingAnchors, maxTasksPerIteration);
        if (gapItems.length === 0) {
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
              proposedGapItems: gapItems.map((item) => ({ kind: item.kind, value: item.value })),
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
          gapItems,
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
          `Iteration ${iteration}: added ${createdTaskKeys.length} task(s): ${createdTaskKeys.join(", ")}\n`,
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
          headingSignals: extractMarkdownHeadings(doc.content, SDS_HEADING_LIMIT).length,
          folderSignals: extractFolderEntries(doc.content, SDS_FOLDER_LIMIT).length,
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
