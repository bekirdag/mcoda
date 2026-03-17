import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { AgentService } from "@mcoda/agents";
import {
  EpicInsert,
  EpicRow,
  GlobalRepository,
  ProjectBacklogSummary,
  StoryInsert,
  StoryRow,
  TaskDependencyInsert,
  TaskDependencyRow,
  TaskInsert,
  TaskRow,
  WorkspaceRepository,
} from "@mcoda/db";
import { Agent, type QaEntrypoint, type QaReadiness } from "@mcoda/shared";
import { setTimeout as delay } from "node:timers/promises";
import { DocdexClient, DocdexDocument } from "@mcoda/integrations";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { RoutingService } from "../agents/RoutingService.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import { classifyTask } from "../backlog/TaskOrderingHeuristics.js";
import { TaskOrderingService } from "../backlog/TaskOrderingService.js";
import { QaTestCommandBuilder } from "../execution/QaTestCommandBuilder.js";
import {
  createEpicKeyGenerator,
  createStoryKeyGenerator,
  createTaskKeyGenerator,
} from "./KeyHelpers.js";
import {
  collectSdsCoverageSignalsFromDocs,
  evaluateSdsCoverage,
  normalizeCoverageText,
  type SdsCoverageSummary,
} from "./SdsCoverageModel.js";
import {
  collectSdsImplementationSignals,
  extractStructuredPaths,
  filterImplementationStructuredPaths,
  headingLooksImplementationRelevant,
  isStructuredFilePath,
  normalizeFolderEntry,
  normalizeHeadingCandidate,
  normalizeStructuredPathToken,
  stripManagedSdsPreflightBlock,
} from "./SdsStructureSignals.js";
import {
  TaskSufficiencyService,
  type TaskSufficiencyAuditResult,
  type TaskSufficiencyPlannedGapBundle,
} from "./TaskSufficiencyService.js";
import { SdsPreflightService, type SdsPreflightResult } from "./SdsPreflightService.js";

export interface CreateTasksOptions {
  workspace: WorkspaceResolution;
  projectKey: string;
  inputs: string[];
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  maxEpics?: number;
  maxStoriesPerEpic?: number;
  maxTasksPerStory?: number;
  force?: boolean;
  qaProfiles?: string[];
  qaEntryUrl?: string;
  qaStartCommand?: string;
  qaRequires?: string[];
  sdsPreflightApplyToSds?: boolean;
  sdsPreflightCommit?: boolean;
  sdsPreflightCommitMessage?: string;
  unknownEpicServicePolicy?: EpicServiceValidationPolicy;
}

export interface CreateTasksResult {
  jobId: string;
  commandRunId: string;
  epics: EpicRow[];
  stories: StoryRow[];
  tasks: TaskRow[];
  dependencies: TaskDependencyRow[];
  warnings: string[];
  completionReport?: {
    score: number;
    threshold: number;
    satisfied: boolean;
    reportPath: string;
    architectureUnitCount: number;
    coveredArchitectureUnitCount: number;
    implementationTaskCount: number;
    verificationTaskCount: number;
    warnings: string[];
  };
  sufficiencyAudit?: {
    jobId: string;
    commandRunId: string;
    satisfied: boolean;
    totalTasksAdded: number;
    totalTasksUpdated: number;
    finalCoverageRatio: number;
    reportPath: string;
    remainingSectionCount: number;
    remainingFolderCount: number;
    remainingGapCount: number;
    unresolvedBundleCount: number;
    acceptedWithResidualSectionGaps: boolean;
    warnings: string[];
  };
}

interface AgentTaskNode {
  localId?: string;
  title: string;
  type?: string;
  description?: string;
  files?: string[];
  estimatedStoryPoints?: number;
  priorityHint?: number;
  dependsOnKeys?: string[];
  relatedDocs?: string[];
  unitTests?: string[];
  componentTests?: string[];
  integrationTests?: string[];
  apiTests?: string[];
  qa?: QaReadiness;
}

interface AgentStoryNode {
  localId?: string;
  title: string;
  userStory?: string;
  description?: string;
  acceptanceCriteria?: string[];
  relatedDocs?: string[];
  priorityHint?: number;
  tasks: AgentTaskNode[];
}

interface AgentEpicNode {
  localId?: string;
  area?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  relatedDocs?: string[];
  priorityHint?: number;
  serviceIds?: string[];
  tags?: string[];
  stories: AgentStoryNode[];
}

interface AgentPlan {
  epics: AgentEpicNode[];
}

interface PlanEpic extends AgentEpicNode {
  localId: string;
}

interface PlanStory extends AgentStoryNode {
  localId: string;
  epicLocalId: string;
}

interface PlanTask extends AgentTaskNode {
  localId: string;
  storyLocalId: string;
  epicLocalId: string;
}

interface GeneratedPlan {
  epics: PlanEpic[];
  stories: PlanStory[];
  tasks: PlanTask[];
}

type ServiceDependencyGraph = {
  services: string[];
  dependencies: Map<string, Set<string>>;
  aliases: Map<string, Set<string>>;
  waveRank: Map<string, number>;
  startupWaves: Array<{ wave: number; services: string[] }>;
  foundationalDependencies: string[];
};

type TopologySignalSummary = {
  structureServices: string[];
  topologyHeadings: string[];
  dependencyPairs: string[];
  waveMentions: string[];
};

type SourceTopologyExpectation = {
  runtimeBearing: boolean;
  services: string[];
  startupWaves: Array<{ wave: number; services: string[] }>;
  dependencyPairs: string[];
  signalSummary: TopologySignalSummary;
};

type CanonicalNameInventory = {
  paths: string[];
  pathSet: Set<string>;
  services: string[];
  serviceAliases: Map<string, Set<string>>;
};

type ServiceCatalogEntry = {
  id: string;
  name: string;
  aliases: string[];
  startupWave?: number;
  dependsOnServiceIds: string[];
  isFoundational: boolean;
};

type ServiceCatalogArtifact = {
  projectKey: string;
  generatedAt: string;
  sourceDocs: string[];
  services: ServiceCatalogEntry[];
};

type EpicServiceValidationPolicy = "auto-remediate" | "fail";

type QaPreflight = {
  scripts: Record<string, string>;
  entrypoints: QaEntrypoint[];
  blockers: string[];
};

type ProjectBuildPlanArtifact = {
  projectKey: string;
  generatedAt: string;
  sourceDocs: string[];
  startupWaves: Array<{ wave: number; services: string[] }>;
  services: string[];
  serviceIds: string[];
  foundationalDependencies: string[];
  buildMethod: string;
};

type BacklogQualityMetric = {
  numerator: number;
  denominator: number;
  ratio: number;
};

type BacklogQualityPenalty = {
  count: number;
  ratio: number;
};

type BacklogQualityIssue = {
  code: string;
  count: number;
  taskKeys: string[];
  message: string;
};

type BacklogQualityReport = {
  projectKey: string;
  generatedAt: string;
  score: number;
  summary: string;
  architectureRoots: string[];
  metrics: {
    taskCounts: {
      total: number;
      implementation: number;
      verification: number;
      docs: number;
    };
    implementationFileCoverage: BacklogQualityMetric;
    verificationReadinessCoverage: BacklogQualityMetric;
    dependencyCoverage: BacklogQualityMetric;
    docsOnlyPenalty: BacklogQualityPenalty;
    architectureDriftPenalty: BacklogQualityPenalty;
  };
  issues: BacklogQualityIssue[];
};

type ArchitectureUnitKind = "service" | "cross_cutting" | "release_gate";

type ArchitectureVerificationSurfaceKind = "suite" | "scenario" | "gate";

type ArchitectureVerificationSurface = {
  surfaceId: string;
  kind: ArchitectureVerificationSurfaceKind;
  name: string;
  summary: string;
  sourceCoverage?: string;
  targetHints: string[];
  relatedUnitIds: string[];
};

type ArchitectureUnit = {
  unitId: string;
  kind: ArchitectureUnitKind;
  name: string;
  summary: string;
  sourceHeadings: string[];
  implementationTargets: string[];
  supportingTargets: string[];
  verificationTargets: string[];
  verificationSurfaceIds: string[];
  dependsOnUnitIds: string[];
  startupWave?: number;
  isFoundational: boolean;
  sourceServiceIds: string[];
  completionSignals: string[];
};

type CanonicalArchitectureArtifact = {
  projectKey: string;
  generatedAt: string;
  sourceDocs: string[];
  architectureRoots: string[];
  services: string[];
  crossCuttingDomains: string[];
  verificationSurfaces: ArchitectureVerificationSurface[];
  units: ArchitectureUnit[];
  dependencyOrder: string[];
  startupWaves: Array<{ wave: number; units: string[] }>;
};

type ProjectCompletionMetric = {
  numerator: number;
  denominator: number;
  ratio: number;
};

type ProjectCompletionPenalty = {
  count: number;
  ratio: number;
};

type ProjectCompletionIssue = {
  code: string;
  count: number;
  unitIds: string[];
  taskKeys: string[];
  message: string;
};

type ProjectCompletionUnitCoverage = {
  unitId: string;
  kind: ArchitectureUnitKind;
  name: string;
  implementationTaskKeys: string[];
  verificationTaskKeys: string[];
  satisfied: boolean;
};

type ProjectCompletionReport = {
  projectKey: string;
  generatedAt: string;
  score: number;
  threshold: number;
  satisfied: boolean;
  summary: string;
  architectureRoots: string[];
  metrics: {
    architectureUnitCoverage: ProjectCompletionMetric;
    implementationSurfaceCoverage: ProjectCompletionMetric;
    crossCuttingCoverage: ProjectCompletionMetric;
    dependencyOrderCoverage: ProjectCompletionMetric;
    verificationSupportCoverage: ProjectCompletionMetric;
    implementationToVerificationBalance: ProjectCompletionMetric;
    docsOnlyPenalty: ProjectCompletionPenalty;
    metaTaskPenalty: ProjectCompletionPenalty;
  };
  issues: ProjectCompletionIssue[];
  unitCoverage: ProjectCompletionUnitCoverage[];
};

type StrictAgentPlanningMode = "strict_full_plan" | "strict_staged_plan";

type SdsServiceBuildUnit = {
  serviceId: string;
  serviceName: string;
  aliases: string[];
  startupWave?: number;
  dependsOnServiceIds: string[];
  directories: string[];
  files: string[];
  headings: string[];
  isFoundational: boolean;
};

type SdsVerificationSuite = {
  name: string;
  scope?: string;
  sourceCoverage?: string;
};

type SdsAcceptanceScenario = {
  index: number;
  title: string;
  details: string;
};

type BuildTargetPurpose = "structure" | "implementation" | "verification";

type BuildTargetClassification = {
  normalized: string;
  basename: string;
  segments: string[];
  isFile: boolean;
  kind: "runtime" | "interface" | "data" | "test" | "ops" | "manifest" | "doc" | "unknown";
  isServiceArtifact: boolean;
};

type PersistPlanOptions = {
  force?: boolean;
  resetKeys?: boolean;
  qaPreflight?: QaPreflight;
  qaOverrides?: QaReadiness;
};

type TaskOrderingClient = Pick<TaskOrderingService, "orderTasks" | "close">;
type TaskOrderingFactory = (
  workspace: WorkspaceResolution,
  options?: { recordTelemetry?: boolean },
) => Promise<TaskOrderingClient>;

type TaskSufficiencyClient = Pick<TaskSufficiencyService, "runAudit" | "close">;
type TaskSufficiencyFactory = (workspace: WorkspaceResolution) => Promise<TaskSufficiencyClient>;
type SdsPreflightClient = Pick<SdsPreflightService, "runPreflight" | "close">;
type SdsPreflightFactory = (workspace: WorkspaceResolution) => Promise<SdsPreflightClient>;

const formatBullets = (items: string[] | undefined, fallback: string): string => {
  if (!items || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeEntrypoints = (value: unknown): QaEntrypoint[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const kind = record.kind;
      if (kind !== "web" && kind !== "api" && kind !== "cli") return null;
      return {
        kind,
        base_url: typeof record.base_url === "string" ? record.base_url : undefined,
        command: typeof record.command === "string" ? record.command : undefined,
      } as QaEntrypoint;
    })
    .filter((entry): entry is QaEntrypoint => Boolean(entry));
};

const normalizeQaReadiness = (value: unknown): QaReadiness | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const qa: QaReadiness = {
    profiles_expected: normalizeStringArray(record.profiles_expected),
    requires: normalizeStringArray(record.requires),
    entrypoints: normalizeEntrypoints(record.entrypoints),
    data_setup: normalizeStringArray(record.data_setup),
    blockers: normalizeStringArray(record.blockers),
    notes: typeof record.notes === "string" ? record.notes : undefined,
  };
  const hasValues =
    (qa.profiles_expected?.length ?? 0) > 0 ||
    (qa.requires?.length ?? 0) > 0 ||
    (qa.entrypoints?.length ?? 0) > 0 ||
    (qa.data_setup?.length ?? 0) > 0 ||
    (qa.blockers?.length ?? 0) > 0 ||
    (qa.notes?.length ?? 0) > 0;
  return hasValues ? qa : undefined;
};

const uniqueStrings = (items: string[]): string[] => Array.from(new Set(items));

const uniqueEntrypoints = (items: QaEntrypoint[]): QaEntrypoint[] => {
  const seen = new Set<string>();
  const result: QaEntrypoint[] = [];
  for (const entry of items) {
    const key = `${entry.kind}|${entry.base_url ?? ""}|${entry.command ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
};

const buildQaReadiness = (params: {
  classification: { stage: string };
  planQa?: QaReadiness;
  preflight?: QaPreflight;
  overrides?: QaReadiness;
}): QaReadiness => {
  const derivedProfiles = ["cli"];
  if (params.classification.stage === "frontend") derivedProfiles.push("chromium");
  if (params.classification.stage === "backend") derivedProfiles.push("api");
  const profilesExpected = uniqueStrings([
    ...derivedProfiles,
    ...(params.overrides?.profiles_expected ?? []),
    ...(params.planQa?.profiles_expected ?? []),
  ]);
  const entrypoints = uniqueEntrypoints([
    ...(params.overrides?.entrypoints ?? []),
    ...(params.planQa?.entrypoints ?? []),
    ...(params.classification.stage === "frontend" ? params.preflight?.entrypoints ?? [] : []),
  ]);
  const blockers = uniqueStrings([
    ...(params.overrides?.blockers ?? []),
    ...(params.planQa?.blockers ?? []),
    ...(params.preflight?.blockers ?? []),
  ]);
  if (params.classification.stage === "frontend" && entrypoints.length === 0) {
    blockers.push("Missing UI entrypoint (dev/start script).");
  }
  return {
    profiles_expected: profilesExpected,
    requires: uniqueStrings([...(params.overrides?.requires ?? []), ...(params.planQa?.requires ?? [])]),
    entrypoints: entrypoints.length ? entrypoints : undefined,
    data_setup: uniqueStrings([...(params.overrides?.data_setup ?? []), ...(params.planQa?.data_setup ?? [])]),
    blockers: blockers.length ? blockers : undefined,
    notes: params.overrides?.notes ?? params.planQa?.notes,
  };
};

const formatTestList = (items: string[] | undefined): string => {
  if (!items || items.length === 0) return "Not applicable";
  return items.join("; ");
};

const ensureNonEmpty = (value: string | undefined, fallback: string): string =>
  value && value.trim().length > 0 ? value.trim() : fallback;

const normalizeTaskLine = (line: string): string => line.replace(/^[-*]\s+/, "").trim();

const looksLikeSectionHeader = (line: string): boolean => /^\* \*\*.+\*\*$/.test(line.trim());

const isReferenceOnlyLine = (line: string): boolean =>
  /^(epic|story|references?|related docs?|inputs?|objective|context|implementation plan|definition of done|testing & qa)\s*:/i.test(
    line.trim(),
  );

const extractActionableLines = (description: string | undefined, limit: number): string[] => {
  if (!description) return [];
  const lines = description
    .split(/\r?\n/)
    .map((line) => normalizeTaskLine(line))
    .filter(Boolean)
    .filter((line) => !looksLikeSectionHeader(line))
    .filter((line) => !isReferenceOnlyLine(line));
  const actionable = lines.filter((line) =>
    /^(?:\d+[.)]\s+|implement\b|create\b|update\b|add\b|define\b|wire\b|integrate\b|enforce\b|publish\b|configure\b|materialize\b|validate\b|verify\b)/i.test(
      line,
    ),
  );
  const source = actionable.length > 0 ? actionable : lines;
  return uniqueStrings(source.slice(0, limit));
};

const extractRiskLines = (description: string | undefined, limit: number): string[] => {
  if (!description) return [];
  const lines = description
    .split(/\r?\n/)
    .map((line) => normalizeTaskLine(line))
    .filter(Boolean)
    .filter((line) => !looksLikeSectionHeader(line));
  const risks = lines.filter((line) => /\b(risk|edge case|gotcha|constraint|failure|flaky|drift|regression)\b/i.test(line));
  return uniqueStrings(risks.slice(0, limit));
};

const extractScriptPort = (script: string): number | undefined => {
  const matches = [script.match(/(?:--port|-p)\s*(\d{2,5})/), script.match(/PORT\s*=\s*(\d{2,5})/)];
  for (const match of matches) {
    if (!match) continue;
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};

const inferPackageScriptCommand = (pkg: Record<string, unknown> | null, scriptName: string): string => {
  const packageManager = typeof pkg?.packageManager === "string" ? pkg.packageManager.toLowerCase() : "";
  if (packageManager.startsWith("yarn")) return `yarn ${scriptName}`;
  if (packageManager.startsWith("pnpm")) return `pnpm ${scriptName}`;
  if (packageManager.startsWith("bun")) return `bun run ${scriptName}`;
  if (packageManager.startsWith("npm")) return scriptName === "start" ? "npm start" : `npm run ${scriptName}`;
  return `package script:${scriptName}`;
};

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
const DOC_CONTEXT_BUDGET = 8000;
const DOC_CONTEXT_SEGMENTS_PER_DOC = 8;
const DOC_CONTEXT_FALLBACK_CHUNK_LENGTH = 480;
const SDS_COVERAGE_HINT_HEADING_LIMIT = 24;
const SDS_COVERAGE_REPORT_SECTION_LIMIT = 80;
const SDS_COVERAGE_REPORT_FOLDER_LIMIT = 240;
const COVERAGE_SDS_SCAN_MAX_FILES = 120;
const OPENAPI_HINT_OPERATIONS_LIMIT = 30;
const DOCDEX_HANDLE = /^docdex:/i;
const DOCDEX_LOCAL_HANDLE = /^docdex:local[-:/]/i;
const coverageSdsIgnoredDirs = new Set([".git", "node_modules", "dist", "build", ".mcoda", ".docdex"]);
const coverageSdsFilenamePattern = /(sds|software[-_ ]design|system[-_ ]design|design[-_ ]spec)/i;
const coverageSdsContentPattern = /(software design specification|system design specification|^#\s*sds\b)/im;
const RELATED_DOC_PATH_PATTERN =
  /^(?:~\/|\/|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+\/)[A-Za-z0-9._/-]+(?:\.[A-Za-z0-9._-]+)?(?:#[A-Za-z0-9._:-]+)?$/;
const RELATIVE_DOC_PATH_PATTERN = /^(?:\.{1,2}\/)+[A-Za-z0-9._/-]+(?:\.[A-Za-z0-9._-]+)?(?:#[A-Za-z0-9._:-]+)?$/;
const FUZZY_DOC_CANDIDATE_LIMIT = 64;
const DEPENDENCY_SCAN_LINE_LIMIT = 1400;
const STARTUP_WAVE_SCAN_LINE_LIMIT = 4000;
const VALID_TASK_TYPES = new Set(["feature", "bug", "chore", "spike"]);
const VALID_EPIC_SERVICE_POLICIES = new Set<EpicServiceValidationPolicy>(["auto-remediate", "fail"]);
const CROSS_SERVICE_TAG = "cross_service";
const PROJECT_COMPLETION_SCORE_THRESHOLD = 80;
const ARCHITECTURE_SERVICE_MATCH_SCORE = 25;
const ARCHITECTURE_SERVICE_HINT_SCORE = 15;
const STRICT_AGENT_FULL_PLAN_PROMPT_TOKEN_LIMIT = 7000;
const STRICT_AGENT_STORY_BATCH_PROMPT_TOKEN_LIMIT = 12000;
const STRICT_AGENT_TASK_BATCH_PROMPT_TOKEN_LIMIT = 12000;
const STRICT_AGENT_MAX_EPICS_PER_STORY_BATCH = 3;
const STRICT_AGENT_MAX_STORIES_PER_TASK_BATCH = 4;
const STRICT_AGENT_BATCH_DOC_SUMMARY_TOKEN_LIMIT = 1800;
const STRICT_AGENT_BATCH_BUILD_METHOD_TOKEN_LIMIT = 1200;
const STRICT_AGENT_STAGED_EPICS_DOC_SUMMARY_TOKEN_LIMIT = 800;
const STRICT_AGENT_STAGED_EPICS_BUILD_METHOD_TOKEN_LIMIT = 500;
const STRICT_AGENT_STAGED_EPICS_ARCHITECTURE_TOKEN_LIMIT = 1000;
const STRICT_AGENT_STAGED_EPICS_SERVICE_CATALOG_TOKEN_LIMIT = 800;
const STRICT_AGENT_EPIC_BATCH_PROMPT_TOKEN_LIMIT = 1600;
const STRICT_AGENT_MAX_UNITS_PER_EPIC_BATCH = 1;
const STRICT_AGENT_EPIC_BATCH_TIMEOUT_BASE_MS = 90_000;
const STRICT_AGENT_EPIC_BATCH_TIMEOUT_PER_UNIT_MS = 45_000;
const STRICT_AGENT_EPIC_REPAIR_TIMEOUT_MS = 120_000;
const STRICT_AGENT_STORY_BATCH_TIMEOUT_BASE_MS = 120_000;
const STRICT_AGENT_STORY_BATCH_TIMEOUT_PER_EPIC_MS = 45_000;
const STRICT_AGENT_TASK_BATCH_TIMEOUT_BASE_MS = 120_000;
const STRICT_AGENT_TASK_BATCH_TIMEOUT_PER_STORY_MS = 30_000;
const STRICT_AGENT_SINGLE_STORY_DOC_SUMMARY_TOKEN_LIMIT = 1200;
const STRICT_AGENT_SINGLE_STORY_BUILD_METHOD_TOKEN_LIMIT = 900;
const STRICT_AGENT_SINGLE_TASK_DOC_SUMMARY_TOKEN_LIMIT = 1200;
const STRICT_AGENT_SINGLE_TASK_BUILD_METHOD_TOKEN_LIMIT = 900;
const STRICT_AGENT_COMPACT_TASK_STRUCTURED_PROMPT_TOKEN_LIMIT = 1200;
const STRICT_AGENT_COMPACT_TASK_RUNTIME_PROMPT_TOKEN_LIMIT = 1000;
const STRICT_AGENT_COMPACT_TASK_MINIMAL_PROMPT_TOKEN_LIMIT = 650;
const STRICT_AGENT_COMPACT_TASK_FULL_STORY_TOKEN_LIMIT = 260;
const STRICT_AGENT_COMPACT_TASK_MINIMAL_STORY_TOKEN_LIMIT = 140;
const STRICT_AGENT_COMPACT_TASK_FULL_ACCEPTANCE_TOKEN_LIMIT = 180;
const STRICT_AGENT_COMPACT_TASK_MINIMAL_ACCEPTANCE_TOKEN_LIMIT = 90;
const STRICT_AGENT_COMPACT_TASK_FULL_DOC_TOKEN_LIMIT = 140;
const STRICT_AGENT_COMPACT_TASK_MINIMAL_DOC_TOKEN_LIMIT = 60;
const STRICT_AGENT_COMPACT_TASK_FULL_BUILD_TOKEN_LIMIT = 160;
const STRICT_AGENT_COMPACT_TASK_MINIMAL_BUILD_TOKEN_LIMIT = 70;
const STRICT_AGENT_MAX_TASKS_PER_COMPACT_REWRITE = 3;
const META_TASK_PATTERN =
  /\b(plan|planning|backlog|coverage|artifact|evidence capture|document baseline|update refine log|record refinement|review inputs)\b/i;

const compactPromptContext = (value: string | undefined, maxTokens: number, fallback = "none"): string => {
  const text = value?.trim();
  if (!text) return fallback;
  if (estimateTokens(text) <= maxTokens) return text;
  const pieces = text
    .split(/\n{2,}|\r?\n|(?<=[.!?])\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const kept: string[] = [];
  let budget = maxTokens;
  for (const piece of pieces) {
    const cost = estimateTokens(piece);
    if (cost <= budget) {
      kept.push(piece);
      budget -= cost;
      continue;
    }
    if (kept.length === 0) {
      const maxChars = Math.max(80, maxTokens * 4 - 3);
      kept.push(`${piece.slice(0, maxChars).trimEnd()}...`);
    } else {
      kept.push("...");
    }
    break;
  }
  return kept.join("\n");
};

const inferDocType = (filePath: string): string => {
  const name = path.basename(filePath).toLowerCase();
  if (API_CONTRACT_LIKE_PATH_PATTERN.test(name)) return "OPENAPI";
  if (name.includes("sds")) return "SDS";
  if (name.includes("pdr")) return "PDR";
  if (name.includes("rfp")) return "RFP";
  return "DOC";
};

const normalizeArea = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized.slice(0, 24) : undefined;
};

const normalizeTaskType = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const tokens = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (VALID_TASK_TYPES.has(token)) return token;
  }
  return undefined;
};

const normalizeEpicServicePolicy = (value: unknown): EpicServiceValidationPolicy | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase() as EpicServiceValidationPolicy;
  if (!VALID_EPIC_SERVICE_POLICIES.has(normalized)) return undefined;
  return normalized;
};

const normalizeEpicTags = (value: unknown): string[] =>
  uniqueStrings(
    normalizeStringArray(value)
      .map((item) => item.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""))
      .filter(Boolean),
  );

const normalizeRelatedDocs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    const candidate =
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object" && "handle" in entry && typeof entry.handle === "string"
          ? entry.handle.trim()
          : "";
    if (!candidate) continue;
    if (DOCDEX_LOCAL_HANDLE.test(candidate)) continue;
    const isDocHandle = DOCDEX_HANDLE.test(candidate);
    const isHttp = /^https?:\/\/\S+$/i.test(candidate);
    const isPath = RELATED_DOC_PATH_PATTERN.test(candidate) || RELATIVE_DOC_PATH_PATTERN.test(candidate);
    if (!isDocHandle && !isHttp && !isPath) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
};

const pickDistributedIndices = (length: number, limit: number): number[] => {
  if (length <= 0 || limit <= 0) return [];
  if (length <= limit) return Array.from({ length }, (_, index) => index);
  const selected = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const ratio = limit === 1 ? 0 : index / (limit - 1);
    selected.add(Math.round(ratio * (length - 1)));
  }
  return Array.from(selected)
    .sort((a, b) => a - b)
    .slice(0, limit);
};

const sampleRawContent = (value: string | undefined, chunkLength: number): string[] => {
  if (!value) return [];
  const content = value.trim();
  if (!content) return [];
  if (content.length <= chunkLength) return [content];
  const anchors = [
    0,
    Math.max(0, Math.floor(content.length / 2) - Math.floor(chunkLength / 2)),
    Math.max(0, content.length - chunkLength),
  ];
  const sampled = anchors.map((anchor) => content.slice(anchor, anchor + chunkLength).trim()).filter(Boolean);
  return uniqueStrings(sampled);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseStructuredDoc = (raw: string): Record<string, unknown> | undefined => {
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    const parsed = YAML.parse(raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // fallback to JSON parse
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // ignore invalid fallback parse
  }
  return undefined;
};

const describeDoc = (doc: DocdexDocument, idx: number): string => {
  const title = doc.title ?? doc.path ?? doc.id ?? `doc-${idx + 1}`;
  const source = doc.path ?? doc.id ?? "docdex";
  const head = doc.content ? doc.content.split(/\r?\n/).slice(0, 3).join(" ").slice(0, 240) : "";
  return `- [${doc.docType}] ${title} (handle: docdex:${doc.id ?? `doc-${idx + 1}`}, source: ${source})${
    head ? `\n  Excerpt: ${head}` : ""
  }`;
};

const extractJson = (raw: string): any | undefined => {
  const fencedMatches = [...raw.matchAll(/```json([\s\S]*?)```/g)].map((match) => match[1]);
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const candidates = [...fencedMatches, stripped, raw].filter((candidate) => candidate.trim().length > 0);
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return undefined;
};

const tryParseJson = (value: string): any | undefined => {
  try {
    return JSON.parse(value);
  } catch {
    // continue
  }
  const objects = extractJsonObjects(value).reverse();
  for (const obj of objects) {
    try {
      return JSON.parse(obj);
    } catch {
      // continue
    }
  }
  return undefined;
};

const extractJsonObjects = (value: string): string[] => {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(value.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
};

const normalizeAgentFailoverEvents = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.type !== "string" || entry.type.trim().length === 0) continue;
    events.push({ ...entry });
  }
  return events;
};

const mergeAgentFailoverEvents = (
  left: Array<Record<string, unknown>>,
  right: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  if (!left.length) return right;
  if (!right.length) return left;
  const seen = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  const signature = (event: Record<string, unknown>): string =>
    [
      event.type ?? "",
      event.fromAgentId ?? "",
      event.toAgentId ?? "",
      event.at ?? "",
      event.until ?? "",
      event.durationMs ?? "",
    ].join("|");
  for (const event of [...left, ...right]) {
    const key = signature(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged;
};

const mergeAgentInvocationMetadata = (
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!current && !incoming) return undefined;
  if (!incoming) return current;
  if (!current) return { ...incoming };
  const merged: Record<string, unknown> = { ...current, ...incoming };
  const currentEvents = normalizeAgentFailoverEvents(current.failoverEvents);
  const incomingEvents = normalizeAgentFailoverEvents(incoming.failoverEvents);
  if (currentEvents.length > 0 || incomingEvents.length > 0) {
    merged.failoverEvents = mergeAgentFailoverEvents(currentEvents, incomingEvents);
  }
  return merged;
};

const summarizeAgentFailoverEvent = (event: Record<string, unknown>): string => {
  const type = String(event.type ?? "unknown");
  if (type === "switch_agent") {
    const from = typeof event.fromAgentId === "string" ? event.fromAgentId : "unknown";
    const to = typeof event.toAgentId === "string" ? event.toAgentId : "unknown";
    return `switch_agent ${from} -> ${to}`;
  }
  if (type === "sleep_until_reset") {
    const duration =
      typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
        ? `${Math.round(event.durationMs / 1000)}s`
        : "unknown duration";
    const until = typeof event.until === "string" ? event.until : "unknown";
    return `sleep_until_reset ${duration} (until ${until})`;
  }
  if (type === "stream_restart_after_limit") {
    const from = typeof event.fromAgentId === "string" ? event.fromAgentId : "unknown";
    return `stream_restart_after_limit from ${from}`;
  }
  return type;
};

const resolveTerminalFailoverAgentId = (
  events: Array<Record<string, unknown>>,
  fallbackAgentId: string,
): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "switch_agent") continue;
    if (typeof event.toAgentId === "string" && event.toAgentId.trim().length > 0) {
      return event.toAgentId;
    }
  }
  return fallbackAgentId;
};

const compactNarrative = (value: string | undefined, fallback: string, maxLines = 5): string => {
  if (!value || value.trim().length === 0) return fallback;
  const lines = value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[*-]\s+/, "")
        .replace(/^#+\s+/, "")
        .replace(/^\*+\s*\*\*(.+?)\*\*\s*$/, "$1")
        .trim(),
    )
    .filter(Boolean)
    .filter((line) => !/^(in scope|out of scope|key flows?|non-functional requirements|dependencies|risks|acceptance criteria|related docs?)\s*:/i.test(line))
    .slice(0, maxLines);
  return lines.length > 0 ? lines.join("\n") : fallback;
};

const buildEpicDescription = (
  epicKey: string,
  title: string,
  description: string | undefined,
  acceptance: string[] | undefined,
  relatedDocs: string[] | undefined,
): string => {
  const context = compactNarrative(
    description,
    `Deliver ${title} with implementation-ready scope and sequencing aligned to SDS guidance.`,
    6,
  );
  return [
    `* **Epic Key**: ${epicKey}`,
    `* **Epic Title**: ${title}`,
    "* **Context / Problem**",
    "",
    context,
    "* **Acceptance Criteria**",
    formatBullets(acceptance, "Define measurable and testable outcomes for this epic."),
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Link SDS/PDR/OpenAPI references used by this epic."),
  ].join("\n");
};

const buildStoryDescription = (
  storyKey: string,
  title: string,
  userStory: string | undefined,
  description: string | undefined,
  acceptanceCriteria: string[] | undefined,
  relatedDocs: string[] | undefined,
): string => {
  const userStoryText = compactNarrative(userStory, `As a user, I want ${title} so that it delivers clear product value.`, 3);
  const contextText = compactNarrative(description, `Implement ${title} with concrete scope and dependency context.`, 5);
  return [
    `* **Story Key**: ${storyKey}`,
    "* **User Story**",
    "",
    userStoryText,
    "* **Context**",
    "",
    contextText,
    "* **Acceptance Criteria**",
    formatBullets(acceptanceCriteria, "List testable outcomes for this story."),
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Docdex handles, OpenAPI endpoints, and code modules."),
  ].join("\n");
};

const buildTaskDescription = (
  taskKey: string,
  title: string,
  description: string | undefined,
  storyKey: string,
  epicKey: string,
  files: string[] | undefined,
  relatedDocs: string[] | undefined,
  dependencies: string[],
  tests: {
    unitTests?: string[];
    componentTests?: string[];
    integrationTests?: string[];
    apiTests?: string[];
  },
  qa?: QaReadiness,
): string => {
  const formatEntrypoints = (entrypoints: QaEntrypoint[] | undefined): string => {
    if (!entrypoints || entrypoints.length === 0) return "- Not specified";
    return entrypoints
      .map((entry) => {
        const target = entry.base_url ?? entry.command ?? "TBD";
        return `- ${entry.kind}: ${target}`;
      })
      .join("\n");
  };
  const objectiveText = compactNarrative(description, `Deliver ${title} for story ${storyKey}.`, 3);
  const implementationLines = extractActionableLines(description, 4);
  const riskLines = extractRiskLines(description, 3);
  const testsDefined =
    (tests.unitTests?.length ?? 0) +
      (tests.componentTests?.length ?? 0) +
      (tests.integrationTests?.length ?? 0) +
      (tests.apiTests?.length ?? 0) >
    0;
  const definitionOfDone = [
    `- Implementation for \`${taskKey}\` is complete and scoped to ${storyKey}.`,
    testsDefined
      ? "- Task-specific tests are added/updated and green in the task validation loop."
      : "- Verification evidence is captured in task logs/checklists for this scope.",
    relatedDocs?.length
      ? "- Related interfaces/docs are consistent with delivered behavior."
      : "- Documentation impact is reviewed and no additional interface docs are required.",
    qa?.blockers?.length ? "- Remaining QA blockers are explicit and actionable." : "- QA blockers are resolved or not present.",
  ];
  const defaultImplementationPlan = [
    `Implement ${title} with concrete file/module-level changes aligned to the objective.`,
    dependencies.length
      ? `Respect dependency order before completion: ${dependencies.join(", ")}.`
      : "Finalize concrete implementation steps before coding and keep scope bounded.",
  ];
  const defaultRisks = dependencies.length
    ? [`Delivery depends on upstream tasks: ${dependencies.join(", ")}.`]
    : ["Keep implementation aligned to documented interfaces and dependency expectations to avoid drift."];
  return [
    `* **Task Key**: ${taskKey}`,
    "* **Objective**",
    "",
    objectiveText,
    "* **Context**",
    "",
    `- Epic: ${epicKey}`,
    `- Story: ${storyKey}`,
    "* **Files to Touch**",
    formatBullets(files, "Not specified."),
    "* **Inputs**",
    formatBullets(relatedDocs, "No explicit external references."),
    "* **Implementation Plan**",
    formatBullets(implementationLines, defaultImplementationPlan.join(" ")),
    "* **Definition of Done**",
    definitionOfDone.join("\n"),
    "* **Testing & QA**",
    `- Unit tests: ${formatTestList(tests.unitTests)}`,
    `- Component tests: ${formatTestList(tests.componentTests)}`,
    `- Integration tests: ${formatTestList(tests.integrationTests)}`,
    `- API tests: ${formatTestList(tests.apiTests)}`,
    "* **QA Readiness**",
    `- Profiles: ${qa?.profiles_expected?.length ? qa.profiles_expected.join(", ") : "TBD"}`,
    `- Requires: ${qa?.requires?.length ? qa.requires.join("; ") : "None specified"}`,
    `- Data setup: ${qa?.data_setup?.length ? qa.data_setup.join("; ") : "None specified"}`,
    "* **QA Entry Points**",
    formatEntrypoints(qa?.entrypoints),
    "* **QA Blockers**",
    formatBullets(qa?.blockers, "None known."),
    "* **Dependencies**",
    formatBullets(dependencies, "None."),
    "* **Risks & Gotchas**",
    formatBullets(riskLines, defaultRisks.join(" ")),
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "None."),
  ].join("\n");
};

const collectFilesRecursively = async (target: string): Promise<string[]> => {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target);
    const results: string[] = [];
    for (const entry of entries) {
      const child = path.join(target, entry);
      const childStat = await fs.stat(child);
      if (childStat.isDirectory()) {
        results.push(...(await collectFilesRecursively(child)));
      } else {
        results.push(child);
      }
    }
    return results;
  }
  return [target];
};

const DOC_SCAN_MAX_DEPTH = 5;
const DOC_SCAN_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mcoda",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "tmp",
  "temp",
]);
const GENERATED_PLANNING_DOC_PATH_PATTERN =
  /(?:^|\/)(?:\.mcoda\/docs\/)?(?:.*(?:refine[_-]?tasks?|create[_-]?tasks?|task-sufficiency|backlog(?:-quality)?|coverage-report|quality-report|gap(?:-remediation)?-addendum|sds-gap-remediation-addendum|sds-preflight-report|sds-open-questions|open-questions|implementation-plan|task-progress|progress)(?:[-_a-z0-9]*)\.(?:md|markdown|json|ya?ml))$/i;
const DOC_SCAN_FILE_PATTERN = /\.(md|markdown|txt|rst|ya?ml|json)$/i;
const STRICT_SDS_PATH_PATTERN =
  /(^|\/)(sds(?:[-_. ][a-z0-9]+)?|software[-_ ]design(?:[-_ ](?:spec|specification|outline|doc))?|design[-_ ]spec(?:ification)?)(\/|[-_.]|$)/i;
const STRICT_SDS_CONTENT_PATTERN =
  /\b(software design specification|software design document|system design specification|\bSDS\b)\b/i;
const SDS_LIKE_PATH_PATTERN =
  /(^|\/)(sds|software[-_ ]design|design[-_ ]spec|requirements|prd|pdr|rfp|architecture|solution[-_ ]design)/i;
const API_CONTRACT_LIKE_PATH_PATTERN =
  /(?:openapi|swagger|api[-_ ]?(?:spec|schema|contract)|interface[-_ ]?(?:spec|contract)|service[-_ ]contract|endpoint[-_ ]catalog)/i;
const STRUCTURE_LIKE_PATH_PATTERN = /(^|\/)(tree|structure|layout|folder|directory|services?|modules?)(\/|[-_.]|$)/i;
const DOC_PATH_TOKEN_PATTERN = /(^|[\s`"'([{<])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s`"')\]}>.,;:!?])/g;
const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,10}$/i;
const TOP_LEVEL_STRUCTURE_PATTERN = /^[a-z][a-z0-9._-]{1,60}$/i;
const SERVICE_PATH_CONTAINER_SEGMENTS = new Set([
  "services",
  "service",
  "apps",
  "app",
  "packages",
  "package",
  "modules",
  "module",
  "libs",
  "lib",
  "src",
  "source",
]);
const SOURCE_LIKE_PATH_SEGMENTS = new Set([
  "api",
  "app",
  "apps",
  "bin",
  "cmd",
  "components",
  "controllers",
  "handlers",
  "internal",
  "lib",
  "libs",
  "pages",
  "routes",
  "screens",
  "server",
  "servers",
  "spec",
  "specs",
  "src",
  "test",
  "tests",
  "ui",
  "web",
]);
const GENERIC_CONTAINER_PATH_SEGMENTS = new Set([
  "adapters",
  "apps",
  "clients",
  "consoles",
  "domains",
  "engines",
  "features",
  "modules",
  "packages",
  "platforms",
  "plugins",
  "products",
  "servers",
  "services",
  "systems",
  "tools",
  "workers",
]);
const NON_RUNTIME_STRUCTURE_ROOT_SEGMENTS = new Set(["docs", "fixtures", "runbooks", "policies", "policy"]);
const SERVICE_NAME_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "by",
  "from",
  "layer",
  "stack",
  "system",
  "platform",
  "project",
  "repository",
  "codebase",
  "component",
  "feature",
  "implement",
  "build",
  "create",
  "develop",
  "deliver",
  "setup",
  "set",
  "provision",
  "define",
  "configure",
  "add",
  "update",
  "refactor",
  "init",
  "initialize",
  "prepare",
  "establish",
  "support",
  "enable",
]);
const SERVICE_NAME_INVALID = new Set([
  "service",
  "services",
  "module",
  "modules",
  "app",
  "apps",
  "layer",
  "stack",
  "system",
  "project",
  "repository",
  "codebase",
]);
const SERVICE_TEXT_INVALID_STARTERS = new Set([
  "active",
  "are",
  "artifact",
  "artifacts",
  "be",
  "been",
  "being",
  "block",
  "blocks",
  "build",
  "builder",
  "built",
  "canonical",
  "chain",
  "configured",
  "dedicated",
  "deployment",
  "discovered",
  "failure",
  "first",
  "is",
  "last",
  "listing",
  "mode",
  "modes",
  "never",
  "no",
  "not",
  "ordered",
  "owned",
  "private",
  "public",
  "resolved",
  "runtime",
  "second",
  "startup",
  "third",
  "validation",
  "wave",
  "waves",
  "was",
  "were",
]);
const NON_RUNTIME_SERVICE_SINGLETONS = new Set([
  "artifact",
  "artifacts",
  "compose",
  "config",
  "configs",
  "doc",
  "docs",
  "interface",
  "interfaces",
  "key",
  "keys",
  "libraries",
  "library",
  "pdr",
  "read",
  "rfp",
  "sds",
  "script",
  "scripts",
  "src",
  "systemd",
  "test",
  "tests",
  "types",
  "write",
]);
const NON_RUNTIME_PATH_SERVICE_TOKENS = new Set([
  "artifact",
  "artifacts",
  "manifest",
  "manifests",
  "schema",
  "schemas",
  "taxonomy",
  "taxonomies",
]);
const SERVICE_LABEL_PATTERN =
  /\b([A-Za-z][A-Za-z0-9]*(?:[ _/-]+[A-Za-z][A-Za-z0-9]*){0,3})\s+(service|api|backend|frontend|worker|gateway|database|db|ui|client|server|adapter)\b/gi;
const SERVICE_ARROW_PATTERN =
  /([A-Za-z][A-Za-z0-9 _/-]{1,80})\s*(?:->|=>|→)\s*([A-Za-z][A-Za-z0-9 _/-]{1,80})/g;
const SERVICE_HANDLE_PATTERN = /\b((?:svc|ui|worker)-[a-z0-9-*]+)\b/gi;
const WAVE_LABEL_PATTERN = /\bwave\s*([0-9]{1,2})\b/i;
const TOPOLOGY_HEADING_PATTERN =
  /\b(service|services|component|components|module|modules|interface|interfaces|runtime|runtimes|worker|workers|client|clients|gateway|gateways|server|servers|engine|engines|pipeline|pipelines|registry|registries|adapter|adapters|processor|processors|daemon|daemons|ops|operations|deployment|deployments|topology)\b/i;
const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const RUNTIME_COMPONENTS_HEADING_PATTERN =
  /\b(runtime components?|runtime topology|system components?|component topology|service architecture|service topology|runtime services?)\b/i;
const VERIFICATION_MATRIX_HEADING_PATTERN =
  /\b(verification matrix|validation matrix|test matrix|verification suites?)\b/i;
const ACCEPTANCE_SCENARIOS_HEADING_PATTERN = /\b(required )?acceptance scenarios?\b/i;
const ARCHITECTURE_META_HEADING_PATTERN =
  /\b(architecture overview|system overview|overview|runtime components?|component topology|service topology|target folder tree|folder tree|directory layout|repository layout|startup sequence|deployment waves?|technology stack|platform model|core decisions?|resolved decisions|system boundaries|product design review|quality gates|operations model|operational evidence|assumptions? and constraints)\b/i;
const BUILD_TARGET_RUNTIME_SEGMENTS = new Set([
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
  "page",
  "pages",
  "processor",
  "processors",
  "route",
  "routes",
  "screen",
  "screens",
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
const BUILD_TARGET_INTERFACE_SEGMENTS = new Set([
  "contract",
  "contracts",
  "dto",
  "dtos",
  "interface",
  "interfaces",
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
const BUILD_TARGET_DATA_SEGMENTS = new Set([
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
const BUILD_TARGET_TEST_SEGMENTS = new Set([
  "acceptance",
  "e2e",
  "integration",
  "spec",
  "specs",
  "test",
  "tests",
]);
const BUILD_TARGET_OPS_SEGMENTS = new Set([
  "automation",
  "deploy",
  "deployment",
  "deployments",
  "infra",
  "ops",
  "operation",
  "operations",
  "orchestration",
  "orchestrations",
  "provision",
  "provisioning",
  "runbook",
  "runbooks",
  "script",
  "scripts",
]);
const BUILD_TARGET_DOC_SEGMENTS = new Set([
  "docs",
  "documentation",
  "guide",
  "guides",
  "manual",
  "manuals",
  "policy",
  "policies",
  "reference",
  "references",
  "rfp",
  "pdr",
  "sds",
]);
const MANIFEST_SIGNAL_TOKENS = new Set([
  "build",
  "config",
  "configuration",
  "dependency",
  "dependencies",
  "environment",
  "lock",
  "lockfile",
  "manifest",
  "package",
  "project",
  "settings",
  "tooling",
  "workspace",
  "worktree",
]);
const MANIFEST_MACHINE_FILE_PATTERN =
  /\.(?:cfg|cnf|conf|gradle|ini|json|kts|lock|mod|properties|sum|toml|txt|xml|ya?ml)$/i;
const NON_MANIFEST_TOKENS = new Set([
  "acceptance",
  "archive",
  "changelog",
  "contract",
  "contracts",
  "example",
  "examples",
  "fixture",
  "fixtures",
  "guide",
  "guides",
  "license",
  "manual",
  "manuals",
  "notice",
  "readme",
  "reference",
  "references",
  "sample",
  "samples",
  "schema",
  "schemas",
  "spec",
  "specs",
  "test",
  "tests",
]);
const SERVICE_ARTIFACT_SIGNAL_PATTERN =
  /(?:^|[._-])(compose|daemon|orchestrator|scheduler|service|socket|timer|worker)(?:[._-]|$)|\.(?:service|socket|timer)$/i;
const GENERIC_CONTAINER_SEGMENTS = new Set([
  ...SERVICE_PATH_CONTAINER_SEGMENTS,
  "code",
  "domain",
  "domains",
  "feature",
  "features",
  "implementation",
  "implementations",
  "platform",
  "platforms",
  "runtime",
  "runtimes",
  "system",
  "systems",
]);
const UI_ROOT_SEGMENTS = new Set(["app", "apps", "client", "clients", "console", "consoles", "portal", "portals", "ui", "web"]);
const API_ROOT_SEGMENTS = new Set(["api", "apis", "gateway", "gateways", "handler", "handlers", "route", "routes", "server", "servers", "service", "services"]);
const WORKER_ROOT_SEGMENTS = new Set([
  "command",
  "commands",
  "engine",
  "engines",
  "job",
  "jobs",
  "pipeline",
  "pipelines",
  "processor",
  "processors",
  "queue",
  "queues",
  "scheduler",
  "schedulers",
  "service",
  "services",
  "worker",
  "workers",
]);
const GENERIC_IMPLEMENTATION_TASK_PATTERN = /update the concrete .* modules surfaced by the sds/i;

const tokenizeBasename = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

const isManifestLikeBasename = (basename: string, segments: string[] = []): boolean => {
  const normalized = basename.toLowerCase();
  const tokens = tokenizeBasename(normalized);
  if (tokens.some((token) => MANIFEST_SIGNAL_TOKENS.has(token))) return true;
  if (!MANIFEST_MACHINE_FILE_PATTERN.test(normalized)) return false;
  if (segments.length <= 2 && tokens.length <= 3 && !tokens.some((token) => NON_MANIFEST_TOKENS.has(token))) {
    return true;
  }
  return false;
};

const isServiceArtifactBasename = (basename: string): boolean => SERVICE_ARTIFACT_SIGNAL_PATTERN.test(basename.toLowerCase());

const nextUniqueLocalId = (prefix: string, existing: Set<string>): string => {
  let index = 1;
  let candidate = `${prefix}-${index}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  existing.add(candidate);
  return candidate;
};

const looksLikeSdsPath = (value: string): boolean => STRICT_SDS_PATH_PATTERN.test(value.replace(/\\/g, "/").toLowerCase());

const looksLikeSdsDoc = (doc: DocdexDocument): boolean => {
  if ((doc.docType ?? "").toUpperCase() === "SDS") return true;
  const pathOrTitle = `${doc.path ?? ""}\n${doc.title ?? ""}`;
  if (looksLikeSdsPath(pathOrTitle)) return true;
  const sample = [doc.content ?? "", ...(doc.segments ?? []).slice(0, 4).map((seg) => seg.content ?? "")]
    .join("\n")
    .slice(0, 5000);
  return STRICT_SDS_CONTENT_PATTERN.test(sample);
};

const looksLikePathishDocId = (value: string | undefined): boolean => {
  if (!value) return false;
  if (DOCDEX_LOCAL_HANDLE.test(value)) return false;
  return (
    value.includes("/") ||
    value.includes("\\") ||
    FILE_EXTENSION_PATTERN.test(value) ||
    STRICT_SDS_PATH_PATTERN.test(value.replace(/\\/g, "/").toLowerCase())
  );
};

const EPIC_SCHEMA_SNIPPET = `{
  "epics": [
    {
      "localId": "e1",
      "area": "documented-area-label",
      "title": "Epic title",
      "description": "Epic description using the epic template",
      "acceptanceCriteria": ["criterion"],
      "relatedDocs": ["docdex:..."],
      "priorityHint": 50,
      "serviceIds": ["backend-api"],
      "tags": ["cross_service"]
    }
  ]
}`;

const EPIC_BATCH_SCHEMA_SNIPPET = `{
  "epics": [
    {
      "localId": "e1",
      "area": "documented-area-label",
      "title": "Epic title",
      "serviceIds": ["backend-api"],
      "tags": ["cross_service"]
    }
  ]
}`;

const STORY_SCHEMA_SNIPPET = `{
  "stories": [
    {
      "localId": "us1",
      "title": "Story title",
      "userStory": "As a ...",
      "description": "Story description using the template",
      "acceptanceCriteria": ["criterion"],
      "relatedDocs": ["docdex:..."],
      "priorityHint": 50
    }
  ]
}`;

const STORIES_BATCH_SCHEMA_SNIPPET = `{
  "epicStories": [
    {
      "epicLocalId": "e1",
      "stories": [
        {
          "localId": "us1",
          "title": "Story title",
          "userStory": "As a ...",
          "description": "Story description using the template",
          "acceptanceCriteria": ["criterion"],
          "relatedDocs": ["docdex:..."],
          "priorityHint": 50
        }
      ]
    }
  ]
}`;

const TASK_SCHEMA_SNIPPET = `{
  "tasks": [
    {
      "localId": "t1",
      "title": "Task title",
      "type": "feature|bug|chore|spike",
      "description": "Task description using the template",
      "files": ["relative/path/to/implementation.file"],
      "estimatedStoryPoints": 3,
      "priorityHint": 50,
      "dependsOnKeys": ["t0"],
      "relatedDocs": ["docdex:..."],
      "unitTests": ["unit test description"],
      "componentTests": ["component test description"],
      "integrationTests": ["integration test description"],
      "apiTests": ["api test description"],
      "qa": {
        "profiles_expected": ["cli", "api", "chromium"],
        "requires": ["runtime dependency", "seed data"],
        "entrypoints": [{ "kind": "web", "base_url": "http://localhost:<PORT>", "command": "project start command" }],
        "data_setup": ["seed sample data"],
        "blockers": [],
        "notes": null
      }
    }
  ]
}`;

const TASK_COMPACT_SCHEMA_SNIPPET = `{
  "tasks": [
    {
      "localId": "t1",
      "title": "Task title",
      "type": "feature|bug|chore|spike",
      "description": "Task description using the template",
      "files": ["relative/path/to/implementation.file"],
      "estimatedStoryPoints": 3,
      "priorityHint": 50,
      "dependsOnKeys": ["t0"],
      "relatedDocs": ["docdex:..."],
      "unitTests": ["unit test description"],
      "componentTests": ["component test description"],
      "integrationTests": ["integration test description"],
      "apiTests": ["api test description"]
    }
  ]
}`;

const TASKS_BATCH_SCHEMA_SNIPPET = `{
  "storyTasks": [
    {
      "epicLocalId": "e1",
      "storyLocalId": "us1",
      "tasks": [
        {
          "localId": "t1",
          "title": "Task title",
          "type": "feature|bug|chore|spike",
          "description": "Task description using the template",
          "files": ["relative/path/to/implementation.file"],
          "estimatedStoryPoints": 3,
          "priorityHint": 50,
          "dependsOnKeys": ["t0"],
          "relatedDocs": ["docdex:..."],
          "unitTests": ["unit test description"],
          "componentTests": ["component test description"],
          "integrationTests": ["integration test description"],
          "apiTests": ["api test description"],
          "qa": {
            "profiles_expected": ["cli", "api", "chromium"],
            "requires": ["runtime dependency", "seed data"],
            "entrypoints": [{ "kind": "web", "base_url": "http://localhost:<PORT>", "command": "project start command" }],
            "data_setup": ["seed sample data"],
            "blockers": [],
            "notes": null
          }
        }
      ]
    }
  ]
}`;

const FULL_PLAN_SCHEMA_SNIPPET = `{
  "epics": [
    {
      "localId": "e1",
      "area": "documented-area-label",
      "title": "Epic title",
      "description": "Epic description using the epic template",
      "acceptanceCriteria": ["criterion"],
      "relatedDocs": ["docdex:..."],
      "priorityHint": 50,
      "serviceIds": ["backend-api"],
      "tags": ["cross_service"],
      "stories": [
        {
          "localId": "us1",
          "title": "Story title",
          "userStory": "As a ...",
          "description": "Story description using the template",
          "acceptanceCriteria": ["criterion"],
          "relatedDocs": ["docdex:..."],
          "priorityHint": 50,
          "tasks": [
            {
              "localId": "t1",
              "title": "Task title",
              "type": "feature|bug|chore|spike",
              "description": "Task description using the template",
              "files": ["relative/path/to/implementation.file"],
              "estimatedStoryPoints": 3,
              "priorityHint": 50,
              "dependsOnKeys": ["t0"],
              "relatedDocs": ["docdex:..."],
              "unitTests": ["unit test description"],
              "componentTests": ["component test description"],
              "integrationTests": ["integration test description"],
              "apiTests": ["api test description"],
              "qa": {
                "profiles_expected": ["cli", "api", "chromium"],
                "requires": ["runtime dependency", "seed data"],
                "entrypoints": [{ "kind": "web", "base_url": "http://localhost:<PORT>", "command": "project start command" }],
                "data_setup": ["seed sample data"],
                "blockers": [],
                "notes": null
              }
            }
          ]
        }
      ]
    }
  ]
}`;

export class CreateTasksService {
  private static readonly MAX_BUSY_RETRIES = 6;
  private static readonly BUSY_BACKOFF_MS = 500;
  private static readonly MAX_AGENT_REFINEMENT_ATTEMPTS = 3;
  private static readonly MAX_STRICT_AGENT_PLAN_ATTEMPTS = 3;
  private docdex: DocdexClient;
  private jobService: JobService;
  private agentService: AgentService;
  private repo: GlobalRepository;
  private workspaceRepo: WorkspaceRepository;
  private routingService: RoutingService;
  private workspace: WorkspaceResolution;
  private ratingService?: AgentRatingService;
  private taskOrderingFactory: TaskOrderingFactory;
  private taskSufficiencyFactory: TaskSufficiencyFactory;
  private sdsPreflightFactory: SdsPreflightFactory;
  private compactTaskSchemaStrategy: "structured" | "schema_free_pref" = "structured";
  private compactTaskSchemaStrategyLogged = false;

  constructor(
    workspace: WorkspaceResolution,
    deps: {
      docdex: DocdexClient;
      jobService: JobService;
      agentService: AgentService;
      repo: GlobalRepository;
      workspaceRepo: WorkspaceRepository;
      routingService: RoutingService;
      ratingService?: AgentRatingService;
      taskOrderingFactory?: TaskOrderingFactory;
      taskSufficiencyFactory?: TaskSufficiencyFactory;
      sdsPreflightFactory?: SdsPreflightFactory;
    },
  ) {
    this.workspace = workspace;
    this.docdex = deps.docdex;
    this.jobService = deps.jobService;
    this.agentService = deps.agentService;
    this.repo = deps.repo;
    this.workspaceRepo = deps.workspaceRepo;
    this.routingService = deps.routingService;
    this.ratingService = deps.ratingService;
    this.taskOrderingFactory = deps.taskOrderingFactory ?? TaskOrderingService.create;
    this.taskSufficiencyFactory = deps.taskSufficiencyFactory ?? TaskSufficiencyService.create;
    this.sdsPreflightFactory = deps.sdsPreflightFactory ?? SdsPreflightService.create;
  }

  static async create(workspace: WorkspaceResolution): Promise<CreateTasksService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const routingService = await RoutingService.create();
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
      repoId: docdexRepoId,
    });
    const jobService = new JobService(workspace);
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    return new CreateTasksService(workspace, {
      docdex,
      jobService,
      agentService,
      repo,
      workspaceRepo,
      routingService,
      taskSufficiencyFactory: TaskSufficiencyService.create,
      sdsPreflightFactory: SdsPreflightService.create,
    });
  }

  async close(): Promise<void> {
    const swallow = async (fn?: () => Promise<void>) => {
      try {
        if (fn) await fn();
      } catch {
        // Best-effort close; ignore errors (including "database is closed").
      }
    };
    await swallow((this.agentService as any).close?.bind(this.agentService));
    await swallow((this.repo as any).close?.bind(this.repo));
    await swallow((this.jobService as any).close?.bind(this.jobService));
    await swallow((this.workspaceRepo as any).close?.bind(this.workspaceRepo));
    await swallow((this.routingService as any).close?.bind(this.routingService));
    const docdex = this.docdex as any;
    await swallow(docdex?.close?.bind(docdex));
  }

  private storyScopeKey(epicLocalId: string, storyLocalId: string): string {
    return `${epicLocalId}::${storyLocalId}`;
  }

  private taskScopeKey(epicLocalId: string, storyLocalId: string, taskLocalId: string): string {
    return `${epicLocalId}::${storyLocalId}::${taskLocalId}`;
  }

  private scopeStory(story: Pick<PlanStory, "epicLocalId" | "localId">): string {
    return this.storyScopeKey(story.epicLocalId, story.localId);
  }

  private scopeTask(task: Pick<PlanTask, "epicLocalId" | "storyLocalId" | "localId">): string {
    return this.taskScopeKey(task.epicLocalId, task.storyLocalId, task.localId);
  }

  private async seedPriorities(projectKey: string): Promise<void> {
    const ordering = await this.taskOrderingFactory(this.workspace, { recordTelemetry: false });
    try {
      await ordering.orderTasks({
        projectKey,
        apply: true,
      });
    } finally {
      await ordering.close();
    }
  }

  private async resolveAgent(agentName?: string): Promise<Agent> {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "create-tasks",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private ensureRatingService(): AgentRatingService {
    if (!this.ratingService) {
      this.ratingService = new AgentRatingService(this.workspace, {
        workspaceRepo: this.workspaceRepo,
        globalRepo: this.repo,
        agentService: this.agentService,
        routingService: this.routingService,
      });
    }
    return this.ratingService;
  }

  private async prepareDocs(inputs: string[]): Promise<DocdexDocument[]> {
    const primaryInputs = inputs.length > 0 ? inputs : await this.resolveDefaultDocInputs();
    let documents = await this.collectDocsFromInputs(primaryInputs);
    if (!documents.some((doc) => looksLikeSdsDoc(doc))) {
      const fallbackInputs = await this.resolveDefaultDocInputs();
      if (fallbackInputs.length > 0) {
        const alreadyUsed = new Set(primaryInputs.map((input) => this.normalizeDocInputForSet(input)));
        const missingInputs = fallbackInputs.filter(
          (candidate) => !alreadyUsed.has(this.normalizeDocInputForSet(candidate)),
        );
        if (missingInputs.length > 0) {
          const discovered = await this.collectDocsFromInputs(missingInputs);
          documents = this.mergeDocs(documents, discovered);
        }
      }
    }
    const sdsReferencedInputs = await this.expandSdsReferencedDocInputs(documents, primaryInputs);
    if (sdsReferencedInputs.length > 0) {
      const discovered = await this.collectDocsFromInputs(sdsReferencedInputs);
      documents = this.mergeDocs(documents, discovered);
    }
    if (!documents.some((doc) => looksLikeSdsDoc(doc))) {
      throw new Error(
        "create-tasks requires at least one SDS document. Add an SDS file (for example docs/sds.md) or pass SDS paths as input.",
      );
    }
    const sanitized = documents.map((doc) => this.sanitizeDocForPlanning(doc));
    const sourceDocs = this.filterPlanningSourceDocs(sanitized);
    return this.sortDocsForPlanning(this.dedupePlanningDocs(sourceDocs));
  }

  private normalizeDocInputForSet(input: string): string {
    if (input.startsWith("docdex:")) return input.trim().toLowerCase();
    const resolved = path.isAbsolute(input) ? input : path.join(this.workspace.workspaceRoot, input);
    return path.resolve(resolved).toLowerCase();
  }

  private mergeDocInputs(primary: string[], extras: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const input of [...primary, ...extras]) {
      if (!input?.trim()) continue;
      const key = this.normalizeDocInputForSet(input);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(input);
    }
    return merged;
  }

  private normalizePlanningDocPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.workspace.workspaceRoot, resolved).replace(/\\/g, "/");
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved;
  }

  private docMatchesResolvedInputPath(doc: DocdexDocument | undefined, filePath: string): boolean {
    if (!doc) return false;
    const expected = this.canonicalizeDocPathKey(filePath);
    if (!expected) return false;
    const docPath = this.canonicalizeDocPathKey(doc.path);
    const docIdPath = this.canonicalizeDocPathKey(doc.id);
    return docPath === expected || docIdPath === expected;
  }

  private async materializePlanningDocFromFile(
    filePath: string,
    docType?: string,
    registeredDoc?: DocdexDocument,
  ): Promise<DocdexDocument> {
    const content = await fs.readFile(filePath, "utf8");
    const workspacePath = this.normalizePlanningDocPath(filePath);
    const timestamp = new Date().toISOString();
    const matchedRegisteredDoc = this.docMatchesResolvedInputPath(registeredDoc, filePath) ? registeredDoc : undefined;
    const inferredDocType = inferDocType(filePath);
    return {
      ...(matchedRegisteredDoc ?? {}),
      id:
        matchedRegisteredDoc?.id ??
        (looksLikePathishDocId(workspacePath) ? workspacePath : `file:${path.resolve(filePath)}`),
      docType:
        looksLikeSdsDoc({
          ...(matchedRegisteredDoc ?? {}),
          path: workspacePath,
          id: matchedRegisteredDoc?.id,
          title: matchedRegisteredDoc?.title ?? path.basename(filePath),
          docType: matchedRegisteredDoc?.docType ?? docType ?? inferredDocType,
          content,
          segments: matchedRegisteredDoc?.segments ?? [],
        } as DocdexDocument)
          ? "SDS"
          : matchedRegisteredDoc?.docType ?? docType ?? inferredDocType,
      path: workspacePath,
      title: matchedRegisteredDoc?.title ?? path.basename(filePath),
      content,
      segments: matchedRegisteredDoc?.segments ?? [],
      createdAt: matchedRegisteredDoc?.createdAt ?? timestamp,
      updatedAt: matchedRegisteredDoc?.updatedAt ?? timestamp,
    } as DocdexDocument;
  }

  private isSdsReferencedSupportDocPath(candidate: string): boolean {
    const normalized = this.normalizeStructurePathToken(candidate);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    if (GENERATED_PLANNING_DOC_PATH_PATTERN.test(lower)) return false;
    if (lower.startsWith("docs/")) return /\.(md|markdown|txt|json|ya?ml)$/i.test(lower);
    return /^openapi(?:\/|\.|$)/i.test(lower);
  }

  private async expandSdsReferencedDocInputs(
    docs: DocdexDocument[],
    existingInputs: string[],
  ): Promise<string[]> {
    const extras: string[] = [];
    const seen = new Set(existingInputs.map((input) => this.normalizeDocInputForSet(input)));
    for (const doc of docs) {
      if (!looksLikeSdsDoc(doc)) continue;
      const corpus = [doc.content, ...(doc.segments ?? []).map((segment) => segment.content)]
        .filter(Boolean)
        .join("\n");
      for (const token of extractStructuredPaths(corpus, 256)) {
        if (!this.isSdsReferencedSupportDocPath(token)) continue;
        const resolved = path.resolve(this.workspace.workspaceRoot, token);
        try {
          const stat = await fs.stat(resolved);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }
        const key = this.normalizeDocInputForSet(resolved);
        if (seen.has(key)) continue;
        seen.add(key);
        extras.push(resolved);
        if (extras.length >= 24) return extras;
      }
    }
    return extras;
  }

  private canonicalizeDocPathKey(value: string | undefined): string | undefined {
    const trimmed = `${value ?? ""}`.trim();
    if (!trimmed || DOCDEX_LOCAL_HANDLE.test(trimmed)) return undefined;
    if (path.isAbsolute(trimmed)) return path.resolve(trimmed).toLowerCase();
    if (looksLikePathishDocId(trimmed)) {
      return path.resolve(this.workspace.workspaceRoot, trimmed).toLowerCase();
    }
    return undefined;
  }

  private docIdentity(doc: DocdexDocument): string {
    const pathKey = this.canonicalizeDocPathKey(doc.path) ?? this.canonicalizeDocPathKey(doc.id);
    const idKey = `${doc.id ?? ""}`.trim().toLowerCase();
    if (pathKey) return `path:${pathKey}`;
    if (idKey) return `id:${idKey}`;
    const titleKey = `${doc.title ?? ""}`.trim().toLowerCase();
    if (titleKey) return `title:${titleKey}`;
    const sample = `${doc.content ?? doc.segments?.[0]?.content ?? ""}`.slice(0, 120).toLowerCase();
    return `sample:${sample}`;
  }

  private mergeDocs(base: DocdexDocument[], incoming: DocdexDocument[]): DocdexDocument[] {
    const merged = [...base];
    const seen = new Set(merged.map((doc) => this.docIdentity(doc)));
    for (const doc of incoming) {
      const identity = this.docIdentity(doc);
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push(doc);
    }
    return merged;
  }

  private sanitizeDocForPlanning(doc: DocdexDocument): DocdexDocument {
    const content = stripManagedSdsPreflightBlock(doc.content);
    const segments =
      content !== doc.content
        ? []
        : (doc.segments ?? [])
            .map((segment) => {
              const sanitizedContent = stripManagedSdsPreflightBlock(segment.content ?? undefined);
              return {
                ...segment,
                content: sanitizedContent ?? segment.content,
              };
            })
            .filter(
              (segment) =>
                `${segment.content ?? ""}`.trim().length > 0 || `${segment.heading ?? ""}`.trim().length > 0,
            );
    const sanitized: DocdexDocument = {
      ...doc,
      content: content ?? doc.content,
      segments,
    };
    if (looksLikeSdsDoc(sanitized) && `${sanitized.docType ?? ""}`.toUpperCase() !== "SDS") {
      sanitized.docType = "SDS";
    }
    return sanitized;
  }

  private isGeneratedPlanningArtifactDoc(doc: DocdexDocument): boolean {
    const identityParts = [doc.path, doc.id, doc.title].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    return identityParts.some((value) => GENERATED_PLANNING_DOC_PATH_PATTERN.test(value.toLowerCase()));
  }

  private filterPlanningSourceDocs(docs: DocdexDocument[]): DocdexDocument[] {
    const filtered = docs.filter((doc) => !this.isGeneratedPlanningArtifactDoc(doc));
    return filtered.length > 0 ? filtered : docs;
  }

  private buildPlanningDocLinks(docs: DocdexDocument[], limit = 12): string[] {
    return this.sortDocsForPlanning(this.dedupePlanningDocs(this.filterPlanningSourceDocs(docs)))
      .map((doc) => (doc.id ? `docdex:${doc.id}` : undefined))
      .filter((value): value is string => Boolean(value))
      .slice(0, limit);
  }

  private scorePlanningDoc(doc: DocdexDocument): number {
    const segmentCount = doc.segments?.length ?? 0;
    const contentLength = `${doc.content ?? ""}`.length;
    return (
      (looksLikeSdsDoc(doc) ? 5000 : 0) +
      (doc.path ? 400 : 0) +
      segmentCount * 20 +
      Math.min(300, contentLength)
    );
  }

  private mergePlanningDocPair(current: DocdexDocument, incoming: DocdexDocument): DocdexDocument {
    const [primary, secondary] =
      this.scorePlanningDoc(incoming) > this.scorePlanningDoc(current) ? [incoming, current] : [current, incoming];
    const merged = {
      ...secondary,
      ...primary,
      path: primary.path ?? secondary.path,
      title: primary.title ?? secondary.title,
      content: primary.content ?? secondary.content,
      segments: (primary.segments?.length ?? 0) > 0 ? primary.segments : secondary.segments,
    };
    if (looksLikeSdsDoc(merged) && `${merged.docType ?? ""}`.toUpperCase() !== "SDS") {
      merged.docType = "SDS";
    }
    return merged;
  }

  private dedupePlanningDocs(docs: DocdexDocument[]): DocdexDocument[] {
    const merged = new Map<string, DocdexDocument>();
    for (const doc of docs) {
      const identity = this.docIdentity(doc);
      const existing = merged.get(identity);
      merged.set(identity, existing ? this.mergePlanningDocPair(existing, doc) : doc);
    }
    return Array.from(merged.values());
  }

  private sortDocsForPlanning(docs: DocdexDocument[]): DocdexDocument[] {
    return [...docs].sort((a, b) => {
      const aIsSds = looksLikeSdsDoc(a) ? 0 : 1;
      const bIsSds = looksLikeSdsDoc(b) ? 0 : 1;
      if (aIsSds !== bIsSds) return aIsSds - bIsSds;
      const byUpdated = `${b.updatedAt ?? ""}`.localeCompare(`${a.updatedAt ?? ""}`);
      if (byUpdated !== 0) return byUpdated;
      return `${a.path ?? a.title ?? ""}`.localeCompare(`${b.path ?? b.title ?? ""}`);
    });
  }

  private async collectDocsFromInputs(resolvedInputs: string[]): Promise<DocdexDocument[]> {
    if (resolvedInputs.length === 0) return [];
    const documents: DocdexDocument[] = [];
    for (const input of resolvedInputs) {
      if (input.startsWith("docdex:")) {
        const docId = input.replace(/^docdex:/, "");
        try {
          const doc = await this.docdex.fetchDocumentById(docId);
          documents.push(doc);
        } catch (error) {
          throw new Error(`Docdex reference failed (${docId}): ${(error as Error).message}`);
        }
        continue;
      }
      const resolved = path.isAbsolute(input) ? input : path.join(this.workspace.workspaceRoot, input);
      let paths: string[];
      try {
        paths = await collectFilesRecursively(resolved);
      } catch (error) {
        throw new Error(`Failed to read input ${input}: ${(error as Error).message}`);
      }
      for (const filePath of paths) {
        const baseName = path.basename(filePath);
        if (baseName.endsWith(".meta.json") || baseName.endsWith("-first-draft.md")) continue;
        if (!/\.(md|markdown|ya?ml|json)$/i.test(baseName)) continue;
        const docType = inferDocType(filePath);
        try {
          const registered = await this.docdex.ensureRegisteredFromFile(filePath, docType, {
            projectKey: this.workspace.workspaceId,
          });
          documents.push(await this.materializePlanningDocFromFile(filePath, docType, registered));
        } catch (error) {
          try {
            documents.push(await this.materializePlanningDocFromFile(filePath, docType));
          } catch {
            throw new Error(`Docdex register failed for ${filePath}: ${(error as Error).message}`);
          }
        }
      }
    }
    return documents;
  }

  private async resolveDefaultDocInputs(): Promise<string[]> {
    return this.findFuzzyDocInputs();
  }

  private async walkDocCandidates(
    currentDir: string,
    depth: number,
    collector: (filePath: string) => void,
  ): Promise<void> {
    if (depth > DOC_SCAN_MAX_DEPTH) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (DOC_SCAN_IGNORE_DIRS.has(entry.name.toLowerCase())) continue;
        await this.walkDocCandidates(entryPath, depth + 1, collector);
        continue;
      }
      if (entry.isFile()) {
        collector(entryPath);
      }
    }
  }

  private scoreDocCandidate(filePath: string): number {
    const workspaceRelative = path.relative(this.workspace.workspaceRoot, filePath).replace(/\\/g, "/").toLowerCase();
    const mcodaRelative = path.relative(this.workspace.mcodaDir, filePath).replace(/\\/g, "/").toLowerCase();
    const relative =
      workspaceRelative && !workspaceRelative.startsWith("..")
        ? workspaceRelative
        : mcodaRelative && !mcodaRelative.startsWith("..")
          ? mcodaRelative
          : path.basename(filePath).toLowerCase();
    const normalized = `/${relative}`;
    const baseName = path.basename(relative);
    if (!DOC_SCAN_FILE_PATTERN.test(baseName)) return 0;
    const segments = normalized.split("/").filter(Boolean);
    let score = 0;
    if (SDS_LIKE_PATH_PATTERN.test(normalized)) score += 100;
    if (API_CONTRACT_LIKE_PATH_PATTERN.test(normalized)) score += 45;
    if (STRUCTURE_LIKE_PATH_PATTERN.test(normalized)) score += 30;
    if (segments.some((segment) => BUILD_TARGET_DOC_SEGMENTS.has(segment))) score += 20;
    if (/(architecture|design|requirements?|reference|guide|manual|plan|contract|interface|spec)/i.test(baseName)) score += 15;
    if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) score += 10;
    return score;
  }

  private async findFuzzyDocInputs(): Promise<string[]> {
    const ranked: Array<{ path: string; score: number }> = [];
    const seen = new Set<string>();
    const collect = (candidate: string) => {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) return;
      const score = this.scoreDocCandidate(resolved);
      if (score <= 0) return;
      ranked.push({ path: resolved, score });
      seen.add(resolved);
    };
    await this.walkDocCandidates(this.workspace.workspaceRoot, 0, collect);
    const mcodaDocs = path.join(this.workspace.mcodaDir, "docs");
    try {
      const stat = await fs.stat(mcodaDocs);
      if (stat.isDirectory()) {
        await this.walkDocCandidates(mcodaDocs, 0, collect);
      }
    } catch {
      // Ignore missing workspace docs.
    }
    return ranked
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, FUZZY_DOC_CANDIDATE_LIMIT)
      .map((entry) => entry.path);
  }

  private normalizeStructurePathToken(value: string): string | undefined {
    const normalized = normalizeStructuredPathToken(value);
    if (!normalized) return undefined;
    const cleaned = normalized
      .split("/")
      .map((segment) => (isStructuredFilePath(segment) ? segment : segment.replace(/[.,:;]+$/g, "")))
      .filter((segment, index, segments) => !(index < segments.length - 1 && isManifestLikeBasename(segment)))
      .filter(Boolean)
      .join("/");
    if (!cleaned) return undefined;
    const root = cleaned.split("/")[0]?.toLowerCase();
    if (root && DOC_SCAN_IGNORE_DIRS.has(root)) return undefined;
    return cleaned;
  }

  private normalizeTaskFiles(
    task: Pick<PlanTask, "files" | "description" | "unitTests" | "componentTests" | "integrationTests" | "apiTests">,
  ): string[] {
    const explicitFiles = (task.files ?? [])
      .map((value) => this.normalizeStructurePathToken(value))
      .filter((value): value is string => Boolean(value));
    const extractedFiles = filterImplementationStructuredPaths(
      extractStructuredPaths(
        [
          task.description ?? "",
          ...(task.unitTests ?? []),
          ...(task.componentTests ?? []),
          ...(task.integrationTests ?? []),
          ...(task.apiTests ?? []),
        ]
          .filter(Boolean)
          .join("\n"),
        96,
      ),
      )
      .map((value) => this.normalizeStructurePathToken(value))
      .filter((value): value is string => Boolean(value));
    return this.preferSpecificTaskTargets([...explicitFiles, ...extractedFiles]).slice(0, 8);
  }

  private preferSpecificTaskTargets(targets: string[]): string[] {
    const normalized = uniqueStrings(
      targets
        .map((value) => this.normalizeStructurePathToken(value) ?? value.replace(/\\/g, "/").trim())
        .filter((value): value is string => Boolean(value)),
    );
    const sorted = normalized.sort((left, right) => {
      const leftIsFile = isStructuredFilePath(path.basename(left));
      const rightIsFile = isStructuredFilePath(path.basename(right));
      if (leftIsFile !== rightIsFile) return leftIsFile ? -1 : 1;
      const leftDepth = left.split("/").filter(Boolean).length;
      const rightDepth = right.split("/").filter(Boolean).length;
      if (leftDepth !== rightDepth) return rightDepth - leftDepth;
      if (left.length !== right.length) return right.length - left.length;
      return left.localeCompare(right);
    });
    const kept: string[] = [];
    for (const target of sorted) {
      const prefix = `${target.replace(/\/+$/g, "")}/`;
      if (kept.some((existing) => existing === target || existing.startsWith(prefix))) {
        continue;
      }
      kept.push(target);
    }
    return kept.sort((left, right) => left.length - right.length || left.localeCompare(right));
  }

  private extractStructureTargets(docs: DocdexDocument[]): { directories: string[]; files: string[] } {
    const directories = new Set<string>();
    const files = new Set<string>();
    const shouldSkipStructureTarget = (normalized: string): boolean => {
      const lower = normalized.toLowerCase();
      if (lower === "docs" || lower.startsWith("docs/")) return true;
      return /\.(md|markdown|txt)$/i.test(path.basename(lower));
    };
    for (const doc of docs) {
      const segments = (doc.segments ?? []).map((segment) => segment.content).filter(Boolean).join("\n");
      const corpus = [doc.content, segments].filter(Boolean).join("\n");
      for (const token of filterImplementationStructuredPaths(extractStructuredPaths(corpus, 256))) {
        const normalized = this.normalizeStructurePathToken(token);
        if (!normalized) continue;
        if (shouldSkipStructureTarget(normalized)) continue;
        if (isStructuredFilePath(path.basename(normalized))) {
          files.add(normalized);
          const parent = path.dirname(normalized).replace(/\\/g, "/");
          if (parent && parent !== "." && !shouldSkipStructureTarget(parent)) directories.add(parent);
        } else {
          directories.add(normalized);
        }
      }
    }
    return {
      directories: Array.from(directories).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 32),
      files: Array.from(files).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 32),
    };
  }

  private selectArchitectureAuthorityDocs(docs: DocdexDocument[]): DocdexDocument[] {
    const planningDocs = this.sortDocsForPlanning(this.dedupePlanningDocs(this.filterPlanningSourceDocs(docs)));
    const pathBackedSdsDocs = planningDocs.filter((doc) => looksLikeSdsPath(`${doc.path ?? ""}\n${doc.title ?? ""}`));
    if (pathBackedSdsDocs.length > 0) return pathBackedSdsDocs;
    const sdsDocs = planningDocs.filter((doc) => looksLikeSdsDoc(doc));
    if (sdsDocs.length > 0) return sdsDocs;
    return planningDocs.slice(0, Math.min(2, planningDocs.length));
  }

  private splitArchitectureAuthorityDocs(
    docs: DocdexDocument[],
  ): { authorityDocs: DocdexDocument[]; supplementalDocs: DocdexDocument[] } {
    const authorityDocs = this.selectArchitectureAuthorityDocs(docs);
    const authorityIdentities = new Set(authorityDocs.map((doc) => this.docIdentity(doc)));
    return {
      authorityDocs,
      supplementalDocs: docs.filter((doc) => !authorityIdentities.has(this.docIdentity(doc))),
    };
  }

  private extractArchitectureRoot(target: string): string | undefined {
    const normalized = this.normalizeStructurePathToken(target);
    if (!normalized) return undefined;
    const segments = normalized
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) return undefined;
    const root = segments[0] ?? "";
    if (!root) return undefined;
    if (segments.length === 1 && isStructuredFilePath(root)) return undefined;
    if (segments.length === 1 && root.includes(".")) return undefined;
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(root)) return undefined;
    if (segments.length === 1) {
      return root.toLowerCase();
    }
    const second = segments[1] ?? "";
    if (!second || isStructuredFilePath(second) || second.includes(".")) {
      return root.toLowerCase();
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(second)) {
      return root.toLowerCase();
    }
    return `${root.toLowerCase()}/${second.toLowerCase()}`;
  }

  private isImplementationBearingArchitectureTarget(target: string): boolean {
    const classification = this.classifyBuildTarget(target);
    if (classification.kind === "doc") return false;
    if (classification.kind === "manifest") return classification.isServiceArtifact;
    if (classification.kind === "runtime" || classification.kind === "interface" || classification.kind === "data") {
      return true;
    }
    if (classification.kind === "ops") return true;
    if (classification.kind === "test") return classification.isFile;
    return classification.isFile && classification.segments.length >= 3;
  }

  private shouldUseSupplementalArchitectureTarget(target: string, trustedRoots: Set<string>): boolean {
    const normalized = this.normalizeStructurePathToken(target);
    if (!normalized) return false;
    if (!this.isImplementationBearingArchitectureTarget(normalized)) return false;
    const classification = this.classifyBuildTarget(normalized);
    const root = this.extractArchitectureRoot(normalized);
    if (trustedRoots.size === 0) {
      return classification.isFile || classification.segments.length >= 2;
    }
    if (root && trustedRoots.has(root)) return true;
    return classification.isFile && classification.segments.length >= 4;
  }

  private collectArchitectureSourceModel(docs: DocdexDocument[]): {
    authorityDocs: DocdexDocument[];
    supplementalDocs: DocdexDocument[];
    structureTargets: { directories: string[]; files: string[] };
    trustedRoots: Set<string>;
  } {
    const { authorityDocs, supplementalDocs } = this.splitArchitectureAuthorityDocs(docs);
    const rawAuthorityTargets = this.extractStructureTargets(authorityDocs);
    const authorityTargets = {
      directories: uniqueStrings(rawAuthorityTargets.directories),
      files: uniqueStrings(rawAuthorityTargets.files),
    };
    const trustedRoots = new Set<string>(
      [...authorityTargets.directories, ...authorityTargets.files]
        .filter((target) => {
          const normalized = this.normalizeStructurePathToken(target);
          if (!normalized) return false;
          const classification = this.classifyBuildTarget(normalized);
          return (
            classification.isFile ||
            classification.isServiceArtifact ||
            classification.kind === "runtime" ||
            classification.kind === "interface" ||
            classification.kind === "data" ||
            classification.kind === "ops" ||
            classification.segments.length >= 3
          );
        })
        .map((target) => this.extractArchitectureRoot(target))
        .filter((value): value is string => Boolean(value)),
    );
    const allowLooseSupplementalTargets = authorityTargets.directories.length + authorityTargets.files.length === 0;
    const filterAuthority = (targets: string[]): string[] =>
      uniqueStrings(
        targets.filter((target) =>
          allowLooseSupplementalTargets
            ? this.isImplementationBearingArchitectureTarget(target)
            : this.shouldUseSupplementalArchitectureTarget(target, trustedRoots),
        ),
      );
    const supplementalTargets = this.extractStructureTargets(supplementalDocs);
    const filterSupplemental = (targets: string[]): string[] =>
      uniqueStrings(
        targets.filter((target) =>
          allowLooseSupplementalTargets
            ? this.isImplementationBearingArchitectureTarget(target)
            : this.shouldUseSupplementalArchitectureTarget(target, trustedRoots),
        ),
      );
    return {
      authorityDocs,
      supplementalDocs,
      structureTargets: {
        directories: uniqueStrings([...filterAuthority(authorityTargets.directories), ...filterSupplemental(supplementalTargets.directories)]),
        files: uniqueStrings([...filterAuthority(authorityTargets.files), ...filterSupplemental(supplementalTargets.files)]),
      },
      trustedRoots,
    };
  }

  private isArchitectureMetaHeading(value: string): boolean {
    const normalized = normalizeHeadingCandidate(value);
    if (!normalized) return true;
    return ARCHITECTURE_META_HEADING_PATTERN.test(normalized);
  }

  private normalizeServiceName(value: string): string | undefined {
    const normalized = value
      .toLowerCase()
      .replace(/[`"'()[\]{}]/g, " ")
      .replace(/[._/-]+/g, " ")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return undefined;
    const keepTokens = new Set(["api", "ui", "db", "qa", "ml", "ai", "etl"]);
    const tokens = normalized
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => keepTokens.has(token) || !SERVICE_NAME_STOPWORDS.has(token))
      .slice(0, 4);
    if (!tokens.length) return undefined;
    const candidate = tokens.join(" ");
    if (SERVICE_NAME_INVALID.has(candidate)) return undefined;
    return candidate.length >= 2 ? candidate : undefined;
  }

  private normalizeTextServiceName(value: string): string | undefined {
    const candidate = this.normalizeServiceName(value);
    if (!candidate) return undefined;
    const tokens = candidate.split(" ").filter(Boolean);
    if (tokens.length === 0 || tokens.length > 3) return undefined;
    const first = tokens[0] ?? "";
    if (SERVICE_TEXT_INVALID_STARTERS.has(first)) return undefined;
    if (tokens.length === 1) {
      if (first.length < 3) return undefined;
      if (SERVICE_NAME_INVALID.has(first) || NON_RUNTIME_SERVICE_SINGLETONS.has(first)) return undefined;
      if (SERVICE_NAME_STOPWORDS.has(first)) return undefined;
    }
    return candidate;
  }

  private isLikelyServiceContainerSegment(parts: string[], index: number): boolean {
    const segment = parts[index];
    if (!segment) return false;
    if (SERVICE_PATH_CONTAINER_SEGMENTS.has(segment)) return true;
    if (index !== 0) return false;
    const next = parts[index + 1];
    if (!next) return false;
    const following = parts[index + 2];
    const nextLooksSpecific =
      !SERVICE_PATH_CONTAINER_SEGMENTS.has(next) &&
      !NON_RUNTIME_STRUCTURE_ROOT_SEGMENTS.has(next) &&
      !SOURCE_LIKE_PATH_SEGMENTS.has(next) &&
      !isStructuredFilePath(next);
    if (!nextLooksSpecific) return false;
    if (GENERIC_CONTAINER_PATH_SEGMENTS.has(segment)) {
      if (!following) return true;
      return SOURCE_LIKE_PATH_SEGMENTS.has(following) || isStructuredFilePath(following);
    }
    return false;
  }

  private normalizePathDerivedServiceName(value: string): string | undefined {
    const candidate = this.normalizeServiceName(value);
    if (!candidate) return undefined;
    if (NON_RUNTIME_SERVICE_SINGLETONS.has(candidate)) return undefined;
    if (candidate.split(" ").some((token) => NON_RUNTIME_PATH_SERVICE_TOKENS.has(token))) return undefined;
    return candidate;
  }

  private deriveServiceFromPathToken(pathToken: string): string | undefined {
    const parts = pathToken
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return undefined;
    if (NON_RUNTIME_STRUCTURE_ROOT_SEGMENTS.has(parts[0] ?? "")) return undefined;
    if (parts.length === 1 && isStructuredFilePath(parts[0] ?? "")) return undefined;
    let idx = 0;
    while (idx < parts.length - 1 && this.isLikelyServiceContainerSegment(parts, idx)) {
      idx += 1;
    }
    const candidate = parts[idx] ?? parts[0];
    if (isStructuredFilePath(candidate)) return undefined;
    return this.normalizePathDerivedServiceName(candidate);
  }

  private addServiceAlias(aliases: Map<string, Set<string>>, rawValue: string): string | undefined {
    const canonical = this.normalizeServiceName(rawValue);
    if (!canonical) return undefined;
    const existing = aliases.get(canonical) ?? new Set<string>();
    existing.add(canonical);
    const alias = rawValue
      .toLowerCase()
      .replace(/[._/-]+/g, " ")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (alias) existing.add(alias);
    if (alias.endsWith("s") && alias.length > 3) existing.add(alias.slice(0, -1));
    if (!alias.endsWith("s") && alias.length > 2) existing.add(`${alias}s`);
    aliases.set(canonical, existing);
    return canonical;
  }

  private extractServiceMentionsFromText(text: string): string[] {
    if (!text) return [];
    const mentions = new Set<string>();
    for (const match of text.matchAll(SERVICE_LABEL_PATTERN)) {
      const phrase = `${match[1] ?? ""} ${match[2] ?? ""}`.trim();
      const normalized = this.normalizeTextServiceName(phrase);
      if (normalized) mentions.add(normalized);
    }
    for (const match of text.matchAll(DOC_PATH_TOKEN_PATTERN)) {
      const token = match[2];
      if (!token) continue;
      const normalized = this.deriveServiceFromPathToken(token);
      if (normalized) mentions.add(normalized);
    }
    return Array.from(mentions);
  }

  private deriveServiceMentionFromPathPhrase(phrase: string): string | undefined {
    for (const match of phrase.matchAll(DOC_PATH_TOKEN_PATTERN)) {
      const token = match[2];
      if (!token) continue;
      const derived = this.deriveServiceFromPathToken(token);
      if (derived) return derived;
    }
    return undefined;
  }

  private resolveServiceMentionFromPhrase(
    phrase: string,
    aliases: Map<string, Set<string>>,
    options: { allowAliasRegistration?: boolean } = {},
  ): string | undefined {
    const normalizedPhrase = phrase
      .toLowerCase()
      .replace(/[._/-]+/g, " ")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalizedPhrase) return undefined;
    let best: { key: string; aliasLength: number } | undefined;
    const haystack = ` ${normalizedPhrase} `;
    for (const [service, names] of aliases.entries()) {
      for (const alias of names) {
        const needle = ` ${alias} `;
        if (!haystack.includes(needle)) continue;
        if (!best || alias.length > best.aliasLength) {
          best = { key: service, aliasLength: alias.length };
        }
      }
    }
    if (best) return best.key;
    const pathDerived = this.deriveServiceMentionFromPathPhrase(phrase);
    if (pathDerived) return pathDerived;
    if (!options.allowAliasRegistration) return undefined;
    const mention = this.extractServiceMentionsFromText(phrase)[0];
    if (!mention) return undefined;
    return this.addServiceAlias(aliases, mention);
  }

  private collectDependencyStatements(text: string): Array<{ dependent: string; dependency: string }> {
    const statements: Array<{ dependent: string; dependency: string }> = [];
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, DEPENDENCY_SCAN_LINE_LIMIT);
    const dependencyPatterns: Array<{
      regex: RegExp;
      dependentGroup: number;
      dependencyGroup: number;
    }> = [
      {
        regex:
          /^(.+?)\b(?:depends on|requires|needs|uses|consumes|calls|reads from|writes to|must come after|comes after|built after|runs after|backed by)\b(.+)$/i,
        dependentGroup: 1,
        dependencyGroup: 2,
      },
      {
        regex: /^(.+?)\b(?:before|prerequisite for)\b(.+)$/i,
        dependentGroup: 2,
        dependencyGroup: 1,
      },
    ];
    for (const rawLine of lines) {
      const line = rawLine.replace(/^[-*]\s+/, "").trim();
      if (!line) continue;
      for (const match of line.matchAll(SERVICE_ARROW_PATTERN)) {
        const dependent = match[1]?.trim();
        const dependency = match[2]?.trim();
        if (dependent && dependency) {
          statements.push({ dependent, dependency });
        }
      }
      for (const pattern of dependencyPatterns) {
        const match = line.match(pattern.regex);
        if (!match) continue;
        const dependent = match[pattern.dependentGroup]?.trim();
        const dependency = match[pattern.dependencyGroup]?.trim();
        if (!dependent || !dependency) continue;
        statements.push({ dependent, dependency });
      }
    }
    return statements;
  }

  private extractStartupWaveHints(
    text: string,
    aliases: Map<string, Set<string>>,
  ): {
    waveRank: Map<string, number>;
    startupWaves: Array<{ wave: number; services: string[] }>;
    foundationalDependencies: string[];
  } {
    const waveRank = new Map<string, number>();
    const startupWavesMap = new Map<number, Set<string>>();
    const foundational = new Set<string>();
    const registerWave = (service: string, wave: number) => {
      const normalizedWave = Number.isFinite(wave) ? Math.max(0, wave) : Number.MAX_SAFE_INTEGER;
      const current = waveRank.get(service);
      if (current === undefined || normalizedWave < current) {
        waveRank.set(service, normalizedWave);
      }
      const bucket = startupWavesMap.get(normalizedWave) ?? new Set<string>();
      bucket.add(service);
      startupWavesMap.set(normalizedWave, bucket);
    };
    const resolveServicesFromCell = (cell: string): string[] => {
      const resolved = new Set<string>();
      for (const match of cell.matchAll(SERVICE_HANDLE_PATTERN)) {
        const token = match[1]?.trim();
        if (!token) continue;
        if (token.includes("*")) {
          const normalizedPrefix = this.normalizeServiceName(token.replace(/\*+/g, ""));
          if (!normalizedPrefix) continue;
          for (const service of aliases.keys()) {
            if (service.startsWith(normalizedPrefix)) resolved.add(service);
          }
          continue;
        }
        const canonical = this.resolveServiceMentionFromPhrase(token, aliases) ?? this.addServiceAlias(aliases, token);
        if (canonical) resolved.add(canonical);
      }
      if (resolved.size === 0) {
        const normalizedCell = this.normalizeServiceLookupKey(cell);
        const haystack = normalizedCell ? ` ${normalizedCell} ` : "";
        for (const [service, names] of aliases.entries()) {
          for (const alias of names) {
            if (!alias || alias.length < 2) continue;
            if (!haystack.includes(` ${alias} `)) continue;
            resolved.add(service);
            break;
          }
        }
      }
      return Array.from(resolved);
    };
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, STARTUP_WAVE_SCAN_LINE_LIMIT);
    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      const cells = line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length < 2) continue;
      const waveFromFirst = cells[0].match(WAVE_LABEL_PATTERN);
      if (waveFromFirst) {
        const waveIndex = Number.parseInt(waveFromFirst[1] ?? "", 10);
        const services = resolveServicesFromCell(cells[1]);
        for (const service of services) registerWave(service, waveIndex);
        if (waveIndex === 0 && services.length === 0) {
          for (const token of cells[1]
            .replace(/[`_*]/g, "")
            .split(/[,+]/)
            .map((entry) => entry.trim())
            .filter(Boolean)) {
            foundational.add(token);
          }
        }
        continue;
      }
      const waveFromSecond = cells[1].match(WAVE_LABEL_PATTERN);
      if (!waveFromSecond) continue;
      const waveIndex = Number.parseInt(waveFromSecond[1] ?? "", 10);
      for (const service of resolveServicesFromCell(cells[0])) registerWave(service, waveIndex);
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const waveMatch = line.match(WAVE_LABEL_PATTERN);
      if (!waveMatch) continue;
      const waveIndex = Number.parseInt(waveMatch[1] ?? "", 10);
      if (!Number.isFinite(waveIndex)) continue;
      const contextLines = [line];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]!;
        if (WAVE_LABEL_PATTERN.test(next)) break;
        if (/^#{1,6}\s+/.test(next)) break;
        if (/^(?:[-*]|\d+[.)])\s+/.test(next)) break;
        contextLines.push(next);
        if (contextLines.length >= 4) break;
      }
      for (const service of resolveServicesFromCell(contextLines.join(" "))) {
        registerWave(service, waveIndex);
      }
    }
    const startupWaves = Array.from(startupWavesMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([wave, services]) => ({ wave, services: Array.from(services).sort((a, b) => a.localeCompare(b)) }));
    return {
      waveRank,
      startupWaves,
      foundationalDependencies: Array.from(foundational).slice(0, 12),
    };
  }

  private sortServicesByDependency(
    services: string[],
    dependencies: Map<string, Set<string>>,
    waveRank: Map<string, number> = new Map(),
  ): string[] {
    const nodes = Array.from(new Set(services));
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, Set<string>>();
    const dependedBy = new Map<string, number>();
    for (const node of nodes) {
      indegree.set(node, 0);
      dependedBy.set(node, 0);
    }
    for (const [dependent, dependencySet] of dependencies.entries()) {
      if (!indegree.has(dependent)) {
        indegree.set(dependent, 0);
        dependedBy.set(dependent, 0);
        nodes.push(dependent);
      }
      for (const dependency of dependencySet) {
        if (!indegree.has(dependency)) {
          indegree.set(dependency, 0);
          dependedBy.set(dependency, 0);
          nodes.push(dependency);
        }
        indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1);
        const out = adjacency.get(dependency) ?? new Set<string>();
        out.add(dependent);
        adjacency.set(dependency, out);
        dependedBy.set(dependency, (dependedBy.get(dependency) ?? 0) + 1);
      }
    }
    const compare = (a: string, b: string): number => {
      const waveA = waveRank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const waveB = waveRank.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (waveA !== waveB) return waveA - waveB;
      const dependedByA = dependedBy.get(a) ?? 0;
      const dependedByB = dependedBy.get(b) ?? 0;
      if (dependedByA !== dependedByB) return dependedByB - dependedByA;
      return a.localeCompare(b);
    };
    const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0).sort(compare);
    const ordered: string[] = [];
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      ordered.push(current);
      const out = adjacency.get(current);
      if (!out) continue;
      for (const neighbor of out) {
        const nextInDegree = (indegree.get(neighbor) ?? 0) - 1;
        indegree.set(neighbor, nextInDegree);
        if (nextInDegree === 0) {
          queue.push(neighbor);
        }
      }
      queue.sort(compare);
    }
    if (ordered.length === nodes.length) return ordered;
    const remaining = nodes.filter((node) => !ordered.includes(node)).sort(compare);
    return [...ordered, ...remaining];
  }

  private buildServiceDependencyGraph(plan: GeneratedPlan, docs: DocdexDocument[]): ServiceDependencyGraph {
    const aliases = new Map<string, Set<string>>();
    const dependencies = new Map<string, Set<string>>();
    const sourceBackedServices = new Set<string>();
    const sourceModel = this.collectArchitectureSourceModel(docs);
    const register = (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      return this.addServiceAlias(aliases, value);
    };
    const registerSourceBacked = (value: string | undefined): string | undefined => {
      const canonical = register(value);
      if (canonical) sourceBackedServices.add(canonical);
      return canonical;
    };
    const docsText = docs
      .map((doc) => [doc.title, doc.path, doc.content, ...(doc.segments ?? []).map((segment) => segment.content)].filter(Boolean).join("\n"))
      .join("\n");
    const authorityDocsText = sourceModel.authorityDocs
      .map((doc) => [doc.title, doc.path, doc.content, ...(doc.segments ?? []).map((segment) => segment.content)].filter(Boolean).join("\n"))
      .join("\n");
    const planText = [
      ...plan.epics.map((epic) => `${epic.title}\n${epic.description ?? ""}`),
      ...plan.stories.map((story) => `${story.title}\n${story.description ?? ""}\n${story.userStory ?? ""}`),
      ...plan.tasks.map((task) => `${task.title}\n${task.description ?? ""}`),
    ].join("\n");
    for (const [epicIndex, epic] of plan.epics.entries()) {
      for (const serviceId of normalizeStringArray(epic.serviceIds)) {
        register(serviceId);
      }
    }
    const structureTargets = sourceModel.structureTargets;
    const structureTokens = [...structureTargets.directories, ...structureTargets.files];
    for (const token of structureTokens) {
      if (
        !token.includes("/") &&
        !isStructuredFilePath(path.basename(token)) &&
        structureTokens.some((candidate) => candidate !== token && candidate.startsWith(`${token}/`))
      ) {
        continue;
      }
      registerSourceBacked(this.deriveServiceFromPathToken(token));
    }
    for (const component of this.extractRuntimeComponentNames(sourceModel.authorityDocs)) {
      registerSourceBacked(component);
    }
    for (const match of authorityDocsText.matchAll(SERVICE_HANDLE_PATTERN)) registerSourceBacked(match[1]);
    const docsHaveRuntimeTopologySignals =
      sourceBackedServices.size > 0 &&
      (structureTargets.directories.length > 0 ||
        structureTargets.files.length > 0 ||
        this.collectDependencyStatements(authorityDocsText).length > 0 ||
        WAVE_LABEL_PATTERN.test(authorityDocsText) ||
        TOPOLOGY_HEADING_PATTERN.test(authorityDocsText));
    if (!docsHaveRuntimeTopologySignals) {
      for (const match of planText.matchAll(SERVICE_HANDLE_PATTERN)) register(match[1]);
      for (const mention of this.extractServiceMentionsFromText(planText)) register(mention);
    }
    const corpus = [
      { text: authorityDocsText, allowAliasRegistration: false },
      { text: planText, allowAliasRegistration: true },
    ].filter((entry) => entry.text);
    for (const { text, allowAliasRegistration } of corpus) {
      const statements = this.collectDependencyStatements(text);
      for (const statement of statements) {
        const dependent =
          this.resolveServiceMentionFromPhrase(statement.dependent, aliases) ??
          (allowAliasRegistration
            ? this.resolveServiceMentionFromPhrase(statement.dependent, aliases, {
                allowAliasRegistration: true,
              })
            : undefined);
        const dependency =
          this.resolveServiceMentionFromPhrase(statement.dependency, aliases) ??
          (allowAliasRegistration
            ? this.resolveServiceMentionFromPhrase(statement.dependency, aliases, {
                allowAliasRegistration: true,
              })
            : undefined);
        if (!dependent || !dependency || dependent === dependency) continue;
        const next = dependencies.get(dependent) ?? new Set<string>();
        next.add(dependency);
        dependencies.set(dependent, next);
      }
    }
    const waveHints = this.extractStartupWaveHints(
      corpus
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n"),
      aliases,
    );
    const services = this.sortServicesByDependency(Array.from(aliases.keys()), dependencies, waveHints.waveRank);
    return {
      services,
      dependencies,
      aliases,
      waveRank: waveHints.waveRank,
      startupWaves: waveHints.startupWaves,
      foundationalDependencies: waveHints.foundationalDependencies,
    };
  }

  private summarizeTopologySignals(docs: DocdexDocument[]): TopologySignalSummary {
    const sourceModel = this.collectArchitectureSourceModel(docs);
    const structureTargets = sourceModel.structureTargets;
    const structureServices = uniqueStrings(
      [...structureTargets.directories, ...structureTargets.files]
        .map((token) => this.deriveServiceFromPathToken(token))
        .filter((value): value is string => Boolean(value))
        .concat(this.extractRuntimeComponentNames(sourceModel.authorityDocs)),
    ).slice(0, 24);
    const topologyHeadings = this.extractSdsSectionCandidates(sourceModel.authorityDocs, 64)
      .filter((heading) => TOPOLOGY_HEADING_PATTERN.test(heading))
      .slice(0, 24);
    const docsText = sourceModel.authorityDocs
      .map((doc) => [doc.title, doc.path, doc.content, ...(doc.segments ?? []).map((segment) => segment.content)].filter(Boolean).join("\n"))
      .join("\n");
    const dependencyPairs = uniqueStrings(
      this.collectDependencyStatements(docsText).map((statement) => `${statement.dependent} -> ${statement.dependency}`),
    ).slice(0, 16);
    const waveMentions = docsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => WAVE_LABEL_PATTERN.test(line))
      .slice(0, 16);
    return {
      structureServices,
      topologyHeadings,
      dependencyPairs,
      waveMentions,
    };
  }

  private buildSourceTopologyExpectation(docs: DocdexDocument[]): SourceTopologyExpectation {
    const signalSummary = this.summarizeTopologySignals(docs);
    const docsOnlyGraph = this.buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
    return {
      runtimeBearing:
        docsOnlyGraph.services.length > 0 ||
        docsOnlyGraph.startupWaves.length > 0 ||
        signalSummary.dependencyPairs.length > 0,
      services: docsOnlyGraph.services,
      startupWaves: docsOnlyGraph.startupWaves.map((wave) => ({
        wave: wave.wave,
        services: [...wave.services],
      })),
      dependencyPairs: signalSummary.dependencyPairs,
      signalSummary,
    };
  }

  private buildCanonicalNameInventory(docs: DocdexDocument[]): CanonicalNameInventory {
    const sourceModel = this.collectArchitectureSourceModel(docs);
    const structureTargets = sourceModel.structureTargets;
    const paths = uniqueStrings(
      [...structureTargets.directories, ...structureTargets.files]
        .map((token) => this.normalizeStructurePathToken(token))
        .filter((value): value is string => Boolean(value)),
    ).sort((a, b) => a.length - b.length || a.localeCompare(b));
    const graph = this.buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, sourceModel.authorityDocs);
    const serviceAliases = new Map<string, Set<string>>();
    for (const [service, aliases] of graph.aliases.entries()) {
      serviceAliases.set(service, new Set(aliases));
    }
    for (const service of graph.services) {
      const existing = serviceAliases.get(service) ?? new Set<string>();
      existing.add(service);
      serviceAliases.set(service, existing);
    }
    return {
      paths,
      pathSet: new Set(paths),
      services: [...graph.services],
      serviceAliases,
    };
  }

  private countCommonPrefixSegments(left: string[], right: string[]): number {
    let count = 0;
    while (count < left.length && count < right.length && left[count] === right[count]) {
      count += 1;
    }
    return count;
  }

  private countCommonSuffixSegments(left: string[], right: string[], prefixFloor = 0): number {
    let count = 0;
    while (
      count < left.length - prefixFloor &&
      count < right.length - prefixFloor &&
      left[left.length - 1 - count] === right[right.length - 1 - count]
    ) {
      count += 1;
    }
    return count;
  }

  private tokenizeCanonicalName(value: string): string[] {
    return this.normalizeServiceLookupKey(value)
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private namesSemanticallyCollide(candidate: string, canonical: string): boolean {
    const candidateTokens = this.tokenizeCanonicalName(candidate);
    const canonicalTokens = this.tokenizeCanonicalName(canonical);
    if (candidateTokens.length === 0 || canonicalTokens.length === 0) return false;
    const canonicalSet = new Set(canonicalTokens);
    const shared = candidateTokens.filter((token) => canonicalSet.has(token));
    if (shared.length === 0) return false;
    if (shared.length === Math.min(candidateTokens.length, canonicalTokens.length)) return true;
    const candidateNormalized = candidateTokens.join(" ");
    const canonicalNormalized = canonicalTokens.join(" ");
    return (
      candidateNormalized.includes(canonicalNormalized) || canonicalNormalized.includes(candidateNormalized)
    );
  }

  private findCanonicalPathConflict(
    candidatePath: string,
    inventory: CanonicalNameInventory,
  ): { canonicalPath: string; canonicalService?: string } | undefined {
    if (!candidatePath || inventory.pathSet.has(candidatePath)) return undefined;
    const candidateParts = candidatePath.split("/").filter(Boolean);
    let bestMatch:
      | {
          canonicalPath: string;
          canonicalService?: string;
          score: number;
        }
      | undefined;
    for (const canonicalPath of inventory.paths) {
      if (candidatePath === canonicalPath) continue;
      const canonicalParts = canonicalPath.split("/").filter(Boolean);
      const sharedPrefix = this.countCommonPrefixSegments(candidateParts, canonicalParts);
      if (sharedPrefix === 0) continue;
      const sharedSuffix = this.countCommonSuffixSegments(candidateParts, canonicalParts, sharedPrefix);
      if (sharedSuffix === 0) continue;
      const candidateCore = candidateParts.slice(sharedPrefix, candidateParts.length - sharedSuffix);
      const canonicalCore = canonicalParts.slice(sharedPrefix, canonicalParts.length - sharedSuffix);
      if (candidateCore.length !== 1 || canonicalCore.length !== 1) continue;
      const candidateSegment = candidateCore[0] ?? "";
      const canonicalSegment = canonicalCore[0] ?? "";
      if (!this.namesSemanticallyCollide(candidateSegment, canonicalSegment)) continue;
      const candidateService = this.deriveServiceFromPathToken(candidatePath);
      const canonicalService = this.deriveServiceFromPathToken(canonicalPath);
      if (
        candidateService &&
        canonicalService &&
        candidateService !== canonicalService &&
        !this.namesSemanticallyCollide(candidateService, canonicalService)
      ) {
        continue;
      }
      const score = sharedPrefix + sharedSuffix;
      if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && canonicalPath.length > bestMatch.canonicalPath.length)) {
        bestMatch = { canonicalPath, canonicalService, score };
      }
    }
    return bestMatch ? { canonicalPath: bestMatch.canonicalPath, canonicalService: bestMatch.canonicalService } : undefined;
  }

  private collectCanonicalPlanSources(plan: GeneratedPlan): Array<{ location: string; text: string }> {
    const sources: Array<{ location: string; text: string }> = [];
    for (const [epicIndex, epic] of plan.epics.entries()) {
      sources.push({
        location: `epic:${epic.localId}`,
        text: [epic.title, epic.description, ...(epic.acceptanceCriteria ?? []), ...(epic.serviceIds ?? []), ...(epic.tags ?? [])]
          .filter(Boolean)
          .join("\n"),
      });
    }
    for (const story of plan.stories) {
      sources.push({
        location: `story:${story.epicLocalId}/${story.localId}`,
        text: [story.title, story.userStory, story.description, ...(story.acceptanceCriteria ?? [])]
          .filter(Boolean)
          .join("\n"),
      });
    }
    for (const task of plan.tasks) {
      sources.push({
        location: `task:${task.epicLocalId}/${task.storyLocalId}/${task.localId}`,
        text: [
          task.title,
          task.description,
          ...(task.relatedDocs ?? []),
          ...(task.unitTests ?? []),
          ...(task.componentTests ?? []),
          ...(task.integrationTests ?? []),
          ...(task.apiTests ?? []),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
    return sources.filter((source) => source.text.trim().length > 0);
  }

  private assertCanonicalNameConsistency(projectKey: string, docs: DocdexDocument[], plan: GeneratedPlan): void {
    const inventory = this.buildCanonicalNameInventory(docs);
    if (inventory.paths.length === 0 && inventory.services.length === 0) return;
    const conflicts = new Map<string, { location: string; candidate: string; canonical: string }>();
    for (const source of this.collectCanonicalPlanSources(plan)) {
      const candidatePaths = uniqueStrings(
        filterImplementationStructuredPaths(extractStructuredPaths(source.text, 256))
          .map((token) => this.normalizeStructurePathToken(token))
          .filter((value): value is string => Boolean(value)),
      );
      for (const candidatePath of candidatePaths) {
        if (inventory.pathSet.has(candidatePath)) continue;
        const conflict = this.findCanonicalPathConflict(candidatePath, inventory);
        if (!conflict) continue;
        const key = `${source.location}|${candidatePath}|${conflict.canonicalPath}`;
        conflicts.set(key, {
          location: source.location,
          candidate: candidatePath,
          canonical: conflict.canonicalPath,
        });
      }
    }
    if (conflicts.size === 0) return;
    const summary = Array.from(conflicts.values())
      .slice(0, 8)
      .map((conflict) => `${conflict.location}: ${conflict.candidate} -> ${conflict.canonical}`)
      .join("; ");
    throw new Error(
      `create-tasks failed canonical name validation for project "${projectKey}". Undocumented alternate implementation paths conflict with source-backed canonical names: ${summary}`,
    );
  }

  private formatTopologySignalSummary(signalSummary: TopologySignalSummary): string {
    return uniqueStrings([
      ...signalSummary.structureServices.map((service) => `structure:${service}`),
      ...signalSummary.topologyHeadings.map((heading) => `heading:${heading}`),
      ...signalSummary.dependencyPairs.map((pair) => `dependency:${pair}`),
      ...signalSummary.waveMentions.map((wave) => `wave:${wave}`),
    ])
      .slice(0, 10)
      .join("; ");
  }

  private validateTopologyExtraction(
    projectKey: string,
    expectation: SourceTopologyExpectation,
    graph: ServiceDependencyGraph,
  ): TopologySignalSummary {
    const topologySignals = expectation.signalSummary;
    if (!expectation.runtimeBearing) return topologySignals;
    if (graph.services.length === 0) {
      throw new Error(
        `create-tasks failed internal topology extraction for project "${projectKey}". SDS includes runtime topology signals but no services were resolved. Signals: ${this.formatTopologySignalSummary(topologySignals) || "unavailable"}`,
      );
    }
    const missingServices = expectation.services.filter((service) => !graph.services.includes(service));
    if (missingServices.length > 0) {
      throw new Error(
        `create-tasks failed internal topology extraction for project "${projectKey}". Final planning artifacts lost source-backed services: ${missingServices.slice(0, 8).join(", ")}.`,
      );
    }
    if (expectation.startupWaves.length > 0 && graph.startupWaves.length === 0) {
      throw new Error(
        `create-tasks failed internal topology extraction for project "${projectKey}". SDS includes startup wave signals but no startup waves were resolved. Signals: ${topologySignals.waveMentions.slice(0, 6).join("; ")}`,
      );
    }
    const graphServicesByWave = new Map(
      graph.startupWaves.map((wave) => [wave.wave, new Set(wave.services)] as const),
    );
    const missingWaves = expectation.startupWaves
      .map((wave) => wave.wave)
      .filter((wave) => !graphServicesByWave.has(wave));
    if (missingWaves.length > 0) {
      throw new Error(
        `create-tasks failed internal topology extraction for project "${projectKey}". Final planning artifacts lost source-backed startup waves: ${missingWaves.slice(0, 8).join(", ")}.`,
      );
    }
    const missingWaveServices = expectation.startupWaves.flatMap((wave) => {
      const actualServices = graphServicesByWave.get(wave.wave);
      return wave.services
        .filter((service) => !(actualServices?.has(service) ?? false))
        .map((service) => `wave ${wave.wave}:${service}`);
    });
    if (missingWaveServices.length > 0) {
      throw new Error(
        `create-tasks failed internal topology extraction for project "${projectKey}". Final planning artifacts lost source-backed startup wave services: ${missingWaveServices.slice(0, 8).join(", ")}.`,
      );
    }
    return topologySignals;
  }

  private derivePlanningArtifacts(
    projectKey: string,
    docs: DocdexDocument[],
    _plan: GeneratedPlan,
    expectation: SourceTopologyExpectation = this.buildSourceTopologyExpectation(docs),
  ): {
    discoveryGraph: ServiceDependencyGraph;
    topologySignals: TopologySignalSummary;
    serviceCatalog: ServiceCatalogArtifact;
    architecture: CanonicalArchitectureArtifact;
    projectBuildMethod: string;
    projectBuildPlan: ProjectBuildPlanArtifact;
  } {
    const discoveryGraph = this.buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
    const topologySignals = this.validateTopologyExtraction(projectKey, expectation, discoveryGraph);
    const serviceCatalog = this.buildServiceCatalogArtifact(projectKey, docs, discoveryGraph);
    const architecture = this.buildCanonicalArchitectureArtifact(docs, serviceCatalog, discoveryGraph);
    const projectBuildMethod = this.buildProjectConstructionMethod(docs, discoveryGraph);
    const projectBuildPlan = this.buildProjectPlanArtifact(projectKey, docs, discoveryGraph, projectBuildMethod);
    return {
      discoveryGraph,
      topologySignals,
      serviceCatalog,
      architecture,
      projectBuildMethod,
      projectBuildPlan,
    };
  }

  private normalizeServiceId(value: string): string | undefined {
    const normalizedName = this.normalizeServiceName(value);
    if (!normalizedName) return undefined;
    const slug = normalizedName
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) return undefined;
    return /^[a-z]/.test(slug) ? slug : `svc-${slug}`;
  }

  private normalizeServiceLookupKey(value: string): string {
    return value
      .toLowerCase()
      .replace(/[`"'()[\]{}]/g, " ")
      .replace(/[._/-]+/g, " ")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private createUniqueServiceId(baseId: string, used: Set<string>): string {
    if (!used.has(baseId)) {
      used.add(baseId);
      return baseId;
    }
    let suffix = 2;
    while (used.has(`${baseId}-${suffix}`)) suffix += 1;
    const next = `${baseId}-${suffix}`;
    used.add(next);
    return next;
  }

  private buildServiceCatalogArtifact(
    projectKey: string,
    docs: DocdexDocument[],
    graph: ServiceDependencyGraph,
  ): ServiceCatalogArtifact {
    const serviceNames = new Set<string>(graph.services);
    for (const [dependent, dependencies] of graph.dependencies.entries()) {
      serviceNames.add(dependent);
      for (const dependency of dependencies) serviceNames.add(dependency);
    }
    for (const foundation of graph.foundationalDependencies) {
      const normalized = this.normalizeServiceName(foundation);
      if (normalized) serviceNames.add(normalized);
    }
    const orderedNames = [
      ...graph.services,
      ...Array.from(serviceNames)
        .filter((name) => !graph.services.includes(name))
        .sort((a, b) => a.localeCompare(b)),
    ];
    const usedServiceIds = new Set<string>();
    const serviceIdByName = new Map<string, string>();
    for (const name of orderedNames) {
      const baseId = this.normalizeServiceId(name);
      if (!baseId) continue;
      serviceIdByName.set(name, this.createUniqueServiceId(baseId, usedServiceIds));
    }

    const services: ServiceCatalogEntry[] = [];
    for (const name of orderedNames) {
      const id = serviceIdByName.get(name);
      if (!id) continue;
      const aliases = uniqueStrings([
        name,
        ...(graph.aliases.get(name) ? Array.from(graph.aliases.get(name) ?? []) : []),
      ]).sort((a, b) => a.localeCompare(b));
      const dependencyNames = Array.from(graph.dependencies.get(name) ?? []);
      const dependsOnServiceIds = uniqueStrings(
        dependencyNames
          .map((dependency) => serviceIdByName.get(dependency))
          .filter((value): value is string => Boolean(value)),
      );
      const startupWave = graph.waveRank.get(name);
      const wave = typeof startupWave === "number" && Number.isFinite(startupWave) ? startupWave : undefined;
      services.push({
        id,
        name,
        aliases,
        startupWave: wave,
        dependsOnServiceIds,
        isFoundational:
          graph.foundationalDependencies.some(
            (foundation) => this.normalizeServiceName(foundation) === name || this.normalizeServiceId(foundation) === id,
          ) || dependsOnServiceIds.length === 0,
      });
    }

    if (services.length === 0) {
      const fallbackServiceId = this.normalizeServiceId(`${projectKey} core`) ?? `${projectKey}-core`;
      services.push({
        id: fallbackServiceId,
        name: `${projectKey} core`,
        aliases: uniqueStrings([`${projectKey} core`, projectKey, "core"]),
        dependsOnServiceIds: [],
        isFoundational: true,
      });
    }

    const sourceDocs = docs
      .map((doc) => doc.path ?? (doc.id ? `docdex:${doc.id}` : doc.title ?? "doc"))
      .filter((value): value is string => Boolean(value))
      .filter((value, index, items) => items.indexOf(value) === index)
      .slice(0, 24);

    return {
      projectKey,
      generatedAt: new Date().toISOString(),
      sourceDocs,
      services,
    };
  }

  private buildServiceCatalogPromptSummary(catalog: ServiceCatalogArtifact): string {
    if (!catalog.services.length) {
      return "- No services detected. Infer services from SDS and ensure every epic includes at least one service id.";
    }
    const allIds = catalog.services.map((service) => service.id);
    const idChunks: string[] = [];
    for (let index = 0; index < allIds.length; index += 12) {
      idChunks.push(allIds.slice(index, index + 12).join(", "));
    }
    const detailLimit = Math.min(catalog.services.length, 40);
    const detailLines = catalog.services.slice(0, detailLimit).map((service) => {
      const deps = service.dependsOnServiceIds.length > 0 ? service.dependsOnServiceIds.join(", ") : "none";
      const wave = typeof service.startupWave === "number" ? `wave=${service.startupWave}` : "wave=unspecified";
      return `- ${service.id} (${wave}; deps: ${deps}; aliases: ${service.aliases.slice(0, 5).join(", ")})`;
    });
    if (catalog.services.length > detailLimit) {
      detailLines.push(
        `- ${catalog.services.length - detailLimit} additional services omitted from detailed lines (still listed in allowed serviceIds).`,
      );
    }
    return [`- Allowed serviceIds (${allIds.length}):`, ...idChunks.map((chunk) => `  ${chunk}`), "- Service details:", ...detailLines].join(
      "\n",
    );
  }

  private buildServiceCatalogPromptSummaryForIds(
    catalog: ServiceCatalogArtifact,
    serviceIds: Iterable<string>,
  ): string {
    const allowed = new Set(
      Array.from(serviceIds)
        .map((serviceId) => serviceId.trim())
        .filter(Boolean),
    );
    if (allowed.size === 0) {
      return this.buildServiceCatalogPromptSummary(catalog);
    }
    const filtered = catalog.services.filter((service) => allowed.has(service.id));
    if (filtered.length === 0) {
      return this.buildServiceCatalogPromptSummary(catalog);
    }
    return this.buildServiceCatalogPromptSummary({
      ...catalog,
      services: filtered,
    });
  }

  private buildArchitecturePromptSummary(architecture: CanonicalArchitectureArtifact): string {
    if (!architecture.units.length) {
      return "- No canonical architecture units were derived. Infer the minimum buildable architecture directly from the SDS.";
    }
    const detailLimit = Math.min(architecture.units.length, 24);
    const lines = architecture.units.slice(0, detailLimit).map((unit) => {
      const deps = unit.dependsOnUnitIds.length > 0 ? unit.dependsOnUnitIds.join(", ") : "none";
      const targets = uniqueStrings([...unit.implementationTargets, ...unit.supportingTargets]).slice(0, 4);
      const wave = typeof unit.startupWave === "number" ? `wave=${unit.startupWave}` : "wave=unspecified";
      return [
        `- ${unit.unitId} (${unit.kind}; ${wave}; deps: ${deps})`,
        `  targets: ${targets.length > 0 ? targets.join(", ") : "none inferred"}`,
        `  headings: ${unit.sourceHeadings.slice(0, 3).join("; ") || "none"}`,
      ].join("\n");
    });
    if (architecture.units.length > detailLimit) {
      lines.push(`- ${architecture.units.length - detailLimit} additional architecture units omitted from the summary.`);
    }
    return [
      `- Architecture roots: ${architecture.architectureRoots.join(", ") || "none"}`,
      `- Services: ${architecture.services.join(", ") || "none"}`,
      `- Cross-cutting domains: ${architecture.crossCuttingDomains.join(", ") || "none"}`,
      "- Architecture units:",
      ...lines,
    ].join("\n");
  }

  private alignEpicsToServiceCatalog(
    epics: AgentEpicNode[],
    catalog: ServiceCatalogArtifact,
    policy: EpicServiceValidationPolicy,
  ): { epics: AgentEpicNode[]; warnings: string[] } {
    const warnings: string[] = [];
    const validServiceIds = new Set(catalog.services.map((service) => service.id));
    const serviceOrder = new Map(catalog.services.map((service, index) => [service.id, index]));
    const aliasToIds = new Map<string, Set<string>>();
    const idLookup = new Map<string, string>();
    const registerAlias = (rawValue: string, serviceId: string) => {
      const normalized = this.normalizeServiceLookupKey(rawValue);
      if (!normalized) return;
      const bucket = aliasToIds.get(normalized) ?? new Set<string>();
      bucket.add(serviceId);
      aliasToIds.set(normalized, bucket);
    };
    for (const service of catalog.services) {
      const normalizedId = this.normalizeServiceLookupKey(service.id);
      if (normalizedId) idLookup.set(normalizedId, service.id);
      registerAlias(service.id, service.id);
      registerAlias(service.name, service.id);
      for (const alias of service.aliases) {
        registerAlias(alias, service.id);
      }
    }
    const containsLookupPhrase = (haystack: string, phrase: string): boolean => {
      if (!haystack || !phrase) return false;
      if (!phrase.includes(" ") && phrase.length < 4) return false;
      return ` ${haystack} `.includes(` ${phrase} `);
    };
    const mapCandidateToServiceId = (
      value: string,
    ): { resolvedId?: string; ambiguousIds?: string[] } => {
      const normalized = this.normalizeServiceLookupKey(value);
      if (!normalized) return {};
      const directId = idLookup.get(normalized);
      if (directId) return { resolvedId: directId };
      const aliasMatches = aliasToIds.get(normalized);
      if (aliasMatches && aliasMatches.size === 1) {
        return { resolvedId: Array.from(aliasMatches)[0] };
      }
      if (aliasMatches && aliasMatches.size > 1) {
        return {
          ambiguousIds: Array.from(aliasMatches).sort(
            (a, b) =>
              (serviceOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (serviceOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
          ),
        };
      }
      const idFromName = this.normalizeServiceId(normalized);
      if (!idFromName) return {};
      if (validServiceIds.has(idFromName)) return { resolvedId: idFromName };
      const candidates = Array.from(validServiceIds)
        .filter((id) => id === idFromName || id.startsWith(`${idFromName}-`))
        .sort(
          (a, b) => (serviceOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (serviceOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
        );
      if (candidates.length === 1) return { resolvedId: candidates[0] };
      if (candidates.length > 1) return { ambiguousIds: candidates };
      return {};
    };
    const inferServiceIdsFromEpicText = (epic: AgentEpicNode): string[] => {
      const text = this.normalizeServiceLookupKey(
        [epic.title, epic.description ?? "", ...(epic.acceptanceCriteria ?? [])]
          .filter(Boolean)
          .join("\n"),
      );
      if (!text) return [];
      const scored = new Map<string, number>();
      for (const service of catalog.services) {
        let score = 0;
        const idToken = this.normalizeServiceLookupKey(service.id);
        if (idToken && containsLookupPhrase(text, idToken)) {
          score = Math.max(score, 120 + idToken.length);
        }
        const nameToken = this.normalizeServiceLookupKey(service.name);
        if (nameToken && containsLookupPhrase(text, nameToken)) {
          score = Math.max(score, 90 + nameToken.length);
        }
        for (const alias of service.aliases) {
          const aliasToken = this.normalizeServiceLookupKey(alias);
          if (!aliasToken || aliasToken === idToken || aliasToken === nameToken) continue;
          if (containsLookupPhrase(text, aliasToken)) {
            score = Math.max(score, 60 + aliasToken.length);
          }
        }
        if (score > 0) scored.set(service.id, score);
      }
      return Array.from(scored.entries())
        .sort((a, b) => b[1] - a[1] || (serviceOrder.get(a[0]) ?? 0) - (serviceOrder.get(b[0]) ?? 0))
        .map(([id]) => id)
        .slice(0, 4);
    };
    const pickFallbackServiceIds = (epic: AgentEpicNode, count: number): string[] => {
      const text = this.normalizeServiceLookupKey(
        [epic.title, epic.description ?? "", ...(epic.acceptanceCriteria ?? [])]
          .filter(Boolean)
          .join("\n"),
      );
      const ranked = catalog.services
        .map((service) => {
          let score = 0;
          if (service.isFoundational) score += 100;
          if (typeof service.startupWave === "number") score += Math.max(0, 40 - service.startupWave * 2);
          if (service.dependsOnServiceIds.length === 0) score += 20;
          const tokens = uniqueStrings([service.id, service.name, ...service.aliases])
            .map((value) => this.normalizeServiceLookupKey(value))
            .filter(Boolean);
          for (const token of tokens) {
            if (containsLookupPhrase(text, token)) {
              score += 25 + token.length;
            }
          }
          return { id: service.id, score };
        })
        .sort(
          (a, b) =>
            b.score - a.score ||
            (serviceOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (serviceOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
      return ranked.slice(0, Math.max(1, count)).map((entry) => entry.id);
    };

    const normalizedEpics = epics.map((epic, index) => {
      const explicitServiceIds = normalizeStringArray(epic.serviceIds);
      const resolvedServiceIds: string[] = [];
      const unresolvedServiceIds: string[] = [];
      const ambiguousServiceIds: Array<{ candidate: string; options: string[] }> = [];
      for (const candidate of explicitServiceIds) {
        const mapped = mapCandidateToServiceId(candidate);
        if (mapped.resolvedId) {
          resolvedServiceIds.push(mapped.resolvedId);
        } else if ((mapped.ambiguousIds?.length ?? 0) > 1) {
          ambiguousServiceIds.push({ candidate, options: mapped.ambiguousIds ?? [] });
          unresolvedServiceIds.push(candidate);
        } else {
          unresolvedServiceIds.push(candidate);
        }
      }
      const inferredServiceIds = inferServiceIdsFromEpicText(epic);
      const targetServiceCount = Math.max(1, Math.min(3, explicitServiceIds.length || 1));
      if (policy === "auto-remediate") {
        for (const inferred of inferredServiceIds) {
          if (resolvedServiceIds.includes(inferred)) continue;
          resolvedServiceIds.push(inferred);
          if (resolvedServiceIds.length >= targetServiceCount) break;
        }
        if (resolvedServiceIds.length === 0 && catalog.services.length > 0) {
          resolvedServiceIds.push(...pickFallbackServiceIds(epic, 1));
        }
      } else if (resolvedServiceIds.length === 0 && inferredServiceIds.length > 0) {
        resolvedServiceIds.push(...inferredServiceIds.slice(0, Math.max(1, targetServiceCount)));
      }
      const dedupedServiceIds = uniqueStrings(resolvedServiceIds)
        .filter((serviceId) => validServiceIds.has(serviceId))
        .sort((a, b) => (serviceOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (serviceOrder.get(b) ?? Number.MAX_SAFE_INTEGER));
      if (dedupedServiceIds.length === 0) {
        throw new Error(
          `Epic ${epic.localId ?? index + 1} (${epic.title}) has no valid phase-0 service references. Allowed service ids: ${Array.from(validServiceIds).join(", ")}`,
        );
      }
      if (unresolvedServiceIds.length > 0 || ambiguousServiceIds.length > 0) {
        const unresolvedLabel = unresolvedServiceIds.length > 0 ? unresolvedServiceIds.join(", ") : "(none)";
        const issueLabel = unresolvedServiceIds.length > 0 ? "unknown service ids" : "ambiguous service ids";
        const ambiguity =
          ambiguousServiceIds.length > 0
            ? ` Ambiguous mappings: ${ambiguousServiceIds
                .map((item) => `${item.candidate} -> [${item.options.join(", ")}]`)
                .join("; ")}.`
            : "";
        const message = `Epic ${epic.localId ?? index + 1} (${epic.title}) referenced ${issueLabel}: ${unresolvedLabel}.${ambiguity}`;
        if (policy === "fail") {
          throw new Error(`${message} Allowed service ids: ${Array.from(validServiceIds).join(", ")}`);
        }
        warnings.push(`${message} Auto-remediated to: ${dedupedServiceIds.join(", ")}`);
      }
      const tags = normalizeEpicTags(epic.tags);
      if (dedupedServiceIds.length > 1 && !tags.includes(CROSS_SERVICE_TAG)) {
        tags.push(CROSS_SERVICE_TAG);
      }
      if (dedupedServiceIds.length <= 1 && tags.includes(CROSS_SERVICE_TAG)) {
        warnings.push(
          `Epic ${epic.localId ?? index + 1} (${epic.title}) has tag ${CROSS_SERVICE_TAG} but only one service id (${dedupedServiceIds.join(", ")}). Keeping tag as explicit cross-cutting marker.`,
        );
      }
      return {
        ...epic,
        serviceIds: dedupedServiceIds,
        tags: uniqueStrings(tags),
      };
    });
    return { epics: normalizedEpics, warnings };
  }

  private buildProjectConstructionMethod(docs: DocdexDocument[], graph: ServiceDependencyGraph): string {
    const toLabel = (value: string): string => value.replace(/\s+/g, "-");
    const structureTargets = this.collectArchitectureSourceModel(docs).structureTargets;
    const sourceDocPaths = new Set(
      docs
        .map((doc) => (doc.path ? path.relative(this.workspace.workspaceRoot, doc.path).replace(/\\/g, "/") : undefined))
        .filter((value): value is string => Boolean(value)),
    );
    const sourceDocDirectories = new Set(
      Array.from(sourceDocPaths)
        .map((docPath) => path.posix.dirname(docPath))
        .filter((dir) => dir && dir !== "."),
    );
    const buildDirectories = structureTargets.directories.filter((dir) => !sourceDocDirectories.has(dir));
    const buildFiles = structureTargets.files.filter((file) => !sourceDocPaths.has(file));
    const topDirectories = (buildDirectories.length > 0 ? buildDirectories : structureTargets.directories).slice(0, 10);
    const topFiles = (buildFiles.length > 0 ? buildFiles : structureTargets.files).slice(0, 10);
    const startupWaveLines = graph.startupWaves
      .slice(0, 8)
      .map((wave) => `- Wave ${wave.wave}: ${wave.services.map(toLabel).join(", ")}`);
    const serviceOrderLine =
      graph.services.length > 0
        ? graph.services
            .slice(0, 16)
            .map(toLabel)
            .join(" -> ")
        : "infer from SDS service dependencies and startup waves";
    const dependencyPairs: string[] = [];
    for (const [dependent, needs] of graph.dependencies.entries()) {
      for (const dependency of needs) {
        dependencyPairs.push(`${toLabel(dependent)} after ${toLabel(dependency)}`);
      }
    }
    return [
      "Project construction method (strict):",
      "1) Build repository structure from SDS folder tree first.",
      ...topDirectories.map((dir) => `   - create dir: ${dir}`),
      ...topFiles.map((file) => `   - create file: ${file}`),
      "2) Build foundational dependencies and low-wave services before consumers.",
      ...(graph.foundationalDependencies.length > 0
        ? graph.foundationalDependencies.map((dependency) => `   - foundation: ${dependency}`)
        : ["   - foundation: infer runtime prerequisites from SDS deployment sections"]),
      ...(startupWaveLines.length > 0
        ? startupWaveLines
        : ["   - startup waves: infer from documented dependency constraints"]),
      "3) Implement services by dependency direction and startup wave.",
      `   - service order: ${serviceOrderLine}`,
      ...(dependencyPairs.length > 0
        ? dependencyPairs.slice(0, 14).map((pair) => `   - dependency: ${pair}`)
        : ["   - dependency: infer explicit \"depends on\" relations from SDS"]),
      "4) Only then sequence user-facing features, QA hardening, and release chores.",
      "5) Keep task dependencies story-scoped while preserving epic/story/task ordering by this build method.",
    ].join("\n");
  }

  private buildProjectPlanArtifact(
    projectKey: string,
    docs: DocdexDocument[],
    graph: ServiceDependencyGraph,
    buildMethod: string,
  ): ProjectBuildPlanArtifact {
    const sourceDocs = docs
      .map((doc) => doc.path ?? (doc.id ? `docdex:${doc.id}` : doc.title ?? "doc"))
      .filter((value): value is string => Boolean(value))
      .filter((value, index, items) => items.indexOf(value) === index)
      .slice(0, 24);
    return {
      projectKey,
      generatedAt: new Date().toISOString(),
      sourceDocs,
      startupWaves: graph.startupWaves.slice(0, 12),
      services: graph.services.slice(0, 40),
      serviceIds: graph.services.map((service) => this.normalizeServiceId(service) ?? service.replace(/\s+/g, "-")).slice(0, 40),
      foundationalDependencies: graph.foundationalDependencies.slice(0, 16),
      buildMethod,
    };
  }

  private scoreServiceUnitForText(
    unit: SdsServiceBuildUnit,
    text: string,
    graph: ServiceDependencyGraph,
  ): number {
    const normalizedText = this.normalizeServiceLookupKey(text);
    if (!normalizedText) return 0;
    const tokens = normalizedText
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    if (tokens.length === 0) return 0;
    const unitCorpus = this.normalizeServiceLookupKey(
      [
        unit.serviceName,
        ...unit.aliases,
        ...unit.directories,
        ...unit.files,
        ...unit.headings,
        ...unit.dependsOnServiceIds,
      ].join("\n"),
    );
    const overlap = tokens.filter((token) => unitCorpus.includes(token)).length;
    let score = overlap * 10;
    const direct = this.resolveServiceMentionFromPhrase(text, graph.aliases);
    if (direct && unit.serviceName === direct) score += 100;
    if (normalizedText.includes(this.normalizeServiceLookupKey(unit.serviceName))) score += 25;
    if (unit.isFoundational) score += 4;
    return score;
  }

  private buildSdsServiceUnits(
    docs: DocdexDocument[],
    catalog: ServiceCatalogArtifact,
    graph: ServiceDependencyGraph,
  ): SdsServiceBuildUnit[] {
    const architecture = this.buildCanonicalArchitectureArtifact(docs, catalog, graph);
    return architecture.units
      .filter((unit) => unit.kind === "service")
      .map((unit) => ({
        serviceId: unit.sourceServiceIds[0] ?? unit.unitId,
        serviceName: unit.name,
        aliases: [unit.name],
        startupWave: unit.startupWave,
        dependsOnServiceIds: [...unit.dependsOnUnitIds],
        directories: uniqueStrings(
          [...unit.implementationTargets, ...unit.supportingTargets]
            .filter((target) => !isStructuredFilePath(path.basename(target)))
            .map((target) => this.normalizeStructurePathToken(target) ?? target),
        ),
        files: uniqueStrings(
          [...unit.implementationTargets, ...unit.supportingTargets, ...unit.verificationTargets]
            .filter((target) => isStructuredFilePath(path.basename(target)))
            .map((target) => this.normalizeStructurePathToken(target) ?? target),
        ),
        headings: [...unit.sourceHeadings],
        isFoundational: unit.isFoundational,
      }));
  }

  private createArchitectureUnitId(prefix: string, name: string, used: Set<string>): string {
    const base =
      normalizeArea(name)
        ?.replace(/_/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "") || prefix;
    const seed = `${prefix}-${base}`;
    if (!used.has(seed)) {
      used.add(seed);
      return seed;
    }
    let counter = 2;
    while (used.has(`${seed}-${counter}`)) counter += 1;
    const resolved = `${seed}-${counter}`;
    used.add(resolved);
    return resolved;
  }

  private deriveCrossCuttingDomainName(value: string): string | undefined {
    const normalized = this.normalizeServiceLookupKey(value);
    if (!normalized || this.isArchitectureMetaHeading(value)) return undefined;
    const patterns: Array<[RegExp, string]> = [
      [/\b(observability|telemetry|monitoring|logging|alerting|slo|sla)\b/, "Observability Baseline"],
      [/\b(identity|wallet identity|identity model)\b/, "Identity Model"],
      [/\b(iam|access control|authorization|authz|rbac|permissions?)\b/, "IAM Model"],
      [/\b(compliance|governance|policy controls?|regulatory)\b/, "Compliance Rules"],
      [/\b(ownership|owner rules?|accountability)\b/, "Ownership Rules"],
      [/\b(builder anonymity|anonymous builder|privacy controls?|anonymity)\b/, "Builder Anonymity Controls"],
      [/\b(compute model|runtime model|execution model|compute)\b/, "Compute Model"],
      [/\b(non functional|nfr|availability|latency|throughput|reliability|performance)\b/, "Non-Functional Requirements"],
      [/\b(risk|risks|mitigation|mitigations|failure mode)\b/, "Risks and Mitigations"],
      [/\b(delivery|dependency sequencing|architectural dependency order|deployment order|rollout)\b/, "Delivery and Dependency Sequencing"],
      [/\b(product design review|pdr)\b/, "Product Design Review"],
    ];
    for (const [pattern, label] of patterns) {
      if (pattern.test(normalized)) return label;
    }
    return undefined;
  }

  private isSystemWideCrossCuttingDomain(name: string): boolean {
    const normalized = this.normalizeServiceLookupKey(name);
    return /\b(observability|identity|iam|compliance|ownership|builder anonymity|anonymity|compute|non functional|risk|delivery|dependency sequencing)\b/.test(
      normalized,
    );
  }

  private toBuildTargetUnit(unit: Pick<ArchitectureUnit, "unitId" | "name" | "sourceHeadings" | "implementationTargets" | "supportingTargets" | "verificationTargets" | "dependsOnUnitIds" | "isFoundational" | "startupWave">): SdsServiceBuildUnit {
    const allTargets = uniqueStrings([
      ...unit.implementationTargets,
      ...unit.supportingTargets,
      ...unit.verificationTargets,
    ]);
    return {
      serviceId: unit.unitId,
      serviceName: unit.name,
      aliases: [unit.name],
      startupWave: unit.startupWave,
      dependsOnServiceIds: [...unit.dependsOnUnitIds],
      directories: allTargets.filter((target) => !isStructuredFilePath(path.basename(target))),
      files: allTargets.filter((target) => isStructuredFilePath(path.basename(target))),
      headings: [...unit.sourceHeadings],
      isFoundational: unit.isFoundational,
    };
  }

  private selectArchitectureTargets(
    unit: ArchitectureUnit,
    focusTexts: string[],
    purpose: BuildTargetPurpose,
    limit: number,
  ): string[] {
    return this.selectBuildTargets(this.toBuildTargetUnit(unit), focusTexts, purpose, limit);
  }

  private inferFallbackImplementationTargets(
    unit: ArchitectureUnit,
    preferredRoots: string[],
    verificationHints: string[],
  ): string[] {
    const normalizedHints = uniqueStrings(
      verificationHints
        .map((target) => this.normalizeStructurePathToken(target))
        .filter((value): value is string => Boolean(value)),
    );
    const runtimeLikeHints = normalizedHints.filter((target) => {
      const kind = this.classifyBuildTarget(target).kind;
      return kind === "runtime" || kind === "interface" || kind === "data" || kind === "ops";
    });
    if (runtimeLikeHints.length > 0) {
      return runtimeLikeHints.slice(0, 4);
    }

    const slugs = uniqueStrings(
      [unit.sourceServiceIds[0], ...unit.sourceServiceIds, unit.name]
        .map((value) => (typeof value === "string" ? value : ""))
        .map((value) => normalizeArea(value)?.replace(/^-+|-+$/g, "") ?? this.normalizeServiceLookupKey(value).replace(/\s+/g, "-"))
        .map((value) => value.replace(/^-+|-+$/g, ""))
        .filter(Boolean),
    );
    const semanticCorpus = this.normalizeServiceLookupKey([unit.name, ...unit.sourceServiceIds, ...unit.sourceHeadings].join("\n"));
    const wantsInterface = /\b(contract|interface|schema|policy|protocol|type|types)\b/.test(semanticCorpus);
    const wantsData = /\b(cache|data|database|db|ledger|migration|model|persistence|repository|storage)\b/.test(semanticCorpus);
    const wantsOps = /\b(automation|deploy|deployment|ops|operation|orchestration|provision|recovery|release|replay|rollback|runbook)\b/.test(
      semanticCorpus,
    );
    const wantsUi = /\b(client|console|dashboard|frontend|page|portal|screen|ui|web)\b/.test(semanticCorpus);
    const wantsApi = /\b(api|endpoint|gateway|handler|route|server)\b/.test(semanticCorpus);
    const wantsWorker = /\b(consumer|daemon|job|pipeline|processor|queue|scheduler|worker)\b/.test(semanticCorpus);
    const normalizedRoots = uniqueStrings(
      preferredRoots
        .map((value) => this.normalizeStructurePathToken(value) ?? normalizeFolderEntry(value)?.toLowerCase() ?? value.toLowerCase())
        .filter(Boolean),
    );
    const rankedRoots = normalizedRoots
      .map((root) => {
        const classification = this.classifyBuildTarget(root);
        const leaf = classification.segments[classification.segments.length - 1] ?? root;
        let score = 0;
        if (classification.kind === "runtime") score += 45;
        else if (classification.kind === "interface" || classification.kind === "data" || classification.kind === "ops") score += 35;
        else if (classification.kind === "unknown") score += 20;
        if (wantsInterface && classification.kind === "interface") score += 65;
        if (wantsData && classification.kind === "data") score += 65;
        if (wantsOps && classification.kind === "ops") score += 65;
        if (wantsUi && UI_ROOT_SEGMENTS.has(leaf)) score += 60;
        if (wantsApi && API_ROOT_SEGMENTS.has(leaf)) score += 60;
        if (wantsWorker && WORKER_ROOT_SEGMENTS.has(leaf)) score += 60;
        if (!wantsInterface && !wantsData && !wantsOps && !wantsUi && !wantsApi && !wantsWorker) {
          if (classification.kind === "runtime" && API_ROOT_SEGMENTS.has(leaf)) score += 20;
          if (classification.kind === "runtime" && WORKER_ROOT_SEGMENTS.has(leaf)) score += 20;
        }
        if (classification.kind === "doc") score -= 90;
        if (classification.kind === "manifest" && !classification.isServiceArtifact) score -= 60;
        if (classification.isFile) score -= 25;
        if (GENERIC_CONTAINER_SEGMENTS.has(leaf)) score += 18;
        if (slugs.some((slug) => classification.segments.includes(slug))) score += 55;
        score += Math.min(classification.segments.length, 4) * 4;
        return { root, classification, leaf, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.root.localeCompare(right.root));
    const results: string[] = [];
    const primarySlug = slugs[0];
    const scoreFloor = rankedRoots[0] ? rankedRoots[0].score - 18 : Number.NEGATIVE_INFINITY;
    for (const entry of rankedRoots) {
      if (entry.score < scoreFloor) continue;
      const hasSlug = slugs.some((slug) => entry.classification.segments.includes(slug));
      const shouldAppendSlug =
        Boolean(primarySlug) &&
        !hasSlug &&
        !entry.classification.isFile &&
        (GENERIC_CONTAINER_SEGMENTS.has(entry.leaf) || entry.classification.segments.length === 1 || entry.classification.kind === "unknown");
      const candidate = shouldAppendSlug ? `${entry.root.replace(/\/+$/g, "")}/${primarySlug}` : entry.root;
      const normalizedCandidate = this.normalizeStructurePathToken(candidate) ?? candidate;
      const classification = this.classifyBuildTarget(normalizedCandidate);
      if (classification.kind === "doc") continue;
      if (classification.kind === "manifest" && !classification.isServiceArtifact) continue;
      if (!results.includes(normalizedCandidate)) {
        results.push(normalizedCandidate);
      }
      if (results.length >= 3) break;
    }
    if (results.length > 0) return results;
    return primarySlug ? [primarySlug] : [];
  }

  private buildCanonicalArchitectureArtifact(
    docs: DocdexDocument[],
    catalog: ServiceCatalogArtifact,
    graph: ServiceDependencyGraph,
  ): CanonicalArchitectureArtifact {
    const sourceModel = this.collectArchitectureSourceModel(docs);
    const sourceDocs = uniqueStrings(catalog.sourceDocs);
    const architectureHeadings = this.extractSdsSectionCandidates(sourceModel.authorityDocs, 96);
    const structureTargets = sourceModel.structureTargets;
    const preferredRoots = uniqueStrings([
      ...Array.from(sourceModel.trustedRoots),
      ...structureTargets.directories
        .map((target) => this.extractArchitectureRoot(target))
        .filter((value): value is string => Boolean(value)),
      ...structureTargets.files
        .map((target) => this.extractArchitectureRoot(target))
        .filter((value): value is string => Boolean(value)),
    ]);
    const runtimeComponents = this.extractRuntimeComponentNames(sourceModel.authorityDocs);
    const verificationSuites = this.extractVerificationSuites(sourceModel.authorityDocs);
    const acceptanceScenarios = this.extractAcceptanceScenarios(sourceModel.authorityDocs);
    const usedUnitIds = new Set<string>();
    const serviceUnits = catalog.services.map((service) => ({
      unitId: this.createArchitectureUnitId("svc", service.id, usedUnitIds),
      kind: "service" as const,
      name: service.name,
      summary: [
        `Build the ${service.name} architecture slice from the SDS.`,
        typeof service.startupWave === "number" ? `Startup wave ${service.startupWave}.` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      sourceHeadings: [] as string[],
      implementationTargets: [] as string[],
      supportingTargets: [] as string[],
      verificationTargets: [] as string[],
      verificationSurfaceIds: [] as string[],
      dependsOnUnitIds: [] as string[],
      startupWave: service.startupWave,
      isFoundational: service.isFoundational,
      sourceServiceIds: [service.id],
      completionSignals: [] as string[],
    }));
    const serviceUnitByServiceId = new Map(serviceUnits.map((unit) => [unit.sourceServiceIds[0]!, unit]));

    const classifyAndAttachTarget = (unit: ArchitectureUnit, rawTarget: string): void => {
      const target = this.normalizeStructurePathToken(rawTarget) ?? rawTarget.replace(/\\/g, "/").trim();
      if (!target) return;
      const classification = this.classifyBuildTarget(target);
      if (classification.kind === "doc") {
        return;
      }
      if (classification.kind === "manifest") {
        if (classification.isServiceArtifact) unit.supportingTargets.push(target);
        return;
      }
      if (classification.kind === "test") {
        unit.verificationTargets.push(target);
        return;
      }
      unit.implementationTargets.push(target);
    };

    const rankServiceUnitsForText = (
      text: string,
      options?: { pathLike?: boolean },
    ): Array<{ unit: ArchitectureUnit; score: number }> => {
      const directName = this.resolveServiceMentionFromPhrase(text, graph.aliases);
      const pathName = options?.pathLike ? this.deriveServiceFromPathToken(text) : undefined;
      const rows = serviceUnits.map((unit) => {
        const asServiceUnit = this.toBuildTargetUnit(unit);
        let score = this.scoreServiceUnitForText(asServiceUnit, text, graph);
        if (directName && unit.name === directName) score += 150;
        if (pathName && unit.name === pathName) score += 150;
        return { unit, score };
      });
      return rows.sort((left, right) => right.score - left.score || left.unit.name.localeCompare(right.unit.name));
    };

    const unmatchedHeadings: string[] = [];
    const unmatchedTargets: string[] = [];
    const seenHeadingSignals = new Set<string>();

    const tryAssignHeading = (value: string): void => {
      const heading = normalizeHeadingCandidate(value);
      if (!heading || seenHeadingSignals.has(heading)) return;
      if (this.isArchitectureMetaHeading(heading)) return;
      seenHeadingSignals.add(heading);
      const ranked = rankServiceUnitsForText(heading);
      if ((ranked[0]?.score ?? 0) >= ARCHITECTURE_SERVICE_MATCH_SCORE) {
        ranked[0]!.unit.sourceHeadings.push(heading);
        ranked[0]!.unit.completionSignals.push(`heading:${heading}`);
        return;
      }
      if ((ranked[0]?.score ?? 0) >= ARCHITECTURE_SERVICE_HINT_SCORE) {
        ranked[0]!.unit.sourceHeadings.push(heading);
        ranked[0]!.unit.completionSignals.push(`heading:${heading}`);
        return;
      }
      unmatchedHeadings.push(heading);
    };

    for (const directory of structureTargets.directories) {
      const ranked = rankServiceUnitsForText(directory, { pathLike: true });
      if ((ranked[0]?.score ?? 0) >= ARCHITECTURE_SERVICE_MATCH_SCORE) {
        classifyAndAttachTarget(ranked[0]!.unit, directory);
        ranked[0]!.unit.completionSignals.push(`target:${directory}`);
      } else {
        unmatchedTargets.push(directory);
      }
    }
    for (const file of structureTargets.files) {
      const ranked = rankServiceUnitsForText(file, { pathLike: true });
      if ((ranked[0]?.score ?? 0) >= ARCHITECTURE_SERVICE_MATCH_SCORE) {
        classifyAndAttachTarget(ranked[0]!.unit, file);
        ranked[0]!.unit.completionSignals.push(`target:${file}`);
      } else {
        unmatchedTargets.push(file);
      }
    }
    for (const heading of architectureHeadings) tryAssignHeading(heading);
    for (const component of runtimeComponents) tryAssignHeading(component);

    type CrossCuttingSeed = {
      name: string;
      headings: Set<string>;
      implementationTargets: Set<string>;
      supportingTargets: Set<string>;
      verificationTargets: Set<string>;
      relatedServiceIds: Set<string>;
      completionSignals: Set<string>;
      isFoundational: boolean;
    };

    const crossSeeds = new Map<string, CrossCuttingSeed>();
    const ensureCrossSeed = (domainName: string): CrossCuttingSeed => {
      const key = this.normalizeServiceLookupKey(domainName) || domainName.toLowerCase();
      const existing = crossSeeds.get(key);
      if (existing) return existing;
      const created: CrossCuttingSeed = {
        name: domainName,
        headings: new Set<string>(),
        implementationTargets: new Set<string>(),
        supportingTargets: new Set<string>(),
        verificationTargets: new Set<string>(),
        relatedServiceIds: new Set<string>(),
        completionSignals: new Set<string>(),
        isFoundational: this.isSystemWideCrossCuttingDomain(domainName),
      };
      crossSeeds.set(key, created);
      return created;
    };
    const attachRelatedServices = (seed: CrossCuttingSeed, sourceText: string): void => {
      const ranked = rankServiceUnitsForText(sourceText);
      for (const match of ranked.filter((entry) => entry.score >= ARCHITECTURE_SERVICE_HINT_SCORE).slice(0, 3)) {
        const serviceId = match.unit.sourceServiceIds[0];
        if (serviceId) seed.relatedServiceIds.add(serviceId);
      }
      if (seed.relatedServiceIds.size === 0 && seed.isFoundational) {
        for (const unit of serviceUnits) {
          const serviceId = unit.sourceServiceIds[0];
          if (serviceId) seed.relatedServiceIds.add(serviceId);
        }
      }
    };
    const mergeSeedIntoServiceUnit = (seed: CrossCuttingSeed, serviceId: string): void => {
      const unit = serviceUnitByServiceId.get(serviceId);
      if (!unit) return;
      unit.sourceHeadings.push(...Array.from(seed.headings));
      unit.implementationTargets.push(...Array.from(seed.implementationTargets));
      unit.supportingTargets.push(...Array.from(seed.supportingTargets));
      unit.verificationTargets.push(...Array.from(seed.verificationTargets));
      unit.completionSignals.push(...Array.from(seed.completionSignals));
    };

    for (const heading of unmatchedHeadings) {
      const domainName = this.deriveCrossCuttingDomainName(heading);
      if (!domainName) continue;
      const seed = ensureCrossSeed(domainName);
      seed.headings.add(heading);
      seed.completionSignals.add(`heading:${heading}`);
      attachRelatedServices(seed, heading);
    }
    for (const target of unmatchedTargets) {
      const domainName = this.deriveCrossCuttingDomainName(target);
      if (!domainName) continue;
      const seed = ensureCrossSeed(domainName);
      const classification = this.classifyBuildTarget(target);
      const normalizedTarget = this.normalizeStructurePathToken(target) ?? target;
      if (classification.kind === "doc") continue;
      if (classification.kind === "manifest") {
        if (classification.isServiceArtifact) seed.supportingTargets.add(normalizedTarget);
        else continue;
      } else if (classification.kind === "test") seed.verificationTargets.add(normalizedTarget);
      else if (this.isImplementationBearingArchitectureTarget(normalizedTarget)) seed.implementationTargets.add(normalizedTarget);
      else continue;
      seed.completionSignals.add(`target:${normalizedTarget}`);
      attachRelatedServices(seed, target);
    }

    const crossUnits = Array.from(crossSeeds.values()).flatMap((seed) => {
      if (!seed.isFoundational && seed.relatedServiceIds.size === 1) {
        const serviceId = Array.from(seed.relatedServiceIds)[0];
        if (serviceId) mergeSeedIntoServiceUnit(seed, serviceId);
        return [];
      }
      const relatedServiceTargets = uniqueStrings(
        Array.from(seed.relatedServiceIds)
          .flatMap((serviceId) => serviceUnitByServiceId.get(serviceId))
          .flatMap((unit) => (unit ? [...unit.implementationTargets, ...unit.supportingTargets] : []))
          .filter((target) => this.isStrongImplementationTarget(target)),
      );
      const implementationTargets = uniqueStrings([
        ...Array.from(seed.implementationTargets),
        ...(seed.implementationTargets.size === 0 ? relatedServiceTargets.slice(0, 4) : []),
      ]);
      const supportingTargets = uniqueStrings(Array.from(seed.supportingTargets));
      const verificationTargets = uniqueStrings([
        ...Array.from(seed.verificationTargets),
        ...(seed.verificationTargets.size === 0 ? relatedServiceTargets.filter((target) => this.classifyBuildTarget(target).kind === "test").slice(0, 2) : []),
      ]);
      const sourceServiceIds = uniqueStrings(Array.from(seed.relatedServiceIds));
      if (
        sourceServiceIds.length === 0 &&
        implementationTargets.length === 0 &&
        verificationTargets.length === 0 &&
        supportingTargets.length === 0
      ) {
        return [];
      }
      return [{
        unitId: this.createArchitectureUnitId("cross", seed.name, usedUnitIds),
        kind: "cross_cutting" as const,
        name: seed.name,
        summary: `Implement the ${seed.name} architecture domain across the SDS-defined software stack.`,
        sourceHeadings: Array.from(seed.headings),
        implementationTargets,
        supportingTargets,
        verificationTargets,
        verificationSurfaceIds: [] as string[],
        dependsOnUnitIds: [] as string[],
        startupWave: undefined,
        isFoundational: seed.isFoundational,
        sourceServiceIds,
        completionSignals: uniqueStrings(Array.from(seed.completionSignals)),
      }];
    });

    for (const service of catalog.services) {
      const unit = serviceUnitByServiceId.get(service.id);
      if (!unit) continue;
      unit.sourceHeadings = uniqueStrings(unit.sourceHeadings);
      unit.implementationTargets = uniqueStrings(unit.implementationTargets);
      unit.supportingTargets = uniqueStrings(unit.supportingTargets);
      unit.verificationTargets = uniqueStrings(unit.verificationTargets);
      unit.dependsOnUnitIds = uniqueStrings(
        service.dependsOnServiceIds
          .map((dependencyId) => serviceUnitByServiceId.get(dependencyId)?.unitId)
          .filter((value): value is string => Boolean(value)),
      );
    }

    const allBaseUnits = [...serviceUnits, ...crossUnits];
    const unitById = new Map(allBaseUnits.map((unit) => [unit.unitId, unit]));
    const rankAllUnitsForText = (text: string): ArchitectureUnit[] => {
      const normalizedText = this.normalizeServiceLookupKey(text);
      return [...allBaseUnits]
        .map((unit) => {
          const corpus = this.normalizeServiceLookupKey(
            [
              unit.name,
              ...unit.sourceHeadings,
              ...unit.implementationTargets,
              ...unit.supportingTargets,
              ...unit.verificationTargets,
            ].join("\n"),
          );
          const overlap = normalizedText
            .split(" ")
            .map((token) => token.trim())
            .filter((token) => token.length >= 3 && corpus.includes(token)).length;
          let score = overlap * 8;
          if (normalizedText.includes(this.normalizeServiceLookupKey(unit.name))) score += 40;
          return { unit, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.unit.name.localeCompare(right.unit.name))
        .map((entry) => entry.unit);
    };

    const verificationSurfaces: ArchitectureVerificationSurface[] = [];
    const addVerificationSurface = (surface: Omit<ArchitectureVerificationSurface, "surfaceId">): void => {
      const surfaceId = this.createArchitectureUnitId(surface.kind, surface.name, usedUnitIds);
      verificationSurfaces.push({ surfaceId, ...surface });
      for (const unitId of surface.relatedUnitIds) {
        unitById.get(unitId)?.verificationSurfaceIds.push(surfaceId);
      }
    };

    for (const suite of verificationSuites) {
      const relatedUnits = rankAllUnitsForText([suite.name, suite.scope, suite.sourceCoverage].filter(Boolean).join("\n"))
        .slice(0, 3);
      addVerificationSurface({
        kind: "suite",
        name: suite.name,
        summary: [suite.scope, suite.sourceCoverage].filter(Boolean).join(" | ") || suite.name,
        sourceCoverage: suite.sourceCoverage,
        targetHints: uniqueStrings(
          relatedUnits.flatMap((unit) =>
            this.selectArchitectureTargets(unit, [suite.name, suite.scope ?? "", suite.sourceCoverage ?? ""], "verification", 3),
          ),
        ),
        relatedUnitIds: relatedUnits.map((unit) => unit.unitId),
      });
    }
    for (const scenario of acceptanceScenarios) {
      const relatedUnits = rankAllUnitsForText(`${scenario.title}\n${scenario.details}`).slice(0, 3);
      addVerificationSurface({
        kind: "scenario",
        name: `Scenario ${scenario.index}: ${scenario.title}`,
        summary: scenario.details,
        targetHints: uniqueStrings(
          relatedUnits.flatMap((unit) =>
            this.selectArchitectureTargets(unit, [scenario.title, scenario.details], "verification", 3),
          ),
        ),
        relatedUnitIds: relatedUnits.map((unit) => unit.unitId),
      });
    }

    for (const unit of serviceUnits) {
      const strongTargets = uniqueStrings(
        [...unit.implementationTargets, ...unit.supportingTargets].filter((target) => this.isStrongImplementationTarget(target)),
      );
      if (strongTargets.length > 0) continue;
      const relatedVerificationHints = verificationSurfaces
        .filter((surface) => surface.relatedUnitIds.includes(unit.unitId))
        .flatMap((surface) => surface.targetHints);
      const fallbackTargets = this.inferFallbackImplementationTargets(unit, preferredRoots, relatedVerificationHints);
      if (fallbackTargets.length === 0) continue;
      unit.implementationTargets.push(...fallbackTargets);
      unit.completionSignals.push(...fallbackTargets.map((target) => `fallback-target:${target}`));
      unit.implementationTargets = uniqueStrings(unit.implementationTargets);
      unit.completionSignals = uniqueStrings(unit.completionSignals);
    }

    const crossServiceSurfaceIds = verificationSurfaces
      .filter((surface) => surface.relatedUnitIds.length === 0 || surface.relatedUnitIds.length > 1)
      .map((surface) => surface.surfaceId);
    const units: ArchitectureUnit[] = [...allBaseUnits];
    if (crossServiceSurfaceIds.length > 0) {
      units.push({
        unitId: this.createArchitectureUnitId("gate", "release-readiness", usedUnitIds),
        kind: "release_gate",
        name: "Release Readiness",
        summary: "Execute cross-service verification gates required by the SDS release criteria.",
        sourceHeadings: ["Release Readiness"],
        implementationTargets: [],
        supportingTargets: [],
        verificationTargets: uniqueStrings(
          verificationSurfaces
            .filter((surface) => crossServiceSurfaceIds.includes(surface.surfaceId))
            .flatMap((surface) => surface.targetHints),
        ),
        verificationSurfaceIds: crossServiceSurfaceIds,
        dependsOnUnitIds: serviceUnits.map((unit) => unit.unitId),
        startupWave: undefined,
        isFoundational: false,
        sourceServiceIds: uniqueStrings(serviceUnits.flatMap((unit) => unit.sourceServiceIds)),
        completionSignals: crossServiceSurfaceIds.map((surfaceId) => `verification:${surfaceId}`),
      });
    }

    for (const unit of units.filter((entry) => entry.kind === "cross_cutting")) {
      unit.dependsOnUnitIds = uniqueStrings(
        unit.sourceServiceIds
          .map((serviceId) => serviceUnitByServiceId.get(serviceId)?.unitId)
          .filter((value): value is string => Boolean(value)),
      );
    }

    const dependencyMap = new Map(units.map((unit) => [unit.unitId, new Set(unit.dependsOnUnitIds)] as const));
    const unitWaveRank = new Map(
      units
        .filter((unit) => typeof unit.startupWave === "number")
        .map((unit) => [unit.unitId, unit.startupWave ?? Number.MAX_SAFE_INTEGER] as const),
    );
    const dependencyOrder = this.sortServicesByDependency(
      units.map((unit) => unit.unitId),
      dependencyMap,
      unitWaveRank,
    );
    const architectureRoots = uniqueStrings(
      units.flatMap((unit) =>
        [...unit.implementationTargets, ...unit.supportingTargets, ...unit.verificationTargets]
          .map((target) => this.extractArchitectureRoot(target))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const startupWaves = Array.from(
      units.reduce((accumulator, unit) => {
        if (typeof unit.startupWave !== "number") return accumulator;
        const current = accumulator.get(unit.startupWave) ?? [];
        current.push(unit.unitId);
        accumulator.set(unit.startupWave, current);
        return accumulator;
      }, new Map<number, string[]>()),
    )
      .sort((left, right) => left[0] - right[0])
      .map(([wave, unitIds]) => ({ wave, units: unitIds.sort((left, right) => left.localeCompare(right)) }));

    return {
      projectKey: catalog.projectKey,
      generatedAt: new Date().toISOString(),
      sourceDocs,
      architectureRoots,
      services: catalog.services.map((service) => service.name),
      crossCuttingDomains: crossUnits.map((unit) => unit.name),
      verificationSurfaces: verificationSurfaces.map((surface) => ({
        ...surface,
        targetHints: uniqueStrings(surface.targetHints),
        relatedUnitIds: uniqueStrings(surface.relatedUnitIds),
      })),
      units: units.map((unit) => ({
        ...unit,
        sourceHeadings: uniqueStrings(unit.sourceHeadings),
        implementationTargets: uniqueStrings(unit.implementationTargets),
        supportingTargets: uniqueStrings(unit.supportingTargets),
        verificationTargets: uniqueStrings(unit.verificationTargets),
        verificationSurfaceIds: uniqueStrings(unit.verificationSurfaceIds),
        dependsOnUnitIds: uniqueStrings(unit.dependsOnUnitIds),
        sourceServiceIds: uniqueStrings(unit.sourceServiceIds),
        completionSignals: uniqueStrings(unit.completionSignals),
      })),
      dependencyOrder,
      startupWaves,
    };
  }

  private buildImplementationTargetGroups(unit: ArchitectureUnit): string[][] {
    const rankedTargets = uniqueStrings(unit.implementationTargets).sort((left, right) => {
      const strongLeft = this.isStrongImplementationTarget(left);
      const strongRight = this.isStrongImplementationTarget(right);
      if (strongLeft !== strongRight) return strongLeft ? -1 : 1;
      const rootLeft = this.extractArchitectureRoot(left) ?? left;
      const rootRight = this.extractArchitectureRoot(right) ?? right;
      if (rootLeft !== rootRight) return rootLeft.localeCompare(rootRight);
      const depthLeft = left.split("/").length;
      const depthRight = right.split("/").length;
      if (depthLeft !== depthRight) return depthLeft - depthRight;
      return left.localeCompare(right);
    });
    if (rankedTargets.length === 0) return [];
    const targetLimit = unit.kind === "cross_cutting" ? 4 : 5;
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    let currentRoot: string | undefined;
    const flush = () => {
      if (currentGroup.length === 0) return;
      groups.push(currentGroup);
      currentGroup = [];
      currentRoot = undefined;
    };
    for (const target of rankedTargets) {
      const targetRoot = this.extractArchitectureRoot(target) ?? target;
      const shouldRotate =
        currentGroup.length >= targetLimit ||
        (currentGroup.length >= 2 && currentRoot && currentRoot !== targetRoot);
      if (shouldRotate) flush();
      currentGroup.push(target);
      currentRoot = currentRoot ?? targetRoot;
    }
    flush();
    return groups;
  }

  private summarizeImplementationGroup(unit: ArchitectureUnit, targets: string[], index: number): string {
    const toTitle = (value: string): string =>
      value
        .split(/\s+/)
        .map((token) => (token ? token[0]!.toUpperCase() + token.slice(1) : token))
        .join(" ");
    const fileNames = targets
      .filter((target) => isStructuredFilePath(path.basename(target)))
      .map((target) => path.basename(target).replace(/\.[^.]+$/, ""))
      .filter(Boolean);
    if (fileNames.length > 0) {
      return fileNames.slice(0, 2).join(" + ");
    }
    const roots = uniqueStrings(
      targets
        .map((target) => this.extractArchitectureRoot(target) ?? target)
        .filter((value): value is string => Boolean(value)),
    );
    if (roots.length > 0) {
      const rootLabel = roots[0]!.split("/").filter(Boolean).slice(-1)[0] ?? roots[0]!;
      return `${toTitle(rootLabel)} surfaces`;
    }
    return `${toTitle(unit.name)} slice ${index + 1}`;
  }

  private buildVerificationTaskBundles(
    unit: ArchitectureUnit,
    surfaces: ArchitectureVerificationSurface[],
  ): Array<{
    title: string;
    description: string;
    files: string[];
    unitTests: string[];
    integrationTests: string[];
    apiTests: string[];
  }> {
    const preview = (items: string[], fallback: string): string =>
      items.length > 0 ? items.slice(0, 8).map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
    const prioritizedSurfaces = [...surfaces].sort((left, right) => {
      const rank = (surface: ArchitectureVerificationSurface): number => {
        if (surface.kind === "suite") return 0;
        if (surface.kind === "scenario") return 1;
        return 2;
      };
      const rankDelta = rank(left) - rank(right);
      if (rankDelta !== 0) return rankDelta;
      return left.name.localeCompare(right.name);
    });
    const selectedNames = uniqueStrings(prioritizedSurfaces.map((surface) => surface.name)).slice(
      0,
      unit.kind === "release_gate" ? 8 : 4,
    );
    const selectedTargets = uniqueStrings([
      ...unit.verificationTargets,
      ...prioritizedSurfaces.flatMap((surface) => surface.targetHints),
    ]).slice(0, unit.kind === "release_gate" ? 12 : 6);
    if (selectedNames.length === 0 && selectedTargets.length === 0) return [];

    const unitTests = selectedNames.filter((value) => /\b(unit|invariant|contract)\b/i.test(value));
    const integrationTests = selectedNames.filter((value) =>
      /\b(integration|acceptance|end-to-end|end to end|operations drills|scenario)\b/i.test(value),
    );
    const apiTests = selectedNames.filter((value) => /\b(api|rpc|gateway|provider)\b/i.test(value));
    const title =
      unit.kind === "release_gate" ? "Execute release readiness bundle" : `Validate ${unit.name} readiness`;
    const description = [
      unit.kind === "release_gate"
        ? `Execute the minimum cross-service release verification for ${unit.name}.`
        : `Run the minimum deterministic verification needed to prove ${unit.name}.`,
      "Verification surfaces:",
      preview(selectedNames, `Validate the implemented ${unit.name} surfaces.`),
      "Primary verification targets:",
      preview(selectedTargets, `Validate the implemented ${unit.name} surfaces.`),
    ].join("\n");
    return [
      {
        title,
        description,
        files: selectedTargets,
        unitTests:
          unitTests.length > 0
            ? unitTests.map((value) => `Execute ${value} for ${unit.name}.`)
            : selectedTargets.length > 0
              ? [`Validate ${unit.name} internal behavior through ${selectedTargets[0]}.`]
              : [],
        integrationTests: integrationTests.map((value) =>
          unit.kind === "release_gate"
            ? `Execute ${value} and capture deterministic release evidence.`
            : `Execute ${value} for ${unit.name}.`,
        ),
        apiTests: apiTests.map((value) => `Execute ${value} against the ${unit.name} API/provider surface.`),
      },
    ];
  }

  private buildArchitectureDrivenPlan(
    projectKey: string,
    docs: DocdexDocument[],
    architecture: CanonicalArchitectureArtifact,
  ): GeneratedPlan {
    const localIds = new Set<string>();
    const epics: PlanEpic[] = [];
    const stories: PlanStory[] = [];
    const tasks: PlanTask[] = [];
    const unitById = new Map(architecture.units.map((unit) => [unit.unitId, unit]));
    const docLinks = this.buildPlanningDocLinks(docs);
    const orderedUnits = architecture.dependencyOrder
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is ArchitectureUnit => Boolean(unit));
    const rootPreview = (items: string[], fallback: string): string =>
      items.length > 0 ? items.slice(0, 8).map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
    const chunk = (items: string[], size: number): string[][] => {
      const chunks: string[][] = [];
      for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
      }
      return chunks;
    };
    const toDisplayName = (value: string): string =>
      value
        .split(/\s+/)
        .map((token) => (token ? token[0]!.toUpperCase() + token.slice(1) : token))
        .join(" ");

    const createTask = (params: {
      localIdSeed: string;
      storyLocalId: string;
      epicLocalId: string;
      title: string;
      type: string;
      description: string;
      files: string[];
      priorityHint: number;
      estimatedStoryPoints: number;
      dependsOnKeys?: string[];
      unitTests?: string[];
      componentTests?: string[];
      integrationTests?: string[];
      apiTests?: string[];
    }): PlanTask => ({
      localId: nextUniqueLocalId(params.localIdSeed, localIds),
      storyLocalId: params.storyLocalId,
      epicLocalId: params.epicLocalId,
      title: params.title,
      type: params.type,
      description: params.description,
      files: uniqueStrings(params.files),
      estimatedStoryPoints: params.estimatedStoryPoints,
      priorityHint: params.priorityHint,
      dependsOnKeys: params.dependsOnKeys ?? [],
      relatedDocs: docLinks,
      unitTests: uniqueStrings(params.unitTests ?? []),
      componentTests: uniqueStrings(params.componentTests ?? []),
      integrationTests: uniqueStrings(params.integrationTests ?? []),
      apiTests: uniqueStrings(params.apiTests ?? []),
    });
    const latestImplementationTaskByUnitId = new Map<string, string>();

    for (const unit of orderedUnits) {
      const epicLocalId = nextUniqueLocalId(`${unit.kind}-${normalizeArea(unit.name) ?? "unit"}`, localIds);
      const epicTitle =
        unit.kind === "service"
          ? `Build ${toDisplayName(unit.name)}`
          : unit.kind === "cross_cutting"
            ? `Establish ${toDisplayName(unit.name)}`
            : "Verify Release Readiness";
      epics.push({
        localId: epicLocalId,
        area: normalizeArea(projectKey) ?? "core",
        title: epicTitle,
        description: [
          unit.summary,
          typeof unit.startupWave === "number" ? `Startup wave: ${unit.startupWave}.` : undefined,
          unit.dependsOnUnitIds.length > 0
            ? `Dependencies: ${unit.dependsOnUnitIds
                .map((dependencyId) => unitById.get(dependencyId)?.name ?? dependencyId)
                .join(", ")}.`
            : undefined,
          unit.sourceHeadings.length > 0 ? `SDS sections: ${unit.sourceHeadings.slice(0, 6).join("; ")}.` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        acceptanceCriteria: [
          `${unit.name} is represented with explicit buildable work.`,
          `${unit.name} stays aligned with SDS dependency and architecture ordering.`,
          `${unit.name} includes supporting validation where the SDS requires it.`,
        ],
        relatedDocs: docLinks,
        priorityHint: epics.length + 1,
        serviceIds: uniqueStrings(unit.sourceServiceIds),
        tags: unit.kind === "cross_cutting" || unit.sourceServiceIds.length > 1 ? [CROSS_SERVICE_TAG] : [],
        stories: [],
      });

      if (unit.kind !== "release_gate") {
        const structureTargets = uniqueStrings(
          [...unit.implementationTargets, ...unit.supportingTargets]
            .filter((target) => !this.isDocsTaskForQuality({ title: "", description: target, type: "feature" } as any)),
        );
        const structureFiles = structureTargets.filter((target) => isStructuredFilePath(path.basename(target)));
        const structureDirs = structureTargets.filter((target) => !isStructuredFilePath(path.basename(target)));
        const unitDependencyTasks = uniqueStrings(
          unit.dependsOnUnitIds
            .map((dependencyId) => latestImplementationTaskByUnitId.get(dependencyId))
            .filter((value): value is string => Boolean(value)),
        );
        const structureTaskIds: string[] = [];
        if (structureTargets.length > 0) {
          const storyLocalId = nextUniqueLocalId(`${unit.unitId}-structure`, localIds);
          stories.push({
            localId: storyLocalId,
            epicLocalId,
            title: `Establish ${toDisplayName(unit.name)} structure`,
            userStory: `As an engineer, I need the ${unit.name} structure in place so implementation lands on real surfaces.`,
            description: `Create or update the concrete repository structure required for ${unit.name}.`,
            acceptanceCriteria: [
              `${unit.name} has the required runtime or support surfaces in the repo.`,
              `Follow-up work references real ${unit.name} paths instead of generic roots.`,
            ],
            relatedDocs: docLinks,
            priorityHint: 1,
            tasks: [],
          });
          if (structureDirs.length > 0) {
            const scaffoldTask = createTask({
              localIdSeed: `${unit.unitId}-structure-task`,
              storyLocalId,
              epicLocalId,
              title: `Create ${unit.name} directory scaffold`,
              type: "chore",
              description: [
                `Create the SDS-backed directory scaffold for ${unit.name}.`,
                "Target directories:",
                rootPreview(structureDirs, `Create the concrete directories required for ${unit.name}.`),
              ].join("\n"),
              files: structureDirs,
              priorityHint: 1,
              estimatedStoryPoints: 2,
              dependsOnKeys: unitDependencyTasks,
            });
            tasks.push(scaffoldTask);
            structureTaskIds.push(scaffoldTask.localId);
          }
          if (structureFiles.length > 0) {
            const foundationalTask = createTask({
              localIdSeed: `${unit.unitId}-structure-task`,
              storyLocalId,
              epicLocalId,
              title: `Create ${unit.name} foundational entrypoints`,
              type: "feature",
              description: [
                `Create the first concrete runtime, interface, or support entrypoints for ${unit.name}.`,
                "Target files:",
                rootPreview(structureFiles, `Create the initial ${unit.name} implementation files.`),
              ].join("\n"),
              files: structureFiles,
              priorityHint: 2,
              estimatedStoryPoints: 3,
              dependsOnKeys: uniqueStrings([...unitDependencyTasks, ...structureTaskIds]),
            });
            tasks.push(foundationalTask);
            structureTaskIds.push(foundationalTask.localId);
          }
        }

        const storyLocalId = nextUniqueLocalId(`${unit.unitId}-implementation`, localIds);
        stories.push({
          localId: storyLocalId,
          epicLocalId,
          title: `Implement ${toDisplayName(unit.name)} capabilities`,
          userStory: `As a delivery team, we need ${unit.name} implemented from the SDS-defined architecture.`,
          description: [
            `Implement the ${unit.name} capability slices from the canonical architecture model.`,
            unit.sourceHeadings.length > 0 ? `Primary SDS sections: ${unit.sourceHeadings.slice(0, 6).join("; ")}.` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          acceptanceCriteria: [
            `${unit.name} has explicit implementation tasks with concrete surfaces.`,
            `${unit.name} implementation stays aligned to source-backed SDS sections.`,
          ],
          relatedDocs: docLinks,
          priorityHint: 2,
          tasks: [],
        });
        const implementationTargetGroups = this.buildImplementationTargetGroups(unit);
        const headingGroups =
          unit.sourceHeadings.length > 0
            ? chunk(
                unit.sourceHeadings,
                Math.max(1, Math.ceil(unit.sourceHeadings.length / Math.max(implementationTargetGroups.length, 1))),
              )
            : [];
        let priorImplementationDependencies = uniqueStrings([...unitDependencyTasks, ...structureTaskIds]);
        const groupsToPlan = implementationTargetGroups.length > 0 ? implementationTargetGroups : [[]];
        groupsToPlan.forEach((targetSlice, index) => {
          const headingSlice = headingGroups[index] ?? [];
          const groupLabel =
            headingSlice[0] ?? this.summarizeImplementationGroup(unit, targetSlice, index);
          const verificationSlice = this.selectArchitectureTargets(
            unit,
            [...headingSlice, groupLabel, ...targetSlice],
            "verification",
            3,
          );
          const implementationTask = createTask({
            localIdSeed: `${unit.unitId}-implementation-task`,
            storyLocalId,
            epicLocalId,
            title: `Implement ${groupLabel}`,
            type: "feature",
            description: [
              headingSlice.length > 0
                ? `Implement the ${unit.name} scope required by these SDS sections: ${headingSlice.join("; ")}.`
                : `Implement the next concrete ${unit.name} architecture slice.`,
              "Primary implementation targets:",
              rootPreview(targetSlice, `Extend the concrete ${unit.name} implementation surfaces.`),
              unit.dependsOnUnitIds.length > 0
                ? `Keep dependency direction aligned to: ${unit.dependsOnUnitIds
                    .map((dependencyId) => unitById.get(dependencyId)?.name ?? dependencyId)
                    .join(", ")}.`
                : "Keep the implementation buildable without introducing undocumented dependencies.",
            ].join("\n"),
            files: targetSlice,
            priorityHint: index + 1,
            estimatedStoryPoints: Math.min(8, 3 + Math.max(0, targetSlice.length - 1)),
            dependsOnKeys: priorImplementationDependencies,
            unitTests:
              verificationSlice.length > 0
                ? [`Cover ${unit.name} behavior through ${verificationSlice[0]}.`]
                : targetSlice.length > 0
                  ? [`Cover ${unit.name} behavior through ${targetSlice[0]}.`]
                  : [],
          });
          tasks.push(implementationTask);
          priorImplementationDependencies = [implementationTask.localId];
          latestImplementationTaskByUnitId.set(unit.unitId, implementationTask.localId);
        });

        let latestUnitWorkTaskId =
          latestImplementationTaskByUnitId.get(unit.unitId) ??
          structureTaskIds.at(-1) ??
          unitDependencyTasks.at(-1);
        if (unit.dependsOnUnitIds.length > 0) {
          const integrationStoryLocalId = nextUniqueLocalId(`${unit.unitId}-integration`, localIds);
          stories.push({
            localId: integrationStoryLocalId,
            epicLocalId,
            title: `Integrate ${toDisplayName(unit.name)} dependencies`,
            userStory: `As an engineer, I need ${unit.name} wired to its documented dependencies.`,
            description: `Implement dependency and integration behavior for ${unit.name}.`,
            acceptanceCriteria: [
              `${unit.name} uses only documented dependency directions.`,
              `${unit.name} integration behavior is covered by explicit backlog work.`,
            ],
            relatedDocs: docLinks,
            priorityHint: 3,
            tasks: [],
          });
          unit.dependsOnUnitIds.slice(0, 3).forEach((dependencyId, index) => {
            const dependencyName = unitById.get(dependencyId)?.name ?? dependencyId;
            const integrationTargets = this.selectArchitectureTargets(unit, [dependencyName], "implementation", 3);
            const integrationTask = createTask({
              localIdSeed: `${unit.unitId}-integration-task`,
              storyLocalId: integrationStoryLocalId,
              epicLocalId,
              title: `Wire ${unit.name} to ${dependencyName}`,
              type: "feature",
              description: [
                `Implement the documented dependency direction from ${unit.name} to ${dependencyName}.`,
                "Update orchestration, interfaces, configuration reads, or runtime flow where the integration lands.",
              ].join("\n"),
              files: integrationTargets,
              priorityHint: index + 1,
              estimatedStoryPoints: 2,
              dependsOnKeys: uniqueStrings(
                [latestUnitWorkTaskId, latestImplementationTaskByUnitId.get(dependencyId)].filter(
                  (value): value is string => Boolean(value),
                ),
              ),
              integrationTests: [`Validate ${unit.name} integration with ${dependencyName}.`],
            });
            tasks.push(integrationTask);
            latestUnitWorkTaskId = integrationTask.localId;
            latestImplementationTaskByUnitId.set(unit.unitId, integrationTask.localId);
          });
        }

        const unitVerificationSurfaces = architecture.verificationSurfaces.filter((surface) =>
          unit.verificationSurfaceIds.includes(surface.surfaceId),
        );
        const verificationBundles = this.buildVerificationTaskBundles(unit, unitVerificationSurfaces);
        if (verificationBundles.length > 0) {
          const verificationStoryLocalId = nextUniqueLocalId(`${unit.unitId}-verification`, localIds);
          stories.push({
            localId: verificationStoryLocalId,
            epicLocalId,
            title: `Validate ${toDisplayName(unit.name)} readiness`,
            userStory: `As a reviewer, I need supporting validation for ${unit.name}.`,
            description: `Add the smallest deterministic validation work needed to prove ${unit.name}.`,
            acceptanceCriteria: [
              `${unit.name} has supporting verification tied to implemented surfaces.`,
            ],
            relatedDocs: docLinks,
            priorityHint: 4,
            tasks: [],
          });
          verificationBundles.forEach((bundle, index) => {
            tasks.push(
              createTask({
                localIdSeed: `${unit.unitId}-verification-task`,
                storyLocalId: verificationStoryLocalId,
                epicLocalId,
                title: bundle.title,
                type: "chore",
                description: bundle.description,
                files: bundle.files,
                priorityHint: index + 1,
                estimatedStoryPoints: 2,
                dependsOnKeys: latestUnitWorkTaskId ? [latestUnitWorkTaskId] : unitDependencyTasks,
                unitTests: bundle.unitTests,
                integrationTests: bundle.integrationTests,
                apiTests: bundle.apiTests,
              }),
            );
          });
        }
      } else {
        const verificationStoryLocalId = nextUniqueLocalId(`${unit.unitId}-verification`, localIds);
        stories.push({
          localId: verificationStoryLocalId,
          epicLocalId,
          title: "Execute cross-service release gates",
          userStory: "As a release reviewer, I need the cross-service release gates executed before approval.",
          description: "Execute the cross-service verification surfaces that remain after unit-level validation is planned.",
          acceptanceCriteria: [
            "Cross-service release gates are represented as executable tasks.",
          ],
          relatedDocs: docLinks,
          priorityHint: 1,
          tasks: [],
        });
        const releaseGateBundles = this.buildVerificationTaskBundles(
          unit,
          architecture.verificationSurfaces.filter((surface) => unit.verificationSurfaceIds.includes(surface.surfaceId)),
        );
        releaseGateBundles.forEach((bundle, index) => {
          tasks.push(
            createTask({
              localIdSeed: `${unit.unitId}-verification-task`,
              storyLocalId: verificationStoryLocalId,
              epicLocalId,
              title: bundle.title,
              type: "chore",
              description: bundle.description,
              files: bundle.files,
              priorityHint: index + 1,
              estimatedStoryPoints: 3,
              dependsOnKeys: uniqueStrings(
                unit.dependsOnUnitIds
                  .map((dependencyId) => latestImplementationTaskByUnitId.get(dependencyId))
                  .filter((value): value is string => Boolean(value)),
              ),
              unitTests: bundle.unitTests,
              integrationTests: bundle.integrationTests,
              apiTests: bundle.apiTests,
            }),
          );
        });
      }
    }

    return { epics, stories, tasks };
  }

  private buildSdsDrivenPlan(
    projectKey: string,
    docs: DocdexDocument[],
    architecture: CanonicalArchitectureArtifact,
  ): GeneratedPlan {
    return this.buildArchitectureDrivenPlan(projectKey, docs, architecture);
  }

  private backlogSummaryHasExecutionActivity(summary: ProjectBacklogSummary): boolean {
    return (
      summary.nonNotStartedTaskCount > 0 ||
      summary.taskRunCount > 0 ||
      summary.taskQaRunCount > 0 ||
      summary.taskLogCount > 0
    );
  }

  private async determineCreateTasksBacklogPersistence(
    projectId: string,
    force: boolean | undefined,
  ): Promise<{
    replaceExistingBacklog: boolean;
    hasExistingBacklog: boolean;
    warning?: string;
  }> {
    if (force) {
      return {
        replaceExistingBacklog: true,
        hasExistingBacklog: true,
      };
    }
    const summary = await this.workspaceRepo.getProjectBacklogSummary(projectId);
    if (summary.taskCount === 0) {
      return {
        replaceExistingBacklog: false,
        hasExistingBacklog: false,
      };
    }
    if (!this.backlogSummaryHasExecutionActivity(summary)) {
      return {
        replaceExistingBacklog: true,
        hasExistingBacklog: true,
        warning:
          "create-tasks detected an untouched existing backlog for this project and will replace it instead of appending another generation.",
      };
    }
    return {
      replaceExistingBacklog: false,
      hasExistingBacklog: true,
      warning:
        "create-tasks detected active backlog activity for this project and preserved the existing backlog; use --force to replace it explicitly.",
    };
  }

  private hasStrongSdsPlanningEvidence(
    docs: DocdexDocument[],
    catalog: ServiceCatalogArtifact,
    expectation: SourceTopologyExpectation,
  ): boolean {
    const sourceModel = this.collectArchitectureSourceModel(docs);
    if (sourceModel.authorityDocs.length === 0 || !sourceModel.authorityDocs.some((doc) => looksLikeSdsDoc(doc))) return false;
    const coverageSignals = collectSdsCoverageSignalsFromDocs(
      sourceModel.authorityDocs.map((doc) => ({ content: doc.content })),
      { headingLimit: 200, folderLimit: 240 },
    );
    const structureTargets = sourceModel.structureTargets;
    const structureSignalCount = structureTargets.directories.length + structureTargets.files.length;
    const headingSignalCount = coverageSignals.sectionHeadings.length;
    const topologySignalCount =
      expectation.services.length +
      expectation.startupWaves.length +
      expectation.dependencyPairs.length +
      expectation.signalSummary.topologyHeadings.length +
      expectation.signalSummary.waveMentions.length;
    return (
      structureSignalCount >= 4 ||
      headingSignalCount >= 8 ||
      catalog.services.length >= 2 ||
      topologySignalCount >= 4
    );
  }

  private taskUsesOnlyWeakImplementationTargets(task: PlanTask, docs: DocdexDocument[]): boolean {
    if (!/\bimplement\b/i.test(`${task.title} ${task.description ?? ""}`)) return false;
    const inventory = this.buildCanonicalNameInventory(docs);
    if (!inventory.paths.some((candidate) => this.isStrongImplementationTarget(candidate))) return false;
    const candidateTargets = uniqueStrings(
      filterImplementationStructuredPaths(extractStructuredPaths(`${task.title}\n${task.description ?? ""}`, 64))
        .map((token) => this.normalizeStructurePathToken(token))
        .filter((value): value is string => Boolean(value)),
    );
    if (candidateTargets.length === 0) return false;
    return candidateTargets.every((target) => !this.isStrongImplementationTarget(target));
  }

  private planLooksTooWeakForSds(
    plan: GeneratedPlan,
    docs: DocdexDocument[],
    catalog: ServiceCatalogArtifact,
    expectation: SourceTopologyExpectation,
  ): boolean {
    if (!this.hasStrongSdsPlanningEvidence(docs, catalog, expectation)) return false;
    const genericTitles = plan.tasks.filter((task) =>
      /initial planning|draft backlog|review inputs|baseline project scaffolding|integrate core dependencies|validate baseline behavior/i.test(
        `${task.title} ${task.description ?? ""}`,
      ),
    ).length;
    const genericImplementationTasks = plan.tasks.filter((task) =>
      GENERIC_IMPLEMENTATION_TASK_PATTERN.test(`${task.title} ${task.description ?? ""}`),
    ).length;
    const weakImplementationTargetTasks = plan.tasks.filter((task) =>
      this.taskUsesOnlyWeakImplementationTargets(task, docs),
    ).length;
    const authorityDocs = this.collectArchitectureSourceModel(docs).authorityDocs;
    const verificationSuites = this.extractVerificationSuites(authorityDocs);
    const acceptanceScenarios = this.extractAcceptanceScenarios(authorityDocs);
    const planCorpus = this.normalizeServiceLookupKey(
      [
        ...plan.epics.map((epic) => `${epic.title}\n${epic.description ?? ""}`),
        ...plan.stories.map((story) => `${story.title}\n${story.description ?? ""}\n${story.userStory ?? ""}`),
        ...plan.tasks.map((task) => `${task.title}\n${task.description ?? ""}`),
      ].join("\n"),
    );
    const coveredVerificationSuites = verificationSuites.filter((suite) =>
      planCorpus.includes(this.normalizeServiceLookupKey(suite.name)),
    ).length;
    const coveredAcceptanceScenarios = acceptanceScenarios.filter(
      (scenario) =>
        planCorpus.includes(`scenario ${scenario.index}`) ||
        planCorpus.includes(this.normalizeServiceLookupKey(scenario.title)),
    ).length;
    const coveredServiceIds = new Set(plan.epics.flatMap((epic) => normalizeStringArray(epic.serviceIds)));
    return (
      plan.epics.length === 0 ||
      plan.stories.length === 0 ||
      plan.tasks.length === 0 ||
      genericTitles >= Math.min(2, plan.tasks.length) ||
      genericImplementationTasks > 0 ||
      weakImplementationTargetTasks > 0 ||
      (verificationSuites.length > 0 && coveredVerificationSuites === 0) ||
      (acceptanceScenarios.length > 0 && coveredAcceptanceScenarios < Math.min(3, acceptanceScenarios.length)) ||
      (genericTitles > 0 &&
        catalog.services.length > 1 &&
        coveredServiceIds.size > 0 &&
        coveredServiceIds.size < Math.min(catalog.services.length, 2))
    );
  }

  private backlogMostlyAlignedEnough(audit: TaskSufficiencyAuditResult | undefined): boolean {
    if (!audit) return true;
    return audit.satisfied;
  }

  private orderStoryTasksByDependencies(
    storyTasks: PlanTask[],
    serviceRank: Map<string, number>,
    taskServiceByScope: Map<string, string | undefined>,
  ): PlanTask[] {
    const byLocalId = new Map(storyTasks.map((task) => [task.localId, task]));
    const indegree = new Map<string, number>();
    const outgoing = new Map<string, Set<string>>();
    for (const task of storyTasks) {
      indegree.set(task.localId, 0);
    }
    for (const task of storyTasks) {
      for (const dep of task.dependsOnKeys ?? []) {
        if (!byLocalId.has(dep) || dep === task.localId) continue;
        indegree.set(task.localId, (indegree.get(task.localId) ?? 0) + 1);
        const edges = outgoing.get(dep) ?? new Set<string>();
        edges.add(task.localId);
        outgoing.set(dep, edges);
      }
    }
    const priorityComparator = (a: PlanTask, b: PlanTask): number => {
      const classA = classifyTask({ title: a.title ?? "", description: a.description, type: a.type });
      const classB = classifyTask({ title: b.title ?? "", description: b.description, type: b.type });
      if (classA.foundation !== classB.foundation) return classA.foundation ? -1 : 1;
      const rankA =
        serviceRank.get(taskServiceByScope.get(this.scopeTask(a)) ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rankB =
        serviceRank.get(taskServiceByScope.get(this.scopeTask(b)) ?? "") ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      const priorityA = a.priorityHint ?? Number.MAX_SAFE_INTEGER;
      const priorityB = b.priorityHint ?? Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.localId.localeCompare(b.localId);
    };
    const queue = storyTasks.filter((task) => (indegree.get(task.localId) ?? 0) === 0).sort(priorityComparator);
    const ordered: PlanTask[] = [];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || seen.has(next.localId)) continue;
      seen.add(next.localId);
      ordered.push(next);
      const dependents = outgoing.get(next.localId);
      if (!dependents) continue;
      for (const dependent of dependents) {
        const updated = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, updated);
        if (updated === 0) {
          const depTask = byLocalId.get(dependent);
          if (depTask) queue.push(depTask);
        }
      }
      queue.sort(priorityComparator);
    }
    if (ordered.length === storyTasks.length) return ordered;
    const remaining = storyTasks.filter((task) => !seen.has(task.localId)).sort(priorityComparator);
    return [...ordered, ...remaining];
  }

  private applyServiceDependencySequencing(plan: GeneratedPlan, docs: DocdexDocument[]): GeneratedPlan {
    const graph = this.buildServiceDependencyGraph(plan, docs);
    if (!graph.services.length) return plan;
    const serviceOrderRank = new Map(graph.services.map((service, index) => [service, index]));
    const serviceRank = new Map(
      graph.services.map((service) => {
        const wave = graph.waveRank.get(service) ?? Number.MAX_SAFE_INTEGER;
        const order = serviceOrderRank.get(service) ?? Number.MAX_SAFE_INTEGER;
        return [service, wave * 10_000 + order] as const;
      }),
    );
    const resolveEntityService = (text: string): string | undefined => this.resolveServiceMentionFromPhrase(text, graph.aliases);
    const resolveServiceFromIds = (serviceIds: string[] | undefined): string | undefined => {
      for (const serviceId of normalizeStringArray(serviceIds)) {
        const resolved = resolveEntityService(serviceId) ?? this.addServiceAlias(graph.aliases, serviceId);
        if (resolved) return resolved;
      }
      return undefined;
    };
    const epics = plan.epics.map((epic) => ({ ...epic }));
    const stories = plan.stories.map((story) => ({ ...story }));
    const tasks = plan.tasks.map((task) => ({ ...task, dependsOnKeys: uniqueStrings(task.dependsOnKeys ?? []) }));
    const storyByScope = new Map(stories.map((story) => [this.scopeStory(story), story]));
    const epicServiceByLocalId = new Map<string, string | undefined>();
    const storyServiceByScope = new Map<string, string | undefined>();
    const taskServiceByScope = new Map<string, string | undefined>();

    for (const epic of epics) {
      const serviceFromIds = resolveServiceFromIds(epic.serviceIds);
      const serviceFromText = resolveEntityService(`${epic.title}\n${epic.description ?? ""}`);
      epicServiceByLocalId.set(epic.localId, serviceFromIds ?? serviceFromText);
    }

    for (const story of stories) {
      const storyScope = this.scopeStory(story);
      const inherited = epicServiceByLocalId.get(story.epicLocalId);
      const serviceFromText = resolveEntityService(`${story.title}\n${story.description ?? ""}\n${story.userStory ?? ""}`);
      storyServiceByScope.set(storyScope, serviceFromText ?? inherited);
    }

    for (const task of tasks) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const text = `${task.title ?? ""}\n${task.description ?? ""}`;
      taskServiceByScope.set(this.scopeTask(task), resolveEntityService(text) ?? storyServiceByScope.get(storyScope));
    }

    const tasksByStory = new Map<string, PlanTask[]>();
    for (const task of tasks) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const bucket = tasksByStory.get(storyScope) ?? [];
      bucket.push(task);
      tasksByStory.set(storyScope, bucket);
    }

    for (const storyTasks of tasksByStory.values()) {
      const tasksByService = new Map<string, PlanTask[]>();
      for (const task of storyTasks) {
        const service = taskServiceByScope.get(this.scopeTask(task));
        if (!service) continue;
        const serviceTasks = tasksByService.get(service) ?? [];
        serviceTasks.push(task);
        tasksByService.set(service, serviceTasks);
      }
      for (const serviceTasks of tasksByService.values()) {
        serviceTasks.sort((a, b) => (a.priorityHint ?? Number.MAX_SAFE_INTEGER) - (b.priorityHint ?? Number.MAX_SAFE_INTEGER));
      }
      for (const task of storyTasks) {
        const service = taskServiceByScope.get(this.scopeTask(task));
        if (!service) continue;
        const requiredServices = graph.dependencies.get(service);
        if (!requiredServices || requiredServices.size === 0) continue;
        for (const requiredService of requiredServices) {
          const candidate = tasksByService.get(requiredService)?.[0];
          if (!candidate || candidate.localId === task.localId) continue;
          if (!(task.dependsOnKeys ?? []).includes(candidate.localId)) {
            task.dependsOnKeys = uniqueStrings([...(task.dependsOnKeys ?? []), candidate.localId]);
          }
        }
      }
    }

    const storyRankByScope = new Map<string, number>();
    for (const story of stories) {
      const storyScope = this.scopeStory(story);
      const storyTasks = tasksByStory.get(storyScope) ?? [];
      const taskRanks = storyTasks
        .map((task) => serviceRank.get(taskServiceByScope.get(this.scopeTask(task)) ?? ""))
        .filter((value): value is number => typeof value === "number");
      const storyTextRank = serviceRank.get(storyServiceByScope.get(storyScope) ?? "");
      const rank = taskRanks.length > 0 ? Math.min(...taskRanks) : storyTextRank ?? Number.MAX_SAFE_INTEGER;
      storyRankByScope.set(storyScope, rank);
    }

    const epicRankByLocalId = new Map<string, number>();
    for (const epic of epics) {
      const epicStories = stories.filter((story) => story.epicLocalId === epic.localId);
      const storyRanks = epicStories
        .map((story) => storyRankByScope.get(this.scopeStory(story)))
        .filter((value): value is number => typeof value === "number");
      const epicTextRank = serviceRank.get(epicServiceByLocalId.get(epic.localId) ?? "");
      const rank = storyRanks.length > 0 ? Math.min(...storyRanks) : epicTextRank ?? Number.MAX_SAFE_INTEGER;
      epicRankByLocalId.set(epic.localId, rank);
    }

    const isBootstrap = (value: string): boolean => /bootstrap|foundation|structure/i.test(value);
    epics.sort((a, b) => {
      const bootstrapA = isBootstrap(`${a.title} ${a.description ?? ""}`);
      const bootstrapB = isBootstrap(`${b.title} ${b.description ?? ""}`);
      if (bootstrapA !== bootstrapB) return bootstrapA ? -1 : 1;
      const rankA = epicRankByLocalId.get(a.localId) ?? Number.MAX_SAFE_INTEGER;
      const rankB = epicRankByLocalId.get(b.localId) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      const priorityA = a.priorityHint ?? Number.MAX_SAFE_INTEGER;
      const priorityB = b.priorityHint ?? Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.localId.localeCompare(b.localId);
    });
    epics.forEach((epic, index) => {
      epic.priorityHint = index + 1;
    });

    const storiesOrdered: PlanStory[] = [];
    const tasksOrdered: PlanTask[] = [];
    for (const epic of epics) {
      const epicStories = stories
        .filter((story) => story.epicLocalId === epic.localId)
        .sort((a, b) => {
          const bootstrapA = isBootstrap(`${a.title} ${a.description ?? ""}`);
          const bootstrapB = isBootstrap(`${b.title} ${b.description ?? ""}`);
          if (bootstrapA !== bootstrapB) return bootstrapA ? -1 : 1;
          const rankA = storyRankByScope.get(this.scopeStory(a)) ?? Number.MAX_SAFE_INTEGER;
          const rankB = storyRankByScope.get(this.scopeStory(b)) ?? Number.MAX_SAFE_INTEGER;
          if (rankA !== rankB) return rankA - rankB;
          const priorityA = a.priorityHint ?? Number.MAX_SAFE_INTEGER;
          const priorityB = b.priorityHint ?? Number.MAX_SAFE_INTEGER;
          if (priorityA !== priorityB) return priorityA - priorityB;
          return a.localId.localeCompare(b.localId);
        });
      epicStories.forEach((story, index) => {
        story.priorityHint = index + 1;
        storiesOrdered.push(story);
        const storyTasks = tasksByStory.get(this.scopeStory(story)) ?? [];
        const orderedTasks = this.orderStoryTasksByDependencies(storyTasks, serviceRank, taskServiceByScope);
        orderedTasks.forEach((task, taskIndex) => {
          task.priorityHint = taskIndex + 1;
          tasksOrdered.push(task);
        });
      });
    }

    const orderedStoryScopes = new Set(storiesOrdered.map((story) => this.scopeStory(story)));
    for (const story of stories) {
      if (orderedStoryScopes.has(this.scopeStory(story))) continue;
      storiesOrdered.push(story);
    }
    const orderedTaskScopes = new Set(tasksOrdered.map((task) => this.scopeTask(task)));
    for (const task of tasks) {
      if (orderedTaskScopes.has(this.scopeTask(task))) continue;
      tasksOrdered.push(task);
    }

    // Keep parent linkage intact even if malformed story references exist.
    for (const story of storiesOrdered) {
      if (!storyByScope.has(this.scopeStory(story))) continue;
      story.epicLocalId = storyByScope.get(this.scopeStory(story))?.epicLocalId ?? story.epicLocalId;
    }

    return { epics, stories: storiesOrdered, tasks: tasksOrdered };
  }

  private shouldInjectStructureBootstrap(plan: GeneratedPlan, docs: DocdexDocument[]): boolean {
    if (docs.length === 0) return false;
    return !plan.tasks.some((task) =>
      /codebase structure|folder tree|scaffold|bootstrap|repository layout|project skeleton/i.test(
        `${task.title} ${task.description ?? ""}`,
      ),
    );
  }

  private injectStructureBootstrapPlan(
    plan: GeneratedPlan,
    docs: DocdexDocument[],
    projectKey: string,
  ): GeneratedPlan {
    if (!this.shouldInjectStructureBootstrap(plan, docs)) return plan;
    const localIds = new Set<string>([
      ...plan.epics.map((epic) => epic.localId),
      ...plan.stories.map((story) => story.localId),
      ...plan.tasks.map((task) => task.localId),
    ]);
    const epicLocalId = nextUniqueLocalId("bootstrap-epic", localIds);
    const storyLocalId = nextUniqueLocalId("bootstrap-story", localIds);
    const task1LocalId = nextUniqueLocalId("bootstrap-task", localIds);
    const task2LocalId = nextUniqueLocalId("bootstrap-task", localIds);
    const task3LocalId = nextUniqueLocalId("bootstrap-task", localIds);
    const structureTargets = this.collectArchitectureSourceModel(docs).structureTargets;
    const directoryPreview = structureTargets.directories.length
      ? structureTargets.directories.slice(0, 20).map((item) => `- ${item}`).join("\n")
      : "- Infer top-level source directories from SDS sections and create them.";
    const filePreview = structureTargets.files.length
      ? structureTargets.files.slice(0, 20).map((item) => `- ${item}`).join("\n")
      : "- Create minimal entrypoint/config placeholders required by the SDS-defined architecture.";
    const relatedDocs = this.buildPlanningDocLinks(docs);
    const bootstrapEpic: PlanEpic = {
      localId: epicLocalId,
      area: normalizeArea(projectKey) ?? "core",
      title: "Codebase Foundation and Structure Setup",
      description:
        "Create the SDS-defined codebase scaffold first (folders/files/service boundaries) before feature implementation tasks.",
      acceptanceCriteria: [
        "Required folder tree exists for the planned architecture.",
        "Minimal entrypoint/config files exist for each discovered service/module.",
        "Service dependency assumptions are explicit and actionable in follow-up tasks.",
      ],
      relatedDocs,
      priorityHint: 1,
      stories: [],
    };
    const bootstrapStory: PlanStory = {
      localId: storyLocalId,
      epicLocalId,
      title: "Bootstrap repository structure from SDS",
      userStory:
        "As an engineer, I want a concrete codebase scaffold first so implementation tasks can target real modules instead of only tests.",
      description: [
        "Parse SDS/PDR/OpenAPI context and establish the expected folder/file tree.",
        "Start with dependencies-first service ordering (foundational components before dependents).",
      ].join("\n"),
      acceptanceCriteria: [
        "Repository scaffold matches documented architecture at a high level.",
        "Core service/module placeholders are committed as executable starting points.",
        "Follow-up tasks reference real directories/files under the scaffold.",
      ],
      relatedDocs,
      priorityHint: 1,
      tasks: [],
    };
    const bootstrapTasks: PlanTask[] = [
      {
        localId: task1LocalId,
        storyLocalId,
        epicLocalId,
        title: "Create SDS-aligned folder tree",
        type: "chore",
        description: [
          "Create the initial folder tree inferred from SDS and related docs.",
          "Target directories:",
          directoryPreview,
        ].join("\n"),
        estimatedStoryPoints: 2,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs,
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
      {
        localId: task2LocalId,
        storyLocalId,
        epicLocalId,
        title: "Create foundational file stubs for discovered modules",
        type: "chore",
        description: [
          "Create minimal file stubs/config entrypoints for the scaffolded modules/services.",
          "Target files:",
          filePreview,
        ].join("\n"),
        estimatedStoryPoints: 3,
        priorityHint: 2,
        dependsOnKeys: [task1LocalId],
        relatedDocs,
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
      {
        localId: task3LocalId,
        storyLocalId,
        epicLocalId,
        title: "Define service dependency baseline for implementation sequencing",
        type: "spike",
        description:
          "Document and codify service/module dependency direction so highly depended foundational services are implemented first.",
        estimatedStoryPoints: 2,
        priorityHint: 3,
        dependsOnKeys: [task2LocalId],
        relatedDocs,
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ];
    return {
      epics: [bootstrapEpic, ...plan.epics],
      stories: [bootstrapStory, ...plan.stories],
      tasks: [...bootstrapTasks, ...plan.tasks],
    };
  }

  private enforceStoryScopedDependencies(plan: GeneratedPlan): GeneratedPlan {
    const taskMap = new Map(
      plan.tasks.map((task) => [
        this.scopeTask(task),
        {
          ...task,
          dependsOnKeys: uniqueStrings((task.dependsOnKeys ?? []).filter(Boolean)),
        },
      ]),
    );
    const tasksByStory = new Map<string, PlanTask[]>();
    for (const task of taskMap.values()) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const storyTasks = tasksByStory.get(storyScope) ?? [];
      storyTasks.push(task);
      tasksByStory.set(storyScope, storyTasks);
    }
    for (const storyTasks of tasksByStory.values()) {
      const localIds = new Set(storyTasks.map((task) => task.localId));
      const foundationTasks = storyTasks
        .filter((task) =>
          classifyTask({
            title: task.title ?? "",
            description: task.description,
            type: task.type,
          }).foundation,
        )
        .sort((a, b) => (a.priorityHint ?? Number.MAX_SAFE_INTEGER) - (b.priorityHint ?? Number.MAX_SAFE_INTEGER));
      const foundationAnchor =
        foundationTasks.find((task) => !(task.dependsOnKeys ?? []).some((dep) => localIds.has(dep)))?.localId ??
        foundationTasks[0]?.localId;
      for (const task of storyTasks) {
        const filtered = (task.dependsOnKeys ?? []).filter((dep) => dep !== task.localId && localIds.has(dep));
        const classification = classifyTask({
          title: task.title ?? "",
          description: task.description,
          type: task.type,
        });
        if (
          foundationAnchor &&
          foundationAnchor !== task.localId &&
          !classification.foundation &&
          !filtered.includes(foundationAnchor)
        ) {
          filtered.push(foundationAnchor);
        }
        task.dependsOnKeys = uniqueStrings(filtered);
      }
    }
    return {
      ...plan,
      tasks: plan.tasks.map((task) => taskMap.get(this.scopeTask(task)) ?? task),
    };
  }

  private validatePlanLocalIdentifiers(plan: GeneratedPlan): void {
    const errors: string[] = [];
    const epicIds = new Set<string>();
    for (const [epicIndex, epic] of plan.epics.entries()) {
      if (!epic.localId || !epic.localId.trim()) {
        errors.push("epic has missing localId");
        continue;
      }
      if (epicIds.has(epic.localId)) {
        errors.push(`duplicate epic localId: ${epic.localId}`);
        continue;
      }
      epicIds.add(epic.localId);
    }

    const storyScopes = new Set<string>();
    for (const story of plan.stories) {
      const scope = this.scopeStory(story);
      if (!epicIds.has(story.epicLocalId)) {
        errors.push(`story ${scope} references unknown epicLocalId ${story.epicLocalId}`);
      }
      if (storyScopes.has(scope)) {
        errors.push(`duplicate story scope: ${scope}`);
        continue;
      }
      storyScopes.add(scope);
    }

    const taskScopes = new Set<string>();
    const storyTaskLocals = new Map<string, Set<string>>();
    for (const task of plan.tasks) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const taskScope = this.scopeTask(task);
      if (!storyScopes.has(storyScope)) {
        errors.push(`task ${taskScope} references unknown story scope ${storyScope}`);
      }
      if (taskScopes.has(taskScope)) {
        errors.push(`duplicate task scope: ${taskScope}`);
        continue;
      }
      taskScopes.add(taskScope);
      const locals = storyTaskLocals.get(storyScope) ?? new Set<string>();
      locals.add(task.localId);
      storyTaskLocals.set(storyScope, locals);
    }

    for (const task of plan.tasks) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const localIds = storyTaskLocals.get(storyScope) ?? new Set<string>();
      for (const dep of task.dependsOnKeys ?? []) {
        if (!dep || dep === task.localId) continue;
        if (!localIds.has(dep)) {
          errors.push(
            `task ${this.scopeTask(task)} has dependency ${dep} that is outside story scope ${storyScope}`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Invalid generated plan local identifiers:\n- ${errors.join("\n- ")}`);
    }
  }

  private async buildQaPreflight(): Promise<QaPreflight> {
    const preflight: QaPreflight = {
      scripts: {},
      entrypoints: [],
      blockers: [],
    };
    const packagePath = path.join(this.workspace.workspaceRoot, "package.json");
    let pkg: Record<string, unknown> | null = null;
    try {
      const raw = await fs.readFile(packagePath, "utf8");
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return preflight;
    }
    const scripts = pkg?.scripts;
    if (scripts && typeof scripts === "object") {
      for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
        if (typeof value === "string") {
          preflight.scripts[name] = value;
        }
      }
    }
    const dependencies = {
      ...(pkg?.dependencies && typeof pkg.dependencies === "object" ? (pkg.dependencies as Record<string, unknown>) : {}),
      ...(pkg?.devDependencies && typeof pkg.devDependencies === "object"
        ? (pkg.devDependencies as Record<string, unknown>)
        : {}),
    };
    const hasDev = typeof preflight.scripts.dev === "string";
    const hasStart = typeof preflight.scripts.start === "string";
    const devPort = hasDev ? extractScriptPort(preflight.scripts.dev) : undefined;
    const startPort = hasStart ? extractScriptPort(preflight.scripts.start) : undefined;
    if (hasDev) {
      preflight.entrypoints.push({
        kind: "web",
        base_url: devPort ? `http://localhost:${devPort}` : undefined,
        command: inferPackageScriptCommand(pkg, "dev"),
      });
    } else if (hasStart) {
      preflight.entrypoints.push({
        kind: "web",
        base_url: startPort ? `http://localhost:${startPort}` : undefined,
        command: inferPackageScriptCommand(pkg, "start"),
      });
    }
    const testDirs = [
      path.join(this.workspace.workspaceRoot, "tests"),
      path.join(this.workspace.workspaceRoot, "__tests__"),
    ];
    const testFiles: string[] = [];
    for (const dir of testDirs) {
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) continue;
        testFiles.push(...(await collectFilesRecursively(dir)));
      } catch {
        // ignore missing test dirs
      }
    }
    const testCandidates = testFiles.filter((file) => /\b(test|spec)\b/i.test(path.basename(file)));
    const hasSupertest = typeof dependencies.supertest === "string";
    if (!hasSupertest && testCandidates.length > 0) {
      for (const file of testCandidates) {
        try {
          const content = await fs.readFile(file, "utf8");
          if (content.includes("supertest")) {
            preflight.blockers.push(
              "Missing devDependency: supertest (required by test files).",
            );
            break;
          }
        } catch {
          // ignore read errors
        }
      }
    }
    return preflight;
  }

  private buildQaOverrides(options: CreateTasksOptions): QaReadiness | undefined {
    const profiles = options.qaProfiles?.filter(Boolean);
    const requires = options.qaRequires?.filter(Boolean);
    const entrypoints: QaEntrypoint[] = [];
    if (options.qaEntryUrl || options.qaStartCommand) {
      entrypoints.push({
        kind: "web",
        base_url: options.qaEntryUrl,
        command: options.qaStartCommand,
      });
    }
    if (!profiles?.length && !requires?.length && entrypoints.length === 0) return undefined;
    return {
      profiles_expected: profiles,
      requires,
      entrypoints: entrypoints.length ? entrypoints : undefined,
    };
  }

  private isOpenApiDoc(doc: DocdexDocument): boolean {
    const type = (doc.docType ?? "").toLowerCase();
    if (type.includes("openapi") || type.includes("swagger")) return true;
    const pathTitle = `${doc.path ?? ""} ${doc.title ?? ""}`.toLowerCase();
    return API_CONTRACT_LIKE_PATH_PATTERN.test(pathTitle);
  }

  private buildOpenApiHintSummary(docs: DocdexDocument[]): string {
    const lines: string[] = [];
    for (const doc of docs) {
      if (!this.isOpenApiDoc(doc)) continue;
      const rawContent =
        doc.content && doc.content.trim().length > 0
          ? doc.content
          : (doc.segments ?? []).map((segment) => segment.content).join("\n\n");
      const parsed = parseStructuredDoc(rawContent);
      if (!parsed) continue;
      const paths = parsed.paths;
      if (!isPlainObject(paths)) continue;
      for (const [apiPath, pathItem] of Object.entries(paths)) {
        if (!isPlainObject(pathItem)) continue;
        for (const [method, operation] of Object.entries(pathItem)) {
          const normalizedMethod = method.toLowerCase();
          if (!["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(normalizedMethod)) {
            continue;
          }
          if (!isPlainObject(operation)) continue;
          const hints = (operation as Record<string, unknown>)["x-mcoda-task-hints"];
          if (!isPlainObject(hints)) continue;
          const service = typeof hints.service === "string" ? hints.service : "-";
          const capability = typeof hints.capability === "string" ? hints.capability : "-";
          const stage = typeof hints.stage === "string" ? hints.stage : "-";
          const complexity =
            typeof hints.complexity === "number" && Number.isFinite(hints.complexity)
              ? hints.complexity.toFixed(1)
              : "-";
          const dependsOn = Array.isArray(hints.depends_on_operations)
            ? hints.depends_on_operations.filter((entry): entry is string => typeof entry === "string").length
            : 0;
          const tests = isPlainObject(hints.test_requirements) ? hints.test_requirements : undefined;
          const countEntries = (value: unknown): number =>
            Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").length : 0;
          const unitCount = countEntries(tests?.unit);
          const componentCount = countEntries(tests?.component);
          const integrationCount = countEntries(tests?.integration);
          const apiCount = countEntries(tests?.api);
          lines.push(
            `- ${normalizedMethod.toUpperCase()} ${apiPath} :: service=${service}; capability=${capability}; stage=${stage}; complexity=${complexity}; deps=${dependsOn}; tests(u/c/i/a)=${unitCount}/${componentCount}/${integrationCount}/${apiCount}`,
          );
          if (lines.length >= OPENAPI_HINT_OPERATIONS_LIMIT) {
            return lines.join("\n");
          }
        }
      }
    }
    return lines.join("\n");
  }

  private extractSdsSectionCandidates(docs: DocdexDocument[], limit: number): string[] {
    const sections: string[] = [];
    for (const doc of docs) {
      if (!looksLikeSdsDoc(doc)) continue;
      const scanLimit = Math.max(limit * 4, limit + 12);
      const contentHeadings = collectSdsImplementationSignals(doc.content ?? "", {
        headingLimit: scanLimit,
        folderLimit: 0,
      }).sectionHeadings;
      const segmentHeadings = (doc.segments ?? [])
        .map((segment) => normalizeHeadingCandidate(segment.heading?.trim() ?? ""))
        .filter((heading): heading is string => Boolean(heading));
      const segmentContentHeadings = (doc.segments ?? [])
        .flatMap((segment) =>
          collectSdsImplementationSignals(segment.content ?? "", {
            headingLimit: Math.max(12, Math.ceil(scanLimit / 2)),
            folderLimit: 0,
          }).sectionHeadings,
        )
        .slice(0, scanLimit);
      for (const heading of uniqueStrings([...contentHeadings, ...segmentHeadings, ...segmentContentHeadings])) {
        const normalized = normalizeHeadingCandidate(heading);
        if (!normalized) continue;
        if (!headingLooksImplementationRelevant(normalized)) continue;
        if (/^software design specification$/i.test(normalized)) continue;
        if (/^(?:\d+(?:\.\d+)*\.?\s*)?roles$/i.test(normalized)) continue;
        if (sections.includes(normalized)) continue;
        sections.push(normalized);
        if (sections.length >= limit) break;
      }
      if (sections.length >= limit) break;
    }
    return uniqueStrings(sections).slice(0, limit);
  }

  private collectSdsSections(docs: DocdexDocument[]): Array<{ heading: string; body: string[] }> {
    const sections: Array<{ heading: string; body: string[] }> = [];
    for (const doc of docs) {
      if (!looksLikeSdsDoc(doc)) continue;
      const content = stripManagedSdsPreflightBlock(doc.content ?? "") ?? "";
      const lines = content.split(/\r?\n/);
      let currentHeading: string | undefined;
      let currentBody: string[] = [];
      let inCodeFence = false;
      const flush = () => {
        if (!currentHeading) return;
        sections.push({ heading: currentHeading, body: [...currentBody] });
      };
      for (const rawLine of lines) {
        const line = rawLine ?? "";
        const trimmed = line.trim();
        if (/^```/.test(trimmed)) {
          inCodeFence = !inCodeFence;
          currentBody.push(line);
          continue;
        }
        if (!inCodeFence) {
          const headingMatch = trimmed.match(MARKDOWN_HEADING_PATTERN);
          if (headingMatch) {
            flush();
            currentHeading = normalizeHeadingCandidate(headingMatch[2] ?? "");
            currentBody = [];
            continue;
          }
        }
        if (currentHeading) currentBody.push(line);
      }
      flush();
    }
    return sections;
  }

  private normalizeRuntimeComponentCandidate(rawValue: string): string | undefined {
    let candidate = rawValue.trim();
    if (!candidate) return undefined;
    const backtickMatch = candidate.match(/`([^`]+)`/);
    if (backtickMatch?.[1]) {
      candidate = backtickMatch[1];
    }
    const colonHead = candidate.split(/:\s+/, 2)[0]?.trim();
    if (colonHead && colonHead.split(/\s+/).length <= 5) {
      candidate = colonHead;
    }
    const dashHead = candidate.split(/\s+[—-]\s+/, 2)[0]?.trim();
    if (dashHead && dashHead.split(/\s+/).length <= 5) {
      candidate = dashHead;
    }
    candidate = candidate.replace(/\([^)]*\)/g, " ").replace(/[.;,]+$/, "").trim();
    if (!candidate) return undefined;
    const normalized = this.normalizeTextServiceName(candidate) ?? this.normalizeServiceName(candidate);
    if (!normalized) return undefined;
    if (normalized.split(" ").length > 4) return undefined;
    return normalized;
  }

  private extractRuntimeComponentNames(docs: DocdexDocument[]): string[] {
    const components = new Set<string>();
    for (const section of this.collectSdsSections(docs)) {
      if (!RUNTIME_COMPONENTS_HEADING_PATTERN.test(section.heading)) continue;
      let inCodeFence = false;
      for (const rawLine of section.body) {
        const trimmed = rawLine.trim();
        if (/^```/.test(trimmed)) {
          inCodeFence = !inCodeFence;
          continue;
        }
        if (inCodeFence) continue;
        const listMatch = trimmed.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
        if (!listMatch?.[1]) continue;
        const candidate = this.normalizeRuntimeComponentCandidate(listMatch[1]);
        if (candidate) components.add(candidate);
      }
    }
    return Array.from(components);
  }

  private extractVerificationSuites(docs: DocdexDocument[]): SdsVerificationSuite[] {
    const suites: SdsVerificationSuite[] = [];
    const seen = new Set<string>();
    for (const section of this.collectSdsSections(docs)) {
      if (!VERIFICATION_MATRIX_HEADING_PATTERN.test(section.heading)) continue;
      for (const rawLine of section.body) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith("|")) continue;
        if (/^\|\s*-+\s*\|/i.test(trimmed)) continue;
        const cells = trimmed
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean);
        if (cells.length < 2) continue;
        if (/verification suite/i.test(cells[0] ?? "")) continue;
        const name = normalizeHeadingCandidate(cells[0] ?? "");
        if (!name) continue;
        const key = this.normalizeServiceLookupKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        suites.push({
          name,
          scope: cells[1] || undefined,
          sourceCoverage: cells[2] || undefined,
        });
      }
    }
    return suites;
  }

  private extractAcceptanceScenarios(docs: DocdexDocument[]): SdsAcceptanceScenario[] {
    const scenarios: SdsAcceptanceScenario[] = [];
    const seen = new Set<number>();
    for (const section of this.collectSdsSections(docs)) {
      if (!ACCEPTANCE_SCENARIOS_HEADING_PATTERN.test(section.heading)) continue;
      for (const rawLine of section.body) {
        const trimmed = rawLine.trim();
        const match = trimmed.match(/^(\d+)\.\s+(.+)$/);
        if (!match?.[1] || !match[2]) continue;
        const index = Number.parseInt(match[1], 10);
        if (!Number.isFinite(index) || seen.has(index)) continue;
        const details = match[2].trim();
        const title = normalizeHeadingCandidate(details.split(/:\s+/, 2)[0] ?? details) || `Scenario ${index}`;
        scenarios.push({ index, title, details });
        seen.add(index);
      }
    }
    return scenarios.sort((left, right) => left.index - right.index);
  }

  private classifyBuildTarget(target: string): BuildTargetClassification {
    const normalized = this.normalizeStructurePathToken(target) ?? target.replace(/\\/g, "/").trim();
    const segments = normalized
      .toLowerCase()
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const basename = segments[segments.length - 1] ?? normalized.toLowerCase();
    const isFile = isStructuredFilePath(basename);
    const isServiceArtifact = isServiceArtifactBasename(basename);
    if (segments.some((segment) => BUILD_TARGET_DOC_SEGMENTS.has(segment))) {
      return { normalized, basename, segments, isFile, kind: "doc", isServiceArtifact };
    }
    if (isManifestLikeBasename(basename, segments) || isServiceArtifact) {
      return { normalized, basename, segments, isFile, kind: "manifest", isServiceArtifact };
    }
    if (segments.some((segment) => BUILD_TARGET_TEST_SEGMENTS.has(segment))) {
      return { normalized, basename, segments, isFile, kind: "test", isServiceArtifact };
    }
    if (segments.some((segment) => BUILD_TARGET_OPS_SEGMENTS.has(segment))) {
      return { normalized, basename, segments, isFile, kind: "ops", isServiceArtifact };
    }
    if (segments.some((segment) => BUILD_TARGET_INTERFACE_SEGMENTS.has(segment))) {
      return { normalized, basename, segments, isFile, kind: "interface", isServiceArtifact };
    }
    if (segments.some((segment) => BUILD_TARGET_DATA_SEGMENTS.has(segment))) {
      return { normalized, basename, segments, isFile, kind: "data", isServiceArtifact };
    }
    if (segments.some((segment) => BUILD_TARGET_RUNTIME_SEGMENTS.has(segment))) {
      return { normalized, basename, segments, isFile, kind: "runtime", isServiceArtifact };
    }
    return { normalized, basename, segments, isFile, kind: "unknown", isServiceArtifact };
  }

  private isStrongImplementationTarget(target: string): boolean {
    const classification = this.classifyBuildTarget(target);
    return (
      classification.kind === "runtime" ||
      classification.kind === "interface" ||
      classification.kind === "data" ||
      classification.kind === "test" ||
      classification.kind === "ops"
    );
  }

  private deriveBuildFocusProfile(texts: string[]): {
    wantsOps: boolean;
    wantsVerification: boolean;
    wantsData: boolean;
    wantsInterface: boolean;
  } {
    const corpus = this.normalizeServiceLookupKey(texts.join("\n"));
    return {
      wantsOps:
        /\b(deploy|deployment|startup|release|rollback|recovery|rotation|drill|runbook|failover|proxy|operations?|runtime)\b/.test(
          corpus,
        ),
      wantsVerification:
        /\b(verify|verification|acceptance|scenario|quality|suite|test|tests|matrix|gate|drill)\b/.test(corpus),
      wantsData: /\b(data|storage|cache|ledger|pipeline|db|database|persistence)\b/.test(corpus),
      wantsInterface: /\b(contract|policy|provider|gateway|rpc|api|interface|schema|oracle|protocol)\b/.test(corpus),
    };
  }

  private selectBuildTargets(
    unit: SdsServiceBuildUnit,
    focusTexts: string[],
    purpose: BuildTargetPurpose,
    limit: number,
  ): string[] {
    const candidates = uniqueStrings([...unit.files, ...unit.directories])
      .map((candidate) => this.normalizeStructurePathToken(candidate) ?? candidate.replace(/\\/g, "/").trim())
      .filter(Boolean);
    if (candidates.length === 0) return [];
    const focusCorpus = this.normalizeServiceLookupKey(
      [unit.serviceName, ...unit.aliases, ...focusTexts].filter(Boolean).join("\n"),
    );
    const focusTokens = focusCorpus
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    const focusProfile = this.deriveBuildFocusProfile(focusTexts);
    const scored = candidates
      .map((target) => {
        const classification = this.classifyBuildTarget(target);
        const normalizedTarget = this.normalizeServiceLookupKey(target.replace(/\//g, " "));
        const overlap = focusTokens.filter((token) => normalizedTarget.includes(token)).length;
        let score = overlap * 25 + (classification.isFile ? 12 : 0);
        if (purpose === "structure") {
          if (classification.kind === "runtime" || classification.kind === "interface") score += 90;
          else if (classification.kind === "data") score += 75;
          else if (classification.kind === "ops") score += 30;
          else if (classification.kind === "manifest") score += 10;
          else if (classification.kind === "doc") score -= 80;
        } else if (purpose === "implementation") {
          if (classification.kind === "runtime") score += classification.isFile ? 170 : 140;
          else if (classification.kind === "interface") score += classification.isFile ? 160 : 135;
          else if (classification.kind === "data") score += classification.isFile ? 150 : 125;
          else if (classification.kind === "test") score += 70;
          else if (classification.kind === "ops") score += focusProfile.wantsOps ? 140 : 25;
          else if (classification.kind === "manifest") score -= 140;
          else if (classification.kind === "doc") score -= 180;
        } else {
          if (classification.kind === "test") score += 170;
          else if (classification.kind === "runtime") score += 120;
          else if (classification.kind === "interface") score += 105;
          else if (classification.kind === "data") score += 95;
          else if (classification.kind === "ops") score += focusProfile.wantsOps ? 160 : 90;
          else if (classification.kind === "manifest") score -= 120;
          else if (classification.kind === "doc") score -= 180;
        }
        if (focusProfile.wantsOps && classification.kind === "ops") score += 60;
        if (focusProfile.wantsVerification && classification.kind === "test") score += 60;
        if (focusProfile.wantsData && classification.kind === "data") score += 55;
        if (focusProfile.wantsInterface && classification.kind === "interface") score += 55;
        if (focusProfile.wantsInterface && classification.kind === "runtime") score += 20;
        return { target, classification, score };
      })
      .sort((left, right) => right.score - left.score || left.target.length - right.target.length || left.target.localeCompare(right.target));
    const strongExists = scored.some(
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
      if (!strongExists) return true;
      if (purpose === "structure") return entry.classification.kind !== "doc";
      if (entry.classification.kind === "manifest") return false;
      return entry.classification.kind !== "doc";
    });
    const ranked = (filtered.length > 0 ? filtered : scored.filter((entry) => entry.score > 0)).map((entry) => entry.target);
    return uniqueStrings(ranked).slice(0, Math.max(1, limit));
  }

  private buildVerificationSuiteTaskDraft(
    suite: SdsVerificationSuite,
    serviceName: string,
  ): Pick<PlanTask, "unitTests" | "componentTests" | "integrationTests" | "apiTests" | "description"> {
    const normalized = this.normalizeServiceLookupKey([suite.name, suite.scope, suite.sourceCoverage].filter(Boolean).join(" "));
    const unitTests: string[] = [];
    const componentTests: string[] = [];
    const integrationTests: string[] = [];
    const apiTests: string[] = [];
    if (/\bunit\b/.test(normalized)) {
      unitTests.push(`Execute the named suite "${suite.name}" for ${serviceName}.`);
    }
    if (/\b(component|ui|render|client)\b/.test(normalized)) {
      componentTests.push(`Execute the named suite "${suite.name}" against the ${serviceName} surface.`);
    }
    if (/\b(integration|acceptance|end to end|end-to-end|drill|replay|failover)\b/.test(normalized)) {
      integrationTests.push(`Execute the named suite "${suite.name}" end to end for ${serviceName}.`);
    }
    if (/\b(api|gateway|rpc|provider)\b/.test(normalized)) {
      apiTests.push(`Execute the named suite "${suite.name}" against the ${serviceName} API/provider surface.`);
    }
    if (
      unitTests.length === 0 &&
      componentTests.length === 0 &&
      integrationTests.length === 0 &&
      apiTests.length === 0
    ) {
      integrationTests.push(`Execute the named suite "${suite.name}" and capture deterministic evidence.`);
    }
    return {
      description: [
        `Implement and wire the named verification suite "${suite.name}" for ${serviceName}.`,
        suite.scope ? `Scope: ${suite.scope}` : undefined,
        suite.sourceCoverage ? `Source coverage: ${suite.sourceCoverage}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      unitTests,
      componentTests,
      integrationTests,
      apiTests,
    };
  }

  private buildSdsCoverageHints(docs: DocdexDocument[]): string {
    const hints = this.extractSdsSectionCandidates(
      this.collectArchitectureSourceModel(docs).authorityDocs,
      SDS_COVERAGE_HINT_HEADING_LIMIT,
    );
    if (hints.length === 0) return "";
    return hints.map((hint) => `- ${hint}`).join("\n");
  }

  private buildDocContext(docs: DocdexDocument[]): { docSummary: string; warnings: string[] } {
    const warnings: string[] = [];
    const blocks: string[] = [];
    let budget = DOC_CONTEXT_BUDGET;
    const sorted = [...docs].sort((a, b) => {
      const sdsDelta = Number(looksLikeSdsDoc(b)) - Number(looksLikeSdsDoc(a));
      if (sdsDelta !== 0) return sdsDelta;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    });
    for (const [idx, doc] of sorted.entries()) {
      const segments = doc.segments ?? [];
      const sampledSegments = pickDistributedIndices(segments.length, DOC_CONTEXT_SEGMENTS_PER_DOC)
        .map((index) => segments[index]!)
        .filter(Boolean);
      const content = sampledSegments.length
        ? sampledSegments
            .map((seg, i) => {
              const trimmed = seg.content.length > 600 ? `${seg.content.slice(0, 600)}...` : seg.content;
              return `  - (${i + 1}) ${seg.heading ? `${seg.heading}: ` : ""}${trimmed}`;
            })
            .join("\n")
        : sampleRawContent(doc.content, DOC_CONTEXT_FALLBACK_CHUNK_LENGTH)
            .map((chunk, i) => `  - (${i + 1}) ${chunk.length > 600 ? `${chunk.slice(0, 600)}...` : chunk}`)
            .join("\n");
      const entry = [`[${doc.docType}] docdex:${doc.id ?? `doc-${idx + 1}`}`, describeDoc(doc, idx), content]
        .filter(Boolean)
        .join("\n");
      const cost = estimateTokens(entry);
      if (budget - cost < 0) {
        warnings.push(`Context truncated due to token budget; skipped doc ${doc.id ?? doc.path ?? idx + 1}.`);
        continue;
      }
      budget -= cost;
      blocks.push(entry);
      if (budget <= 0) break;
    }
    const openApiHints = this.buildOpenApiHintSummary(sorted);
    if (openApiHints) {
      const hintBlock = ["[OPENAPI_HINTS]", openApiHints].join("\n");
      const hintCost = estimateTokens(hintBlock);
      if (budget - hintCost >= 0) {
        budget -= hintCost;
        blocks.push(hintBlock);
      } else {
        warnings.push("Context truncated due to token budget; skipped OpenAPI hint summary.");
      }
    }
    const sdsCoverageHints = this.buildSdsCoverageHints(sorted);
    if (sdsCoverageHints) {
      const hintBlock = ["[SDS_COVERAGE_HINTS]", sdsCoverageHints].join("\n");
      const hintCost = estimateTokens(hintBlock);
      if (budget - hintCost >= 0) {
        budget -= hintCost;
        blocks.push(hintBlock);
      } else {
        warnings.push("Context truncated due to token budget; skipped SDS coverage hints.");
      }
    }
    return { docSummary: blocks.join("\n\n") || "(no docs)", warnings };
  }

  private buildCreateTasksAgentMission(projectKey: string): string {
    return [
      `You are the orchestration agent for mcoda create-tasks on project ${projectKey}.`,
      "Your job in this run is to turn the SDS and supporting docs into an executable backlog that is enough to build the documented product.",
      "You must understand the services/tools that need to exist, define implementation epics, define the user stories needed to finish each epic, and define the concrete tasks needed to finish each story.",
      "Keep every phase aligned to the SDS folder tree, runtime topology, dependency order, startup waves, verification suites, acceptance scenarios, and named implementation targets.",
      "Use only canonical documented names for services, modules, interfaces, commands, schemas, files, and runtime artifacts.",
      "Do not invent stack choices, rename documented targets, emit placeholder work, or defer SDS gaps to a later manual pass.",
      "If coverage gaps remain, refine the backlog itself until the backlog is enough to build the product.",
    ].join("\n");
  }

  private hasExplicitAgentRequest(agentName?: string): boolean {
    return typeof agentName === "string" && agentName.trim().length > 0;
  }

  private schemaSnippetForAction(action: string): string {
    switch (action) {
      case "epics":
        return EPIC_SCHEMA_SNIPPET;
      case "epics_batch":
        return EPIC_BATCH_SCHEMA_SNIPPET;
      case "stories":
        return STORY_SCHEMA_SNIPPET;
      case "stories_batch":
        return STORIES_BATCH_SCHEMA_SNIPPET;
      case "tasks":
        return TASK_SCHEMA_SNIPPET;
      case "tasks_compact":
        return TASK_COMPACT_SCHEMA_SNIPPET;
      case "tasks_batch":
        return TASKS_BATCH_SCHEMA_SNIPPET;
      case "full_plan":
        return FULL_PLAN_SCHEMA_SNIPPET;
      default:
        return FULL_PLAN_SCHEMA_SNIPPET;
    }
  }

  private outputSchemaForAction(action: string): Record<string, unknown> | undefined {
    const stringArray = { type: "array", items: { type: "string" } };
    const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
    const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
    const qaEntrySchema = {
      type: "object",
      required: ["kind", "command", "base_url"],
      properties: {
        kind: nullableString,
        command: nullableString,
        base_url: nullableString,
      },
      additionalProperties: false,
    };
    const qaSchema = {
      type: "object",
      required: ["requires", "profiles_expected", "entrypoints", "data_setup", "blockers", "notes"],
      properties: {
        requires: stringArray,
        profiles_expected: stringArray,
        entrypoints: { type: "array", items: qaEntrySchema },
        data_setup: stringArray,
        blockers: stringArray,
        notes: nullableString,
      },
      additionalProperties: false,
    };
    const taskSchema: Record<string, unknown> = {
      type: "object",
      required: [
        "localId",
        "title",
        "type",
        "description",
        "files",
        "estimatedStoryPoints",
        "priorityHint",
        "dependsOnKeys",
        "relatedDocs",
        "unitTests",
        "componentTests",
        "integrationTests",
        "apiTests",
        "qa",
      ],
      properties: {
        localId: nullableString,
        title: { type: "string" },
        type: nullableString,
        description: nullableString,
        files: stringArray,
        estimatedStoryPoints: nullableNumber,
        priorityHint: nullableNumber,
        dependsOnKeys: stringArray,
        relatedDocs: stringArray,
        unitTests: stringArray,
        componentTests: stringArray,
        integrationTests: stringArray,
        apiTests: stringArray,
        qa: qaSchema,
      },
      additionalProperties: false,
    };
    const taskCompactSchema: Record<string, unknown> = {
      type: "object",
      required: [
        "localId",
        "title",
        "type",
        "description",
        "files",
        "estimatedStoryPoints",
        "priorityHint",
        "dependsOnKeys",
        "relatedDocs",
        "unitTests",
        "componentTests",
        "integrationTests",
        "apiTests",
      ],
      properties: {
        localId: nullableString,
        title: { type: "string" },
        type: nullableString,
        description: nullableString,
        files: stringArray,
        estimatedStoryPoints: nullableNumber,
        priorityHint: nullableNumber,
        dependsOnKeys: stringArray,
        relatedDocs: stringArray,
        unitTests: stringArray,
        componentTests: stringArray,
        integrationTests: stringArray,
        apiTests: stringArray,
      },
      additionalProperties: false,
    };
    const storySchema: Record<string, unknown> = {
      type: "object",
      required: [
        "localId",
        "title",
        "userStory",
        "description",
        "acceptanceCriteria",
        "relatedDocs",
        "priorityHint",
        "tasks",
      ],
      properties: {
        localId: nullableString,
        title: { type: "string" },
        userStory: nullableString,
        description: nullableString,
        acceptanceCriteria: stringArray,
        relatedDocs: stringArray,
        priorityHint: nullableNumber,
        tasks: { type: "array", items: taskSchema },
      },
      additionalProperties: false,
    };
    const epicSchema: Record<string, unknown> = {
      type: "object",
      required: [
        "localId",
        "area",
        "title",
        "description",
        "acceptanceCriteria",
        "relatedDocs",
        "priorityHint",
        "serviceIds",
        "tags",
        "stories",
      ],
      properties: {
        localId: nullableString,
        area: nullableString,
        title: { type: "string" },
        description: nullableString,
        acceptanceCriteria: stringArray,
        relatedDocs: stringArray,
        priorityHint: nullableNumber,
        serviceIds: stringArray,
        tags: stringArray,
        stories: { type: "array", items: storySchema },
      },
      additionalProperties: false,
    };

    const storySeedSchema: Record<string, unknown> = {
      type: "object",
      required: ["localId", "title", "userStory", "description", "acceptanceCriteria", "relatedDocs", "priorityHint"],
      properties: {
        localId: nullableString,
        title: { type: "string" },
        userStory: nullableString,
        description: nullableString,
        acceptanceCriteria: stringArray,
        relatedDocs: stringArray,
        priorityHint: nullableNumber,
      },
      additionalProperties: false,
    };
    const epicSeedSchema: Record<string, unknown> = {
      type: "object",
      required: [
        "localId",
        "area",
        "title",
        "description",
        "acceptanceCriteria",
        "relatedDocs",
        "priorityHint",
        "serviceIds",
        "tags",
      ],
      properties: {
        localId: nullableString,
        area: nullableString,
        title: { type: "string" },
        description: nullableString,
        acceptanceCriteria: stringArray,
        relatedDocs: stringArray,
        priorityHint: nullableNumber,
        serviceIds: stringArray,
        tags: stringArray,
      },
      additionalProperties: false,
    };
    const epicBatchSeedSchema: Record<string, unknown> = {
      type: "object",
      required: ["localId", "area", "title", "serviceIds", "tags"],
      properties: {
        localId: nullableString,
        area: nullableString,
        title: { type: "string" },
        serviceIds: stringArray,
        tags: stringArray,
      },
      additionalProperties: false,
    };
    const batchedStoriesSchema: Record<string, unknown> = {
      type: "object",
      required: ["epicLocalId", "stories"],
      properties: {
        epicLocalId: { type: "string" },
        stories: { type: "array", minItems: 1, items: storySeedSchema },
      },
      additionalProperties: false,
    };
    const batchedTasksSchema: Record<string, unknown> = {
      type: "object",
      required: ["epicLocalId", "storyLocalId", "tasks"],
      properties: {
        epicLocalId: { type: "string" },
        storyLocalId: { type: "string" },
        tasks: { type: "array", minItems: 1, items: taskSchema },
      },
      additionalProperties: false,
    };

    if (action === "epics") {
      return {
        type: "object",
        required: ["epics"],
        properties: {
          epics: { type: "array", minItems: 1, items: epicSeedSchema },
        },
        additionalProperties: false,
      };
    }
    if (action === "epics_batch") {
      return {
        type: "object",
        required: ["epics"],
        properties: {
          epics: { type: "array", minItems: 1, items: epicBatchSeedSchema },
        },
        additionalProperties: false,
      };
    }
    if (action === "stories") {
      return {
        type: "object",
        required: ["stories"],
        properties: {
          stories: { type: "array", minItems: 1, items: storySeedSchema },
        },
        additionalProperties: false,
      };
    }
    if (action === "stories_batch") {
      return {
        type: "object",
        required: ["epicStories"],
        properties: {
          epicStories: { type: "array", minItems: 1, items: batchedStoriesSchema },
        },
        additionalProperties: false,
      };
    }
    if (action === "tasks") {
      return {
        type: "object",
        required: ["tasks"],
        properties: {
          tasks: { type: "array", minItems: 1, items: taskSchema },
        },
        additionalProperties: false,
      };
    }
    if (action === "tasks_compact") {
      return {
        type: "object",
        required: ["tasks"],
        properties: {
          tasks: { type: "array", minItems: 1, items: taskCompactSchema },
        },
        additionalProperties: false,
      };
    }
    if (action === "tasks_batch") {
      return {
        type: "object",
        required: ["storyTasks"],
        properties: {
          storyTasks: { type: "array", minItems: 1, items: batchedTasksSchema },
        },
        additionalProperties: false,
      };
    }
    if (action === "full_plan") {
      return {
        type: "object",
        required: ["epics"],
        properties: {
          epics: { type: "array", minItems: 1, items: epicSchema },
        },
        additionalProperties: false,
      };
    }
    return undefined;
  }

  private buildPlanOutline(
    plan: GeneratedPlan,
    options?: {
      maxEpics?: number;
      maxStoriesPerEpic?: number;
      maxTasksPerStory?: number;
      mode?: "full" | "compact";
    },
  ): string {
    const maxEpics = options?.maxEpics ?? 16;
    const maxStoriesPerEpic = options?.maxStoriesPerEpic ?? 8;
    const maxTasksPerStory = options?.maxTasksPerStory ?? 10;
    const compact = options?.mode === "compact";
    const summary = {
      epics: plan.epics.slice(0, maxEpics).map((epic) => ({
        localId: epic.localId,
        title: epic.title,
        area: epic.area,
        serviceIds: normalizeStringArray(epic.serviceIds),
        tags: normalizeStringArray(epic.tags),
        acceptanceCriteria: compact ? (epic.acceptanceCriteria ?? []).slice(0, 3) : (epic.acceptanceCriteria ?? []).slice(0, 8),
        stories: plan.stories
          .filter((story) => story.epicLocalId === epic.localId)
          .slice(0, maxStoriesPerEpic)
          .map((story) => ({
            localId: story.localId,
            title: story.title,
            userStory: compact ? undefined : story.userStory,
            acceptanceCriteria: compact ? (story.acceptanceCriteria ?? []).slice(0, 3) : (story.acceptanceCriteria ?? []).slice(0, 8),
            tasks: plan.tasks
              .filter((task) => task.epicLocalId === epic.localId && task.storyLocalId === story.localId)
              .slice(0, maxTasksPerStory)
              .map((task) => ({
                localId: task.localId,
                title: task.title,
                type: task.type,
                dependsOnKeys: normalizeStringArray(task.dependsOnKeys),
                files: compact ? normalizeStringArray(task.files).slice(0, 4) : normalizeStringArray(task.files),
                description: compact ? undefined : task.description,
                unitTests: compact ? undefined : normalizeStringArray(task.unitTests),
                componentTests: compact ? undefined : normalizeStringArray(task.componentTests),
                integrationTests: compact ? undefined : normalizeStringArray(task.integrationTests),
                apiTests: compact ? undefined : normalizeStringArray(task.apiTests),
              })),
          })),
      })),
    };
    return JSON.stringify(summary, null, 2);
  }

  private isAgentTimeoutLikeError(error: unknown): boolean {
    const message = (error as Error)?.message ?? String(error);
    return /\btimed?\s*out\b|ETIMEDOUT|timeout/i.test(message);
  }

  private shouldPreferSchemaFreeInitialCompactTasks(): boolean {
    return this.compactTaskSchemaStrategy === "schema_free_pref";
  }

  private async activateCompactTaskSchemaFallback(jobId: string, reason?: string): Promise<void> {
    this.compactTaskSchemaStrategy = "schema_free_pref";
    if (this.compactTaskSchemaStrategyLogged) return;
    this.compactTaskSchemaStrategyLogged = true;
    await this.jobService.appendLog(
      jobId,
      "[create-tasks] tasks_compact structured mode is unstable in this run; preferring schema-free initial calls for remaining compact task prompts.\n",
    );
    if (reason) {
      await this.jobService.appendLog(jobId, `[create-tasks] ${reason}\n`);
    }
  }

  private buildJsonRepairPrompt(action: string, originalPrompt: string, originalOutput: string): string {
    if (action === "tasks_compact") {
      return [
        "The previous response did not satisfy the JSON-only compact task contract.",
        "You do not have tool access in this repair step. Do not say you will inspect Docdex, repo files, profile memory, or any other context.",
        "All required context is already present in the original request below.",
        "Answer the original request now as the final JSON object only.",
        `Schema hint:\n${this.schemaSnippetForAction(action)}`,
        'The first character of your answer must be "{" and the last must be "}".',
        `Original request:\n${originalPrompt}`,
        `Previous invalid response:\n${originalOutput}`,
      ].join("\n\n");
    }
    return [
      "Rewrite the previous response into valid JSON matching the expected schema.",
      `Schema hint:\n${this.schemaSnippetForAction(action)}`,
      "You do not have tool access in this repair step. Do not describe loading repo context or using tools.",
      "Return JSON only; no prose.",
      `Original content:\n${originalOutput}`,
    ].join("\n\n");
  }

  private shouldUseStrictAgentStagedPlanning(params: {
    projectKey: string;
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    architecture: CanonicalArchitectureArtifact;
    seedPlan: GeneratedPlan;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
  }): { useStaged: boolean; promptTokens: number; reason?: string } {
    const prompt = this.buildStrictAgentPlanPrompt({
      projectKey: params.projectKey,
      docSummary: params.docSummary,
      projectBuildMethod: params.projectBuildMethod,
      serviceCatalog: params.serviceCatalog,
      architecture: params.architecture,
      seedPlan: params.seedPlan,
      reasons: ["Generate the first complete SDS-aligned backlog from the architecture and docs."],
      options: params.options,
      iteration: 1,
    });
    const promptTokens = estimateTokens(prompt);
    if (promptTokens > STRICT_AGENT_FULL_PLAN_PROMPT_TOKEN_LIMIT) {
      return {
        useStaged: true,
        promptTokens,
        reason: `Estimated strict full-plan prompt size ${promptTokens} tokens exceeds reliability limit ${STRICT_AGENT_FULL_PLAN_PROMPT_TOKEN_LIMIT}.`,
      };
    }
    return { useStaged: false, promptTokens };
  }

  private parseFullPlan(
    output: string,
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): GeneratedPlan {
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.epics) || parsed.epics.length === 0) {
      throw new Error("Agent did not return a full backlog plan in expected format");
    }
    return this.materializePlanFromSeed(parsed as AgentPlan, options);
  }

  private buildStrictAgentPlanPrompt(params: {
    projectKey: string;
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    architecture: CanonicalArchitectureArtifact;
    seedPlan: GeneratedPlan;
    reasons: string[];
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
    iteration: number;
  }): string {
    const serviceCatalogSummary = this.buildServiceCatalogPromptSummary(params.serviceCatalog);
    const architectureSummary = this.buildArchitecturePromptSummary(params.architecture);
    const seedOutline = this.buildPlanOutline(params.seedPlan, { ...params.options, mode: "compact" });
    const limits = [
      params.options.maxEpics ? `- Limit epics to ${params.options.maxEpics}.` : "",
      params.options.maxStoriesPerEpic ? `- Limit stories per epic to ${params.options.maxStoriesPerEpic}.` : "",
      params.options.maxTasksPerStory ? `- Limit tasks per story to ${params.options.maxTasksPerStory}.` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return [
      this.buildCreateTasksAgentMission(params.projectKey),
      `Explicit-agent planning iteration ${params.iteration}. You are producing the complete backlog in one response.`,
      "Return strictly valid JSON only matching:",
      FULL_PLAN_SCHEMA_SNIPPET,
      "Rules:",
      "- Return the full backlog, not a delta and not an outline.",
      "- The final backlog must be agent-authored; deterministic SDS scaffolding below is context, not the accepted answer.",
      "- Every property shown in the schema must be present. Use null for unknown scalar fields and [] for empty arrays.",
      "- Every epic must map to one or more serviceIds from the phase-0 service catalog.",
      "- Every story must contain concrete implementation tasks; avoid meta, glossary, or placeholder work.",
      "- Every task must stay scoped to its own story and include files, unitTests, componentTests, integrationTests, apiTests, and qa. Use empty arrays or nulls when not applicable.",
      "- Use canonical documented names for services, files, interfaces, commands, schemas, and runtime artifacts exactly as documented.",
      "- Respect dependency-first build order, startup waves, and architecture authority.",
      "- Verification must support implementation work and must not dominate the backlog.",
      limits || "- Use reasonable scope without over-generating backlog items.",
      "Why this attempt is needed:",
      formatBullets(params.reasons, "Generate the first complete SDS-aligned backlog from the architecture and docs."),
      "Canonical architecture summary:",
      architectureSummary,
      "Project construction method:",
      params.projectBuildMethod,
      "Phase 0 service catalog (allowed serviceIds):",
      serviceCatalogSummary,
      "Deterministic SDS seed backlog outline for critique/context only:",
      seedOutline,
      "Docs available:",
      params.docSummary || "- (no docs provided; propose sensible backlog items).",
    ].join("\n\n");
  }

  private buildStrictAgentPlanRepairReasons(params: {
    plan: GeneratedPlan;
    completionReport: ReturnType<CreateTasksService["buildProjectCompletionReport"]>;
    weakForSds: boolean;
  }): string[] {
    const reasons: string[] = [];
    if (params.weakForSds) {
      reasons.push(
        `The backlog remains too weak for SDS-first acceptance (epics=${params.plan.epics.length}, stories=${params.plan.stories.length}, tasks=${params.plan.tasks.length}).`,
      );
    }
    if (!params.completionReport.satisfied) {
      reasons.push(
        `Project completion score ${params.completionReport.score}/${params.completionReport.threshold} is below target.`,
      );
    }
    for (const issue of params.completionReport.issues.slice(0, 8)) {
      reasons.push(`${issue.code}: ${issue.message}`);
    }
    if (reasons.length === 0) {
      reasons.push("Tighten the backlog so every architecture unit, dependency chain, and implementation surface is explicitly covered.");
    }
    return reasons;
  }

  private async generateStrictAgentPlan(params: {
    agent: Agent;
    projectKey: string;
    docs: DocdexDocument[];
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    architecture: CanonicalArchitectureArtifact;
    sourceTopologyExpectation: SourceTopologyExpectation;
    unknownEpicServicePolicy: EpicServiceValidationPolicy;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
    agentStream: boolean;
    jobId: string;
    commandRunId: string;
    seedPlan: GeneratedPlan;
  }): Promise<GeneratedPlan> {
    let seedPlan = params.seedPlan;
    let reasons = ["Generate the first complete SDS-aligned backlog from the architecture and docs."];
    let lastIssue = reasons[0];

    for (let iteration = 1; iteration <= CreateTasksService.MAX_STRICT_AGENT_PLAN_ATTEMPTS; iteration++) {
      const prompt = this.buildStrictAgentPlanPrompt({
        projectKey: params.projectKey,
        docSummary: params.docSummary,
        projectBuildMethod: params.projectBuildMethod,
        serviceCatalog: params.serviceCatalog,
        architecture: params.architecture,
        seedPlan,
        reasons,
        options: params.options,
        iteration,
      });
      await this.jobService.writeCheckpoint(params.jobId, {
        stage: "agent_full_plan_requested",
        timestamp: new Date().toISOString(),
        details: {
          iteration,
          maxIterations: CreateTasksService.MAX_STRICT_AGENT_PLAN_ATTEMPTS,
          seedEpics: seedPlan.epics.length,
          seedStories: seedPlan.stories.length,
          seedTasks: seedPlan.tasks.length,
        },
      });
      try {
        const { output } = await this.invokeAgentWithRetry(
          params.agent,
          prompt,
          "full_plan",
          params.agentStream,
          params.jobId,
          params.commandRunId,
          {
            strictAgentMode: true,
            planningIteration: iteration,
          },
        );
        const candidate = await this.normalizeGeneratedPlan({
          plan: this.parseFullPlan(output, params.options),
          docs: params.docs,
          serviceCatalog: params.serviceCatalog,
          sourceTopologyExpectation: params.sourceTopologyExpectation,
          unknownEpicServicePolicy: params.unknownEpicServicePolicy,
          jobId: params.jobId,
        });
        const completionReport = this.buildProjectCompletionReport(
          params.projectKey,
          candidate,
          params.architecture,
        );
        const weakForSds = this.planLooksTooWeakForSds(
          candidate,
          params.docs,
          params.serviceCatalog,
          params.sourceTopologyExpectation,
        );
        if (completionReport.satisfied) {
          if (weakForSds) {
            await this.jobService.appendLog(
              params.jobId,
              `Explicit agent planning iteration ${iteration} satisfied project completion but still showed SDS-coverage weakness; accepting because completion remains the primary explicit-agent gate.\n`,
            );
          }
          if (iteration > 1) {
            await this.jobService.appendLog(
              params.jobId,
              `Explicit agent planning converged on iteration ${iteration} with ${candidate.epics.length} epics, ${candidate.stories.length} stories, and ${candidate.tasks.length} tasks.\n`,
            );
          }
          return candidate;
        }
        reasons = this.buildStrictAgentPlanRepairReasons({
          plan: candidate,
          completionReport,
          weakForSds,
        });
        seedPlan = candidate;
        lastIssue = reasons[0];
        await this.jobService.appendLog(
          params.jobId,
          `Explicit agent planning iteration ${iteration} produced a backlog that still needs repair: ${reasons.join(" | ")}\n`,
        );
      } catch (error) {
        lastIssue = (error as Error)?.message ?? String(error);
        if (this.isAgentTimeoutLikeError(error)) {
          await this.jobService.appendLog(
            params.jobId,
            `Explicit agent full-plan iteration ${iteration} timed out and will recover through staged planning: ${lastIssue}\n`,
          );
          throw new Error(lastIssue);
        }
        reasons = [
          `The previous response failed planning validation: ${lastIssue}`,
          "Repair the output by returning a valid full backlog JSON object only.",
        ];
        await this.jobService.appendLog(
          params.jobId,
          `Explicit agent planning iteration ${iteration} failed: ${lastIssue}\n`,
        );
      }
    }

    throw new Error(
      `Explicit agent \"${params.agent.slug ?? params.agent.id}\" did not produce an acceptable backlog after ${CreateTasksService.MAX_STRICT_AGENT_PLAN_ATTEMPTS} planning iteration(s). Last issue: ${lastIssue}`,
    );
  }

  private async normalizeGeneratedPlan(params: {
    plan: GeneratedPlan;
    docs: DocdexDocument[];
    serviceCatalog: ServiceCatalogArtifact;
    sourceTopologyExpectation: SourceTopologyExpectation;
    unknownEpicServicePolicy: EpicServiceValidationPolicy;
    jobId: string;
  }): Promise<GeneratedPlan> {
    const normalizedPlanEpics = this.alignEpicsToServiceCatalog(
      params.plan.epics,
      params.serviceCatalog,
      params.unknownEpicServicePolicy,
    );
    for (const warning of normalizedPlanEpics.warnings) {
      await this.jobService.appendLog(params.jobId, `[create-tasks] ${warning}\n`);
    }
    let plan: GeneratedPlan = {
      ...params.plan,
      epics: normalizedPlanEpics.epics.map((epic, index) => ({
        ...epic,
        localId: epic.localId ?? `e${index + 1}`,
        stories: [],
      })),
    };
    plan = this.enforceStoryScopedDependencies(plan);
    plan = this.injectStructureBootstrapPlan(plan, params.docs, params.serviceCatalog.projectKey);
    plan = this.enforceStoryScopedDependencies(plan);
    this.validatePlanLocalIdentifiers(plan);
    plan = this.applyServiceDependencySequencing(plan, params.docs);
    plan = this.enforceStoryScopedDependencies(plan);
    this.validatePlanLocalIdentifiers(plan);
    this.derivePlanningArtifacts(
      params.serviceCatalog.projectKey,
      params.docs,
      plan,
      params.sourceTopologyExpectation,
    );
    return plan;
  }

  private buildRefinementPrompt(params: {
    projectKey: string;
    currentPlan: GeneratedPlan;
    audit: TaskSufficiencyAuditResult;
    reasons: string[];
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
    iteration: number;
  }): string {
    const serviceCatalogSummary = this.buildServiceCatalogPromptSummary(params.serviceCatalog);
    const planOutline = this.buildPlanOutline(params.currentPlan, params.options);
    const refinementLimits = [
      params.options.maxEpics ? `- Limit epics to ${params.options.maxEpics}.` : "",
      params.options.maxStoriesPerEpic ? `- Limit stories per epic to ${params.options.maxStoriesPerEpic}.` : "",
      params.options.maxTasksPerStory ? `- Limit tasks per story to ${params.options.maxTasksPerStory}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const plannedGapBundles =
      params.audit.plannedGapBundles.length > 0
        ? JSON.stringify(params.audit.plannedGapBundles.slice(0, 48), null, 2)
        : "[]";
    return [
      this.buildCreateTasksAgentMission(params.projectKey),
      `Refinement iteration ${params.iteration}. The current backlog did not yet satisfy the SDS sufficiency audit.`,
      "Return a complete replacement backlog as valid JSON only matching:",
      FULL_PLAN_SCHEMA_SNIPPET,
      "Refinement rules:",
      "- Return the full revised backlog, not a delta.",
      "- Preserve already-good backlog slices unless a stricter SDS-aligned replacement is required.",
      "- Every epic must map to one or more serviceIds from the phase-0 service catalog.",
      "- Every story must contain concrete tasks, and every task must stay scoped to its own story.",
      "- Every task must be implementation-concrete, name real targets when the SDS exposes them, and include unit/component/integration/api test arrays ([] when not applicable).",
      "- Fix the specific missing SDS coverage items listed below. Do not claim coverage unless the backlog contains executable work for them.",
      "- Maintain dependency-first sequencing from foundational/runtime prerequisites through verification and acceptance evidence.",
      refinementLimits || "- Use reasonable scope without over-generating backlog items.",
      "Why this revision is required:",
      formatBullets(params.reasons, "SDS coverage gaps remain."),
      "Current backlog outline:",
      planOutline,
      "Remaining section headings:",
      formatBullets(params.audit.remainingSectionHeadings, "none"),
      "Remaining folder entries:",
      formatBullets(params.audit.remainingFolderEntries, "none"),
      "Actionable gap bundles (anchor + concrete implementation targets):",
      plannedGapBundles,
      "Project construction method:",
      params.projectBuildMethod,
      "Phase 0 service catalog (allowed serviceIds):",
      serviceCatalogSummary,
      "Docs available:",
      params.docSummary || "- (no docs provided; propose sensible refinements).",
    ].join("\n\n");
  }

  private async refinePlanWithAgent(params: {
    agent: Agent;
    currentPlan: GeneratedPlan;
    audit: TaskSufficiencyAuditResult;
    reasons: string[];
    docs: DocdexDocument[];
    docSummary: string;
    projectKey: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    sourceTopologyExpectation: SourceTopologyExpectation;
    unknownEpicServicePolicy: EpicServiceValidationPolicy;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
    agentStream: boolean;
    jobId: string;
    commandRunId: string;
    iteration: number;
  }): Promise<GeneratedPlan> {
    const prompt = this.buildRefinementPrompt({
      projectKey: params.projectKey,
      currentPlan: params.currentPlan,
      audit: params.audit,
      reasons: params.reasons,
      docSummary: params.docSummary,
      projectBuildMethod: params.projectBuildMethod,
      serviceCatalog: params.serviceCatalog,
      options: params.options,
      iteration: params.iteration,
    });
    const { output } = await this.invokeAgentWithRetry(
      params.agent,
      prompt,
      "full_plan",
      params.agentStream,
      params.jobId,
      params.commandRunId,
      {
        refinementIteration: params.iteration,
        remainingGapCount: params.audit.remainingGaps.total,
        remainingSectionCount: params.audit.remainingSectionHeadings.length,
        remainingFolderCount: params.audit.remainingFolderEntries.length,
      },
    );
    const refinedPlan = this.parseFullPlan(output, params.options);
    return this.normalizeGeneratedPlan({
      plan: refinedPlan,
      docs: params.docs,
      serviceCatalog: params.serviceCatalog,
      sourceTopologyExpectation: params.sourceTopologyExpectation,
      unknownEpicServicePolicy: params.unknownEpicServicePolicy,
      jobId: params.jobId,
    });
  }

  private async runTaskSufficiencyAudit(params: {
    workspace: WorkspaceResolution;
    projectKey: string;
    sourceCommand: string;
    dryRun: boolean;
    jobId: string;
  }): Promise<{ audit?: TaskSufficiencyAuditResult; error?: string; warnings: string[] }> {
    if (!this.taskSufficiencyFactory) {
      return { warnings: [] };
    }
    let audit: TaskSufficiencyAuditResult | undefined;
    let error: string | undefined;
    let closeError: string | undefined;
    try {
      const sufficiencyService = await this.taskSufficiencyFactory(this.workspace);
      try {
        audit = await sufficiencyService.runAudit({
          workspace: params.workspace,
          projectKey: params.projectKey,
          sourceCommand: params.sourceCommand,
          dryRun: params.dryRun,
        });
      } finally {
        try {
          await sufficiencyService.close();
        } catch (caught) {
          closeError = (caught as Error)?.message ?? String(caught);
          await this.jobService.appendLog(
            params.jobId,
            `Task sufficiency audit close warning: ${closeError}\n`,
          );
        }
      }
    } catch (caught) {
      error = (caught as Error)?.message ?? String(caught);
    }
    return {
      audit,
      error,
      warnings: uniqueStrings([
        ...(audit?.warnings ?? []),
        ...(closeError ? [`Task sufficiency audit close warning: ${closeError}`] : []),
      ]),
    };
  }

  private buildPrompt(
    projectKey: string,
    docSummary: string,
    projectBuildMethod: string,
    serviceCatalog: ServiceCatalogArtifact,
    architecture: CanonicalArchitectureArtifact,
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): { prompt: string; docSummary: string } {
    const serviceCatalogSummary = this.buildServiceCatalogPromptSummary(serviceCatalog);
    const architectureSummary = this.buildArchitecturePromptSummary(architecture);
    const limits = [
      options.maxEpics ? `Limit epics to ${options.maxEpics}.` : "",
      options.maxStoriesPerEpic ? `Limit stories per epic to ${options.maxStoriesPerEpic}.` : "",
      options.maxTasksPerStory ? `Limit tasks per story to ${options.maxTasksPerStory}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const prompt = [
      this.buildCreateTasksAgentMission(projectKey),
      `You are assisting in phase 1 of 3 for project ${projectKey}: understand the documented services/tools and generate epics only.`,
      "Process is strict and direct: synthesize canonical architecture -> epics -> stories -> tasks -> project completion review. Coverage diagnostics are secondary.",
      "This step outputs only epics derived from the build plan and docs.",
      "Return strictly valid JSON (no prose) matching:",
      EPIC_SCHEMA_SNIPPET,
      "Rules:",
      "- First reason through the canonical architecture and implementation surfaces that must exist, then express that understanding through executable implementation epics.",
      "- Do NOT include final slugs; the system will assign keys.",
      "- Every property shown in the schema must be present. Use null for unknown scalar fields and [] for empty arrays.",
      "- Use docdex handles when referencing docs.",
      "- acceptanceCriteria must be an array of strings (5-10 items).",
      "- Keep epics actionable and implementation-oriented; avoid glossary/admin-only epics.",
      "- Prefer dependency-first sequencing: foundational setup epics before dependent feature epics.",
      "- Treat verification as supporting work; do not make verification-only epics the bulk of the backlog.",
      "- Keep output derived from docs; do not assume stacks unless docs state them.",
      "- Use canonical documented names for modules, services, interfaces, commands, schemas, and files exactly as they appear in Docs and the project construction method.",
      "- Do not rename explicit documented targets or replace them with invented alternatives.",
      "- serviceIds is required and must contain one or more ids from the phase-0 service catalog below.",
      `- If an epic spans multiple services, include tag \"${CROSS_SERVICE_TAG}\" in tags.`,
      "Canonical architecture summary:",
      architectureSummary,
      "Project construction method to follow:",
      projectBuildMethod,
      "Phase 0 service catalog (allowed serviceIds):",
      serviceCatalogSummary,
      limits || "Use reasonable scope without over-generating epics.",
      "Docs available:",
      docSummary || "- (no docs provided; propose sensible epics).",
    ].join("\n\n");
    return { prompt, docSummary };
  }

  private buildStrictStagedEpicsPrompt(
    projectKey: string,
    docSummary: string,
    projectBuildMethod: string,
    serviceCatalog: ServiceCatalogArtifact,
    architecture: CanonicalArchitectureArtifact,
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): { prompt: string; promptTokens: number } {
    const serviceCatalogSummary = compactPromptContext(
      this.buildServiceCatalogPromptSummary(serviceCatalog),
      STRICT_AGENT_STAGED_EPICS_SERVICE_CATALOG_TOKEN_LIMIT,
      "- none",
    );
    const architectureSummary = compactPromptContext(
      this.buildArchitecturePromptSummary(architecture),
      STRICT_AGENT_STAGED_EPICS_ARCHITECTURE_TOKEN_LIMIT,
      "- none",
    );
    const compactBuildMethod = compactPromptContext(
      projectBuildMethod,
      STRICT_AGENT_STAGED_EPICS_BUILD_METHOD_TOKEN_LIMIT,
      "none",
    );
    const compactDocSummary = compactPromptContext(
      docSummary,
      STRICT_AGENT_STAGED_EPICS_DOC_SUMMARY_TOKEN_LIMIT,
      "none",
    );
    const limits = [
      options.maxEpics ? `Limit epics to ${options.maxEpics}.` : "",
      options.maxStoriesPerEpic ? `Limit stories per epic to ${options.maxStoriesPerEpic}.` : "",
      options.maxTasksPerStory ? `Limit tasks per story to ${options.maxTasksPerStory}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const prompt = [
      this.buildCreateTasksAgentMission(projectKey),
      `You are assisting in phase 1 of 3 for project ${projectKey}: generate epics only from the frozen architecture and service catalog.`,
      "Return strictly valid JSON only matching:",
      EPIC_SCHEMA_SNIPPET,
      "Staged epics rules:",
      "- Emit epics only. Stories and tasks come later.",
      "- Each epic must be executable, implementation-oriented, and sufficient to cover one or more architecture units.",
      "- Every schema field must be present; use null or [] when unknown.",
      "- serviceIds must come from the service catalog below.",
      `- Use tag \"${CROSS_SERVICE_TAG}\" only when an epic truly spans multiple services.`,
      "- Preserve canonical documented names for services, modules, commands, schemas, and files.",
      "- Keep dependency-first ordering from foundational surfaces toward dependent runtime and release work.",
      "Canonical architecture summary:",
      architectureSummary,
      "Project construction method:",
      compactBuildMethod,
      "Phase 0 service catalog (allowed serviceIds):",
      serviceCatalogSummary,
      limits || "Use reasonable scope without over-generating epics.",
      "Docs available:",
      compactDocSummary,
    ].join("\n\n");
    return { prompt, promptTokens: estimateTokens(prompt) };
  }

  private buildArchitectureUnitBatchSummary(units: ArchitectureUnit[]): string {
    return units
      .map((unit) => {
        const deps = unit.dependsOnUnitIds.length > 0 ? unit.dependsOnUnitIds.join(", ") : "none";
        const targets = uniqueStrings([...unit.implementationTargets, ...unit.supportingTargets]).slice(0, 4);
        const services = unit.sourceServiceIds.length > 0 ? unit.sourceServiceIds.join(", ") : "none";
        const wave = typeof unit.startupWave === "number" ? `wave=${unit.startupWave}` : "wave=unspecified";
        return `- ${unit.unitId}: ${unit.name}; ${unit.kind}; ${wave}; services=${services}; deps=${deps}; targets=${
          targets.length > 0 ? targets.join(", ") : "none inferred"
        }`;
      })
      .join("\n");
  }

  private buildStrictStagedEpicBatchPrompt(params: {
    projectKey: string;
    units: ArchitectureUnit[];
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
  }): string {
    const serviceIds = new Set<string>();
    for (const unit of params.units) {
      for (const serviceId of unit.sourceServiceIds) {
        serviceIds.add(serviceId);
      }
    }
    const allowedServiceIds = Array.from(serviceIds).sort();
    const unitSummary = this.buildArchitectureUnitBatchSummary(params.units);
    const limits = [
      params.options.maxEpics ? `Limit epics in this batch to ${params.options.maxEpics}.` : "",
      params.options.maxStoriesPerEpic ? `Stories per epic will be limited later to ${params.options.maxStoriesPerEpic}.` : "",
      params.options.maxTasksPerStory ? `Tasks per story will be limited later to ${params.options.maxTasksPerStory}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return [
      `Project ${params.projectKey}. Phase 1 of 3.`,
      `Generate implementation epics for ${params.units.length} architecture unit(s) in one staged batch.`,
      "Return strictly valid JSON only matching:",
      EPIC_BATCH_SCHEMA_SNIPPET,
      "Batch scope rules:",
      "- Cover the supplied architecture units in dependency order with executable implementation epics.",
      "- Return only epics. Stories and tasks come later.",
      "- Return only the structural epic fields shown in the schema for this staged batch.",
      "- Prefer one epic per supplied architecture unit unless a combined epic is clearly required by a shared implementation target.",
      "- serviceIds must come from the allowed serviceIds list below.",
      `- Use tag \"${CROSS_SERVICE_TAG}\" only when an epic truly spans multiple services.`,
      "- Keep titles concise, implementation-oriented, and grounded in the supplied unit names and targets.",
      "- Do not emit placeholder, glossary, or verification-heavy epics.",
      "- No prose outside the JSON object.",
      "Architecture unit batch:",
      unitSummary,
      `Allowed serviceIds for this batch: ${allowedServiceIds.join(", ") || "none"}`,
      limits || "Use reasonable scope for this batch.",
    ].join("\n\n");
  }

  private formatArchitectureUnitEpicTitle(unit: ArchitectureUnit): string {
    const displayName = unit.name
      .split(/\s+/)
      .map((token) => (token ? token[0]!.toUpperCase() + token.slice(1) : token))
      .join(" ");
    if (unit.kind === "service") return `Build ${displayName}`;
    if (unit.kind === "cross_cutting") return `Establish ${displayName}`;
    return `Verify ${displayName}`;
  }

  private buildSingleUnitEpicRepairSeed(projectKey: string, unit: ArchitectureUnit): Record<string, unknown> {
    const serviceIds = uniqueStrings(unit.sourceServiceIds);
    return {
      localId: null,
      area: normalizeArea(projectKey) ?? "core",
      title: this.formatArchitectureUnitEpicTitle(unit),
      serviceIds,
      tags: unit.kind === "cross_cutting" || serviceIds.length > 1 ? [CROSS_SERVICE_TAG] : [],
    };
  }

  private buildDeterministicEpicForArchitectureUnit(projectKey: string, unit: ArchitectureUnit): AgentEpicNode {
    const serviceIds = uniqueStrings(unit.sourceServiceIds);
    const dependencySummary =
      unit.dependsOnUnitIds.length > 0 ? `Dependencies: ${unit.dependsOnUnitIds.join(", ")}.` : undefined;
    return {
      area: normalizeArea(projectKey) ?? "core",
      title: this.formatArchitectureUnitEpicTitle(unit),
      description: [
        unit.summary,
        typeof unit.startupWave === "number" ? `Startup wave: ${unit.startupWave}.` : undefined,
        dependencySummary,
        unit.sourceHeadings.length > 0 ? `SDS sections: ${unit.sourceHeadings.slice(0, 6).join("; ")}.` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      acceptanceCriteria: [
        `${unit.name} is represented with explicit buildable work.`,
        `${unit.name} stays aligned with SDS dependency and architecture ordering.`,
        `${unit.name} includes supporting validation where the SDS requires it.`,
      ],
      relatedDocs: [],
      priorityHint: typeof unit.startupWave === "number" ? Math.max(1, 100 - unit.startupWave * 5) : undefined,
      serviceIds,
      tags: unit.kind === "cross_cutting" || serviceIds.length > 1 ? [CROSS_SERVICE_TAG] : [],
      stories: [],
    };
  }

  private buildSingleUnitEpicPrompt(params: {
    projectKey: string;
    unit: ArchitectureUnit;
    retryReason?: string;
  }): string {
    const allowedServiceIds = uniqueStrings(params.unit.sourceServiceIds);
    const seed = this.buildSingleUnitEpicRepairSeed(params.projectKey, params.unit);
    const intro = params.retryReason
      ? `The previous strict single-unit epic attempt failed: ${params.retryReason}`
      : `Generate exactly one implementation epic for architecture unit ${params.unit.unitId}.`;
    return [
      `Project ${params.projectKey}. Phase 1 single-unit epic generation for architecture unit ${params.unit.unitId}.`,
      intro,
      "Return strictly valid JSON only matching:",
      EPIC_BATCH_SCHEMA_SNIPPET,
      "Repair rules:",
      "- Return exactly one executable implementation epic for the supplied architecture unit.",
      "- Keep the epic focused on this unit and its real implementation targets.",
      "- Use only the allowed serviceIds listed below.",
      `- Use tag \"${CROSS_SERVICE_TAG}\" only when the returned epic truly spans multiple services.`,
      "- Reuse the provided seed structure unless a materially better title or service grouping is required.",
      "- Return JSON only. Do not include prose.",
      "Architecture unit:",
      this.buildArchitectureUnitBatchSummary([params.unit]),
      `Allowed serviceIds: ${allowedServiceIds.join(", ") || "none"}`,
      "Seed epic JSON:",
      JSON.stringify({ epics: [seed] }, null, 2),
    ].join("\n\n");
  }

  private resolveStrictBatchTimeoutMs(action: "epics_batch" | "stories_batch" | "tasks_batch", itemCount: number): number {
    const safeCount = Math.max(1, itemCount);
    switch (action) {
      case "epics_batch":
        return STRICT_AGENT_EPIC_BATCH_TIMEOUT_BASE_MS + (safeCount - 1) * STRICT_AGENT_EPIC_BATCH_TIMEOUT_PER_UNIT_MS;
      case "stories_batch":
        return STRICT_AGENT_STORY_BATCH_TIMEOUT_BASE_MS + (safeCount - 1) * STRICT_AGENT_STORY_BATCH_TIMEOUT_PER_EPIC_MS;
      case "tasks_batch":
        return STRICT_AGENT_TASK_BATCH_TIMEOUT_BASE_MS + (safeCount - 1) * STRICT_AGENT_TASK_BATCH_TIMEOUT_PER_STORY_MS;
    }
  }

  private buildStrictStagedEpicGenerationChunks(params: {
    projectKey: string;
    architecture: CanonicalArchitectureArtifact;
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
  }): ArchitectureUnit[][] {
    const unitById = new Map(params.architecture.units.map((unit) => [unit.unitId, unit] as const));
    const orderedUnits: ArchitectureUnit[] = [];
    for (const unitId of params.architecture.dependencyOrder) {
      const unit = unitById.get(unitId);
      if (unit) orderedUnits.push(unit);
    }
    for (const unit of params.architecture.units) {
      if (!orderedUnits.some((entry) => entry.unitId === unit.unitId)) {
        orderedUnits.push(unit);
      }
    }

    const chunks: ArchitectureUnit[][] = [];
    let current: ArchitectureUnit[] = [];
    for (const unit of orderedUnits) {
      const candidate = [...current, unit];
      const promptTokens = estimateTokens(
        this.buildStrictStagedEpicBatchPrompt({
          projectKey: params.projectKey,
          units: candidate,
          docSummary: params.docSummary,
          projectBuildMethod: params.projectBuildMethod,
          serviceCatalog: params.serviceCatalog,
          options: params.options,
        }),
      );
      if (
        current.length > 0 &&
        (candidate.length > STRICT_AGENT_MAX_UNITS_PER_EPIC_BATCH ||
          promptTokens > STRICT_AGENT_EPIC_BATCH_PROMPT_TOKEN_LIMIT)
      ) {
        chunks.push(current);
        current = [unit];
        continue;
      }
      current = candidate;
    }
    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  private async generateEpicsForArchitectureChunk(params: {
    agent: Agent;
    projectKey: string;
    units: ArchitectureUnit[];
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
    stream: boolean;
    jobId: string;
    commandRunId: string;
  }): Promise<AgentEpicNode[]> {
    const prompt = this.buildStrictStagedEpicBatchPrompt({
      projectKey: params.projectKey,
      units: params.units,
      docSummary: params.docSummary,
      projectBuildMethod: params.projectBuildMethod,
      serviceCatalog: params.serviceCatalog,
      options: params.options,
    });
    const { output } = await this.invokeAgentWithRetry(
      params.agent,
      prompt,
      "epics_batch",
      params.stream,
      params.jobId,
      params.commandRunId,
      {
        strictAgentMode: true,
        planningMode: "staged_epics_batch",
        architectureUnitIds: params.units.map((unit) => unit.unitId),
        timeoutMs: this.resolveStrictBatchTimeoutMs("epics_batch", params.units.length),
      },
    );
    return this.parseEpics(output, [], params.projectKey);
  }

  private async generateEpicForSingleArchitectureUnit(params: {
    agent: Agent;
    projectKey: string;
    unit: ArchitectureUnit;
    jobId: string;
    commandRunId: string;
    retryReason?: string;
  }): Promise<AgentEpicNode[]> {
    const prompt = this.buildSingleUnitEpicPrompt({
      projectKey: params.projectKey,
      unit: params.unit,
      retryReason: params.retryReason,
    });
    const { output } = await this.invokeAgentWithRetry(
      params.agent,
      prompt,
      "epics_batch",
      false,
      params.jobId,
      params.commandRunId,
      {
        strictAgentMode: true,
        planningMode: params.retryReason ? "staged_epics_single_unit_repair" : "staged_epics_single_unit",
        architectureUnitIds: [params.unit.unitId],
        timeoutMs: STRICT_AGENT_EPIC_REPAIR_TIMEOUT_MS,
      },
    );
    return this.parseEpics(output, [], params.projectKey);
  }

  private async collectStrictEpicChunk(params: {
    agent: Agent;
    projectKey: string;
    chunk: ArchitectureUnit[];
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
    stream: boolean;
    jobId: string;
    commandRunId: string;
    collectedEpics: AgentEpicNode[];
  }): Promise<void> {
    if (params.chunk.length === 1) {
      const [unit] = params.chunk;
      if (!unit) {
        return;
      }
      await this.jobService.appendLog(
        params.jobId,
        `Strict single-unit epic generation requested for architecture unit [${unit.unitId}].\n`,
      );
      try {
        const epics = await this.generateEpicForSingleArchitectureUnit({
          agent: params.agent,
          projectKey: params.projectKey,
          unit,
          jobId: params.jobId,
          commandRunId: params.commandRunId,
        });
        params.collectedEpics.push(...epics);
        return;
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        await this.jobService.appendLog(
          params.jobId,
          `Strict single-unit epic generation failed for architecture unit [${unit.unitId}]. Retrying through single-unit repair. Reason: ${message}\n`,
        );
        try {
          const repairedEpics = await this.generateEpicForSingleArchitectureUnit({
            agent: params.agent,
            projectKey: params.projectKey,
            unit,
            retryReason: message,
            jobId: params.jobId,
            commandRunId: params.commandRunId,
          });
          params.collectedEpics.push(...repairedEpics);
        } catch (retryError) {
          const retryMessage = (retryError as Error).message ?? String(retryError);
          await this.jobService.appendLog(
            params.jobId,
            `Strict single-unit epic repair failed for architecture unit [${unit.unitId}]. Using deterministic architecture scaffold and continuing. Reason: ${retryMessage}\n`,
          );
          params.collectedEpics.push(
            this.buildDeterministicEpicForArchitectureUnit(params.projectKey, unit),
          );
        }
        return;
      }
    }
    try {
      const epics = await this.generateEpicsForArchitectureChunk({
        agent: params.agent,
        projectKey: params.projectKey,
        units: params.chunk,
        docSummary: params.docSummary,
        projectBuildMethod: params.projectBuildMethod,
        serviceCatalog: params.serviceCatalog,
        options: params.options,
        stream: params.stream,
        jobId: params.jobId,
        commandRunId: params.commandRunId,
      });
      params.collectedEpics.push(...epics);
      return;
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const unitLabels = params.chunk.map((unit) => unit.unitId).join(", ");
      await this.jobService.appendLog(
        params.jobId,
        `Batched epic generation failed for architecture unit chunk [${unitLabels}]. Splitting chunk for strict recovery. Reason: ${message}\n`,
      );
      const [left, right] = this.splitChunkInHalf(params.chunk);
      await this.collectStrictEpicChunk({ ...params, chunk: left });
      if (right.length > 0) {
        await this.collectStrictEpicChunk({ ...params, chunk: right });
      }
    }
  }

  private fallbackPlan(projectKey: string, docs: DocdexDocument[]): AgentPlan {
    const docRefs = docs.map((doc) => (doc.id ? `docdex:${doc.id}` : doc.path ?? doc.title ?? "doc"));
    return {
      epics: [
        {
          area: projectKey,
          title: `Initial planning for ${projectKey}`,
          description: `Seed epic derived from provided documentation (${docRefs.join(", ")})`,
          acceptanceCriteria: ["Backlog created with actionable tasks", "Dependencies identified", "Tasks grouped by user value"],
          relatedDocs: docRefs,
          stories: [
            {
              localId: "story-1",
              title: "Review inputs and draft backlog",
              userStory: "As a planner, I want a decomposed backlog so that work can be prioritized.",
              description: "Review provided docs and produce a first-pass backlog.",
              acceptanceCriteria: [
                "Epics, stories, and tasks are listed",
                "Each task has an objective and DoD",
                "Dependencies noted",
              ],
              relatedDocs: docRefs,
              tasks: [
                {
                  localId: "task-1",
                  title: "Implement baseline project scaffolding",
                  type: "feature",
                  description: "Create SDS-aligned baseline structure and core implementation entrypoints from the available docs.",
                  estimatedStoryPoints: 3,
                  priorityHint: 10,
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
                {
                  localId: "task-2",
                  title: "Integrate core dependencies and interfaces",
                  type: "feature",
                  description: "Wire key dependencies, interfaces, and integration paths so core behavior can execute end-to-end.",
                  estimatedStoryPoints: 3,
                  priorityHint: 20,
                  dependsOnKeys: ["task-1"],
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
                {
                  localId: "task-3",
                  title: "Validate baseline behavior and regressions",
                  type: "chore",
                  description: "Add targeted validation coverage and readiness evidence for the implemented baseline capabilities.",
                  estimatedStoryPoints: 2,
                  priorityHint: 30,
                  dependsOnKeys: ["task-2"],
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  private materializePlanFromSeed(
    seed: AgentPlan,
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): GeneratedPlan {
    const epics: PlanEpic[] = [];
    const stories: PlanStory[] = [];
    const tasks: PlanTask[] = [];
    const epicLimit = options.maxEpics ?? Number.MAX_SAFE_INTEGER;
    const storyLimit = options.maxStoriesPerEpic ?? Number.MAX_SAFE_INTEGER;
    const taskLimit = options.maxTasksPerStory ?? Number.MAX_SAFE_INTEGER;
    const seedEpics = Array.isArray(seed.epics) ? seed.epics.slice(0, epicLimit) : [];
    for (const [epicIndex, epic] of seedEpics.entries()) {
      const epicLocalId =
        typeof epic.localId === "string" && epic.localId.trim().length > 0 ? epic.localId : `e${epicIndex + 1}`;
      const planEpic: PlanEpic = {
        ...epic,
        localId: epicLocalId,
        area: normalizeArea(epic.area),
        relatedDocs: normalizeRelatedDocs(epic.relatedDocs),
        acceptanceCriteria: Array.isArray(epic.acceptanceCriteria) ? epic.acceptanceCriteria : [],
        stories: [],
      };
      epics.push(planEpic);
      const epicStories = Array.isArray(epic.stories) ? epic.stories.slice(0, storyLimit) : [];
      for (const [storyIndex, story] of epicStories.entries()) {
        const storyLocalId =
          typeof story.localId === "string" && story.localId.trim().length > 0 ? story.localId : `us${storyIndex + 1}`;
        const planStory: PlanStory = {
          ...story,
          localId: storyLocalId,
          epicLocalId,
          relatedDocs: normalizeRelatedDocs(story.relatedDocs),
          acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
          tasks: [],
        };
        stories.push(planStory);
        const storyTasks = Array.isArray(story.tasks) ? story.tasks.slice(0, taskLimit) : [];
        for (const [taskIndex, task] of storyTasks.entries()) {
          const localId =
            typeof task.localId === "string" && task.localId.trim().length > 0 ? task.localId : `t${taskIndex + 1}`;
          tasks.push({
            ...task,
            localId,
            storyLocalId,
            epicLocalId,
            title: task.title ?? "Task",
            type: normalizeTaskType(task.type) ?? "feature",
            description: task.description ?? "",
            estimatedStoryPoints: typeof task.estimatedStoryPoints === "number" ? task.estimatedStoryPoints : undefined,
            priorityHint: typeof task.priorityHint === "number" ? task.priorityHint : undefined,
            dependsOnKeys: normalizeStringArray(task.dependsOnKeys),
            relatedDocs: normalizeRelatedDocs(task.relatedDocs),
            unitTests: normalizeStringArray(task.unitTests),
            componentTests: normalizeStringArray(task.componentTests),
            integrationTests: normalizeStringArray(task.integrationTests),
            apiTests: normalizeStringArray(task.apiTests),
            qa: normalizeQaReadiness(task.qa),
          });
        }
      }
    }
    return { epics, stories, tasks };
  }

  private async invokeAgentWithRetry(
    agent: Agent,
    prompt: string,
    action: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ output: string; promptTokens: number; completionTokens: number }> {
    const startedAt = Date.now();
    let output = "";
    let invocationMetadata: Record<string, unknown> | undefined;
    const currentTimestamp = () => new Date().toISOString();
    const promptTokens = estimateTokens(prompt);
    if (
      action === "tasks_compact" &&
      !this.shouldPreferSchemaFreeInitialCompactTasks() &&
      promptTokens > STRICT_AGENT_COMPACT_TASK_STRUCTURED_PROMPT_TOKEN_LIMIT
    ) {
      await this.activateCompactTaskSchemaFallback(
        jobId,
        `tasks_compact prompt estimate ${promptTokens} exceeds structured reliability limit ${STRICT_AGENT_COMPACT_TASK_STRUCTURED_PROMPT_TOKEN_LIMIT}.`,
      );
    }
    const actionOutputSchema = this.outputSchemaForAction(action);
    const preferSchemaFreeInitialCompactCall =
      action === "tasks_compact" && this.shouldPreferSchemaFreeInitialCompactTasks();
    const outputSchema = preferSchemaFreeInitialCompactCall ? undefined : actionOutputSchema;
    const requestMetadata = {
      command: "create-tasks",
      action,
      phase: `create_tasks_${action}`,
      ...(metadata ?? {}),
      ...(outputSchema ? { outputSchema } : {}),
    };
    const schemaFreeRequestMetadata = { ...requestMetadata } as Record<string, unknown>;
    delete schemaFreeRequestMetadata.outputSchema;
    schemaFreeRequestMetadata.schemaRetryMode = "without_output_schema";
    const repairRequestMetadata = {
      ...requestMetadata,
      ...(actionOutputSchema ? { outputSchema: actionOutputSchema } : {}),
    } as Record<string, unknown>;
    const usageMetadata = { ...(metadata ?? {}) };
    delete usageMetadata.outputSchema;
    const logChunk = async (chunk?: string) => {
      if (!chunk) return;
      await this.jobService.appendLog(jobId, chunk);
      if (stream) process.stdout.write(chunk);
    };
    const logFailoverEvents = async (events: Array<Record<string, unknown>>): Promise<void> => {
      if (!events.length) return;
      for (const event of events) {
        await this.jobService.appendLog(
          jobId,
          `[create-tasks] agent failover (${action}): ${summarizeAgentFailoverEvent(event)}\n`,
        );
      }
    };
    const resolveUsageAgent = async (
      events: Array<Record<string, unknown>>,
    ): Promise<{ id: string; defaultModel?: string }> => {
      const agentId = resolveTerminalFailoverAgentId(events, agent.id);
      if (agentId === agent.id) {
        return { id: agent.id, defaultModel: agent.defaultModel };
      }
      try {
        const resolved = await this.agentService.resolveAgent(agentId);
        return { id: resolved.id, defaultModel: resolved.defaultModel };
      } catch (error) {
        await this.jobService.appendLog(
          jobId,
          `[create-tasks] unable to resolve failover agent (${agentId}) for usage accounting: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { id: agent.id, defaultModel: agent.defaultModel };
      }
    };
    const recordUsageForAttempt = async (
      inputText: string,
      outputText: string,
      attempt: number,
      metadataForAttempt?: Record<string, unknown>,
      extraMetadata?: Record<string, unknown>,
    ): Promise<{ promptTokens: number; completionTokens: number }> => {
      const failoverEvents = normalizeAgentFailoverEvents(metadataForAttempt?.failoverEvents);
      await logFailoverEvents(failoverEvents);
      const usageAgent = await resolveUsageAgent(failoverEvents);
      const promptTokens = estimateTokens(inputText);
      const completionTokens = estimateTokens(outputText);
      const durationSeconds = (Date.now() - startedAt) / 1000;
      await this.jobService.recordTokenUsage({
        timestamp: currentTimestamp(),
        workspaceId: this.workspace.workspaceId,
        jobId,
        commandRunId,
        agentId: usageAgent.id,
        modelName: usageAgent.defaultModel,
        promptTokens,
        completionTokens,
        tokensPrompt: promptTokens,
        tokensCompletion: completionTokens,
        tokensTotal: promptTokens + completionTokens,
        durationSeconds,
        metadata: {
          action: `create_tasks_${action}`,
          phase: `create_tasks_${action}`,
          attempt,
          failoverEvents: failoverEvents.length > 0 ? failoverEvents : undefined,
          ...usageMetadata,
          ...(extraMetadata ?? {}),
        },
      });
      return { promptTokens, completionTokens };
    };
    try {
      if (stream) {
        const gen = await this.agentService.invokeStream(agent.id, {
          input: prompt,
          metadata: requestMetadata,
        });
        for await (const chunk of gen) {
          output += chunk.output ?? "";
          invocationMetadata = mergeAgentInvocationMetadata(
            invocationMetadata,
            chunk.metadata as Record<string, unknown> | undefined,
          );
          await logChunk(chunk.output);
        }
      } else {
        const result = await this.agentService.invoke(agent.id, {
          input: prompt,
          metadata: requestMetadata,
        });
        output = result.output ?? "";
        invocationMetadata = mergeAgentInvocationMetadata(
          invocationMetadata,
          result.metadata as Record<string, unknown> | undefined,
        );
        await logChunk(output);
      }
    } catch (error) {
      if (action === "tasks_compact" && outputSchema && this.isAgentTimeoutLikeError(error)) {
        await this.activateCompactTaskSchemaFallback(jobId);
      }
      if (outputSchema && this.isAgentTimeoutLikeError(error)) {
        await this.jobService.appendLog(
          jobId,
          `[create-tasks] structured ${action} call timed out; retrying once without output schema.\n`,
        );
        try {
          const result = await this.agentService.invoke(agent.id, {
            input: prompt,
            metadata: schemaFreeRequestMetadata,
          });
          output = result.output ?? "";
          invocationMetadata = mergeAgentInvocationMetadata(
            invocationMetadata,
            result.metadata as Record<string, unknown> | undefined,
          );
        } catch (schemaRetryError) {
          throw new Error(
            `Agent invocation failed (${action}): ${(error as Error).message}; schema-free retry failed: ${(schemaRetryError as Error).message}`,
          );
        }
      } else {
        throw new Error(`Agent invocation failed (${action}): ${(error as Error).message}`);
      }
    }
    const initialUsage = await recordUsageForAttempt(prompt, output, 1, invocationMetadata);
    let parsed = extractJson(output);
    if (!parsed) {
      const attempt = 2;
      const fixPrompt = this.buildJsonRepairPrompt(action, prompt, output);
      try {
        let retryInvocationMetadata: Record<string, unknown> | undefined;
        const fix = await this.agentService.invoke(agent.id, {
          input: fixPrompt,
          metadata: {
            ...repairRequestMetadata,
            attempt: 2,
            stage: "json_repair",
          },
        });
        output = fix.output ?? "";
        retryInvocationMetadata = mergeAgentInvocationMetadata(
          retryInvocationMetadata,
          fix.metadata as Record<string, unknown> | undefined,
        );
        const retryUsage = await recordUsageForAttempt(
          fixPrompt,
          output,
          attempt,
          retryInvocationMetadata,
          { stage: "json_repair" },
        );
        parsed = extractJson(output);
        if (parsed) {
          return { output, promptTokens: retryUsage.promptTokens, completionTokens: retryUsage.completionTokens };
        }
      } catch (error) {
        throw new Error(`Agent retry failed (${action}): ${(error as Error).message}`);
      }
    }
    if (!parsed) {
      throw new Error(`Agent output was not valid JSON for ${action}`);
    }
    return { output, promptTokens: initialUsage.promptTokens, completionTokens: initialUsage.completionTokens };
  }

  private parseEpics(output: string, fallbackDocs: DocdexDocument[], projectKey: string): AgentEpicNode[] {
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.epics) || parsed.epics.length === 0) {
      throw new Error("Agent did not return epics in expected format");
    }
    return (parsed.epics as any[])
      .map((epic, idx) => ({
        localId: epic.localId ?? `e${idx + 1}`,
        area: normalizeArea(epic.area),
        title: epic.title ?? "Epic",
        description: epic.description,
        acceptanceCriteria: Array.isArray(epic.acceptanceCriteria) ? epic.acceptanceCriteria : [],
        relatedDocs: normalizeRelatedDocs(epic.relatedDocs),
        priorityHint: typeof epic.priorityHint === "number" ? epic.priorityHint : undefined,
        serviceIds: normalizeStringArray(epic.serviceIds),
        tags: normalizeEpicTags(epic.tags),
        stories: [],
      }))
      .filter((e) => e.title);
  }

  private normalizeAgentStoryNode(story: any, idx: number): AgentStoryNode {
    return {
      localId: story.localId ?? `us${idx + 1}`,
      title: story.title ?? "Story",
      userStory: story.userStory ?? story.description,
      description: story.description,
      acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
      relatedDocs: normalizeRelatedDocs(story.relatedDocs),
      priorityHint: typeof story.priorityHint === "number" ? story.priorityHint : undefined,
      tasks: [],
    };
  }

  private parseAgentTestList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private parseAgentFileList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().replace(/\\/g, "/"))
      .filter(Boolean);
  }

  private normalizeAgentTaskNode(task: any, idx: number): AgentTaskNode {
    return {
      localId: task.localId ?? `t${idx + 1}`,
      title: task.title ?? "Task",
      type: normalizeTaskType(task.type) ?? "feature",
      description: task.description ?? "",
      files: this.parseAgentFileList(task.files),
      estimatedStoryPoints: typeof task.estimatedStoryPoints === "number" ? task.estimatedStoryPoints : undefined,
      priorityHint: typeof task.priorityHint === "number" ? task.priorityHint : undefined,
      dependsOnKeys: Array.isArray(task.dependsOnKeys) ? task.dependsOnKeys : [],
      relatedDocs: normalizeRelatedDocs(task.relatedDocs),
      unitTests: this.parseAgentTestList(task.unitTests),
      componentTests: this.parseAgentTestList(task.componentTests),
      integrationTests: this.parseAgentTestList(task.integrationTests),
      apiTests: this.parseAgentTestList(task.apiTests),
      qa: normalizeQaReadiness(task.qa),
    };
  }

  private buildStoriesBatchPrompt(
    projectKey: string,
    epics: PlanEpic[],
    docSummary: string,
    projectBuildMethod: string,
  ): string {
    const compactDocSummary = compactPromptContext(
      docSummary,
      STRICT_AGENT_BATCH_DOC_SUMMARY_TOKEN_LIMIT,
      "none",
    );
    const compactBuildMethod = compactPromptContext(
      projectBuildMethod,
      STRICT_AGENT_BATCH_BUILD_METHOD_TOKEN_LIMIT,
      "none",
    );
    const batchContext = JSON.stringify(
      {
        epics: epics.map((epic) => ({
          epicLocalId: epic.localId ?? "TBD",
          title: epic.title,
          description: epic.description ?? null,
          acceptanceCriteria: epic.acceptanceCriteria ?? [],
          relatedDocs: epic.relatedDocs ?? [],
          priorityHint: epic.priorityHint ?? null,
          serviceIds: epic.serviceIds ?? [],
          tags: epic.tags ?? [],
        })),
      },
      null,
      2,
    );
    return [
      this.buildCreateTasksAgentMission(projectKey),
      `Generate user stories for ${epics.length} epic(s) in one batch (phase 2 of 3).`,
      "This phase is stories-only. Do not generate tasks yet.",
      "Return JSON only matching:",
      STORIES_BATCH_SCHEMA_SNIPPET,
      "Batch rules:",
      "- Return one epicStories entry per supplied epicLocalId, exactly once.",
      "- Keep stories implementation-oriented, dependency-ordered, and sufficient to finish each epic.",
      "- Every schema field must be present; use null or [] when unknown.",
      "- No tasks in this step and no placeholder/meta stories.",
      "- Preserve canonical names and use docdex handles for cited docs.",
      "Epic batch context:",
      batchContext,
      "Project construction method:",
      compactBuildMethod,
      `Docs: ${compactDocSummary}`,
    ].join("\n\n");
  }

  private buildStoryGenerationChunks(
    projectKey: string,
    epics: PlanEpic[],
    docSummary: string,
    projectBuildMethod: string,
  ): Array<Array<PlanEpic>> {
    const chunks: Array<Array<PlanEpic>> = [];
    let current: Array<PlanEpic> = [];
    for (const epic of epics) {
      const candidate = [...current, epic];
      const promptTokens = estimateTokens(
        this.buildStoriesBatchPrompt(projectKey, candidate, docSummary, projectBuildMethod),
      );
      if (
        current.length > 0 &&
        (candidate.length > STRICT_AGENT_MAX_EPICS_PER_STORY_BATCH ||
          promptTokens > STRICT_AGENT_STORY_BATCH_PROMPT_TOKEN_LIMIT)
      ) {
        chunks.push(current);
        current = [epic];
        continue;
      }
      current = candidate;
    }
    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  private async generateStoriesForEpicBatch(
    agent: Agent,
    projectKey: string,
    epics: PlanEpic[],
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<Map<string, AgentStoryNode[]>> {
    const epicIds = epics.map((epic) => epic.localId ?? "TBD");
    const prompt = this.buildStoriesBatchPrompt(projectKey, epics, docSummary, projectBuildMethod);
    const { output } = await this.invokeAgentWithRetry(
      agent,
      prompt,
      "stories_batch",
      stream,
      jobId,
      commandRunId,
      {
        epicKeys: epicIds,
        timeoutMs: this.resolveStrictBatchTimeoutMs("stories_batch", epics.length),
      },
    );
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.epicStories) || parsed.epicStories.length === 0) {
      throw new Error(`Agent did not return batched stories for epics ${epicIds.join(", ")}`);
    }
    const storyMap = new Map<string, AgentStoryNode[]>();
    for (const entry of parsed.epicStories as any[]) {
      const epicLocalId = typeof entry?.epicLocalId === "string" ? entry.epicLocalId.trim() : "";
      if (!epicLocalId || !epicIds.includes(epicLocalId)) {
        throw new Error(`Agent returned stories for an unexpected epicLocalId in batch ${epicIds.join(", ")}`);
      }
      if (!Array.isArray(entry.stories) || entry.stories.length === 0) {
        throw new Error(`Agent returned no stories for epic ${epicLocalId} in batch mode`);
      }
      storyMap.set(
        epicLocalId,
        entry.stories
          .map((story: any, idx: number) => this.normalizeAgentStoryNode(story, idx))
          .filter((story: AgentStoryNode) => story.title),
      );
    }
    for (const epicId of epicIds) {
      if (!storyMap.has(epicId)) {
        throw new Error(`Agent omitted stories for epic ${epicId} in batch mode`);
      }
    }
    return storyMap;
  }

  private buildTasksBatchPrompt(
    projectKey: string,
    entries: Array<{ epic: PlanEpic; story: PlanStory }>,
    docSummary: string,
    projectBuildMethod: string,
  ): string {
    const compactDocSummary = compactPromptContext(
      docSummary,
      STRICT_AGENT_BATCH_DOC_SUMMARY_TOKEN_LIMIT,
      "none",
    );
    const compactBuildMethod = compactPromptContext(
      projectBuildMethod,
      STRICT_AGENT_BATCH_BUILD_METHOD_TOKEN_LIMIT,
      "none",
    );
    const batchContext = JSON.stringify(
      {
        stories: entries.map(({ epic, story }) => ({
          epicLocalId: epic.localId ?? story.epicLocalId ?? "TBD",
          epicTitle: epic.title,
          storyLocalId: story.localId ?? "TBD",
          storyTitle: story.title,
          userStory: story.userStory ?? null,
          description: story.description ?? null,
          acceptanceCriteria: story.acceptanceCriteria ?? [],
          relatedDocs: story.relatedDocs ?? [],
          priorityHint: story.priorityHint ?? null,
        })),
      },
      null,
      2,
    );
    return [
      this.buildCreateTasksAgentMission(projectKey),
      `Generate tasks for ${entries.length} story/stories in one batch (phase 3 of 3).`,
      "This phase is tasks-only for the supplied stories.",
      "Return JSON only matching:",
      TASKS_BATCH_SCHEMA_SNIPPET,
      "Batch rules:",
      "- Return one storyTasks entry per supplied storyLocalId, exactly once.",
      "- Each task must be concrete, dependency-ordered, story-scoped, and sufficient to finish the story.",
      "- Every schema field must be present; use null or [] when unknown.",
      "- Include real file targets, test arrays, and qa payloads when applicable; avoid placeholders and meta-only tasks.",
      "- Keep dependencies inside the same story and preserve canonical documented names.",
      "Story batch context:",
      batchContext,
      "Project construction method:",
      compactBuildMethod,
      `Docs: ${compactDocSummary}`,
    ].join("\n\n");
  }

  private buildTaskGenerationChunks(
    projectKey: string,
    entries: Array<{ epic: PlanEpic; story: PlanStory }>,
    docSummary: string,
    projectBuildMethod: string,
  ): Array<Array<{ epic: PlanEpic; story: PlanStory }>> {
    const chunks: Array<Array<{ epic: PlanEpic; story: PlanStory }>> = [];
    let current: Array<{ epic: PlanEpic; story: PlanStory }> = [];
    for (const entry of entries) {
      const candidate = [...current, entry];
      const promptTokens = estimateTokens(
        this.buildTasksBatchPrompt(projectKey, candidate, docSummary, projectBuildMethod),
      );
      if (
        current.length > 0 &&
        (candidate.length > STRICT_AGENT_MAX_STORIES_PER_TASK_BATCH ||
          promptTokens > STRICT_AGENT_TASK_BATCH_PROMPT_TOKEN_LIMIT)
      ) {
        chunks.push(current);
        current = [entry];
        continue;
      }
      current = candidate;
    }
    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  private async generateTasksForStoryBatch(
    agent: Agent,
    projectKey: string,
    entries: Array<{ epic: PlanEpic; story: PlanStory }>,
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<Map<string, AgentTaskNode[]>> {
    const storyIds = entries.map(({ story }) => story.localId ?? "TBD");
    const prompt = this.buildTasksBatchPrompt(projectKey, entries, docSummary, projectBuildMethod);
    const { output } = await this.invokeAgentWithRetry(
      agent,
      prompt,
      "tasks_batch",
      stream,
      jobId,
      commandRunId,
      {
        storyKeys: storyIds,
        timeoutMs: this.resolveStrictBatchTimeoutMs("tasks_batch", entries.length),
      },
    );
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.storyTasks) || parsed.storyTasks.length === 0) {
      throw new Error(`Agent did not return batched tasks for stories ${storyIds.join(", ")}`);
    }
    const taskMap = new Map<string, AgentTaskNode[]>();
    for (const entry of parsed.storyTasks as any[]) {
      const epicLocalId = typeof entry?.epicLocalId === "string" ? entry.epicLocalId.trim() : "";
      const storyLocalId = typeof entry?.storyLocalId === "string" ? entry.storyLocalId.trim() : "";
      const scope = this.storyScopeKey(epicLocalId, storyLocalId);
      if (!epicLocalId || !storyLocalId || !Array.isArray(entry.tasks) || entry.tasks.length === 0) {
        throw new Error(`Agent returned an incomplete batched task entry for stories ${storyIds.join(", ")}`);
      }
      if (!entries.some(({ epic, story }) => epic.localId === epicLocalId && story.localId === storyLocalId)) {
        throw new Error(`Agent returned tasks for an unexpected story scope ${scope} in batch mode`);
      }
      taskMap.set(
        scope,
        entry.tasks
          .map((task: any, idx: number) => this.normalizeAgentTaskNode(task, idx))
          .filter((task: AgentTaskNode) => task.title),
      );
    }
    for (const { epic, story } of entries) {
      const scope = this.storyScopeKey(epic.localId ?? story.epicLocalId ?? "TBD", story.localId ?? "TBD");
      if (!taskMap.has(scope)) {
        throw new Error(`Agent omitted tasks for story scope ${scope} in batch mode`);
      }
    }
    return taskMap;
  }

  private splitChunkInHalf<T>(items: T[]): [T[], T[]] {
    const midpoint = Math.ceil(items.length / 2);
    return [items.slice(0, midpoint), items.slice(midpoint)];
  }

  private async collectStrictStoriesChunk(
    agent: Agent,
    projectKey: string,
    chunk: Array<PlanEpic>,
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    storiesByEpic: Map<string, AgentStoryNode[]>,
  ): Promise<void> {
    if (chunk.length === 1) {
      const epic = chunk[0]!;
      let stories: AgentStoryNode[];
      try {
        stories = await this.generateStoriesForEpic(
          agent,
          projectKey,
          { ...epic, key: epic.localId },
          docSummary,
          projectBuildMethod,
          stream,
          jobId,
          commandRunId,
        );
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        if (this.isAgentTimeoutLikeError(error)) {
          await this.jobService.appendLog(
            jobId,
            `Story generation timed out for epic "${epic.title}". Using deterministic fallback story without a second repair attempt.\n`,
          );
          stories = [this.buildFallbackStoryForEpic(epic)];
          storiesByEpic.set(epic.localId, stories);
          return;
        }
        await this.jobService.appendLog(
          jobId,
          `Story generation failed for epic "${epic.title}". Retrying through strict staged recovery. Reason: ${message}\n`,
        );
        try {
          stories = await this.repairStoriesForEpic(
            agent,
            projectKey,
            { ...epic, key: epic.localId },
            docSummary,
            projectBuildMethod,
            message,
            [this.buildFallbackStoryForEpic(epic)],
            stream,
            jobId,
            commandRunId,
          );
        } catch (repairError) {
          const repairMessage = (repairError as Error).message ?? String(repairError);
          await this.jobService.appendLog(
            jobId,
            `Strict story repair failed for epic "${epic.title}". Using deterministic fallback story and continuing. Reason: ${repairMessage}\n`,
          );
          stories = [this.buildFallbackStoryForEpic(epic)];
        }
        if (stories.length === 0) {
          await this.jobService.appendLog(
            jobId,
            `Strict story repair returned no stories for epic "${epic.title}". Using deterministic fallback story and continuing.\n`,
          );
          stories = [this.buildFallbackStoryForEpic(epic)];
        }
      }
      if (stories.length === 0) {
        await this.jobService.appendLog(
          jobId,
          `Story generation returned no stories for epic "${epic.title}". Retrying through strict staged recovery.\n`,
        );
        try {
          stories = await this.repairStoriesForEpic(
            agent,
            projectKey,
            { ...epic, key: epic.localId },
            docSummary,
            projectBuildMethod,
            `No stories were returned for epic ${epic.title}.`,
            [this.buildFallbackStoryForEpic(epic)],
            stream,
            jobId,
            commandRunId,
          );
        } catch (repairError) {
          const repairMessage = (repairError as Error).message ?? String(repairError);
          await this.jobService.appendLog(
            jobId,
            `Strict story repair failed for epic "${epic.title}" after empty output. Using deterministic fallback story and continuing. Reason: ${repairMessage}\n`,
          );
          stories = [this.buildFallbackStoryForEpic(epic)];
        }
        if (stories.length === 0) {
          await this.jobService.appendLog(
            jobId,
            `Strict story repair returned no stories for epic "${epic.title}" after empty output. Using deterministic fallback story and continuing.\n`,
          );
          stories = [this.buildFallbackStoryForEpic(epic)];
        }
      }
      storiesByEpic.set(epic.localId, stories);
      return;
    }
    try {
      const batchStories = await this.generateStoriesForEpicBatch(
        agent,
        projectKey,
        chunk.map((epic) => ({ ...epic, key: epic.localId })),
        docSummary,
        projectBuildMethod,
        false,
        jobId,
        commandRunId,
      );
      for (const epic of chunk) {
        storiesByEpic.set(epic.localId, batchStories.get(epic.localId) ?? []);
      }
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const epicLabels = chunk.map((epic) => epic.localId).join(", ");
      await this.jobService.appendLog(
        jobId,
        `Batched story generation failed for epic chunk [${epicLabels}]. Splitting chunk for strict recovery. Reason: ${message}\n`,
      );
      const [left, right] = this.splitChunkInHalf(chunk);
      await this.collectStrictStoriesChunk(
        agent,
        projectKey,
        left,
        docSummary,
        projectBuildMethod,
        stream,
        jobId,
        commandRunId,
        storiesByEpic,
      );
      if (right.length > 0) {
        await this.collectStrictStoriesChunk(
          agent,
          projectKey,
          right,
          docSummary,
          projectBuildMethod,
          stream,
          jobId,
          commandRunId,
          storiesByEpic,
        );
      }
    }
  }

  private async collectStrictTasksChunk(
    agent: Agent,
    projectKey: string,
    chunk: Array<{ epic: PlanEpic; story: PlanStory }>,
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    epicTitleByLocalId: Map<string, string>,
    tasksByStoryScope: Map<string, AgentTaskNode[]>,
    options?: { compactSingleStorySchema?: boolean },
  ): Promise<void> {
    if (chunk.length === 1) {
      const { epic, story } = chunk[0]!;
      const storyScope = this.storyScopeKey(story.epicLocalId, story.localId);
      const fallbackTasks = this.buildFallbackTasksForStory(story);
      let tasks: AgentTaskNode[];
      try {
        tasks = await this.generateTasksForStory(
          agent,
          projectKey,
          { key: epic.localId, title: epicTitleByLocalId.get(epic.localId) ?? epic.title },
          { ...story, key: story.localId },
          docSummary,
          projectBuildMethod,
          stream,
          jobId,
          commandRunId,
          { compactSchema: options?.compactSingleStorySchema === true },
        );
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        if (this.isAgentTimeoutLikeError(error)) {
          await this.jobService.appendLog(
            jobId,
            `Task generation timed out for story "${story.title}" (${storyScope}). Retrying through strict staged recovery before deterministic fallback.\n`,
          );
          try {
            tasks = await this.repairTasksForStory(
              agent,
              projectKey,
              { key: epic.localId, title: epicTitleByLocalId.get(epic.localId) ?? epic.title },
              { ...story, key: story.localId },
              docSummary,
              projectBuildMethod,
              message,
              fallbackTasks,
              stream,
              jobId,
              commandRunId,
              { compactSchema: options?.compactSingleStorySchema === true },
            );
          } catch (repairError) {
            const repairMessage = (repairError as Error).message ?? String(repairError);
            await this.jobService.appendLog(
              jobId,
              `Strict task repair failed for story "${story.title}" (${storyScope}) after timeout. Using deterministic fallback tasks and continuing. Reason: ${repairMessage}\n`,
            );
            tasks = fallbackTasks;
          }
          tasksByStoryScope.set(storyScope, tasks);
          return;
        }
        await this.jobService.appendLog(
          jobId,
          `Task generation failed for story "${story.title}" (${storyScope}). Retrying through strict staged recovery. Reason: ${message}\n`,
        );
        try {
          tasks = await this.repairTasksForStory(
            agent,
            projectKey,
            { key: epic.localId, title: epicTitleByLocalId.get(epic.localId) ?? epic.title },
            { ...story, key: story.localId },
            docSummary,
            projectBuildMethod,
            message,
            fallbackTasks,
            stream,
            jobId,
            commandRunId,
            { compactSchema: options?.compactSingleStorySchema === true },
          );
        } catch (repairError) {
          const repairMessage = (repairError as Error).message ?? String(repairError);
          await this.jobService.appendLog(
            jobId,
            `Strict task repair failed for story "${story.title}" (${storyScope}). Using deterministic fallback tasks and continuing. Reason: ${repairMessage}\n`,
          );
          tasks = fallbackTasks;
        }
        if (tasks.length === 0) {
          await this.jobService.appendLog(
            jobId,
            `Strict task repair returned no tasks for story "${story.title}" (${storyScope}). Using deterministic fallback tasks and continuing.\n`,
          );
          tasks = fallbackTasks;
        }
      }
      if (tasks.length === 0) {
        await this.jobService.appendLog(
          jobId,
          `Task generation returned no tasks for story "${story.title}" (${storyScope}). Retrying through strict staged recovery.\n`,
        );
        try {
          tasks = await this.repairTasksForStory(
            agent,
            projectKey,
            { key: epic.localId, title: epicTitleByLocalId.get(epic.localId) ?? epic.title },
            { ...story, key: story.localId },
            docSummary,
            projectBuildMethod,
            `No tasks were returned for story ${story.title}.`,
            fallbackTasks,
            stream,
            jobId,
            commandRunId,
            { compactSchema: options?.compactSingleStorySchema === true },
          );
        } catch (repairError) {
          const repairMessage = (repairError as Error).message ?? String(repairError);
          await this.jobService.appendLog(
            jobId,
            `Strict task repair failed for story "${story.title}" (${storyScope}) after empty output. Using deterministic fallback tasks and continuing. Reason: ${repairMessage}\n`,
          );
          tasks = fallbackTasks;
        }
        if (tasks.length === 0) {
          await this.jobService.appendLog(
            jobId,
            `Strict task repair returned no tasks for story "${story.title}" (${storyScope}) after empty output. Using deterministic fallback tasks and continuing.\n`,
          );
          tasks = fallbackTasks;
        }
      }
      tasksByStoryScope.set(storyScope, tasks);
      return;
    }
    try {
      const batchTasks = await this.generateTasksForStoryBatch(
        agent,
        projectKey,
        chunk,
        docSummary,
        projectBuildMethod,
        false,
        jobId,
        commandRunId,
      );
      for (const { story } of chunk) {
        tasksByStoryScope.set(
          this.storyScopeKey(story.epicLocalId, story.localId),
          batchTasks.get(this.storyScopeKey(story.epicLocalId, story.localId)) ?? [],
        );
      }
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const storyLabels = chunk.map(({ story }) => this.storyScopeKey(story.epicLocalId, story.localId)).join(", ");
      await this.jobService.appendLog(
        jobId,
        `Batched task generation failed for story chunk [${storyLabels}]. Splitting chunk for strict recovery. Reason: ${message}\n`,
      );
      const [left, right] = this.splitChunkInHalf(chunk);
      await this.collectStrictTasksChunk(
        agent,
        projectKey,
        left,
        docSummary,
        projectBuildMethod,
        stream,
        jobId,
        commandRunId,
        epicTitleByLocalId,
        tasksByStoryScope,
        options,
      );
      if (right.length > 0) {
        await this.collectStrictTasksChunk(
          agent,
          projectKey,
          right,
          docSummary,
          projectBuildMethod,
          stream,
          jobId,
          commandRunId,
          epicTitleByLocalId,
          tasksByStoryScope,
          options,
        );
      }
    }
  }

  private async generateStoriesForEpic(
    agent: Agent,
    projectKey: string,
    epic: AgentEpicNode & { key?: string },
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<AgentStoryNode[]> {
    const compactBuildMethod = compactPromptContext(
      projectBuildMethod,
      STRICT_AGENT_SINGLE_STORY_BUILD_METHOD_TOKEN_LIMIT,
      "none",
    );
    const compactDocSummary = compactPromptContext(
      docSummary,
      STRICT_AGENT_SINGLE_STORY_DOC_SUMMARY_TOKEN_LIMIT,
      "none",
    );
    const prompt = [
      this.buildCreateTasksAgentMission(projectKey),
      `Generate user stories for epic "${epic.title}" (phase 2 of 3).`,
      "This phase is stories-only. Do not generate tasks yet.",
      "Return JSON only matching:",
      STORY_SCHEMA_SNIPPET,
      "Rules:",
      "- No tasks in this step.",
      "- Every property shown in the schema must be present. Use null for unknown scalar fields and [] for empty arrays.",
      "- acceptanceCriteria must be an array of strings.",
      "- Use docdex handles when citing docs.",
      "- Keep stories direct and implementation-oriented; avoid placeholder-only narrative sections.",
      "- Define the minimum set of user stories that, when completed, will finish this epic according to the SDS and construction method.",
      "- Keep story sequencing aligned with the project construction method.",
      "- Preserve canonical documented names for modules, services, interfaces, commands, schemas, and files exactly as written.",
      `Epic context (key=${epic.key ?? epic.localId ?? "TBD"}):`,
      epic.description ?? "(no description provided)",
      `Epic serviceIds: ${(epic.serviceIds ?? []).join(", ") || "(not provided)"}`,
      `Epic tags: ${(epic.tags ?? []).join(", ") || "(none)"}`,
      "Project construction method:",
      compactBuildMethod,
      `Docs: ${compactDocSummary}`,
    ].join("\n\n");
    const { output } = await this.invokeAgentWithRetry(agent, prompt, "stories", stream, jobId, commandRunId, {
      epicKey: epic.key ?? epic.localId,
      timeoutMs: this.resolveStrictBatchTimeoutMs("stories_batch", 1),
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.stories) || parsed.stories.length === 0) {
      throw new Error(`Agent did not return stories for epic ${epic.title}`);
    }
    return parsed.stories
      .map((story: any, idx: number) => this.normalizeAgentStoryNode(story, idx))
      .filter((s: AgentStoryNode) => s.title);
  }

  private async generateTasksForStory(
    agent: Agent,
    projectKey: string,
    epic: { key?: string; title: string },
    story: AgentStoryNode & { key?: string },
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    options?: { compactSchema?: boolean },
  ): Promise<AgentTaskNode[]> {
    const compactSchema = options?.compactSchema === true;
    const seedTasks = this.buildFallbackTasksForStory(story);
    const compactBuildMethod = compactPromptContext(
      projectBuildMethod,
      compactSchema ? 220 : STRICT_AGENT_SINGLE_TASK_BUILD_METHOD_TOKEN_LIMIT,
      "none",
    );
    const compactDocSummary = compactPromptContext(
      docSummary,
      compactSchema ? 180 : STRICT_AGENT_SINGLE_TASK_DOC_SUMMARY_TOKEN_LIMIT,
      "none",
    );
    if (compactSchema) {
      return this.executeCompactTaskRewrite(
        agent,
        projectKey,
        epic,
        story,
        compactDocSummary,
        compactBuildMethod,
        seedTasks,
        stream,
        jobId,
        commandRunId,
      );
    }
    const prompt = compactSchema
      ? ""
      : [
          this.buildCreateTasksAgentMission(projectKey),
          `Generate tasks for story "${story.title}" (Epic: ${epic.title}, phase 3 of 3).`,
          "This phase is tasks-only for the given story.",
          "Return JSON only matching:",
          TASK_SCHEMA_SNIPPET,
          "Rules:",
          "- Every property shown in the schema must be present. Use null for unknown scalar fields and [] for empty arrays.",
          "- Do not narrate your work, preface the answer, explain your reasoning, or emit progress updates. Return the final JSON object immediately.",
          "- Each task must include localId, title, description, type, estimatedStoryPoints, priorityHint, files, all test arrays, and qa.",
          "- Descriptions must be implementation-concrete and include target modules/files/services where work happens.",
          "- Each task should include files with repo-relative file or directory targets whenever the docs or story context identify them.",
          "- Do not return only root-level placeholders like src/ or packages/ when a deeper runtime, interface, test, or ops target is available.",
          "- Prioritize software construction tasks before test-only/docs-only chores unless story scope explicitly requires those first.",
          "- Include test arrays: unitTests, componentTests, integrationTests, apiTests. Use [] when not applicable.",
          "- Only include tests that are relevant to the task's scope.",
          "- Prefer including task-relevant tests when they are concrete and actionable; do not invent generic placeholders.",
          "- Include qa object with profiles_expected, requires, entrypoints, data_setup, blockers, and notes. Use [] or null when not applicable.",
          "- Do not hardcode ports. For QA entrypoints, use http://localhost:<PORT> placeholders or omit base_url when unknown.",
          "- dependsOnKeys must reference localIds in this story.",
          "- If dependsOnKeys is non-empty, include dependency rationale in the task description.",
          "- Start from prerequisite codebase setup: add structure/bootstrap tasks before feature tasks when missing.",
          "- Keep dependencies strictly inside this story; never reference tasks from other stories/epics.",
          "- Order tasks from foundational prerequisites to dependents based on documented dependency direction and startup constraints.",
          "- Generate the concrete work that would actually complete this story in one automated backlog pass; do not leave implied implementation gaps behind.",
          "- Avoid placeholder wording (TBD, TODO, to be defined, generic follow-up phrases).",
          "- Avoid documentation-only or glossary-only tasks unless story acceptance explicitly requires them.",
          "- Preserve canonical documented names for modules, services, interfaces, commands, schemas, and files exactly as written.",
          "- Use docdex handles when citing docs.",
          "- If OPENAPI_HINTS are present in Docs, align tasks with hinted service/capability/stage/test_requirements.",
          "- If SDS_COVERAGE_HINTS are present in Docs, cover the relevant SDS sections in implementation tasks.",
          "- Follow the project construction method and startup-wave order from SDS when available.",
          `Story context (key=${story.key ?? story.localId ?? "TBD"}):`,
          story.description ?? story.userStory ?? "",
          `Acceptance criteria: ${(story.acceptanceCriteria ?? []).join("; ")}`,
          "Project construction method:",
          compactBuildMethod,
          `Docs: ${compactDocSummary}`,
        ].join("\n\n");
    const action = "tasks";
    const taskStream = stream;
    const { output } = await this.invokeAgentWithRetry(agent, prompt, action, taskStream, jobId, commandRunId, {
      epicKey: epic.key,
      storyKey: story.key ?? story.localId,
      timeoutMs: this.resolveStrictBatchTimeoutMs("tasks_batch", 1),
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new Error(`Agent did not return tasks for story ${story.title}`);
    }
    const normalizedTasks = parsed.tasks
      .map((task: any, idx: number) => this.normalizeAgentTaskNode(task, idx))
      .filter((t: AgentTaskNode) => t.title);
    return compactSchema ? this.mergeCompactTaskMetadata(normalizedTasks, seedTasks) : normalizedTasks;
  }

  private async repairStoriesForEpic(
    agent: Agent,
    projectKey: string,
    epic: AgentEpicNode & { key?: string },
    docSummary: string,
    projectBuildMethod: string,
    reason: string,
    seedStories: AgentStoryNode[],
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<AgentStoryNode[]> {
    const compactBuildMethod = compactPromptContext(
      projectBuildMethod,
      STRICT_AGENT_SINGLE_STORY_BUILD_METHOD_TOKEN_LIMIT,
      "none",
    );
    const compactDocSummary = compactPromptContext(
      docSummary,
      STRICT_AGENT_SINGLE_STORY_DOC_SUMMARY_TOKEN_LIMIT,
      "none",
    );
    const prompt = [
      this.buildCreateTasksAgentMission(projectKey),
      `Repair story generation for epic "${epic.title}". The previous attempt failed or returned no stories.`,
      "Return JSON only matching:",
      STORY_SCHEMA_SNIPPET,
      "Repair rules:",
      "- Return stories only for this epic.",
      "- The final stories must be agent-authored. The seed JSON below is scaffolding for recovery, not the accepted answer.",
      "- Every property shown in the schema must be present. Use null for unknown scalar fields and [] for empty arrays.",
      "- Keep stories implementation-oriented and sufficient to complete the epic according to the SDS and project construction method.",
      "- Preserve canonical documented names for modules, services, interfaces, commands, schemas, and files exactly as written.",
      `Previous failure: ${reason}`,
      `Epic context (key=${epic.key ?? epic.localId ?? "TBD"}):`,
      epic.description ?? "(no description provided)",
      `Epic serviceIds: ${(epic.serviceIds ?? []).join(", ") || "(not provided)"}`,
      "Project construction method:",
      compactBuildMethod,
      "Seed stories for repair context only:",
      JSON.stringify({ stories: seedStories }, null, 2),
      `Docs: ${compactDocSummary}`,
    ].join("\n\n");
    const { output } = await this.invokeAgentWithRetry(agent, prompt, "stories", stream, jobId, commandRunId, {
      epicKey: epic.key ?? epic.localId,
      strictAgentMode: true,
      repairStage: "stories",
      timeoutMs: this.resolveStrictBatchTimeoutMs("stories_batch", 1),
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.stories) || parsed.stories.length === 0) {
      throw new Error(`Agent did not return repair stories for epic ${epic.title}`);
    }
    return parsed.stories
      .map((story: any, idx: number) => this.normalizeAgentStoryNode(story, idx))
      .filter((story: AgentStoryNode) => story.title);
  }

  private async repairTasksForStory(
    agent: Agent,
    projectKey: string,
    epic: { key?: string; title: string },
    story: AgentStoryNode & { key?: string },
    docSummary: string,
    projectBuildMethod: string,
    reason: string,
    seedTasks: AgentTaskNode[],
    stream: boolean,
    jobId: string,
    commandRunId: string,
    options?: { compactSchema?: boolean },
  ): Promise<AgentTaskNode[]> {
    const compactSchema = options?.compactSchema === true;
    const compactBuildMethod = compactPromptContext(
      projectBuildMethod,
      compactSchema ? 220 : STRICT_AGENT_SINGLE_TASK_BUILD_METHOD_TOKEN_LIMIT,
      "none",
    );
    const compactDocSummary = compactPromptContext(
      docSummary,
      compactSchema ? 180 : STRICT_AGENT_SINGLE_TASK_DOC_SUMMARY_TOKEN_LIMIT,
      "none",
    );
    if (compactSchema) {
      return this.executeCompactTaskRewrite(
        agent,
        projectKey,
        epic,
        story,
        compactDocSummary,
        compactBuildMethod,
        seedTasks,
        stream,
        jobId,
        commandRunId,
        reason,
      );
    }
    const prompt = compactSchema
      ? ""
      : [
          this.buildCreateTasksAgentMission(projectKey),
          `Repair task generation for story "${story.title}" (Epic: ${epic.title}). The previous attempt failed or returned no tasks.`,
          "Return JSON only matching:",
          TASK_SCHEMA_SNIPPET,
          "Repair rules:",
          "- Return tasks only for this story.",
          "- The final tasks must be agent-authored. The seed JSON below is scaffolding for recovery, not the accepted answer.",
          "- Every property shown in the schema must be present. Use null for unknown scalar fields and [] for empty arrays.",
          "- Do not narrate your work, preface the answer, explain your reasoning, or emit progress updates. Return the final JSON object immediately.",
          "- Keep tasks implementation-concrete, scoped to this story, and sufficient to complete the story in dependency order.",
          "- Each task must include files plus unit/component/integration/api test arrays and qa.",
          "- Preserve canonical documented names for modules, services, interfaces, commands, schemas, and files exactly as written.",
          `Previous failure: ${reason}`,
          `Story context (key=${story.key ?? story.localId ?? "TBD"}):`,
          story.description ?? story.userStory ?? "",
          `Acceptance criteria: ${(story.acceptanceCriteria ?? []).join("; ")}`,
          "Project construction method:",
          compactBuildMethod,
          "Seed tasks for repair context only:",
          JSON.stringify({ tasks: seedTasks }, null, 2),
          `Docs: ${compactDocSummary}`,
        ].join("\n\n");
    const action = "tasks";
    const taskStream = stream;
    const { output } = await this.invokeAgentWithRetry(agent, prompt, action, taskStream, jobId, commandRunId, {
      epicKey: epic.key,
      storyKey: story.key ?? story.localId,
      strictAgentMode: true,
      repairStage: "tasks",
      timeoutMs: this.resolveStrictBatchTimeoutMs("tasks_batch", 1),
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new Error(`Agent did not return repair tasks for story ${story.title}`);
    }
    const normalizedTasks = parsed.tasks
      .map((task: any, idx: number) => this.normalizeAgentTaskNode(task, idx))
      .filter((task: AgentTaskNode) => task.title);
    return compactSchema ? this.mergeCompactTaskMetadata(normalizedTasks, seedTasks) : normalizedTasks;
  }

  private splitCompactTaskRewriteChunks(seedTasks: AgentTaskNode[]): AgentTaskNode[][] {
    if (seedTasks.length <= STRICT_AGENT_MAX_TASKS_PER_COMPACT_REWRITE) {
      return [seedTasks];
    }
    const chunks: AgentTaskNode[][] = [];
    for (let index = 0; index < seedTasks.length; index += STRICT_AGENT_MAX_TASKS_PER_COMPACT_REWRITE) {
      chunks.push(seedTasks.slice(index, index + STRICT_AGENT_MAX_TASKS_PER_COMPACT_REWRITE));
    }
    return chunks;
  }

  private async executeCompactTaskRewrite(
    agent: Agent,
    projectKey: string,
    epic: { key?: string; title: string },
    story: AgentStoryNode & { key?: string },
    docSummary: string,
    projectBuildMethod: string,
    seedTasks: AgentTaskNode[],
    stream: boolean,
    jobId: string,
    commandRunId: string,
    previousFailure?: string,
  ): Promise<AgentTaskNode[]> {
    const initialChunkCount = this.splitCompactTaskRewriteChunks(seedTasks).length;
    const taskChunks = this.planCompactTaskRewriteChunks({
      projectKey,
      epic,
      story,
      docSummary,
      projectBuildMethod,
      seedTasks,
      previousFailure,
    });
    if (taskChunks.length > initialChunkCount) {
      await this.jobService.appendLog(
        jobId,
        `[create-tasks] compact task rewrite split story "${story.title}" into ${taskChunks.length} prompt-bounded chunk(s).\n`,
      );
    }
    if (taskChunks.some((chunk) => chunk.contextMode === "minimal")) {
      await this.jobService.appendLog(
        jobId,
        `[create-tasks] compact task rewrite is using reduced prompt context for story "${story.title}".\n`,
      );
    }
    const rewritten: AgentTaskNode[] = [];
    for (const [index, chunkPlan] of taskChunks.entries()) {
      const prompt = this.buildCompactSeededTaskPrompt({
        projectKey,
        epic,
        story,
        docSummary,
        projectBuildMethod,
        seedTasks: chunkPlan.seedTasks,
        previousFailure,
        chunkIndex: index,
        chunkCount: taskChunks.length,
        totalSeedTaskCount: seedTasks.length,
        contextMode: chunkPlan.contextMode,
      });
      const { output } = await this.invokeAgentWithRetry(
        agent,
        prompt,
        "tasks_compact",
        false,
        jobId,
        commandRunId,
        {
          epicKey: epic.key,
          storyKey: story.key ?? story.localId,
          strictAgentMode: true,
          repairStage: previousFailure ? "tasks" : undefined,
          taskChunkIndex: index + 1,
          taskChunkCount: taskChunks.length,
          timeoutMs: this.resolveStrictBatchTimeoutMs("tasks_batch", 1),
        },
      );
      const parsed = extractJson(output);
      if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
        throw new Error(`Agent did not return compact tasks for story ${story.title} chunk ${index + 1}`);
      }
      const normalizedTasks = parsed.tasks
        .map((task: any, taskIndex: number) => this.normalizeAgentTaskNode(task, taskIndex))
        .filter((task: AgentTaskNode) => task.title);
      rewritten.push(...this.mergeCompactTaskMetadata(normalizedTasks, chunkPlan.seedTasks));
    }
    return rewritten;
  }

  private buildFallbackStoryForEpic(epic: PlanEpic): AgentStoryNode {
    const derived = this.buildDerivedStoryForEpic(epic);
    return {
      ...derived,
      localId: "us-fallback-1",
      description: [
        `Deterministic fallback story generated because model output for epic "${epic.title}" could not be parsed reliably.`,
        derived.description,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  private buildDerivedStoryForEpic(epic: PlanEpic): AgentStoryNode {
    const criteria = epic.acceptanceCriteria?.filter(Boolean) ?? [];
    const serviceIds = (epic.serviceIds ?? []).filter(Boolean);
    return {
      localId: "us-impl-1",
      title: `Deliver ${epic.title}`,
      userStory: `As the delivery team, we need to implement ${epic.title} end to end.`,
      description: [
        epic.description?.trim() ? `Epic scope: ${epic.description.trim()}` : null,
        serviceIds.length > 0 ? `Target services: ${serviceIds.join(", ")}.` : null,
        "Translate this epic into concrete implementation, integration, and verification tasks that satisfy the documented acceptance criteria in dependency order.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      acceptanceCriteria:
        criteria.length > 0
          ? criteria
          : [
              "Story has actionable implementation tasks.",
              "Dependencies are explicit and story-scoped.",
              "Tasks are ready for execution.",
            ],
      relatedDocs: epic.relatedDocs ?? [],
      priorityHint: epic.priorityHint ?? 1,
      tasks: [],
    };
  }

  private findArchitectureUnitForEpic(
    epic: PlanEpic,
    architecture?: CanonicalArchitectureArtifact,
  ): ArchitectureUnit | undefined {
    if (!architecture) return undefined;
    const epicTitle = epic.title.trim().toLowerCase();
    const exactTitleMatch = architecture.units.find(
      (unit) => this.formatArchitectureUnitEpicTitle(unit).trim().toLowerCase() === epicTitle,
    );
    if (exactTitleMatch) return exactTitleMatch;
    const epicServiceIds = new Set(normalizeStringArray(epic.serviceIds));
    const serviceMatch = architecture.units.find((unit) =>
      unit.sourceServiceIds.some((serviceId) => epicServiceIds.has(serviceId)),
    );
    if (serviceMatch) return serviceMatch;
    return architecture.units.find((unit) => epicTitle.includes(unit.name.trim().toLowerCase()));
  }

  private buildDerivedStoriesForEpic(
    epic: PlanEpic,
    unit?: ArchitectureUnit,
    verificationSurfaceById?: Map<string, ArchitectureVerificationSurface>,
  ): AgentStoryNode[] {
    if (!unit) {
      return [this.buildDerivedStoryForEpic(epic)];
    }
    const stories: AgentStoryNode[] = [];
    const implementationTargets = uniqueStrings(unit.implementationTargets).slice(0, 6);
    const supportingTargets = uniqueStrings(unit.supportingTargets).slice(0, 6);
    const verificationTargets = uniqueStrings(unit.verificationTargets).slice(0, 6);
    const verificationSurfaces = uniqueStrings(
      unit.verificationSurfaceIds
        .map((surfaceId) => verificationSurfaceById?.get(surfaceId)?.name ?? surfaceId)
        .filter(Boolean),
    ).slice(0, 6);
    const waveLine = typeof unit.startupWave === "number" ? `Startup wave: ${unit.startupWave}.` : undefined;
    const dependencyLine =
      unit.dependsOnUnitIds.length > 0 ? `Dependencies: ${unit.dependsOnUnitIds.join(", ")}.` : undefined;
    const completionLine =
      unit.completionSignals.length > 0
        ? `Completion signals: ${unit.completionSignals.slice(0, 4).join("; ")}.`
        : undefined;
    const chunkTargets = (targets: string[], size: number): string[][] => {
      if (targets.length === 0) return [];
      const chunks: string[][] = [];
      for (let idx = 0; idx < targets.length; idx += size) {
        chunks.push(targets.slice(idx, idx + size));
      }
      return chunks;
    };
    const implementationChunks = chunkTargets(implementationTargets, 2);
    const supportingChunks = chunkTargets(supportingTargets, 2);

    if (unit.kind !== "release_gate") {
      const coreStories =
        implementationChunks.length > 0
          ? implementationChunks
          : [[]];
      for (const [idx, targetChunk] of coreStories.entries()) {
        const totalChunks = coreStories.length;
        stories.push({
          localId: `us-core-${idx + 1}`,
          title:
            totalChunks > 1
              ? `Implement ${unit.name} core targets ${idx + 1}`
              : `Implement ${unit.name} core`,
          userStory: `As the delivery team, we need the core ${unit.name} implementation in place.`,
          description: [
            `Implement the primary ${unit.name} build targets for epic "${epic.title}".`,
            targetChunk.length > 0 ? `Primary implementation targets: ${targetChunk.join(", ")}.` : undefined,
            totalChunks > 1
              ? `This story covers target group ${idx + 1} of ${totalChunks} for ${unit.name}.`
              : undefined,
            waveLine,
            dependencyLine,
            completionLine,
          ]
            .filter(Boolean)
            .join("\n"),
          acceptanceCriteria: uniqueStrings([
            targetChunk.length > 0
              ? `${unit.name} target group ${idx + 1} is created or updated.`
              : `${unit.name} core implementation exists.`,
            ...unit.completionSignals.slice(0, 2),
          ]),
          relatedDocs: epic.relatedDocs ?? [],
          priorityHint: epic.priorityHint ?? 1,
          tasks: [],
        });
      }
    }

    if (supportingTargets.length > 0 || unit.dependsOnUnitIds.length > 0) {
      const integrationStories =
        supportingChunks.length > 0
          ? supportingChunks
          : [[]];
      for (const [idx, targetChunk] of integrationStories.entries()) {
        const totalChunks = integrationStories.length;
        stories.push({
          localId: `us-integration-${idx + 1}`,
          title:
            totalChunks > 1
              ? `Integrate ${unit.name} dependencies ${idx + 1}`
              : `Integrate ${unit.name} dependencies`,
          userStory: `As the delivery team, we need ${unit.name} wired to its supporting surfaces and dependencies.`,
          description: [
            `Integrate ${unit.name} with supporting modules, contracts, and operational dependencies after the core implementation exists.`,
            targetChunk.length > 0 ? `Supporting targets: ${targetChunk.join(", ")}.` : undefined,
            totalChunks > 1
              ? `This story covers dependency/support target group ${idx + 1} of ${totalChunks}.`
              : undefined,
            dependencyLine,
            completionLine,
          ]
            .filter(Boolean)
            .join("\n"),
          acceptanceCriteria: uniqueStrings([
            `${unit.name} dependencies are wired in documented order.`,
            targetChunk.length > 0
              ? `${unit.name} supporting target group ${idx + 1} is aligned with the core implementation.`
              : `${unit.name} integration points are aligned with upstream dependencies.`,
            ...unit.completionSignals.slice(0, 2),
          ]),
          relatedDocs: epic.relatedDocs ?? [],
          priorityHint: epic.priorityHint ?? 1,
          tasks: [],
        });
      }
    }

    if (verificationTargets.length > 0 || verificationSurfaces.length > 0 || unit.kind === "release_gate") {
      stories.push({
        localId: "us-verify-1",
        title: `Validate ${unit.name} readiness`,
        userStory: `As the delivery team, we need ${unit.name} validation and readiness surfaces in place.`,
        description: [
          `Add or update the validation and readiness surfaces required for ${unit.name}.`,
          verificationTargets.length > 0 ? `Verification targets: ${verificationTargets.join(", ")}.` : undefined,
          verificationSurfaces.length > 0
            ? `Verification surfaces: ${verificationSurfaces.join(", ")}.`
            : undefined,
          completionLine,
        ]
          .filter(Boolean)
          .join("\n"),
        acceptanceCriteria: uniqueStrings([
          `${unit.name} validation surfaces cover the documented completion signals.`,
          verificationSurfaces.length > 0
            ? `${unit.name} readiness includes the required verification surfaces.`
            : `${unit.name} readiness evidence is produced where the SDS requires it.`,
          ...unit.completionSignals.slice(0, 2),
        ]),
        relatedDocs: epic.relatedDocs ?? [],
        priorityHint: epic.priorityHint ?? 1,
        tasks: [],
      });
    }

    return stories.length > 0 ? stories : [this.buildDerivedStoryForEpic(epic)];
  }

  private buildScopedTaskDocSummary(docSummary: string, epic: PlanEpic, story: PlanStory): string {
    const relatedDocs = uniqueStrings([...(epic.relatedDocs ?? []), ...(story.relatedDocs ?? [])]).slice(0, 8);
    const serviceIds = (epic.serviceIds ?? []).filter(Boolean).slice(0, 6);
    const lines: string[] = [];
    if (relatedDocs.length > 0) {
      lines.push(`Relevant doc handles: ${relatedDocs.join(", ")}`);
    }
    if (serviceIds.length > 0) {
      lines.push(`Service focus: ${serviceIds.join(", ")}`);
    }
    const compactGlobal = compactPromptContext(docSummary, 320, "");
    if (compactGlobal.trim().length > 0) {
      lines.push(compactGlobal);
    }
    return lines.join("\n").trim() || "none";
  }

  private buildScopedTaskBuildMethod(projectBuildMethod: string): string {
    return compactPromptContext(projectBuildMethod, 360, "none");
  }

  private extractStoryHintList(description: string | undefined, label: string): string[] {
    if (!description) return [];
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\n)${escapedLabel}:\\s*([^\\n]+)`, "i");
    const match = description.match(pattern);
    if (!match?.[1]) return [];
    return uniqueStrings(
      match[1]
        .split(/[,;]+/)
        .map((value) => value.trim().replace(/[.]+$/g, ""))
        .filter(Boolean),
    ).slice(0, 6);
  }

  private normalizeStoryHintFiles(values: string[]): string[] {
    return this.preferSpecificTaskTargets(
      values
        .map((value) => this.normalizeStructurePathToken(value))
        .filter((value): value is string => Boolean(value)),
    ).slice(0, 6);
  }

  private classifyDerivedStoryMode(story: { localId?: string | null; title: string }): "core" | "integration" | "verification" | "generic" {
    const localId = `${story.localId ?? ""}`.toLowerCase();
    const title = story.title.toLowerCase();
    if (localId.includes("verify") || title.startsWith("validate ")) return "verification";
    if (localId.includes("integration") || title.startsWith("integrate ")) return "integration";
    if (localId.includes("core") || title.startsWith("implement ")) return "core";
    return "generic";
  }

  private buildCompactSeededTaskPrompt(params: {
    projectKey: string;
    epic: { key?: string; title: string };
    story: AgentStoryNode & { key?: string };
    docSummary: string;
    projectBuildMethod: string;
    seedTasks: AgentTaskNode[];
    previousFailure?: string;
    chunkIndex?: number;
    chunkCount?: number;
    totalSeedTaskCount?: number;
    contextMode?: "full" | "minimal";
  }): string {
    const contextMode = params.contextMode ?? "full";
    const minimalContext = contextMode === "minimal";
    const compactSeedTasks = this.buildCompactTaskSeeds(params.seedTasks, { minimalContext });
    const chunkCount = Math.max(1, params.chunkCount ?? 1);
    const chunkIndex = Math.max(0, params.chunkIndex ?? 0);
    const totalSeedTaskCount = Math.max(compactSeedTasks.length, params.totalSeedTaskCount ?? compactSeedTasks.length);
    const chunkLocalIds = compactSeedTasks.map((task) => `${task.localId ?? ""}`.trim()).filter(Boolean);
    const storyContext = compactPromptContext(
      params.story.description ?? params.story.userStory ?? "",
      minimalContext ? STRICT_AGENT_COMPACT_TASK_MINIMAL_STORY_TOKEN_LIMIT : STRICT_AGENT_COMPACT_TASK_FULL_STORY_TOKEN_LIMIT,
      "none",
    );
    const acceptanceContext = compactPromptContext(
      (params.story.acceptanceCriteria ?? []).slice(0, minimalContext ? 3 : 5).join("; "),
      minimalContext
        ? STRICT_AGENT_COMPACT_TASK_MINIMAL_ACCEPTANCE_TOKEN_LIMIT
        : STRICT_AGENT_COMPACT_TASK_FULL_ACCEPTANCE_TOKEN_LIMIT,
      "none",
    );
    const compactBuildMethod = compactPromptContext(
      params.projectBuildMethod,
      minimalContext ? STRICT_AGENT_COMPACT_TASK_MINIMAL_BUILD_TOKEN_LIMIT : STRICT_AGENT_COMPACT_TASK_FULL_BUILD_TOKEN_LIMIT,
      "none",
    );
    const compactDocSummary = compactPromptContext(
      params.docSummary,
      minimalContext ? STRICT_AGENT_COMPACT_TASK_MINIMAL_DOC_TOKEN_LIMIT : STRICT_AGENT_COMPACT_TASK_FULL_DOC_TOKEN_LIMIT,
      "none",
    );
    return [
      `Project ${params.projectKey}. Phase 3 compact task synthesis for story "${params.story.title}" in epic "${params.epic.title}".`,
      chunkCount > 1
        ? `This prompt covers compact task chunk ${chunkIndex + 1}/${chunkCount} for ${totalSeedTaskCount} total story tasks. Rewrite only the localIds in this chunk: ${chunkLocalIds.join(", ")}.`
        : null,
      params.previousFailure
        ? `The previous attempt failed: ${params.previousFailure}`
        : "Rewrite the provided seed tasks into the final story task list.",
      "Return strictly valid JSON only matching:",
      TASK_COMPACT_SCHEMA_SNIPPET,
      "Compact rewrite rules:",
      `- Return exactly ${compactSeedTasks.length} tasks.`,
      "- Preserve the seed task localIds and dependsOnKeys unless a direct consistency fix is required.",
      "- Keep each returned task aligned to the corresponding seed task role and execution order.",
      chunkCount > 1
        ? "- Return tasks only for the chunk localIds listed in this prompt. Preserve dependsOnKeys even when they reference earlier-chunk localIds not rewritten here."
        : null,
      "- Keep the task list scoped to this story only; do not introduce cross-story dependencies.",
      "- Improve titles, descriptions, file targets, related docs, test arrays, and story points using the story context and seed targets below.",
      "- Prefer exact repo-relative files from the seed tasks and story hints; only broaden to directories when no deeper target is known.",
      "- You do not have tool access in this subtask. Do not say you will inspect Docdex, repo files, profile memory, or any other context.",
      "- Do not narrate your work, explain your reasoning, or emit any prose outside the JSON object.",
      '- Emit the final JSON object immediately. The first character must be "{" and the last must be "}".',
      `Story context (key=${params.story.key ?? params.story.localId ?? "TBD"}):`,
      storyContext,
      `Acceptance criteria: ${acceptanceContext}`,
      "Project construction method:",
      compactBuildMethod,
      "Seed tasks to rewrite exactly:",
      JSON.stringify({ tasks: compactSeedTasks }, null, 2),
      `Docs: ${compactDocSummary}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
  }

  private buildCompactTaskSeeds(
    tasks: AgentTaskNode[],
    options?: { minimalContext?: boolean },
  ): Array<Record<string, unknown>> {
    const minimalContext = options?.minimalContext === true;
    const compactDescription = (value: string | undefined): string => {
      const collapsed = `${value ?? ""}`.replace(/\s+/g, " ").trim();
      const maxLength = minimalContext ? 160 : 280;
      if (collapsed.length <= maxLength) return collapsed;
      return `${collapsed.slice(0, maxLength - 3).replace(/[ ,;:.-]+$/g, "")}...`;
    };
    return tasks.map((task) => ({
      localId: task.localId,
      title: task.title,
      type: task.type,
      description: compactDescription(task.description),
      files: this.preferSpecificTaskTargets(normalizeStringArray(task.files)).slice(0, minimalContext ? 4 : 8),
      estimatedStoryPoints: task.estimatedStoryPoints ?? null,
      priorityHint: task.priorityHint ?? null,
      dependsOnKeys: normalizeStringArray(task.dependsOnKeys),
      relatedDocs: normalizeRelatedDocs(task.relatedDocs).slice(0, minimalContext ? 2 : 4),
      unitTests: normalizeStringArray(task.unitTests).slice(0, minimalContext ? 1 : 2),
      componentTests: normalizeStringArray(task.componentTests).slice(0, minimalContext ? 1 : 2),
      integrationTests: normalizeStringArray(task.integrationTests).slice(0, minimalContext ? 1 : 2),
      apiTests: normalizeStringArray(task.apiTests).slice(0, minimalContext ? 1 : 2),
    }));
  }

  private planCompactTaskRewriteChunks(params: {
    projectKey: string;
    epic: { key?: string; title: string };
    story: AgentStoryNode & { key?: string };
    docSummary: string;
    projectBuildMethod: string;
    seedTasks: AgentTaskNode[];
    previousFailure?: string;
  }): Array<{ seedTasks: AgentTaskNode[]; contextMode: "full" | "minimal" }> {
    const initialContextMode: "full" | "minimal" = params.previousFailure ? "minimal" : "full";
    const queue = this.splitCompactTaskRewriteChunks(params.seedTasks).map((seedChunk) => ({
      seedTasks: seedChunk,
      contextMode: initialContextMode,
    }));
    const planned: Array<{ seedTasks: AgentTaskNode[]; contextMode: "full" | "minimal" }> = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const prompt = this.buildCompactSeededTaskPrompt({
        ...params,
        seedTasks: current.seedTasks,
        chunkIndex: 0,
        chunkCount: 1,
        totalSeedTaskCount: params.seedTasks.length,
        contextMode: current.contextMode,
      });
      const promptTokens = estimateTokens(prompt);
      const promptLimit =
        current.contextMode === "minimal"
          ? STRICT_AGENT_COMPACT_TASK_MINIMAL_PROMPT_TOKEN_LIMIT
          : STRICT_AGENT_COMPACT_TASK_RUNTIME_PROMPT_TOKEN_LIMIT;
      if (promptTokens > promptLimit && current.contextMode !== "minimal") {
        queue.unshift({ seedTasks: current.seedTasks, contextMode: "minimal" });
        continue;
      }
      if (promptTokens > promptLimit && current.seedTasks.length > 1) {
        const [left, right] = this.splitChunkInHalf(current.seedTasks);
        if (right.length > 0) {
          queue.unshift(
            { seedTasks: right, contextMode: "minimal" },
            { seedTasks: left, contextMode: "minimal" },
          );
          continue;
        }
      }
      planned.push(current);
    }
    return planned;
  }

  private groupFallbackTaskTargets(targets: string[], maxGroups: number): string[][] {
    const cleaned = this.preferSpecificTaskTargets(targets).filter((value): value is string => Boolean(value));
    if (cleaned.length === 0 || maxGroups <= 0) return [];
    const groups = new Map<string, string[]>();
    for (const target of cleaned) {
      const normalized = target.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      const keyParts = isStructuredFilePath(path.basename(normalized)) ? parts.slice(0, -1) : parts;
      let key = target;
      if (keyParts.length >= 4) {
        key = keyParts.slice(0, 4).join("/");
      } else if (keyParts.length >= 3) {
        key = keyParts.slice(0, 3).join("/");
      } else if (keyParts.length >= 2) {
        key = keyParts.slice(0, 2).join("/");
      }
      const existing = groups.get(key) ?? [];
      existing.push(target);
      groups.set(key, existing);
    }
    const ordered = [...groups.values()]
      .map((group) => uniqueStrings(group))
      .sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!));
    if (ordered.length <= maxGroups) return ordered;
    const head = ordered.slice(0, Math.max(1, maxGroups - 1));
    const tail = uniqueStrings(ordered.slice(Math.max(1, maxGroups - 1)).flat());
    return [...head, tail];
  }

  private summarizeFallbackTargetGroup(targets: string[]): string {
    if (targets.length === 0) return "Target Slice";
    const titleize = (value: string): string =>
      value
        .split(/[\s._/-]+/)
        .filter(Boolean)
        .map((token) => token[0]!.toUpperCase() + token.slice(1))
        .join(" ");
    const fileNames = uniqueStrings(
      targets
        .map((target) => path.basename(target))
        .filter((value) => isStructuredFilePath(value))
        .map((value) => value.replace(/\.[^.]+$/, "")),
    );
    if (fileNames.length === 1) return titleize(fileNames[0]!);
    if (fileNames.length >= 2) return `${titleize(fileNames[0]!)} and ${titleize(fileNames[1]!)}`;
    const firstTarget = targets[0]!;
    let root = path.dirname(firstTarget);
    try {
      root = this.extractArchitectureRoot(firstTarget) ?? root;
    } catch {
      root = path.dirname(firstTarget);
    }
    const label = root.split("/").filter(Boolean).slice(-2).join(" ");
    return titleize(label || firstTarget);
  }

  private buildFallbackTestMetadata(
    storyTitle: string,
    targets: string[],
  ): Pick<AgentTaskNode, "unitTests" | "componentTests" | "integrationTests" | "apiTests"> {
    const unitTests: string[] = [];
    const componentTests: string[] = [];
    const integrationTests: string[] = [];
    const apiTests: string[] = [];
    for (const target of uniqueStrings(targets).slice(0, 4)) {
      const lower = target.toLowerCase();
      const statement = `Exercise ${target} for ${storyTitle}.`;
      if (/\b(api|rpc|gateway|provider|endpoint)\b/.test(lower)) {
        apiTests.push(statement);
      } else if (/\b(component|screen|page|view|ui)\b/.test(lower)) {
        componentTests.push(statement);
      } else if (/\b(test|spec|scenario|e2e|integration|workflow|script|runbook|deploy)\b/.test(lower)) {
        integrationTests.push(statement);
      } else {
        unitTests.push(statement);
      }
    }
    if (unitTests.length === 0 && componentTests.length === 0 && integrationTests.length === 0 && apiTests.length === 0) {
      integrationTests.push(`Execute focused readiness coverage for ${storyTitle}.`);
    }
    return { unitTests, componentTests, integrationTests, apiTests };
  }

  private mergeCompactTaskMetadata(tasks: AgentTaskNode[], seedTasks: AgentTaskNode[]): AgentTaskNode[] {
    if (tasks.length === 0 || seedTasks.length === 0) return tasks;
    const seedByLocalId = new Map(seedTasks.map((task) => [task.localId, task] as const));
    return tasks.map((task, index) => {
      const seed = (task.localId ? seedByLocalId.get(task.localId) : undefined) ?? seedTasks[index];
      if (!seed) return task;
      const mergedFiles = this.preferSpecificTaskTargets([
        ...normalizeStringArray(task.files),
        ...normalizeStringArray(seed.files),
      ]).slice(0, 8);
      const taskRelatedDocs = normalizeRelatedDocs(task.relatedDocs);
      const taskUnitTests = normalizeStringArray(task.unitTests);
      const taskComponentTests = normalizeStringArray(task.componentTests);
      const taskIntegrationTests = normalizeStringArray(task.integrationTests);
      const taskApiTests = normalizeStringArray(task.apiTests);
      return {
        ...task,
        files: mergedFiles.length > 0 ? mergedFiles : normalizeStringArray(seed.files),
        relatedDocs: taskRelatedDocs.length > 0 ? taskRelatedDocs : normalizeRelatedDocs(seed.relatedDocs),
        unitTests: taskUnitTests.length > 0 ? taskUnitTests : normalizeStringArray(seed.unitTests),
        componentTests: taskComponentTests.length > 0 ? taskComponentTests : normalizeStringArray(seed.componentTests),
        integrationTests:
          taskIntegrationTests.length > 0 ? taskIntegrationTests : normalizeStringArray(seed.integrationTests),
        apiTests: taskApiTests.length > 0 ? taskApiTests : normalizeStringArray(seed.apiTests),
      };
    });
  }

  private buildFallbackTasksForStory(
    story: Pick<PlanStory, "title" | "description" | "acceptanceCriteria" | "relatedDocs"> & { localId?: string | null },
  ): AgentTaskNode[] {
    const mode = this.classifyDerivedStoryMode(story);
    const primaryTargets = this.extractStoryHintList(story.description, "Primary implementation targets");
    const supportingTargets = this.extractStoryHintList(story.description, "Supporting targets");
    const verificationTargets = this.extractStoryHintList(story.description, "Verification targets");
    const verificationSurfaces = this.extractStoryHintList(story.description, "Verification surfaces");
    const primaryFiles = this.normalizeStoryHintFiles(primaryTargets);
    const supportingFiles = this.normalizeStoryHintFiles(supportingTargets);
    const verificationFiles = this.normalizeStoryHintFiles(verificationTargets);
    const fallbackFiles = uniqueStrings([
      ...primaryFiles,
      ...supportingFiles,
      ...verificationFiles,
      ...this.normalizeTaskFiles({
        files: [],
        description: story.description ?? "",
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      }),
    ]).slice(0, 6);
    const criteriaLines = (story.acceptanceCriteria ?? [])
      .slice(0, 6)
      .map((criterion) => `- ${criterion}`)
      .join("\n");
    const objectiveLine =
      story.description && story.description.trim().length > 0
        ? story.description.trim().split(/\r?\n/)[0]
        : `Deliver story scope for "${story.title}".`;
    const primaryLine =
      primaryTargets.length > 0 ? `Primary targets: ${primaryTargets.join(", ")}.` : "Primary targets: use the story's core implementation surface.";
    const supportingLine =
      supportingTargets.length > 0
        ? `Supporting targets: ${supportingTargets.join(", ")}.`
        : "Supporting targets: align dependent modules, contracts, and runtime wiring surfaced by the story.";
    const verificationLine =
      verificationTargets.length > 0
        ? `Verification targets: ${verificationTargets.join(", ")}.`
        : verificationSurfaces.length > 0
          ? `Verification surfaces: ${verificationSurfaces.join(", ")}.`
          : "Verification targets: validate the completed story through its documented readiness surface.";
    const defaultCoreFiles = primaryFiles.length > 0 ? primaryFiles : fallbackFiles;
    const defaultSupportingFiles =
      supportingFiles.length > 0 ? supportingFiles : defaultCoreFiles.length > 0 ? defaultCoreFiles : fallbackFiles;
    const defaultVerificationFiles =
      verificationFiles.length > 0
        ? verificationFiles
        : defaultSupportingFiles.length > 0
          ? defaultSupportingFiles
          : fallbackFiles;
    const taskGroups: Array<{
      kind: "primary" | "supporting" | "verification";
      files: string[];
    }> = [];
    const pushGroups = (kind: "primary" | "supporting" | "verification", groups: string[][]): void => {
      for (const files of groups) {
        if (files.length > 0) taskGroups.push({ kind, files });
      }
    };
    const verificationSeedFiles =
      defaultVerificationFiles.length > 0 ? defaultVerificationFiles : uniqueStrings([...defaultSupportingFiles, ...defaultCoreFiles]);
    if (mode === "verification") {
      pushGroups("primary", this.groupFallbackTaskTargets(verificationSeedFiles, 2));
      pushGroups("supporting", this.groupFallbackTaskTargets(defaultSupportingFiles, 1));
    } else if (mode === "integration") {
      pushGroups("primary", this.groupFallbackTaskTargets(defaultSupportingFiles, 2));
      pushGroups("supporting", this.groupFallbackTaskTargets(uniqueStrings([...defaultCoreFiles, ...defaultSupportingFiles]), 1));
    } else {
      pushGroups("primary", this.groupFallbackTaskTargets(defaultCoreFiles, 2));
      pushGroups("supporting", this.groupFallbackTaskTargets(defaultSupportingFiles, 2));
    }
    pushGroups("verification", this.groupFallbackTaskTargets(verificationSeedFiles, mode === "verification" ? 1 : 2));
    if (taskGroups.length === 0) {
      taskGroups.push({ kind: "primary", files: fallbackFiles.slice(0, 3) });
      taskGroups.push({ kind: "verification", files: fallbackFiles.slice(0, 3) });
    }
    const dedupedGroups: Array<{ kind: "primary" | "supporting" | "verification"; files: string[] }> = [];
    const seenGroupKeys = new Set<string>();
    for (const group of taskGroups) {
      const key = `${group.kind}:${group.files.join("|")}`;
      if (seenGroupKeys.has(key)) continue;
      seenGroupKeys.add(key);
      dedupedGroups.push(group);
    }
    const boundedGroups = this.boundFallbackTaskGroups(dedupedGroups, mode);
    return boundedGroups.map((group, index) => {
      const label = this.summarizeFallbackTargetGroup(group.files);
      const dependsOnKeys = index > 0 ? [`t-fallback-${index}`] : [];
      const acceptanceBlock =
        index === 0 && criteriaLines ? `Acceptance criteria to satisfy:\n${criteriaLines}` : "Acceptance criteria: use story definition.";
      if (group.kind === "primary") {
        return {
          localId: `t-fallback-${index + 1}`,
          title:
            mode === "verification"
              ? `Build ${label} verification surfaces for ${story.title}`
              : `Implement ${label} for ${story.title}`,
          type: "feature",
          description: [
            `Implement the core product behavior for story "${story.title}".`,
            `Primary objective: ${objectiveLine}`,
            `Focused targets: ${group.files.join(", ")}.`,
            group.kind === "primary" && mode === "integration"
              ? supportingLine
              : primaryLine,
            "Create or update the concrete modules and baseline execution path for this target group before downstream wiring.",
            acceptanceBlock,
          ].join("\n"),
          files: group.files,
          estimatedStoryPoints: group.files.length > 2 ? 5 : 3,
          priorityHint: Math.max(1, 100 - index * 10),
          dependsOnKeys,
          relatedDocs: story.relatedDocs ?? [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        } satisfies AgentTaskNode;
      }
      if (group.kind === "supporting") {
        return {
          localId: `t-fallback-${index + 1}`,
          title: `Wire ${label} into ${story.title}`,
          type: "feature",
          description: [
            `Integrate the supporting runtime and dependency surfaces for "${story.title}" after the prerequisite target groups are in place.`,
            `Focused targets: ${group.files.join(", ")}.`,
            supportingLine,
            "Align internal/external interfaces, dependency order, and runtime contracts across this target group.",
          ].join("\n"),
          files: group.files,
          estimatedStoryPoints: group.files.length > 2 ? 3 : 2,
          priorityHint: Math.max(1, 90 - index * 10),
          dependsOnKeys,
          relatedDocs: story.relatedDocs ?? [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        } satisfies AgentTaskNode;
      }
      const testMetadata = this.buildFallbackTestMetadata(story.title, group.files);
      return {
        localId: `t-fallback-${index + 1}`,
        title: `Validate ${label} for ${story.title}`,
        type: "chore",
        description: [
          `Validate the completed story slice for "${story.title}" with focused regression coverage and readiness evidence.`,
          `Focused verification targets: ${group.files.join(", ")}.`,
          verificationLine,
          "Add or update the targeted verification path that proves this slice behaves correctly after implementation and wiring land.",
        ].join("\n"),
        files: group.files,
        estimatedStoryPoints: 2,
        priorityHint: Math.max(1, 80 - index * 10),
        dependsOnKeys,
        relatedDocs: story.relatedDocs ?? [],
        unitTests: testMetadata.unitTests,
        componentTests: testMetadata.componentTests,
        integrationTests: testMetadata.integrationTests,
        apiTests: testMetadata.apiTests,
      } satisfies AgentTaskNode;
    });
  }

  private boundFallbackTaskGroups(
    groups: Array<{ kind: "primary" | "supporting" | "verification"; files: string[] }>,
    mode: "core" | "integration" | "verification" | "generic",
  ): Array<{ kind: "primary" | "supporting" | "verification"; files: string[] }> {
    const budgets: Record<"primary" | "supporting" | "verification", number> =
      mode === "verification"
        ? { primary: 1, supporting: 1, verification: 1 }
        : { primary: 2, supporting: 1, verification: 1 };
    const mergedByKind = new Map<"primary" | "supporting" | "verification", string[]>();
    const passThroughCounts = new Map<"primary" | "supporting" | "verification", number>();
    const bounded: Array<{ kind: "primary" | "supporting" | "verification"; files: string[] }> = [];
    for (const group of groups) {
      const budget = budgets[group.kind];
      const passthroughBudget = Math.max(0, budget - 1);
      const currentCount = passThroughCounts.get(group.kind) ?? 0;
      if (currentCount < passthroughBudget) {
        bounded.push(group);
        passThroughCounts.set(group.kind, currentCount + 1);
        continue;
      }
      const existing = mergedByKind.get(group.kind) ?? [];
      mergedByKind.set(group.kind, [...existing, ...group.files]);
    }
    for (const [kind, files] of mergedByKind.entries()) {
      if (files.length === 0) continue;
      bounded.push({
        kind,
        files: this.preferSpecificTaskTargets(files).slice(0, 6),
      });
    }
    return bounded;
  }

  private async generatePlanFromAgent(
    projectKey: string,
    epics: AgentEpicNode[],
    agent: Agent,
    docSummary: string,
    options: {
      agentStream: boolean;
      jobId: string;
      commandRunId: string;
      maxStoriesPerEpic?: number;
      maxTasksPerStory?: number;
      projectBuildMethod: string;
      strictAgentMode?: boolean;
      strictStagedStoryMode?: "agent" | "deterministic";
      architecture?: CanonicalArchitectureArtifact;
    },
  ): Promise<GeneratedPlan> {
    const planEpics: PlanEpic[] = epics.map((epic, idx) => ({
      ...epic,
      localId: epic.localId ?? `e${idx + 1}`,
    }));
    const epicTitleByLocalId = new Map(planEpics.map((epic) => [epic.localId, epic.title] as const));
    const epicByLocalId = new Map(planEpics.map((epic) => [epic.localId, epic] as const));

    const planStories: PlanStory[] = [];
    const planTasks: PlanTask[] = [];
    const fallbackStoryScopes = new Set<string>();

    if (options.strictAgentMode) {
      if ((options.strictStagedStoryMode ?? "agent") === "deterministic") {
        await this.jobService.appendLog(
          options.jobId,
          `Strict staged planning is using deterministic epic-derived stories (${planEpics.length}) before agent task synthesis.\n`,
        );
        const verificationSurfaceById = new Map(
          (options.architecture?.verificationSurfaces ?? []).map((surface) => [surface.surfaceId, surface] as const),
        );
        for (const epic of planEpics) {
          const unit = this.findArchitectureUnitForEpic(epic, options.architecture);
          const stories = this.buildDerivedStoriesForEpic(epic, unit, verificationSurfaceById).slice(
            0,
            options.maxStoriesPerEpic ?? Number.MAX_SAFE_INTEGER,
          );
          for (const [idx, story] of stories.entries()) {
            planStories.push({
              ...story,
              localId: story.localId ?? `us${idx + 1}`,
              epicLocalId: epic.localId,
            });
          }
        }
      } else {
        const storiesByEpic = new Map<string, AgentStoryNode[]>();
        const storyChunks = this.buildStoryGenerationChunks(
          projectKey,
          planEpics,
          docSummary,
          options.projectBuildMethod,
        );
        for (const chunk of storyChunks) {
          await this.collectStrictStoriesChunk(
            agent,
            projectKey,
            chunk,
            docSummary,
            options.projectBuildMethod,
            options.agentStream,
            options.jobId,
            options.commandRunId,
            storiesByEpic,
          );
        }
        for (const epic of planEpics) {
          const stories = (storiesByEpic.get(epic.localId) ?? []).slice(
            0,
            options.maxStoriesPerEpic ?? Number.MAX_SAFE_INTEGER,
          );
          for (const [idx, story] of stories.entries()) {
            planStories.push({
              ...story,
              localId: story.localId ?? `us${idx + 1}`,
              epicLocalId: epic.localId,
            });
          }
        }
      }

      const taskEntries = planStories.map((story) => ({
        epic: epicByLocalId.get(story.epicLocalId)!,
        story,
      }));
      const tasksByStoryScope = new Map<string, AgentTaskNode[]>();
      if ((options.strictStagedStoryMode ?? "agent") === "deterministic") {
        await this.jobService.appendLog(
          options.jobId,
          `Strict staged planning is using single-story agent task synthesis (${taskEntries.length}) for deterministic story scaffolds.\n`,
        );
        for (const entry of taskEntries) {
          await this.collectStrictTasksChunk(
            agent,
            projectKey,
            [entry],
            this.buildScopedTaskDocSummary(docSummary, entry.epic, entry.story),
            this.buildScopedTaskBuildMethod(options.projectBuildMethod),
            options.agentStream,
            options.jobId,
            options.commandRunId,
            epicTitleByLocalId,
            tasksByStoryScope,
            { compactSingleStorySchema: true },
          );
        }
      } else {
        const taskChunks = this.buildTaskGenerationChunks(
          projectKey,
          taskEntries,
          docSummary,
          options.projectBuildMethod,
        );
        for (const chunk of taskChunks) {
          await this.collectStrictTasksChunk(
            agent,
            projectKey,
            chunk,
            docSummary,
            options.projectBuildMethod,
            options.agentStream,
            options.jobId,
            options.commandRunId,
            epicTitleByLocalId,
            tasksByStoryScope,
          );
        }
      }
      for (const story of planStories) {
        const storyScope = this.storyScopeKey(story.epicLocalId, story.localId);
        const limitedTasks = (tasksByStoryScope.get(storyScope) ?? []).slice(
          0,
          options.maxTasksPerStory ?? Number.MAX_SAFE_INTEGER,
        );
        for (const [idx, task] of limitedTasks.entries()) {
          planTasks.push({
            ...task,
            localId: task.localId ?? `t${idx + 1}`,
            storyLocalId: story.localId,
            epicLocalId: story.epicLocalId,
          });
        }
      }
      return { epics: planEpics, stories: planStories, tasks: planTasks };
    }

    for (const epic of planEpics) {
      let stories: AgentStoryNode[] = [];
      let usedFallbackStories = false;
      try {
        stories = await this.generateStoriesForEpic(
          agent,
          projectKey,
          { ...epic },
          docSummary,
          options.projectBuildMethod,
          options.agentStream,
          options.jobId,
          options.commandRunId,
        );
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        if (!options.strictAgentMode) {
          usedFallbackStories = true;
          await this.jobService.appendLog(
            options.jobId,
            `Story generation failed for epic "${epic.title}". Using deterministic fallback story. Reason: ${message}\n`,
          );
          stories = [this.buildFallbackStoryForEpic(epic)];
        } else {
          await this.jobService.appendLog(
            options.jobId,
            `Story generation failed for epic "${epic.title}". Retrying through strict staged recovery. Reason: ${message}\n`,
          );
          stories = await this.repairStoriesForEpic(
            agent,
            projectKey,
            { ...epic },
            docSummary,
            options.projectBuildMethod,
            message,
            [this.buildFallbackStoryForEpic(epic)],
            options.agentStream,
            options.jobId,
            options.commandRunId,
          );
        }
      }
      let limitedStories = stories.slice(0, options.maxStoriesPerEpic ?? stories.length);
      if (limitedStories.length === 0) {
        if (!options.strictAgentMode) {
          usedFallbackStories = true;
          await this.jobService.appendLog(
            options.jobId,
            `Story generation returned no stories for epic "${epic.title}". Using deterministic fallback story.\n`,
          );
          limitedStories = [this.buildFallbackStoryForEpic(epic)];
        } else {
          const fallbackStories = [this.buildFallbackStoryForEpic(epic)];
          await this.jobService.appendLog(
            options.jobId,
            `Story generation returned no stories for epic "${epic.title}". Retrying through strict staged recovery.\n`,
          );
          limitedStories = (
            await this.repairStoriesForEpic(
              agent,
              projectKey,
              { ...epic },
              docSummary,
              options.projectBuildMethod,
              `No stories were returned for epic ${epic.title}.`,
              fallbackStories,
              options.agentStream,
              options.jobId,
              options.commandRunId,
            )
          ).slice(0, options.maxStoriesPerEpic ?? Number.MAX_SAFE_INTEGER);
          if (limitedStories.length === 0) {
            await this.jobService.appendLog(
              options.jobId,
              `Strict story repair returned no stories for epic "${epic.title}" after empty output. Using deterministic fallback story.\n`,
            );
            limitedStories = fallbackStories.slice(
              0,
              options.maxStoriesPerEpic ?? Number.MAX_SAFE_INTEGER,
            );
          }
        }
      }
      limitedStories.forEach((story, idx) => {
        const planStory: PlanStory = {
          ...story,
          localId: story.localId ?? `us${idx + 1}`,
          epicLocalId: epic.localId,
        };
        planStories.push(planStory);
        if (usedFallbackStories) {
          fallbackStoryScopes.add(this.storyScopeKey(planStory.epicLocalId, planStory.localId));
        }
      });
    }

    for (const story of planStories) {
      const storyScope = this.storyScopeKey(story.epicLocalId, story.localId);
      let tasks: AgentTaskNode[] = [];
      if (fallbackStoryScopes.has(storyScope)) {
        tasks = this.buildFallbackTasksForStory(story);
      } else {
        try {
          tasks = await this.generateTasksForStory(
            agent,
            projectKey,
            {
              key: story.epicLocalId,
              title: epicTitleByLocalId.get(story.epicLocalId) ?? story.title,
            },
            story,
            docSummary,
            options.projectBuildMethod,
            options.agentStream,
            options.jobId,
            options.commandRunId,
          );
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          if (!options.strictAgentMode) {
            await this.jobService.appendLog(
              options.jobId,
              `Task generation failed for story "${story.title}" (${storyScope}). Using deterministic fallback tasks. Reason: ${message}\n`,
            );
            tasks = this.buildFallbackTasksForStory(story);
          } else {
            await this.jobService.appendLog(
              options.jobId,
              `Task generation failed for story "${story.title}" (${storyScope}). Retrying through strict staged recovery. Reason: ${message}\n`,
            );
            tasks = await this.repairTasksForStory(
              agent,
              projectKey,
              {
                key: story.epicLocalId,
                title: epicTitleByLocalId.get(story.epicLocalId) ?? story.title,
              },
              story,
              docSummary,
              options.projectBuildMethod,
              message,
              this.buildFallbackTasksForStory(story),
              options.agentStream,
              options.jobId,
              options.commandRunId,
            );
          }
        }
      }
      let limitedTasks = tasks.slice(0, options.maxTasksPerStory ?? tasks.length);
      if (limitedTasks.length === 0) {
        if (!options.strictAgentMode) {
          await this.jobService.appendLog(
            options.jobId,
            `Task generation returned no tasks for story "${story.title}" (${storyScope}). Using deterministic fallback tasks.\n`,
          );
          limitedTasks = this.buildFallbackTasksForStory(story).slice(
            0,
            options.maxTasksPerStory ?? Number.MAX_SAFE_INTEGER,
          );
        } else {
          const fallbackTasks = this.buildFallbackTasksForStory(story);
          await this.jobService.appendLog(
            options.jobId,
            `Task generation returned no tasks for story "${story.title}" (${storyScope}). Retrying through strict staged recovery.\n`,
          );
          limitedTasks = (
            await this.repairTasksForStory(
              agent,
              projectKey,
              {
                key: story.epicLocalId,
                title: epicTitleByLocalId.get(story.epicLocalId) ?? story.title,
              },
              story,
              docSummary,
              options.projectBuildMethod,
              `No tasks were returned for story ${story.title}.`,
              fallbackTasks,
              options.agentStream,
              options.jobId,
              options.commandRunId,
            )
          ).slice(0, options.maxTasksPerStory ?? Number.MAX_SAFE_INTEGER);
          if (limitedTasks.length === 0) {
            await this.jobService.appendLog(
              options.jobId,
              `Strict task repair returned no tasks for story "${story.title}" (${storyScope}) after empty output. Using deterministic fallback tasks.\n`,
            );
            limitedTasks = fallbackTasks.slice(
              0,
              options.maxTasksPerStory ?? Number.MAX_SAFE_INTEGER,
            );
          }
        }
      }
      limitedTasks.forEach((task, idx) => {
        planTasks.push({
          ...task,
          localId: task.localId ?? `t${idx + 1}`,
          storyLocalId: story.localId,
          epicLocalId: story.epicLocalId,
        });
      });
    }

    return { epics: planEpics, stories: planStories, tasks: planTasks };
  }

  private async generateStrictAgentPlanStaged(params: {
    agent: Agent;
    projectKey: string;
    docs: DocdexDocument[];
    docSummary: string;
    projectBuildMethod: string;
    serviceCatalog: ServiceCatalogArtifact;
    architecture: CanonicalArchitectureArtifact;
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number };
    agentStream: boolean;
    jobId: string;
    commandRunId: string;
    unknownEpicServicePolicy: EpicServiceValidationPolicy;
    epicsPrompt: string;
    docWarnings: string[];
  }): Promise<GeneratedPlan> {
    let parsedEpics: AgentEpicNode[];
    if (params.architecture.units.length > 0) {
      const architectureSeedPlan = this.buildSdsDrivenPlan(params.projectKey, params.docs, params.architecture);
      parsedEpics = architectureSeedPlan.epics.map((epic) => ({ ...epic, stories: [] }));
      await this.jobService.appendLog(
        params.jobId,
        `Strict staged planning is using deterministic architecture-derived epics (${parsedEpics.length}) before agent story/task synthesis.\n`,
      );
    } else {
      const { output: epicOutput } = await this.invokeAgentWithRetry(
        params.agent,
        params.epicsPrompt,
        "epics",
        params.agentStream,
        params.jobId,
        params.commandRunId,
        {
          strictAgentMode: true,
          planningMode: "staged",
          docWarnings: params.docWarnings,
        },
      );
      parsedEpics = this.parseEpics(epicOutput, params.docs, params.projectKey);
    }
    parsedEpics = parsedEpics.slice(0, params.options.maxEpics ?? Number.MAX_SAFE_INTEGER);
    const normalizedEpics = this.alignEpicsToServiceCatalog(
      parsedEpics,
      params.serviceCatalog,
      params.unknownEpicServicePolicy,
    );
    for (const warning of normalizedEpics.warnings) {
      await this.jobService.appendLog(params.jobId, `[create-tasks] ${warning}\n`);
    }
    return this.generatePlanFromAgent(params.projectKey, normalizedEpics.epics, params.agent, params.docSummary, {
      agentStream: params.agentStream,
      jobId: params.jobId,
      commandRunId: params.commandRunId,
      maxStoriesPerEpic: params.options.maxStoriesPerEpic,
      maxTasksPerStory: params.options.maxTasksPerStory,
      projectBuildMethod: params.projectBuildMethod,
      strictAgentMode: true,
      strictStagedStoryMode: params.architecture.units.length > 0 ? "deterministic" : "agent",
      architecture: params.architecture,
    });
  }

  private buildCoverageCorpus(plan: GeneratedPlan): string {
    return normalizeCoverageText(
      [
        ...plan.epics.map((epic) => `${epic.title} ${epic.description ?? ""} ${(epic.acceptanceCriteria ?? []).join(" ")}`),
        ...plan.stories.map(
          (story) =>
            `${story.title} ${story.userStory ?? ""} ${story.description ?? ""} ${(story.acceptanceCriteria ?? []).join(" ")}`,
        ),
        ...plan.tasks.map((task) => `${task.title} ${task.description ?? ""}`),
      ].join("\n"),
    );
  }

  private isDocsTaskForQuality(task: Pick<PlanTask, "title" | "description" | "type">): boolean {
    const corpus = this.normalizeServiceLookupKey(
      [task.title, this.extractQualityClassificationDescription(task.description), task.type ?? ""].join("\n"),
    );
    return (
      /\b(doc|documentation|docs|readme|guide|runbook|report|policy|progress|plan)\b/.test(corpus) &&
      !/\b(implement|build|create|wire|refactor|fix|update|migrate|test|verify|validate)\b/.test(corpus)
    );
  }

  private extractQualityClassificationDescription(description?: string): string {
    if (!description) return "";
    const normalized = description.replace(/\r/g, "");
    const cutoffHeadings = [
      "* **Files to Touch**",
      "* **Related Documentation / References**",
      "* **Dependencies**",
      "* **Implementation Plan**",
      "* **Risks / Notes**",
      "* **Unit Tests**",
      "* **Component Tests**",
      "* **Integration Tests**",
      "* **API Tests**",
      "* **QA Readiness**",
      "* **Definition of Done**",
    ];
    const cutoff = cutoffHeadings
      .map((heading) => normalized.indexOf(heading))
      .filter((index) => index >= 0)
      .reduce((min, index) => Math.min(min, index), normalized.length);
    return normalized.slice(0, cutoff).trim();
  }

  private isVerificationTaskForQuality(
    task: Pick<PlanTask, "title" | "description" | "type" | "unitTests" | "componentTests" | "integrationTests" | "apiTests">,
  ): boolean {
    const hasTestArrays =
      (task.unitTests?.length ?? 0) > 0 ||
      (task.componentTests?.length ?? 0) > 0 ||
      (task.integrationTests?.length ?? 0) > 0 ||
      (task.apiTests?.length ?? 0) > 0;
    const corpus = this.normalizeServiceLookupKey(
      [task.title, this.extractQualityClassificationDescription(task.description), task.type ?? ""].join("\n"),
    );
    const implementationLike = /\b(implement|build|create|wire|integrate|configure|instrument|migrate|bootstrap|establish|scaffold)\b/.test(
      corpus,
    );
    const verificationLike = /\b(test|tests|verify|verification|validate|validation|acceptance|regression|suite|qa|quality|readiness)\b/.test(
      corpus,
    );
    if (implementationLike && !verificationLike) return false;
    if (verificationLike) return true;
    if (!hasTestArrays) return false;
    return /\b(test|tests|qa|verification|quality|chore)\b/.test(this.normalizeServiceLookupKey(task.type ?? ""));
  }

  private collectStrongTaskFiles(task: PlanTask): { all: string[]; strong: string[]; docOnly: string[]; testLike: string[] } {
    const all = this.normalizeTaskFiles(task);
    const strong: string[] = [];
    const docOnly: string[] = [];
    const testLike: string[] = [];
    for (const target of all) {
      const kind = this.classifyBuildTarget(target).kind;
      if (kind === "doc") {
        docOnly.push(target);
        continue;
      }
      if (kind === "runtime" || kind === "interface" || kind === "data" || kind === "test" || kind === "ops") {
        strong.push(target);
      }
      if (kind === "test" || kind === "ops") {
        testLike.push(target);
      }
    }
    return {
      all,
      strong: uniqueStrings(strong),
      docOnly: uniqueStrings(docOnly),
      testLike: uniqueStrings(testLike),
    };
  }

  private buildBacklogQualityReport(projectKey: string, plan: GeneratedPlan): BacklogQualityReport {
    const implementationTasks = plan.tasks.filter((task) => !this.isDocsTaskForQuality(task) && !this.isVerificationTaskForQuality(task));
    const verificationTasks = plan.tasks.filter((task) => !this.isDocsTaskForQuality(task) && this.isVerificationTaskForQuality(task));
    const docsTasks = plan.tasks.filter((task) => this.isDocsTaskForQuality(task));
    const taskFiles = new Map(
      plan.tasks.map((task) => [task.localId, this.collectStrongTaskFiles(task)] as const),
    );
    const implementationWithStrongFiles = implementationTasks.filter(
      (task) => (taskFiles.get(task.localId)?.strong.length ?? 0) > 0,
    );
    const verificationReady = verificationTasks.filter((task) => {
      const files = taskFiles.get(task.localId);
      const hasTestArrays =
        (task.unitTests?.length ?? 0) > 0 ||
        (task.componentTests?.length ?? 0) > 0 ||
        (task.integrationTests?.length ?? 0) > 0 ||
        (task.apiTests?.length ?? 0) > 0;
      return hasTestArrays || (files?.testLike.length ?? 0) > 0;
    });
    const dependencyCandidates = implementationTasks.filter((task) => (task.priorityHint ?? 1) > 1);
    const dependencyReady = dependencyCandidates.filter((task) => (task.dependsOnKeys?.length ?? 0) > 0);
    const docsOnlyImplementationTasks = implementationTasks.filter((task) => {
      const files = taskFiles.get(task.localId);
      return (files?.strong.length ?? 0) === 0 && ((files?.docOnly.length ?? 0) > 0 || (files?.all.length ?? 0) === 0);
    });

    const rootCounts = new Map<string, number>();
    for (const task of implementationTasks) {
      const roots = uniqueStrings(
        (taskFiles.get(task.localId)?.strong ?? []).map((target) => target.split("/").filter(Boolean)[0] ?? target),
      );
      for (const root of roots) {
        rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
      }
    }
    const architectureRoots = Array.from(rootCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([root]) => root);
    const rareRoots = new Set(
      Array.from(rootCounts.entries())
        .filter(([, count]) => count === 1)
        .map(([root]) => root),
    );
    const architectureDriftTasks =
      implementationTasks.length >= 5
        ? implementationTasks.filter((task) => {
            const roots = uniqueStrings(
              (taskFiles.get(task.localId)?.strong ?? []).map((target) => target.split("/").filter(Boolean)[0] ?? target),
            );
            return roots.length > 0 && roots.every((root) => rareRoots.has(root));
          })
        : [];

    const implementationFileCoverage =
      implementationTasks.length > 0 ? implementationWithStrongFiles.length / implementationTasks.length : 1;
    const verificationReadinessCoverage =
      verificationTasks.length > 0 ? verificationReady.length / verificationTasks.length : 1;
    const dependencyCoverage = dependencyCandidates.length > 0 ? dependencyReady.length / dependencyCandidates.length : 1;
    const docsOnlyPenaltyRatio =
      implementationTasks.length > 0 ? docsOnlyImplementationTasks.length / implementationTasks.length : 0;
    const architectureDriftPenaltyRatio =
      implementationTasks.length > 0 ? architectureDriftTasks.length / implementationTasks.length : 0;
    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          implementationFileCoverage * 45 +
            verificationReadinessCoverage * 25 +
            dependencyCoverage * 15 +
            15 -
            docsOnlyPenaltyRatio * 10 -
            architectureDriftPenaltyRatio * 10,
        ),
      ),
    );

    const issues: BacklogQualityIssue[] = [];
    if (docsOnlyImplementationTasks.length > 0) {
      issues.push({
        code: "implementation_missing_strong_targets",
        count: docsOnlyImplementationTasks.length,
        taskKeys: docsOnlyImplementationTasks.slice(0, 8).map((task) => task.localId),
        message: "Implementation tasks are still missing strong runtime/interface/data/test/ops file scope.",
      });
    }
    if (verificationTasks.length > verificationReady.length) {
      const missingVerification = verificationTasks.filter((task) => !verificationReady.includes(task));
      issues.push({
        code: "verification_missing_runnable_surface",
        count: missingVerification.length,
        taskKeys: missingVerification.slice(0, 8).map((task) => task.localId),
        message: "Verification tasks are still missing concrete test surfaces or declared test coverage.",
      });
    }
    if (dependencyCandidates.length > dependencyReady.length) {
      const missingDependencies = dependencyCandidates.filter((task) => !dependencyReady.includes(task));
      issues.push({
        code: "dependency_links_missing",
        count: missingDependencies.length,
        taskKeys: missingDependencies.slice(0, 8).map((task) => task.localId),
        message: "Later-priority implementation tasks are missing explicit intra-story dependency links.",
      });
    }
    if (architectureDriftTasks.length > 0) {
      issues.push({
        code: "architecture_roots_fragmented",
        count: architectureDriftTasks.length,
        taskKeys: architectureDriftTasks.slice(0, 8).map((task) => task.localId),
        message: "A subset of implementation tasks use rare root families that do not appear elsewhere in the backlog.",
      });
    }

    return {
      projectKey,
      generatedAt: new Date().toISOString(),
      score,
      summary: [
        `Implementation file coverage ${implementationWithStrongFiles.length}/${implementationTasks.length || 0}.`,
        `Verification readiness ${verificationReady.length}/${verificationTasks.length || 0}.`,
        `Dependency coverage ${dependencyReady.length}/${dependencyCandidates.length || 0}.`,
        `Docs-only implementation penalties ${docsOnlyImplementationTasks.length}.`,
        `Architecture drift penalties ${architectureDriftTasks.length}.`,
      ].join(" "),
      architectureRoots,
      metrics: {
        taskCounts: {
          total: plan.tasks.length,
          implementation: implementationTasks.length,
          verification: verificationTasks.length,
          docs: docsTasks.length,
        },
        implementationFileCoverage: {
          numerator: implementationWithStrongFiles.length,
          denominator: implementationTasks.length,
          ratio: Number(implementationFileCoverage.toFixed(4)),
        },
        verificationReadinessCoverage: {
          numerator: verificationReady.length,
          denominator: verificationTasks.length,
          ratio: Number(verificationReadinessCoverage.toFixed(4)),
        },
        dependencyCoverage: {
          numerator: dependencyReady.length,
          denominator: dependencyCandidates.length,
          ratio: Number(dependencyCoverage.toFixed(4)),
        },
        docsOnlyPenalty: {
          count: docsOnlyImplementationTasks.length,
          ratio: Number(docsOnlyPenaltyRatio.toFixed(4)),
        },
        architectureDriftPenalty: {
          count: architectureDriftTasks.length,
          ratio: Number(architectureDriftPenaltyRatio.toFixed(4)),
        },
      },
      issues,
    };
  }

  private isMetaTaskForCompletion(
    task: Pick<PlanTask, "title" | "description" | "type">,
  ): boolean {
    const corpus = this.normalizeServiceLookupKey(
      [task.title, this.extractQualityClassificationDescription(task.description), task.type ?? ""].join("\n"),
    );
    return META_TASK_PATTERN.test(corpus) && !/\b(implement|build|create|wire|integrate|configure|instrument|migrate|fix|validate|verify|test)\b/.test(corpus);
  }

  private buildProjectCompletionReport(
    projectKey: string,
    plan: GeneratedPlan,
    architecture: CanonicalArchitectureArtifact,
  ): ProjectCompletionReport {
    const implementationTasks = plan.tasks.filter((task) => !this.isDocsTaskForQuality(task) && !this.isVerificationTaskForQuality(task));
    const verificationTasks = plan.tasks.filter((task) => !this.isDocsTaskForQuality(task) && this.isVerificationTaskForQuality(task));
    const docsTasks = plan.tasks.filter((task) => this.isDocsTaskForQuality(task));
    const taskFiles = new Map(plan.tasks.map((task) => [task.localId, this.collectStrongTaskFiles(task)] as const));
    const unitCoverage: ProjectCompletionUnitCoverage[] = [];
    const taskOrder = new Map(plan.tasks.map((task, index) => [task.localId, index] as const));
    const earliestImplementationTaskByUnitId = new Map<string, number>();
    const architectureUnits = architecture.units.filter((unit) => unit.kind !== "release_gate");

    const taskMatchesUnit = (task: PlanTask, unit: ArchitectureUnit): boolean => {
      const scopedOwner = architecture.units
        .filter(
          (candidate) =>
            task.localId.startsWith(`${candidate.unitId}-`) || task.storyLocalId.startsWith(`${candidate.unitId}-`),
        )
        .sort((left, right) => right.unitId.length - left.unitId.length)[0];
      if (scopedOwner) return scopedOwner.unitId === unit.unitId;
      const corpus = this.normalizeServiceLookupKey(
        [task.title, this.extractQualityClassificationDescription(task.description), ...(task.relatedDocs ?? [])].join("\n"),
      );
      const files = taskFiles.get(task.localId);
      const allTargets = new Set([
        ...unit.implementationTargets,
        ...unit.supportingTargets,
        ...unit.verificationTargets,
      ]);
      const hitsTarget = (files?.all ?? []).some((target) => allTargets.has(target));
      if (hitsTarget) return true;
      if (corpus.includes(this.normalizeServiceLookupKey(unit.name))) return true;
      return unit.sourceHeadings.some((heading) => corpus.includes(this.normalizeServiceLookupKey(heading)));
    };

    for (const unit of architecture.units) {
      const implementationTaskKeys = implementationTasks
        .filter((task) => taskMatchesUnit(task, unit))
        .map((task) => task.localId);
      const verificationTaskKeys = verificationTasks
        .filter((task) => taskMatchesUnit(task, unit))
        .map((task) => task.localId);
      const satisfied =
        unit.kind === "release_gate"
          ? verificationTaskKeys.length > 0
          : implementationTaskKeys.length > 0;
      unitCoverage.push({
        unitId: unit.unitId,
        kind: unit.kind,
        name: unit.name,
        implementationTaskKeys,
        verificationTaskKeys,
        satisfied,
      });
      if (implementationTaskKeys.length > 0) {
        const earliest = Math.min(
          ...implementationTaskKeys.map((taskKey) => taskOrder.get(taskKey) ?? Number.MAX_SAFE_INTEGER),
        );
        earliestImplementationTaskByUnitId.set(unit.unitId, earliest);
      }
    }

    const coveredUnits = unitCoverage.filter((entry) => entry.satisfied);
    const surfaceTargets = uniqueStrings(
      architectureUnits.flatMap((unit) => unit.implementationTargets.filter((target) => this.isStrongImplementationTarget(target))),
    );
    const coveredSurfaceTargets = new Set<string>();
    for (const task of implementationTasks) {
      for (const target of taskFiles.get(task.localId)?.strong ?? []) {
        if (surfaceTargets.includes(target)) coveredSurfaceTargets.add(target);
      }
    }
    const crossCuttingUnits = architecture.units.filter((unit) => unit.kind === "cross_cutting");
    const coveredCrossCuttingUnits = unitCoverage.filter(
      (entry) => entry.kind === "cross_cutting" && entry.implementationTaskKeys.length > 0,
    );
    const dependencyPairs = architectureUnits.flatMap((unit) =>
      unit.dependsOnUnitIds.map((dependencyId) => ({ unitId: unit.unitId, dependencyId })),
    );
    const dependencyPairsEligible = dependencyPairs.filter(({ unitId, dependencyId }) => {
      const unitOrder = earliestImplementationTaskByUnitId.get(unitId);
      const dependencyOrder = earliestImplementationTaskByUnitId.get(dependencyId);
      return typeof unitOrder === "number" && typeof dependencyOrder === "number";
    });
    const dependencyPairsCovered = dependencyPairsEligible.filter(({ unitId, dependencyId }) => {
      const unitOrder = earliestImplementationTaskByUnitId.get(unitId);
      const dependencyOrder = earliestImplementationTaskByUnitId.get(dependencyId);
      return typeof unitOrder === "number" && typeof dependencyOrder === "number" && dependencyOrder < unitOrder;
    });
    const verificationEligibleUnits = architecture.units.filter(
      (unit) => unit.verificationSurfaceIds.length > 0 || unit.verificationTargets.length > 0,
    );
    const verificationCoveredUnits = unitCoverage.filter((entry) => {
      if (!verificationEligibleUnits.some((unit) => unit.unitId === entry.unitId)) return false;
      return entry.verificationTaskKeys.length > 0 || entry.implementationTaskKeys.some((taskKey) => {
        const task = plan.tasks.find((candidate) => candidate.localId === taskKey);
        return Boolean(
          task &&
            ((task.unitTests?.length ?? 0) > 0 ||
              (task.componentTests?.length ?? 0) > 0 ||
              (task.integrationTests?.length ?? 0) > 0 ||
              (task.apiTests?.length ?? 0) > 0),
        );
      });
    });
    const docsOnlyImplementationTasks = implementationTasks.filter((task) => {
      const files = taskFiles.get(task.localId);
      return (files?.strong.length ?? 0) === 0 && ((files?.docOnly.length ?? 0) > 0 || (files?.all.length ?? 0) === 0);
    });
    const metaTasks = implementationTasks.filter((task) => this.isMetaTaskForCompletion(task));
    const implementationBalance =
      implementationTasks.length === 0
        ? 0
        : Math.min(1, implementationTasks.length / Math.max(verificationTasks.length, 1));

    const architectureUnitCoverageRatio = architecture.units.length > 0 ? coveredUnits.length / architecture.units.length : 1;
    const implementationSurfaceCoverageRatio = surfaceTargets.length > 0 ? coveredSurfaceTargets.size / surfaceTargets.length : 1;
    const crossCuttingCoverageRatio = crossCuttingUnits.length > 0 ? coveredCrossCuttingUnits.length / crossCuttingUnits.length : 1;
    const dependencyOrderCoverageRatio =
      dependencyPairsEligible.length > 0 ? dependencyPairsCovered.length / dependencyPairsEligible.length : 1;
    const verificationSupportCoverageRatio =
      verificationEligibleUnits.length > 0 ? verificationCoveredUnits.length / verificationEligibleUnits.length : 1;
    const docsOnlyPenaltyRatio = implementationTasks.length > 0 ? docsOnlyImplementationTasks.length / implementationTasks.length : 0;
    const metaTaskPenaltyRatio = implementationTasks.length > 0 ? metaTasks.length / implementationTasks.length : 0;
    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          architectureUnitCoverageRatio * 30 +
            implementationSurfaceCoverageRatio * 25 +
            crossCuttingCoverageRatio * 15 +
            dependencyOrderCoverageRatio * 10 +
            verificationSupportCoverageRatio * 10 +
            implementationBalance * 10 -
            docsOnlyPenaltyRatio * 10 -
            metaTaskPenaltyRatio * 10,
        ),
      ),
    );
    const issues: ProjectCompletionIssue[] = [];
    const uncoveredUnits = unitCoverage.filter((entry) => !entry.satisfied);
    if (uncoveredUnits.length > 0) {
      issues.push({
        code: "architecture_units_uncovered",
        count: uncoveredUnits.length,
        unitIds: uncoveredUnits.slice(0, 12).map((entry) => entry.unitId),
        taskKeys: [],
        message: "Some architecture units still have no direct backlog coverage.",
      });
    }
    if (coveredSurfaceTargets.size < surfaceTargets.length) {
      issues.push({
        code: "implementation_surfaces_uncovered",
        count: surfaceTargets.length - coveredSurfaceTargets.size,
        unitIds: [],
        taskKeys: [],
        message: "Some architecture implementation surfaces still have no concrete implementation task coverage.",
      });
    }
    if (coveredCrossCuttingUnits.length < crossCuttingUnits.length) {
      const missing = crossCuttingUnits.filter(
        (unit) => !coveredCrossCuttingUnits.some((entry) => entry.unitId === unit.unitId),
      );
      issues.push({
        code: "cross_cutting_units_uncovered",
        count: missing.length,
        unitIds: missing.slice(0, 12).map((unit) => unit.unitId),
        taskKeys: [],
        message: "Cross-cutting architecture domains are still missing direct implementation coverage.",
      });
    }
    if (dependencyPairsCovered.length < dependencyPairsEligible.length) {
      issues.push({
        code: "dependency_order_weak",
        count: dependencyPairsEligible.length - dependencyPairsCovered.length,
        unitIds: dependencyPairsEligible
          .slice(0, 12)
          .map((pair) => pair.unitId),
        taskKeys: [],
        message: "Some architecture dependencies are not reflected in backlog execution order.",
      });
    }
    if (verificationCoveredUnits.length < verificationEligibleUnits.length) {
      const missing = verificationEligibleUnits.filter(
        (unit) => !verificationCoveredUnits.some((entry) => entry.unitId === unit.unitId),
      );
      issues.push({
        code: "verification_support_missing",
        count: missing.length,
        unitIds: missing.slice(0, 12).map((unit) => unit.unitId),
        taskKeys: [],
        message: "Some units with SDS verification expectations are still missing supporting validation work.",
      });
    }
    if (docsOnlyImplementationTasks.length > 0) {
      issues.push({
        code: "docs_only_implementation_tasks",
        count: docsOnlyImplementationTasks.length,
        unitIds: [],
        taskKeys: docsOnlyImplementationTasks.slice(0, 12).map((task) => task.localId),
        message: "A subset of implementation tasks still lacks strong runtime/interface/data/ops scope.",
      });
    }
    if (metaTasks.length > 0) {
      issues.push({
        code: "meta_tasks_present",
        count: metaTasks.length,
        unitIds: [],
        taskKeys: metaTasks.slice(0, 12).map((task) => task.localId),
        message: "A subset of implementation tasks still reads like planning/meta work instead of build work.",
      });
    }

    return {
      projectKey,
      generatedAt: new Date().toISOString(),
      score,
      threshold: PROJECT_COMPLETION_SCORE_THRESHOLD,
      satisfied: score >= PROJECT_COMPLETION_SCORE_THRESHOLD,
      summary: [
        `Architecture units covered ${coveredUnits.length}/${architecture.units.length}.`,
        `Implementation surfaces covered ${coveredSurfaceTargets.size}/${surfaceTargets.length || 0}.`,
        `Cross-cutting coverage ${coveredCrossCuttingUnits.length}/${crossCuttingUnits.length || 0}.`,
        `Verification support ${verificationCoveredUnits.length}/${verificationEligibleUnits.length || 0}.`,
        `Implementation vs verification tasks ${implementationTasks.length}/${verificationTasks.length}.`,
      ].join(" "),
      architectureRoots: architecture.architectureRoots,
      metrics: {
        architectureUnitCoverage: {
          numerator: coveredUnits.length,
          denominator: architecture.units.length,
          ratio: Number(architectureUnitCoverageRatio.toFixed(4)),
        },
        implementationSurfaceCoverage: {
          numerator: coveredSurfaceTargets.size,
          denominator: surfaceTargets.length,
          ratio: Number(implementationSurfaceCoverageRatio.toFixed(4)),
        },
        crossCuttingCoverage: {
          numerator: coveredCrossCuttingUnits.length,
          denominator: crossCuttingUnits.length,
          ratio: Number(crossCuttingCoverageRatio.toFixed(4)),
        },
        dependencyOrderCoverage: {
          numerator: dependencyPairsCovered.length,
          denominator: dependencyPairs.length,
          ratio: Number(dependencyOrderCoverageRatio.toFixed(4)),
        },
        verificationSupportCoverage: {
          numerator: verificationCoveredUnits.length,
          denominator: verificationEligibleUnits.length,
          ratio: Number(verificationSupportCoverageRatio.toFixed(4)),
        },
        implementationToVerificationBalance: {
          numerator: Math.min(implementationTasks.length, Math.max(verificationTasks.length, 1)),
          denominator: Math.max(verificationTasks.length, 1),
          ratio: Number(implementationBalance.toFixed(4)),
        },
        docsOnlyPenalty: {
          count: docsOnlyImplementationTasks.length,
          ratio: Number(docsOnlyPenaltyRatio.toFixed(4)),
        },
        metaTaskPenalty: {
          count: metaTasks.length,
          ratio: Number(metaTaskPenaltyRatio.toFixed(4)),
        },
      },
      issues,
      unitCoverage,
    };
  }

  private collectCoverageAnchorsFromBacklog(backlog: {
    tasks: Array<{ metadata?: Record<string, unknown> | undefined }>;
  }): Set<string> {
    const anchors = new Set<string>();
    for (const task of backlog.tasks) {
      const sufficiencyAudit = task.metadata?.sufficiencyAudit as
        | { anchor?: unknown; anchors?: unknown }
        | undefined;
      const anchor = typeof sufficiencyAudit?.anchor === "string" ? sufficiencyAudit.anchor.trim() : "";
      if (anchor) anchors.add(anchor);
      if (Array.isArray(sufficiencyAudit?.anchors)) {
        for (const value of sufficiencyAudit.anchors) {
          if (typeof value !== "string" || value.trim().length === 0) continue;
          anchors.add(value.trim());
        }
      }
    }
    return anchors;
  }

  private coverageSummariesMatch(
    report: {
      totalSignals: number;
      coverageRatio: number;
      missingSectionHeadings: string[];
      missingFolderEntries: string[];
    },
    expected: SdsCoverageSummary,
  ): boolean {
    const sort = (values: string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));
    const sameSectionGaps =
      JSON.stringify(sort(report.missingSectionHeadings)) === JSON.stringify(sort(expected.missingSectionHeadings));
    const sameFolderGaps =
      JSON.stringify(sort(report.missingFolderEntries)) === JSON.stringify(sort(expected.missingFolderEntries));
    return (
      report.totalSignals !== expected.totalSignals ||
      report.coverageRatio !== expected.coverageRatio ||
      !sameSectionGaps ||
      !sameFolderGaps
    ) === false;
  }

  private appendCoverageNote(report: Record<string, unknown>, note: string): Record<string, unknown> {
    const existingNotes = Array.isArray(report.notes)
      ? report.notes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return {
      ...report,
      notes: uniqueStrings([...existingNotes, note]),
    };
  }

  private mergeCoverageReportWithExpected(
    report: Record<string, unknown>,
    expected: SdsCoverageSummary,
    note: string,
  ): Record<string, unknown> {
    return this.appendCoverageNote(
      {
        ...report,
        totalSignals: expected.totalSignals,
        coverageRatio: expected.coverageRatio,
        unmatched: [...expected.missingSectionHeadings],
        missingSectionHeadings: [...expected.missingSectionHeadings],
        missingFolderEntries: [...expected.missingFolderEntries],
      },
      note,
    );
  }

  private async walkCoverageSdsCandidates(root: string, maxDepth: number, cap: number): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (results.length >= cap || depth > maxDepth) return;
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= cap) break;
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (coverageSdsIgnoredDirs.has(entry.name)) continue;
          await walk(entryPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue;
        if (!coverageSdsFilenamePattern.test(entry.name)) {
          try {
            const sample = await fs.readFile(entryPath, "utf8");
            if (!coverageSdsContentPattern.test(sample.slice(0, 30000))) continue;
          } catch {
            continue;
          }
        }
        results.push(path.resolve(entryPath));
      }
    };
    await walk(root, 0);
    return results;
  }

  private async discoverCoverageSourcePaths(docs: DocdexDocument[]): Promise<string[]> {
    const discovered = new Set<string>();
    const tryAdd = async (candidate: string | undefined) => {
      const trimmed = `${candidate ?? ""}`.trim();
      if (!trimmed || DOCDEX_LOCAL_HANDLE.test(trimmed)) return;
      const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(this.workspace.workspaceRoot, trimmed);
      try {
        const stat = await fs.stat(resolved);
        if (stat.isFile()) discovered.add(resolved);
      } catch {
        // ignore missing candidate
      }
    };

    for (const doc of docs) {
      if (!looksLikeSdsDoc(doc)) continue;
      await tryAdd(doc.path);
      await tryAdd(looksLikePathishDocId(doc.id ?? "") ? doc.id : undefined);
    }

    const directCandidates = [
      path.join(this.workspace.workspaceRoot, "docs", "sds.md"),
      path.join(this.workspace.workspaceRoot, "docs", "sds", "sds.md"),
      path.join(this.workspace.workspaceRoot, "docs", "software-design-specification.md"),
      path.join(this.workspace.workspaceRoot, "sds.md"),
    ];
    for (const candidate of directCandidates) {
      await tryAdd(candidate);
    }

    if (discovered.size >= COVERAGE_SDS_SCAN_MAX_FILES) {
      return Array.from(discovered).slice(0, COVERAGE_SDS_SCAN_MAX_FILES);
    }

    const roots = [path.join(this.workspace.workspaceRoot, "docs"), this.workspace.workspaceRoot];
    for (const root of roots) {
      const candidates = await this.walkCoverageSdsCandidates(
        root,
        root === this.workspace.workspaceRoot ? 3 : 5,
        COVERAGE_SDS_SCAN_MAX_FILES,
      );
      for (const candidate of candidates) {
        discovered.add(candidate);
        if (discovered.size >= COVERAGE_SDS_SCAN_MAX_FILES) break;
      }
      if (discovered.size >= COVERAGE_SDS_SCAN_MAX_FILES) break;
    }

    return Array.from(discovered).slice(0, COVERAGE_SDS_SCAN_MAX_FILES);
  }

  private async reloadCoverageDocsFromSource(docs: DocdexDocument[]): Promise<DocdexDocument[]> {
    const coverageSourcePaths = await this.discoverCoverageSourcePaths(docs);
    if (coverageSourcePaths.length === 0) return [];
    const reloaded: DocdexDocument[] = [];
    for (const filePath of coverageSourcePaths) {
      try {
        const content = await fs.readFile(filePath, "utf8");
        const resolvedPath = path.resolve(filePath);
        const timestamp = new Date().toISOString();
        reloaded.push(
          this.sanitizeDocForPlanning({
            id: `file:${resolvedPath}`,
            docType: inferDocType(resolvedPath),
            path: resolvedPath,
            title: path.basename(resolvedPath),
            content,
            segments: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          } as DocdexDocument),
        );
      } catch {
        // ignore unreadable source files
      }
    }
    return this.sortDocsForPlanning(this.dedupePlanningDocs(reloaded));
  }

  private assertPlanningArtifactConsistency(
    projectKey: string,
    buildPlan: ProjectBuildPlanArtifact,
    serviceCatalog: ServiceCatalogArtifact,
  ): void {
    const sort = (values: string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));
    const catalogSourceDocs = sort(uniqueStrings(serviceCatalog.sourceDocs));
    const buildPlanSourceDocs = sort(uniqueStrings(buildPlan.sourceDocs));
    if (JSON.stringify(catalogSourceDocs) !== JSON.stringify(buildPlanSourceDocs)) {
      throw new Error(
        `create-tasks produced inconsistent planning artifacts for project "${projectKey}". build-plan.json and services.json disagree on source docs.`,
      );
    }

    const catalogServiceNames = serviceCatalog.services.map((service) => service.name);
    const catalogServiceIds = serviceCatalog.services.map((service) => service.id);
    const expectedBuildPlanServiceNames = catalogServiceNames.slice(0, buildPlan.services.length);
    const expectedBuildPlanServiceIds = catalogServiceIds.slice(0, buildPlan.serviceIds.length);
    if (
      JSON.stringify(buildPlan.services) !== JSON.stringify(expectedBuildPlanServiceNames) ||
      JSON.stringify(buildPlan.serviceIds) !== JSON.stringify(expectedBuildPlanServiceIds)
    ) {
      throw new Error(
        `create-tasks produced inconsistent planning artifacts for project "${projectKey}". build-plan.json and services.json disagree on service identity ordering.`,
      );
    }

    const catalogServicesByName = new Map(serviceCatalog.services.map((service) => [service.name, service] as const));
    const unknownWaveServices = buildPlan.startupWaves.flatMap((wave) =>
      wave.services
        .filter((serviceName) => !catalogServicesByName.has(serviceName))
        .map((serviceName) => `wave ${wave.wave}:${serviceName}`),
    );
    if (unknownWaveServices.length > 0) {
      throw new Error(
        `create-tasks produced inconsistent planning artifacts for project "${projectKey}". build-plan.json references services missing from services.json: ${unknownWaveServices.slice(0, 8).join(", ")}.`,
      );
    }
  }

  private async loadExpectedCoverageFromSufficiencyReport(reportPath: string | undefined): Promise<SdsCoverageSummary | undefined> {
    if (!reportPath) return undefined;
    let raw: string;
    try {
      raw = await fs.readFile(reportPath, "utf8");
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new Error(
        `create-tasks failed to load task sufficiency coverage report from "${reportPath}": ${message}`,
      );
    }

    let parsed: {
      finalCoverage?: {
        coverageRatio?: unknown;
        totalSignals?: unknown;
        missingSectionHeadings?: unknown;
        missingFolderEntries?: unknown;
      };
    };
    try {
      parsed = JSON.parse(raw) as {
        finalCoverage?: {
          coverageRatio?: unknown;
          totalSignals?: unknown;
          missingSectionHeadings?: unknown;
          missingFolderEntries?: unknown;
        };
      };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new Error(
        `create-tasks failed to parse task sufficiency coverage report from "${reportPath}": ${message}`,
      );
    }

    const finalCoverage = parsed.finalCoverage;
    if (
      !finalCoverage ||
      typeof finalCoverage.coverageRatio !== "number" ||
      typeof finalCoverage.totalSignals !== "number" ||
      !Array.isArray(finalCoverage.missingSectionHeadings) ||
      !Array.isArray(finalCoverage.missingFolderEntries)
    ) {
      throw new Error(
        `create-tasks failed to load task sufficiency coverage report from "${reportPath}": finalCoverage is incomplete.`,
      );
    }
    return {
      coverageRatio: finalCoverage.coverageRatio,
      totalSignals: finalCoverage.totalSignals,
      missingSectionHeadings: finalCoverage.missingSectionHeadings.filter(
        (value): value is string => typeof value === "string",
      ),
      missingFolderEntries: finalCoverage.missingFolderEntries.filter(
        (value): value is string => typeof value === "string",
      ),
    };
  }

  private buildSdsCoverageReport(
    projectKey: string,
    docs: DocdexDocument[],
    plan: GeneratedPlan,
    existingAnchors: Set<string> = new Set(),
  ): Record<string, unknown> {
    const coverageSignals = collectSdsCoverageSignalsFromDocs(docs, {
      headingLimit: SDS_COVERAGE_REPORT_SECTION_LIMIT,
      folderLimit: SDS_COVERAGE_REPORT_FOLDER_LIMIT,
    });
    const coverage = evaluateSdsCoverage(
      this.buildCoverageCorpus(plan),
      {
        sectionHeadings: coverageSignals.sectionHeadings,
        folderEntries: coverageSignals.folderEntries,
      },
      existingAnchors,
    );
    const matchedSections = coverageSignals.sectionHeadings.filter(
      (heading) => !coverage.missingSectionHeadings.includes(heading),
    );
    const matchedFolderEntries = coverageSignals.folderEntries.filter(
      (entry) => !coverage.missingFolderEntries.includes(entry),
    );
    return {
      projectKey,
      generatedAt: new Date().toISOString(),
      totalSignals: coverage.totalSignals,
      totalSections: coverageSignals.sectionHeadings.length,
      totalFolderEntries: coverageSignals.folderEntries.length,
      rawSectionSignals: coverageSignals.rawSectionHeadings.length,
      rawFolderSignals: coverageSignals.rawFolderEntries.length,
      skippedHeadingSignals: coverageSignals.skippedHeadingSignals,
      skippedFolderSignals: coverageSignals.skippedFolderSignals,
      matched: matchedSections,
      unmatched: coverage.missingSectionHeadings,
      matchedSections,
      missingSectionHeadings: coverage.missingSectionHeadings,
      matchedFolderEntries,
      missingFolderEntries: coverage.missingFolderEntries,
      existingAnchorsCount: existingAnchors.size,
      coverageRatio: coverage.coverageRatio,
      notes:
        coverage.totalSignals === 0
          ? ["No actionable SDS implementation signals detected; coverage defaults to 1.0."]
          : ["Coverage uses the same heading and folder signal model as task-sufficiency-audit."],
    };
  }

  private async buildConsistentSdsCoverageReport(
    projectKey: string,
    docs: DocdexDocument[],
    plan: GeneratedPlan,
    existingAnchors: Set<string>,
    expectedCoverage?: SdsCoverageSummary,
  ): Promise<Record<string, unknown>> {
    const readSummary = (
      report: Record<string, unknown>,
    ): {
      totalSignals: number;
      coverageRatio: number;
      missingSectionHeadings: string[];
      missingFolderEntries: string[];
    } => ({
      totalSignals: Number(report.totalSignals ?? 0),
      coverageRatio: Number(report.coverageRatio ?? 0),
      missingSectionHeadings: Array.isArray(report.missingSectionHeadings)
        ? report.missingSectionHeadings.filter((value): value is string => typeof value === "string")
        : [],
      missingFolderEntries: Array.isArray(report.missingFolderEntries)
        ? report.missingFolderEntries.filter((value): value is string => typeof value === "string")
        : [],
    });

    const baseReport = this.buildSdsCoverageReport(projectKey, docs, plan, existingAnchors);
    if (!expectedCoverage || this.coverageSummariesMatch(readSummary(baseReport), expectedCoverage)) {
      return baseReport;
    }

    const reloadedDocs = await this.reloadCoverageDocsFromSource(docs);
    if (reloadedDocs.length > 0) {
      const reloadedReport = this.buildSdsCoverageReport(projectKey, reloadedDocs, plan, existingAnchors);
      if (this.coverageSummariesMatch(readSummary(reloadedReport), expectedCoverage)) {
        return this.appendCoverageNote(
          reloadedReport,
          "Coverage source refreshed from workspace SDS files after Docdex-derived coverage diverged from task-sufficiency-audit.",
        );
      }
      return this.mergeCoverageReportWithExpected(
        reloadedReport,
        expectedCoverage,
        "Coverage summary synchronized to task-sufficiency-audit after reloading workspace SDS files.",
      );
    }

    return this.mergeCoverageReportWithExpected(
      baseReport,
      expectedCoverage,
      "Coverage summary synchronized to task-sufficiency-audit after Docdex-derived coverage diverged.",
    );
  }

  private async acquirePlanArtifactLock(
    baseDir: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number; staleLockMs?: number },
  ): Promise<() => Promise<void>> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 80;
    const staleLockMs = options?.staleLockMs ?? 120_000;
    const lockPath = path.join(baseDir, ".plan-artifacts.lock");
    const startedAtMs = Date.now();
    while (true) {
      try {
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          "utf8",
        );
        return async () => {
          try {
            await handle.close();
          } catch {}
          await fs.rm(lockPath, { force: true });
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleLockMs) {
            await fs.rm(lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startedAtMs >= timeoutMs) {
          throw new Error(`Timed out acquiring plan artifact lock for ${baseDir}`);
        }
        await delay(pollIntervalMs);
      }
    }
  }

  private async writeJsonArtifactAtomic(targetPath: string, data: unknown): Promise<void> {
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tempPath, payload, "utf8");
    try {
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EPERM") {
        await fs.rm(targetPath, { force: true });
        await fs.rename(tempPath, targetPath);
      } else {
        await fs.rm(tempPath, { force: true });
        throw error;
      }
    }
  }

  private splitPersistedAcceptanceCriteria(value: string | null | undefined): string[] {
    if (!value) return [];
    return uniqueStrings(
      value
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean),
    );
  }

  private async loadPersistedBacklog(projectId: string): Promise<{
    epics: EpicRow[];
    stories: StoryRow[];
    tasks: TaskRow[];
    dependencies: TaskDependencyRow[];
  }> {
    const repoLike = this.workspaceRepo as any;
    if (typeof repoLike.getDb !== "function") {
      const epics = Array.isArray(repoLike.epics)
        ? repoLike.epics.filter((row: EpicRow) => row.projectId === projectId)
        : [];
      const stories = Array.isArray(repoLike.stories)
        ? repoLike.stories.filter((row: StoryRow) => row.projectId === projectId)
        : [];
      const tasks = Array.isArray(repoLike.tasks)
        ? repoLike.tasks.filter((row: TaskRow) => row.projectId === projectId)
        : [];
      const taskIds = new Set(tasks.map((task: TaskRow) => task.id));
      const dependencies = Array.isArray(repoLike.deps)
        ? repoLike.deps.filter((row: TaskDependencyRow) => taskIds.has(row.taskId))
        : [];
      return { epics, stories, tasks, dependencies };
    }

    const db = repoLike.getDb();
    const epicRows = await db.all(
      `SELECT id, project_id, key, title, description, story_points_total, priority, metadata_json, created_at, updated_at
       FROM epics
       WHERE project_id = ?
       ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key`,
      projectId,
    );
    const storyRows = await db.all(
      `SELECT id, project_id, epic_id, key, title, description, acceptance_criteria, story_points_total, priority, metadata_json, created_at, updated_at
       FROM user_stories
       WHERE project_id = ?
       ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key`,
      projectId,
    );
    const taskRows = await db.all(
      `SELECT id, project_id, epic_id, user_story_id, key, title, description, type, status, story_points, priority,
              assigned_agent_id, assignee_human, vcs_branch, vcs_base_branch, vcs_last_commit_sha, metadata_json,
              openapi_version_at_creation, created_at, updated_at
       FROM tasks
       WHERE project_id = ?
       ORDER BY COALESCE(priority, 2147483647), datetime(created_at), key`,
      projectId,
    );
    const epics: EpicRow[] = epicRows.map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      key: row.key,
      title: row.title,
      description: row.description,
      storyPointsTotal: row.story_points_total ?? null,
      priority: row.priority ?? null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const stories: StoryRow[] = storyRows.map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      key: row.key,
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptance_criteria ?? null,
      storyPointsTotal: row.story_points_total ?? null,
      priority: row.priority ?? null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const tasks: TaskRow[] = taskRows.map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      userStoryId: row.user_story_id,
      key: row.key,
      title: row.title,
      description: row.description,
      type: row.type ?? null,
      status: row.status,
      storyPoints: row.story_points ?? null,
      priority: row.priority ?? null,
      assignedAgentId: row.assigned_agent_id ?? null,
      assigneeHuman: row.assignee_human ?? null,
      vcsBranch: row.vcs_branch ?? null,
      vcsBaseBranch: row.vcs_base_branch ?? null,
      vcsLastCommitSha: row.vcs_last_commit_sha ?? null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      openapiVersionAtCreation: row.openapi_version_at_creation ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const dependencies =
      typeof repoLike.getTaskDependencies === "function"
        ? await repoLike.getTaskDependencies(tasks.map((task: TaskRow) => task.id))
        : [];
    return { epics, stories, tasks, dependencies };
  }

  private buildPlanFromPersistedBacklog(backlog: {
    epics: EpicRow[];
    stories: StoryRow[];
    tasks: TaskRow[];
    dependencies: TaskDependencyRow[];
  }): GeneratedPlan {
    const readPersistedOrderIndex = (
      metadata: Record<string, unknown> | undefined,
      fallback: number,
    ): number => {
      const value = metadata?.plan_order_index;
      return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    };
    const readPersistedLocalId = (
      metadata: Record<string, unknown> | undefined,
      field: "local_id" | "epic_local_id" | "story_local_id",
      fallback: string,
    ): string => {
      const value = metadata?.[field];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
    };
    const orderedEpics = [...backlog.epics].sort((left, right) => {
      const leftMeta = (left.metadata ?? {}) as Record<string, unknown>;
      const rightMeta = (right.metadata ?? {}) as Record<string, unknown>;
      return (
        readPersistedOrderIndex(leftMeta, Number(left.priority ?? Number.MAX_SAFE_INTEGER)) -
        readPersistedOrderIndex(rightMeta, Number(right.priority ?? Number.MAX_SAFE_INTEGER))
      );
    });
    const orderedStories = [...backlog.stories].sort((left, right) => {
      const leftMeta = (left.metadata ?? {}) as Record<string, unknown>;
      const rightMeta = (right.metadata ?? {}) as Record<string, unknown>;
      return (
        readPersistedOrderIndex(leftMeta, Number(left.priority ?? Number.MAX_SAFE_INTEGER)) -
        readPersistedOrderIndex(rightMeta, Number(right.priority ?? Number.MAX_SAFE_INTEGER))
      );
    });
    const orderedTasks = [...backlog.tasks].sort((left, right) => {
      const leftMeta = (left.metadata ?? {}) as Record<string, unknown>;
      const rightMeta = (right.metadata ?? {}) as Record<string, unknown>;
      return (
        readPersistedOrderIndex(leftMeta, Number(left.priority ?? Number.MAX_SAFE_INTEGER)) -
        readPersistedOrderIndex(rightMeta, Number(right.priority ?? Number.MAX_SAFE_INTEGER))
      );
    });
    const storyById = new Map(orderedStories.map((story) => [story.id, story]));
    const epicById = new Map(orderedEpics.map((epic) => [epic.id, epic]));
    const taskById = new Map(orderedTasks.map((task) => [task.id, task]));
    const epicLocalIdById = new Map(
      orderedEpics.map((epic) => {
        const metadata = (epic.metadata ?? {}) as Record<string, unknown>;
        return [epic.id, readPersistedLocalId(metadata, "local_id", epic.key)] as const;
      }),
    );
    const storyLocalIdById = new Map(
      orderedStories.map((story) => {
        const metadata = (story.metadata ?? {}) as Record<string, unknown>;
        return [story.id, readPersistedLocalId(metadata, "local_id", story.key)] as const;
      }),
    );
    const taskLocalIdById = new Map(
      orderedTasks.map((task) => {
        const metadata = (task.metadata ?? {}) as Record<string, unknown>;
        return [task.id, readPersistedLocalId(metadata, "local_id", task.key)] as const;
      }),
    );
    const dependencyLocalIdsByTaskId = new Map<string, string[]>();
    for (const dependency of backlog.dependencies) {
      const current = dependencyLocalIdsByTaskId.get(dependency.taskId) ?? [];
      const dependsOn =
        taskLocalIdById.get(dependency.dependsOnTaskId) ?? taskById.get(dependency.dependsOnTaskId)?.key;
      if (dependsOn && !current.includes(dependsOn)) current.push(dependsOn);
      dependencyLocalIdsByTaskId.set(dependency.taskId, current);
    }

    return {
      epics: orderedEpics.map((epic) => {
        const metadata = (epic.metadata ?? {}) as Record<string, unknown>;
        return {
          localId: epicLocalIdById.get(epic.id) ?? epic.key,
          area: epic.key.split("-")[0]?.toLowerCase() || "proj",
          title: epic.title,
          description: epic.description,
          acceptanceCriteria: [],
          relatedDocs: normalizeRelatedDocs(metadata.doc_links),
          priorityHint: epic.priority ?? undefined,
          serviceIds: normalizeStringArray(metadata.service_ids),
          tags: normalizeStringArray(metadata.tags),
          stories: [],
        };
      }),
      stories: orderedStories.map((story) => {
        const metadata = (story.metadata ?? {}) as Record<string, unknown>;
        return {
          localId: storyLocalIdById.get(story.id) ?? story.key,
          epicLocalId: readPersistedLocalId(
            metadata,
            "epic_local_id",
            epicLocalIdById.get(story.epicId) ?? epicById.get(story.epicId)?.key ?? story.epicId,
          ),
          title: story.title,
          userStory: undefined,
          description: story.description,
          acceptanceCriteria: this.splitPersistedAcceptanceCriteria(story.acceptanceCriteria),
          relatedDocs: normalizeRelatedDocs(metadata.doc_links),
          priorityHint: story.priority ?? undefined,
          tasks: [],
        };
      }),
      tasks: orderedTasks.map((task) => {
        const metadata = (task.metadata ?? {}) as Record<string, any>;
        const testRequirements = (metadata.test_requirements ?? {}) as Record<string, unknown>;
        return {
          localId: taskLocalIdById.get(task.id) ?? task.key,
          epicLocalId: readPersistedLocalId(
            metadata,
            "epic_local_id",
            epicLocalIdById.get(task.epicId) ?? epicById.get(task.epicId)?.key ?? task.epicId,
          ),
          storyLocalId: readPersistedLocalId(
            metadata,
            "story_local_id",
            storyLocalIdById.get(task.userStoryId) ?? storyById.get(task.userStoryId)?.key ?? task.userStoryId,
          ),
          title: task.title,
          type: task.type ?? "feature",
          description: task.description,
          files: normalizeStringArray(metadata.files),
          estimatedStoryPoints: task.storyPoints ?? undefined,
          priorityHint: task.priority ?? undefined,
          dependsOnKeys: dependencyLocalIdsByTaskId.get(task.id) ?? [],
          relatedDocs: normalizeRelatedDocs(metadata.doc_links),
          unitTests: normalizeStringArray(testRequirements.unit),
          componentTests: normalizeStringArray(testRequirements.component),
          integrationTests: normalizeStringArray(testRequirements.integration),
          apiTests: normalizeStringArray(testRequirements.api),
          qa: isPlainObject(metadata.qa) ? (metadata.qa as QaReadiness) : undefined,
        };
      }),
    };
  }

  private async writePlanArtifacts(
    projectKey: string,
    plan: GeneratedPlan,
    docSummary: string,
    docs: DocdexDocument[],
    buildPlan: ProjectBuildPlanArtifact,
    serviceCatalog: ServiceCatalogArtifact,
    architecture: CanonicalArchitectureArtifact,
    options?: {
      existingCoverageAnchors?: Set<string>;
      expectedCoverage?: SdsCoverageSummary;
    },
  ): Promise<{ folder: string }> {
    const baseDir = path.join(this.workspace.mcodaDir, "tasks", projectKey);
    await fs.mkdir(baseDir, { recursive: true });
    const releaseLock = await this.acquirePlanArtifactLock(baseDir);
    try {
      this.assertCanonicalNameConsistency(projectKey, docs, plan);
      const write = async (file: string, data: unknown) => {
        const target = path.join(baseDir, file);
        await this.writeJsonArtifactAtomic(target, data);
      };
      await write("plan.json", {
        projectKey,
        generatedAt: new Date().toISOString(),
        docSummary,
        buildPlan,
        serviceCatalog,
        architecture,
        ...plan,
      });
      await write("build-plan.json", buildPlan);
      await write("services.json", serviceCatalog);
      await write("architecture.json", architecture);
      await write("epics.json", plan.epics);
      await write("stories.json", plan.stories);
      await write("tasks.json", plan.tasks);
      this.assertPlanningArtifactConsistency(projectKey, buildPlan, serviceCatalog);
      const coverageReport = await this.buildConsistentSdsCoverageReport(
        projectKey,
        docs,
        plan,
        options?.existingCoverageAnchors ?? new Set(),
        options?.expectedCoverage,
      );
      await write("coverage-report.json", coverageReport);
      await write("backlog-quality-report.json", this.buildBacklogQualityReport(projectKey, plan));
      await write("project-completion-report.json", this.buildProjectCompletionReport(projectKey, plan, architecture));
    } finally {
      await releaseLock();
    }
    return { folder: baseDir };
  }

  private async persistPlanToDb(
    projectId: string,
    projectKey: string,
    plan: GeneratedPlan,
    jobId: string,
    commandRunId: string,
    options?: PersistPlanOptions,
  ): Promise<{ epics: EpicRow[]; stories: StoryRow[]; tasks: TaskRow[]; dependencies: TaskDependencyRow[] }> {
    const resetKeys = options?.resetKeys ?? false;
    const existingEpicKeys = resetKeys ? [] : await this.workspaceRepo.listEpicKeys(projectId);
    const epicKeyGen = createEpicKeyGenerator(projectKey, existingEpicKeys);
    const planningMetadata = {
      source_command: "create-tasks",
      plan_generation_id: commandRunId,
      plan_job_id: jobId,
    };

    const epicInserts: EpicInsert[] = [];
    const epicMeta: { key: string; node: PlanEpic }[] = [];

    for (const [epicIndex, epic] of plan.epics.entries()) {
      const key = epicKeyGen(epic.area);
      epicInserts.push({
        projectId,
        key,
        title: epic.title || `Epic ${key}`,
        description: buildEpicDescription(
          key,
          epic.title || `Epic ${key}`,
          epic.description,
          epic.acceptanceCriteria,
          epic.relatedDocs,
        ),
        storyPointsTotal: null,
        priority: epic.priorityHint ?? (epicInserts.length + 1),
        metadata:
          epic.relatedDocs || (epic.serviceIds?.length ?? 0) > 0 || (epic.tags?.length ?? 0) > 0
            ? {
                ...planningMetadata,
                local_id: epic.localId,
                plan_order_index: epicIndex,
                ...(epic.relatedDocs ? { doc_links: epic.relatedDocs } : {}),
                ...(epic.serviceIds && epic.serviceIds.length > 0 ? { service_ids: epic.serviceIds } : {}),
                ...(epic.tags && epic.tags.length > 0 ? { tags: epic.tags } : {}),
              }
            : {
                ...planningMetadata,
                local_id: epic.localId,
                plan_order_index: epicIndex,
              },
      });
      epicMeta.push({ key, node: epic });
    }

    let epicRows: EpicRow[] = [];
    let storyRows: StoryRow[] = [];
    let taskRows: TaskRow[] = [];
    let dependencyRows: TaskDependencyRow[] = [];

    await this.workspaceRepo.withTransaction(async () => {
      if (options?.force) {
        await this.workspaceRepo.deleteProjectBacklog(projectId, false);
      }
      epicRows = await this.workspaceRepo.insertEpics(epicInserts, false);

      const storyInserts: StoryInsert[] = [];
      const storyMeta: { storyKey: string; epicKey: string; node: PlanStory }[] = [];
      for (const [epicMetaIndex, epic] of epicMeta.entries()) {
        const epicRow = epicRows.find((row) => row.key === epic.key);
        if (!epicRow) continue;
        const stories = plan.stories.filter((s) => s.epicLocalId === epic.node.localId);
        const existingStoryKeys = await this.workspaceRepo.listStoryKeys(epicRow.id);
        const storyKeyGen = createStoryKeyGenerator(epicRow.key, existingStoryKeys);
        for (const [storyIndexWithinEpic, story] of stories.entries()) {
          const storyPlanIndex = plan.stories.findIndex(
            (candidate) => candidate.localId === story.localId && candidate.epicLocalId === story.epicLocalId,
          );
          const storyKey = storyKeyGen();
          storyInserts.push({
            projectId,
            epicId: epicRow.id,
            key: storyKey,
            title: story.title || `Story ${storyKey}`,
            description: buildStoryDescription(
              storyKey,
              story.title || `Story ${storyKey}`,
              story.userStory,
              story.description,
              story.acceptanceCriteria,
              story.relatedDocs,
            ),
            acceptanceCriteria: story.acceptanceCriteria?.join("\n") ?? undefined,
            storyPointsTotal: null,
            priority: story.priorityHint ?? (storyInserts.length + 1),
            metadata: {
              ...planningMetadata,
              local_id: story.localId,
              epic_local_id: story.epicLocalId,
              plan_order_index:
                storyPlanIndex >= 0 ? storyPlanIndex : epicMetaIndex * 1000 + storyIndexWithinEpic,
              ...(story.relatedDocs ? { doc_links: story.relatedDocs } : {}),
            },
          });
          storyMeta.push({ storyKey, epicKey: epicRow.key, node: story });
        }
      }

      storyRows = await this.workspaceRepo.insertStories(storyInserts, false);
      const storyIdByKey = new Map(storyRows.map((row) => [row.key, row.id]));
      const epicIdByKey = new Map(epicRows.map((row) => [row.key, row.id]));

      type TaskDetail = {
        localId: string;
        epicLocalId: string;
        key: string;
        storyLocalId: string;
        storyKey: string;
        epicKey: string;
        planIndex: number;
        plan: PlanTask;
      };
      const taskDetails: TaskDetail[] = [];
      for (const [storyMetaIndex, story] of storyMeta.entries()) {
        const storyId = storyIdByKey.get(story.storyKey);
        const existingTaskKeys = storyId ? await this.workspaceRepo.listTaskKeys(storyId) : [];
        const tasks = plan.tasks.filter(
          (t) => t.storyLocalId === story.node.localId && t.epicLocalId === story.node.epicLocalId,
        );
        const taskKeyGen = createTaskKeyGenerator(story.storyKey, existingTaskKeys);
        for (const [taskIndexWithinStory, task] of tasks.entries()) {
          const taskPlanIndex = plan.tasks.findIndex(
            (candidate) =>
              candidate.localId === task.localId &&
              candidate.storyLocalId === task.storyLocalId &&
              candidate.epicLocalId === task.epicLocalId,
          );
          const key = taskKeyGen();
          const localId = task.localId ?? key;
          taskDetails.push({
            localId,
            epicLocalId: story.node.epicLocalId,
            key,
            storyLocalId: story.node.localId,
            storyKey: story.storyKey,
            epicKey: story.epicKey,
            planIndex: taskPlanIndex >= 0 ? taskPlanIndex : storyMetaIndex * 1000 + taskIndexWithinStory,
            plan: task,
          });
        }
      }

      const scopedLocalKey = (epicLocalId: string, storyLocalId: string, localId: string): string =>
        this.taskScopeKey(epicLocalId, storyLocalId, localId);
      const localToKey = new Map(
        taskDetails.map((t) => [scopedLocalKey(t.epicLocalId, t.storyLocalId, t.localId), t.key]),
      );
      const globalLocalToKeys = new Map<string, string[]>();
      for (const detail of taskDetails) {
        const current = globalLocalToKeys.get(detail.localId) ?? [];
        current.push(detail.key);
        globalLocalToKeys.set(detail.localId, current);
      }
      const taskInserts: TaskInsert[] = [];
      const testCommandBuilder = new QaTestCommandBuilder(this.workspace.workspaceRoot);
      for (const task of taskDetails) {
        const storyId = storyIdByKey.get(task.storyKey);
        const epicId = epicIdByKey.get(task.epicKey);
        if (!storyId || !epicId) continue;
        const classification = classifyTask({
          title: task.plan.title ?? `Task ${task.key}`,
          description: task.plan.description,
          type: task.plan.type,
        });
        const qaReadiness = buildQaReadiness({
          classification,
          planQa: task.plan.qa,
          preflight: options?.qaPreflight,
          overrides: options?.qaOverrides,
        });
        const testRequirements = {
          unit: task.plan.unitTests ?? [],
          component: task.plan.componentTests ?? [],
          integration: task.plan.integrationTests ?? [],
          api: task.plan.apiTests ?? [],
        };
        const normalizedFiles = this.normalizeTaskFiles(task.plan);
        const testsRequired =
          testRequirements.unit.length > 0 ||
          testRequirements.component.length > 0 ||
          testRequirements.integration.length > 0 ||
          testRequirements.api.length > 0;
        let discoveredTestCommands: string[] = [];
        if (testsRequired) {
          try {
            const commandPlan = await testCommandBuilder.build({
              task: {
                id: task.key,
                key: task.key,
                title: task.plan.title ?? `Task ${task.key}`,
                description: task.plan.description ?? "",
                type: task.plan.type ?? "feature",
                status: "not_started",
                metadata: { test_requirements: testRequirements },
              } as TaskRow & { metadata?: any },
            });
            discoveredTestCommands = Array.from(new Set(commandPlan.commands.map((command) => command.trim()).filter(Boolean)));
          } catch {
            discoveredTestCommands = [];
          }
        }
        const qaBlockers = uniqueStrings(qaReadiness.blockers ?? []);
        const qaReadinessWithHarness: QaReadiness = {
          ...qaReadiness,
          blockers: qaBlockers.length ? qaBlockers : undefined,
        };
        const depSlugs = (task.plan.dependsOnKeys ?? [])
          .map((dep) => {
            const scoped = localToKey.get(scopedLocalKey(task.plan.epicLocalId, task.storyLocalId, dep));
            if (scoped) return scoped;
            const global = globalLocalToKeys.get(dep) ?? [];
            return global.length === 1 ? global[0] : undefined;
          })
          .filter((value): value is string => Boolean(value));
        const metadata: Record<string, unknown> = {
          ...planningMetadata,
          local_id: task.plan.localId,
          epic_local_id: task.plan.epicLocalId,
          story_local_id: task.plan.storyLocalId,
          plan_order_index: task.planIndex,
          doc_links: task.plan.relatedDocs ?? [],
          test_requirements: testRequirements,
          stage: classification.stage,
          foundation: classification.foundation,
          qa: qaReadinessWithHarness,
        };
        if (normalizedFiles.length > 0) {
          metadata.files = normalizedFiles;
        }
        if (discoveredTestCommands.length > 0) {
          metadata.tests = discoveredTestCommands;
          metadata.testCommands = discoveredTestCommands;
        }
        taskInserts.push({
          projectId,
          epicId,
          userStoryId: storyId,
          key: task.key,
          title: task.plan.title ?? `Task ${task.key}`,
          description: buildTaskDescription(
            task.key,
            task.plan.title ?? `Task ${task.key}`,
            task.plan.description,
            task.storyKey,
            task.epicKey,
            normalizedFiles,
            task.plan.relatedDocs,
            depSlugs,
            {
              unitTests: task.plan.unitTests,
              componentTests: task.plan.componentTests,
              integrationTests: task.plan.integrationTests,
              apiTests: task.plan.apiTests,
            },
            qaReadinessWithHarness,
          ),
          type: task.plan.type ?? "feature",
          status: "not_started",
          storyPoints: task.plan.estimatedStoryPoints ?? null,
          priority: task.plan.priorityHint ?? (taskInserts.length + 1),
          metadata,
        });
      }

      taskRows = await this.workspaceRepo.insertTasks(taskInserts, false);
      const taskByLocal = new Map<string, TaskRow>();
      for (const detail of taskDetails) {
        const row = taskRows.find((t) => t.key === detail.key);
        if (row) {
          taskByLocal.set(scopedLocalKey(detail.epicLocalId, detail.storyLocalId, detail.localId), row);
        }
      }

      const depKeys = new Set<string>();
      const dependencies: TaskDependencyInsert[] = [];
      for (const detail of taskDetails) {
        const current = taskByLocal.get(scopedLocalKey(detail.epicLocalId, detail.storyLocalId, detail.localId));
        if (!current) continue;
        for (const dep of detail.plan.dependsOnKeys ?? []) {
          const target = taskByLocal.get(scopedLocalKey(detail.plan.epicLocalId, detail.storyLocalId, dep));
          if (!target || target.id === current.id) continue;
          const depKey = `${current.id}|${target.id}|blocks`;
          if (depKeys.has(depKey)) continue;
          depKeys.add(depKey);
          dependencies.push({
            taskId: current.id,
            dependsOnTaskId: target.id,
            relationType: "blocks",
          });
        }
      }

      if (dependencies.length > 0) {
        dependencyRows = await this.workspaceRepo.insertTaskDependencies(dependencies, false);
      }

      // Roll up story and epic story point totals.
      const storySpTotals = new Map<string, number>();
      for (const task of taskRows) {
        if (typeof task.storyPoints === "number") {
          storySpTotals.set(task.userStoryId, (storySpTotals.get(task.userStoryId) ?? 0) + task.storyPoints);
        }
      }
      for (const [storyId, total] of storySpTotals.entries()) {
        await this.workspaceRepo.updateStoryPointsTotal(storyId, total);
      }
      const epicSpTotals = new Map<string, number>();
      for (const story of storyRows) {
        if (typeof story.storyPointsTotal === "number") {
          epicSpTotals.set(story.epicId, (epicSpTotals.get(story.epicId) ?? 0) + (story.storyPointsTotal ?? 0));
        }
      }
      for (const [epicId, total] of epicSpTotals.entries()) {
        await this.workspaceRepo.updateEpicStoryPointsTotal(epicId, total);
      }

      const now = new Date().toISOString();
      for (const task of taskRows) {
        await this.workspaceRepo.createTaskRun({
          taskId: task.id,
          command: "create-tasks",
          status: "succeeded",
          jobId,
          commandRunId,
          startedAt: now,
          finishedAt: now,
          runContext: { key: task.key },
        });
      }
    });

    return { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows };
  }

  async createTasks(options: CreateTasksOptions): Promise<CreateTasksResult> {
    const agentStream = options.agentStream !== false;
    const strictAgentMode = this.hasExplicitAgentRequest(options.agentName);
    const unknownEpicServicePolicy = normalizeEpicServicePolicy(options.unknownEpicServicePolicy) ?? "auto-remediate";
    const commandRun = await this.jobService.startCommandRun("create-tasks", options.projectKey);
    const job = await this.jobService.startJob(
      "create_tasks",
      commandRun.id,
      options.projectKey,
      {
        commandName: "create-tasks",
        payload: {
          projectKey: options.projectKey,
          inputs: options.inputs,
          agent: options.agentName,
          agentStream,
          sdsPreflightCommit: options.sdsPreflightCommit === true,
          unknownEpicServicePolicy,
        },
      },
    );

    let lastError: unknown;
    for (let attempt = 1; attempt <= CreateTasksService.MAX_BUSY_RETRIES; attempt++) {
      try {
        const project = await this.workspaceRepo.createProjectIfMissing({
          key: options.projectKey,
          name: options.projectKey,
          description: `Workspace project ${options.projectKey}`,
        });
        const backlogPersistence = await this.determineCreateTasksBacklogPersistence(project.id, options.force);
        const backlogPersistenceWarnings = backlogPersistence.warning ? [backlogPersistence.warning] : [];
        const canReplaceBacklogDuringRun =
          backlogPersistence.replaceExistingBacklog || !backlogPersistence.hasExistingBacklog || Boolean(options.force);
        if (backlogPersistence.warning) {
          await this.jobService.appendLog(job.id, `${backlogPersistence.warning}\n`);
        }

        let sdsPreflight: SdsPreflightResult | undefined;
        let sdsPreflightError: string | undefined;
        let sdsPreflightBlockingReasons: string[] = [];
        let continueAfterSdsPreflightWarnings = false;
        if (this.sdsPreflightFactory) {
          let sdsPreflightCloseError: string | undefined;
          try {
            const preflightService = await this.sdsPreflightFactory(this.workspace);
            try {
              sdsPreflight = await preflightService.runPreflight({
                workspace: options.workspace,
                projectKey: options.projectKey,
                inputPaths: options.inputs,
                sdsPaths: options.inputs,
                writeArtifacts: true,
                applyToSds: options.sdsPreflightApplyToSds === true,
                commitAppliedChanges: options.sdsPreflightCommit === true,
                commitMessage: options.sdsPreflightCommitMessage,
              });
            } finally {
              try {
                await preflightService.close();
              } catch (closeError) {
                sdsPreflightCloseError = (closeError as Error)?.message ?? String(closeError);
                await this.jobService.appendLog(
                  job.id,
                  `SDS preflight close warning: ${sdsPreflightCloseError}\n`,
                );
              }
            }
          } catch (error) {
            sdsPreflightError = (error as Error)?.message ?? String(error);
          }

          if (!sdsPreflight) {
            const message = `create-tasks blocked: SDS preflight failed before backlog generation (${sdsPreflightError ?? "unknown error"}).`;
            await this.jobService.writeCheckpoint(job.id, {
              stage: "sds_preflight",
              timestamp: new Date().toISOString(),
              details: {
                status: "failed",
                error: message,
                readyForPlanning: false,
                qualityStatus: undefined,
                sourceSdsCount: 0,
                issueCount: 0,
                blockingIssueCount: 0,
                questionCount: 0,
                requiredQuestionCount: 0,
                reportPath: undefined,
                openQuestionsPath: undefined,
                gapAddendumPath: undefined,
                warnings: [],
              },
            });
            throw new Error(message);
          }

          const preflightWarnings = uniqueStrings([
            ...(sdsPreflight.warnings ?? []),
            ...(sdsPreflightCloseError ? [`SDS preflight close warning: ${sdsPreflightCloseError}`] : []),
          ]);
          const blockingReasons: string[] = [];
          if (sdsPreflight.qualityStatus === "fail") {
            blockingReasons.push("SDS quality gates failed.");
          }
          if (sdsPreflight.blockingIssueCount > 0) {
            blockingReasons.push(`Blocking SDS issues: ${sdsPreflight.blockingIssueCount}.`);
          }
          if (sdsPreflight.requiredQuestionCount > 0) {
            blockingReasons.push(`Required open questions remaining: ${sdsPreflight.requiredQuestionCount}.`);
          }
          if (!sdsPreflight.readyForPlanning) {
            blockingReasons.push("SDS preflight reported planning context is not ready.");
          }
          if (blockingReasons.length > 0) {
            sdsPreflightError = blockingReasons.join(" ");
            sdsPreflightBlockingReasons = [...blockingReasons];
            continueAfterSdsPreflightWarnings = true;
            await this.jobService.appendLog(
              job.id,
              `SDS preflight reported planning warnings but create-tasks will continue with remediation context: ${blockingReasons.join(" ")} Report: ${sdsPreflight.reportPath}\n`,
            );
          }

          await this.jobService.writeCheckpoint(job.id, {
            stage: "sds_preflight",
            timestamp: new Date().toISOString(),
            details: {
              status: blockingReasons.length > 0 ? "continued_with_warnings" : "succeeded",
              error: sdsPreflightError,
              readyForPlanning: sdsPreflight.readyForPlanning,
              qualityStatus: sdsPreflight.qualityStatus,
              sourceSdsCount: sdsPreflight.sourceSdsPaths.length,
              issueCount: sdsPreflight.issueCount,
              blockingIssueCount: sdsPreflight.blockingIssueCount,
              questionCount: sdsPreflight.questionCount,
              requiredQuestionCount: sdsPreflight.requiredQuestionCount,
              reportPath: sdsPreflight.reportPath,
              openQuestionsPath: sdsPreflight.openQuestionsPath,
              gapAddendumPath: sdsPreflight.gapAddendumPath,
              appliedToSds: sdsPreflight.appliedToSds,
              appliedSdsCount: sdsPreflight.appliedSdsPaths.length,
              commitHash: sdsPreflight.commitHash,
              blockingReasons,
              continuedWithWarnings: continueAfterSdsPreflightWarnings,
              warnings: preflightWarnings,
            },
          });
        }

        const preflightGeneratedDocInputs =
          sdsPreflight && (!sdsPreflight.appliedToSds || continueAfterSdsPreflightWarnings)
            ? sdsPreflight.generatedDocPaths
            : [];
        const preflightDocInputs = this.mergeDocInputs(
          options.inputs,
          sdsPreflight ? [...sdsPreflight.sourceSdsPaths, ...preflightGeneratedDocInputs] : [],
        );
        const docs = await this.prepareDocs(preflightDocInputs);
        const { docSummary, warnings: indexedDocWarnings } = this.buildDocContext(docs);
        const docWarnings = uniqueStrings([...(sdsPreflight?.warnings ?? []), ...indexedDocWarnings]);
        const sourceTopologyExpectation = this.buildSourceTopologyExpectation(docs);
        const initialArtifacts = this.derivePlanningArtifacts(
          options.projectKey,
          docs,
          { epics: [], stories: [], tasks: [] },
          sourceTopologyExpectation,
        );
        const { discoveryGraph, topologySignals, serviceCatalog, architecture, projectBuildMethod, projectBuildPlan } =
          initialArtifacts;
        const sdsDrivenPlan = this.buildSdsDrivenPlan(options.projectKey, docs, architecture);
        const sdsDrivenCompletionReport = this.buildProjectCompletionReport(
          options.projectKey,
          sdsDrivenPlan,
          architecture,
        );
        const deterministicFallbackPlan = this.hasStrongSdsPlanningEvidence(
          docs,
          serviceCatalog,
          sourceTopologyExpectation,
        )
          ? sdsDrivenPlan
          : this.materializePlanFromSeed(this.fallbackPlan(options.projectKey, docs), {
              maxEpics: options.maxEpics,
              maxStoriesPerEpic: options.maxStoriesPerEpic,
              maxTasksPerStory: options.maxTasksPerStory,
            });
        const planSizingOptions = {
          maxEpics: options.maxEpics,
          maxStoriesPerEpic: options.maxStoriesPerEpic,
          maxTasksPerStory: options.maxTasksPerStory,
        };
        const { prompt } = this.buildPrompt(
          options.projectKey,
          docSummary,
          projectBuildMethod,
          serviceCatalog,
          architecture,
          planSizingOptions,
        );
        const stagedEpicsPrompt = this.buildStrictStagedEpicsPrompt(
          options.projectKey,
          docSummary,
          projectBuildMethod,
          serviceCatalog,
          architecture,
          planSizingOptions,
        );
        const qaPreflight = await this.buildQaPreflight();
        const qaOverrides = this.buildQaOverrides(options);
        await this.jobService.writeCheckpoint(job.id, {
          stage: "docs_indexed",
          timestamp: new Date().toISOString(),
          details: {
            count: docs.length,
            warnings: docWarnings,
            startupWaves: discoveryGraph.startupWaves.slice(0, 8),
            topologySignals: {
              structureServices: topologySignals.structureServices.slice(0, 8),
              topologyHeadings: topologySignals.topologyHeadings.slice(0, 8),
              waveMentions: topologySignals.waveMentions.slice(0, 4),
            },
          },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "build_plan_defined",
          timestamp: new Date().toISOString(),
          details: {
            sourceDocs: projectBuildPlan.sourceDocs.length,
            services: projectBuildPlan.services.length,
            startupWaves: projectBuildPlan.startupWaves.length,
          },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "architecture_defined",
          timestamp: new Date().toISOString(),
          details: {
            architectureRoots: architecture.architectureRoots,
            services: architecture.services,
            crossCuttingDomains: architecture.crossCuttingDomains,
            verificationSurfaces: architecture.verificationSurfaces.length,
            units: architecture.units.length,
            dependencyOrder: architecture.dependencyOrder,
            startupWaves: architecture.startupWaves,
            completionScore: sdsDrivenCompletionReport.score,
            completionThreshold: sdsDrivenCompletionReport.threshold,
            completionSatisfied: sdsDrivenCompletionReport.satisfied,
          },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "phase0_services_defined",
          timestamp: new Date().toISOString(),
          details: {
            services: serviceCatalog.services.length,
            foundational: serviceCatalog.services.filter((service) => service.isFoundational).length,
            startupWaves: uniqueStrings(
              serviceCatalog.services
                .map((service) => (typeof service.startupWave === "number" ? String(service.startupWave) : ""))
                .filter(Boolean),
            ).length,
            sourceDocs: serviceCatalog.sourceDocs.length,
          },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "qa_preflight",
          timestamp: new Date().toISOString(),
          details: qaPreflight,
        });

        let agent: Agent | undefined;
        let planSource: "agent" | "fallback" | "sds" = "agent";
        let fallbackReason: string | undefined;
        let plan: GeneratedPlan;
        let strictPlanningMode: StrictAgentPlanningMode | undefined;
        try {
          agent = await this.resolveAgent(options.agentName);
          if (strictAgentMode) {
            const stagedDecision = this.shouldUseStrictAgentStagedPlanning({
              projectKey: options.projectKey,
              docSummary,
              projectBuildMethod,
              serviceCatalog,
              architecture,
              seedPlan: sdsDrivenPlan,
              options: planSizingOptions,
            });
            if (stagedDecision.useStaged) {
              strictPlanningMode = "strict_staged_plan";
              fallbackReason = stagedDecision.reason;
              await this.jobService.appendLog(
                job.id,
                `Explicit agent planning selected staged mode before full-plan synthesis. ${stagedDecision.reason} Staged epics prompt estimate: ${stagedEpicsPrompt.promptTokens} tokens.\n`,
              );
              plan = await this.generateStrictAgentPlanStaged({
                agent,
                projectKey: options.projectKey,
                docs,
                docSummary,
                projectBuildMethod,
                serviceCatalog,
                architecture,
                options: planSizingOptions,
                agentStream,
                jobId: job.id,
                commandRunId: commandRun.id,
                unknownEpicServicePolicy,
                epicsPrompt: stagedEpicsPrompt.prompt,
                docWarnings,
              });
            } else {
              try {
                plan = await this.generateStrictAgentPlan({
                  agent,
                  projectKey: options.projectKey,
                  docs,
                  docSummary,
                  projectBuildMethod,
                  serviceCatalog,
                  architecture,
                  sourceTopologyExpectation,
                  unknownEpicServicePolicy,
                  options: planSizingOptions,
                  agentStream,
                  jobId: job.id,
                  commandRunId: commandRun.id,
                  seedPlan: sdsDrivenPlan,
                });
                strictPlanningMode = "strict_full_plan";
              } catch (error) {
                if (!this.isAgentTimeoutLikeError(error)) {
                  throw error;
                }
                strictPlanningMode = "strict_staged_plan";
                fallbackReason = (error as Error).message ?? String(error);
                await this.jobService.appendLog(
                  job.id,
                  `Explicit agent planning is recovering from full-plan timeout through staged generation: ${fallbackReason}\n`,
                );
                plan = await this.generateStrictAgentPlanStaged({
                  agent,
                  projectKey: options.projectKey,
                  docs,
                  docSummary,
                  projectBuildMethod,
                  serviceCatalog,
                  architecture,
                  options: planSizingOptions,
                  agentStream,
                  jobId: job.id,
                  commandRunId: commandRun.id,
                  unknownEpicServicePolicy,
                  epicsPrompt: prompt,
                  docWarnings,
                });
              }
            }
            await this.jobService.writeCheckpoint(job.id, {
              stage: "epics_generated",
              timestamp: new Date().toISOString(),
              details: {
                epics: plan.epics.length,
                source: "agent",
                mode: strictPlanningMode,
                reason: fallbackReason,
              },
            });
          } else {
            const { output: epicOutput } = await this.invokeAgentWithRetry(
              agent,
              prompt,
              "epics",
              agentStream,
              job.id,
              commandRun.id,
              { docWarnings },
            );
            const parsedEpics = this.parseEpics(epicOutput, docs, options.projectKey).slice(
              0,
              options.maxEpics ?? Number.MAX_SAFE_INTEGER,
            );
            const normalizedEpics = this.alignEpicsToServiceCatalog(
              parsedEpics,
              serviceCatalog,
              unknownEpicServicePolicy,
            );
            for (const warning of normalizedEpics.warnings) {
              await this.jobService.appendLog(job.id, `[create-tasks] ${warning}\n`);
            }
            const epics = normalizedEpics.epics;
            await this.jobService.writeCheckpoint(job.id, {
              stage: "epics_generated",
              timestamp: new Date().toISOString(),
              details: { epics: epics.length, source: "agent" },
            });
            plan = await this.generatePlanFromAgent(options.projectKey, epics, agent, docSummary, {
              agentStream,
              jobId: job.id,
              commandRunId: commandRun.id,
              maxStoriesPerEpic: options.maxStoriesPerEpic,
              maxTasksPerStory: options.maxTasksPerStory,
              projectBuildMethod,
            });
          }
        } catch (error) {
          fallbackReason = (error as Error).message ?? String(error);
          if (strictAgentMode) {
            throw new Error(
              `Explicit agent \"${options.agentName}\" failed before backlog persistence: ${fallbackReason}`,
            );
          }
          if (
            unknownEpicServicePolicy === "fail" &&
            /unknown service ids|phase-0 service references/i.test(fallbackReason)
          ) {
            throw error;
          }
          await this.jobService.appendLog(
            job.id,
            `Agent planning failed, using deterministic planner fallback: ${fallbackReason}\n`,
          );
          planSource = deterministicFallbackPlan === sdsDrivenPlan ? "sds" : "fallback";
          plan = deterministicFallbackPlan;
          await this.jobService.writeCheckpoint(job.id, {
            stage: "epics_generated",
            timestamp: new Date().toISOString(),
            details: { epics: plan.epics.length, source: planSource, reason: fallbackReason },
          });
        }

        plan = await this.normalizeGeneratedPlan({
          plan,
          docs,
          serviceCatalog,
          sourceTopologyExpectation,
          unknownEpicServicePolicy,
          jobId: job.id,
        });
        let completionReport = this.buildProjectCompletionReport(options.projectKey, plan, architecture);
        if (this.planLooksTooWeakForSds(plan, docs, serviceCatalog, sourceTopologyExpectation)) {
          fallbackReason = [
            fallbackReason,
            `generated backlog was too weak for SDS-first acceptance (epics=${plan.epics.length}, tasks=${plan.tasks.length})`,
          ]
            .filter(Boolean)
            .join("; ");
          if (strictAgentMode) {
            await this.jobService.appendLog(
              job.id,
              `Explicit agent backlog retained despite SDS-coverage weakness because project completion remains the primary acceptance signal: ${fallbackReason}\n`,
            );
          } else {
            planSource = "sds";
            plan = await this.normalizeGeneratedPlan({
              plan: sdsDrivenPlan,
              docs,
              serviceCatalog,
              sourceTopologyExpectation,
              unknownEpicServicePolicy,
              jobId: job.id,
            });
            await this.jobService.appendLog(
              job.id,
              `create-tasks replaced the weak generated backlog with the SDS-first deterministic plan. Reason: ${fallbackReason}\n`,
            );
            completionReport = sdsDrivenCompletionReport;
          }
        }
        await this.jobService.writeCheckpoint(job.id, {
          stage: "project_completion_review",
          timestamp: new Date().toISOString(),
          details: {
            source: planSource,
            score: completionReport.score,
            threshold: completionReport.threshold,
            satisfied: completionReport.satisfied,
            architectureUnitCount: completionReport.unitCoverage.length,
            coveredArchitectureUnitCount: completionReport.unitCoverage.filter((entry) => entry.satisfied).length,
            issueCodes: completionReport.issues.map((issue) => issue.code),
          },
        });

        await this.jobService.writeCheckpoint(job.id, {
          stage: "stories_generated",
          timestamp: new Date().toISOString(),
          details: { stories: plan.stories.length, source: planSource, fallbackReason },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "tasks_generated",
          timestamp: new Date().toISOString(),
          details: { tasks: plan.tasks.length, source: planSource, fallbackReason },
        });

        const { folder } = await this.writePlanArtifacts(
          options.projectKey,
          plan,
          docSummary,
          docs,
          projectBuildPlan,
          serviceCatalog,
          architecture,
        );
        await this.jobService.writeCheckpoint(job.id, {
          stage: "plan_written",
          timestamp: new Date().toISOString(),
          details: { folder },
        });

        const { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows } =
          await this.persistPlanToDb(project.id, options.projectKey, plan, job.id, commandRun.id, {
            force: backlogPersistence.replaceExistingBacklog || Boolean(options.force),
            resetKeys: backlogPersistence.replaceExistingBacklog || Boolean(options.force),
            qaPreflight,
            qaOverrides,
          });
        await this.seedPriorities(options.projectKey);
        let sufficiencyAudit: TaskSufficiencyAuditResult | undefined;
        let sufficiencyAuditError: string | undefined;
        const sufficiencyWarnings: string[] = [];
        let sufficiencyAcceptedWithWarnings = false;
        let sufficiencyRemediationApplied = false;
        let refinementAttempt = 0;
        const auditResult = await this.runTaskSufficiencyAudit({
          workspace: options.workspace,
          projectKey: options.projectKey,
          sourceCommand: "create-tasks",
          dryRun: true,
          jobId: job.id,
        });
        sufficiencyAudit = auditResult.audit;
        sufficiencyAuditError = auditResult.error;
        sufficiencyWarnings.push(...auditResult.warnings);

          while (
            sufficiencyAudit &&
            canReplaceBacklogDuringRun &&
            (strictAgentMode ? !completionReport.satisfied : !sufficiencyAudit.satisfied && !completionReport.satisfied)
          ) {
            const refinementReasons = [
              ...(!completionReport.satisfied
                ? [`Project completion score ${completionReport.score}/${completionReport.threshold} is below threshold.`]
                : []),
              ...completionReport.issues
                .slice(0, 8)
                .map((issue) => `${issue.code}: ${issue.message}`),
              ...(!sufficiencyAudit.satisfied
                ? [
                    `SDS coverage target not reached (coverage=${sufficiencyAudit.finalCoverageRatio}, remaining gaps=${sufficiencyAudit.remainingGaps.total}).`,
                  ]
                : []),
              ...(sufficiencyAudit.remainingSectionHeadings.length > 0
                ? [
                    `Remaining section headings: ${sufficiencyAudit.remainingSectionHeadings.slice(0, 12).join(", ")}`,
                  ]
                : []),
              ...(sufficiencyAudit.remainingFolderEntries.length > 0
                ? [
                    `Remaining folder entries: ${sufficiencyAudit.remainingFolderEntries.slice(0, 12).join(", ")}`,
                  ]
                : []),
            ];
            if (!agent || refinementAttempt >= CreateTasksService.MAX_AGENT_REFINEMENT_ATTEMPTS) {
              sufficiencyAuditError = refinementReasons[0] ?? "Agent backlog refinement budget exhausted.";
              break;
            }

            refinementAttempt += 1;
            await this.jobService.writeCheckpoint(job.id, {
              stage: "backlog_refinement",
              timestamp: new Date().toISOString(),
              details: {
                iteration: refinementAttempt,
                completionScore: completionReport.score,
                completionThreshold: completionReport.threshold,
                remainingGapCount: sufficiencyAudit.remainingGaps.total,
                remainingSectionCount: sufficiencyAudit.remainingSectionHeadings.length,
                remainingFolderCount: sufficiencyAudit.remainingFolderEntries.length,
                plannedGapBundleCount: sufficiencyAudit.plannedGapBundles.length,
                unresolvedBundleCount: sufficiencyAudit.unresolvedBundles.length,
              },
            });
            try {
              if (strictAgentMode && strictPlanningMode === "strict_staged_plan") {
                await this.jobService.appendLog(
                  job.id,
                  `create-tasks refinement iteration ${refinementAttempt} is rerunning strict staged planning because project completion remains below target.\n`,
                );
                plan = await this.generateStrictAgentPlanStaged({
                  agent,
                  projectKey: options.projectKey,
                  docs,
                  docSummary,
                  projectBuildMethod,
                  serviceCatalog,
                  architecture,
                  options: planSizingOptions,
                  agentStream,
                  jobId: job.id,
                  commandRunId: commandRun.id,
                  unknownEpicServicePolicy,
                  epicsPrompt: prompt,
                  docWarnings,
                });
              } else {
                plan = await this.refinePlanWithAgent({
                  agent,
                  currentPlan: plan,
                  audit: sufficiencyAudit,
                  reasons: refinementReasons,
                  docs,
                  docSummary,
                  projectKey: options.projectKey,
                  projectBuildMethod,
                  serviceCatalog,
                  sourceTopologyExpectation,
                  unknownEpicServicePolicy,
                  options,
                  agentStream,
                  jobId: job.id,
                  commandRunId: commandRun.id,
                  iteration: refinementAttempt,
                });
              }
              completionReport = this.buildProjectCompletionReport(options.projectKey, plan, architecture);
              planSource = "agent";
              await this.persistPlanToDb(project.id, options.projectKey, plan, job.id, commandRun.id, {
                force: canReplaceBacklogDuringRun,
                resetKeys: canReplaceBacklogDuringRun,
                qaPreflight,
                qaOverrides,
              });
              await this.seedPriorities(options.projectKey);
              await this.jobService.appendLog(
                job.id,
                `create-tasks refinement iteration ${refinementAttempt} replaced the backlog with ${plan.epics.length} epics, ${plan.stories.length} stories, and ${plan.tasks.length} tasks (completion=${completionReport.score}/${completionReport.threshold}).\n`,
              );
              const refreshedAudit = await this.runTaskSufficiencyAudit({
                workspace: options.workspace,
                projectKey: options.projectKey,
                sourceCommand: "create-tasks",
                dryRun: true,
                jobId: job.id,
              });
              sufficiencyAudit = refreshedAudit.audit ?? sufficiencyAudit;
              sufficiencyAuditError = refreshedAudit.error;
              sufficiencyWarnings.push(...refreshedAudit.warnings);
            } catch (error) {
              const message = (error as Error)?.message ?? String(error);
              await this.jobService.appendLog(
                job.id,
                `create-tasks refinement iteration ${refinementAttempt} failed: ${message}\n`,
              );
              sufficiencyAuditError = refinementReasons[0];
              if (refinementAttempt >= CreateTasksService.MAX_AGENT_REFINEMENT_ATTEMPTS) {
                break;
              }
            }
          }

          if (!sufficiencyAudit) {
            sufficiencyAcceptedWithWarnings = true;
            sufficiencyWarnings.push(
              `Task sufficiency audit failed (${sufficiencyAuditError ?? "unknown error"}). Coverage diagnostics were skipped because project completion scoring remains the primary acceptance signal.`,
            );
            await this.jobService.writeCheckpoint(job.id, {
              stage: "task_sufficiency_audit",
              timestamp: new Date().toISOString(),
              details: {
                status: "continued_with_warnings",
                error: sufficiencyAuditError,
                jobId: undefined,
                commandRunId: undefined,
                satisfied: undefined,
                dryRun: undefined,
                totalTasksAdded: undefined,
                totalTasksUpdated: undefined,
                finalCoverageRatio: undefined,
                reportPath: undefined,
                remainingSectionCount: undefined,
                remainingFolderCount: undefined,
                remainingGapCount: undefined,
                plannedGapBundleCount: undefined,
                unresolvedBundleCount: undefined,
                remediationApplied: false,
                warnings: uniqueStrings(sufficiencyWarnings),
              },
            });
          } else {
            if (!sufficiencyAudit.satisfied && completionReport.satisfied) {
              sufficiencyAcceptedWithWarnings = true;
              sufficiencyWarnings.push(
                `Task sufficiency audit remained below target (coverage=${sufficiencyAudit.finalCoverageRatio}, remaining gaps=${sufficiencyAudit.remainingGaps.total}), but create-tasks preserved the backlog because project completion scoring remains the primary acceptance signal.`,
              );
              await this.jobService.appendLog(
                job.id,
                "create-tasks kept the backlog after dry-run sufficiency gaps because project completion scoring remains the primary acceptance signal.\n",
              );
            } else if (!sufficiencyAudit.satisfied) {
              sufficiencyAcceptedWithWarnings = true;
              sufficiencyWarnings.push(
                `Task sufficiency audit remained below target (coverage=${sufficiencyAudit.finalCoverageRatio}, remaining gaps=${sufficiencyAudit.remainingGaps.total}), but create-tasks preserved the architecture-first backlog because project completion scoring is the primary acceptance signal.`,
              );
              await this.jobService.appendLog(
                job.id,
                "create-tasks kept the architecture-first backlog after dry-run sufficiency gaps instead of applying heading/folder remediation.\n",
              );
            }

            const uniqueSufficiencyWarnings = uniqueStrings([...backlogPersistenceWarnings, ...sufficiencyWarnings]);
            sufficiencyAudit = {
              ...sufficiencyAudit,
              warnings: uniqueSufficiencyWarnings,
            };
            if (!sufficiencyAudit.satisfied) {
              sufficiencyAuditError = `SDS coverage target not reached (coverage=${sufficiencyAudit.finalCoverageRatio}, remaining gaps=${sufficiencyAudit.remainingGaps.total}).`;
              sufficiencyAcceptedWithWarnings = true;
              sufficiencyAudit = {
                ...sufficiencyAudit,
                warnings: uniqueStrings([
                  ...uniqueSufficiencyWarnings,
                  `Task sufficiency audit completed with residual gaps (coverage=${sufficiencyAudit.finalCoverageRatio}, remaining gaps=${sufficiencyAudit.remainingGaps.total}). Backlog artifacts were preserved. Report: ${sufficiencyAudit.reportPath}`,
                ]),
              };
              await this.jobService.appendLog(
                job.id,
                `Task sufficiency audit completed with residual coverage gaps after the secondary recovery step (coverage=${sufficiencyAudit.finalCoverageRatio}, remaining gaps=${sufficiencyAudit.remainingGaps.total}). Preserving backlog artifacts and continuing.\n`,
              );
            } else {
              sufficiencyAcceptedWithWarnings = false;
              sufficiencyAuditError = undefined;
            }
            await this.jobService.writeCheckpoint(job.id, {
              stage: "task_sufficiency_audit",
              timestamp: new Date().toISOString(),
              details: {
                status: sufficiencyAudit.satisfied
                  ? "succeeded"
                  : sufficiencyAcceptedWithWarnings
                    ? "continued_with_warnings"
                    : "blocked",
                error: sufficiencyAuditError,
                jobId: sufficiencyAudit.jobId,
                commandRunId: sufficiencyAudit.commandRunId,
                satisfied: sufficiencyAudit.satisfied,
                dryRun: sufficiencyAudit.dryRun,
                totalTasksAdded: sufficiencyAudit.totalTasksAdded,
                totalTasksUpdated: sufficiencyAudit.totalTasksUpdated,
                finalCoverageRatio: sufficiencyAudit.finalCoverageRatio,
                reportPath: sufficiencyAudit.reportPath,
                remainingSectionCount: sufficiencyAudit.remainingSectionHeadings.length,
                remainingFolderCount: sufficiencyAudit.remainingFolderEntries.length,
                remainingGapCount: sufficiencyAudit.remainingGaps.total,
                plannedGapBundleCount: sufficiencyAudit.plannedGapBundles.length,
                unresolvedBundleCount: sufficiencyAudit.unresolvedBundles.length,
                remediationApplied: sufficiencyRemediationApplied,
                warnings: sufficiencyAudit.warnings,
              },
            });
        }

        if ((sufficiencyAudit?.totalTasksAdded ?? 0) > 0) {
          await this.seedPriorities(options.projectKey);
        }

        const finalBacklog = await this.loadPersistedBacklog(project.id);
        const finalPlan = this.buildPlanFromPersistedBacklog(finalBacklog);
        const finalCoverageAnchors = this.collectCoverageAnchorsFromBacklog(finalBacklog);
        const expectedCoverage = await this.loadExpectedCoverageFromSufficiencyReport(sufficiencyAudit?.reportPath);
        await this.writePlanArtifacts(
          options.projectKey,
          finalPlan,
          docSummary,
          docs,
          projectBuildPlan,
          serviceCatalog,
          architecture,
          {
            existingCoverageAnchors: finalCoverageAnchors,
            expectedCoverage,
          },
        );
        const finalCompletionReport = this.buildProjectCompletionReport(
          options.projectKey,
          finalPlan,
          architecture,
        );
        const completionReportPath = path.join(folder, "project-completion-report.json");
        const strictAgentFailures: string[] = [];
        if (strictAgentMode && !finalCompletionReport.satisfied) {
          strictAgentFailures.push(
            `project completion stayed below target (score=${finalCompletionReport.score}, threshold=${finalCompletionReport.threshold}). Report: ${completionReportPath}`,
          );
        }
        const completionWarnings = finalCompletionReport.satisfied
          ? []
          : [
              `Project completion target not reached (score=${finalCompletionReport.score}, threshold=${finalCompletionReport.threshold}). Backlog artifacts were preserved. Report: ${completionReportPath}`,
            ];
        const combinedWarnings = uniqueStrings([
          ...backlogPersistenceWarnings,
          ...completionWarnings,
          ...(sufficiencyAudit?.warnings ?? sufficiencyWarnings),
        ]);
        const acceptedWithResidualSectionGaps = Boolean(
          sufficiencyAudit && !sufficiencyAudit.satisfied && sufficiencyAcceptedWithWarnings,
        );
        await this.jobService.writeCheckpoint(job.id, {
          stage: "plan_refreshed",
          timestamp: new Date().toISOString(),
          details: {
            folder,
            epics: finalBacklog.epics.length,
            stories: finalBacklog.stories.length,
            tasks: finalBacklog.tasks.length,
            dependencies: finalBacklog.dependencies.length,
            services: serviceCatalog.services.length,
            startupWaves: projectBuildPlan.startupWaves.length,
            acceptedWithResidualSectionGaps,
          },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "project_completion",
          timestamp: new Date().toISOString(),
          details: {
            status: finalCompletionReport.satisfied ? "succeeded" : "continued_with_warnings",
            score: finalCompletionReport.score,
            threshold: finalCompletionReport.threshold,
            reportPath: completionReportPath,
            architectureUnitCount: finalCompletionReport.unitCoverage.length,
            coveredArchitectureUnitCount: finalCompletionReport.unitCoverage.filter((entry) => entry.satisfied).length,
            implementationTaskCount: finalPlan.tasks.filter(
              (task) => !this.isDocsTaskForQuality(task) && !this.isVerificationTaskForQuality(task),
            ).length,
            verificationTaskCount: finalPlan.tasks.filter(
              (task) => !this.isDocsTaskForQuality(task) && this.isVerificationTaskForQuality(task),
            ).length,
            warnings: combinedWarnings,
          },
        });

        if (strictAgentFailures.length > 0) {
          throw new Error(
            `Explicit agent \"${options.agentName}\" did not converge to an acceptable backlog: ${strictAgentFailures.join(" ")}`,
          );
        }

        await this.jobService.updateJobStatus(job.id, "completed", {
          payload: {
            epicsCreated: finalBacklog.epics.length,
            storiesCreated: finalBacklog.stories.length,
            tasksCreated: finalBacklog.tasks.length,
            dependenciesCreated: finalBacklog.dependencies.length,
            docs: docSummary,
            planFolder: folder,
            planSource,
            fallbackReason,
            sdsPreflight: sdsPreflight
              ? {
                  readyForPlanning: sdsPreflight.readyForPlanning,
                  qualityStatus: sdsPreflight.qualityStatus,
                  sourceSdsCount: sdsPreflight.sourceSdsPaths.length,
                  issueCount: sdsPreflight.issueCount,
                  blockingIssueCount: sdsPreflight.blockingIssueCount,
                  questionCount: sdsPreflight.questionCount,
                  requiredQuestionCount: sdsPreflight.requiredQuestionCount,
                  appliedToSds: sdsPreflight.appliedToSds,
                  appliedSdsPaths: sdsPreflight.appliedSdsPaths,
                  commitHash: sdsPreflight.commitHash,
                  reportPath: sdsPreflight.reportPath,
                  openQuestionsPath: sdsPreflight.openQuestionsPath,
                  gapAddendumPath: sdsPreflight.gapAddendumPath,
                  blockingReasons: sdsPreflightBlockingReasons,
                  continuedWithWarnings: continueAfterSdsPreflightWarnings,
                  warnings: sdsPreflight.warnings,
                }
              : undefined,
            sdsPreflightError,
            sufficiencyAudit: sufficiencyAudit
              ? {
                  jobId: sufficiencyAudit.jobId,
                  commandRunId: sufficiencyAudit.commandRunId,
                  satisfied: sufficiencyAudit.satisfied,
                  totalTasksAdded: sufficiencyAudit.totalTasksAdded,
                  totalTasksUpdated: sufficiencyAudit.totalTasksUpdated,
                  finalCoverageRatio: sufficiencyAudit.finalCoverageRatio,
                  reportPath: sufficiencyAudit.reportPath,
                  remainingSectionCount: sufficiencyAudit.remainingSectionHeadings.length,
                  remainingFolderCount: sufficiencyAudit.remainingFolderEntries.length,
                  remainingGapCount: sufficiencyAudit.remainingGaps.total,
                  unresolvedBundleCount: sufficiencyAudit.unresolvedBundles.length,
                  acceptedWithResidualSectionGaps,
                  warnings: sufficiencyAudit.warnings,
                }
              : undefined,
            completionReport: {
              score: finalCompletionReport.score,
              threshold: finalCompletionReport.threshold,
              satisfied: finalCompletionReport.satisfied,
              reportPath: completionReportPath,
              architectureUnitCount: finalCompletionReport.unitCoverage.length,
              coveredArchitectureUnitCount: finalCompletionReport.unitCoverage.filter((entry) => entry.satisfied).length,
              implementationTaskCount: finalPlan.tasks.filter(
                (task) => !this.isDocsTaskForQuality(task) && !this.isVerificationTaskForQuality(task),
              ).length,
              verificationTaskCount: finalPlan.tasks.filter(
                (task) => !this.isDocsTaskForQuality(task) && this.isVerificationTaskForQuality(task),
              ).length,
              warnings: combinedWarnings,
            },
            sufficiencyAuditError,
          },
        });
        await this.jobService.finishCommandRun(commandRun.id, "succeeded");
        if (options.rateAgents && planSource === "agent" && agent) {
          try {
            const ratingService = this.ensureRatingService();
            await ratingService.rate({
              workspace: this.workspace,
              agentId: agent.id,
              commandName: "create-tasks",
              jobId: job.id,
              commandRunId: commandRun.id,
            });
          } catch (error) {
            const message = `Agent rating failed: ${(error as Error).message ?? String(error)}`;
            try {
              await this.jobService.appendLog(job.id, `${message}\n`);
            } catch {
              /* ignore rating log failures */
            }
          }
        }

        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          epics: finalBacklog.epics,
          stories: finalBacklog.stories,
          tasks: finalBacklog.tasks,
          dependencies: finalBacklog.dependencies,
          warnings: combinedWarnings,
          completionReport: {
            score: finalCompletionReport.score,
            threshold: finalCompletionReport.threshold,
            satisfied: finalCompletionReport.satisfied,
            reportPath: completionReportPath,
            architectureUnitCount: finalCompletionReport.unitCoverage.length,
            coveredArchitectureUnitCount: finalCompletionReport.unitCoverage.filter((entry) => entry.satisfied).length,
            implementationTaskCount: finalPlan.tasks.filter(
              (task) => !this.isDocsTaskForQuality(task) && !this.isVerificationTaskForQuality(task),
            ).length,
            verificationTaskCount: finalPlan.tasks.filter(
              (task) => !this.isDocsTaskForQuality(task) && this.isVerificationTaskForQuality(task),
            ).length,
            warnings: combinedWarnings,
          },
          sufficiencyAudit: sufficiencyAudit
            ? {
                jobId: sufficiencyAudit.jobId,
                commandRunId: sufficiencyAudit.commandRunId,
                satisfied: sufficiencyAudit.satisfied,
                totalTasksAdded: sufficiencyAudit.totalTasksAdded,
                totalTasksUpdated: sufficiencyAudit.totalTasksUpdated,
                finalCoverageRatio: sufficiencyAudit.finalCoverageRatio,
                reportPath: sufficiencyAudit.reportPath,
                remainingSectionCount: sufficiencyAudit.remainingSectionHeadings.length,
                remainingFolderCount: sufficiencyAudit.remainingFolderEntries.length,
                remainingGapCount: sufficiencyAudit.remainingGaps.total,
                unresolvedBundleCount: sufficiencyAudit.unresolvedBundles.length,
                acceptedWithResidualSectionGaps,
                warnings: sufficiencyAudit.warnings,
              }
            : undefined,
        };
      } catch (error) {
        lastError = error;
        const message = (error as Error).message;
        const isBusy =
          message?.includes("SQLITE_BUSY") ||
          message?.includes("database is locked") ||
          message?.includes("busy");
        const remaining = CreateTasksService.MAX_BUSY_RETRIES - attempt;
        if (isBusy && remaining > 0) {
          const backoff = CreateTasksService.BUSY_BACKOFF_MS * attempt;
          await this.jobService.appendLog(
            job.id,
            `Encountered SQLITE_BUSY, retrying create-tasks (attempt ${attempt}/${CreateTasksService.MAX_BUSY_RETRIES}) after ${backoff}ms...\n`,
          );
          await delay(backoff);
          continue;
        }
        await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
        await this.jobService.finishCommandRun(commandRun.id, "failed", message);
        throw error;
      }
    }
    await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: (lastError as Error)?.message });
    await this.jobService.finishCommandRun(commandRun.id, "failed", (lastError as Error)?.message);
    throw lastError ?? new Error("create-tasks failed");
  }

  async migratePlanFromFolder(options: {
    projectKey: string;
    planDir?: string;
    force?: boolean;
    refinePlanPath?: string;
    refinePlanPaths?: string[];
    refinePlansDir?: string;
  }): Promise<CreateTasksResult> {
    const projectKey = options.projectKey;
    const commandRun = await this.jobService.startCommandRun("migrate-tasks", projectKey);
    const job = await this.jobService.startJob("migrate_tasks", commandRun.id, projectKey, {
      commandName: "migrate-tasks",
      payload: { projectKey, planDir: options.planDir },
    });
    const planDir =
      options.planDir ?? path.join(this.workspace.mcodaDir, "tasks", projectKey);
    try {
      const planPath = path.join(planDir, "plan.json");
      const loadJson = async <T>(file: string): Promise<T | undefined> => {
        try {
          const raw = await fs.readFile(file, "utf8");
          return JSON.parse(raw) as T;
        } catch {
          return undefined;
        }
      };

      const planFromPlan = await loadJson<{ docSummary?: string } & GeneratedPlan>(planPath);
      const epicsFromFile = await loadJson<PlanEpic[]>(path.join(planDir, "epics.json"));
      const storiesFromFile = await loadJson<PlanStory[]>(path.join(planDir, "stories.json"));
      const tasksFromFile = await loadJson<PlanTask[]>(path.join(planDir, "tasks.json"));

      const epics = epicsFromFile ?? planFromPlan?.epics;
      const stories = storiesFromFile ?? planFromPlan?.stories;
      const tasks = tasksFromFile ?? planFromPlan?.tasks;
      const docSummary = planFromPlan?.docSummary;

      if (!epics || !stories || !tasks) {
        throw new Error(
          `Plan files missing required sections. Expected epics/stories/tasks in ${planDir} (plan.json or separate files).`,
        );
      }

      const project = await this.workspaceRepo.createProjectIfMissing({
        key: projectKey,
        name: projectKey,
        description: `Workspace project ${projectKey}`,
      });

      let plan: GeneratedPlan = {
        epics: epics as PlanEpic[],
        stories: stories as PlanStory[],
        tasks: tasks as PlanTask[],
      };
      plan = this.enforceStoryScopedDependencies(plan);
      plan = this.applyServiceDependencySequencing(plan, []);
      plan = this.enforceStoryScopedDependencies(plan);
      this.validatePlanLocalIdentifiers(plan);

      const loadRefinePlans = async (): Promise<string[]> => {
        const candidates: string[] = [];
        if (options.refinePlanPath) candidates.push(options.refinePlanPath);
        if (options.refinePlanPaths && options.refinePlanPaths.length) candidates.push(...options.refinePlanPaths);
        if (options.refinePlansDir) {
          const dir = path.resolve(options.refinePlansDir);
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              candidates.push(path.join(dir, entry.name, "plan.json"));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
              candidates.push(path.join(dir, entry.name));
            }
          }
        }
        const uniq = Array.from(new Set(candidates.map((p) => path.resolve(p))));
        const existing: string[] = [];
        for (const file of uniq) {
          try {
            await fs.access(file);
            existing.push(file);
          } catch {
            // ignore missing file candidates (e.g., directory entries without plan.json)
          }
        }
        return existing.sort((a, b) => a.localeCompare(b));
      };

      const refinePlanPaths = await loadRefinePlans();

      // If refinement plans are provided, default to wiping existing backlog to avoid mixing old tasks.
      const forceBacklogReset = refinePlanPaths.length ? true : !!options.force;

      await this.jobService.writeCheckpoint(job.id, {
        stage: "plan_loaded",
        timestamp: new Date().toISOString(),
        details: { planDir, epics: plan.epics.length, stories: plan.stories.length, tasks: plan.tasks.length },
      });

      const { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows } =
        await this.persistPlanToDb(project.id, projectKey, plan, job.id, commandRun.id, {
          force: forceBacklogReset,
          resetKeys: forceBacklogReset,
        });

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          epicsCreated: epicRows.length,
          storiesCreated: storyRows.length,
          tasksCreated: taskRows.length,
          dependenciesCreated: dependencyRows.length,
          docs: docSummary,
          planFolder: planDir,
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");

      // Optionally apply a refinement plan from disk after seeding the backlog.
      if (refinePlanPaths.length > 0) {
        const { RefineTasksService } = await import("./RefineTasksService.js");
        const refineService = await RefineTasksService.create(this.workspace);
        try {
          for (const refinePlanPath of refinePlanPaths) {
            await refineService.refineTasks({
              workspace: this.workspace,
              projectKey,
              planInPath: path.resolve(refinePlanPath),
              fromDb: true,
              apply: true,
              agentStream: false,
              dryRun: false,
            });
          }
        } finally {
          await refineService.close();
        }
      }

      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        epics: epicRows,
        stories: storyRows,
        tasks: taskRows,
        dependencies: dependencyRows,
        warnings: [],
        sufficiencyAudit: undefined,
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      throw error;
    }
  }
}
