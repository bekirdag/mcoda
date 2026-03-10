import path from "node:path";
import { promises as fs } from "node:fs";
import { WorkspaceRepository, type ProjectRow, type TaskRow } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { createEpicKeyGenerator, createStoryKeyGenerator, createTaskKeyGenerator } from "./KeyHelpers.js";
import {
  collectSdsCoverageSignalsFromDocs,
  evaluateSdsCoverage,
  normalizeCoverageAnchor,
  normalizeCoverageText,
} from "./SdsCoverageModel.js";
import {
  collectSdsImplementationSignals,
  isStructuredFilePath,
  normalizeFolderEntry,
  normalizeHeadingCandidate,
  stripManagedSdsPreflightBlock,
} from "./SdsStructureSignals.js";

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_MAX_TASKS_PER_ITERATION = 24;
const DEFAULT_MIN_COVERAGE_RATIO = 1;
const SDS_SCAN_MAX_FILES = 120;
const SDS_HEADING_LIMIT = 200;
const SDS_FOLDER_LIMIT = 240;
const GAP_BUNDLE_MAX_ANCHORS = 3;
const COVERAGE_HEURISTICS_VERSION = 2;
const REPORT_FILE_NAME = "task-sufficiency-report.json";

const ignoredDirs = new Set([".git", "node_modules", "dist", "build", ".mcoda", ".docdex"]);
const sdsFilenamePattern = /(sds|software[-_ ]design|system[-_ ]design|design[-_ ]spec)/i;
const sdsContentPattern = /(software design specification|system design specification|^#\s*sds\b)/im;
const supportRootSegments = new Set(["docs", "fixtures", "policies", "policy", "runbooks", "pdr", "rfp", "sds"]);
const headingNoiseTokens = new Set(["and", "for", "from", "into", "the", "with"]);
const runtimePathSegments = new Set([
  "api",
  "app",
  "apps",
  "bin",
  "cli",
  "client",
  "clients",
  "cmd",
  "command",
  "commands",
  "engine",
  "engines",
  "feature",
  "features",
  "gateway",
  "gateways",
  "handler",
  "handlers",
  "module",
  "modules",
  "pipeline",
  "pipelines",
  "processor",
  "processors",
  "route",
  "routes",
  "server",
  "servers",
  "service",
  "services",
  "src",
  "ui",
  "web",
  "worker",
  "workers",
]);
const interfacePathSegments = new Set([
  "contract",
  "contracts",
  "dto",
  "dtos",
  "interface",
  "interfaces",
  "policy",
  "policies",
  "proto",
  "protocol",
  "protocols",
  "schema",
  "schemas",
  "spec",
  "specs",
  "type",
  "types",
]);
const dataPathSegments = new Set([
  "cache",
  "caches",
  "data",
  "db",
  "ledger",
  "migration",
  "migrations",
  "model",
  "models",
  "persistence",
  "repository",
  "repositories",
  "storage",
]);
const testPathSegments = new Set(["acceptance", "e2e", "integration", "spec", "specs", "test", "tests"]);
const opsPathSegments = new Set([
  "deploy",
  "deployment",
  "deployments",
  "helm",
  "infra",
  "k8s",
  "ops",
  "operation",
  "operations",
  "runbook",
  "runbooks",
  "script",
  "scripts",
  "systemd",
  "terraform",
]);
const manifestBasenamePattern =
  /^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|turbo\.json|tsconfig(?:\.[^.]+)?\.json|cargo\.toml|pyproject\.toml|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|requirements\.txt|poetry\.lock|foundry\.toml|hardhat\.config\.[^.]+)$/i;
const serviceArtifactBasenamePattern =
  /(?:\.service|\.socket|\.timer|(?:^|[.-])compose\.(?:ya?ml|json)$|docker-compose\.(?:ya?ml|json)$)$/i;

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

type PlannedGapBundle = {
  bundle: GapBundle;
  implementationTargets: string[];
};

export interface TaskSufficiencyPlannedGapBundle {
  kind: "section" | "folder" | "mixed";
  domain: string;
  values: string[];
  anchors: string[];
  implementationTargets: string[];
}

export interface TaskSufficiencyUnresolvedBundle {
  kind: "section" | "folder" | "mixed";
  domain: string;
  values: string[];
  anchors: string[];
}

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
  unresolvedBundleCount: number;
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
  finalTotalSignals: number;
  finalCoverageRatio: number;
  remainingSectionHeadings: string[];
  remainingFolderEntries: string[];
  remainingGaps: {
    sections: number;
    folders: number;
    total: number;
  };
  plannedGapBundles: TaskSufficiencyPlannedGapBundle[];
  unresolvedBundles: TaskSufficiencyUnresolvedBundle[];
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
  normalizeCoverageText(value);

const normalizeAnchor = normalizeCoverageAnchor;

const toPlannedGapBundle = (entry: PlannedGapBundle): TaskSufficiencyPlannedGapBundle => ({
  kind: entry.bundle.kind,
  domain: entry.bundle.domain,
  values: entry.bundle.values,
  anchors: entry.bundle.normalizedAnchors,
  implementationTargets: entry.implementationTargets,
});

const unique = (items: string[]): string[] => Array.from(new Set(items.filter(Boolean)));

const tokenizeCoverageSignal = (value: string): string[] =>
  unique(
    normalizeCoverageText(value)
      .split(/\s+/)
      .map((token) => token.replace(/[^a-z0-9._-]+/g, ""))
      .filter((token) => token.length >= 3),
  );

const stripDecorators = (value: string): string =>
  value
    .replace(/[`*_]/g, " ")
    .replace(/^[\s>:\-[\]().]+/, "")
    .replace(/\s+/g, " ")
    .trim();

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

const implementationRootWeight = (target: string): number => {
  const normalized = normalizeFolderEntry(target)?.toLowerCase() ?? normalizeText(target);
  const segments = normalized.split("/").filter(Boolean);
  const root = segments[0] ?? normalized;
  let score = 55 + Math.min(segments.length, 4) * 6 + (isStructuredFilePath(normalized) ? 10 : 0);
  if (supportRootSegments.has(root)) score -= 30;
  if (segments.some((segment) => ["src", "app", "apps", "lib", "libs", "server", "api", "worker", "workers"].includes(segment))) {
    score += 20;
  }
  if (segments.some((segment) => ["test", "tests", "spec", "specs", "integration", "acceptance", "e2e"].includes(segment))) {
    score += 10;
  }
  if (segments.some((segment) => ["db", "data", "schema", "schemas", "migration", "migrations"].includes(segment))) {
    score += 12;
  }
  if (segments.some((segment) => ["ops", "infra", "deploy", "deployment", "deployments", "script", "scripts"].includes(segment))) {
    score += 12;
  }
  return score;
};

const classifyImplementationTarget = (
  target: string,
): {
  normalized: string;
  basename: string;
  segments: string[];
  kind: "runtime" | "interface" | "data" | "test" | "ops" | "manifest" | "doc" | "unknown";
  isServiceArtifact: boolean;
} => {
  const normalized = normalizeFolderEntry(target)?.toLowerCase() ?? normalizeText(target);
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? normalized;
  const isServiceArtifact = serviceArtifactBasenamePattern.test(basename);
  if (segments.some((segment) => supportRootSegments.has(segment))) {
    return { normalized, basename, segments, kind: "doc", isServiceArtifact };
  }
  if (manifestBasenamePattern.test(basename) || isServiceArtifact) {
    return { normalized, basename, segments, kind: "manifest", isServiceArtifact };
  }
  if (segments.some((segment) => testPathSegments.has(segment))) {
    return { normalized, basename, segments, kind: "test", isServiceArtifact };
  }
  if (segments.some((segment) => opsPathSegments.has(segment))) {
    return { normalized, basename, segments, kind: "ops", isServiceArtifact };
  }
  if (segments.some((segment) => interfacePathSegments.has(segment))) {
    return { normalized, basename, segments, kind: "interface", isServiceArtifact };
  }
  if (segments.some((segment) => dataPathSegments.has(segment))) {
    return { normalized, basename, segments, kind: "data", isServiceArtifact };
  }
  if (segments.some((segment) => runtimePathSegments.has(segment))) {
    return { normalized, basename, segments, kind: "runtime", isServiceArtifact };
  }
  return { normalized, basename, segments, kind: "unknown", isServiceArtifact };
};

const deriveSemanticTargetNeeds = (bundle: GapBundle): {
  wantsVerification: boolean;
  wantsOps: boolean;
  wantsInterface: boolean;
  wantsData: boolean;
  wantsProvider: boolean;
} => {
  const corpus = normalizeText([bundle.domain, ...bundle.values].join(" "));
  return {
    wantsVerification: /\b(verify|verification|acceptance|scenario|suite|test|tests|quality|gate|matrix)\b/.test(corpus),
    wantsOps: /\b(rollback|recovery|replay|restart|rotation|drill|runbook|failover|release|startup|deploy|deployment|operations?|incident|compromise)\b/.test(
      corpus,
    ),
    wantsInterface: /\b(contract|interface|schema|policy|policies|oracle|gateway|api|protocol)\b/.test(corpus),
    wantsData: /\b(data|storage|cache|db|database|ledger|pipeline|metering|pricing)\b/.test(corpus),
    wantsProvider: /\b(provider|providers|gateway|gateways|rpc|adapter|adapters|sanctions|moderation|kyt)\b/.test(corpus),
  };
};

const inferImplementationTargets = (bundle: GapBundle, availablePaths: string[], limit = 3): string[] => {
  const explicitTargets = bundle.values
    .map((value) => normalizeFolderEntry(value))
    .filter((value): value is string => Boolean(value));
  if (explicitTargets.length > 0) {
    return unique(explicitTargets).slice(0, limit);
  }

  const anchorTokens = tokenizeCoverageSignal(
    normalizeText([bundle.domain, ...bundle.values].join(" ")).replace(/[-/]+/g, " "),
  );
  const domainNeedle = bundle.domain.replace(/[-_]+/g, " ").trim();
  const targetNeeds = deriveSemanticTargetNeeds(bundle);
  const scored = availablePaths
    .map((candidate) => normalizeFolderEntry(candidate))
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => bundle.kind === "folder" || !candidate.startsWith("docs/"))
    .map((candidate) => {
      const classification = classifyImplementationTarget(candidate);
      const normalizedCandidate = classification.normalized.replace(/\//g, " ");
      const overlap = anchorTokens.filter((token) => normalizedCandidate.includes(token)).length;
      const hasDomainMatch = domainNeedle.length > 0 && normalizedCandidate.includes(domainNeedle);
      const semanticEvidence =
        (targetNeeds.wantsVerification && classification.kind === "test") ||
        (targetNeeds.wantsOps && classification.kind === "ops") ||
        (targetNeeds.wantsInterface && classification.kind === "interface") ||
        (targetNeeds.wantsData && classification.kind === "data") ||
        (targetNeeds.wantsProvider &&
          (classification.kind === "interface" ||
            classification.kind === "runtime" ||
            classification.kind === "ops"));
      const hasEvidence = overlap > 0 || hasDomainMatch || semanticEvidence;
      const score =
        implementationRootWeight(candidate) +
        overlap * 20 +
        (hasDomainMatch ? 15 : 0) -
        (candidate.startsWith("docs/") ? 25 : 0) +
        (targetNeeds.wantsVerification && classification.kind === "test" ? 45 : 0) +
        (targetNeeds.wantsOps && classification.kind === "ops" ? 60 : 0) +
        (targetNeeds.wantsInterface && classification.kind === "interface" ? 55 : 0) +
        (targetNeeds.wantsData && classification.kind === "data" ? 55 : 0) +
        (targetNeeds.wantsProvider &&
        (classification.kind === "interface" || classification.kind === "runtime")
          ? 35
          : 0) -
        (classification.kind === "manifest" ? 120 : 0) -
        (classification.kind === "doc" ? 120 : 0);
      return { candidate, classification, score, hasEvidence };
    })
    .filter((entry) => entry.hasEvidence)
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate));
  const hasStrongCandidates = scored.some(
    (entry) =>
      entry.score > 0 &&
      (entry.classification.kind === "runtime" ||
        entry.classification.kind === "interface" ||
        entry.classification.kind === "data" ||
        entry.classification.kind === "test" ||
        entry.classification.kind === "ops"),
  );
  const filtered = scored.filter((entry) => {
    if (entry.score <= 0) return false;
    if (!hasStrongCandidates) return true;
    if (entry.classification.kind === "manifest") return false;
    if (entry.classification.kind === "doc") return false;
    return true;
  });

  return unique((filtered.length > 0 ? filtered : scored.filter((entry) => entry.score > 0)).map((entry) => entry.candidate)).slice(
    0,
    limit,
  );
};

const summarizeImplementationTargets = (targets: string[]): string => {
  if (targets.length === 0) return "target implementation surfaces";
  if (targets.length === 1) return targets[0]!;
  if (targets.length === 2) return `${targets[0]}, ${targets[1]}`;
  return `${targets[0]} (+${targets.length - 1} more)`;
};

const summarizeBundleScope = (bundle: GapBundle): string => {
  const normalizedValues = unique(
    bundle.values
      .map((value) =>
        bundle.kind === "folder" ? normalizeFolderEntry(value) ?? stripDecorators(value) : normalizeHeadingCandidate(value),
      )
      .filter(Boolean),
  );
  if (normalizedValues.length === 0) return bundle.domain.replace(/[-_]+/g, " ").trim() || "coverage";
  if (normalizedValues.length === 1) return normalizedValues[0]!;
  return `${normalizedValues[0]} (+${normalizedValues.length - 1} more)`;
};

const buildRemediationTitle = (bundle: GapBundle, implementationTargets: string[]): string => {
  const domainLabel = bundle.domain.replace(/[-_]+/g, " ").trim() || "coverage";
  const scopeLabel = summarizeBundleScope(bundle);
  if (implementationTargets.length === 0) {
    return `Implement ${scopeLabel || domainLabel}`.slice(0, 180);
  }
  if (bundle.kind === "folder") {
    return `Implement ${summarizeImplementationTargets(implementationTargets)}`.slice(0, 180);
  }
  return `Implement ${scopeLabel} in ${summarizeImplementationTargets(implementationTargets)}`.slice(0, 180);
};

const summarizeAnchorBundle = (bundle: GapBundle): string => {
  if (bundle.normalizedAnchors.length === 0) {
    return `${bundle.kind}:${summarizeBundleScope(bundle)}`;
  }
  if (bundle.normalizedAnchors.length === 1) {
    return bundle.normalizedAnchors[0]!;
  }
  return `${bundle.normalizedAnchors[0]} (+${bundle.normalizedAnchors.length - 1} more)`;
};

const toUnresolvedBundle = (bundle: GapBundle): TaskSufficiencyUnresolvedBundle => ({
  kind: bundle.kind,
  domain: bundle.domain,
  values: [...bundle.values],
  anchors: [...bundle.normalizedAnchors],
});

const buildTargetedTestGuidance = (implementationTargets: string[]): string[] => {
  const guidance = new Set<string>();
  for (const target of implementationTargets) {
    const segments = target
      .toLowerCase()
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.some((segment) => ["ui", "web", "frontend", "page", "pages", "screen", "screens", "component", "components"].includes(segment))) {
      guidance.add("- Add/update unit, component, and flow coverage for the affected user-facing path.");
    } else if (segments.some((segment) => ["api", "server", "backend", "route", "routes", "controller", "controllers", "handler", "handlers"].includes(segment))) {
      guidance.add("- Add/update unit and integration coverage for the affected service/API surface.");
    } else if (segments.some((segment) => ["cli", "cmd", "bin", "command", "commands"].includes(segment))) {
      guidance.add("- Add/update command-level tests and end-to-end invocation coverage for the affected runtime flow.");
    } else if (segments.some((segment) => ["ops", "infra", "deploy", "deployment", "deployments", "script", "scripts"].includes(segment))) {
      guidance.add("- Add/update operational smoke coverage or script validation for the affected deployment/runbook path.");
    } else if (segments.some((segment) => ["db", "data", "schema", "schemas", "migration", "migrations", "model", "models"].includes(segment))) {
      guidance.add("- Add/update persistence, schema, and integration coverage for the affected implementation path.");
    } else if (segments.some((segment) => ["worker", "workers", "job", "jobs", "queue", "task", "tasks", "service", "services", "module", "modules"].includes(segment))) {
      guidance.add("- Add/update unit and integration coverage for the affected implementation path.");
    }
  }
  if (guidance.size === 0) {
    guidance.add("- Add/update the smallest deterministic test scope that proves the affected implementation targets.");
  }
  return Array.from(guidance);
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
        const rawContent = await fs.readFile(filePath, "utf8");
        const content = stripManagedSdsPreflightBlock(rawContent) ?? "";
        if (!content) continue;
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
      corpus: normalizeCoverageText(corpusChunks.join("\n")),
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
    return evaluateSdsCoverage(corpus, { sectionHeadings, folderEntries }, existingAnchors);
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
    const bundles: GapBundle[] = [];
    const activeByDomain = new Map<string, GapBundle>();
    for (const item of gapItems.slice(0, limit)) {
      const domainKey = item.domain;
      let bundle = activeByDomain.get(domainKey);
      if (!bundle || bundle.values.length >= GAP_BUNDLE_MAX_ANCHORS) {
        bundle = {
          kind: item.kind,
          domain: item.domain,
          values: [],
          normalizedAnchors: [],
        };
        bundles.push(bundle);
        activeByDomain.set(domainKey, bundle);
      } else if (bundle.kind !== item.kind) {
        bundle.kind = "mixed";
      }
      if (!bundle.values.includes(item.value)) bundle.values.push(item.value);
      if (!bundle.normalizedAnchors.includes(item.normalizedAnchor)) {
        bundle.normalizedAnchors.push(item.normalizedAnchor);
      }
      if (bundles.length >= limit) break;
    }
    return bundles.slice(0, limit);
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
    gapBundles: PlannedGapBundle[];
    iteration: number;
    jobId: string;
    commandRunId: string;
  }): Promise<TaskRow[]> {
    const existingTaskKeys = await this.workspaceRepo.listTaskKeys(params.storyId);
    const taskKeyGen = createTaskKeyGenerator(params.storyKey, existingTaskKeys);
    const now = new Date().toISOString();
    const taskInserts = params.gapBundles.map(({ bundle, implementationTargets }, index) => {
      if (implementationTargets.length === 0) {
        throw new Error(
          `task-sufficiency-audit attempted to insert a remediation task without implementation targets (${summarizeAnchorBundle(bundle)}).`,
        );
      }
      const scopeCount = bundle.values.length;
      const domainLabel = bundle.domain.replace(/[-_]+/g, " ").trim() || "coverage";
      const title = buildRemediationTitle(bundle, implementationTargets);
      const objective =
        bundle.kind === "folder"
          ? scopeCount <= 1
            ? `Create or update production code under the SDS path \`${bundle.values[0] ?? implementationTargets[0] ?? domainLabel}\`.`
            : `Create or update production code for ${scopeCount} related SDS folder-tree paths in the ${domainLabel} domain.`
          : bundle.kind === "mixed"
            ? `Implement a cohesive capability slice covering both SDS sections and folder targets in the ${domainLabel} domain.`
            : scopeCount <= 1
              ? `Implement the missing production functionality described by SDS section \`${bundle.values[0] ?? domainLabel}\`.`
              : `Implement ${scopeCount} related SDS section requirements in the ${domainLabel} domain.`;
      const scopeLines = bundle.values.map((value) => `- ${value}`);
      const anchorLines = bundle.normalizedAnchors.map((anchor) => `- ${anchor}`);
      const targetLines = implementationTargets.map((target) => `- ${target}`);
      const testingLines = buildTargetedTestGuidance(implementationTargets);
      const description = [
        "## Objective",
        objective,
        "",
        "## Context",
        `- Generated by task-sufficiency-audit iteration ${params.iteration}.`,
        `- Coverage domain: ${bundle.domain}`,
        `- Scope kind: ${bundle.kind}`,
        "",
        "## Anchor Scope",
        ...scopeLines,
        "",
        "## Concrete Implementation Targets",
        ...targetLines,
        "",
        "## Anchor Keys",
        ...anchorLines,
        "",
        "## Implementation Plan",
        "- Phase 1: update the listed implementation targets first; add missing files/scripts/tests only where the SDS requires them.",
        "- Phase 2: implement production logic for each anchor item and keep the work mapped to the concrete targets above.",
        "- Phase 3: wire dependencies, startup/runtime sequencing, and artifact generation affected by this scope.",
        "- Keep implementation traceable to anchor keys in commit and test evidence.",
        "",
        "## Testing",
        ...testingLines,
        "- Execute the smallest deterministic test scope that proves the behavior for the listed targets.",
        "",
        "## Definition of Done",
        "- All anchor scope items in this bundle are represented in working code.",
        "- All concrete implementation targets above are updated or explicitly confirmed unchanged with evidence.",
        "- Validation evidence exists and maps back to each anchor key.",
      ].join("\n");
      const storyPointsBase = bundle.kind === "folder" ? 1 : 2;
      const storyPoints = Math.min(8, Math.max(2, storyPointsBase + scopeCount + (bundle.kind === "mixed" ? 1 : 0)));

      return {
        projectId: params.project.id,
        epicId: params.epicId,
        userStoryId: params.storyId,
        key: taskKeyGen(),
        title,
        description,
        type: "feature",
        status: "not_started",
        storyPoints,
        priority: params.maxPriority + index + 1,
        metadata: {
          sufficiencyAudit: {
            source: "task-sufficiency-audit",
            kind: bundle.kind,
            domain: bundle.domain,
            scopeCount,
            values: bundle.values,
            implementationTargets,
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
      const coverageSignals = collectSdsCoverageSignalsFromDocs(sdsDocs, {
        headingLimit: SDS_HEADING_LIMIT,
        folderLimit: SDS_FOLDER_LIMIT,
      });
      const {
        rawSectionHeadings,
        rawFolderEntries,
        sectionHeadings,
        folderEntries,
        skippedHeadingSignals,
        skippedFolderSignals,
      } = coverageSignals;
      if (skippedHeadingSignals > 0 || skippedFolderSignals > 0) {
        warnings.push(
          `Filtered non-actionable SDS signals (headings=${skippedHeadingSignals}, folders=${skippedFolderSignals}) before remediation.`,
        );
      }
      const noActionableSignals = sectionHeadings.length === 0 && folderEntries.length === 0;
      if (noActionableSignals) {
        warnings.push(
          "No actionable implementation signals detected from SDS headings/folder tree after filtering.",
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

      if (noActionableSignals) {
        throw new Error(
          "task-sufficiency-audit could not derive actionable SDS implementation signals after filtering. Expand SDS implementation headings/folder tree and retry.",
        );
      }

      const iterations: TaskSufficiencyAuditIteration[] = [];
      let totalTasksAdded = 0;
      const totalTasksUpdated = 0;
      let satisfied = false;
      let latestUnresolvedBundles: TaskSufficiencyUnresolvedBundle[] = [];

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
            unresolvedBundleCount: 0,
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
              unresolvedBundleCount: 0,
              action: "complete",
            },
          });
          break;
        }

        const gapItems = this.buildGapItems(coverage, snapshot.existingAnchors, maxTasksPerIteration);
        const gapBundles = this.bundleGapItems(gapItems, maxTasksPerIteration);
        if (gapBundles.length === 0) {
          latestUnresolvedBundles = [];
          warnings.push(
            `Iteration ${iteration}: unresolved SDS gaps remain but no insertable gap items were identified.`,
          );
          iterations.push({
            iteration,
            coverageRatio: coverage.coverageRatio,
            totalSignals: coverage.totalSignals,
            missingSectionCount: coverage.missingSectionHeadings.length,
            missingFolderCount: coverage.missingFolderEntries.length,
            unresolvedBundleCount: 0,
            createdTaskKeys: [],
          });
          break;
        }

        const plannedGapBundles = gapBundles.map((bundle) => ({
          bundle,
          implementationTargets: inferImplementationTargets(bundle, folderEntries, 3),
        }));
        const actionableGapBundles = plannedGapBundles.filter((entry) => entry.implementationTargets.length > 0);
        const unresolvedGapBundles = plannedGapBundles.filter((entry) => entry.implementationTargets.length === 0);
        latestUnresolvedBundles = unresolvedGapBundles.map((entry) => toUnresolvedBundle(entry.bundle));
        if (unresolvedGapBundles.length > 0) {
          warnings.push(
            `Iteration ${iteration}: ${unresolvedGapBundles.length} SDS gap bundle(s) remain unresolved because no concrete implementation targets were inferred (${unresolvedGapBundles
              .map((entry) => summarizeAnchorBundle(entry.bundle))
              .join("; ")}).`,
          );
        }
        if (actionableGapBundles.length === 0) {
          warnings.push(
            `Iteration ${iteration}: unresolved SDS gaps remain but no executable remediation tasks could be generated.`,
          );
          iterations.push({
            iteration,
            coverageRatio: coverage.coverageRatio,
            totalSignals: coverage.totalSignals,
            missingSectionCount: coverage.missingSectionHeadings.length,
            missingFolderCount: coverage.missingFolderEntries.length,
            unresolvedBundleCount: latestUnresolvedBundles.length,
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
              unresolvedBundleCount: latestUnresolvedBundles.length,
              action: "unresolved",
              unresolvedGapItems: latestUnresolvedBundles,
            },
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
            unresolvedBundleCount: latestUnresolvedBundles.length,
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
              unresolvedBundleCount: latestUnresolvedBundles.length,
              action: "dry_run",
              proposedGapItems: actionableGapBundles.map((entry) => ({
                kind: entry.bundle.kind,
                domain: entry.bundle.domain,
                values: entry.bundle.values,
                implementationTargets: entry.implementationTargets,
              })),
              unresolvedGapItems: latestUnresolvedBundles,
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
          gapBundles: actionableGapBundles,
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
          unresolvedBundleCount: latestUnresolvedBundles.length,
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
            unresolvedBundleCount: latestUnresolvedBundles.length,
            createdTaskKeys,
            addedCount: createdTaskKeys.length,
          },
        });
        await this.jobService.appendLog(
          job.id,
          `Iteration ${iteration}: added ${createdTaskKeys.length} remediation task(s) from ${actionableGapBundles.length} actionable gap bundle(s): ${createdTaskKeys.join(", ")}\n`,
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
      const finalGapItemLimit = Math.max(
        1,
        finalCoverage.missingSectionHeadings.length + finalCoverage.missingFolderEntries.length,
      );
      const finalGapItems = this.buildGapItems(finalCoverage, finalSnapshot.existingAnchors, finalGapItemLimit);
      const finalGapBundles = this.bundleGapItems(finalGapItems, finalGapItemLimit);
      const finalPlannedGapBundles = finalGapBundles.map((bundle) => ({
        bundle,
        implementationTargets: inferImplementationTargets(bundle, folderEntries, 3),
      }));
      const plannedGapBundles = finalPlannedGapBundles.map(toPlannedGapBundle);
      const unresolvedBundles = finalPlannedGapBundles
        .filter((entry) => entry.implementationTargets.length === 0)
        .map((entry) => toUnresolvedBundle(entry.bundle));

      const report = {
        projectKey: request.projectKey,
        sourceCommand,
        generatedAt: new Date().toISOString(),
        coverageHeuristicsVersion: COVERAGE_HEURISTICS_VERSION,
        dryRun,
        maxIterations,
        maxTasksPerIteration,
        minCoverageRatio,
        satisfied,
        totalTasksAdded,
        totalTasksUpdated,
        docs: sdsDocs.map((doc) => {
          const signals = collectSdsImplementationSignals(doc.content, {
            headingLimit: SDS_HEADING_LIMIT,
            folderLimit: SDS_FOLDER_LIMIT,
          });
          return {
            path: path.relative(request.workspace.workspaceRoot, doc.path),
            headingSignals: signals.sectionHeadings.length,
            folderSignals: signals.folderEntries.length,
            rawHeadingSignals: signals.rawSectionHeadings.length,
            rawFolderSignals: signals.rawFolderEntries.length,
          };
        }),
        finalCoverage: {
          coverageRatio: finalCoverage.coverageRatio,
          totalSignals: finalCoverage.totalSignals,
          missingSectionHeadings: finalCoverage.missingSectionHeadings,
          missingFolderEntries: finalCoverage.missingFolderEntries,
        },
        plannedGapBundles,
        unresolvedBundles,
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
          finalTotalSignals: finalCoverage.totalSignals,
          finalCoverageRatio: finalCoverage.coverageRatio,
          unresolvedBundleCount: unresolvedBundles.length,
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
        finalTotalSignals: finalCoverage.totalSignals,
        finalCoverageRatio: finalCoverage.coverageRatio,
        remainingSectionHeadings: finalCoverage.missingSectionHeadings,
        remainingFolderEntries: finalCoverage.missingFolderEntries,
        remainingGaps: {
          sections: finalCoverage.missingSectionHeadings.length,
          folders: finalCoverage.missingFolderEntries.length,
          total: finalCoverage.missingSectionHeadings.length + finalCoverage.missingFolderEntries.length,
        },
        plannedGapBundles,
        unresolvedBundles,
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
          finalTotalSignals: finalCoverage.totalSignals,
          finalCoverageRatio: finalCoverage.coverageRatio,
          remainingSectionCount: finalCoverage.missingSectionHeadings.length,
          remainingFolderCount: finalCoverage.missingFolderEntries.length,
          unresolvedBundleCount: unresolvedBundles.length,
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
